/**
 * LOD sampling and blending: the level interpolations the pop measurement reads, the morph targets a
transition walks, and the surface delta that decides how coarse a level may be. Split out of
`world-tiles.ts` verbatim (PRD-797).
 */

import { BufferAttribute, type BufferGeometry, Vector3 } from "three";
import {
  CONSTRUCTION_CHUNK_SAMPLES,
  LOD_POP_THRESHOLD,
  LOD_TRANSITION_FRAMES,
} from "./world-tile-budget.js";
import { refreshEdgeSamples, updateLevelSkirts } from "./world-tile-geometry.js";
import type { ILevelGeometry, ILodTransition, IResidentTile } from "./world-tiles.js";
export function levelHeight(
  position: BufferAttribute,
  resolution: number,
  row: number,
  column: number,
): number {
  const value = position.getY(row * resolution + column);
  if (!Number.isFinite(value)) throw new Error("TerrainTiles LOD geometry has an invalid height.");
  return value;
}

export function interpolatedLevelHeight(
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

export function interpolatedLevelNormal(
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

export const morphSourceVersions = new WeakMap<
  BufferGeometry,
  readonly { attribute: BufferAttribute; version: number }[]
>();

/** Immutable stock morph buffers; shared sides keep the canonical surface used by seam jobs. */
export function* buildLodMorphTargets(
  finer: ILevelGeometry,
  coarserLevels: readonly ILevelGeometry[],
  sharedEdges: number,
  chunked: boolean,
  previous?: BufferGeometry,
): Generator<void> {
  const sources = [finer, ...coarserLevels].flatMap((level) =>
    ["position", "normal"].map((name) => {
      const attribute = level.geometry.getAttribute(name) as BufferAttribute;
      return { attribute, version: attribute.version };
    }),
  );
  const retained = previous === undefined ? undefined : morphSourceVersions.get(previous);
  const boundaryOnly =
    retained?.length === sources.length &&
    sources.every(
      ({ attribute, version }, index) =>
        retained[index]?.attribute === attribute && retained[index]?.version === version,
    );
  const position = finer.geometry.getAttribute("position");
  const normal = finer.geometry.getAttribute("normal");
  const positions: BufferAttribute[] = [];
  const normals: BufferAttribute[] = [];
  const coarseNormal = new Vector3();
  const last = finer.resolution - 1;
  for (const [target, coarser] of coarserLevels.entries()) {
    const deltaPosition = boundaryOnly
      ? (finer.geometry.morphAttributes.position?.[target] as BufferAttribute).clone()
      : new BufferAttribute(new Float32Array(position.count * 3), 3);
    const deltaNormal = boundaryOnly
      ? (finer.geometry.morphAttributes.normal?.[target] as BufferAttribute).clone()
      : new BufferAttribute(new Float32Array(position.count * 3), 3);
    const coarsePosition = coarser.geometry.getAttribute("position") as BufferAttribute;
    const coarseNormals = coarser.geometry.getAttribute("normal") as BufferAttribute;
    for (let row = 0; row <= last; row += 1) {
      // Mask changes only affect the perimeter when every source buffer is unchanged.
      const columnStep = boundaryOnly && row > 0 && row < last ? last : 1;
      for (let column = 0; column <= last; column += columnStep) {
        const index = row * finer.resolution + column;
        const pinned =
          (row === 0 && sharedEdges & 1) ||
          (row === last && sharedEdges & 2) ||
          (column === 0 && sharedEdges & 4) ||
          (column === last && sharedEdges & 8);
        if (pinned) {
          deltaPosition.setY(index, 0);
          deltaNormal.setXYZ(index, 0, 0, 0);
        } else {
          deltaPosition.setY(
            index,
            interpolatedLevelHeight(coarser, coarsePosition, column / last, row / last) -
              position.getY(index),
          );
          interpolatedLevelNormal(coarser, coarseNormals, column / last, row / last, coarseNormal);
          deltaNormal.setXYZ(
            index,
            coarseNormal.x - normal.getX(index),
            coarseNormal.y - normal.getY(index),
            coarseNormal.z - normal.getZ(index),
          );
        }
        if (chunked && (index + 1) % (CONSTRUCTION_CHUNK_SAMPLES / 2) === 0) yield;
      }
    }
    const edges = [
      (index: number) => index,
      (index: number) => last * finer.resolution + index,
      (index: number) => index * finer.resolution,
      (index: number) => index * finer.resolution + last,
    ];
    for (const [edgeIndex, edge] of edges.entries())
      for (let index = 0; index <= last; index += 1)
        deltaPosition.setY(
          finer.resolution ** 2 + edgeIndex * finer.resolution + index,
          deltaPosition.getY(edge(index)),
        );
    positions.push(deltaPosition);
    normals.push(deltaNormal);
  }
  finer.geometry.morphAttributes.position = positions;
  finer.geometry.morphAttributes.normal = normals;
  morphSourceVersions.set(finer.geometry, sources);
}

export function updateLodMorph(
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
  const target = tile.levels
    .filter((level) => level !== finer && level.resolution <= finer.resolution)
    .indexOf(coarser);
  const influences = finer.mesh.morphTargetInfluences;
  if (influences === undefined || influences[target] === undefined)
    throw new Error("TerrainTiles LOD transition references a missing morph target.");
  influences.fill(0);
  influences[target] = finer === from ? progress : 1 - progress;
}

/**
 * A blend only ever moves a vertex between the two levels' surfaces, so the union of the two
 * known bounds holds every frame of it. Widened once when the transition starts instead of
 * recomputed per blend frame: `computeBoundingBox` + `computeBoundingSphere` walked the finer
 * level's ~8,600 positions every frame of every transition (56 + 45 + 27 + 29 ms over a six-second
 * walk). `#restoreLodTransition` puts the finer level's own bounds back when the blend ends.
 */
export function widenLevelBoundsForBlend(finer: ILevelGeometry, coarser: ILevelGeometry): void {
  const box = finer.geometry.boundingBox;
  const sphere = finer.geometry.boundingSphere;
  const coarserBox = coarser.geometry.boundingBox;
  if (box === null || sphere === null || coarserBox === null)
    throw new Error("TerrainTiles LOD transition needs both levels' bounds to be known.");
  box.union(coarserBox);
  box.getBoundingSphere(sphere);
}

export function updateLodTransitionGeometry(
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

export function* surfaceHeightChunks(
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

export function surfaceHeights(level: ILevelGeometry): Float32Array {
  return surfaceHeightChunks(level, false).next().value as Float32Array;
}

export function interpolatedSamplesHeight(
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

export function* surfaceDeltaChunks(
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

export function surfaceDeltaFromSamples(
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
export function* coarsestSelectableLevel(
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
    level.surfaceError = error;
    if (error > LOD_POP_THRESHOLD) break;
    coarsest = index;
  }
  return coarsest;
}
