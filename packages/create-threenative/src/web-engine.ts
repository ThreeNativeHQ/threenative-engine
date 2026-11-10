import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The asset decoders the web build ships, per format.
 *
 * Meshopt geometry decodes on both engines: on `engine: "threenative"` the engine's own glTF loader
 * decompresses EXT/KHR_meshopt_compression with meshoptimizer, which `pnpm wasm:build` provisions
 * and without which the `tn-native-engine-web` target refuses to link (PRD-861).
 *
 * KTX2 stays off for the owned engine by measurement, not by capability. The engine transcodes
 * KHR_texture_basisu to BC7 or ETC2 and uploads the blocks (PRD-867), and three's KTX2Loader runs on
 * it, but the download costs more: Midway's KTX2 cook is 189,852,625 B against 125,132,608 B with
 * WebP model textures, mostly UASTC images of 4 MB and more. Turn it on when the cook's KTX2 bytes
 * are not above WebP's.
 *
 * `threenative build` and each template's dev-server asset watch both read it, so the two cook the
 * same bytes.
 */
export function webRuntimeDecoders(config: {
  readonly engine?: "threejs" | "threenative";
}): { readonly ktx2: boolean; readonly meshopt: boolean } {
  return config.engine === "threejs"
    ? { ktx2: true, meshopt: true }
    : { ktx2: false, meshopt: true };
}

/** The module every `three`, `three/webgpu` and `three/tsl` import becomes under `engine: "threenative"`. */
export const WEB_ENGINE_ID = "\0threenative:web-engine";
const UPSTREAM = ["three", "three/webgpu", "three/tsl"] as const;
const POST_EFFECT_ADDONS: readonly string[] = [
  "GTAONode",
  "DenoiseNode",
  "SMAANode",
  "BloomNode",
  "TRAANode",
  "FilmNode",
  "Lut3DNode",
  // Refused on use, as on the V8 player: upstream's copies run `Fn(...).setLayout(...)` at import.
  "FXAANode",
  "GodraysNode",
  "SSGINode",
  "SSRNode",
  "SharpenNode",
].map((node) => `three/addons/tsl/display/${node}.js`);
/**
 * Addons the engine binds as its own classes (as the V8 bundler maps them): the addon path becomes a
 * module re-exporting the engine class, so the upstream addon never extends an engine base it does
 * not match (upstream RoundedBoxGeometry writes `type` on the engine BoxGeometry).
 */
const ENGINE_ADDON_CLASSES: Readonly<Record<string, string>> = {
  "three/addons/geometries/RoundedBoxGeometry.js": "RoundedBoxGeometry",
};
const ENGINE_ADDON_PREFIX = "\0threenative:web-engine-addon:";
/** three's SkeletonUtils addon over the engine's SkeletonUtils namespace (shared with the V8 player). */
const SKELETON_UTILS_ID = "\0threenative:web-engine-skeleton-utils";
/** The product Wasm entry inside the installed `@threenative/runtime-native` (PRD-540 phase 2). */
export const WASM_ENGINE_ENTRY = "build/web/tn-native-engine-web.mjs";
/**
 * The threaded engine beside it (PRD-752 phase 4), the one every page loads: the engine's job pool has
 * workers on every page. A missing module, a page without cross-origin isolation, or a pool with no
 * worker refuses to start (owner, 2026-10-29: "just force all to use worker threads"). The
 * single-thread entry stays for Node hosts (tests, the ABI check), which have no isolation.
 */
export const WASM_THREADS_ENTRY = "build/web/tn-native-engine-web-threads.mjs";
/** The refusal a page without engine worker threads raises (TN_FRAME_BUDGET.threads names the cause). */
const THREADS_OFF = "TN_WEB_THREADS_OFF";

/**
 * three's math modules the engine's own JS value classes borrow (PRD-742). They carry no renderer,
 * so the runtime may bundle them; a game still may not (the deep-import refusal below).
 */
const ENGINE_MATH_MODULES = new Set([
  "three/src/math/Box3.js",
  "three/src/math/Color.js",
  "three/src/math/ColorManagement.js",
  "three/src/math/Euler.js",
  "three/src/math/Matrix3.js",
  "three/src/math/Matrix4.js",
  "three/src/math/Quaternion.js",
  "three/src/math/Sphere.js",
  "three/src/math/Vector2.js",
  "three/src/math/Vector3.js",
  "three/src/math/Vector4.js",
  // three's loader base classes (browser-loaders.ts): fetch and request tracking, no drawing.
  "three/src/loaders/Cache.js",
  "three/src/loaders/FileLoader.js",
  "three/src/loaders/Loader.js",
  "three/src/loaders/LoadingManager.js",
]);
/** Where the browser back end's value classes live: only these may import three's math modules. */
const ENGINE_MATH_IMPORTER =
  /[\\/](?:browser-math\.ts|browser-loaders\.ts|web-engine-runtime\.js)(?:\?.*)?$/u;

export interface IWebEnginePlugin {
  readonly name: string;
  readonly enforce: "pre";
  configResolved(config: { readonly root: string; readonly command?: "build" | "serve" }): void;
  resolveId(source: string, importer?: string): string | null;
  load(id: string): Promise<string | null>;
}

/** A browser module: bundled beside this one in `dist`, or the three-native workspace source. */
function browserModule(built: string, source: string): string {
  const bundled = fileURLToPath(new URL(`./${built}`, import.meta.url));
  if (existsSync(bundled)) return bundled;
  const workspace = fileURLToPath(new URL(`../../three-native/src/${source}`, import.meta.url));
  if (existsSync(workspace)) return workspace;
  throw new Error(`TN_WEB_ENGINE_RUNTIME_MISSING: neither ${bundled} nor ${workspace} exists.`);
}

/** The binding runtime every upstream three import resolves through. */
const runtimeModule = () => browserModule("web-engine-runtime.js", "browser-entry.ts");

// The engine is the default; upstream three is the user's choice to make, never a build fix.
const OPT_OUT =
  'engine: "threejs" in threenative.config.ts switches to upstream three only when the user asks for it.';

function wasmModule(root: string, explicit: string | undefined): string {
  if (explicit !== undefined) {
    if (!existsSync(explicit))
      throw new Error(
        `TN_WASM_ENGINE_MISSING: engine "threenative" needs the Wasm engine at ${explicit}.`,
      );
    return explicit;
  }
  let entry: string;
  try {
    const require = createRequire(path.join(root, "package.json"));
    entry = path.join(
      path.dirname(require.resolve("@threenative/runtime-native/package.json")),
      WASM_ENGINE_ENTRY,
    );
  } catch {
    throw new Error(
      `TN_WASM_ENGINE_MISSING: engine "threenative" needs @threenative/runtime-native installed in ${root}; install it (its npm package ships the Wasm engine). ${OPT_OUT}`,
    );
  }
  if (!existsSync(entry))
    throw new Error(
      `TN_WASM_ENGINE_MISSING: engine "threenative" needs the Wasm engine at ${entry}; reinstall @threenative/runtime-native, or in a ThreeNative checkout run \`pnpm wasm:build\` from the repository root (it fetches stb, cgltf and webp-source, then builds), or build it with \`cmake --build build/wasm --target tn-native-engine-web\` in packages/runtime-native. ${OPT_OUT}`,
    );
  return entry;
}

/** Every export name of the project's own upstream three, which the game was written against. */
async function upstreamNames(root: string): Promise<string[]> {
  const require = createRequire(path.join(root, "package.json"));
  const modules = await Promise.all(
    UPSTREAM.map((id) => import(pathToFileURL(require.resolve(id)).href) as Promise<object>),
  );
  return [...new Set(modules.flatMap((module) => Object.keys(module)))]
    .filter((name) => name !== "default" && name !== "module.exports")
    .sort();
}

/** A refused export's error, as `refused` in three-native's browser-entry.ts words it. */
const REFUSAL = /^(TN_[A-Z0-9_]+): (\S+) is not available on the Wasm engine\.$/u;

type CreateModule = (options: Record<string, unknown>) => Promise<object>;

/**
 * Every upstream export name the installed Wasm engine refuses, with the code a page throws on its
 * first use (PRD-830). The runtime decides, not a copy of its rules: the catalog alone marks names
 * `unsupported` that the runtime binds (WebGPURenderer, pass). This boots the single-thread engine
 * in Node, binds the project's names as a page does, and reads back each refusal.
 */
export async function upstreamRefusals(
  root: string,
  wasm?: string,
): Promise<ReadonlyMap<string, string>> {
  const entry = wasmModule(root, wasm);
  const binary = readFileSync(entry.replace(/\.mjs$/u, ".wasm"));
  const create = ((await import(pathToFileURL(entry).href)) as { default: CreateModule }).default;
  const { bindWebEngine } = (await import(pathToFileURL(runtimeModule()).href)) as {
    bindWebEngine: (
      create: CreateModule,
      names: readonly string[],
    ) => Promise<Record<string, unknown>>;
  };
  const names = await upstreamNames(root);
  const bound = await bindWebEngine(
    (options) =>
      create({
        ...options,
        print: () => {},
        printErr: () => {},
        // The web build fetches its .wasm by URL; Node has no page to fetch from.
        instantiateWasm(
          imports: WebAssembly.Imports,
          receive: (instance: WebAssembly.Instance, module: WebAssembly.Module) => void,
        ) {
          void WebAssembly.instantiate(binary, imports).then((result) =>
            receive(result.instance, result.module),
          );
          return {};
        },
      }),
    names,
  );
  return refusalsOf(bound, names);
}

/** Each refused name in `bound` (bindUpstreamExports's output) with the code its first use throws. */
export function refusalsOf(
  bound: Readonly<Record<string, unknown>>,
  names: readonly string[],
): ReadonlyMap<string, string> {
  const refusals = new Map<string, string>();
  for (const name of names) {
    const value = bound[name];
    if (typeof value !== "function") continue;
    try {
      Reflect.ownKeys(value); // a refusal throws on any read, a bound class never does
    } catch (error) {
      const match = REFUSAL.exec(error instanceof Error ? error.message : "");
      if (match?.[2] === name && match[1] !== undefined) refusals.set(name, match[1]);
    }
  }
  return refusals;
}

export interface IWebEngineOptions {
  /** The project root; Vite's own root when omitted. */
  readonly root?: string;
  /** `threenative.config.ts`'s `engine`: anything but `"threenative"` leaves upstream three alone. */
  readonly engine?: "threejs" | "threenative";
  /** The Wasm engine's ES module, for a workspace build that does not install runtime-native. */
  readonly wasm?: string;
  /**
   * Refuse a page without worker threads (TN_WEB_THREADS_OFF). Default: everywhere but a Vite build,
   * so the dev server, playtests and conformance fail closed while a shipped game still loads: it
   * falls back to the single-thread engine and warns (owner, 2026-11-08: "so at least the game loads").
   */
  readonly strict?: boolean;
}

/**
 * Routes a web build's upstream three imports to the Wasm engine (PRD-540) when `engine` is
 * `"threenative"`. Deep imports into three's own source would bundle the upstream engine beside it, so
 * they fail the build. The scaffold's web branding plugin applies the config switch for Vite.
 */
export function createWebEnginePlugin(options: IWebEngineOptions = {}): IWebEnginePlugin {
  let root = options.root;
  let strict = options.strict ?? true;
  const native = options.engine === "threenative";
  const projectRoot = (): string => {
    if (root === undefined)
      throw new Error("TN_WEB_ENGINE_ROOT: Vite has not resolved its config yet.");
    return root;
  };
  return {
    name: "threenative-web-engine",
    enforce: "pre",
    configResolved(config) {
      root ??= config.root;
      strict = options.strict ?? config.command !== "build";
    },
    resolveId(specifier, importer = "") {
      if (!native) return null;
      // three ships each addon under `addons/` and under its older `examples/jsm/` path.
      const source = specifier.replace(/^three\/examples\/jsm\//u, "three/addons/");
      if ((UPSTREAM as readonly string[]).includes(source)) return WEB_ENGINE_ID;
      const engineClass = ENGINE_ADDON_CLASSES[source];
      if (engineClass !== undefined) return ENGINE_ADDON_PREFIX + engineClass;
      if (source === "three/addons/utils/SkeletonUtils.js") return SKELETON_UTILS_ID;
      // The engine's MeshBVH answers picking with its own raycast; the upstream package extends
      // three's math classes and cannot load over the engine.
      if (source === "three-mesh-bvh")
        return browserModule("web-engine-mesh-bvh.js", "addons/mesh-bvh.ts");
      if (source === "three-mesh-bvh/webgpu")
        return browserModule("web-engine-mesh-bvh-webgpu.js", "addons/mesh-bvh-webgpu.ts");
      // three's mergeGeometries over the engine's geometries; the upstream addon builds attributes
      // around arrays it fills afterwards, which an engine attribute has already copied.
      if (source === "three/addons/utils/BufferGeometryUtils.js")
        return browserModule(
          "web-engine-buffer-geometry-utils.js",
          "addons/buffer-geometry-utils.ts",
        );
      // three's DecalGeometry clipping, ported over the engine's geometry classes.
      if (source === "three/addons/geometries/DecalGeometry.js")
        return browserModule("web-engine-decal-geometry.js", "addons/decal-geometry.ts");
      // three's CCD IK solver, ported over the engine's bones and math classes.
      if (source === "three/addons/animation/CCDIKSolver.js")
        return browserModule("web-engine-ccd-ik-solver.js", "addons/ccd-ik-solver.ts");
      // Upstream's HDRLoader extends DataTextureLoader, which the engine does not bind; this one
      // decodes with the same RGBE parser into an engine DataTexture.
      if (source === "three/addons/loaders/HDRLoader.js")
        return browserModule("web-engine-hdr-loader.js", "addons/hdr-loader.ts");
      // GTAO, Denoise, SMAA and Bloom are the engine's live post effects (lane-531), shared with V8.
      // Models load through the engine's own glTF loader; upstream GLTFLoader never settles over it.
      if (source === "three/addons/loaders/GLTFLoader.js")
        return browserModule("web-engine-gltf-loader.js", "addons/gltf-loader-web.ts");
      if (source === "three/addons/loaders/LUTCubeLoader.js")
        return browserModule("web-engine-lut-cube-loader.js", "addons/lut-cube-loader-web.ts");
      if (POST_EFFECT_ADDONS.includes(source))
        return browserModule("web-engine-post-effects.js", "addons/post-effects-web.ts");
      if (
        /^three\/(?:src|build)\//u.test(source) &&
        !(ENGINE_MATH_MODULES.has(source) && ENGINE_MATH_IMPORTER.test(importer))
      )
        throw new Error(
          `TN_NATIVE_UPSTREAM_IMPORT: ${source} would bundle upstream three under engine "threenative"; import from three, three/webgpu or three/tsl.`,
        );
      return null;
    },
    async load(id) {
      if (native && id.startsWith(ENGINE_ADDON_PREFIX))
        return `export { ${id.slice(ENGINE_ADDON_PREFIX.length)} } from "three";\n`;
      if (native && id === SKELETON_UTILS_ID)
        return 'import { SkeletonUtils } from "three";\nexport const clone = (source) => SkeletonUtils.clone(source);\n';
      if (!native || id !== WEB_ENGINE_ID) return null;
      // `__tnTsl` rides along for the post effects module: the engine TSL functions three does not
      // export by name (ao, bloom, ...).
      const names = [
        ...(await upstreamNames(projectRoot())),
        ...Object.values(ENGINE_ADDON_CLASSES),
        "SkeletonUtils",
        "__tnTsl",
        "__tnLoadGltf",
      ];
      const single = wasmModule(projectRoot(), options.wasm);
      const threads = path.join(path.dirname(single), path.basename(WASM_THREADS_ENTRY));
      if (!existsSync(threads))
        throw new Error(
          `TN_WASM_THREADS_MISSING: engine "threenative" needs the threaded Wasm engine at ${threads}; reinstall @threenative/runtime-native, or in a ThreeNative checkout run \`pnpm wasm:build\` (presets wasm and wasm-threads). ${OPT_OUT}`,
        );
      // Shared memory exists only on a cross-origin-isolated page (COOP + COEP: createWebBrandPlugin
      // sends them from the dev and preview servers, and a build's service worker adds them on a host
      // that sends none). `__tnIsolation` (web-brand's boot script) is pending while it reloads the page.
      const off = (detail: string): string =>
        `${THREADS_OFF}: ${detail} Serve the game over https or localhost (the build's service worker adds Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp), or send both headers; on itch.io enable "SharedArrayBuffer support".`;
      const head = [
        `import { bindWebEngine } from ${JSON.stringify(runtimeModule())};`,
        "if (globalThis.crossOriginIsolated !== true) await globalThis.__tnIsolation;",
      ];
      const threadsReport = "${globalThis.__tnWebThreads}";
      const lines = strict
        ? [
            "if (globalThis.crossOriginIsolated !== true)",
            `  throw new Error(${JSON.stringify(off("this page is not cross-origin isolated, so the engine cannot start its worker threads."))});`,
            `const createModule = (await import(${JSON.stringify(threads)})).default;`,
            `const engine = await bindWebEngine(createModule, ${JSON.stringify(names)});`,
            'if (!String(globalThis.__tnWebThreads).startsWith("on"))',
            `  throw new Error(\`${THREADS_OFF}: the engine's job pool started no worker thread (${threadsReport}).\`);`,
          ]
        : [
            "const createModule = (",
            "  globalThis.crossOriginIsolated === true",
            `    ? await import(${JSON.stringify(threads)})`,
            `    : await import(${JSON.stringify(single)})`,
            ").default;",
            `const engine = await bindWebEngine(createModule, ${JSON.stringify(names)});`,
            'if (!String(globalThis.__tnWebThreads).startsWith("on"))',
            `  console.warn(\`${off(`the engine runs without worker threads (${threadsReport}), so frames cost more.`).replaceAll("`", "\\`")}\`);`,
          ];
      return [...head, ...lines, `export const { ${names.join(", ")} } = engine;`, ""].join("\n");
    },
  };
}
