/**
 * The node-side file store for registered assets. Server only: it reads and writes the project's
 * files, which is why it is not part of the browser-safe asset validators in `assets.ts`.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import {
  DEFAULT_ASSET_LIMITS,
  FOLDER,
  type IAssetKind,
  type IAssetLimits,
  ID,
  type IProjectAsset,
  PATH,
  inspectGlb,
  sniff,
  validateAsset,
} from "./assets.js";
import { inspectImage } from "./images.js";

/**
 * Where registered files live. The directory is configured by the project and every stored file
 * name carries its own content hash, so a replaced file can never be served from a stale cache.
 */
export class AssetStore {
  readonly dir: string;
  readonly limits: IAssetLimits;
  constructor(dir: string, limits: Partial<IAssetLimits> = {}) {
    if (!isAbsolute(dir)) throw new Error("Assets directory must be absolute");
    this.dir = resolve(dir);
    this.limits = { ...DEFAULT_ASSET_LIMITS, ...limits };
  }
  /** Read a local source file for registration: a regular file, never a link, within the limit. */
  readSource(path: string): Uint8Array {
    if (!isAbsolute(path)) throw new Error("Asset path must be absolute");
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Asset path must be a regular file");
    if (info.size > this.limits.maxBytes)
      throw new Error(
        `Asset is ${info.size} bytes; this project's limit is ${this.limits.maxBytes}`,
      );
    const descriptor = openSync(path, "r");
    try {
      const bytes = new Uint8Array(fstatSync(descriptor).size);
      let read = 0;
      while (read < bytes.length) {
        const count = readSync(descriptor, bytes, read, bytes.length - read, read);
        if (!count) break;
        read += count;
      }
      return bytes;
    } finally {
      closeSync(descriptor);
    }
  }
  /** The bytes of one stored file, addressed only by a path an entry carries. */
  read(path: string): Buffer {
    if (!PATH.test(path)) throw new Error("Unknown asset file");
    return readFileSync(join(this.dir, path));
  }
  /** Measure, hash and store one file; the returned entry is what the document saves. */
  store(
    id: string,
    name: string,
    bytes: Uint8Array,
    extra: { license?: string; source?: string; kind?: IAssetKind },
  ): IProjectAsset {
    if (!ID.test(id)) throw new Error(`Asset id '${id}' must be lowercase letters, digits, - or _`);
    if (bytes.byteLength > this.limits.maxBytes)
      throw new Error(
        `Asset is ${bytes.byteLength} bytes; this project's limit is ${this.limits.maxBytes}`,
      );
    const kind = sniff(bytes);
    if (!kind)
      throw new Error(`'${name}' is not a supported GLB, PNG, JPEG, WebP, HDR or EXR file`);
    if (extra.kind && extra.kind !== kind.kind)
      throw new Error(`'${name}' is a ${kind.kind} file, not a ${extra.kind}`);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const measured = kind.kind === "model" ? inspectGlb(bytes, this.limits) : undefined;
    const picture =
      kind.kind === "model" ? undefined : inspectImage(bytes, kind.format, this.limits);
    const path = `${FOLDER[kind.kind]}/${sha256.slice(0, 12)}-${id}.${kind.ext}`;
    mkdirSync(join(this.dir, FOLDER[kind.kind]), { recursive: true });
    const target = join(this.dir, path);
    const temporary = `${target}.${process.pid}.tmp`;
    // Content-addressed: the same bytes under the same id are already stored, never rewritten.
    try {
      lstatSync(target);
    } catch {
      writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
      renameSync(temporary, target);
    }
    return validateAsset({
      id,
      kind: kind.kind,
      name: name.slice(0, 128),
      path,
      sha256,
      bytes: bytes.byteLength,
      status: "ready",
      ...(extra.license ? { license: extra.license } : {}),
      ...(extra.source ? { source: extra.source } : {}),
      ...(measured
        ? {
            bounds: measured.bounds,
            triangles: measured.triangles,
            ...(measured.diagnostics.length ? { diagnostics: measured.diagnostics } : {}),
            adjust: { scale: 1, pivot: "base" },
          }
        : {}),
      ...(picture
        ? {
            width: picture.width,
            height: picture.height,
            format: picture.format,
            ...(picture.diagnostics.length ? { diagnostics: picture.diagnostics } : {}),
          }
        : {}),
    });
  }
}
