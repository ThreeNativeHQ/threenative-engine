/**
 * The terrain block merge and the seam bridge strip, as pure attribute arithmetic.
 *
 * Two hosts run these two bodies: the main thread, inline, and a module worker. Nothing here reads
 * a scene, a material, a field or a sampler — the inputs are typed arrays plus the numbers that
 * place them, the outputs are the merged arrays — so both hosts compute from one function and
 * cannot disagree. `TerrainTiles` keeps the GPU uploads and the scene-graph edits; this is the part
 * that moves (PRD-478 Phase 3).
 *
 * Buffers go to the worker by structured clone and come back transferred: a level's own attribute
 * arrays stay owned by its geometry, because a dissolved block restores that mesh, so they are
 * never detached underneath it.
 */

/** Which edge of a level a sample row runs along. */
export type TerrainEdgeSide = "east" | "north" | "south" | "west";

/** Where a tile or a block sits, in world metres. */
export interface ITerrainJobOrigin {
  readonly x: number;
  readonly z: number;
}

/** One tile level's attributes, exactly as the merge reads them. */
export interface ITerrainPartAttributes {
  readonly indices: Uint16Array | Uint32Array;
  readonly normals: Float32Array;
  readonly positions: Float32Array;
}

export interface ITerrainMergeJob {
  readonly blockOrigin: ITerrainJobOrigin;
  readonly kind: "merge";
  readonly parts: readonly (ITerrainPartAttributes & { readonly origin: ITerrainJobOrigin })[];
}

export interface ITerrainMergeResult extends ITerrainPartAttributes {
  readonly indices: Uint32Array;
  readonly kind: "merge";
}

/** One level's edge: the row's own sample heights and the field rectangle they sit on. */
export interface ITerrainEdgeJob {
  readonly depth: number;
  readonly origin: ITerrainJobOrigin;
  /** The edge's vertex heights, copied out of the level that still owns them. */
  readonly samples: Float32Array;
  readonly side: TerrainEdgeSide;
  readonly width: number;
}

export interface ITerrainFineEdgeJob extends ITerrainEdgeJob {
  /** How many pairs the strip carries; the coarse side is sampled at the fine side's rate. */
  readonly resolution: number;
}

export interface ITerrainSeamJob {
  readonly kind: "seam";
  readonly pairs: readonly {
    readonly coarse: ITerrainEdgeJob;
    readonly fine: ITerrainFineEdgeJob;
  }[];
}

export interface ITerrainBridgeAttributes {
  readonly coverageDepth: number;
  readonly indices: Uint32Array;
  readonly normals: Float32Array;
  readonly positions: Float32Array;
}

export interface ITerrainSeamResult {
  readonly bridges: readonly ITerrainBridgeAttributes[];
  readonly kind: "seam";
}

export type ITerrainJob = ITerrainMergeJob | ITerrainSeamJob;
export type ITerrainJobResult = ITerrainMergeResult | ITerrainSeamResult;

/**
 * Concatenate each part's `position`/`normal`/`index` into one block, every vertex translated from
 * its own tile origin to the block origin. The vertices land on the world positions they already
 * occupied, so the same surface material samples the same heights and normals. Skirts come along
 * unchanged because they are part of the level geometry, and each survivor keeps its tile's
 * perimeter skirt: a block edge only ever exposes a tile that was already on the block's perimeter,
 * whose outward skirt is already there.
 */
export function mergeBlockAttributes(job: ITerrainMergeJob): ITerrainMergeResult {
  let vertexCount = 0;
  let indexCount = 0;
  for (const part of job.parts) {
    vertexCount += part.positions.length / 3;
    indexCount += part.indices.length;
  }
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  let vertexOffset = 0;
  let indexOffset = 0;
  for (const part of job.parts) {
    const dx = part.origin.x - job.blockOrigin.x;
    const dz = part.origin.z - job.blockOrigin.z;
    const count = part.positions.length / 3;
    for (let vertex = 0; vertex < count; vertex += 1) {
      const at = (vertexOffset + vertex) * 3;
      const from = vertex * 3;
      positions[at] = (part.positions[from] as number) + dx;
      positions[at + 1] = part.positions[from + 1] as number;
      positions[at + 2] = (part.positions[from + 2] as number) + dz;
      normals[at] = part.normals[from] as number;
      normals[at + 1] = part.normals[from + 1] as number;
      normals[at + 2] = part.normals[from + 2] as number;
    }
    for (let element = 0; element < part.indices.length; element += 1)
      indices[indexOffset + element] = (part.indices[element] as number) + vertexOffset;
    vertexOffset += count;
    indexOffset += part.indices.length;
  }
  return { indices, kind: "merge", normals, positions };
}

/**
 * The strip's height along one edge: the retained samples read at a normalized position, clamped to
 * the row's own ends.
 */
export function interpolatedEdgeSample(
  samples: Float32Array,
  normalized: number,
  name: string,
): number {
  const position = Math.max(0, Math.min(1, normalized)) * (samples.length - 1);
  const lower = Math.floor(position);
  const upper = Math.min(samples.length - 1, lower + 1);
  const mix = position - lower;
  const lowerValue = samples[lower] as number;
  const upperValue = samples[upper] as number;
  if (!Number.isFinite(lowerValue) || !Number.isFinite(upperValue))
    throw new Error(`TerrainTiles retained ${name} edge sample must be finite.`);
  return lowerValue * (1 - mix) + upperValue * mix;
}

/** The rectangle and side one edge's point is read against; a field's own numbers, no samples. */
export type ITerrainEdgeFrame = Pick<ITerrainEdgeJob, "depth" | "origin" | "side" | "width">;

/** Where one edge's point at a normalized position sits in the world. */
export function edgeWorldPoint(
  edge: ITerrainEdgeFrame,
  normalized: number,
  height: number,
): [number, number, number] {
  const minimumX = edge.origin.x - edge.width / 2;
  const minimumZ = edge.origin.z - edge.depth / 2;
  const x =
    edge.side === "west"
      ? minimumX
      : edge.side === "east"
        ? minimumX + edge.width
        : minimumX + normalized * edge.width;
  const z =
    edge.side === "north"
      ? minimumZ
      : edge.side === "south"
        ? minimumZ + edge.depth
        : minimumZ + normalized * edge.depth;
  return [x, height, z];
}

/**
 * One bridge's strip: a quad per fine vertex between the fine edge's height and the coarse edge's,
 * plus the deepest gap between them, which is the coverage the bridge has to hide.
 */
export function stitchBridgeAttributes(
  fine: ITerrainFineEdgeJob,
  coarse: ITerrainEdgeJob,
): ITerrainBridgeAttributes {
  const positions = new Float32Array(fine.resolution * 6);
  const normals = new Float32Array(fine.resolution * 6);
  const indices = new Uint32Array((fine.resolution - 1) * 12);
  let coverageDepth = 0;
  for (let index = 0; index < fine.resolution; index += 1) {
    const normalized = index / (fine.resolution - 1);
    const fineHeight = interpolatedEdgeSample(
      fine.samples,
      normalized,
      `${fine.side} of finer LOD`,
    );
    const coarseHeight = interpolatedEdgeSample(
      coarse.samples,
      normalized,
      `${coarse.side} of coarser LOD`,
    );
    coverageDepth = Math.max(coverageDepth, Math.abs(fineHeight - coarseHeight));
    const at = index * 6;
    const finePoint = edgeWorldPoint(fine, normalized, fineHeight);
    const coarsePoint = edgeWorldPoint(coarse, normalized, coarseHeight);
    positions[at] = finePoint[0];
    positions[at + 1] = finePoint[1];
    positions[at + 2] = finePoint[2];
    positions[at + 3] = coarsePoint[0];
    positions[at + 4] = coarsePoint[1];
    positions[at + 5] = coarsePoint[2];
    normals[at] = 0;
    normals[at + 1] = 1;
    normals[at + 2] = 0;
    normals[at + 3] = 0;
    normals[at + 4] = 1;
    normals[at + 5] = 0;
  }
  for (let index = 0; index < fine.resolution - 1; index += 1) {
    const fine2 = index * 2;
    const coarse2 = fine2 + 1;
    const nextFine = fine2 + 2;
    const nextCoarse = coarse2 + 2;
    const at = index * 12;
    indices[at] = fine2;
    indices[at + 1] = coarse2;
    indices[at + 2] = nextFine;
    indices[at + 3] = nextFine;
    indices[at + 4] = coarse2;
    indices[at + 5] = nextCoarse;
    indices[at + 6] = nextFine;
    indices[at + 7] = coarse2;
    indices[at + 8] = fine2;
    indices[at + 9] = nextCoarse;
    indices[at + 10] = coarse2;
    indices[at + 11] = nextFine;
  }
  return { coverageDepth, indices, normals, positions };
}

export function runTerrainJob(job: ITerrainMergeJob): ITerrainMergeResult;
export function runTerrainJob(job: ITerrainSeamJob): ITerrainSeamResult;
export function runTerrainJob(job: ITerrainJob): ITerrainJobResult;
/** The one body both hosts run; the worker entry is a message handler around this call. */
export function runTerrainJob(job: ITerrainJob): ITerrainJobResult {
  if (job.kind === "merge") return mergeBlockAttributes(job);
  return {
    bridges: job.pairs.map(({ coarse, fine }) => stitchBridgeAttributes(fine, coarse)),
    kind: "seam",
  };
}

/** The buffers a result owns, so the reply transfers them instead of copying them back. */
export function terrainJobTransfers(result: ITerrainJobResult): Transferable[] {
  if (result.kind === "merge")
    return [result.positions.buffer, result.normals.buffer, result.indices.buffer];
  return result.bridges.flatMap((bridge) => [
    bridge.positions.buffer,
    bridge.normals.buffer,
    bridge.indices.buffer,
  ]);
}

/**
 * Where the terrain jobs run.
 *
 * `offThread` is `true` only when a worker is really there: the runner keeps the same function
 * inline whenever `Worker` is missing (node, a native script scope) or refuses a module source, and
 * it falls back to this thread if a worker dies mid-job, so a broken worker costs the main thread
 * the work and nothing else. `inlineReason` names which of those it is.
 *
 * One worker, one job at a time, which is what keeps a block's older merge from answering after its
 * newer one: replies come back in the order the jobs were sent.
 */
export interface ITerrainJobRunner {
  dispose(): void;
  /** Why this host runs the jobs on its own thread, or `undefined` while a worker has them. */
  readonly inlineReason: string | undefined;
  readonly offThread: boolean;
  merge(job: ITerrainMergeJob): ITerrainMergeResult | Promise<ITerrainMergeResult>;
  seam(job: ITerrainSeamJob): ITerrainSeamResult | Promise<ITerrainSeamResult>;
}

interface IPendingJob {
  readonly compute: () => ITerrainJobResult;
  readonly resolve: (result: ITerrainJobResult) => void;
}

/**
 * The module worker next to this file, and why there may not be one.
 *
 * The native host is the host that answers here: its shim installs a `Worker` that admits a classic
 * Blob source only and refuses a module source by name (`TN_NATIVE_WORKER_MODULE_UNSUPPORTED`, see
 * `runtime-native/src/runtime-scripts/url-worker-polyfill.js`), and the native bundle rewrites
 * `import.meta.url` before Vite can inline a sibling worker, so there is no packaged module to load
 * there. Both refusals are reported as a reason and every job runs inline from the same function.
 */
function spawnTerrainWorker(): { reason: string | undefined; worker: Worker | undefined } {
  if (typeof Worker === "undefined") return { reason: "no Worker on this host", worker: undefined };
  try {
    const worker = new Worker(new URL("./terrain-jobs-worker.js", import.meta.url), {
      type: "module",
    });
    return { reason: undefined, worker };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { reason: `module worker refused: ${message}`, worker: undefined };
  }
}

export function createTerrainJobRunner(): ITerrainJobRunner {
  const pending = new Map<number, IPendingJob>();
  let nextId = 0;
  const spawned = spawnTerrainWorker();
  let worker = spawned.worker;
  const abandon = (): void => {
    for (const [, job] of pending) job.resolve(job.compute());
    pending.clear();
    worker?.terminate();
    worker = undefined;
  };
  if (worker !== undefined) {
    worker.onmessage = (event: MessageEvent): void => {
      const reply = event.data as { id: number; result: ITerrainJobResult };
      pending.get(reply.id)?.resolve(reply.result);
      pending.delete(reply.id);
    };
    worker.onerror = abandon;
  }
  const dispatch = <T extends ITerrainJobResult>(
    job: ITerrainJob,
    compute: () => T,
  ): T | Promise<T> => {
    const active = worker;
    if (active === undefined) return compute();
    const id = nextId;
    nextId += 1;
    const sent = new Promise<T>((resolve) => {
      pending.set(id, {
        compute: compute as () => ITerrainJobResult,
        resolve: resolve as (result: ITerrainJobResult) => void,
      });
    });
    try {
      active.postMessage({ id, job });
    } catch {
      pending.delete(id);
      return compute();
    }
    return sent;
  };
  return {
    dispose: () => {
      pending.clear();
      worker?.terminate();
      worker = undefined;
    },
    inlineReason: spawned.reason,
    merge: (job) => dispatch(job, () => runTerrainJob(job)),
    offThread: worker !== undefined,
    seam: (job) => dispatch(job, () => runTerrainJob(job)),
  };
}
