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
//     surface returns: its albedo times the sun and the local lights it receives, plus its own emission,
//     plus (from L7) the light the previous pass cached at that point. Each further bounce re-gathers the
//     same rays. A scene without a sky has a black one: rays that miss carry nothing (a box lit by one lamp).
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
  type ISurfaceCacheOptions,
  type ISurfaceCacheReport,
  SurfaceCache,
} from "@threenative/core";
import {
  Box3,
  type Color,
  Data3DTexture,
  DoubleSide,
  HalfFloatType,
  type Intersection,
  LinearFilter,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type PerspectiveCamera,
  RGBAFormat,
  type Side,
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
import { MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, type Node } from "three/webgpu";
import { type IFlatRays, bakeRays } from "./bakeRays.js";

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
  readonly sun?: { readonly color: Color; readonly intensity: number; readonly direction: Vector3 };
  /**
   * Point lights, in three's units: `intensity` is a `PointLight.intensity` (candela), `distance` its cutoff
   * (0 = none). A surface returns albedo x colour x (intensity / pi) / d^2 x window x cos x visibility, as the sun.
   */
  readonly lights?: readonly {
    readonly position: Vector3;
    readonly color: Color;
    readonly intensity: number;
    readonly distance: number;
  }[];
  /**
   * Unreal without global illumination (layers L2 to L6) shadows its movable sky light with the scene's
   * distance fields, up to the sky light's occlusion distance (1000 cm,
   * Engine/Source/Runtime/Engine/Private/Components/SkyLightComponent.cpp, OcclusionMaxDistance): the open
   * fraction of the surface's hemisphere scales the open sky's light, whatever the sky radiance in each
   * direction. Set, in metres, the cache does that and carries no surface light. Unset, it gathers radiance.
   */
  readonly skyShadowDistance?: number;
  /**
   * Unreal's `r.SkylightIntensityMultiplier`: a factor on the sky's radiance in the bake. Its Low tier of global
   * illumination sets 0.8 (Engine/Config/BaseScalability.ini, `[GlobalIlluminationQuality@0]`). Unset is 1.
   */
  readonly skyIntensity?: number;
  /** Cast the bake's rays through `ctx.raycast` instead of the flat triangle hierarchy: the slow path, kept for an A/B. */
  readonly stockRays?: boolean;
  /**
   * Draw the first frame at once and fill the cache over the following frames, as Lumen fills its probes over frames
   * instead of before the first one. `installGi` installs the materials over a black cache and returns a `pending`
   * report. A provisional bake (`previewRays` rays per probe, `previewBounces` bounces) then runs in slices of `budgetMs` on the clock
   * (twice that), and the full bake after it. Each rewrites the texture the materials already read; `onConverged`
   * gets the full bake's report. No frame is held longer than a slice. Needs the flat rays.
   */
  readonly progressive?: {
    readonly previewRays: number;
    /**
     * Bounces of the provisional bake, 2 when unset. One bounce leaves out the warm light a lit floor throws on the
     * walls: the first frame reads dark and cool. A second one halves the error against the full cache (relative L1 0.151
     * to 0.077 on the sunlit room) for about 150 ms; more bounces gain little, the rays' noise stays.
     */
    readonly previewBounces?: number;
    readonly budgetMs: number;
    /**
     * Idle time left after each slice, in milliseconds. The default 0 runs the next slice on the next task: the browser
     * draws a frame that is due, and handles input, before it, so the bake takes what the frames leave.
     */
    readonly gapMs?: number;
    /** Runs a slice after `gapMs` of idle time. The host's task queue by default; a test hands in its own queue. */
    readonly defer?: (run: () => void, gapMs: number) => void;
    readonly onConverged?: (report: IGiReport) => void;
  };
  /**
   * The Surface Cache (PRD-639): a ray that lands on a mapped material returns the map's texel at the hit UV, for the
   * albedo and for the emission, instead of the material's flat colour (a loaded asset's colour factor is often white
   * under a brick map). Unset, every hit returns the flat colour. `true` takes the cache's defaults.
   */
  readonly surfaceCache?: boolean | ISurfaceCacheOptions;
}

export interface IGiReport {
  readonly cell: number;
  readonly points: number;
  readonly enclosed: number;
  readonly rays: number;
  readonly shadowRays: number;
  /** Final-grid texels whose centre lies inside a solid; the reader skips them. */
  readonly solid: number;
  readonly bounces: number;
  readonly milliseconds: number;
  /** Milliseconds per bake phase, in order, so a cost is attributed before it is cut. */
  readonly phases: Readonly<Record<string, number>>;
  /**
   * `pending` is a progressive bake that has not published yet (the cache reads black); `preview` is its provisional
   * cache; `final` is the full one.
   */
  readonly pass: "pending" | "preview" | "final";
  /**
   * A progressive bake's own account of how long it held the thread: its slices so far (count, and the longest one) and
   * the time this report's publish took on the thread (the resample into the texture's data; the GPU copy follows at
   * the next render), all in milliseconds.
   */
  readonly slices?: {
    readonly count: number;
    readonly longestMs: number;
    readonly publishMs: number;
  };
  /** What the Surface Cache held, when the bake used one. */
  readonly surfaceCache?: ISurfaceCacheReport;
}

const CELL = 0.5;
/** How far past the rest of the scene the grid covers a ground plane that dwarfs it (`sceneBounds`). */
const GROUND_MARGIN = 2;
/**
 * Passes of `smooth` over the baked probes. Wall roughness on the sunlit room (mean |read - its 1 m box mean| / mean):
 * 0.060 with none, 0.029 / 0.017 / 0.011 / 0.0085 after 1 to 4; the 1 m grid had 0.011. Area means move under 1%.
 */
const SMOOTH_PASSES = 4;
/**
 * The filter's edge stop, in natural-log units of a neighbour's luminance over the probe's: a neighbour 2x off weighs
 * 0.61, 4x off 0.14. Probe noise (about 30%) blends; a window probe that sees the sun patch does not. Plain, the filter
 * lit a halo round the sunlit room's window (sill 2.45x the path trace at sun 15; 1.58x with the stop).
 */
const SMOOTH_EDGE = 0.7;
/**
 * The most coarse probes a bake takes, counted as the grid holds them (`nx * ny * nz`, padding included). 8820 is the
 * reference scene's 40 m ground at the old 1 m cell. A budget on the volume alone let the 0.5 m cell bake 33327
 * probes there, and L9 took 344 s to start instead of 112 s.
 */
const MAX_POINTS = 8820;
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

/**
 * The bounds the probes cover: the scene's, less a ground plane that dwarfs the rest. The sunlit room's 40 m ground
 * stretched the grid to 1 m probes, 0.9 m under its ceiling: each bounce read the light nearer the sun patch and the
 * walls came out 1.4 to 1.6 times the path trace.
 */
function sceneBounds(root: Object3D): Box3 {
  const boxes: Box3[] = [];
  root.traverse((object) => {
    if ((object as Mesh).isMesh) boxes.push(new Box3().setFromObject(object));
  });
  const area = (box: Box3) => (box.max.x - box.min.x) * (box.max.z - box.min.z);
  const widest = boxes.reduce<Box3 | undefined>(
    (w, box) => (w === undefined || area(box) > area(w) ? box : w),
    undefined,
  );
  const rest = new Box3();
  for (const box of boxes) if (box !== widest) rest.union(box);
  // A 40 m floor under a 12 m roof (11 times its area) is a covered plaza, all of it read; the room's ground is 29 times.
  if (widest === undefined || rest.isEmpty() || area(widest) < 20 * area(rest))
    return new Box3().setFromObject(root);
  // The ground next to the walls stays in the grid; past it a read takes probes 2 m out, in the open.
  return rest
    .expandByVector(new Vector3(GROUND_MARGIN, 0, GROUND_MARGIN))
    .union(
      new Box3(
        new Vector3(rest.min.x, widest.min.y, rest.min.z),
        new Vector3(rest.max.x, widest.max.y, rest.max.z),
      ),
    );
}

export function gridOver(root: Object3D): IGrid {
  const bounds = sceneBounds(root);
  const size = bounds.getSize(new Vector3());
  const count = (cell: number) =>
    (Math.ceil(size.x / cell) + 2) *
    (Math.ceil(size.y / cell) + 1) *
    (Math.ceil(size.z / cell) + 2);
  let cell = Math.max(CELL, Math.cbrt((size.x * size.y * size.z) / MAX_POINTS));
  while (count(cell) > MAX_POINTS) cell *= 1.01;
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

// --- time slicing ------------------------------------------------------------------------------

/**
 * A bake handed a deadline yields at its loop boundaries once the deadline passes, so a game can spread the
 * full-quality bake over frames. With no deadline nothing ever yields and a bake runs to its end in one call.
 * One bake runs at a time: the deadline and the idle counter are module state, like the probe scratch below.
 */
const slice = { deadline: Number.POSITIVE_INFINITY, idle: 0 };
const due = (): boolean => performance.now() > slice.deadline;
/** Yields to the frame. The time spent away is counted, so a phase reports its own work and not the wait. */
function* pause(): Generator<void, void> {
  const left = performance.now();
  yield;
  slice.idle += performance.now() - left;
}

/**
 * Runs a callback on a later task of the host: after `gapMs` on the clock, or on the next task when there is no gap. A
 * message round trip is the next task without the timer's 4 ms floor (the clamp on nested `setTimeout`), and the browser
 * draws a due frame and handles input before it. A host without `MessageChannel` falls back to the timer.
 */
function hostDefer(): (run: () => void, gapMs: number) => void {
  if (typeof MessageChannel !== "function") return (run, gapMs) => void setTimeout(run, gapMs);
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => queue.shift()?.();
  // Node keeps a listening port alive until it closes; a page has no such method.
  (channel.port1 as { unref?: () => void }).unref?.();
  return (run, gapMs) => {
    if (gapMs > 0) void setTimeout(run, gapMs);
    else {
      queue.push(run);
      channel.port2.postMessage(0);
    }
  };
}

// --- reading the cache across walls ---------------------------------------------------------

const cornerProbe = new Int32Array(8);
const cornerWeight = new Float64Array(8);

/**
 * The probes around `point` and their weights, written to `cornerProbe` / `cornerWeight`: the usual
 * trilinear weights, zero for a probe that sits inside a solid and for one the strongest valid probe
 * cannot reach along clear segments (a wall between them), renormalised. With `sees`, the strongest probe must also
 * be visible from the point where a wall cuts the cell: a texel 0.15 m under a 0.2 m roof otherwise started from the
 * probe above the roof (weight 0.75 against 0.25), read the sky (share 0.46 against 0.01 a row lower) and lit a
 * band along every ceiling of the sunlit room.
 */
function weightsAt(field: IField, point: Vector3, sees?: (probe: number) => boolean): void {
  const { grid } = field;
  const nx = grid.nx;
  const ny = grid.ny;
  const nz = grid.nz;
  // No arrays or closures before the fast path: this runs for every ray of every bounce pass and every texel.
  const fx = Math.min(nx - 1, Math.max(0, (point.x - grid.origin.x) / grid.cell - 0.5));
  const fy = Math.min(ny - 1, Math.max(0, (point.y - grid.origin.y) / grid.cell - 0.5));
  const fz = Math.min(nz - 1, Math.max(0, (point.z - grid.origin.z) / grid.cell - 0.5));
  const lx = Math.floor(fx);
  const ly = Math.floor(fy);
  const lz = Math.floor(fz);
  const tx = fx - lx;
  const ty = fy - ly;
  const tz = fz - lz;
  const hx = Math.min(nx - 1, lx + 1);
  const hy = Math.min(ny - 1, ly + 1);
  const hz = Math.min(nz - 1, lz + 1);
  let best = -1;
  let bestWeight = -1;
  let cut = false;
  for (let corner = 0; corner < 8; corner += 1) {
    const w = (corner & 1 ? tx : 1 - tx) * (corner & 2 ? ty : 1 - ty) * (corner & 4 ? tz : 1 - tz);
    const probe =
      (corner & 1 ? hx : lx) + nx * ((corner & 2 ? hy : ly) + ny * (corner & 4 ? hz : lz));
    cornerProbe[corner] = probe;
    cornerWeight[corner] = w;
    if (field.valid[probe] !== 1) cut = true;
    for (let a = 0; a < 3; a += 1)
      if (!((corner >> a) & 1) && field.links[probe * 3 + a] !== 1) cut = true;
    if (field.valid[probe] === 1 && w > bestWeight) {
      best = corner;
      bestWeight = w;
    }
  }
  // No wall, no solid around the cell: every corner is reachable, so only the renormalisation below remains.
  if (!cut) {
    let total = 0;
    for (let corner = 0; corner < 8; corner += 1) total += cornerWeight[corner] ?? 0;
    for (let corner = 0; corner < 8; corner += 1)
      cornerWeight[corner] = (cornerWeight[corner] ?? 0) / total;
    return;
  }
  const stride = [1, nx, nx * ny];
  const lo = [lx, ly, lz];
  const dims = [nx, ny, nz];
  const coordinate = (corner: number, a: number): number =>
    Math.min((dims[a] ?? 1) - 1, (lo[a] ?? 0) + ((corner >> a) & 1));
  const probeOf = (corner: number): number => cornerProbe[corner] ?? 0;
  if (cut && sees !== undefined && best >= 0 && !sees(probeOf(best))) {
    const order = [0, 1, 2, 3, 4, 5, 6, 7]
      .filter((c) => c !== best && field.valid[probeOf(c)] === 1)
      .sort((a, b) => (cornerWeight[b] ?? 0) - (cornerWeight[a] ?? 0));
    best = order.find((c) => sees(probeOf(c))) ?? best;
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
    // Every other probe it blends must be in sight too: under the sunlit room's window, a texel below the sill took the
    // probe 5 cm over the sun-lit sill top, round the sill through the opening, and read 3.7x the path trace.
    if (
      cut &&
      sees !== undefined &&
      corner !== best &&
      (cornerWeight[corner] ?? 0) > 0 &&
      !sees(probeOf(corner))
    )
      cornerWeight[corner] = 0;
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
  // The three faces the normal leans on and how much (its squared components); every corner adds each of them in turn.
  const squareX = normal.x * normal.x;
  const squareY = normal.y * normal.y;
  const squareZ = normal.z * normal.z;
  const faceX = normal.x < 0 ? 1 : 0;
  const faceY = normal.y < 0 ? 3 : 2;
  const faceZ = normal.z < 0 ? 5 : 4;
  const { values } = field;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < 8; i += 1) {
    const w = cornerWeight[i] ?? 0;
    if (w === 0) continue;
    const probe = (cornerProbe[i] ?? 0) * 6;
    let at = (probe + faceX) * 3;
    r += w * squareX * (values[at] ?? 0);
    g += w * squareX * (values[at + 1] ?? 0);
    b += w * squareX * (values[at + 2] ?? 0);
    at = (probe + faceY) * 3;
    r += w * squareY * (values[at] ?? 0);
    g += w * squareY * (values[at + 1] ?? 0);
    b += w * squareY * (values[at + 2] ?? 0);
    at = (probe + faceZ) * 3;
    r += w * squareZ * (values[at] ?? 0);
    g += w * squareZ * (values[at + 1] ?? 0);
    b += w * squareZ * (values[at + 2] ?? 0);
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
}

/**
 * One pass of a spatial filter over the probes, as Lumen filters its probes: each face averages with the same face of
 * the six neighbours it links to (a clear segment, neither inside a solid), the probe itself counted twice. At 0.5 m
 * probes and 96 to 240 rays each, the ray noise read as half-metre blotches on a flat wall (judge round 10).
 */
function smooth(field: IField): Float32Array {
  const { grid, values, links, valid } = field;
  const out = new Float32Array(values.length);
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const dims = [grid.nx, grid.ny, grid.nz];
  const luminance = (probe: number, face: number) => {
    const o = (probe * 6 + face) * 3;
    return (
      0.2126 * (values[o] ?? 0) +
      0.7152 * (values[o + 1] ?? 0) +
      0.0722 * (values[o + 2] ?? 0) +
      1e-6
    );
  };
  const total = new Float64Array(6);
  for (let probe = 0; probe < valid.length; probe += 1) {
    const base = probe * 18;
    if (valid[probe] !== 1) {
      out.set(values.subarray(base, base + 18), base);
      continue;
    }
    total.fill(2);
    for (let j = 0; j < 18; j += 1) out[base + j] = 2 * (values[base + j] ?? 0);
    const at = [
      probe % grid.nx,
      Math.floor(probe / grid.nx) % grid.ny,
      Math.floor(probe / (grid.nx * grid.ny)),
    ];
    for (let a = 0; a < 3; a += 1)
      for (const step of [-1, 1]) {
        const to = (at[a] ?? 0) + step;
        if (to < 0 || to >= (dims[a] ?? 0)) continue;
        const other = probe + step * (stride[a] ?? 0);
        if (valid[other] !== 1 || links[Math.min(probe, other) * 3 + a] !== 1) continue;
        for (let f = 0; f < 6; f += 1) {
          // Edge-stopping: a neighbour that reads far brighter or darker is a different light, not noise.
          const ratio = Math.log(luminance(other, f) / luminance(probe, f)) / SMOOTH_EDGE;
          const w = Math.exp(-0.5 * ratio * ratio);
          total[f] = (total[f] ?? 0) + w;
          for (let c = 0; c < 3; c += 1)
            out[base + f * 3 + c] =
              (out[base + f * 3 + c] ?? 0) + w * (values[other * 18 + f * 3 + c] ?? 0);
        }
      }
    for (let j = 0; j < 18; j += 1)
      out[base + j] = (out[base + j] ?? 0) / (total[Math.floor(j / 3)] ?? 1);
  }
  return out;
}

/** The field at twice the resolution, every texel read across walls from the coarse probes. */
function* resample(
  field: IField,
  sees?: (point: Vector3, probe: number) => boolean,
): Generator<void, { grid: IGrid; values: Float32Array; sky: Float32Array }> {
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
    if (due()) yield* pause();
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
    weightsAt(field, point, sees === undefined ? undefined : (probe) => sees(point, probe));
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

const AXES = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
] as const;

/**
 * Runs the generator `work` with every material under `root` double-sided, then gives each its side back. The ray query
 * honours a material's side, so a single-sided solid is invisible from inside it: the solid test needs both sides.
 * The flat rays take the switch themselves; a game's `ctx.raycast` needs the materials flipped, which is only safe in
 * one call (a yield would draw the frame with them flipped), so a bake on `ctx.raycast` never slices.
 */
function* withDoubleSide<T>(
  ctx: IRayContext,
  root: Object3D,
  work: () => Generator<void, T>,
): Generator<void, T> {
  const flat = (ctx as Partial<IFlatRays>).doubleSided !== undefined;
  const sides = new Map<{ side: Side }, Side>();
  if (flat) (ctx as IFlatRays).doubleSided = true;
  else {
    root.traverse((object) => {
      const material = (object as Mesh).material;
      for (const m of Array.isArray(material) ? material : material === undefined ? [] : [material])
        sides.set(m, m.side);
    });
    for (const m of sides.keys()) m.side = DoubleSide;
  }
  try {
    return yield* work();
  } finally {
    if (flat) (ctx as IFlatRays).doubleSided = false;
    for (const [m, side] of sides) m.side = side;
  }
}

const solidNormal = new Vector3();
const solidDirection = new Vector3();
/**
 * True when `at` is inside a solid: most of six axis rays leave through a back face. Run it inside `withDoubleSide`.
 * The coarse trace cannot say this for a single-sided slab, which shows no back face under front-face culling.
 */
function insideSolid(ctx: IRayContext, root: Object3D, at: Vector3): boolean {
  let backfaces = 0;
  for (let a = 0; a < 6; a += 1) {
    const along = AXES[a % 3] as readonly [number, number, number];
    const sign = a < 3 ? 1 : -1;
    solidDirection.set(along[0] * sign, along[1] * sign, along[2] * sign);
    const hit = ctx.raycast({
      origin: at,
      direction: solidDirection,
      far: Number.POSITIVE_INFINITY,
      targets: root,
    });
    const face = hit?.face?.normal;
    if (hit === undefined || face === undefined || face === null) continue;
    solidNormal.copy(face).transformDirection(hit.object.matrixWorld);
    if (solidNormal.dot(solidDirection) > 0) backfaces += 1;
  }
  return backfaces > 6 * SOLID_SHARE;
}

/**
 * Per texel of the final grid, which of the links to its +x, +y and +z neighbours a wall cuts (bit 0, 1, 2).
 * The reader blends texels itself and drops the ones a wall separates, because a hardware blend across a wall
 * thinner than a texel (the 0.2 m roof) mixes the lit outside into the room. Most links lie inside open space
 * where the coarse probes already say so; only the ones near a blocked or solid probe get a ray.
 * A texel whose centre lies inside a solid (most of six axis rays leave through a back face, the coarse bake's own
 * test) is flagged: its value is an interpolation through the solid, and a floor beside a box that is not aligned
 * with the grid read it as its nearest texel, a hard-edged bright wedge along the box's foot.
 */
function* linkMasks(
  field: IField,
  fine: IGrid,
  ctx: IRayContext,
  root: Object3D,
): Generator<void, { masks: Uint8Array; solid: Uint8Array; rays: number }> {
  const { grid } = field;
  const masks = new Uint8Array(fine.nx * fine.ny * fine.nz);
  const solid = new Uint8Array(masks.length);
  const dims = [grid.nx, grid.ny, grid.nz];
  const stride = [1, grid.nx, grid.nx * grid.ny];
  const origin = new Vector3();
  const direction = new Vector3();
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
  const centre = (index: number) =>
    [
      fine.origin.x + ((index % fine.nx) + 0.5) * fine.cell,
      fine.origin.y + ((Math.floor(index / fine.nx) % fine.ny) + 0.5) * fine.cell,
      fine.origin.z + (Math.floor(index / (fine.nx * fine.ny)) + 0.5) * fine.cell,
    ] as const;
  // The link rays below run with each material's own side.
  yield* withDoubleSide(ctx, root, function* () {
    const at = new Vector3();
    for (let index = 0; index < masks.length; index += 1) {
      if (due()) yield* pause();
      at.set(...centre(index));
      if (!unsure(at.x, at.y, at.z)) continue;
      rays += 6;
      if (insideSolid(ctx, root, at)) solid[index] = 1;
    }
  });
  for (let index = 0; index < masks.length; index += 1) {
    if (due()) yield* pause();
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
      const along = AXES[a] as readonly [number, number, number];
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
  return { masks, solid, rays };
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

/**
 * Sky visibility is stored in 6 bits next to the 3-bit link mask, and the solid flag above them:
 * alpha = mask + 8 x round(63 x visibility) + 512 x solid (an integer below 2048, exact in a half float).
 */
const SKY_STEPS = 63;

function texelsOf(
  values: Float32Array,
  grid: IGrid,
  masks: Uint8Array,
  sky: Float32Array,
  solid: Uint8Array,
): Uint16Array {
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
        (masks[probe] ?? 0) +
          8 * Math.round(SKY_STEPS * Math.min(1, sky[probe * 6 + face] ?? 0)) +
          512 * (solid[probe] ?? 0),
      );
    }
  }
  return texels;
}

function volume(
  values: Float32Array,
  grid: IGrid,
  masks: Uint8Array,
  sky: Float32Array,
  solid: Uint8Array,
): Data3DTexture {
  const slices = grid.nz * 6;
  const texture = new Data3DTexture(
    texelsOf(values, grid, masks, sky, solid),
    grid.nx,
    grid.ny,
    slices,
  );
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
function irradianceAt(
  values: Float32Array,
  grid: IGrid,
  masks: Uint8Array,
  sky: Float32Array,
  solid: Uint8Array,
) {
  const cache = volume(values, grid, masks, sky, solid);
  const dims = [grid.nx, grid.ny, grid.nz] as const;
  /** Writes a finer bake into the texture the materials already read. */
  const refresh = (
    nextValues: Float32Array,
    nextMasks: Uint8Array,
    nextSky: Float32Array,
    nextSolid: Uint8Array,
  ): void => {
    (cache.image.data as Uint16Array).set(
      texelsOf(nextValues, grid, nextMasks, nextSky, nextSolid),
    );
    cache.needsUpdate = true;
  };
  const read = (
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
      .sub(vec3(grid.origin))
      .div(grid.cell);
    const [ax, ay, az] = [
      clamp(at.x, 0.5, grid.nx - 0.5).sub(0.5),
      clamp(at.y, 0.5, grid.ny - 0.5).sub(0.5),
      clamp(at.z, 0.5, grid.nz - 0.5).sub(0.5),
    ];
    const lower = [ax.floor(), ay.floor(), az.floor()];
    const fraction = [ax.sub(nth(lower, 0)), ay.sub(nth(lower, 1)), az.sub(nth(lower, 2))];
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

    type Taps = {
      colour: Node<"vec3">;
      mask: Node<"float">;
      sky: Node<"float">;
      solid: Node<"float">;
    };
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
      let solidFlag: Node<"float"> | undefined;
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
        // alpha = link mask + 8 x sky steps + 512 x solid (see `volume`).
        const inside = texel.a.add(0.25).div(512).floor();
        const rest = texel.a.sub(inside.mul(512));
        const steps = rest.add(0.25).div(8).floor();
        solidFlag ??= inside;
        mask ??= rest.sub(steps.mul(8));
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
        const alongRest = along.a.sub(along.a.add(0.25).div(512).floor().mul(512));
        const shareSteps = alongRest.add(0.25).div(8).floor();
        const share = shareSteps.div(SKY_STEPS).mul(nth(squaresR, axis));
        visible = visible === undefined ? share : visible.add(share);
      }
      const result = {
        colour: colour as Node<"vec3">,
        mask: mask as Node<"float">,
        sky: visible as Node<"float">,
        solid: solidFlag as Node<"float">,
      };
      taps.set(corner, result);
      return result;
    };
    /** 1 when the link along `axis` from texel `corner` (its lower end) is open; each read once. */
    const links = new Map<number, Node<"float">>();
    const link = (corner: number, axis: number): Node<"float"> => {
      const known = links.get(corner * 3 + axis);
      if (known !== undefined) return known;
      const whole = tap(corner)
        .mask.add(0.25)
        .div(2 ** axis)
        .floor();
      const open = whole.sub(whole.div(2).floor().mul(2)).lessThan(0.5).select(float(1), float(0));
      links.set(corner * 3 + axis, open);
      return open;
    };
    /** Trilinear weight of a corner; a solid texel holds an interpolation through the solid, so next to none. */
    const weightOf = (corner: number): Node<"float"> =>
      [0, 1, 2].reduce<Node<"float">>(
        (w, a) => w.mul((corner >> a) & 1 ? nth(fraction, a) : float(1).sub(nth(fraction, a))),
        float(1).sub(tap(corner).solid.mul(0.999)),
      );

    // Every texel starts a walk, the one `weightsAt` takes at bake time from its strongest probe: a corner counts when
    // the links from the start to it, axis by axis, are open. The walks blend by the start's weight to the fourth
    // power, so the read stays continuous where the strongest texel changes: one start alone left a hard seam on an
    // open floor wherever a wall cut the link between the two texels either side of a cell's middle.
    let sum: Node<"vec3"> | undefined;
    let skySum: Node<"float"> | undefined;
    let total: Node<"float"> | undefined;
    for (let start = 0; start < 8; start += 1) {
      let walkSum: Node<"vec3"> | undefined;
      let walkSky: Node<"float"> | undefined;
      let walkTotal: Node<"float"> | undefined;
      for (let corner = 0; corner < 8; corner += 1) {
        let weight = weightOf(corner);
        for (let a = 0; a < 3; a += 1) {
          if (((corner >> a) & 1) === ((start >> a) & 1)) continue;
          // The step along a: earlier axes already moved to this corner, later ones not yet; the link is the lower texel's.
          const lower = [0, 1, 2].reduce(
            (index, k) =>
              index | ((k < a ? (corner >> k) & 1 : k === a ? 0 : (start >> k) & 1) << k),
            0,
          );
          weight = weight.mul(link(lower, a));
        }
        const t = tap(corner);
        walkSum = walkSum === undefined ? t.colour.mul(weight) : walkSum.add(t.colour.mul(weight));
        walkSky = walkSky === undefined ? t.sky.mul(weight) : walkSky.add(t.sky.mul(weight));
        walkTotal = walkTotal === undefined ? weight : walkTotal.add(weight);
      }
      const own = weightOf(start);
      const share = own
        .mul(own)
        .mul(own)
        .mul(own)
        .div(max(walkTotal as Node<"float">, 1e-20));
      sum =
        sum === undefined
          ? (walkSum as Node<"vec3">).mul(share)
          : sum.add((walkSum as Node<"vec3">).mul(share));
      skySum =
        skySum === undefined
          ? (walkSky as Node<"float">).mul(share)
          : skySum.add((walkSky as Node<"float">).mul(share));
      const pow4 = own.mul(own).mul(own).mul(own);
      total = total === undefined ? pow4 : total.add(pow4);
    }
    const whole = max(total as Node<"float">, 1e-30);
    return {
      irradiance: (sum as Node<"vec3">).div(whole),
      visibility: (skySum as Node<"float">).div(whole),
    };
  };
  return { read, refresh, texture: cache };
}

/**
 * The cache's read, registered when the bake finishes: a screen-space gather asks it what a ray that finds
 * nothing on screen would have returned (the tier below its own), with the pixel's world position and normal.
 */
export const giCache: {
  irradiance?: (position: Node<"vec3">, normal: Node<"vec3">) => Node<"vec3">;
  /**
   * The baked field at its final resolution, for tools and tests: per texel, six faces of RGB (E / pi), six
   * environment shares, and whether the texel's centre lies inside a solid (a read gives it no weight).
   */
  field?: { grid: IGrid; values: Float32Array; sky: Float32Array; solid: Uint8Array };
  /** The texture the materials read, for tools and tests; a progressive bake rewrites its data in place. */
  texture?: Data3DTexture;
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

/**
 * What the bake reads of a mesh its rays land on, taken once: a bake meets a few hundred meshes a million times, and on the
 * owned engine each field of an object (its id, its matrix) is a call into the engine.
 */
interface IHitRecord {
  readonly id: number;
  /** The world matrix as plain numbers (it does not change during a bake). */
  readonly matrix: readonly number[];
  readonly data: { albedo: number[]; emissive: number[] };
  /** The mesh's slot in the Surface Cache, when it has one. */
  readonly slot: number | undefined;
  readonly emitter: boolean;
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
  baseRays: number,
): [number, number, number] | undefined {
  const sum = [0, 0, 0];
  const cached = [0, 0, 0];
  const point = new Vector3();
  const normal = new Vector3();
  let count = 0;
  for (let probe = 0; probe < first.length; probe += 1) {
    if ((end[probe] ?? 0) - (first[probe] ?? 0) !== baseRays) continue;
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
 * reads it. Returns what it did, or undefined when there is no light at all: no sky (no OffscreenCanvas), no sun
 * and no local light. Without a sky, rays that miss carry zero.
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

/** A bake's quality: the rays per probe, the extra rays an enclosed probe adds, and the bounces that carry light. */
interface IBakeParams {
  readonly baseRays: number;
  readonly extraRays: number;
  readonly bounces: number;
}

/** What a bake leaves for the material pass: the final grid with its masks, and the counts the report needs. */
interface IBaked {
  readonly fine: { grid: IGrid; values: Float32Array; sky: Float32Array };
  readonly cut: { masks: Uint8Array; solid: Uint8Array; rays: number };
  readonly floor: [number, number, number] | undefined;
  readonly emitters: Parameters<typeof emitterLight>[0];
  readonly enclosedProbes: number;
  readonly traced: number;
  readonly shadowRays: number;
  readonly phases: Record<string, number>;
}

/** What three's own `fromMaterial` copies, and the engine's identity: never carried to the twin. */
const NOT_COPIED = /^(?:is[A-Z]|_)|^(?:constructor|id|uuid|version|type)$/;

/**
 * Every settable field of the source that the twin declares, copied as three's `fromMaterial` copies it, so the maps, the
 * cut-out, the sides and the blending carry over. three holds a field as an own property and the native engine as an accessor
 * on the class, which `for in` never lists, so the fields are found by walking the prototype chain's descriptors.
 */
function copyFields(source: object, twin: Record<string, unknown>): void {
  for (
    let at: object | null = source;
    at !== null && at !== Object.prototype;
    at = Object.getPrototypeOf(at)
  )
    for (const [key, field] of Object.entries(Object.getOwnPropertyDescriptors(at))) {
      if (NOT_COPIED.test(key) || !(key in twin) || (field.set ? !field.get : !field.writable))
        continue;
      const value = (source as Record<string, unknown>)[key];
      if (value !== undefined && typeof value !== "function") twin[key] = value;
    }
}

/**
 * The node material a source material becomes when the cache lights it, as three's `fromMaterial` makes it: the class that
 * matches the source type (a node material keeps its class) with the source's fields copied over.
 */
function nodeTwin(source: MeshStandardMaterial): MeshStandardMaterial {
  if ((source as { isNodeMaterial?: boolean }).isNodeMaterial) return source;
  const twin = (source.type === "MeshPhysicalMaterial"
    ? physicalTwin()
    : new MeshStandardNodeMaterial()) as unknown as Record<string, unknown>;
  copyFields(source, twin);
  // three declares no `twoSidedFoliage`, so a three twin has no such key to copy into: carry the marker by name (PRD-651).
  if ((source as { twoSidedFoliage?: boolean }).twoSidedFoliage === true)
    twin.twoSidedFoliage = true;
  return twin as unknown as MeshStandardMaterial;
}

/** The native engine has no physical node class yet (core-webgpu.mjs refuses it): it lights a physical source as a standard one. */
function physicalTwin() {
  try {
    return new MeshPhysicalNodeMaterial();
  } catch {
    return new MeshStandardNodeMaterial();
  }
}

export function installGi(
  gameCtx: IRayContext,
  root: Object3D,
  options: IGiOptions,
): IGiReport | undefined {
  const lights = options.lights ?? [];
  const sun = options.sun;
  if (skyRadiance.current === undefined && sun === undefined && lights.length === 0)
    return undefined;
  const baked = skyRadiance.current ?? {
    data: new Float32Array(3),
    width: 1,
    height: 1,
    scale: [1, 1, 1],
  };
  const skyGain = options.skyIntensity ?? 1;
  const sky = {
    ...baked,
    scale: baked.scale.map((c) => c * skyGain) as [number, number, number],
  };
  const started = performance.now();
  // The bake's own ray query; `stockRays` keeps the game's `ctx.raycast` for an A/B.
  const flat = options.stockRays === true ? undefined : bakeRays(root);
  const ctx: IRayContext = flat ?? gameCtx;
  root.updateMatrixWorld(true);
  const grid = gridOver(root);
  const far = Math.hypot(grid.nx, grid.ny, grid.nz) * grid.cell;
  const probes = grid.nx * grid.ny * grid.nz;

  const full: IBakeParams = {
    baseRays: BASE_RAYS,
    extraRays: EXTRA_RAYS,
    bounces: options.bounces,
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
    if (radius > Math.max(1, grid.cell)) return;
    emitters.push({
      centre: bound.center.clone().applyMatrix4(mesh.matrixWorld),
      radius,
      radiance,
      id: mesh.id,
    });
  });

  /**
   * What the bake reads of each mesh's material (albedo, emission), taken now. The cache swaps a material for its node
   * twin before a progressive bake runs, and the light must not depend on what a twin holds: a twin that lost its colour
   * made the room 4 times too bright. `installMaterials` runs after this.
   */
  const emitterIds = new Set(emitters.map((e) => e.id));
  const surfaces = new Map<number, { albedo: number[]; emissive: number[] }>();
  const surfaceOf = (object: Object3D): { albedo: number[]; emissive: number[] } => {
    const known = surfaces.get(object.id);
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
    surfaces.set(object.id, data);
    return data;
  };
  root.traverse((object) => {
    const material = (object as Mesh).material as Partial<MeshStandardMaterial> | undefined;
    if ((object as { isMesh?: boolean }).isMesh && material?.color && material.emissive)
      surfaceOf(object);
  });

  // The Surface Cache reads a map where a ray lands; a material without one returns the numbers `surfaceOf` does. The
  // slots are taken now, per object, like `surfaceOf`: a progressive bake runs after the cache swapped each material
  // for its node twin, and a lookup by the object's current material would miss.
  const slotOf = new Map<number, number>();
  const cacheMaterials: Material[] = [];
  if (options.surfaceCache) {
    const slotOfMaterial = new Map<Material, number>();
    root.traverse((object) => {
      const mesh = object as Mesh;
      const material = mesh.material;
      if (!(mesh as { isMesh?: boolean }).isMesh || Array.isArray(material)) return;
      let slot = slotOfMaterial.get(material);
      if (slot === undefined) {
        slot = cacheMaterials.length;
        slotOfMaterial.set(material, slot);
        cacheMaterials.push(material);
      }
      slotOf.set(object.id, slot);
    });
  }
  const surfaceCache =
    options.surfaceCache && cacheMaterials.length > 0
      ? SurfaceCache.from(
          cacheMaterials as never,
          options.surfaceCache === true ? {} : options.surfaceCache,
        )
      : undefined;
  const sampled = { albedo: [0, 0, 0], emissive: [0, 0, 0] };
  /** The albedo and emission a ray that landed on `record` at (u, v) returns; `hasUv` is false for a hit without a UV. */
  const dataAt = (
    record: IHitRecord,
    hasUv: boolean,
    u: number,
    v: number,
  ): { albedo: number[]; emissive: number[] } => {
    if (surfaceCache === undefined || !hasUv || record.slot === undefined) return record.data;
    surfaceCache.albedo(record.slot, u, v, sampled.albedo);
    // An emitter small enough for `emitterLight` carries no emission of its own in the rays.
    if (record.emitter) sampled.emissive.fill(0);
    else surfaceCache.emissive(record.slot, u, v, sampled.emissive);
    return sampled;
  };

  /** One bake at the given quality. It yields only when `slice.deadline` has passed. */
  function* bake(params: IBakeParams): Generator<void, IBaked> {
    const phases: Record<string, number> = {};
    let phaseStart = performance.now();
    let phaseIdle = slice.idle;
    const phase = (name: string): void => {
      const now = performance.now();
      phases[name] = Math.round(now - phaseStart - (slice.idle - phaseIdle));
      phaseStart = now;
      phaseIdle = slice.idle;
    };

    const capacity = probes * params.baseRays + MAX_ENCLOSED * params.extraRays;
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
        ([sun?.color.r, sun?.color.g, sun?.color.b][c] ?? 0) * ((sun?.intensity ?? 0) / Math.PI),
    );
    /** Per surface cell, the shadow rays' answers: [sun, ...lights], 1 when lit. */
    const shaded = new Map<string, number[]>();
    let shadowRays = 0;
    let traced = 0;
    const origin = new Vector3();
    const direction = new Vector3();
    const [sunX, sunY, sunZ] = [
      sun?.direction.x ?? 0,
      sun?.direction.y ?? 0,
      sun?.direction.z ?? 0,
    ];
    const toLight = new Vector3();
    const colour = [0, 0, 0];

    /**
     * What a surface point returns of the sun and the point lights (albedo x light x cos x visibility) plus its emission.
     * Only the visibility is shared by a 0.5 m surface cell (a shadow ray each); the cosine and the inverse square are
     * the point's own. Sharing the whole result let one sample stand for its cell: the cornell shade, 0.3 m above its
     * lamp, ranges 100 to 13 across a cell, and a sample near the hot spot lit the floor below it 1.8 times too bright.
     */
    const surface = (
      id: number,
      [px, py, pz]: readonly [number, number, number],
      [nx, ny, nz]: readonly [number, number, number],
      albedo: number[],
      emissive: number[],
    ): number[] => {
      const key = `${id}|${Math.floor(px / SHADE_CELL)}|${Math.floor(py / SHADE_CELL)}|${Math.floor(pz / SHADE_CELL)}|${Math.round(nx)}${Math.round(ny)}${Math.round(nz)}`;
      let visible = shaded.get(key);
      origin.set(px + nx * 0.02, py + ny * 0.02, pz + nz * 0.02);
      if (visible === undefined) {
        visible = [0];
        if (sun !== undefined && nx * sunX + ny * sunY + nz * sunZ > 0) {
          shadowRays += 1;
          visible[0] =
            ctx.raycast({ origin, direction: sun.direction, far, targets: root }) === undefined
              ? 1
              : 0;
        }
        for (const light of lights) {
          toLight.subVectors(light.position, origin);
          const d = toLight.length();
          toLight.divideScalar(d);
          let open = 0;
          if (d >= 0.02 && nx * toLight.x + ny * toLight.y + nz * toLight.z > 0) {
            shadowRays += 1;
            open =
              ctx.raycast({ origin, direction: toLight, far: d - 0.02, targets: root }) ===
              undefined
                ? 1
                : 0;
          }
          visible.push(open);
        }
        shaded.set(key, visible);
      }
      const cosine = Math.max(0, nx * sunX + ny * sunY + nz * sunZ);
      const lit = [0, 1, 2].map(
        (c) =>
          (albedo[c] ?? 0) * (sunRadiance[c] ?? 0) * cosine * (visible[0] ?? 0) +
          (emissive[c] ?? 0),
      );
      lights.forEach((light, l) => {
        if (visible[l + 1] !== 1) return;
        toLight.subVectors(light.position, origin);
        const d = toLight.length();
        toLight.divideScalar(d);
        const cos = Math.max(0, nx * toLight.x + ny * toLight.y + nz * toLight.z);
        // three's getDistanceAttenuation: inverse square times a window that closes at the cutoff distance.
        const window =
          light.distance > 0 ? Math.min(1, Math.max(0, 1 - (d / light.distance) ** 4)) ** 2 : 1;
        if (cos <= 0 || window <= 0 || d < 0.02) return;
        const scale = (light.intensity / Math.PI / (d * d)) * window * cos;
        const tint = [light.color.r, light.color.g, light.color.b];
        for (let c = 0; c < 3; c += 1)
          lit[c] = (lit[c] ?? 0) + (albedo[c] ?? 0) * (tint[c] ?? 0) * scale;
      });
      return lit;
    };

    const centreOf = (probe: number, into: Vector3): Vector3 =>
      into.set(
        grid.origin.x + ((probe % grid.nx) + 0.5) * grid.cell,
        grid.origin.y + ((Math.floor(probe / grid.nx) % grid.ny) + 0.5) * grid.cell,
        grid.origin.z + (Math.floor(probe / (grid.nx * grid.ny)) + 0.5) * grid.cell,
      );

    /** Each mesh the rays land on, read once. The flat rays name a mesh by its index; a game's own rays by its object. */
    const records = new Map<number, IHitRecord>();
    const recordOf = (object: Object3D): IHitRecord => {
      const id = object.id;
      let known = records.get(id);
      if (known === undefined) {
        known = {
          id,
          matrix: [...object.matrixWorld.elements],
          data: surfaceOf(object),
          slot: slotOf.get(id),
          emitter: emitterIds.has(id),
        };
        records.set(id, known);
      }
      return known;
    };
    const recordsByOwner: (IHitRecord | undefined)[] = [];
    const hitAt: [number, number, number] = [0, 0, 0];
    const hitNormal: [number, number, number] = [0, 0, 0];

    /**
     * Traces a block of rays from a probe and stores what they find. Returns how many hit within ENCLOSED_DISTANCE.
     * `skies` is the sky radiance along each direction of the block (the same for every probe, so it is read once).
     */
    const trace = (
      probe: number,
      centre: Vector3,
      directions: Float64Array,
      skies: Float64Array,
    ): number => {
      let near = 0;
      const ox = centre.x;
      const oy = centre.y;
      const oz = centre.z;
      for (let k = 0; k < directions.length; k += 3) {
        const dx = directions[k] ?? 0;
        const dy = directions[k + 1] ?? 0;
        const dz = directions[k + 2] ?? 0;
        const i = used;
        used += 1;
        traced += 1;
        const at = i * 3;
        ray.direction[at] = dx;
        ray.direction[at + 1] = dy;
        ray.direction[at + 2] = dz;
        // What the ray found, whichever query answered it. The flat rays answer in plain numbers; a game's own
        // `ctx.raycast` answers with vector objects, and each field of one is a call into the engine.
        let found = false;
        let distance = 0;
        let hasFace = false;
        let fx = dx;
        let fy = dy;
        let fz = dz;
        let hasUv = false;
        let u = 0;
        let v = 0;
        let record: IHitRecord | undefined;
        if (flat !== undefined) {
          found = flat.cast(ox, oy, oz, dx, dy, dz, far);
          if (found) {
            const result = flat.result;
            distance = result.distance;
            hitAt[0] = result.x;
            hitAt[1] = result.y;
            hitAt[2] = result.z;
            hasFace = true;
            fx = result.nx;
            fy = result.ny;
            fz = result.nz;
            hasUv = true;
            u = result.u;
            v = result.v;
            record = recordsByOwner[result.owner];
            if (record === undefined) {
              record = recordOf(flat.objects[result.owner] as Object3D);
              recordsByOwner[result.owner] = record;
            }
          }
        } else {
          direction.set(dx, dy, dz);
          const hit = ctx.raycast({ origin: centre, direction, far, targets: root });
          if (hit !== undefined) {
            found = true;
            distance = hit.distance;
            hitAt[0] = hit.point.x;
            hitAt[1] = hit.point.y;
            hitAt[2] = hit.point.z;
            const face = hit.face?.normal;
            if (face !== undefined && face !== null) {
              hasFace = true;
              fx = face.x;
              fy = face.y;
              fz = face.z;
            }
            hasUv = hit.uv !== undefined;
            if (hit.uv !== undefined) {
              u = hit.uv.x;
              v = hit.uv.y;
            }
            record = recordOf(hit.object);
          }
        }
        const skyR = skies[k] ?? 0;
        const skyG = skies[k + 1] ?? 0;
        const skyB = skies[k + 2] ?? 0;
        ray.sky[at] = skyR;
        ray.sky[at + 1] = skyG;
        ray.sky[at + 2] = skyB;
        if (!found || record === undefined) {
          ray.base[at] = skyR;
          ray.base[at + 1] = skyG;
          ray.base[at + 2] = skyB;
          continue;
        }
        ray.hit[i] = 1;
        ray.distance[i] = distance;
        if (distance < ENCLOSED_DISTANCE) near += 1;
        const m = record.matrix;
        // transformDirection: the upper 3x3 of the world matrix, normalised.
        let nx = (m[0] ?? 0) * fx + (m[4] ?? 0) * fy + (m[8] ?? 0) * fz;
        let ny = (m[1] ?? 0) * fx + (m[5] ?? 0) * fy + (m[9] ?? 0) * fz;
        let nz = (m[2] ?? 0) * fx + (m[6] ?? 0) * fy + (m[10] ?? 0) * fz;
        const length = Math.hypot(nx, ny, nz) || 1;
        nx /= length;
        ny /= length;
        nz /= length;
        if (nx * dx + ny * dy + nz * dz > 0) {
          nx = -nx;
          ny = -ny;
          nz = -nz;
          if (hasFace) backfaces[probe] = (backfaces[probe] ?? 0) + 1;
        }
        hitNormal[0] = nx;
        hitNormal[1] = ny;
        hitNormal[2] = nz;
        const { albedo, emissive } = dataAt(record, hasUv, u, v);
        // A bake without bounces keeps no surface light: `base` stays at its zeros.
        if (params.bounces > 0) {
          const lit = surface(record.id, hitAt, hitNormal, albedo, emissive);
          ray.base[at] = lit[0] ?? 0;
          ray.base[at + 1] = lit[1] ?? 0;
          ray.base[at + 2] = lit[2] ?? 0;
        }
        ray.albedo[at] = albedo[0] ?? 0;
        ray.albedo[at + 1] = albedo[1] ?? 0;
        ray.albedo[at + 2] = albedo[2] ?? 0;
        ray.point[at] = hitAt[0];
        ray.point[at + 1] = hitAt[1];
        ray.point[at + 2] = hitAt[2];
        ray.normal[at] = nx;
        ray.normal[at + 1] = ny;
        ray.normal[at + 2] = nz;
      }
      return near;
    };

    const centre = new Vector3();
    let enclosedProbes = 0;
    // Every probe shoots the same ray set. Rays that differ per probe put an independent sampling error in each
    // probe, and a flat wall read through them shows it as a patchwork a probe cell wide; the same set makes
    // neighbours err alike, so the error varies smoothly (Lumen's probes share one importance-sampled set too).
    const next = random(1);
    const baseRays = sphereRays(params.baseRays, next);
    const extraRays = sphereRays(params.extraRays, next);
    /** The sky radiance along each direction of a block: it does not depend on the probe. */
    const skiesOf = (directions: Float64Array): Float64Array => {
      const out = new Float64Array(directions.length);
      for (let k = 0; k < directions.length; k += 3) {
        skyAt(sky, directions[k] ?? 0, directions[k + 1] ?? 0, directions[k + 2] ?? 0, colour);
        out[k] = colour[0] ?? 0;
        out[k + 1] = colour[1] ?? 0;
        out[k + 2] = colour[2] ?? 0;
      }
      return out;
    };
    const baseSkies = skiesOf(baseRays);
    const extraSkies = skiesOf(extraRays);
    for (let probe = 0; probe < probes; probe += 1) {
      if (due()) yield* pause();
      centreOf(probe, centre);
      first[probe] = used;
      const near = trace(probe, centre, baseRays, baseSkies);
      if (
        params.extraRays > 0 &&
        near > params.baseRays * ENCLOSED_SHARE &&
        enclosedProbes < MAX_ENCLOSED
      ) {
        enclosedProbes += 1;
        trace(probe, centre, extraRays, extraSkies);
      }
      end[probe] = used;
    }

    phase("trace");
    // Which probes see which: one ray along each positive axis to the neighbour, and whether a probe is inside a solid.
    const links = new Uint8Array(probes * 3);
    const valid = new Uint8Array(probes).fill(1);
    const axis = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
    const dims = [grid.nx, grid.ny, grid.nz];
    // The trace culls by material side, so a probe inside a single-sided slab (a 0.2 m wall) meets no back face
    // there and would stay valid, carrying the lit outside into every texel read beside the wall.
    yield* withDoubleSide(ctx, root, function* () {
      const inside = new Vector3();
      for (let probe = 0; probe < probes; probe += 1) {
        if (due()) yield* pause();
        if ((backfaces[probe] ?? 0) > ((end[probe] ?? 0) - (first[probe] ?? 0)) * SOLID_SHARE) {
          valid[probe] = 0;
          continue;
        }
        traced += 6;
        if (insideSolid(ctx, root, centreOf(probe, inside))) valid[probe] = 0;
      }
    });
    for (let probe = 0; probe < probes; probe += 1) {
      if (due()) yield* pause();
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

    phase("links");
    /**
     * Per probe, six faces of RGB: what the emitters add, E / pi = L (r / d)^2 max(0, n.l) for a sphere that is
     * wholly above the face's horizon, seen through one ray to its centre.
     */
    const emitted = new Float32Array(probes * 18);
    const toward = new Vector3();
    for (let probe = 0; probe < probes && emitters.length > 0; probe += 1) {
      if (due()) yield* pause();
      centreOf(probe, centre);
      if (valid[probe] !== 1) continue;
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

    phase("emitters");
    // Gather: each pass sums what the rays carry into six faces per probe.
    const shadowing = options.skyShadowDistance !== undefined;
    /** Per probe and face, the share of the cosine-weighted rays that leave the scene (see `IField.sky`). */
    const skyShare = new Float32Array(probes * 6);
    const gather = function* (previous: IField | undefined): Generator<void, Float32Array> {
      const point = new Vector3();
      const normal = new Vector3();
      const out = new Float32Array(probes * 18);
      const cached = [0, 0, 0];
      const sum = new Float32Array(18);
      const open = new Float32Array(6);
      const weight = new Float32Array(6);
      const sees = new Float32Array(6);
      for (let probe = 0; probe < probes; probe += 1) {
        if (due()) yield* pause();
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
          let [r, g, b] = [
            ray.base[i * 3] ?? 0,
            ray.base[i * 3 + 1] ?? 0,
            ray.base[i * 3 + 2] ?? 0,
          ];
          const free =
            ray.hit[i] === 0 || (ray.distance[i] ?? 0) > (options.skyShadowDistance ?? 0);
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
          // A ray adds to the face on each axis it points along (+x, -x, +y, -y, +z, -z), by that component.
          for (let a = 0; a < 3; a += 1) {
            const d = a === 0 ? dx : a === 1 ? dy : dz;
            if (d === 0) continue;
            const f = d > 0 ? a * 2 : a * 2 + 1;
            const w = d > 0 ? d : -d;
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
    let values = yield* gather(undefined);
    for (let pass = 1; pass < params.bounces; pass += 1)
      values = yield* gather({ grid, values, links, valid });
    // The bounces above carry the emitters' light; what a surface reads directly from them is exact per pixel (see
    // `emitterLight`), because a 0.5 m cell cannot hold a glow that falls off within 0.3 m of the source.
    for (let i = 0; i < values.length; i += 1) values[i] = (values[i] ?? 0) - (emitted[i] ?? 0);
    phase("gather");
    for (let pass = 0; pass < SMOOTH_PASSES; pass += 1) {
      if (due()) yield* pause();
      values = smooth({ grid, values, links, valid });
    }
    phase("smooth");

    const floor =
      params.bounces > 0
        ? groundRadiance(
            { grid, values, links, valid },
            ray,
            first,
            end,
            grid.origin.y,
            params.baseRays,
          )
        : undefined;
    const environment = environmentShare(grid, ray, first, end, skyShare);
    const toProbe = new Vector3();
    const fine = yield* resample(
      { grid, values, links, valid, sky: environment },
      (point, probe) => {
        toProbe.set(
          grid.origin.x + ((probe % grid.nx) + 0.5) * grid.cell,
          grid.origin.y + ((Math.floor(probe / grid.nx) % grid.ny) + 0.5) * grid.cell,
          grid.origin.z + (Math.floor(probe / (grid.nx * grid.ny)) + 0.5) * grid.cell,
        );
        toProbe.sub(point);
        const d = toProbe.length();
        traced += 1;
        return (
          d < 1e-4 ||
          ctx.raycast({
            origin: point,
            direction: toProbe.divideScalar(d),
            far: d,
            targets: root,
          }) === undefined
        );
      },
    );
    phase("resample");
    const cut = yield* linkMasks({ grid, values, links, valid }, fine.grid, ctx, root);
    phase("linkMasks");
    traced += cut.rays;
    return { fine, cut, floor, emitters, enclosedProbes, traced, shadowRays, phases };
  }

  /** Gives the materials the cache's read, once; a finer bake later rewrites the texture they already read. */
  const install = (read: ReturnType<typeof irradianceAt>["read"], emitters: IBaked["emitters"]) => {
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
    const twins = new Map<MeshStandardMaterial, MeshStandardMaterial>();
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!(mesh as { isMesh?: boolean }).isMesh) return;
      const source = mesh.material as MeshStandardMaterial;
      // Meshes that share a material keep sharing its twin. The twin keeps the maps, or a textured wall bakes its
      // texel and then draws its colour factor (PRD-639).
      let material = twins.get(source);
      if (material === undefined) {
        const { node, visibility } = readFor(source.roughness);
        material = nodeTwin(source);
        (material as unknown as { irradianceNode: unknown }).irradianceNode = node;
        (material as unknown as { aoNode: unknown }).aoNode = visibility;
        twins.set(source, material);
      }
      mesh.material = material;
    });
  };

  let reader: ReturnType<typeof irradianceAt> | undefined;
  const slicing = { count: 0, longestMs: 0 };
  const publish = (baked: IBaked, pass: "preview" | "final", bounces: number): IGiReport => {
    const publishStart = performance.now();
    const { fine, cut } = baked;
    if (baked.floor !== undefined) paintGround(root, baked.floor);
    giCache.field = { grid: fine.grid, values: fine.values, sky: fine.sky, solid: cut.solid };
    if (reader === undefined) {
      reader = irradianceAt(fine.values, fine.grid, cut.masks, fine.sky, cut.solid);
      giCache.texture = reader.texture;
      install(reader.read, baked.emitters);
    } else reader.refresh(fine.values, cut.masks, fine.sky, cut.solid);
    const report: IGiReport = {
      cell: grid.cell,
      points: probes,
      enclosed: baked.enclosedProbes,
      rays: baked.traced,
      solid: cut.solid.reduce((n, v) => n + v, 0),
      shadowRays: baked.shadowRays,
      bounces,
      milliseconds: Math.round(Object.values(baked.phases).reduce((n, v) => n + v, 0)),
      phases: baked.phases,
      pass,
      ...(surfaceCache === undefined ? {} : { surfaceCache: surfaceCache.report }),
      ...(slicing.count === 0
        ? {}
        : {
            slices: {
              count: slicing.count,
              longestMs: Math.round(slicing.longestMs),
              publishMs: Math.round(performance.now() - publishStart),
            },
          }),
    };
    console.info(`TN_GI_CACHE ${JSON.stringify(report)}`);
    if (surfaceCache !== undefined && pass === "final")
      console.info(`TN_SURFACE_CACHE ${JSON.stringify(surfaceCache.report)}`);
    return report;
  };

  /** Runs a bake to its end in this call: with no deadline it never yields. */
  const finish = <T>(bakeRun: Generator<void, T>): T => {
    slice.deadline = Number.POSITIVE_INFINITY;
    let step = bakeRun.next();
    while (!step.done) step = bakeRun.next();
    return step.value;
  };
  const progressive = options.progressive;
  // Time slicing flips materials to double-sided only on the flat rays, so it needs them.
  if (progressive === undefined || flat === undefined)
    return publish(finish(bake(full)), "final", full.bounces);
  const previewParams = {
    baseRays: progressive.previewRays,
    extraRays: 0,
    bounces: Math.min(progressive.previewBounces ?? 2, full.bounces),
  };
  // The materials are installed now, over a black cache of the final size, so the first frame draws at once and
  // the graph never changes: each bake below rewrites the texture they already read.
  const fineGrid: IGrid = {
    origin: grid.origin,
    cell: grid.cell / 2,
    nx: grid.nx * 2,
    ny: grid.ny * 2,
    nz: grid.nz * 2,
  };
  const texels = fineGrid.nx * fineGrid.ny * fineGrid.nz;
  reader = irradianceAt(
    new Float32Array(texels * 18),
    fineGrid,
    new Uint8Array(texels),
    new Float32Array(texels * 6),
    new Uint8Array(texels),
  );
  giCache.texture = reader.texture;
  install(reader.read, emitters);
  // Paced by the clock, not by frames: a page that presents one frame a second (a slow present path, a busy
  // compositor) must not stretch the bake to hundreds of seconds. A slice is short (`budgetMs`), so a frame or an input
  // that is due waits for one slice at most, and the idle time the frames leave goes to the bake.
  const defer = progressive.defer ?? hostDefer();
  const gapMs = progressive.gapMs ?? 0;
  /** Runs a bake in slices of `budgetMs` (no task is held longer), then hands the result on. */
  const spread = <T>(run: Generator<void, T>, budgetMs: number, done: (value: T) => void): void => {
    const step = (): void => {
      const at = performance.now();
      slice.deadline = at + budgetMs;
      const next = run.next();
      slice.deadline = Number.POSITIVE_INFINITY;
      slicing.count += 1;
      slicing.longestMs = Math.max(slicing.longestMs, performance.now() - at);
      if (next.done) done(next.value);
      else defer(step, gapMs);
    };
    // After the first frame, not before it.
    defer(step, 0);
  };
  // The preview takes the frames twice as hungrily: the sooner it lands, the sooner the room is lit.
  spread(bake(previewParams), progressive.budgetMs * 2, (baked) => {
    publish(baked, "preview", previewParams.bounces);
    spread(bake(full), progressive.budgetMs, (final) => {
      // Published whether or not anyone listens: an optional call would skip its argument too.
      const report = publish(final, "final", full.bounces);
      progressive.onConverged?.(report);
    });
  });
  return {
    cell: grid.cell,
    points: probes,
    enclosed: 0,
    rays: 0,
    shadowRays: 0,
    solid: 0,
    bounces: 0,
    milliseconds: Math.round(performance.now() - started),
    phases: {},
    pass: "pending",
  };
}
