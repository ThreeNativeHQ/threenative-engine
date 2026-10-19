import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Document, Format, type GLTF, type NodeIO } from "@gltf-transform/core";
import { type ITextureQuality, readTextureQuality } from "../image-quality.js";

/**
 * Images that models share, written once and referenced from every model that carries them.
 *
 * A marketplace pack embeds its textures in every model that uses them: eight pines each carry
 * the same 9 MB of bark and needle maps, so a valley of 58 models moves 280 MB for 63 MB of
 * distinct images — and re-encodes every one of them on every build. The store keys an image on
 * its **source** bytes plus the settings that decide its output, so the second model that
 * carries the same bark map finds the encoded result instead of paying for it again, and a
 * second build finds it on disk.
 *
 * The output is content-addressed under `shared/images/`, so two models that embed the same
 * bytes resolve to one URL and the browser cache, the bundle and the delete-test all see one file.
 */
export interface ISharedImage {
  readonly quality?: ITextureQuality;
  readonly buffer: Buffer;
  /** `uastc`, `etc1s` or `none`, spelled into the filename so a cache hit knows what it found. */
  readonly codec: string;
  readonly mimeType: string;
}

export interface ISharedImageStoreOptions {
  /**
   * Persist `put()` immediately. The compiler disables this because it publishes the returned
   * auxiliary output itself, after recording ownership; direct stores retain write-through.
   */
  readonly writeThrough?: boolean;
}

export interface ISharedImageStore {
  /** The image encoded from this key, from memory or from a previous build's output. */
  get(key: string): Promise<ISharedImage | undefined>;
  put(key: string, image: ISharedImage): Promise<void>;
  /** Output path, relative to the output root, of a stored image. */
  outputPath(key: string, image: Pick<ISharedImage, "codec" | "mimeType">): string;
}

export const SHARED_IMAGES_DIRECTORY = "shared/images";
const KEY_LENGTH = 16;

const EXTENSION_BY_MIME: Readonly<Record<string, string>> = {
  "image/jpeg": ".jpg",
  "image/ktx2": ".ktx2",
  "image/png": ".png",
  "image/webp": ".webp",
};

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSION_BY_MIME).map(([mime, extension]) => [extension, mime]),
);

function extensionOf(mimeType: string): string {
  const extension = EXTENSION_BY_MIME[mimeType];
  if (extension === undefined) {
    throw new Error(`TN_ASSETS_SHARED_IMAGE_MIME: no file extension is known for '${mimeType}'.`);
  }
  return extension;
}

/** `<key>.<codec><ext>`, so the filename alone says what the bytes are. */
function fileNameFor(key: string, image: Pick<ISharedImage, "codec" | "mimeType">): string {
  return `${key}.${image.codec}${extensionOf(image.mimeType)}`;
}

function parseFileName(
  name: string,
): { readonly key: string; readonly codec: string; readonly mimeType: string } | undefined {
  const match = /^([0-9a-f]{16})\.([a-z0-9]+)(\.[a-z0-9]+)$/u.exec(name);
  if (match === null) return undefined;
  const [, key, codec, extension] = match;
  const mimeType = MIME_BY_EXTENSION[extension ?? ""];
  if (key === undefined || codec === undefined || mimeType === undefined) return undefined;
  return { codec, key, mimeType };
}

/**
 * The key of a source image under one set of encoding decisions.
 *
 * Source bytes, not encoded bytes: the whole point is to know the answer before paying for it.
 * `settings` must hold everything that changes the output — the slots the image feeds (they
 * pick the codec), colour space, size cap, quality and overrides — as JSON-stable values.
 */
export function sharedImageKey(
  source: Uint8Array,
  settings: Readonly<Record<string, unknown>>,
): string {
  return createHash("sha256")
    .update(source)
    .update(JSON.stringify(settings), "utf8")
    .digest("hex")
    .slice(0, KEY_LENGTH);
}

/**
 * A store that remembers within one build and, given an output root, across builds.
 *
 * Disk hits are read lazily from `<outputRoot>/shared/images/`; nothing there is ever rewritten,
 * because a content-addressed file that exists is by definition already right.
 */
export function createSharedImageStore(
  outputRoot?: string,
  options: ISharedImageStoreOptions = {},
): ISharedImageStore {
  const memory = new Map<string, ISharedImage>();
  let listing: Promise<Map<string, string>> | undefined;
  let manifestQuality: Promise<Map<string, ITextureQuality>> | undefined;
  const directory =
    outputRoot === undefined ? undefined : path.join(outputRoot, SHARED_IMAGES_DIRECTORY);

  // Compiler-owned observations already publish atomically in its manifest. Reuse that cache
  // rather than adding files to the runtime acquisition set; direct stores use a sidecar.
  const qualityInManifest = (): Promise<Map<string, ITextureQuality>> => {
    manifestQuality ??= (async () => {
      const scores = new Map<string, ITextureQuality>();
      if (outputRoot === undefined) return scores;
      try {
        const manifest = JSON.parse(
          await readFile(path.join(outputRoot, "assets.manifest.json"), "utf8"),
        ) as {
          entries?: Record<string, { sharedImages?: { key?: unknown; quality?: unknown }[] }>;
        };
        for (const entry of Object.values(manifest.entries ?? {})) {
          if (!Array.isArray(entry?.sharedImages)) continue;
          for (const image of entry.sharedImages) {
            const quality = readTextureQuality(image?.quality);
            if (typeof image?.key === "string" && quality !== undefined)
              scores.set(image.key, quality);
          }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError))
          throw error;
      }
      return scores;
    })();
    return manifestQuality;
  };

  const onDisk = (): Promise<Map<string, string>> => {
    listing ??= (async () => {
      const byKey = new Map<string, string>();
      if (directory === undefined) return byKey;
      let names: string[];
      try {
        names = await readdir(directory);
      } catch {
        return byKey;
      }
      for (const name of names) {
        const parsed = parseFileName(name);
        if (parsed !== undefined) byKey.set(parsed.key, name);
      }
      return byKey;
    })();
    return listing;
  };

  return {
    get: async (key) => {
      const remembered = memory.get(key);
      if (remembered !== undefined) return remembered;
      if (directory === undefined) return undefined;
      const name = (await onDisk()).get(key);
      if (name === undefined) return undefined;
      const parsed = parseFileName(name);
      if (parsed === undefined) return undefined;
      const image: ISharedImage = {
        buffer: await readFile(path.join(directory, name)),
        codec: parsed.codec,
        mimeType: parsed.mimeType,
        ...(await (async () => {
          const cached = (await qualityInManifest()).get(key);
          if (cached !== undefined) return { quality: cached };
          try {
            const quality = readTextureQuality(
              JSON.parse(await readFile(path.join(directory, `${name}.quality.json`), "utf8")),
            );
            return quality === undefined ? {} : { quality };
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError)
              return {};
            throw error;
          }
        })()),
      };
      memory.set(key, image);
      return image;
    },
    outputPath: (key, image) => `${SHARED_IMAGES_DIRECTORY}/${fileNameFor(key, image)}`,
    put: async (key, image) => {
      memory.set(key, image);
      if (directory === undefined || options.writeThrough === false) return;
      const name = fileNameFor(key, image);
      const known = await onDisk();
      if (known.has(key) && image.quality === undefined) return;
      await mkdir(directory, { recursive: true });
      // Temp file + rename: a concurrent reader (another worker's get, a parallel build's) must
      // never observe a truncated image, and two writers of identical bytes must not be able to
      // interleave into a torn file. Content-addressed, so the rename is idempotent.
      const target = path.join(directory, name);
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, image.buffer);
        await rename(temporary, target);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
      if (image.quality !== undefined) {
        const qualityTarget = `${target}.quality.json`;
        const qualityTemporary = `${qualityTarget}.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(qualityTemporary, `${JSON.stringify(image.quality)}\n`);
          await rename(qualityTemporary, qualityTarget);
        } finally {
          await rm(qualityTemporary, { force: true }).catch(() => undefined);
        }
      }
      known.set(key, name);
    },
  };
}

/** Relative URL from the directory a model is served from to a shared output path. */
export function sharedImageUri(logicalPath: string, outputPath: string): string {
  const from = path.posix.dirname(logicalPath.split(path.sep).join("/"));
  const relative = path.posix.relative(from === "." ? "" : from, outputPath);
  return relative.startsWith(".") || from === "." ? relative : `./${relative}`;
}

export interface ISharedGlb {
  readonly buffer: Buffer;
  readonly extensionsUsed: readonly string[];
  /** Image uri, as written into the GLB, keyed by the resource bytes' sha256. */
  readonly json: GLTF.IGLTF;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function padded(buffer: Buffer, fill: number): Buffer {
  const remainder = buffer.length % 4;
  return remainder === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(4 - remainder, fill)]);
}

/**
 * Packs a document into a GLB whose images live outside it.
 *
 * glTF-Transform's own GLB writer embeds every image by design, so this writes the document in
 * glTF form, rewrites each image's `uri` to the shared output the caller chose, and packs the one
 * binary buffer as the GLB's BIN chunk itself. Meshopt's fallback buffer stays a declaration, as
 * in any GLB the library writes.
 */
export async function writeSharedGlb(
  io: NodeIO,
  document: Document,
  logicalPath: string,
  uriFor: (imageBytes: Uint8Array) => string,
): Promise<ISharedGlb> {
  const basename = path.posix.basename(
    logicalPath.split(path.sep).join("/"),
    path.extname(logicalPath),
  );
  const written = await io.writeJSON(document, { basename, format: Format.GLTF });
  const json = written.json;
  const resources = written.resources;
  for (const image of json.images ?? []) {
    if (image.uri === undefined) continue;
    const bytes = resources[image.uri];
    if (bytes === undefined) {
      throw new Error(
        `TN_ASSETS_MODEL_WRITE_FAILED: '${logicalPath}' wrote image '${image.uri}' without its bytes.`,
      );
    }
    delete resources[image.uri];
    image.uri = uriFor(bytes);
  }
  const buffers = json.buffers ?? [];
  const external = buffers.filter((buffer) => buffer.uri !== undefined);
  const first = buffers[0];
  if (buffers.length > 0 && (external.length !== 1 || first?.uri === undefined)) {
    throw new Error(
      `TN_ASSETS_MODEL_WRITE_FAILED: '${logicalPath}' must write exactly one binary buffer as buffer 0 to pack as GLB; found ${String(external.length)} external buffer(s).`,
    );
  }
  const bin = first?.uri === undefined ? undefined : resources[first.uri];
  if (first !== undefined && bin === undefined) {
    throw new Error(`TN_ASSETS_MODEL_WRITE_FAILED: '${logicalPath}' wrote no bytes for buffer 0.`);
  }
  if (first?.uri !== undefined) delete resources[first.uri];
  // JSON.stringify drops an undefined member, so the packed buffer 0 has no uri.
  if (first !== undefined) first.uri = undefined;
  const remaining = Object.keys(resources);
  if (remaining.length > 0) {
    throw new Error(
      `TN_ASSETS_MODEL_WRITE_FAILED: '${logicalPath}' left unpacked resources: ${remaining.join(", ")}.`,
    );
  }
  const jsonChunk = padded(Buffer.from(JSON.stringify(json), "utf8"), 0x20);
  const binChunk =
    bin === undefined
      ? undefined
      : padded(Buffer.from(bin.buffer, bin.byteOffset, bin.byteLength), 0x00);
  const header = Buffer.alloc(12);
  const total = 12 + 8 + jsonChunk.length + (binChunk === undefined ? 0 : 8 + binChunk.length);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk?.length ?? 0, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);
  return {
    buffer: Buffer.concat([
      header,
      jsonHeader,
      jsonChunk,
      ...(binChunk === undefined ? [] : [binHeader, binChunk]),
    ]),
    extensionsUsed: json.extensionsUsed ?? [],
    json,
  };
}

/** The JSON chunk and BIN chunk of a GLB, without resolving anything. */
export function unpackGlb(buffer: Buffer): {
  readonly json: GLTF.IGLTF;
  readonly bin: Uint8Array | undefined;
} {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error("TN_ASSETS_MODEL_UNREADABLE: not a GLB container.");
  }
  let offset = 12;
  let json: GLTF.IGLTF | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    const chunk = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(chunk.toString("utf8")) as GLTF.IGLTF;
    else if (type === CHUNK_BIN) bin = chunk;
    offset += 8 + length;
  }
  if (json === undefined) throw new Error("TN_ASSETS_MODEL_UNREADABLE: GLB has no JSON chunk.");
  return { bin, json };
}

/** A copy on a plain ArrayBuffer, which is what the reader's resource map is typed to hold. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Reads a GLB whose images live outside it, resolving each `uri` through the caller.
 *
 * `binaryToJSON` refuses external images by design; this is the reader for the file this
 * module writes, used by the pass to verify its own output.
 */
export async function readSharedGlb(
  io: NodeIO,
  buffer: Buffer,
  resolve: (uri: string) => Promise<Uint8Array>,
): Promise<Document> {
  const { bin, json } = unpackGlb(buffer);
  const resources: Record<string, Uint8Array<ArrayBuffer>> = {};
  const first = json.buffers?.[0];
  if (first !== undefined && first.uri === undefined && bin !== undefined) {
    // glTF-Transform names the GLB buffer this way when it unwraps a container itself.
    first.uri = "@glb.bin";
    resources["@glb.bin"] = owned(bin);
  }
  for (const image of json.images ?? []) {
    if (image.uri !== undefined && resources[image.uri] === undefined) {
      resources[image.uri] = owned(await resolve(image.uri));
    }
  }
  return io.readJSON({ json, resources });
}
