// Generated for you. This is ordinary Three.js — edit or delete it freely.
// ThreeNative does not read this file.
//
// Clover Loop's look, all procedural: rolling terrain that climbs into hills at the edge, the
// asphalt ribbon with its edge lines and red-and-white kerbs, the grass shoulder, toy-block walls,
// the bridge on its pillars, a creek under the jump, trees, the start gantry and the boost pads.
// Every shape follows `track/Course.ts`, so a change to the layout there moves all of it. About
// ten draw calls: the ribbons are one merged mesh, the walls and the trees are instanced.
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from "three";
import { type ICourse, PROFILE } from "../track/Course.js";
import { at, lit, merge, paint } from "./materials.js";
import { C } from "./palette.js";

/** A seeded generator, so the trees and the grass colour fall the same way every run. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The shoulder ribbon ends this far out, behind the wall; the terrain starts under it. */
const SHOULDER = PROFILE.wall + 2.5;
/** Terrain cell size and how far it reaches past the course. */
const CELL = 6;
const MARGIN = 190;

export interface ICourseView {
  readonly group: Group;
  /** Ground height at any x/z: the terrain, or the road where the road is. */
  ground(x: number, z: number): number;
  /** The three countdown lamps on the start gantry, left to right; `Race.ts` lights them. */
  readonly lamps: readonly MeshStandardMaterial[];
  readonly audit: {
    readonly triangles: number;
    readonly trees: number;
    readonly pillars: number;
    /** Highest road point less the lowest, metres. */
    readonly reliefMetres: number;
  };
}

const scratch = new Color();
const mixColour = (a: number, b: number, t: number): Color =>
  scratch.set(a).lerp(new Color(b), Math.min(1, Math.max(0, t)));

/** A ribbon along the whole line: one quad per metre per column, each quad one colour. */
function ribbon(
  course: ICourse,
  laterals: readonly number[],
  colour: (i: number, column: number) => Color | number | undefined,
  lift: (i: number, lateral: number) => number = () => 0,
): BufferGeometry {
  const positions: number[] = [];
  const colours: number[] = [];
  const p = { x: 0, y: 0, z: 0 };
  const corner = (i: number, lateral: number): readonly [number, number, number] => {
    course.pointAt(i, lateral, p);
    return [p.x, p.y + lift(course.wrap(i), lateral), p.z];
  };
  for (let i = 0; i < course.count; i += 1) {
    for (let c = 0; c < laterals.length - 1; c += 1) {
      const paintWith = colour(i, c);
      if (paintWith === undefined) continue;
      const tint = typeof paintWith === "number" ? new Color(paintWith) : paintWith;
      const a = corner(i, laterals[c] ?? 0);
      const b = corner(i, laterals[c + 1] ?? 0);
      const d = corner(i + 1, laterals[c] ?? 0);
      const e = corner(i + 1, laterals[c + 1] ?? 0);
      // Counter-clockwise seen from above: forward × right points down, so a → b → d faces up.
      for (const v of [a, b, d, b, e, d]) {
        positions.push(...v);
        colours.push(tint.r, tint.g, tint.b);
      }
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute("color", new BufferAttribute(new Float32Array(colours), 3));
  geometry.setAttribute("uv", new BufferAttribute(new Float32Array((positions.length / 3) * 2), 2));
  geometry.computeVertexNormals();
  return geometry;
}

export function buildCourseView(course: ICourse, seed = 734): ICourseView {
  const rng = makeRng(seed);
  const group = new Group();
  group.name = "course";
  const n = course.count;
  const { x: cx, y: cy, z: cz, tx, tz, deck } = course;

  // ---- Height field ------------------------------------------------------------------------
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i += 1) {
    minX = Math.min(minX, cx[i] ?? 0);
    maxX = Math.max(maxX, cx[i] ?? 0);
    minZ = Math.min(minZ, cz[i] ?? 0);
    maxZ = Math.max(maxZ, cz[i] ?? 0);
  }
  const midX = (minX + maxX) / 2;
  const midZ = (minZ + maxZ) / 2;
  const halfX = (maxX - minX) / 2 + 20;
  const halfZ = (maxZ - minZ) / 2 + 20;
  // The creek runs across the line at the jump's dip, square to it.
  const creekAt = Math.round((course.creek[0] + course.creek[1]) / 2);
  const creekY = cy[creekAt] ?? 0;
  const creekReach = channelReach(course, creekAt);
  /** Rolling ground away from the road, climbing to a ring of hills past the course. */
  const far = (x: number, z: number): number => {
    const e = Math.hypot((x - midX) / halfX, (z - midZ) / halfZ);
    const roll =
      1.4 * Math.sin(x * 0.029 + 1.3) * Math.cos(z * 0.034 - 0.4) +
      0.8 * Math.sin(x * 0.071 - z * 0.053 + 2.2);
    const hills =
      smooth(1, 1.9, e) * (26 + 16 * Math.sin(Math.atan2(z - midZ, x - midX) * 5 + 0.8));
    return roll + hills;
  };
  const ground = (x: number, z: number): number => {
    let nearest = Number.POSITIVE_INFINITY;
    let low = Number.POSITIVE_INFINITY;
    for (let i = 0; i < n; i += 1) {
      if (deck[i] === 1) continue;
      const d = (x - (cx[i] ?? 0)) ** 2 + (z - (cz[i] ?? 0)) ** 2;
      if (d < nearest) nearest = d;
      if (d < (SHOULDER + 3) ** 2 && (cy[i] ?? 0) < low) low = cy[i] ?? 0;
    }
    const d = Math.sqrt(nearest);
    const base = Number.isFinite(low) ? low - 0.35 : far(x, z);
    let h = base + (far(x, z) - base) * smooth(SHOULDER, SHOULDER + 24, d);
    // The creek's channel: a trough square to the line at the dip, its banks easing up.
    const along =
      (x - (cx[creekAt] ?? 0)) * (tx[creekAt] ?? 0) + (z - (cz[creekAt] ?? 0)) * (tz[creekAt] ?? 0);
    const across =
      (x - (cx[creekAt] ?? 0)) * -(tz[creekAt] ?? 0) +
      (z - (cz[creekAt] ?? 0)) * (tx[creekAt] ?? 0);
    if (across > creekReach[0] - 10 && across < creekReach[1] + 10) {
      const end =
        smooth(creekReach[1], creekReach[1] + 10, across) +
        smooth(-creekReach[0], -creekReach[0] + 10, -across);
      const trough = creekY - 0.7 + smooth(4, 12, Math.abs(along)) * 30 + end * 30;
      h = Math.min(h, trough);
    }
    return h;
  };

  // ---- Terrain ------------------------------------------------------------------------------
  const width = 2 * (halfX + MARGIN);
  const depth = 2 * (halfZ + MARGIN);
  const terrainGeometry = new PlaneGeometry(
    width,
    depth,
    Math.ceil(width / CELL),
    Math.ceil(depth / CELL),
  );
  terrainGeometry.rotateX(-Math.PI / 2);
  terrainGeometry.translate(midX, 0, midZ);
  const tp = terrainGeometry.getAttribute("position");
  for (let i = 0; i < tp.count; i += 1) tp.setY(i, ground(tp.getX(i), tp.getZ(i)));
  terrainGeometry.computeVertexNormals();
  const tn = terrainGeometry.getAttribute("normal");
  const terrainColours = new Float32Array(tp.count * 3);
  for (let i = 0; i < tp.count; i += 1) {
    const x = tp.getX(i);
    const z = tp.getZ(i);
    const y = tp.getY(i);
    const steep = 1 - tn.getY(i);
    const patch =
      0.5 + 0.5 * Math.sin(x * 0.11 + Math.sin(z * 0.07) * 2) * Math.cos(z * 0.09 - x * 0.03);
    const colour = mixColour(C.grassDark, C.grassLight, patch);
    if (y < creekY + 0.4) colour.lerp(new Color(C.sand), smooth(creekY + 0.4, creekY - 0.3, y));
    if (steep > 0.16) colour.lerp(new Color(C.rock), smooth(0.16, 0.35, steep));
    terrainColours.set([colour.r, colour.g, colour.b], i * 3);
  }
  terrainGeometry.setAttribute("color", new BufferAttribute(terrainColours, 3));
  const terrain = new Mesh(terrainGeometry, lit({ roughness: 0.95 }));
  terrain.name = "terrain";
  terrain.receiveShadow = true;
  group.add(terrain);

  // ---- Road, kerbs, shoulders -----------------------------------------------------------------
  const r = PROFILE.road;
  const k = r + PROFILE.kerb;
  const road = ribbon(course, [-r, -r + 0.35, -r + 0.6, -3, 0, 3, r - 0.6, r - 0.35, r], (i, c) => {
    if (c === 1 || c === 6) return C.line;
    // Patches of older asphalt every few metres keep the ribbon from reading as one flat sheet.
    const wear = 0.5 + 0.5 * Math.sin(i * 0.37 + c * 1.9) * Math.sin(i * 0.11 - c);
    return mixColour(C.asphalt, C.asphaltDark, wear * (c === 0 || c === 7 ? 1 : 0.6));
  });
  // Kerbs in 2 m blocks; a hair above the road so the seam never flickers.
  const kerbs = ribbon(
    course,
    [-k, -r, r, k],
    (i, c) => (c === 1 ? undefined : Math.floor(i / 2) % 2 === 0 ? C.kerbRed : C.kerbWhite),
    () => 0.01,
  );
  // The grass shoulder out past the wall, then a skirt down to the terrain, so a dip in the road
  // (the creek, the cut under the bridge) never leaves the ribbon's edge hanging in the air.
  const skirt = SHOULDER + 2;
  const q = { x: 0, y: 0, z: 0 };
  const shoulders = ribbon(
    course,
    [-skirt, -SHOULDER, -k, k, SHOULDER, skirt],
    (i, c) => {
      if (c === 2 || deck[i] === 1 || deck[(i + 1) % n] === 1) return undefined;
      const patch = 0.5 + 0.5 * Math.sin(i * 0.21 + c * 2.3);
      return mixColour(C.grassDark, C.grass, patch);
    },
    (i, lateral) => {
      if (Math.abs(lateral) <= SHOULDER) return 0;
      course.pointAt(i, lateral, q);
      return Math.min(0, ground(q.x, q.z) - q.y - 0.05);
    },
  );
  // The bridge's deck edge, kerb to rail.
  const deckEdge = ribbon(course, [-PROFILE.rail - 0.3, -k, k, PROFILE.rail + 0.3], (i, c) =>
    c === 1 || deck[i] !== 1 ? undefined : C.bridge,
  );
  // The checkered start line, 2 m deep across the road.
  const checks: BufferGeometry[] = [];
  const squares = 13;
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < squares; col += 1) {
      const lateral = -r + ((col + 0.5) * (2 * r)) / squares;
      const p = { x: 0, y: 0, z: 0 };
      course.pointAt(row, lateral, p);
      const yaw = Math.atan2(-(tx[0] ?? 0), -(tz[0] ?? 0));
      checks.push(
        paint(
          new PlaneGeometry((2 * r) / squares, 1).rotateX(-Math.PI / 2),
          (row + col) % 2 === 0 ? C.check : C.white,
          at(p.x, p.y + 0.02, p.z, 0, yaw),
        ),
      );
    }
  }
  const surfaces = new Mesh(
    merge([road, kerbs, shoulders, deckEdge, ...checks]),
    lit({ roughness: 0.86 }),
  );
  surfaces.name = "road";
  surfaces.receiveShadow = true;
  group.add(surfaces);

  // ---- Water in the creek -----------------------------------------------------------------
  const waterLength = creekReach[1] - creekReach[0] + 16;
  const water = new Mesh(
    new PlaneGeometry(14, waterLength).rotateX(-Math.PI / 2),
    lit({ color: C.water, roughness: 0.08, vertexColors: false, transparent: true, opacity: 0.82 }),
  );
  const mid = (creekReach[0] + creekReach[1]) / 2;
  water.position.set(
    (cx[creekAt] ?? 0) - (tz[creekAt] ?? 0) * mid,
    creekY + 0.14,
    (cz[creekAt] ?? 0) + (tx[creekAt] ?? 0) * mid,
  );
  water.rotation.y = Math.atan2(-(tx[creekAt] ?? 0), -(tz[creekAt] ?? 0));
  water.name = "creek";
  water.receiveShadow = true;
  group.add(water);

  // ---- Walls and bridge rails: toy blocks, 2 m each ----------------------------------------------
  const blockColours = [C.blockA, C.blockD, C.blockB, C.blockD, C.blockC, C.blockD];
  const block = new BoxGeometry(1, 1, 1);
  const wallCount = Math.ceil(n / 2) * 2;
  const walls = new InstancedMesh(block, lit({ roughness: 0.55, vertexColors: false }), wallCount);
  const dummy = new Object3D();
  const p = { x: 0, y: 0, z: 0 };
  let w = 0;
  for (let i = 0; i < n; i += 2) {
    for (const side of [-1, 1]) {
      const onDeck = deck[i] === 1;
      const thick = onDeck ? 0.3 : 0.6;
      const tall = onDeck ? 0.75 : 0.95;
      course.pointAt(i + 1, side * ((course.wall[i] ?? 0) + thick / 2), p);
      dummy.position.set(p.x, p.y + tall / 2 - 0.05, p.z);
      dummy.rotation.set(
        Math.atan(course.slope[i] ?? 0),
        Math.atan2(-(tx[i] ?? 0), -(tz[i] ?? 0)),
        0,
        "YXZ",
      );
      dummy.scale.set(thick, tall, 2.02);
      dummy.updateMatrix();
      walls.setMatrixAt(w, dummy.matrix);
      walls.setColorAt(
        w,
        new Color(
          onDeck ? C.bridgeDark : (blockColours[(i / 2) % blockColours.length] ?? C.blockD),
        ),
      );
      w += 1;
    }
  }
  walls.count = w;
  walls.name = "walls";
  walls.castShadow = true;
  walls.receiveShadow = true;
  group.add(walls);

  // ---- The bridge: a slab under the deck, pillars to the ground ------------------------------------
  const solids: BufferGeometry[] = [];
  let pillars = 0;
  for (let i = 0; i < n; i += 1) {
    if (deck[i] !== 1) continue;
    const yaw = Math.atan2(-(tx[i] ?? 0), -(tz[i] ?? 0));
    course.pointAt(i, 0, p);
    // Each 1 m slab pitches with the road, as the walls do: a level slab pokes its ends up through
    // a sloped deck and stripes the ramp.
    dummy.position.set(p.x, p.y - 0.51, p.z);
    dummy.rotation.set(Math.atan(course.slope[i] ?? 0), yaw, 0, "YXZ");
    dummy.scale.set(1, 1, 1);
    dummy.updateMatrix();
    solids.push(
      paint(
        new BoxGeometry(2 * PROFILE.rail + 0.6, 0.9, 1.02),
        C.bridge,
        dummy.matrix.clone(),
        0.3,
      ),
    );
    if (i % 9 !== 0) continue;
    for (const side of [-1, 1]) {
      course.pointAt(i, side * 5.2, p);
      // Keep the pillars off the road that runs underneath (any sample far along the lap).
      if (!clearOfBranch(course, i, p.x, p.z, PROFILE.wall + 2.5)) continue;
      const base = ground(p.x, p.z) - 0.5;
      const height = p.y - 0.9 - base;
      if (height < 0.5) continue;
      solids.push(
        paint(
          new BoxGeometry(1.3, height, 1.3),
          C.pillar,
          at(p.x, base + height / 2, p.z, 0, yaw),
          0.35,
        ),
      );
      pillars += 1;
    }
  }

  // ---- The start gantry: two posts, a banner and three lamps ---------------------------------------
  const yaw0 = Math.atan2(-(tx[0] ?? 0), -(tz[0] ?? 0));
  const span = PROFILE.wall + 0.6;
  for (const side of [-1, 1]) {
    course.pointAt(0, side * span, p);
    solids.push(
      paint(new BoxGeometry(0.7, 7.4, 0.7), C.metal, at(p.x, p.y + 3.7, p.z, 0, yaw0), 0.25),
    );
  }
  course.pointAt(0, 0, p);
  solids.push(
    paint(
      new BoxGeometry(2 * span + 0.7, 1.6, 0.5),
      C.banner,
      at(p.x, p.y + 6.6, p.z, 0, yaw0),
      0.2,
    ),
  );
  for (let c = 0; c < 14; c += 1) {
    const lateral = -span + ((c + 0.5) * 2 * span) / 14;
    course.pointAt(0, lateral, p);
    solids.push(
      paint(
        new BoxGeometry((2 * span) / 14, 0.4, 0.52),
        c % 2 === 0 ? C.check : C.white,
        at(p.x, p.y + 7.6, p.z, 0, yaw0),
      ),
    );
  }
  const bridgeMesh = new Mesh(merge(solids), lit({ roughness: 0.7 }));
  bridgeMesh.name = "structures";
  bridgeMesh.castShadow = true;
  bridgeMesh.receiveShadow = true;
  group.add(bridgeMesh);
  const lamps: MeshStandardMaterial[] = [];
  for (let l = 0; l < 3; l += 1) {
    const material = new MeshStandardMaterial({
      color: 0x331010,
      emissive: 0xff2a1a,
      emissiveIntensity: 0,
      roughness: 0.3,
    });
    const lamp = new Mesh(new IcosahedronGeometry(0.42, 2), material);
    course.pointAt(0, (l - 1) * 1.3, p);
    // On the banner's back face, toward the grid behind the line.
    lamp.position.set(p.x + (tx[0] ?? 0) * -0.4, p.y + 6.6, p.z + (tz[0] ?? 0) * -0.4);
    lamp.name = `lamp.${l}`;
    group.add(lamp);
    lamps.push(material);
  }

  // ---- Boost pads: three chevrons each, glowing ---------------------------------------------
  // Each flat piece is pitched to the road's slope, or on a hill one end sinks and the other floats.
  const pitch = (i: number): number => Math.atan(course.slope[i] ?? 0);
  const chevrons: BufferGeometry[] = [];
  for (const pad of course.pads) {
    const yaw = Math.atan2(-(tx[pad.index] ?? 0), -(tz[pad.index] ?? 0));
    for (let c = 0; c < 3; c += 1) {
      const i = Math.round(pad.index - 1 + c * 1.2);
      for (const side of [-1, 1]) {
        course.pointAt(i, pad.lateral + side * 0.75, p);
        chevrons.push(
          paint(
            new PlaneGeometry(1.7, 0.55)
              .rotateX(-Math.PI / 2)
              .rotateY(side * 0.6)
              .rotateX(pitch(i)),
            c === 1 ? C.padGlow : C.pad,
            at(p.x, p.y + 0.06, p.z, 0, yaw),
          ),
        );
      }
    }
    course.pointAt(pad.index, pad.lateral, p);
    chevrons.push(
      paint(
        new PlaneGeometry(3, 4.2).rotateX(-Math.PI / 2).rotateX(pitch(pad.index)),
        C.asphaltDark,
        at(p.x, p.y + 0.04, p.z, 0, yaw),
      ),
    );
  }
  const pads = new Mesh(
    merge(chevrons),
    lit({ emissive: C.pad, emissiveIntensity: 0.35, roughness: 0.4 }),
  );
  pads.name = "boost-pads";
  group.add(pads);

  // ---- Trees and bushes: two instanced meshes ----------------------------------------------
  const trunkGeometry = paint(new CylinderGeometry(0.22, 0.32, 1, 6), C.bark, at(0, 0.5, 0), 0.4);
  const canopyGeometry = paint(new IcosahedronGeometry(1, 1), C.white, undefined, 0.45);
  const crowns: { x: number; y: number; z: number; size: number; trunk: number }[] = [];
  for (let tries = 0; tries < 2600 && crowns.length < 260; tries += 1) {
    const x = midX + (rng() * 2 - 1) * (halfX + 70);
    const z = midZ + (rng() * 2 - 1) * (halfZ + 70);
    if (!clearOfRoad(course, x, z, SHOULDER + 3)) continue;
    const trunk = rng() < 0.25 ? 0 : 1.8 + rng() * 2.2;
    crowns.push({
      size: trunk === 0 ? 0.9 + rng() * 0.8 : 1.8 + rng() * 1.6,
      trunk,
      x,
      y: ground(x, z),
      z,
    });
  }
  const trunks = new InstancedMesh(trunkGeometry, lit({ roughness: 0.9 }), crowns.length);
  const canopies = new InstancedMesh(
    canopyGeometry,
    lit({ roughness: 0.85, flatShading: true }),
    crowns.length,
  );
  const m = new Matrix4();
  const canopyTints = [C.canopy, C.canopyLight, C.grassDark, C.bloomPink, C.bloomYellow];
  crowns.forEach((tree, i) => {
    trunks.setMatrixAt(
      i,
      m.compose(
        dummy.position.set(tree.x, tree.y - 0.2, tree.z),
        dummy.quaternion.identity(),
        dummy.scale.set(1, tree.trunk + 0.2, 1),
      ),
    );
    const lift = tree.trunk === 0 ? tree.size * 0.45 : tree.trunk + tree.size * 0.7;
    dummy.rotation.set(0, rng() * Math.PI, 0);
    canopies.setMatrixAt(
      i,
      m.compose(
        dummy.position.set(tree.x, tree.y + lift, tree.z),
        dummy.quaternion.setFromEuler(dummy.rotation),
        dummy.scale.set(tree.size, tree.size * 0.85, tree.size),
      ),
    );
    // Bushes flower now and then; tree crowns stay green.
    const tint = tree.trunk === 0 && rng() < 0.4 ? canopyTints[3 + (i % 2)] : canopyTints[i % 3];
    canopies.setColorAt(i, new Color(tint));
  });
  for (const mesh of [trunks, canopies]) {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  trunks.name = "trunks";
  canopies.name = "canopies";

  let triangles = 0;
  group.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    const count = geometry.index?.count ?? geometry.getAttribute("position").count;
    triangles += (count / 3) * (object instanceof InstancedMesh ? object.count : 1);
  });
  const reliefMetres = Math.max(...cy) - Math.min(...cy);
  return {
    audit: { pillars, reliefMetres, trees: crowns.length, triangles: Math.round(triangles) },
    ground,
    group,
    lamps,
  };
}

function smooth(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** True when x/z is at least `clearance` metres from every sample of the line. */
function clearOfRoad(course: ICourse, x: number, z: number, clearance: number): boolean {
  const reach = clearance * clearance;
  for (let i = 0; i < course.count; i += 1) {
    if ((x - (course.x[i] ?? 0)) ** 2 + (z - (course.z[i] ?? 0)) ** 2 < reach) return false;
  }
  return true;
}

/** True when x/z is at least `clearance` metres from every sample more than 60 m along the lap from `from`. */
function clearOfBranch(
  course: ICourse,
  from: number,
  x: number,
  z: number,
  clearance: number,
): boolean {
  for (let i = 0; i < course.count; i += 1) {
    let apart = Math.abs(i - from);
    apart = Math.min(apart, course.count - apart);
    if (
      apart > 60 &&
      (x - (course.x[i] ?? 0)) ** 2 + (z - (course.z[i] ?? 0)) ** 2 < clearance * clearance
    )
      return false;
  }
  return true;
}

/**
 * How far the creek may run each way from the line, square to it, before it would reach another
 * part of the course: [left, right] in metres of lateral offset, at most 90 each way.
 */
function channelReach(course: ICourse, at: number): readonly [number, number] {
  const reach = (side: number): number => {
    for (let d = PROFILE.wall + 4; d <= 90; d += 2) {
      const x = (course.x[at] ?? 0) - (course.tz[at] ?? 0) * side * d;
      const z = (course.z[at] ?? 0) + (course.tx[at] ?? 0) * side * d;
      for (let i = 0; i < course.count; i += 1) {
        let apart = Math.abs(i - at);
        apart = Math.min(apart, course.count - apart);
        if (apart < 40) continue;
        if (
          (x - (course.x[i] ?? 0)) ** 2 + (z - (course.z[i] ?? 0)) ** 2 <
          (PROFILE.wall + 14) ** 2
        )
          return d - 14;
      }
    }
    return 90;
  };
  return [-reach(-1), reach(1)];
}
