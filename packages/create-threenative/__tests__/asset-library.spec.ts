/**
 * PRD-915: the shared Asset Library's server half, driven through a real Vite dev server on a
 * throwaway project — catalog discovery, model/texture/audio info, Raw vs Cooked, path containment,
 * code stories, and the Scene Bundler's two outputs (a TypeScript module that typechecks and a
 * merged GLB that decodes and passes `inspectAsset`). The browser half is asset-library-browser.spec.ts.
 */
import { copyFile, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import ts from "typescript";
import { type ViteDevServer, build, createServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import { createAssetLibraryPlugin, devShellScript } from "../src/asset-library.js";
import { containedFile } from "../src/asset-library/project-source.js";
import { inspectAsset } from "../src/inspect.js";
import { WEB_ENGINE_ID } from "../src/web-engine.js";

const STARTER = path.resolve("packages/create-threenative/templates/starter");
const fromHere = createRequire(path.resolve("packages/create-threenative/package.json"));

/** A one-metre floor tile with one named material: what the bundler must not duplicate. */
async function writeTile(file: string): Promise<void> {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]))
    .setBuffer(buffer);
  const normal = document
    .createAccessor()
    .setType("VEC3")
    .setArray(new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]))
    .setBuffer(buffer);
  const indices = document
    .createAccessor()
    .setType("SCALAR")
    .setArray(new Uint16Array([0, 2, 1, 0, 3, 2]))
    .setBuffer(buffer);
  const material = document.createMaterial("stone").setBaseColorFactor([0.5, 0.5, 0.5, 1]);
  const primitive = document
    .createPrimitive()
    .setAttribute("POSITION", position)
    .setAttribute("NORMAL", normal)
    .setIndices(indices)
    .setMaterial(material);
  const node = document
    .createNode("tile")
    .setMesh(document.createMesh("tile").addPrimitive(primitive));
  document.createScene("tile").addChild(node);
  await new NodeIO().write(file, document);
}

let root = "";
let server: ViteDevServer;
let base = "";

const get = async (route: string, init?: RequestInit) => {
  const response = await fetch(`${base}/__assets/${route}`, init);
  return {
    status: response.status,
    body: await response.text(),
    type: response.headers.get("content-type"),
  };
};
const json = async <T>(route: string, init?: RequestInit) => {
  const { status, body } = await get(route, init);
  return { status, body: JSON.parse(body) as T };
};

beforeAll(async () => {
  root = await makeTempDir("tn-asset-library-");
  await mkdir(path.join(root, "assets/props"), { recursive: true });
  await mkdir(path.join(root, "src/entities"), { recursive: true });
  await mkdir(path.join(root, "public"), { recursive: true });
  await copyFile(
    path.join(STARTER, "assets/native-proof.glb"),
    path.join(root, "assets/props/crate.glb"),
  );
  await writeTile(path.join(root, "assets/props/tile.glb"));
  await copyFile(
    path.join(STARTER, "assets/native-proof.png"),
    path.join(root, "assets/proof.png"),
  );
  await copyFile(path.join(STARTER, "assets/pickup.wav"), path.join(root, "assets/pickup.wav"));
  // A cooked copy and its manifest row, as `@threenative/assets` writes them.
  await copyFile(
    path.join(STARTER, "assets/native-proof.glb"),
    path.join(root, "public/crate.cooked.glb"),
  );
  const bytes = (await stat(path.join(root, "public/crate.cooked.glb"))).size;
  await writeFile(
    path.join(root, "public/assets.manifest.json"),
    JSON.stringify({
      version: 1,
      entries: {
        "props/crate.glb": {
          output: "crate.cooked.glb",
          bytes,
          lod: { levels: 3, runtime: { maxPixelError: 2 } },
        },
      },
    }),
  );
  await writeFile(
    path.join(root, "src/entities/crate.story.ts"),
    `export default { title: "Crate", controls: [], create: () => { throw new Error("browser only"); } };\n`,
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "asset-library-fixture", type: "module" }),
  );
  // The project's core, as a kit installs it: its capability manifest lists the VFX stories.
  await mkdir(path.join(root, "node_modules/@threenative"), { recursive: true });
  await symlink(path.resolve("packages/core"), path.join(root, "node_modules/@threenative/core"));
  await writeFile(
    path.join(root, "index.html"),
    "<!doctype html><html><head></head><body>game</body></html>",
  );
  server = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    // No file watcher: no test edits a file after start, and closing chokidar over the symlinked
    // core package outlived the 60 s afterAll hook on a loaded CI runner.
    server: { port: 0, host: "127.0.0.1", watch: null },
    plugins: [
      // A kit's engine alias, listed first as in every kit: it claims every `three` import.
      {
        name: "stand-in-web-engine",
        enforce: "pre",
        resolveId: (source: string) => (source === "three" ? WEB_ENGINE_ID : null),
        load: (id: string) => (id === WEB_ENGINE_ID ? "export const engine = true;" : null),
      },
      createAssetLibraryPlugin(),
    ],
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("dev server has no port");
  base = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await server?.close();
  // A `beforeAll` directory is outside any test, so `makeTempDir` only removes it at process exit,
  // which a Vitest worker may never reach: the suite's temp guard then counts it as a leak.
  if (root) await rm(root, { recursive: true, force: true });
});

describe("asset library server", () => {
  it("lists the project's models, textures, audio, stories and the Scene Bundler", async () => {
    const { status, body } = await json<{
      elements: { id: string; kind: string; category?: string }[];
    }>("api/catalog");
    expect(status).toBe(200);
    const byId = Object.fromEntries(body.elements.map((e) => [e.id, e]));
    expect(byId["assets/props/crate.glb"]).toMatchObject({ kind: "model", category: "props" });
    expect(byId["assets/proof.png"]?.kind).toBe("texture");
    expect(byId["assets/pickup.wav"]?.kind).toBe("audio");
    expect(byId["src/entities/crate.story.ts"]).toMatchObject({
      kind: "story",
      category: "entities",
    });
    expect(byId.stage?.kind).toBe("stage");
  });

  it("serves the shell page with the brand favicon, its entry and Basis transcoder", async () => {
    const page = await get("");
    expect(page.status).toBe(200);
    expect(page.body).toContain("/__assets/favicon.svg");
    expect(page.body).toContain("/@id/virtual:tn-asset-library/entry");
    expect((await get("favicon.svg")).type).toBe("image/svg+xml");
    expect((await get("basis/basis_transcoder.wasm")).status).toBe(200);
    const entry = await get("../@id/virtual:tn-asset-library/entry");
    expect(entry.body).toContain('"base":"/__assets/"');
  });

  it("reports a model's health, Raw vs Cooked bytes and the cooked LOD row", async () => {
    const { status, body } = await json<{
      health: { level: string; text: string }[];
      raw: { bytes: number; textures: number };
      cooked?: { bytes: number; output: string };
      lod?: { levels: number; maxPixelError: number };
      inspection: { bounds: unknown };
    }>("api/project/info?path=assets/props/crate.glb");
    expect(status).toBe(200);
    expect(body.health.length).toBeGreaterThan(0);
    expect(body.health.every((badge) => ["ok", "warn", "error"].includes(badge.level))).toBe(true);
    expect(body.raw.bytes).toBeGreaterThan(0);
    expect(body.cooked).toMatchObject({ output: "public/crate.cooked.glb" });
    expect(body.lod).toEqual({ levels: 3, maxPixelError: 2 });
    expect(body.inspection.bounds).toBeDefined();
    const cooked = await get("api/project/cooked/assets/props/crate.glb");
    expect([cooked.status, cooked.type]).toEqual([200, "model/gltf-binary"]);
  });

  it("measures a texture and an audio file", async () => {
    const texture = await json<{ width: number; height: number; raw: { vram: number } }>(
      "api/project/info?path=assets/proof.png",
    );
    expect(texture.body.width).toBeGreaterThan(0);
    expect(texture.body.raw.vram).toBeGreaterThan(texture.body.width * texture.body.height * 4 - 1);
    const audio = await get("api/project/file/assets/pickup.wav");
    expect([audio.status, audio.type]).toEqual([200, "audio/wav"]);
  });

  it("serves nothing outside assets/ and src/", async () => {
    expect((await get("api/project/file/package.json")).status).toBe(404);
    expect((await get("api/project/file/assets/..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await get("api/project/info?path=../package.json")).status).toBe(500);
    expect(containedFile(root, "assets/../package.json", ["assets"])).toBeUndefined();
    expect(containedFile(root, "/etc/passwd", ["assets"])).toBeUndefined();
    expect(containedFile(root, "assets/props/crate.glb", ["assets"])).toBe(
      path.join(root, "assets/props/crate.glb"),
    );
  });

  it("hands the shell upstream three even behind a kit's engine alias, and a story the game's", async () => {
    const shell = await get("../@id/virtual:tn-asset-library/entry");
    const client = /import\("([^"]+client\.js)"\)/u.exec(shell.body)?.[1] ?? "";
    expect(client).not.toBe("");
    const module = await (await fetch(`${base}${client}`)).text();
    expect(module).toMatch(/from "[^"]*three\/build\/three\.module\.js"/u);
    expect(module).not.toContain("threenative:web-engine");
    const story = await get(
      `../@id/virtual:tn-asset-library/story/${encodeURIComponent("src/entities/crate.story.ts")}.js`,
    );
    const frame = /from "([^"]+story-frame\.js)"/u.exec(story.body)?.[1] ?? "";
    expect(await (await fetch(`${base}${frame}`)).text()).toContain("threenative:web-engine");
  });

  it("lists every @threenative/core/vfx effect as a story that imports it from the game's core", async () => {
    const { body } = await json<{ elements: { id: string; kind: string; name: string }[] }>(
      "api/catalog",
    );
    const vfx = body.elements.filter((e) => e.id.startsWith("vfx:"));
    expect(vfx).toHaveLength(46);
    expect(vfx.every((e) => e.kind === "story")).toBe(true);
    expect(vfx.find((e) => e.id === "vfx:createHealingAura")?.name).toBe("Healing Aura");
    const story = await get(
      `../@id/virtual:tn-asset-library/story/${encodeURIComponent("vfx:createFire")}.js`,
    );
    expect(story.body).toMatch(/import \{ createFire \} from "[^"]*core\/dist\/vfx\/index\.js"/u);
    expect(story.body).toMatch(/import \{ GPUParticles3D \} from "[^"]*core\/dist\/index\.js"/u);
    expect(story.body).toContain('vfxStory("Fire", createFire, GPUParticles3D)');
    expect((await get("story.html?path=vfx:createFire")).status).toBe(200);
    expect((await get("story.html?path=vfx:create..%2Fx")).status).toBe(400);
  });

  it("pre-bundles what code stories import at startup, so the first story opens without a reload", () => {
    // A dependency Vite meets first in a story was optimized late, and its `full-reload` reloaded
    // the game page under the library too: the switcher fell back to Game.
    expect(server.config.optimizeDeps.entries).toEqual(["**/*.html", "src/**/*.story.ts"]);
  });

  it("ships defineAssetStory as browser code, with no Node import", async () => {
    // A story imports it in the page: tsup's Node `require` banner threw there.
    const shipped = await readFile(
      path.resolve("packages/create-threenative/dist/asset-story.js"),
      "utf8",
    );
    expect(shipped).toContain("function defineAssetStory");
    expect(shipped).not.toMatch(/node:/u);
  });

  it("frames a code story with the game's own Vite graph and an HMR boundary", async () => {
    const page = await get("story.html?path=src/entities/crate.story.ts");
    expect(page.status).toBe(200);
    expect(page.body).toContain("virtual:tn-asset-library/story/");
    const story = await get(
      `../@id/virtual:tn-asset-library/story/${encodeURIComponent("src/entities/crate.story.ts")}.js`,
    );
    expect(story.body).toContain("mountStory");
    expect(story.body).toContain("import.meta.hot.accept");
    expect((await get("story.html?path=../secret.story.ts")).status).toBe(400);
  });

  it("injects the lazy dev shell into the game page only", async () => {
    const game = await (await fetch(`${base}/`)).text();
    expect(game).toContain('id = "tn-dev-shell"');
    expect((await get("")).body).not.toContain("tn-dev-shell");
    // Nothing loads until the Asset Library tab is picked; automation and iframes never see it.
    const script = devShellScript("/__assets/");
    expect(script).toContain("navigator.webdriver");
    expect(script).toContain("window.self !== window.top");
    expect(script).toContain('"noDevShell"');
    expect(script.indexOf("frame.src = mount")).toBeGreaterThan(script.indexOf("const show"));
    // The switch says it is dev-only, so nobody expects it in a shipped game.
    expect(script).toContain('badge.textContent = "DEV"');
    expect(script).toContain("not in production builds");
  });
});

describe("Scene Bundler", () => {
  const items = [
    {
      path: "assets/props/tile.glb",
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
    },
    {
      path: "assets/props/tile.glb",
      position: [2, 0, 0],
      quaternion: [0, Math.SQRT1_2, 0, Math.SQRT1_2],
      scale: [1, 1, 1],
    },
    {
      path: "assets/props/tile.glb",
      position: [4, 0, 1],
      quaternion: [0, 0, 0, 1],
      scale: [2, 2, 2],
    },
  ];
  const save = (output: "ts" | "glb", name = "yard") =>
    json<{ written: string; report: { drawCalls: number; triangles: number; materials: number } }>(
      "api/project/bundle",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, output, items }),
      },
    );

  it("writes a scene module that instances repeats and typechecks", async () => {
    const { status, body } = await save("ts");
    expect(status).toBe(200);
    expect(body.written).toBe("src/scenes/yard.ts");
    const file = path.join(root, body.written);
    const source = await readFile(file, "utf8");
    expect(source).toContain("ctx.assets.model<{ scene: Object3D }>(file)");
    expect(source).toContain("InstancedMesh");
    expect(source).toContain('"props/tile.glb"');
    const program = ts.createProgram([file], {
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      paths: {
        three: [
          path.join(path.dirname(fromHere.resolve("@types/three/package.json")), "index.d.ts"),
        ],
      },
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    expect(errors).toEqual([]);
  });

  it("writes one merged GLB that decodes, dedupes materials and passes inspectAsset", async () => {
    const { status, body } = await save("glb");
    expect(status).toBe(200);
    expect(body.written).toBe("assets/bundles/yard.glb");
    const file = path.join(root, body.written);
    const inspection = await inspectAsset(file);
    const single = await inspectAsset(path.join(root, "assets/props/tile.glb"));
    // Three copies of one prop share its one material instead of tripling it.
    expect(single.materials).toBe(1);
    expect(inspection.materials).toBe(1);
    expect(inspection.bounds.size.x).toBeGreaterThan(single.bounds.size.x * 4);
    expect(body.report).toMatchObject({ materials: 1, triangles: 6 });
    expect(body.report.triangles).toBeGreaterThan(0);
  });

  it("refuses a bad name, an empty stage and an item outside assets/", async () => {
    expect((await save("ts", "../evil")).status).toBe(500);
    const post = (payload: unknown) =>
      get("api/project/bundle", { method: "POST", body: JSON.stringify(payload) });
    expect((await post({ name: "empty", output: "ts", items: [] })).status).toBe(500);
    const outside = { ...items[0], path: "package.json" };
    expect((await post({ name: "outside", output: "glb", items: [outside] })).status).toBe(500);
  });
});

describe("production isolation", () => {
  it("is a serve-only plugin, so a build never loads it", async () => {
    expect(createAssetLibraryPlugin().apply).toBe("serve");
    const out = path.join(root, "dist");
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      build: { outDir: out, emptyOutDir: true },
      plugins: [createAssetLibraryPlugin()],
    });
    const html = await readFile(path.join(out, "index.html"), "utf8");
    expect(html).not.toContain("tn-dev-shell");
    expect(html).not.toContain("tn-asset-library");
  }, 60_000);
});
