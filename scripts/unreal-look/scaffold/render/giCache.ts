// Harness overlay (PRD-631, L2 and L7): the world-space tier of indirect diffuse light.
//
// Unreal's global illumination gathers in tiers: screen probes trace what is on screen, and a
// world-space radiance cache of probes, traced against the scene, answers for what is not
// (Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeGather.cpp and LumenRadianceCache.cpp).
// Its sky light is shadowed by the scene the same way, so a ceiling that stands over a floor gets
// none of the sky and a room with one open wall fills from that opening.
// This file is that cache for a fixed world, baked once at load from the game's own ray query:
//
//   - A 1 m grid of probes. Each shoots rays over the whole sphere (many more when it is enclosed,
//     because a room's opening is a small solid angle) and gathers, for the six axis directions, the
//     cosine-weighted radiance that arrives: an ambient cube, E / pi per face, the radiance a white
//     Lambert surface returns. A ray that misses sees the sky; one that hits a surface sees what that
//     surface returns: its albedo times the sun it receives, plus its own emission, plus (from L7) the
//     light the previous pass cached at that point. Each further bounce re-gathers the same rays.
//   - Probes know which neighbours they can see (one ray per link) and whether they sit inside a solid.
//     The cache is read through those links, so a surface never takes light from a probe on the other
//     side of a wall (Lumen weighs probes by what they see for the same reason). The final grid is
//     resampled to half a metre through the same weights, so the texture a material filters has no
//     cross-wall blend left in it.
//   - A material reads the grid through `irradianceNode`, which replaces the environment's diffuse
//     term. The environment stays the source of specular reflection.
//
// A fixed-world bake: move a wall and bake again. Resolution is one metre, so contact-scale light is
// the screen-space tier's job.
import {
  Box3,
  type Color,
  Data3DTexture,
  HalfFloatType,
  type Intersection,
  LinearFilter,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  RGBAFormat,
  Vector3,
} from "three";
import {
  acos,
  atan,
  cameraPosition,
  clamp,
  dot,
  float,
  inverseSqrt,
  max,
  mix,
  normalWorld,
  positionWorld,
  reflect,
  select,
  sqrt,
  texture3D,
  uniform,
  vec3,
} from "three/tsl";
import { MeshStandardNodeMaterial, type Node } from "three/webgpu";

/** What the bake needs of the game's context: the scene ray query (`ICtx.raycast`). */
export interface IRayContext {
  raycast(options: {
    origin: Vector3;
    direction: Vector3;
    far: number;
    targets?: Object3D;
  }): Intersection | undefined;
}

/** Sky radiance on three's equirectangular grid, in scene units: `data * scale` per channel. */
export interface ISkyRadiance {
  readonly data: Float32Array;
  readonly width: number;
  readonly height: number;
  readonly scale: readonly [number, number, number];
}

/** The sky `setupSky` baked, registered for the material pass. */
export const skyRadiance: { current?: ISkyRadiance } = {};

export interface IGiOptions {
  /** Passes that carry surface light back into the cache. 0 is the sky alone (Unreal L2 to L6). */
  readonly bounces: number;
  /** The sun: its colour (tint and air transmittance), intensity, and unit direction toward it. */
  readonly sun: { readonly color: Color; readonly intensity: number; readonly direction: Vector3 };
  /**
   * Unreal without global illumination (layers L2 to L6) shadows its movable sky light with the scene's
   * distance fields, up to the sky light's occlusion distance (1000 cm,
   * Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp, OcclusionMaxDistance): the open
   * fraction of the surface's hemisphere scales the open sky's light, whatever the sky radiance in each
   * direction. Set, in metres, the cache does that and carries no surface light. Unset, it gathers radiance.
   */
  readonly skyShadowDistance?: number;
}

export interface IGiReport {
  readonly cell: number;
  readonly points: number;
  readonly enclosed: number;
  readonly rays: number;
  readonly shadowRays: number;
  readonly bounces: number;
  readonly milliseconds: number;
}

const CELL = 1;
const MAX_POINTS = 24000;
/** Rays every probe shoots, and the extra rays a probe that is mostly enclosed shoots. */
/** An element that exists by construction (a fixed-length array indexed by a loop over its length). */
const nth = <T>(list: readonly T[], index: number): T => list[index] as T;

const BASE_RAYS = 96;
const EXTRA_RAYS = 144;
/** A probe is enclosed when this share of its base rays hit something within ENCLOSED_DISTANCE metres. */
const ENCLOSED_SHARE = 0.15;
const ENCLOSED_DISTANCE = 6;
/** The most probes that get the extra rays: it bounds the bake. */
const MAX_ENCLOSED = 2500;
/** A probe whose rays leave through the back of a surface this share of the time is inside a solid. */
const SOLID_SHARE = 0.25;
/** Where a probe's six faces sit in the grid arrays and the texture's z slices. */
const FACES: readonly (readonly [number, number, number])[] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];
/** Surface shading is cached per half metre and per object: a floor is shaded once for a thousand rays. */
const SHADE_CELL = 0.5;

export interface IGrid {
  readonly origin: Vector3;
  readonly cell: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

/** A grid with what it takes to read it across walls. */
interface IField {
  readonly grid: IGrid;
  /** Per probe, six faces of RGB. */
  readonly values: Float32Array;
  /** Per probe, whether the segment to the next probe along +x, +y, +z is clear. */
  readonly links: Uint8Array;
  /** Per probe, 0 when it sits inside a solid. */
  readonly valid: Uint8Array;
  /** Per probe, six faces: the share of the face's cosine-weighted rays that reach the sky (0..1). */
  readonly sky?: Float32Array;
}

function gridOver(root: Object3D): IGrid {
  const bounds = new Box3().setFromObject(root);
  const size = bounds.getSize(new Vector3());
  const cell = Math.max(CELL, Math.cbrt((size.x * size.y * size.z) / MAX_POINTS));
  return {
    origin: new Vector3(bounds.min.x - cell, bounds.min.y, bounds.min.z - cell),
    cell,
    nx: Math.ceil(size.x / cell) + 2,
    ny: Math.ceil(size.y / cell) + 1,
    nz: Math.ceil(size.z / cell) + 2,
  };
}

/** A small deterministic generator, so a bake repeats. */
function random(seed: number): () => number {
  let state = Math.imul(seed, 2654435761) >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

/**
 * Equal solid angle per ray over the sphere, turned by a random rotation, as x, y, z triples. Plain numbers: on the
 * owned engine every `Vector3` field read is a call into the Wasm module, and the bake reads each ray's direction
 * for the sky, the six faces and the raycast.
 */
function sphereRays(count: number, next: () => number): Float64Array {
  // A uniform random unit quaternion (Shoemake).
  const [u1, u2, u3] = [next(), next(), next()];
  const [qx, qy, qz, qw] = [
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  ];
  const rays = new Float64Array(count * 3);
  for (let k = 0; k < count; k += 1) {
    const y = 1 - ((k + 0.5) * 2) / count;
    const radius = Math.sqrt(1 - y * y);
    const phi = k * Math.PI * (3 - Math.sqrt(5));
    const [vx, vy, vz] = [Math.cos(phi) * radius, y, Math.sin(phi) * radius];
    // v' = v + w t + q x t, with t = 2 q x v.
    const [tx, ty, tz] = [
      2 * (qy * vz - qz * vy),
      2 * (qz * vx - qx * vz),
      2 * (qx * vy - qy * vx),
    ];
    rays[k * 3] = vx + qw * tx + (qy * tz - qz * ty);
    rays[k * 3 + 1] = vy + qw * ty + (qz * tx - qx * tz);
    rays[k * 3 + 2] = vz + qw * tz + (qx * ty - qy * tx);
  }
  return rays;
}

/** Bilinear read of the baked sky in a direction, in scene radiance. */
function skyAt(sky: ISkyRadiance, dx: number, dy: number, dz: number, out: number[]): void {
  const u = (Math.atan2(dz, dx) / (2 * Math.PI) + 0.5) * sky.width - 0.5;
  const v = (Math.acos(Math.max(-1, Math.min(1, dy))) / Math.PI) * sky.height - 0.5;
  const [x0, y0] = [Math.floor(u), Math.floor(v)];
  const [fx, fy] = [u - x0, v - y0];
  for (let c = 0; c < 3; c += 1) {
    const at = (x: number, y: number): number =>
      sky.data[
        (Math.min(sky.height - 1, Math.max(0, y)) * sky.width + ((x + sky.width) % sky.width)) * 3 +
          c
      ] ?? 0;
    const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
    const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
    out[c] = (top * (1 - fy) + bottom * fy) * (sky.scale[c] ?? 1);
  }
}

// --- reading the cache across walls ---------------------------------------------------------

const cornerProbe = new Int32Array(8);
const cornerWeight = new Float64Array(8);

/**
 * The probes around `point` and their weights, written to `cornerProbe` / `cornerWeight`: the usual
 * trilinear weights, zero for a probe that sits inside a solid and for one the strongest valid probe
 * cannot reach along clear segments (a wall between them), renormalised.
 */
function weightsAt(field: IField, point: Vector3): void {
  const { grid } = field;
  const dims = [grid.nx, grid.ny, grid.nz];
  const f = [
    (point.x - grid.origin.x) / grid.cell - 0.5,
    (point.y - grid.origin.y) / grid.cell - 0.5,
    (point.z - grid.origin.z) / grid.cell - 0.5,
  ].map((v, a) => Math.min((dims[a] ?? 1) - 1, Math.max(0, v)));
  const lo = f.map((v) => Math.floor(v));
  const t = f.map((v, a) => v - (lo[a] ?? 0));
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const coordinate = (corner: number, a: number): number =>
    Math.min((dims[a] ?? 1) - 1, (lo[a] ?? 0) + ((corner >> a) & 1));
  const probeOf = (corner: number): number =>
    coordinate(corner, 0) + grid.nx * (coordinate(corner, 1) + grid.ny * coordinate(corner, 2));
  let best = -1;
  let bestWeight = -1;
  for (let corner = 0; corner < 8; corner += 1) {
    let w = 1;
    for (let a = 0; a < 3; a += 1) w *= (corner >> a) & 1 ? (t[a] ?? 0) : 1 - (t[a] ?? 0);
    cornerProbe[corner] = probeOf(corner);
    cornerWeight[corner] = w;
    if (field.valid[probeOf(corner)] === 1 && w > bestWeight) [best, bestWeight] = [corner, w];
  }
  // Every probe around is inside a solid: nothing to choose between, keep the plain weights.
  if (best < 0) return;
  // Walk the axes that differ, in order, from the strongest probe to a corner.
  const reaches = (to: number): boolean => {
    let probe = probeOf(best);
    for (let a = 0; a < 3; a += 1) {
      const [bf, bt] = [(best >> a) & 1, (to >> a) & 1];
      if (bf === bt || coordinate(best, a) === coordinate(to, a)) continue;
      const lower = bf < bt ? probe : probe - (stride[a] ?? 1);
      if (field.links[lower * 3 + a] !== 1) return false;
      probe += bf < bt ? (stride[a] ?? 1) : -(stride[a] ?? 1);
    }
    return field.valid[probe] === 1;
  };
  let sum = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    if (corner !== best && !reaches(corner)) cornerWeight[corner] = 0;
    sum += cornerWeight[corner] ?? 0;
  }
  if (sum <= 1e-9) {
    cornerWeight.fill(0);
    cornerWeight[best] = 1;
    return;
  }
  for (let corner = 0; corner < 8; corner += 1)
    cornerWeight[corner] = (cornerWeight[corner] ?? 0) / sum;
}

/** The ambient-cube read of a field at `point` for `normal`: E / pi. */
function readField(field: IField, point: Vector3, normal: Vector3, out: number[]): void {
  weightsAt(field, point);
  const axes = [normal.x * normal.x, normal.y * normal.y, normal.z * normal.z];
  const faces = [normal.x < 0 ? 1 : 0, normal.y < 0 ? 3 : 2, normal.z < 0 ? 5 : 4];
  out[0] = out[1] = out[2] = 0;
  for (let i = 0; i < 8; i += 1) {
    const w = cornerWeight[i] ?? 0;
    if (w === 0) continue;
    for (let a = 0; a < 3; a += 1)
      for (let c = 0; c < 3; c += 1)
        out[c] =
          (out[c] ?? 0) +
          w *
            (axes[a] ?? 0) *
            (field.values[((cornerProbe[i] ?? 0) * 6 + (faces[a] ?? 0)) * 3 + c] ?? 0);
  }
}

/** The field at twice the resolution, every texel read across walls from the coarse probes. */
function resample(field: IField): { grid: IGrid; values: Float32Array; sky: Float32Array } {
  const { grid } = field;
  const fine: IGrid = {
    origin: grid.origin,
    cell: grid.cell / 2,
    nx: grid.nx * 2,
    ny: grid.ny * 2,
    nz: grid.nz * 2,
  };
  const values = new Float32Array(fine.nx * fine.ny * fine.nz * 18);
  const sky = new Float32Array(fine.nx * fine.ny * fine.nz * 6);
  const point = new Vector3();
  for (let index = 0; index < fine.nx * fine.ny * fine.nz; index += 1) {
    const [x, y, z] = [
      index % fine.nx,
      Math.floor(index / fine.nx) % fine.ny,
      Math.floor(index / (fine.nx * fine.ny)),
    ];
    point.set(
      fine.origin.x + (x + 0.5) * fine.cell,
      fine.origin.y + (y + 0.5) * fine.cell,
      fine.origin.z + (z + 0.5) * fine.cell,
    );
    weightsAt(field, point);
    for (let i = 0; i < 8; i += 1) {
      const w = cornerWeight[i] ?? 0;
      if (w === 0) continue;
      const base = (cornerProbe[i] ?? 0) * 18;
      for (let j = 0; j < 18; j += 1)
        values[index * 18 + j] = (values[index * 18 + j] ?? 0) + w * (field.values[base + j] ?? 0);
      for (let j = 0; j < 6; j += 1)
        sky[index * 6 + j] =
          (sky[index * 6 + j] ?? 0) + w * (field.sky?.[(cornerProbe[i] ?? 0) * 6 + j] ?? 0);
    }
  }
  return { grid: fine, values, sky };
}

// --- the texture -----------------------------------------------------------------------------

/**
 * Per texel of the final grid, which of the links to its +x, +y and +z neighbours a wall cuts (bit 0, 1, 2).
 * The reader blends texels itself and drops the ones a wall separates, because a hardware blend across a wall
 * thinner than a texel (the 0.2 m roof) mixes the lit outside into the room. Most links lie inside open space
 * where the coarse probes already say so; only the ones near a blocked or solid probe get a ray.
 */
function linkMasks(
  field: IField,
  fine: IGrid,
  ctx: IRayContext,
  root: Object3D,
): { masks: Uint8Array; rays: number } {
  const { grid } = field;
  const masks = new Uint8Array(fine.nx * fine.ny * fine.nz);
  const dims = [grid.nx, grid.ny, grid.nz];
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const origin = new Vector3();
  const direction = new Vector3();
  const axes = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ] as const;
  let rays = 0;
  /** True when any probe around `point` is inside a solid or any link between them is cut. */
  const unsure = (px: number, py: number, pz: number): boolean => {
    const f = [
      (px - grid.origin.x) / grid.cell - 0.5,
      (py - grid.origin.y) / grid.cell - 0.5,
      (pz - grid.origin.z) / grid.cell - 0.5,
    ];
    const lo = f.map((v, a) => Math.max(0, Math.min((dims[a] ?? 1) - 2, Math.floor(v))));
    const base = (lo[0] ?? 0) + grid.nx * ((lo[1] ?? 0) + grid.ny * (lo[2] ?? 0));
    for (let corner = 0; corner < 8; corner += 1) {
      const probe =
        base +
        (corner & 1 ? (stride[0] ?? 1) : 0) +
        (corner & 2 ? (stride[1] ?? 1) : 0) +
        (corner & 4 ? (stride[2] ?? 1) : 0);
      if (field.valid[probe] !== 1) return true;
      for (let a = 0; a < 3; a += 1)
        if (!((corner >> a) & 1) && field.links[probe * 3 + a] !== 1) return true;
    }
    return false;
  };
  for (let index = 0; index < masks.length; index += 1) {
    const [x, y, z] = [
      index % fine.nx,
      Math.floor(index / fine.nx) % fine.ny,
      Math.floor(index / (fine.nx * fine.ny)),
    ];
    const at = [
      fine.origin.x + (x + 0.5) * fine.cell,
      fine.origin.y + (y + 0.5) * fine.cell,
      fine.origin.z + (z + 0.5) * fine.cell,
    ] as const;
    let mask = 0;
    for (let a = 0; a < 3; a += 1) {
      if ([x, y, z][a] === ([fine.nx, fine.ny, fine.nz][a] ?? 1) - 1) continue;
      const along = axes[a] as readonly [number, number, number];
      const middle = [0, 1, 2].map((c) => (at[c] ?? 0) + (along[c] ?? 0) * fine.cell * 0.5) as [
        number,
        number,
        number,
      ];
      if (!unsure(...middle)) continue;
      rays += 1;
      origin.set(at[0], at[1], at[2]);
      direction.set(along[0], along[1], along[2]);
      const hit = ctx.raycast({ origin, direction, far: fine.cell, targets: root });
      if (hit !== undefined && hit.distance < fine.cell) mask |= 1 << a;
    }
    masks[index] = mask;
  }
  return { masks, rays };
}

const halfView = new DataView(new ArrayBuffer(4));
/** float32 to IEEE binary16 bits (round to nearest, subnormals flushed: irradiance is never that small). */
function toHalf(value: number): number {
  halfView.setFloat32(0, value);
  const bits = halfView.getUint32(0);
  const sign = (bits >>> 16) & 0x8000;
  const exponent = ((bits >>> 23) & 0xff) - 127 + 15;
  if (exponent <= 0) return sign;
  if (exponent >= 31) return sign | 0x7bff;
  return sign | (exponent << 10) | ((bits >>> 13) & 0x3ff);
}

/** Sky visibility is stored in 6 bits next to the 3-bit link mask: alpha = mask + 8 x round(63 x visibility). */
const SKY_STEPS = 63;

function volume(
  values: Float32Array,
  grid: IGrid,
  masks: Uint8Array,
  sky: Float32Array,
): Data3DTexture {
  const slices = grid.nz * 6;
  const texels = new Uint16Array(grid.nx * grid.ny * slices * 4);
  for (let probe = 0; probe < grid.nx * grid.ny * grid.nz; probe += 1) {
    const [x, y, z] = [
      probe % grid.nx,
      Math.floor(probe / grid.nx) % grid.ny,
      Math.floor(probe / (grid.nx * grid.ny)),
    ];
    for (let face = 0; face < 6; face += 1) {
      const o = (x + grid.nx * (y + grid.ny * (face * grid.nz + z))) * 4;
      for (let c = 0; c < 3; c += 1)
        texels[o + c] = toHalf(values[(probe * 6 + face) * 3 + c] ?? 0);
      texels[o + 3] = toHalf(
        (masks[probe] ?? 0) + 8 * Math.round(SKY_STEPS * Math.min(1, sky[probe * 6 + face] ?? 0)),
      );
    }
  }
  const texture = new Data3DTexture(texels, grid.nx, grid.ny, slices);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The ambient-cube read as a TSL function of a world position and unit normal: E / pi. The eight texels around the
 * read point are blended here (not by the hardware) with the weight of a texel set to zero when a wall cuts the way
 * to it from the nearest texel, the walk `weightsAt` does at bake time, on the links `linkMasks` stored in alpha.
 */
function irradianceAt(values: Float32Array, grid: IGrid, masks: Uint8Array, sky: Float32Array) {
  const cache = volume(values, grid, masks, sky);
  const dims = [grid.nx, grid.ny, grid.nz] as const;
  return (
    position: Node<"vec3">,
    normal: Node<"vec3">,
    reflection?: Node<"vec3">,
  ): { irradiance: Node<"vec3">; visibility: Node<"float"> } => {
    // A node of its own per reader (a material, a post pass), over the one texture.
    const volumeNode = texture3D(cache);
    const n = normal;
    // Texel units: texel i's centre is at i + 0.5. Clamped to the centres so nothing reads past the grid.
    // Read half a fine cell off the surface. 1.5 cells (0.75 m) looked past a 0.4 m gap between two boxes and read the
    // far side, so the white box next to the green one saw no green; the link masks already stop the read from
    // crossing a thin wall. Against a path trace of the scene at 0.25 m, mean |ln(cache / truth)| fell 0.129 -> 0.090
    // (sun60) and 0.106 -> 0.080 (sun15), the worst patch 1.36x -> 1.24x, and a flat wall is as smooth.
    const at = position
      .add(n.mul(grid.cell * 0.5))
      .sub(grid.origin)
      .div(grid.cell);
    const [ax, ay, az] = [
      clamp(at.x, 0.5, grid.nx - 0.5).sub(0.5),
      clamp(at.y, 0.5, grid.ny - 0.5).sub(0.5),
      clamp(at.z, 0.5, grid.nz - 0.5).sub(0.5),
    ];
    const lower = [ax.floor(), ay.floor(), az.floor()];
    const fraction = [ax.sub(nth(lower, 0)), ay.sub(nth(lower, 1)), az.sub(nth(lower, 2))];
    const nearest = fraction.map((f) => f.greaterThan(0.5).select(float(1), float(0)));
    const squares = [n.x.mul(n.x), n.y.mul(n.y), n.z.mul(n.z)];
    const faceIndex = [
      n.x.lessThan(0).select(float(1), float(0)),
      n.y.lessThan(0).select(float(3), float(2)),
      n.z.lessThan(0).select(float(5), float(4)),
    ];
    // The environment share is read along the reflection when there is one (a floor that looks at a doorway sees
    // the sky there, whatever its normal sees), through the same three faces of the ambient cube.
    const r = reflection ?? n;
    const squaresR = [r.x.mul(r.x), r.y.mul(r.y), r.z.mul(r.z)];
    const faceIndexR = [
      r.x.lessThan(0).select(float(1), float(0)),
      r.y.lessThan(0).select(float(3), float(2)),
      r.z.lessThan(0).select(float(5), float(4)),
    ];

    type Taps = { colour: Node<"vec3">; mask: Node<"float">; sky: Node<"float"> };
    const taps = new Map<number, Taps>();
    const tap = (corner: number): Taps => {
      const known = taps.get(corner);
      if (known !== undefined) return known;
      const [tx, ty, tz] = [0, 1, 2].map((a) =>
        clamp(nth(lower, a).add((corner >> a) & 1), 0, (dims[a] ?? 1) - 1),
      );
      const u = (tx as Node<"float">).add(0.5).div(grid.nx);
      const v = (ty as Node<"float">).add(0.5).div(grid.ny);
      let colour: Node<"vec3"> | undefined;
      let mask: Node<"float"> | undefined;
      let visible: Node<"float"> | undefined;
      for (let axis = 0; axis < 3; axis += 1) {
        const w = nth(faceIndex, axis)
          .mul(grid.nz)
          .add(tz as Node<"float">)
          .add(0.5)
          .div(grid.nz * 6);
        const texel = volumeNode.sample(vec3(u, v, w));
        const weighted = texel.rgb.mul(nth(squares, axis));
        colour = colour === undefined ? weighted : colour.add(weighted);
        // alpha = link mask + 8 x sky steps (see `volume`).
        const steps = texel.a.add(0.25).div(8).floor();
        mask ??= texel.a.sub(steps.mul(8));
        const along =
          reflection === undefined
            ? texel
            : volumeNode.sample(
                vec3(
                  u,
                  v,
                  nth(faceIndexR, axis)
                    .mul(grid.nz)
                    .add(tz as Node<"float">)
                    .add(0.5)
                    .div(grid.nz * 6),
                ),
              );
        const shareSteps = along.a.add(0.25).div(8).floor();
        const share = shareSteps.div(SKY_STEPS).mul(nth(squaresR, axis));
        visible = visible === undefined ? share : visible.add(share);
      }
      const result = {
        colour: colour as Node<"vec3">,
        mask: mask as Node<"float">,
        sky: visible as Node<"float">,
      };
      taps.set(corner, result);
      return result;
    };
    /** The mask of the corner whose bits are fixed numbers or, for the nearest corner's bits, a 0/1 node. */
    const maskAt = (
      bits: readonly (number | Node<"float">)[],
      axis = 0,
      corner = 0,
    ): Node<"float"> => {
      if (axis === 3) return tap(corner).mask;
      const bit = nth(bits, axis);
      if (typeof bit === "number") return maskAt(bits, axis + 1, corner | (bit << axis));
      return maskAt(bits, axis + 1, corner)
        .mul(float(1).sub(bit))
        .add(maskAt(bits, axis + 1, corner | (1 << axis)).mul(bit));
    };
    /** 1 when the link along `axis` from a texel with this mask is open. */
    const open = (mask: Node<"float">, axis: number): Node<"float"> => {
      const whole = mask
        .add(0.25)
        .div(2 ** axis)
        .floor();
      return whole.sub(whole.div(2).floor().mul(2)).lessThan(0.5).select(float(1), float(0));
    };

    let sum: Node<"vec3"> | undefined;
    let total: Node<"float"> | undefined;
    let skySum: Node<"float"> | undefined;
    for (let corner = 0; corner < 8; corner += 1) {
      let weight: Node<"float"> = float(1);
      for (let a = 0; a < 3; a += 1) {
        const c = (corner >> a) & 1;
        weight = weight.mul(c ? nth(fraction, a) : float(1).sub(nth(fraction, a)));
        // The step along axis a from the nearest texel: earlier axes already moved to this corner, later ones not yet.
        const bits = [0, 1, 2].map((k) =>
          k < a ? (corner >> k) & 1 : k === a ? 0 : nth(nearest, k),
        );
        const step = open(maskAt(bits), a);
        // Differs from the nearest texel along a: nearest bit != c. A texel that does not differ takes no step.
        const differs = c ? float(1).sub(nth(nearest, a)) : nth(nearest, a);
        weight = weight.mul(float(1).sub(differs).add(differs.mul(step)));
      }
      const t = tap(corner);
      sum = sum === undefined ? t.colour.mul(weight) : sum.add(t.colour.mul(weight));
      skySum = skySum === undefined ? t.sky.mul(weight) : skySum.add(t.sky.mul(weight));
      total = total === undefined ? weight : total.add(weight);
    }
    const whole = max(total as Node<"float">, 1e-5);
    return {
      irradiance: (sum as Node<"vec3">).div(whole),
      visibility: (skySum as Node<"float">).div(whole),
    };
  };
}

/**
 * The cache's read, registered when the bake finishes: a screen-space gather asks it what a ray that finds
 * nothing on screen would have returned (the tier below its own), with the pixel's world position and normal.
 */
export const giCache: {
  irradiance?: (position: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">;
  /** The baked field at its final resolution, for tools and tests: per texel, six faces of RGB (E / pi), six environment shares. */
  field?: { grid: IGrid; values: Float32Array; sky: Float32Array };
} = {};

/**
 * The cache as the tier below a screen-space gather: a function of the pixel's view-space position and unit
 * normal, reading the cache through the camera's world matrix (refreshed every render). Undefined before the bake.
 */
export function cacheFallback(
  camera: PerspectiveCamera,
): ((position: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">) | undefined {
  const read = giCache.irradiance;
  if (read === undefined) return undefined;
  const live = (index: number) =>
    uniform(0).onRenderUpdate(() => camera.matrixWorld.elements[index] ?? 0);
  const column = (a: number) => vec3(live(a), live(a + 1), live(a + 2));
  const [right, up, back, at] = [column(0), column(4), column(8), column(12)];
  const toWorld = (v: Node<"vec3">) => right.mul(v.x).add(up.mul(v.y)).add(back.mul(v.z));
  return (position, normal) => read(toWorld(position).add(at), toWorld(normal).normalize());
}

/** What the bake's rays kept of each hit: enough to tell what a surface returns. */
interface IRays {
  readonly hit: Uint8Array;
  readonly base: Float32Array;
  readonly albedo: Float32Array;
  readonly point: Float32Array;
  readonly normal: Float32Array;
}

/**
 * The radiance the open ground returns, in scene units: the mean over the rays of the unenclosed probes that
 * hit a horizontal surface at the scene's lowest height (the sun it receives, and the cache's light times its
 * albedo, as every other hit counts). Unreal's reflections trace the lit scene, so a mirror's lower half shows
 * this ground; the sky's own radiance has none below the horizon (Unreal's sky pass draws no ground luminance).
 */
function groundRadiance(
  field: IField,
  ray: IRays,
  first: Uint32Array,
  end: Uint32Array,
  floorY: number,
): [number, number, number] | undefined {
  const sum = [0, 0, 0];
  const cached = [0, 0, 0];
  const point = new Vector3();
  const normal = new Vector3();
  let count = 0;
  for (let probe = 0; probe < first.length; probe += 1) {
    if ((end[probe] ?? 0) - (first[probe] ?? 0) !== BASE_RAYS) continue;
    for (let i = first[probe] ?? 0; i < (end[probe] ?? 0); i += 1) {
      if (ray.hit[i] !== 1 || (ray.normal[i * 3 + 1] ?? 0) < 0.99) continue;
      if (Math.abs((ray.point[i * 3 + 1] ?? 0) - floorY) > 0.05) continue;
      point.set(ray.point[i * 3] ?? 0, ray.point[i * 3 + 1] ?? 0, ray.point[i * 3 + 2] ?? 0);
      normal.set(0, 1, 0);
      point.addScaledVector(normal, field.grid.cell * 0.75);
      readField(field, point, normal, cached);
      for (let c = 0; c < 3; c += 1)
        sum[c] =
          (sum[c] ?? 0) +
          (ray.base[i * 3 + c] ?? 0) +
          (ray.albedo[i * 3 + c] ?? 0) * (cached[c] ?? 0);
      count += 1;
    }
  }
  return count === 0
    ? undefined
    : [(sum[0] ?? 0) / count, (sum[1] ?? 0) / count, (sum[2] ?? 0) / count];
}

/**
 * Paints the ground into the lower half of the scene's environment map, the one a mirror reflects: a ray that
 * leaves the frame below the horizon met the lit floor in Unreal's reflections, not the sky's dark nadir. A
 * 3 degree ramp above the horizon hands over from the sky. No-op when the environment is not a canvas.
 */
function paintGround(root: Object3D, radiance: readonly [number, number, number]): void {
  let top: Object3D = root;
  while (top.parent !== null) top = top.parent;
  const scene = top as {
    environment?: { image?: unknown; needsUpdate: boolean } | null;
    environmentIntensity?: number;
  };
  const image = scene.environment?.image as OffscreenCanvas | undefined;
  const context = image?.getContext?.("2d");
  if (
    image === undefined ||
    context === undefined ||
    context === null ||
    scene.environment === null
  )
    return;
  const range = scene.environmentIntensity ?? 1;
  const encoded = radiance.map((v) => Math.round(255 * linearToSrgb(Math.min(1, v / range))));
  const horizon = image.height / 2;
  const ramp = (3 / 180) * image.height;
  const gradient = context.createLinearGradient(0, horizon - ramp, 0, horizon + ramp);
  gradient.addColorStop(0, `rgba(${encoded.join(",")},0)`);
  gradient.addColorStop(1, `rgba(${encoded.join(",")},1)`);
  context.fillStyle = gradient;
  context.fillRect(0, horizon - ramp, image.width, ramp * 2);
  context.fillStyle = `rgb(${encoded.join(",")})`;
  context.fillRect(0, horizon + ramp, image.width, image.height - horizon - ramp);
  (scene.environment as { needsUpdate: boolean }).needsUpdate = true;
}

/** sRGB encoding of a linear value in 0..1. */
function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/**
 * Per probe and face, the share of the face's cosine-weighted rays that see what the scene's environment map shows:
 * the sky (a ray that leaves the scene) and the open ground (a ray that lands on the lowest horizontal surface at a
 * probe that itself sees the sky; the environment's lower half is that ground, `paintGround`). What a ray meets
 * instead (a roof, a wall, the floor of a room) the map does not know. A material's environment reflection is
 * scaled by it. Lumen's rough reflections read the same room through its screen probes, not the sky.
 */
function environmentShare(
  grid: IGrid,
  ray: IRays & { readonly direction: Float32Array },
  first: Uint32Array,
  end: Uint32Array,
  skyShare: Float32Array,
): Float32Array {
  const probes = grid.nx * grid.ny * grid.nz;
  const share = new Float32Array(probes * 6);
  const open = new Float32Array(6);
  const weight = new Float32Array(6);
  for (let probe = 0; probe < probes; probe += 1) {
    open.fill(0);
    weight.fill(0);
    for (let i = first[probe] ?? 0; i < (end[probe] ?? 0); i += 1) {
      let see = 0;
      if (ray.hit[i] === 0) see = 1;
      else if (
        (ray.normal[i * 3 + 1] ?? 0) > 0.99 &&
        Math.abs((ray.point[i * 3 + 1] ?? 0) - grid.origin.y) < 0.05
      ) {
        const ix = Math.floor(((ray.point[i * 3] ?? 0) - grid.origin.x) / grid.cell);
        const iy = Math.floor(
          ((ray.point[i * 3 + 1] ?? 0) + 0.25 * grid.cell - grid.origin.y) / grid.cell,
        );
        const iz = Math.floor(((ray.point[i * 3 + 2] ?? 0) - grid.origin.z) / grid.cell);
        if (ix >= 0 && ix < grid.nx && iy >= 0 && iy < grid.ny && iz >= 0 && iz < grid.nz)
          see = skyShare[(ix + grid.nx * (iy + grid.ny * iz)) * 6 + 2] ?? 0;
      }
      const [dx, dy, dz] = [
        ray.direction[i * 3] ?? 0,
        ray.direction[i * 3 + 1] ?? 0,
        ray.direction[i * 3 + 2] ?? 0,
      ];
      for (let f = 0; f < 6; f += 1) {
        const face = FACES[f] as readonly [number, number, number];
        const w = Math.max(0, face[0] * dx + face[1] * dy + face[2] * dz);
        weight[f] = (weight[f] ?? 0) + w;
        open[f] = (open[f] ?? 0) + w * see;
      }
    }
    for (let f = 0; f < 6; f += 1)
      share[probe * 6 + f] = (open[f] ?? 0) / Math.max(1e-6, weight[f] ?? 0);
  }
  return share;
}

// --- the bake --------------------------------------------------------------------------------

/**
 * Bakes the cache for `root` and gives every standard material under it an `irradianceNode` that
 * reads it. Returns what it did, or undefined when there is no sky to gather (no OffscreenCanvas).
 */
/**
 * E / (pi L) at a surface from a sphere of angular radius asin(sqrt(sin2)) whose centre lies at `cos` from the normal:
 * the CPU twin of the share inside `emitterLight` (keep the two in step; the spec pins this one).
 */
export function sphereShare(sin2: number, cos: number): number {
  if (cos * cos > sin2) return sin2 * Math.max(cos, 0);
  const sin = Math.sqrt(Math.max(1 - cos * cos, 1e-6));
  const x = Math.sqrt(Math.max(1 / sin2 - 1, 1e-6));
  const y = Math.min(1, Math.max(-1, (-x * cos) / sin));
  const t = sin * Math.sqrt(Math.max(1 - y * y, 0));
  return Math.max(0, ((cos * Math.acos(y) - x * t) * sin2 + Math.atan(t / x)) / Math.PI);
}

/**
 * E / pi at a surface from small emissive spheres: the source's own light on its neighbourhood, resolved where the light
 * lands, as Lumen's surface cache does (Engine/Shaders/Private/Lumen/LumenSceneLighting.usf). A sphere wholly above the
 * horizon gives L (r / d)^2 cos; one cut by the horizon gives the clipped form (Lagarde and de Rousiers, "Moving
 * Frostbite to PBR", 2014, section 4.7.2). Only the source occludes itself; another object between them does not
 * (ponytail: no per-pixel visibility; add a shadow ray or a screen trace when a scene puts a blocker beside an emitter).
 */
export function emitterLight(
  emitters: readonly { centre: Vector3; radius: number; radiance: number[] }[],
  position: Node<"vec3">,
  normal: Node<"vec3">,
): Node<"vec3"> | undefined {
  let sum: Node<"vec3"> | undefined;
  for (const e of emitters) {
    const toward = vec3(e.centre.x, e.centre.y, e.centre.z).sub(position);
    const d2 = max(dot(toward, toward), e.radius * e.radius * 1.0001);
    const sin2 = float(e.radius * e.radius).div(d2);
    const cos = clamp(dot(normal, toward.mul(inverseSqrt(d2))), -1, 1);
    const sin = sqrt(max(float(1).sub(cos.mul(cos)), 1e-6));
    const x = sqrt(max(float(1).div(sin2).sub(1), 1e-6));
    const y = clamp(x.negate().mul(cos.div(sin)), -1, 1);
    const s = sin.mul(sqrt(max(float(1).sub(y.mul(y)), 0)));
    const clipped = cos
      .mul(acos(y))
      .sub(x.mul(s))
      .mul(sin2)
      .add(atan(s.div(x)))
      .div(Math.PI);
    const share = select(cos.mul(cos).greaterThan(sin2), sin2.mul(max(cos, 0)), max(clipped, 0));
    const light = vec3(e.radiance[0] ?? 0, e.radiance[1] ?? 0, e.radiance[2] ?? 0).mul(share);
    sum = sum === undefined ? light : sum.add(light);
  }
  return sum;
}

export function installGi(
  ctx: IRayContext,
  root: Object3D,
  options: IGiOptions,
): IGiReport | undefined {
  const sky = skyRadiance.current;
  if (sky === undefined) return undefined;
  const started = performance.now();
  root.updateMatrixWorld(true);
  const grid = gridOver(root);
  const far = Math.hypot(grid.nx, grid.ny, grid.nz) * grid.cell;
  const probes = grid.nx * grid.ny * grid.nz;
  const capacity = probes * BASE_RAYS + MAX_ENCLOSED * EXTRA_RAYS;
  const ray = {
    direction: new Float32Array(capacity * 3),
    hit: new Uint8Array(capacity),
    /** Miss: the sky radiance. Hit: the surface's own radiance (sun and emission), before the cache. */
    base: new Float32Array(capacity * 3),
    albedo: new Float32Array(capacity * 3),
    point: new Float32Array(capacity * 3),
    normal: new Float32Array(capacity * 3),
    /** The sky radiance along the ray, hit or not, and the distance to the hit. */
    sky: new Float32Array(capacity * 3),
    distance: new Float32Array(capacity).fill(far),
  };
  /** A probe's rays are contiguous: its base block, then its extra block when it is enclosed. */
  const first = new Uint32Array(probes);
  const end = new Uint32Array(probes);
  let used = 0;
  const backfaces = new Uint16Array(probes);

  const sunRadiance = [0, 1, 2].map(
    (c) =>
      ([options.sun.color.r, options.sun.color.g, options.sun.color.b][c] ?? 0) *
      (options.sun.intensity / Math.PI),
  );
  const shaded = new Map<string, number[]>();
  let shadowRays = 0;
  let traced = 0;
  const origin = new Vector3();
  const direction = new Vector3();
  const [sunX, sunY, sunZ] = [
    options.sun.direction.x,
    options.sun.direction.y,
    options.sun.direction.z,
  ];
  const colour = [0, 0, 0];

  /** What a surface point returns of the sun (albedo x sun x cos x visibility) plus its emission. */
  const surface = (
    object: Object3D,
    [px, py, pz]: readonly [number, number, number],
    [nx, ny, nz]: readonly [number, number, number],
    albedo: number[],
    emissive: number[],
  ): number[] => {
    const key = `${object.id}|${Math.floor(px / SHADE_CELL)}|${Math.floor(py / SHADE_CELL)}|${Math.floor(pz / SHADE_CELL)}|${Math.round(nx)}${Math.round(ny)}${Math.round(nz)}`;
    const cached = shaded.get(key);
    if (cached !== undefined) return cached;
    const cosine = Math.max(0, nx * sunX + ny * sunY + nz * sunZ);
    let visible = 0;
    if (cosine > 0) {
      shadowRays += 1;
      origin.set(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02);
      visible =
        ctx.raycast({ origin, direction: options.sun.direction, far, targets: root }) === undefined
          ? 1
          : 0;
    }
    const lit = [0, 1, 2].map(
      (c) => (albedo[c] ?? 0) * (sunRadiance[c] ?? 0) * cosine * visible + (emissive[c] ?? 0),
    );
    shaded.set(key, lit);
    return lit;
  };

  // An emissive mesh smaller than a probe cell is a bright point: a few of a probe's rays hit it, each standing for a solid angle
  // many times the source's own, and every probe shoots the same set, so the whole neighbourhood over-reads by the
  // same factor (a 5 x 3.14 radiance sphere lit a wall 8 m away at 4 to 7 times the path-traced value). Lumen clamps
  // and filters such rays; here the source is integrated analytically instead. It is a sphere of its bounding
  // radius (exact for a sphere), and rays that hit it carry no emission of their own.
  const emitters: { centre: Vector3; radius: number; radiance: number[]; id: number }[] = [];
  root.traverse((object) => {
    const mesh = object as Mesh;
    const m = mesh.material as MeshStandardMaterial | undefined;
    if (!(mesh as { isMesh?: boolean }).isMesh || m === undefined) return;
    const radiance = [m.emissive.r, m.emissive.g, m.emissive.b].map(
      (v) => v * (m.emissiveIntensity ?? 1),
    );
    if ((radiance[0] ?? 0) + (radiance[1] ?? 0) + (radiance[2] ?? 0) <= 0) return;
    // The tight sphere: a loader may have set one from the bounding box, which is sqrt(3) too large for a sphere.
    mesh.geometry.computeBoundingSphere();
    const bound = mesh.geometry.boundingSphere;
    if (bound === null) return;
    const radius = bound.radius * mesh.matrixWorld.getMaxScaleOnAxis();
    // A source wider than a probe cell is sampled well by the rays (a lit room, a glowing panel).
    if (radius > grid.cell) return;
    emitters.push({
      centre: bound.center.clone().applyMatrix4(mesh.matrixWorld),
      radius,
      radiance,
      id: mesh.id,
    });
  });
  const emitterIds = new Set(emitters.map((e) => e.id));

  const materialData = new Map<number, { albedo: number[]; emissive: number[] }>();
  const dataOf = (object: Object3D): { albedo: number[]; emissive: number[] } => {
    const known = materialData.get(object.id);
    if (known !== undefined) return known;
    const m = (object as Mesh).material as MeshStandardMaterial;
    const k = 1 - (m.metalness ?? 0);
    const e = [m.emissive.r, m.emissive.g, m.emissive.b];
    const data = {
      albedo: [m.color.r * k, m.color.g * k, m.color.b * k],
      emissive: emitterIds.has(object.id)
        ? [0, 0, 0]
        : [0, 1, 2].map((c) => (e[c] ?? 0) * (m.emissiveIntensity ?? 1)),
    };
    materialData.set(object.id, data);
    return data;
  };

  const centreOf = (probe: number, into: Vector3): Vector3 =>
    into.set(
      grid.origin.x + ((probe % grid.nx) + 0.5) * grid.cell,
      grid.origin.y + ((Math.floor(probe / grid.nx) % grid.ny) + 0.5) * grid.cell,
      grid.origin.z + (Math.floor(probe / (grid.nx * grid.ny)) + 0.5) * grid.cell,
    );

  /** Each object's world matrix as plain numbers (it does not change during the bake). */
  const matrices = new Map<number, number[]>();
  const matrixOf = (object: Object3D): number[] => {
    const known = matrices.get(object.id);
    if (known !== undefined) return known;
    const elements = [...object.matrixWorld.elements];
    matrices.set(object.id, elements);
    return elements;
  };
  const hitAt: [number, number, number] = [0, 0, 0];
  const hitNormal: [number, number, number] = [0, 0, 0];

  /** Traces a block of rays from a probe and stores what they find. Returns how many hit within ENCLOSED_DISTANCE. */
  const trace = (probe: number, centre: Vector3, directions: Float64Array): number => {
    let near = 0;
    for (let k = 0; k < directions.length; k += 3) {
      const [dx, dy, dz] = [directions[k] ?? 0, directions[k + 1] ?? 0, directions[k + 2] ?? 0];
      const i = used;
      used += 1;
      traced += 1;
      ray.direction[i * 3] = dx;
      ray.direction[i * 3 + 1] = dy;
      ray.direction[i * 3 + 2] = dz;
      direction.set(dx, dy, dz);
      const hit = ctx.raycast({ origin: centre, direction, far, targets: root });
      skyAt(sky, dx, dy, dz, colour);
      ray.sky.set(colour, i * 3);
      if (hit === undefined) {
        ray.base.set(colour, i * 3);
        continue;
      }
      ray.hit[i] = 1;
      const distance = hit.distance;
      ray.distance[i] = distance;
      if (distance < ENCLOSED_DISTANCE) near += 1;
      const hitPoint = hit.point;
      [hitAt[0], hitAt[1], hitAt[2]] = [hitPoint.x, hitPoint.y, hitPoint.z];
      const face = hit.face?.normal;
      const m = matrixOf(hit.object);
      // transformDirection: the upper 3x3 of the world matrix, normalised.
      const [fx, fy, fz] =
        face === undefined || face === null ? [dx, dy, dz] : [face.x, face.y, face.z];
      let [nx, ny, nz] = [
        (m[0] ?? 0) * fx + (m[4] ?? 0) * fy + (m[8] ?? 0) * fz,
        (m[1] ?? 0) * fx + (m[5] ?? 0) * fy + (m[9] ?? 0) * fz,
        (m[2] ?? 0) * fx + (m[6] ?? 0) * fy + (m[10] ?? 0) * fz,
      ];
      const length = Math.hypot(nx, ny, nz) || 1;
      [nx, ny, nz] = [nx / length, ny / length, nz / length];
      if (nx * dx + ny * dy + nz * dz > 0) {
        [nx, ny, nz] = [-nx, -ny, -nz];
        if (face !== undefined && face !== null) backfaces[probe] = (backfaces[probe] ?? 0) + 1;
      }
      [hitNormal[0], hitNormal[1], hitNormal[2]] = [nx, ny, nz];
      const { albedo, emissive } = dataOf(hit.object);
      ray.base.set(
        options.bounces > 0 ? surface(hit.object, hitAt, hitNormal, albedo, emissive) : [0, 0, 0],
        i * 3,
      );
      ray.albedo.set(albedo, i * 3);
      ray.point.set(hitAt, i * 3);
      ray.normal.set(hitNormal, i * 3);
    }
    return near;
  };

  const centre = new Vector3();
  let enclosedProbes = 0;
  // Every probe shoots the same ray set. Rays that differ per probe put an independent sampling error in each
  // probe, and a flat wall read through them shows it as a patchwork a probe cell wide; the same set makes
  // neighbours err alike, so the error varies smoothly (Lumen's probes share one importance-sampled set too).
  const next = random(1);
  const baseRays = sphereRays(BASE_RAYS, next);
  const extraRays = sphereRays(EXTRA_RAYS, next);
  for (let probe = 0; probe < probes; probe += 1) {
    centreOf(probe, centre);
    first[probe] = used;
    const near = trace(probe, centre, baseRays);
    if (near > BASE_RAYS * ENCLOSED_SHARE && enclosedProbes < MAX_ENCLOSED) {
      enclosedProbes += 1;
      trace(probe, centre, extraRays);
    }
    end[probe] = used;
  }

  // Which probes see which: one ray along each positive axis to the neighbour, and whether a probe is inside a solid.
  const links = new Uint8Array(probes * 3);
  const valid = new Uint8Array(probes).fill(1);
  const axis = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  const dims = [grid.nx, grid.ny, grid.nz];
  for (let probe = 0; probe < probes; probe += 1) {
    if ((backfaces[probe] ?? 0) > ((end[probe] ?? 0) - (first[probe] ?? 0)) * SOLID_SHARE)
      valid[probe] = 0;
    const index = [
      probe % grid.nx,
      Math.floor(probe / grid.nx) % grid.ny,
      Math.floor(probe / (grid.nx * grid.ny)),
    ];
    centreOf(probe, centre);
    for (let a = 0; a < 3; a += 1) {
      if (index[a] === (dims[a] ?? 1) - 1) continue;
      traced += 1;
      const hit = ctx.raycast({
        origin: centre,
        direction: axis[a] as Vector3,
        far: grid.cell,
        targets: root,
      });
      links[probe * 3 + a] = hit === undefined || hit.distance >= grid.cell ? 1 : 0;
    }
  }

  /**
   * Per probe, six faces of RGB: what the emitters add, E / pi = L (r / d)^2 max(0, n.l) for a sphere that is
   * wholly above the face's horizon, seen through one ray to its centre.
   */
  const emitted = new Float32Array(probes * 18);
  const toward = new Vector3();
  for (let probe = 0; probe < probes && emitters.length > 0; probe += 1) {
    centreOf(probe, centre);
    if ((backfaces[probe] ?? 0) > ((end[probe] ?? 0) - (first[probe] ?? 0)) * SOLID_SHARE) continue;
    for (const emitter of emitters) {
      toward.copy(emitter.centre).sub(centre);
      const distance = toward.length();
      if (distance <= emitter.radius) continue;
      toward.divideScalar(distance);
      traced += 1;
      const blocker = ctx.raycast({
        origin: centre,
        direction: toward,
        far: distance,
        targets: root,
      });
      if (blocker !== undefined && blocker.distance < distance - emitter.radius) continue;
      const solid = Math.min(1, (emitter.radius / distance) ** 2);
      for (let f = 0; f < 6; f += 1) {
        const face = FACES[f] as readonly [number, number, number];
        const cosine = Math.max(0, face[0] * toward.x + face[1] * toward.y + face[2] * toward.z);
        for (let c = 0; c < 3; c += 1)
          emitted[probe * 18 + f * 3 + c] =
            (emitted[probe * 18 + f * 3 + c] ?? 0) + (emitter.radiance[c] ?? 0) * solid * cosine;
      }
    }
  }

  // Gather: each pass sums what the rays carry into six faces per probe.
  const shadowing = options.skyShadowDistance !== undefined;
  /** Per probe and face, the share of the cosine-weighted rays that leave the scene (see `IField.sky`). */
  const skyShare = new Float32Array(probes * 6);
  const gather = (previous: IField | undefined): Float32Array => {
    const point = new Vector3();
    const normal = new Vector3();
    const out = new Float32Array(probes * 18);
    const cached = [0, 0, 0];
    const sum = new Float32Array(18);
    const open = new Float32Array(6);
    const weight = new Float32Array(6);
    const sees = new Float32Array(6);
    for (let probe = 0; probe < probes; probe += 1) {
      sum.fill(0);
      open.fill(0);
      weight.fill(0);
      sees.fill(0);
      const count = (end[probe] ?? 0) - (first[probe] ?? 0);
      for (let i = first[probe] ?? 0; i < (end[probe] ?? 0); i += 1) {
        const [dx, dy, dz] = [
          ray.direction[i * 3] ?? 0,
          ray.direction[i * 3 + 1] ?? 0,
          ray.direction[i * 3 + 2] ?? 0,
        ];
        let [r, g, b] = [ray.base[i * 3] ?? 0, ray.base[i * 3 + 1] ?? 0, ray.base[i * 3 + 2] ?? 0];
        const free = ray.hit[i] === 0 || (ray.distance[i] ?? 0) > (options.skyShadowDistance ?? 0);
        if (shadowing)
          [r, g, b] = [ray.sky[i * 3] ?? 0, ray.sky[i * 3 + 1] ?? 0, ray.sky[i * 3 + 2] ?? 0];
        else if (ray.hit[i] === 1 && previous !== undefined) {
          point.set(ray.point[i * 3] ?? 0, ray.point[i * 3 + 1] ?? 0, ray.point[i * 3 + 2] ?? 0);
          normal.set(
            ray.normal[i * 3] ?? 0,
            ray.normal[i * 3 + 1] ?? 0,
            ray.normal[i * 3 + 2] ?? 0,
          );
          point.addScaledVector(normal, grid.cell * 0.75);
          readField(previous, point, normal, cached);
          r += (ray.albedo[i * 3] ?? 0) * (cached[0] ?? 0);
          g += (ray.albedo[i * 3 + 1] ?? 0) * (cached[1] ?? 0);
          b += (ray.albedo[i * 3 + 2] ?? 0) * (cached[2] ?? 0);
        }
        for (let f = 0; f < 6; f += 1) {
          const face = FACES[f] as readonly [number, number, number];
          const w = Math.max(0, face[0] * dx + face[1] * dy + face[2] * dz);
          if (w === 0) continue;
          weight[f] = (weight[f] ?? 0) + w;
          if (free) open[f] = (open[f] ?? 0) + w;
          if (ray.hit[i] === 0) sees[f] = (sees[f] ?? 0) + w;
          sum[f * 3] = (sum[f * 3] ?? 0) + w * r;
          sum[f * 3 + 1] = (sum[f * 3 + 1] ?? 0) + w * g;
          sum[f * 3 + 2] = (sum[f * 3 + 2] ?? 0) + w * b;
        }
      }
      for (let f = 0; f < 6; f += 1)
        skyShare[probe * 6 + f] = (sees[f] ?? 0) / Math.max(1e-6, weight[f] ?? 0);
      // E / pi = (1 / pi) x sum(L cos dOmega) with dOmega = 4 pi / rays.
      for (let j = 0; j < 18; j += 1) {
        const f = Math.floor(j / 3);
        const visible = shadowing ? (open[f] ?? 0) / Math.max(1e-6, weight[f] ?? 0) : 1;
        out[probe * 18 + j] =
          (((sum[j] ?? 0) * 4) / Math.max(1, count)) * visible + (emitted[probe * 18 + j] ?? 0);
      }
    }
    return out;
  };
  let values = gather(undefined);
  for (let pass = 1; pass < options.bounces; pass += 1)
    values = gather({ grid, values, links, valid });
  // The bounces above carry the emitters' light; what a surface reads directly from them is exact per pixel (see
  // `emitterLight`), because a 0.5 m cell cannot hold a glow that falls off within 0.3 m of the source.
  for (let i = 0; i < values.length; i += 1) values[i] = (values[i] ?? 0) - (emitted[i] ?? 0);

  if (options.bounces > 0) {
    const floor = groundRadiance({ grid, values, links, valid }, ray, first, end, grid.origin.y);
    if (floor !== undefined) paintGround(root, floor);
  }
  const environment = environmentShare(grid, ray, first, end, skyShare);
  const fine = resample({ grid, values, links, valid, sky: environment });
  const cut = linkMasks({ grid, values, links, valid }, fine.grid, ctx, root);
  traced += cut.rays;
  giCache.field = { grid: fine.grid, values: fine.values, sky: fine.sky };
  const read = irradianceAt(fine.values, fine.grid, cut.masks, fine.sky);
  // The screen-space gather's tier below reads the same as a material does, emitters included, so a ray that hits
  // the emitter on screen replaces its direct light instead of adding it twice.
  giCache.irradiance = (position, normal) => {
    const base = read(position, normal).irradiance;
    const light = emitterLight(emitters, position, normal);
    return light === undefined ? base : base.add(light);
  };
  const normal = normalWorld.normalize();
  const incident = positionWorld.sub(cameraPosition).normalize();
  /**
   * What a material reads: the cache, and the environment's share along its reflection (the lobe leans toward the
   * normal as the surface roughens, as the engine's own reflection vector does). The share is the material's
   * occlusion: it dims the environment's specular, which the engine applies to the indirect specular only (aoNode
   * also scales the indirect diffuse, so the diffuse reads the cache divided by it: the product is the cache).
   */
  const direct = emitterLight(emitters, positionWorld, normal);
  const reads = new Map<number, { node: Node<"vec3">; visibility: Node<"float"> }>();
  const readFor = (roughness: number) => {
    const known = reads.get(roughness);
    if (known !== undefined) return known;
    const lobe = mix(reflect(incident, normal), normal, roughness ** 3).normalize();
    const lit = read(positionWorld, normal, lobe);
    const visibility = max(lit.visibility, 0.05);
    const irradiance = direct === undefined ? lit.irradiance : lit.irradiance.add(direct);
    const made = { node: irradiance.div(visibility), visibility };
    reads.set(roughness, made);
    return made;
  };
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const source = mesh.material as MeshStandardMaterial;
    const { node, visibility } = readFor(source.roughness);
    const material = new MeshStandardNodeMaterial();
    material.color.copy(source.color);
    material.roughness = source.roughness;
    material.metalness = source.metalness;
    material.emissive.copy(source.emissive);
    material.emissiveIntensity = source.emissiveIntensity;
    material.side = source.side;
    (material as unknown as { irradianceNode: unknown }).irradianceNode = node;
    (material as unknown as { aoNode: unknown }).aoNode = visibility;
    mesh.material = material;
  });
  const report: IGiReport = {
    cell: grid.cell,
    points: probes,
    enclosed: enclosedProbes,
    rays: traced,
    shadowRays,
    bounces: options.bounces,
    milliseconds: Math.round(performance.now() - started),
  };
  console.info(`TN_GI_CACHE ${JSON.stringify(report)}`);
  return report;
}
