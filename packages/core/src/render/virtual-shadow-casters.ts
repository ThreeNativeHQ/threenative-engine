import type { Box3, BufferGeometry, Mesh, Sphere } from "three";
import { lodChainOf } from "../model-lod.js";

/**
 * What a caster is, what a level measures it by, and how it is sorted into static and moving.
 *
 * One layer of the pipeline: the world sphere and box a level derives its depth from, the texel and
 * LOD gates that decide whether a caster draws into a level at all, and the motion record that keeps
 * a walking mesh out of the cached maps until it holds still.
 */

/**
 * World spheres one level render collects: centre, radius, shadow flags, the box's own height
 * range, seven numbers each.
 */
export const POOL_STRIDE = 7;
/**
 * How many window widths a caster may be before the window is cut out of it instead. One: an
 * object wider than the window it is in is a mass, and only its height reaches the frustum.
 */
export const MAX_MASS_WINDOW_WIDTHS = 1;
export const POOL_CASTERS = 1 << 0;

/**
 * A mesh in the caster table, with the three channels the probe reads off the object rather than off
 * the geometry: the bounds three's own cull would use, which `Mesh` does not declare, the
 * `casterPrewarmOwed` flag `WorldCells` writes (see `SharedBatch.awaitPrewarmDraw`), and the
 * `mainAdmitted` answer it publishes for a caster half (see `SharedBatch.setMainAdmitted`).
 */
export interface ICasterMesh extends Mesh {
  boundingBox?: Box3 | null;
  boundingSphere?: Sphere | null;
  casterPrewarmOwed?: boolean;
  mainAdmitted?: boolean;
  chunkShadowProxy?: boolean;
  casterMinDiameter?: number;
  /**
   * How many per-level buffers a chunk shadow proxy may keep, set by the level probe from the
   * ladder's own length; see `selectChunkShadowParts`.
   */
  casterLevelSlots?: number;
  computeBoundingBox(): void;
  computeBoundingSphere(): void;
}

/**
 * One caster's memoised world values, and the inputs they were derived from.
 *
 * The key is the world matrix plus the local sphere and the local box's two Y values — everything
 * `Sphere.applyMatrix4` and `Box3.applyMatrix4` read, and nothing else. Twenty-two doubles compare
 * against the pair of matrix applies they replace, and a key that matches cannot have a different
 * answer, so this is a memo on the inputs rather than a guess about whether the mesh moved. A
 * caster under a frozen subtree, a streamed cell nobody touched and a walking stag are therefore
 * the same case: whichever of them changed its world matrix is recomputed, and the rest are not.
 *
 * A fresh slot is all zeros, which no world matrix can be — its last element is 1 — so the first
 * render of a caster always misses and always computes.
 */
const CASTER_KEY_STRIDE = 22;
/** World centre and radius, then the box's world height range: what the pool row is written from. */
const CASTER_WORLD_STRIDE = 6;
export const CASTER_STRIDE = CASTER_KEY_STRIDE + CASTER_WORLD_STRIDE;

export const MOTION_STATIC = 0;
/** Drawn through the mover maps and kept out of the cached levels. */
export const MOTION_MOVER = 1;
/**
 * Back in the cached levels, still drawn through the mover maps until every level the redraw asked
 * has rendered it, so the shadow never drops out between the two.
 */
export const MOTION_SETTLING = 2;

/** What the motion scan remembers of one caster mesh between frames. */
export interface ICasterMotion {
  /** The 16 world-matrix elements at the last scan: where the cached levels last saw it. */
  readonly world: Float64Array;
  /** `instanceMatrix.version` at the last scan; unused on a plain mesh. */
  instanceVersion: number;
  phase: typeof MOTION_STATIC | typeof MOTION_MOVER | typeof MOTION_SETTLING;
  /** `pinStatic` named this mesh or an ancestor. */
  pinned: boolean;
  /** Consecutive scans without movement while a mover. */
  quiet: number;
}

/**
 * What a world publishes on its root for a shadow level to draw a map from GPU-scene keys:
 * `(renderer, level) => void`, the level's own three numbers and the scene that selects against them.
 *
 * Engine-internal and duck-typed. `WorldCells` publishes it as `tnShadowGpuKeys`; nothing in a
 * template or a manifest names it, and this module cannot import the world package to name the type,
 * so the contract is the call and the flag behind it.
 */
export type IShadowKeyDispatch = (renderer: unknown, level: IShadowLevelNumbers) => void;

/**
 * One shadow map's own three numbers, duck-typed from `world-gpu-scene`'s `IShadowLevel`: the six
 * planes of this map's own shadow camera, its texel gate in world metres, and the chain level it
 * draws at. Typed here rather than imported for the
 * same reason as the dispatch above.
 */
interface IShadowLevelNumbers {
  readonly planes: Float32Array;
  readonly gate: number;
  readonly base: number;
}

/** The state cached maps depend on: visible, casting, and admitted by the main pass. */
/** A skinned mesh, or one with a morph target weighted above zero: its pixels change with no matrix change. */
export function deforms(mesh: Mesh): boolean {
  if ((mesh as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) return true;
  const influences = mesh.morphTargetInfluences;
  if (influences === undefined) return false;
  for (const weight of influences) if (weight !== 0) return true;
  return false;
}

export function casterFlag(mesh: {
  castShadow?: boolean;
  mainAdmitted?: boolean;
  userData?: { tnShadowSwap?: unknown };
  visible?: boolean;
}): number {
  // A mesh marked tnShadowSwap trades visibility with a twin over the same ground — terrain's
  // tile and merged block, or one LOD level for the next. That flip is not a change the cached map
  // must redraw for (it measured ~80 % of a walk's flips); castShadow and mainAdmitted still are,
  // and the next window move redraws whatever resolution difference a LOD step left behind.
  return (
    (mesh.visible === true || mesh.userData?.tnShadowSwap === true ? 1 : 0) |
    (mesh.castShadow === true ? 2 : 0) |
    (mesh.mainAdmitted === false ? 4 : 0)
  );
}

/**
 * The diameter a shadow level's texel gate judges one caster by: the part's own geometry radius
 * times the largest instance scale `WorldCells` placed into this batch, or the mesh's own sphere
 * when it publishes no scale (anything the world does not own).
 */
export function instanceDiameter(mesh: Mesh, sphereRadius: number): number {
  const scale = (mesh as Mesh & { casterInstanceScale?: number }).casterInstanceScale;
  if (scale === undefined || scale <= 0) return sphereRadius * 2;
  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const radius = geometry.boundingSphere?.radius;
  if (radius === undefined || radius <= 0) return sphereRadius * 2;
  return radius * 2 * scale;
}

/**
 * The geometry a caster draws into a level past the finest: the coarsest rung of its AutoLOD chain
 * whose error stays within `budget` (world units: texels of the level times `shadowLodTexels`), and
 * never finer than the rung the main pass shows, which the viewer already cannot tell apart. Where
 * no rung is that accurate the mesh keeps what it has. A rung whose error is more than a texel
 * draws as a facet on the shadow's edge: the coarsest rung of a sphere, 60 mm out, put straight
 * segments on a 7 mm texel. `undefined` leaves the geometry alone.
 */
export function shadowLod(mesh: Mesh, budget: number): BufferGeometry | undefined {
  const chain = lodChainOf(mesh.geometry);
  if (chain === undefined) return undefined;
  // The largest instance scale `WorldCells` placed into this batch is on top of the mesh's own.
  const placed = (mesh as Mesh & { casterInstanceScale?: number }).casterInstanceScale;
  const scale =
    mesh.matrixWorld.getMaxScaleOnAxis() * (placed !== undefined && placed > 0 ? placed : 1);
  const shown = chain.levels.indexOf(mesh.geometry);
  for (let rung = chain.levels.length - 1; rung > shown; rung -= 1) {
    if ((chain.errors[rung] as number) * scale <= budget) return chain.levels[rung];
  }
  return undefined;
}
