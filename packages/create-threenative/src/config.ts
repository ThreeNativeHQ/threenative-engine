import { access, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseAudioConfig, parsePng } from "@threenative/assets";
import type {
  IThreeNativeAudioConfig,
  IThreeNativeBootSplash,
  IThreeNativeConfig,
  IThreeNativeIconVariants,
  IThreeNativeLodConfig,
  IThreeNativeLodOverride,
  IThreeNativeTexturesConfig,
  ThreeNativeLodMinTrianglesScope,
  ThreeNativeLodPreset,
  ThreeNativeOrientation,
  ThreeNativeUiRenderer,
} from "@threenative/core";
import type { BuildTarget } from "./build.js";

export type {
  IThreeNativeAudioConfig,
  IThreeNativeAudioLoop,
  IThreeNativeAudioOverride,
  IThreeNativeAudioSpectrum,
  IThreeNativeConfig,
  IThreeNativeLodConfig,
  IThreeNativeLodGenerationConfig,
  IThreeNativeLodOverride,
  IThreeNativeLodRuntimeConfig,
  IThreeNativeTexturesConfig,
  ThreeNativeLodMinTrianglesScope,
  ThreeNativeLodPreset,
  ThreeNativeOrientation,
  ThreeNativeUiRenderer,
} from "@threenative/core";

export interface IResolvedThreeNativeConfig {
  readonly engine: "threejs" | "threenative";
  readonly app: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly build: number;
    readonly icon?: string;
    readonly icons?: IThreeNativeIconVariants;
  };
  readonly display: {
    readonly orientation: ThreeNativeOrientation;
    readonly fullscreen: boolean;
    readonly keepScreenOn: boolean;
    readonly maxFps: number;
  };
  readonly window: {
    readonly title: string;
    readonly width: number;
    readonly height: number;
    /** Start maximized on desktop; ignored when `display.fullscreen` is true. */
    readonly maximized: boolean;
    readonly resizable: boolean;
  };
  readonly bootSplash?: IThreeNativeBootSplash;
  readonly nativeEntry: string;
  /** Which cook profile produced this configuration, and whether the flag or the default chose it. */
  readonly buildProfile?: {
    readonly name: string;
    readonly source: "flag" | "default";
    readonly target: BuildTarget;
    /** The byte ceilings this build must measure against before publishing its artifact. */
    readonly artifactBudget?: ArtifactBudget;
    /** The runtime ceilings published into this build's report, for `threenative-playtest`. */
    readonly performanceBudget?: PerformanceBudget;
  };
  readonly renderer: {
    readonly preferWebGPU: boolean;
    readonly resolutionScale?: number | "auto";
    readonly antialias?: boolean;
    readonly alphaAntialiasing?: boolean;
    readonly projection?: boolean;
    readonly minimumProjectedPixels?: number | false;
    readonly matrixWorld?: "visible" | "all";
    readonly android?: {
      readonly resolutionScale?: number | "auto";
      readonly antialias?: boolean;
      readonly alphaAntialiasing?: boolean;
    };
  };
  readonly ui: {
    readonly renderer: ThreeNativeUiRenderer;
  };
  readonly assets?: {
    /** Audio conditioning options, or `"none"` to ship every clip exactly as committed. */
    readonly audio?: "none" | IThreeNativeAudioConfig;
    readonly budget?: NonNullable<IThreeNativeConfig["assets"]>["budget"];
    readonly exclude?: readonly string[];
    /** The bound on how many workers a bake may use; absent means the driver's default. */
    readonly concurrency?: number;
    /** Validated, not yet resolved: per-asset resolution happens where the asset is known. */
    readonly lod?: boolean | IThreeNativeLodConfig;
    readonly models?: "none" | IThreeNativeModelsConfig;
    /** Also emit the native cooked package beside the existing outputs. */
    readonly nativePackage?: boolean;
    readonly output?: string;
    readonly source?: string;
    readonly targets?: {
      readonly maxMaterials?: number;
      readonly maxTriangles?: number;
      readonly maxTextureDimension?: number;
    };
    /** Texture compression options, or `"none"` to ship every texture exactly as committed. */
    readonly textures?: "none" | IThreeNativeTexturesConfig;
  };
}

/** Model optimization sub-pass switches; absent means every pass runs. */
export interface IThreeNativeModelPassesConfig {
  readonly dedup?: boolean;
  readonly meshopt?: boolean;
  readonly prune?: boolean;
  readonly quantize?: boolean;
  readonly reorder?: boolean;
  /** Drop animation tracks that only hold the pose their node already has. */
  readonly restTracks?: boolean;
}

export interface IThreeNativeModelsConfig {
  /**
   * Lossless scene-graph compaction (flatten, join, instance) against one protected-node set.
   * `false` ships the scene graph as authored; absent means on with defaults.
   */
  readonly compact?:
    | boolean
    | {
        readonly flatten?: boolean;
        readonly instance?: boolean | { readonly min?: number };
        readonly join?: boolean;
        readonly protectedNames?: readonly string[];
        readonly protectedPattern?: string;
      };
  readonly lightmap?: {
    readonly atlasSize: number;
    readonly padding: number;
  };
  readonly passes?: IThreeNativeModelPassesConfig;
  readonly quantize?: {
    /** Normal precision in bits, default 8. */
    readonly normalBits?: number;
    /** Position precision in bits, default 16. */
    readonly positionBits?: number;
    /** UV precision in bits, default 12. */
    readonly uvBits?: number;
  };
  /**
   * Embedded-texture compression for images carried inside a `.glb`.
   *
   * On by default in the compile step; `"none"` ships every embedded image exactly as
   * authored. `maxSize` caps the longest edge, preserving aspect and snapping to whole 4x4
   * blocks, and never upscales.
   */
  readonly textures?:
    | "none"
    | {
        readonly maxSize?: number | Readonly<Record<string, number>>;
        readonly quality?: number;
        readonly overrides?: readonly {
          readonly slot: string;
          readonly codec: "etc1s" | "none" | "uastc";
        }[];
      };
  /**
   * Mesh simplification. Absent means none at all, which is the default.
   *
   * `ratio` is the fraction of triangles to keep. `error` is a quality guard rather than a
   * target — the largest a vertex may move as a fraction of the mesh's extent — so a loose
   * ratio with a tight error stops short, and the compile step reports the ratio it actually
   * achieved next to the one that was asked for.
   */
  readonly simplify?: {
    readonly ratio: number;
    readonly error?: number;
  };
  /**
   * Cluster-DAG bake for virtual geometry: options, or `"none"` to ship every primitive as
   * authored. **Absent means the bake runs with defaults**, exactly as `textures` does.
   *
   * Only primitives at or above `minSourceTriangles` (65,536 by default) are touched, so ordinary
   * props compile byte-identically either way; a body dense enough to matter gets a cluster DAG and
   * the engine draws only what the camera can resolve. The payload costs about 3-4x the primitive's
   * compiled bytes, which is why the threshold is where it is. There is no runtime switch: a
   * minutes-long bake cannot happen at run time.
   */
  readonly virtual?:
    | {
        readonly groupSize?: number;
        readonly maxTriangles?: number;
        readonly minSourceTriangles?: number;
        readonly minTriangles?: number;
        readonly simplifyRatio?: number;
      }
    | "none";
}

interface IPackageManifest {
  readonly dependencies?: unknown;
  readonly devDependencies?: unknown;
  readonly name?: unknown;
  readonly optionalDependencies?: unknown;
  readonly version?: unknown;
  readonly threenative?: unknown;
}

type Esbuild = {
  transformSync(
    source: string,
    options: { format: "esm"; loader: "ts"; platform: "node"; target: "node20" },
  ): { code: string };
};

type ConfigLayer = "package manifest" | "config loading" | "config validation";

interface IConfigContext {
  readonly cwd: string;
  readonly fix: string;
  readonly layer: ConfigLayer;
  readonly searched: readonly string[];
  readonly sources: readonly string[];
}

const ORIENTATIONS: readonly ThreeNativeOrientation[] = ["landscape", "portrait", "sensor"];
const CONFIG_FILE = "threenative.config.ts";

class ConfigFailure extends Error {
  readonly code: string;
  readonly context: IConfigContext | undefined;
  readonly detail: string;

  constructor(code: string, detail: string, context?: IConfigContext) {
    super(`${code}: ${context === undefined ? detail : formatContext(context, detail)}`);
    this.name = "ConfigFailure";
    this.code = code;
    this.context = context;
    this.detail = detail;
  }
}

function formatContext(context: IConfigContext, detail: string): string {
  return `${context.layer} layer failed for ${context.sources.map((source) => `'${source}'`).join(", ")} from '${context.cwd}'. Searched: ${context.searched.join(", ")}. ${detail} Fix: ${context.fix}`;
}

function fail(code: string, message: string): never {
  throw new ConfigFailure(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, group: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) fail("TN_CONFIG_GROUP_INVALID", `${group} must be an object.`);
  return value;
}

function assertKeys(
  value: Record<string, unknown>,
  group: string,
  allowed: readonly string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail("TN_CONFIG_UNKNOWN_KEY", `${group}.${key} is not recognised.`);
  }
}

function nonEmptyString(value: unknown, code: string, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(code, `${label} must be non-empty.`);
  return value;
}

function booleanValue(value: unknown, fallback: boolean, code: string, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") fail(code, `${label} must be true or false.`);
  return value;
}

function positiveInteger(value: unknown, fallback: number, code: string, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(code, `${label} must be a positive integer.`);
  }
  return value as number;
}

function maxFpsValue(value: unknown): number {
  if (value === undefined) return 60;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1000) {
    fail(
      "TN_CONFIG_MAX_FPS_INVALID",
      "display.maxFps must be a whole number between 0 (uncapped) and 1000.",
    );
  }
  return value as number;
}

function packageDisplayName(manifest: IPackageManifest): string {
  if (typeof manifest.name !== "string" || manifest.name.trim().length === 0) {
    fail("TN_CONFIG_PACKAGE_NAME_MISSING", "package.json must declare a non-empty name.");
  }
  const name = manifest.name.replace(/^@[^/]+\//u, "");
  if (name.length === 0) fail("TN_CONFIG_PACKAGE_NAME_MISSING", "package.json name is incomplete.");
  return name;
}

function defaultAppId(name: string): string {
  let segment = name.toLowerCase().replace(/[^a-z0-9]/gu, "") || "game";
  if (!/^[a-z]/u.test(segment)) segment = `game${segment}`;
  return `com.threenative.${segment}`;
}

function projectRequire(cwd: string): NodeJS.Require {
  return createRequire(path.join(cwd, "package.json"));
}

function resolveModule(cwd: string, name: string): string | undefined {
  try {
    return projectRequire(cwd).resolve(name);
  } catch {
    return undefined;
  }
}

function configLoaderSearch(cwd: string): readonly string[] {
  return [
    path.join(cwd, "node_modules", "vite"),
    path.join(cwd, "node_modules", "esbuild"),
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "esbuild"),
  ];
}

const CONFIG_BUILD_COMMAND = "pnpm exec threenative build --target web";

function configContext(
  cwd: string,
  layer: ConfigLayer,
  sources: readonly string[],
  searched: readonly string[],
  fix: string,
): IConfigContext {
  return { cwd, fix, layer, searched, sources };
}

function packageContext(cwd: string): IConfigContext {
  const packagePath = path.join(cwd, "package.json");
  return configContext(
    cwd,
    "package manifest",
    [packagePath],
    [packagePath],
    `repair '${packagePath}' and rerun ${CONFIG_BUILD_COMMAND}`,
  );
}

function loadingContext(cwd: string, sourcePath: string, fix?: string): IConfigContext {
  return configContext(
    cwd,
    "config loading",
    [sourcePath],
    configLoaderSearch(cwd),
    fix ?? `fix '${sourcePath}' and rerun ${CONFIG_BUILD_COMMAND}`,
  );
}

function validationContext(cwd: string, sources: readonly string[]): IConfigContext {
  return configContext(
    cwd,
    "config validation",
    sources,
    [path.join(cwd, "package.json"), path.join(cwd, CONFIG_FILE)],
    `fix '${path.join(cwd, CONFIG_FILE)}' and rerun ${CONFIG_BUILD_COMMAND}`,
  );
}

function configFailure(code: string, context: IConfigContext, detail: string): never {
  throw new ConfigFailure(code, detail, context);
}

function contextualize(
  error: unknown,
  context: IConfigContext,
  fallbackCode: string,
): ConfigFailure {
  if (error instanceof ConfigFailure && error.context !== undefined) return error;
  if (error instanceof ConfigFailure) return new ConfigFailure(error.code, error.detail, context);
  return new ConfigFailure(
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    context,
  );
}

async function withConfigContext<T>(
  context: IConfigContext,
  fallbackCode: string,
  action: () => Promise<T> | T,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    throw contextualize(error, context, fallbackCode);
  }
}

function resolveEsbuild(cwd: string): string | undefined {
  const require = projectRequire(cwd);
  try {
    return require.resolve("esbuild");
  } catch {
    try {
      const vite = require.resolve("vite");
      return createRequire(vite).resolve("esbuild");
    } catch {
      try {
        return createRequire(import.meta.url).resolve("esbuild");
      } catch {
        return undefined;
      }
    }
  }
}

async function importConfig(cwd: string): Promise<Record<string, unknown> | undefined> {
  const sourcePath = path.join(cwd, CONFIG_FILE);
  try {
    await access(sourcePath);
  } catch {
    return undefined;
  }

  const esbuildPath = resolveEsbuild(cwd);
  if (esbuildPath === undefined) {
    configFailure(
      "TN_CONFIG_TRANSPILER_MISSING",
      loadingContext(
        cwd,
        sourcePath,
        `run pnpm add -D esbuild in '${cwd}' and rerun ${CONFIG_BUILD_COMMAND}`,
      ),
      // Not "install Vite": Vite 8 dropped esbuild for rolldown, so a project on it satisfies the
      // old advice and still lands here. The templates ship esbuild explicitly for this reason;
      // projects scaffolded before that do not.
      "threenative.config.ts needs project-resolved esbuild; install esbuild.",
    );
  }

  let esbuild: Esbuild;
  try {
    esbuild = projectRequire(cwd)(esbuildPath) as Esbuild;
  } catch (error) {
    configFailure(
      "TN_CONFIG_TRANSPILER_MISSING",
      loadingContext(
        cwd,
        sourcePath,
        `run pnpm install in '${cwd}' and rerun ${CONFIG_BUILD_COMMAND}`,
      ),
      error instanceof Error ? error.message : String(error),
    );
  }

  const context = loadingContext(cwd, sourcePath);
  let source: string;
  try {
    source = await readFile(sourcePath, "utf8");
  } catch (error) {
    configFailure(
      "TN_CONFIG_LOAD_FAILED",
      context,
      error instanceof Error ? error.message : String(error),
    );
  }
  let code: string;
  try {
    code = esbuild.transformSync(source, {
      format: "esm",
      loader: "ts",
      platform: "node",
      target: "node20",
    }).code;
  } catch (error) {
    configFailure(
      "TN_CONFIG_TRANSPILE_FAILED",
      context,
      error instanceof Error ? error.message : String(error),
    );
  }

  const compiledPath = path.join(cwd, `.threenative.config.${process.pid}.${Date.now()}.mjs`);
  try {
    await writeFile(compiledPath, code, "utf8");
  } catch (error) {
    configFailure(
      "TN_CONFIG_LOAD_FAILED",
      context,
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    let module: { default?: unknown };
    try {
      module = (await import(`${pathToFileURL(compiledPath).href}?cache=${Date.now()}`)) as {
        default?: unknown;
      };
    } catch (error) {
      configFailure(
        "TN_CONFIG_LOAD_FAILED",
        context,
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!isRecord(module.default)) {
      configFailure(
        "TN_CONFIG_DEFAULT_MISSING",
        context,
        "the config did not default-export an object.",
      );
    }
    return module.default;
  } finally {
    await unlink(compiledPath).catch(() => undefined);
  }
}

async function readManifest(cwd: string): Promise<IPackageManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(cwd, "package.json"), "utf8"));
  } catch (error) {
    fail("TN_CONFIG_PACKAGE_INVALID", error instanceof Error ? error.message : String(error));
  }
  if (!isRecord(parsed)) fail("TN_CONFIG_PACKAGE_INVALID", "package.json must contain an object.");
  return parsed as IPackageManifest;
}

function packageNativeEntry(manifest: IPackageManifest): string | undefined {
  if (manifest.threenative === undefined) return undefined;
  if (!isRecord(manifest.threenative)) {
    fail("TN_CONFIG_PACKAGE_INVALID", "package.json.threenative must be an object.");
  }
  assertKeys(manifest.threenative, "package.json.threenative", ["nativeEntry"]);
  const value = manifest.threenative.nativeEntry;
  if (value === undefined) return undefined;
  return nonEmptyString(value, "TN_NATIVE_ENTRY_MISSING", "package.json.threenative.nativeEntry");
}

function validateNativeEntry(value: unknown, cwd: string): string {
  const entry = nonEmptyString(value, "TN_NATIVE_ENTRY_MISSING", "nativeEntry");
  if (path.isAbsolute(entry)) {
    fail("TN_CONFIG_NATIVE_ENTRY_INVALID", "nativeEntry must be project-relative.");
  }
  const resolved = path.resolve(cwd, entry);
  const relative = path.relative(cwd, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    fail("TN_CONFIG_NATIVE_ENTRY_INVALID", "nativeEntry must stay inside the project.");
  }
  return entry;
}

async function validateApp(
  raw: unknown,
  name: string,
  cwd: string,
): Promise<IResolvedThreeNativeConfig["app"]> {
  const app = assertRecord(raw, "app");
  assertKeys(app, "app", ["id", "name", "version", "build", "icon", "icons"]);
  const id =
    app.id === undefined
      ? defaultAppId(name)
      : nonEmptyString(app.id, "TN_CONFIG_APP_ID_INVALID", "app.id");
  if (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(id)) {
    fail("TN_CONFIG_APP_ID_INVALID", "app.id must be a lower-case reverse-DNS identifier.");
  }
  const appName =
    app.name === undefined
      ? name
      : nonEmptyString(app.name, "TN_CONFIG_APP_NAME_INVALID", "app.name");
  const version =
    app.version === undefined
      ? "0.1.13"
      : nonEmptyString(app.version, "TN_CONFIG_APP_VERSION_INVALID", "app.version");
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    fail(
      "TN_CONFIG_APP_VERSION_INVALID",
      "app.version must contain three period-separated integer components.",
    );
  }
  const build = positiveInteger(app.build, 1, "TN_CONFIG_APP_BUILD_INVALID", "app.build");
  const icon =
    app.icon === undefined
      ? undefined
      : await validateProjectAsset(app.icon, cwd, "app.icon", {
          codePrefix: "TN_CONFIG_ICON",
          formats: ["png"],
          square: true,
        });
  const icons = await validateIconVariants(app.icons, cwd);
  if (
    icons?.android !== undefined &&
    icon === undefined &&
    icons.android.foreground === undefined
  ) {
    fail(
      "TN_CONFIG_BRAND_ANDROID_FOREGROUND_MISSING",
      "app.icons.android.foreground is required when app.icon is not declared.",
    );
  }
  return {
    id,
    name: appName,
    version,
    build,
    ...(icon === undefined ? {} : { icon }),
    ...(icons === undefined ? {} : { icons }),
  };
}

type BrandFormat = "png" | "svg";

interface IProjectAssetOptions {
  readonly codePrefix: string;
  readonly formats: readonly BrandFormat[];
  readonly requiresAlpha?: boolean;
  readonly square?: boolean;
}

async function validateProjectAsset(
  raw: unknown,
  cwd: string,
  label: string,
  options: IProjectAssetOptions,
): Promise<string> {
  const relative = nonEmptyString(raw, `${options.codePrefix}_INVALID`, label);
  if (path.isAbsolute(relative)) {
    fail(`${options.codePrefix}_PATH_INVALID`, `${label} must be project-relative: ${relative}`);
  }
  const resolved = path.resolve(cwd, relative);
  const withinProject = path.relative(cwd, resolved);
  if (
    withinProject === ".." ||
    withinProject.startsWith(`..${path.sep}`) ||
    path.isAbsolute(withinProject)
  ) {
    fail(
      `${options.codePrefix}_PATH_INVALID`,
      `${label} must stay inside the project: ${relative}`,
    );
  }
  const extension = path.extname(relative).slice(1).toLowerCase() as BrandFormat;
  if (!options.formats.includes(extension)) {
    fail(
      options.codePrefix === "TN_CONFIG_ICON"
        ? `${options.codePrefix}_INVALID`
        : `${options.codePrefix}_FORMAT_INVALID`,
      `${label} must use ${options.formats.map((format) => `.${format}`).join(" or ")}: ${relative}`,
    );
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(resolved);
  } catch {
    fail(`${options.codePrefix}_MISSING`, `${label} does not exist: ${relative}`);
  }
  if (!info.isFile()) fail(`${options.codePrefix}_MISSING`, `${label} is not a file: ${relative}`);
  let contents: Buffer;
  try {
    contents = await readFile(resolved);
  } catch (error) {
    fail(
      `${options.codePrefix}_INVALID`,
      `${label} could not be read at ${relative}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (extension === "svg") {
    if (!/<svg(?:\s|>)/iu.test(contents.toString("utf8"))) {
      fail(`${options.codePrefix}_INVALID`, `${label} is not a valid SVG file: ${relative}`);
    }
    return relative;
  }
  const png = parsePng(contents);
  if (png === undefined) {
    fail(`${options.codePrefix}_INVALID`, `${label} is not a valid PNG file: ${relative}`);
  }
  if (options.square === true && png.width !== png.height) {
    fail(
      `${options.codePrefix}_DIMENSIONS_INVALID`,
      `${label} must be square (${png.width}x${png.height}): ${relative}`,
    );
  }
  if (options.requiresAlpha === true && !png.hasAlpha) {
    fail(
      `${options.codePrefix}_ALPHA_INVALID`,
      `${label} must include an alpha channel: ${relative}`,
    );
  }
  return relative;
}

function validateBrandColor(raw: unknown, label: string): string {
  if (typeof raw !== "string" || !/^#[0-9a-f]{6}$/iu.test(raw)) {
    fail("TN_CONFIG_BRAND_COLOR_INVALID", `${label} must be a #rrggbb colour.`);
  }
  return raw;
}

async function validateIconVariants(
  raw: unknown,
  cwd: string,
): Promise<IThreeNativeIconVariants | undefined> {
  if (raw === undefined) return undefined;
  const icons = assertRecord(raw, "app.icons");
  assertKeys(icons, "app.icons", ["android", "ios", "web"]);
  const android =
    icons.android === undefined ? undefined : assertRecord(icons.android, "app.icons.android");
  const ios = icons.ios === undefined ? undefined : assertRecord(icons.ios, "app.icons.ios");
  const web = icons.web === undefined ? undefined : assertRecord(icons.web, "app.icons.web");
  if (android !== undefined)
    assertKeys(android, "app.icons.android", ["foreground", "background", "monochrome"]);
  if (ios !== undefined) assertKeys(ios, "app.icons.ios", ["dark", "tinted"]);
  if (web !== undefined)
    assertKeys(web, "app.icons.web", ["favicon", "maskable", "monochrome", "appleTouch"]);
  const androidResult =
    android === undefined
      ? undefined
      : {
          ...(android.foreground === undefined
            ? {}
            : {
                foreground: await validateProjectAsset(
                  android.foreground,
                  cwd,
                  "app.icons.android.foreground",
                  {
                    codePrefix: "TN_CONFIG_BRAND_ANDROID_FOREGROUND",
                    formats: ["png"],
                    requiresAlpha: true,
                    square: true,
                  },
                ),
              }),
          ...(android.background === undefined
            ? {}
            : {
                background: validateBrandColor(android.background, "app.icons.android.background"),
              }),
          ...(android.monochrome === undefined
            ? {}
            : {
                monochrome: await validateProjectAsset(
                  android.monochrome,
                  cwd,
                  "app.icons.android.monochrome",
                  {
                    codePrefix: "TN_CONFIG_BRAND_ANDROID_MONOCHROME",
                    formats: ["png"],
                    requiresAlpha: true,
                    square: true,
                  },
                ),
              }),
        };
  const iosResult =
    ios === undefined
      ? undefined
      : {
          ...(ios.dark === undefined
            ? {}
            : {
                dark: await validateProjectAsset(ios.dark, cwd, "app.icons.ios.dark", {
                  codePrefix: "TN_CONFIG_BRAND_IOS_DARK",
                  formats: ["png"],
                  square: true,
                }),
              }),
          ...(ios.tinted === undefined
            ? {}
            : {
                tinted: await validateProjectAsset(ios.tinted, cwd, "app.icons.ios.tinted", {
                  codePrefix: "TN_CONFIG_BRAND_IOS_TINTED",
                  formats: ["png"],
                  square: true,
                }),
              }),
        };
  const webResult =
    web === undefined
      ? undefined
      : {
          ...(web.favicon === undefined
            ? {}
            : {
                favicon: await validateProjectAsset(web.favicon, cwd, "app.icons.web.favicon", {
                  codePrefix: "TN_CONFIG_BRAND_WEB_FAVICON",
                  formats: ["png", "svg"],
                  square: true,
                }),
              }),
          ...(web.maskable === undefined
            ? {}
            : {
                maskable: await validateProjectAsset(web.maskable, cwd, "app.icons.web.maskable", {
                  codePrefix: "TN_CONFIG_BRAND_WEB_MASKABLE",
                  formats: ["png"],
                  square: true,
                }),
              }),
          ...(web.monochrome === undefined
            ? {}
            : {
                monochrome: await validateProjectAsset(
                  web.monochrome,
                  cwd,
                  "app.icons.web.monochrome",
                  {
                    codePrefix: "TN_CONFIG_BRAND_WEB_MONOCHROME",
                    formats: ["png"],
                    square: true,
                  },
                ),
              }),
          ...(web.appleTouch === undefined
            ? {}
            : {
                appleTouch: await validateProjectAsset(
                  web.appleTouch,
                  cwd,
                  "app.icons.web.appleTouch",
                  {
                    codePrefix: "TN_CONFIG_BRAND_WEB_APPLE_TOUCH",
                    formats: ["png"],
                    square: true,
                  },
                ),
              }),
        };
  return {
    ...(androidResult === undefined ? {} : { android: androidResult }),
    ...(iosResult === undefined ? {} : { ios: iosResult }),
    ...(webResult === undefined ? {} : { web: webResult }),
  };
}

function validateDisplay(raw: unknown): IResolvedThreeNativeConfig["display"] {
  const display = assertRecord(raw, "display");
  assertKeys(display, "display", ["orientation", "fullscreen", "keepScreenOn", "maxFps"]);
  const orientation = display.orientation === undefined ? "landscape" : display.orientation;
  if (
    typeof orientation !== "string" ||
    !ORIENTATIONS.includes(orientation as ThreeNativeOrientation)
  ) {
    fail(
      "TN_NATIVE_ORIENTATION_INVALID",
      "display.orientation must be landscape, portrait, or sensor.",
    );
  }
  return {
    orientation: orientation as ThreeNativeOrientation,
    fullscreen: booleanValue(
      display.fullscreen,
      true,
      "TN_CONFIG_FULLSCREEN_INVALID",
      "display.fullscreen",
    ),
    keepScreenOn: booleanValue(
      display.keepScreenOn,
      false,
      "TN_CONFIG_KEEP_SCREEN_ON_INVALID",
      "display.keepScreenOn",
    ),
    maxFps: maxFpsValue(display.maxFps),
  };
}

function validateWindow(raw: unknown, appName: string): IResolvedThreeNativeConfig["window"] {
  const window = assertRecord(raw, "window");
  assertKeys(window, "window", ["title", "width", "height", "maximized", "resizable"]);
  return {
    title:
      window.title === undefined
        ? appName
        : nonEmptyString(window.title, "TN_CONFIG_WINDOW_TITLE_INVALID", "window.title"),
    width: positiveInteger(window.width, 1280, "TN_CONFIG_WINDOW_WIDTH_INVALID", "window.width"),
    height: positiveInteger(window.height, 720, "TN_CONFIG_WINDOW_HEIGHT_INVALID", "window.height"),
    maximized: booleanValue(
      window.maximized,
      false,
      "TN_CONFIG_WINDOW_MAXIMIZED_INVALID",
      "window.maximized",
    ),
    resizable: booleanValue(
      window.resizable,
      true,
      "TN_CONFIG_WINDOW_RESIZABLE_INVALID",
      "window.resizable",
    ),
  };
}

async function validateBootSplash(
  raw: unknown,
  cwd: string,
): Promise<IResolvedThreeNativeConfig["bootSplash"]> {
  if (raw === undefined) return undefined;
  const bootSplash = assertRecord(raw, "bootSplash");
  assertKeys(bootSplash, "bootSplash", ["backgroundColor", "image"]);
  const backgroundColor =
    bootSplash.backgroundColor === undefined
      ? undefined
      : validateBrandColor(bootSplash.backgroundColor, "bootSplash.backgroundColor");
  const image =
    bootSplash.image === undefined
      ? undefined
      : await validateProjectAsset(bootSplash.image, cwd, "bootSplash.image", {
          codePrefix: "TN_CONFIG_BRAND_SPLASH",
          formats: ["png"],
        });
  return {
    ...(backgroundColor === undefined ? {} : { backgroundColor }),
    ...(image === undefined ? {} : { image }),
  };
}

function validateEngine(raw: unknown): "threejs" | "threenative" {
  if (raw === undefined) return "threenative";
  if (raw === "threejs" || raw === "threenative") return raw;
  if (raw === "native" || raw === "legacy")
    return fail(
      "TN_CONFIG_ENGINE_RENAMED",
      `engine "${raw}" was renamed: use "${raw === "native" ? "threenative" : "threejs"}".`,
    );
  return fail("TN_CONFIG_ENGINE_INVALID", 'engine must be "threenative" or "threejs".');
}

/** Which renderer draws `src/ui/`. @see IThreeNativeConfig.ui */
const UI_RENDERERS: readonly ThreeNativeUiRenderer[] = ["native", "native-css", "web"];

/**
 * The public surface is exactly three words. Which web view a `"web"` game lands on — and whether
 * a platform composites a sibling layer or renders to a texture — is the host's business, so a
 * typo here fails naming the valid values rather than defaulting to one of them.
 */
function validateUi(raw: unknown): IResolvedThreeNativeConfig["ui"] {
  const ui = assertRecord(raw, "ui");
  assertKeys(ui, "ui", ["renderer"]);
  const renderer = ui.renderer === undefined ? "web" : ui.renderer;
  if (typeof renderer !== "string" || !UI_RENDERERS.includes(renderer as ThreeNativeUiRenderer)) {
    fail("TN_CONFIG_UI_RENDERER_INVALID", "ui.renderer must be web, native or native-css.");
  }
  return { renderer: renderer as ThreeNativeUiRenderer };
}

function validateRenderer(raw: unknown): IResolvedThreeNativeConfig["renderer"] {
  const renderer = assertRecord(raw, "renderer");
  assertKeys(renderer, "renderer", [
    "preferWebGPU",
    "resolutionScale",
    "antialias",
    "alphaAntialiasing",
    "projection",
    "minimumProjectedPixels",
    "matrixWorld",
    "android",
  ]);
  const android = assertRecord(renderer.android, "renderer.android");
  assertKeys(android, "renderer.android", ["resolutionScale", "antialias", "alphaAntialiasing"]);
  const resolutionScale = renderer.resolutionScale;
  const androidResolutionScale = android.resolutionScale;
  // The same rule the engine enforces at `resolveRendererScaleSetting`, stated here so a game
  // learns it from a named config failure rather than from a renderer that throws mid-boot:
  // "auto", or a number in (0, 1]. Above one asks for a buffer larger than the surface.
  for (const [name, value] of [
    ["renderer.resolutionScale", resolutionScale],
    ["renderer.android.resolutionScale", androidResolutionScale],
  ] as const) {
    if (value === undefined || value === "auto") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 1) {
      fail(
        "TN_CONFIG_RENDERER_RESOLUTION_SCALE_INVALID",
        `${name} must be "auto" or a number within (0, 1].`,
      );
    }
  }
  const antialias = booleanOrUndefined(renderer.antialias, "renderer.antialias");
  const androidAntialias = booleanOrUndefined(android.antialias, "renderer.android.antialias");
  const alphaAntialiasing = booleanOrUndefined(
    renderer.alphaAntialiasing,
    "renderer.alphaAntialiasing",
  );
  const androidAlphaAntialiasing = booleanOrUndefined(
    android.alphaAntialiasing,
    "renderer.android.alphaAntialiasing",
  );
  const projection = booleanOrUndefined(renderer.projection, "renderer.projection");
  const minimumProjectedPixels = numberOrFalse(
    renderer.minimumProjectedPixels,
    "renderer.minimumProjectedPixels",
  );
  const matrixWorld = renderer.matrixWorld;
  if (matrixWorld !== undefined && matrixWorld !== "visible" && matrixWorld !== "all") {
    fail("TN_CONFIG_RENDERER_INVALID", 'renderer.matrixWorld must be "visible" or "all".');
  }
  const androidOverrides = {
    ...(androidResolutionScale === undefined
      ? {}
      : { resolutionScale: androidResolutionScale as number | "auto" }),
    ...(androidAntialias === undefined ? {} : { antialias: androidAntialias }),
    ...(androidAlphaAntialiasing === undefined
      ? {}
      : { alphaAntialiasing: androidAlphaAntialiasing }),
  };
  return {
    preferWebGPU: booleanValue(
      renderer.preferWebGPU,
      true,
      "TN_CONFIG_RENDERER_INVALID",
      "renderer.preferWebGPU",
    ),
    ...(antialias === undefined ? {} : { antialias }),
    ...(alphaAntialiasing === undefined ? {} : { alphaAntialiasing }),
    ...(projection === undefined ? {} : { projection }),
    ...(minimumProjectedPixels === undefined ? {} : { minimumProjectedPixels }),
    ...(matrixWorld === undefined ? {} : { matrixWorld: matrixWorld as "visible" | "all" }),
    ...(resolutionScale === undefined
      ? {}
      : { resolutionScale: resolutionScale as number | "auto" }),
    ...(Object.keys(androidOverrides).length === 0 ? {} : { android: androidOverrides }),
  };
}

function booleanOrUndefined(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("TN_CONFIG_RENDERER_INVALID", `${name} must be a boolean.`);
  return value as boolean;
}

function numberOrFalse(value: unknown, name: string): number | false | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    fail("TN_CONFIG_RENDERER_INVALID", `${name} must be false or a positive finite number.`);
  }
  return value as number;
}

const ASSET_TARGET_KEYS: readonly string[] = [
  "maxMaterials",
  "maxTriangles",
  "maxTextureDimension",
];

function validateAssetTargets(
  raw: unknown,
): NonNullable<IResolvedThreeNativeConfig["assets"]>["targets"] {
  const targets = assertRecord(raw, "assets.targets");
  assertKeys(targets, "assets.targets", ASSET_TARGET_KEYS);
  return {
    ...(targets.maxMaterials === undefined
      ? {}
      : {
          maxMaterials: positiveInteger(
            targets.maxMaterials,
            1,
            "TN_CONFIG_ASSETS_INVALID",
            "assets.targets.maxMaterials",
          ),
        }),
    ...(targets.maxTriangles === undefined
      ? {}
      : {
          maxTriangles: positiveInteger(
            targets.maxTriangles,
            1,
            "TN_CONFIG_ASSETS_INVALID",
            "assets.targets.maxTriangles",
          ),
        }),
    ...(targets.maxTextureDimension === undefined
      ? {}
      : {
          maxTextureDimension: positiveInteger(
            targets.maxTextureDimension,
            1,
            "TN_CONFIG_ASSETS_INVALID",
            "assets.targets.maxTextureDimension",
          ),
        }),
  };
}

const ASSET_TEXTURE_KEYS: readonly string[] = ["maxSize", "overrides", "quality"];
const TEXTURE_OVERRIDE_KEYS: readonly string[] = ["codec", "glob", "quality"];
const TEXTURE_CODECS: readonly string[] = ["etc1s", "none", "uastc"];

function textureQuality(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 255) {
    fail("TN_CONFIG_ASSETS_INVALID", `${label} must be an integer between 1 and 255.`);
  }
  return value;
}

function textureMaxSize(value: unknown): number | Readonly<Record<string, number>> {
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([slot, cap]) => {
        if (
          !/^[a-z][a-zA-Z]*Texture$/u.test(slot) ||
          typeof cap !== "number" ||
          !Number.isSafeInteger(cap) ||
          cap < 4
        )
          fail(
            "TN_CONFIG_ASSETS_INVALID",
            `assets.textures.maxSize.${slot} must name a glTF texture slot with a positive integer cap of at least 4.`,
          );
        return [slot, cap];
      }),
    );
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 4) {
    fail(
      "TN_CONFIG_ASSETS_INVALID",
      "assets.textures.maxSize must be a positive integer of at least 4.",
    );
  }
  return value;
}

function validateTextureOverrides(
  raw: unknown,
): NonNullable<IThreeNativeTexturesConfig["overrides"]> {
  if (!Array.isArray(raw)) {
    fail("TN_CONFIG_ASSETS_INVALID", "assets.textures.overrides must be an array.");
  }
  return raw.map((item, index) => {
    if (!isRecord(item)) {
      fail(
        "TN_CONFIG_ASSETS_INVALID",
        `assets.textures.overrides[${String(index)}] must be an object.`,
      );
    }
    assertKeys(item, `assets.textures.overrides[${String(index)}]`, TEXTURE_OVERRIDE_KEYS);
    const glob = nonEmptyString(
      item.glob,
      "TN_CONFIG_ASSETS_INVALID",
      `assets.textures.overrides[${String(index)}].glob`,
    );
    if (typeof item.codec !== "string" || !TEXTURE_CODECS.includes(item.codec)) {
      fail(
        "TN_CONFIG_ASSETS_INVALID",
        `assets.textures.overrides[${String(index)}].codec must be one of ${TEXTURE_CODECS.join(", ")}; received '${String(item.codec)}'.`,
      );
    }
    return {
      codec: item.codec as "etc1s" | "none" | "uastc",
      glob,
      ...(item.quality === undefined
        ? {}
        : {
            quality: textureQuality(
              item.quality,
              `assets.textures.overrides[${String(index)}].quality`,
            ),
          }),
    };
  });
}

function validateTextures(
  raw: unknown,
): NonNullable<IResolvedThreeNativeConfig["assets"]>["textures"] {
  if (raw === "none") return "none";
  const textures = assertRecord(raw, "assets.textures");
  assertKeys(textures, "assets.textures", ASSET_TEXTURE_KEYS);
  return {
    ...(textures.maxSize === undefined ? {} : { maxSize: textureMaxSize(textures.maxSize) }),
    ...(textures.quality === undefined
      ? {}
      : { quality: textureQuality(textures.quality, "assets.textures.quality") }),
    ...(textures.overrides === undefined
      ? {}
      : { overrides: validateTextureOverrides(textures.overrides) }),
  };
}

/** Every `assets.*` key the loader accepts. The compile step must accept the same set. */
export const ASSETS_CONFIG_KEYS = [
  "audio",
  "budget",
  "exclude",
  "concurrency",
  "lod",
  "models",
  "nativePackage",
  "source",
  "output",
  "targets",
  "textures",
] as const;
/** Every `assets.models` key the loader accepts. The compile step must accept the same set. */
export const MODELS_CONFIG_KEYS = [
  "compact",
  "lightmap",
  "passes",
  "quantize",
  "sharedImages",
  "simplify",
  "textures",
  "virtual",
] as const;
export const LIGHTMAP_CONFIG_KEYS = ["atlasSize", "padding"] as const;
export const MODEL_PASS_KEYS: readonly string[] = [
  "dedup",
  "meshopt",
  "prune",
  "quantize",
  "reorder",
  "restTracks",
];
export const MODEL_QUANTIZE_KEYS: readonly string[] = ["normalBits", "positionBits", "uvBits"];
export const MODEL_VIRTUAL_KEYS: readonly string[] = [
  "groupSize",
  "maxTriangles",
  "minSourceTriangles",
  "minTriangles",
  "simplifyRatio",
];

function bitDepth(value: unknown, label: string): number {
  // Depths low enough to warp a model are accepted, not rejected: the compile step's own
  // self-verification fails the build naming the drift instead of a config rule guessing.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 16) {
    fail("TN_CONFIG_ASSETS_INVALID", `${label} must be an integer between 1 and 16 bits.`);
  }
  return value;
}

function validateModels(raw: unknown): NonNullable<IResolvedThreeNativeConfig["assets"]>["models"] {
  if (raw === "none") return "none";
  const models = assertRecord(raw, "assets.models");
  assertKeys(models, "assets.models", MODELS_CONFIG_KEYS);
  if (models.sharedImages !== undefined && typeof models.sharedImages !== "boolean") {
    fail("TN_CONFIG_ASSETS_INVALID", "assets.models.sharedImages must be true or false.");
  }
  const sharedImages = models.sharedImages as boolean | undefined;
  let lightmap: IThreeNativeModelsConfig["lightmap"];
  if (models.lightmap !== undefined) {
    const rawLightmap = assertRecord(models.lightmap, "assets.models.lightmap");
    assertKeys(rawLightmap, "assets.models.lightmap", LIGHTMAP_CONFIG_KEYS);
    if (rawLightmap.atlasSize === undefined || rawLightmap.padding === undefined) {
      fail("TN_CONFIG_ASSETS_INVALID", "assets.models.lightmap requires atlasSize and padding.");
    }
    const atlasSize = positiveInteger(
      rawLightmap.atlasSize,
      1,
      "TN_CONFIG_ASSETS_INVALID",
      "assets.models.lightmap.atlasSize",
    );
    if (atlasSize % 4 !== 0) {
      fail("TN_CONFIG_ASSETS_INVALID", "assets.models.lightmap.atlasSize must be a multiple of 4.");
    }
    lightmap = {
      atlasSize,
      padding: positiveInteger(
        rawLightmap.padding,
        1,
        "TN_CONFIG_ASSETS_INVALID",
        "assets.models.lightmap.padding",
      ),
    };
  }
  let passes: IThreeNativeModelPassesConfig | undefined;
  if (models.passes !== undefined) {
    const rawPasses = assertRecord(models.passes, "assets.models.passes");
    assertKeys(rawPasses, "assets.models.passes", MODEL_PASS_KEYS);
    passes = {};
    for (const key of MODEL_PASS_KEYS) {
      const value = rawPasses[key];
      if (value === undefined) continue;
      if (typeof value !== "boolean")
        fail("TN_CONFIG_ASSETS_INVALID", `assets.models.passes.${key} must be true or false.`);
      passes = { ...passes, [key]: value } as IThreeNativeModelPassesConfig;
    }
  }
  let quantize: IThreeNativeModelsConfig["quantize"];
  if (models.quantize !== undefined) {
    const rawQuantize = assertRecord(models.quantize, "assets.models.quantize");
    assertKeys(rawQuantize, "assets.models.quantize", MODEL_QUANTIZE_KEYS);
    quantize = {};
    for (const key of MODEL_QUANTIZE_KEYS) {
      const value = rawQuantize[key];
      if (value === undefined) continue;
      quantize = {
        ...quantize,
        [key]: bitDepth(value, `assets.models.quantize.${key}`),
      } as IThreeNativeModelsConfig["quantize"];
    }
  }
  // Embedded-texture compression and simplification are validated by the asset pipeline
  // itself, which owns their shapes and reports TN_ASSETS_CONFIG_* for anything malformed.
  // Both are passed through rather than re-parsed here, because a second hand-written parser
  // for the same keys is exactly how the two `IThreeNativeModelsConfig` declarations in this
  // repo drifted apart in the first place: the pipeline grew `textures` and `simplify`, and
  // neither this validator nor its type knew, so a project literally could not declare a
  // feature the compile step already supported.
  const simplify = models.simplify as IThreeNativeModelsConfig["simplify"];
  const textures = models.textures as IThreeNativeModelsConfig["textures"];
  const compact = models.compact as IThreeNativeModelsConfig["compact"];
  let virtual: IThreeNativeModelsConfig["virtual"];
  if (models.virtual === "none") {
    virtual = "none";
  } else if (models.virtual !== undefined) {
    const rawVirtual = assertRecord(models.virtual, "assets.models.virtual");
    assertKeys(rawVirtual, "assets.models.virtual", MODEL_VIRTUAL_KEYS);
    const bake: Record<string, number> = {};
    for (const key of MODEL_VIRTUAL_KEYS) {
      const value = rawVirtual[key];
      if (value === undefined) continue;
      if (key === "simplifyRatio") {
        if (typeof value !== "number" || !(value > 0) || !(value < 1))
          fail(
            "TN_CONFIG_ASSETS_INVALID",
            "assets.models.virtual.simplifyRatio must be a number between 0 and 1, exclusive.",
          );
        bake.simplifyRatio = value as number;
        continue;
      }
      bake[key] = positiveInteger(
        value,
        1,
        "TN_CONFIG_ASSETS_INVALID",
        `assets.models.virtual.${key}`,
      );
    }
    virtual = bake as IThreeNativeModelsConfig["virtual"];
  }
  return {
    ...(compact === undefined ? {} : { compact }),
    ...(lightmap === undefined ? {} : { lightmap }),
    ...(passes === undefined || Object.keys(passes).length === 0 ? {} : { passes }),
    ...(quantize === undefined || Object.keys(quantize).length === 0 ? {} : { quantize }),
    ...(sharedImages === undefined ? {} : { sharedImages }),
    ...(simplify === undefined ? {} : { simplify }),
    ...(textures === undefined ? {} : { textures }),
    ...(virtual === undefined ? {} : { virtual }),
  };
}

const LOD_PRESETS: readonly ThreeNativeLodPreset[] = ["aggressive", "balanced", "quality"];
const LOD_MIN_TRIANGLES_SCOPES: readonly ThreeNativeLodMinTrianglesScope[] = ["primitive", "asset"];
const LOD_KEYS: readonly string[] = ["enabled", "generation", "overrides", "preset", "runtime"];
const LOD_GENERATION_KEYS: readonly string[] = [
  "errorTargets",
  "join",
  "maxLevels",
  "minSaving",
  "minTriangles",
  "minTrianglesScope",
];
const LOD_RUNTIME_KEYS: readonly string[] = ["hysteresis", "maxPixelError"];
const LOD_OVERRIDE_KEYS: readonly string[] = ["enabled", "generation", "preset", "runtime"];

function lodGeneration(raw: unknown, label: string): IThreeNativeLodConfig["generation"] {
  const value = assertRecord(raw, label);
  assertKeys(value, label, LOD_GENERATION_KEYS);
  const generation: {
    errorTargets?: readonly number[];
    join?: boolean;
    maxLevels?: number;
    minSaving?: number;
    minTriangles?: number;
    minTrianglesScope?: ThreeNativeLodMinTrianglesScope;
  } = {};
  if (value.join !== undefined) {
    if (typeof value.join !== "boolean") {
      fail("TN_CONFIG_ASSETS_INVALID", `${label}.join must be a boolean.`);
    }
    generation.join = value.join;
  }
  if (value.maxLevels !== undefined) {
    if (
      !Number.isSafeInteger(value.maxLevels) ||
      (value.maxLevels as number) < 1 ||
      (value.maxLevels as number) > 8
    ) {
      fail("TN_CONFIG_ASSETS_INVALID", `${label}.maxLevels must be an integer between 1 and 8.`);
    }
    generation.maxLevels = value.maxLevels as number;
  }
  if (value.minTriangles !== undefined) {
    generation.minTriangles = positiveInteger(
      value.minTriangles,
      1,
      "TN_CONFIG_ASSETS_INVALID",
      `${label}.minTriangles`,
    );
  }
  if (value.minTrianglesScope !== undefined) {
    if (
      typeof value.minTrianglesScope !== "string" ||
      !LOD_MIN_TRIANGLES_SCOPES.includes(value.minTrianglesScope as ThreeNativeLodMinTrianglesScope)
    ) {
      fail(
        "TN_CONFIG_ASSETS_INVALID",
        `${label}.minTrianglesScope must be one of ${LOD_MIN_TRIANGLES_SCOPES.join(", ")}.`,
      );
    }
    generation.minTrianglesScope = value.minTrianglesScope as ThreeNativeLodMinTrianglesScope;
  }
  if (value.minSaving !== undefined) {
    if (
      typeof value.minSaving !== "number" ||
      !Number.isFinite(value.minSaving) ||
      value.minSaving < 0 ||
      value.minSaving >= 1
    ) {
      fail("TN_CONFIG_ASSETS_INVALID", `${label}.minSaving must be a finite number in [0, 1).`);
    }
    generation.minSaving = value.minSaving;
  }
  if (value.errorTargets !== undefined) {
    const targets = value.errorTargets;
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > 16) {
      fail(
        "TN_CONFIG_ASSETS_INVALID",
        `${label}.errorTargets must be 1 to 16 geometric-error targets.`,
      );
    }
    let previous = -1;
    for (const target of targets) {
      if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
        fail("TN_CONFIG_ASSETS_INVALID", `${label}.errorTargets must be positive finite numbers.`);
      }
      if (target <= previous) {
        fail("TN_CONFIG_ASSETS_INVALID", `${label}.errorTargets must increase strictly.`);
      }
      previous = target;
    }
    generation.errorTargets = [...targets];
  }
  return generation;
}

function lodRuntime(raw: unknown, label: string): IThreeNativeLodConfig["runtime"] {
  const value = assertRecord(raw, label);
  assertKeys(value, label, LOD_RUNTIME_KEYS);
  const runtime: { hysteresis?: number; maxPixelError?: number } = {};
  if (value.maxPixelError !== undefined) {
    if (
      typeof value.maxPixelError !== "number" ||
      !Number.isFinite(value.maxPixelError) ||
      value.maxPixelError <= 0
    ) {
      fail("TN_CONFIG_ASSETS_INVALID", `${label}.maxPixelError must be a positive finite number.`);
    }
    runtime.maxPixelError = value.maxPixelError;
  }
  if (value.hysteresis !== undefined) {
    if (
      typeof value.hysteresis !== "number" ||
      !Number.isFinite(value.hysteresis) ||
      value.hysteresis < 0 ||
      value.hysteresis >= 0.5
    ) {
      fail("TN_CONFIG_ASSETS_INVALID", `${label}.hysteresis must be a finite number in [0, 0.5).`);
    }
    runtime.hysteresis = value.hysteresis;
  }
  return runtime;
}

function lodPreset(raw: unknown, label: string): ThreeNativeLodPreset {
  if (typeof raw !== "string" || !LOD_PRESETS.includes(raw as ThreeNativeLodPreset)) {
    fail("TN_CONFIG_ASSETS_INVALID", `${label} must be one of ${LOD_PRESETS.join(", ")}.`);
  }
  return raw as ThreeNativeLodPreset;
}

function lodOverride(raw: unknown, label: string): boolean | IThreeNativeLodOverride {
  if (typeof raw === "boolean") return raw;
  const value = assertRecord(raw, label);
  assertKeys(value, label, LOD_OVERRIDE_KEYS);
  return {
    ...(value.enabled === undefined
      ? {}
      : {
          enabled: booleanValue(
            value.enabled,
            true,
            "TN_CONFIG_ASSETS_INVALID",
            `${label}.enabled`,
          ),
        }),
    ...(value.generation === undefined
      ? {}
      : { generation: lodGeneration(value.generation, `${label}.generation`) }),
    ...(value.preset === undefined ? {} : { preset: lodPreset(value.preset, `${label}.preset`) }),
    ...(value.runtime === undefined
      ? {}
      : { runtime: lodRuntime(value.runtime, `${label}.runtime`) }),
  };
}

/**
 * Validates and normalizes `assets.lod` without resolving it: resolution is per asset (the
 * override table is keyed by source asset), so it happens where the asset is known. Unknown
 * fields, non-finite numbers, invalid enums and out-of-range values name their config path and
 * throw rather than silently falling back.
 */
function validateLod(raw: unknown): boolean | IThreeNativeLodConfig {
  if (typeof raw === "boolean") return raw;
  const value = assertRecord(raw, "assets.lod");
  assertKeys(value, "assets.lod", LOD_KEYS);
  const overrides: Record<string, boolean | IThreeNativeLodOverride> = {};
  if (value.overrides !== undefined) {
    if (!isRecord(value.overrides)) {
      fail("TN_CONFIG_ASSETS_INVALID", "assets.lod.overrides must be an object.");
    }
    for (const [key, entry] of Object.entries(value.overrides)) {
      if (key.trim() === "") {
        fail(
          "TN_CONFIG_ASSETS_INVALID",
          "assets.lod.overrides keys must be non-empty source asset paths.",
        );
      }
      overrides[key] = lodOverride(entry, `assets.lod.overrides['${key}']`);
    }
  }
  return {
    ...(value.enabled === undefined
      ? {}
      : {
          enabled: booleanValue(
            value.enabled,
            true,
            "TN_CONFIG_ASSETS_INVALID",
            "assets.lod.enabled",
          ),
        }),
    ...(value.generation === undefined
      ? {}
      : { generation: lodGeneration(value.generation, "assets.lod.generation") }),
    ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    ...(value.preset === undefined ? {} : { preset: lodPreset(value.preset, "assets.lod.preset") }),
    ...(value.runtime === undefined
      ? {}
      : { runtime: lodRuntime(value.runtime, "assets.lod.runtime") }),
  };
}

function validateBudget(raw: unknown): NonNullable<IResolvedThreeNativeConfig["assets"]>["budget"] {
  const limit = (value: unknown): value is number | "none" =>
    value === "none" || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
  if (limit(raw)) return raw;
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    Object.entries(raw).some(
      ([key, value]) => !["uncooked", "total"].includes(key) || !limit(value),
    )
  ) {
    fail(
      "TN_CONFIG_ASSETS_INVALID",
      'assets.budget must contain positive integer byte limits or "none" for uncooked and total.',
    );
  }
  return raw as NonNullable<IResolvedThreeNativeConfig["assets"]>["budget"];
}

/**
 * Checks a declared audio block with the compiler's own parser, then hands the declaration on
 * unchanged.
 *
 * Unchanged, not parsed: `parseAudioConfig` answers `undefined` for `"none"`, and `undefined` is
 * exactly what the compiler reads as "run the defaults" — forwarding the parsed value would turn
 * an opt-out into the full conditioning pass while the config still reported success. So this is
 * the `concurrency` seam again: validate here with the named code, hand the driver the
 * declaration, and let the driver re-check it. There is no second vocabulary for audio keys.
 */
function validateAudio(raw: unknown): "none" | IThreeNativeAudioConfig {
  try {
    parseAudioConfig(raw);
  } catch (error) {
    fail("TN_CONFIG_ASSETS_INVALID", error instanceof Error ? error.message : String(error));
  }
  return raw as "none" | IThreeNativeAudioConfig;
}

function validateAssets(raw: unknown): IResolvedThreeNativeConfig["assets"] {
  const assets = assertRecord(raw, "assets");
  assertKeys(assets, "assets", ASSETS_CONFIG_KEYS);
  const targets = assets.targets === undefined ? undefined : validateAssetTargets(assets.targets);
  const lod = assets.lod === undefined ? undefined : validateLod(assets.lod);
  const models = assets.models === undefined ? undefined : validateModels(assets.models);
  const textures = assets.textures === undefined ? undefined : validateTextures(assets.textures);
  if (
    assets.exclude !== undefined &&
    (!Array.isArray(assets.exclude) ||
      assets.exclude.some((glob) => typeof glob !== "string" || glob.trim() === ""))
  ) {
    fail("TN_CONFIG_ASSETS_INVALID", "assets.exclude must be an array of non-empty glob strings.");
  }
  if (assets.nativePackage !== undefined && typeof assets.nativePackage !== "boolean") {
    fail("TN_CONFIG_ASSETS_INVALID", "assets.nativePackage must be true or false.");
  }
  return {
    ...(assets.audio === undefined ? {} : { audio: validateAudio(assets.audio) }),
    ...(assets.exclude === undefined ? {} : { exclude: assets.exclude as readonly string[] }),
    ...(assets.budget === undefined ? {} : { budget: validateBudget(assets.budget) }),
    // The worker bound a bake may use. Validated here so a malformed value fails at config
    // load with the named code, and handed to the driver unchanged, which re-checks it —
    // the producer→consumer seam the config spec proves by running the pipeline.
    ...(assets.concurrency === undefined
      ? {}
      : {
          concurrency: positiveInteger(
            assets.concurrency,
            1,
            "TN_CONFIG_ASSETS_INVALID",
            "assets.concurrency",
          ),
        }),
    ...(assets.source === undefined
      ? {}
      : { source: nonEmptyString(assets.source, "TN_CONFIG_ASSETS_INVALID", "assets.source") }),
    ...(assets.output === undefined
      ? {}
      : { output: nonEmptyString(assets.output, "TN_CONFIG_ASSETS_INVALID", "assets.output") }),
    ...(targets === undefined ? {} : { targets }),
    ...(lod === undefined ? {} : { lod }),
    ...(models === undefined ? {} : { models }),
    ...(assets.nativePackage === undefined ? {} : { nativePackage: assets.nativePackage }),
    ...(textures === undefined ? {} : { textures }),
  };
}

/** One safe output-directory segment: no traversal, no separator, no case collision. */
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const PROFILE_ASSET_KEYS: readonly string[] = [
  "audio",
  "budget",
  "lod",
  "models",
  "nativePackage",
  "targets",
  "textures",
];
const PROFILE_TARGETS: readonly BuildTarget[] = ["android", "desktop", "ios", "web"];

/** What the caller asked for: the target being built, and a profile name when one was named. */
interface IProfileSelection {
  readonly profile?: string;
  readonly target: BuildTarget;
}

interface IResolvedProfile {
  /** The overlay as declared, still unvalidated: `validateAssets` sees the merged result. */
  readonly assets: Record<string, unknown>;
  /** The validated byte ceilings on what this profile's build may produce. */
  readonly artifactBudget?: ArtifactBudget;
  /** The validated runtime ceilings published into this build's report for the playtest lane. */
  readonly performanceBudget?: PerformanceBudget;
  readonly name: string;
  readonly source: "flag" | "default";
  readonly target: BuildTarget;
}

/** The byte ceilings a profile declares on what a build produced. */
type ArtifactBudget = NonNullable<
  NonNullable<IThreeNativeConfig["buildProfiles"]>["profiles"][string]["artifactBudget"]
>;
type ArtifactBudgetLimit = Required<ArtifactBudget>["artifactBytes"];

/** The runtime ceilings a profile declares on what its artifact does. */
type PerformanceBudget = NonNullable<
  NonNullable<IThreeNativeConfig["buildProfiles"]>["profiles"][string]["performanceBudget"]
>;

const ARTIFACT_BUDGET_KEYS: readonly string[] = ["artifactBytes", "packagedAssetBytes"];
const ARTIFACT_BUDGET_SEVERITIES: readonly string[] = ["error", "warn"];

/**
 * The playtest harness's own `assert.performance` fields, mirrored rather than imported.
 *
 * `@threenative/playtest` deliberately depends on nothing from this monorepo — it runs against
 * plain Three.js — so the one list that has to agree with it is spelled out on both sides and
 * pinned by `__tests__/build-report.spec.ts`, which fails the moment the two drift. A budget key
 * the harness does not know is a key nothing would ever evaluate.
 */
export const PERFORMANCE_BUDGET_KEYS: readonly string[] = [
  "maxDrawCalls",
  "maxFrameMsP95",
  "maxPassDrawCalls",
  "maxPassTriangles",
  "maxPhaseMsP95",
  "maxTriangles",
  "minFps",
];
/** Mirrors `PLAYTEST_FRAME_BUDGET_PHASES`. */
const PERFORMANCE_BUDGET_PHASES: readonly string[] = [
  "hostGap",
  "overlay",
  "render",
  "residual",
  "update",
];
/** Mirrors `PLAYTEST_FRAME_PASS_KINDS`. */
const PERFORMANCE_BUDGET_PASSES: readonly string[] = ["main", "shadow", "reflection", "nested"];

/**
 * A per-phase or per-pass ceiling: a non-empty map of known names to non-negative ceilings, the
 * shape the harness evaluates. An unknown name is refused here rather than reaching a run that
 * could not measure it.
 */
function validatePerformanceBudgetMap(
  raw: unknown,
  label: string,
  names: readonly string[],
  unit: string,
): Record<string, number> {
  const map = assertRecord(raw, label);
  const entries = Object.entries(map);
  if (entries.length === 0)
    fail("TN_CONFIG_PROFILE_INVALID", `${label} must name at least one entry.`);
  const budget: Record<string, number> = {};
  for (const [name, ceiling] of entries) {
    if (!names.includes(name)) {
      fail(
        "TN_CONFIG_PROFILE_INVALID",
        `${label}.${name} is not recognised. Expected one of: ${names.join(", ")}.`,
      );
    }
    if (typeof ceiling !== "number" || !Number.isFinite(ceiling) || ceiling < 0) {
      fail(
        "TN_CONFIG_PROFILE_INVALID",
        `${label}.${name} must be a non-negative number of ${unit}.`,
      );
    }
    budget[name] = ceiling;
  }
  return budget;
}

function validatePerformanceBudget(raw: unknown, label: string): PerformanceBudget {
  const budget = assertRecord(raw, `${label}.performanceBudget`);
  assertKeys(budget, `${label}.performanceBudget`, PERFORMANCE_BUDGET_KEYS);
  if (Object.keys(budget).length === 0) {
    fail(
      "TN_CONFIG_PROFILE_INVALID",
      `${label}.performanceBudget must declare at least one ceiling; an empty budget bounds nothing.`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of ["maxDrawCalls", "maxFrameMsP95", "maxTriangles", "minFps"] as const) {
    const value = budget[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(
        "TN_CONFIG_PROFILE_INVALID",
        `${label}.performanceBudget.${key} must be a non-negative number.`,
      );
    }
    out[key] = value;
  }
  for (const [key, names, unit] of [
    ["maxPassDrawCalls", PERFORMANCE_BUDGET_PASSES, "draw calls"],
    ["maxPassTriangles", PERFORMANCE_BUDGET_PASSES, "triangles"],
    ["maxPhaseMsP95", PERFORMANCE_BUDGET_PHASES, "milliseconds"],
  ] as const) {
    if (budget[key] === undefined) continue;
    out[key] = validatePerformanceBudgetMap(
      budget[key],
      `${label}.performanceBudget.${key}`,
      names,
      unit,
    );
  }
  return out as PerformanceBudget;
}

function artifactBudgetLimit(raw: unknown, label: string): ArtifactBudgetLimit {
  const limit = assertRecord(raw, label);
  assertKeys(limit, label, ["limit", "severity"]);
  const bytes = positiveInteger(limit.limit, 1, "TN_CONFIG_PROFILE_INVALID", `${label}.limit`);
  if (typeof limit.severity !== "string" || !ARTIFACT_BUDGET_SEVERITIES.includes(limit.severity)) {
    fail(
      "TN_CONFIG_PROFILE_INVALID",
      `${label}.severity must be one of ${ARTIFACT_BUDGET_SEVERITIES.join(", ")}.`,
    );
  }
  return { limit: bytes, severity: limit.severity as ArtifactBudgetLimit["severity"] };
}

function validateArtifactBudget(raw: unknown, label: string): ArtifactBudget {
  const budget = assertRecord(raw, `${label}.artifactBudget`);
  assertKeys(budget, `${label}.artifactBudget`, ARTIFACT_BUDGET_KEYS);
  const artifactBytes =
    budget.artifactBytes === undefined
      ? undefined
      : artifactBudgetLimit(budget.artifactBytes, `${label}.artifactBudget.artifactBytes`);
  const packagedAssetBytes =
    budget.packagedAssetBytes === undefined
      ? undefined
      : artifactBudgetLimit(
          budget.packagedAssetBytes,
          `${label}.artifactBudget.packagedAssetBytes`,
        );
  return {
    ...(artifactBytes === undefined ? {} : { artifactBytes }),
    ...(packagedAssetBytes === undefined ? {} : { packagedAssetBytes }),
  };
}

/**
 * Validates the declaration, then picks the one profile this build cooks with.
 *
 * Selection is the flag first, the target's default second, and no overlay at all otherwise —
 * which is exactly what every project without `buildProfiles` gets, so a name that cannot be
 * honoured is a failure here rather than a build that quietly shipped the wrong representation.
 */
function resolveBuildProfile(
  raw: unknown,
  selection: IProfileSelection | undefined,
): IResolvedProfile | undefined {
  if (raw === undefined) {
    if (selection?.profile !== undefined) {
      fail(
        "TN_CONFIG_PROFILE_UNKNOWN",
        `--profile ${selection.profile} was requested but ${CONFIG_FILE} declares no buildProfiles.`,
      );
    }
    return undefined;
  }
  const group = assertRecord(raw, "buildProfiles");
  assertKeys(group, "buildProfiles", ["defaults", "profiles"]);
  const defaults = assertRecord(group.defaults, "buildProfiles.defaults");
  assertKeys(defaults, "buildProfiles.defaults", PROFILE_TARGETS);
  for (const [target, name] of Object.entries(defaults)) {
    if (typeof name !== "string" || name.length === 0) {
      fail("TN_CONFIG_PROFILE_INVALID", `buildProfiles.defaults.${target} must name a profile.`);
    }
  }
  const profiles = assertRecord(group.profiles, "buildProfiles.profiles");
  const declared = Object.keys(profiles);
  if (declared.length === 0) {
    fail("TN_CONFIG_GROUP_INVALID", "buildProfiles.profiles must declare at least one profile.");
  }
  // Every declared profile is validated, not only the selected one: a broken budget that only
  // bites when someone names that profile is a build that fails at the worst possible moment.
  const budgets: Record<string, ArtifactBudget> = {};
  const performanceBudgets: Record<string, PerformanceBudget> = {};
  for (const name of declared) {
    const label = `buildProfiles.profiles['${name}']`;
    if (!PROFILE_NAME.test(name)) {
      fail(
        "TN_CONFIG_PROFILE_NAME_INVALID",
        `${label} is not a usable profile name ('${name}'): names are one lower-case path segment matching /^[a-z0-9][a-z0-9_-]{0,63}$/, so no name can traverse out of the build directory or collide by case.`,
      );
    }
    const profile = assertRecord(profiles[name], label);
    assertKeys(profile, label, ["artifactBudget", "assets", "performanceBudget"]);
    assertKeys(
      assertRecord(profile.assets, `${label}.assets`),
      `${label}.assets`,
      PROFILE_ASSET_KEYS,
    );
    if (profile.artifactBudget !== undefined) {
      budgets[name] = validateArtifactBudget(profile.artifactBudget, label);
    }
    if (profile.performanceBudget !== undefined) {
      performanceBudgets[name] = validatePerformanceBudget(profile.performanceBudget, label);
    }
  }
  for (const [target, name] of Object.entries(defaults)) {
    if (typeof name === "string" && !Object.hasOwn(profiles, name)) {
      fail(
        "TN_CONFIG_PROFILE_UNKNOWN",
        `buildProfiles.defaults.${target} names '${name}', which is not declared. Declared profiles: ${declared.join(", ")}.`,
      );
    }
  }
  if (selection === undefined) return undefined;
  const requested = selection.profile;
  const name = requested ?? (defaults[selection.target] as string | undefined);
  if (name === undefined) return undefined;
  const profile = profiles[name] as Record<string, unknown> | undefined;
  if (profile === undefined) {
    const asked =
      requested === undefined ? `buildProfiles.defaults.${selection.target}` : `--profile ${name}`;
    fail(
      "TN_CONFIG_PROFILE_UNKNOWN",
      `${asked} names a profile this project does not declare. Declared profiles: ${declared.join(", ")}.`,
    );
  }
  return {
    assets: isRecord(profile.assets) ? profile.assets : {},
    ...(budgets[name] === undefined ? {} : { artifactBudget: budgets[name] }),
    ...(performanceBudgets[name] === undefined
      ? {}
      : { performanceBudget: performanceBudgets[name] }),
    name,
    source: requested === undefined ? "default" : "flag",
    target: selection.target,
  };
}

/**
 * The whole merge rule, in one place: two plain objects merge field by field, anything else is
 * the overlay's. So arrays replace, `"none"` and `false` in the overlay win, an overlay object
 * replaces a base `"none"`, and a base `"none"` the overlay says nothing about stays `"none"`.
 * Every level returns a new object, so the project's own config object is never written to.
 */
function mergeProfileOverlay(base: unknown, overlay: Record<string, unknown>): unknown {
  if (!isRecord(base)) return overlay;
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = merged[key];
    merged[key] =
      isRecord(current) && isRecord(value) ? mergeProfileOverlay(current, value) : value;
  }
  return merged;
}

/**
 * `codec: "none"` is how a project says "ship these bytes as authored" — both texture passes
 * return them before they resize. A profile cap asking for smaller pixels and an override asking
 * for the original ones are a contradiction the pass would settle by ignoring the cap, so it is
 * settled here instead, naming the selector that would have been ignored.
 */
function assertProfileCapReachable(
  assets: NonNullable<IResolvedThreeNativeConfig["assets"]>,
  overlay: Record<string, unknown>,
  name: string,
): void {
  const overlayTextures = overlay.textures;
  const overlayModels = overlay.models;
  const caps =
    (isRecord(overlayTextures) && overlayTextures.maxSize !== undefined) ||
    (isRecord(overlayModels) &&
      isRecord(overlayModels.textures) &&
      overlayModels.textures.maxSize !== undefined);
  if (!caps) return;
  const conflicts: string[] = [];
  if (assets.textures !== undefined && assets.textures !== "none") {
    for (const override of assets.textures.overrides ?? []) {
      if (override.codec === "none") {
        conflicts.push(`assets.textures.overrides glob '${override.glob}' declares codec "none"`);
      }
    }
  }
  const models = assets.models;
  const modelTextures = models === undefined || models === "none" ? undefined : models.textures;
  if (modelTextures !== undefined && modelTextures !== "none") {
    for (const override of modelTextures.overrides ?? []) {
      if (override.codec === "none") {
        conflicts.push(
          `assets.models.textures.overrides slot '${override.slot}' declares codec "none"`,
        );
      }
    }
  }
  if (conflicts.length > 0) {
    fail(
      "TN_CONFIG_PROFILE_CONFLICT",
      `profile '${name}' caps texture size, and ${conflicts.join("; ")}, which returns the authored bytes before resizing. Drop the override, or take the cap out of the profile.`,
    );
  }
}

async function loadConfigInternal(
  root: string,
  selection?: IProfileSelection,
): Promise<IResolvedThreeNativeConfig> {
  const packagePath = path.join(root, "package.json");
  const sourcePath = path.join(root, CONFIG_FILE);
  const manifest = await withConfigContext(packageContext(root), "TN_CONFIG_PACKAGE_INVALID", () =>
    readManifest(root),
  );
  const name = await withConfigContext(packageContext(root), "TN_CONFIG_PACKAGE_INVALID", () =>
    packageDisplayName(manifest),
  );
  const packageEntry = await withConfigContext(
    packageContext(root),
    "TN_CONFIG_PACKAGE_INVALID",
    () => packageNativeEntry(manifest),
  );
  const raw = await importConfig(root);
  const sources = packageEntry === undefined ? [sourcePath] : [sourcePath, packagePath];
  return withConfigContext(
    validationContext(root, sources),
    "TN_CONFIG_VALIDATION_FAILED",
    async () => {
      if (raw !== undefined) {
        assertKeys(raw, "config", [
          "app",
          "engine",
          "display",
          "bootSplash",
          "window",
          "nativeEntry",
          "renderer",
          "ui",
          "assets",
          "buildProfiles",
        ]);
      }
      const configuredEntry = raw?.nativeEntry;
      if (configuredEntry !== undefined && packageEntry !== undefined) {
        fail(
          "TN_CONFIG_CONFLICT",
          "nativeEntry is declared in both threenative.config.ts and package.json.",
        );
      }
      const app = await validateApp(raw?.app, name, root);
      const bootSplash = await validateBootSplash(raw?.bootSplash, root);
      // The overlay lands on the raw declaration before validation, so every rule above applies
      // to the merged result and an overlay can never smuggle an unvalidated value to a pass.
      const profile = resolveBuildProfile(raw?.buildProfiles, selection);
      const rawAssets =
        profile === undefined ? raw?.assets : mergeProfileOverlay(raw?.assets, profile.assets);
      const assets = rawAssets === undefined ? undefined : validateAssets(rawAssets);
      if (assets !== undefined && profile !== undefined) {
        assertProfileCapReachable(assets, profile.assets, profile.name);
      }
      return {
        app,
        engine: validateEngine(raw?.engine),
        display: validateDisplay(raw?.display),
        window: validateWindow(raw?.window, app.name),
        nativeEntry: validateNativeEntry(configuredEntry ?? packageEntry ?? "src/game.ts", root),
        renderer: validateRenderer(raw?.renderer),
        ui: validateUi(raw?.ui),
        ...(bootSplash === undefined ? {} : { bootSplash }),
        ...(assets === undefined ? {} : { assets }),
        ...(profile === undefined
          ? {}
          : {
              buildProfile: {
                name: profile.name,
                source: profile.source,
                target: profile.target,
                ...(profile.artifactBudget === undefined
                  ? {}
                  : { artifactBudget: profile.artifactBudget }),
                ...(profile.performanceBudget === undefined
                  ? {}
                  : { performanceBudget: profile.performanceBudget }),
              },
            }),
      };
    },
  );
}

export async function loadConfig(
  cwd: string,
  selection?: IProfileSelection,
): Promise<IResolvedThreeNativeConfig> {
  const root = path.resolve(cwd);
  return withConfigContext(
    validationContext(root, [path.join(root, CONFIG_FILE), path.join(root, "package.json")]),
    "TN_CONFIG_VALIDATION_FAILED",
    () => loadConfigInternal(root, selection),
  );
}
