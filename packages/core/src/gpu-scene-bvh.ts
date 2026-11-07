import {
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  type Material,
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
import { buildCpuBvh } from "./render/cpu-bvh.js";
import type { IProbeTraceScene } from "./render/probe-trace.js";
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
  readonly materials: readonly Material[];
  readonly nodes: Uint32Array;
  readonly normals: Float32Array;
  readonly objectCount: number;
  readonly positions: Float32Array;
  readonly triangleCount: number;
  readonly triangleMaterials: Uint32Array;
  readonly vertexCount: number;
}

interface IBuildState {
  indices: number[];
  /** One slot per distinct Material, in first-seen order: the trace's material table. */
  materialSlots: Map<Material, number>;
  normals: number[];
  objectCount: number;
  positions: number[];
  triangleCount: number;
  triangleMaterials: number[];
  triangleSlots: number[];
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

function materialSlot(mesh: Mesh, materialIndex: number, state: IBuildState): number {
  const material = Array.isArray(mesh.material) ? mesh.material[materialIndex] : mesh.material;
  if (material === undefined) return 0;
  let slot = state.materialSlots.get(material);
  if (slot === undefined) {
    slot = state.materialSlots.size;
    state.materialSlots.set(material, slot);
  }
  return slot;
}

function appendTriangles(
  mesh: Mesh,
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
    const slot = materialSlot(mesh, range.materialIndex, state);
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      state.triangleMaterials.push(range.materialIndex);
      state.triangleSlots.push(slot);
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
    appendTriangles(mesh, index, ranges, vertexOffset, state);
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
  resolveTriangleIndex: (slot: number) => number,
  sourceIndices: Uint32Array,
  sourceMaterials: readonly number[],
  sourceSlots: readonly number[],
): { indices: Uint32Array; materialGroups: IGPUSceneBVHMaterialGroup[]; slots: Uint32Array } {
  const triangleCount = sourceIndices.length / 3;
  const indices = new Uint32Array(sourceIndices.length);
  const materials = new Uint32Array(triangleCount);
  const slots = new Uint32Array(triangleCount);
  for (let slot = 0; slot < triangleCount; slot += 1) {
    const triangle = resolveTriangleIndex(slot);
    indices[slot * 3] = sourceIndices[triangle * 3] ?? 0;
    indices[slot * 3 + 1] = sourceIndices[triangle * 3 + 1] ?? 0;
    indices[slot * 3 + 2] = sourceIndices[triangle * 3 + 2] ?? 0;
    materials[slot] = sourceMaterials[triangle] ?? 0;
    slots[slot] = sourceSlots[triangle] ?? 0;
  }
  return { indices, materialGroups: materialGroupsFor(materials), slots };
}

/**
 * The BVH nodes and leaf order. Upstream `MeshBVH` builds them where it builds a tree; the owned engine's
 * `MeshBVH` refuses the build options and holds no tree, so a CPU build (`render/cpu-bvh.ts`) stands in.
 */
function buildNodes(
  geometry: BufferGeometry,
  positions: Float32Array,
  indices: Uint32Array,
): { nodes: Uint32Array; resolveTriangleIndex: (slot: number) => number } {
  try {
    const bvh = new MeshBVH(geometry, {
      indirect: true,
      strategy: SAH,
      targetLeafSize: 10,
      verbose: false,
    });
    const root = MeshBVH.serialize(bvh, { cloneBuffers: false }).roots[0];
    if (root === undefined) throw new Error("GPUSceneBVH could not serialize its root node.");
    return {
      nodes: new Uint32Array(root),
      resolveTriangleIndex: (slot) => bvh.resolveTriangleIndex(slot),
    };
  } catch (error) {
    if (!String((error as Error).message).includes("TN_NATIVE_MESH_BVH")) throw error;
    const built = buildCpuBvh(positions, indices);
    return { nodes: built.nodes, resolveTriangleIndex: (slot) => built.order[slot] as number };
  }
}

function packScene(scene: Object3D, include: (object: Mesh) => boolean): IPackedScene {
  scene.updateMatrixWorld(true);
  const state: IBuildState = {
    indices: [],
    materialSlots: new Map(),
    normals: [],
    objectCount: 0,
    positions: [],
    triangleCount: 0,
    triangleMaterials: [],
    triangleSlots: [],
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
  let triangleMaterials: Uint32Array = new Uint32Array(state.triangleSlots);
  if (state.indices.length > 0) {
    // Indirect keeps `geometry.index` in source order, so the material assignment collected above
    // still lines up with it; the leaf order is then applied to both at once below.
    const built = buildNodes(geometry, tightPositions, sourceIndices);
    nodes = built.nodes;
    const permuted = permuteToLeafOrder(
      built.resolveTriangleIndex,
      sourceIndices,
      state.triangleMaterials,
      state.triangleSlots,
    );
    indices = permuted.indices;
    materialGroups = permuted.materialGroups;
    triangleMaterials = permuted.slots;
  }
  return {
    geometry,
    indices,
    materialGroups,
    materials: [...state.materialSlots.keys()],
    nodes,
    normals,
    objectCount: state.objectCount,
    positions,
    triangleCount: state.triangleCount,
    triangleMaterials,
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
    // Each backing is built on first read: the owned engine refuses the upstream node struct and
    // freezes storage nodes, and the probe trace (`traceScene`) needs none of them.
    indices: null,
    nodes: null,
    normals: null,
    positions: null,
  };
  #packedStorage: { indices: Uint32Array; normals: Float32Array; positions: Float32Array } = {
    indices: new Uint32Array([0, 0, 0]),
    normals: new Float32Array([0, 1, 0, 0]),
    positions: new Float32Array([0, 0, 0, 0]),
  };
  readonly warmupNodes: readonly unknown[] = [];
  #buildMs = 0;
  #packedNodes: Uint32Array = emptyNodes();
  #traceScene: IProbeTraceScene | undefined;
  #version = 0;
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
    this.addEventListener("removed", this.#onRemoved);
    this.rebuild();
  }

  /** Packed triangle indices as a storage node, built on first read. */
  get indices(): StorageBufferNode<"uvec3"> {
    if (this.#released) throw new Error("GPUSceneBVH indices were read after release.");
    this.#backings.indices ??= readStorage(this.#packedStorage.indices, "uvec3", 3);
    return this.#backings.indices;
  }

  /** Packed vertex normals as a storage node, built on first read. */
  get normals(): StorageBufferNode<"vec3"> {
    if (this.#released) throw new Error("GPUSceneBVH normals were read after release.");
    this.#backings.normals ??= readStorage(this.#packedStorage.normals, "vec3", 4);
    return this.#backings.normals;
  }

  /** Packed world-space vertex positions as a storage node, built on first read. */
  get positions(): StorageBufferNode<"vec3"> {
    if (this.#released) throw new Error("GPUSceneBVH positions were read after release.");
    this.#backings.positions ??= readStorage(this.#packedStorage.positions, "vec3", 4);
    return this.#backings.positions;
  }

  /** The upstream TSL query's node table, built on first read. */
  get nodes(): StorageBufferNode<"struct"> {
    if (this.#released) throw new Error("GPUSceneBVH nodes were read after release.");
    this.#backings.nodes ??= readNodeStorage(this.#packedNodes);
    return this.#backings.nodes;
  }

  /** The CPU snapshot in leaf order, with one material slot per triangle: what `RadianceCache` traces. */
  get traceScene(): IProbeTraceScene {
    if (this.#traceScene === undefined)
      throw new Error("GPUSceneBVH has no snapshot after release.");
    return this.#traceScene;
  }

  /** Increments on every rebuild, so a consumer of `traceScene` knows to re-upload. */
  get version(): number {
    return this.#version;
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
    this.#packedNodes = packed.nodes;
    if (this.#backings.nodes !== null) {
      replaceStorage(this.#backings.nodes, readNodeStorage(packed.nodes));
    }
    this.#traceScene = {
      indices: packed.indices,
      materials: packed.materials,
      nodes: packed.nodes,
      positions: packed.positions,
      triangleMaterials: packed.triangleMaterials,
    };
    this.#version += 1;
    this.#packedStorage = {
      indices: packed.indices,
      normals: packed.normals,
      positions: packed.positions,
    };
    const { positions, indices, normals } = this.#backings;
    if (positions !== null) replaceStorage(positions, readStorage(packed.positions, "vec3", 4));
    if (indices !== null) replaceStorage(indices, readStorage(packed.indices, "uvec3", 3));
    if (normals !== null) replaceStorage(normals, readStorage(packed.normals, "vec3", 4));
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
    this.#traceScene = undefined;
    this.#released = true;
  }

  #onRemoved = (): void => this.detach();
}
