import {
  type Document,
  Extension,
  type GLTF,
  NodeIO,
  PropertyType,
  type ReaderContext,
  type Texture,
  type WriterContext,
} from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { KHR_DF_MODEL_ASTC, read as readKTX2 } from "ktx-parse";
import { MeshoptDecoder, MeshoptEncoder } from "meshoptimizer";
import { TNDiscreteLod } from "./lod/extension.js";
import { TNVirtualGeometry } from "./virtual/extension.js";

/** Raw ASTC owns this vendor-draft extension; Basis KTX2 owns KHR_texture_basisu. */
export function isRawAstc(texture: Texture): boolean {
  const image = texture.getImage();
  if (texture.getMimeType() !== "image/ktx2" || image === null) return false;
  const container = readKTX2(image);
  return (
    (container.vkFormat === 157 || container.vkFormat === 158) &&
    container.supercompressionScheme === 0
  );
}

export class EXTTextureAstc extends Extension {
  static override EXTENSION_NAME = "EXT_texture_astc";
  override extensionName = EXTTextureAstc.EXTENSION_NAME;
  override prereadTypes = [PropertyType.TEXTURE];
  override preread(context: ReaderContext): this {
    for (const texture of context.jsonDoc.json.textures ?? []) {
      const astc = texture.extensions?.[this.extensionName] as { source?: number } | undefined;
      if (astc === undefined) continue;
      if (texture.source !== undefined || texture.extensions?.KHR_texture_basisu !== undefined)
        throw new Error(
          "TN_ASSETS_ASTC_FALLBACK: paired authored ASTC fallbacks cannot yet be preserved.",
        );
      if (!Number.isInteger(astc.source) || !context.jsonDoc.json.images?.[astc.source ?? -1])
        throw new Error("TN_ASSETS_ASTC_SOURCE: missing ASTC image source.");
      texture.source = astc.source;
    }
    return this;
  }
  read(context: ReaderContext): this {
    for (const definition of context.jsonDoc.json.textures ?? []) {
      const astc = definition.extensions?.[this.extensionName] as { source: number } | undefined;
      if (astc === undefined) continue;
      const texture = context.textures[astc.source];
      if (texture === undefined || !isRawAstc(texture))
        throw new Error("TN_ASSETS_ASTC_SOURCE: extension source must be raw ASTC 4x4 KTX2.");
    }
    this.setRequired(true);
    return this;
  }
  write(context: WriterContext): this {
    for (const texture of this.document.getRoot().listTextures()) {
      if (!isRawAstc(texture)) continue;
      const image = texture.getImage();
      if (image === null) throw new Error("TN_ASSETS_ASTC_SOURCE: missing image bytes.");
      const container = readKTX2(image);
      const dfd = container.dataFormatDescriptor[0];
      if (
        container.pixelWidth <= 0 ||
        container.pixelHeight <= 0 ||
        container.pixelWidth > 0x7fffffff ||
        container.pixelHeight > 0x7fffffff ||
        container.pixelDepth !== 0 ||
        container.layerCount !== 0 ||
        container.faceCount !== 1 ||
        container.levelCount !==
          Math.floor(Math.log2(Math.max(container.pixelWidth, container.pixelHeight))) + 1 ||
        container.levels.length !== container.levelCount ||
        container.levels.some((level, mip) => {
          const bytes =
            16 *
            Math.ceil(Math.max(1, container.pixelWidth >> mip) / 4) *
            Math.ceil(Math.max(1, container.pixelHeight >> mip) / 4);
          return level.levelData.byteLength !== bytes || level.uncompressedByteLength !== bytes;
        }) ||
        dfd?.colorModel !== KHR_DF_MODEL_ASTC ||
        dfd.texelBlockDimension.join() !== "3,3,0,0" ||
        dfd.bytesPlane.join() !== "16,0,0,0,0,0,0,0" ||
        dfd.colorPrimaries !== (container.vkFormat === 158 ? 1 : 0) ||
        dfd.transferFunction !== (container.vkFormat === 158 ? 2 : 1) ||
        (dfd.flags & 1) !== 0 ||
        (container.keyValue.KTXorientation !== undefined &&
          container.keyValue.KTXorientation !== "rd")
      )
        throw new Error(
          "TN_ASSETS_ASTC_METADATA: raw glTF ASTC must carry full mips, matching primaries/transfer, straight alpha and rd orientation.",
        );
      const imageIndex = context.imageIndexMap.get(texture);
      for (const definition of context.jsonDoc.json.textures ?? []) {
        if (definition.source !== imageIndex) continue;
        definition.extensions ??= {};
        definition.extensions[this.extensionName] = { source: imageIndex };
        definition.source = undefined;
      }
    }
    return this;
  }
}

const DRACO_EXTENSION = "KHR_draco_mesh_compression";

/** Reads the glTF JSON header out of a `.glb`/`.gltf` buffer without full parsing. */
export function peekExtensions(input: Buffer): ReadonlySet<string> {
  try {
    const json =
      input.subarray(0, 4).toString("ascii") === "glTF"
        ? (JSON.parse(
            input.subarray(20, 20 + input.readUInt32LE(12)).toString("utf8"),
          ) as GLTF.IGLTF)
        : (JSON.parse(input.toString("utf8")) as GLTF.IGLTF);
    return new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  } catch {
    // Full parsing reports malformed input with a proper named error; the peek only
    // decides which codecs to prepare.
    return new Set();
  }
}

/**
 * The one reader every pass that opens a source model shares.
 *
 * Registers every glTF-Transform extension plus this package's own virtual-geometry extension,
 * and the codecs a compressed input needs: the Meshopt decoder always (its WebAssembly module is
 * awaited first — registering it before it instantiates does not fail, it fails later inside the
 * reader as an unreadable-file error on a well-formed file), Draco only when the header names
 * it, so projects without a Draco input never pay for the codec.
 *
 * The health report once built its own bare `NodeIO` and refused every Meshopt-compressed
 * source — which is what an asset importer or a previous compile writes — with
 * `Please install extension dependency, "meshopt.decoder"`, killing `models: "none"` builds
 * from a report that only measures.
 */
export async function createGltfReader(input: Buffer): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  let io = new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, EXTTextureAstc, TNVirtualGeometry, TNDiscreteLod])
    .registerDependencies({ "meshopt.decoder": MeshoptDecoder });
  if (peekExtensions(input).has(DRACO_EXTENSION)) {
    const { createDecoderModule } = await import("draco3dgltf");
    io = io.registerDependencies({ "draco3d.decoder": await createDecoderModule() });
  }
  return io;
}

/**
 * The writer for a document a reader from {@link createGltfReader} opened. A Meshopt-compressed
 * source keeps `EXT_meshopt_compression` on its document, and a bare `NodeIO` cannot write that
 * back: an imported Unreal pack (every Landscape Pro mesh) failed the world cook at its first write.
 */
export async function createGltfWriter(): Promise<NodeIO> {
  await MeshoptEncoder.ready;
  return new NodeIO()
    .registerExtensions([...ALL_EXTENSIONS, TNDiscreteLod])
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder });
}

/**
 * Parse a self-contained `.glb` or `.gltf` buffer. Throws the reader's own error; callers wrap
 * it with their `TN_ASSETS_MODEL_UNREADABLE` message so the failure names the pass and the file.
 */
export async function readGltfDocument(io: NodeIO, input: Buffer): Promise<Document> {
  // readJSON resolves to the Document itself; binaryToJSON only unwraps the container.
  if (input.subarray(0, 4).toString("ascii") === "glTF") {
    return io.readJSON(await io.binaryToJSON(input));
  }
  return io.readJSON({ json: JSON.parse(input.toString("utf8")) as GLTF.IGLTF, resources: {} });
}
