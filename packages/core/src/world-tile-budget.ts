/**
 * TerrainTiles' constants, admission byte estimates and the input guards they share. Split out of
`world-tiles.ts` verbatim (PRD-797), so the estimator can be read and tested without the class.
 */
import { readLaunchFlag } from "./debug.js";

import { type SpanId, addSpan, spanNow, spanRecorder } from "./profiling/Spans.js";
import type { IHeightfieldWorldPassOptions } from "./world-heightfield.js";
import type {
  IEdgeSamples,
  IWorldTileCollider,
  IWorldTilesTopologyObservation,
} from "./world-tiles.js";
export const MAX_RAW_TOPOLOGY_SAMPLES = 10_000;
export const LOD_POP_THRESHOLD = 16;
export const LOD_TRANSITION_FRAMES = 3;
/** Maximum sampled vertices or quads in one terrain-construction admission unit. */
export const CONSTRUCTION_CHUNK_SAMPLES = 256;
/** Tiles per side in a merged super-tile block. Small, because a block is culled as one object. */
export const TERRAIN_MERGE_BLOCK = 4;
export const TERRAIN_MERGE_FLAG = "TN_TERRAIN_MERGE";
export const TERRAIN_TILE_MARKER_MS = 5_000;

/**
 * Whether this launch asked for terrain tile merging to be turned off.
 *
 * The merge is on by default, so this only has to hear the three ways every other launch switch is
 * read: a native launch sets the environment variable, a browser asks with the query string, and a
 * test or harness sets the global. Only `0` and `false` count, so a URL that never mentioned the
 * switch — or one that still carries the `=1` that used to ask for the merge — stays on.
 */
export function terrainMergeOptedOut(): boolean {
  return readLaunchFlag(
    { environment: TERRAIN_MERGE_FLAG, global: "__tnTerrainMerge", query: "tnTerrainMerge" },
    "off",
  );
}

/** A block's key: its LOD tier and which K×K cell of the tile grid it covers. */
export function blockKeyFor(lod: number, tileX: number, tileZ: number): string {
  return `${String(lod)}:${String(Math.floor(tileX / TERRAIN_MERGE_BLOCK))},${String(
    Math.floor(tileZ / TERRAIN_MERGE_BLOCK),
  )}`;
}

export function blockCoordinates(key: string): { lod: number; blockX: number; blockZ: number } {
  const separator = key.indexOf(":");
  const comma = key.indexOf(",", separator + 1);
  return {
    lod: Number(key.slice(0, separator)),
    blockX: Number(key.slice(separator + 1, comma)),
    blockZ: Number(key.slice(comma + 1)),
  };
}

export class EmptyCollider implements IWorldTileCollider {
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  dispose(): void {
    this.#disposed = true;
  }
}

/**
 * The one throw a hard cap produces, so a caller composing `TerrainTiles` can tell "a tile no longer
 * fits" from a defect in game-owned input by `instanceof` rather than by a name any error can borrow.
 * Not re-exported from `world.ts`: the cap's condition is the caller's to absorb, not to handle.
 */
export class TerrainTileBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerrainTileBudgetError";
  }
}

export function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`TerrainTiles ${name} must be finite.`);
  return value;
}

export function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new Error(`TerrainTiles ${name} must be greater than zero.`);
  return value;
}

export function integerAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum)
    throw new Error(`TerrainTiles ${name} must be an integer of at least ${minimum}.`);
  return value;
}

export function keyFor(tileX: number, tileZ: number): string {
  return `${String(tileX)}:${String(tileZ)}`;
}

export function lodLevelForDistance(distance: number, thresholds: readonly number[]): number {
  let level = 0;
  for (const threshold of thresholds) {
    if (distance < threshold) break;
    level += 1;
  }
  return level;
}

export function resolutionFor(tileResolution: number, factor: number): number {
  const cells = (tileResolution - 1) / factor;
  if (!Number.isInteger(cells))
    throw new Error("TerrainTiles tileResolution minus one must divide every lod factor.");
  return cells + 1;
}

export function morphBytes(resolution: number, targets: number): number {
  const vertices = resolution * resolution + resolution * 4;
  // Stock Three packs both vec3 deltas into RGBA32F: retain its CPU texture and GPU copy too.
  const texels = vertices * 2;
  // Any row width pads to < 2 * texels; admission precedes renderer-limit discovery.
  const packedTexels = texels * 2;
  return targets * (vertices * 3 * 4 * 2 + packedTexels * 4 * 4 * 2);
}

export function estimatedLevelBytes(resolution: number, targets = 0): number {
  const vertices = resolution * resolution + resolution * 4;
  const triangles = (resolution - 1) * (resolution - 1) + (resolution - 1) * 4;
  const edgeSampleBytes = resolution * 4 * Float32Array.BYTES_PER_ELEMENT;
  return (
    vertices * 3 * Float32Array.BYTES_PER_ELEMENT * 2 +
    triangles * 6 * Uint32Array.BYTES_PER_ELEMENT +
    edgeSampleBytes +
    morphBytes(resolution, targets)
  );
}

export function estimatedFieldBytes(
  tileResolution: number,
  worldPasses: IHeightfieldWorldPassOptions | undefined,
): number {
  const sampleBytes = tileResolution * tileResolution * Float32Array.BYTES_PER_ELEMENT;
  if (worldPasses === undefined) return sampleBytes * 2;
  // The GPU path retains the canonical/collider values plus several ping-pong storage buffers.
  // Admission is deliberately conservative so backend allocation overhead cannot break the cap.
  return sampleBytes * (worldPasses.gpu === false ? 4 : 24);
}

export function estimatedTileBytes(
  tileResolution: number,
  factors: readonly number[],
  worldPasses: IHeightfieldWorldPassOptions | undefined,
  validate: boolean,
): number {
  return factors.reduce(
    (total, factor) =>
      total +
      estimatedLevelBytes(
        resolutionFor(tileResolution, factor),
        validate ? 0 : factors.filter((candidate) => candidate >= factor).length - 1,
      ),
    estimatedFieldBytes(tileResolution, worldPasses),
  );
}

export function tiledObservationResolution(
  extent: number,
  tileSize: number,
  tileResolution: number,
  axis: string,
): number {
  const tileCount = extent / tileSize;
  if (!Number.isInteger(tileCount) || tileCount < 1)
    throw new Error(
      `TerrainTiles topologyObservation ${axis} must cover a positive whole number of rendered tiles.`,
    );
  return tileCount * (tileResolution - 1) + 1;
}

export function validateTopologyObservation(
  observation: IWorldTilesTopologyObservation,
  tileSize: number,
  tileResolution: number,
): void {
  const expectedColumns = tiledObservationResolution(
    observation.width,
    tileSize,
    tileResolution,
    "width",
  );
  const expectedRows = tiledObservationResolution(
    observation.depth,
    tileSize,
    tileResolution,
    "depth",
  );
  if (observation.columns !== expectedColumns)
    throw new Error(
      `TerrainTiles topologyObservation columns must match the rendered tile grid (expected ${String(expectedColumns)}, received ${String(observation.columns)}).`,
    );
  if (observation.rows !== expectedRows)
    throw new Error(
      `TerrainTiles topologyObservation rows must match the rendered tile grid (expected ${String(expectedRows)}, received ${String(observation.rows)}).`,
    );
}

export function edgeSamplesFor(values: readonly number[], resolution: number): IEdgeSamples {
  const north = new Float32Array(resolution);
  const south = new Float32Array(resolution);
  const west = new Float32Array(resolution);
  const east = new Float32Array(resolution);
  for (let index = 0; index < resolution; index += 1) {
    north[index] = values[index] as number;
    south[index] = values[(resolution - 1) * resolution + index] as number;
    west[index] = values[index * resolution] as number;
    east[index] = values[index * resolution + resolution - 1] as number;
  }
  return { east, north, south, west };
}

/**
 * Apply a job's result, whenever it arrives. An inline host resolves inside the call, so the caller
 * keeps the synchronous shape it always had; a worker host applies in its reply. A reply that throws
 * rejects the promise instead of returning, so a budget overflow off this thread is a loud failure
 * rather than a swallowed one.
 */
export function settleJob<T>(result: T | Promise<T>, apply: (value: T) => void): void {
  if (result instanceof Promise) result.then(apply);
  else apply(result);
}

/**
 * Runs one unit of main-thread terrain work and charges it to a frame span.
 *
 * Added, not bracketed: a worker host's block swap arrives in a job reply and an inline host's runs
 * inside the same `follow`, so `begin`/`end` at both call sites would nest and count one unit twice.
 * `addSpan` accumulates whatever runs on this thread with no nesting to get wrong, and costs one
 * guarded return when spans are off — no clock read, no allocation. The frame-span table's
 * `TN_FRAME_SPANS` report is where the number surfaces; nothing here decides anything.
 */
export function timedSpan<T>(id: SpanId, run: () => T): T {
  if (spanRecorder() === undefined) return run();
  const start = spanNow();
  try {
    return run();
  } finally {
    addSpan(id, spanNow() - start);
  }
}
