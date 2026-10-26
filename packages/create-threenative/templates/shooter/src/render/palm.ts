// Date palms for the Bayview waterfront, built as real geometry.
//
// A palm is recognised entirely from its outline, so this file spends its
// vertices on the three things that outline is made of:
//
//   1. a slender trunk that LEANS — Mediterranean date palms never stand
//      plumb — tapering 0.37 m at the root flare to 0.21 m under the crown,
//      with stepped bark rings where old frond bases sheared off;
//   2. nine to thirteen pinnate fronds whose pitch rotates from upward at the
//      base, through horizontal, to drooping well past it at the tip, each one
//      a run of swept leaflets so the edge reads as a saw-tooth rather than a
//      cut-out rectangle;
//   3. the crown junk under it: a skirt of dead brown fronds and two or three
//      hanging date bunches, both cheap and both unmistakably palm.
//
// Everything is deterministic (`makeRandom`, never `Math.random`) so a replay
// renders the same tree twice, and the whole run of trees is drawn from three
// prototype geometries through `InstancedMesh` — a palm is a repeated prop, and
// generating fresh geometry per placement is how a prop budget disappears.
//
// Colour variation is baked into a vertex-colour attribute instead of extra
// materials: frond tips read sun-bleached, frond bases shaded, and the bark
// grooves darker, all inside one draw call per part. (CanvasTexture samples
// black under WebGPURenderer, so a painted gradient is not an option here.)
import {
  BufferGeometry,
  CatmullRomCurve3,
  Float32BufferAttribute,
  type Group,
  InstancedMesh,
  type Material,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  Vector3,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import { worldGridUVs } from "./materials.js";
import { makeRandom } from "./shapes.js";

/** The two town materials a palm is allowed to ask for; the rest are derived. */
export type PalmMaterials = {
  readonly palmTrunk: Material;
  readonly frond: Material;
};

/** Ground position of one tree. */
export type PalmPlacement = readonly [number, number];

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);

/** Trunk: 0.37 m across at the flare, 0.21 m under the crown. Half of that here. */
const TRUNK_BASE_RADIUS = 0.185;
const TRUNK_TOP_RADIUS = 0.105;
/** Bark steps along the trunk; three geometry rings each, so the step reads. */
const BARK_STEPS = 18;
const TRUNK_RINGS = BARK_STEPS * 3;
const TRUNK_RADIALS = 8;
/** Leaflets a side. The reference frond is a feather, not a serrated blade. */
const LEAFLETS_PER_SIDE = 20;

/** One geometry per material, all in the tree's local space with the root at y=0. */
type PalmParts = {
  readonly trunk: BufferGeometry;
  readonly live: BufferGeometry;
  readonly dead: BufferGeometry;
  readonly fruit: BufferGeometry;
};

/** A frond, described the way it is drawn: an arch that keeps rotating downward. */
type FrondSpec = {
  readonly length: number;
  readonly width: number;
  /** Pitch at the base, radians above horizontal. */
  readonly rise: number;
  /** Pitch at the tip. Below −0.2 or so the frond droops past horizontal. */
  readonly droop: number;
  readonly curl: number;
  readonly segments: number;
  readonly shade: readonly [number, number, number];
  readonly tip: readonly [number, number, number];
};

function tint(
  values: number[],
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  t: number,
  gain: number,
): void {
  values.push(
    (from[0] + (to[0] - from[0]) * t) * gain,
    (from[1] + (to[1] - from[1]) * t) * gain,
    (from[2] + (to[2] - from[2]) * t) * gain,
  );
}

function finish(positions: number[], colors: number[], indices: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * A pinnate frond growing along +x from the origin.
 *
 * The rachis is a narrow ribbon; every segment then hangs one triangular
 * leaflet off each side, swept toward the tip and folded down into a shallow V.
 * Adjacent leaflets share the rachis edge, so the blade is continuous while its
 * outer edge is a run of points — which is the whole reason to build it this
 * way rather than as a quad.
 */
function frondGeometry(spec: FrondSpec, rng: () => number): BufferGeometry {
  const { length, width, rise, droop, curl, segments, shade, tip } = spec;
  const step = length / segments;
  const spine: Vector3[] = [];
  const walker = new Vector3(0, 0, 0);
  for (let i = 0; i <= segments; i += 1) {
    spine.push(walker.clone());
    const along = (i + 0.5) / segments;
    // The droop accelerates: a frond is stiff where it leaves the crown and
    // limp at the tip, so the pitch is eased rather than lerped.
    const pitch = rise + (droop - rise) * along ** 1.65;
    walker.x += Math.cos(pitch) * step;
    walker.y += Math.sin(pitch) * step;
    walker.z += curl * along * step;
  }

  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const at = (i: number): Vector3 => spine[Math.min(i, spine.length - 1)] ?? walker;
  const bladeWidth = (t: number): number =>
    width * Math.max(0.05, Math.min(1, t / 0.2)) * (1 - t * 0.76);
  const rachisWidth = (t: number): number => 0.05 * (1 - t * 0.62);

  // Rachis ribbon.
  for (let i = 0; i <= segments; i += 1) {
    const t = i / segments;
    const point = at(i);
    const half = rachisWidth(t);
    for (const side of [-1, 1]) {
      positions.push(point.x, point.y + half * 0.2, point.z + half * side);
      tint(colors, shade, tip, t, 0.92);
    }
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }

  // Leaflets.
  for (let i = 0; i < segments; i += 1) {
    const t = i / segments;
    const next = (i + 1) / segments;
    const root = at(i);
    const ahead = at(i + 1);
    const span = bladeWidth((t + next) / 2) * (0.82 + rng() * 0.36);
    for (const side of [-1, 1]) {
      const base = positions.length / 3;
      const inner = rachisWidth(t) * side;
      const innerNext = rachisWidth(next) * side;
      positions.push(root.x, root.y, root.z + inner);
      tint(colors, shade, tip, t, 0.8);
      positions.push(ahead.x, ahead.y, ahead.z + innerNext);
      tint(colors, shade, tip, next, 0.86);
      // Swept past the next node so leaflets overlap instead of leaving gaps,
      // and folded down so the frond has a V section rather than a flat one.
      const sweep = 1.45;
      positions.push(
        root.x + (ahead.x - root.x) * sweep,
        root.y + (ahead.y - root.y) * sweep - span * 0.44,
        root.z + (ahead.z - root.z) * sweep + span * side,
      );
      tint(colors, shade, tip, Math.min(1, next + 0.1), 1);
      if (side < 0) indices.push(base, base + 1, base + 2);
      else indices.push(base, base + 2, base + 1);
    }
  }

  return finish(positions, colors, indices);
}

/** Leaning, ring-stepped trunk swept along a Catmull-Rom spine. */
function trunkGeometry(spine: CatmullRomCurve3): BufferGeometry {
  const frames = spine.computeFrenetFrames(TRUNK_RINGS, false);
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  const point = new Vector3();
  // The scar phase is a function of height AND of which radial column you are
  // on: neighbouring columns are offset half a step, which turns a stack of
  // plain hoops into the diamond lattice of old frond bases a date palm
  // actually wears. Radius and vertex colour both read this one function, so
  // the relief and the shading agree instead of fighting.
  const scarPhase = (t: number, column: number): number =>
    (t * BARK_STEPS + (column % 2) * 0.5) % 1;
  const radiusAt = (t: number, column: number): number => {
    const taper = TRUNK_BASE_RADIUS + (TRUNK_TOP_RADIUS - TRUNK_BASE_RADIUS) * t ** 0.7;
    const flare = 1 + 0.5 * Math.exp(-t * 15);
    return taper * flare * (1 + 0.12 * (1 - scarPhase(t, column)));
  };
  for (let i = 0; i <= TRUNK_RINGS; i += 1) {
    const t = i / TRUNK_RINGS;
    spine.getPointAt(t, point);
    const normal = frames.normals[i] ?? UP;
    const binormal = frames.binormals[i] ?? UP;
    for (let j = 0; j < TRUNK_RADIALS; j += 1) {
      const angle = (j / TRUNK_RADIALS) * TAU;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const radius = radiusAt(t, j);
      // The scar face catches the sun; the step under it reads dark.
      const bark = 0.6 + 0.62 * (1 - scarPhase(t, j)) + t * 0.12;
      positions.push(
        point.x + radius * (cos * normal.x + sin * binormal.x),
        point.y + radius * (cos * normal.y + sin * binormal.y),
        point.z + radius * (cos * normal.z + sin * binormal.z),
      );
      colors.push(bark, bark, bark);
    }
  }
  for (let i = 0; i < TRUNK_RINGS; i += 1) {
    for (let j = 0; j < TRUNK_RADIALS; j += 1) {
      const a = i * TRUNK_RADIALS + j;
      const b = i * TRUNK_RADIALS + ((j + 1) % TRUNK_RADIALS);
      indices.push(a, a + TRUNK_RADIALS, b, b, a + TRUNK_RADIALS, b + TRUNK_RADIALS);
    }
  }
  // Cap the top so the crown never shows a hollow tube from below.
  const cap = positions.length / 3;
  spine.getPointAt(1, point);
  positions.push(point.x, point.y, point.z);
  colors.push(0.9, 0.9, 0.9);
  const last = TRUNK_RINGS * TRUNK_RADIALS;
  for (let j = 0; j < TRUNK_RADIALS; j += 1) {
    indices.push(cap, last + j, last + ((j + 1) % TRUNK_RADIALS));
  }
  return finish(positions, colors, indices);
}

/** A low-poly blob, used for the crown boss and the date bunches. */
function blob(radius: number, widthSegments: number, heightSegments: number): BufferGeometry {
  const sphere = new SphereGeometry(radius, widthSegments, heightSegments);
  sphere.deleteAttribute("uv");
  sphere.deleteAttribute("normal");
  const count = sphere.attributes.position?.count ?? 0;
  const colors: number[] = [];
  for (let i = 0; i < count; i += 1) colors.push(1, 1, 1);
  sphere.setAttribute("color", new Float32BufferAttribute(colors, 3));
  return sphere;
}

/** Place a geometry into the crown's frame: spin it, then stand it on the trunk. */
function placed(geometry: BufferGeometry, azimuth: number, crown: Matrix4): BufferGeometry {
  const spin = new Matrix4().makeRotationY(azimuth);
  return geometry.applyMatrix4(spin).applyMatrix4(crown);
}

/**
 * One prototype tree. `seed` picks its height, lean, frond count and every
 * jitter inside it, so the same seed is byte-identical on every reload.
 */
function buildPalm(seed: number): PalmParts {
  const rng = makeRandom(seed);
  const height = 5.6 + rng() * 1.7;
  const leanAngle = rng() * TAU;
  const lean = 0.4 + rng() * 0.55;
  const leanX = Math.cos(leanAngle) * lean;
  const leanZ = Math.sin(leanAngle) * lean;
  // A shallow S: the trunk kicks back before it leans out, which is what stops
  // a "curved" trunk from reading as a bent pipe.
  const spine = new CatmullRomCurve3([
    new Vector3(0, -0.25, 0),
    new Vector3(leanX * -0.14, height * 0.3, leanZ * -0.14),
    new Vector3(leanX * 0.4, height * 0.68, leanZ * 0.4),
    new Vector3(leanX, height, leanZ),
  ]);

  const tangent = spine.getTangentAt(1).normalize();
  const crown = new Matrix4().compose(
    spine.getPointAt(1),
    new Quaternion().setFromUnitVectors(UP, tangent),
    new Vector3(1, 1, 1),
  );

  const trunk: BufferGeometry[] = [trunkGeometry(spine)];
  // The crown boss: the fibrous knuckle every frond springs from. Without it
  // the fronds visibly converge on a point and the crown floats.
  const boss = blob(0.23, 8, 5);
  boss.applyMatrix4(new Matrix4().makeScale(1, 0.72, 1));
  trunk.push(placed(boss, 0, crown));

  const live: BufferGeometry[] = [];
  const fronds = 13 + Math.floor(rng() * 6);
  for (let i = 0; i < fronds; i += 1) {
    // Golden angle: an even fan looks stamped, and a random one clumps.
    const azimuth = i * 2.39996 + rng() * 0.22;
    const tier = i % 3;
    // Value separation is what makes a crown read as foliage instead of as one
    // green silhouette. The upright tier-0 fronds sit in each other's shade and
    // stay deep green; the long tier-2 droopers take the sun and their tips
    // bleach toward yellow. Red leads the bleach, blue lags — a flat brightness
    // ramp would read as fog, not as sun damage. A per-frond jitter keeps
    // neighbouring fronds from matching exactly.
    const depth = tier === 0 ? 0.55 : tier === 1 ? 0.78 : 1.0;
    const bleach = tier === 0 ? 0.98 : tier === 1 ? 1.14 : 1.34;
    const jitter = 0.9 + rng() * 0.2;
    const spec: FrondSpec = {
      length: (tier === 0 ? 2.9 : tier === 1 ? 3.3 : 3.6) + rng() * 0.4,
      width: 0.4 + rng() * 0.09,
      rise: tier === 0 ? 0.95 : tier === 1 ? 0.55 : 0.2,
      droop: tier === 0 ? -0.5 : tier === 1 ? -1.15 : -1.8,
      curl: (rng() - 0.5) * 0.5,
      // Twenty leaflets a side. Ten read as a coarse zigzag; the reference
      // frond is a feather, and leaflet count is what separates the two.
      segments: LEAFLETS_PER_SIDE,
      shade: [0.58 * depth * jitter, 0.66 * depth * jitter, 0.44 * depth * jitter],
      tip: [1.22 * bleach * jitter * 1.06, 1.16 * bleach * jitter, 0.78 * bleach * jitter * 0.88],
    };
    live.push(placed(frondGeometry(spec, rng), azimuth, crown));
  }

  // Dead fronds hang against the trunk under the live crown — the single
  // cheapest detail that says "date palm" rather than "green thing on a pole".
  const dead: BufferGeometry[] = [];
  const skirt = new Matrix4().compose(
    spine.getPointAt(0.985),
    new Quaternion().setFromUnitVectors(UP, tangent),
    new Vector3(1, 1, 1),
  );
  const deadCount = 4 + Math.floor(rng() * 3);
  for (let i = 0; i < deadCount; i += 1) {
    const spec: FrondSpec = {
      length: 1.3 + rng() * 0.7,
      width: 0.22 + rng() * 0.07,
      rise: -0.25 - rng() * 0.3,
      droop: -2.1 - rng() * 0.25,
      curl: (rng() - 0.5) * 0.35,
      segments: 8,
      shade: [0.62, 0.55, 0.42],
      tip: [1.05, 0.95, 0.7],
    };
    dead.push(placed(frondGeometry(spec, rng), i * 2.39996 + 0.8, skirt));
  }

  // Date bunches: a stalk of four blobs sagging out of the crown.
  const fruit: BufferGeometry[] = [];
  const bunches = 2 + Math.floor(rng() * 2);
  for (let i = 0; i < bunches; i += 1) {
    for (let b = 0; b < 4; b += 1) {
      const drop = b / 3;
      const berry = blob(0.095 - drop * 0.03, 5, 3);
      berry.applyMatrix4(
        new Matrix4().makeTranslation(
          0.42 + drop * 0.34,
          -0.18 - drop * 0.5 - rng() * 0.08,
          (rng() - 0.5) * 0.14,
        ),
      );
      fruit.push(placed(berry, i * 2.1 + 0.5 + rng() * 0.2, crown));
    }
  }

  const merge = (parts: BufferGeometry[]): BufferGeometry => {
    const merged = mergeGeometries(parts, false);
    if (merged === null) throw new Error("Palm geometry failed to merge.");
    merged.computeVertexNormals();
    // One metre of grid, in the tree's own frame — the prototypes are authored at metre
    // scale, so this is the same tile the walls and the street get.
    return worldGridUVs(merged);
  };
  return { trunk: merge(trunk), live: merge(live), dead: merge(dead), fruit: merge(fruit) };
}

/**
 * A recoloured copy of a town material.
 *
 * Dead fronds and dates want their own colour, and every part wants vertex
 * colours switched on. These four belong in `townMaterials.ts` beside
 * `palmTrunk` and `frond`; they are derived here so this file owns no
 * material the town has not already declared.
 */
function derive(source: Material, hex: number | undefined): Material {
  const clone = source.clone();
  if (clone instanceof MeshStandardMaterial) {
    clone.vertexColors = true;
    if (hex !== undefined) clone.color.setHex(hex);
  }
  return clone;
}

/**
 * Build every palm in the town.
 *
 * Three prototypes are generated once and drawn through one `InstancedMesh`
 * per prototype per material — twelve draw calls for the whole run of trees,
 * whatever the placement table grows to.
 */
export function addPalms(
  group: Group,
  materials: PalmMaterials,
  places: readonly PalmPlacement[],
): void {
  if (places.length === 0) return;
  const trunkMaterial = derive(materials.palmTrunk, undefined);
  const frondMaterial = derive(materials.frond, undefined);
  const deadMaterial = derive(materials.frond, 0x8b7440);
  const fruitMaterial = derive(materials.palmTrunk, 0x8a5520);

  const prototypes = [buildPalm(1301), buildPalm(2707), buildPalm(4211)];
  const buckets: Matrix4[][] = prototypes.map(() => []);
  const rng = makeRandom(90210);
  const quaternion = new Quaternion();
  const one = new Vector3(1, 1, 1);
  places.forEach(([x, z], index) => {
    // Round-robin the prototypes so no one tree dominates a plaza; the yaw and
    // the size below are what stop the repeat from reading as a repeat.
    const which = index % prototypes.length;
    const spin = rng() * TAU;
    const size = 0.88 + rng() * 0.16;
    buckets[which]?.push(
      new Matrix4().compose(
        new Vector3(x, 0, z),
        quaternion.setFromAxisAngle(UP, spin),
        one.clone().multiplyScalar(size),
      ),
    );
  });

  prototypes.forEach((parts, index) => {
    const matrices = buckets[index];
    if (matrices === undefined || matrices.length === 0) return;
    const layers: readonly (readonly [BufferGeometry, Material, string])[] = [
      [parts.trunk, trunkMaterial, "palm-trunk"],
      [parts.live, frondMaterial, "palm-frond"],
      [parts.dead, deadMaterial, "palm-frond-dead"],
      [parts.fruit, fruitMaterial, "palm-dates"],
    ];
    for (const [geometry, material, name] of layers) {
      const mesh = new InstancedMesh(geometry, material, matrices.length);
      mesh.name = name;
      matrices.forEach((matrix, slot) => mesh.setMatrixAt(slot, matrix));
      mesh.instanceMatrix.needsUpdate = true;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.computeBoundingSphere();
      group.add(mesh);
    }
  });
}
