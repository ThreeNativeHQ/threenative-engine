import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  Vector3,
} from "three";
import { MeshBVH, SAH } from "three-mesh-bvh";
import * as upstreamWebGPU from "three-mesh-bvh/webgpu";
import { storage } from "three/tsl";
import { StorageBufferAttribute, type StorageBufferNode, type StructTypeNode } from "three/webgpu";
import type { IComputeDriven } from "./compute-driven.js";
import type { IRendererLike } from "./renderer.js";

/** Selects the meshes that become part of a GPU trace set. */
export interface IGPUSceneBVHOptions {
  readonly include?: (object: Mesh) => boolean;
}

/**
 * A material range expressed in packed index elements, after the BVH leaf reorder.
 *
 * `start` and `count` address the uploaded index buffer, not the source geometry, so a single
 * source material can appear as more than one range once the SAH sort interleaves its triangles.
 */
export interface IGPUSceneBVHMaterialGroup {
  readonly count: number;
  readonly materialIndex: number;
  readonly start: number;
}

interface IUpstreamWebGPU {
  readonly bvhNodeStruct: StructTypeNode;
  readonly rayStruct: StructTypeNode;
  readonly bvhIntersectFirstHit: GPUSceneBVHTraceFunction;
}

interface INodeBackings {
  indices: StorageBufferNode<"uvec3"> | null;
  nodes: StorageBufferNode<"struct"> | null;
  normals: StorageBufferNode<"vec3"> | null;
  positions: StorageBufferNode<"vec3"> | null;
}

interface IPackedScene {
  readonly geometry: BufferGeometry;
  readonly indices: Uint32Array;
  readonly materialGroups: readonly IGPUSceneBVHMaterialGroup[];
  readonly nodes: Uint32Array;
  readonly normals: Float32Array;
  readonly objectCount: number;
  readonly positions: Float32Array;
  readonly triangleCount: number;
  readonly vertexCount: number;
}

interface IBuildState {
  indices: number[];
  normals: number[];
  objectCount: number;
  positions: number[];
  triangleCount: number;
  triangleMaterials: number[];
}

interface IRange {
  readonly count: number;
  readonly materialIndex: number;
  readonly start: number;
}

// three-mesh-bvh/webgpu ships no type declarations for bvhIntersectFirstHit, rayStruct or
// bvhNodeStruct. Shaping the module object once, here, is what keeps the cast out of every
// call site.
// quality-allow: upstream three-mesh-bvh/webgpu exports are untyped; shaped once behind IUpstreamWebGPU
const upstream = upstreamWebGPU as unknown as IUpstreamWebGPU;
const EMPTY_NODE_WORDS = 8;
const NODE_WORDS = 8;
const now = (): number => globalThis.performance?.now() ?? Date.now();

/** The upstream TSL ray query, exposed without renaming or wrapping it. */
export type GPUSceneBVHTraceFunction = (...args: readonly unknown[]) => unknown;
export const bvhIntersectFirstHit = upstream.bvhIntersectFirstHit;
export const rayStruct = upstream.rayStruct;

function storageAttribute<T extends ArrayBufferView>(
  array: T,
  itemSize: number,
): StorageBufferAttribute {
  return new StorageBufferAttribute(array as never, itemSize);
}

function readStorage<T extends "vec3" | "uvec3">(
  array: Float32Array | Uint32Array,
  type: T,
  itemSize: number,
): StorageBufferNode<T> {
  return storage(storageAttribute(array, itemSize), type, array.length / itemSize).toReadOnly();
}

function readNodeStorage(array: Uint32Array): StorageBufferNode<"struct"> {
  return storage(
    storageAttribute(array, NODE_WORDS),
    upstream.bvhNodeStruct as never,
    array.length / NODE_WORDS,
  ).toReadOnly() as StorageBufferNode<"struct">;
}

function disposeStorage(
  node: StorageBufferNode<"struct"> | StorageBufferNode<"vec3"> | StorageBufferNode<"uvec3"> | null,
): void {
  node?.value.dispose();
}

function replaceStorage<
  T extends StorageBufferNode<"struct"> | StorageBufferNode<"vec3"> | StorageBufferNode<"uvec3">,
>(current: T, next: T): void {
  current.value.dispose();
  current.value = next.value;
}

function emptyNodes(): Uint32Array {
  const words = new Uint32Array(EMPTY_NODE_WORDS);
  const bounds = new Float32Array(words.buffer);
  bounds[0] = 0;
  bounds[1] = 0;
  bounds[2] = 0;
  bounds[3] = 0;
  bounds[4] = 0;
  bounds[5] = 0;
  words[6] = 0;
  words[7] = 0xffff0000;
  return words;
}

function rangesFor(geometry: BufferGeometry, indexCount: number): readonly IRange[] {
  const drawStart = Math.min(indexCount, Math.max(0, Math.floor(geometry.drawRange.start)));
  const drawCount = Number.isFinite(geometry.drawRange.count)
    ? Math.max(0, Math.floor(geometry.drawRange.count))
    : indexCount - drawStart;
  const drawEnd = Math.min(indexCount, drawStart + drawCount);
  const groups = geometry.groups;
  if (groups.length === 0) {
    return [
      {
        count: Math.max(0, drawEnd - drawStart) - ((drawEnd - drawStart) % 3),
        materialIndex: 0,
        start: drawStart,
      },
    ];
  }
  return groups.flatMap((group) => {
    const start = Math.max(drawStart, Math.floor(group.start));
    const requestedCount = Number.isFinite(group.count)
      ? Math.max(0, Math.floor(group.count))
      : indexCount - start;
    const count = Math.min(drawEnd, start + requestedCount) - start;
    const alignedCount = count - (count % 3);
    return alignedCount > 0
      ? [{ count: alignedCount, materialIndex: group.materialIndex ?? 0, start }]
      : [];
  });
}

function matrixFor(mesh: Mesh, instance: number, target: Matrix4): Matrix4 {
  if (mesh instanceof InstancedMesh) {
    mesh.getMatrixAt(instance, target);
    return target.premultiply(mesh.matrixWorld);
  }
  return target.copy(mesh.matrixWorld);
}

function appendVertices(
  mesh: Mesh,
  position: ReturnType<BufferGeometry["getAttribute"]>,
  normal: ReturnType<BufferGeometry["getAttribute"]>,
  matrix: Matrix4,
  normalMatrix: Matrix3,
  state: IBuildState,
): void {
  const localPosition = new Vector3();
  const worldPosition = new Vector3();
  const localNormal = new Vector3();
  const worldNormal = new Vector3();
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    mesh.getVertexPosition(vertex, localPosition);
    worldPosition.copy(localPosition).applyMatrix4(matrix);
    state.positions.push(worldPosition.x, worldPosition.y, worldPosition.z);
    if (normal === undefined) localNormal.set(0, 1, 0);
    else localNormal.set(normal.getX(vertex), normal.getY(vertex), normal.getZ(vertex));
    worldNormal.copy(localNormal).applyNormalMatrix(normalMatrix).normalize();
    state.normals.push(worldNormal.x, worldNormal.y, worldNormal.z);
  }
}

function padVec3(array: Float32Array): Float32Array {
  const padded = new Float32Array((array.length / 3) * 4);
  for (let source = 0, target = 0; source < array.length; source += 3, target += 4) {
    padded[target] = array[source] ?? 0;
    padded[target + 1] = array[source + 1] ?? 0;
    padded[target + 2] = array[source + 2] ?? 0;
  }
  return padded;
}

function appendTriangles(
  index: ReturnType<BufferGeometry["getIndex"]>,
  ranges: readonly IRange[],
  vertexOffset: number,
  state: IBuildState,
): void {
  for (const range of ranges) {
    for (let element = range.start; element < range.start + range.count; element += 1) {
      const sourceIndex = index === null ? element : index.getX(element);
      state.indices.push(vertexOffset + sourceIndex);
    }
    const triangles = range.count / 3;
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      state.triangleMaterials.push(range.materialIndex);
    }
    state.triangleCount += triangles;
  }
}

function appendMesh(mesh: Mesh, state: IBuildState): void {
  const position = mesh.geometry.getAttribute("position");
  if (position === undefined || position.count === 0) return;
  const index = mesh.geometry.getIndex();
  const ranges = rangesFor(mesh.geometry, index?.count ?? position.count);
  if (ranges.length === 0) return;
  state.objectCount += 1;
  const instances = mesh instanceof InstancedMesh ? Math.max(0, mesh.count) : 1;
  const matrix = new Matrix4();
  const normalMatrix = new Matrix3();
  const normal = mesh.geometry.getAttribute("normal");
  for (let instance = 0; instance < instances; instance += 1) {
    const vertexOffset = state.positions.length / 3;
    matrixFor(mesh, instance, matrix);
    normalMatrix.getNormalMatrix(matrix);
    appendVertices(mesh, position, normal, matrix, normalMatrix, state);
    appendTriangles(index, ranges, vertexOffset, state);
  }
}

/** Run-length encode a per-triangle material assignment into packed index element ranges. */
function materialGroupsFor(materials: Uint32Array): IGPUSceneBVHMaterialGroup[] {
  const groups: IGPUSceneBVHMaterialGroup[] = [];
  let runStart = 0;
  for (let triangle = 1; triangle <= materials.length; triangle += 1) {
    if (triangle < materials.length && materials[triangle] === materials[runStart]) continue;
    groups.push({
      count: (triangle - runStart) * 3,
      materialIndex: materials[runStart] ?? 0,
      start: runStart * 3,
    });
    runStart = triangle;
  }
  return groups;
}

/**
 * Materialise the packed index buffer in BVH leaf order and permute the material assignment with
 * it, so a leaf's triangle offset and the material ranges address the same layout.
 */
function permuteToLeafOrder(
  bvh: MeshBVH,
  sourceIndices: Uint32Array,
  sourceMaterials: readonly number[],
): { indices: Uint32Array; materialGroups: IGPUSceneBVHMaterialGroup[] } {
  const triangleCount = sourceIndices.length / 3;
  const indices = new Uint32Array(sourceIndices.length);
  const materials = new Uint32Array(triangleCount);
  for (let slot = 0; slot < triangleCount; slot += 1) {
    const triangle = bvh.resolveTriangleIndex(slot);
    indices[slot * 3] = sourceIndices[triangle * 3] ?? 0;
    indices[slot * 3 + 1] = sourceIndices[triangle * 3 + 1] ?? 0;
    indices[slot * 3 + 2] = sourceIndices[triangle * 3 + 2] ?? 0;
    materials[slot] = sourceMaterials[triangle] ?? 0;
  }
  return { indices, materialGroups: materialGroupsFor(materials) };
}

function packScene(scene: Object3D, include: (object: Mesh) => boolean): IPackedScene {
  scene.updateMatrixWorld(true);
  const state: IBuildState = {
    indices: [],
    normals: [],
    objectCount: 0,
    positions: [],
    triangleCount: 0,
    triangleMaterials: [],
  };
  scene.traverse((candidate) => {
    if (!(candidate instanceof Mesh) || candidate.visible === false || !include(candidate)) return;
    appendMesh(candidate, state);
  });

  const tightPositions = new Float32Array(
    state.positions.length === 0 ? [0, 0, 0] : state.positions,
  );
  const tightNormals = new Float32Array(state.normals.length === 0 ? [0, 1, 0] : state.normals);
  const positions = padVec3(tightPositions);
  const normals = padVec3(tightNormals);
  const sourceIndices = new Uint32Array(state.indices.length === 0 ? [0, 0, 0] : state.indices);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(tightPositions, 3));
  geometry.setIndex(new BufferAttribute(sourceIndices, 1));

  let nodes = emptyNodes();
  let indices: Uint32Array = sourceIndices;
  let materialGroups: readonly IGPUSceneBVHMaterialGroup[] = [];
  if (state.indices.length > 0) {
    // Indirect keeps `geometry.index` in source order, so the material assignment collected above
    // still lines up with it; the leaf order is then applied to both at once below.
    const bvh = new MeshBVH(geometry, {
      indirect: true,
      strategy: SAH,
      targetLeafSize: 10,
      verbose: false,
    });
    const serialized = MeshBVH.serialize(bvh, { cloneBuffers: false });
    const root = serialized.roots[0];
    if (root === undefined) throw new Error("GPUSceneBVH could not serialize its root node.");
    nodes = new Uint32Array(root);
    const permuted = permuteToLeafOrder(bvh, sourceIndices, state.triangleMaterials);
    indices = permuted.indices;
    materialGroups = permuted.materialGroups;
  }
  return {
    geometry,
    indices,
    materialGroups,
    nodes,
    normals,
    objectCount: state.objectCount,
    positions,
    triangleCount: state.triangleCount,
    vertexCount: tightPositions.length / 3,
  };
}

/**
 * Snapshot selected scene meshes into world-space storage buffers for an upstream TSL BVH query.
 *
 * This class owns packing, residency, and release. It deliberately does not own the ray query or
 * a rendered effect: a game imports the exact upstream `bvhIntersectFirstHit` and `rayStruct`
 * exports through the core entry point and uses these four named nodes in its own `src/render/`
 * kernel. The snapshot is static until `rebuild()`.
 */
export class GPUSceneBVH extends Group implements IComputeDriven {
  #backings: INodeBackings = {
    indices: readStorage(new Uint32Array([0, 0, 0]), "uvec3", 3),
    nodes: readNodeStorage(emptyNodes()),
    normals: readStorage(new Float32Array([0, 1, 0, 0]), "vec3", 4),
    positions: readStorage(new Float32Array([0, 0, 0, 0]), "vec3", 4),
  };
  readonly indices: StorageBufferNode<"uvec3">;
  readonly nodes: StorageBufferNode<"struct">;
  readonly normals: StorageBufferNode<"vec3">;
  readonly positions: StorageBufferNode<"vec3">;
  readonly warmupNodes: readonly unknown[] = [];
  #buildMs = 0;
  #include: (object: Mesh) => boolean;
  #materialGroups: readonly IGPUSceneBVHMaterialGroup[] = [];
  #objectCount = 0;
  #packedGeometry: BufferGeometry | undefined;
  #positions = 0;
  #released = false;
  #scene: Object3D;
  #triangleCount = 0;

  constructor(scene: Object3D, options: IGPUSceneBVHOptions = {}) {
    super();
    if (scene?.isObject3D !== true) throw new Error("GPUSceneBVH.scene must be an Object3D.");
    if (options.include !== undefined && typeof options.include !== "function") {
      throw new Error("GPUSceneBVH.include must be a function when provided.");
    }
    this.#scene = scene;
    this.#include = options.include ?? (() => true);
    this.nodes = this.#backings.nodes as StorageBufferNode<"struct">;
    this.positions = this.#backings.positions as StorageBufferNode<"vec3">;
    this.indices = this.#backings.indices as StorageBufferNode<"uvec3">;
    this.normals = this.#backings.normals as StorageBufferNode<"vec3">;
    this.addEventListener("removed", this.#onRemoved);
    this.rebuild();
  }

  get buildMs(): number {
    return this.#buildMs;
  }

  get materialGroups(): readonly IGPUSceneBVHMaterialGroup[] {
    return this.#materialGroups;
  }

  get objectCount(): number {
    return this.#objectCount;
  }

  get released(): boolean {
    return this.#released;
  }

  get triangleCount(): number {
    return this.#triangleCount;
  }

  get vertexCount(): number {
    return this.#positions;
  }

  attachRenderer(_renderer: IRendererLike): void {
    if (this.#released) throw new Error("GPUSceneBVH cannot be attached after release.");
  }

  process(_renderer: IRendererLike): void {
    // The snapshot is static by default. A game changes it only by calling rebuild().
  }

  /** Repack the selected scene objects and replace the GPU buffers behind the stable node handles. */
  rebuild(): void {
    if (this.#released) throw new Error("GPUSceneBVH cannot rebuild after release.");
    const started = now();
    const packed = packScene(this.#scene, this.#include);
    const nextNodes = readNodeStorage(packed.nodes);
    const nextPositions = readStorage(packed.positions, "vec3", 4);
    const nextIndices = readStorage(packed.indices, "uvec3", 3);
    const nextNormals = readStorage(packed.normals, "vec3", 4);
    replaceStorage(this.#backings.nodes as StorageBufferNode<"struct">, nextNodes);
    replaceStorage(this.#backings.positions as StorageBufferNode<"vec3">, nextPositions);
    replaceStorage(this.#backings.indices as StorageBufferNode<"uvec3">, nextIndices);
    replaceStorage(this.#backings.normals as StorageBufferNode<"vec3">, nextNormals);
    this.#packedGeometry?.dispose();
    this.#packedGeometry = packed.geometry;
    this.#materialGroups = packed.materialGroups;
    this.#objectCount = packed.objectCount;
    this.#positions = packed.vertexCount;
    this.#triangleCount = packed.triangleCount;
    this.#buildMs = now() - started;
  }

  /** Dispose every storage attribute owned by this snapshot. Safe to call more than once. */
  detach(): void {
    if (this.#released) return;
    this.removeEventListener("removed", this.#onRemoved);
    disposeStorage(this.#backings.nodes);
    disposeStorage(this.#backings.positions);
    disposeStorage(this.#backings.indices);
    disposeStorage(this.#backings.normals);
    this.#backings.nodes = null;
    this.#backings.positions = null;
    this.#backings.indices = null;
    this.#backings.normals = null;
    this.#packedGeometry?.dispose();
    this.#packedGeometry = undefined;
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}
