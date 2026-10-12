import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  LOD,
  type Matrix4,
  Mesh,
  Object3D,
  Sphere,
  Vector3,
} from "three";
import type { InterleavedBufferAttribute } from "three";
import type { IAssetLoader } from "./assets.js";
import type { IComputeDriven } from "./compute-driven.js";
import { SPANS, type SpanId, addSpan, spanNow, spanRecorder } from "./profiling/Spans.js";
import type { IRendererLike } from "./renderer.js";
import {
  type ITerrainBridgeAttributes,
  type ITerrainEdgeFrame,
  type ITerrainEdgeJob,
  type ITerrainFineEdgeJob,
  type ITerrainJobRunner,
  type ITerrainMergeJob,
  type ITerrainMergeResult,
  type ITerrainSeamJob,
  createTerrainJobRunner,
  edgeWorldPoint,
} from "./terrain-jobs.js";
import { summarizeWorldTopology } from "./world-topology.js";
import { terrainValidationRequested } from "./world-validate.js";
import {
  Heightfield,
  type IHeightfieldOrigin,
  type IHeightfieldSamplerOptions,
  type IHeightfieldWorldPassOptions,
} from "./world.js";

type MeshSurface = NonNullable<ConstructorParameters<typeof Mesh>[1]>;

export interface IWorldTileCollider {
  dispose(): void;
}

export interface IWorldTileColliderInput {
  readonly field: Heightfield;
  readonly key: string;
  readonly object: Object3D;
  readonly tileX: number;
  readonly tileZ: number;
}

/**
 * One frame's allowance for admission work — the millisecond budget every path that puts streamed
 * content on screen draws on, spent in bounded units rather than in one lump.
 *
 * `admit` is the whole contract: run one unit and charge the frame for it, or report that there was
 * no room and run nothing. A caller that is refused leaves the work for a later frame instead of
 * dropping it, so the budget decides *when* content is admitted, never *whether*.
 *
 * Nothing here decides what anything looks like; it decides only how much of it a frame may pay for.
 */
export interface IAdmissionBudget {
  /**
   * Run one unit of admission work, charging the frame's budget for it. `false` means the budget
   * was spent and `work` was never called, so the caller must stop and resume on a later frame.
   */
  admit(work: () => void): boolean;
}

export interface IWorldTile {
  readonly bytes: number;
  /** `undefined` for a resident tile outside `colliderRadius`, or when no factory was given. */
  readonly collider: IWorldTileCollider | undefined;
  readonly field: Heightfield;
  readonly key: string;
  readonly lod: LOD;
  readonly lodLevel: number;
  readonly object: Object3D;
  readonly skirtVertexCount: number;
  readonly tileX: number;
  readonly tileZ: number;
}

export interface IWorldTilesFollowPosition {
  readonly x: number;
  readonly z: number;
}

export interface IWorldTilesTopologyObservation {
  readonly columns: number;
  readonly depth: number;
  readonly origin: IHeightfieldOrigin;
  readonly rows: number;
  readonly width: number;
}

export interface IWorldTilesOptions {
  /** Releases a caller-supplied model key when its last tile reference is evicted. */
  readonly assets?: Pick<IAssetLoader, "release">;
  /** A game-owned, already-loaded logical model key, or a key resolver per tile. */
  readonly assetKey?: string | ((tileX: number, tileZ: number) => string);
  /**
   * Chebyshev radius, in tiles from the followed one, that gets a `createCollider` body. Defaults
   * to `streamRadius`, so every resident tile collides. A smaller radius keeps a wide render ring
   * cheap to simulate: a tile crossing the radius has its collider created or disposed as it goes.
   */
  readonly colliderRadius?: number;
  /** Terrain tiles and seam bridges receive the scene's shadows. Default false. */
  readonly receiveShadow?: boolean;
  /** Creates the physics body from the field's explicit collider-order copy. */
  readonly createCollider?: (input: IWorldTileColliderInput) => IWorldTileCollider;
  /** TSL pass options are game supplied and are forwarded to each resident field. */
  readonly worldPasses?: IHeightfieldWorldPassOptions;
  /** Game-owned surface; this class never creates or mutates it. */
  readonly surface: MeshSurface;
  readonly residentByteBudget: number;
  readonly residentTileBudget: number;
  readonly sampleHeight: IHeightfieldSamplerOptions["sampleHeight"];
  /** How deep each edge skirt extends below its surface. Defaults to one tile width. */
  readonly skirtDepth?: number;
  /** Square tile neighborhood to consider around the followed point. Defaults to 1. */
  readonly streamRadius?: number;
  readonly tileResolution: number;
  readonly tileSize: number;
  /** Vertex decimation factors. Defaults to 1, 2, and 4 over the same field. */
  readonly lodFactors?: readonly number[];
  /** Distances in world units at which the next LOD becomes active. */
  readonly lodDistances?: readonly number[];
  /**
   * Re-derive the terrain every frame and assert it: a finiteness scan of every rendered vertex,
   * a seam measurement per resident pair and an LOD pop sample per blending tile. Off by default
   * because it is a measurement and it cost ~270 ms over a six-second walk on a 289-tile ring.
   * `TN_TERRAIN_VALIDATE=1` or `?tnTerrainValidate=1` turns it on for a run; this overrides that.
   */
  readonly validate?: boolean;
  /**
   * Merge settled same-LOD terrain tiles into super-tiles: one mesh per K×K block, one block rebuilt
   * per frame. It changes how many draws the main pass submits, never how the ground looks — a merged
   * vertex lands on the world position its tile's vertex did, on the same game-owned `surface`.
   *
   * On by default, like `validate`'s measurements are off by default only because they cost a
   * measurement a frame. `mergeTiles: false`, `?tnTerrainMerge=0` or `TN_TERRAIN_MERGE=0` turns it
   * off for a run. A block's bytes are reported as `terrainTiles.blockBytes` and are never charged to
   * `residentByteBudget`, so the merge changes draws and no tile the budget would admit without it.
   */
  readonly mergeTiles?: boolean;
  /** Explicit game-owned measurement region used by the topology evaluator. */
  readonly topologyObservation?: IWorldTilesTopologyObservation;
}

interface ILevelGeometry {
  readonly edgeSamples: IEdgeSamples;
  readonly geometry: BufferGeometry;
  readonly mesh: Mesh;
  readonly resolution: number;
  readonly skirtDepth: number;
  readonly skirtVertexCount: number;
}

interface IEdgeSamples {
  readonly east: Float32Array;
  readonly north: Float32Array;
  readonly south: Float32Array;
  readonly west: Float32Array;
}

interface IResidentTile extends Omit<IWorldTile, "lodLevel"> {
  readonly assetKey?: string;
  collider: IWorldTileCollider | undefined;
  readonly levels: readonly ILevelGeometry[];
  lodTransition?: ILodTransition;
  lodLevel: number;
  /** Coarsest level whose height error against every finer level stays inside the pop bound. */
  readonly maxLodLevel: number;
  readonly origin: IHeightfieldOrigin;
  readonly skirts: number;
}

interface ILodTransition {
  readonly from: number;
  readonly to: number;
  elapsedFrames: number;
  remainingFrames: number;
}

interface IStitchBridge {
  readonly keys: readonly [string, string];
  geometry: BufferGeometry;
  readonly mesh: Mesh;
  resolution: number;
  coverageDepth: number;
  bytes: number;
}

interface ILodFrameSnapshot {
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly tile: IResidentTile;
}

/** One super-tile: a same-LOD block's settled level geometries held as a single draw. */
interface IMergedBlock {
  readonly key: string;
  readonly lod: number;
  readonly geometry: BufferGeometry;
  readonly mesh: Mesh;
  /** This block's own geometry bytes, reported through `terrainTiles.blockBytes`. */
  bytes: number;
  /** The tile keys whose current level geometry this block holds, kept equal to what its geometry
   * actually holds: a record the geometry has moved past double-draws the tiles that left and hides
   * the ones that joined. */
  members: Set<string>;
}

/**
 * A pair's observed seam state, one per coverage mode, and the observation pass that last saw each
 * of them. Both modes live in one record so a pass marks what it visited and prunes what it did
 * not without building a `${key}|coverage` string and a Set of them for every resident pair.
 */
interface ISeamObservation {
  coverage: number[] | undefined;
  plain: number[] | undefined;
  seenCoverage: number;
  seenPlain: number;
}

const MAX_RAW_TOPOLOGY_SAMPLES = 10_000;
const LOD_POP_THRESHOLD = 16;
const LOD_TRANSITION_FRAMES = 3;
/** Maximum sampled vertices or quads in one terrain-construction admission unit. */
const CONSTRUCTION_CHUNK_SAMPLES = 256;
/** Tiles per side in a merged super-tile block. Small, because a block is culled as one object. */
const TERRAIN_MERGE_BLOCK = 4;
const TERRAIN_MERGE_FLAG = "TN_TERRAIN_MERGE";
const TERRAIN_TILE_MARKER_MS = 5_000;
const BRIDGE_COORDINATE_EPSILON = 1e-4;

/**
 * Whether this launch asked for terrain tile merging to be turned off.
 *
 * The merge is on by default, so this only has to hear the three ways every other launch switch is
 * read: a native launch sets the environment variable, a browser asks with the query string, and a
 * test or harness sets the global. Only `0` and `false` count, so a URL that never mentioned the
 * switch — or one that still carries the `=1` that used to ask for the merge — stays on.
 */
function terrainMergeOptedOut(): boolean {
  const host = globalThis as { process?: { env?: Record<string, unknown> } } & Record<
    string,
    unknown
  >;
  const fromEnv = host.process?.env?.[TERRAIN_MERGE_FLAG];
  if (fromEnv === "0" || fromEnv === "false") return true;
  const query = globalThis.location?.search;
  if (typeof query === "string" && /[?&]tnTerrainMerge=(?:0|false)(?:&|$)/u.test(query))
    return true;
  return (
    host.__tnTerrainMerge === false || host.__tnTerrainMerge === 0 || host.__tnTerrainMerge === "0"
  );
}

/** A block's key: its LOD tier and which K×K cell of the tile grid it covers. */
function blockKeyFor(lod: number, tileX: number, tileZ: number): string {
  return `${String(lod)}:${String(Math.floor(tileX / TERRAIN_MERGE_BLOCK))},${String(
    Math.floor(tileZ / TERRAIN_MERGE_BLOCK),
  )}`;
}

function blockCoordinates(key: string): { lod: number; blockX: number; blockZ: number } {
  const separator = key.indexOf(":");
  const comma = key.indexOf(",", separator + 1);
  return {
    lod: Number(key.slice(0, separator)),
    blockX: Number(key.slice(separator + 1, comma)),
    blockZ: Number(key.slice(comma + 1)),
  };
}
const BRIDGE_COORDINATE_RELATIVE_EPSILON = 2 ** -22;
const BRIDGE_STRIP_INDEX_PATTERN = [0, 1, 2, 2, 1, 3, 2, 1, 0, 3, 1, 2] as const;
type PositionAttribute = BufferAttribute | InterleavedBufferAttribute;

function bridgeCoordinateMatches(actual: number, expected: number): boolean {
  return (
    Math.abs(actual - expected) <=
    Math.max(
      BRIDGE_COORDINATE_EPSILON,
      Math.max(1, Math.abs(actual), Math.abs(expected)) * BRIDGE_COORDINATE_RELATIVE_EPSILON,
    )
  );
}

class EmptyCollider implements IWorldTileCollider {
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

function finite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`TerrainTiles ${name} must be finite.`);
  return value;
}

function positive(value: number, name: string): number {
  finite(value, name);
  if (value <= 0) throw new Error(`TerrainTiles ${name} must be greater than zero.`);
  return value;
}

function integerAtLeast(value: number, minimum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum)
    throw new Error(`TerrainTiles ${name} must be an integer of at least ${minimum}.`);
  return value;
}

function keyFor(tileX: number, tileZ: number): string {
  return `${String(tileX)}:${String(tileZ)}`;
}

function lodLevelForDistance(distance: number, thresholds: readonly number[]): number {
  let level = 0;
  for (const threshold of thresholds) {
    if (distance < threshold) break;
    level += 1;
  }
  return level;
}

function resolutionFor(tileResolution: number, factor: number): number {
  const cells = (tileResolution - 1) / factor;
  if (!Number.isInteger(cells))
    throw new Error("TerrainTiles tileResolution minus one must divide every lod factor.");
  return cells + 1;
}

function estimatedLevelBytes(resolution: number): number {
  const vertices = resolution * resolution + resolution * 4;
  const triangles = (resolution - 1) * (resolution - 1) + (resolution - 1) * 4;
  const edgeSampleBytes = resolution * 4 * Float32Array.BYTES_PER_ELEMENT;
  return (
    vertices * 3 * Float32Array.BYTES_PER_ELEMENT * 2 +
    triangles * 6 * Uint32Array.BYTES_PER_ELEMENT +
    edgeSampleBytes
  );
}

function estimatedFieldBytes(
  tileResolution: number,
  worldPasses: IHeightfieldWorldPassOptions | undefined,
): number {
  const sampleBytes = tileResolution * tileResolution * Float32Array.BYTES_PER_ELEMENT;
  if (worldPasses === undefined) return sampleBytes * 2;
  // The GPU path retains the canonical/collider values plus several ping-pong storage buffers.
  // Admission is deliberately conservative so backend allocation overhead cannot break the cap.
  return sampleBytes * (worldPasses.gpu === false ? 4 : 24);
}

function estimatedTileBytes(
  tileResolution: number,
  factors: readonly number[],
  worldPasses: IHeightfieldWorldPassOptions | undefined,
): number {
  return factors.reduce(
    (total, factor) => total + estimatedLevelBytes(resolutionFor(tileResolution, factor)),
    estimatedFieldBytes(tileResolution, worldPasses),
  );
}

function tiledObservationResolution(
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

function validateTopologyObservation(
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

function edgeSamplesFor(values: readonly number[], resolution: number): IEdgeSamples {
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

/** One field's own rectangle and side, which is all a world point along an edge needs. */
function tileEdgeFrame(field: Heightfield, side: keyof IEdgeSamples): ITerrainEdgeFrame {
  return { depth: field.depth, origin: field.origin, side, width: field.width };
}

/**
 * Apply a job's result, whenever it arrives. An inline host resolves inside the call, so the caller
 * keeps the synchronous shape it always had; a worker host applies in its reply. A reply that throws
 * rejects the promise instead of returning, so a budget overflow off this thread is a loud failure
 * rather than a swallowed one.
 */
function settleJob<T>(result: T | Promise<T>, apply: (value: T) => void): void {
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
function timedSpan<T>(id: SpanId, run: () => T): T {
  if (spanRecorder() === undefined) return run();
  const start = spanNow();
  try {
    return run();
  } finally {
    addSpan(id, spanNow() - start);
  }
}

function edgeVertexIndex(level: ILevelGeometry, side: keyof IEdgeSamples, index: number): number {
  const row = side === "north" ? 0 : side === "south" ? level.resolution - 1 : index;
  const column = side === "west" ? 0 : side === "east" ? level.resolution - 1 : index;
  return row * level.resolution + column;
}

function appendQuad(
  indices: number[],
  topLeft: number,
  bottomLeft: number,
  topRight: number,
  bottomRight: number,
): void {
  indices.push(topLeft, bottomLeft, topRight, topRight, bottomLeft, bottomRight);
}

/**
 * The field's own sample heights, once, with a ring of clamped neighbours around them.
 *
 * `normalAt` reads the height at the point and at its four field-cell neighbours, so a level built
 * vertex by vertex asked the field six times per vertex — 33,800 `heightAt` calls for a 65x65 tile
 * and every coarser level with it (46 ms + 46 ms a streaming frame). This is the same set of samples
 * read once, and the ring repeats the edge sample, which is exactly the clamp `normalAt` applies at
 * the field's own border. One grid serves every level of the tile, because a level's vertices are
 * every `lodFactor`-th of the field's.
 */
function* fieldHeightGrid(field: Heightfield, chunked: boolean): Generator<void, Float32Array> {
  const columns = field.columns + 2;
  const cellWidth = field.width / (field.columns - 1);
  const cellDepth = field.depth / (field.rows - 1);
  const minimumX = field.origin.x - field.width / 2;
  const minimumZ = field.origin.z - field.depth / 2;
  const grid = new Float32Array(columns * (field.rows + 2));
  for (let row = 0; row < field.rows + 2; row += 1) {
    const z = minimumZ + Math.min(field.rows - 1, Math.max(0, row - 1)) * cellDepth;
    for (let column = 0; column < columns; column += 1) {
      const x = minimumX + Math.min(field.columns - 1, Math.max(0, column - 1)) * cellWidth;
      grid[row * columns + column] = field.heightAt(x, z);
      if (chunked && (row * columns + column + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
    }
  }
  return grid;
}

/**
 * How many field samples a level's vertices are apart. An integer by `resolutionFor`'s own check,
 * and the reason one grid serves every level: vertex column `n` sits on field sample `n * step`.
 */
function fieldStep(field: Heightfield, resolution: number): number {
  const step = (field.columns - 1) / (resolution - 1);
  if (!Number.isInteger(step) || step < 1)
    throw new Error("TerrainTiles level vertices must land on the field's own sample grid.");
  return step;
}

/**
 * Tags a mesh as terrain, so the frame budget counts its main-pass draw under `terrain` instead of
 * under the `other` every mesh no world system claimed lands in. Every mesh this file creates goes
 * through here — a tile level, a stitch bridge and a merged block — because a source that is tagged
 * at three of the four places it exists is a split nobody can reconcile.
 */
function terrainMesh(mesh: Mesh): Mesh {
  mesh.userData.tnDrawSource = "terrain";
  // Visibility only swaps this mesh with a twin over the same ground (its merged block, or the
  // neighbouring LOD level), so a cached shadow map need not redraw for it; see `casterFlag`.
  mesh.userData.tnShadowSwap = true;
  return mesh;
}

/** Three's box/sphere arithmetic, over the same float32 positions, in admission-sized scans. */
function* levelBounds(
  positions: Float32Array,
  chunked: boolean,
): Generator<void, { box: Box3; sphere: Sphere }> {
  const box = new Box3();
  const point = new Vector3();
  for (let index = 0; index < positions.length; index += 3) {
    point.fromArray(positions, index);
    box.expandByPoint(point);
    if (chunked && (index / 3 + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
  }
  const sphere = new Sphere();
  box.getCenter(sphere.center);
  let radiusSquared = 0;
  for (let index = 0; index < positions.length; index += 3) {
    point.fromArray(positions, index);
    radiusSquared = Math.max(radiusSquared, sphere.center.distanceToSquared(point));
    if (chunked && (index / 3 + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
  }
  sphere.radius = Math.sqrt(radiusSquared);
  return { box, sphere };
}

function* buildLevel(
  field: Heightfield,
  resolution: number,
  skirtDepth: number,
  surface: MeshSurface,
  grid: Float32Array,
  chunked: boolean,
): Generator<void, ILevelGeometry> {
  const positions: number[] = [];
  const normals: number[] = [];
  const heights: number[] = [];
  const minimumX = field.origin.x - field.width / 2;
  const minimumZ = field.origin.z - field.depth / 2;
  const cellWidth = field.width / (resolution - 1);
  const cellDepth = field.depth / (resolution - 1);
  const fieldCellWidth = field.width / (field.columns - 1);
  const fieldCellDepth = field.depth / (field.rows - 1);
  const gridColumns = field.columns + 2;
  const step = fieldStep(field, resolution);
  const normal = new Vector3();
  for (let row = 0; row < resolution; row += 1) {
    const z = minimumZ + row * cellDepth;
    const fieldRow = row * step;
    const gridRow = fieldRow + 1;
    for (let column = 0; column < resolution; column += 1) {
      const x = minimumX + column * cellWidth;
      const fieldColumn = column * step;
      const at = gridRow * gridColumns + fieldColumn + 1;
      const height = grid[at] as number;
      heights.push(height);
      positions.push(x - field.origin.x, height, z - field.origin.z);
      // `normalAt`'s stencil, off the same grid: a field cell either side, clamped at the border,
      // over the distance those two samples really are apart.
      const column0 = Math.min(field.columns - 1, Math.max(0, fieldColumn - 1));
      const column1 = Math.min(field.columns - 1, fieldColumn + 1);
      const row0 = Math.min(field.rows - 1, Math.max(0, fieldRow - 1));
      const row1 = Math.min(field.rows - 1, fieldRow + 1);
      const slopeX =
        ((grid[gridRow * gridColumns + column1 + 1] as number) -
          (grid[gridRow * gridColumns + column0 + 1] as number)) /
        ((column1 - column0) * fieldCellWidth);
      const slopeZ =
        ((grid[(row1 + 1) * gridColumns + fieldColumn + 1] as number) -
          (grid[(row0 + 1) * gridColumns + fieldColumn + 1] as number)) /
        ((row1 - row0) * fieldCellDepth);
      normal.set(-slopeX, 1, -slopeZ).normalize();
      normals.push(normal.x, normal.y, normal.z);
      if (chunked && (row * resolution + column + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
    }
  }
  const indices: number[] = [];
  for (let row = 0; row < resolution - 1; row += 1) {
    for (let column = 0; column < resolution - 1; column += 1) {
      const topLeft = row * resolution + column;
      appendQuad(indices, topLeft, topLeft + resolution, topLeft + 1, topLeft + resolution + 1);
      if (chunked && (row * (resolution - 1) + column + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0)
        yield;
    }
  }

  const edges = [
    (index: number) => index,
    (index: number) => (resolution - 1) * resolution + index,
    (index: number) => index * resolution,
    (index: number) => index * resolution + resolution - 1,
  ];
  for (const edge of edges) {
    const bottom = positions.length / 3;
    for (let index = 0; index < resolution; index += 1) {
      const top = edge(index);
      positions.push(
        positions[top * 3] as number,
        (positions[top * 3 + 1] as number) - skirtDepth,
        positions[top * 3 + 2] as number,
      );
      normals.push(0, 1, 0);
    }
    for (let index = 0; index < resolution - 1; index += 1) {
      const topLeft = edge(index);
      const topRight = edge(index + 1);
      appendQuad(indices, topLeft, bottom + index, topRight, bottom + index + 1);
    }
  }

  const positionArray = Float32Array.from(positions);
  const bounds = yield* levelBounds(positionArray, chunked);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positionArray, 3));
  geometry.setAttribute("normal", new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
  geometry.boundingBox = bounds.box;
  geometry.boundingSphere = bounds.sphere;
  const skirt = inspectSkirtGeometry(geometry, resolution, edges);
  return {
    edgeSamples: edgeSamplesFor(heights, resolution),
    geometry,
    mesh: terrainMesh(new Mesh(geometry, surface)),
    resolution,
    skirtDepth: skirt.depth,
    skirtVertexCount: skirt.vertexCount,
  };
}

/**
 * A block's merged attributes, as the geometry the main thread swaps in. The concatenation itself
 * is `mergeBlockAttributes`, which runs in a worker wherever a host has one; this is the part that
 * cannot leave the main thread — a `BufferGeometry` and its bounds.
 */
function mergedBlockGeometry(result: ITerrainMergeResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(result.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(result.normals, 3));
  geometry.setIndex(new BufferAttribute(result.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One settled tile level's attributes, as the merge job reads them. */
function mergeJob(
  parts: readonly { readonly geometry: BufferGeometry; readonly origin: IHeightfieldOrigin }[],
  blockOrigin: IHeightfieldOrigin,
): ITerrainMergeJob {
  return {
    blockOrigin,
    kind: "merge",
    parts: parts.map(({ geometry, origin }) => {
      const index = geometry.getIndex();
      if (index === null)
        throw new Error("TerrainTiles merged block geometry needs an index buffer.");
      return {
        indices: index.array as Uint32Array,
        normals: (geometry.getAttribute("normal") as BufferAttribute).array as Float32Array,
        origin,
        positions: (geometry.getAttribute("position") as BufferAttribute).array as Float32Array,
      };
    }),
  };
}

function inspectSkirtGeometry(
  geometry: BufferGeometry,
  resolution: number,
  edges: readonly ((index: number) => number)[],
): { depth: number; vertexCount: number } {
  const position = geometry.getAttribute("position");
  const surfaceVertexCount = resolution * resolution;
  const vertexCount = position.count - surfaceVertexCount;
  if (vertexCount < 0 || vertexCount % edges.length !== 0)
    throw new Error("TerrainTiles generated skirt geometry has an invalid vertex count.");
  if (vertexCount === 0) return { depth: 0, vertexCount: 0 };
  const edgeVertexCount = vertexCount / edges.length;
  let depth = Number.POSITIVE_INFINITY;
  for (const [edgeIndex, edge] of edges.entries()) {
    for (let index = 0; index < edgeVertexCount; index += 1) {
      const top = edge(index);
      const bottom = surfaceVertexCount + edgeIndex * edgeVertexCount + index;
      depth = Math.min(depth, position.getY(top) - position.getY(bottom));
    }
  }
  if (!Number.isFinite(depth) || depth < 0)
    throw new Error("TerrainTiles generated skirt geometry has an invalid depth.");
  return { depth, vertexCount };
}

function opposingEdge(
  a: IResidentTile,
  b: IResidentTile,
): [keyof IEdgeSamples, keyof IEdgeSamples] {
  if (a.tileX < b.tileX) return ["east", "west"];
  if (a.tileX > b.tileX) return ["west", "east"];
  if (a.tileZ < b.tileZ) return ["south", "north"];
  return ["north", "south"];
}

function renderedLevel(tile: IResidentTile): ILevelGeometry | undefined {
  return tile.levels.find(({ mesh }) => mesh.visible) ?? tile.levels[tile.lodLevel];
}

/**
 * An attribute's vertex count while every component it draws is finite, `NaN` once one is not.
 * Every writer this package owns goes through `needsUpdate`, which bumps `version`, so a version
 * alone cannot see a writer that reached past the attribute — and `NaN` never compares equal to the
 * finite state the last reconcile recorded, so a settled seam still fails closed on it. The scan is
 * the cost of that, against the per-sample walk it keeps off a settled frame, so it is validation:
 * with `validate` off the count alone is compared, and a writer that reached past `needsUpdate`
 * leaves a geometry the next reconcile reads the same way it always did.
 */
function positionFingerprint(position: BufferAttribute | undefined, validate: boolean): number {
  if (position === undefined) return -1;
  if (!validate) return position.count;
  const values = position.array;
  for (let index = 0; index < values.length; index += 1)
    if (!Number.isFinite(values[index])) return Number.NaN;
  return position.count;
}

/**
 * What a pair's seam was reconciled against: each side's rendered level, its buffers and where its
 * mesh sits. Every writer to a level sets `needsUpdate`, which bumps the version, so an unchanged
 * state means neither facing edge can have moved since — and an edge is sampled through
 * `level.mesh.matrixWorld`, so a level mesh moved from outside changed what the observation reads
 * without touching a single version. Its own transform is what that matrix composes from, and it is
 * what any outside writer moves: an ancestor of it is either the tiles group, whose own movement the
 * bridge state already observes, or the LOD this package owns and never moves, and a seam exists
 * only where a bridge is. Numbers, not a string, and pushed rather than returned: this runs for
 * every resident pair every frame (544 pairs on a 289-tile ring) into a reused buffer, and the
 * intermediate array per level and per bridge was itself the cost the settled ring was measured on.
 */
function pushLevelState(state: number[], level: ILevelGeometry): void {
  const geometry = level.geometry;
  const { mesh } = level;
  state.push(
    geometry.id,
    (geometry.getAttribute("position") as BufferAttribute).version,
    (geometry.getAttribute("normal") as BufferAttribute).version,
    mesh.position.x,
    mesh.position.y,
    mesh.position.z,
    mesh.quaternion.x,
    mesh.quaternion.y,
    mesh.quaternion.z,
    mesh.quaternion.w,
    mesh.scale.x,
    mesh.scale.y,
    mesh.scale.z,
  );
}

/** Whether both sides of a pair have a rendered level, which is what its state needs to exist. */
function pushPairState(state: number[], pair: NeighborPair): boolean {
  const aLevel = renderedLevel(pair[0]);
  const bLevel = renderedLevel(pair[1]);
  if (aLevel === undefined || bLevel === undefined) return false;
  pushLevelState(state, aLevel);
  pushLevelState(state, bLevel);
  return true;
}

/**
 * Everything a seam observation reads: the pair's state plus the bridge's placement, parent, draw
 * range and buffers. A diagnostic exists to catch a bridge moved, detached, emptied or rewritten,
 * so each of those has to change this state and force a fresh observation.
 */
function pushBridgeState(state: number[], bridge: IStitchBridge, validate: boolean): void {
  const { mesh } = bridge;
  // The mesh's own geometry rather than the record's: a bridge retargeted to foreign geometry reads
  // perfectly well from the record, and `bridgeCoverageContext` is the only thing that rejects it.
  const geometry = mesh.geometry;
  const position = geometry.getAttribute("position") as BufferAttribute | undefined;
  const normal = geometry.getAttribute("normal") as BufferAttribute | undefined;
  const index = geometry.getIndex();
  mesh.updateMatrixWorld();
  state.push(mesh.id, mesh.parent?.id ?? -1, mesh.visible ? 1 : 0);
  const elements = mesh.matrixWorld.elements;
  for (let element = 0; element < elements.length; element += 1)
    state.push(elements[element] as number);
  state.push(
    geometry.id,
    position?.version ?? -1,
    positionFingerprint(position, validate),
    normal?.id ?? -1,
    index?.id ?? -1,
    index?.version ?? -1,
    geometry.drawRange.start,
    geometry.drawRange.count,
  );
}

function seamState(
  pair: NeighborPair,
  bridge: IStitchBridge | undefined,
  validate: boolean,
): number[] | undefined {
  const state: number[] = [];
  if (!pushPairState(state, pair)) return undefined;
  if (bridge !== undefined) pushBridgeState(state, bridge, validate);
  return state;
}

function sameState(a: readonly number[] | undefined, b: readonly number[] | undefined): boolean {
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function edgeVertexHeight(level: ILevelGeometry, side: keyof IEdgeSamples, index: number): number {
  const value = level.geometry.getAttribute("position").getY(edgeVertexIndex(level, side, index));
  if (!Number.isFinite(value))
    throw new Error("TerrainTiles seam diagnostic edge height must be finite.");
  return value;
}

function edgeWorldVertexHeight(
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
  index: number,
  target: Vector3,
): number {
  const position = level.geometry.getAttribute("position");
  const vertex = edgeVertexIndex(level, side, index);
  const localX = position.getX(vertex);
  const localY = position.getY(vertex);
  const localZ = position.getZ(vertex);
  if (!Number.isFinite(localX) || !Number.isFinite(localY) || !Number.isFinite(localZ))
    throw new Error("TerrainTiles seam diagnostic bridge coordinates must be finite.");
  target.set(localX, localY, localZ).applyMatrix4(level.mesh.matrixWorld);
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z))
    throw new Error("TerrainTiles seam diagnostic bridge world coordinates must be finite.");
  return target.y;
}

function edgeWorldHeight(
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
  normalized: number,
  target: Vector3,
): number {
  const position = Math.max(0, Math.min(1, normalized)) * (level.resolution - 1);
  const lower = Math.floor(position);
  const upper = Math.min(level.resolution - 1, lower + 1);
  const mix = position - lower;
  return (
    edgeWorldVertexHeight(level, side, lower, target) * (1 - mix) +
    edgeWorldVertexHeight(level, side, upper, target) * mix
  );
}

function bridgeEndpointWorldHeight(
  position: PositionAttribute,
  matrixWorld: Matrix4,
  vertex: number,
  expectedX: number,
  expectedY: number,
  expectedZ: number,
  worldPosition: Vector3,
): number {
  const localX = position.getX(vertex);
  const localY = position.getY(vertex);
  const localZ = position.getZ(vertex);
  if (!Number.isFinite(localX) || !Number.isFinite(localY) || !Number.isFinite(localZ))
    throw new Error("TerrainTiles seam diagnostic bridge coordinates must be finite.");
  worldPosition.set(localX, localY, localZ).applyMatrix4(matrixWorld);
  if (
    !Number.isFinite(worldPosition.x) ||
    !Number.isFinite(worldPosition.y) ||
    !Number.isFinite(worldPosition.z)
  )
    throw new Error("TerrainTiles seam diagnostic bridge world coordinates must be finite.");
  if (
    !Number.isFinite(expectedX) ||
    !Number.isFinite(expectedY) ||
    !Number.isFinite(expectedZ) ||
    !bridgeCoordinateMatches(worldPosition.x, expectedX) ||
    !bridgeCoordinateMatches(worldPosition.y, expectedY) ||
    !bridgeCoordinateMatches(worldPosition.z, expectedZ)
  )
    throw new Error(
      "TerrainTiles seam diagnostic bridge topology does not match current neighboring edges.",
    );
  return worldPosition.y;
}

function bridgeEndpointHeight(
  bridge: IStitchBridge,
  position: PositionAttribute,
  sample: number,
  endpoint: number,
  tile: IResidentTile,
  side: keyof IEdgeSamples,
  level: ILevelGeometry,
  worldPosition: Vector3,
  expectedWorldPosition: Vector3,
): number {
  const sampleNormalized = sample / (bridge.resolution - 1);
  const [expectedX, , expectedZ] = edgeWorldPoint(
    tileEdgeFrame(tile.field, side),
    sampleNormalized,
    0,
  );
  const expectedY = edgeWorldHeight(level, side, sampleNormalized, expectedWorldPosition);
  return bridgeEndpointWorldHeight(
    position,
    bridge.mesh.matrixWorld,
    sample * 2 + endpoint,
    expectedX,
    expectedY,
    expectedZ,
    worldPosition,
  );
}

interface IBridgeEndpoint {
  readonly level: ILevelGeometry;
  readonly side: keyof IEdgeSamples;
  readonly tile: IResidentTile;
}

function bridgeEndpointPair(
  a: IResidentTile,
  aSide: keyof IEdgeSamples,
  b: IResidentTile,
  bSide: keyof IEdgeSamples,
): readonly [IBridgeEndpoint, IBridgeEndpoint] {
  const aLevel = renderedLevel(a);
  const bLevel = renderedLevel(b);
  if (aLevel === undefined || bLevel === undefined)
    throw new Error(
      "TerrainTiles seam diagnostic bridge topology has no rendered neighboring edge.",
    );
  const aEndpoint = { level: aLevel, side: aSide, tile: a };
  const bEndpoint = { level: bLevel, side: bSide, tile: b };
  return aLevel.resolution > bLevel.resolution ? [aEndpoint, bEndpoint] : [bEndpoint, aEndpoint];
}

function refreshEdgeSamples(level: ILevelGeometry): void {
  for (const side of ["east", "north", "south", "west"] as const) {
    const samples = level.edgeSamples[side];
    for (let index = 0; index < level.resolution; index += 1)
      samples[index] = edgeVertexHeight(level, side, index);
  }
}

/**
 * A level mid-blend already carries the union of both levels' bounds, widened once when the
 * transition started, and the canonical edge this writes is inside it. So the blend's three frames
 * restore the edge and leave the bounds alone: recomputing them walked the level's ~4,500
 * positions per seam per frame, which is the `setFromBufferAttribute` + `computeBoundingSphere` +
 * `computeBoundingBox` + `expandByPoint` the six-second walk spent inside a transition.
 */
function restoreLevelEdge(
  tile: IResidentTile,
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
): boolean {
  const field = tile.field;
  const position = level.geometry.getAttribute("position");
  const normalAttribute = level.geometry.getAttribute("normal");
  const normal = new Vector3();
  const frame = tileEdgeFrame(field, side);
  let changed = false;
  for (let index = 0; index < level.resolution; index += 1) {
    const normalized = index / (level.resolution - 1);
    const [x, , z] = edgeWorldPoint(frame, normalized, 0);
    const vertex = edgeVertexIndex(level, side, index);
    // Compared at float32, the precision the attributes store: a float64 sample never equals its
    // stored copy, so an exact compare reported every edge changed on every call and recomputed
    // the whole tile's bounds per seam per frame (~39 ms/frame on a 25-tile ring).
    const height = Math.fround(field.heightAt(x, z));
    field.normalAt(x, z, normal);
    if (position.getY(vertex) !== height) {
      position.setY(vertex, height);
      changed = true;
    }
    if (
      normalAttribute.getX(vertex) !== Math.fround(normal.x) ||
      normalAttribute.getY(vertex) !== Math.fround(normal.y) ||
      normalAttribute.getZ(vertex) !== Math.fround(normal.z)
    ) {
      normalAttribute.setXYZ(vertex, normal.x, normal.y, normal.z);
      changed = true;
    }
  }
  if (!changed) return false;
  updateLevelSkirts(level);
  refreshEdgeSamples(level);
  position.needsUpdate = true;
  normalAttribute.needsUpdate = true;
  if (tile.lodTransition === undefined) {
    level.geometry.computeBoundingBox();
    level.geometry.computeBoundingSphere();
  }
  return true;
}

/** One level's edge as the bridge job reads it: the row's own heights, copied out of the level. */
function edgeJob(
  tile: IResidentTile,
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
): ITerrainEdgeJob {
  return {
    depth: tile.field.depth,
    origin: tile.field.origin,
    samples: level.edgeSamples[side].slice(),
    side,
    width: tile.field.width,
  };
}

/** The same edge with the resolution the fine side of a bridge needs. */
function fineEdgeJob(
  tile: IResidentTile,
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
): ITerrainFineEdgeJob {
  return { ...edgeJob(tile, level, side), resolution: level.resolution };
}

function stitchGeometry(data: ITerrainBridgeAttributes): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(data.normals, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function geometryBytes(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  return (
    geometry.getAttribute("position").array.byteLength +
    geometry.getAttribute("normal").array.byteLength +
    (index?.array.byteLength ?? 0)
  );
}

function validateBridgeTriangleTopology(
  geometry: BufferGeometry,
  expectedVertexCount?: number,
): PositionAttribute {
  const position = geometry.getAttribute("position");
  const index = geometry.getIndex();
  const drawRange = geometry.drawRange;
  const positionArray = position?.array;
  if (
    position === undefined ||
    position.itemSize !== 3 ||
    !Number.isInteger(position.count) ||
    position.count < 6 ||
    position.count % 2 !== 0 ||
    positionArray === undefined ||
    positionArray.length < position.count * position.itemSize ||
    (expectedVertexCount !== undefined && position.count !== expectedVertexCount) ||
    index === null ||
    index.itemSize !== 1 ||
    !Number.isInteger(index.count) ||
    index.array.length !== index.count ||
    !(index.array instanceof Uint16Array || index.array instanceof Uint32Array) ||
    !Number.isInteger(drawRange.start) ||
    drawRange.start !== 0 ||
    (drawRange.count !== Number.POSITIVE_INFINITY &&
      (!Number.isInteger(drawRange.count) ||
        drawRange.count < index.count ||
        drawRange.count % 3 !== 0))
  )
    throw new Error(
      "TerrainTiles seam diagnostic bridge topology has invalid rendered triangle data.",
    );
  const vertexCount = position.count;
  const stripResolution = vertexCount / 2;
  const expectedIndexCount = (stripResolution - 1) * BRIDGE_STRIP_INDEX_PATTERN.length;
  if (index.count !== expectedIndexCount)
    throw new Error(
      "TerrainTiles seam diagnostic bridge topology has invalid rendered triangle data.",
    );
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (
      !Number.isFinite(position.getX(vertex)) ||
      !Number.isFinite(position.getY(vertex)) ||
      !Number.isFinite(position.getZ(vertex))
    )
      throw new Error("TerrainTiles seam diagnostic bridge coordinates must be finite.");
  }
  for (let offset = 0; offset < index.count; offset += 1) {
    const segment = Math.floor(offset / BRIDGE_STRIP_INDEX_PATTERN.length);
    const pair = segment * 2;
    const expected =
      pair + (BRIDGE_STRIP_INDEX_PATTERN[offset % BRIDGE_STRIP_INDEX_PATTERN.length] as number);
    const vertex = index.getX(offset);
    if (vertex !== expected)
      throw new Error("TerrainTiles seam diagnostic bridge topology has invalid index data.");
  }
  return position;
}

function updateStitchBridge(bridge: IStitchBridge, data: ITerrainBridgeAttributes): void {
  const position = validateBridgeTriangleTopology(bridge.geometry, bridge.resolution * 2);
  if (bridge.resolution !== data.positions.length / 6) {
    const previous = bridge.geometry;
    bridge.geometry = stitchGeometry(data);
    bridge.mesh.geometry = bridge.geometry;
    bridge.resolution = data.positions.length / 6;
    bridge.bytes = geometryBytes(bridge.geometry);
    previous.dispose();
  } else {
    const normal = bridge.geometry.getAttribute("normal");
    const index = bridge.geometry.getIndex();
    if (
      normal === undefined ||
      normal.itemSize !== 3 ||
      normal.count !== position.count ||
      index === null
    )
      throw new Error(
        "TerrainTiles seam diagnostic bridge topology has invalid rendered triangle data.",
      );
    position.array.set(data.positions);
    normal.array.set(data.normals);
    index.array.set(data.indices);
    position.needsUpdate = true;
    normal.needsUpdate = true;
    index.needsUpdate = true;
    bridge.geometry.computeBoundingBox();
    bridge.geometry.computeBoundingSphere();
  }
  bridge.coverageDepth = data.coverageDepth;
}

/**
 * The position attribute is passed in rather than looked up per sample: these run four times a
 * vertex for a blend and four times a sample for the pop measurement — 33,800 `getAttribute` map
 * lookups a transition frame on a 65x65 tile, for a name that cannot change while the level is
 * being written.
 */
function levelHeight(
  position: BufferAttribute,
  resolution: number,
  row: number,
  column: number,
): number {
  const value = position.getY(row * resolution + column);
  if (!Number.isFinite(value)) throw new Error("TerrainTiles LOD geometry has an invalid height.");
  return value;
}

function interpolatedLevelHeight(
  level: ILevelGeometry,
  position: BufferAttribute,
  x: number,
  z: number,
): number {
  const column = Math.max(0, Math.min(1, x)) * (level.resolution - 1);
  const row = Math.max(0, Math.min(1, z)) * (level.resolution - 1);
  const column0 = Math.floor(column);
  const row0 = Math.floor(row);
  const column1 = Math.min(level.resolution - 1, column0 + 1);
  const row1 = Math.min(level.resolution - 1, row0 + 1);
  const columnMix = column - column0;
  const rowMix = row - row0;
  const upperLeft = levelHeight(position, level.resolution, row0, column0);
  const upperRight = levelHeight(position, level.resolution, row0, column1);
  const lowerLeft = levelHeight(position, level.resolution, row1, column0);
  const lowerRight = levelHeight(position, level.resolution, row1, column1);
  const upper = upperLeft + (upperRight - upperLeft) * columnMix;
  const lower = lowerLeft + (lowerRight - lowerLeft) * columnMix;
  return upper + (lower - upper) * rowMix;
}

function interpolatedLevelNormal(
  level: ILevelGeometry,
  normal: BufferAttribute,
  x: number,
  z: number,
  target: Vector3,
): Vector3 {
  const column = Math.max(0, Math.min(1, x)) * (level.resolution - 1);
  const row = Math.max(0, Math.min(1, z)) * (level.resolution - 1);
  const column0 = Math.floor(column);
  const row0 = Math.floor(row);
  const column1 = Math.min(level.resolution - 1, column0 + 1);
  const row1 = Math.min(level.resolution - 1, row0 + 1);
  const columnMix = column - column0;
  const rowMix = row - row0;
  const upperLeft = row0 * level.resolution + column0;
  const upperRight = row0 * level.resolution + column1;
  const lowerLeft = row1 * level.resolution + column0;
  const lowerRight = row1 * level.resolution + column1;
  const blend = (upper: number, lower: number): number => upper + (lower - upper) * rowMix;
  const interpolate = (
    topLeft: number,
    topRight: number,
    bottomLeft: number,
    bottomRight: number,
  ) =>
    blend(
      topLeft + (topRight - topLeft) * columnMix,
      bottomLeft + (bottomRight - bottomLeft) * columnMix,
    );
  return target
    .set(
      interpolate(
        normal.getX(upperLeft),
        normal.getX(upperRight),
        normal.getX(lowerLeft),
        normal.getX(lowerRight),
      ),
      interpolate(
        normal.getY(upperLeft),
        normal.getY(upperRight),
        normal.getY(lowerLeft),
        normal.getY(lowerRight),
      ),
      interpolate(
        normal.getZ(upperLeft),
        normal.getZ(upperRight),
        normal.getZ(lowerLeft),
        normal.getZ(lowerRight),
      ),
    )
    .normalize();
}

function updateLevelSkirts(level: ILevelGeometry): void {
  const position = level.geometry.getAttribute("position");
  const normal = level.geometry.getAttribute("normal");
  const surfaceVertexCount = level.resolution * level.resolution;
  const edges = [
    (index: number) => index,
    (index: number) => (level.resolution - 1) * level.resolution + index,
    (index: number) => index * level.resolution,
    (index: number) => index * level.resolution + level.resolution - 1,
  ];
  for (const [edgeIndex, edge] of edges.entries()) {
    for (let index = 0; index < level.resolution; index += 1) {
      const top = edge(index);
      const bottom = surfaceVertexCount + edgeIndex * level.resolution + index;
      position.setY(bottom, position.getY(top) - level.skirtDepth);
      normal.setXYZ(bottom, 0, 1, 0);
    }
  }
}

function restoreLevelSurface(field: Heightfield, level: ILevelGeometry): void {
  const position = level.geometry.getAttribute("position");
  const normalAttribute = level.geometry.getAttribute("normal");
  const minimumX = field.origin.x - field.width / 2;
  const minimumZ = field.origin.z - field.depth / 2;
  const cellWidth = field.width / (level.resolution - 1);
  const cellDepth = field.depth / (level.resolution - 1);
  const normal = new Vector3();
  for (let row = 0; row < level.resolution; row += 1) {
    const z = minimumZ + row * cellDepth;
    for (let column = 0; column < level.resolution; column += 1) {
      const x = minimumX + column * cellWidth;
      const index = row * level.resolution + column;
      position.setY(index, field.heightAt(x, z));
      field.normalAt(x, z, normal);
      normalAttribute.setXYZ(index, normal.x, normal.y, normal.z);
    }
  }
  updateLevelSkirts(level);
  refreshEdgeSamples(level);
  position.needsUpdate = true;
  normalAttribute.needsUpdate = true;
  level.geometry.computeBoundingBox();
  level.geometry.computeBoundingSphere();
}

/**
 * A blend only ever moves a vertex between the two levels' surfaces, so the union of the two
 * known bounds holds every frame of it. Widened once when the transition starts instead of
 * recomputed per blend frame: `computeBoundingBox` + `computeBoundingSphere` walked the finer
 * level's ~8,600 positions every frame of every transition (56 + 45 + 27 + 29 ms over a six-second
 * walk). `#restoreLodTransition` puts the finer level's own bounds back when the blend ends.
 */
function widenLevelBoundsForBlend(finer: ILevelGeometry, coarser: ILevelGeometry): void {
  const box = finer.geometry.boundingBox;
  const sphere = finer.geometry.boundingSphere;
  const coarserBox = coarser.geometry.boundingBox;
  if (box === null || sphere === null || coarserBox === null)
    throw new Error("TerrainTiles LOD transition needs both levels' bounds to be known.");
  box.union(coarserBox);
  box.getBoundingSphere(sphere);
}

function updateLodTransitionGeometry(
  tile: IResidentTile,
  transition: ILodTransition,
  progress: number,
): void {
  const from = tile.levels[transition.from];
  const to = tile.levels[transition.to];
  if (from === undefined || to === undefined)
    throw new Error("TerrainTiles LOD transition references a missing level.");
  const finer = from.resolution >= to.resolution ? from : to;
  const coarser = finer === from ? to : from;
  const fromIsFiner = finer === from;
  const position = finer.geometry.getAttribute("position");
  const normalAttribute = finer.geometry.getAttribute("normal");
  const coarsePosition = coarser.geometry.getAttribute("position") as BufferAttribute;
  const coarseNormalAttribute = coarser.geometry.getAttribute("normal") as BufferAttribute;
  const minimumX = tile.field.origin.x - tile.field.width / 2;
  const minimumZ = tile.field.origin.z - tile.field.depth / 2;
  const cellWidth = tile.field.width / (finer.resolution - 1);
  const cellDepth = tile.field.depth / (finer.resolution - 1);
  const fineNormal = new Vector3();
  const coarseNormal = new Vector3();
  const blendedNormal = new Vector3();
  for (let row = 0; row < finer.resolution; row += 1) {
    const z = minimumZ + row * cellDepth;
    const normalizedZ = row / (finer.resolution - 1);
    for (let column = 0; column < finer.resolution; column += 1) {
      const x = minimumX + column * cellWidth;
      const normalizedX = column / (finer.resolution - 1);
      const index = row * finer.resolution + column;
      const fineHeight = tile.field.heightAt(x, z);
      const coarseHeight = interpolatedLevelHeight(
        coarser,
        coarsePosition,
        normalizedX,
        normalizedZ,
      );
      const startHeight = fromIsFiner ? fineHeight : coarseHeight;
      const endHeight = fromIsFiner ? coarseHeight : fineHeight;
      position.setY(index, startHeight + (endHeight - startHeight) * progress);

      tile.field.normalAt(x, z, fineNormal);
      interpolatedLevelNormal(
        coarser,
        coarseNormalAttribute,
        normalizedX,
        normalizedZ,
        coarseNormal,
      );
      const startNormal = fromIsFiner ? fineNormal : coarseNormal;
      const endNormal = fromIsFiner ? coarseNormal : fineNormal;
      blendedNormal
        .set(
          startNormal.x + (endNormal.x - startNormal.x) * progress,
          startNormal.y + (endNormal.y - startNormal.y) * progress,
          startNormal.z + (endNormal.z - startNormal.z) * progress,
        )
        .normalize();
      normalAttribute.setXYZ(index, blendedNormal.x, blendedNormal.y, blendedNormal.z);
    }
  }
  updateLevelSkirts(finer);
  refreshEdgeSamples(finer);
  position.needsUpdate = true;
  normalAttribute.needsUpdate = true;
}

function* surfaceHeightChunks(
  level: ILevelGeometry,
  chunked: boolean,
): Generator<void, Float32Array> {
  const position = level.geometry.getAttribute("position");
  const heights = new Float32Array(level.resolution * level.resolution);
  for (let index = 0; index < heights.length; index += 1) {
    heights[index] = position.getY(index);
    if (chunked && (index + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
  }
  return heights;
}

function surfaceHeights(level: ILevelGeometry): Float32Array {
  return surfaceHeightChunks(level, false).next().value as Float32Array;
}

function interpolatedSamplesHeight(
  samples: Float32Array,
  resolution: number,
  x: number,
  z: number,
): number {
  const column = Math.max(0, Math.min(1, x)) * (resolution - 1);
  const row = Math.max(0, Math.min(1, z)) * (resolution - 1);
  const column0 = Math.floor(column);
  const row0 = Math.floor(row);
  const column1 = Math.min(resolution - 1, column0 + 1);
  const row1 = Math.min(resolution - 1, row0 + 1);
  const columnMix = column - column0;
  const rowMix = row - row0;
  const upperLeft = samples[row0 * resolution + column0] as number;
  const upperRight = samples[row0 * resolution + column1] as number;
  const lowerLeft = samples[row1 * resolution + column0] as number;
  const lowerRight = samples[row1 * resolution + column1] as number;
  const upper = upperLeft + (upperRight - upperLeft) * columnMix;
  const lower = lowerLeft + (lowerRight - lowerLeft) * columnMix;
  return upper + (lower - upper) * rowMix;
}

function* surfaceDeltaChunks(
  samples: Float32Array,
  resolution: number,
  level: ILevelGeometry,
  chunked: boolean,
): Generator<void, number> {
  const sampleCount = Math.max(resolution, level.resolution);
  const position = level.geometry.getAttribute("position") as BufferAttribute;
  let maximum = 0;
  for (let row = 0; row < sampleCount; row += 1) {
    for (let column = 0; column < sampleCount; column += 1) {
      const x = column / (sampleCount - 1);
      const z = row / (sampleCount - 1);
      maximum = Math.max(
        maximum,
        Math.abs(
          interpolatedSamplesHeight(samples, resolution, x, z) -
            interpolatedLevelHeight(level, position, x, z),
        ),
      );
      if (chunked && (row * sampleCount + column + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
    }
  }
  return maximum;
}

function surfaceDeltaFromSamples(
  samples: Float32Array,
  resolution: number,
  level: ILevelGeometry,
): number {
  return surfaceDeltaChunks(samples, resolution, level, false).next().value as number;
}

/**
 * The coarsest level a tile may ever show. A level is selectable only when its height error
 * against *every* finer level fits the pop bound, which is what keeps the per-frame displacement
 * inside it: a transition walks one LOD_TRANSITION_FRAMES-th of the way between two levels, and
 * an interrupted transition snaps back to a level endpoint, which is never further from the
 * surface it replaced than the bound between any two selectable levels. A cliff therefore keeps
 * its tile at a finer level instead of throwing out of the frame.
 */
function* coarsestSelectableLevel(
  levels: readonly ILevelGeometry[],
  chunked: boolean,
): Generator<void, number> {
  let coarsest = 0;
  for (let index = 1; index < levels.length; index += 1) {
    const level = levels[index];
    if (level === undefined) break;
    let error = 0;
    for (let finerIndex = 0; finerIndex < index; finerIndex += 1) {
      const finer = levels[finerIndex];
      if (finer === undefined) break;
      error = Math.max(
        error,
        yield* surfaceDeltaChunks(
          yield* surfaceHeightChunks(finer, chunked),
          finer.resolution,
          level,
          chunked,
        ),
      );
    }
    if (error > LOD_POP_THRESHOLD) break;
    coarsest = index;
  }
  return coarsest;
}

function seamCoverageDepth(a: IResidentTile, b: IResidentTile): number {
  const aLevel = a.levels[a.lodLevel];
  const bLevel = b.levels[b.lodLevel];
  if (aLevel === undefined || bLevel === undefined) return 0;
  return Math.min(aLevel.skirtDepth, bLevel.skirtDepth);
}

/**
 * One edge of one level, addressed in the position buffer directly.
 *
 * The seam diagnostic reads two edges once per sample of every pair, four times a frame, so the
 * per-read cost is the per-frame cost: resolving the attribute and calling `getY` per vertex was
 * ~40% of a settled 289-tile frame. The Y of edge vertex `index` sits at `first + index * span`
 * in the interleaved array, and stepping an edge by one vertex steps the array by `span`.
 */
interface IEdgeWalk {
  readonly first: number;
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly span: number;
}

function edgeWalk(level: ILevelGeometry, side: keyof IEdgeSamples): IEdgeWalk {
  const position = level.geometry.getAttribute("position");
  const array = position.array as Float32Array;
  const last = level.resolution - 1;
  const first =
    side === "north" ? 0 : side === "south" ? last * level.resolution : side === "west" ? 0 : last;
  return {
    first: first * 3 + 1,
    heights: array,
    resolution: level.resolution,
    span: (side === "north" || side === "south" ? 1 : level.resolution) * 3,
  };
}

function edgeWalkHeight(walk: IEdgeWalk, index: number): number {
  const lower = walk.heights[walk.first + index * walk.span] as number;
  if (!Number.isFinite(lower))
    throw new Error("TerrainTiles seam diagnostic edge height must be finite.");
  return lower;
}

/** The walk's height at `normalized`, interpolating exactly as `edgeHeight` does. */
function edgeWalkAt(walk: IEdgeWalk, normalized: number): number {
  const position = normalized * (walk.resolution - 1);
  const lower = Math.floor(position);
  const mix = position - lower;
  const lowerValue = edgeWalkHeight(walk, lower);
  if (mix === 0) return lowerValue;
  return (
    lowerValue * (1 - mix) + edgeWalkHeight(walk, Math.min(walk.resolution - 1, lower + 1)) * mix
  );
}

/** A pair's bridge, validated and placed once so the per-sample loop only measures. */
interface IBridgeCoverage {
  readonly bridge: IStitchBridge;
  readonly coarser: IBridgeEndpoint;
  readonly finer: IBridgeEndpoint;
  readonly position: PositionAttribute;
}

function bridgeCoverageContext(
  bridge: IStitchBridge,
  a: IResidentTile,
  aSide: keyof IEdgeSamples,
  b: IResidentTile,
  bSide: keyof IEdgeSamples,
): IBridgeCoverage {
  if (bridge.mesh.geometry !== bridge.geometry)
    throw new Error("TerrainTiles seam diagnostic bridge geometry is not attached to its mesh.");
  if (!Number.isInteger(bridge.resolution) || bridge.resolution < 2)
    throw new Error("TerrainTiles seam diagnostic bridge resolution is invalid.");
  if (
    bridge.keys[0] !== (a.key < b.key ? a.key : b.key) ||
    bridge.keys[1] !== (a.key < b.key ? b.key : a.key)
  )
    throw new Error("TerrainTiles seam diagnostic bridge topology does not match its tile pair.");
  const position = validateBridgeTriangleTopology(bridge.mesh.geometry, bridge.resolution * 2);
  if (position.count !== bridge.resolution * 2)
    throw new Error("TerrainTiles seam diagnostic bridge topology has invalid coverage.");
  const [finer, coarser] = bridgeEndpointPair(a, aSide, b, bSide);
  // Nothing inside the sample loop moves these, so deriving them per sample only repeated work:
  // three world-matrix updates and a full revalidation of the bridge's own topology for every
  // edge vertex of every pair, four times a frame.
  bridge.mesh.updateWorldMatrix(true, false);
  finer.level.mesh.updateWorldMatrix(true, false);
  coarser.level.mesh.updateWorldMatrix(true, false);
  return { bridge, coarser, finer, position };
}

function bridgeCoverageAt(
  coverage: IBridgeCoverage,
  normalized: number,
  worldPosition: Vector3,
  expectedWorldPosition: Vector3,
): number {
  if (!Number.isFinite(normalized))
    throw new Error("TerrainTiles seam diagnostic bridge sample coordinate must be finite.");
  const { bridge, coarser, finer, position } = coverage;
  const samplePosition = Math.max(0, Math.min(1, normalized)) * (bridge.resolution - 1);
  const lower = Math.floor(samplePosition);
  const upper = Math.min(bridge.resolution - 1, lower + 1);
  const mix = samplePosition - lower;
  const fine =
    bridgeEndpointHeight(
      bridge,
      position,
      lower,
      0,
      finer.tile,
      finer.side,
      finer.level,
      worldPosition,
      expectedWorldPosition,
    ) *
      (1 - mix) +
    bridgeEndpointHeight(
      bridge,
      position,
      upper,
      0,
      finer.tile,
      finer.side,
      finer.level,
      worldPosition,
      expectedWorldPosition,
    ) *
      mix;
  const coarse =
    bridgeEndpointHeight(
      bridge,
      position,
      lower,
      1,
      coarser.tile,
      coarser.side,
      coarser.level,
      worldPosition,
      expectedWorldPosition,
    ) *
      (1 - mix) +
    bridgeEndpointHeight(
      bridge,
      position,
      upper,
      1,
      coarser.tile,
      coarser.side,
      coarser.level,
      worldPosition,
      expectedWorldPosition,
    ) *
      mix;
  const covered = Math.abs(fine - coarse);
  if (!Number.isFinite(covered))
    throw new Error("TerrainTiles seam diagnostic bridge coverage must be finite.");
  return covered;
}

function seamObservation(
  a: IResidentTile,
  b: IResidentTile,
  bridge: IStitchBridge | undefined,
  owner: Object3D,
  includeBridgeCoverage: boolean,
): { gap: number; visualGap: number } {
  const [aSide, bSide] = opposingEdge(a, b);
  const aLevel = renderedLevel(a);
  const bLevel = renderedLevel(b);
  if (aLevel === undefined || bLevel === undefined)
    throw new Error("TerrainTiles seam diagnostic observation has no rendered level.");
  const samples = Math.max(aLevel.resolution, bLevel.resolution);
  const aWalk = edgeWalk(aLevel, aSide);
  const bWalk = edgeWalk(bLevel, bSide);
  const coverage =
    includeBridgeCoverage &&
    bridge !== undefined &&
    bridge.mesh.parent === owner &&
    bridge.mesh.visible
      ? bridgeCoverageContext(bridge, a, aSide, b, bSide)
      : undefined;
  const skirt = seamCoverageDepth(a, b);
  const worldPosition = new Vector3();
  const expectedWorldPosition = new Vector3();
  let gap = 0;
  let visualGap = 0;
  for (let index = 0; index < samples; index += 1) {
    const normalized = samples === 1 ? 0 : index / (samples - 1);
    const currentGap = Math.abs(edgeWalkAt(aWalk, normalized) - edgeWalkAt(bWalk, normalized));
    if (!Number.isFinite(currentGap))
      throw new Error("TerrainTiles seam diagnostic observation must be finite.");
    gap = Math.max(gap, currentGap);
    const covered =
      coverage === undefined
        ? 0
        : bridgeCoverageAt(coverage, normalized, worldPosition, expectedWorldPosition);
    visualGap = Math.max(visualGap, Math.max(0, currentGap - Math.max(skirt, covered)));
  }
  if (!Number.isFinite(visualGap))
    throw new Error("TerrainTiles visual seam diagnostic observation must be finite.");
  return { gap, visualGap };
}

type NeighborPair = readonly [IResidentTile, IResidentTile];

/**
 * One pair's bridge, as the seam job carries it: the two edges it is made of, and what the bridge it
 * produces is called and keyed by.
 */
interface IStitchRequest {
  readonly coarse: ITerrainEdgeJob;
  readonly fine: ITerrainFineEdgeJob;
  readonly keys: [string, string];
  readonly resolution: number;
}

function neighborPairKey(pair: NeighborPair): string {
  const [a, b] = pair;
  return a.key < b.key ? `${a.key}|${b.key}` : `${b.key}|${a.key}`;
}

/**
 * Every facing pair of the resident set, from the residency key map rather than from a scan of
 * every tile against every other tile.
 *
 * `follow` and `process` each want this list, four times a frame, and the scan was quadratic in
 * the resident count: 41k comparisons for the 289-tile ring a `streamRadius: 8` game streams,
 * which is the whole per-frame regression. A tile's east and south neighbors are its only
 * unfaced-inward partners, so two map lookups per tile enumerate each pair exactly once.
 */
function neighborPairs(tiles: ReadonlyMap<string, IResidentTile>): NeighborPair[] {
  const pairs: NeighborPair[] = [];
  collectNeighborPairs(tiles, pairs);
  return pairs;
}

/** `neighborPairs` into a buffer the caller already owns, so a frame allocates no pair arrays. */
function collectNeighborPairs(
  tiles: ReadonlyMap<string, IResidentTile>,
  into: NeighborPair[],
): NeighborPair[] {
  into.length = 0;
  for (const tile of tiles.values()) {
    const east = tiles.get(keyFor(tile.tileX + 1, tile.tileZ));
    if (east !== undefined) into.push([tile, east]);
    const south = tiles.get(keyFor(tile.tileX, tile.tileZ + 1));
    if (south !== undefined) into.push([tile, south]);
  }
  return into;
}

function hasPendingTarget(targets: ReadonlyMap<IResidentTile, number>): boolean {
  for (const [tile, target] of targets)
    if (Math.min(target, tile.maxLodLevel) !== tile.lodLevel) return true;
  return false;
}

/** Each resident tile's target level after the neighbour rule: no two neighbours two levels apart. */
function coordinatedLevels(
  resident: ReadonlyMap<string, IResidentTile>,
  targets: ReadonlyMap<IResidentTile, number>,
): Map<IResidentTile, number> {
  const levels = new Map<IResidentTile, number>();
  for (const tile of resident.values())
    levels.set(tile, Math.min(targets.get(tile) ?? tile.lodLevel, tile.maxLodLevel));
  const pairs = neighborPairs(resident);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [a, b] of pairs) {
      const aLevel = levels.get(a) as number;
      const bLevel = levels.get(b) as number;
      if (Math.abs(aLevel - bLevel) <= 1) continue;
      if (aLevel > bLevel) levels.set(a, bLevel + 1);
      else levels.set(b, aLevel + 1);
      changed = true;
    }
  }
  return levels;
}

function neighborLodCorrection(
  pair: NeighborPair,
): { coarser: IResidentTile; level: number } | undefined {
  const [a, b] = pair;
  if (Math.abs(a.lodLevel - b.lodLevel) <= 1) return undefined;
  const finer = a.lodLevel < b.lodLevel ? a : b;
  const coarser = finer === a ? b : a;
  return { coarser, level: finer.lodLevel + 1 };
}

/**
 * One neighbor pair's bridge request, or `undefined` when the pair needs no bridge.
 *
 * The two edges are restored here — that reads the game's field sampler, which cannot cross into a
 * worker — and everything the bridge strip is made of is copied out as numbers. The strip itself is
 * built wherever the jobs run, so the main thread only swaps the attributes it gets back.
 */
function neighborBridgeRequest(pair: NeighborPair): IStitchRequest | undefined {
  const [a, b] = pair;
  const [aSide, bSide] = opposingEdge(a, b);
  const aLevel = renderedLevel(a);
  const bLevel = renderedLevel(b);
  if (aLevel === undefined || bLevel === undefined)
    throw new Error("TerrainTiles cannot reconcile a neighbor with no rendered LOD level.");
  restoreLevelEdge(a, aLevel, aSide);
  restoreLevelEdge(b, bLevel, bSide);
  if (aLevel.resolution === bLevel.resolution) return undefined;
  const finerLevel = aLevel.resolution > bLevel.resolution ? aLevel : bLevel;
  return {
    coarse: edgeJob(
      finerLevel === aLevel ? b : a,
      finerLevel === aLevel ? bLevel : aLevel,
      finerLevel === aLevel ? bSide : aSide,
    ),
    fine: fineEdgeJob(
      finerLevel === aLevel ? a : b,
      finerLevel,
      finerLevel === aLevel ? aSide : bSide,
    ),
    keys: [a.key, b.key].sort() as [string, string],
    resolution: finerLevel.resolution,
  };
}

function newStitchBridge(
  request: IStitchRequest,
  data: ITerrainBridgeAttributes,
  surface: MeshSurface,
): IStitchBridge {
  const geometry = stitchGeometry(data);
  const mesh = terrainMesh(new Mesh(geometry, surface));
  mesh.frustumCulled = true;
  return {
    bytes: geometryBytes(geometry),
    coverageDepth: data.coverageDepth,
    geometry,
    keys: request.keys,
    mesh,
    resolution: request.resolution,
  };
}

function setManualLodLevel(lod: LOD, level: number): void {
  // Three's renderer reads `autoUpdate`, and its update method owns this private-ish marker. Keep
  // that marker aligned with the visible child for callers that inspect the composed LOD.
  (lod as LOD & { _currentLevel: number })._currentLevel = level;
}

/**
 * Stream a bounded square of game-authored heightfields and keep their render and physics units
 * together. The class composes ordinary THREE.LOD objects and leaves frustum/projection culling
 * to the renderer's existing scene path.
 *
 * @situation stream terrain without cracks
 * @situation keep generated terrain resident around a moving player
 * @situation put a generated terrain tile into a game-owned physics world
 * @alias stream terrain across chunks
 * @constraint sampleHeight and surface are required game choices; no landform or surface preset is installed
 * @constraint residentTileBudget and residentByteBudget are hard caps; a tile that cannot fit throws
 * @constraint seam gap, LOD pop and the rendered-vertex finiteness scan are measurements that are off by default; TN_TERRAIN_VALIDATE=1, ?tnTerrainValidate=1 or validate: true runs them, and maxSeamGap, maxVisualSeamGap and maxLodPop report undefined while they are off
 * @override tileSize, tileResolution, lodFactors, lodDistances, skirtDepth, streamRadius, colliderRadius, mergeTiles, validate, and budgets
 * @example const tiles = new TerrainTiles({ sampleHeight, surface: gameSurface(), tileSize: 256, tileResolution: 129, residentTileBudget: 25, residentByteBudget: 32_000_000 });
 */
export class TerrainTiles extends Object3D implements IComputeDriven {
  readonly residentTileBudget: number;
  readonly residentByteBudget: number;
  readonly skirtDepth: number;
  readonly tileResolution: number;
  readonly tileSize: number;
  readonly processCadence = "render" as const;
  readonly #assets: Pick<IAssetLoader, "release"> | undefined;
  readonly #assetKey: IWorldTilesOptions["assetKey"];
  readonly #colliderRadius: number;
  readonly #receiveShadow: boolean;
  readonly #createCollider: IWorldTilesOptions["createCollider"];
  readonly #factors: readonly number[];
  readonly #lodDistances: readonly number[];
  readonly #surface: MeshSurface;
  readonly #sampleHeight: IWorldTilesOptions["sampleHeight"];
  readonly #streamRadius: number;
  /** Canonical topology samples retained only for the declared diagnostics region. */
  readonly #topologyField: Heightfield | undefined;
  readonly #topologyBytes: number;
  readonly #worldPasses: IHeightfieldWorldPassOptions | undefined;
  readonly #resident = new Map<string, IResidentTile>();
  #construction: { key: string; work: Generator<void, IResidentTile> } | undefined;
  #topologyMetrics: ReturnType<typeof summarizeWorldTopology> | undefined;
  #focus: IWorldTilesFollowPosition | undefined;
  #peakBytes = 0;
  #peakTiles = 0;
  #lodTransitions = 0;
  readonly #blending = new Set<IResidentTile>();
  /** Merged super-tiles by block key, and the blocks a LOD or residency change left to rebuild. */
  readonly #blocks = new Map<string, IMergedBlock>();
  readonly #dirtyBlocks = new Set<string>();
  /**
   * Blocks whose merge job is out. A block re-dirtied while its own merge is in flight stays dirty
   * and waits: dispatching it again would merge the same block twice, and the older reply would land
   * first carrying the membership the block had when it was sent — a snapshot that no longer matches
   * the resident set, so the record claims tiles its geometry does not hold and the second reply has
   * to correct it. (PRD-478.)
   */
  readonly #mergingBlocks = new Set<string>();
  /** Tile key -> block key currently hiding it, so a settled member is not drawn twice. */
  readonly #mergedMembers = new Map<string, string>();
  #blockRebuilds = 0;
  /** Merged super-tile bytes, reported beside the tiles they duplicate and never charged to them. */
  #blockBytes = 0;
  #tilesToldAt = Number.NEGATIVE_INFINITY;
  readonly #mergeTiles: boolean;
  // The last `follow` ran out of admission budget before it wanted everything, so the next one
  // has to run even if the follow point has not moved. Cleared at the top of `follow`.
  #deferredAdmissions = 0;
  #maxLodPop = 0;
  #maxLodTransitionFrames = 0;
  // These diagnostics are lifetime maxima for this residency owner. Zero is the deliberate
  // empty/evicted value; each finite live-geometry observation can only increase it.
  #maxSeamGap = 0;
  #maxVisualSeamGap = 0;
  #stitchedEdges = 0;
  #stitchBytes = 0;
  readonly #stitches = new Map<string, IStitchBridge>();
  /** Each pair's `seamState` as the last reconcile left it, so a settled seam is not redone. */
  readonly #pairSignatures = new Map<string, number[]>();
  /** The state each pair was last observed in, per coverage mode, so a settled seam is not re-measured. */
  readonly #observedSeams = new Map<string, ISeamObservation>();
  /** Counts the observation passes, so a pass marks what it saw instead of building a live set. */
  #observationPass = 0;
  /** The facing pairs a pass walks, reused so a frame allocates no pair arrays. */
  readonly #pairScratch: NeighborPair[] = [];
  /** The ring state the last full seam pass left behind; `undefined` until one has run. */
  #settledRing: number[] | undefined;
  /**
   * The buffer a frame measures its ring state into before comparing it, and the one the last pass
   * settled. Two buffers trade places instead of being reallocated, because a settled 289-tile ring
   * measures some twenty thousand numbers a frame and building that many arrays was itself the cost
   * this fast path exists to avoid.
   */
  #ringScratch: number[] = [];
  /**
   * Bumped by every writer of the state the ring pass describes, and the epoch the last pass settled
   * at. The shipped frame's change detector; see {@link #seamPass}. `-1` so the first pass runs.
   */
  #ringEpoch = 0;
  #seamEpoch = -1;
  /**
   * A seam pass whose strips are still being built off this thread, so a frame that arrives before the
   * reply does not start a second pass over the same pairs and write them twice.
   */
  #seamPending = false;
  /**
   * Where the block merges and the seam strips are built. A module worker where the host has one, this
   * thread where it does not, from the same function either way.
   */
  readonly #jobs: ITerrainJobRunner;
  #released = false;
  #renderer: IRendererLike | undefined;
  /**
   * Whether the per-frame measurements run. Off by default: they assert what the shipped frame
   * trusts, and every observation getter below reports `undefined` while they are off, so a caller
   * can never read an unmeasured zero as a measurement.
   */
  readonly #validate: boolean;

  constructor(options: IWorldTilesOptions) {
    super();
    this.#jobs = createTerrainJobRunner();
    this.tileSize = positive(options.tileSize, "tileSize");
    this.tileResolution = integerAtLeast(options.tileResolution, 3, "tileResolution");
    this.residentTileBudget = integerAtLeast(options.residentTileBudget, 1, "residentTileBudget");
    this.residentByteBudget = integerAtLeast(options.residentByteBudget, 1, "residentByteBudget");
    this.skirtDepth = positive(options.skirtDepth ?? this.tileSize, "skirtDepth");
    this.#streamRadius = integerAtLeast(options.streamRadius ?? 1, 0, "streamRadius");
    this.#receiveShadow = options.receiveShadow === true;
    this.#colliderRadius = integerAtLeast(
      options.colliderRadius ?? this.#streamRadius,
      0,
      "colliderRadius",
    );
    this.#surface = options.surface;
    if (options.surface === undefined || options.surface === null)
      throw new Error("TerrainTiles surface is required and must be game-owned.");
    this.#validate = options.validate ?? terrainValidationRequested();
    this.#mergeTiles = options.mergeTiles ?? !terrainMergeOptedOut();
    this.#sampleHeight = options.sampleHeight;
    if (typeof options.sampleHeight !== "function")
      throw new Error("TerrainTiles sampleHeight is required.");
    this.#factors = [...(options.lodFactors ?? [1, 2, 4])];
    if (this.#factors.length < 1) throw new Error("TerrainTiles lodFactors must not be empty.");
    for (const factor of this.#factors) integerAtLeast(factor, 1, "lod factor");
    for (const factor of this.#factors) resolutionFor(this.tileResolution, factor);
    this.#lodDistances = [...(options.lodDistances ?? [this.tileSize * 2, this.tileSize * 4])];
    if (this.#lodDistances.length !== this.#factors.length - 1)
      throw new Error("TerrainTiles lodDistances must contain one threshold per LOD transition.");
    this.#lodDistances.forEach((distance, index) => {
      positive(distance, `lodDistances[${String(index)}]`);
      if (index > 0 && distance <= (this.#lodDistances[index - 1] as number))
        throw new Error("TerrainTiles lodDistances must be strictly increasing.");
    });
    if (options.assetKey !== undefined && options.assets === undefined)
      throw new Error("TerrainTiles assetKey requires an assets.release consumer.");
    this.#assets = options.assets;
    this.#assetKey = options.assetKey;
    this.#createCollider = options.createCollider;
    this.#worldPasses = options.worldPasses;
    if (options.topologyObservation !== undefined)
      validateTopologyObservation(options.topologyObservation, this.tileSize, this.tileResolution);
    this.#topologyField =
      options.topologyObservation === undefined
        ? undefined
        : Heightfield.fromSampler({
            ...options.topologyObservation,
            sampleHeight: this.#sampleHeight,
            ...(this.#worldPasses === undefined ? {} : { worldPasses: this.#worldPasses }),
          });
    this.#topologyBytes = this.#topologyField?.memoryBytes ?? 0;
    if (this.#topologyBytes > this.residentByteBudget)
      throw new TerrainTileBudgetError(
        "TerrainTiles residentByteBudget cannot fit the topology observation.",
      );
    this.#recordPeaks();
    if (this.#validate) this.#recordSeamDiagnostics();
    this.frustumCulled = true;
  }

  get released(): boolean {
    return this.#released;
  }

  get residentTileCount(): number {
    return this.#resident.size;
  }

  /**
   * Every retained terrain byte, against `residentByteBudget`: the resident tiles with their levels
   * and edge samples, the stitch bridges, and the retained topology.
   *
   * A merged super-tile is deliberately absent. A block duplicates the level vertices of the tiles it
   * covers, and those tiles stay resident because a tile that leaves the block draws its own mesh
   * again — so charging the copy made a derived artefact evict real terrain detail out of the same
   * budget the tiles were admitted against, and a budget sized for unmerged terrain held fewer tiles
   * with the merge on. The copy is reported as `terrainTiles.blockBytes` instead. (PRD-475.)
   *
   * ponytail: terrain geometry costs up to ~2x while merged; free the per-tile GPU buffers behind a
   * block (keep the height field for queries) if that memory ever matters.
   */
  get residentBytes(): number {
    // Read four times a frame by the residency admission and the peak record, so it accumulates
    // instead of materialising the resident set.
    let total = this.#topologyBytes + this.#stitchBytes;
    for (const tile of this.#resident.values()) total += tile.bytes;
    return total;
  }

  get peakResidentTileCount(): number {
    return this.#peakTiles;
  }

  get peakResidentBytes(): number {
    return this.#peakBytes;
  }

  get residentKeys(): readonly string[] {
    return [...this.#resident.keys()].sort();
  }

  get residentColliderKeys(): readonly string[] {
    return [...this.#resident.values()]
      .filter((tile) => tile.collider !== undefined)
      .map((tile) => tile.key)
      .sort();
  }

  get lodLevelCount(): number {
    return this.#factors.length;
  }

  get lodTransitions(): number {
    return this.#lodTransitions;
  }

  /**
   * What the main pass submits for terrain levels right now: `tiles` surfaces, held as `blocks`
   * merged super-tiles plus one mesh each for the tiles that are not merged (a lone block member or
   * a tile mid LOD morph). `draws` is `blocks` plus those individual meshes, so with the merge off
   * it is exactly the number of visible level meshes — the census the merge exists to cut. `blending`
   * counts the resident tiles mid LOD morph, which are always among the individual meshes. A block
   * whose tile just left stops being drawn until its rebuild lands, and those tiles are counted as the
   * individual meshes they went back to — see `#releaseStaleBlock`.
   * `rebuilds` counts the block geometries built over this residency owner's life. `blockBytes` is
   * what the held blocks cost, reported and not charged to `residentByteBudget` — see `residentBytes`.
   */
  get terrainTiles(): {
    readonly blockBytes: number;
    readonly blocks: number;
    readonly blending: number;
    readonly draws: number;
    readonly rebuilds: number;
    readonly tiles: number;
  } {
    let individual = 0;
    for (const tile of this.#resident.values())
      for (const level of tile.levels) if (level.mesh.visible) individual += 1;
    let merged = 0;
    for (const block of this.#blocks.values()) merged += block.members.size;
    const blocks = this.#blocks.size;
    return {
      blockBytes: this.#blockBytes,
      blocks,
      blending: this.blendingTiles,
      draws: individual + blocks,
      rebuilds: this.#blockRebuilds,
      tiles: individual + merged,
    };
  }

  /**
   * Resident tiles mid LOD morph right now, so `process` is still owed. A blend is
   * `LOD_TRANSITION_FRAMES` frames long and only `process` advances it, so a caller that skips
   * `process` while its follow point is standing still would freeze every blend on frame one.
   */
  get blendingTiles(): number {
    return this.#blending.size;
  }

  /**
   * Maximum per-render-frame displacement of the visible LOD surface during transitions.
   *
   * `undefined` when validation is off: the pop is sampled by measuring the rendered surface twice
   * a frame, and reporting the empty value `0` instead of a measurement would be a lie a caller
   * could assert on.
   */
  get maxLodPop(): number | undefined {
    return this.#validate ? this.#maxLodPop : undefined;
  }

  /** Maximum number of rendered frames during which an LOD transition remained observable. */
  get maxLodTransitionFrames(): number {
    return this.#maxLodTransitionFrames;
  }

  /**
   * Maximum visible edge gap observed across follow/process calls for this residency owner, or
   * `undefined` when validation is off — see `maxLodPop`.
   */
  get maxSeamGap(): number | undefined {
    return this.#validate ? this.#maxSeamGap : undefined;
  }

  /**
   * Maximum remaining visible gap after skirt or bridge coverage observed across follow/process
   * calls, or `undefined` when validation is off — see `maxLodPop`.
   */
  get maxVisualSeamGap(): number | undefined {
    return this.#validate ? this.#maxVisualSeamGap : undefined;
  }

  /** Number of mixed-LOD edge reconciliations observed during this residency lifetime. */
  get stitchedEdgeCount(): number {
    return this.#stitchedEdges;
  }

  /**
   * A tile or a collider the last `follow` wanted and its budget refused, so the next one is owed
   * work even for an unmoved follow point. `0` once a pass wanted nothing it did not get.
   */
  get deferredAdmissions(): number {
    return this.#deferredAdmissions;
  }

  get warmupNodes(): readonly unknown[] {
    return [
      ...(this.#topologyField?.warmupNodes ?? []),
      ...[...this.#resident.values()].flatMap((tile) => tile.field.warmupNodes),
    ];
  }

  getTile(key: string): IWorldTile | undefined {
    return this.#resident.get(key);
  }

  /**
   * Move residency to the followed point: admit, evict and re-level every tile.
   *
   * `budget` caps construction chunks as well as completed admissions. An unfinished tile stays
   * outside residency and resumes on a later call while it remains wanted. Moving it outside the
   * selected ring cancels and releases that work. Omitted, a call drains synchronously as before.
   */
  follow(
    position: IWorldTilesFollowPosition | Pick<Vector3, "x" | "z">,
    budget?: IAdmissionBudget,
  ): void {
    if (this.#released) throw new Error("TerrainTiles cannot follow after release.");
    // This pass starts owing nothing; a refusal below sets the flag that owes the next one, so
    // `deferredAdmissions` is exactly "the last pass did not get everything it wanted".
    this.#deferredAdmissions = 0;
    const x = finite(position.x, "follow x");
    const z = finite(position.z, "follow z");
    const hadFocus = this.#focus !== undefined;
    this.#focus = { x, z };
    const centerX = Math.floor((x + this.tileSize / 2) / this.tileSize);
    const centerZ = Math.floor((z + this.tileSize / 2) / this.tileSize);
    const wanted: Array<{ distance: number; tileX: number; tileZ: number }> = [];
    for (
      let tileZ = centerZ - this.#streamRadius;
      tileZ <= centerZ + this.#streamRadius;
      tileZ += 1
    ) {
      for (
        let tileX = centerX - this.#streamRadius;
        tileX <= centerX + this.#streamRadius;
        tileX += 1
      ) {
        const tileCenterX = tileX * this.tileSize;
        const tileCenterZ = tileZ * this.tileSize;
        wanted.push({
          distance: Math.hypot(x - tileCenterX, z - tileCenterZ),
          tileX,
          tileZ,
        });
      }
    }
    wanted.sort((a, b) => a.distance - b.distance || a.tileZ - b.tileZ || a.tileX - b.tileX);
    const selected = wanted.slice(0, this.residentTileBudget);
    const selectedKeys = new Set(selected.map(({ tileX, tileZ }) => keyFor(tileX, tileZ)));
    if (this.#construction !== undefined && !selectedKeys.has(this.#construction.key))
      this.#cancelConstruction();
    for (const tile of [...this.#resident.values()]) {
      if (!selectedKeys.has(tile.key)) this.#evict(tile);
    }
    const targets = new Map<IResidentTile, number>();
    const missing: typeof selected = [];
    for (const candidate of selected) {
      const resident = this.#resident.get(keyFor(candidate.tileX, candidate.tileZ));
      if (resident !== undefined)
        targets.set(resident, lodLevelForDistance(candidate.distance, this.#lodDistances));
      // A selected tile keeps its construction progress when sub-tile camera motion changes the
      // distance order. Only leaving the wanted set cancels it; otherwise a jittering camera could
      // restart two equally near tiles forever.
      else if (keyFor(candidate.tileX, candidate.tileZ) === this.#construction?.key)
        missing.unshift(candidate);
      else missing.push(candidate);
    }
    // Even an already-spent allowance advances one chunk of pending work, starting nearest first.
    // The progress floor closes the ring without forcing an entire tile through one frame.
    let built = 0;
    for (const candidate of missing) {
      const key = keyFor(candidate.tileX, candidate.tileZ);
      const estimate = estimatedTileBytes(this.tileResolution, this.#factors, this.#worldPasses);
      if (this.residentBytes + estimate > this.residentByteBudget) {
        if (this.#construction?.key === key) this.#cancelConstruction();
        if (candidate.tileX === centerX && candidate.tileZ === centerZ)
          throw new TerrainTileBudgetError(
            "TerrainTiles residentByteBudget cannot fit the followed tile.",
          );
        continue;
      }
      // Keep incomplete work out of the scene; later calls resume it under the same allowance.
      const tile = this.#admitCandidate(candidate, centerX, centerZ, budget, built === 0);
      if (tile === undefined) break;
      this.#selectLod(tile, candidate.distance, false);
      built += 1;
      if (this.residentBytes + tile.bytes > this.residentByteBudget) {
        this.#disposeTile(tile);
        if (candidate.tileX === centerX && candidate.tileZ === centerZ)
          throw new TerrainTileBudgetError(
            "TerrainTiles residentByteBudget cannot fit the followed tile.",
          );
        continue;
      }
      this.#resident.set(tile.key, tile);
      this.add(tile.lod);
      this.#markTileDirty(tile);
      this.#ringEpoch += 1;
      this.#recordPeaks();
    }
    this.#recordPeaks();
    this.#updateColliders(centerX, centerZ, budget);
    this.#applyLodTargets(targets);
    // Retargeting already coordinates the resident ring; only newly admitted tiles can owe it.
    if (built > 0) this.#coordinateNeighborLods(hadFocus);
    this.#seamPass();
    // After every LOD target is settled, so a block is built from the levels this pass left behind.
    this.#rebuildDirtyBlocks(budget);
    this.#recordPeaks();
  }

  heightAt(x: number, z: number): number {
    return this.#fieldAt(x, z).heightAt(x, z);
  }

  normalAt(x: number, z: number, target = new Vector3()): Vector3 {
    return this.#fieldAt(x, z).normalAt(x, z, target);
  }

  sample(channel: string, x: number, z: number): number {
    if (channel === "slope") return 1 - this.normalAt(x, z).y;
    return this.#fieldAt(x, z).sample(channel, x, z);
  }

  attachRenderer(renderer: IRendererLike): void {
    if (this.#released) throw new Error("TerrainTiles cannot attach after release.");
    this.#renderer = renderer;
    this.#topologyField?.attachRenderer(renderer);
    for (const tile of this.#resident.values()) tile.field.attachRenderer(renderer);
  }

  process(renderer = this.#renderer): void {
    if (this.#released) return;
    const lodFrame = this.#validate ? this.#captureLodFrame() : undefined;
    this.#advanceLodTransitions();
    if (renderer !== undefined) {
      this.#topologyField?.process(renderer);
      for (const tile of this.#resident.values()) {
        tile.field.attachRenderer(renderer);
        tile.field.process(renderer);
      }
    }
    this.#seamPass();
    if (lodFrame !== undefined) this.#recordLodPopAfterReconciliation(lodFrame);
    this.#recordPeaks();
    this.#reportTileMarker();
  }

  /** Completed render tiles intersecting a square in world metres; pending builds do not count. */
  readinessAt(
    position: IWorldTilesFollowPosition,
    radius = 0,
  ): { required: number; loaded: number } {
    if (
      !Number.isFinite(position.x) ||
      !Number.isFinite(position.z) ||
      !Number.isFinite(radius) ||
      radius < 0
    )
      throw new Error(
        "TerrainTiles readiness requires finite coordinates and a nonnegative radius.",
      );
    const lowX = Math.floor((position.x - radius + this.tileSize / 2) / this.tileSize);
    const highX = Math.floor((position.x + radius + this.tileSize / 2) / this.tileSize);
    const lowZ = Math.floor((position.z - radius + this.tileSize / 2) / this.tileSize);
    const highZ = Math.floor((position.z + radius + this.tileSize / 2) / this.tileSize);
    let loaded = 0;
    const required = (highX - lowX + 1) * (highZ - lowZ + 1);
    if (!Number.isSafeInteger(required))
      throw new Error("TerrainTiles readiness region is too large.");
    for (const tile of this.#resident.values())
      if (tile.tileX >= lowX && tile.tileX <= highX && tile.tileZ >= lowZ && tile.tileZ <= highZ)
        loaded++;
    return { required, loaded };
  }

  debug(): Record<string, unknown> {
    const topologyField = this.#topologyField;
    const topology =
      topologyField === undefined
        ? undefined
        : (() => {
            const heights = topologyField.heights;
            const flow = topologyField.flow;
            const description = {
              columns: topologyField.columns,
              depth: topologyField.depth,
              origin: topologyField.origin,
              rows: topologyField.rows,
              width: topologyField.width,
            };
            if (heights.length <= MAX_RAW_TOPOLOGY_SAMPLES)
              return {
                ...description,
                heights: Array.from(heights),
                ...(flow === undefined ? {} : { flow: Array.from(flow) }),
              };
            if (flow === undefined) return description;
            if (this.#topologyMetrics === undefined)
              this.#topologyMetrics = summarizeWorldTopology({
                columns: topologyField.columns,
                depth: topologyField.depth,
                flow,
                heights,
                rows: topologyField.rows,
                width: topologyField.width,
              });
            return {
              ...description,
              metrics: this.#topologyMetrics,
            };
          })();
    return {
      maxSeamGap: this.maxSeamGap,
      maxVisualSeamGap: this.maxVisualSeamGap,
      maxLodTransitionFrames: this.#maxLodTransitionFrames,
      peakResidentBytes: this.#peakBytes,
      peakResidentTiles: this.#peakTiles,
      residentBytes: this.residentBytes,
      // The shipped frame's change detector, and the ring-state reads it replaced. Both flat: a
      // settled ring leaves them still.
      ringEpoch: this.#ringEpoch,
      ringStateBuilds: this.#ringStateBuilds,
      residentByteBudget: this.residentByteBudget,
      residentKeys: this.residentKeys,
      residentTiles: this.residentTileCount,
      residentTileBudget: this.residentTileBudget,
      pendingConstruction: this.#construction?.key,
      topologyBytes: this.#topologyBytes,
      lodTransitions: this.#lodTransitions,
      terrainTiles: this.terrainTiles,
      maxLodPop: this.maxLodPop,
      stitchedEdges: this.#stitchedEdges,
      skirtVertexCount: [...this.#resident.values()].reduce(
        (total, tile) => total + tile.skirtVertexCount,
        0,
      ),
      released: this.#released,
      ...(topology === undefined ? {} : { topology }),
    };
  }

  detach(): void {
    this.dispose();
  }

  dispose(): void {
    if (this.#released) return;
    this.#released = true;
    this.#renderer = undefined;
    this.#jobs.dispose();
    this.#cancelConstruction();
    this.#topologyField?.detach();
    for (const key of [...this.#blocks.keys()]) this.#dissolveBlock(key);
    for (const tile of [...this.#resident.values()]) this.#evict(tile);
    this.#resident.clear();
    this.removeFromParent();
  }

  *#createField(origin: IHeightfieldOrigin, chunked: boolean): Generator<void, Heightfield> {
    const sampler: IHeightfieldSamplerOptions = {
      columns: this.tileResolution,
      depth: this.tileSize,
      origin,
      rows: this.tileResolution,
      sampleHeight: this.#sampleHeight,
      width: this.tileSize,
      ...(this.#worldPasses === undefined ? {} : { worldPasses: this.#worldPasses }),
    };
    if (!chunked) return Heightfield.fromSampler(sampler);
    const heights = new Float32Array(this.tileResolution ** 2);
    const minimumX = origin.x - this.tileSize / 2;
    const minimumZ = origin.z - this.tileSize / 2;
    const cellSize = this.tileSize / (this.tileResolution - 1);
    for (let row = 0; row < this.tileResolution; row += 1) {
      const z = minimumZ + row * cellSize;
      for (let column = 0; column < this.tileResolution; column += 1) {
        const index = row * this.tileResolution + column;
        heights[index] = finite(
          this.#sampleHeight(minimumX + column * cellSize, z),
          "sampleHeight result",
        );
        if ((index + 1) % CONSTRUCTION_CHUNK_SAMPLES === 0) yield;
      }
    }
    // The same canonical field as fromSampler; only the sampler loop changes cadence.
    return new Heightfield({ ...sampler, heights });
  }

  *#createTile(
    tileX: number,
    tileZ: number,
    distance: number,
    withCollider: boolean,
    chunked: boolean,
  ): Generator<void, IResidentTile> {
    const origin = { x: tileX * this.tileSize, z: tileZ * this.tileSize };
    const assetKey =
      this.#assetKey === undefined
        ? undefined
        : typeof this.#assetKey === "function"
          ? this.#assetKey(tileX, tileZ)
          : this.#assetKey;
    if (assetKey !== undefined && (typeof assetKey !== "string" || assetKey.trim().length === 0))
      throw new Error("TerrainTiles assetKey must resolve to a non-empty string.");
    let field: Heightfield | undefined;
    const levels: ILevelGeometry[] = [];
    let lod: LOD | undefined;
    let collider: IWorldTileCollider | undefined;
    let completed = false;
    try {
      field = yield* this.#createField(origin, chunked);
      // One grid of the field's own heights for the whole tile, read before any level is built.
      const grid = yield* fieldHeightGrid(field, chunked);
      for (const factor of this.#factors)
        levels.push(
          yield* buildLevel(
            field,
            resolutionFor(this.tileResolution, factor),
            this.skirtDepth,
            this.#surface,
            grid,
            chunked,
          ),
        );
      lod = new LOD();
      lod.autoUpdate = false;
      lod.position.set(origin.x, 0, origin.z);
      levels.forEach(({ mesh }, index) => {
        mesh.visible = index === 0;
        lod?.addLevel(mesh, index === 0 ? 0 : (this.#lodDistances[index - 1] as number));
        mesh.frustumCulled = true;
        mesh.receiveShadow = this.#receiveShadow;
      });
      const maxLodLevel = yield* coarsestSelectableLevel(levels, chunked);
      collider =
        this.#createCollider === undefined
          ? new EmptyCollider()
          : withCollider
            ? this.#createCollider({ field, key: keyFor(tileX, tileZ), object: lod, tileX, tileZ })
            : undefined;
      const bytes =
        levels.reduce((total, level) => total + estimatedLevelBytes(level.resolution), 0) +
        field.memoryBytes;
      const tile: IResidentTile = {
        ...(assetKey === undefined ? {} : { assetKey }),
        bytes,
        collider,
        field,
        key: keyFor(tileX, tileZ),
        lod,
        lodLevel: 0,
        levels,
        maxLodLevel,
        object: lod,
        origin,
        skirtVertexCount: levels.reduce((total, level) => total + level.skirtVertexCount, 0),
        skirts: this.skirtDepth,
        tileX,
        tileZ,
      };
      this.#selectLod(tile, distance, false);
      completed = true;
      return tile;
    } finally {
      if (!completed) {
        collider?.dispose();
        lod?.removeFromParent();
        for (const level of levels) level.geometry.dispose();
        field?.detach();
      }
    }
  }

  /** Whether a tile this far from the followed one is inside `colliderRadius`. */
  #wantsCollider(tileX: number, tileZ: number, centerX: number, centerZ: number): boolean {
    return Math.max(Math.abs(tileX - centerX), Math.abs(tileZ - centerZ)) <= this.#colliderRadius;
  }

  /**
   * Build one wanted tile, if this frame's admission budget has room for it.
   *
   * Large fields, levels, bounds and LOD safety scans yield in chunks. Only a completed tile is
   * published; a refused chunk remains owned here until a later follow, a move or disposal.
   * Small tiles fit one unit, and a follow without an allowance drains synchronously as before.
   *
   * `forced` grants the first chunk progress even when another system spent the allowance.
   */
  #admitCandidate(
    candidate: { distance: number; tileX: number; tileZ: number },
    centerX: number,
    centerZ: number,
    budget: IAdmissionBudget | undefined,
    forced = false,
  ): IResidentTile | undefined {
    let progressOwed = forced;
    const key = keyFor(candidate.tileX, candidate.tileZ);
    if (this.#construction !== undefined && this.#construction.key !== key)
      this.#cancelConstruction();
    const construction = this.#construction ?? {
      key,
      work: this.#createTile(
        candidate.tileX,
        candidate.tileZ,
        candidate.distance,
        this.#wantsCollider(candidate.tileX, candidate.tileZ, centerX, centerZ),
        budget !== undefined && this.tileResolution ** 2 > CONSTRUCTION_CHUNK_SAMPLES,
      ),
    };
    this.#construction = construction;
    let tile: IResidentTile | undefined;
    const advance = (): void => {
      try {
        const result = construction.work.next();
        if (result.done) {
          tile = result.value;
          this.#construction = undefined;
        }
      } catch (error) {
        this.#construction = undefined;
        throw error;
      }
    };
    while (tile === undefined) {
      if (budget === undefined) advance();
      else if (budget.admit(advance)) progressOwed = false;
      else if (progressOwed) {
        // Progress is one chunk, never an entire high-resolution tile outside the allowance.
        advance();
        progressOwed = false;
      } else {
        this.#deferredAdmissions = 1;
        return undefined;
      }
    }
    return tile;
  }

  #cancelConstruction(): void {
    this.#construction?.work.return(undefined as never);
    this.#construction = undefined;
  }

  /**
   * Bring every resident tile's collider in line with `colliderRadius`: a tile that entered it gets
   * a body, one that left disposes the body it had. That is the whole cost control — a wide
   * `streamRadius` renders the ground out to the horizon while physics only ever covers the tiles a
   * player can reach — and it needs no per-tile bookkeeping because residency already walks the
   * resident set on every `follow`.
   *
   * A body the budget refuses is the same deferral as a refused tile: the tile is inside
   * `colliderRadius` with no body for a frame or two, and the next `follow` still wants one.
   *
   * Except under and beside the followed point. One tile build spends the whole 2 ms budget on its
   * own, so the collider pass behind it was refused every time a tile was admitted — and the
   * resident set is walked in insertion order, not nearest first, so the tiles the player is
   * standing on were as likely as any other to be the ones refused. A body under or beside the
   * walk point is the one thing a deferred admission may not take: a probe under the walk point
   * asks the physics world for ground that is not there yet. Nine bodies at most, and the ring's
   * other tiles keep their deferral.
   */
  #updateColliders(centerX: number, centerZ: number, budget?: IAdmissionBudget): void {
    const createCollider = this.#createCollider;
    if (createCollider === undefined) return;
    for (const tile of this.#resident.values()) {
      const wanted = this.#wantsCollider(tile.tileX, tile.tileZ, centerX, centerZ);
      if (wanted === (tile.collider !== undefined)) continue;
      if (!wanted) {
        tile.collider?.dispose();
        tile.collider = undefined;
        this.#ringEpoch += 1;
        continue;
      }
      const created = (): void => {
        tile.collider = createCollider({
          field: tile.field,
          key: tile.key,
          object: tile.lod,
          tileX: tile.tileX,
          tileZ: tile.tileZ,
        });
      };
      // The 3x3 ring around the followed point is never refused; see above.
      if (
        budget === undefined ||
        Math.max(Math.abs(tile.tileX - centerX), Math.abs(tile.tileZ - centerZ)) <= 1
      ) {
        created();
        this.#ringEpoch += 1;
      }
      // Out of room: the body is owed, and every later `follow` asks for it again.
      else if (!budget.admit(created)) {
        this.#deferredAdmissions = 1;
      }
    }
  }

  /**
   * Move resident tiles to their distance level after the neighbour rule is applied to the targets.
   *
   * Setting each tile to its raw distance level and then letting `#coordinateNeighborLods` pull
   * the coarser side of a two-level jump back flipped those tiles every frame the follow point
   * stood still: two LOD transitions, a visible morph and whole-tile bounds work, forever. The rule
   * is the same — a coarser neighbour moves to one level past the finer — but it now shapes the
   * target, so a settled ring asks for the level it already has.
   */
  #applyLodTargets(targets: ReadonlyMap<IResidentTile, number>): void {
    // A ring that already holds every level it is asking for has no target to reshape: the
    // neighbour fixpoint would return the same levels it starts from. Skipping it is what keeps a
    // still follow point off the per-frame pair walk entirely.
    if (!hasPendingTarget(targets)) return;
    const levels = coordinatedLevels(this.#resident, targets);
    for (const [tile, level] of levels) if (targets.has(tile)) this.#setLodLevel(tile, level);
  }

  #selectLod(tile: IResidentTile, distance: number, countTransition = true): void {
    this.#setLodLevel(tile, lodLevelForDistance(distance, this.#lodDistances), countTransition);
  }

  #setLodLevel(tile: IResidentTile, level: number, countTransition = true): void {
    const selectable = Math.min(level, tile.maxLodLevel);
    if (selectable === tile.lodLevel) {
      setManualLodLevel(tile.lod, selectable);
      return;
    }
    const interruptedFrame =
      !this.#validate || tile.lodTransition === undefined
        ? undefined
        : this.#captureLodFrameForTile(tile);
    if (tile.lodTransition !== undefined) this.#finishLodTransition(tile);
    const previousLevel = tile.lodLevel;
    const previous = tile.levels[previousLevel];
    const next = tile.levels[selectable];
    if (previous === undefined || next === undefined)
      throw new Error("TerrainTiles LOD transition references a missing level.");
    // The tile leaves its old level's block and joins the new level's: the old one is now holding
    // ground this tile is no longer at, and the new one is waiting to be built.
    this.#releaseStaleBlock(previousLevel, tile.tileX, tile.tileZ);
    tile.lodLevel = selectable;
    this.#markBlockDirty(selectable, tile.tileX, tile.tileZ);
    this.#ringEpoch += 1;
    if (!countTransition) {
      setManualLodLevel(tile.lod, selectable);
      this.#setLodVisibility(tile);
      this.#recordLodPopAfterRetarget(interruptedFrame);
      return;
    }
    this.#lodTransitions += 1;
    this.#blending.add(tile);
    tile.lodTransition = {
      elapsedFrames: 0,
      from: previousLevel,
      remainingFrames: LOD_TRANSITION_FRAMES,
      to: selectable,
    };
    const finerLevel = previous.resolution >= next.resolution ? previousLevel : selectable;
    const finer = previous.resolution >= next.resolution ? previous : next;
    setManualLodLevel(tile.lod, finerLevel);
    widenLevelBoundsForBlend(finer, finer === previous ? next : previous);
    updateLodTransitionGeometry(tile, tile.lodTransition, 0);
    this.#setLodVisibility(tile, [finerLevel]);
    this.#recordLodPopAfterRetarget(interruptedFrame);
  }

  #setLodVisibility(tile: IResidentTile, visibleLevels = [tile.lodLevel]): void {
    // A block draws this tile's level, so its own mesh must not be submitted on top of it. Only a
    // tile settled into a block is hidden: a morphing tile is never merged, and a tile whose LOD
    // just changed is no longer a member of the block its old level lived in.
    if (
      this.#mergeTiles &&
      tile.lodTransition === undefined &&
      this.#mergedMembers.get(tile.key) === blockKeyFor(tile.lodLevel, tile.tileX, tile.tileZ)
    ) {
      for (const level of tile.levels) level.mesh.visible = false;
      return;
    }
    const visible = new Set(visibleLevels);
    tile.levels.forEach(({ mesh }, index) => {
      mesh.visible = visible.has(index);
    });
  }

  #captureLodFrame(): ILodFrameSnapshot[] {
    const snapshots: ILodFrameSnapshot[] = [];
    for (const tile of this.#resident.values()) {
      if (tile.lodTransition === undefined) continue;
      snapshots.push(this.#captureLodFrameForTile(tile));
    }
    return snapshots;
  }

  #captureLodFrameForTile(tile: IResidentTile): ILodFrameSnapshot {
    const level = renderedLevel(tile);
    if (level === undefined)
      throw new Error("TerrainTiles cannot measure an LOD transition without a visible level.");
    return { heights: surfaceHeights(level), resolution: level.resolution, tile };
  }

  #recordLodPopAfterReconciliation(snapshots: readonly ILodFrameSnapshot[]): void {
    for (const snapshot of snapshots) {
      const level = renderedLevel(snapshot.tile);
      if (level === undefined)
        throw new Error("TerrainTiles cannot measure an LOD frame without a visible level.");
      this.#recordLodPop(surfaceDeltaFromSamples(snapshot.heights, snapshot.resolution, level));
    }
  }

  #recordLodPopAfterRetarget(snapshot: ILodFrameSnapshot | undefined): void {
    if (snapshot === undefined) return;
    const level = renderedLevel(snapshot.tile);
    if (level === undefined)
      throw new Error(
        "TerrainTiles cannot measure a retargeted LOD frame without a visible level.",
      );
    this.#recordLodPop(surfaceDeltaFromSamples(snapshot.heights, snapshot.resolution, level));
  }

  #advanceLodTransitions(): void {
    for (const tile of this.#blending) {
      const transition = tile.lodTransition;
      if (transition === undefined) continue;
      const from = tile.levels[transition.from];
      if (from === undefined || tile.levels[transition.to] === undefined)
        throw new Error("TerrainTiles LOD transition references a missing level.");
      transition.elapsedFrames += 1;
      transition.remainingFrames -= 1;
      updateLodTransitionGeometry(
        tile,
        transition,
        Math.min(1, transition.elapsedFrames / LOD_TRANSITION_FRAMES),
      );
      if (transition.remainingFrames > 0) {
        // A blend frame rewrote the finer level's vertices, which the ring state reads.
        this.#ringEpoch += 1;
        continue;
      }
      this.#ringEpoch += 1;
      this.#maxLodTransitionFrames = Math.max(
        this.#maxLodTransitionFrames,
        transition.elapsedFrames,
      );
      this.#restoreLodTransition(tile, transition);
      tile.lodTransition = undefined;
      this.#blending.delete(tile);
      setManualLodLevel(tile.lod, transition.to);
      this.#setLodVisibility(tile);
      // The end of a blend is the one moment a tile rejoins its settled block.
      this.#markTileDirty(tile);
    }
  }

  #coordinateNeighborLods(countTransitions: boolean): void {
    const pairs = collectNeighborPairs(this.#resident, this.#pairScratch);
    let changed = true;
    while (changed) {
      changed = false;
      for (const pair of pairs) {
        const correction = neighborLodCorrection(pair);
        if (correction === undefined) continue;
        const before = correction.coarser.lodLevel;
        this.#setLodLevel(correction.coarser, correction.level, countTransitions);
        if (correction.coarser.lodLevel === before) continue;
        changed = true;
      }
    }
  }

  /**
   * Recorded for the pairs this pass reconciled, after every pair is done: reconciling one pair
   * bumps a tile its other pairs share, and a signature taken mid-pass would mark those pairs
   * stale. A pair the pass left alone keeps the signature the settled check just compared against
   * — taking it again would be a second signature per pair per pass for the same answer.
   */
  #recordPairSignatures(
    pairs: readonly NeighborPair[],
    reconciled: ReadonlySet<string>,
    active: ReadonlySet<string>,
  ): void {
    for (const key of this.#pairSignatures.keys()) {
      if (!active.has(key)) this.#pairSignatures.delete(key);
    }
    for (const pair of pairs) {
      const key = neighborPairKey(pair);
      if (!reconciled.has(key)) continue;
      const state = seamState(pair, this.#stitches.get(key), this.#validate);
      if (state === undefined) this.#pairSignatures.delete(key);
      else this.#pairSignatures.set(key, state);
    }
  }

  /**
   * Whether a pair's seam is exactly as the last reconcile left it, bridge included: reconciling
   * restores both facing edges and then rewrites the bridge, so redoing a settled pair rewrote its
   * edges and recomputed whole-tile bounds every frame for nothing. A bridge corrupted from outside
   * changes that state and is reconciled and observed again, never healed silently. A settled
   * stitch still counts as stitched.
   */
  #settled(key: string, pair: NeighborPair): boolean {
    if (
      !sameState(
        seamState(pair, this.#stitches.get(key), this.#validate),
        this.#pairSignatures.get(key),
      )
    )
      return false;
    if (this.#stitches.has(key)) this.#stitchedEdges += 1;
    return true;
  }

  /**
   * Reconcile every seam that moved, then close the pass.
   *
   * The strips are built wherever the jobs run — a worker where the host has one, this thread where
   * it does not — so this loop only restores edges, collects what each bridge is made of, and swaps
   * in the arrays that come back. An inline host resolves inside the call and the pass closes before
   * `follow` returns, exactly as it did before the jobs moved; an off-thread host closes the pass in
   * the reply, and a frame that arrives first finds `#seamPending` and waits.
   */
  #reconcileNeighbors(): void {
    const pairs = collectNeighborPairs(this.#resident, this.#pairScratch);
    const active = new Set<string>();
    const reconciled = new Set<string>();
    const requests: { key: string; previousBytes: number; request: IStitchRequest }[] = [];
    for (const pair of pairs) {
      const key = neighborPairKey(pair);
      active.add(key);
      if (this.#settled(key, pair)) continue;
      reconciled.add(key);
      const previousBytes = this.#stitches.get(key)?.bytes ?? 0;
      const request = neighborBridgeRequest(pair);
      if (request === undefined) {
        this.#removeStitch(key);
        continue;
      }
      requests.push({ key, previousBytes, request });
    }
    for (const key of this.#stitches.keys()) {
      if (!active.has(key)) this.#removeStitch(key);
    }
    if (requests.length === 0) {
      timedSpan(SPANS.terrainSeam, () => this.#settleSeamPass(pairs, reconciled, active));
      return;
    }
    const job: ITerrainSeamJob = {
      kind: "seam",
      pairs: requests.map(({ request }) => ({ coarse: request.coarse, fine: request.fine })),
    };
    // The scratch array is reused by the next pass, so a reply that lands a frame later reads its
    // own copy of the pairs and not whatever the next pass left there.
    const snapshot = [...pairs];
    this.#seamPending = true;
    const result = timedSpan(SPANS.terrainSeam, () => this.#jobs.seam(job));
    settleJob(result, (settled) => {
      if (this.#released) return;
      timedSpan(SPANS.terrainSeam, () => {
        for (const [index, pending] of requests.entries()) {
          const data = settled.bridges[index];
          if (data === undefined) continue;
          this.#applyStitch(pending.key, pending.previousBytes, pending.request, data);
        }
        this.#settleSeamPass(snapshot, reconciled, active);
      });
    });
  }

  #applyStitch(
    key: string,
    previousBytes: number,
    request: IStitchRequest,
    data: ITerrainBridgeAttributes,
  ): void {
    const existing = this.#stitches.get(key);
    if (existing === undefined) {
      const bridge = newStitchBridge(request, data, this.#surface);
      this.#stitches.set(key, bridge);
      bridge.mesh.receiveShadow = this.#receiveShadow;
      this.add(bridge.mesh);
      this.#stitchBytes += bridge.bytes;
    } else {
      updateStitchBridge(existing, data);
      this.#stitchBytes += existing.bytes - previousBytes;
    }
    this.#stitchedEdges += 1;
  }

  /** Everything that closes a seam pass, once every bridge it asked for is in place. */
  #settleSeamPass(
    pairs: readonly NeighborPair[],
    reconciled: ReadonlySet<string>,
    active: ReadonlySet<string>,
  ): void {
    this.#seamPending = false;
    if (this.#validate) this.#recordSeamDiagnostics();
    this.#recordPairSignatures(pairs, reconciled, active);
    // Every edge restore and bridge rewrite this pass did is a change the ring state describes; the
    // pass is the only writer of either, so one bump here covers all of it.
    this.#ringEpoch += 1;
    if (this.residentBytes > this.residentByteBudget)
      throw new TerrainTileBudgetError(
        "TerrainTiles residentByteBudget cannot fit stitched neighbor geometry.",
      );
    if (this.#validate) {
      // The pass moved geometry, so the settled state is what it left behind, read into the buffer
      // the compare just filled; the buffer it compared against becomes the next frame's scratch.
      const scratch = this.#ringScratch;
      this.#ringScratch = this.#settledRing ?? [];
      this.#settledRing = scratch;
      this.#ringStateInto(this.#settledRing);
    }
    // Read after the pass, which moved geometry and bumped the epoch itself.
    this.#seamEpoch = this.#ringEpoch;
  }

  #finishLodTransition(tile: IResidentTile): void {
    const transition = tile.lodTransition;
    if (transition === undefined) return;
    this.#maxLodTransitionFrames = Math.max(this.#maxLodTransitionFrames, transition.elapsedFrames);
    this.#restoreLodTransition(tile, transition);
    tile.lodTransition = undefined;
    this.#blending.delete(tile);
    setManualLodLevel(tile.lod, transition.to);
    this.#setLodVisibility(tile);
  }

  #restoreLodTransition(tile: IResidentTile, transition: ILodTransition): void {
    const from = tile.levels[transition.from];
    const to = tile.levels[transition.to];
    if (from === undefined || to === undefined) return;
    restoreLevelSurface(tile.field, from.resolution >= to.resolution ? from : to);
  }

  #recordLodPop(pop: number): void {
    if (!Number.isFinite(pop)) throw new Error("TerrainTiles LOD pop observation must be finite.");
    this.#maxLodPop = Math.max(this.#maxLodPop, pop);
    if (pop > LOD_POP_THRESHOLD)
      throw new Error(
        `TerrainTiles LOD pop threshold ${String(LOD_POP_THRESHOLD)} exceeded by ${String(pop)}.`,
      );
  }

  #removeStitch(key: string): void {
    const bridge = this.#stitches.get(key);
    if (bridge === undefined) return;
    this.#stitches.delete(key);
    this.remove(bridge.mesh);
    this.#stitchBytes -= bridge.bytes;
    bridge.geometry.dispose();
  }

  #removeStitchesForTile(tileKey: string): void {
    for (const [key, bridge] of this.#stitches) {
      if (bridge.keys.includes(tileKey)) this.#removeStitch(key);
    }
  }

  /**
   * Reconcile and observe every seam, unless nothing a seam reads changed since the last pass.
   *
   * The change detector is `this` class's own epoch, bumped by every writer of the state the ring
   * pass describes: a tile admitted or evicted, a LOD level set, a transition started, stepped or
   * finished, a bridge written or an edge restored, a collider created or disposed. A settled
   * 289-tile ring used to rebuild an array of per-tile levels, geometry ids and attribute versions
   * and compare it with last frame's — 244 ms of a six-second walk, plus 139 ms of the bridge states
   * — to be told the same thing the epoch already said.
   *
   * The reconcile half always runs when the epoch moved; the observe half is validation, so with
   * `validate` off a frame pays for this compare and the geometry it changes and nothing else.
   *
   * Under validation the full ring-state compare stays, as the extra detector it now is: it is what
   * catches a writer that reached past this class's own bookkeeping — a buffer overwritten without
   * `needsUpdate`, a level mesh moved from outside — and the corrupted-buffer specs fail closed on
   * it. The epoch cannot see those, and the trade is deliberate: the shipped frame trusts the writers
   * it owns, and the validating frame still checks everything.
   */
  #seamPass(): void {
    if (this.#seamPending) {
      this.#stitchedEdges += this.#stitches.size;
      return;
    }
    if (this.#validate) {
      this.#ringStateInto(this.#ringScratch);
      if (sameState(this.#ringScratch, this.#settledRing)) {
        this.#stitchedEdges += this.#stitches.size;
        return;
      }
    } else if (this.#ringEpoch === this.#seamEpoch) {
      this.#stitchedEdges += this.#stitches.size;
      return;
    }
    if (this.#validate) this.#recordSeamDiagnostics(false);
    this.#reconcileNeighbors();
  }

  /** Counted so a frame that built one is visible; see `#ringStateInto`. */
  #ringStateBuilds = 0;

  #ringStateInto(state: number[]): void {
    this.#ringStateBuilds += 1;
    state.length = 0;
    for (const tile of this.#resident.values()) {
      const level = renderedLevel(tile);
      if (level === undefined) state.push(-1);
      else pushLevelState(state, level);
    }
    for (const bridge of this.#stitches.values()) pushBridgeState(state, bridge, this.#validate);
  }

  /**
   * Seam gaps are running maxima, so a pair observed in exactly this state already contributed its
   * gap: re-measuring every resident pair three times an update cost ~3 ms a frame on a 289-tile
   * ring for the same numbers. Only pairs whose levels or bridge changed are observed again.
   *
   * The pass stamps the pairs it visits and clears the mode of every pair it did not, so it neither
   * builds the `${key}|coverage` string nor the Set of live keys for each of the ring's 544 pairs
   * twice a frame — which on this pass was more work than the observations it was pruning for.
   */
  #recordSeamDiagnostics(includeBridgeCoverage = true): void {
    this.#observationPass += 1;
    const pass = this.#observationPass;
    for (const pair of collectNeighborPairs(this.#resident, this.#pairScratch)) {
      const key = neighborPairKey(pair);
      const bridge = this.#stitches.get(key);
      let observed = this.#observedSeams.get(key);
      if (observed === undefined) {
        observed = { coverage: undefined, plain: undefined, seenCoverage: 0, seenPlain: 0 };
        this.#observedSeams.set(key, observed);
      }
      if (includeBridgeCoverage) observed.seenCoverage = pass;
      else observed.seenPlain = pass;
      const state = seamState(pair, bridge, this.#validate);
      if (sameState(state, includeBridgeCoverage ? observed.coverage : observed.plain)) continue;
      if (state === undefined) {
        if (includeBridgeCoverage) observed.coverage = undefined;
        else observed.plain = undefined;
      } else if (includeBridgeCoverage) observed.coverage = state;
      else observed.plain = state;
      const { gap, visualGap } = seamObservation(
        pair[0],
        pair[1],
        bridge,
        this,
        includeBridgeCoverage,
      );
      this.#maxSeamGap = Math.max(this.#maxSeamGap, gap);
      this.#maxVisualSeamGap = Math.max(this.#maxVisualSeamGap, visualGap);
    }
    for (const [key, observed] of this.#observedSeams) {
      if (includeBridgeCoverage) {
        if (observed.seenCoverage !== pass) observed.coverage = undefined;
      } else if (observed.seenPlain !== pass) observed.plain = undefined;
      if (observed.coverage === undefined && observed.plain === undefined)
        this.#observedSeams.delete(key);
    }
  }

  #fieldAt(x: number, z: number): Heightfield {
    finite(x, "query x");
    finite(z, "query z");
    const tileX = Math.floor((x + this.tileSize / 2) / this.tileSize);
    const tileZ = Math.floor((z + this.tileSize / 2) / this.tileSize);
    const tile = this.#resident.get(keyFor(tileX, tileZ));
    if (tile === undefined)
      throw new Error(`TerrainTiles query (${x}, ${z}) is outside its resident region.`);
    return tile.field;
  }

  /**
   * Mark the block a tile's level belongs to for rebuild. Off with the merge, and cheap: one string
   * into a Set that at most holds the blocks a single frame's admissions, evictions and LOD moves
   * touched — the block geometry is rebuilt once, later, inside a frame's admission budget.
   */
  #markBlockDirty(lod: number, tileX: number, tileZ: number): void {
    if (!this.#mergeTiles) return;
    this.#dirtyBlocks.add(blockKeyFor(lod, tileX, tileZ));
  }

  #markTileDirty(tile: IResidentTile): void {
    this.#markBlockDirty(tile.lodLevel, tile.tileX, tile.tileZ);
  }

  /**
   * Let go of a block one of its tiles has left.
   *
   * A departure is the one ring change a rebuild cannot hide: the block's geometry still holds the
   * tile that just left, so it would draw that ground a second time — at the level the tile has left
   * — until this frame's one rebuild could replace it, and one rebuild a frame does not arrive before
   * the next departure. So the block stops being drawn the frame the departure happens, every tile it
   * still holds goes back to its own mesh, and the rebuild queue brings the block back whole. It is
   * dirty either way: the block has to be rebuilt whatever this does to it. (PRD-475.)
   */
  #releaseStaleBlock(lod: number, tileX: number, tileZ: number): void {
    if (!this.#mergeTiles) return;
    const blockKey = blockKeyFor(lod, tileX, tileZ);
    this.#markBlockDirty(lod, tileX, tileZ);
    if (this.#blocks.has(blockKey)) this.#dissolveBlock(blockKey);
  }

  /**
   * Rebuild one dirty block, charging it to the frame's admission budget like any other streamed
   * work. One, per frame, whatever the budget still holds: a rebuild concatenates a K×K block of
   * settled tile levels, and a follow that paid for every block its own streaming churn left dirty
   * is the frame-time spike this cap exists to prevent — the plan's `TN_FRAME_SPANS` check watches
   * for exactly that. A refused rebuild stays dirty and the next `follow` runs it, so N dirty blocks
   * take N frames and a still follow point converges.
   */
  #rebuildDirtyBlocks(budget: IAdmissionBudget | undefined): void {
    if (!this.#mergeTiles) return;
    const dirty = this.#nextDirtyBlock();
    if (dirty === undefined) return;
    const run = (): void => {
      this.#dirtyBlocks.delete(dirty);
      this.#rebuildBlock(dirty);
    };
    if (budget === undefined) {
      run();
      return;
    }
    if (!budget.admit(run)) this.#deferredAdmissions = 1;
  }

  /** The lowest block key still waiting for a merge of its own, so the one a frame spends is the same. */
  #nextDirtyBlock(): string | undefined {
    let first: string | undefined;
    for (const candidate of this.#dirtyBlocks) {
      if (this.#mergingBlocks.has(candidate)) continue;
      if (first === undefined || candidate < first) first = candidate;
    }
    return first;
  }

  /**
   * Build, or dissolve, one super-tile from the resident tiles it currently covers.
   *
   * Membership is recomputed from the resident set, never patched incrementally: a tile belongs iff
   * it is resident, settled (`lodTransition` undefined, so a morphing tile stays individual) and at
   * this block's LOD tier. A block of fewer than two tiles is dissolved rather than drawn — a single
   * merged mesh for one tile is the same draw with a copied geometry — and every tile that just left
   * the block has its own mesh restored.
   *
   * The concatenation runs as a job, so this thread names the block and the tile levels it covers and
   * then only swaps the attributes that come back.
   */
  #rebuildBlock(blockKey: string): void {
    const { lod, blockX, blockZ } = blockCoordinates(blockKey);
    const { members, parts } = this.#blockMembers(blockKey, lod);
    if (parts.length < 2) {
      this.#dissolveBlock(blockKey);
      // The tiles that remain here (a lone member, or none) draw their own meshes again.
      for (const key of members) this.#showTile(key, blockKey);
      return;
    }
    const blockOrigin = {
      x: blockX * TERRAIN_MERGE_BLOCK * this.tileSize,
      z: blockZ * TERRAIN_MERGE_BLOCK * this.tileSize,
    };
    this.#mergingBlocks.add(blockKey);
    const job = timedSpan(SPANS.terrainBlock, () => this.#jobs.merge(mergeJob(parts, blockOrigin)));
    const apply = (result: ITerrainMergeResult): void => {
      this.#mergingBlocks.delete(blockKey);
      if (this.#released) return;
      timedSpan(SPANS.terrainBlock, () =>
        this.#applyBlock({ blockKey, blockOrigin, lod, members }, result),
      );
    };
    if (job instanceof Promise)
      job.then(apply, (error: unknown) => {
        // Free the block for its next mark, and still name the failure.
        this.#mergingBlocks.delete(blockKey);
        console.error(`TN_TERRAIN_MERGE_FAILURE block=${blockKey} message=${String(error)}`);
      });
    else apply(job);
  }

  #applyBlock(
    plan: {
      readonly blockKey: string;
      readonly blockOrigin: IHeightfieldOrigin;
      readonly lod: number;
      readonly members: Set<string>;
    },
    result: ITerrainMergeResult,
  ): void {
    const { blockKey, blockOrigin, lod, members } = plan;
    const existing = this.#blocks.get(blockKey);
    const geometry = mergedBlockGeometry(result);
    const bytes = geometryBytes(geometry);
    this.#blockBytes += bytes - (existing?.bytes ?? 0);
    if (existing === undefined) {
      const mesh = terrainMesh(new Mesh(geometry, this.#surface));
      mesh.frustumCulled = true;
      mesh.name = `tn-terrain-block:${blockKey}`;
      // The merged geometry is written relative to the block origin, so the mesh carries it. Without
      // this the block drew a whole `blockOrigin` away from the tiles it replaced: floating slabs and
      // a hole where the ground is, at any block that is not at (0, 0). (PRD-475.)
      mesh.position.set(blockOrigin.x, 0, blockOrigin.z);
      mesh.receiveShadow = this.#receiveShadow;
      this.#blocks.set(blockKey, { bytes, geometry, key: blockKey, lod, members, mesh });
      this.add(mesh);
    } else {
      const left = existing.members;
      existing.geometry.dispose();
      existing.bytes = bytes;
      existing.mesh.geometry = geometry;
      // The record follows the geometry: the loop below restores the tiles this rebuild dropped, and
      // `terrainTiles` counts what the blocks hold, so a stale record here is a tile drawn twice or
      // not at all (PRD-475).
      existing.members = members;
      this.#blocks.set(blockKey, existing);
      for (const key of left) if (!members.has(key)) this.#showTile(key, blockKey);
    }
    for (const key of members) {
      this.#mergedMembers.set(key, blockKey);
      const tile = this.#resident.get(key);
      if (tile !== undefined) this.#setLodVisibility(tile);
    }
    this.#blockRebuilds += 1;
  }

  /** The resident settled tiles a block covers, and their level geometries to concatenate. */
  #blockMembers(
    blockKey: string,
    lod: number,
  ): { members: Set<string>; parts: { geometry: BufferGeometry; origin: IHeightfieldOrigin }[] } {
    const parts: { geometry: BufferGeometry; origin: IHeightfieldOrigin }[] = [];
    const members = new Set<string>();
    for (const tile of this.#resident.values()) {
      if (tile.lodLevel !== lod || tile.lodTransition !== undefined) continue;
      if (blockKeyFor(lod, tile.tileX, tile.tileZ) !== blockKey) continue;
      const level = tile.levels[lod];
      if (level === undefined) continue;
      parts.push({ geometry: level.geometry, origin: tile.origin });
      members.add(tile.key);
    }
    return { members, parts };
  }

  /** Restore a tile that left, or never joined, a block; a morphing tile keeps its blend visible. */
  #showTile(key: string, blockKey: string): void {
    if (this.#mergedMembers.get(key) === blockKey) this.#mergedMembers.delete(key);
    const tile = this.#resident.get(key);
    if (tile !== undefined && tile.lodTransition === undefined) this.#setLodVisibility(tile);
  }

  #dissolveBlock(blockKey: string): void {
    const block = this.#blocks.get(blockKey);
    if (block === undefined) return;
    this.#blocks.delete(blockKey);
    this.remove(block.mesh);
    this.#blockBytes -= block.bytes;
    block.geometry.dispose();
    for (const key of block.members) this.#showTile(key, blockKey);
  }

  #now(): number {
    const host = globalThis as { performance?: { now?: () => number } };
    return typeof host.performance?.now === "function" ? host.performance.now() : Date.now();
  }

  /**
   * `TN_TERRAIN_TILES`, every `TERRAIN_TILE_MARKER_MS`, with the merge on or off: the same census
   * before and after is the only way to read what the merge cut. A run that asked for validation also
   * gets the seam and LOD-pop maxima it is paying to measure, so a browser console run prints them
   * instead of only an in-process accessor ever reading them.
   */
  #reportTileMarker(): void {
    const now = this.#now();
    if (now - this.#tilesToldAt < TERRAIN_TILE_MARKER_MS) return;
    this.#tilesToldAt = now;
    const stats = this.terrainTiles;
    const measurements = this.#validate
      ? ` maxSeamGap=${String(this.maxSeamGap)} maxLodPop=${String(this.maxLodPop)} ` +
        `maxVisualSeamGap=${String(this.maxVisualSeamGap)}`
      : "";
    console.info(
      `TN_TERRAIN_TILES tiles=${String(stats.tiles)} blocks=${String(stats.blocks)} draws=${String(stats.draws)} blending=${String(stats.blending)} rebuilds=${String(stats.rebuilds)} blockBytes=${String(stats.blockBytes)}${measurements}`,
    );
  }

  #evict(tile: IResidentTile): void {
    this.#blending.delete(tile);
    if (this.#mergeTiles) {
      this.#releaseStaleBlock(tile.lodLevel, tile.tileX, tile.tileZ);
      this.#mergedMembers.delete(tile.key);
    }
    if (this.#resident.get(tile.key) === tile) this.#resident.delete(tile.key);
    this.#ringEpoch += 1;
    this.#removeStitchesForTile(tile.key);
    this.remove(tile.lod);
    tile.collider?.dispose();
    tile.field.detach();
    for (const level of tile.levels) level.geometry.dispose();
    this.#releaseAsset(tile);
  }

  #disposeTile(tile: IResidentTile): void {
    tile.collider?.dispose();
    tile.field.detach();
    for (const level of tile.levels) level.geometry.dispose();
    tile.lod.removeFromParent();
    this.#releaseAsset(tile);
  }

  #releaseAsset(tile: IResidentTile): void {
    if (this.#assets === undefined || tile.assetKey === undefined) return;
    const stillReferenced = [...this.#resident.values()].some(
      (resident) => resident !== tile && resident.assetKey === tile.assetKey,
    );
    if (!stillReferenced) this.#assets.release("model", tile.assetKey);
  }

  #recordPeaks(): void {
    this.#peakTiles = Math.max(this.#peakTiles, this.residentTileCount);
    this.#peakBytes = Math.max(this.#peakBytes, this.residentBytes);
  }
}
