// The Bayview town itself: an 84 m whitewashed Mediterranean block laid out
// per docs/bayview-design.md — CT spawn north, T spawn south, A site west,
// B site east, mid in the centre, raised decks (back plat, heaven, catwalk),
// the waterfront dock, crates, barrels and palms between the lanes. The palms
// themselves are geometry-heavy enough to own a file: see `palm.ts`.
//
// Buildings form continuous street walls along every lane (the references are
// dense white blocks, never scattered boxes), heights step between neighbours
// 5–9.2 m with setback storeys and slim towers, every roofline carries a
// parapet plus water tanks / AC boxes / antenna masts / vents, and every
// lane-facing face gets blue doors, shutter pairs, balconies and striped
// awnings from one deterministic hash so replays render identically.
//
// Everything solid goes into `hittable` (the raycast stops there) and gets a
// collider; raised decks sit overhead so ground navigation ignores them while
// their posts still block it. Site letters are built from boxes because
// CanvasTexture samples black under WebGPURenderer.
import {
  BoxGeometry,
  BufferGeometry,
  CatmullRomCurve3,
  CylinderGeometry,
  Group,
  Line,
  Mesh,
  PlaneGeometry,
  RingGeometry,
  Vector3,
} from "three";
import type { TargetSpec } from "../entities/Target.js";
// Impact surfaces are stamped here at construction so audio, VFX and any later
// consumer read one tag off the mesh instead of re-deriving name tables.
import { tagSurfaces } from "../surfaces.js";
import {
  BAYVIEW_ARCHES,
  FACE_INDEX,
  FACE_NORMAL,
  type Face,
  addArchGateway,
  addDoorsAndShutters,
  addRoofLife,
  createFacade,
  visibleFaces,
} from "./facade.js";
import { worldGridUVs } from "./materials.js";
import { type PalmPlacement, addPalms } from "./palm.js";
import { unitCylinder } from "./shapes.js";
import { gridSolid } from "./townMaterials.js";
import type { TownMaterials } from "./townMaterials.js";
import { type BoatPlacement, type VanPlacement, addFishingBoat, addVan } from "./vehicles.js";

import {
  A_SITE_MARK,
  A_SITE_PLAZA,
  BACK_PLAT_DECK,
  CATWALK_DECK,
  type DeckFootprint,
  HEAVEN_DECK,
  type ITownSchematic,
  MID_COURTYARD_PLAZA,
  PIER,
  type SchematicRect,
  TOWN_HALF,
  WATER_X,
  townSchematic,
} from "./town-schematic.js";

// The map data lives beside this file rather than in it, so the UI layer can read it without the
// renderer. Re-exported because the rest of the game imports these from `town.js`.
export {
  type DeckFootprint,
  type ITownSchematic,
  type SchematicRect,
  TOWN_HALF,
  WATER_X,
  townSchematic,
};

export const TOWN = 84;
/** Slab thickness of the raised decks. */
const DECK_THICKNESS = 0.4;

export type TownCollider = {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
};

export type TownSpawn = { x: number; z: number; yaw: number };
export type TownRoute = readonly Vector3[];

export type Town = {
  readonly group: Group;
  /** Every solid the round and the sight lines meet. */
  readonly hittable: Mesh[];
  readonly colliders: TownCollider[];
  readonly spawn: TownSpawn;
  readonly targets: TargetSpec[];
  /** Ground-level patrol loops, one per soldier. */
  readonly enemyRoutes: readonly TownRoute[];
  /** Raised deck footprints, for the under-the-deck observation. */
  readonly decks: readonly DeckFootprint[];
  /** Overhead-map data traced from the same constants that built the scene. */
  readonly schematic: ITownSchematic;
};

/** Deterministic layout hash: identical across runs, so replays match. */
const hash = (n: number): number => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

/**
 * Building blocks: footprints tile the map except where the lanes, sites and
 * courtyards run; neighbours abut so streets read as continuous walls.
 * Heights 5–9.2 m step between neighbours; `top` adds a setback storey.
 */
type BuildingSpec = {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
  readonly h: number;
  readonly brick?: boolean;
  /** Lane-facing faces that receive doors, shutters, balconies, awnings. */
  readonly j?: readonly Face[];
  readonly tank?: boolean;
  readonly mast?: boolean;
  readonly ac?: boolean;
  /** Setback upper storey: `i` metres inset each side, `h` extra height. */
  readonly top?: { readonly i: number; readonly h: number };
};

const BUILDINGS: readonly BuildingSpec[] = [
  // North band (z −42…−30): CT yard stays open at x −4…14.
  { x: [-42, -27], z: [-42, -30], h: 7.2 },
  { x: [-27, -16], z: [-42, -30], h: 6.2, brick: true },
  { x: [-16, -4], z: [-42, -30], h: 8.8, j: ["s"], tank: true, top: { i: 2, h: 1.6 } },
  { x: [14, 29], z: [-42, -30], h: 6.4, j: ["w", "s"] },
  { x: [29, 42], z: [-42, -30], h: 7.6, tank: true, top: { i: 2.5, h: 1.8 } },

  // Band z −30…−22: CT-ramp stair apron stays open around x 1.4…4.6.
  { x: [-42, -24], z: [-30, -22], h: 5.6, j: ["e"] },
  { x: [-24, -14], z: [-30, -22], h: 6.8, brick: true, j: ["e"] },
  { x: [-14, -4], z: [-30, -22], h: 5.2, j: ["e"] },
  { x: [12, 20], z: [-30, -22], h: 6.8, j: ["n", "w", "e"], ac: true, top: { i: 2, h: 1.5 } },

  // Back-plat row z −22…−10: the plat itself rides overhead at x 0…12.
  { x: [-42, -36], z: [-22, -10], h: 6.4, j: ["e"] },
  { x: [-36, -20], z: [-22, -10], h: 5.4, brick: true, j: ["e"], tank: true },
  { x: [12, 20], z: [-20, -10], h: 6.8, j: ["n", "w", "e"], ac: true, top: { i: 2, h: 1.5 } },
  { x: [10, 16], z: [-8, -1], h: 5.4, j: ["n", "s", "w"] },
  // South and east faces both front the B-site plaza beside the catwalk stair,
  // so they carry joinery; an undressed face here reads as greybox from the site.
  { x: [16, 20], z: [-8, -1], h: 7.5, j: ["s", "e"], mast: true },

  // Mid-west wall between A site and mid, passage z 0…6 stays open.
  { x: [-20, -8], z: [-8, 0], h: 5, j: ["n", "s", "e"] },

  // West perimeter behind A site, with the tall corner tower.
  { x: [-42, -36], z: [-10, -4], h: 9.2, j: ["e"], mast: true },
  { x: [-42, -36], z: [-4, 10], h: 5.8, brick: true, j: ["e"] },
  { x: [-42, -36], z: [10, 26], h: 6.2, j: ["e"] },
  { x: [-36, -20], z: [10, 16], h: 5.6, j: ["n"] },
  { x: [-36, -20], z: [16, 28], h: 5.8, j: ["e"] },

  // South-central: T main flows between TW and TE to the junction square.
  // Both flank the player's opening view, so they stay whitewashed plaster —
  // the reference frame is white walls with only rare exposed-brick accents.
  { x: [2, 10], z: [13, 24], h: 6.5, j: ["n", "w"], tank: true, top: { i: 1.6, h: 1.8 } },
  { x: [-20, -12], z: [16, 28], h: 6, j: ["n", "e"], top: { i: 1.5, h: 1.7 } },

  // East flank of mid and the connector's street walls.
  { x: [15, 30], z: [10, 26], h: 6.2, j: ["n", "w", "e"], ac: true },
  // The west face at x=15 is the whole right-hand wall of the T-spawn courtyard —
  // the wall beside the player on spawn, and the most-looked-at surface in the game.
  { x: [15, 30], z: [32, 42], h: 5.6, j: ["n", "e", "w"] },
  { x: [30, 42], z: [28, 42], h: 7, j: ["n", "w"], tank: true, mast: true },
  { x: [37, 42], z: [4, 30], h: 5.8, j: ["w"], top: { i: 1.8, h: 1.6 } },

  // Waterfront rows: promenade and dock plaza stay open at x 30…42.
  { x: [34, 42], z: [-16, -10], h: 5.4, j: ["w"] },
  { x: [34, 42], z: [-2, 4], h: 6, j: ["w"], ac: true },
  { x: [30, 42], z: [-30, -16], h: 6, tank: true },

  // South band (z 26…42): T spawn courtyard x −9…9 stays open.
  { x: [-42, -12], z: [28, 42], h: 6.4, j: ["e"] },
  { x: [-9, 16], z: [38, 42], h: 5.5, j: ["n"] },
];

/** The A site and mid-courtyard slabs are named because the minimap schematic
 * traces these exact rectangles; the rest of the plazas stay anonymous. */

/** Site plazas, mid courtyard, T spawn and the dock read a shade apart. */
const PLAZAS: readonly {
  readonly x: readonly [number, number];
  readonly z: readonly [number, number];
  readonly finish: "plazaWarm" | "plazaCool" | "plazaPale";
}[] = [
  A_SITE_PLAZA,
  { x: [16, 33], z: [-8, 11], finish: "plazaCool" }, // B site
  MID_COURTYARD_PLAZA,
  { x: [-9, 9], z: [26, 40], finish: "plazaWarm" }, // T spawn
  { x: [33, 42], z: [-10, -1], finish: "plazaPale" }, // dock plaza
  { x: [30, 34], z: [-16, 4], finish: "plazaCool" }, // promenade strip
];

/** Crate stacks: [x, z], tiers of 0.72 m cubes; clusters hug walls and sites. */
const CRATES: readonly (readonly [number, number, number])[] = [
  [-35.1, -6.6, 2], // A site, against the west perimeter wall
  [-25.6, -6.0, 2], // A site, behind the standing plate
  [-19.2, 1.6, 1], // A↔mid passage mouth
  [-18.4, 2.6, 1],
  [30.5, -0.5, 2], // B site anchor stack
  [31.7, -1.2, 1],
  [19, -13.5, 2], // quay-north pocket, against BE's east face
  [22.5, 9.3, 2], // B site, against SE's north face
  [-6.5, -6.4, 1], // mid north-west
  [7.4, 6.6, 2], // mid south-east
  [-7.4, 30.2, 1], // T spawn west
  [-13, 14.6, 2], // junction square, against TW's north face
  [-3, 15.6, 1],
  [35.6, 8.2, 1], // outside long, against EW's west face
  [36.4, 9.0, 1],
  [36.2, -6.6, 1], // dock plaza
  [3.4, -17.6, 1], // on the back plat
  [26, -24.5, 1], // on heaven
];

const BARRELS: readonly (readonly [number, number])[] = [
  [-33.2, -6.4],
  [-34.2, -4.9],
  [33, 0.2],
  [32.6, -2.4],
  [20.4, -12.6],
  [7.2, 7.9],
  [-6.6, 29.4],
  [-5.5, 30.2],
  [34.7, 7.4],
  [-4.3, -19.4], // back plat edge
  [26.6, -23.2], // heaven
  [36.2, -6.8],
];

/**
 * Palms, re-audited against the reference sheet and against playability.
 *
 * In the references the palms sit at the map's edges: the dock plaza, a plaza
 * corner, the back of a spawn — never mid-lane. The previous table had two
 * trees standing more than two metres INSIDE a building, one in the middle of
 * the six-metre south corridor, one 0.8 m off a patrol line and 3 m from the
 * plate the player shoots first, and one at the mouth of the A↔short-A route
 * where it filled the centre of the screen. A palm in a sightline on a bomb
 * map is a bug, so every entry here now hugs a building face or a plaza
 * corner, clears every wall, and stays out of the lanes.
 *
 * Palms carry no collider and are not `hittable`, unchanged from before: the
 * enemy nav grid and every committed ballistics scenario are written against
 * the solids, and a trunk is too slim to be worth changing that for.
 */
const PALMS: readonly PalmPlacement[] = [
  [39.5, -8.6], // dock plaza, north end of the quay walk
  [39.6, -3.6], // dock plaza, south end of the quay walk
  [33.1, -8.9], // dock plaza west corner, clear of the promenade mouth
  [35.9, 6.2], // outside long, tight into the north-east corner
  [21.6, -14.6], // quay-north pocket behind the catwalk
  [17.2, 30.6], // south corridor, hard against the north street wall
  [-34.3, 8.6], // A site south-west corner
  [-21.9, -7.5], // A site north-east corner, in the building return
  [-10.6, 27.2], // T main, tucked behind TW's south-east corner
  [-7.6, 36.6], // T spawn south-west corner, behind the player
  [7.4, 36.4], // T spawn south-east corner, behind the player
  [-2.7, -38.4], // CT spawn, back corner
  [12.6, -38.6], // CT spawn, back corner
];

/**
 * The yellow panel van, parked against a T MAIN street wall.
 *
 * Placement is not a matter of taste here, so the reasoning is written down.
 * The reference frame has the van against the lane's right-hand wall, which on
 * this map is TE's west face at x = 2 — and that is the one wall it cannot
 * have. The T-spawn opening view is a straight shot up x = 0 to the mid plate
 * at (0, 9.9); a 1.9 m van hugging x = 2 leaves five centimetres of that
 * sightline, which is a bug on a bomb map, not a prop. So it parks on the
 * lane's other continuous wall, TW's east face at x = −12, where:
 *
 *   * the body clears the wall by 0.47 m and the mirrors by 0.30 m, which is
 *     more than the 0.22 m a facade door surround stands proud;
 *   * the east flank stops at x = −9.2, so the mid-plate sightline is clear by
 *     over nine metres;
 *   * the T-main plate at (−11.9, 22) stays 1.2 m clear to the south, and the
 *     approach to it from T spawn never crosses the van;
 *   * the palm at (−10.6, 27.2) is four metres further south — the previous
 *     candidate spot was straight through it;
 *   * the nearest patrol leg, the west rover's (−16, 10) → (−7, 18), passes
 *     2.5 m from the van's centre and about 1.3 m from its nearest corner.
 *
 * Nose points +z, at the player walking up from T spawn, like the reference.
 */
const VANS: readonly VanPlacement[] = [{ x: -10.25, z: 18.4, yaw: -Math.PI / 2 + 0.05 }];

/**
 * The fishing boat, moored on the north flank of the dock pier's outer half.
 * Out over open water beyond the quay: no collider, nothing to snag, and every
 * committed ballistics scenario is unaffected. Its hull spans z −10.76…−8.65
 * against pier posts whose outer edge is at −8.12, so it clears them by half a
 * metre even at the top of its roll.
 */
const BOATS: readonly BoatPlacement[] = [
  {
    x: 51.5,
    z: -9.7,
    yaw: 0.1,
    waterY: -1.1,
    moorTo: [53.5, 0.05, -7.9],
  },
];

function addSolid(
  group: Group,
  colliders: TownCollider[],
  hittable: Mesh[],
  material: Mesh["material"],
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  name?: string,
): Mesh {
  // Its own geometry, in world space, with world-metre UVs. A shared unit box
  // scaled per mesh is what let the projection instance these, and a grid cannot
  // ride that: one unit box has one set of UVs, so a 30 m wall and a 0.78 m crate
  // would show the same single tile. `worldGridUVs` needs world positions, so the
  // box is built at size and translated rather than scaled.
  const mesh = new Mesh(gridSolid(size, at), material);
  if (name !== undefined) mesh.name = name;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  hittable.push(mesh);
  colliders.push({
    min: [at[0] - size[0] / 2, at[1] - size[1] / 2, at[2] - size[2] / 2],
    max: [at[0] + size[0] / 2, at[1] + size[1] / 2, at[2] + size[2] / 2],
  });
  return mesh;
}

/** Pure decoration: no collider, never a bullet stop nor a sight blocker. */
function addProp(
  group: Group,
  material: Mesh["material"],
  size: readonly [number, number, number],
  at: readonly [number, number, number],
  name?: string,
): Mesh {
  const mesh = new Mesh(gridSolid(size, at), material);
  if (name !== undefined) mesh.name = name;
  mesh.castShadow = false;
  group.add(mesh);
  return mesh;
}

// Frustum cylinders cannot share the unit cylinder's scale form, but the same
// frustum is built many times (bollards, pier posts), so they cache by shape —
// identical reasoning to `roundedBox`'s cache, one floor up.
const frustumCache = new Map<string, CylinderGeometry>();
function frustumCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
): CylinderGeometry {
  const key = `${radiusTop},${radiusBottom},${height},${segments}`;
  let geometry = frustumCache.get(key);
  if (geometry === undefined) {
    geometry = new CylinderGeometry(radiusTop, radiusBottom, height, segments);
    frustumCache.set(key, geometry);
  }
  return geometry;
}

function addCylinderProp(
  group: Group,
  material: Mesh["material"],
  radiusTop: number,
  radiusBottom: number,
  height: number,
  segments: number,
  at: readonly [number, number, number],
  name?: string,
  castsShadow = false,
): Mesh {
  // A straight cylinder is a shared unit cylinder scaled by (r, h, r); a
  // frustum (top radius ≠ bottom) has no scale form and keeps its own geometry.
  const frustum = radiusTop !== radiusBottom;
  const source = frustum
    ? frustumCylinder(radiusTop, radiusBottom, height, segments)
    : unitCylinder(segments);
  const mesh = new Mesh(
    worldGridUVs(frustum ? source : source.clone().scale(radiusTop, height, radiusTop)),
    material,
  );
  if (name !== undefined) mesh.name = name;
  mesh.position.set(at[0], at[1], at[2]);
  mesh.castShadow = castsShadow;
  group.add(mesh);
  return mesh;
}

/** Flat painted ring plus an extruded flat letter, both from box geometry. */
let siteRingGeometry: RingGeometry | undefined;
function ringGeometry(): RingGeometry {
  siteRingGeometry ??= new RingGeometry(2.1, 2.75, 48);
  return siteRingGeometry;
}

function addSiteMark(
  group: Group,
  materials: TownMaterials,
  mark: (typeof SITE_MARKS)[number],
): void {
  const ring = new Mesh(ringGeometry(), materials.siteMark);
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(mark.at[0], 0.015, mark.at[1]);
  ring.receiveShadow = true;
  group.add(ring);

  const letter = new Group();
  // Built upright in the XZ plane with up = −z, then turned to face the approach.
  const stroke = (
    size: readonly [number, number],
    at: readonly [number, number],
    tilt = 0,
  ): void => {
    const leg = new Mesh(worldGridUVs(new BoxGeometry(size[0], size[1], 0.03)), materials.siteMark);
    leg.rotation.x = -Math.PI / 2;
    leg.rotation.z = tilt;
    leg.position.set(at[0], 0.026, at[1]);
    letter.add(leg);
  };
  if (mark.letter === "A") {
    stroke([0.34, 1.5], [-0.52, 0.1], 0.36);
    stroke([0.34, 1.5], [0.52, 0.1], -0.36);
    stroke([1.3, 0.3], [0, -0.28]);
  } else {
    stroke([0.3, 1.5], [-0.5, 0]);
    stroke([0.3, 1.5], [0.5, 0]);
    stroke([1.3, 0.3], [0, 0.68]);
    stroke([1.3, 0.3], [0, 0]);
    stroke([1.3, 0.3], [0, -0.68]);
  }
  // Readable from the approach face: the strokes were authored readable from
  // +z (south), so turn by the inverse of the approach azimuth.
  const normal = FACE_NORMAL[mark.approach];
  letter.rotation.y = Math.atan2(normal[0], normal[1]);
  letter.position.set(mark.at[0], 0, mark.at[1]);
  group.add(letter);
}

/**
 * Stepped stairs the character body actually climbs: visual steps plus one
 * collider each. Works for descending flights too — each step is solid from
 * the flight's low end up to that step's walking surface. A descending step
 * landing exactly on its base is skipped so every collider stays positive.
 */
function addStairs(
  group: Group,
  colliders: TownCollider[],
  hittable: Mesh[],
  material: Mesh["material"],
  width: number,
  from: readonly [number, number, number],
  to: readonly [number, number, number],
): void {
  const dx = to[0] - from[0];
  const dz = to[2] - from[2];
  const dy = to[1] - from[1];
  const run = Math.hypot(dx, dz);
  const steps = Math.max(2, Math.ceil(Math.abs(dy) / 0.32));
  const stepRun = run / steps;
  const ux = dx / run;
  const uz = dz / run;
  const baseY = Math.min(from[1], to[1]);
  for (let index = 0; index < steps; index += 1) {
    const topY = from[1] + ((index + 1) / steps) * dy;
    // A descending flight's last step lands exactly on its base: nothing to build.
    if (topY - baseY < 0.01) continue;
    const depth = stepRun + 0.3;
    const centreX = from[0] + ux * stepRun * (index + 0.5);
    const centreZ = from[2] + uz * stepRun * (index + 0.5);
    const height = topY - baseY;
    const size: readonly [number, number, number] = [
      ux !== 0 ? depth : width,
      height,
      uz !== 0 ? depth : width,
    ];
    const mesh = new Mesh(gridSolid(size, [centreX, baseY + height / 2, centreZ]), material);
    mesh.name = "stair-step";
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
    hittable.push(mesh);
    colliders.push({
      min: [centreX - size[0] / 2, baseY, centreZ - size[2] / 2],
      max: [centreX + size[0] / 2, topY, centreZ + size[2] / 2],
    });
  }
}

/** Visual-only guard rail along a deck edge: posts and a top beam. */
function addRail(
  group: Group,
  material: Mesh["material"],
  from: readonly [number, number],
  to: readonly [number, number],
  baseY: number,
): void {
  const ax = from[0];
  const az = from[1];
  const bx = to[0];
  const bz = to[1];
  const length = Math.hypot(bx - ax, bz - az);
  if (length < 0.5) return;
  const posts = Math.max(2, Math.round(length / 3) + 1);
  for (let index = 0; index < posts; index += 1) {
    const t = index / (posts - 1);
    addCylinderProp(group, material, 0.035, 0.035, 0.95, 5, [
      ax + (bx - ax) * t,
      baseY + 0.475,
      az + (bz - az) * t,
    ]);
  }
  addProp(
    group,
    material,
    ax === bx ? [0.07, 0.07, length] : [length, 0.07, 0.07],
    [(ax + bx) / 2, baseY + 0.92, (az + bz) / 2],
    "deck-rail",
  );
}

/** The floor marks are named because the schematic's site letters trace their
 * positions. */
const B_SITE_MARK = { at: [27, 3], letter: "B", approach: "w" } as const;

/** A site plaza, mid courtyard, B site plaza and T spawn stay open. */
const SITE_MARKS: readonly {
  readonly at: readonly [number, number];
  readonly letter: "A" | "B";
  readonly approach: Face;
}[] = [A_SITE_MARK, B_SITE_MARK];

/** Rooftop power lines: thin dark catenary spans between neighbouring roofs,
 * purely visual — they never block a bullet or a sight line. */
const WIRES: readonly (readonly [number, number, number, number, number, number])[] = [
  // Across the CT yard: north band's tall setback storey to the north-east corner.
  [-10, 9.4, -26, 20, 7.4, -36],
  // Across mid: back-plat row's setback roof to the mid-west wall.
  [16, 8.4, -15, -13, 6.0, -4],
  // Across T main: the south-west block to TW's roofline.
  [-16, 6.0, 22, 6, 7.5, 18],
  // Across B site: the connector's street wall to outside-long's west face.
  [22, 6.2, 18, 38, 6.8, 17],
  // Along the waterfront: quay-north block to the B-site waterfront row.
  [34, 6.0, -23, 36, 5.4, -13],
];

/** One sagging wire: a three-point curve dipped below the chord. */
function addWire(
  group: Group,
  materials: TownMaterials,
  wire: readonly [number, number, number, number, number, number],
): void {
  const [ax, ay, az, bx, by, bz] = wire;
  const midX = (ax + bx) / 2;
  const midY = (ay + by) / 2 - Math.hypot(bx - ax, bz - az) * 0.05 - 0.25;
  const midZ = (az + bz) / 2;
  const curve = new CatmullRomCurve3([
    new Vector3(ax, ay, az),
    new Vector3(midX, midY, midZ),
    new Vector3(bx, by, bz),
  ]);
  const points = curve.getPoints(24);
  const geometry = new BufferGeometry();
  geometry.setFromPoints(points);
  const wireLine = new Line(geometry, materials.steelMast);
  wireLine.name = "roof-wire";
  group.add(wireLine);
}

/**
 * Raised-deck footprints, stated once and read three times: the deck meshes
 * place themselves from these, the under-deck observation gets them as
 * `Town.decks`, and the minimap schematic traces them — one edit moves all
 * three. The numbers are the deck's walking surface extents on the ground
 * plane; heights live with the meshes below.
 */

export function buildTown(materials: TownMaterials): Town {
  const group = new Group();
  group.name = "town";
  const hittable: Mesh[] = [];
  const colliders: TownCollider[] = [];

  // Street deck.
  const deck = new Mesh(
    worldGridUVs(new PlaneGeometry(TOWN, TOWN).rotateX(-Math.PI / 2)),
    materials.ground,
  );
  deck.receiveShadow = true;
  // Named "street", not "deck": the wood name rule exists for the pier and catwalk planking and
  // matches any name containing "deck", so calling the stone street deck tagged the whole town
  // floor as wood — wrong impact cue, wrong debris, wrong decal tint, on every ground shot.
  deck.name = "street";
  group.add(deck);
  hittable.push(deck);

  // Plaza tints read a shade apart from the lanes — kerb-edged slabs, never
  // painted bitmaps (CanvasTexture samples black under WebGPURenderer).
  for (const plaza of PLAZAS) {
    const slab = new Mesh(
      gridSolid(
        [plaza.x[1] - plaza.x[0], 0.03, plaza.z[1] - plaza.z[0]],
        [(plaza.x[0] + plaza.x[1]) / 2, 0.015, (plaza.z[0] + plaza.z[1]) / 2],
      ),
      materials[plaza.finish],
    );
    slab.name = "plaza";
    slab.receiveShadow = true;
    group.add(slab);
    // Hittable, or a round fired at a plaza passes straight through the paving the player can
    // see and registers on the street plane 3 cm below — which put every impact cue, burst and
    // bullet hole on the wrong surface, and buried the hole inside the slab.
    hittable.push(slab);
  }

  // Sea east of the quay, one huge plane well below street level, with pale
  // shallows hugging the wall.
  const water = new Mesh(new PlaneGeometry(220, 260), materials.water);
  water.rotation.x = -Math.PI / 2;
  water.position.set(WATER_X + 108, -1.1, -10);
  group.add(water);
  const shallows = new Mesh(
    gridSolid([5.5, 0.04, 260], [WATER_X + 2.75, -0.96, -10]),
    materials.shallow,
  );
  group.add(shallows);

  // Quay wall along the east edge, with the dock gap z −10…−2 left open.
  addSolid(
    group,
    colliders,
    hittable,
    materials.quay,
    [1.4, 1.1, 32],
    [WATER_X - 0.7, 0.55, -26],
    "quay-n",
  );
  addSolid(
    group,
    colliders,
    hittable,
    materials.quay,
    [1.4, 1.1, 44],
    [WATER_X - 0.7, 0.55, 20],
    "quay-s",
  );
  for (const z of [-20, -14, 6, 16, 26]) {
    addCylinderProp(
      group,
      materials.steelPost,
      0.13,
      0.16,
      0.55,
      8,
      [WATER_X - 0.7, 1.38, z],
      "bollard",
      true,
    );
  }

  // Dock pier: plank deck on posts, running east into the water at the
  // north-east waterfront from the PIER span above — the same numbers the
  // schematic's centre-line draws.
  const pierDeck = new Mesh(
    gridSolid([PIER.x1 - PIER.x0, 0.24, 4.4], [(PIER.x0 + PIER.x1) / 2, 0.12, PIER.z]),
    materials.deckWood,
  );
  pierDeck.name = "pier-deck";
  pierDeck.castShadow = true;
  pierDeck.receiveShadow = true;
  group.add(pierDeck);
  hittable.push(pierDeck);
  colliders.push({
    min: [PIER.x0, 0, -8.2],
    max: [PIER.x1, 0.24, -3.8],
  });
  for (let index = 0; index < 4; index += 1) {
    for (const side of [-1, 1]) {
      const post = new Mesh(worldGridUVs(frustumCylinder(0.18, 0.22, 2.4, 6)), materials.deckWood);
      post.name = "pier-post";
      post.position.set(PIER.x0 + 2.5 + index * 5, -1.08, PIER.z + side * 1.9);
      post.castShadow = true;
      group.add(post);
    }
  }
  for (const side of [-1, 1]) {
    const railBeam = new Mesh(
      gridSolid(
        [PIER.x1 - PIER.x0, 0.07, 0.07],
        [(PIER.x0 + PIER.x1) / 2, 1.16, PIER.z + side * 2.05],
      ),
      materials.steelMast,
    );
    railBeam.name = "pier-rail";
    group.add(railBeam);
    for (let index = 0; index < 5; index += 1) {
      addCylinderProp(group, materials.steelMast, 0.04, 0.04, 0.95, 5, [
        PIER.x0 + 1.5 + index * 4.25,
        0.72,
        PIER.z + side * 2.05,
      ]);
    }
  }

  // Buildings: continuous street walls with parapets, joinery and clutter.
  // Every face piece is accumulated by `facade` and merged per material by
  // `finishFacade` below, so ~900 small meshes cost a few dozen draw calls.
  const facade = createFacade(group, hittable, colliders, materials, BUILDINGS);
  BUILDINGS.forEach((spec, index) => {
    const [x0, x1] = spec.x;
    const [z0, z1] = spec.z;
    const w = x1 - x0;
    const d = z1 - z0;
    const pool = spec.brick === true ? materials.brick : materials.plaster;
    addSolid(
      group,
      colliders,
      hittable,
      pool(spec.brick === true ? d : w),
      [w, spec.h, d],
      [(x0 + x1) / 2, spec.h / 2, (z0 + z1) / 2],
      "building",
    );
    addRoofLife(facade, spec, index);
    // `j` names the faces someone judged lane-facing; `visibleFaces` adds any
    // other face a neighbouring block does not bury, because several walls a
    // player stands right next to were missing from those lists.
    for (const face of visibleFaces(facade, spec, spec.j ?? [])) {
      addDoorsAndShutters(facade, spec, face, index * 8 + FACE_INDEX[face]);
    }
  });

  // Round-headed passages through a building: the arcade of the CONNECTOR
  // reference frame. Both sit in lanes no patrol route crosses, and only their
  // piers and the mass over the opening carry colliders, so a player and a
  // soldier walk straight through.
  for (const gateway of BAYVIEW_ARCHES) addArchGateway(facade, gateway);

  // Raised decks: back plat y 2.4, heaven y 4.8, catwalk bridge y 2.4. Each
  // slab places itself from its footprint constant above, which the schematic
  // and the under-deck observation share.
  const backPlat = addSolid(
    group,
    colliders,
    hittable,
    materials.deckWood,
    [
      BACK_PLAT_DECK.maxX - BACK_PLAT_DECK.minX,
      DECK_THICKNESS,
      BACK_PLAT_DECK.maxZ - BACK_PLAT_DECK.minZ,
    ],
    [
      (BACK_PLAT_DECK.minX + BACK_PLAT_DECK.maxX) / 2,
      2.4 - DECK_THICKNESS / 2,
      (BACK_PLAT_DECK.minZ + BACK_PLAT_DECK.maxZ) / 2,
    ],
    "back-plat",
  );
  void backPlat;
  addStairs(group, colliders, hittable, materials.deckWood, 3.2, [3, 0, -30], [3, 2.4, -22]);
  addStairs(group, colliders, hittable, materials.deckWood, 3.2, [5, 2.4, -10], [5, 0, -8]);

  const heaven = addSolid(
    group,
    colliders,
    hittable,
    materials.deckWood,
    [HEAVEN_DECK.maxX - HEAVEN_DECK.minX, DECK_THICKNESS, HEAVEN_DECK.maxZ - HEAVEN_DECK.minZ],
    [
      (HEAVEN_DECK.minX + HEAVEN_DECK.maxX) / 2,
      4.8 - DECK_THICKNESS / 2,
      (HEAVEN_DECK.minZ + HEAVEN_DECK.maxZ) / 2,
    ],
    "heaven",
  );
  void heaven;
  addStairs(group, colliders, hittable, materials.deckWood, 3.2, [17.5, 0, -25], [20, 4.8, -25]);

  // Catwalk bridge on posts from the back plat's south-east corner to B site.
  const catwalkDeck = new Mesh(
    gridSolid(
      [CATWALK_DECK.maxX - CATWALK_DECK.minX, 0.22, CATWALK_DECK.maxZ - CATWALK_DECK.minZ],
      [
        (CATWALK_DECK.minX + CATWALK_DECK.maxX) / 2,
        2.29,
        (CATWALK_DECK.minZ + CATWALK_DECK.maxZ) / 2,
      ],
    ),
    materials.deckWood,
  );
  catwalkDeck.name = "catwalk-deck";
  catwalkDeck.castShadow = true;
  catwalkDeck.receiveShadow = true;
  group.add(catwalkDeck);
  hittable.push(catwalkDeck);
  colliders.push({
    min: [CATWALK_DECK.minX, 0, CATWALK_DECK.minZ],
    max: [CATWALK_DECK.maxX, 2.4, CATWALK_DECK.maxZ],
  });
  for (const z of [-14.6, -9, -3.4]) {
    for (const side of [-1, 1]) {
      const post = new Mesh(
        gridSolid([0.22, 2.18, 0.22], [25 + side * 1.1, 1.09, z]),
        materials.steelPost,
      );
      post.name = "catwalk-post";
      post.castShadow = true;
      group.add(post);
    }
  }
  addStairs(group, colliders, hittable, materials.deckWood, 2.6, [25, 4.8, -19.5], [25, 2.4, -16]);
  addStairs(group, colliders, hittable, materials.deckWood, 2.6, [25, 2.4, -2], [25, 0, -4]);

  // Guard rails ride every open deck edge; purely visual, so traversal and
  // ballistics stay exactly as the playtests know them.
  const RAILS: readonly [readonly [number, number], readonly [number, number], number][] = [
    // Back plat, stair gaps kept clear.
    [[0, -22], [1.4, -22], 2.4],
    [[4.6, -22], [12, -22], 2.4],
    [[0, -22], [0, -10], 2.4],
    [[12, -22], [12, -10], 2.4],
    [[0, -10], [3.4, -10], 2.4],
    [[6.6, -10], [12, -10], 2.4],
    // Heaven, stair gaps kept clear.
    [[20, -30], [30, -30], 4.8],
    [[30, -30], [30, -20], 4.8],
    [[20, -30], [20, -26.6], 4.8],
    [[20, -23.4], [20, -20], 4.8],
    [[20, -20], [23.7, -20], 4.8],
    [[26.3, -20], [30, -20], 4.8],
    // Catwalk sides.
    [[23.7, -16.3], [23.7, -1.7], 2.4],
    [[26.3, -16.3], [26.3, -1.7], 2.4],
  ];
  for (const [from, to, baseY] of RAILS) {
    addRail(group, materials.steelMast, from, to, baseY);
  }

  // Site markers.
  for (const mark of SITE_MARKS) addSiteMark(group, materials, mark);

  // Rooftop power lines between neighbouring roofs; visual dressing only.
  for (const wire of WIRES) addWire(group, materials, wire);

  // Crates and barrels: clusters against walls and on the sites.
  CRATES.forEach(([x, z, tiers], crateIndex) => {
    const rowDir = hash(crateIndex * 3.7) > 0.5 ? 1 : 0;
    for (let tier = 0; tier < tiers; tier += 1) {
      const rows = tier === 0 ? 2 : 1;
      for (let row = 0; row < rows; row += 1) {
        const lateral = tier === 0 ? (row === 0 ? -0.42 : 0.44) : 0;
        addSolid(
          group,
          colliders,
          hittable,
          materials.crate,
          [0.78, 0.78, 0.78],
          [x + (rowDir === 0 ? lateral : 0), 0.39 + tier * 0.8, z + (rowDir === 1 ? lateral : 0)],
          "crate",
        );
      }
    }
  });
  for (const [x, z] of BARRELS) {
    const barrel = new Mesh(
      worldGridUVs(unitCylinder(10).clone().scale(0.32, 0.92, 0.32)),
      materials.barrel,
    );
    barrel.name = "barrel";
    barrel.position.set(x, 0.46, z);
    barrel.castShadow = true;
    barrel.receiveShadow = true;
    group.add(barrel);
    hittable.push(barrel);
    colliders.push({ min: [x - 0.32, 0, z - 0.32], max: [x + 0.32, 0.92, z + 0.32] });
  }

  // Palms: three prototype trees, instanced across the placement table.
  addPalms(group, materials, PALMS);

  // Vehicles: no CC0 asset for either exists, so both are sculpted in code.
  // The van is a solid the player can hide behind; the boat is out at sea and
  // gets no collider at all.
  for (const van of VANS) colliders.push(addVan(group, hittable, materials, van));
  for (const boat of BOATS) addFishingBoat(group, materials, boat);

  // Player spawns T spawn centre facing north into the town.
  const spawn: TownSpawn = { x: 0, z: 32, yaw: 0 };

  // Scoring plates across the callouts; each faces its lane. The mid plate
  // stands straight north of spawn so the opening view reads like the
  // reference frame: sign ahead, sea down the lanes to the east.
  const targets: TargetSpec[] = [
    { position: new Vector3(-30.5, 1.65, 7.9), value: 250, yaw: Math.PI / 2 }, // A site west
    { position: new Vector3(-25.5, 2.35, -5.6), value: 300, standing: true }, // A site crates
    { position: new Vector3(0, 1.6, 9.9), value: 150, yaw: 0 }, // mid south lane, ahead of spawn
    { position: new Vector3(9.9, 1.55, 4), value: 100, yaw: -Math.PI / 2 }, // mid east edge
    { position: new Vector3(24, 1.65, 9.9), value: 250, yaw: Math.PI }, // B site north wall
    { position: new Vector3(30.5, 2.35, -0.5), value: 300, standing: true }, // B site crates
    { position: new Vector3(25, 3.9, -2.6), value: 250, yaw: 0 }, // catwalk south end, high over B
    { position: new Vector3(36.9, 1.65, 18), value: 150, yaw: -Math.PI / 2 }, // outside long east wall
    { position: new Vector3(35, 1.55, 29.5), value: 100, yaw: Math.PI }, // outside long south end
    { position: new Vector3(-11.9, 1.65, 22), value: 150, yaw: Math.PI / 2 }, // T main west wall
  ];

  // Patrol loops, one per soldier, all on the ground — five of them, like a
  // full T side holding the town.
  const enemyRoutes: TownRoute[] = [
    // Mid defender: mid courtyard ↔ connector ↔ B site.
    [
      new Vector3(0, 0, 0),
      new Vector3(13, 0, 4),
      new Vector3(26, 0, 2),
      new Vector3(24, 0, 8),
      new Vector3(12, 0, 5),
    ],
    // West rover: A site ↔ short A ↔ T main ↔ T spawn edge.
    [
      new Vector3(-28, 0, 0),
      new Vector3(-16, 0, 10),
      new Vector3(-7, 0, 18),
      new Vector3(0, 0, 26),
    ],
    // Waterfront rover: outside long ↔ B site ↔ quay north.
    [
      new Vector3(35, 0, 26),
      new Vector3(30, 0, 4),
      new Vector3(28, 0, -6),
      new Vector3(24, 0, -12),
    ],
    // North rover: CT yard ↔ beneath the back plat ↔ mid north face.
    [
      new Vector3(7, 0, -27),
      new Vector3(-4, 0, -16),
      new Vector3(-4, 0, -4),
      new Vector3(6, 0, -12),
    ],
    // South rover: T spawn ↔ mid south ↔ connector south.
    [
      new Vector3(0, 0, 29),
      new Vector3(-6, 0, 14),
      new Vector3(4, 0, 9),
      new Vector3(13, 0, 9),
      new Vector3(8, 0, 22),
    ],
  ];

  // Raised deck footprints, for the under-the-deck observation.
  const decks: DeckFootprint[] = [BACK_PLAT_DECK, HEAVEN_DECK, CATWALK_DECK];

  // Every solid now exists carrying its final material, so this one walk can
  // tag them all — while a crate is still called "crate": the engine
  // merges the settled town later, and a hit still names the authored mesh.
  tagSurfaces(hittable, materials);

  return {
    group,
    hittable,
    colliders,
    spawn,
    targets,
    enemyRoutes,
    decks,
    schematic: townSchematic,
  };
}
