/**
 * Seam planning: which resident pairs face each other, which LOD levels a pair may differ by, and the
bridge request the job runner turns into a strip. Split out of `world-tiles.ts` verbatim (PRD-797).
 */

import { BufferGeometry, type LOD, Mesh } from "three";
import type {
  ITerrainBridgeAttributes,
  ITerrainEdgeJob,
  ITerrainFineEdgeJob,
} from "./terrain-jobs.js";
import { keyFor } from "./world-tile-budget.js";
import {
  type MeshSurface,
  edgeJob,
  fineEdgeJob,
  geometryBytes,
  restoreLevelEdge,
  stitchGeometry,
  terrainMesh,
} from "./world-tile-geometry.js";
import { opposingEdge, renderedLevel } from "./world-tile-observation.js";
import type { IResidentTile, IStitchBridge, NeighborPair } from "./world-tiles.js";
/**
 * One pair's bridge, as the seam job carries it: the two edges it is made of, and what the bridge it
 * produces is called and keyed by.
 */
export interface IStitchRequest {
  readonly coarse: ITerrainEdgeJob;
  readonly fine: ITerrainFineEdgeJob;
  readonly keys: [string, string];
  readonly resolution: number;
}

export function neighborPairKey(pair: NeighborPair): string {
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
export function neighborPairs(tiles: ReadonlyMap<string, IResidentTile>): NeighborPair[] {
  const pairs: NeighborPair[] = [];
  collectNeighborPairs(tiles, pairs);
  return pairs;
}

/** `neighborPairs` into a buffer the caller already owns, so a frame allocates no pair arrays. */
export function collectNeighborPairs(
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

export function hasPendingTarget(targets: ReadonlyMap<IResidentTile, number>): boolean {
  for (const [tile, target] of targets)
    if (Math.min(target, tile.maxLodLevel) !== tile.lodLevel) return true;
  return false;
}

/** Each resident tile's target level after the neighbour rule: no two neighbours two levels apart. */
export function coordinatedLevels(
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

export function neighborLodCorrection(
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
export function neighborBridgeRequest(pair: NeighborPair): IStitchRequest | undefined {
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

export function newStitchBridge(
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

export function setManualLodLevel(lod: LOD, level: number): void {
  // Three's renderer reads `autoUpdate`, and its update method owns this private-ish marker. Keep
  // that marker aligned with the visible child for callers that inspect the composed LOD.
  (lod as LOD & { _currentLevel: number })._currentLevel = level;
}
