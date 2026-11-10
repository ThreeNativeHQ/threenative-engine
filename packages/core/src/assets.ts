import {
  type AnimationClip,
  type AudioLoader,
  type Bone,
  BufferAttribute,
  type BufferGeometry,
  Mesh,
  NoColorSpace,
  Object3D,
  RGBA_ASTC_4x4_Format,
  SRGBColorSpace,
  Texture,
  type TextureLoader,
  type Wrapping,
} from "three";
import {
  type AssetPriority,
  type IAssetCacheReport,
  PRIORITY_ORDER,
  canonicalUrl,
  createAssetCache,
} from "./asset-cache.js";
import { type AssetMemo, createAssetMemo } from "./asset-memo.js";
import { TN_VIRTUAL_GEOMETRY, VirtualGeometryPlugin } from "./clustered-mesh.js";
import { GEOMETRY_ASSET_KEY } from "./geometry-capture.js";
import { attachInstancedLod } from "./instanced-batch-lod.js";
import {
  DiscreteLodPlugin,
  type IModelLodPolicy,
  TN_DISCRETE_LOD,
  markStreamedGeometry,
  upgradeStreamedGeometry,
} from "./model-lod.js";
import { countDebug, debugRequested, measureDebug } from "./profiling/debug-telemetry.js";
import { streamedTextureUpgrade } from "./streamed-textures.js";
import { openKtx2Stream } from "./texture-streaming.js";

export interface IAssetLoaderOptions {
  readonly basePath?: string;
  /**
   * URL of the manifest written by the asset compile step (`public/assets.manifest.json`).
   * Defaults to `assets.manifest.json` resolved against `basePath`. A logical path is resolved
   * to its compiled output through it; a manifest that is absent — 404 or unfetchable — falls
   * back to loading every path verbatim, while one that is served malformed or with an unknown
   * version throws.
   */
  readonly manifest?: string;
  /**
   * Directory the game's uncompiled assets live in, relative to `basePath`.
   *
   * Only consulted when there is no manifest, and only after the verbatim path has been tried. It
   * is what makes the delete-test possible: remove everything the asset pipeline produced and the
   * game still finds `assets/rock.png` where the author put it, just slower and uncompressed.
   * Defaults to the compile step's own default source directory.
   */
  readonly sourcePath?: string;
  readonly model?: (url: string) => Promise<unknown>;
  readonly texture?: (url: string) => Promise<Texture>;
  readonly audio?: (url: string) => Promise<AudioBuffer>;
  /**
   * The live renderer (`IRendererLike.raw`), handed to `KTX2Loader.detectSupport()` exactly
   * once so compiled KTX2 textures transcode to a format this machine's GPU actually supports.
   * Required for games whose textures compile to `.ktx2`; without it such a load throws rather
   * than silently uploading decoded RGBA.
   */
  readonly renderer?: unknown;
  /**
   * Keep compiled asset bytes on disk between visits. On by default where the Cache API exists;
   * `false` is the named override. A native host has no Cache API and reports the cache off with
   * the reason "native host reads installed files", so the native load path is unchanged.
   */
  readonly cache?: boolean;
  /**
   * Download the rest of the manifest after the reveal, at idle priority. On by default;
   * `false` is the named override. It stops by itself when the browser reports
   * `navigator.connection.saveData`.
   */
  readonly backgroundFill?: boolean;
  /**
   * Draw a model's coarse companion first, where the cook wrote one, and the full model when it
   * lands (PRD-860). On by default; `false` is the named override, reported once as
   * `TN_ASSETS_STREAM_MESHES_OFF`.
   */
  readonly streamMeshes?: boolean;
  /**
   * Draw a streamed model's KTX2 textures with their resident mips first, and the whole files when
   * they land (PRD-860). On by default; `false` is the named override, reported once as
   * `TN_ASSETS_STREAM_TEXTURES_OFF`. It rides on `streamMeshes`: the coarse parse is where the
   * resident mips draw.
   */
  readonly streamTextures?: boolean;
}

/**
 * A streamed model's images for one parse: whether any drew from its resident mips only (`used`),
 * and the KTX2 files a host with no `Range` sent whole, handed on to the full parse (`keptOnly`).
 */
interface IResidentImages {
  used: boolean;
  readonly whole: Map<string, Uint8Array>;
  readonly keptOnly?: boolean;
}

/** What one request is worth relative to the rest of the loader's queue. */
/**
 * Report marker for a file a scene asks for after the reveal that the game had not prefetched.
 *
 * The reveal is the first moment the player is playing, so the download such a request starts is
 * time spent looking at a world without that file in it — the pop-in a streaming game exists to
 * avoid. One line per file, carrying the bytes and how far into play the request landed, so a
 * playtest can count the pop-ins instead of a person having to watch for them.
 *
 * A file the game asked `prefetch` for first is not late: that is a deliberate stream, and the
 * engine's own background fill is no promise either — it lags the link by design.
 */
export const ASSET_LATE_MARKER = "TN_ASSET_LATE";

export interface IAssetRequestOptions {
  /**
   * `now` for a file the running scene awaits, `soon` for a prefetch. The loader's own direct
   * calls default to `now`.
   */
  readonly priority?: AssetPriority;
  /**
   * PRD-860: `true` resolves a model only once its full file has replaced the coarse companion the
   * first scene draws (the same object, upgraded in place). For a caller that copies the vertices:
   * a trimesh or convex-hull collider, a navmesh bake, a geometry merge. Default: the coarse model,
   * so the scene plays before the download ends.
   */
  readonly whole?: boolean;
}

/** What a `prefetch` asked for and what the download produced. */
export interface IAssetPrefetchProgress {
  readonly requested: number;
  readonly requestedBytes: number;
  readonly settled: number;
  /** Bytes served by the load, from disk or network; not a claim that the disk kept them. */
  readonly settledBytes: number;
}

/** The cache report plus the one action a settings screen needs. */
export interface IAssetCacheState extends IAssetCacheReport {
  /** Delete every byte this release stored, for a "free 1.8 GB" button. */
  clear(): Promise<void>;
}

/** The structural slice of three's `KTX2Loader` core depends on. */
export interface IKTX2LoaderLike {
  detectSupport(renderer: unknown): unknown;
  load(
    url: string,
    onLoad: (texture: Texture) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (error: unknown) => void,
  ): unknown;
  setTranscoderPath(path: string): unknown;
}

/**
 * Present only when a renderer was handed to the asset loader. `ready` settles once support
 * detection ran; it rejects naming the renderer and platform when no compressed format is
 * supported, and `defineGame` awaits it during boot so such a target fails at construction.
 */
export interface ICompressedTextureSupport {
  /**
   * The one shared instance, also handed to `GLTFLoader.setKTX2Loader()` for models. Resolves
   * `undefined` when the renderer exposed no surface to probe (see `createKtx2Loader`).
   */
  readonly loader: Promise<IKTX2LoaderLike | undefined>;
  readonly ready: Promise<void>;
}

/** Which pipeline served a logical path: the compile step's manifest, or the project's own files. */
export type AssetSource = "manifest" | "source";

/** Where one settled load's bytes actually came from. */
/** One downloaded file of a load, with the size the manifest records for it. */
export interface IResolvedFile {
  readonly bytes: number;
  readonly url: string;
}

export interface IResolvedAsset {
  /**
   * The manifest's size for this path, set once the load settled and the manifest named one.
   * Absent for a game with no manifest, an external url, or an entry the compile step wrote
   * without a size, so absent means unknown and never zero.
   */
  readonly bytes?: number;
  /**
   * Every sized file the load downloaded: its own output first, then the shared images and
   * lightmaps the manifest lists for it. Set with `bytes`. Two models that share an image list
   * the same url, so a byte total dedupes by url.
   */
  readonly files?: readonly IResolvedFile[];
  /** What the load was asked for; set once the load settled. */
  readonly kind?: AssetKind;
  readonly url: string;
  readonly via: AssetSource;
}

export interface ITextureOptions {
  /**
   * The pixels are data, not colour: a normal map, a roughness map, a mask. Data textures are
   * sampled without a colour-space conversion, which is wrong for an albedo and right for these.
   * Left out, the copy is sRGB — the space an image file is authored in. A loader leaves a plain
   * image linear, which washes out every albedo, so an options call never inherits that.
   */
  readonly data?: boolean;
  // A normal or roughness map asking only for `wrap` still passes `data: true`: options always pick
  // the space. The configured copy is outside the cache, so `release` cannot reclaim it — dispose it
  // with the material that uses it.
  /** Both axes at once. Absent leaves the loaded texture's own wrapping. */
  readonly wrap?: Wrapping;
  /** Tiling counts, one for both axes or one per axis. Absent leaves the loaded texture's own. */
  readonly repeat?: number | readonly [number, number];
  /** Samples to take at grazing angles. Absent leaves the loaded texture's own. */
  readonly anisotropy?: number;
}

/** What `texture(path, options)` hands back: the cached instance untouched, or a configured copy. */
function configuredTexture(texture: Texture, options: ITextureOptions): Texture {
  const copy = texture.clone();
  copy.colorSpace = options.data === true ? NoColorSpace : SRGBColorSpace;
  if (options.wrap !== undefined) copy.wrapS = copy.wrapT = options.wrap;
  const { repeat } = options;
  if (typeof repeat === "number") copy.repeat.setScalar(repeat);
  else if (repeat !== undefined) copy.repeat.set(repeat[0], repeat[1]);
  if (options.anisotropy !== undefined) copy.anisotropy = options.anisotropy;
  return copy;
}

export interface IAssetLoader {
  readonly compressedTextures?: ICompressedTextureSupport;
  model<T = unknown>(path: string, options?: IAssetRequestOptions): Promise<T>;
  /**
   * Load a texture, optionally configured in one call.
   *
   * @situation set color space, wrap, repeat or anisotropy on a loaded texture
   *
   * With no options this is the shared cached instance, exactly as before. With options it is a
   * copy of it: the cached texture is shared by every other caller of that path, and a wrap or a
   * colour-space write on it would silently change how another material draws.
   */
  texture(path: string, options?: ITextureOptions): Promise<Texture>;
  audio(path: string): Promise<AudioBuffer>;
  release(kind: "audio" | "model" | "texture", path: string): boolean;
  /**
   * Where a logical path is served from, in the order worth trying — the manifest's
   * content-addressed output when a manifest exists, otherwise the verbatim and source paths.
   * For loaders this surface does not wrap (an HDR sky, a font, a data file) — a game must never
   * hard-code a hashed output name, which changes on every rebuild.
   */
  resolve(path: string): Promise<readonly string[]>;
  /**
   * What is on disk right now: hits, misses, bytes stored and the whole release's size. A loading
   * view can show "1.2 of 2.0 GB on disk" without new code, and `enabled` is false with a `reason`
   * on a native host or when the game passed `assets.cache: false`.
   */
  readonly cache: IAssetCacheState;
  /**
   * Download the next scene's files to disk at `soon` priority, so its `load()` reads them back
   * without a cold fetch. Stores bytes only: no decode, no GPU memory. Resolves at once on native,
   * where the files are already installed, and reports how many bytes the request served.
   */
  prefetch(paths: readonly string[]): Promise<IAssetPrefetchProgress>;
  /**
   * Start the post-reveal idle fill. The engine calls this when `ctx.startup.whenReady()` settles;
   * a game that drives a loader outside `defineGame` may call it after its own reveal.
   *
   * It is also where the reveal is marked for {@link ASSET_LATE_MARKER}: a whole-file load a scene
   * asks for after this call, and that the game did not `prefetch`, is reported as the pop-in it is.
   * A game that never calls it never gets the report.
   */
  startBackgroundFill(): Promise<void>;
  /**
   * Generated content kept between runs (PRD-860): returns what `build` returned the last time this
   * build of the game ran, read from disk, and calls `build` only when nothing is stored. Use it for
   * seeded work that is the same every run, such as placement lists, painted sky pixels or terrain
   * heights. The value is named typed arrays. A new build regenerates. On the dev server and on a
   * native host `build` runs every time, and `TN_ASSET_MEMO` says why.
   *
   * @example const { pixels } = await ctx.assets.memo("sky", () => ({ pixels: paintSky() }));
   */
  memo: AssetMemo;
  /**
   * How many loads this loader has been asked for and how many have settled (resolved or
   * rejected). A loading view reads the ratio; the runtime folds it into `ctx.startup.progress`
   * while the start scene loads, so the bar moves with the bytes instead of jumping 0 to 1.
   *
   * `requestedBytes` and `settledBytes` are the same ledger weighed by the `bytes` the compile
   * step already records for every manifest entry, and they are what a loading bar should read.
   * A file count treats a 710 MB model and a 4 KB icon alike: one real game's bar reached 92%
   * on eleven small assets and then stood still for the entire download of the twelfth. Both
   * stay 0 for a game with no manifest, where no size is knowable before the bytes arrive.
   */
  readonly progress: {
    /**
     * The logical paths asked for and not yet settled, in request order. A loading screen that
     * only shows a ratio cannot say *what* it is waiting for, which is the difference between
     * "still loading" and "stuck on `akagi.glb`" — and a stall report that names nothing is a
     * bug report nobody can act on.
     */
    readonly pending: readonly string[];
    readonly requested: number;
    readonly requestedBytes: number;
    readonly settled: number;
    readonly settledBytes: number;
  };
  /**
   * Where each settled load was actually served from, keyed by the logical path asked for.
   *
   * `progress` counts loads and cannot say which of a path's candidate urls answered, so a game
   * whose manifest 404s and a game whose manifest named the output look identical from the game's
   * own side — which is how an unreadable manifest became a silent uncompiled fallback on the
   * native hosts, where a failed read arrives as a rejected fetch rather than a 404. `via` is
   * `"manifest"` only for the compiled output the manifest named; `"source"` is the verbatim or
   * source-directory path, and an external url, which no manifest governs.
   */
  readonly resolved: ReadonlyMap<string, IResolvedAsset>;
  clear(): void;
  /**
   * Final release, called by the game's teardown. Frees the decoder worker pools this loader
   * owns; `clear()` stays reusable because a live game may empty its cache between levels.
   * Idempotent.
   */
  dispose(): void;
}

/**
 * The manifest the asset compile step writes, read structurally: core needs only `version` and
 * each entry's `output`, and must not depend on the build-time package for the rest.
 */
interface IAssetManifest {
  readonly entries: Readonly<Record<string, unknown>>;
  readonly version: number;
}

interface ICompiledLightmap {
  readonly materialTargets: readonly string[];
  readonly output: string;
  readonly texCoord: number;
}

const MANIFEST_VERSION = 1;
const ASTC_FORMAT = "astc4x4";

function entryUsesKtx2(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (typeof entry.output === "string" && /\.ktx2$/iu.test(entry.output)) return true;
  if (
    Array.isArray(entry.extensions) &&
    entry.extensions.some(
      (extension) => extension === "KHR_texture_basisu" || extension === "EXT_texture_astc",
    )
  )
    return true;
  const embeddedTextures = entry.embeddedTextures;
  if (
    isRecord(embeddedTextures) &&
    isRecord(embeddedTextures.formats) &&
    Object.values(embeddedTextures.formats).some(
      (format) => typeof format === "string" && format !== "none",
    )
  )
    return true;
  return [entry.lightmaps, entry.sharedImages].some(
    (outputs) =>
      Array.isArray(outputs) &&
      outputs.some(
        (item) =>
          isRecord(item) && typeof item.output === "string" && /\.ktx2$/iu.test(item.output),
      ),
  );
}

interface IManifestAstcAsset {
  readonly logicalPath: string;
  readonly output: string;
}

function manifestOutput(entry: Record<string, unknown>, fallback: string): string {
  return typeof entry.output === "string" ? entry.output : fallback;
}

function firstRawAstcAsset(logicalPath: string, entry: unknown): IManifestAstcAsset | undefined {
  if (!isRecord(entry)) return undefined;
  const output = manifestOutput(entry, logicalPath);
  if (entry.format === ASTC_FORMAT) return { logicalPath, output };
  if (Array.isArray(entry.lightmaps)) {
    const lightmap = entry.lightmaps.find((item) => isRecord(item) && item.format === ASTC_FORMAT);
    if (isRecord(lightmap)) return { logicalPath, output: manifestOutput(lightmap, output) };
  }
  if (Array.isArray(entry.sharedImages)) {
    const sharedImage = entry.sharedImages.find(
      (item) => isRecord(item) && item.codec === ASTC_FORMAT,
    );
    if (isRecord(sharedImage)) return { logicalPath, output: manifestOutput(sharedImage, output) };
  }
  const embeddedTextures = entry.embeddedTextures;
  if (
    isRecord(embeddedTextures) &&
    isRecord(embeddedTextures.formats) &&
    Object.values(embeddedTextures.formats).some((format) => format === ASTC_FORMAT)
  )
    return { logicalPath, output };
  return undefined;
}

function firstRawAstcManifestAsset(
  manifest: IAssetManifest | undefined,
): IManifestAstcAsset | undefined {
  for (const [logicalPath, entry] of Object.entries(manifest?.entries ?? {})) {
    const asset = firstRawAstcAsset(logicalPath, entry);
    if (asset !== undefined) return asset;
  }
  return undefined;
}

function compiledLightmaps(entry: unknown, logicalPath: string): readonly ICompiledLightmap[] {
  if (!isRecord(entry) || entry.lightmaps === undefined) return [];
  if (!Array.isArray(entry.lightmaps)) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_MANIFEST_INVALID: '${logicalPath}' lightmaps must be an array.`,
    );
  }
  return entry.lightmaps.map((lightmap, index) => {
    if (
      !isRecord(lightmap) ||
      typeof lightmap.output !== "string" ||
      lightmap.texCoord !== 1 ||
      !Array.isArray(lightmap.materialTargets) ||
      !lightmap.materialTargets.every((target) => typeof target === "string")
    ) {
      throw new Error(
        `TN_ASSETS_LIGHTMAP_MANIFEST_INVALID: '${logicalPath}' lightmaps[${String(index)}] must name output, texCoord 1, and string materialTargets.`,
      );
    }
    return {
      materialTargets: lightmap.materialTargets,
      output: lightmap.output,
      texCoord: lightmap.texCoord,
    };
  });
}

function isExternalAssetPath(path: string): boolean {
  return /^(?:[a-z]+:)?\/\//iu.test(path) || path.startsWith("data:");
}

function resolvePath(basePath: string, path: string): string {
  if (isExternalAssetPath(path)) return path;
  if (basePath.length === 0) return path;
  return `${basePath.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
}

/**
 * Reads the compile step's manifest. A 404 — or a url that cannot be fetched at all, which is
 * how "no manifest" presents in bare-node tests and on hosts without a web root — is the
 * documented no-manifest case and resolves to `undefined`. Anything that *is* served must be a
 * valid version-1 manifest; anything else throws.
 */
async function readManifest(url: string): Promise<IAssetManifest | undefined> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch {
    return undefined;
  }
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`Failed to load asset manifest '${url}': ${response.status}.`);
  // SPA dev servers commonly return the app shell with status 200 for an unknown asset path.
  // That response is the same as a missing manifest, not a malformed manifest supplied by the
  // asset pipeline.
  if (response.headers.get("content-type")?.toLowerCase().includes("text/html") === true)
    return undefined;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new Error(`Asset manifest '${url}' does not contain valid JSON.`);
  }
  if (!isRecord(parsed) || parsed.version !== MANIFEST_VERSION || !isRecord(parsed.entries)) {
    throw new Error(
      `Asset manifest '${url}' must be version ${MANIFEST_VERSION} with an 'entries' object.`,
    );
  }
  // An asset-free build still serves an empty manifest (so nothing 404s); it lists nothing, so it
  // must not become authoritative over files a project serves verbatim from `public/`.
  if (Object.keys(parsed.entries).length === 0) return undefined;
  return parsed as unknown as IAssetManifest;
}

type LoaderLike<T> = {
  load: (
    url: string,
    onLoad: (value: T) => void,
    onProgress?: (event: ProgressEvent<EventTarget>) => void,
    onError?: (error: unknown) => void,
  ) => unknown;
};

type AssetKind = "audio" | "model" | "texture";

interface IAssetEntry {
  disposed: boolean;
  kind: AssetKind;
  loaded: boolean;
  promise: Promise<unknown>;
  released: boolean;
  /** The most urgent priority any caller asked for; the download starts at it. */
  priority: AssetPriority;
  /** The candidate url the load is downloading, so a later, more urgent caller can promote it. */
  url?: string;
  value?: unknown;
}

/** The candidate urls for a logical path, and the pipeline that produced them. */
interface ICandidateUrls {
  readonly urls: readonly string[];
  readonly via: AssetSource;
}

interface IDisposableResource {
  dispose(): void;
}

interface IResourceDisposalSets {
  geometries: WeakSet<object>;
  surfaces: WeakSet<object>;
  textures: WeakSet<object>;
}

function loadWith<T>(loader: LoaderLike<T>, url: string): Promise<T> {
  return new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));
}

/**
 * Extensions whose presence in a model's `extensionsUsed`/`extensionsRequired` triggers lazy
 * decoder wiring. Read off the fetched bytes rather than out of the compile step's manifest
 * so uncompiled paths and compiled outputs take exactly one code path.
 */
const MESHOPT_EXTENSIONS: readonly string[] = [
  "EXT_meshopt_compression",
  "KHR_meshopt_compression",
];
const DRACO_EXTENSION = "KHR_draco_mesh_compression";

/**
 * Reads `extensionsUsed`/`extensionsRequired` from a `.glb` or `.gltf` payload without full
 * parsing. Malformed input yields an empty set here; GLTFLoader itself fails on it with its
 * own error moments later.
 */
function declaredExtensions(data: ArrayBuffer): ReadonlySet<string> {
  try {
    const bytes = new Uint8Array(data);
    const magic = String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0, bytes[2] ?? 0, bytes[3] ?? 0);
    const json =
      magic === "glTF"
        ? JSON.parse(
            new TextDecoder().decode(
              bytes.subarray(20, 20 + new DataView(data).getUint32(12, true)),
            ),
          )
        : JSON.parse(new TextDecoder().decode(bytes));
    return new Set([
      ...(typeof json.extensionsUsed === "object" && Array.isArray(json.extensionsUsed)
        ? (json.extensionsUsed as string[])
        : []),
      ...(typeof json.extensionsRequired === "object" && Array.isArray(json.extensionsRequired)
        ? (json.extensionsRequired as string[])
        : []),
    ]);
  } catch {
    return new Set();
  }
}

async function fetchModelBytes(
  url: string,
  cache: ReturnType<typeof createAssetCache>,
  expectedBytes: number | undefined,
  priority: AssetPriority,
): Promise<ArrayBuffer> {
  try {
    return await cache.fetchBytes(url, priority, expectedBytes);
  } catch (error) {
    throw new Error(
      `Failed to load model '${url}': ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
}

/**
 * Loads a texture with its pixels already decoded, off the main thread.
 *
 * `TextureLoader` hands the bytes to an `<img>`, whose `onload` fires before the pixels exist:
 * `await ctx.assets.texture()` therefore resolves early and the decode lands later, on the main
 * thread, at the first GPU upload — after the loading screen has lifted, in the middle of play.
 * Measured over 16 real game textures (38 MB, 126 MB decoded), the decode is 397 ms through
 * `<img>` and 153 ms through `createImageBitmap`. three's own `GLTFLoader` already prefers
 * `ImageBitmapLoader` for a model's embedded textures, so before this the same file decoded
 * off-thread inside a model and on the main thread when a game loaded it directly.
 *
 * **Orientation is the trap.** `TextureLoader` leaves `flipY` true and the backend flips at
 * upload, which is the orientation every existing game is authored against. WebGPU can flip an
 * `ImageBitmap` at copy time and does, so that branch keeps `flipY` and asks for the natural
 * orientation — which is also what the native host has always done. WebGL2 cannot flip an
 * `ImageBitmap` at all and silently ignores `flipY`, so that branch asks the browser to decode
 * it flipped instead. Both land on the pixels `TextureLoader` would have produced; getting this
 * wrong turns every standalone texture upside down with no error anywhere.
 */
async function loadBitmapTexture(
  url: string,
  renderer: unknown,
  cache: ReturnType<typeof createAssetCache>,
  expectedBytes: number | undefined,
  priority: AssetPriority,
): Promise<Texture> {
  let data: ArrayBuffer;
  try {
    data = await cache.fetchBytes(url, priority, expectedBytes);
  } catch (error) {
    throw new Error(
      `Failed to load texture '${url}': ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  const blob = new Blob([data]);
  // No renderer means the native host or a bare-node load, both of which flip at upload.
  const flipsAtUpload =
    renderer === undefined ||
    (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
  const debug = debugRequested();
  const start = debug ? performanceNow() : 0;
  const pending = flipsAtUpload
    ? createImageBitmap(blob)
    : createImageBitmap(blob, { imageOrientation: "flipY" });
  if (debug) {
    const elapsed = performanceNow() - start;
    countDebug("textureDecodeDispatchMs", elapsed, "loading", "loadBitmapTexture (all URLs)", "ms");
    countDebug(`textureDecode.${url}DispatchMs`, elapsed, "loading", url, "ms");
  }
  const bitmap = await pending;
  if (debug) {
    const caller = "loadBitmapTexture (all URLs)";
    const elapsed = performanceNow() - start;
    countDebug("textureDecodes", 1, "loading", caller);
    countDebug("textureDecodeBytes", data.byteLength, "loading", caller, "bytes");
    countDebug("textureDecodeWallMs", elapsed, "loading", caller, "async-ms");
    countDebug(`textureDecode.${url}WallMs`, elapsed, "loading", url, "async-ms");
  }
  const texture = new Texture(bitmap);
  texture.flipY = flipsAtUpload;
  texture.needsUpdate = true;
  return texture;
}

/** True when the caller asked for per-asset timing; read once per settle, not per frame. */
function assetTraceEnabled(): boolean {
  // quality-allow: the playtest runner sets this global by its exact name.
  // biome-ignore lint/style/useNamingConvention: a global the playtest runner sets by this exact name.
  return (globalThis as { __TN_ASSET_TRACE__?: unknown }).__TN_ASSET_TRACE__ === true;
}

function performanceNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function resourcePathOf(url: string): string {
  const slash = url.lastIndexOf("/");
  return slash === -1 ? "" : url.slice(0, slash + 1);
}

function platformName(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  return nav?.userAgent ?? "unknown platform";
}

function attachLightmap(value: unknown, specification: ICompiledLightmap, texture: Texture): void {
  const targets = new Set(specification.materialTargets);
  let assignments = 0;
  for (const root of modelRoots(value)) {
    root.traverse((object) => {
      const renderable = object as Object3D & {
        geometry?: { getAttribute(name: string): unknown };
        material?: unknown;
      };
      const materials = Array.isArray(renderable.material)
        ? renderable.material
        : [renderable.material];
      for (const material of materials) {
        if (!isRecord(material) || !targets.has(String(material.name ?? ""))) continue;
        if (
          renderable.geometry?.getAttribute(`uv${String(specification.texCoord)}`) === undefined
        ) {
          throw new Error(
            `TN_ASSETS_LIGHTMAP_UV2_MISSING: material '${String(material.name ?? "")}' has no TEXCOORD_1 geometry.`,
          );
        }
        material.lightMap = texture;
        material.needsUpdate = true;
        assignments += 1;
      }
    });
  }
  if (assignments === 0) {
    throw new Error(
      `TN_ASSETS_LIGHTMAP_TARGET_MISSING: no loaded material matches ${JSON.stringify(specification.materialTargets)}.`,
    );
  }
}

/**
 * Builds the one shared `KTX2Loader`: transcoder served from the compile step's copy under
 * `<basePath>basis/`, support detected against the real renderer exactly once. Resolves
 * `undefined` when the renderer cannot be probed at all — neither a WebGPU feature surface
 * nor WebGL extensions, which is what minimal stubs and exotic backends look like. A
 * renderer that probes fine but supports no compressed format rejects: three's own loader
 * would silently fall back to an uncompressed RGBA32 upload, which is precisely the 16 MB
 * this exists to prevent, so the failure happens here, naming the renderer and platform.
 */
function transcoderWorkers(): number {
  const cores = (globalThis.navigator as { hardwareConcurrency?: number } | undefined)
    ?.hardwareConcurrency;
  return typeof cores === "number" && cores > 0 ? Math.max(2, Math.min(8, cores - 2)) : 4;
}

export async function createKtx2Loader(options: {
  basePath?: string;
  renderer: unknown;
}): Promise<IKTX2LoaderLike | undefined> {
  const { KTX2Loader } = await import("three/addons/loaders/KTX2Loader.js");
  const loader = new KTX2Loader();
  loader.setTranscoderPath(resolvePath(options.basePath ?? "", "basis/"));
  // three's default is 4 transcoder workers; a streamed world decodes hundreds of textures while
  // it moves, so use the machine's cores (leaving two for the main thread and the compositor).
  loader.setWorkerLimit(transcoderWorkers());
  let config: Record<string, boolean> | undefined;
  try {
    // The structural contract is what matters; three's own parameter type is narrower than
    // every renderer-shaped object core accepts (including platform sources and test stubs).
    loader.detectSupport(options.renderer as Parameters<typeof loader.detectSupport>[0]);
    config = (loader as unknown as { workerConfig?: Record<string, boolean> }).workerConfig;
  } catch {
    return undefined;
  }
  const supported = config === undefined ? [] : Object.values(config).filter(Boolean);
  if (supported.length === 0) {
    const kind =
      (options.renderer as { isWebGPURenderer?: boolean } | undefined)?.isWebGPURenderer === true
        ? "webgpu"
        : "webgl2";
    throw new Error(
      `TN_ASSETS_KTX2_UNSUPPORTED: the ${kind} renderer on ${platformName()} supports no compressed texture format; compiled KTX2 textures cannot be transcoded here.`,
    );
  }
  return loader as unknown as IKTX2LoaderLike;
}

function hasAstcSupport(loader: IKTX2LoaderLike | undefined): boolean {
  return (
    (loader as (IKTX2LoaderLike & { workerConfig?: { astcSupported?: boolean } }) | undefined)
      ?.workerConfig?.astcSupported === true
  );
}

function astcUnsupported(asset: IManifestAstcAsset): Error {
  return new Error(
    `TN_ASSETS_ASTC_UNSUPPORTED: '${asset.logicalPath}' uses raw ASTC 4x4 output '${asset.output}', but the renderer lacks ASTC texture-compression support.`,
  );
}

async function prepareCompressedTextures(
  manifest: IAssetManifest | undefined,
  loader: Promise<IKTX2LoaderLike | undefined>,
): Promise<void> {
  const astcAsset = firstRawAstcManifestAsset(manifest);
  if (astcAsset !== undefined) {
    try {
      const shared = await loader;
      if (!hasAstcSupport(shared)) throw astcUnsupported(astcAsset);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TN_ASSETS_KTX2_UNSUPPORTED:")) {
        throw astcUnsupported(astcAsset);
      }
      throw error;
    }
    return;
  }
  if (Object.values(manifest?.entries ?? {}).some(entryUsesKtx2)) await loader;
}

/**
 * Widen every quantized `POSITION` a loaded model carries back to float32.
 *
 * The asset pipeline emits `KHR_mesh_quantization`, so positions arrive as *normalized* int16:
 * each component encodes a value in [-1, 1] and the real metre scale lives on the node (or, for a
 * skinned mesh, in the inverse bind matrices). That is a correct glTF file and three renders it
 * correctly — but it is a landmine for the game, because three's own geometry helpers write back
 * through `BufferAttribute.setXYZ`, which **re-normalizes and clamps to +/-1**. `applyMatrix4`,
 * `translate`, `scale`, `rotateX/Y/Z`, `center` and `toNonIndexed` all take that path. A game that
 * bakes a node transform into an imported prop — the most ordinary thing there is to do with one —
 * gets every vertex past 1 unit slammed onto the faces of the unit cube, with no error, no warning
 * and a perfectly valid draw of ruined geometry. Wildwood lost 99.7% of a pine's canopy that way.
 *
 * Widening costs 2 bytes per component in RAM and changes nothing on screen: the values written are
 * exactly what `getX/getY/getZ` already returned. The wire payload keeps the pipeline's win.
 *
 * Meshopt-compressed models decode to `InterleavedBufferAttribute`, which is not a `BufferAttribute`
 * at all — an `instanceof BufferAttribute` guard here silently skips every compressed model, which
 * is most of them. Read through the attribute interface both types share instead.
 */
function widenQuantizedPositions(root: Object3D): void {
  const widened = new Set<BufferGeometry>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    if (widened.has(geometry)) return;
    const position = geometry.getAttribute("position");
    if (position === undefined) return;
    const plain = position instanceof BufferAttribute;
    if (plain && !position.normalized && position.array instanceof Float32Array) return;
    const values = new Float32Array(position.count * 3);
    for (let index = 0; index < position.count; index += 1) {
      values[index * 3] = position.getX(index);
      values[index * 3 + 1] = position.getY(index);
      values[index * 3 + 2] = position.getZ(index);
    }
    geometry.setAttribute("position", new BufferAttribute(values, 3));
    widened.add(geometry);
  });
}

/**
 * Widens every normalized one-component integer attribute to float. three picks a one-component
 * WebGPU vertex format from the array type alone and ignores `normalized`, so a cooked scalar in
 * [0, 1] — a baked wind weight, say — reaches the pipeline as `uint16` where a TSL float attribute
 * expects a float, and the pipeline fails to build. Same values, read through `getX`, so a meshopt
 * interleaved attribute widens too.
 */
function widenNormalizedScalars(root: Object3D): void {
  const widened = new Set<BufferGeometry>();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry as BufferGeometry;
    if (widened.has(geometry)) return;
    widened.add(geometry);
    for (const [name, attribute] of Object.entries(geometry.attributes)) {
      if (attribute.itemSize !== 1 || !attribute.normalized) continue;
      const values = new Float32Array(attribute.count);
      for (let index = 0; index < attribute.count; index += 1)
        values[index] = attribute.getX(index);
      geometry.setAttribute(name, new BufferAttribute(values, 1));
    }
  });
}

/** The `{ scene }` a GLTF result carries, when it carries one. */
/** A loaded model's meshes in traversal order: the coarse companion and the full model list them alike. */
function meshesOf(value: unknown): Mesh[] {
  const meshes: Mesh[] = [];
  modelRoot(value)?.traverse((object) => {
    if ((object as Mesh).isMesh === true) meshes.push(object as Mesh);
  });
  return meshes;
}

function modelRoot(value: unknown): Object3D | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const scene = (value as { scene?: unknown }).scene;
  return scene instanceof Object3D ? scene : undefined;
}

/** The `{ animations }` a GLTF result carries, when it carries well-formed ones. */
function modelClips(value: unknown): readonly AnimationClip[] {
  if (typeof value !== "object" || value === null) return [];
  const animations = (value as { animations?: unknown }).animations;
  return Array.isArray(animations) ? (animations as AnimationClip[]) : [];
}

/** Below this a bone's bind translation along Z carries no vote: there is nothing to negate. */
const MIRROR_VOTE_FLOOR = 1e-6;
/** A translation track must actually hold the offset for its vote to count, not pass through zero. */
const MIRROR_VOTE_HOLD = 0.25;
/** The share of voting bones that must read mirrored before the loader repairs the clips. */
const MIRROR_VOTE_SHARE = 0.8;
/** Fewer voting bones than this cannot carry the decision, whatever they read. */
const MIRROR_VOTE_MINIMUM = 4;

/**
 * Repair an exported rig whose clips are Z-mirrored against its own bind pose, in place.
 *
 * The signature (PRD-324, the whole Wildwood animal pack): the file's bind faces its own +Z, but
 * every animation track is expressed in a Z-mirrored frame — position tracks hold `(x, y, −z)`
 * where the bind holds `(x, y, z)`, and quaternion tracks hold `(−x, −y, z, w)`, the conjugation
 * of the same mirror. Played as authored, every animal faces backwards with its spine folded:
 * head behind pelvis, healthy bone lengths, zero errors anywhere.
 *
 * An exporter writes exactly this when it converts a rig's bind to one convention and forgets its
 * animation tracks. The loader repairs it before the game ever sees it: detection votes per
 * tracked bone on whether the clip's translation Z sits negated against the bind, and only an
 * overwhelming vote (at least `MIRROR_VOTE_MINIMUM` bones, `MIRROR_VOTE_SHARE` of them) converts
 * every track — positions negate Z, quaternions negate X and Y, once, across all clips. A file
 * that does not carry the signature is left byte-identical.
 */
export function reconcileMirroredClips(root: Object3D, clips: readonly AnimationClip[]): boolean {
  if (clips.length === 0) return false;
  const bones = new Map<string, Bone>();
  root.traverse((object) => {
    if ((object as Bone).isBone === true) bones.set(object.name, object as Bone);
  });
  if (bones.size === 0) return false;

  let voters = 0;
  let mirrored = 0;
  for (const clip of clips) {
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf(".");
      if (track.name.slice(dot + 1) !== "position") continue;
      const bone = bones.get(track.name.slice(0, dot));
      if (bone === undefined) continue;
      const bindZ = bone.position.z;
      if (Math.abs(bindZ) < MIRROR_VOTE_FLOOR) continue;
      const values = track.values;
      let sum = 0;
      let count = 0;
      for (let index = 2; index < values.length; index += 3) {
        sum += values[index] ?? 0;
        count += 1;
      }
      if (count === 0) continue;
      const meanZ = sum / count;
      // A track that never holds the offset votes neither way.
      if (Math.abs(meanZ) < Math.abs(bindZ) * MIRROR_VOTE_HOLD) continue;
      voters += 1;
      if (Math.abs(meanZ + bindZ) < Math.abs(meanZ - bindZ)) mirrored += 1;
    }
  }
  if (voters < MIRROR_VOTE_MINIMUM || mirrored / voters < MIRROR_VOTE_SHARE) return false;

  for (const clip of clips) {
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf(".");
      const property = track.name.slice(dot + 1);
      const values = track.values;
      if (property === "position") {
        for (let index = 2; index < values.length; index += 3) {
          values[index] = -(values[index] ?? 0);
        }
      } else if (property === "quaternion") {
        for (let index = 0; index < values.length; index += 4) {
          values[index] = -(values[index] ?? 0);
          values[index + 1] = -(values[index + 1] ?? 0);
        }
      }
    }
  }
  return true;
}

export function createAssetLoader(options: IAssetLoaderOptions = {}): IAssetLoader {
  const debug = debugRequested();
  const basePath = options.basePath ?? "";
  const streamMeshes = options.streamMeshes !== false;
  if (!streamMeshes)
    console.info(
      "TN_ASSETS_STREAM_MESHES_OFF: assets.streamMeshes is false; every model loads whole.",
    );
  const streamTextures = options.streamTextures !== false;
  if (!streamTextures)
    console.info(
      "TN_ASSETS_STREAM_TEXTURES_OFF: assets.streamTextures is false; every model texture loads whole.",
    );
  // What the texture streaming kept off the first-play path, read from the console as TN_STREAMING_POOL.
  const pool = { files: 0, fullBytes: 0, ranged: 0, residentBytes: 0, upgraded: 0 };
  let poolTimer: ReturnType<typeof setTimeout> | undefined;
  const reportPool = (): void => {
    clearTimeout(poolTimer);
    poolTimer = setTimeout(() => {
      poolTimer = undefined;
      console.info(
        `TN_STREAMING_POOL ${JSON.stringify({ ...pool, deferredBytes: pool.fullBytes - pool.residentBytes })}`,
      );
    }, 2000);
  };
  /** One KTX2 image as its resident mips only; any other image, or a host with no `Range`, loads whole. */
  const residentImage = async (
    url: string,
  ): Promise<{ readonly file: Uint8Array; readonly partial: boolean } | undefined> => {
    if (!/\.ktx2(?:$|\?)/iu.test(url)) return undefined;
    const stream = await openKtx2Stream(url);
    // A host with no Range support sent the whole file already: hand it on, not fetched again.
    if (!stream.ranged) return { file: stream.file(), partial: false };
    const file = stream.file();
    pool.files += 1;
    pool.ranged += 1;
    pool.residentBytes += file.byteLength;
    pool.fullBytes += stream.index.levels.reduce((sum, level) => sum + level.byteLength, 0);
    reportPool();
    return { file, partial: true };
  };
  /** The engine loader's `imageSource` for one parse of a streamed model. */
  const imageSourceFor =
    (resident: IResidentImages) =>
    async (imageUrl: string): Promise<Uint8Array | undefined> => {
      // A host with no Range already sent this file whole to the coarse parse.
      const kept = resident.whole.get(imageUrl);
      if (kept !== undefined || resident.keptOnly === true) return kept;
      const served = await residentImage(imageUrl);
      if (served?.partial === true) resident.used = true;
      else if (served !== undefined) resident.whole.set(imageUrl, served.file);
      return served?.file;
    };
  // `assets` is what `@threenative/assets` compiles from unless a project says otherwise, so it is
  // where an unbaked game's files are. A project that moved its sources passes `sourcePath`.
  const sourcePath = (options.sourcePath ?? "assets").replace(/^\/+|\/+$/gu, "");
  const manifestUrl = resolvePath(basePath, options.manifest ?? "assets.manifest.json");
  const assetCache = createAssetCache({
    enabled: options.cache,
    backgroundFill: options.backgroundFill,
    // A different manifest url is a different game on the same origin, and must not delete this
    // one's cache at startup. Two urls of the same page (`/` and `/index.html`) read the same one.
    namespace: canonicalUrl(manifestUrl),
  });
  /** The urls the background fill warms, in manifest order, with the sizes the manifest records. */
  const fillEntries = (manifest: IAssetManifest): readonly { bytes?: number; url: string }[] => {
    const byUrl = new Map<string, { bytes?: number; url: string }>();
    const add = (output: unknown, bytes: unknown): void => {
      // The disk keeps only a file whose size the manifest records, so an unsized one would be
      // downloaded and thrown away on every visit.
      if (typeof output !== "string" || !isSize(bytes)) return;
      const url = resolvePath(basePath, output);
      if (byUrl.has(url)) return;
      byUrl.set(url, { bytes, url });
    };
    for (const entry of Object.values(manifest.entries)) {
      if (!isRecord(entry)) continue;
      add(entry.output, entry.bytes);
      // A model's external textures and a lightmap are separate files in the same release, so the
      // fill warms them too: otherwise a second visit still re-downloads every texture.
      if (Array.isArray(entry.lightmaps)) {
        for (const lightmap of entry.lightmaps) {
          if (isRecord(lightmap)) add(lightmap.output, lightmap.bytes);
        }
      }
      if (Array.isArray(entry.sharedImages)) {
        for (const image of entry.sharedImages) {
          if (isRecord(image)) add(image.output, image.bytes);
        }
      }
    }
    return [...byUrl.values()];
  };
  let manifestRequest: Promise<IAssetManifest | undefined> | undefined;
  const manifestOnce = (): Promise<IAssetManifest | undefined> => {
    if (manifestRequest === undefined) {
      manifestRequest = readManifest(manifestUrl)
        .catch((error: unknown) => {
          // A malformed manifest still has to release the fill gate; otherwise a game that awaits
          // the documented `startBackgroundFill()` promise waits forever.
          assetCache.setManifest([]);
          throw error;
        })
        .then((manifest) => {
          if (manifest !== undefined) {
            const entries = fillEntries(manifest);
            assetCache.setManifest(entries);
          } else {
            // No manifest means nothing is content-addressed, so the cache stays out of the way.
            assetCache.setManifest([]);
          }
          return manifest;
        });
    }
    return manifestRequest;
  };
  // Detection still runs exactly once, but `ready` only makes unsupported compressed textures a
  // boot error when this build actually published KTX2 output. Native-safe manifests and the
  // no-manifest fallback must not fail merely because a renderer exposes no compressed format.
  const compressedTextures =
    options.renderer === undefined
      ? undefined
      : (() => {
          const loader = createKtx2Loader({ basePath, renderer: options.renderer });
          const ready = manifestOnce().then((manifest) =>
            prepareCompressedTextures(manifest, loader),
          );
          loader.catch(() => undefined);
          ready.catch(() => undefined);
          return { loader, ready };
        })();
  const cache = new Map<string, IAssetEntry>();
  /** Logical path → the url that actually served it, and the pipeline that url came from. */
  const resolvedAssets = new Map<string, IResolvedAsset>();
  const disposed: IResourceDisposalSets = {
    geometries: new WeakSet(),
    surfaces: new WeakSet(),
    textures: new WeakSet(),
  };
  let loaderDisposed = false;

  const loadCompiledKtx2 = async (url: string): Promise<Texture> => {
    if (compressedTextures === undefined) {
      throw new Error(
        `TN_ASSETS_KTX2_NO_RENDERER: '${url}' is compiled compressed output; construct the asset loader with { renderer } so KTX2 support can be detected.`,
      );
    }
    const shared = await compressedTextures.loader;
    if (shared === undefined) {
      throw new Error(
        `TN_ASSETS_KTX2_UNPROBED: '${url}' is compiled compressed output but the provided renderer exposes no support-detection surface (neither WebGPU features nor WebGL extensions).`,
      );
    }
    const texture = await loadWith(shared, url);
    if (texture.format === RGBA_ASTC_4x4_Format && !hasAstcSupport(shared)) {
      texture.dispose();
      throw new Error(
        `TN_ASSETS_ASTC_UNSUPPORTED: '${url}' contains raw ASTC 4x4 but the renderer lacks ASTC texture-compression support.`,
      );
    }
    return texture;
  };

  const attachCompiledLightmaps = async (logicalPath: string, value: unknown): Promise<void> => {
    if (isExternalAssetPath(logicalPath)) return;
    const manifest = await manifestOnce();
    const lightmaps = compiledLightmaps(manifest?.entries[logicalPath], logicalPath);
    for (const specification of lightmaps) {
      const resolved = resolvePath(basePath, specification.output);
      let texture: Texture;
      try {
        texture = await loadCompiledKtx2(resolved);
      } catch (error) {
        throw new Error(
          `TN_ASSETS_LIGHTMAP_MISSING: could not load '${resolved}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      texture.channel = specification.texCoord;
      try {
        attachLightmap(value, specification, texture);
      } catch (error) {
        texture.dispose();
        throw error;
      }
    }
  };

  // Cache keys stay on the logical path so `release` matches whatever was loaded with or
  // without a manifest; loaders always receive the fully resolved url.
  /**
   * The resolved runtime selection budget an asset was cooked with, read from the manifest entry.
   * Absent — no manifest, an older cook, or a disabled asset — selects the built-in default budget
   * so an extension-bearing file still refines and coarsens sensibly.
   */
  const discretePolicy = async (logicalPath: string): Promise<IModelLodPolicy | undefined> => {
    if (isExternalAssetPath(logicalPath)) return undefined;
    const manifest = await manifestOnce();
    const entry = manifest?.entries[logicalPath];
    const lod = isRecord(entry) ? entry.lod : undefined;
    const runtime = isRecord(lod) ? lod.runtime : undefined;
    if (
      !isRecord(runtime) ||
      typeof runtime.maxPixelError !== "number" ||
      typeof runtime.hysteresis !== "number"
    ) {
      return undefined;
    }
    return { hysteresis: runtime.hysteresis, maxPixelError: runtime.maxPixelError };
  };

  /**
   * Where a logical path might live, in the order worth trying.
   *
   * With a manifest there is exactly one answer, and a path the manifest does not list is an
   * error rather than a guess. Without one there are two, and both are real games:
   *
   * - a project with **no asset pipeline** puts its files straight into `public/` and refers to
   *   them by name, so the verbatim path is right;
   * - a project **whose compiled output has been removed** still has its sources under
   *   `assets/`, and the content-addressed name the manifest would have given is gone with it.
   *
   * The second case is the delete-test — *delete the entire baked output and the game runs
   * identically, just slower* — and it could not pass while only the first was tried: the loader
   * asked for `/rock.png`, which exists nowhere in a compiled project, and the game never booted.
   */
  const resolveCandidates = async (path: string): Promise<ICandidateUrls> => {
    if (isExternalAssetPath(path)) return { urls: [path], via: "source" };
    const manifest = await manifestOnce();
    if (manifest !== undefined) {
      const listed = manifest.entries[path];
      const output = isRecord(listed) ? listed.output : undefined;
      if (typeof output !== "string") {
        throw new Error(`Asset '${path}' is not listed in the asset manifest '${manifestUrl}'.`);
      }
      return { urls: [resolvePath(basePath, output)], via: "manifest" };
    }
    const verbatim = resolvePath(basePath, path);
    if (sourcePath === "") return { urls: [verbatim], via: "source" };
    const fromSource = resolvePath(basePath, `${sourcePath}/${path}`);
    return fromSource === verbatim
      ? { urls: [verbatim], via: "source" }
      : { urls: [verbatim, fromSource], via: "source" };
  };

  /**
   * Loads from the first candidate that works, and names every one it tried when none do.
   *
   * A single combined error matters more than it looks: the failure this replaces reported only
   * the last url, so "the game cannot find its texture" read as one missing file rather than as
   * two places that were looked at and neither had it.
   */
  const loadFirst = async <T>(
    path: string,
    { urls, via }: ICandidateUrls,
    load: (url: string) => Promise<T>,
  ): Promise<T> => {
    const failures: string[] = [];
    for (const url of urls) {
      const start = debug ? performanceNow() : 0;
      try {
        const value = await (debug
          ? measureDebug(`assetDispatch.${url}`, "loading", url, () => load(url))
          : load(url));
        // Recorded here, where the winner is known and nowhere else: a caller that asks which
        // url served its bytes gets the one that did, not the first one that was tried.
        resolvedAssets.set(path, { url, via });
        return value;
      } catch (error) {
        failures.push(`${url} (${error instanceof Error ? error.message : String(error)})`);
      } finally {
        if (debug)
          countDebug(
            `assetLoad.${url}WallMs`,
            performanceNow() - start,
            "loading",
            url,
            "async-ms",
          );
      }
    }
    throw new Error(
      `TN_ASSETS_UNRESOLVED: '${path}' could not be loaded from ${urls.length} candidate url(s): ${failures.join("; ")}`,
    );
  };

  let requested = 0;
  let requestedBytes = 0;
  let settled = 0;
  let settledBytes = 0;
  /** Logical paths asked for and not yet settled, in request order — what a loading view names. */
  const pending = new Set<string>();
  /** A streamed model's full-file upgrade, settled when it landed or failed (`whole: true` waits on it). */
  const wholeOf = new WeakMap<object, Promise<void>>();
  const wholeWhen = <T>(wait: boolean, loading: Promise<T>): Promise<T> =>
    wait
      ? loading.then(async (value) => {
          if (typeof value === "object" && value !== null) await wholeOf.get(value);
          return value;
        })
      : loading;
  /** Logical paths the game warmed ahead of time; a load of one is a stream, not a pop-in. */
  const warmed = new Set<string>();
  /** When the reveal made the player play; `undefined` until then. */
  let revealedAtMs: number | undefined;

  /**
   * The compiled size of a logical path, or 0 when it is not knowable — no manifest, an external
   * url, or an entry the compile step wrote without a size. Zero is the honest answer and keeps
   * both byte counters at zero, which is the signal a reader uses to fall back to the file ratio.
   */
  const bytesOf = async (path: string): Promise<number> => {
    if (isExternalAssetPath(path)) return 0;
    const manifest = await manifestOnce();
    const entry = manifest?.entries[path];
    const bytes = isRecord(entry) ? entry.bytes : undefined;
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  };

  /** A model's coarse companion (PRD-860 Phase 3), when the cook wrote one and streaming is on. */
  const coarseOf = async (path: string): Promise<{ bytes: number; url: string } | undefined> => {
    if (!streamMeshes || isExternalAssetPath(path)) return undefined;
    const entry = (await manifestOnce())?.entries[path];
    const coarse =
      isRecord(entry) && Array.isArray(entry.streamedLods) ? entry.streamedLods[0] : undefined;
    if (!isRecord(coarse) || typeof coarse.output !== "string" || typeof coarse.bytes !== "number")
      return undefined;
    return { bytes: coarse.bytes, url: resolvePath(basePath, coarse.output) };
  };

  /** What a request waits for: a streamed model's coarse companion, else the file itself. */
  const weightOf = async (kind: string, path: string): Promise<number> =>
    (kind === "model" && !warmed.has(path) ? (await coarseOf(path))?.bytes : undefined) ??
    bytesOf(path);

  /** The shared images and lightmaps a path's load downloads beside its own file, with sizes. */
  const auxiliaryOf = async (path: string): Promise<IResolvedFile[]> => {
    if (isExternalAssetPath(path)) return [];
    const entry = (await manifestOnce())?.entries[path];
    if (!isRecord(entry)) return [];
    const files: IResolvedFile[] = [];
    for (const key of ["sharedImages", "lightmaps"] as const) {
      const outputs = entry[key];
      if (!Array.isArray(outputs)) continue;
      for (const output of outputs) {
        if (!isRecord(output) || typeof output.output !== "string") continue;
        const bytes = output.bytes;
        if (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0)
          files.push({ bytes, url: resolvePath(basePath, output.output) });
      }
    }
    return files;
  };

  const cached = <T>(
    kind: string,
    path: string,
    load: (url: string, priority: AssetPriority) => Promise<T>,
    priority: AssetPriority = "now",
    whole = false,
  ): Promise<T> => {
    const key = `${kind}:${path}`;
    const existing = cache.get(key);
    if (existing !== undefined) {
      // The world asked at `soon` and the scene now awaits the same file: without the promotion
      // the scene waits behind every queued prefetch.
      if (!existing.loaded && PRIORITY_ORDER[priority] < PRIORITY_ORDER[existing.priority]) {
        existing.priority = priority;
        if (existing.url !== undefined) assetCache.promote(existing.url, priority);
      }
      return wholeWhen(whole, existing.promise as Promise<T>);
    }
    requested += 1;
    // The size is only knowable once the manifest lands, so this load's weight joins the
    // denominator a tick later than its count. Recorded here rather than inside the load chain
    // so a load that fails still contributes the same weight to both sides of the ratio.
    let weight = 0;
    let auxiliary: readonly IResolvedFile[] = [];
    const weighed = Promise.all([weightOf(kind, path), auxiliaryOf(path)]).then(
      ([bytes, files]) => {
        weight = bytes;
        auxiliary = files;
        requestedBytes += bytes;
      },
      () => undefined,
    );
    // A whole-file request after the reveal is the pop-in a streaming game exists to avoid: the
    // scene has no bytes and starts a download while the player is already looking at the world.
    // Measured, never configured — and quiet for a file the game warmed with `prefetch`.
    if (revealedAtMs !== undefined && !warmed.has(path)) {
      const lateAt = revealedAtMs;
      void weighed.then(() =>
        console.log(
          `${ASSET_LATE_MARKER}:${JSON.stringify({
            bytes: weight,
            kind,
            ms: Math.round(performanceNow() - lateAt),
            path,
          })}`,
        ),
      );
    }
    // Opt-in per-asset timing, off by default and free when off: a launch that is slow because of
    // *which* asset is slow cannot be told from the group totals a game logs, and the engine is the
    // only place that sees every settle. Set `globalThis.__TN_ASSET_TRACE__ = true` before boot.
    const traceStart = assetTraceEnabled() ? performanceNow() : 0;
    const entry: IAssetEntry = {
      disposed: false,
      kind: kind as AssetKind,
      loaded: false,
      priority,
      promise: Promise.resolve()
        .then(() => resolveCandidates(path))
        .then((candidates) =>
          loadFirst(path, candidates, (url) => {
            entry.url = url;
            return load(url, entry.priority);
          }),
        ),
      released: false,
    };
    entry.promise = entry.promise.then((value) => {
      entry.loaded = true;
      entry.value = value;
      const record = resolvedAssets.get(path);
      if (record !== undefined) resolvedAssets.set(path, { ...record, kind: kind as AssetKind });
      if (entry.released) disposeEntry(entry, disposed);
      return value;
    });
    entry.promise.catch(() => {
      if (cache.get(key) === entry) cache.delete(key);
    });
    pending.add(path);
    const note = (): void => {
      settled += 1;
      pending.delete(path);
      void weighed.then(() => {
        settledBytes += weight;
        // Only a load that resolved has a record; a rejected one has no bytes to attribute.
        const record = resolvedAssets.get(path);
        if (record !== undefined && weight > 0)
          resolvedAssets.set(path, {
            ...record,
            bytes: weight,
            files: [{ bytes: weight, url: record.url }, ...auxiliary],
          });
      });
      if (traceStart !== 0) {
        console.log(
          `TN_ASSET:${JSON.stringify({
            bytes: weight,
            kind,
            ms: Math.round((performanceNow() - traceStart) * 10) / 10,
            path,
          })}`,
        );
      }
    };
    entry.promise.then(note, note);
    cache.set(key, entry);
    return wholeWhen(whole, entry.promise as Promise<T>);
  };

  const releaseEntry = (entry: IAssetEntry): void => {
    entry.released = true;
    if (entry.loaded) disposeEntry(entry, disposed);
    else
      void entry.promise.then(
        () => disposeEntry(entry, disposed),
        () => undefined,
      );
  };

  /**
   * Warm the disk with the named logical paths at `soon` priority. Resolves once every candidate
   * settles; a path the manifest does not list is skipped rather than failing the whole prefetch.
   */
  const prefetchPaths = async (paths: readonly string[]): Promise<IAssetPrefetchProgress> => {
    // Marked before the early returns: a native host has the files installed, and a game asked for
    // these either way, so a later load of one is not a surprise download.
    for (const path of paths) warmed.add(path);
    if (!assetCache.enabled) {
      return {
        requested: paths.length,
        requestedBytes: 0,
        settled: paths.length,
        settledBytes: 0,
      };
    }
    const manifest = await manifestOnce().catch(() => undefined);
    // No manifest means no content-addressed output, so there is nothing the cache may keep and
    // nothing to warm. Reporting the paths as settled is honest; downloading them would not be.
    if (manifest === undefined) {
      return {
        requested: paths.length,
        requestedBytes: 0,
        settled: paths.length,
        settledBytes: 0,
      };
    }
    const targets: { bytes?: number; url: string }[] = [];
    const addOutput = (output: unknown, bytes: unknown): void => {
      // An unsized file cannot be kept on disk, so prefetching it would only waste the link.
      if (typeof output !== "string" || !isSize(bytes)) return;
      targets.push({ bytes, url: resolvePath(basePath, output) });
    };
    for (const path of paths) {
      let urls: readonly string[];
      try {
        urls = (await resolveCandidates(path)).urls;
      } catch {
        continue;
      }
      const size = await bytesOf(path);
      for (const url of urls) targets.push({ url, ...(size > 0 ? { bytes: size } : {}) });
      // A model's external textures and a lightmap are separate files; prefetching the model
      // alone would leave the deferred tier fetching the textures again over the network.
      const entry = manifest.entries[path];
      if (!isRecord(entry)) continue;
      for (const key of ["lightmaps", "sharedImages"] as const) {
        const outputs = entry[key];
        if (!Array.isArray(outputs)) continue;
        for (const output of outputs) {
          if (!isRecord(output)) continue;
          addOutput(output.output, output.bytes);
        }
      }
    }
    // One entry per url, so a candidate list with two spellings still costs one download.
    const unique = [...new Map(targets.map((target) => [target.url, target])).values()];
    const results = await Promise.allSettled(
      unique.map((target) => assetCache.fetchBytes(target.url, "soon", target.bytes)),
    );
    let settled = 0;
    let settledBytes = 0;
    results.forEach((result, index) => {
      if (result.status !== "fulfilled") return;
      settled += 1;
      settledBytes += unique[index]?.bytes ?? result.value.byteLength;
    });
    return {
      requested: unique.length,
      requestedBytes: unique.reduce((sum, target) => sum + (target.bytes ?? 0), 0),
      settled,
      settledBytes,
    };
  };

  return {
    audio: (path) =>
      cached("audio", path, async (url) => {
        if (options.audio !== undefined) return options.audio(url);
        const { AudioLoader: Loader } = await import("three");
        return loadWith(new Loader() as AudioLoader, url);
      }),
    clear: () => {
      const entries = [...cache.values()];
      cache.clear();
      entries.forEach(releaseEntry);
    },
    dispose: () => {
      if (loaderDisposed) return;
      loaderDisposed = true;
      assetCache.dispose();
      // Three's KTX2Loader owns the decoder worker pool. Resolving the shared promise can fail
      // when no loader was built; that is not a teardown failure.
      void compressedTextures?.loader
        .then((shared) => {
          (shared as (IKTX2LoaderLike & { dispose?: () => void }) | undefined)?.dispose?.();
        })
        .catch(() => undefined);
    },
    ...(compressedTextures === undefined ? {} : { compressedTextures }),
    model: <T = unknown>(path: string, request?: IAssetRequestOptions) =>
      cached<T>(
        "model",
        path,
        async (url, priority) => {
          if (options.model !== undefined) {
            const value = (await options.model(url)) as T;
            stampAssetProvenance(value, path);
            await attachCompiledLightmaps(path, value);
            return value;
          }
          const parse = async (
            fileUrl: string,
            expected: number,
            at: AssetPriority,
            resident?: IResidentImages,
          ): Promise<T> => {
            // Fetched here rather than through the loader so the declared extensions decide which
            // decoders load: a game never pays for a codec its assets do not use, and no WASM is
            // instantiated on platforms that never load a compressed model. Both the compiled and
            // the uncompiled path take this one code path.
            const data = await fetchModelBytes(
              fileUrl,
              assetCache,
              expected > 0 ? expected : undefined,
              at,
            );
            const extensions = declaredExtensions(data);
            const { GLTFLoader } = await import("three/addons/loaders/GLTFLoader.js");
            const loader = new GLTFLoader();
            if (resident !== undefined && "imageSource" in loader)
              (loader as { imageSource?: unknown }).imageSource = imageSourceFor(resident);
            // Both glTF texture extensions use the same support-detected instance as texture().
            const astcExtension = "EXT_texture_astc";
            // The owned engine's loader (`failClosed`) transcodes KHR_texture_basisu itself, to BC7,
            // ETC2 or RGBA8, so three's KTX2Loader and its format check do not gate it (PRD-867).
            const hasBasis =
              extensions.has("KHR_texture_basisu") &&
              (loader as { failClosed?: boolean }).failClosed !== true;
            const hasAstc = extensions.has(astcExtension);
            let shared: IKTX2LoaderLike | undefined;
            if (compressedTextures !== undefined && (hasBasis || hasAstc)) {
              try {
                shared = await compressedTextures.loader;
              } catch (error) {
                // Only ASTC-only models may select their ordinary fallback on capability refusal.
                // Import/setup failures and the existing Basis contract still reject unchanged.
                if (
                  hasBasis ||
                  !(error instanceof Error) ||
                  !error.message.startsWith("TN_ASSETS_KTX2_UNSUPPORTED:")
                )
                  throw error;
              }
              if (shared !== undefined) {
                loader.setKTX2Loader(
                  shared as unknown as Parameters<typeof loader.setKTX2Loader>[0],
                );
              }
            }
            if (hasAstc) {
              const astcLoader = shared;
              const astcSupported = hasAstcSupport(astcLoader);
              // EXT_texture_astc is an official vendor draft. Borrow Three's Basis plugin handoff,
              // but raw ASTC cannot use Basis's format fallback and needs this explicit GPU guard.
              loader.register((parser) => {
                if (!astcSupported && parser.json.extensionsRequired?.includes(astcExtension)) {
                  throw new Error(
                    "TN_ASSETS_ASTC_UNSUPPORTED: required EXT_texture_astc needs a renderer with ASTC texture-compression support.",
                  );
                }
                return {
                  name: astcExtension,
                  loadTexture(textureIndex) {
                    const extension =
                      parser.json.textures[textureIndex].extensions?.[astcExtension];
                    if (extension === undefined || !astcSupported || astcLoader === undefined)
                      return null;
                    return parser.loadTextureImage(
                      textureIndex,
                      extension.source,
                      astcLoader as NonNullable<Parameters<typeof loader.setKTX2Loader>[0]>,
                    );
                  },
                };
              });
            }
            // three's own decoder embeds its WASM; it compiles only once a compressed model is
            // actually loaded. The native bundle inlines this branch (no runtime import remains),
            // and the host shims WebAssembly.
            if (MESHOPT_EXTENSIONS.some((extension) => extensions.has(extension))) {
              const { MeshoptDecoder } = await import(
                "three/addons/libs/meshopt_decoder.module.js"
              );
              loader.setMeshoptDecoder(MeshoptDecoder);
            }
            // Draco is an input format only: the compile step re-emits Draco assets as Meshopt,
            // so this serves uncompiled Draco files dropped into a web root. The decoder wasm is
            // served from `<basePath>draco/` by convention, like `basis/`.
            // The cluster DAG the asset pipeline baked in. Registered only when the file declares it,
            // so a game whose models are ordinary meshes never pays for the plugin — and a game whose
            // models are not gets a plain `Mesh`, with no runtime switch either way.
            // The Wasm engine's loader hosts no cluster plugin and refuses any it does not host. The
            // pipeline never marks the bake required, so there the file's source triangles draw.
            if (extensions.has(TN_VIRTUAL_GEOMETRY)) {
              if ((loader as { failClosed?: boolean }).failClosed === true)
                console.info(
                  `TN_VIRTUAL_GEOMETRY_SKIPPED ${path}: this engine's glTF loader hosts no cluster plugin; the source mesh draws`,
                );
              else loader.register((parser) => new VirtualGeometryPlugin(parser as never) as never);
            }
            // The discrete chain the asset pipeline baked in. Registered only when the file declares it,
            // so a game with no auto LOD never pays for the plugin. Levels are built after the quantized
            // positions are widened, so the derived geometries share the widened attributes.
            // The Wasm engine's loader hosts this plugin too, and sets `failClosed`: a chain it cannot
            // deliver rejects the load there instead of being logged.
            const discreteLod = extensions.has(TN_DISCRETE_LOD)
              ? new DiscreteLodPlugin({
                  failClosed: (loader as { failClosed?: boolean }).failClosed === true,
                })
              : undefined;
            if (discreteLod !== undefined) {
              const plugin = discreteLod;
              loader.register((parser) => {
                plugin.setParser(parser as never);
                return plugin as never;
              });
            }
            if (extensions.has(DRACO_EXTENSION)) {
              const { DRACOLoader } = await import("three/addons/loaders/DRACOLoader.js");
              const dracoLoader = new DRACOLoader();
              dracoLoader.setDecoderPath(resolvePath(basePath, "draco/"));
              loader.setDRACOLoader(dracoLoader);
            }
            const value = await new Promise<T>((resolve, reject) =>
              loader.parse(data, resourcePathOf(fileUrl), resolve as never, reject),
            );
            // Before the game ever sees it: a quantized POSITION is a trap for every ordinary
            // three.js geometry call. See `widenQuantizedPositions`.
            const root = modelRoot(value);
            if (root !== undefined) widenQuantizedPositions(root);
            // And a normalized scalar is a trap for the WebGPU pipeline. See `widenNormalizedScalars`.
            if (root !== undefined) widenNormalizedScalars(root);
            // Built here, after both widenings, so the derived levels share the widened base
            // attributes instead of pinning the quantized ones.
            if (root !== undefined && discreteLod !== undefined)
              discreteLod.attach(root, await discretePolicy(path), attachInstancedLod);
            // Before the game ever sees it: clips z-mirrored against their own bind pose play every
            // animal backwards, silently. See `reconcileMirroredClips`.
            const clips = modelClips(value);
            if (root !== undefined && clips.length > 0 && reconcileMirroredClips(root, clips)) {
              // A warning, not an info line: every file this fires on is a defect in whatever wrote
              // it, and a repair that reads as routine is a repair nobody ever removes the cause of.
              // The Unreal importer's own reader of ActorX PSA keys once produced exactly this on
              // every skeletal mesh it converted, unnoticed for as long as the line said `info`.
              const cause =
                "its clips are mirrored against its own bind pose, and the loader un-mirrored them " +
                "so the game plays forwards. The file is wrong, not the game: re-import it with a " +
                "current converter and this stops.";
              console.warn(`TN_ASSETS_MIRRORED_CLIPS_REPAIRED ${path} — ${cause}`);
            }
            return value;
          };
          // PRD-860 Phase 3: a model the cook gave a coarse companion draws it first, and every
          // coarse geometry takes the full model in place when that lands, the game's clones
          // included. A model the game prefetched is already on its way whole.
          const coarse = warmed.has(path) ? undefined : await coarseOf(path);
          let value: T | undefined;
          const residentState: IResidentImages | undefined = streamTextures
            ? { used: false, whole: new Map() }
            : undefined;
          if (coarse !== undefined) {
            try {
              value = await parse(coarse.url, coarse.bytes, priority, residentState);
            } catch (error) {
              console.warn(
                `TN_ASSETS_STREAM_FAILED ${path}: the coarse model did not load, so the whole file does; ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          }
          if (value === undefined) value = await parse(url, await bytesOf(path), priority);
          else {
            const coarseMeshes = meshesOf(value);
            // What the coarse model brought, recorded now: the game may set a geometry, material
            // or texture of its own before the full model lands, and the upgrade leaves that alone.
            const coarseGeometries = coarseMeshes.map((mesh) => mesh.geometry);
            const upgradeTextures = streamedTextureUpgrade(coarseMeshes);
            for (const geometry of coarseGeometries) markStreamedGeometry(geometry);
            // Released, cleared or the loader disposed while the full file was on its way: the
            // coarse model is gone, so the full one is not parsed, or is released unused.
            const gone = (): boolean =>
              loaderDisposed ||
              coarseGeometries.some((geometry) => disposed.geometries.has(geometry));
            const landed = bytesOf(path)
              .then((bytes) =>
                gone()
                  ? undefined
                  : parse(
                      url,
                      bytes,
                      "soon",
                      residentState && { keptOnly: true, used: false, whole: residentState.whole },
                    ),
              )
              .then((full) => {
                residentState?.whole.clear();
                if (full === undefined) return;
                if (gone()) {
                  disposeModel(full, disposed);
                  return;
                }
                const fullMeshes = meshesOf(full);
                if (fullMeshes.length !== coarseMeshes.length)
                  throw new Error(
                    `the full model has ${String(fullMeshes.length)} mesh(es), the coarse ${String(coarseMeshes.length)}`,
                  );
                coarseGeometries.forEach((geometry, index) =>
                  upgradeStreamedGeometry(geometry, (fullMeshes[index] as Mesh).geometry),
                );
                const swapped = upgradeTextures(fullMeshes, residentState?.used === true);
                if (residentState?.used === true) {
                  pool.upgraded += swapped;
                  reportPool();
                }
              })
              .catch((error: unknown) =>
                console.warn(
                  `TN_ASSETS_STREAM_FAILED ${path}: the coarse model stays; ${error instanceof Error ? error.message : String(error)}`,
                ),
              );
            if (typeof value === "object" && value !== null) wholeOf.set(value, landed);
          }
          stampAssetProvenance(value, path);
          await attachCompiledLightmaps(path, value);
          return value;
        },
        request?.priority ?? "now",
        request?.whole === true,
      ),
    get cache() {
      return { ...assetCache.report, clear: () => assetCache.clear() };
    },
    get progress() {
      return { pending: [...pending], requested, requestedBytes, settled, settledBytes };
    },
    memo: createAssetMemo(canonicalUrl(manifestUrl)),
    prefetch: prefetchPaths,
    resolve: async (path) => (await resolveCandidates(path)).urls,
    startBackgroundFill: () => {
      // The reveal is the first moment the network is free and the player is playing, so it is also
      // where a request stops being a load and starts being a pop-in. See `ASSET_LATE_MARKER`.
      revealedAtMs ??= performanceNow();
      // The fill needs the manifest even when the scene loaded nothing through this loader yet;
      // a failed read is the documented no-manifest case and simply leaves the fill empty.
      void manifestOnce().catch(() => undefined);
      return assetCache.startFill();
    },
    // A copy per read, like `progress`: a caller inspecting the record must not be able to
    // rewrite what the loader reports for the next asset that settles.
    get resolved(): ReadonlyMap<string, IResolvedAsset> {
      return new Map(resolvedAssets);
    },
    release: (kind, path) => {
      const key = `${kind}:${path}`;
      const entry = cache.get(key);
      if (entry === undefined) return false;
      cache.delete(key);
      releaseEntry(entry);
      return true;
    },
    texture: async (path, textureOptions) => {
      const texture = await cached("texture", path, async (url, priority) => {
        if (options.texture !== undefined) return options.texture(url);
        // Compiled output carries the content-addressed extension: anything ending in .ktx2
        // goes through the shared KTX2 loader, everything else stays on TextureLoader.
        if (/\.ktx2$/iu.test(url)) {
          return loadCompiledKtx2(url);
        }
        if (typeof createImageBitmap === "function") {
          const expected = await bytesOf(path);
          return loadBitmapTexture(
            url,
            options.renderer,
            assetCache,
            expected > 0 ? expected : undefined,
            priority,
          );
        }
        const { TextureLoader: Loader } = await import("three");
        if (debug) countDebug("textureMainThreadDecodeFallbacks", 1, "loading", url);
        return loadWith(new Loader() as TextureLoader, url);
      });
      return textureOptions === undefined ? texture : configuredTexture(texture, textureOptions);
    },
  };
}

function disposeEntry(entry: IAssetEntry, disposed: IResourceDisposalSets): void {
  if (entry.disposed || !entry.loaded) return;
  entry.disposed = true;
  if (entry.kind === "model") disposeModel(entry.value, disposed);
  else if (entry.kind === "texture") disposeTexture(entry.value, disposed);
}

function disposeModel(value: unknown, disposed: IResourceDisposalSets): void {
  for (const root of modelRoots(value)) {
    root.traverse((object) => {
      const renderable = object as Object3D & { geometry?: unknown; [key: string]: unknown };
      disposeResource(renderable.geometry, disposed.geometries);
      const skeleton = renderable.skeleton as { boneTexture?: unknown } | undefined;
      // A SkinnedMesh's skeleton owns a bone texture allocated on renderer paths that lack
      // float textures (the WebGL2 fallback). Dispose it with the model, and share ownership
      // with every other material/texture reference through the same set.
      disposeTexture(skeleton?.boneTexture, disposed);
      disposeSurface(renderable["ma" + "terial"], disposed);
    });
  }
}

function modelRoots(value: unknown): Object3D[] {
  if (value instanceof Object3D) return [value];
  if (!isRecord(value)) return [];
  const roots = [value.scene, ...(Array.isArray(value.scenes) ? value.scenes : [])];
  return roots.filter((root): root is Object3D => root instanceof Object3D);
}

/**
 * Stamp the logical path the caller asked for onto the model roots a game adds to the scene.
 *
 * The stamp lives on the root and never on its descendants: three's `Object3D.copy` deep-copies
 * `userData`, so one stamp survives `.clone()` and every skeleton-safe clone an animation helper
 * makes — a clone keeps its provenance without the game annotating anything by hand. A result that
 * is a bare `Object3D` is stamped directly; a `Texture` or `AudioBuffer` is no `Object3D` root and
 * gets nothing. An existing non-empty stamp is never overwritten.
 */
function stampAssetProvenance(value: unknown, logicalPath: string): void {
  for (const root of modelRoots(value)) {
    const userData = root.userData as Record<string, unknown>;
    const existing = userData[GEOMETRY_ASSET_KEY];
    if (typeof existing === "string" && existing !== "") continue;
    userData[GEOMETRY_ASSET_KEY] = logicalPath;
    // An instanced batch is built from a model's geometry and the root never enters the scene, so
    // the geometry carries the stamp too. `BufferGeometry.copy` shares `userData`, so clones keep it.
    root.traverse((object) => {
      const geometry = (object as Object3D & { geometry?: { userData?: Record<string, unknown> } })
        .geometry;
      if (geometry?.userData !== undefined) geometry.userData[GEOMETRY_ASSET_KEY] ??= logicalPath;
    });
  }
}

function disposeSurface(value: unknown, disposed: IResourceDisposalSets): void {
  if (Array.isArray(value)) {
    for (const surface of value) disposeSurface(surface, disposed);
    return;
  }
  if (!isRecord(value)) return;
  if (disposed.surfaces.has(value)) return;
  disposeSurfaceTextures(value, disposed, new WeakSet<object>());
  disposeResource(value, disposed.surfaces);
}

function disposeSurfaceTextures(
  value: unknown,
  disposed: IResourceDisposalSets,
  visited: WeakSet<object>,
): void {
  if (isTexture(value)) {
    disposeTexture(value, disposed);
    return;
  }
  if (typeof value !== "object" || value === null || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    for (const item of value) disposeSurfaceTextures(item, disposed, visited);
    return;
  }
  for (const item of Object.values(value)) disposeSurfaceTextures(item, disposed, visited);
}

function disposeTexture(value: unknown, disposed: IResourceDisposalSets): void {
  if (!isDisposable(value) || disposed.textures.has(value)) return;
  disposed.textures.add(value);
  value.dispose();
}

function disposeResource(value: unknown, disposed: WeakSet<object>): void {
  if (!isDisposable(value) || disposed.has(value)) return;
  disposed.add(value);
  value.dispose();
}

function isDisposable(value: unknown): value is IDisposableResource & object {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { dispose?: unknown }).dispose === "function"
  );
}

function isTexture(value: unknown): value is Texture {
  return value instanceof Texture || (isRecord(value) && value.isTexture === true);
}

/** A byte count the manifest recorded: the disk cache keeps only a file with one. */
function isSize(bytes: unknown): bytes is number {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
