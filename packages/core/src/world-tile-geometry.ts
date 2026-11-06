/**
 * The terrain geometry `TerrainTiles` builds and keeps: level meshes, skirts, edges, stitch strips and
merged blocks. Split out of `world-tiles.ts` verbatim (PRD-797).
 */

import { Box3, BufferAttribute, BufferGeometry, Mesh, Sphere, Vector3 } from "three";
import { edgeWorldPoint } from "./terrain-jobs.js";
import type {
  ITerrainBridgeAttributes,
  ITerrainEdgeJob,
  ITerrainFineEdgeJob,
  ITerrainMergeJob,
  ITerrainMergeResult,
} from "./terrain-jobs.js";
import type { Heightfield, IHeightfieldOrigin } from "./world-heightfield.js";
import {
  edgeVertexHeight,
  edgeVertexIndex,
  tileEdgeFrame,
  validateBridgeTriangleTopology,
} from "./world-tile-observation.js";
export type MeshSurface = NonNullable<ConstructorParameters<typeof Mesh>[1]>;
import { CONSTRUCTION_CHUNK_SAMPLES, edgeSamplesFor, resolutionFor } from "./world-tile-budget.js";
import type { IEdgeSamples, ILevelGeometry, IResidentTile, IStitchBridge } from "./world-tiles.js";
export function appendQuad(
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
export function* fieldHeightGrid(
  field: Heightfield,
  chunked: boolean,
): Generator<void, Float32Array> {
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
export function fieldStep(field: Heightfield, resolution: number): number {
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
export function terrainMesh(mesh: Mesh): Mesh {
  mesh.userData.tnDrawSource = "terrain";
  // Visibility only swaps this mesh with a twin over the same ground (its merged block, or the
  // neighbouring LOD level), so a cached shadow map need not redraw for it; see `casterFlag`.
  mesh.userData.tnShadowSwap = true;
  return mesh;
}

/** Three's box/sphere arithmetic, over the same float32 positions, in admission-sized scans. */
export function* levelBounds(
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

export function* buildLevel(
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
  geometry.morphTargetsRelative = true;
  geometry.setAttribute("position", new BufferAttribute(positionArray, 3));
  geometry.setAttribute("normal", new BufferAttribute(Float32Array.from(normals), 3));
  geometry.setIndex(new BufferAttribute(Uint32Array.from(indices), 1));
  geometry.boundingBox = bounds.box;
  geometry.boundingSphere = bounds.sphere;
  const skirt = inspectSkirtGeometry(geometry, resolution, edges);
  return {
    surfaceError: 0,
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
export function mergedBlockGeometry(result: ITerrainMergeResult): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(result.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(result.normals, 3));
  geometry.setIndex(new BufferAttribute(result.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** One settled tile level's attributes, as the merge job reads them. */
export function mergeJob(
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

export function inspectSkirtGeometry(
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

export function refreshEdgeSamples(level: ILevelGeometry): void {
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
export function restoreLevelEdge(
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
export function edgeJob(
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
export function fineEdgeJob(
  tile: IResidentTile,
  level: ILevelGeometry,
  side: keyof IEdgeSamples,
): ITerrainFineEdgeJob {
  return { ...edgeJob(tile, level, side), resolution: level.resolution };
}

export function stitchGeometry(data: ITerrainBridgeAttributes): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(data.positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(data.normals, 3));
  geometry.setIndex(new BufferAttribute(data.indices, 1));
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function geometryBytes(geometry: BufferGeometry): number {
  const index = geometry.getIndex();
  return (
    geometry.getAttribute("position").array.byteLength +
    geometry.getAttribute("normal").array.byteLength +
    (index?.array.byteLength ?? 0)
  );
}

export function updateStitchBridge(bridge: IStitchBridge, data: ITerrainBridgeAttributes): void {
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

export function updateLevelSkirts(level: ILevelGeometry): void {
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

export function restoreLevelSurface(field: Heightfield, level: ILevelGeometry): void {
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
