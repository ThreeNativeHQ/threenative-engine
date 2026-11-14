// PRD-668 Phase 1: the price of displaced, diced triangles, counted before a dice pass exists.
// Read-only. It walks what the scene already submits and counts the patches and micro-triangles
// Unreal's Nanite tessellation would dice them into. It draws nothing and decides no look.
//
// Clean-room port of the rules, not the code (UE 5.8.3):
// - dice rate 2 px: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteCullRaster.cpp:147-152`
// - edge factor = edge length / max(nearer depth, near) * view-to-pixels / dice rate, a quarter past
//   the fade distance: `Engine/Shaders/Private/Nanite/NaniteTessellation.ush:62-101`, with
//   LODScale * InvDiceRate = ViewToPixels / DicingRate (`NaniteShared.cpp:197-199`,
//   `NaniteCullRaster.cpp:6993`), ViewToPixels = 0.5 * ViewToClip[1][1] * view height
// - fade distance: `NaniteTessellation.ush:49-59`; the fade-out size is min(start 4, end 1) px when
//   the material enables the fade and 0 (no fade) when it does not
//   (`Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:774-791`)
// - magnitude 4 cm about a 0.5 center, range (0 - c) * m to (1 - c) * m:
//   `Engine/Source/Runtime/Engine/Classes/Engine/EngineTypes.h:3446-3458`, `NaniteResources.cpp:792-793`
// - table of factors 1 to 14 and a split past it at TF / 14, capped at 8, ceil and clamp, each child
//   culled and priced from its own points:
//   `Engine/Shaders/Shared/NaniteDefinitions.h:125-128`, `NaniteTessellation.ush:103-106,141-144`,
//   `Engine/Shaders/Private/Nanite/NaniteSplit.usf:117-258`
// - a uniform pattern of factor n holds n * n triangles:
//   `Engine/Source/Runtime/Renderer/Private/Nanite/TessellationTable.cpp:233-236`
import type { BufferAttribute, InstancedMesh, Mesh, Object3D, PerspectiveCamera } from "three";
import { Matrix4 } from "three";

/** `r.Nanite.DicingRate`: pixels per micro-triangle edge. */
export const DICE_RATE_PIXELS = 2;
/** `NANITE_TESSELLATION_TABLE_SIZE`: the largest edge factor one pattern holds. */
const TABLE_SIZE = 14;
/** The cap on one split level's factor (`min(GetSplitFactors(...), 8)`). */
const SPLIT_CAP = 8;
/** `NANITE_TESSELLATION_MAX_PATCH_SPLIT_LEVELS`. */
const MAX_SPLIT_LEVELS = 6;
/** The hard-coded edge-factor multiple past the fade distance. */
const LOW_TESS_MULTIPLE = 0.25;

export interface IDisplacementPriceOptions {
  /** Pixels per micro-triangle edge. Default 2, Unreal's. */
  readonly diceRate?: number;
  /** Displacement magnitude in metres. Default 0.04, Unreal's 4 cm. */
  readonly magnitude?: number;
  /** The height that does not move the surface. Default 0.5, Unreal's. */
  readonly center?: number;
  /** Pixels the largest displacement spans where the fade ends. Default 0: fade off, Unreal's stock material. */
  readonly fadeOutPixels?: number;
  /** Culls each patch against this buffer, as Unreal's split pass tests its HZB. Default: none. */
  readonly occlusion?: IOcclusionBuffer;
}

/**
 * A conservative stand-in for Unreal's HZB: per texel, the far depth of the nearest triangle that
 * covers its center. A patch is hidden only when every texel under it holds an occluder wholly in
 * front of it, so no patch is ever hidden by itself.
 */
export interface IOcclusionBuffer {
  readonly width: number;
  readonly height: number;
  readonly depth: Float32Array;
}

export interface IDisplacementPrice {
  /** Triangles the scene submits now: draw ranges times drawn copies. */
  triangles: number;
  /** Of those, the ones not wholly outside one frustum plane. */
  visibleTriangles: number;
  /** Visible triangles with an edge factor above 1, the ones a dice pass would split. */
  dicedTriangles: number;
  /** Leaf patches the diced triangles split into. */
  patches: number;
  /** Micro-triangles the diced triangles become. */
  microTriangles: number;
  /** `microTriangles - dicedTriangles`: what dicing adds to the submitted count. */
  addedMicroTriangles: number;
  /** Metres past which edge factors drop to a quarter, for unit scale; 0 when the fade is off. */
  fadeDistance: number;
}

function clampFactor(factor: number): number {
  return Math.min(TABLE_SIZE, Math.max(1, Math.ceil(factor)));
}

/**
 * Micro-triangles in the pattern for three edge factors, after Unreal's ceil and 1-14 clamp.
 *
 * Exact for a uniform pattern (n * n). Unreal remeshes a non-uniform pattern; this estimates its
 * interior vertices from the mean factor and closes with Euler's T = 2I + B - 2.
 * ponytail: estimate for non-uniform patterns; read Unreal's baked table counts if a gate sits on the edge.
 */
export function patternTriangles(a: number, b: number, c: number): number {
  const boundary = clampFactor(a) + clampFactor(b) + clampFactor(c);
  const mean = boundary / 3;
  const interior = Math.max(0, Math.round(((mean - 1) * (mean - 2)) / 2));
  return 2 * interior + boundary - 2;
}

/** One edge's tessellation factor, as `GetTessFactors` computes it for a perspective view. */
export function edgeFactor(
  edgeLength: number,
  nearerDepth: number,
  viewToPixels: number,
  diceRate: number,
  fadeDistance: number,
  near: number,
): number {
  const depth = Math.max(nearerDepth, near);
  const distant = fadeDistance > 0 && depth > fadeDistance;
  return ((edgeLength / depth) * viewToPixels * (distant ? LOW_TESS_MULTIPLE : 1)) / diceRate;
}

/** The view depth where the largest displacement spans `fadeOutPixels`; 0 when the fade is off. */
export function displacementFadeDistance(
  magnitude: number,
  center: number,
  maxScale: number,
  viewToPixels: number,
  fadeOutPixels: number,
): number {
  if (fadeOutPixels <= 0) return 0;
  const largest = Math.max(center, 1 - center) * magnitude;
  return (largest * maxScale * viewToPixels) / fadeOutPixels;
}

/** Visits the n * n children of a uniform barycentric grid over a patch's three view-space points. */
function splitGrid(points: Float64Array, n: number, visit: (child: Float64Array) => void): void {
  const at = (row: number, column: number, into: Float64Array, slot: number): void => {
    const w0 = 1 - row / n;
    const w1 = (row - column) / n;
    const w2 = column / n;
    for (let axis = 0; axis < 3; axis += 1)
      into[slot * 3 + axis] =
        w0 * (points[axis] as number) +
        w1 * (points[3 + axis] as number) +
        w2 * (points[6 + axis] as number);
  };
  for (let row = 0; row < n; row += 1)
    for (let column = 0; column <= row; column += 1) {
      const up = new Float64Array(9);
      at(row, column, up, 0);
      at(row + 1, column, up, 1);
      at(row + 1, column + 1, up, 2);
      visit(up);
      if (column === row) continue;
      const down = new Float64Array(9);
      at(row, column, down, 0);
      at(row + 1, column + 1, down, 1);
      at(row, column + 1, down, 2);
      visit(down);
    }
}

const scratchInstance = new Matrix4();
const scratchView = new Matrix4();
const view = new Float64Array(9);

/** Writes vertex `vertex` of `position`, through `m`, into slot `k` of `view`. */
function toView(position: BufferAttribute, vertex: number, m: number[], k: number): void {
  const x = position.getX(vertex);
  const y = position.getY(vertex);
  const z = position.getZ(vertex);
  view[k * 3] =
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number);
  view[k * 3 + 1] =
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number);
  view[k * 3 + 2] =
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number);
}

/**
 * Calls `visit` with each triangle `root` submits now, in `camera`'s view space: every visible mesh,
 * its draw range only, once per drawn instance.
 */
function forEachSubmittedTriangle(
  root: Object3D,
  camera: PerspectiveCamera,
  visit: (points: Float64Array, modelView: Matrix4) => void,
): void {
  root.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  const each = (mesh: Mesh, modelView: Matrix4): void => {
    const geometry = mesh.geometry;
    const position = geometry.getAttribute("position") as BufferAttribute;
    const index = geometry.getIndex();
    const total = index === null ? position.count : index.count;
    const start = Math.max(0, geometry.drawRange.start);
    const end = Math.min(total, start + geometry.drawRange.count);
    const m = modelView.elements;
    for (let corner = start; corner + 2 < end; corner += 3) {
      for (let k = 0; k < 3; k += 1) toView(position, index?.getX(corner + k) ?? corner + k, m, k);
      visit(view, modelView);
    }
  };
  root.traverseVisible((object) => {
    const mesh = object as Mesh;
    if (mesh.isMesh !== true) return;
    const instanced = object as InstancedMesh;
    if (instanced.isInstancedMesh !== true) {
      each(mesh, scratchView.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld));
      return;
    }
    for (let copy = 0; copy < instanced.count; copy += 1) {
      instanced.getMatrixAt(copy, scratchInstance);
      scratchView
        .multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld)
        .multiply(scratchInstance);
      each(mesh, scratchView);
    }
  });
}

/** Writes point `k` of `points` into `into` as buffer texels; false in front of the near plane. */
function toTexel(
  points: Float64Array,
  k: number,
  projection: number[],
  near: number,
  buffer: { readonly width: number; readonly height: number },
  into: number[],
): boolean {
  const depth = -(points[k * 3 + 2] as number);
  if (depth < near) return false;
  const cx =
    (projection[0] as number) * (points[k * 3] as number) - (projection[8] as number) * depth;
  const cy =
    (projection[5] as number) * (points[k * 3 + 1] as number) - (projection[9] as number) * depth;
  into[k * 2] = (cx / depth + 1) * 0.5 * buffer.width;
  into[k * 2 + 1] = (1 - cy / depth) * 0.5 * buffer.height;
  return true;
}

/** The texel rectangle under three texel points, clamped to the buffer: left, right, top, bottom. */
function texelRect(
  texel: number[],
  width: number,
  height: number,
): [number, number, number, number] {
  const xs = [texel[0] as number, texel[2] as number, texel[4] as number];
  const ys = [texel[1] as number, texel[3] as number, texel[5] as number];
  return [
    Math.max(0, Math.floor(Math.min(...xs))),
    Math.min(width - 1, Math.floor(Math.max(...xs))),
    Math.max(0, Math.floor(Math.min(...ys))),
    Math.min(height - 1, Math.floor(Math.max(...ys))),
  ];
}

/** Keeps `far` at every texel center the triangle covers, where it is nearer than the buffer. */
function rasterize(buffer: IOcclusionBuffer, texel: number[], far: number): void {
  const [x0, y0, x1, y1, x2, y2] = texel as [number, number, number, number, number, number];
  const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (area === 0) return;
  const [left, right, top, bottom] = texelRect(texel, buffer.width, buffer.height);
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      // Signed by the area, so either winding covers the same texels.
      const w0 = ((x2 - x1) * (py - y1) - (y2 - y1) * (px - x1)) * area;
      const w1 = ((x0 - x2) * (py - y2) - (y0 - y2) * (px - x2)) * area;
      const w2 = ((x1 - x0) * (py - y0) - (y1 - y0) * (px - x0)) * area;
      const slot = y * buffer.width + x;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0 && far < (buffer.depth[slot] as number))
        buffer.depth[slot] = far;
    }
}

/**
 * Rasterizes every triangle `root` submits into a `width` x `height` occlusion buffer.
 *
 * Each covered texel center keeps the smallest far depth over the triangles that cover it, so an
 * occluder never claims to hide more than it does. Triangles that cross the near plane are skipped.
 * ponytail: a CPU raster for a measurement; a real dice pass reads the GPU's own HZB.
 */
export function occlusionBuffer(
  root: Object3D,
  camera: PerspectiveCamera,
  width: number,
  height: number,
): IOcclusionBuffer {
  const buffer: IOcclusionBuffer = {
    depth: new Float32Array(width * height).fill(Number.POSITIVE_INFINITY),
    height,
    width,
  };
  const projection = camera.projectionMatrix.elements;
  const texel = [0, 0, 0, 0, 0, 0];
  forEachSubmittedTriangle(root, camera, (points) => {
    for (let k = 0; k < 3; k += 1)
      if (!toTexel(points, k, projection, camera.near, buffer, texel)) return;
    rasterize(
      buffer,
      texel,
      -Math.min(points[2] as number, points[5] as number, points[8] as number),
    );
  });
  return buffer;
}

/** True when some texel under the patch holds no occluder wholly in front of `nearest`. */
function unoccluded(buffer: IOcclusionBuffer, texel: number[], nearest: number): boolean {
  const [left, right, top, bottom] = texelRect(texel, buffer.width, buffer.height);
  if (left > right || top > bottom) return true;
  for (let y = top; y <= bottom; y += 1)
    for (let x = left; x <= right; x += 1)
      if ((buffer.depth[y * buffer.width + x] as number) >= nearest) return true;
  return false;
}

/**
 * Prices dicing every triangle `root` submits now, seen by `camera` at `viewportHeight` pixels.
 *
 * Frustum culling per patch, as Unreal's split pass does, and occlusion when `options.occlusion`
 * is given (`NaniteSplit.usf:228`, `Cull.FrustumHZB`). Back faces are diced too: Unreal's patch
 * back-face cull is compiled out (`NaniteSplit.usf:196-202`). Without an occlusion buffer the price
 * is an upper bound.
 */
export function priceDisplacedSurface(
  root: Object3D,
  camera: PerspectiveCamera,
  viewportHeight: number,
  options: IDisplacementPriceOptions = {},
): IDisplacementPrice {
  const diceRate = options.diceRate ?? DICE_RATE_PIXELS;
  const magnitude = options.magnitude ?? 0.04;
  const center = options.center ?? 0.5;
  const fadeOutPixels = options.fadeOutPixels ?? 0;
  const occlusion = options.occlusion;
  if (!(diceRate > 0) || !(viewportHeight > 0))
    throw new Error("TN_DISPLACED_SURFACE: dice rate and viewport height must be positive.");
  const projection = camera.projectionMatrix.elements;
  const viewToPixels = 0.5 * (projection[5] as number) * viewportHeight;
  const { near, far } = camera;
  const price: IDisplacementPrice = {
    addedMicroTriangles: 0,
    dicedTriangles: 0,
    fadeDistance: displacementFadeDistance(magnitude, center, 1, viewToPixels, fadeOutPixels),
    microTriangles: 0,
    patches: 0,
    triangles: 0,
    visibleTriangles: 0,
  };
  /** Which frustum planes view-space point `k` of `points` lies outside, one bit each. */
  const outcode = (points: Float64Array, k: number): number => {
    const vx = points[k * 3] as number;
    const vy = points[k * 3 + 1] as number;
    const vz = points[k * 3 + 2] as number;
    const cx = (projection[0] as number) * vx + (projection[8] as number) * vz;
    const cy = (projection[5] as number) * vy + (projection[9] as number) * vz;
    const depth = -vz;
    return (
      (cx < -depth ? 1 : 0) |
      (cx > depth ? 2 : 0) |
      (cy < -depth ? 4 : 0) |
      (cy > depth ? 8 : 0) |
      (depth < near ? 16 : 0) |
      (depth > far ? 32 : 0)
    );
  };
  /** True when all three points lie outside one frustum plane. */
  const outside = (points: Float64Array): boolean =>
    (outcode(points, 0) & outcode(points, 1) & outcode(points, 2)) !== 0;
  const texel = [0, 0, 0, 0, 0, 0];
  /** False when the occlusion buffer hides the patch, its nearest point pulled in by the displacement. */
  const seen = (points: Float64Array, reach: number): boolean => {
    if (occlusion === undefined) return true;
    for (let k = 0; k < 3; k += 1)
      if (!toTexel(points, k, projection, near, occlusion, texel)) return true;
    const nearest =
      -Math.max(points[2] as number, points[5] as number, points[8] as number) - reach;
    return unoccluded(occlusion, texel, nearest);
  };
  const factorOf = (points: Float64Array, i: number, j: number, fade: number): number =>
    edgeFactor(
      Math.hypot(
        (points[i * 3] as number) - (points[j * 3] as number),
        (points[i * 3 + 1] as number) - (points[j * 3 + 1] as number),
        (points[i * 3 + 2] as number) - (points[j * 3 + 2] as number),
      ),
      Math.min(-(points[i * 3 + 2] as number), -(points[j * 3 + 2] as number)),
      viewToPixels,
      diceRate,
      fade,
      near,
    );

  /**
   * Dices one patch, given as nine view-space numbers, into `price`; false when it needs no dice.
   *
   * Past a factor of 14 it splits, as `NaniteSplit.usf:239-258` does, by TF / 14 capped at 8, and
   * every child culls and prices itself from its own points (`NaniteSplit.usf:117-235`).
   * ponytail: children are a uniform grid at the largest split factor where Unreal's split pattern
   * follows each edge; the leaf count shifts, the micro-triangle density does not.
   */
  const dice = (
    points: Float64Array,
    fade: number,
    reach: number,
    level: number,
    root: boolean,
  ): boolean => {
    if (!root && outside(points)) return true;
    const a = factorOf(points, 0, 1, fade);
    const b = factorOf(points, 1, 2, fade);
    const c = factorOf(points, 2, 0, fade);
    const largest = Math.max(a, b, c);
    if (root && largest <= 1) return false;
    // An occluded root is not diced at all; an occluded child is a culled part of a diced one.
    if (!seen(points, reach)) return !root;
    if (largest <= TABLE_SIZE || level >= MAX_SPLIT_LEVELS) {
      price.patches += 1;
      price.microTriangles += patternTriangles(a, b, c);
      return true;
    }
    const n = clampFactor(Math.min(largest / TABLE_SIZE, SPLIT_CAP));
    splitGrid(points, n, (child) => dice(child, fade, reach, level + 1, false));
    return true;
  };

  forEachSubmittedTriangle(root, camera, (points, modelView) => {
    price.triangles += 1;
    if (outside(points)) return;
    price.visibleTriangles += 1;
    const scale = modelView.getMaxScaleOnAxis();
    const fade = displacementFadeDistance(magnitude, center, scale, viewToPixels, fadeOutPixels);
    const reach = Math.max(center, 1 - center) * magnitude * scale;
    if (dice(points, fade, reach, 0, true)) price.dicedTriangles += 1;
  });
  price.addedMicroTriangles = price.microTriangles - price.dicedTriangles;
  return price;
}
