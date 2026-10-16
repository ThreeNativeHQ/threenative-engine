/**
 * PRD-540 phase 1: `engine: "native"` routes a web build's `three`, `three/webgpu` and `three/tsl`
 * imports to the Wasm engine; the legacy build is unchanged.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { build, createServer } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createWebBrandPlugin } from "../src/web-brand.js";
import {
  WASM_ENGINE_ENTRY,
  WEB_ENGINE_ID,
  createWebEnginePlugin,
  webRuntimeDecoders,
} from "../src/web-engine.js";

const roots: string[] = [];
/** A string only upstream three's own Object3D carries (the binding's JS Vector3 keeps three's messages). */
const UPSTREAM_OBJECT3D = "Object3D.add: object not an instance of THREE.Object3D.";
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

// three exports no ./package.json; its entry sits in build/.
const THREE = path.resolve(
  path.dirname(createRequire(path.join(import.meta.dirname, "../package.json")).resolve("three")),
  "..",
);

/** A game importing all three upstream entry points, with three and (optionally) the Wasm entry. */
async function project(withWasm: boolean): Promise<string> {
  const root = await makeTempDir("tn-web-engine-");
  roots.push(root);
  await mkdir(path.join(root, "node_modules/@threenative/runtime-native"), { recursive: true });
  await symlink(THREE, path.join(root, "node_modules/three"), "dir");
  const runtime = path.join(root, "node_modules/@threenative/runtime-native");
  await writeFile(path.join(runtime, "package.json"), '{"name":"@threenative/runtime-native"}');
  if (withWasm) {
    await mkdir(path.dirname(path.join(runtime, WASM_ENGINE_ENTRY)), { recursive: true });
    await writeFile(
      path.join(runtime, WASM_ENGINE_ENTRY),
      "export default async function createModule() { return {}; }\n",
    );
  }
  await writeFile(path.join(root, "package.json"), '{"name":"game","type":"module"}');
  await writeFile(
    path.join(root, "index.html"),
    '<script type="module" src="/game.js"></script>\n',
  );
  await writeFile(
    path.join(root, "game.js"),
    [
      'import { Mesh, Vector3 } from "three";',
      'import { WebGPURenderer } from "three/webgpu";',
      'import { pass } from "three/tsl";',
      "globalThis.game = [Mesh, Vector3, WebGPURenderer, pass];",
      "",
    ].join("\n"),
  );
  return root;
}

async function bundle(
  root: string,
  native: boolean,
  configured: boolean | "baseline" = false,
): Promise<string> {
  const brand = createWebBrandPlugin();
  const baseline = {
    name: brand.name,
    configResolved: brand.configResolved,
    transformIndexHtml: brand.transformIndexHtml,
    generateBundle: brand.generateBundle,
  };
  await build({
    configFile: false,
    logLevel: "silent",
    root,
    build: { outDir: "dist", minify: false, target: "es2022" },
    plugins:
      configured === "baseline"
        ? [baseline]
        : configured
          ? [brand]
          : native
            ? [createWebEnginePlugin({ root, engine: "native" })]
            : [],
  });
  const assets = path.join(root, "dist/assets");
  const files = (await readdir(assets)).filter((name) => name.endsWith(".js"));
  return (await Promise.all(files.map((name) => readFile(path.join(assets, name), "utf8")))).join(
    "\n",
  );
}

describe("createWebEnginePlugin", () => {
  it("uses config alone for Vite build and dev", async () => {
    const root = await project(true);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { engine: "native" };\n',
    );
    const output = await bundle(root, false, true);
    expect(output).toContain("is not available on the Wasm engine");
    expect(output).not.toContain(UPSTREAM_OBJECT3D);
    const server = await createServer({
      root,
      configFile: false,
      plugins: [createWebBrandPlugin()],
      server: { middlewareMode: true, ws: false },
    });
    try {
      expect(await server.pluginContainer.resolveId("three")).toMatchObject({ id: WEB_ENGINE_ID });
      // The dep optimizer bypasses resolveId: a pre-bundled @threenative/core would inline upstream
      // three-mesh-bvh, whose module scope builds a Line3 the engine refuses (Midway dev boot).
      expect(server.config.optimizeDeps.exclude).toEqual(
        expect.arrayContaining(["three", "three/webgpu", "three/tsl", "three-mesh-bvh"]),
      );
    } finally {
      await server.close();
    }
  });

  it("keeps explicit legacy output byte-identical to today's build", async () => {
    const root = await project(false);
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
    const snapshot = async () => {
      const dist = path.join(root, "dist");
      const files = (await readdir(dist, { recursive: true }))
        .sort()
        .filter((name) => /\.(?:js|html|webmanifest)$/u.test(name));
      return Promise.all(
        files.map(async (name) => [
          name,
          (await readFile(path.join(dist, name))).toString("base64"),
        ]),
      );
    };
    await bundle(root, false, "baseline");
    const baseline = await snapshot();
    await writeFile(
      path.join(root, "threenative.config.ts"),
      'export default { engine: "legacy" };\n',
    );
    await bundle(root, false, true);
    expect(await snapshot()).toEqual(baseline);
  });

  it("bundles the browser binding and addon modules into the published CLI", async () => {
    const { default: configs } = await import("../tsup.config.js");
    const entries = (Array.isArray(configs) ? configs : [configs]).flatMap((config) =>
      typeof config !== "function" && config.entry && !Array.isArray(config.entry)
        ? Object.keys(config.entry)
        : [],
    );
    for (const name of [
      "web-engine-runtime",
      "web-engine-mesh-bvh",
      "web-engine-mesh-bvh-webgpu",
      "web-engine-buffer-geometry-utils",
      "web-engine-decal-geometry",
      "web-engine-hdr-loader",
      "web-engine-lut-cube-loader",
      "web-engine-gltf-loader",
      "web-engine-post-effects",
    ])
      expect(entries).toContain(name);
  });

  it("ships only the web engine module and Wasm sidecar from the native build directory", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../../runtime-native/package.json", import.meta.url), "utf8"),
    );
    expect(manifest.files).toContain(WASM_ENGINE_ENTRY);
    expect(manifest.files).toContain("build/web/tn-native-engine-web.wasm");
    expect(manifest.files.filter((file: string) => file.startsWith("build"))).toEqual([
      WASM_ENGINE_ENTRY,
      "build/web/tn-native-engine-web.wasm",
    ]);
  });

  it("does nothing for a legacy project, so the same dev config serves both engines", () => {
    for (const plugin of [createWebEnginePlugin(), createWebEnginePlugin({ engine: "legacy" })])
      for (const id of ["three", "three/webgpu", "three/tsl", "three-mesh-bvh"])
        expect(plugin.resolveId(id)).toBeNull();
  });

  it("takes its root from Vite when the dev config names none", async () => {
    const root = await project(true);
    const plugin = createWebEnginePlugin({ engine: "native" });
    plugin.configResolved({ root });
    expect(await plugin.load(WEB_ENGINE_ID)).toContain(WASM_ENGINE_ENTRY);
  });

  it("loads the Wasm engine from an explicit module path when one is given", async () => {
    const root = await project(false);
    const wasm = path.join(root, "engine/tn-native-engine-web.mjs");
    await mkdir(path.dirname(wasm), { recursive: true });
    await writeFile(wasm, "export default async function createModule() { return {}; }\n");
    const loaded = await createWebEnginePlugin({ root, engine: "native", wasm }).load(
      WEB_ENGINE_ID,
    );
    expect(loaded).toContain(JSON.stringify(wasm));
    await expect(
      createWebEnginePlugin({ root, engine: "native", wasm: `${wasm}.missing` }).load(
        WEB_ENGINE_ID,
      ),
    ).rejects.toThrow("TN_WASM_ENGINE_MISSING");
  });

  it("resolves the three entry points to the engine and refuses deep upstream imports", () => {
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    for (const id of ["three", "three/webgpu", "three/tsl"])
      expect(plugin.resolveId(id)).toBe(WEB_ENGINE_ID);
    expect(plugin.resolveId("three/addons/controls/OrbitControls.js")).toBeNull();
    expect(() => plugin.resolveId("three/src/nodes/Nodes.js")).toThrow("TN_NATIVE_UPSTREAM_IMPORT");
  });

  it("resolves three-mesh-bvh to the engine's own MeshBVH, never the upstream package", () => {
    const resolved = createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
      "three-mesh-bvh",
    );
    expect(resolved).toMatch(
      /(?:three-native\/src\/addons\/mesh-bvh\.ts|web-engine-mesh-bvh\.js)$/u,
    );
  });

  it("resolves three-mesh-bvh/webgpu to an engine module that loads and refuses each export at use", async () => {
    const resolved = createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
      "three-mesh-bvh/webgpu",
    );
    expect(resolved).toMatch(
      /(?:three-native\/src\/addons\/mesh-bvh-webgpu\.ts|web-engine-mesh-bvh-webgpu\.js)$/u,
    );
    // Core's gpu-scene-bvh reads these three at module scope; reading must not throw, using must.
    const module = (await import(resolved as string)) as Record<string, { struct?: unknown }>;
    for (const name of ["bvhIntersectFirstHit", "rayStruct", "bvhNodeStruct"])
      expect(() => module[name]?.struct).toThrow(`TN_NATIVE_UNSUPPORTED_${name.toUpperCase()}`);
  });

  it("resolves BufferGeometryUtils to the engine's mergeGeometries, never the upstream addon", () => {
    const resolved = createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
      "three/addons/utils/BufferGeometryUtils.js",
    );
    expect(resolved).toMatch(
      /(?:three-native\/src\/addons\/buffer-geometry-utils\.ts|web-engine-buffer-geometry-utils\.js)$/u,
    );
  });

  it("resolves DecalGeometry to the engine port, never the upstream addon", () => {
    const resolved = createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
      "three/addons/geometries/DecalGeometry.js",
    );
    expect(resolved).toMatch(
      /(?:three-native\/src\/addons\/decal-geometry\.ts|web-engine-decal-geometry\.js)$/u,
    );
  });

  it("resolves three's RoundedBoxGeometry addon to the engine's own class, never upstream", async () => {
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    const resolved = plugin.resolveId("three/addons/geometries/RoundedBoxGeometry.js");
    expect(resolved).toBe("\0threenative:web-engine-addon:RoundedBoxGeometry");
    expect(await plugin.load(resolved as string)).toBe(
      'export { RoundedBoxGeometry } from "three";\n',
    );
    expect(
      createWebEnginePlugin({ root: "/game" }).resolveId(
        "three/addons/geometries/RoundedBoxGeometry.js",
      ),
    ).toBeNull();
  });

  it("resolves three's SkeletonUtils addon to the engine's SkeletonUtils namespace", async () => {
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    const resolved = plugin.resolveId("three/addons/utils/SkeletonUtils.js");
    expect(resolved).toBe("\0threenative:web-engine-skeleton-utils");
    expect(await plugin.load(resolved as string)).toBe(
      'import { SkeletonUtils } from "three";\nexport const clone = (source) => SkeletonUtils.clone(source);\n',
    );
    expect(
      createWebEnginePlugin({ root: "/game" }).resolveId("three/addons/utils/SkeletonUtils.js"),
    ).toBeNull();
  });

  it("resolves an addon under three's older examples/jsm path as under addons", () => {
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    expect(plugin.resolveId("three/examples/jsm/utils/SkeletonUtils.js")).toBe(
      "\0threenative:web-engine-skeleton-utils",
    );
  });

  it("resolves three's HDRLoader addon to the engine's own loader, never upstream", () => {
    const resolved = createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
      "three/addons/loaders/HDRLoader.js",
    );
    expect(resolved).toMatch(
      /(?:three-native\/src\/addons\/hdr-loader\.ts|web-engine-hdr-loader\.js)$/u,
    );
  });

  it("resolves three's LUTCubeLoader to the shared engine loader", () => {
    expect(
      createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
        "three/addons/loaders/LUTCubeLoader.js",
      ),
    ).toMatch(
      /(?:three-native\/src\/addons\/lut-cube-loader-web\.ts|web-engine-lut-cube-loader\.js)$/u,
    );
  });

  it("resolves three's GTAO, Denoise, SMAA and Bloom addons to the engine's live effects", () => {
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    for (const node of [
      "GTAONode",
      "DenoiseNode",
      "SMAANode",
      "BloomNode",
      "FilmNode",
      "Lut3DNode",
      "TRAANode",
    ])
      expect(plugin.resolveId(`three/addons/tsl/display/${node}.js`)).toMatch(
        /(?:three-native\/src\/addons\/post-effects-web\.ts|web-engine-post-effects\.js)$/u,
      );
  });

  it("resolves the display addons the engine refuses to the same module, never upstream", () => {
    // Upstream's SSRNode runs `Fn(...).setLayout(...)` at import, which the engine's Fn does not carry.
    const plugin = createWebEnginePlugin({ root: "/game", engine: "native" });
    for (const node of ["FXAANode", "GodraysNode", "SSGINode", "SSRNode", "SharpenNode"])
      expect(plugin.resolveId(`three/addons/tsl/display/${node}.js`)).toMatch(
        /(?:three-native\/src\/addons\/post-effects-web\.ts|web-engine-post-effects\.js)$/u,
      );
  });

  it("resolves three's GLTFLoader to the engine glTF loader, never upstream", () => {
    expect(
      createWebEnginePlugin({ root: "/game", engine: "native" }).resolveId(
        "three/addons/loaders/GLTFLoader.js",
      ),
    ).toMatch(/(?:three-native\/src\/addons\/gltf-loader-web\.ts|web-engine-gltf-loader\.js)$/u);
  });

  it("fails the build when the Wasm engine is not installed", async () => {
    const root = await project(false);
    await expect(
      createWebEnginePlugin({ root, engine: "native" }).load(WEB_ENGINE_ID),
    ).rejects.toThrow("TN_WASM_ENGINE_MISSING");
  });

  it("bundles the Wasm engine binding instead of upstream three; legacy still bundles three", async () => {
    const root = await project(true);
    const native = await bundle(root, true);
    expect(native).toContain("is not available on the Wasm engine");
    expect(native).toContain("createModule");
    expect(native).toContain("__tnTsl");
    expect(native).not.toContain(UPSTREAM_OBJECT3D);
    await rm(path.join(root, "dist"), { recursive: true });
    const legacy = await bundle(root, false);
    expect(legacy).toContain(UPSTREAM_OBJECT3D);
    expect(legacy).not.toContain("is not available on the Wasm engine");
  }, 120_000);
});

describe("the web engine's asset decoders", () => {
  it("cooks without KTX2 or Meshopt unless the game pins the legacy engine", () => {
    expect(webRuntimeDecoders({})).toEqual({ ktx2: false, meshopt: false });
    expect(webRuntimeDecoders({ engine: "native" })).toEqual({ ktx2: false, meshopt: false });
    expect(webRuntimeDecoders({ engine: "legacy" })).toBeUndefined();
  });

  it("is what every template's dev-server asset watch cooks with, as its build does", async () => {
    const templates = path.resolve(import.meta.dirname, "../templates");
    const watching = (await readdir(templates)).filter((name) =>
      existsSync(path.join(templates, name, "vite.config.ts")),
    );
    expect(watching.length).toBeGreaterThan(0);
    for (const name of watching) {
      const source = await readFile(path.join(templates, name, "vite.config.ts"), "utf8");
      expect(source, name).toContain("runtimeDecoders: webRuntimeDecoders(config)");
    }
  });
});
