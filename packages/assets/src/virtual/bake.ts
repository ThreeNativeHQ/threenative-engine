// The pipeline's side of the DAG bake: which primitives get one, and what the report says about it.

import type { Document, Primitive } from "@gltf-transform/core";
import {
  type IClusterDag,
  type IClusterDagOptions,
  type IVirtualLevel,
  buildClusterDag,
} from "./dag.js";
import { TNVirtualGeometry, attachVirtualGeometry, virtualGeometryBytes } from "./extension.js";

/**
 * Cluster-DAG bake options, as they appear under `assets.models.virtual` in `threenative.config.ts`.
 *
 * **Absent means the bake runs with defaults**, exactly as `textures` does: a game that imports a
 * body too dense for the screen should not have to know this key exists to avoid drawing all of it.
 * `"none"` ships every primitive as authored. There is no runtime flag either way — a minutes-long
 * bake cannot happen at run time, and a second way to say the same thing is a second thing to get
 * wrong.
 */
export interface IModelVirtualOptions {
  /** Clusters folded together per group, default 4. */
  readonly groupSize?: number;
  /** Upper bound on a cluster's triangles, default 128. */
  readonly maxTriangles?: number;
  /** Lower bound on a cluster's triangles, default 96. */
  readonly minTriangles?: number;
  /**
   * Primitives below this many triangles are left alone. Default {@link DEFAULT_MIN_SOURCE_TRIANGLES}.
   *
   * The payload costs about 3–4x the primitive's compiled bytes whatever its density, so the
   * default is the density where the cut starts earning them back. Measured on one body at seven
   * densities, drawing at a distance that frames it across a third of the screen:
   *
   * | source triangles | desktop 1080p draws | Pixel 8 (0.44 scale) draws |
   * | --- | --- | --- |
   * | 32,768 | 92% | 57% |
   * | 65,536 | 69% | 27% |
   * | 131,072 | 35% | 16% |
   * | 524,288 | 13% | 8% |
   *
   * Below 32k the cut is the whole mesh on desktop — payload for nothing. 65,536 is where a phone
   * already draws a quarter of the triangles and a desktop a bit over two thirds, and it is the
   * density at which a mesh needs 32-bit indices anyway.
   */
  readonly minSourceTriangles?: number;
  /** Fraction of a group's triangles kept per level, default 0.5. */
  readonly simplifyRatio?: number;
}

/**
 * What the bake actually did, per model.
 *
 * `skipped` is reported rather than silently implied: a config that turns virtual geometry on and a
 * report that names zero clusters is a build the author needs to see.
 */
export interface IModelVirtualSummary {
  readonly bakeSeconds: number;
  readonly clusters: number;
  /**
   * Primitives the bake looked at and handed back because their DAG reduced nothing — left for the
   * discrete ladder, which is named here because "no clusters" alone reads as a bug.
   */
  readonly declined: number;
  readonly levels: number;
  readonly payloadBytes: number;
  readonly primitives: number;
  readonly skipped: number;
  /** The worst outcome across the model's primitives — `cap` means a DAG stopped unfinished. */
  readonly stopReason: string;
}

/** Bumped when the bake's output changes for the same input. Part of the compile cache key. */
export const VIRTUAL_BAKE_VERSION = 4;

/**
 * The share of its own triangles a DAG has to shed before it keeps the primitive.
 *
 * Below that the payload is three to four times the primitive's compiled bytes (see
 * {@link IModelVirtualOptions.minSourceTriangles}) for a cut that draws the same triangles, and the
 * discrete ladder's terminal level reaches 5% of LOD0 on the same geometry.
 */
const DECLINE_KEEP_RATIO = 0.8;

/**
 * Whether the bake hands this primitive back instead of owning it (PRD-485).
 *
 * A `stalled` DAG whose coarsest level still holds most of the source has no coarse representation
 * to offer. meshoptimizer will not collapse a body of disconnected alpha-cutout cards with every
 * border locked — each card's whole rim is a border — so the first fold simplifies nothing
 * (`virtual/dag.ts:461`), every level reports the source count, and every threshold draws LOD0: the
 * Hornbeam's two foliage primitives, 745,328 triangles with no coarse step at all. Owning them
 * anyway costs 3–4x their bytes and leaves them `virtual-owned` (`lod/eligibility.ts:182`), so the
 * bake declines them and the discrete ladder — whose terminal pass exists for exactly this shape,
 * `lod/generate.ts:851` — gets the primitive instead.
 *
 * Measured, not assumed: a DAG that stalls *after* real folds has shed its triangles and keeps the
 * primitive, and so does every stop reason but `stalled`.
 */
function declines(dag: IClusterDag, sourceTriangles: number): boolean {
  if (dag.stopReason !== "stalled") return false;
  const coarsest = dag.levels[dag.levels.length - 1] as IVirtualLevel;
  return coarsest.triangleCount > sourceTriangles * DECLINE_KEEP_RATIO;
}

/**
 * The density at which a cluster DAG starts paying for its own bytes. See
 * {@link IModelVirtualOptions.minSourceTriangles} for the measurement behind it.
 */
export const DEFAULT_MIN_SOURCE_TRIANGLES = 65_536;

/** Positions as tightly packed floats, whatever the accessor stores them as. */
function positionsOf(primitive: Primitive): Float32Array | null {
  const position = primitive.getAttribute("POSITION");
  if (position === null || position.getType() !== "VEC3") return null;
  const array = position.getArray();
  if (array === null) return null;
  if (array instanceof Float32Array && !position.getNormalized()) return array;
  const floats = new Float32Array(position.getCount() * 3);
  const element: number[] = [0, 0, 0];
  for (let vertex = 0; vertex < position.getCount(); vertex += 1) {
    position.getElement(vertex, element);
    floats[vertex * 3] = element[0] as number;
    floats[vertex * 3 + 1] = element[1] as number;
    floats[vertex * 3 + 2] = element[2] as number;
  }
  return floats;
}

const WORST_FIRST = ["cap", "stalled", "root"];

function worse(left: string, right: string): string {
  return WORST_FIRST.indexOf(left) <= WORST_FIRST.indexOf(right) ? left : right;
}

/**
 * Bakes a cluster DAG onto every primitive dense enough to want one.
 *
 * Runs after `reorder` and before `quantize`: `reorder` is the last stage that moves a vertex, and
 * the DAG's index buffer names vertices. Quantization afterwards changes what a position *is* by a
 * fraction of the finest cluster's error and never changes which vertex it is, so the cut still
 * addresses the same triangles — which `virtual-pass.spec.ts` asserts rather than assumes.
 */
export async function bakeVirtualGeometry(
  document: Document,
  options: IModelVirtualOptions,
  now: () => number = () => Date.now(),
): Promise<IModelVirtualSummary> {
  const started = now();
  const minSourceTriangles = options.minSourceTriangles ?? DEFAULT_MIN_SOURCE_TRIANGLES;
  const dagOptions: IClusterDagOptions = {
    ...(options.groupSize === undefined ? {} : { groupSize: options.groupSize }),
    ...(options.maxTriangles === undefined ? {} : { maxTriangles: options.maxTriangles }),
    ...(options.minTriangles === undefined ? {} : { minTriangles: options.minTriangles }),
    ...(options.simplifyRatio === undefined ? {} : { simplifyRatio: options.simplifyRatio }),
  };

  let extension: TNVirtualGeometry | null = null;
  let clusters = 0;
  let declined = 0;
  let levels = 0;
  let payloadBytes = 0;
  let primitives = 0;
  let skipped = 0;
  let stopReason = "root";

  for (const primitive of document
    .getRoot()
    .listMeshes()
    .flatMap((mesh) => mesh.listPrimitives())) {
    const indices = primitive.getIndices();
    const positions = positionsOf(primitive);
    // A skinned body ships whole: the loader's clustered mesh is a plain `Mesh`, so a baked
    // primitive would lose its skin (and the rig would not clone).
    if (
      indices === null ||
      positions === null ||
      primitive.getMode() !== 4 ||
      primitive.getAttribute("JOINTS_0") !== null
    ) {
      skipped += 1;
      continue;
    }
    const sourceTriangles = indices.getCount() / 3;
    if (sourceTriangles < minSourceTriangles) {
      skipped += 1;
      continue;
    }
    const dag = await buildClusterDag(
      Uint32Array.from(indices.getArray() as ArrayLike<number>),
      positions,
      dagOptions,
    );
    // No extension is created for a declined primitive, so a document whose every primitive is
    // card soup never declares `TN_virtual_geometry` at all.
    if (declines(dag, sourceTriangles)) {
      declined += 1;
      continue;
    }
    extension ??= document.createExtension(TNVirtualGeometry).setRequired(false);
    const virtual = attachVirtualGeometry(document, extension, primitive, dag);
    clusters += dag.clusters.length;
    levels = Math.max(levels, dag.levels.length);
    payloadBytes += virtualGeometryBytes(virtual);
    primitives += 1;
    stopReason = worse(stopReason, dag.stopReason);
  }

  return {
    bakeSeconds: (now() - started) / 1000,
    clusters,
    declined,
    levels,
    payloadBytes,
    primitives,
    skipped,
    stopReason,
  };
}
