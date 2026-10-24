// Generated for you. This is ordinary Three.js — edit or delete it freely.
//
// The island's planting: a meadow of tall swaying grass, broadleaf trees with soft canopies,
// white-bark birches, bushes, two hedge arcs, red, orange, white and yellow flowers, butterflies,
// pebbles on the path and stones in the grass, and the islet's beach. Every kind is one
// `InstancedMesh` (the grass one per 12 m cell, so the camera culls what it does not see), and
// every plant stands on the terrain's own height. Nothing here is solid: the hero walks through a
// bush as it walks through a tree trunk, and the course's metres stay the course's. Placement is
// seeded and asks the course where planting may go (`clear`).
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  type Material,
  Mesh,
  Object3D,
  OctahedronGeometry,
  RingGeometry,
} from "three";
import {
  abs,
  hash,
  instanceIndex,
  positionGeometry,
  positionLocal,
  sin,
  time,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";
import { flat, lit, mottle } from "./materials.js";
import { C } from "./palette.js";

/** x, y, z, scale x, y, z, rotation x, y, z. */
type Placement = readonly [number, number, number, number, number, number, number, number, number];

export interface IPlantingSite {
  readonly rng: () => number;
  /** The terrain's extent; planting stays on land inside it. */
  readonly bounds: {
    readonly minX: number;
    readonly maxX: number;
    readonly minZ: number;
    readonly maxZ: number;
  };
  /** Whether a plant this wide may stand at (x, z): off the landmarks and the routes. */
  clear(x: number, z: number, width: number): boolean;
  ground(x: number, z: number): number;
  /** The ground normal's up component: under 0.8 is a rock face, where nothing grows. */
  flatness(x: number, z: number): number;
  /** Metres from the nearest dirt path's centre line (the path is about 1.2 m each side). */
  pathDistance(x: number, z: number): number;
  /** Islands that get a sand-and-foam beach ring: x, z, cliff radius at the waterline. */
  readonly shores: readonly (readonly [number, number, number])[];
  readonly seaLevel: number;
  /** Share of the grass tufts drawn, 0..1: the quality tier's (`GRASS_SHARE` in `quality.ts`). */
  readonly grassShare: number;
}

const dummy = new Object3D();
// Yaw last: a placement leans or droops about X, then turns to face its way round Y.
dummy.rotation.order = "YXZ";

function instanced(
  geometry: BufferGeometry,
  material: Material,
  placements: readonly Placement[],
  castShadow: boolean,
  tints?: readonly Color[],
): InstancedMesh {
  const mesh = new InstancedMesh(geometry, material, Math.max(1, placements.length));
  mesh.count = placements.length;
  placements.forEach(([x, y, z, sx, sy, sz, rx, ry, rz], i) => {
    dummy.position.set(x, y, z);
    dummy.scale.set(sx, sy, sz);
    dummy.rotation.set(rx, ry, rz);
    dummy.updateMatrix();
    mesh.setMatrixAt(i, dummy.matrix);
    const tint = tints?.[i];
    if (tint !== undefined) mesh.setColorAt(i, tint);
  });
  mesh.computeBoundingSphere();
  mesh.castShadow = castShadow;
  mesh.receiveShadow = true;
  return mesh;
}

/** A lit material whose vertices above y = 0 sway with the wind, each instance on its own phase. */
function swaying(color: number, amount: number, options: { vertexColors?: boolean } = {}) {
  const material = new MeshStandardNodeMaterial({
    color,
    roughness: 0.8,
    side: DoubleSide,
    vertexColors: options.vertexColors ?? false,
  });
  const phase = hash(instanceIndex).mul(6.28);
  // `positionGeometry`, not `positionLocal`: an instanced mesh's `positionLocal` already carries the
  // instance matrix, so its y is the blade's height above the sea, not above its root.
  const height = positionGeometry.y.max(0);
  const bend = height.mul(height).mul(amount);
  // A slow gust under a quick flutter, both along +X with a little cross-wind.
  const gust = sin(time.mul(0.9).add(phase.mul(0.3)))
    .mul(0.6)
    .add(0.7);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(2.3).add(phase)).mul(0.35).add(gust).mul(bend),
      0,
      sin(time.mul(1.7).add(phase.mul(1.7)))
        .mul(bend)
        .mul(0.4),
    ),
  );
  return material;
}

/** Blades in one grass tuft: every tuft is this many triangles. */
export const TUFT_BLADES = 12;

/**
 * A clump of single-triangle blades, 1 m tall before scaling, leaning out from its centre and all
 * bending one way, as wind-combed meadow grass does. Every normal points up, so a blade lights like
 * the lawn it grows from, not like a dark sliver edge-on to the sun, and the vertex colour runs
 * from the lawn's own green at the root to a sunlit yellow-green tip.
 */
function tuftGeometry(rng: () => number): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  for (let b = 0; b < TUFT_BLADES; b += 1) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * 0.32;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const h = 0.6 + rng() * 0.4;
    // Lean out from the centre, plus a shared comb toward +X.
    const lean = 0.1 + rng() * 0.25;
    const across = a + Math.PI / 2;
    const w = 0.022 + rng() * 0.016;
    const tip = 0.95 + rng() * 0.25;
    positions.push(
      x - Math.cos(across) * w,
      0,
      z - Math.sin(across) * w,
      x + Math.cos(across) * w,
      0,
      z + Math.sin(across) * w,
      x + (Math.cos(a) * lean + 0.18) * h,
      h,
      z + Math.sin(a) * lean * h,
    );
    colors.push(0.78, 0.8, 0.78, 0.78, 0.8, 0.78, 1.18 * tip, 1.12 * tip, 0.7 * tip);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute(
    "normal",
    new BufferAttribute(
      new Float32Array(positions.length).map((_, i) => (i % 3 === 1 ? 1 : 0)),
      3,
    ),
  );
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colors), 3));
  return geometry;
}

/**
 * A leafy canopy lump: a sphere pushed in and out by seeded noise, darker underneath, with the
 * sphere's own smooth normals so the lump shades soft instead of in facets.
 */
function canopyGeometry(rng: () => number, detail = 1): BufferGeometry {
  const geometry = new IcosahedronGeometry(1, detail);
  const normal = geometry.attributes.normal;
  const position = geometry.attributes.position;
  const offsets = Array.from({ length: 6 }, () => [rng() * 6, rng() * 6, rng() * 6] as const);
  const colors = new Float32Array((position?.count ?? 0) * 3);
  for (let i = 0; i < (position?.count ?? 0); i += 1) {
    const x = position?.getX(i) ?? 0;
    const y = position?.getY(i) ?? 0;
    const z = position?.getZ(i) ?? 0;
    let bump = 1;
    for (const [ox, oy, oz] of offsets)
      bump += 0.05 * Math.sin(x * 4 + ox) * Math.sin(y * 4 + oy) * Math.sin(z * 4 + oz) * 2;
    position?.setXYZ(i, x * bump, y * bump, z * bump);
    normal?.setXYZ(i, x, y, z);
    const k = 0.55 + 0.45 * Math.min(1, Math.max(0, (y + 0.6) / 1.4));
    colors.set([k, k, k], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** A birch trunk: white bark with dark horizontal lenticels and a darker foot, base at the origin. */
function birchGeometry(rng: () => number): BufferGeometry {
  const geometry = new CylinderGeometry(0.09, 0.15, 1, 8, 24).translate(0, 0.5, 0);
  const position = geometry.attributes.position;
  const colors = new Float32Array((position?.count ?? 0) * 3);
  const rows = Array.from({ length: 25 }, () => Array.from({ length: 9 }, () => rng()));
  for (let i = 0; i < (position?.count ?? 0); i += 1) {
    const y = position?.getY(i) ?? 0;
    const row = rows[Math.round(y * 24)] ?? [];
    const k = (row[i % 9] ?? 0) < 0.22 ? 0.18 : y < 0.06 ? 0.45 : 1;
    colors.set([k, k, k * 0.97], i * 3);
  }
  geometry.setAttribute("color", new BufferAttribute(colors, 3));
  return geometry;
}

/** Two wings hinged on the body's line, flapping on their own phase while the insect wanders. */
function butterflies(placements: readonly Placement[], tints: readonly Color[]): InstancedMesh {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(
      new Float32Array([
        0, 0, -0.05, -0.11, 0, -0.07, -0.08, 0, 0.06, 0, 0, -0.05, 0.08, 0, 0.06, 0.11, 0, -0.07,
      ]),
      3,
    ),
  );
  geometry.computeVertexNormals();
  const material = new MeshStandardNodeMaterial({
    color: 0xffffff,
    roughness: 0.6,
    side: DoubleSide,
  });
  const phase = hash(instanceIndex).mul(6.28);
  const flap = sin(time.mul(17).add(phase)).mul(abs(positionGeometry.x)).mul(1.4);
  material.positionNode = positionLocal.add(
    vec3(
      sin(time.mul(0.45).add(phase)).mul(1.8),
      flap.add(sin(time.mul(1.3).add(phase.mul(2))).mul(0.35)),
      sin(time.mul(0.33).add(phase.mul(3))).mul(1.8),
    ),
  );
  const mesh = instanced(geometry, material, placements, false, tints);
  // The wander leaves the instance bounds; a few metres of slack keep it from being culled early.
  mesh.frustumCulled = false;
  return mesh;
}

/** The meadow's distance thinning: call `update` with the camera's position once a frame. */
export interface IMeadow {
  update(eye: { readonly x: number; readonly z: number }): void;
  /** Tufts drawn after the last `update`, and the tier's whole meadow. */
  readonly drawn: number;
  readonly total: number;
}

export function plantIsland(site: IPlantingSite): { group: Group; meadow: IMeadow } {
  const { rng, bounds, clear, ground } = site;
  const group = new Group();
  group.name = "planting";
  const spin = () => rng() * Math.PI * 2;
  const land = (x: number, z: number): boolean =>
    ground(x, z) > site.seaLevel + 1 && site.flatness(x, z) > 0.8;
  /** A random clear spot on grass, off the path, at least `width` from every route, or undefined. */
  const spot = (width: number, pathGap = width + 1.4): [number, number] | undefined => {
    for (let tries = 0; tries < 16; tries += 1) {
      const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
      const z = bounds.minZ + rng() * (bounds.maxZ - bounds.minZ);
      if (land(x, z) && site.pathDistance(x, z) > pathGap && clear(x, z, width)) return [x, z];
    }
    return undefined;
  };

  // Broadleaf trees: a stout trunk and a soft crown of seven leafy lumps, two greens.
  const trunks: Placement[] = [];
  const crowns: Placement[] = [];
  const crownTints: Color[] = [];
  for (let i = 0; i < 22; i += 1) {
    const at = spot(3.5);
    if (at === undefined) continue;
    const [x, z] = at;
    const size = 0.9 + rng() * 0.6;
    const height = 3.4 * size;
    const y = ground(x, z) - 0.2;
    trunks.push([x, y, z, 1.5 * size, height + 1, 1.5 * size, (rng() - 0.5) * 0.12, spin(), 0]);
    const tint = new Color(i % 3 === 0 ? C.canopyDeep : C.canopy);
    for (let c = 0; c < 7; c += 1) {
      const a = (c / 6) * Math.PI * 2 + rng();
      const ring = c === 0 ? 0 : 1.3 * size;
      const s = (c === 0 ? 1.9 : 1.25 + rng() * 0.4) * size;
      crowns.push([
        x + Math.cos(a) * ring,
        y + height + (c === 0 ? 1.6 : 0.4 + rng() * 0.9) * size,
        z + Math.sin(a) * ring,
        s,
        s * 0.85,
        s,
        0,
        spin(),
        0,
      ]);
      crownTints.push(tint.clone().multiplyScalar(0.9 + rng() * 0.2));
    }
  }
  const trunk = mottle(new CylinderGeometry(0.13, 0.22, 1, 8, 2).translate(0, 0.5, 0), 0.15, rng);
  group.add(instanced(trunk, lit(C.bark, { vertexColors: true }), trunks, true));
  group.add(
    instanced(
      canopyGeometry(rng),
      lit(0xffffff, { vertexColors: true, roughness: 0.9 }),
      crowns,
      true,
      crownTints,
    ),
  );

  // Birches: tall white trunks with a light crown of small lumps up their top half.
  const birches: Placement[] = [];
  const leaves: Placement[] = [];
  for (let i = 0; i < 14; i += 1) {
    const at = spot(2);
    if (at === undefined) continue;
    const [x, z] = at;
    const height = 8 + rng() * 3.5;
    const lean = (rng() - 0.5) * 0.12;
    const yaw = spin();
    const y = ground(x, z) - 0.2;
    birches.push([x, y, z, 1, height, 1, lean, yaw, 0]);
    for (let c = 0; c < 7; c += 1) {
      const t = 0.5 + (c / 7) * 0.5;
      const a = spin();
      const s = 0.9 + rng() * 0.5;
      leaves.push([
        x + Math.sin(yaw) * Math.sin(lean) * height * t + Math.cos(a) * 0.9,
        y + height * t + 0.3,
        z + Math.cos(yaw) * Math.sin(lean) * height * t + Math.sin(a) * 0.9,
        s,
        s * 0.8,
        s,
        0,
        spin(),
        0,
      ]);
    }
  }
  group.add(
    instanced(
      birchGeometry(rng),
      lit(C.birch, { vertexColors: true, roughness: 0.7 }),
      birches,
      true,
    ),
  );
  group.add(
    instanced(
      canopyGeometry(rng),
      lit(C.birchLeaf, { vertexColors: true, roughness: 0.9 }),
      leaves,
      true,
    ),
  );

  // Bushes: two or three leafy lumps.
  const blobs: Placement[] = [];
  for (let i = 0; i < 40; i += 1) {
    const at = spot(1.6);
    if (at === undefined) continue;
    const [x, z] = at;
    const size = 0.5 + rng() * 0.45;
    for (let b = 0; b < 2 + (i % 2); b += 1) {
      const a = spin();
      const bx = x + Math.cos(a) * 0.5 * size;
      const bz = z + Math.sin(a) * 0.5 * size;
      blobs.push([
        bx,
        ground(bx, bz) + 0.3 * size,
        bz,
        size * 0.8,
        size * 0.65,
        size * 0.8,
        0,
        spin(),
        0,
      ]);
    }
  }
  group.add(instanced(canopyGeometry(rng), lit(C.bush, { vertexColors: true }), blobs, true));

  // Hedge rows: two arcs of clipped hedge near the rim, broken wherever a route or landmark is.
  const hedges: Placement[] = [];
  for (const [from, to] of [
    [0.75, 1.35],
    [3.55, 4.25],
  ] as const) {
    for (let a = from; a < to; a += 2.1 / 29) {
      const x = Math.cos(a) * 29;
      const z = Math.sin(a) * 29;
      if (clear(x, z, 1.2) && land(x, z) && site.pathDistance(x, z) > 2)
        hedges.push([x, ground(x, z) - 0.1, z, 1, 1, 1, 0, -a, 0]);
    }
  }
  // A faceted, lumpy loaf 2.6 m long, so neighbours 2.1 m apart overlap into one leafy row.
  const hedge = mottle(
    new IcosahedronGeometry(1, 1).scale(0.55, 0.62, 1.3).translate(0, 0.5, 0),
    0.14,
    rng,
  );
  group.add(instanced(hedge, lit(C.hedge, { flat: true, vertexColors: true }), hedges, true));

  // Flowers: clusters in the grass, one draw per colour, on stems that sway with it.
  const petals = [C.petalRed, C.petalOrange, C.petalWhite, C.petalYellow];
  const heads: Placement[][] = petals.map(() => []);
  const stems: Placement[] = [];
  for (let i = 0; i < 110; i += 1) {
    const at = spot(0.6, 1.4);
    if (at === undefined) continue;
    const hue = heads[i % petals.length] ?? [];
    for (let f = 0; f < 7; f += 1) {
      const a = spin();
      const r = rng() * 1.1;
      const x = at[0] + Math.cos(a) * r;
      const z = at[1] + Math.sin(a) * r;
      const h = 0.35 + rng() * 0.25;
      const y = ground(x, z);
      stems.push([x, y, z, 1, h, 1, 0, 0, 0]);
      hue.push([x, y + h, z, 1.4, 0.8, 1.4, 0, spin(), 0]);
    }
  }
  const stem = new CylinderGeometry(0.012, 0.012, 1, 3).translate(0, 0.5, 0);
  group.add(instanced(stem, lit(C.blade), stems, false));
  const head = new OctahedronGeometry(0.08);
  petals.forEach((colour, i) => {
    group.add(instanced(head, lit(colour, { roughness: 0.6 }), heads[i] ?? [], false));
  });

  // Butterflies over the flowers: orange, white and blue.
  const flyers: Placement[] = [];
  const wingTints: Color[] = [];
  const wings = [C.petalOrange, C.petalWhite, C.wingBlue];
  for (let i = 0; i < 20; i += 1) {
    const at = spot(0.5, 1);
    if (at === undefined) continue;
    flyers.push([at[0], ground(at[0], at[1]) + 0.7 + rng() * 0.6, at[1], 1, 1, 1, 0, spin(), 0]);
    wingTints.push(new Color(wings[i % wings.length]));
  }
  group.add(butterflies(flyers, wingTints));

  // Pebbles thick along the path, and a few stones in the grass, half sunk into the ground.
  const pebbles: Placement[] = [];
  const pebbleTints: Color[] = [];
  const stones: Placement[] = [];
  const stoneTints: Color[] = [];
  const pebbleBase = new Color(C.pebble);
  for (let i = 0; i < 30000; i += 1) {
    const x = bounds.minX + rng() * (bounds.maxX - bounds.minX);
    const z = bounds.minZ + rng() * (bounds.maxZ - bounds.minZ);
    const onPath = site.pathDistance(x, z) < 1.4;
    // A grass stone casts a shadow and counts as a prop: it keeps the planting's clearances.
    if ((!onPath && (rng() > 0.006 || !clear(x, z, 0.4))) || ground(x, z) < site.seaLevel + 0.4)
      continue;
    const s = onPath ? 0.025 + rng() ** 3 * 0.11 : 0.1 + rng() ** 2 * 0.3;
    const at: Placement = [
      x,
      ground(x, z) + s * 0.12,
      z,
      s,
      s * 0.55,
      s * (0.8 + rng() * 0.4),
      rng(),
      spin(),
      rng(),
    ];
    (onPath ? pebbles : stones).push(at);
    (onPath ? pebbleTints : stoneTints).push(pebbleBase.clone().multiplyScalar(0.45 + rng() * 0.7));
  }
  const pebble = new OctahedronGeometry(1, 0);
  const pebbleMaterial = lit(0xffffff, { flat: true });
  // Too small to throw a shadow worth its draw.
  const pathPebbles = instanced(pebble, pebbleMaterial, pebbles, false, pebbleTints);
  pathPebbles.name = "path-pebbles";
  const grassStones = instanced(pebble, pebbleMaterial, stones, true, stoneTints);
  grassStones.name = "stones";
  group.add(pathPebbles, grassStones);

  // The meadow: grass tufts on a jittered 0.5 m grid over all the land, shorter on the mown routes
  // and beside the path, combed one way by the wind, one `InstancedMesh` per 12 m cell. Each cell
  // is shuffled, so drawing a prefix of it thins it evenly: `update` draws every tuft within 16 m
  // of the eye and thins to an eighth by 46 m, where the ground's own green carries the field.
  const tuft = tuftGeometry(rng);
  const grassMaterial = swaying(C.blade, 0.16, { vertexColors: true });
  const cells = new Map<
    string,
    { placements: Placement[]; tints: Color[]; x: number; z: number }
  >();
  const meadow = new Color(C.blade);
  const step = 0.5;
  for (let z = bounds.minZ; z < bounds.maxZ; z += step) {
    for (let x = bounds.minX; x < bounds.maxX; x += step) {
      const tx = x + (rng() - 0.5) * step;
      const tz = z + (rng() - 0.5) * step;
      const scale = rng();
      const path = site.pathDistance(tx, tz);
      if (path < 1.1 || !land(tx, tz)) continue;
      const mown = clear(tx, tz, 0) ? 1 : 0.6;
      const edge = Math.min(1, (path - 1.1) / 1.5);
      const h = (0.45 + scale * 0.4) * mown * (0.55 + 0.45 * edge);
      const ix = Math.floor(tx / 12);
      const iz = Math.floor(tz / 12);
      const key = `${ix},${iz}`;
      const cell = cells.get(key) ?? {
        placements: [],
        tints: [],
        x: (ix + 0.5) * 12,
        z: (iz + 0.5) * 12,
      };
      cells.set(key, cell);
      cell.placements.push([tx, ground(tx, tz) - 0.03, tz, 1, h, 1, 0, (rng() - 0.5) * 0.8, 0]);
      // Hue drifts between a yellow-green and a blue-green, in 20 m patches.
      const drift = 0.5 + 0.5 * Math.sin(tx * 0.11 + tz * 0.07) * Math.cos(tz * 0.13 - tx * 0.05);
      cell.tints.push(new Color(meadow).offsetHSL(0.04 * drift - 0.02, 0, 0.06 * (rng() - 0.5)));
    }
  }
  const grass: { mesh: InstancedMesh; full: number; x: number; z: number }[] = [];
  for (const { placements, tints, x, z } of cells.values()) {
    for (let i = placements.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rng() * (i + 1));
      [placements[i], placements[j]] = [placements[j] as Placement, placements[i] as Placement];
      [tints[i], tints[j]] = [tints[j] as Color, tints[i] as Color];
    }
    const mesh = instanced(tuft, grassMaterial, placements, false, tints);
    mesh.name = "grass";
    group.add(mesh);
    grass.push({ full: Math.round(placements.length * site.grassShare), mesh, x, z });
  }
  let drawn = 0;
  const meadowLod: IMeadow = {
    get drawn() {
      return drawn;
    },
    total: grass.reduce((sum, cell) => sum + cell.full, 0),
    update(eye) {
      drawn = 0;
      for (const cell of grass) {
        const d = Math.hypot(cell.x - eye.x, cell.z - eye.z);
        const keep = d < 16 ? 1 : Math.max(1 / 8, 1 - (d - 16) / 34);
        cell.mesh.count = Math.round(cell.full * keep);
        drawn += cell.mesh.count;
      }
    },
  };

  // Beaches: a sand shelf at the cliff's foot, a darker wet band at the water, and a foam line.
  for (const [x, z, r] of site.shores) {
    const band = (inner: number, outer: number, y: number, material: Material): void => {
      const ring = new RingGeometry(inner, outer, Math.max(24, Math.round(r * 3)), 1).rotateX(
        -Math.PI / 2,
      );
      const mesh = new Mesh(ring, material);
      mesh.position.set(x, site.seaLevel + y, z);
      mesh.receiveShadow = true;
      group.add(mesh);
    };
    band(r - 1, r + 1.1, 0.16, lit(C.sand));
    band(r + 1.1, r + 1.8, 0.1, lit(C.wetSand, { roughness: 0.35 }));
    band(r + 1.8, r + 2.3, 0.06, flat(C.foam, { opacity: 0.7 }));
  }
  return { group, meadow: meadowLod };
}
