import { createHash } from "node:crypto";
import path from "node:path";
import {
  Accessor,
  type Document,
  type GLTF,
  type Mesh as GltfMesh,
  type Node as GltfNode,
  type Primitive as GltfPrimitive,
  NodeIO,
  type Skin,
  type Texture,
  VertexLayout,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import {
  dedup,
  getTextureColorSpace,
  listTextureSlots,
  prune,
  quantize,
  simplify,
} from "@gltf-transform/functions";
import { MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import {
  type IAssetAuxiliaryOutput,
  type IAssetPass,
  type IAssetPassOutput,
  classify,
} from "../compile.js";
import { type IMaterialMergeSummary, mergeIdenticalMaterials } from "../foliage.js";
import { EXTTextureAstc, createGltfReader, readGltfDocument } from "../gltf-io.js";
import {
  IMAGE_QUALITY_IDENTITY,
  type ITextureQuality,
  resolveImageQualityFloor,
} from "../image-quality.js";
import { KTX2_ENCODER_VERSION } from "../ktx2-encoder.js";
import { deformingMesh, skinnedMeshes } from "../lod/eligibility.js";
import { TNDiscreteLod } from "../lod/extension.js";
import {
  type IModelLodOptions,
  type IModelLodOverride,
  type IModelLodSummary,
  LOD_ARTIFACT_SCHEMA_VERSION,
  LOD_GENERATOR,
  LOD_GENERATOR_VERSION,
  LOD_TOOLCHAIN,
  generateDiscreteLod,
  validateDiscreteLod,
} from "../lod/generate.js";
import {
  type IModelVirtualOptions,
  type IModelVirtualSummary,
  VIRTUAL_BAKE_VERSION,
  bakeVirtualGeometry,
} from "../virtual/bake.js";
import { TNVirtualGeometry } from "../virtual/extension.js";
import {
  type IModelCompactOptions,
  type IModelCompactSummary,
  compactModel,
  compactRequested,
  composeTrsMatrix,
  countCompactNodes,
  countCompactPrimitives,
  removedNames,
  resolveCompactOptions,
  sceneNodeNames,
} from "./compact.js";
import {
  type IEmbeddedTextureSummary,
  type IModelTexturesOptions,
  type IRecalledTexture,
  assertNoTextureDrift,
  compressEmbeddedTextures,
  resolveTextureMaxSize,
  textureBindings,
  textureKeys,
  textureQualitySemantics,
} from "./model-textures.js";
import { quantizeStaticGeometry } from "./quantize-static.js";
import { reorderStaticPrimitives } from "./reorder-static.js";
import {
  type ISharedImage,
  type ISharedImageStore,
  readSharedGlb,
  sharedImageKey,
  sharedImageUri,
  writeSharedGlb,
} from "./shared-images.js";

export {
  assertNoTextureDrift,
  textureBindings,
  type IEmbeddedTextureSummary,
  type IModelTextureBinding,
  type IModelTextureBindings,
  type IModelTextureOverride,
  type IModelTexturesOptions,
} from "./model-textures.js";

export {
  DEFAULT_PROTECTED_PATTERN,
  buildProtectedSet,
  compactModel,
  compactRequested,
  resolveCompactOptions,
  type IModelCompactInstanceOptions,
  type IModelCompactOptions,
  type IModelCompactSummary,
  type IModelProtectedNode,
  type IResolvedCompactOptions,
  type TModelProtectedRule,
} from "./compact.js";

/**
 * Optimizes compiled models: dedup → prune → simplify → reorder → quantize → textures →
 * meshopt, in that fixed order, each individually switchable in config. Output declares
 * `KHR_mesh_quantization` and `EXT_meshopt_compression`, plus `KHR_texture_basisu` when it
 * carried images; the runtime lazily wires three's own MeshoptDecoder and the shared,
 * support-detected KTX2Loader for exactly those files (see `core/src/assets.ts`).
 *
 * Geometry was only ever half of a model. The textures embedded inside a `.glb` are the
 * expensive half — three 2048x2048 JPEGs are a small file and ~67 MB of VRAM decoded — so
 * they go through the same Basis encoder the standalone texture pass uses, capped to a
 * declared maximum resolution (`packages/assets/src/passes/model-textures.ts`).
 *
 * The pass verifies its own output before shipping it: the result is re-read and its
 * triangle, vertex, joint and clip counts and bounding box are compared against the source,
 * throwing and naming the drift beyond tolerance, and every embedded image is compared for
 * the material slot and UV set it is bound to. A pipeline that silently loses a mesh — or a
 * texture — is worse than no pipeline. Counts are taken over scene-reachable content only, so
 * `prune` dropping DCC leftovers is not drift — losing *referenced* geometry is. Joint indices
 * and weights are never quantized below what the source declared.
 *
 * Draco stays an input, never an output: a Draco `.glb` is decoded here (the codec loads
 * only when one is seen, so no project pays for it) and re-emitted as Meshopt. Animation
 * channels are compressed but never resampled — resampling changes timing, which is gameplay.
 */

export interface IModelPassesOptions {
  readonly dedup?: boolean;
  readonly meshopt?: boolean;
  readonly prune?: boolean;
  readonly quantize?: boolean;
  readonly reorder?: boolean;
}

export interface IModelQuantizeOptions {
  /** Normal precision in bits, default 8. */
  readonly normalBits?: number;
  /** Position precision in bits, default 16. */
  readonly positionBits?: number;
  /** UV precision in bits, default 12. */
  readonly uvBits?: number;
}

/**
 * Mesh simplification for LOD. Off unless declared, because it is the one stage that
 * deliberately destroys the triangle count the pass otherwise guarantees: with it on, the
 * self-verify swaps exact triangle equality for a bounded reduction and a wider bounding-box
 * tolerance, and joints and animation clips are still compared exactly.
 */
export interface IModelSimplifyOptions {
  /** Maximum positional error as a fraction of mesh extent, default 0.001. */
  readonly error?: number;
  /** Target fraction of the source triangle count, 0–1. */
  readonly ratio: number;
}

export interface IModelPassOptions {
  readonly passes?: IModelPassesOptions;
  /**
   * Lossless scene-graph compaction (flatten → instance → join) against one protected-node set.
   * Absent means on with defaults; `false` is the kill switch; an object configures the
   * sub-passes, the protected-name allow-list and the name regex. It never decimates geometry.
   */
  readonly compact?: boolean | IModelCompactOptions;
  /** Native WebGPU rejects interleaved vertex attributes; mobile output uses separate buffers. */
  readonly vertexLayout?: "interleaved" | "separate";
  /** Preserve generated TEXCOORD_1 data that is consumed by a runtime-attached lightmap. */
  readonly preserveLightmapUv?: boolean;
  readonly quantize?: IModelQuantizeOptions;
  /** LOD simplification; absent means no simplification at all. */
  readonly simplify?: IModelSimplifyOptions;
  /**
   * Share embedded images across models: each distinct image is written once, content-addressed
   * under `shared/images/`, and every model that carries it references that one file. The store
   * remembers encoded results within a build and, when it was given the output root, across
   * builds — so a pack whose eight pines embed the same bark map encodes it once, not eight
   * times per build. Absent means every model keeps its images embedded.
   */
  readonly sharedImages?: ISharedImageStore;
  /** Embedded-texture compression: options, or `"none"` to ship every image as authored. */
  readonly textures?: IModelTexturesOptions | "none";
  /**
   * Cluster-DAG bake for virtual geometry: options, or `"none"` to ship every primitive as
   * authored. **Absent means the bake runs with defaults**, on the same terms as `textures` — a
   * game that imports a body too dense for the screen should not have to know this key exists.
   * Only primitives at or above `minSourceTriangles` are touched, so an ordinary prop is
   * byte-identical either way. Minutes on a dense body, so the compile cache keys on it — and on
   * {@link VIRTUAL_BAKE_VERSION}, because a better partition changes the output and a stale entry
   * would hide that.
   */
  readonly virtual?: IModelVirtualOptions | "none";
  /**
   * Automatic discrete LOD (`assets.lod`). Absent means no automatic generation in this phase;
   * `false` / `"none"` is the kill switch, and an object carries the resolved policy. Per-asset
   * overrides key off the canonical source asset path, which is why the pass resolves them here
   * rather than at registry construction.
   */
  readonly lod?: boolean | IModelLodOptions | "none";
}

export type { IModelVirtualOptions, IModelVirtualSummary } from "../virtual/bake.js";

/**
 * What simplification actually delivered. The error tolerance can stop the simplifier well
 * short of the requested ratio — measured on a 99,482-triangle prop, `ratio: 0.05` with the
 * default error lands at 15.2% — so both numbers are reported rather than only the one the
 * config asked for.
 */
export interface IModelSimplifySummary {
  readonly achievedRatio: number;
  readonly error: number;
  readonly requestedRatio: number;
  readonly trianglesAfter: number;
  readonly trianglesBefore: number;
}

export interface IModelPassOutputEntry {
  readonly compact?: IModelCompactSummary;
  readonly embeddedTextures?: IEmbeddedTextureSummary;
  readonly extensions: readonly string[];
  readonly lod?: IModelLodSummary;
  /** Distinct material count before and after the cook's merge (PRD-458 §5, AC-5). */
  readonly materials?: IMaterialMergeSummary;
  readonly simplify?: IModelSimplifySummary;
  readonly triangles: number;
  readonly vertices: number;
  readonly virtual?: IModelVirtualSummary;
}

const DRACO_EXTENSION = "KHR_draco_mesh_compression";
const EXT_MESHOPT_EXTENSION = "EXT_meshopt_compression";
/** Bumped with the merge signature so a stale compile-cache entry cannot hide a changed merge. */
const MATERIAL_MERGE_VERSION = 1;
/**
 * Bumped with the content-key signature behind `TN_ASSET_MODEL_DEDUPE`, for the same reason and
 * the same reason it is not `PIPELINE_VERSION`: that constant is hand-maintained, so a change
 * here would otherwise be invisible to the cache. This one rides the model pass's configuration,
 * which the compile digest already hashes, so it invalidates model outputs and nothing else.
 */
const MODEL_DEDUPE_VERSION = 1;
/**
 * Bumped when `reorder-static.ts` changes what it emits: every model cooked before this fix had its
 * deforming geometry renumbered, and a warm cache entry keyed on the pass switches alone would keep
 * serving those files. 1 = deforming primitives keep their authored vertex order and count.
 */
const MODEL_REORDER_VERSION = 1;
/**
 * Bumped when `quantize-static.ts` changes what it emits: every model cooked before this fix had its
 * deforming positions snapped onto a quantization grid, and a warm cache entry keyed on the pass
 * switches alone would keep serving those files. 1 = deforming POSITION and morph-target deltas
 * stay float32 in the source metre space.
 */
const MODEL_QUANTIZE_VERSION = 1;

/** Relative bounding-box tolerance of the self-verify check (PRD: 0.1%). */
const BBOX_TOLERANCE = 0.001;
/** Simplification moves vertices on purpose; its silhouette tolerance is ten times wider. */
const SIMPLIFY_BBOX_TOLERANCE = 0.01;
/** How far below the requested ratio a simplified result may land before it is a failure. */
const SIMPLIFY_RATIO_FLOOR = 0.5;
const DEFAULT_SIMPLIFY_ERROR = 0.001;

const DEFAULT_POSITION_BITS = 16;
const DEFAULT_NORMAL_BITS = 8;
const DEFAULT_UV_BITS = 12;

type RootOf = ReturnType<Document["getRoot"]>;

interface IModelStats {
  readonly boundingBox: { readonly max: number[]; readonly min: number[] } | undefined;
  readonly clips: number;
  readonly joints: number;
  readonly triangles: number;
  readonly vertices: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonOfGlb(binary: Buffer): GLTF.IGLTF {
  return JSON.parse(
    binary.subarray(20, 20 + binary.readUInt32LE(12)).toString("utf8"),
  ) as GLTF.IGLTF;
}

async function readDocument(input: Buffer, logicalPath: string): Promise<Document> {
  // The shared reader: Meshopt decoder awaited and registered, Draco loaded only when the
  // header names it, and TN_virtual_geometry registered on the reader too because the pass
  // re-reads its own output to verify it — an unregistered extension is dropped on read rather
  // than reported.
  try {
    return await readGltfDocument(await createGltfReader(input), input);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TN_ASSETS_MODEL_UNREADABLE: could not parse '${logicalPath}' for the model pass: ${detail}. External buffer or image URIs are not supported; use a self-contained .glb.`,
    );
  }
}

async function writeDocument(
  document: Document,
  logicalPath: string,
  vertexLayout: "interleaved" | "separate" = "interleaved",
): Promise<{ buffer: Buffer; extensions: readonly string[] }> {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .setVertexLayout(vertexLayout === "separate" ? VertexLayout.SEPARATE : VertexLayout.INTERLEAVED)
    .registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc, TNVirtualGeometry, TNDiscreteLod])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  try {
    const buffer = Buffer.from(await io.writeBinary(document));
    return { buffer, extensions: jsonOfGlb(buffer).extensionsUsed ?? [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TN_ASSETS_MODEL_WRITE_FAILED: could not write '${logicalPath}': ${detail}`);
  }
}

function primitiveTriangles(primitive: GltfPrimitive): number {
  const drawn =
    primitive.getIndices()?.getCount() ?? primitive.getAttribute("POSITION")?.getCount() ?? 0;
  return Math.floor(drawn / 3);
}

/** Structural view of gltf-transform's `EXT_mesh_gpu_instancing` batch property. */
interface IInstanceBatch {
  getAttribute(semantic: string): Accessor | null;
  listSemantics(): string[];
}

/** Reads instance `count` from the first batch attribute; 0 when the batch carries none. */
function instanceCount(batch: IInstanceBatch): number {
  for (const semantic of batch.listSemantics()) {
    const attribute = batch.getAttribute(semantic);
    if (attribute !== null) return attribute.getCount();
  }
  return 0;
}

/** Column-major glTF TRS matrix for one instance: `T * R * S`. */
function instanceMatrix(batch: IInstanceBatch, index: number): number[] {
  return composeTrsMatrix(
    readElement(batch.getAttribute("TRANSLATION"), index, [0, 0, 0]),
    readElement(batch.getAttribute("ROTATION"), index, [0, 0, 0, 1]),
    readElement(batch.getAttribute("SCALE"), index, [1, 1, 1]),
  );
}

/** Reads one element of an optional instance attribute, or the supplied fallback. */
function readElement(
  accessor: Accessor | null,
  index: number,
  fallback: readonly number[],
): number[] {
  if (accessor === null) return [...fallback];
  const array = accessor.getArray();
  const size = accessor.getElementSize();
  const base = index * size;
  return fallback.map((_, axis) => array[base + axis] ?? 0);
}

/**
 * Decodes one POSITION element into the value a vertex shader sees: raw floats on
 * unquantized data, or the normalized [-1, 1] fraction on quantized ones. The metric scale
 * is NOT restored here — quantization folds it into node transforms (static meshes) or the
 * joint × inverse-bind chain (skinned meshes), both applied by the caller.
 */
function decodeElement(accessor: Accessor, index: number): [number, number, number] {
  const array = accessor.getArray();
  const base = index * accessor.getElementSize();
  const x = array[base] ?? 0;
  const y = array[base + 1] ?? 0;
  const z = array[base + 2] ?? 0;
  if (!accessor.getNormalized()) return [x, y, z];
  switch (accessor.getComponentType()) {
    case Accessor.ComponentType.BYTE:
      return [Math.max(x / 127, -1), Math.max(y / 127, -1), Math.max(z / 127, -1)];
    case Accessor.ComponentType.UNSIGNED_BYTE:
      return [x / 255, y / 255, z / 255];
    case Accessor.ComponentType.SHORT:
      return [Math.max(x / 32767, -1), Math.max(y / 32767, -1), Math.max(z / 32767, -1)];
    case Accessor.ComponentType.UNSIGNED_SHORT:
      return [x / 65535, y / 65535, z / 65535];
    default:
      return [x, y, z];
  }
}

/**
 * Evaluates a vertex exactly as the GPU does at bind pose and returns its world position.
 * Unskinned vertices go through the node transform; skinned ones through the weighted
 * joint × inverse-bind matrices — which is precisely where quantization's volume
 * compensation cancels out for skinned meshes.
 */
/** glTF normalized-accessor decode scale per component type, as the GPU applies it. */
function normalizedWeightScale(accessor: Accessor): number {
  switch (accessor.getComponentType()) {
    case Accessor.ComponentType.BYTE:
      return 1 / 127;
    case Accessor.ComponentType.UNSIGNED_BYTE:
      return 1 / 255;
    case Accessor.ComponentType.SHORT:
      return 1 / 32767;
    case Accessor.ComponentType.UNSIGNED_SHORT:
      return 1 / 65535;
    default:
      return 1;
  }
}

function evaluateVertex(
  position: Accessor,
  index: number,
  joints: Accessor | null,
  weights: Accessor | null,
  jointMatrices: readonly number[][] | undefined,
  fallbackMatrix: readonly number[],
): [number, number, number] {
  const [x, y, z] = decodeElement(position, index);
  if (jointMatrices === undefined || joints === null || weights === null) {
    return transformPoint(fallbackMatrix, x, y, z);
  }
  const jointArray = joints.getArray();
  const weightArray = weights.getArray();
  const weightScale = weights.getNormalized() ? normalizedWeightScale(weights) : 1;
  let wx = 0;
  let wy = 0;
  let wz = 0;
  for (let slot = 0; slot < 4; slot += 1) {
    const base = index * 4 + slot;
    const weight = (weightArray[base] ?? 0) * weightScale;
    if (weight === 0) continue;
    const matrix = jointMatrices[jointArray[base] ?? 0];
    if (matrix === undefined) continue;
    const point = transformPoint(matrix, x, y, z);
    wx += point[0] * weight;
    wy += point[1] * weight;
    wz += point[2] * weight;
  }
  // A vertex whose weights do not sum to one keeps its rigid position as a fallback.
  if (wx === 0 && wy === 0 && wz === 0) return transformPoint(fallbackMatrix, x, y, z);
  return [wx, wy, wz];
}

/** Column-major 4x4 transform of a point (glTF convention). */
function transformPoint(
  m: readonly number[],
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  const c = (index: number): number => m[index] ?? 0;
  return [
    c(0) * x + c(4) * y + c(8) * z + c(12),
    c(1) * x + c(5) * y + c(9) * z + c(13),
    c(2) * x + c(6) * y + c(10) * z + c(14),
  ];
}

/** Column-major 4x4 matrix product `a * b`. */
function multiplyMatrices(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      const c = (index: number): number => a[index] ?? 0;
      const d = (index: number): number => b[index] ?? 0;
      out[column * 4 + row] =
        c(row) * d(column * 4) +
        c(4 + row) * d(column * 4 + 1) +
        c(8 + row) * d(column * 4 + 2) +
        c(12 + row) * d(column * 4 + 3);
    }
  }
  return out;
}

const IDENTITY_MATRIX = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * The vertices a primitive draws: all of them when it has no index buffer, otherwise the distinct
 * ones its indices name. A card LOD chain appends scaled copies of its cards that only the levels'
 * indices reach (PRD-541); LOD0 never draws them, so they are not drift.
 */
function drawnVertices(primitive: GltfPrimitive, count: number): Uint32Array {
  const indices = primitive.getIndices()?.getArray();
  if (indices === null || indices === undefined)
    return Uint32Array.from({ length: count }, (_, at) => at);
  const seen = new Uint8Array(count);
  let distinct = 0;
  for (const index of indices)
    if (index < count && seen[index] === 0) {
      seen[index] = 1;
      distinct += 1;
    }
  const out = new Uint32Array(distinct);
  let at = 0;
  for (let index = 0; index < count; index += 1) if (seen[index] === 1) out[at++] = index;
  return out;
}

/**
 * Stats over scene-reachable content only; DCC leftovers dropped by prune are not drift.
 * The bounding box is taken over bind-pose vertex positions evaluated the way the GPU
 * evaluates them — node transforms for static meshes, weighted joint matrices for skinned
 * ones — because quantization replaces accessor arrays with normalized integers whose
 * metric scale lives in exactly those transforms.
 */
export function reachableStats(root: RootOf): IModelStats {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  let triangles = 0;
  let vertices = 0;
  const skins = new Set<Skin>();
  const visited = new Set<GltfNode>();

  const walk = (node: GltfNode): void => {
    if (visited.has(node)) return;
    visited.add(node);
    const skin = node.getSkin();
    if (skin !== null) skins.add(skin);
    const mesh = node.getMesh();
    if (mesh !== null) {
      const batch = node.getExtension("EXT_mesh_gpu_instancing") as IInstanceBatch | null;
      // A node carrying EXT_mesh_gpu_instancing draws its mesh once per instance, each with the
      // instance's own T * R * S; the source node count and world transforms reappear here so the
      // self-verify compares like with like after an `instance` pass.
      const instanceMatrices =
        batch === null
          ? [node.getWorldMatrix()]
          : Array.from({ length: instanceCount(batch) }, (_, index) =>
              multiplyMatrices(node.getWorldMatrix(), instanceMatrix(batch, index)),
            );
      const skin = node.getSkin();
      // Bind-pose joint matrices: joint world transform composed with the inverse bind.
      let jointMatrices: number[][] | undefined;
      if (skin !== null) {
        const inverseBinds = skin.getInverseBindMatrices();
        jointMatrices = skin.listJoints().map((joint, index) => {
          const jointWorld = joint.getWorldMatrix();
          const ibm =
            inverseBinds?.getElement(index, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]) ??
            IDENTITY_MATRIX;
          return multiplyMatrices(jointWorld, ibm);
        });
      }
      for (const matrix of instanceMatrices) {
        for (const primitive of mesh.listPrimitives()) {
          triangles += primitiveTriangles(primitive);
          const position = primitive.getAttribute("POSITION");
          if (position === null) continue;
          const drawn = drawnVertices(primitive, position.getCount());
          vertices += drawn.length;
          for (const index of drawn) {
            const [wx, wy, wz] = evaluateVertex(
              position,
              index,
              primitive.getAttribute("JOINTS_0"),
              primitive.getAttribute("WEIGHTS_0"),
              skin !== null ? jointMatrices : undefined,
              matrix,
            );
            minX = Math.min(minX, wx);
            minY = Math.min(minY, wy);
            minZ = Math.min(minZ, wz);
            maxX = Math.max(maxX, wx);
            maxY = Math.max(maxY, wy);
            maxZ = Math.max(maxZ, wz);
          }
        }
      }
    }
    node.listChildren().forEach(walk);
  };
  root
    .listScenes()
    .flatMap((scene) => scene.listChildren())
    .forEach(walk);

  let joints = 0;
  const seenJoints = new Set<GltfNode>();
  for (const skin of skins) {
    for (const joint of skin.listJoints()) {
      if (seenJoints.has(joint)) continue;
      seenJoints.add(joint);
      joints += 1;
    }
  }
  const finite = Number.isFinite(minX) && Number.isFinite(maxZ);
  return {
    boundingBox: finite ? { max: [maxX, maxY, maxZ], min: [minX, minY, minZ] } : undefined,
    // A clip survives when something reachable is still animated by it.
    clips: root.listAnimations().filter((animation) =>
      animation.listChannels().some((channel) => {
        const targetNode = channel.getTargetNode();
        return targetNode !== null && visited.has(targetNode);
      }),
    ).length,
    joints,
    triangles,
    vertices,
  };
}

/** Smallest per-semantic joint-index/weight component storage, tracked separately so a
 * narrow WEIGHTS accessor cannot hide behind an already-narrow JOINTS one. */
function jointComponentSizes(root: RootOf): {
  joints: number;
  weights: number;
} {
  let joints = 0;
  let weights = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const jointsAccessor = primitive.getAttribute("JOINTS_0");
      if (jointsAccessor !== null) {
        const size = jointsAccessor.getComponentSize();
        joints = joints === 0 ? size : Math.min(joints, size);
      }
      const weightsAccessor = primitive.getAttribute("WEIGHTS_0");
      if (weightsAccessor !== null) {
        const size = weightsAccessor.getComponentSize();
        weights = weights === 0 ? size : Math.min(weights, size);
      }
    }
  }
  return { joints, weights };
}

function bboxDrift(left: IModelStats, right: IModelStats): number | undefined {
  const leftBox = left.boundingBox;
  const rightBox = right.boundingBox;
  if (leftBox === undefined || rightBox === undefined) {
    return leftBox === rightBox ? 0 : undefined;
  }
  const component = (
    box: IModelStats["boundingBox"],
    corner: "max" | "min",
    axis: number,
  ): number => box?.[corner][axis] ?? 0;
  const scale = Math.max(
    ...[0, 1, 2].map((axis) => component(leftBox, "max", axis) - component(leftBox, "min", axis)),
    1e-6,
  );
  return Math.max(
    ...[0, 1, 2].map(
      (axis) =>
        Math.max(
          Math.abs(component(leftBox, "min", axis) - component(rightBox, "min", axis)),
          Math.abs(component(leftBox, "max", axis) - component(rightBox, "max", axis)),
        ) / scale,
    ),
  );
}

/** Compares the re-read output against the source and throws naming the drift. */
export function assertNoDrift(source: IModelStats, output: IModelStats, logicalPath: string): void {
  const failures: string[] = [];
  if (source.triangles !== output.triangles) {
    failures.push(`triangles ${source.triangles} -> ${output.triangles}`);
  }
  if (source.vertices !== output.vertices) {
    failures.push(`vertices ${source.vertices} -> ${output.vertices}`);
  }
  if (source.joints !== output.joints) {
    failures.push(`joints ${source.joints} -> ${output.joints}`);
  }
  if (source.clips !== output.clips) {
    failures.push(`animation clips ${source.clips} -> ${output.clips}`);
  }
  const bbox = bboxDrift(source, output);
  if (bbox === undefined) {
    failures.push("bounding box lost");
  } else if (bbox > BBOX_TOLERANCE) {
    failures.push(
      `bounding box drifted ${(bbox * 100).toFixed(3)}% (tolerance ${(BBOX_TOLERANCE * 100).toFixed(1)}%)`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `TN_ASSETS_MODEL_DRIFT: self-verification failed for '${logicalPath}': ${failures.join("; ")}.`,
    );
  }
}

/**
 * The self-verify for a deliberately lossy stage. Simplification exists to remove triangles,
 * so exact equality would reject every successful run; what must still hold is that the
 * reduction stayed near what was asked for, that the silhouette barely moved, and that the
 * skeleton and the animation clips came through untouched.
 */
export function assertSimplifiedWithinBounds(
  source: IModelStats,
  output: IModelStats,
  ratio: number,
  logicalPath: string,
): void {
  const failures: string[] = [];
  if (source.joints !== output.joints) {
    failures.push(`joints ${source.joints} -> ${output.joints}`);
  }
  if (source.clips !== output.clips) {
    failures.push(`animation clips ${source.clips} -> ${output.clips}`);
  }
  if (output.triangles > source.triangles) {
    failures.push(`triangles grew ${source.triangles} -> ${output.triangles}`);
  }
  const floor = Math.floor(source.triangles * ratio * SIMPLIFY_RATIO_FLOOR);
  if (output.triangles < floor) {
    failures.push(
      `triangles ${source.triangles} -> ${output.triangles}, below the ${String(floor)} floor for ratio ${String(ratio)}`,
    );
  }
  const bbox = bboxDrift(source, output);
  if (bbox === undefined) {
    failures.push("bounding box lost");
  } else if (bbox > SIMPLIFY_BBOX_TOLERANCE) {
    failures.push(
      `bounding box drifted ${(bbox * 100).toFixed(3)}% (simplify tolerance ${(SIMPLIFY_BBOX_TOLERANCE * 100).toFixed(1)}%)`,
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `TN_ASSETS_MODEL_SIMPLIFY_DRIFT: self-verification failed for '${logicalPath}': ${failures.join("; ")}.`,
    );
  }
}

/**
 * Snaps every scene-reachable POSITION accessor onto a uniform `2^bits` grid spanning its
 * own bounds — the destructive low-precision quantization the underlying library refuses
 * to express. Used only for configured depths below its 8-bit floor; the self-verify is
 * expected to reject the result. Deforming meshes are skipped for the same reason the
 * quantization stage skips them: a grid that coarse moves vertices a sidecar already
 * addresses, and holding them is the rule rather than the bit depth.
 */
function snapPositions(root: RootOf, bits: number, skinned: ReadonlySet<GltfMesh>): void {
  const levels = 2 ** bits - 1;
  for (const mesh of root.listMeshes()) {
    if (deformingMesh(mesh, skinned)) continue;
    for (const primitive of mesh.listPrimitives()) {
      const position = primitive.getAttribute("POSITION");
      if (position === null || position.getNormalized()) continue;
      const array = position.getArray();
      const min = position.getMin([0, 0, 0]);
      const max = position.getMax([0, 0, 0]);
      const stride = position.getElementSize();
      const output = new Float32Array(array.length);
      for (let index = 0; index < position.getCount(); index += 1) {
        for (let axis = 0; axis < stride; axis += 1) {
          const source = array[index * stride + axis] ?? 0;
          const low = min[axis] ?? 0;
          const high = max[axis] ?? 0;
          const span = high - low;
          const fraction = span === 0 ? 0 : (source - low) / span;
          output[index * stride + axis] = low + (Math.round(fraction * levels) / levels) * span;
        }
      }
      position.setArray(output);
    }
  }
}

/**
 * The generation-only cache identity of `assets.lod`. Runtime selection settings (`preset`,
 * `runtime`) are stripped: changing only the pixel budget must refresh runtime metadata, not
 * rebake geometry (PRD-377 §3.2, §5).
 */
function lodCacheKey(lod: boolean | IModelLodOptions | "none" | undefined): unknown {
  if (lod === undefined) return null;
  if (lod === false || lod === "none") return "none";
  if (lod === true) {
    return {
      enabled: true,
      generator: `${LOD_GENERATOR}/${String(LOD_GENERATOR_VERSION)}`,
      schema: LOD_ARTIFACT_SCHEMA_VERSION,
      toolchain: LOD_TOOLCHAIN,
    };
  }
  const override = (entry: boolean | IModelLodOverride): unknown =>
    typeof entry === "boolean"
      ? entry
      : {
          ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
          ...(entry.generation === undefined ? {} : { generation: entry.generation }),
        };
  return {
    ...(lod.enabled === undefined ? {} : { enabled: lod.enabled }),
    ...(lod.generation === undefined ? {} : { generation: lod.generation }),
    ...(lod.overrides === undefined
      ? {}
      : {
          overrides: Object.fromEntries(
            Object.entries(lod.overrides).map(([key, entry]) => [key, override(entry)]),
          ),
        }),
    generator: `${LOD_GENERATOR}/${String(LOD_GENERATOR_VERSION)}`,
    schema: LOD_ARTIFACT_SCHEMA_VERSION,
    toolchain: LOD_TOOLCHAIN,
  };
}

export function modelPass(options: IModelPassOptions = {}): IAssetPass {
  return {
    appliesTo: ["model"],
    configuration: {
      passes: {
        dedup: options.passes?.dedup ?? true,
        meshopt: options.passes?.meshopt ?? true,
        prune: options.passes?.prune ?? true,
        quantize: options.passes?.quantize ?? true,
        reorder: options.passes?.reorder ?? true,
      },
      ...(options.vertexLayout === undefined ? {} : { vertexLayout: options.vertexLayout }),
      quantize: {
        normalBits: options.quantize?.normalBits ?? DEFAULT_NORMAL_BITS,
        positionBits: options.quantize?.positionBits ?? DEFAULT_POSITION_BITS,
        uvBits: options.quantize?.uvBits ?? DEFAULT_UV_BITS,
      },
      // Part of the compile cache key: change the cap or a codec and stale outputs must not
      // be re-served.
      simplify: options.simplify ?? null,
      // The resolved compaction policy: a sub-pass switch, allow-list or regex edit changes the
      // output, so it must change the cache key.
      compact: resolveCompactOptions(options.compact),
      // Generation-only identity; runtime budget edits must not invalidate baked geometry.
      lod: lodCacheKey(options.lod),
      // The material merge is unconditional and lossless, so the version string is the whole knob:
      // it moves when the signature does, which invalidates every stale output at once.
      materials: MATERIAL_MERGE_VERSION,
      // Unconditional and lossless for the same reason: the cook shares one output between
      // content-identical sources, so a bake published before this key existed named one output
      // per copy and must not be re-served as if it had deduped.
      dedupe: MODEL_DEDUPE_VERSION,
      // Same reason: which primitives `reorder` declines to renumber is part of the output, and a
      // warm entry from before it declined would hand a game geometry its sidecars cannot address.
      reorderVersion: MODEL_REORDER_VERSION,
      // Same reason again: which positions keep their source metres is part of the output, and a
      // warm entry from before they did would hand a game geometry its sidecars cannot address.
      quantizeVersion: MODEL_QUANTIZE_VERSION,
      // `"none"` and "absent" are different cache keys on purpose: absent bakes with defaults.
      virtual:
        options.virtual === "none"
          ? "none"
          : {
              ...(options.virtual === undefined ? {} : options.virtual),
              bakeVersion: VIRTUAL_BAKE_VERSION,
            },
      sharedImages: options.sharedImages !== undefined,
      textures:
        options.textures === "none"
          ? "none"
          : {
              ...(options.textures?.astc === true ? { astc: "raw4x4-gltf-authored-basis-v2" } : {}),
              decoderFree: options.textures?.decoderFree ?? false,
              encoder: KTX2_ENCODER_VERSION,
              instrument: IMAGE_QUALITY_IDENTITY,
              floor: resolveImageQualityFloor(options.textures?.floor),
              maxSize: options.textures?.maxSize ?? null,
              // Retention is now conditioned on the container, so it is spelled out rather than
              // named by a boolean: a warm cache keyed on the old rule would keep shipping the
              // WebP-requiring models this replaced.
              keepSmallerSource: "universal-containers",
              overrides: options.textures?.overrides ?? [],
              quality: options.textures?.quality ?? null,
            },
    },
    name: "model",
    // A mobile compile replaces these two decoder-backed sub-passes in the effective options;
    // geometry rewrites and shared-image emission remain plain glTF and stay enabled there.
    needsRuntimeDecoder:
      (options.passes?.meshopt ?? true) ||
      (options.textures !== "none" &&
        options.textures?.decoderFree !== true &&
        options.textures?.astc !== true),
    apply: async (input: Buffer, logicalPath: string): Promise<Buffer | IAssetPassOutput> => {
      if (classify(logicalPath) !== "model") return input;
      const passes = options.passes ?? {};
      const enabled = {
        dedup: passes.dedup ?? true,
        meshopt: passes.meshopt ?? true,
        prune: passes.prune ?? true,
        quantize: passes.quantize ?? true,
        reorder: passes.reorder ?? true,
      };
      // Embedded-texture compression and simplification are switched separately from the
      // geometry sub-passes: a model whose geometry is already final still ships images.
      const textureOptions = options.textures === "none" ? undefined : (options.textures ?? {});
      // Absent means on, exactly as `textures` reads it.
      const virtualOptions = options.virtual === "none" ? undefined : (options.virtual ?? {});
      const lodOptions =
        options.lod === undefined || options.lod === false || options.lod === "none"
          ? undefined
          : options.lod;
      const transformsActive =
        Object.values(enabled).some(Boolean) ||
        options.simplify !== undefined ||
        lodOptions !== undefined ||
        virtualOptions !== undefined ||
        compactRequested(options.compact);
      const geometryActive = options.vertexLayout !== undefined || transformsActive;
      if (!geometryActive && textureOptions === undefined) return input;

      const document = await readDocument(input, logicalPath);
      // Nothing left to do once the document turns out to carry no images: re-emitting it
      // would rewrite the container for no gain, and the byte-identical output is what a
      // fully switched-off pass promises.
      if (!geometryActive && document.getRoot().listTextures().length === 0) return input;
      // Draco is an input format only: the extension was consumed by the reader's decode,
      // so it never reaches the writer — the output re-emits as Meshopt further below. A source
      // may already carry Meshopt from an earlier cook; dispose that consumed extension when the
      // mobile effective options deliberately disable the runtime decoder.
      for (const extension of document.getRoot().listExtensionsUsed()) {
        if (
          extension.extensionName === DRACO_EXTENSION ||
          (!enabled.meshopt && extension.extensionName === EXT_MESHOPT_EXTENSION)
        )
          extension.dispose();
      }
      const source = reachableStats(document.getRoot());
      if (!transformsActive && textureOptions === undefined) {
        const { buffer, extensions, verified } = await writeAndVerify(
          document,
          logicalPath,
          options.vertexLayout,
        );
        assertNoDrift(source, reachableStats(verified), logicalPath);
        return { buffer, entry: { extensions } };
      }
      const jointFloor = jointComponentSizes(document.getRoot());

      // Fixed order: dedup → prune → simplify → reorder → quantize → textures → meshopt.
      // None is reorderable: simplification needs float positions, so it must precede
      // quantize, and texture compression must follow every stage that can drop a material.
      if (enabled.dedup) await dedup()(document);
      // Lossless compaction runs before `prune`: `join`/`flatten` leave empty nodes behind for
      // that pass — which the game configures — to remove, and `dedup` has already linked the
      // duplicate meshes `instance` batches.
      const namesBeforeCompact = compactRequested(options.compact)
        ? sceneNodeNames(document)
        : undefined;
      let compact = compactRequested(options.compact)
        ? await compactModel(document, resolveCompactOptions(options.compact))
        : undefined;
      if (enabled.prune) {
        await prune({ keepAttributes: options.preserveLightmapUv === true })(document);
        // The empty nodes `flatten`/`join` left behind are removed by this prune, so the shipped
        // node count and the list of names it dropped are both measured after it. `flatten`'s own
        // before/after stays what flatten itself did, not what prune later finished.
        if (compact !== undefined && namesBeforeCompact !== undefined) {
          const nodes = countCompactNodes(document);
          compact = {
            ...compact,
            nodesAfter: nodes,
            primitivesAfter: countCompactPrimitives(document),
            removed: removedNames(namesBeforeCompact, sceneNodeNames(document)),
          };
        }
      }
      // Lossless and unconditional: materials that agree on every field that can change a pixel are
      // one material, and the cook is the only place that knows the full field list (PRD-458 §5).
      // After `prune` (which drops unreferenced materials) and before the cutout conversion, so the
      // count the report gives is the one a runtime would have drawn with.
      const materials = mergeIdenticalMaterials(document);
      if (options.simplify !== undefined) {
        await MeshoptSimplifier.ready;
        await simplify({
          error: options.simplify.error ?? DEFAULT_SIMPLIFY_ERROR,
          ratio: options.simplify.ratio,
          simplifier: MeshoptSimplifier,
        })(document);
      }
      if (enabled.reorder || enabled.meshopt) await MeshoptEncoder.ready;
      // The last stage that moves a vertex, and the only one that does so selectively: deforming
      // geometry keeps its authored vertex order because a vertex index into it is an address
      // something outside this file may already hold. `reorder-static.ts`.
      if (enabled.reorder) reorderStaticPrimitives(document, MeshoptEncoder);
      // After `reorder`, which is the last stage that moves a vertex, and before `quantize`, which
      // changes what a position is but never which vertex it is.
      const virtual =
        virtualOptions === undefined
          ? undefined
          : await bakeVirtualGeometry(document, virtualOptions);
      // After the virtual bake, so a primitive already owned by a cluster DAG is never also given
      // a discrete chain (PRD-377 §4.2), and before `quantize`, which needs float positions.
      const lod =
        lodOptions === undefined
          ? undefined
          : await generateDiscreteLod(
              document,
              lodOptions,
              logicalPath,
              createHash("sha256").update(input).digest("hex"),
              { simplify: options.simplify !== undefined, virtualNone: options.virtual === "none" },
            );
      if (enabled.quantize) {
        // Depths below the library's 8-bit floor are honoured by pre-rounding the floats
        // onto the coarser grid first; the self-verify then fails the build on the drift.
        const requestedBits = options.quantize?.positionBits ?? DEFAULT_POSITION_BITS;
        if (requestedBits < 8)
          snapPositions(document.getRoot(), requestedBits, skinnedMeshes(document));
        // Joint indices and weights are excluded outright: quantizing them below the
        // exporter's declaration is where skinned meshes visibly break, and the library's
        // own default narrows weights to 8 bits unless told otherwise.
        // Deforming geometry keeps float32 POSITION in the source metre space on top of
        // that, so nothing a sidecar addresses moves: `quantize-static.ts`.
        await quantizeStaticGeometry(document, () =>
          quantize({
            quantizeColor: 8,
            quantizeNormal: options.quantize?.normalBits ?? DEFAULT_NORMAL_BITS,
            quantizePosition: Math.max(requestedBits, 8),
            quantizeTexcoord: options.quantize?.uvBits ?? DEFAULT_UV_BITS,
            pattern: /^(?!JOINTS|WEIGHTS)/u,
            normalizeWeights: false,
          })(document),
        );
      }
      // Taken after every geometry stage and before compression, so what it proves is that
      // *this* stage plus the writer preserved each binding — prune's documented drops of
      // unreferenced material are already settled by then.
      const sourceTextures = textureBindings(document.getRoot());
      const store = options.sharedImages;
      const shared =
        store === undefined ? undefined : await recallSharedImages(document, store, textureOptions);
      const embeddedTextures =
        textureOptions === undefined
          ? undefined
          : await compressEmbeddedTextures(document, logicalPath, textureOptions, shared?.recalled);
      if (store !== undefined && shared !== undefined)
        await rememberSharedImages(
          document,
          store,
          shared,
          embeddedTextures?.formats,
          embeddedTextures?.quality,
        );
      if (enabled.meshopt) {
        document
          .createExtension(EXTMeshoptCompression)
          .setRequired(true)
          // Compression runs at write time; QUANTIZE pre-processing is ours above.
          .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
      }

      const narrowed = jointComponentSizes(document.getRoot());
      const narrowedSemantics: string[] = [];
      if (jointFloor.joints > narrowed.joints) {
        narrowedSemantics.push(
          `JOINTS (${String(jointFloor.joints)} -> ${String(narrowed.joints)} bytes)`,
        );
      }
      if (jointFloor.weights > narrowed.weights) {
        narrowedSemantics.push(
          `WEIGHTS (${String(jointFloor.weights)} -> ${String(narrowed.weights)} bytes)`,
        );
      }
      if (narrowedSemantics.length > 0) {
        throw new Error(
          `TN_ASSETS_MODEL_JOINT_QUANTIZED: '${logicalPath}' narrowed joint data storage for ${narrowedSemantics.join(", ")} per component; joint data is never quantized below the source declaration.`,
        );
      }

      const { auxiliaryOutputs, buffer, extensions, verified } =
        store === undefined || shared === undefined || shared.keys.length === 0
          ? await writeAndVerify(document, logicalPath, options.vertexLayout)
          : await writeAndVerifyShared(document, logicalPath, store, shared, options.vertexLayout);
      const output = reachableStats(verified);
      if (options.simplify === undefined) {
        assertNoDrift(source, output, logicalPath);
      } else {
        assertSimplifiedWithinBounds(source, output, options.simplify.ratio, logicalPath);
      }
      assertNoTextureDrift(sourceTextures, textureBindings(verified), logicalPath);
      // Fails closed on a malformed chain in the bytes that will ship, not in the in-memory graph
      // that produced them.
      if (lod !== undefined && lod.generated > 0) validateDiscreteLod(verified);
      const entry: IModelPassOutputEntry = {
        ...(compact === undefined ? {} : { compact }),
        ...(embeddedTextures === undefined ? {} : { embeddedTextures }),
        extensions: [...extensions].sort(),
        ...(lod === undefined ? {} : { lod }),
        materials,
        ...(options.simplify === undefined
          ? {}
          : {
              simplify: {
                achievedRatio: source.triangles === 0 ? 1 : output.triangles / source.triangles,
                error: options.simplify.error ?? DEFAULT_SIMPLIFY_ERROR,
                requestedRatio: options.simplify.ratio,
                trianglesAfter: output.triangles,
                trianglesBefore: source.triangles,
              },
            }),
        triangles: output.triangles,
        vertices: output.vertices,
        ...(virtual === undefined ? {} : { virtual }),
      };
      return {
        ...(auxiliaryOutputs.length === 0 ? {} : { auxiliaryOutputs }),
        buffer,
        entry: { ...entry },
      };
    },
  };
}

async function writeAndVerify(
  document: Document,
  logicalPath: string,
  vertexLayout: "interleaved" | "separate" | undefined,
): Promise<{
  auxiliaryOutputs: IAssetAuxiliaryOutput[];
  buffer: Buffer;
  extensions: readonly string[];
  verified: RootOf;
}> {
  const { buffer, extensions } = await writeDocument(document, logicalPath, vertexLayout);
  const verified = (await readDocument(buffer, logicalPath)).getRoot();
  return { auxiliaryOutputs: [], buffer, extensions, verified };
}

/** Per-texture bookkeeping between the recall before compression and the write after it. */
interface ISharedImagePlan {
  /** Texture index → key. */
  readonly keys: readonly string[];
  /** Textures whose image came from the store, so they are neither re-encoded nor re-put. */
  readonly recalled: ReadonlyMap<number, IRecalledTexture>;
}

interface ISharedImageCandidate {
  readonly image: ISharedImage;
  readonly key: string;
}

function sharedSettings(
  texture: Texture,
  textureOptions: IModelTexturesOptions | undefined,
): Record<string, unknown> {
  return {
    colorSpace: getTextureColorSpace(texture),
    slots: [...listTextureSlots(texture)].sort(),
    semantics: textureQualitySemantics(texture),
    textures:
      textureOptions === undefined
        ? "none"
        : {
            ...(textureOptions.astc === true ? { astc: "raw4x4-gltf-authored-basis-v2" } : {}),
            decoderFree: textureOptions.decoderFree ?? false,
            encoder: KTX2_ENCODER_VERSION,
            instrument: IMAGE_QUALITY_IDENTITY,
            floor: resolveImageQualityFloor(textureOptions.floor),
            keepSmallerSource: "universal-containers",
            maxSize: resolveTextureMaxSize(textureOptions.maxSize, listTextureSlots(texture)),
            overrides: textureOptions.overrides ?? [],
            quality: textureOptions.quality ?? null,
          },
  };
}

/**
 * Before compression: every texture whose source image, under these settings, is already in
 * the store gets the stored bytes now, so `compressEmbeddedTextures` sees a finished image and
 * leaves it alone. The pass pays for each distinct image once.
 */
async function recallSharedImages(
  document: Document,
  store: ISharedImageStore,
  textureOptions: IModelTexturesOptions | undefined,
): Promise<ISharedImagePlan> {
  const keys: string[] = [];
  const recalled = new Map<number, IRecalledTexture>();
  const textures = document.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const image = texture.getImage();
    if (image === null) {
      keys.push("");
      continue;
    }
    const key = sharedImageKey(image, sharedSettings(texture, textureOptions));
    keys.push(key);
    const stored = await store.get(key);
    if (stored === undefined) continue;
    if (
      textureOptions !== undefined &&
      textureOptions.decoderFree !== true &&
      textureOptions.measureQuality !== false &&
      stored.quality === undefined
    )
      continue;
    texture.setImage(new Uint8Array(stored.buffer)).setMimeType(stored.mimeType);
    recalled.set(index, {
      codec: stored.codec,
      sourceBytes: image.byteLength,
      quality: stored.quality,
    });
  }
  return { keys, recalled };
}

function codecOf(
  mimeType: string,
  formats: Readonly<Record<string, string>> | undefined,
  name: string,
): string {
  if (mimeType !== "image/ktx2") return "none";
  return formats?.[name] ?? "uastc";
}

/** After compression: put every freshly encoded image into the store under its source key. */
async function rememberSharedImages(
  document: Document,
  store: ISharedImageStore,
  plan: ISharedImagePlan,
  formats?: Readonly<Record<string, string>>,
  quality?: Readonly<Record<string, ITextureQuality>>,
): Promise<void> {
  const textures = document.getRoot().listTextures();
  const names = textureKeys(document.getRoot());
  for (const [index, texture] of textures.entries()) {
    if (plan.recalled.has(index)) continue;
    const key = plan.keys[index];
    const image = texture.getImage();
    if (key === undefined || key === "" || image === null) continue;
    await store.put(key, {
      buffer: Buffer.from(image.buffer, image.byteOffset, image.byteLength),
      codec: codecOf(texture.getMimeType(), formats, names[index] ?? ""),
      mimeType: texture.getMimeType(),
      ...(quality?.[names[index] ?? ""] === undefined
        ? {}
        : { quality: quality?.[names[index] ?? ""] }),
    });
  }
}

function declareSharedImage(
  store: ISharedImageStore,
  logicalPath: string,
  auxiliaryOutputs: Map<string, IAssetAuxiliaryOutput>,
  candidate: ISharedImageCandidate,
): string {
  const outputPath = store.outputPath(candidate.key, candidate.image);
  auxiliaryOutputs.set(outputPath, {
    buffer: candidate.image.buffer,
    extension: path.extname(outputPath),
    manifestField: "sharedImages",
    metadata: {
      codec: candidate.image.codec,
      key: candidate.key,
      ...(candidate.image.quality === undefined ? {} : { quality: candidate.image.quality }),
    },
    outputPath,
    role: "image",
  });
  return sharedImageUri(logicalPath, outputPath);
}

function declareSharedImageCandidates(
  byDigest: ReadonlyMap<string, readonly ISharedImageCandidate[]>,
  store: ISharedImageStore,
  logicalPath: string,
  auxiliaryOutputs: Map<string, IAssetAuxiliaryOutput>,
): void {
  for (const candidates of byDigest.values()) {
    for (const candidate of candidates) {
      declareSharedImage(store, logicalPath, auxiliaryOutputs, candidate);
    }
  }
}

/**
 * Writes the model with its images outside it, one shared file per distinct image, then re-reads
 * the output through the same store to verify it exactly as the runtime will resolve it.
 */
async function writeAndVerifyShared(
  document: Document,
  logicalPath: string,
  store: ISharedImageStore,
  plan: ISharedImagePlan,
  vertexLayout: "interleaved" | "separate" | undefined,
): Promise<{
  auxiliaryOutputs: IAssetAuxiliaryOutput[];
  buffer: Buffer;
  extensions: readonly string[];
  verified: RootOf;
}> {
  await MeshoptEncoder.ready;
  const io = new NodeIO()
    .setVertexLayout(vertexLayout === "separate" ? VertexLayout.SEPARATE : VertexLayout.INTERLEAVED)
    .registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc, TNVirtualGeometry, TNDiscreteLod])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  // Encoded bytes → every store key they were filed under. Equal encoded bytes can come from
  // distinct source keys, so each writer callback consumes one deterministic candidate rather
  // than letting the last source key overwrite the earlier ones.
  const byDigest = new Map<string, ISharedImageCandidate[]>();
  const textures = document.getRoot().listTextures();
  for (const [index, texture] of textures.entries()) {
    const key = plan.keys[index];
    const image = texture.getImage();
    if (key === undefined || key === "" || image === null) continue;
    const stored = await store.get(key);
    if (stored === undefined) {
      throw new Error(
        `TN_ASSETS_SHARED_IMAGE_MISSING: '${logicalPath}' texture #${String(index)} was never stored.`,
      );
    }
    const digest = digestOf(image);
    const candidates = byDigest.get(digest) ?? [];
    candidates.push({ image: stored, key });
    byDigest.set(digest, candidates);
  }
  const auxiliaryOutputs = new Map<string, IAssetAuxiliaryOutput>();
  // Store writes happen before this point. Declare every candidate now, rather than only the
  // ones the writer happens to request: a writer may collapse equal resources into fewer
  // callbacks, but that must not leave a source-keyed file undeclared for the output guard.
  declareSharedImageCandidates(byDigest, store, logicalPath, auxiliaryOutputs);
  let written: Awaited<ReturnType<typeof writeSharedGlb>>;
  try {
    written = await writeSharedGlb(io, document, logicalPath, (bytes) => {
      const found = byDigest.get(digestOf(bytes))?.shift();
      if (found === undefined) {
        throw new Error("the writer emitted an image the pass did not file in the shared store");
      }
      return declareSharedImage(store, logicalPath, auxiliaryOutputs, found);
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`TN_ASSETS_MODEL_WRITE_FAILED: could not write '${logicalPath}': ${detail}`);
  }
  const reader = await createGltfReader(written.buffer);
  const uriToBytes = new Map<string, Uint8Array>();
  for (const output of auxiliaryOutputs.values()) {
    uriToBytes.set(sharedImageUri(logicalPath, output.outputPath ?? ""), output.buffer);
  }
  let verified: Document;
  try {
    verified = await readSharedGlb(reader, written.buffer, async (uri) => {
      const bytes = uriToBytes.get(uri);
      if (bytes === undefined) throw new Error(`'${uri}' is not one of this model's shared images`);
      return bytes;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `TN_ASSETS_MODEL_UNREADABLE: could not parse '${logicalPath}' for the model pass: ${detail}.`,
    );
  }
  return {
    auxiliaryOutputs: [...auxiliaryOutputs.values()].sort((left, right) => {
      const leftPath = left.outputPath ?? "";
      const rightPath = right.outputPath ?? "";
      return leftPath < rightPath ? -1 : leftPath > rightPath ? 1 : 0;
    }),
    buffer: written.buffer,
    extensions: written.extensionsUsed,
    verified: verified.getRoot(),
  };
}

function digestOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
