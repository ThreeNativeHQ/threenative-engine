import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  Document,
  Extension,
  type GLTF,
  type Buffer as GltfBuffer,
  MathUtils,
  type Mesh,
  type Node,
  NodeIO,
  type Primitive,
  PropertyType,
  type Scene,
  type mat4,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshGPUInstancing } from "@gltf-transform/extensions";
import {
  compactPrimitive,
  copyToDocument,
  createDefaultPropertyResolver,
  dedup,
  getBounds,
  prune,
  transformPrimitive,
  unpartition,
} from "@gltf-transform/functions";
import { bakeTerrain, bakeWorldPackage, decodeRAW16, sampleHeight } from "@threenative/terrain";
import type { IPlacement, ITerrainState } from "@threenative/terrain";
import { MeshoptSimplifier } from "meshoptimizer";
import { createGltfReader, readGltfDocument } from "../gltf-io.js";
import { sniffImageMime } from "../health.js";
import { type DiscreteLod, TNDiscreteLod, TN_DISCRETE_LOD } from "../lod/extension.js";
import {
  LOD_ERROR_TARGETS,
  LOD_MIN_SAVING,
  generateDiscreteLod,
  thinFoliageCards,
  validateDiscreteLod,
} from "../lod/generate.js";
import { createSimplifyPool } from "../lod/simplify-pool.js";
import { modelPass } from "../passes/model.js";

/** The world.json contract, taken from the shared baker rather than restated here. */
export type IWorldPackageManifest = ReturnType<typeof bakeWorldPackage>["manifest"];
/** One streamed species entry, taken from the shared baker's own option type. */
export type IWorldPackageAsset = NonNullable<IWorldPackageManifest["assets"][string]>;

export interface ISpeciesLODSpec {
  readonly glb?: string | Uint8Array;
  readonly distance: number;
}

export interface ISpeciesSpec {
  readonly glb: string | Uint8Array;
  readonly bounds?: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  };
  readonly lods?: readonly ISpeciesLODSpec[];
  readonly maxDistance?: number;
}

export interface ICookTerrainWorldMaterialLayer {
  readonly id: string;
  readonly diff?: string | Uint8Array;
  readonly nrm?: string | Uint8Array;
  readonly orm?: string | Uint8Array;
  readonly h?: string | Uint8Array;
  readonly diffBytes?: Uint8Array;
  readonly nrmBytes?: Uint8Array;
  readonly ormBytes?: Uint8Array;
  readonly hBytes?: Uint8Array;
  readonly diffMimeType?: string;
  readonly nrmMimeType?: string;
}

export interface ICookTerrainWorldOptions {
  readonly state: ITerrainState;
  readonly species: Readonly<Record<string, ISpeciesSpec>>;
  readonly out: string;
  readonly materials?: {
    readonly layers?: readonly ICookTerrainWorldMaterialLayer[];
    readonly texturesDir?: string;
  };
  readonly cellSize?: number;
  readonly extraLayers?: Readonly<Record<string, string>>;
}

export interface ICookTerrainWorldResult {
  readonly worldGlb: Uint8Array;
  readonly manifest: IWorldPackageManifest;
  /** Reuse the validated binary package instead of baking it again for companion files. */
  readonly worldPackage?: ReturnType<typeof bakeWorldPackage>;
  readonly placementCounts: Readonly<Record<string, number>>;
  /** Every node in the document, across the default and every alternate-LOD scene. */
  readonly nodeCount: number;
  /**
   * Instancing nodes in the default `TerrainWorld` scene only, so an existing consumer keeps
   * reading one node per species. Alternate LODs live in their own named scenes and are not
   * counted here; walk `getRoot().listScenes()` for the authoritative all-scene census.
   */
  readonly instancedMeshCount: number;
}

interface ILayerMap {
  readonly layer: ICookTerrainWorldMaterialLayer;
  readonly index: number;
  readonly channel: "diff" | "nrm" | "orm" | "h";
  bytes: Uint8Array;
  /** Set once `normalizeKind` re-encodes the map. */
  mimeType?: string;
}

/**
 * One kind of map (diff, nrm, orm or h) at one decoded size across every layer, so
 * `loadTerrainSplat` can stack it into one array: one texture binding and one sampler instead of
 * one per layer. This normalizes inputs only. The asset compiler still picks each texture's codec
 * from its content, so a compiled kind can still mix codecs, and a mixed kind does not stack.
 * Already-sized JPEG/PNG maps keep their authored bytes; only maps needing resampling or alpha
 * normalization become lossless PNG. Array stacking compares decoded textures, not file encoding.
 */
async function normalizeKind(maps: readonly ILayerMap[]): Promise<void> {
  if (maps.length < 2) return;
  const sharp = (await import("sharp")).default;
  const sizes = await Promise.all(maps.map((map) => sharp(map.bytes).metadata()));
  const signature = (size: (typeof sizes)[number]) =>
    `${String(size.width)}x${String(size.height)} ${size.format} ${String(size.hasAlpha)}`;
  if (sizes.every((size) => signature(size) === signature(sizes[0] as (typeof sizes)[number])))
    return;
  const width = Math.max(...sizes.map((size) => size.width));
  const height = Math.max(...sizes.map((size) => size.height));
  const alpha = sizes.some((size) => size.hasAlpha);
  await Promise.all(
    maps.map(async (map, i) => {
      const size = sizes[i];
      if (
        size?.width === width &&
        size.height === height &&
        size.hasAlpha === alpha &&
        (size.format === "jpeg" || size.format === "png")
      ) {
        map.mimeType = `image/${size.format}`;
        return;
      }
      let image = sharp(map.bytes);
      if (sizes[i]?.width !== width || sizes[i]?.height !== height)
        image = image.resize(width, height, { fit: "fill" });
      if (alpha) image = image.ensureAlpha();
      map.bytes = new Uint8Array(
        await image.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer(),
      );
      map.mimeType = "image/png";
    }),
  );
}

/** A placement as a world-package record: `item.transform` when authored, else the scatter pose. */
function poseOf(item: IPlacement): {
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  grounding: boolean;
} {
  if (item.transform !== undefined) {
    const { position, quaternion, scale, grounding = true } = item.transform;
    return {
      position: [position[0], position[1], position[2]],
      quaternion: [quaternion[0], quaternion[1], quaternion[2], quaternion[3]],
      scale: [scale[0], scale[1], scale[2]],
      grounding,
    };
  }
  return {
    position: [item.position[0], item.position[1], item.position[2]],
    quaternion: [0, Math.sin(item.rotation / 2), 0, Math.cos(item.rotation / 2)],
    scale: [item.scale, item.scale, item.scale],
    grounding: true,
  };
}

async function resolveBytes(input: string | Uint8Array): Promise<Uint8Array> {
  if (typeof input === "string") {
    return readFile(input);
  }
  return input;
}

/** A species id becomes an output filename, so refuse anything that is not a bare name. */
const SAFE_SPECIES_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Source world-space bounds when the species authors none: geometry plus its node world matrices. */
function sourceBounds(speciesDoc: Document): {
  min: [number, number, number];
  max: [number, number, number];
} {
  const root = speciesDoc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  if (scene) {
    const { min, max } = getBounds(scene);
    if (min.every(Number.isFinite) && max.every(Number.isFinite)) {
      return { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] };
    }
  }
  return { min: [0, 0, 0], max: [0, 0, 0] };
}

/** The mesh-bearing nodes under a species' default scene, in traversal order. */
function meshNodesOf(speciesDoc: Document): { node: Node; mesh: Mesh }[] {
  const root = speciesDoc.getRoot();
  const scene = root.getDefaultScene() ?? root.listScenes()[0] ?? null;
  const meshNodes: { node: Node; mesh: Mesh }[] = [];
  scene?.traverse((node: Node) => {
    const mesh = node.getMesh();
    if (mesh) meshNodes.push({ node, mesh });
  });
  return meshNodes;
}

/**
 * Refuse a species that cannot instance, by name, before a byte is written: a deformer, an
 * animation replay, or an actually-empty draw (no mesh, no primitive, or no positioned vertices).
 * A positive placement count and zero source bounds must not hide a species with nothing to draw.
 */
function assertInstancable(speciesId: string, speciesDoc: Document): void {
  if (speciesDoc.getRoot().listSkins().length > 0) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' declares a skin; only static species can be instanced.`,
    );
  }
  if (speciesDoc.getRoot().listAnimations().length > 0) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' declares an animation; only static species can be instanced.`,
    );
  }
  const meshNodes = meshNodesOf(speciesDoc);
  const primitives = meshNodes.flatMap(({ mesh }) => mesh.listPrimitives());
  const positioned = primitives.some((primitive) => {
    const positions = primitive.getAttribute("POSITION")?.getArray();
    return positions !== undefined && positions !== null && positions.length > 0;
  });
  if (meshNodes.length === 0 || primitives.length === 0 || !positioned) {
    throw new Error(
      `cookTerrainWorld: species '${speciesId}' has no instancable mesh geometry (empty draw); a static species must ship a positioned primitive.`,
    );
  }
}

/** Parse one species or LOD GLB. The same bytes are parsed exactly once per level. */
async function parseSpecies(bytes: Uint8Array): Promise<Document> {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const reader = await createGltfReader(input);
  const doc = await readGltfDocument(reader, input);
  validateDiscreteLod(doc.getRoot());
  return doc;
}

/**
 * How much of a species' coarsest level each derived far level keeps: alpha cards by whole-card
 * thinning (`thinFoliageCards`, scaled so the crown keeps its coverage), every other primitive by
 * the simplifier.
 *
 * Without them a chain ends where the author stopped. The fir kit stops at a 55k-triangle mid that
 * holds out to 600 m, so a 512 m forest drew 62.5M triangles a frame for ~1,100 trees in view:
 * 113-120 ms GPU on an Iris Xe laptop and 18-31 ms on an RTX 2080. With these two levels the same
 * pose drew 10-22M (the adaptive LOD bias moves it) at 47-61 ms and 9 ms (PRD-762).
 */
const FAR_LEVEL_KEEP_RATIOS: readonly number[] = [0.25, 0.06];

function documentTriangles(doc: Document): number {
  let total = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives())
      total += Math.floor((primitive.getIndices()?.getCount() ?? 0) / 3);
  return total;
}

/** Simplify every indexed triangle primitive that is not an alpha card set to `keep` of its count. */
function simplifySolidParts(doc: Document, keep: number): void {
  for (const mesh of doc.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) {
      const indices = primitive.getIndices();
      const position = primitive.getAttribute("POSITION");
      if (
        primitive.getMaterial()?.getAlphaMode() === "MASK" ||
        primitive.getMode() !== 4 ||
        indices === null ||
        position === null
      )
        continue;
      const positions = new Float32Array(position.getCount() * 3);
      const element: number[] = [];
      for (let vertex = 0; vertex < position.getCount(); vertex += 1)
        positions.set(position.getElement(vertex, element), vertex * 3);
      const source = Uint32Array.from(indices.getArray() ?? []);
      // A bad index is the cook's own named error at flatten time, not the simplifier's crash.
      if (source.some((index) => index >= position.getCount())) continue;
      const target = Math.max(3, Math.floor((source.length * keep) / 3) * 3);
      // Permissive collapses across UV and normal seams, which is what a far level can afford.
      const [kept] = MeshoptSimplifier.simplify(source, positions, 3, target, 1, [
        "Prune",
        "Permissive",
      ]);
      primitive.setIndices(indices.clone().setArray(kept));
    }
}

/** One far level of `bytes` at `keep`, or `undefined` when its alpha cards cannot be thinned. */
async function farLevelDocument(bytes: Uint8Array, keep: number): Promise<Document | undefined> {
  const doc = await parseSpecies(bytes);
  // A level's own index-only chain indexes the triangles simplification replaces.
  for (const extension of doc.getRoot().listExtensionsUsed())
    if (extension.extensionName === TN_DISCRETE_LOD) extension.dispose();
  try {
    thinFoliageCards(doc, keep);
  } catch {
    return undefined;
  }
  simplifySolidParts(doc, keep);
  // Drop the vertices no kept triangle reaches, so a far level does not stream the mid's buffers.
  for (const mesh of doc.getRoot().listMeshes())
    for (const primitive of mesh.listPrimitives()) compactPrimitive(primitive);
  await doc.transform(prune({ keepSolidTextures: true }));
  return doc;
}

/**
 * Far levels past a species' coarsest level, each switched in where it holds the same on-screen
 * triangle density the coarsest level had at its own switch: a level with `1/k` of the triangles
 * takes over at `sqrt(k)` times the distance, since projected area falls with distance squared.
 * A level that saves less than `LOD_MIN_SAVING` of the one before it, or would switch at or past
 * `maxDistance`, is not shipped. A species whose alpha cards cannot be thinned keeps its chain.
 */
async function deriveFarLevels(
  speciesId: string,
  coarsest: { readonly distance: number; readonly glb: Uint8Array; readonly doc: Document },
  firstIndex: number,
  maxDistance: number | undefined,
): Promise<{ distance: number; glb: Uint8Array; filename: string; doc: Document }[]> {
  await MeshoptSimplifier.ready;
  const anchor = documentTriangles(coarsest.doc);
  const levels: { distance: number; glb: Uint8Array; filename: string; doc: Document }[] = [];
  let previous = anchor;
  for (const keep of FAR_LEVEL_KEEP_RATIOS) {
    const doc = await farLevelDocument(coarsest.glb, keep);
    if (doc === undefined) return levels;
    const triangles = documentTriangles(doc);
    if (triangles <= 0 || triangles > (1 - LOD_MIN_SAVING) * previous) continue;
    const distance = coarsest.distance * Math.sqrt(anchor / triangles);
    if (maxDistance !== undefined && distance >= maxDistance) break;
    const writer = new NodeIO().registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod]);
    levels.push({
      distance: Math.round(distance * 10) / 10,
      glb: await writer.writeBinary(doc),
      filename: `${speciesId}_lod${firstIndex + levels.length}.glb`,
      doc,
    });
    previous = triangles;
  }
  return levels;
}

/** Optimize only streamed images; restore the document used to assemble the combined world. */
async function optimizeStreamedJpegs(
  bytes: Uint8Array,
  loadedDocument: Document,
  asset: string,
): Promise<Uint8Array> {
  const originals = new Map<ReturnType<Document["createTexture"]>, Uint8Array>();
  try {
    for (const texture of loadedDocument.getRoot().listTextures()) {
      if (texture.getMimeType() !== "image/jpeg") continue;
      const image = texture.getImage();
      try {
        if (image === null) throw new Error("JPEG has no image bytes");
        const sharp = (await import("sharp")).default;
        const decoder = sharp(image, { failOn: "warning" });
        const metadata = await decoder.metadata();
        await decoder.stats();
        if (
          metadata.isProgressive ||
          metadata.space === "cmyk" ||
          metadata.depth !== "uchar" ||
          (metadata.bitsPerSample !== undefined && metadata.bitsPerSample !== 8)
        )
          continue;
        const { optimize } = await import("jspeg");
        const optimized = optimize(image, { strip: false });
        if (optimized.byteLength < image.byteLength) {
          originals.set(texture, image);
          texture.setImage(optimized);
        }
      } catch (cause) {
        throw new Error(`cookTerrainWorld: ${asset} texture '${texture.getName()}' JPEG failed.`, {
          cause,
        });
      }
    }
    return originals.size === 0
      ? bytes
      : await new NodeIO()
          .registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod])
          .writeBinary(loadedDocument);
  } finally {
    for (const [texture, image] of originals) texture.setImage(image);
  }
}

/**
 * Authored sibling LODs beside a path species: `<root>-mid.glb`, else `<root>-lod1.glb`, where
 * `<root>` drops one trailing detail marker (`-near`, `-lod1`, `-lod2`, …) from the file name.
 * Returns nothing when the caller authored `lods` explicitly or no sibling exists; the caller
 * then falls back to `modelPass({ simplify })`.
 */
async function authoredSiblingLods(glbPath: string): Promise<{ distance: number; glb: string }[]> {
  const dir = path.dirname(glbPath);
  const base = path.basename(glbPath).replace(/\.glb$/i, "");
  const root = base.replace(/-(near|hi|lod\d+)$/i, "");
  for (const candidate of [`${root}-mid.glb`, `${root}-lod1.glb`]) {
    const file = path.join(dir, candidate);
    if (file === glbPath) continue;
    try {
      await stat(file);
      return [{ distance: 40, glb: file }];
    } catch (error) {
      // Only a missing sibling means "try the next name"; any other IO error is real.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [];
}

function isExtensionConstructor(ctor: unknown): ctor is new (doc: Document) => Extension {
  return typeof ctor === "function" && ctor.prototype instanceof Extension;
}

/**
 * `transformMesh` writes a normalized-integer NORMAL back through `decodeNormalizedInt` instead of
 * `encodeNormalizedInt`, so a quantized model's normals all become zero: no light reaches the
 * prop and screen-space occlusion reads it as fully occluded. Float normals survive its transform.
 */
function dequantizeNormals(mesh: Mesh): void {
  for (const primitive of mesh.listPrimitives()) {
    const normal = primitive.getAttribute("NORMAL");
    const source = normal?.getArray();
    if (normal === null || source == null || !normal.getNormalized()) continue;
    const type = normal.getComponentType();
    const decoded = new Float32Array(source.length);
    for (let index = 0; index < source.length; index++)
      decoded[index] = MathUtils.decodeNormalizedInt(source[index] as number, type);
    normal.setArray(decoded).setNormalized(false);
  }
}

const UNUSED_VERTEX = 0xffffffff;

/** gltf-transform's compaction plan: vertices renumbered in the order the LOD0 indices reach them. */
function firstReferencePlan(primitive: Primitive): { remap: Uint32Array; count: number } {
  const vertexCount = primitive.getAttribute("POSITION")?.getCount() ?? 0;
  const indices = primitive.getIndices()?.getArray();
  const remap = new Uint32Array(vertexCount).fill(UNUSED_VERTEX);
  let count = 0;
  if (indices == null)
    for (let vertex = 0; vertex < vertexCount; vertex += 1) remap[vertex] = count++;
  else
    for (const index of indices) {
      if (!Number.isInteger(index) || index < 0 || index >= vertexCount)
        throw new Error(`Species LOD0 index ${index} is out of range for ${vertexCount} vertices.`);
      if (remap[index] === UNUSED_VERTEX) remap[index] = count++;
    }
  return { remap, count };
}

/**
 * `transformMesh`, in place. It compacts each primitive first, renumbering the vertices in the
 * order the LOD0 indices first reach them, and reverses LOD0's winding under a mirroring matrix.
 * The index-only TN_discrete_lod levels were baked against the source numbering and are an
 * extension it does not know, so it left them indexing other vertices: every far tree drew cones
 * and slivers. The same plan and the same winding reach every level here.
 */
function transformWithLodChain(primitive: Primitive, matrix: mat4): void {
  const { remap, count } = firstReferencePlan(primitive);
  const chain = primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
  if (chain !== null) {
    // Each primitive has its own compaction order even when its authored chain/accessors are shared.
    const owned = chain.clone();
    for (const level of chain.getIndices()) owned.swap(level, level.clone());
    primitive.setExtension(TN_DISCRETE_LOD, owned);
  }
  compactPrimitive(primitive, remap, count);
  const [a, b, c, , d, e, f, , g, h, i] = matrix;
  const mirrored = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g) < 0;
  for (const level of primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD)?.getIndices() ?? []) {
    const source = level.getArray() ?? [];
    const carried = new Uint32Array(source.length);
    for (let index = 0; index < source.length; index += 1) {
      // A mirror swaps each triangle's first and last corner, as LOD0's own reversal does.
      const corner = mirrored ? index + 2 - 2 * (index % 3) : index;
      carried[index] = remap[source[corner] as number] ?? UNUSED_VERTEX;
    }
    if (carried.includes(UNUSED_VERTEX))
      throw new Error("A TN_discrete_lod level indexes a vertex that its LOD0 does not draw.");
    level.setArray(carried);
  }
  transformPrimitive(primitive, matrix);
}

/**
 * One `EXT_mesh_gpu_instancing` node for one species-and-LOD pair, holding every logical
 * placement. Source meshes, materials, textures and each source node's world transform are
 * preserved by the fresh-copy-per-node path: one resolver per node keeps shared geometry private.
 */
function addInstancedSpeciesNode(
  doc: Document,
  buffer: GltfBuffer,
  speciesDoc: Document,
  items: IPlacement[],
  targetScene: Scene,
  instancingExt: EXTMeshGPUInstancing,
  nodeName: string,
): void {
  const count = items.length;
  const translations = new Float32Array(count * 3);
  const rotations = new Float32Array(count * 4);
  const scales = new Float32Array(count * 3);
  for (const [i, item] of items.entries()) {
    const pose = poseOf(item);
    translations.set(pose.position, i * 3);
    rotations.set(pose.quaternion, i * 4);
    scales.set(pose.scale, i * 3);
  }

  const batch = instancingExt
    .createInstancedMesh()
    .setAttribute(
      "TRANSLATION",
      doc.createAccessor().setType("VEC3").setArray(translations).setBuffer(buffer),
    )
    .setAttribute(
      "ROTATION",
      doc.createAccessor().setType("VEC4").setArray(rotations).setBuffer(buffer),
    )
    .setAttribute("SCALE", doc.createAccessor().setType("VEC3").setArray(scales).setBuffer(buffer));

  // Any extension the source uses must exist on the target document before its properties copy.
  for (const sourceExtension of speciesDoc.getRoot().listExtensionsUsed()) {
    const ctor = sourceExtension.constructor;
    if (!isExtensionConstructor(ctor)) {
      throw new TypeError(
        `Invalid species extension constructor: ${sourceExtension.extensionName}`,
      );
    }
    doc.createExtension(ctor);
  }

  const combined = doc.createMesh(`${nodeName}_mesh`);
  for (const { node, mesh } of meshNodesOf(speciesDoc)) {
    const resolve = createDefaultPropertyResolver(doc, speciesDoc);
    const targetMesh = copyToDocument(doc, speciesDoc, [mesh], resolve).get(mesh) as Mesh;
    const matrix = node.getWorldMatrix();
    dequantizeNormals(targetMesh);
    for (const primitive of targetMesh.listPrimitives()) transformWithLodChain(primitive, matrix);
    // Index-only levels share the transformed vertices; their local errors must follow them.
    const scale = Math.max(
      Math.hypot(matrix[0], matrix[1], matrix[2]),
      Math.hypot(matrix[4], matrix[5], matrix[6]),
      Math.hypot(matrix[8], matrix[9], matrix[10]),
    );
    for (const primitive of targetMesh.listPrimitives()) {
      const chain = primitive.getExtension<DiscreteLod>(TN_DISCRETE_LOD);
      chain
        ?.setErrorScale(chain.getErrorScale() * scale)
        .setAbsoluteErrors(chain.getAbsoluteErrors().map((error) => error * scale));
    }
    for (const primitive of targetMesh.listPrimitives()) {
      targetMesh.removePrimitive(primitive);
      combined.addPrimitive(primitive);
    }
  }

  const instancedNode = doc
    .createNode(nodeName)
    .setMesh(combined)
    .setExtension("EXT_mesh_gpu_instancing", batch);
  targetScene.addChild(instancedNode);
}

/** A portable editor scene with embedded data URIs, already frozen by the game. */
export interface IPreparedTerrainWorldOptions {
  readonly preparedWorld: Record<string, unknown>;
}
/**
 * The MIME a streamed terrain map carries when the caller names none: its own container. A missing
 * label used to mean `image/jpeg`, so a PNG map shipped as a JPEG the loader then refused.
 */
function authoredMime(bytes: Uint8Array, layer: string, channel: string): string {
  const mime = sniffImageMime(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (mime === undefined)
    throw new Error(
      `cookTerrainWorld: layer '${layer}' ${channel} map is neither a readable JPEG nor a PNG; pass ${channel}MimeType to name its codec.`,
    );
  return mime;
}

export function cookTerrainWorld(
  options: IPreparedTerrainWorldOptions,
): Promise<{ worldGlb: Uint8Array }>;
export function cookTerrainWorld(
  options: ICookTerrainWorldOptions,
): Promise<ICookTerrainWorldResult>;
export async function cookTerrainWorld(
  options: ICookTerrainWorldOptions | IPreparedTerrainWorldOptions,
): Promise<ICookTerrainWorldResult | { worldGlb: Uint8Array }> {
  if ("preparedWorld" in options) {
    const json = options.preparedWorld as Partial<GLTF.IGLTF>;
    if (json.asset?.version !== "2.0" || !json.scenes?.length || !json.meshes?.length)
      throw new Error("Prepared world requires a nonempty glTF 2.0 scene");
    if (
      json.cameras?.length ||
      json.animations?.length ||
      json.extensionsRequired?.some((name) => !name.startsWith("KHR_"))
    )
      throw new Error("Prepared world contains nonportable scene content");
    for (const resource of [...(json.buffers ?? []), ...(json.images ?? [])]) {
      if (resource.uri && !/^data:[^,]*;base64,[A-Za-z0-9+/]*={0,2}$/.test(resource.uri))
        throw new Error("Prepared world resources must be embedded base64 data URIs");
    }
    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
    const doc = await io.readJSON({ json: { ...json, asset: json.asset }, resources: {} });
    if (
      !doc
        .getRoot()
        .listScenes()
        .some((scene) => scene.listChildren().length)
    )
      throw new Error("Prepared world has no scene nodes");
    await doc.transform(unpartition(), dedup({ propertyTypes: [PropertyType.TEXTURE] }));
    return { worldGlb: await io.writeBinary(doc) };
  }
  const { state, species, out } = options;
  if (!state || typeof state.size !== "number" || typeof state.resolution !== "number") {
    throw new Error("cookTerrainWorld: state with size and resolution is required");
  }
  if (!state.height || state.height.length !== state.resolution * state.resolution) {
    throw new Error("cookTerrainWorld: state.height length does not match resolution * resolution");
  }

  // A species id becomes an output filename, so every key must be a safe bare name.
  for (const speciesId of Object.keys(species)) {
    if (!SAFE_SPECIES_ID.test(speciesId)) {
      throw new Error(
        `cookTerrainWorld: species id '${speciesId}' is not a safe output filename; use letters, digits, '.', '_' or '-'.`,
      );
    }
  }

  // Every placement must name a species the caller supplied, before anything is read or written.
  for (const item of state.instances) {
    if (species[item.asset] === undefined) {
      throw new Error(
        `cookTerrainWorld: placement '${item.id}' names species '${item.asset}', which is not in the species map.`,
      );
    }
  }

  // Build every species' manifest entry (and its LOD bytes) before the shared bake. Each species
  // model and each of its LODs is parsed exactly once here: the same documents later flatten into
  // their instancing nodes, and every level is refused by name if it cannot instance.
  const assets: Record<string, IWorldPackageAsset> = {};
  const speciesFiles: {
    speciesId: string;
    lod0: Uint8Array;
    nearDoc: Document;
    lods: { distance: number; glb: Uint8Array; filename: string; doc: Document }[];
  }[] = [];

  const pool = createSimplifyPool(LOD_ERROR_TARGETS.length);
  try {
    const tasks = Object.entries(species).map(async ([speciesId, spec]) => {
      const lod0 = await resolveBytes(spec.glb);
      const nearDoc = await parseSpecies(lod0);
      assertInstancable(speciesId, nearDoc);
      const streamedLod0 = await optimizeStreamedJpegs(lod0, nearDoc, `${speciesId}.glb`);

      // Authored LODs first: explicit `spec.lods`, then a sibling `-mid`/`-lod1` file beside a path
      // species. Only when neither exists does simplification invent a level.
      const authored =
        spec.lods && spec.lods.length > 0
          ? spec.lods
          : typeof spec.glb === "string"
            ? await authoredSiblingLods(spec.glb)
            : [];

      const lods: { distance: number; glb: Uint8Array; filename: string; doc: Document }[] = [];
      for (const [i, level] of authored.entries()) {
        if (level.glb === undefined) continue;
        const bytes = await resolveBytes(level.glb);
        const doc = await parseSpecies(bytes);
        assertInstancable(speciesId, doc);
        lods.push({
          distance: level.distance,
          glb: bytes,
          filename: `${speciesId}_lod${i + 1}.glb`,
          doc,
        });
      }

      if (lods.length === 0) {
        const pass = modelPass({
          simplify: { ratio: 0.5 },
          textures: "none",
          passes: { meshopt: false, prune: true, dedup: true },
        });
        const simplified = await pass.apply(Buffer.from(lod0), `${speciesId}_lod1.glb`);
        const bytes = Uint8Array.from(Buffer.isBuffer(simplified) ? simplified : simplified.buffer);
        const doc = await parseSpecies(bytes);
        assertInstancable(speciesId, doc);
        lods.push({ distance: 40, glb: bytes, filename: `${speciesId}_lod1.glb`, doc });
      }

      const coarsest = lods.at(-1);
      if (coarsest !== undefined)
        lods.push(
          ...(await deriveFarLevels(speciesId, coarsest, lods.length + 1, spec.maxDistance)),
        );

      // Optimize streamed bytes before adding the combined world's own index-only chain.
      for (const level of lods)
        level.glb = await optimizeStreamedJpegs(level.glb, level.doc, level.filename);

      // The combined world's near meshes need their own index-only chain; streamed files stay authored.
      await generateDiscreteLod(
        nearDoc,
        { cutout: false },
        `${speciesId}.glb`,
        createHash("sha256").update(lod0).digest("hex"),
        {},
        undefined,
        { preserveVertices: true, simplify: pool.simplify },
      );

      const asset: IWorldPackageAsset = {
        glb: `models/${speciesId}.glb`,
        bounds: spec.bounds ?? sourceBounds(nearDoc),
        lods: lods.map((level) => ({
          distance: level.distance,
          glb: `models/${level.filename}`,
        })),
        ...(spec.maxDistance === undefined ? {} : { maxDistance: spec.maxDistance }),
      };
      return { speciesId, lod0: streamedLod0, nearDoc, lods, asset };
    });
    const prepared = await Promise.all(tasks);
    // Promise.all preserves source order; completion order must not change GLB or manifest bytes.
    for (const { asset, ...file } of prepared) {
      speciesFiles.push(file);
      assets[file.speciesId] = asset;
    }
  } finally {
    await pool.dispose();
  }

  // Fail closed before any glTF work or output write: the shared baker validates finite heights,
  // known assets and uniform poses, and hands back the exact binary files this cook writes.
  const worldPackage = bakeWorldPackage(state, {
    assets,
    ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
    ...(options.extraLayers === undefined ? {} : { layers: options.extraLayers }),
  });
  const { manifest, files } = worldPackage;

  // Contact check against the bytes the bake actually wrote, not the float grid: decode the
  // quantized uint16 heightmap back to metres and sample that. Tolerance is one uint16 step of the
  // written range plus float32 rounding — a sub-texel hop passes; a real offset above one step,
  // and a mirrored-Z placement that reads the wrong row, both fail. `grounding: false` is an
  // authored override and is skipped honestly.
  const heightmapBytes = files[manifest.terrain.heightmap];
  if (heightmapBytes === undefined) {
    throw new Error("cookTerrainWorld: the world package wrote no heightmap to sample.");
  }
  const decoded = decodeRAW16(heightmapBytes, {
    width: manifest.terrain.columns,
    height: manifest.terrain.rows,
    min: manifest.terrain.heightMin,
    max: manifest.terrain.heightMax,
  });
  const decodedGrid = {
    height: decoded.values,
    resolution: manifest.terrain.columns,
    size: state.size,
  };
  const terrainRange = manifest.terrain.heightMax - manifest.terrain.heightMin;
  const heightQuantStep = terrainRange / 65_535;
  // 2^-23 is float32's machine epsilon; the sampled and decoded values share that rounding.
  const tolerance = heightQuantStep + terrainRange * 1.2e-7;
  for (const item of state.instances) {
    const pose = poseOf(item);
    if (!pose.grounding) continue;
    const groundY = sampleHeight(decodedGrid, pose.position[0], pose.position[2]);
    const difference = Math.abs(pose.position[1] - groundY);
    if (Number.isFinite(difference) && difference > tolerance) {
      throw new Error(
        `Placement '${item.id}' of species '${item.asset}' contact check failed: base Y=${pose.position[1]} misses terrain ground Y=${groundY} by ${difference.toFixed(4)}m (> tolerance ${tolerance.toFixed(4)}m). Check for mirrored-Z or invalid coordinates.`,
      );
    }
  }

  // Setup glTF document. The default scene holds only the near LOD of every species; each
  // alternate LOD gets its own named scene, so no two LODs render at once.
  const doc = new Document();
  doc.getRoot().getAsset().extras = { tnTerrainWorld: 1 };
  const scene = doc.createScene("TerrainWorld");
  const buffer = doc.createBuffer();
  const instancingExt = doc.createExtension(EXTMeshGPUInstancing);

  // Terrain mesh chunks, always from the shared baker's LOD0.
  const chunks = bakeTerrain(state, { lodSteps: [1] }).lods[0]?.chunks ?? [];

  // Preserve authored maps separately; the GLB retains its vanilla first-layer fallback.
  const textureFiles = new Map<string, Uint8Array>();
  const terrainMaterial = doc.createMaterial("TerrainMaterial");
  const channels = ["diff", "nrm", "orm", "h"] as const;
  const maps: ILayerMap[] = [];
  for (const [index, layer] of (options.materials?.layers ?? []).entries()) {
    if (!/^[a-zA-Z0-9_-]+$/u.test(layer.id))
      throw new Error(`cookTerrainWorld: invalid texture layer id '${layer.id}'.`);
    for (const channel of channels) {
      let bytes = layer[`${channel}Bytes`];
      const source = layer[channel];
      if (bytes === undefined && source !== undefined) {
        if (typeof source === "string" && options.materials?.texturesDir !== undefined) {
          const dir = path.resolve(options.materials.texturesDir);
          const filename = path.resolve(dir, source);
          const relative = path.relative(dir, filename);
          if (
            relative === ".." ||
            relative.startsWith(`..${path.sep}`) ||
            path.isAbsolute(relative)
          )
            throw new Error(`cookTerrainWorld: texture '${source}' escapes texturesDir '${dir}'.`);
          bytes = await resolveBytes(filename);
        } else bytes = await resolveBytes(source);
      }
      if (bytes !== undefined) maps.push({ layer, index, channel, bytes });
    }
  }
  for (const channel of channels)
    await normalizeKind(maps.filter((map) => map.channel === channel));
  for (const { layer, index, channel, bytes, mimeType } of maps) {
    textureFiles.set(`${layer.id}_${channel}.jpg`, bytes);
    if (index === 0 && (channel === "diff" || channel === "nrm")) {
      const texture = doc
        .createTexture(channel === "diff" ? "TerrainBaseDiff" : "TerrainBaseNrm")
        .setImage(bytes)
        .setMimeType(
          mimeType ?? layer[`${channel}MimeType`] ?? authoredMime(bytes, layer.id, channel),
        );
      if (channel === "diff") terrainMaterial.setBaseColorTexture(texture);
      else terrainMaterial.setNormalTexture(texture);
    }
  }

  // Add chunk meshes
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    if (!chunk) continue;
    const mesh = doc.createMesh(chunk.name ?? `terrain_chunk_${c}`);
    const prim = doc.createPrimitive();
    prim.setMaterial(terrainMaterial);
    prim.setAttribute(
      "POSITION",
      doc.createAccessor().setType("VEC3").setArray(chunk.positions).setBuffer(buffer),
    );
    prim.setAttribute(
      "NORMAL",
      doc.createAccessor().setType("VEC3").setArray(chunk.normals).setBuffer(buffer),
    );
    prim.setAttribute(
      "TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setArray(chunk.uvs).setBuffer(buffer),
    );
    prim.setIndices(
      doc.createAccessor().setType("SCALAR").setArray(chunk.indices).setBuffer(buffer),
    );
    mesh.addPrimitive(prim);
    const node = doc.createNode(chunk.name ?? `terrain_node_${c}`).setMesh(mesh);
    if (manifest.terrain.layers?.table !== undefined) {
      const pointer = { tnTerrainSurface: "world.json" };
      mesh.setExtras(pointer);
      node.setExtras(pointer);
    }
    scene.addChild(node);
  }

  // Group placements by species
  const placementsBySpecies = new Map<string, IPlacement[]>();
  const placementCounts: Record<string, number> = {};
  for (const item of state.instances) {
    let list = placementsBySpecies.get(item.asset);
    if (!list) {
      list = [];
      placementsBySpecies.set(item.asset, list);
    }
    list.push(item);
    placementCounts[item.asset] = (placementCounts[item.asset] ?? 0) + 1;
  }

  // Near LOD: one instancing node per species in the default scene, every logical placement one
  // instance, so the node count stays constant while the instance count grows.
  for (const { speciesId, nearDoc } of speciesFiles) {
    const items = placementsBySpecies.get(speciesId) ?? [];
    if (items.length === 0) continue;
    addInstancedSpeciesNode(
      doc,
      buffer,
      nearDoc,
      items,
      scene,
      instancingExt,
      `${speciesId}_instances`,
    );
  }

  // Alternate LODs: one instancing node per species-and-LOD pair, each in its own named scene,
  // with the same placements as the near node. glTF renders only the default scene, so no two
  // LODs draw at once.
  for (const { speciesId, lods } of speciesFiles) {
    const items = placementsBySpecies.get(speciesId) ?? [];
    if (items.length === 0) continue;
    for (const [i, level] of lods.entries()) {
      const lodScene = doc.createScene(`${speciesId}_lod${i + 1}`);
      addInstancedSpeciesNode(
        doc,
        buffer,
        level.doc,
        items,
        lodScene,
        instancingExt,
        `${speciesId}_lod${i + 1}_instances`,
      );
    }
  }

  doc.getRoot().setDefaultScene(scene);

  await doc.transform(unpartition());
  // Keep solid-texture removal off: species materials are authored, and a flat image is not ours to drop.
  await doc.transform(prune({ keepSolidTextures: true }));
  // Store byte-identical textures once. Each material keeps its own sampler and UV transform.
  await doc.transform(dedup({ propertyTypes: [PropertyType.TEXTURE] }));

  const writer = new NodeIO().registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod]);
  const worldGlb = await writer.writeBinary(doc);

  // Collect in the original write order so even overlapping species filenames keep last-write wins.
  const outputs = new Map<string, string | Uint8Array>([["world.glb", worldGlb]]);
  for (const [name, bytes] of textureFiles) outputs.set(path.join("textures", name), bytes);
  for (const [name, bytes] of Object.entries(files)) outputs.set(name, bytes);
  for (const { speciesId, lod0, lods } of speciesFiles) {
    outputs.set(path.join("models", `${speciesId}.glb`), lod0);
    for (const level of lods) outputs.set(path.join("models", level.filename), level.glb);
  }
  outputs.set("world.json", `${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(out, { recursive: true });
  await mkdir(path.join(out, "models"), { recursive: true });
  if (textureFiles.size > 0) await mkdir(path.join(out, "textures"), { recursive: true });
  await Promise.all([...outputs].map(([name, bytes]) => writeFile(path.join(out, name), bytes)));

  const finalNodes = doc.getRoot().listNodes();
  let instancedMeshCount = 0;
  for (const child of scene.listChildren()) {
    if (child.getExtension("EXT_mesh_gpu_instancing") !== null) instancedMeshCount++;
  }

  return {
    worldGlb,
    manifest,
    worldPackage,
    placementCounts,
    nodeCount: finalNodes.length,
    instancedMeshCount,
  };
}
