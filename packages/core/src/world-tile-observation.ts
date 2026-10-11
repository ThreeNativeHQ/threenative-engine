import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  Matrix4,
  Object3D,
} from "three";

import { Vector3 } from "three";

import type { ITerrainEdgeFrame } from "./terrain-jobs.js";
import { edgeWorldPoint } from "./terrain-jobs.js";
import type {
  IEdgeSamples,
  ILevelGeometry,
  IResidentTile,
  IStitchBridge,
  NeighborPair,
} from "./world-tiles.js";

import type { Heightfield } from "./world.js";

export const BRIDGE_COORDINATE_EPSILON = 1e-4;

export const BRIDGE_COORDINATE_RELATIVE_EPSILON = 2 ** -22;

export const BRIDGE_STRIP_INDEX_PATTERN = [0, 1, 2, 2, 1, 3, 2, 1, 0, 3, 1, 2] as const;

export type PositionAttribute = BufferAttribute | InterleavedBufferAttribute;

export function bridgeCoordinateMatches(actual: number, expected: number): boolean {
  return (
    Math.abs(actual - expected) <=
    Math.max(
      BRIDGE_COORDINATE_EPSILON,
      Math.max(1, Math.abs(actual), Math.abs(expected)) * BRIDGE_COORDINATE_RELATIVE_EPSILON,
    )
  );
}

/** One field's own rectangle and side, which is all a world point along an edge needs. */
export function tileEdgeFrame(field: Heightfield, side: keyof IEdgeSamples): ITerrainEdgeFrame {
  return { depth: field.depth, origin: field.origin, side, width: field.width };
}

function edgeVertexIndex(level: ILevelGeometry, side: keyof IEdgeSamples, index: number): number {
  const row = side === "north" ? 0 : side === "south" ? level.resolution - 1 : index;
  const column = side === "west" ? 0 : side === "east" ? level.resolution - 1 : index;
  return row * level.resolution + column;
}

export function opposingEdge(
  a: IResidentTile,
  b: IResidentTile,
): [keyof IEdgeSamples, keyof IEdgeSamples] {
  if (a.tileX < b.tileX) return ["east", "west"];
  if (a.tileX > b.tileX) return ["west", "east"];
  if (a.tileZ < b.tileZ) return ["south", "north"];
  return ["north", "south"];
}

export function renderedLevel(tile: IResidentTile): ILevelGeometry | undefined {
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
export function pushLevelState(state: number[], level: ILevelGeometry): void {
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
export function pushPairState(state: number[], pair: NeighborPair): boolean {
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
export function pushBridgeState(state: number[], bridge: IStitchBridge, validate: boolean): void {
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

export function seamState(
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

export function edgeWorldVertexHeight(
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

export function edgeWorldHeight(
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

export function bridgeEndpointWorldHeight(
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

export function bridgeEndpointHeight(
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

export interface IBridgeEndpoint {
  readonly level: ILevelGeometry;
  readonly side: keyof IEdgeSamples;
  readonly tile: IResidentTile;
}

export function bridgeEndpointPair(
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

export function validateBridgeTriangleTopology(
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

export function seamCoverageDepth(a: IResidentTile, b: IResidentTile): number {
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
export interface IEdgeWalk {
  readonly first: number;
  readonly heights: Float32Array;
  readonly resolution: number;
  readonly span: number;
}

export function edgeWalk(level: ILevelGeometry, side: keyof IEdgeSamples): IEdgeWalk {
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

export function edgeWalkHeight(walk: IEdgeWalk, index: number): number {
  const lower = walk.heights[walk.first + index * walk.span] as number;
  if (!Number.isFinite(lower))
    throw new Error("TerrainTiles seam diagnostic edge height must be finite.");
  return lower;
}

/** The walk's height at `normalized`, interpolating exactly as `edgeHeight` does. */
export function edgeWalkAt(walk: IEdgeWalk, normalized: number): number {
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
export interface IBridgeCoverage {
  readonly bridge: IStitchBridge;
  readonly coarser: IBridgeEndpoint;
  readonly finer: IBridgeEndpoint;
  readonly position: PositionAttribute;
}

export function bridgeCoverageContext(
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

export function bridgeCoverageAt(
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

export function seamObservation(
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

export { edgeVertexIndex, positionFingerprint, sameState, edgeVertexHeight };
