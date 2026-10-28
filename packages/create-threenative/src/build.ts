import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GLB_BUFFER, NodeIO } from "@gltf-transform/core";
import {
  TraceMap,
  decodedMappings,
  encodedMappings,
  originalPositionFor,
  sourceContentFor,
  traceSegment,
} from "@jridgewell/trace-mapping";
import { compileAssets } from "@threenative/assets";
import {
  KHR_DF_MODEL_ASTC,
  KHR_DF_TRANSFER_LINEAR,
  KHR_DF_TRANSFER_SRGB,
  KHR_SUPERCOMPRESSION_NONE,
  VK_FORMAT_ASTC_4x4_SRGB_BLOCK,
  VK_FORMAT_ASTC_4x4_UNORM_BLOCK,
  read as readKTX2,
} from "ktx-parse";
import { BUILD_REPORT_SUFFIX, measureTreeBytes, writeBuildReport } from "./buildReport.js";
import { writeCompressionSidecars } from "./compress.js";
import { type IResolvedThreeNativeConfig, loadConfig } from "./config.js";
import {
  type INativeCssFinding,
  describeNativeCssFindings,
  findNativeCssViolations,
} from "./native-css-compat.js";
import { webRuntimeDecoders } from "./web-engine.js";

export type BuildTarget = "android" | "desktop" | "ios" | "web";
type NativeBuildTarget = Exclude<BuildTarget, "web">;
/** PRD-212: a debug APK by default; release is an explicit request. */
export type BuildMode = "debug" | "release";
/** PRD-212: the Android artifact shape. An app bundle is only meaningful for a release. */
export type BuildFormat = "apk" | "aab";
export type NativeOrientation = IResolvedThreeNativeConfig["display"]["orientation"];

export interface IBuildOptions {
  cwd?: string;
  target: BuildTarget;
  allowSourceBuild?: boolean;
  /**
   * Android and desktop. Desktop `release` wraps the executable in a complete OS container;
   * omitted keeps the raw-binary debug behavior.
   */
  mode?: BuildMode;
  /** Android only. `aab` requires `mode: "release"`. */
  format?: BuildFormat;
  /** A `buildProfiles` name; wins over `buildProfiles.defaults[target]`. */
  profile?: string;
  viteArgs?: readonly string[];
}

const TARGETS: readonly BuildTarget[] = ["web", "desktop", "android", "ios"];
function projectRequire(cwd: string): NodeJS.Require {
  return createRequire(path.join(cwd, "package.json"));
}

function packageRoot(cwd: string, packageName: string): string {
  try {
    return path.dirname(projectRequire(cwd).resolve(`${packageName}/package.json`));
  } catch {
    throw new Error(`Cannot build because '${packageName}' is not installed in ${cwd}.`);
  }
}

async function run(command: string, args: readonly string[], cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} exited with code ${code ?? "unknown"}.`));
    });
  });
}

async function projectName(cwd: string): Promise<string> {
  const manifest = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8")) as {
    name?: string;
  };
  const name = manifest.name?.replace(/^@[^/]+\//u, "").replace(/[^a-zA-Z0-9._-]/gu, "-");
  if (name === undefined || name.length === 0) throw new Error("package.json must name the game.");
  return name;
}

export async function assertNativeBundleCompatible(
  bundle: string,
  target: NativeBuildTarget,
  capabilities = resolveRuntimeAssetCapabilities(target),
): Promise<void> {
  const source = await readFile(bundle, "utf8");
  const webOnlyUi = [
    ["React DOM", /\breact-dom(?:\/client)?\b|\bcreateRoot\s*\(/u],
    ["document.getElementById", /\bdocument\.getElementById\s*\(/u],
  ].filter(([, pattern]) => (pattern as RegExp).test(source));
  if (webOnlyUi.length > 0) {
    throw new Error(
      `TN_NATIVE_WEB_ONLY_UI: ${target} bundle contains ${webOnlyUi.map(([label]) => label).join(", ")}. Keep the portable game in src/game.ts and move DOM or React mounting to src/main.ts; native UI is owned by PRD-051.`,
    );
  }
  if (target === "desktop" && capabilities.webAssembly) return;
  // Android V8 has WebAssembly for its admitted decoders; Rapier and Recast stay on the native
  // backend there, so only the bare global is allowed.
  const wasm = [
    ...(capabilities.webAssembly ? [] : [["WebAssembly", /\bWebAssembly\b/u] as const]),
    ["Rapier WASM", /rapier_wasm|RAPIER_VERSION|rawrapier/u] as const,
    ["Recast WASM", /recast-navigation\.wasm|recastnavigationwasm/u] as const,
  ].filter(([, pattern]) => pattern.test(source));
  if (wasm.length === 0) return;
  throw new Error(
    `${target === "desktop" ? "TN_NATIVE_WASM_UNSUPPORTED" : "TN_NATIVE_WASM_ON_MOBILE"}: ${target} artifact ${capabilities.artifact} (${capabilities.engine}) bundle contains ${wasm.map(([label]) => label).join(", ")}. Move web-only WASM imports out of src/game.ts or provide a threenative-native conditional backend; mobile navigation is owned by PRD-052.`,
  );
}

/**
 * Refuse a web UI target before native packaging can silently discard its bundle. Android and iOS
 * own platform overlays, and the desktop overlay now ships its Windows (WebView2), macOS (WKWebView)
 * and Linux (X11/Wayland) backends behind the one ABI — proved by the hosted `windows-2025`/
 * `macos-15` starter lanes and the Linux session proofs. A host without one of those desktop window
 * systems still refuses rather than shipping a bundle nothing can render.
 */
export function assertNativeUiRendererCompatible(
  target: NativeBuildTarget,
  renderer: IResolvedThreeNativeConfig["ui"]["renderer"],
  platform: NodeJS.Platform = process.platform,
): void {
  // `native-css` runs on Linux desktop and Android (a runtime source build; the Android packager
  // refuses a prebuilt with TN_CSS_UI_HOST_MISSING) in this release: the hosts that have run its
  // fixtures. It is refused by name rather than silently downgraded to the WebView renderer: a
  // game that asked for no web view would get one.
  if (renderer === "native-css") {
    if (target === "android" || (target === "desktop" && platform === "linux")) return;
    const targetName =
      target === "desktop"
        ? `desktop on ${platform}`
        : `${target} (the CSS backend runs on Linux desktop and Android only)`;
    throw new Error(
      `TN_UI_RENDERER_UNSUPPORTED: ui.renderer is "native-css", which is supported on Linux desktop and Android only in this release; set ui.renderer to "native" or "web" for ${targetName}.`,
    );
  }
  if (renderer === "native" || target === "android" || target === "ios") return;
  if (
    target === "desktop" &&
    (platform === "linux" || platform === "darwin" || platform === "win32")
  ) {
    return;
  }
  const platformName =
    platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform;
  throw new Error(
    `TN_UI_RENDERER_UNSUPPORTED: ui.renderer is "web", but ${target} has no WebView host on ${platformName}. Set ui.renderer to "native" for ${target}.`,
  );
}

/** glTF extensions whose geometry only decodes through a WASM decoder. */
const COMPRESSED_MODEL_EXTENSIONS: readonly string[] = [
  "EXT_meshopt_compression",
  "KHR_draco_mesh_compression",
  "KHR_meshopt_compression",
];

function namedAssets(logicalPaths: readonly string[]): string {
  const shown = logicalPaths.slice(0, 3).join(", ");
  const rest = logicalPaths.length - 3;
  return rest > 0 ? `${shown} and ${rest} more` : shown;
}

/** The compiled asset root this project's config chose, resolved against the project directory. */
export function assetRoot(cwd: string, config: IResolvedThreeNativeConfig): string {
  return path.resolve(cwd, config.assets?.output ?? "public");
}

/** Structural package admission only; the cook owns decoded quality and the host checks GPU support. */
function isMobileRawAstc(bytes: Uint8Array, gltf = false): boolean {
  try {
    if (bytes.byteLength < 80) return false;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const width = view.getUint32(20, true);
    const height = view.getUint32(24, true);
    const count = view.getUint32(40, true);
    const indexEnd = 80 + count * 24;
    if (
      width === 0 ||
      height === 0 ||
      count !== Math.floor(Math.log2(Math.max(width, height))) + 1 ||
      indexEnd > bytes.byteLength
    )
      return false;
    // Bound descriptor parsing before handing untrusted bytes to the installed parser.
    const dfd = view.getUint32(48, true);
    const dfdLength = view.getUint32(52, true);
    if (
      dfd < indexEnd ||
      dfd % 4 !== 0 ||
      dfdLength !== 44 ||
      dfd + dfdLength > bytes.byteLength ||
      view.getUint32(dfd, true) !== dfdLength ||
      view.getUint16(dfd + 10, true) !== 40 ||
      view.getBigUint64(64, true) !== 0n ||
      view.getBigUint64(72, true) !== 0n
    )
      return false;
    const regions: [number, number][] = [
      [0, indexEnd],
      [dfd, dfd + dfdLength],
    ];
    const kvd = view.getUint32(56, true);
    const kvdLength = view.getUint32(60, true);
    if (kvdLength > 0) {
      if (kvd < indexEnd || kvd % 4 !== 0 || kvd + kvdLength > bytes.byteLength) return false;
      regions.push([kvd, kvd + kvdLength]);
    }
    for (let mip = 0; mip < count; mip += 1) {
      const offset = view.getBigUint64(80 + mip * 24, true);
      const expected =
        Math.ceil(Math.max(1, Math.floor(width / 2 ** mip)) / 4) *
        Math.ceil(Math.max(1, Math.floor(height / 2 ** mip)) / 4) *
        16;
      if (
        !Number.isSafeInteger(expected) ||
        view.getBigUint64(88 + mip * 24, true) !== BigInt(expected) ||
        view.getBigUint64(96 + mip * 24, true) !== BigInt(expected) ||
        offset % 16n !== 0n ||
        offset + BigInt(expected) > BigInt(bytes.byteLength)
      )
        return false;
      regions.push([Number(offset), Number(offset) + expected]);
    }
    regions.sort((a, b) => a[0] - b[0]);
    if (regions.some(([start], i) => i > 0 && start < (regions[i - 1]?.[1] ?? 0))) return false;
    const container = readKTX2(bytes);
    const descriptor = container.dataFormatDescriptor[0];
    const sample = descriptor?.samples[0];
    return (
      [VK_FORMAT_ASTC_4x4_UNORM_BLOCK, VK_FORMAT_ASTC_4x4_SRGB_BLOCK].includes(
        container.vkFormat,
      ) &&
      container.typeSize === 1 &&
      container.pixelDepth === 0 &&
      container.layerCount === 0 &&
      container.faceCount === 1 &&
      container.supercompressionScheme === KHR_SUPERCOMPRESSION_NONE &&
      container.globalData === null &&
      container.levelCount === count &&
      container.levels.length === count &&
      container.dataFormatDescriptor.length === 1 &&
      descriptor?.vendorId === 0 &&
      descriptor.descriptorType === 0 &&
      descriptor.versionNumber === 2 &&
      descriptor.colorModel === KHR_DF_MODEL_ASTC &&
      (descriptor.flags === 0 || descriptor.flags === 1) &&
      (!gltf ||
        (descriptor.flags === 0 &&
          descriptor.colorPrimaries ===
            (container.vkFormat === VK_FORMAT_ASTC_4x4_SRGB_BLOCK ? 1 : 0) &&
          (container.keyValue.KTXorientation === undefined ||
            container.keyValue.KTXorientation === "rd"))) &&
      descriptor.transferFunction ===
        (container.vkFormat === VK_FORMAT_ASTC_4x4_SRGB_BLOCK
          ? KHR_DF_TRANSFER_SRGB
          : KHR_DF_TRANSFER_LINEAR) &&
      descriptor.texelBlockDimension.join() === "3,3,0,0" &&
      descriptor.bytesPlane.join() === "16,0,0,0,0,0,0,0" &&
      descriptor.samples.length === 1 &&
      sample?.bitOffset === 0 &&
      sample.bitLength === 127 &&
      sample.channelType === 0 &&
      sample.samplePosition.join() === "0,0,0,0" &&
      sample.sampleLower === 0 &&
      sample.sampleUpper === 0xffffffff
    );
  } catch {
    return false;
  }
}

/** NodeIO resolves GLB, external and data resources; every filesystem read stays in the cook root. */
class CompiledModelIO extends NodeIO {
  constructor(
    private readonly outputRoot: string,
    private readonly canonicalRoot: string,
  ) {
    super();
    this.setAllowNetwork(false);
  }
  protected override readURI(uri: string, type: "view"): Promise<Uint8Array<ArrayBuffer>>;
  protected override readURI(uri: string, type: "text"): Promise<string>;
  protected override async readURI(
    uri: string,
    type: "view" | "text",
  ): Promise<Uint8Array<ArrayBuffer> | string> {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(uri))
      throw new Error("External resource protocols are forbidden.");
    const resolved = path.resolve(uri);
    const relative = path.relative(this.outputRoot, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("Model resource escapes the compiled root.");
    const canonical = await realpath(resolved);
    const realRelative = path.relative(this.canonicalRoot, canonical);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    )
      throw new Error("Model resource escapes the compiled root through a symlink.");
    return type === "text" ? readFile(canonical, "utf8") : readFile(canonical);
  }
}

/** Inspect actual model images and extension ownership without loading a decoder or scene graph. */
async function inspectMobileModel(outputRoot: string, output: string): Promise<string[]> {
  const io = new CompiledModelIO(outputRoot, await realpath(outputRoot));
  const { json, resources } = await io.readAsJSON(path.resolve(outputRoot, output));
  const extensions = new Set([...(json.extensionsUsed ?? []), ...(json.extensionsRequired ?? [])]);
  for (const view of json.bufferViews ?? [])
    for (const name of Object.keys(view.extensions ?? {})) extensions.add(name);
  for (const mesh of json.meshes ?? [])
    for (const primitive of mesh.primitives)
      for (const name of Object.keys(primitive.extensions ?? {})) extensions.add(name);
  if (extensions.has("KHR_texture_basisu"))
    throw new Error("Basis model textures require a decoder.");
  const astcImages = new Set<number>();
  for (const texture of json.textures ?? []) {
    if (texture.extensions?.KHR_texture_basisu !== undefined)
      throw new Error("Basis texture ownership is forbidden.");
    const astc = texture.extensions?.EXT_texture_astc as { source?: number } | undefined;
    if (astc === undefined) continue;
    if (
      !Number.isSafeInteger(astc.source) ||
      !json.images?.[astc.source ?? -1] ||
      texture.source !== undefined
    )
      throw new Error("Invalid ASTC source or unsupported paired fallback.");
    astcImages.add(astc.source as number);
  }
  const hasAstcImages = astcImages.size > 0;
  if (
    extensions.has("EXT_texture_astc") !== hasAstcImages ||
    (hasAstcImages &&
      (!(json.extensionsUsed ?? []).includes("EXT_texture_astc") ||
        !(json.extensionsRequired ?? []).includes("EXT_texture_astc")))
  )
    throw new Error("ASTC model extension membership is inconsistent.");
  for (const [index, image] of (json.images ?? []).entries()) {
    let bytes: Uint8Array | undefined;
    if (typeof image.uri === "string") bytes = resources[image.uri];
    else {
      if (!Number.isSafeInteger(image.bufferView) || (image.bufferView ?? -1) < 0)
        throw new Error("Invalid model image bufferView index.");
      const view = json.bufferViews?.[image.bufferView ?? -1];
      const buffer = json.buffers?.[view?.buffer ?? -1];
      const resource = buffer === undefined ? undefined : resources[buffer.uri ?? GLB_BUFFER];
      const offset = view?.byteOffset ?? 0;
      const length = view?.byteLength;
      if (
        !view ||
        !buffer ||
        !resource ||
        !Number.isSafeInteger(view.buffer) ||
        (buffer.uri === undefined && view.buffer !== 0) ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(length) ||
        (length ?? 0) <= 0 ||
        !Number.isSafeInteger(buffer.byteLength) ||
        offset + (length ?? 0) > buffer.byteLength ||
        offset + (length ?? 0) > resource.byteLength
      )
        throw new Error("Invalid model image buffer bounds.");
      bytes = resource.subarray(offset, offset + (length as number));
    }
    if (!bytes || bytes.byteLength === 0) throw new Error("Missing model image payload.");
    const isKtx =
      image.mimeType === "image/ktx2" ||
      Buffer.from(bytes.subarray(0, 12)).equals(Buffer.from("ab4b5458203230bb0d0a1a0a", "hex"));
    if (astcImages.has(index) || isKtx) {
      if (
        !astcImages.has(index) ||
        image.mimeType !== "image/ktx2" ||
        !isMobileRawAstc(bytes, true) ||
        (json.textures ?? []).some((texture) => texture.source === index)
      )
        throw new Error("Model KTX2 must be valid raw ASTC owned by EXT_texture_astc.");
    }
  }
  return [...extensions];
}

/** Only files in the compiled root can qualify for the mobile raw-ASTC exception. */
async function isCompiledMobileAstc(outputRoot: string, output: string): Promise<boolean> {
  const resolved = path.resolve(outputRoot, output);
  const relative = path.relative(outputRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return false;
  try {
    const canonicalRoot = await realpath(outputRoot);
    const canonical = await realpath(resolved);
    const realRelative = path.relative(canonicalRoot, canonical);
    if (
      realRelative === ".." ||
      realRelative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(realRelative)
    )
      return false;
    return isMobileRawAstc(await readFile(canonical));
  } catch {
    return false;
  }
}

/** Refuse compiled codecs the selected runtime/bundle cannot decode before packaging starts. */
export async function assertNativeAssetsCompatible(
  cwd: string,
  target: BuildTarget,
  config: IResolvedThreeNativeConfig,
  capabilities = resolveRuntimeAssetCapabilities(target),
): Promise<void> {
  if (target === "web") return;
  const outputRoot = assetRoot(cwd, config);
  const manifestPath = path.join(outputRoot, "assets.manifest.json");
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `TN_NATIVE_ASSET_MANIFEST_INVALID: '${manifestPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
    throw new Error(`TN_NATIVE_ASSET_MANIFEST_INVALID: '${manifestPath}' has no 'entries' object.`);
  }
  const rows = Object.entries(entries as Record<string, unknown>).map(
    ([logical, entry]) => [logical, (entry ?? {}) as Record<string, unknown>] as const,
  );
  if (!capabilities.decoders.ktx2 && (target === "android" || target === "ios")) {
    for (const [logical, entry] of rows) {
      if (
        typeof entry.output !== "string" ||
        !(entry.kind === "model" || /\.gl(?:b|tf)$/iu.test(entry.output))
      )
        continue;
      try {
        const actual = await inspectMobileModel(outputRoot, entry.output);
        entry.extensions = [
          ...new Set([...(Array.isArray(entry.extensions) ? entry.extensions : []), ...actual]),
        ];
      } catch (error) {
        throw new Error(
          `TN_NATIVE_KTX2_UNSUPPORTED: ${target} cannot admit model '${logical}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  const ktx2Rows = rows.filter(
    ([, entry]) =>
      (typeof entry.output === "string" && /\.ktx2$/iu.test(entry.output)) ||
      (Array.isArray(entry.extensions) && entry.extensions.includes("KHR_texture_basisu")) ||
      (Array.isArray(entry.sharedImages) &&
        entry.sharedImages.some(
          (image) =>
            image !== null &&
            typeof image === "object" &&
            typeof image.output === "string" &&
            /\.ktx2$/iu.test(image.output),
        )),
  );
  const ktx2: string[] = [];
  for (const [logical, entry] of ktx2Rows) {
    if (
      !capabilities.decoders.ktx2 &&
      (target === "android" || target === "ios") &&
      !(Array.isArray(entry.extensions) && entry.extensions.includes("KHR_texture_basisu"))
    ) {
      const outputs = [
        ...(typeof entry.output === "string" && /\.ktx2$/iu.test(entry.output)
          ? [entry.output]
          : []),
        ...(Array.isArray(entry.sharedImages)
          ? entry.sharedImages.flatMap((image) =>
              image !== null &&
              typeof image === "object" &&
              typeof image.output === "string" &&
              /\.ktx2$/iu.test(image.output)
                ? [image.output as string]
                : [],
            )
          : []),
      ];
      if (
        outputs.length > 0 &&
        (
          await Promise.all(outputs.map((output) => isCompiledMobileAstc(outputRoot, output)))
        ).every(Boolean)
      )
        continue;
    }
    ktx2.push(logical);
  }
  if (!capabilities.decoders.ktx2 && ktx2.length > 0) {
    throw new Error(
      `TN_NATIVE_KTX2_UNSUPPORTED: ${target} cannot ship compiled KTX2 textures (${namedAssets(ktx2)}). Selected artifact ${capabilities.artifact} (${capabilities.engine}) has no admitted Basis/KTX2 decoder in its bundle. Replace or transcode the authored KTX2 source for ${target === "desktop" ? "this runtime" : "mobile"}, or exclude it from ${target === "desktop" ? "this runtime's" : "mobile"} builds; keep compressed textures on the web target.`,
    );
  }
  const compressedModels = rows
    .filter(([, entry]) =>
      (Array.isArray(entry.extensions) ? (entry.extensions as unknown[]) : []).some(
        (extension) =>
          typeof extension === "string" &&
          COMPRESSED_MODEL_EXTENSIONS.includes(extension) &&
          !capabilities.decoders[extension === "KHR_draco_mesh_compression" ? "draco" : "meshopt"],
      ),
    )
    .map(([logical]) => logical);
  if (compressedModels.length > 0) {
    throw new Error(
      `TN_NATIVE_MESH_COMPRESSION_UNSUPPORTED: ${target} cannot ship compressed model geometry (${namedAssets(compressedModels)}). Selected artifact ${capabilities.artifact} (${capabilities.engine}) has no admitted ${rows.flatMap(([, entry]) => (Array.isArray(entry.extensions) ? entry.extensions.filter((extension) => COMPRESSED_MODEL_EXTENSIONS.includes(String(extension))) : [])).join(", ")} decoder in its bundle. Native compilation keeps shared images and decoder-free model rewrites while omitting Meshopt output; rebuild the native target, or keep compressed models on the web target.`,
    );
  }
}

/** Which representation a build is cooking, and whether the flag or the project's default chose it. */
function announceProfile(config: IResolvedThreeNativeConfig): void {
  const selected = config.buildProfile;
  if (selected === undefined) return;
  process.stdout.write(
    `threenative build: profile ${selected.name} (${selected.source}) for ${selected.target}\n`,
  );
}

/** The one UI entry every target mounts. Convention, not configuration. */
const UI_ENTRY = path.join("src", "ui", "main.tsx");
/**
 * The generated entry page, written into the Vite root rather than under `.threenative/build/`.
 *
 * Vite emits an entry HTML at the same path *inside* `outDir` that it had inside the root, and
 * `base: "./"` writes every asset link relative to that path. A page generated two directories
 * deep came out with `../../assets/index.js`, which was correct where Vite put it and wrong the
 * moment the file was moved to the output root — nothing rewrites the links. Served from `/ui/`,
 * the web view then asked for `/assets/index.js`, outside the handler that serves the UI, and
 * rendered a blank page over the game: on a screenshot, a game whose HUD code is broken.
 *
 * Keeping the page in the root makes the emitted path the output root, so the rename below is
 * within one directory and `./assets/...` keeps resolving.
 */
const UI_PAGE_PREFIX = ".threenative-ui-";

/**
 * Build `src/ui/` on its own, for the platform's web view to load.
 *
 * The page is UI only: no scene, no simulation, no render path. It is built through the
 * project's own Vite config so the game's Tailwind, PostCSS, aliases and plugins apply exactly
 * as they do on the web target — that equivalence is the whole point, and re-deriving the
 * toolchain here would be a second build that drifts from the first.
 *
 * The generated entry lives under `.threenative/build/` and the Vite root stays the project, so
 * `/src/ui/main.tsx` resolves the same way it does in `index.html`.
 */
export async function buildUi(cwd: string, config: IResolvedThreeNativeConfig): Promise<string> {
  const output = path.join(cwd, ".threenative", "build", "ui");
  const entry = path.join(cwd, UI_ENTRY);
  try {
    if (!(await stat(entry)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(
      `TN_UI_ENTRY_MISSING: ui.renderer is "${config.ui.renderer}" but ${UI_ENTRY} does not exist. It is the entry every platform's web view loads, and the file the native-css renderer imports its stylesheet from; create it, or set ui.renderer to "native".`,
    );
  }
  const buildRoot = path.join(cwd, ".threenative", "build");
  await mkdir(buildRoot, { recursive: true });
  const page = path.join(cwd, `${UI_PAGE_PREFIX}${randomUUID()}.html`);
  // `viewport-fit=cover` so the UI can reach under a display cutout, and a transparent body so
  // the game surface underneath is what shows through everywhere the UI does not draw.
  await writeFile(
    page,
    [
      "<!doctype html>",
      '<html lang="en">',
      "  <head>",
      '    <meta charset="utf-8" />',
      '    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />',
      "    <style>html,body,#tn-ui{margin:0;height:100%;background:transparent}</style>",
      "  </head>",
      "  <body>",
      '    <div id="tn-ui"></div>',
      `    <script type="module" src="/${UI_ENTRY.split(path.sep).join("/")}"></script>`,
      "  </body>",
      "</html>",
    ].join("\n"),
  );
  const driver = path.join(buildRoot, "build-ui.mjs");
  await writeFile(driver, uiBuildDriver(cwd, page, output, config.ui.renderer === "native-css"));
  try {
    await run(process.execPath, [driver], cwd);
  } finally {
    await rm(page, { force: true });
  }
  const generatedPage = path.join(output, path.basename(page));
  const index = path.join(output, "index.html");
  await rename(generatedPage, index);
  return output;
}

/**
 * Copy just the stylesheets out of a built `src/ui/` into a flat directory the native CSS engine
 * reads, dropping the HTML and the JS of the web page — and copying the fonts and images those
 * stylesheets name, because the engine serves those by file name out of the same directory and has
 * no other source of bytes. Emitted adjacent `*.css.map` sidecars retain their original bytes.
 *
 * CSS and its emitted map sidecars, wherever Vite put them (`assets/index-<hash>.css`), copy flat
 * under their own names so the packaged `ui/` carries no page and no bundle. The previous contents go first
 * through `mkdir` on a directory that must be gone, so a stale stylesheet from a previous build
 * can never be packaged beside the new one.
 */
export async function extractUiStylesheets(
  uiDir: string,
  outDir: string,
  projectRoot?: string,
): Promise<string[]> {
  await rm(outDir, { force: true, recursive: true });
  await mkdir(outDir);
  const stylesheets: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile() && /\.css$/iu.test(entry.name)) stylesheets.push(child);
    }
  };
  await walk(uiDir);
  if (stylesheets.length === 0) {
    throw new Error(
      "TN_CSS_UI_NO_STYLESHEET: the UI build emitted no .css; import your stylesheet from src/ui/main.tsx",
    );
  }
  // Sorted so two builds of one game stage the same names in the same order.
  let sheets = stylesheets.sort();
  const sheetNames = new Set<string>();
  for (const file of sheets) {
    const name = path.basename(file);
    if (sheetNames.has(name)) {
      throw new Error(
        `TN_CSS_UI_STYLESHEET_AMBIGUOUS: ${file} emits ${name}, which another stylesheet already claimed`,
      );
    }
    sheetNames.add(name);
  }
  const assets = new Map<string, string>();
  // Resolved before anything is staged: a build that cannot ship its font must not leave half a
  // `ui/` behind for the packager to find and a player to run.
  const findings: INativeCssFinding[] = [];
  for (const file of sheets) {
    const css = await readFile(file, "utf8");
    await collectStylesheetAssets(uiDir, file, css, assets, projectRoot);
    findings.push(...(await locateNativeCssViolations(uiDir, file, css, projectRoot)));
  }
  // Raster images the UI build emitted: an image imported from JSX is referenced by the bundle, not
  // by any stylesheet, so nothing above names it. They sit in Vite's `assets/`, and stage flat by
  // name like the CSS-referenced files; the engine resolves `assets/<name>` to that name.
  const emitted = path.join(uiDir, "assets");
  if (existsSync(emitted)) {
    for (const entry of await readdir(emitted, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(png|jpe?g|webp|gif)$/iu.test(entry.name)) continue;
      const source = path.join(emitted, entry.name);
      const claimed = assets.get(entry.name);
      if (claimed !== undefined && claimed !== source) {
        throw new Error(
          `TN_CSS_UI_ASSET_AMBIGUOUS: ${source} and ${path.relative(uiDir, claimed)} would both ship as ${entry.name}`,
        );
      }
      assets.set(entry.name, source);
    }
  }
  // The report is written even when clean, so "no findings" is something a build produced rather
  // than the absence of a check; a failure names every finding, not just the first.
  await writeFile(
    path.join(path.dirname(outDir), "native-css-compat.json"),
    `${JSON.stringify({ profile: "core", findings }, null, 2)}\n`,
  );
  if (findings.length > 0) {
    throw new Error(
      `TN_CSS_UI_UNSUPPORTED_CSS: ${findings.length} active rule(s) outside the native-css Core profile (docs/guides/native-css-support.md):\n${describeNativeCssFindings(findings)}`,
    );
  }
  // Vite's entry/import graph carries the browser's stylesheet order. Hashed filenames do not.
  // Older hand-staged directories have no manifest and retain their alphabetical load contract.
  let order: { version: number; stylesheets: string[] } | undefined;
  const manifestFile = path.join(uiDir, ".vite", "manifest.json");
  if (existsSync(manifestFile)) {
    const manifest: Record<
      string,
      { isEntry?: boolean; src?: string; file?: string; imports?: string[]; css?: string[] }
    > = JSON.parse(await readFile(manifestFile, "utf8"));
    const entries = Object.keys(manifest).filter(
      (key) =>
        manifest[key]?.isEntry &&
        path.basename(manifest[key]?.src ?? "").startsWith(UI_PAGE_PREFIX),
    );
    if (entries.length !== 1)
      throw new Error("TN_CSS_UI_STYLESHEET_ORDER: the UI manifest must name exactly one UI entry");
    const visited = new Set<string>();
    const ordered = new Set<string>();
    const visit = (key: string): void => {
      if (visited.has(key)) return;
      visited.add(key);
      const chunk = manifest[key];
      if (chunk === undefined)
        throw new Error(`TN_CSS_UI_STYLESHEET_ORDER: missing manifest chunk ${key}`);
      for (const imported of chunk.imports ?? []) visit(imported);
      for (const css of chunk.css ?? []) {
        const file = path.resolve(uiDir, css);
        if (!stylesheets.includes(file))
          throw new Error(`TN_CSS_UI_STYLESHEET_ORDER: missing emitted stylesheet ${css}`);
        ordered.add(file);
      }
    };
    visit(entries[0] as string);
    // With cssCodeSplit:false Vite emits its one global stylesheet as a standalone manifest
    // asset, and injects that asset into every HTML entry rather than attaching it to a chunk.
    const globalCss = manifest["style.css"]?.file;
    if (ordered.size === 0 && sheets.length === 1 && globalCss !== undefined) {
      const file = path.resolve(uiDir, globalCss);
      if (sheets[0] === file) ordered.add(file);
    }
    const inactive = sheets.filter((file) => !ordered.has(file));
    if (inactive.length > 0)
      throw new Error(
        `TN_CSS_UI_LAZY_STYLESHEET_UNSUPPORTED: ${inactive.map((file) => path.relative(uiDir, file)).join(", ")} is not loaded by the UI entry; import native-css styles statically from src/ui/main.tsx`,
      );
    sheets = [...ordered];
    order = { version: 1, stylesheets: sheets.map((file) => path.basename(file)) };
  }
  for (const file of sheets) {
    await copyFile(file, path.join(outDir, path.basename(file)));
    // Preserve emitted sidecars and the stylesheet's sourceMappingURL without rewriting either.
    const sourceMap = `${file}.map`;
    if (existsSync(sourceMap)) {
      await copyFile(sourceMap, path.join(outDir, path.basename(sourceMap)));
    }
  }
  // Flat, because the engine looks an asset up by name: two files of one name cannot both travel,
  // and silently shipping the wrong one is the failure this refuses.
  for (const [name, source] of assets) {
    await copyFile(source, path.join(outDir, name));
  }
  if (order !== undefined)
    await writeFile(path.join(outDir, "stylesheets.json"), `${JSON.stringify(order)}\n`);
  return readdir(outDir);
}

/**
 * The fonts and images a stylesheet names, keyed by the flat name the engine serves them under.
 *
 * `url()` is the only reach in CSS. A `data:` URI, a `#fragment` and the empty string resolve
 * without a file, so they are left alone; a relative name is a file in the build, which travels
 * beside its stylesheet. Anything else — a scheme, a protocol-relative or absolute path, a `../`
 * out of the build, or a relative name no file answers to — fails the build here rather than
 * shipping a HUD whose font silently fell back to the machine's.
 */
async function collectStylesheetAssets(
  build: string,
  file: string,
  css: string,
  assets: Map<string, string>,
  projectRoot?: string,
): Promise<void> {
  // Mask comments without moving UTF-16 offsets: maps refer to the emitted CSS, not this scan.
  const source = css.replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) =>
    comment.replaceAll(/[^\r\n]/g, " "),
  );
  for (const match of source.matchAll(/url\(([^)]*)\)/giu)) {
    const target = (match[1] ?? "")
      .trim()
      .replace(/^["']|["']$/gu, "")
      .trim();
    if (target === "" || target.startsWith("data:") || target.startsWith("#")) continue;
    try {
      const resolved = resolveStylesheetAsset(build, file, target);
      const name = path.basename(resolved);
      const claimed = assets.get(name);
      if (claimed !== undefined && claimed !== resolved) {
        throw new Error(
          `TN_CSS_UI_ASSET_AMBIGUOUS: ${file} references ${target} as ${name}, which ${path.relative(build, claimed)} already claimed`,
        );
      }
      assets.set(name, resolved);
    } catch (error) {
      if (
        error instanceof Error &&
        /^TN_CSS_UI_ASSET_(?:UNSUPPORTED|AMBIGUOUS):/u.test(error.message)
      ) {
        error.message += await stylesheetAssetLocation(
          build,
          file,
          css,
          match.index,
          target,
          projectRoot,
        );
      }
      throw error;
    }
  }
}

/** Where one emitted position came from, once a verified map has proven it. */
interface IAuthoredLocation {
  /** The authored file, realpath'd. */
  readonly file: string;
  /** The same file as the project-relative path a diagnostic names. */
  readonly source: string;
  readonly line: number;
  /** As the map records it: 0-based. */
  readonly column: number;
}

/**
 * The verified provenance of one emitted stylesheet, or undefined when there is none to trust.
 *
 * One map, one consumer cache, one set of refusals: the `.css.map` sidecar has to be the one the
 * emitted stylesheet itself links, has to carry the bytes of the authored file still on disk, and
 * has to hold complete canonical VLQ tuples before a single authored coordinate is read out of it.
 * A stylesheet without that sidecar, or with one that fails any check, maps nothing — the
 * diagnostics that want provenance keep their generated positions instead.
 */
async function stylesheetTraceMap(
  build: string,
  file: string,
  css: string,
): Promise<TraceMap | undefined> {
  try {
    const links = [...css.matchAll(/\/\*[#@]\s*sourceMappingURL\s*=\s*([^*]*?)\*\//gu)];
    if (links.length !== 1 || links[0]?.[1]?.trim() !== `${path.basename(file)}.map`)
      return undefined;
    const [root, mapFile] = await Promise.all([realpath(build), realpath(`${file}.map`)]);
    const inside = path.relative(root, mapFile);
    if (
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${path.sep}`) ||
      path.isAbsolute(inside)
    )
      return undefined;
    const serialized = await readFile(mapFile, "utf8");
    const raw = JSON.parse(serialized);
    if (
      raw.version !== 3 ||
      // ECMA-426 permits an omitted file; the CSS annotation already identifies this sidecar.
      (raw.file !== undefined && raw.file !== path.basename(file)) ||
      typeof raw.mappings !== "string" ||
      !/^[A-Za-z0-9+/;,]*$/u.test(raw.mappings) ||
      !Array.isArray(raw.sources) ||
      !raw.sources.every((source: unknown) => typeof source === "string") ||
      !Array.isArray(raw.names) ||
      !raw.names.every((name: unknown) => typeof name === "string") ||
      (raw.sourceRoot !== undefined && typeof raw.sourceRoot !== "string") ||
      !Array.isArray(raw.sourcesContent) ||
      raw.sourcesContent.length !== raw.sources.length ||
      !raw.sourcesContent.every(
        (content: unknown) => content === null || typeof content === "string",
      )
    )
      return undefined;
    // Parse the string so untrusted JSON cannot impersonate the consumer's private cache.
    const map = new TraceMap(serialized, pathToFileURL(`${file}.map`).href);
    const mappings = decodedMappings(map);
    // The decoder accepts truncated VLQ tuples. Re-encode through a fresh consumer to require
    // complete canonical tuples before trusting any authored coordinates.
    const canonical = encodedMappings(
      new TraceMap({ version: 3, names: map.names, sources: map.sources, mappings }),
    );
    if (canonical !== raw.mappings) return undefined;
    if (new Set(map.resolvedSources).size !== map.sources.length) return undefined;
    return map;
  } catch {
    return undefined;
  }
}

/**
 * The authored position of a generated one, or undefined when the map does not place it.
 *
 * A generated position with no segment on its line names nothing; one with segments takes the
 * nearest preceding anchor, which is the source-map meaning of that position and the authored rule
 * the emitted declaration came from.
 */
async function authoredStylesheetLocation(
  map: TraceMap,
  projectRoot: string,
  line: number,
  column: number,
): Promise<IAuthoredLocation | undefined> {
  try {
    const original = originalPositionFor(map, { line, column });
    if (typeof original.source !== "string" || original.line === null || original.column === null)
      return undefined;
    const sourceURL = new URL(original.source);
    if (sourceURL.protocol !== "file:") return undefined;
    const [project, authoredFile] = await Promise.all([
      realpath(projectRoot),
      realpath(fileURLToPath(sourceURL)),
    ]);
    const source = path.relative(project, authoredFile);
    if (
      source === "" ||
      source === ".." ||
      source.startsWith(`..${path.sep}`) ||
      path.isAbsolute(source)
    )
      return undefined;
    const content = sourceContentFor(map, original.source);
    if (typeof content !== "string" || content !== (await readFile(authoredFile, "utf8")))
      return undefined;
    return { file: authoredFile, source, line: original.line, column: original.column };
  } catch {
    return undefined;
  }
}

/** The `file:line:column` string every diagnostic and the report share. */
function authoredLocationString(location: IAuthoredLocation): string {
  return `${location.source}:${location.line}:${location.column + 1}`;
}

/**
 * Every Core-profile violation in an emitted stylesheet, each carrying the authored
 * `file:line:column` the stylesheet's own verified map proves.
 *
 * The generated position stays either way: it is what a build without a map, or with a map it
 * cannot verify, has to say.
 */
async function locateNativeCssViolations(
  build: string,
  file: string,
  css: string,
  projectRoot?: string,
): Promise<INativeCssFinding[]> {
  const found = findNativeCssViolations(path.relative(build, file), css);
  if (projectRoot === undefined || found.length === 0) return found;
  const map = await stylesheetTraceMap(build, file, css);
  if (map === undefined) return found;
  return Promise.all(
    found.map(async (finding) => {
      const authored = await authoredStylesheetLocation(
        map,
        projectRoot,
        finding.line,
        // A finding counts columns from 1; a map records them from 0.
        finding.column - 1,
      );
      return authored === undefined
        ? finding
        : { ...finding, authored: authoredLocationString(authored) };
    }),
  );
}

/** Read provenance only for an existing refusal; a bad map must never replace that refusal. */
async function stylesheetAssetLocation(
  build: string,
  file: string,
  css: string,
  offset: number,
  target: string,
  projectRoot?: string,
): Promise<string> {
  const before = css.slice(0, offset);
  const line = before.split("\n").length;
  const column = offset - before.lastIndexOf("\n") - 1;
  const generated = `\n  generated: ${file}:${line}:${column + 1}`;
  if (projectRoot === undefined) return generated;
  try {
    const map = await stylesheetTraceMap(build, file, css);
    if (map === undefined) return generated;
    const segment = traceSegment(map, line - 1, column);
    // A nearest declaration is not the exact authored URL. Duplicate anchors are ambiguous.
    if (
      segment === null ||
      (segment.length !== 4 && segment.length !== 5) ||
      segment[0] !== column ||
      !segment.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      (decodedMappings(map)[line - 1] ?? []).filter((entry) => entry[0] === column).length !== 1
    )
      return generated;
    const authored = await authoredStylesheetLocation(map, projectRoot, line, column);
    if (authored === undefined) return generated;
    const authoredLine = (await readFile(authored.file, "utf8"))
      .replaceAll(/\/\*[\s\S]*?\*\//gu, (comment) => comment.replaceAll(/[^\r\n]/g, " "))
      .split(/\r?\n/u)[authored.line - 1];
    const authoredURL = authoredLine?.slice(authored.column).match(/^url\(([^)]*)\)/iu);
    // A stale or mismatched map is not provenance for this refusal. Rewritten URLs safely retain
    // generated-only diagnostics until a producer can establish their asset identity.
    if (
      authoredURL === null ||
      authoredURL === undefined ||
      (authoredURL[1] ?? "")
        .trim()
        .replace(/^["']|["']$/gu, "")
        .trim() !== target
    )
      return generated;
    return `${generated}\n  authored: ${authoredLocationString(authored)}`;
  } catch {
    return generated;
  }
}

/** The file in `build` that a stylesheet's `url()` names, or the reason there is none. */
function resolveStylesheetAsset(build: string, file: string, target: string): string {
  const offMachine = "only a file inside the UI build ships with it";
  const refuse = (why: string): never => {
    throw new Error(`TN_CSS_UI_ASSET_UNSUPPORTED: ${file} references ${target}; ${why}`);
  };
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target) || target.startsWith("//")) return refuse(offMachine);
  if (path.isAbsolute(target)) return refuse(offMachine);
  const resolved = path.resolve(path.dirname(file), target);
  // A `../` that stays inside the build is how a stylesheet in `assets/` reaches its own assets;
  // one that leaves it is a reach off the machine.
  const inside = path.relative(build, resolved);
  if (inside === "" || inside.startsWith("..") || path.isAbsolute(inside)) {
    return refuse(offMachine);
  }
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    return refuse(`the UI build holds no ${target}`);
  }
  return resolved;
}

/**
 * Vite's Node API rather than its CLI, because the CLI cannot point a build at an entry HTML
 * outside the project's own `index.html` without a config file — and a hand-written config file
 * would be a second copy of the game's, which is the drift this avoids.
 */
function uiBuildDriver(cwd: string, page: string, output: string, cssSourcemaps = false): string {
  const literal = (value: string): string => JSON.stringify(value);
  return `${[
    'import { build, loadConfigFromFile, mergeConfig } from "vite";',
    "",
    `const root = ${literal(cwd)};`,
    `const loaded = await loadConfigFromFile({ command: "build", mode: "production" }, undefined, root);`,
    "const config = mergeConfig(loaded?.config ?? {}, {",
    "    root,",
    '    base: "./",',
    // The UI is a HUD page, not the game: it must not carry the game's `public/`. Vite copies
    // `publicDir` into every build it runs, and this output is packaged *beside* the game's own
    // assets — so every model, texture and sound shipped twice. One game's APK came to 361 MB, of
    // which 97.6 MB was a second copy of its own 97.3 MB asset directory, six copies of one 11 MB
    // weapon among them. Nothing in `src/ui/` reads those files; it reaches the game through
    // published state and intents.
    "    publicDir: false,",
    // One React, one ReactDOM, whatever the import graph looks like. The UI entry resolves its
    // peers beside the game while a linked package — `@threenative/ui`, or anything else pnpm
    // symlinks in — resolves the same bare specifiers beside itself, so a hook-owning package
    // installed outside the project brings a second physical copy into the bundle. React's
    // dispatcher lives in module state, so the copy the entry did not mount reads null and the
    // first `useState` on the phone throws `Cannot read properties of null`. `mergeConfig`
    // concatenates arrays, so a project that deduped its own packages keeps every one of them.
    '    resolve: { dedupe: ["react", "react-dom"] },',
    // Native CSS diagnostics consume adjacent maps linked by the emitted stylesheet.
    ...(cssSourcemaps ? ["    css: { devSourcemap: true, emitSourcemap: true },"] : []),
    "    build: {",
    ...(cssSourcemaps ? ["      sourcemap: true,", "      manifest: true,"] : []),
    `      outDir: ${literal(output)},`,
    "      emptyOutDir: true,",
    `      rollupOptions: { input: { index: ${literal(page)} } },`,
    "    },",
    "});",
    // Set, not merged: `mergeConfig` merges `input` objects, so a project that names its own pages
    // (a worker kit's `index.html` and `main.html`) bundled the whole game into the HUD build.
    // Vite 8 reads `rolldownOptions` and keeps `rollupOptions` as its alias.
    "for (const options of [config.build.rollupOptions, config.build.rolldownOptions])",
    `  if (options) options.input = { index: ${literal(page)} };`,
    // The config is loaded above; a second load from the file would merge its `input` back in.
    "await build({ ...config, configFile: false });",
  ].join("\n")}\n`;
}

export async function buildWeb(
  cwd: string,
  viteArgs: readonly string[] = [],
  profile?: string,
): Promise<void> {
  const config = await loadConfig(cwd, { target: "web", profile });
  announceProfile(config);
  // The Wasm engine's glTF loader takes neither Meshopt nor KTX2, so its web cook is decoder-free.
  await compileAssets({
    config: config.assets,
    cwd,
    platform: "web",
    runtimeDecoders: webRuntimeDecoders(config),
    ...(config.engine !== "threejs" && { runtimeIdentity: "web:native-engine" }),
  });
  const assets = assetRoot(cwd, config);
  // Vite empties and rewrites its outDir in place, so a build that dies half-way through leaves a
  // truncated `dist` where a working one used to be — the same failure a native artifact had, and
  // the same repair. Vite is handed a staging sibling, every post-step runs against it, and only a
  // finished build publishes. Nothing the UI adds lands here: the web view is part of this one
  // Vite build through `index.html`, and `buildUi`'s own output is native packaging's, under
  // `.threenative/build/ui`.
  const outDir = path.resolve(cwd, viteOutDir(viteArgs));
  const staging = stagingPath(outDir);
  const driver = path.join(cwd, ".threenative", "build", "vite.web.mjs");
  try {
    await mkdir(path.dirname(staging), { recursive: true });
    await mkdir(path.dirname(driver), { recursive: true });
    const native = config.engine === "threenative";
    const configIndex = viteArgs.findIndex(
      (arg) => arg === "--config" || arg.startsWith("--config="),
    );
    const configArg = configIndex === -1 ? undefined : viteArgs[configIndex];
    const configFile = configArg?.includes("=")
      ? configArg.slice(configArg.indexOf("=") + 1)
      : viteArgs[configIndex + 1];
    const forwardedArgs =
      native && configIndex !== -1
        ? viteArgs.filter(
            (_, index) =>
              index !== configIndex && (configArg !== "--config" || index !== configIndex + 1),
          )
        : viteArgs;
    await writeFile(
      driver,
      webBuildDriver(cwd, assets, native, configIndex === -1 ? undefined : configFile),
    );
    await run(
      process.execPath,
      [
        path.join(packageRoot(cwd, "vite"), "bin/vite.js"),
        "build",
        ...stagedViteArgs(forwardedArgs, staging),
        ...ownConfigArgs(forwardedArgs, driver, !native && assets === path.resolve(cwd, "public")),
      ],
      cwd,
    );
    await pruneUnpackagedAssets(cwd, config, staging);
    const report = await writeCompressionSidecars(staging);
    if (report !== undefined) {
      process.stdout.write(
        `web main chunk ${report.entry}: raw ${report.raw} B, gzip ${report.gzip} B, brotli ${report.brotli} B\n`,
      );
    }
    // The web target's budget is measured exactly as a native artifact's is: on the staged
    // outDir, before the publish, so an `error` ceiling leaves the previous `dist` alone and a
    // `warn` one prints and publishes. Measured after the publish it would only ever report.
    await assertArtifactBudget(cwd, config, outDir, staging, assets);
    await writeBuildReport({
      artifact: staging,
      assets,
      config,
      packagedAssetBytes: await measurePackagedAssetBytes(cwd, assets),
      target: "web",
    });
    await publishStagedArtifact(outDir, staging);
  } catch (error) {
    // Nothing half-written survives the failure, and `outDir` was never written to.
    await rm(path.dirname(staging), { force: true, recursive: true });
    throw error;
  }
}

/**
 * The Vite config this build runs on: the project's own, plus the one thing Vite's command line
 * cannot carry.
 *
 * A project that declared `assets.output` anywhere but `public/` had its cooked assets — the
 * manifest every loader reads — sitting beside a `dist` Vite built out of its own `publicDir`.
 * The build knows the asset root, so the build is what tells Vite, and it says so through a config
 * rather than by editing a template's `vite.config.ts`: a generated file the project never sees.
 *
 * A `publicDir` the project set itself is left alone, detected by the same signal the choice has
 * in every Vite version: the key is present in its own config (`false` is a choice too). A caller
 * who passed `--config` keeps that config; the native engine switch still applies.
 */
function webBuildDriver(cwd: string, assets: string, native = false, configFile?: string): string {
  const literal = (value: string): string => JSON.stringify(value);
  return `${[
    'import { defineConfig, loadConfigFromFile, mergeConfig } from "vite";',
    ...(native
      ? [
          `import { createWebBrandPlugin } from ${literal(path.join(packageRoot(cwd, "create-threenative"), "dist/index.js"))};`,
        ]
      : []),
    "",
    `const root = ${literal(cwd)};`,
    `const assets = ${literal(assets)};`,
    "export default defineConfig(async ({ command, mode }) => {",
    `  const own = (await loadConfigFromFile({ command, mode }, ${configFile === undefined ? "undefined" : literal(path.resolve(cwd, configFile))}, root))?.config ?? {};`,
    ...(native
      ? [
          '  if (!(own.plugins ?? []).flat(Infinity).some((plugin) => plugin?.name === "threenative-web-brand"))',
          "    own.plugins = [...(own.plugins ?? []), createWebBrandPlugin()];",
          '  own.build = { target: "es2022", ...own.build };',
        ]
      : []),
    "  return mergeConfig(own, own.publicDir === undefined ? { publicDir: assets } : {});",
    "});",
    "",
  ].join("\n")}\n`;
}

/**
 * The generated config, unless the caller named a config of their own or the asset root is
 * Vite's own default `public/`, where there is nothing to tell Vite and the build runs as before.
 */
function ownConfigArgs(
  viteArgs: readonly string[],
  driver: string,
  defaultRoot: boolean,
): string[] {
  const named = viteArgs.some((arg) => arg === "--config" || arg.startsWith("--config="));
  return named || defaultRoot ? [] : ["--config", driver];
}

/**
 * Remove from the Vite outDir exactly the compiled files packaging would have dropped.
 *
 * Vite copies the whole output root, so a cook output no current bake declares rides along into
 * a web build. The rule is the packagers' own selector, imported from the runtime-native package
 * every template installs; a web-only project that does not have it keeps Vite's copy, because
 * there is no packaging selector shipped to ask.
 */
async function pruneUnpackagedAssets(
  cwd: string,
  config: IResolvedThreeNativeConfig,
  outDir: string,
): Promise<void> {
  const assets = assetRoot(cwd, config);
  if (!existsSync(assets)) return;
  const selector = await packagingSelector(cwd);
  if (selector === undefined) return;
  for (const file of selector.selectManifestAssets(assets).dropped)
    await rm(path.join(outDir, file), { force: true });
}

/** Vite's `--outDir`, or its `dist` default when the project left it to the config. */
function viteOutDir(viteArgs: readonly string[]): string {
  const index = viteArgs.findIndex((arg) => arg === "--outDir" || arg.startsWith("--outDir="));
  if (index === -1) return "dist";
  const flag = viteArgs[index] as string;
  return flag.startsWith("--outDir=")
    ? flag.slice("--outDir=".length)
    : (viteArgs[index + 1] ?? "dist");
}

/** The same args with their `--outDir` pointed at the staging sibling, and nothing else changed. */
function stagedViteArgs(viteArgs: readonly string[], staging: string): string[] {
  const index = viteArgs.findIndex((arg) => arg === "--outDir" || arg.startsWith("--outDir="));
  if (index === -1) return [...viteArgs, "--outDir", staging];
  const staged = [...viteArgs];
  if ((staged[index] as string).startsWith("--outDir=")) staged[index] = `--outDir=${staging}`;
  else staged[index + 1] = staging;
  return staged;
}

async function nativeEntry(cwd: string, config?: IResolvedThreeNativeConfig): Promise<string> {
  const relative = (config ?? (await loadConfig(cwd))).nativeEntry;
  const entry = path.resolve(cwd, relative);
  try {
    if (!(await stat(entry)).isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`TN_NATIVE_ENTRY_MISSING: ${relative} does not exist.`);
  }
  return entry;
}

export async function nativeOrientation(cwd: string): Promise<NativeOrientation> {
  return (await loadConfig(cwd)).display.orientation;
}

export function resolvePackagingConfig(
  cwd: string,
  config: IResolvedThreeNativeConfig,
): IResolvedThreeNativeConfig {
  const resolve = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : path.resolve(cwd, value);
  const artifact: IResolvedThreeNativeConfig = {
    ...config,
    app: {
      ...config.app,
      ...(config.app.icon === undefined ? {} : { icon: path.resolve(cwd, config.app.icon) }),
      ...(config.app.icons === undefined
        ? {}
        : {
            icons: {
              ...(config.app.icons.android === undefined
                ? {}
                : {
                    android: {
                      ...(config.app.icons.android.foreground === undefined
                        ? {}
                        : { foreground: path.resolve(cwd, config.app.icons.android.foreground) }),
                      ...(config.app.icons.android.background === undefined
                        ? {}
                        : { background: config.app.icons.android.background }),
                      ...(config.app.icons.android.monochrome === undefined
                        ? {}
                        : { monochrome: path.resolve(cwd, config.app.icons.android.monochrome) }),
                    },
                  }),
              ...(config.app.icons.ios === undefined
                ? {}
                : {
                    ios: {
                      ...(config.app.icons.ios.dark === undefined
                        ? {}
                        : { dark: path.resolve(cwd, config.app.icons.ios.dark) }),
                      ...(config.app.icons.ios.tinted === undefined
                        ? {}
                        : { tinted: path.resolve(cwd, config.app.icons.ios.tinted) }),
                    },
                  }),
              ...(config.app.icons.web === undefined
                ? {}
                : {
                    web: {
                      ...(config.app.icons.web.favicon === undefined
                        ? {}
                        : { favicon: resolve(config.app.icons.web.favicon) }),
                      ...(config.app.icons.web.maskable === undefined
                        ? {}
                        : { maskable: resolve(config.app.icons.web.maskable) }),
                      ...(config.app.icons.web.monochrome === undefined
                        ? {}
                        : { monochrome: resolve(config.app.icons.web.monochrome) }),
                      ...(config.app.icons.web.appleTouch === undefined
                        ? {}
                        : { appleTouch: resolve(config.app.icons.web.appleTouch) }),
                    },
                  }),
            },
          }),
    },
    ...(config.bootSplash === undefined
      ? {}
      : {
          bootSplash: {
            ...config.bootSplash,
            ...(config.bootSplash.image === undefined
              ? {}
              : { image: path.resolve(cwd, config.bootSplash.image) }),
          },
        }),
  };
  return artifact;
}

export async function writePackagingConfig(
  cwd: string,
  config: IResolvedThreeNativeConfig,
): Promise<string> {
  const directory = path.join(cwd, ".threenative", "build");
  await mkdir(directory, { recursive: true });
  const artifact = resolvePackagingConfig(cwd, config);
  const output = path.join(directory, "config.json");
  await writeFile(output, `${JSON.stringify(artifact, null, 2)}\n`);
  return output;
}

/** Read only the selected executable. An unrecognized or failed probe never proves WASM. */
function runtimeEngine(
  binary: string | undefined,
  probe: typeof spawnSync,
): "v8" | "quickjs" | "jsc" | "unknown" {
  if (binary === undefined || !existsSync(binary)) return "unknown";
  try {
    const result = probe(binary, ["--version"], { encoding: "utf8", timeout: 10_000 });
    if (result.status !== 0) return "unknown";
    const engine = /\+ (\S+) build/u.exec(String(result.stdout ?? ""))?.[1]?.toLowerCase();
    return engine === "v8" || engine === "quickjs" || engine === "jsc" ? engine : "unknown";
  } catch {
    return "unknown";
  }
}

export function runtimeHasWebAssembly(
  binary: string | undefined = process.env.THREENATIVE_RUNTIME_BINARY,
  probe: typeof spawnSync = spawnSync,
): boolean {
  return runtimeEngine(binary, probe) === "v8";
}

/**
 * The Android engine the packager will compile or fetch: the `-PthreenativeJsEngine` Gradle
 * property passed through `THREENATIVE_GRADLE_ARGS`, else the Gradle default `v8`. A value Gradle
 * would refuse resolves to `unknown`, which is decoder-free.
 */
function androidEngine(env: NodeJS.ProcessEnv): "v8" | "quickjs" | "unknown" {
  const value = (env.THREENATIVE_GRADLE_ARGS ?? "")
    .split(" ")
    .map((arg) => /^(?:-P|--project-prop=)threenativeJsEngine=(.*)$/u.exec(arg)?.[1])
    .filter((entry) => entry !== undefined)
    .at(-1);
  const engine = (value ?? "v8").toLowerCase();
  return engine === "v8" || engine === "quickjs" ? engine : "unknown";
}

/**
 * One conservative decision for cooking, validation and bundling. Only desktop's selected
 * executable is runnable here: a desktop packaging tool is never evidence about Android/iOS.
 * Android's engine is the one its Gradle build selects; Android V8 admits only the codecs its
 * packaged loader has run on a device lane (KTX2 and Meshopt, PRD-485), Draco stays refused.
 * iOS stays decoder-free until its selected artifact and packaged loaders are qualified.
 * Desktop V8 retains its existing decoder path; WASM alone does not qualify new codec targets.
 */
export function resolveRuntimeAssetCapabilities(
  target: BuildTarget,
  binary?: string,
  probe: typeof spawnSync = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
) {
  const selected = target === "desktop" ? binary : undefined;
  const engine =
    target === "web"
      ? "browser"
      : target === "android"
        ? androidEngine(env)
        : runtimeEngine(selected, probe);
  const artifact =
    target === "android"
      ? `android:${engine}`
      : selected === undefined
        ? `${target}:unresolved`
        : path.resolve(selected);
  let identity = artifact;
  if (selected !== undefined && existsSync(selected)) {
    identity = `${target}:sha256:${createHash("sha256").update(readFileSync(selected)).digest("hex")}`;
  }
  const webAssembly = engine === "v8" || engine === "browser";
  const bundled = target === "web" || (target === "desktop" && webAssembly);
  const androidV8 = target === "android" && engine === "v8";
  return {
    artifact,
    identity,
    engine,
    webAssembly,
    decoders: { ktx2: bundled || androidV8, meshopt: bundled || androidV8, draco: bundled },
  };
}

async function bundleNative(
  cwd: string,
  runtimeRoot: string,
  entry: string,
  target: NativeBuildTarget,
  nativeBackend: boolean,
  decoders: { ktx2: boolean; meshopt: boolean; draco: boolean },
): Promise<string> {
  const output = path.join(cwd, ".threenative", "build", "game.js");
  await run(
    process.execPath,
    [
      path.join(runtimeRoot, "scripts", "bundle.mjs"),
      "--project",
      cwd,
      "--entry",
      entry,
      "--target",
      target,
      "--output",
      output,
      ...(nativeBackend ? ["--native-backend"] : []),
      // Only a mobile bundle reads it: desktop already chooses stubs through `--native-backend`.
      ...(target === "android"
        ? [
            "--decoders",
            Object.entries(decoders)
              .filter(([, admitted]) => admitted)
              .map(([codec]) => codec)
              .join(","),
          ]
        : []),
    ],
    cwd,
  );
  return output;
}

/** The one packaging selector, as `runtime-native/scripts/asset-manifest.mjs` exports it. */
interface IPackagingSelector {
  selectManifestAssets(
    assets: string,
    options?: { log?: (line: string) => void },
  ): { dropped: string[]; selected: string[] };
}

/** The one packaging selector, from the installed native runtime; absent when it is not installed. */
async function packagingSelector(cwd: string): Promise<IPackagingSelector | undefined> {
  try {
    const module = path.join(
      packageRoot(cwd, "@threenative/runtime-native"),
      "scripts",
      "asset-manifest.mjs",
    );
    return (await import(pathToFileURL(module).href)) as IPackagingSelector;
  } catch {
    return undefined;
  }
}

/** The bytes of the asset files this build actually packages, and not the ones it drops. */
async function measurePackagedAssetBytes(cwd: string, assets: string): Promise<number> {
  if (!existsSync(assets)) return 0;
  const selector = await packagingSelector(cwd);
  if (selector === undefined) return measureTreeBytes(assets);
  let total = 0;
  // Silent: the packager is seconds away printing these same skips and the unmanaged line.
  for (const file of selector.selectManifestAssets(assets, { log: () => {} }).selected)
    total += (await stat(path.join(assets, file))).size;
  return total;
}

function budgetSentence(metric: string, measured: number, limit: number): string {
  return `threenative build: ${metric} measured ${measured} bytes over its ${limit}-byte limit.`;
}

/**
 * Measure what a staged build produced against its profile's `artifactBudget`, before publishing.
 *
 * An `error` ceiling refuses the build and leaves the previous artifact exactly where it was —
 * the whole reason measurement happens here, on the staging path, and not after the publish.
 * A `warn` ceiling prints the same sentence and publishes, because a game that ships over its own
 * advisory ceiling is a decision its author made.
 */
async function assertArtifactBudget(
  cwd: string,
  config: IResolvedThreeNativeConfig,
  final: string,
  staged: string,
  assets: string,
): Promise<void> {
  const budget = config.buildProfile?.artifactBudget;
  if (budget === undefined) return;
  const metrics = [
    {
      declared: budget.artifactBytes,
      measured: await measureTreeBytes(staged),
      name: "artifactBytes",
    },
    {
      declared: budget.packagedAssetBytes,
      measured: await measurePackagedAssetBytes(cwd, assets),
      name: "packagedAssetBytes",
    },
  ];
  for (const { declared, measured, name } of metrics) {
    if (declared === undefined || measured <= declared.limit) continue;
    const sentence = budgetSentence(name, measured, declared.limit);
    if (declared.severity === "error") {
      throw new Error(
        `TN_BUILD_ARTIFACT_BUDGET_EXCEEDED: ${sentence} The build did not publish, so ${final} is still the previous artifact.`,
      );
    }
    process.stdout.write(`${sentence}\n`);
  }
}

/** Where a desktop `engine: "threenative"` build finds the engine player, absent an explicit path. */
export function engineDesktopPlayer(
  runtimeRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): string {
  const explicit = env.THREENATIVE_ENGINE_PLAYER;
  if (explicit !== undefined) return path.resolve(cwd, explicit);
  const filename = `tn-native-engine-player-v8${process.platform === "win32" ? ".exe" : ""}`;
  const checkout = path.join(runtimeRoot, "build", "tn-engine-ui", filename);
  return existsSync(checkout)
    ? checkout
    : path.join(runtimeRoot, "prebuilt", `${process.platform}-${process.arch}`, filename);
}

/** The desktop package of a game with `engine: "threenative"`: the engine player, the game on its own three, cooked assets and UI. */
async function buildEngineDesktop(
  cwd: string,
  config: IResolvedThreeNativeConfig,
  entry: string,
): Promise<void> {
  if (config.ui.renderer === "native-css") {
    throw new Error(
      'TN_ENGINE_NATIVE_UI_UNSUPPORTED: engine "threenative" on desktop draws a "web" UI through the engine player\'s overlay; set ui.renderer to "web" or "native", or set engine: "threejs" to keep the native-css host.',
    );
  }
  const runtimeRoot = packageRoot(cwd, "@threenative/runtime-native");
  const packager = path.join(runtimeRoot, "scripts", "package-engine-desktop.mjs");
  const bundler = path.join(runtimeRoot, "scripts", "bundle-native-engine.mjs");
  if (!existsSync(packager) || !existsSync(bundler)) {
    throw new Error(
      `TN_ENGINE_BUNDLER_MISSING: engine "threenative" on desktop bundles the game with ${bundler}, which an installed @threenative/runtime-native does not ship yet. Build from a ThreeNative checkout, or set engine: "threejs" in threenative.config.ts to package with the legacy host.`,
    );
  }
  const ui = config.ui.renderer === "web" ? await buildUi(cwd, config) : undefined;
  const output = path.join(cwd, "dist-native", await projectName(cwd));
  await packageStaged(output, cwd, [
    packager,
    "--project",
    cwd,
    "--entry",
    entry,
    "--player",
    engineDesktopPlayer(runtimeRoot, process.env, cwd),
    ...(ui === undefined ? [] : ["--ui", ui]),
    "--width",
    String(config.window.width),
    "--height",
    String(config.window.height),
    "--title",
    config.window.title,
    "--output",
    output,
  ]);
}

async function buildNative(
  target: NativeBuildTarget,
  cwd: string,
  allowSourceBuild = false,
  mode: BuildMode = "debug",
  format: BuildFormat = "apk",
  profile?: string,
): Promise<void> {
  const config = await loadConfig(cwd, { target, profile });
  announceProfile(config);
  assertNativeUiRendererCompatible(target, config.ui.renderer);
  const entry = await nativeEntry(cwd, config);
  // `engine: "threenative"` opts a desktop game into the C++ engine player, as it opts a web build into the Wasm
  // engine: its own bundler, decoder-free cook and packager, never the legacy host's prebuilt.
  if (target === "desktop" && config.engine === "threenative") {
    await buildEngineDesktop(cwd, config, entry);
    return;
  }
  // Resolve the same desktop binary the packager will receive, before cooking. A default
  // prebuilt used to be selected only after the cook had guessed from the build machine.
  let selectedRuntime: string | undefined;
  if (target === "desktop") {
    const module = path.join(
      packageRoot(cwd, "@threenative/runtime-native"),
      "scripts",
      "package-desktop.mjs",
    );
    const { resolveDesktopRuntime } = (await import(pathToFileURL(module).href)) as {
      resolveDesktopRuntime(explicit?: string): Promise<string>;
    };
    const explicit = process.env.THREENATIVE_RUNTIME_BINARY;
    selectedRuntime = await resolveDesktopRuntime(
      explicit === undefined ? undefined : path.resolve(cwd, explicit),
    );
  }
  const capabilities = resolveRuntimeAssetCapabilities(target, selectedRuntime);
  await compileAssets({
    config: config.assets,
    cwd,
    platform: target,
    runtimeDecoders: capabilities.decoders,
    runtimeIdentity: capabilities.identity,
  });
  await assertNativeAssetsCompatible(cwd, target, config, capabilities);
  const orientation = config.display.orientation;
  const configPath = await writePackagingConfig(cwd, config);
  const runtimeRoot = packageRoot(cwd, "@threenative/runtime-native");
  const bundle = await bundleNative(
    cwd,
    runtimeRoot,
    entry,
    target,
    !capabilities.webAssembly,
    capabilities.decoders,
  );
  await assertNativeBundleCompatible(bundle, target, capabilities);
  // The compiled root the project configured, which `compileAssets` above baked into — not the
  // `public` default. A project whose cook profile writes elsewhere was packaging an empty
  // directory while its own assets sat next to it, unread.
  const assets = assetRoot(cwd, config);
  // The UI is built only when the game asked for the web renderer, so a `native` game ships no
  // web view, no UI bundle and no extra process — acceptance criterion 5 of PRD-217.
  // `native-css` runs the same Vite build and keeps only its stylesheets: the React tree runs in
  // the game's own JS realm, so the page and its JS are dead weight in the package.
  let ui: string | undefined;
  if (config.ui.renderer !== "native") {
    const built = await buildUi(cwd, config);
    if (config.ui.renderer === "native-css") {
      ui = path.join(cwd, ".threenative", "build", "ui-css");
      await extractUiStylesheets(built, ui, cwd);
    } else {
      ui = built;
    }
  }
  if (target === "ios") {
    const output = path.join(cwd, "dist-native", `${await projectName(cwd)}.app`);
    await packageStaged(
      output,
      runtimeRoot,
      [
        path.join(runtimeRoot, "scripts", "package-ios.mjs"),
        "--bundle",
        bundle,
        "--assets",
        assets,
        ...(ui === undefined ? [] : ["--ui", ui]),
        "--orientation",
        orientation,
        "--config",
        configPath,
        "--output",
        output,
      ],
      { assets, config, target: "ios" },
    );
    return;
  }
  if (target === "android") {
    const output = path.join(
      cwd,
      "dist-native",
      `${await projectName(cwd)}.${format === "aab" ? "aab" : "apk"}`,
    );
    await packageStaged(
      output,
      runtimeRoot,
      [
        path.join(runtimeRoot, "scripts", "package-android.mjs"),
        ...(allowSourceBuild ? ["--allow-source-build"] : []),
        "--mode",
        mode,
        "--format",
        format,
        // The consumer project, so a relative keystore path in the signing environment resolves
        // against the game rather than the engine's Android project.
        "--project-root",
        cwd,
        "--bundle",
        bundle,
        "--assets",
        assets,
        ...(ui === undefined ? [] : ["--ui", ui]),
        "--orientation",
        orientation,
        "--config",
        configPath,
        "--output",
        output,
      ],
      { assets, config, target: "android" },
    );
    return;
  }
  const output = path.join(cwd, "dist-native", await projectName(cwd));
  await packageStaged(
    output,
    cwd,
    [
      path.join(runtimeRoot, "scripts", "package-desktop.mjs"),
      "--mode",
      mode,
      "--bundle",
      bundle,
      "--assets",
      assets,
      ...(ui === undefined ? [] : ["--ui", ui]),
      "--config",
      configPath,
      ...(selectedRuntime === undefined ? [] : ["--runtime", selectedRuntime]),
      "--output",
      output,
    ],
    { assets, config, target: "desktop" },
  );
}

/**
 * Run a packager against a staging sibling of the final artifact, then publish what it produced.
 *
 * A packager writes in place: an APK that fails halfway leaves a truncated `dist-native/<name>.apk`
 * where a working one used to be, and a killed build leaves no way to tell the two apart. So the
 * packager is handed `stagingPath(final)`, and only a complete run publishes — a rename aside
 * for the previous artifact, a rename in for the new one, then the old one goes. A failure never
 * reaches the publish, so the previous artifact is still the artifact.
 */
async function packageStaged(
  output: string,
  cwd: string,
  args: readonly string[],
  report?: { assets: string; config: IResolvedThreeNativeConfig; target: BuildTarget },
): Promise<void> {
  const staged = stagingPath(output);
  const index = args.indexOf("--output");
  if (index < 0 || index + 1 >= args.length) {
    throw new Error("packageStaged needs the packager's --output <path> argument to stage it.");
  }
  const packager = [...args];
  packager[index + 1] = staged;
  try {
    await mkdir(path.dirname(staged), { recursive: true });
    await run(process.execPath, packager, cwd);
    if (report !== undefined) {
      const produced = await producedArtifact(staged);
      if (report.config.buildProfile?.artifactBudget !== undefined)
        await assertArtifactBudget(cwd, report.config, output, produced, report.assets);
      await writeBuildReport({
        artifact: produced,
        assets: report.assets,
        config: report.config,
        packagedAssetBytes: await measurePackagedAssetBytes(cwd, report.assets),
        target: report.target,
      });
    }
  } catch (error) {
    await rm(path.dirname(staged), { force: true, recursive: true });
    throw error;
  }
  await publishStagedArtifact(output, staged);
}

/**
 * Where a build stages `final`: a private directory beside it, keeping the artifact's own name.
 *
 * The name matters because packagers derive from it — a desktop release container is named after
 * its output's basename — so a suffixed name would ship inside the artifact. The directory also
 * collects the whole family a packager writes next to its output (`<name>.json` beside an iOS
 * `.app`, `<name>.tar.gz` and `<name>-setup.exe` beside a desktop binary), so publish and cleanup
 * never have to know those spellings.
 */
export function stagingPath(final: string): string {
  return path.join(path.dirname(final), `.staging-${process.pid}`, path.basename(final));
}

/**
 * The file a packager actually wrote for `staged`. Its name is not always the requested one: a
 * Windows executable gains `.exe`, and a desktop release writes only its container
 * (`<name>.tar.gz` or `<name>.zip`, a zipped `.app`), never a bare `<name>`. A Windows release
 * writes *both* a container and an installer, so the order below is what keeps the budget and the
 * report on the container instead of on whichever sibling sorts first. Exact name, then the
 * executable and bundle spellings, then the containers, then the one other thing left beside it.
 */
async function producedArtifact(staged: string): Promise<string> {
  const directory = path.dirname(staged);
  const name = path.basename(staged);
  const entries = existsSync(directory) ? await readdir(directory) : [];
  for (const candidate of [name, `${name}.exe`, `${name}.app`, `${name}.tar.gz`, `${name}.zip`]) {
    if (entries.includes(candidate)) return path.join(directory, candidate);
  }
  const other = entries.filter((entry) => !entry.endsWith(BUILD_REPORT_SUFFIX)).sort()[0];
  if (other === undefined) {
    throw new Error(
      `TN_BUILD_ARTIFACT_MISSING: the packager exited successfully but wrote no artifact to ${staged}.`,
    );
  }
  return path.join(directory, other);
}

/**
 * Publish everything a staging build produced over the artifacts it replaces, then drop the
 * staging directory.
 *
 * Staging and destination share a parent, so each rename is atomic: the window in which an
 * artifact does not exist is a single syscall wide — and a rename that fails puts the previous one
 * back rather than leaving neither. Exported for the test that can only reach this path by making
 * a rename fail.
 */
export async function publishStagedArtifact(final: string, staging: string): Promise<void> {
  const from = path.dirname(staging);
  const produced = existsSync(from) ? await readdir(from) : [];
  if (!produced.some((name) => !name.endsWith(BUILD_REPORT_SUFFIX))) {
    throw new Error(
      `TN_BUILD_ARTIFACT_MISSING: the packager exited successfully but wrote no artifact to ${staging}; ${final} is unchanged.`,
    );
  }
  const directory = path.dirname(final);
  for (const name of produced) {
    const source = path.join(from, name);
    const to = path.join(directory, name);
    if (!existsSync(to)) {
      await rename(source, to);
      continue;
    }
    const previous = path.join(from, `${name}.previous`);
    await rename(to, previous);
    try {
      await rename(source, to);
    } catch (error) {
      // The new artifact did not land, so the previous one goes back: never leave neither.
      await rename(previous, to);
      throw error;
    }
  }
  await rm(from, { force: true, recursive: true });
}

/** The project-scoped build lock, holding the pid of the build that owns it. */
const BUILD_LOCK = path.join(".threenative", "build.lock");

/** Whether a pid is running; `EPERM` is a live process this user may not signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the project build lock, or fail `TN_BUILD_BUSY` naming the build holding it.
 *
 * `.threenative/build/config.json` and `game.js` are shared mutable paths, so two builds in one
 * project overwrite each other's inputs half-way through. A lock whose pid is gone is reclaimed —
 * a crashed build must not lock a project out forever — and a crash mid-write leaves no pid,
 * which reads the same way.
 */
async function acquireBuildLock(lock: string): Promise<void> {
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.writeFile(String(process.pid));
      await handle.close();
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const pid = Number.parseInt((await readFile(lock, "utf8").catch(() => "")).trim(), 10);
      if (Number.isSafeInteger(pid) && pid > 0 && pidAlive(pid)) {
        throw new Error(
          `TN_BUILD_BUSY: another threenative build (pid ${pid}) holds ${lock}. Wait for it to finish; if that process is gone, delete the lock.`,
        );
      }
      // ponytail: two builds reclaiming the same dead lock in the same instant can both win;
      // move to an OS advisory lock if concurrent CI builds of one checkout ever hit it.
      await rm(lock, { force: true });
    }
  }
}

export async function build(options: IBuildOptions): Promise<void> {
  if (options.allowSourceBuild && options.target !== "android") {
    throw new Error("--allow-source-build is supported only for --target android.");
  }
  if (
    (options.mode !== undefined && options.target !== "android" && options.target !== "desktop") ||
    (options.format !== undefined && options.target !== "android")
  ) {
    throw new Error(
      "--mode is supported only for --target android or desktop; --format only for --target android.",
    );
  }
  const mode = options.mode ?? "debug";
  const format = options.format ?? "apk";
  // An app bundle is a Play submission shape; there is no debug AAB to install.
  if (format === "aab" && mode !== "release") {
    throw new Error("--format aab requires --mode release.");
  }
  // Every option is refused before the project is touched, the lock included: a request the
  // build cannot honour must not leave a lock file or a `.threenative/` behind to explain itself.
  if (options.target !== "web" && (options.viteArgs?.length ?? 0) > 0) {
    throw new Error(
      `${options.target} build does not accept ${options.viteArgs?.join(" ")}. iOS output is simulator-only; device signing remains OPEN.`,
    );
  }
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const lock = path.join(cwd, BUILD_LOCK);
  await mkdir(path.dirname(lock), { recursive: true });
  await acquireBuildLock(lock);
  try {
    if (options.target === "web") await buildWeb(cwd, options.viteArgs, options.profile);
    else {
      await buildNative(
        options.target,
        cwd,
        options.allowSourceBuild === true,
        mode,
        format,
        options.profile,
      );
    }
  } finally {
    await rm(lock, { force: true });
  }
}

export function buildHelp(): string {
  return `${[
    "Usage: threenative build [--target web|desktop|android|ios] [--mode debug|release] [--format apk|aab]",
    "",
    "Options:",
    "  --target <target>  Choose web, desktop, android, or ios (default: web).",
    "  --mode <mode>      debug (default) or release. Desktop release wraps the executable in one complete OS container.",
    "  --format <format>  Android only: apk (default) or aab. aab requires --mode release.",
    "  --profile <name>   A buildProfiles name; wins over buildProfiles.defaults for the target.",
    "  --allow-source-build  Explicitly allow Android maintainer source compilation.",
    "  --help             Show this help.",
  ].join("\n")}\n`;
}

export function parseBuildArgs(argv: readonly string[]): IBuildOptions {
  if (argv[0] !== "build") {
    throw new Error("Usage: threenative build [--target web|desktop|android|ios]");
  }
  const targetIndex = argv.indexOf("--target");
  const value = targetIndex === -1 ? "web" : argv[targetIndex + 1];
  if (!TARGETS.includes(value as BuildTarget)) {
    throw new Error(`Unknown build target '${value ?? ""}'. Choose ${TARGETS.join(", ")}.`);
  }
  const allowSourceBuild = argv.includes("--allow-source-build");
  if (allowSourceBuild && value !== "android") {
    throw new Error("--allow-source-build is supported only for --target android.");
  }
  const mode = flagValue(argv, "--mode");
  if (mode !== undefined && mode !== "debug" && mode !== "release") {
    throw new Error(`Unknown build mode '${mode}'. Choose debug or release.`);
  }
  const format = flagValue(argv, "--format");
  if (format !== undefined && format !== "apk" && format !== "aab") {
    throw new Error(`Unknown build format '${format}'. Choose apk or aab.`);
  }
  const profile = flagValue(argv, "--profile");
  if (
    (mode !== undefined && value !== "android" && value !== "desktop") ||
    (format !== undefined && value !== "android")
  ) {
    throw new Error(
      "--mode is supported only for --target android or desktop; --format only for --target android.",
    );
  }
  if (format === "aab" && (mode ?? "debug") !== "release") {
    throw new Error("--format aab requires --mode release.");
  }
  const consumed = new Set([0]);
  if (allowSourceBuild) {
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--allow-source-build") consumed.add(index);
    }
  }
  for (const flag of ["--mode", "--format", "--profile"]) {
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === flag) {
        consumed.add(index);
        consumed.add(index + 1);
      }
    }
  }
  if (targetIndex !== -1) {
    consumed.add(targetIndex);
    consumed.add(targetIndex + 1);
  }
  return {
    target: value as BuildTarget,
    ...(allowSourceBuild ? { allowSourceBuild: true } : {}),
    ...(mode === undefined ? {} : { mode: mode as BuildMode }),
    ...(format === undefined ? {} : { format: format as BuildFormat }),
    ...(profile === undefined ? {} : { profile }),
    viteArgs: argv.filter((_, index) => !consumed.has(index)),
  };
}

/** A single-valued long flag, or undefined when absent; a trailing flag with no value throws. */
function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}
