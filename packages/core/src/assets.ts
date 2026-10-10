import {
  type AnimationClip,
  type AudioLoader,
  type Bone,
  BufferAttribute,
  type BufferGeometry,
  Float32BufferAttribute,
  Mesh,
  NoColorSpace,
  Object3D,
  SRGBColorSpace,
  Texture,
  type TextureLoader,
  type Wrapping,
} from "three";
import { TN_VIRTUAL_GEOMETRY, VirtualGeometryPlugin } from "./clustered-mesh.js";
import { GEOMETRY_ASSET_KEY } from "./geometry-capture.js";
import { DiscreteLodPlugin, type IModelLodPolicy, TN_DISCRETE_LOD } from "./model-lod.js";

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
export interface IResolvedAsset {
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
  model<T = unknown>(path: string): Promise<T>;
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

function entryUsesKtx2(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (typeof entry.output === "string" && /\.ktx2$/iu.test(entry.output)) return true;
  return (
    Array.isArray(entry.lightmaps) &&
    entry.lightmaps.some(
      (lightmap) =>
        isRecord(lightmap) &&
        typeof lightmap.output === "string" &&
        /\.ktx2$/iu.test(lightmap.output),
    )
  );
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

async function fetchModelBytes(url: string): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new Error(
      `Failed to load model '${url}': ${error instanceof Error ? error.message : String(error)}.`,
    );
  }
  if (!response.ok) throw new Error(`Failed to load model '${url}': ${response.status}.`);
  return response.arrayBuffer();
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
async function loadBitmapTexture(url: string, renderer: unknown): Promise<Texture> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to load texture '${url}': ${response.status}.`);
  const blob = new Blob([await response.arrayBuffer()]);
  // No renderer means the native host or a bare-node load, both of which flip at upload.
  const flipsAtUpload =
    renderer === undefined ||
    (renderer as { isWebGPURenderer?: boolean }).isWebGPURenderer === true;
  const bitmap = await (flipsAtUpload
    ? createImageBitmap(blob)
    : createImageBitmap(blob, { imageOrientation: "flipY" }));
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
    const float = () =>
      position instanceof Float32BufferAttribute || position.array instanceof Float32Array;
    if (plain && !position.normalized && float()) return;
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
  const basePath = options.basePath ?? "";
  // `assets` is what `@threenative/assets` compiles from unless a project says otherwise, so it is
  // where an unbaked game's files are. A project that moved its sources passes `sourcePath`.
  const sourcePath = (options.sourcePath ?? "assets").replace(/^\/+|\/+$/gu, "");
  const manifestUrl = resolvePath(basePath, options.manifest ?? "assets.manifest.json");
  let manifestRequest: Promise<IAssetManifest | undefined> | undefined;
  const manifestOnce = (): Promise<IAssetManifest | undefined> => {
    if (manifestRequest === undefined) manifestRequest = readManifest(manifestUrl);
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
          const ready = manifestOnce().then(async (manifest) => {
            const requiresKtx2 = Object.values(manifest?.entries ?? {}).some(entryUsesKtx2);
            if (requiresKtx2) await loader;
          });
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
    return loadWith(shared, url);
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
      try {
        const value = await load(url);
        // Recorded here, where the winner is known and nowhere else: a caller that asks which
        // url served its bytes gets the one that did, not the first one that was tried.
        resolvedAssets.set(path, { url, via });
        return value;
      } catch (error) {
        failures.push(`${url} (${error instanceof Error ? error.message : String(error)})`);
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

  const cached = <T>(kind: string, path: string, load: (url: string) => Promise<T>): Promise<T> => {
    const key = `${kind}:${path}`;
    const existing = cache.get(key);
    if (existing !== undefined) return existing.promise as Promise<T>;
    requested += 1;
    // The size is only knowable once the manifest lands, so this load's weight joins the
    // denominator a tick later than its count. Recorded here rather than inside the load chain
    // so a load that fails still contributes the same weight to both sides of the ratio.
    let weight = 0;
    const weighed = bytesOf(path).then(
      (bytes) => {
        weight = bytes;
        requestedBytes += bytes;
      },
      () => undefined,
    );
    // Opt-in per-asset timing, off by default and free when off: a launch that is slow because of
    // *which* asset is slow cannot be told from the group totals a game logs, and the engine is the
    // only place that sees every settle. Set `globalThis.__TN_ASSET_TRACE__ = true` before boot.
    const traceStart = assetTraceEnabled() ? performanceNow() : 0;
    const entry: IAssetEntry = {
      disposed: false,
      kind: kind as AssetKind,
      loaded: false,
      promise: Promise.resolve()
        .then(() => resolveCandidates(path))
        .then((candidates) => loadFirst(path, candidates, load)),
      released: false,
    };
    entry.promise = entry.promise.then((value) => {
      entry.loaded = true;
      entry.value = value;
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
    return entry.promise as Promise<T>;
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
    ...(compressedTextures === undefined ? {} : { compressedTextures }),
    model: <T = unknown>(path: string) =>
      cached<T>("model", path, async (url) => {
        if (options.model !== undefined) {
          const value = (await options.model(url)) as T;
          stampAssetProvenance(value, path);
          await attachCompiledLightmaps(path, value);
          return value;
        }
        // Fetched here rather than through the loader so the declared extensions decide which
        // decoders load: a game never pays for a codec its assets do not use, and no WASM is
        // instantiated on platforms that never load a compressed model. Both the compiled and
        // the uncompiled path take this one code path.
        // The loader module is requested beside the bytes: requested after them, it queues behind
        // every other model download on the page's few connections, and no model parses until it lands.
        const [data, { GLTFLoader }] = await Promise.all([
          fetchModelBytes(url),
          import("three/addons/loaders/GLTFLoader.js"),
        ]);
        const extensions = declaredExtensions(data);
        const loader = new GLTFLoader();
        // Models carrying KHR_texture_basisu textures transcode through the same shared,
        // support-detected instance `texture()` uses — never a second detection pass.
        if (compressedTextures !== undefined && extensions.has("KHR_texture_basisu")) {
          const shared = await compressedTextures.loader;
          if (shared !== undefined) {
            loader.setKTX2Loader(shared as unknown as Parameters<typeof loader.setKTX2Loader>[0]);
          }
        }
        // three's own decoder embeds its WASM; it compiles only once a compressed model is
        // actually loaded. The native bundle inlines this branch (no runtime import remains),
        // and the host shims WebAssembly.
        if (MESHOPT_EXTENSIONS.some((extension) => extensions.has(extension))) {
          const { MeshoptDecoder } = await import("three/addons/libs/meshopt_decoder.module.js");
          loader.setMeshoptDecoder(MeshoptDecoder);
        }
        // Draco is an input format only: the compile step re-emits Draco assets as Meshopt,
        // so this serves uncompiled Draco files dropped into a web root. The decoder wasm is
        // served from `<basePath>draco/` by convention, like `basis/`.
        // The cluster DAG the asset pipeline baked in. Registered only when the file declares it,
        // so a game whose models are ordinary meshes never pays for the plugin — and a game whose
        // models are not gets a plain `Mesh`, with no runtime switch either way.
        if (extensions.has(TN_VIRTUAL_GEOMETRY)) {
          loader.register((parser) => new VirtualGeometryPlugin(parser as never) as never);
        }
        // The discrete chain the asset pipeline baked in. Registered only when the file declares it,
        // so a game with no auto LOD never pays for the plugin. Levels are built after the quantized
        // positions are widened, so the derived geometries share the widened attributes.
        const discreteLod = extensions.has(TN_DISCRETE_LOD) ? new DiscreteLodPlugin() : undefined;
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
          loader.parse(data, resourcePathOf(url), resolve as never, reject),
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
          discreteLod.attach(root, await discretePolicy(path));
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
        stampAssetProvenance(value, path);
        await attachCompiledLightmaps(path, value);
        return value;
      }),
    get progress() {
      return { pending: [...pending], requested, requestedBytes, settled, settledBytes };
    },
    resolve: async (path) => (await resolveCandidates(path)).urls,
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
      const texture = await cached("texture", path, async (url) => {
        if (options.texture !== undefined) return options.texture(url);
        // Compiled output carries the content-addressed extension: anything ending in .ktx2
        // goes through the shared KTX2 loader, everything else stays on TextureLoader.
        if (/\.ktx2$/iu.test(url)) {
          return loadCompiledKtx2(url);
        }
        if (typeof createImageBitmap === "function") {
          return loadBitmapTexture(url, options.renderer);
        }
        const { TextureLoader: Loader } = await import("three");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
