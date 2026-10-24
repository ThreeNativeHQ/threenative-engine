import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The asset decoders the web engine ships: its glTF loader decodes neither KTX2 nor Meshopt (addons/gltf-loader-web.ts), so a
 * native-engine game's models are cooked without it, which is also the cooker's default. `engine: "threejs"` names both.
 * `threenative build` and each template's dev-server asset watch both read it, so the two cook the same bytes.
 */
export function webRuntimeDecoders(config: {
  readonly engine?: "threejs" | "threenative";
}): { readonly ktx2: boolean; readonly meshopt: boolean } {
  return config.engine === "threejs"
    ? { ktx2: true, meshopt: true }
    : { ktx2: false, meshopt: false };
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

export interface IWebEnginePlugin {
  readonly name: string;
  readonly enforce: "pre";
  configResolved(config: { readonly root: string }): void;
  resolveId(source: string): string | null;
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
      `TN_WASM_ENGINE_MISSING: engine "threenative" needs @threenative/runtime-native installed in ${root}. Set engine: "threejs" in threenative.config.ts to keep upstream three.`,
    );
  }
  if (!existsSync(entry))
    throw new Error(
      `TN_WASM_ENGINE_MISSING: engine "threenative" needs the Wasm engine at ${entry}; build it with \`pnpm wasm:build\` from the repository root (it fetches stb, cgltf and webp-source, then builds), or set engine: "threejs" in threenative.config.ts to keep upstream three.`,
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
    .filter((name) => name !== "default")
    .sort();
}

export interface IWebEngineOptions {
  /** The project root; Vite's own root when omitted. */
  readonly root?: string;
  /** `threenative.config.ts`'s `engine`: anything but `"threenative"` leaves upstream three alone. */
  readonly engine?: "threejs" | "threenative";
  /** The Wasm engine's ES module, for a workspace build that does not install runtime-native. */
  readonly wasm?: string;
}

/**
 * Routes a web build's upstream three imports to the Wasm engine (PRD-540) when `engine` is
 * `"threenative"`. Deep imports into three's own source would bundle the upstream engine beside it, so
 * they fail the build. The scaffold's web branding plugin applies the config switch for Vite.
 */
export function createWebEnginePlugin(options: IWebEngineOptions = {}): IWebEnginePlugin {
  let root = options.root;
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
    },
    resolveId(specifier) {
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
      if (/^three\/(?:src|build)\//u.test(source))
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
      return [
        `import { bindWebEngine } from ${JSON.stringify(runtimeModule())};`,
        `import createModule from ${JSON.stringify(wasmModule(projectRoot(), options.wasm))};`,
        `const engine = await bindWebEngine(createModule, ${JSON.stringify(names)});`,
        `export const { ${names.join(", ")} } = engine;`,
        "",
      ].join("\n");
    },
  };
}
