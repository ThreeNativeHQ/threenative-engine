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
  RGBAFormat,
  Vector3,
} from "three";
import { clamp, float, normalWorld, positionWorld, texture3D, vec3 } from "three/tsl";
import { MeshStandardNodeMaterial } from "three/webgpu";

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

interface IGrid {
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

/** Equal solid angle per ray over the sphere, turned by a random rotation so no two probes share a pattern. */
function sphereRays(count: number, next: () => number): Vector3[] {
  // A uniform random unit quaternion (Shoemake).
  const [u1, u2, u3] = [next(), next(), next()];
  const [qx, qy, qz, qw] = [
    Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2),
    Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2),
    Math.sqrt(u1) * Math.sin(2 * Math.PI * u3),
    Math.sqrt(u1) * Math.cos(2 * Math.PI * u3),
  ];
  const rays: Vector3[] = [];
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
    rays.push(
      new Vector3(
        vx + qw * tx + (qy * tz - qz * ty),
        vy + qw * ty + (qz * tx - qx * tz),
        vz + qw * tz + (qx * ty - qy * tx),
      ),
    );
  }
  return rays;
}

/** Bilinear read of the baked sky in a direction, in scene radiance. */
function skyAt(sky: ISkyRadiance, d: Vector3, out: number[]): void {
  const u = (Math.atan2(d.z, d.x) / (2 * Math.PI) + 0.5) * sky.width - 0.5;
  const v = (Math.acos(Math.max(-1, Math.min(1, d.y))) / Math.PI) * sky.height - 0.5;
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
function resample(field: IField): { grid: IGrid; values: Float32Array } {
  const { grid } = field;
  const fine: IGrid = {
    origin: grid.origin,
    cell: grid.cell / 2,
    nx: grid.nx * 2,
    ny: grid.ny * 2,
    nz: grid.nz * 2,
  };
  const values = new Float32Array(fine.nx * fine.ny * fine.nz * 18);
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
    }
  }
  return { grid: fine, values };
}

// --- the texture -----------------------------------------------------------------------------

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

function volume(values: Float32Array, grid: IGrid): Data3DTexture {
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
      texels[o + 3] = toHalf(1);
    }
  }
  // The engine's Data3DTexture constructor takes bytes or floats, so the half-float bits go in through
  // `image.data` once the type says what they are (the path three's own examples take too).
  const texture = new Data3DTexture(new Float32Array(texels.length), grid.nx, grid.ny, slices);
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  (texture.image as unknown as { data: Uint16Array }).data = texels;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

/** The ambient-cube read as a TSL node over the surface's own world position and normal: E / pi. */
function irradianceNode(values: Float32Array, grid: IGrid) {
  const volumeNode = texture3D(volume(values, grid));
  const n = normalWorld.normalize();
  const at = positionWorld
    .add(n.mul(grid.cell * 1.5))
    .sub(grid.origin)
    .div(grid.cell);
  // Texel units, clamped to the texel centres so no sub-volume reads past its own slices.
  const u = clamp(at.x, 0.5, grid.nx - 0.5).div(grid.nx);
  const v = clamp(at.y, 0.5, grid.ny - 0.5).div(grid.ny);
  const z = clamp(at.z, 0.5, grid.nz - 0.5);
  const face = (axis: 0 | 1 | 2) => {
    const component = axis === 0 ? n.x : axis === 1 ? n.y : n.z;
    const index = component.lessThan(0).select(float(axis * 2 + 1), float(axis * 2));
    const w = index
      .mul(grid.nz)
      .add(z)
      .div(grid.nz * 6);
    return volumeNode.sample(vec3(u, v, w)).rgb.mul(component.mul(component));
  };
  return face(0).add(face(1)).add(face(2));
}

// --- the bake --------------------------------------------------------------------------------

/**
 * Bakes the cache for `root` and gives every standard material under it an `irradianceNode` that
 * reads it. Returns what it did, or undefined when there is no sky to gather (no OffscreenCanvas).
 */
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
  const point = new Vector3();
  const normal = new Vector3();
  const colour = [0, 0, 0];

  /** What a surface point returns of the sun (albedo x sun x cos x visibility) plus its emission. */
  const surface = (hit: Intersection, albedo: number[], emissive: number[]): number[] => {
    const key = `${hit.object.id}|${Math.floor(point.x / SHADE_CELL)}|${Math.floor(point.y / SHADE_CELL)}|${Math.floor(point.z / SHADE_CELL)}|${Math.round(normal.x)}${Math.round(normal.y)}${Math.round(normal.z)}`;
    const cached = shaded.get(key);
    if (cached !== undefined) return cached;
    const cosine = Math.max(0, normal.dot(options.sun.direction));
    let visible = 0;
    if (cosine > 0) {
      shadowRays += 1;
      origin.copy(normal).multiplyScalar(0.02).add(point);
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

  const materialData = new Map<number, { albedo: number[]; emissive: number[] }>();
  const dataOf = (object: Object3D): { albedo: number[]; emissive: number[] } => {
    const known = materialData.get(object.id);
    if (known !== undefined) return known;
    const m = (object as Mesh).material as MeshStandardMaterial;
    const k = 1 - (m.metalness ?? 0);
    const e = [m.emissive.r, m.emissive.g, m.emissive.b];
    const data = {
      albedo: [m.color.r * k, m.color.g * k, m.color.b * k],
      emissive: [0, 1, 2].map((c) => (e[c] ?? 0) * (m.emissiveIntensity ?? 1)),
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

  /** Traces a block of rays from a probe and stores what they find. Returns how many hit within ENCLOSED_DISTANCE. */
  const trace = (probe: number, centre: Vector3, directions: Vector3[]): number => {
    let near = 0;
    for (const direction of directions) {
      const i = used;
      used += 1;
      traced += 1;
      ray.direction.set([direction.x, direction.y, direction.z], i * 3);
      const hit = ctx.raycast({ origin: centre, direction, far, targets: root });
      skyAt(sky, direction, colour);
      ray.sky.set(colour, i * 3);
      if (hit === undefined) {
        ray.base.set(colour, i * 3);
        continue;
      }
      ray.hit[i] = 1;
      ray.distance[i] = hit.distance;
      if (hit.distance < ENCLOSED_DISTANCE) near += 1;
      point.copy(hit.point);
      const face = hit.face?.normal;
      normal.copy(face ?? direction).transformDirection(hit.object.matrixWorld);
      if (normal.dot(direction) > 0) {
        normal.negate();
        if (face !== undefined && face !== null) backfaces[probe] = (backfaces[probe] ?? 0) + 1;
      }
      const { albedo, emissive } = dataOf(hit.object);
      ray.base.set(options.bounces > 0 ? surface(hit, albedo, emissive) : [0, 0, 0], i * 3);
      ray.albedo.set(albedo, i * 3);
      ray.point.set([point.x, point.y, point.z], i * 3);
      ray.normal.set([normal.x, normal.y, normal.z], i * 3);
    }
    return near;
  };

  const centre = new Vector3();
  let enclosedProbes = 0;
  for (let probe = 0; probe < probes; probe += 1) {
    centreOf(probe, centre);
    const next = random(probe + 1);
    first[probe] = used;
    const near = trace(probe, centre, sphereRays(BASE_RAYS, next));
    if (near > BASE_RAYS * ENCLOSED_SHARE && enclosedProbes < MAX_ENCLOSED) {
      enclosedProbes += 1;
      trace(probe, centre, sphereRays(EXTRA_RAYS, next));
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

  // Gather: each pass sums what the rays carry into six faces per probe.
  const shadowing = options.skyShadowDistance !== undefined;
  const gather = (previous: IField | undefined): Float32Array => {
    const out = new Float32Array(probes * 18);
    const cached = [0, 0, 0];
    const sum = new Float32Array(18);
    const open = new Float32Array(6);
    const weight = new Float32Array(6);
    for (let probe = 0; probe < probes; probe += 1) {
      sum.fill(0);
      open.fill(0);
      weight.fill(0);
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
          sum[f * 3] = (sum[f * 3] ?? 0) + w * r;
          sum[f * 3 + 1] = (sum[f * 3 + 1] ?? 0) + w * g;
          sum[f * 3 + 2] = (sum[f * 3 + 2] ?? 0) + w * b;
        }
      }
      // E / pi = (1 / pi) x sum(L cos dOmega) with dOmega = 4 pi / rays.
      for (let j = 0; j < 18; j += 1) {
        const f = Math.floor(j / 3);
        const visible = shadowing ? (open[f] ?? 0) / Math.max(1e-6, weight[f] ?? 0) : 1;
        out[probe * 18 + j] = (((sum[j] ?? 0) * 4) / Math.max(1, count)) * visible;
      }
    }
    return out;
  };
  let values = gather(undefined);
  for (let pass = 1; pass < options.bounces; pass += 1)
    values = gather({ grid, values, links, valid });

  const fine = resample({ grid, values, links, valid });
  const node = irradianceNode(fine.values, fine.grid);
  root.traverse((object) => {
    const mesh = object as Mesh;
    if (!(mesh as { isMesh?: boolean }).isMesh) return;
    const source = mesh.material as MeshStandardMaterial;
    const material = new MeshStandardNodeMaterial();
    material.color.copy(source.color);
    material.roughness = source.roughness;
    material.metalness = source.metalness;
    material.emissive.copy(source.emissive);
    material.emissiveIntensity = source.emissiveIntensity;
    material.side = source.side;
    (material as unknown as { irradianceNode: unknown }).irradianceNode = node;
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
