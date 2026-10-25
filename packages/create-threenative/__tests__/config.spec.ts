import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { compileAssets } from "@threenative/assets";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";
import * as assetKeys from "../../assets/src/config-keys.js";
import type { IThreeNativeModelsConfig } from "../../core/src/config.js";
import {
  ASSETS_CONFIG_KEYS,
  LIGHTMAP_CONFIG_KEYS,
  MODELS_CONFIG_KEYS,
  MODEL_PASS_KEYS,
  MODEL_QUANTIZE_KEYS,
  MODEL_VIRTUAL_KEYS,
  loadConfig,
} from "../src/config.js";
import { createProject, discoverTemplateNames } from "../src/index.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

it("should carry both budget gates through the real config loader into the compiler", async () => {
  const root = await project();
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/large.txt"), "more than one byte");
  await config(root, 'export default { assets: { budget: { uncooked: "none", total: 1 } } };');
  const loaded = await loadConfig(root);
  await expect(compileAssets({ cwd: root, config: loaded.assets })).rejects.toThrow(
    "TN_ASSETS_BUDGET_EXCEEDED",
  );
});

it.each([0, -1, 1.5, null, { uncooked: "bad" }, { typo: 1 }, { total: -1 }])(
  "rejects malformed asset budget %j at config load",
  async (budget) => {
    const root = await project();
    await config(root, `export default ${JSON.stringify({ assets: { budget } })};`);
    await expect(loadConfig(root)).rejects.toThrow("TN_CONFIG_ASSETS_INVALID");
  },
);

it("should carry asset exclusions from the real config loader into the compiler", async () => {
  const root = await project();
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/keep.txt"), "keep");
  await writeFile(path.join(root, "assets/library.glb"), "excluded before parsing");
  await config(root, 'export default { assets: { exclude: ["*.glb"] } };');
  const loaded = await loadConfig(root);
  await compileAssets({ cwd: root, config: loaded.assets });
  const manifest = JSON.parse(
    await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
  );
  expect(manifest.entries["keep.txt"]).toBeDefined();
  expect(manifest.entries["library.glb"]).toBeUndefined();
});
it.each([undefined, "threejs", "threenative"])(
  "resolves engine %j with threenative as the default",
  async (engine) => {
    const root = await project();
    await config(root, `export default ${JSON.stringify({ engine })};`);
    expect((await loadConfig(root)).engine).toBe(engine ?? "threenative");
  },
);

it.each([
  ["native", "threenative"],
  ["legacy", "threejs"],
])("names the new value for the renamed engine %j", async (engine, renamed) => {
  const root = await project();
  await config(root, `export default ${JSON.stringify({ engine })};`);
  const error = await loadConfig(root).catch((caught: unknown) => caught);
  expect(String(error)).toContain("TN_CONFIG_ENGINE_RENAMED");
  expect(String(error)).toContain(`engine "${engine}" was renamed: use "${renamed}".`);
});

it.each(["unknown", null, 1, false, {}])(
  "rejects invalid engine %j with a named error",
  async (engine) => {
    const root = await project();
    await config(root, `export default ${JSON.stringify({ engine })};`);
    await expect(loadConfig(root)).rejects.toThrow("TN_CONFIG_ENGINE_INVALID");
  },
);

const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXUlEQVR4AaXBQRHEAAgEwclWHGDivIBckIWG3Hf/dD/frz9MdOK2BhedOHEkjsTRG524rcFFJ25rcOJIHImjd2tw0YnbGlx04sSROBJHb3TitgYXnbitwYkjcSSO/o/fGRJxtqYFAAAAAElFTkSuQmCC",
  "base64",
);
const TRNS_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAAnRSTlMAAHaTzTgAAAAQSURBVHicY2AYBaNgFMAAAAMQAAE/LCvsAAAAAElFTkSuQmCC",
  "base64",
);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function project(name = "fox-game"): Promise<string> {
  const root = await makeTempDir("threenative-config-");
  roots.push(root);
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src/game.ts"), "export default {};\n");
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name, type: "module", devDependencies: {} }),
  );
  return root;
}

async function config(root: string, source: string): Promise<void> {
  await writeFile(path.join(root, "threenative.config.ts"), `${source}\n`);
}

/**
 * A quiet 16-bit mono sine as RIFF/WAVE — a real clip the audio pass can decode, well under full
 * scale so nothing but the container forces a re-encode.
 */
function wavClip(frames: number): Buffer {
  const sampleRate = 44_100;
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + frames * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(frames * 2, 40);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.sin((2 * Math.PI * 440 * frame) / sampleRate) * 0.5;
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + frame * 2);
  }
  return buffer;
}

/** The bytes a compile actually published for a logical path, read back through its manifest. */
async function compiledBytes(root: string, logical: string): Promise<Buffer> {
  const manifest = JSON.parse(
    await readFile(path.join(root, "public/assets.manifest.json"), "utf8"),
  ) as { entries: Record<string, { output?: string }> };
  const output = manifest.entries[logical]?.output;
  if (output === undefined) throw new Error(`'${logical}' is not in the compiled manifest`);
  return await readFile(path.join(root, "public", output));
}

/**
 * Typechecks a value the loader already accepted against both packages' published audio types,
 * with the real compiler. Vitest transpiles, so a published shape that contradicts the parser is
 * invisible to every other assertion in this file.
 *
 * The declarations a game installs, not the source behind them, because that is the surface that
 * drifted: `IAudioConfig` published `seamThreshold`, which `parseAudioConfig` throws on, and
 * omitted `seamMaxRatio`, which it accepts. Reading `dist` adds no new prerequisite — this spec's
 * own `@threenative/assets` import already resolves there.
 */
async function expectPublishedTypesAccept(accepted: unknown, rejectedKey: string): Promise<void> {
  const dir = await makeTempDir("threenative-audio-types-");
  roots.push(dir);
  const fixture = path.join(dir, "audio.ts");
  await writeFile(
    fixture,
    `import type { IAudioConfig } from "${path.resolve("packages/assets/dist/index.js")}";
import type { IThreeNativeAudioConfig } from "${path.resolve("packages/core/dist/index.js")}";
export const assets: IAudioConfig = ${JSON.stringify(accepted)};
export const core: IThreeNativeAudioConfig = ${JSON.stringify(accepted)};
// @ts-expect-error the parser throws on this key, so no published type may offer it.
export const rejected: IAudioConfig = { ${rejectedKey}: 2 };
`,
  );
  const outcome = (await execFileAsync(process.execPath, [
    path.resolve("packages/core/node_modules/@typescript/native/bin/tsc"),
    "--ignoreConfig",
    "--noEmit",
    "--strict",
    "--target",
    "es2022",
    "--module",
    "esnext",
    "--moduleResolution",
    "bundler",
    "--skipLibCheck",
    fixture,
  ]).catch((error: unknown) => error)) as { readonly stdout?: string };
  expect(outcome.stdout?.trim() ?? "").toBe("");
}

async function expectActionableFailure(
  root: string,
  code: string,
  layer: string,
  searchedLocation: string,
): Promise<void> {
  let result: Error | undefined;
  try {
    await loadConfig(root);
  } catch (error) {
    result = error instanceof Error ? error : new Error(String(error));
  }
  expect(result).toBeInstanceOf(Error);
  expect(result?.message).toContain(code);
  expect(result?.message).toContain(`${layer} layer failed`);
  expect(result?.message).toContain(searchedLocation);
  expect(result?.message).toContain("Searched:");
  expect(result?.message).toContain("Fix:");
  expect(result?.message).toContain("pnpm exec threenative build --target web");
}

describe("threenative.config.ts", () => {
  // The seam this closes, caught the moment `renderer.alphaAntialiasing` was added: the engine's
  // `IThreeNativeConfig` and this package's validator are two independent key lists, so a key can
  // typecheck in a template and be rejected at build with TN_CONFIG_UNKNOWN_KEY. Reading the
  // shipped templates rather than a fixture means the next key is caught the same way.
  it("accepts every renderer key the shipped templates actually set", async () => {
    const templates = path.resolve("packages/create-threenative/templates");
    const names = await readdir(templates);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const source = await readFile(path.join(templates, name, "threenative.config.ts"), "utf8");
      const block = /renderer:\s*\{(?<body>[^}]*)\}/su.exec(source)?.groups?.body ?? "";
      const keys = [...block.matchAll(/^\s{4}(?<key>[A-Za-z]\w*):/gmu)].map(
        (match) => match.groups?.key ?? "",
      );
      expect(keys, `${name} renderer block`).not.toHaveLength(0);
      const root = await project();
      await config(
        root,
        `export default { renderer: { ${keys.map((key) => `${key}: undefined`).join(", ")} } };`,
      );
      await expect(
        loadConfig(root),
        `${name} renderer keys ${keys.join(",")}`,
      ).resolves.toBeTruthy();
    }
  });

  it("carries alpha antialiasing through to the resolved config, Android override included", async () => {
    const root = await project();
    await config(
      root,
      "export default { renderer: { alphaAntialiasing: false, android: { alphaAntialiasing: true } } };",
    );
    await expect(loadConfig(root)).resolves.toMatchObject({
      renderer: { alphaAntialiasing: false, android: { alphaAntialiasing: true } },
    });
  });

  it("re-exports the core-owned asset config types instead of redeclaring them", async () => {
    const createSource = await readFile(
      path.resolve("packages/create-threenative/src/config.ts"),
      "utf8",
    );
    const coreSource = await readFile(path.resolve("packages/core/src/config.ts"), "utf8");
    for (const name of ["IThreeNativeTexturesConfig", "IThreeNativeAudioConfig"]) {
      expect(createSource).toMatch(
        new RegExp(`export type \\{[^}]*${name}[^}]*\\} from "@threenative/core";`, "su"),
      );
      expect(createSource).not.toMatch(new RegExp(`export interface ${name}`, "u"));
      expect(coreSource.match(new RegExp(`export interface ${name}`, "gu"))).toHaveLength(1);
    }
    // The shared parsers, imported rather than reimplemented: PNG for icons, audio for the
    // conditioning block. A second copy of either is a second answer to the same question.
    expect(createSource).toMatch(
      /import \{[^}]*\bparseAudioConfig\b[^}]*\bparsePng\b[^}]*\} from "@threenative\/assets";/u,
    );
    expect(createSource).not.toMatch(/const PNG_SIGNATURE =/u);
    expect(createSource).not.toMatch(/const (?:AUDIO_)?(?:OVERRIDE|SPECTRUM|LOOP)_KEYS =/u);
  });

  it("accepts tRNS PNG alpha through the shared parser", async () => {
    const root = await project();
    await writeFile(path.join(root, "foreground.png"), TRNS_PNG);
    await config(
      root,
      'export default { app: { icons: { android: { foreground: "foreground.png" } } } };',
    );

    await expect(loadConfig(root)).resolves.toMatchObject({
      app: { icons: { android: { foreground: "foreground.png" } } },
    });
  });

  it("parses every group and applies defaults for omitted fields", async () => {
    const root = await project("studio-fox");
    await writeFile(path.join(root, "icon.png"), VALID_PNG);
    await config(
      root,
      `export default {
        app: { id: "com.studio.fox", name: "Fox", version: "1.2.3", build: 7, icon: "icon.png" },
        display: { orientation: "portrait", fullscreen: false, keepScreenOn: true, maxFps: 120 },
        window: {
          title: "Fox Desktop",
          width: 1024,
          height: 576,
          maximized: true,
          resizable: false,
        },
        nativeEntry: "src/game.ts",
        renderer: { preferWebGPU: false },
      };`,
    );

    await expect(loadConfig(root)).resolves.toEqual({
      engine: "threenative",
      app: { id: "com.studio.fox", name: "Fox", version: "1.2.3", build: 7, icon: "icon.png" },
      display: { orientation: "portrait", fullscreen: false, keepScreenOn: true, maxFps: 120 },
      window: {
        title: "Fox Desktop",
        width: 1024,
        height: 576,
        maximized: true,
        resizable: false,
      },
      nativeEntry: "src/game.ts",
      renderer: { preferWebGPU: false },
      ui: { renderer: "web" },
    });
  });

  it("preserves renderer resolution scale and the Android override", async () => {
    const root = await project();
    await config(
      root,
      `export default {
        renderer: { resolutionScale: 0.75, android: { resolutionScale: 0.32 } },
      };`,
    );

    await expect(loadConfig(root)).resolves.toMatchObject({
      renderer: {
        preferWebGPU: true,
        resolutionScale: 0.75,
        android: { resolutionScale: 0.32 },
      },
    });
  });

  it("uses package name defaults and the nativeEntry compatibility fallback without a config file", async () => {
    const root = await project("@studio/fox-game");
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "@studio/fox-game", threenative: { nativeEntry: "src/game.ts" } }),
    );

    await expect(loadConfig(root)).resolves.toMatchObject({
      app: { id: "com.threenative.foxgame", name: "fox-game", version: "0.1.13", build: 1 },
      display: { orientation: "landscape", fullscreen: true, keepScreenOn: false, maxFps: 60 },
      window: { title: "fox-game", width: 1280, height: 720, maximized: false, resizable: true },
      nativeEntry: "src/game.ts",
      renderer: { preferWebGPU: true },
      ui: { renderer: "web" },
    });
  });

  it.each(["web", "native", "native-css"])(
    "preserves an explicit %s UI renderer",
    async (renderer) => {
      const root = await project();
      await config(root, `export default { ui: { renderer: "${renderer}" } };`);
      await expect(loadConfig(root)).resolves.toMatchObject({ ui: { renderer } });
    },
  );

  it("names every valid UI renderer when the value is not one of them", async () => {
    const root = await project();
    await config(root, 'export default { ui: { renderer: "canvas" } };');
    await expect(loadConfig(root)).rejects.toThrow(
      /TN_CONFIG_UI_RENDERER_INVALID[\s\S]*web, native or native-css/u,
    );
  });

  it("uses the Vite-owned esbuild without invoking Vite's config loader", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fox-game", type: "module", devDependencies: { vite: "8.2.0" } }),
    );
    await mkdir(path.join(root, "node_modules/vite/dist/node"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules/vite/package.json"),
      JSON.stringify({
        name: "vite",
        type: "module",
        exports: { ".": "./dist/node/index.js" },
      }),
    );
    await writeFile(
      path.join(root, "node_modules/vite/dist/node/index.js"),
      `export async function loadConfigFromFile() {
  throw new Error("Vite's config loader must not run");
}
`,
    );
    await config(root, "export default { renderer: { preferWebGPU: true } }; ");

    await expect(loadConfig(root)).resolves.toMatchObject({
      renderer: { preferWebGPU: true },
    });
  });

  it("rejects a package without a name with the named code", async () => {
    const root = await project();
    await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module" }));
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_PACKAGE_NAME_MISSING/u);
  });

  it("rejects malformed package metadata with the named code", async () => {
    const root = await project();
    await writeFile(path.join(root, "package.json"), "{\n");
    await expectActionableFailure(
      root,
      "TN_CONFIG_PACKAGE_INVALID",
      "package manifest",
      path.join(root, "package.json"),
    );
  });

  it("rejects a non-object package compatibility block with the named code", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fox-game", threenative: "legacy" }),
    );
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_PACKAGE_INVALID/u);
  });

  it("resolves every declared brand variant and boot splash asset", async () => {
    const root = await project();
    for (const file of [
      "icon.png",
      "foreground.png",
      "monochrome.png",
      "dark.png",
      "tinted.png",
      "maskable.png",
      "apple.png",
      "launch.png",
    ])
      await writeFile(path.join(root, file), VALID_PNG);
    await writeFile(path.join(root, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" />\n');
    await config(
      root,
      `export default {
        app: {
          icon: "icon.png",
          icons: {
            android: { foreground: "foreground.png", background: "#111827", monochrome: "monochrome.png" },
            ios: { dark: "dark.png", tinted: "tinted.png" },
            web: { favicon: "favicon.svg", maskable: "maskable.png", monochrome: "monochrome.png", appleTouch: "apple.png" },
          },
        },
        bootSplash: { backgroundColor: "#0d1b2a", image: "launch.png" },
      };`,
    );
    await expect(loadConfig(root)).resolves.toMatchObject({
      app: {
        icon: "icon.png",
        icons: {
          android: {
            foreground: "foreground.png",
            background: "#111827",
            monochrome: "monochrome.png",
          },
          ios: { dark: "dark.png", tinted: "tinted.png" },
          web: {
            favicon: "favicon.svg",
            maskable: "maskable.png",
            monochrome: "monochrome.png",
            appleTouch: "apple.png",
          },
        },
      },
      bootSplash: { backgroundColor: "#0d1b2a", image: "launch.png" },
    });
  });

  it("rejects a declared brand variant with its path and stable code", async () => {
    const root = await project();
    await config(
      root,
      `export default { app: { icons: { android: { foreground: "missing-foreground.png" } } } };`,
    );
    await expectActionableFailure(
      root,
      "TN_CONFIG_BRAND_ANDROID_FOREGROUND_MISSING",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
    await expect(loadConfig(root)).rejects.toThrow(/missing-foreground\.png/u);
  });

  it("rejects a reintroduced loading group as an unknown config key", async () => {
    const root = await project();
    await config(root, 'export default { loading: { progressColor: "#ffffff" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
  });

  it("parses the assets group and omits it from resolved configs that do not declare it", async () => {
    const configured = await project();
    await config(configured, 'export default { assets: { source: "art", output: "web" } };');
    const resolved = await loadConfig(configured);
    expect(resolved.assets).toEqual({ output: "web", source: "art" });

    const bare = await project();
    expect((await loadConfig(bare)).assets).toBeUndefined();
  });

  it("parses declared asset targets into the resolved config", async () => {
    const root = await project();
    await config(
      root,
      `export default { assets: { source: "art", targets: { maxTriangles: 100000, maxTextureDimension: 2048 } } };`,
    );
    await expect(loadConfig(root)).resolves.toMatchObject({
      assets: {
        source: "art",
        targets: { maxTriangles: 100000, maxTextureDimension: 2048 },
      },
    });
  });

  it("rejects an unknown key under the assets group with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { bogus: true } };");
    await expectActionableFailure(
      root,
      "TN_CONFIG_UNKNOWN_KEY",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
  });

  it("rejects an unknown key under assets.targets with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { targets: { bogus: 1 } } };");
    await expect(loadConfig(root)).rejects.toThrow(/assets\.targets\.bogus/u);
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
  });

  it("parses the textures block and the none shorthand into the resolved config", async () => {
    const configured = await project();
    await config(
      configured,
      `export default {
        assets: {
          textures: {
            quality: 200,
            overrides: [{ glob: "**/*_nrm.png", codec: "uastc" }, { glob: "ui/**", codec: "none" }],
          },
        },
      };`,
    );
    await expect(loadConfig(configured)).resolves.toMatchObject({
      assets: {
        textures: {
          quality: 200,
          overrides: [
            { codec: "uastc", glob: "**/*_nrm.png" },
            { codec: "none", glob: "ui/**" },
          ],
        },
      },
    });

    const disabled = await project();
    await config(disabled, `export default { assets: { textures: "none" } };`);
    expect((await loadConfig(disabled)).assets).toEqual({ textures: "none" });
  });

  it("rejects an unknown texture codec with the named code", async () => {
    const root = await project();
    // The negative control for ledger row 4: an unknown codec name must fail config load.
    await config(
      root,
      `export default { assets: { textures: { overrides: [{ glob: "**/*.png", codec: "supercompressed" }] } } };`,
    );
    await expectActionableFailure(
      root,
      "TN_CONFIG_ASSETS_INVALID",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
    await expect(loadConfig(root)).rejects.toThrow(/supercompressed/u);
  });

  it("rejects a bad texture quality with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { textures: { quality: 900 } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/between 1 and 255/u);
  });

  it("rejects an invalid standalone texture maxSize with the named code", async () => {
    for (const value of ["0", "-1", "1.5", '"2048"']) {
      const root = await project();
      await config(root, `export default { assets: { textures: { maxSize: ${value} } } };`);
      await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
      await expect(loadConfig(root)).rejects.toThrow(
        /assets\.textures\.maxSize must be a positive integer/u,
      );
    }

    for (const value of ["1", "2", "3"]) {
      const root = await project();
      await config(root, `export default { assets: { textures: { maxSize: ${value} } } };`);
      await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
      await expect(loadConfig(root)).rejects.toThrow(
        /assets\.textures\.maxSize must be a positive integer of at least 4/u,
      );
    }
  });

  it("accepts per-slot texture caps and rejects malformed maps", async () => {
    const root = await project();
    const maxSize = { baseColorTexture: 2048, normalTexture: 1024 };
    await config(
      root,
      `export default { assets: { textures: { maxSize: ${JSON.stringify(maxSize)} }, models: { textures: { maxSize: ${JSON.stringify(maxSize)} } } } };`,
    );
    expect((await loadConfig(root)).assets).toMatchObject({
      textures: { maxSize },
      models: { textures: { maxSize } },
    });
    for (const value of [
      null,
      [],
      { baseColorTexture: 0 },
      { normalTexture: "1024" },
      { mask: 1024 },
    ]) {
      await config(
        root,
        `export default { assets: { textures: { maxSize: ${JSON.stringify(value)} } } };`,
      );
      await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    }
  });

  it("parses the models block and the none shorthand into the resolved config", async () => {
    const configured = await project();
    await config(
      configured,
      `export default {
        assets: {
          models: {
            lightmap: { atlasSize: 64, padding: 2 },
            passes: { dedup: true, prune: false },
            quantize: { positionBits: 14, normalBits: 10, uvBits: 12 },
          },
        },
      };`,
    );
    await expect(loadConfig(configured)).resolves.toMatchObject({
      assets: {
        models: {
          lightmap: { atlasSize: 64, padding: 2 },
          passes: { dedup: true, prune: false },
          quantize: { normalBits: 10, positionBits: 14, uvBits: 12 },
        },
      },
    });

    const disabled = await project();
    await config(disabled, `export default { assets: { models: "none" } };`);
    expect((await loadConfig(disabled)).assets).toEqual({ models: "none" });
  });

  it("rejects an unknown model pass name with the named code", async () => {
    const root = await project();
    // The negative control for ledger row 4: an unknown sub-pass must fail config load,
    // never run silently.
    await config(root, "export default { assets: { models: { passes: { decimate: true } } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.models\.passes\.decimate/u);
  });

  it("rejects an unknown key under assets.models with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { models: { bogus: 1 } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.models\.bogus/u);
  });

  it("carries the virtual-geometry bake through to the resolved config", async () => {
    const root = await project();
    await config(
      root,
      `export default {
        assets: {
          models: {
            virtual: { groupSize: 4, minSourceTriangles: 8192, simplifyRatio: 0.5 },
          },
        },
      };`,
    );
    await expect(loadConfig(root)).resolves.toMatchObject({
      assets: {
        models: { virtual: { groupSize: 4, minSourceTriangles: 8192, simplifyRatio: 0.5 } },
      },
    });
  });

  it("carries the virtual-geometry opt-out through to the resolved config", async () => {
    // Virtual geometry bakes by default; `"none"` is how a project that does not want the payload
    // says so, on the same terms as `textures: "none"`.
    const root = await project();
    await config(root, 'export default { assets: { models: { virtual: "none" } } };');
    await expect(loadConfig(root)).resolves.toMatchObject({
      assets: { models: { virtual: "none" } },
    });
  });

  /**
   * The seam, not either side of it. `loadConfig` validated `assets.models.virtual` and
   * `compileAssets` — the only consumer, called by `threenative build` with exactly this object —
   * did not list the key at all, so every game that wrote the documented override died at
   * `TN_ASSETS_CONFIG_UNKNOWN_KEY` before an asset compiled. Both sides were green the whole
   * time. This test hands one to the other.
   */
  it("hands every resolved assets key to the pipeline that receives it", async () => {
    const root = await project();
    await config(
      root,
      `export default {
        assets: {
          models: {
            virtual: { groupSize: 4, minSourceTriangles: 8192, simplifyRatio: 0.5 },
          },
        },
      };`,
    );
    const resolved = await loadConfig(root);

    // No assets/ directory, so the pipeline returns early — but only after it has parsed the
    // config, which is the step that used to throw.
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
  });

  it("hands assets.models.sharedImages to the pipeline that receives it", async () => {
    // The same seam again: the pipeline grew `sharedImages` for packs whose models all embed
    // the same textures, and this validator's key list is where a documented setting dies
    // before an asset compiles.
    const root = await project();
    await config(root, "export default { assets: { models: { sharedImages: true } } };");
    const resolved = await loadConfig(root);
    expect(resolved.assets).toMatchObject({ models: { sharedImages: true } });
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
  });

  it("rejects a non-boolean assets.models.sharedImages with the named code", async () => {
    const root = await project();
    await config(root, 'export default { assets: { models: { sharedImages: "yes" } } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.models\.sharedImages/u);
  });

  it("hands assets.models.compact to the pipeline that receives it", async () => {
    // The same seam: the engine grew lossless compaction, and this validator's key list is
    // where a documented opt-out dies before an asset compiles.
    const root = await project();
    await config(
      root,
      'export default { assets: { models: { compact: { protectedNames: ["Head"], instance: { min: 3 } } } } };',
    );
    const resolved = await loadConfig(root);
    expect(resolved.assets).toMatchObject({
      models: { compact: { instance: { min: 3 }, protectedNames: ["Head"] } },
    });
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });

    const off = await project();
    await config(off, "export default { assets: { models: { compact: false } } };");
    expect((await loadConfig(off)).assets).toMatchObject({ models: { compact: false } });
  });

  it("hands assets.concurrency to the pipeline that receives it", async () => {
    // The bounded-concurrency seam (PRD-319): the config validates the value and the driver
    // reads it — a key the driver ignored would pass this producer half and ship nothing.
    const root = await project();
    await config(root, "export default { assets: { concurrency: 3 } };");
    const resolved = await loadConfig(root);
    expect(resolved.assets).toMatchObject({ concurrency: 3 });
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
  });

  it("rejects a non-integer assets.concurrency with the named code", async () => {
    const root = await project();
    await config(root, 'export default { assets: { concurrency: "lots" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.concurrency/u);
  });

  it("hands assets.nativePackage to the pipeline that receives it", async () => {
    // The same seam: the compiler grew the native cooked package, and this validator's key list is
    // where the opt-in dies before an asset compiles.
    const root = await project();
    await config(root, "export default { assets: { nativePackage: true } };");
    const resolved = await loadConfig(root);
    expect(resolved.assets).toMatchObject({ nativePackage: true });
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toEqual({
      concurrencyUsed: 1,
      passCosts: [],
      skipped: 0,
      skippedCompression: [],
      written: 0,
    });
  });

  it("rejects a non-boolean assets.nativePackage with the named code", async () => {
    const root = await project();
    await config(root, 'export default { assets: { nativePackage: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.nativePackage/u);
  });

  it("hands assets.audio to the pipeline that receives it and ships the declared bytes", async () => {
    // The seam a real game hit: `assets.audio` is a documented compile option that this
    // validator's key list dropped, so a project asking to ship its cues exactly as authored
    // could not load its config at all. Both arms compile the same clip; only the config differs.
    const source = wavClip(4_410);

    const declared = await project();
    await mkdir(path.join(declared, "assets/audio"), { recursive: true });
    await writeFile(path.join(declared, "assets/audio/cue.wav"), source);
    await config(declared, 'export default { assets: { audio: "none" } };');
    const resolved = await loadConfig(declared);
    expect(resolved.assets).toEqual({ audio: "none" });
    await compileAssets({ config: resolved.assets, cwd: declared });
    expect(await compiledBytes(declared, "audio/cue.wav")).toEqual(source);

    // The control: with the block absent, conditioning runs and re-encodes the clip. Without it
    // the assertion above would pass on a pipeline that never touches audio at all.
    const conditioned = await project();
    await mkdir(path.join(conditioned, "assets/audio"), { recursive: true });
    await writeFile(path.join(conditioned, "assets/audio/cue.wav"), source);
    await config(conditioned, "export default {};");
    await compileAssets({ config: (await loadConfig(conditioned)).assets, cwd: conditioned });
    expect(await compiledBytes(conditioned, "audio/cue.wav")).not.toEqual(source);
  });

  it("carries the whole audio block, overrides included, through to the pipeline", async () => {
    const root = await project();
    await config(
      root,
      `export default {
        assets: {
          audio: {
            normalise: "peak",
            peakDb: -3,
            quality: 6,
            seamMaxRatio: 2,
            overrides: [
              {
                glob: "audio/*-bed.ogg",
                loop: { crossFadeMs: 120, spliceToleranceMs: 40 },
                spectrum: { band: "high", minPercent: 10, maxPercent: 60 },
              },
              { glob: "audio/step-*.wav", conditioning: "none", positional: true },
            ],
          },
        },
      };`,
    );
    const resolved = await loadConfig(root);
    // Exact, not a subset: a key silently dropped on the way through is the whole defect.
    expect(resolved.assets).toEqual({
      audio: {
        normalise: "peak",
        peakDb: -3,
        quality: 6,
        seamMaxRatio: 2,
        overrides: [
          {
            glob: "audio/*-bed.ogg",
            loop: { crossFadeMs: 120, spliceToleranceMs: 40 },
            spectrum: { band: "high", minPercent: 10, maxPercent: 60 },
          },
          { glob: "audio/step-*.wav", conditioning: "none", positional: true },
        ],
      },
    });
    await expect(compileAssets({ config: resolved.assets, cwd: root })).resolves.toMatchObject({
      written: 0,
    });
    // Same value, checked by the compiler: the block the parser just accepted has to be assignable
    // to what both packages publish, and the key the table below rejects must not be offered.
    await expectPublishedTypesAccept(resolved.assets?.audio, "seamThreshold");
  });

  it.each([
    ['audio: "off"', /assets\.audio must be "none" or an object/u],
    ["audio: { seamThreshold: 2 }", /assets\.audio\.seamThreshold is not recognised/u],
    ["audio: { normalise: 'loudest' }", /assets\.audio\.normalise must be "ceiling"/u],
    ["audio: { peakDb: 3 }", /assets\.audio\.peakDb must be a number between -60 and 0 dBFS/u],
    [
      "audio: { overrides: [{ glob: '**', loop: { crossFadeMs: 'soon' } }] }",
      /assets\.audio\.overrides\[0\]\.loop\.crossFadeMs must be a non-negative number/u,
    ],
    [
      "audio: { overrides: [{ glob: '**', spectrum: { band: 'ultrasonic', maxPercent: 10 } }] }",
      /assets\.audio\.overrides\[0\]\.spectrum\.band must be one of sub, low, mid, high, air/u,
    ],
    [
      "audio: { overrides: [{ glob: '**', spectrum: { band: 'high' } }] }",
      /neither bounds anything/u,
    ],
    [
      "audio: { overrides: [{ loop: true }] }",
      /assets\.audio\.overrides\[0\]\.glob must be a non-empty string/u,
    ],
  ])(
    "rejects the malformed audio declaration { %s } with the named code",
    async (block, detail) => {
      const root = await project();
      await config(root, `export default { assets: { ${block} } };`);
      await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
      await expect(loadConfig(root)).rejects.toThrow(detail);
    },
  );

  it("rejects an unknown key under assets.models.virtual with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { models: { virtual: { ratio: 0.5 } } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
    await expect(loadConfig(root)).rejects.toThrow(/assets\.models\.virtual\.ratio/u);
  });

  it("rejects a simplify ratio outside the open unit interval with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { models: { virtual: { simplifyRatio: 1 } } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/between 0 and 1, exclusive/u);
  });

  it("rejects an out-of-range quantize depth with the named code", async () => {
    const root = await project();
    await config(root, "export default { assets: { models: { quantize: { positionBits: 0 } } } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ASSETS_INVALID/u);
    await expect(loadConfig(root)).rejects.toThrow(/between 1 and 16 bits/u);
  });

  it("rejects bad orientation with the named code", async () => {
    const root = await project();
    await config(root, 'export default { display: { orientation: "sideways" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_NATIVE_ORIENTATION_INVALID/u);
  });

  it.each([-1, 60.5, 1001, "120"])(
    "rejects invalid display.maxFps %j with the named code",
    async (maxFps) => {
      const root = await project();
      await config(root, `export default { display: { maxFps: ${JSON.stringify(maxFps)} } };`);
      await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_MAX_FPS_INVALID/u);
    },
  );

  it("rejects bad app ids with the named code", async () => {
    const root = await project();
    await config(root, 'export default { app: { id: "Fox Game" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_ID_INVALID/u);
  });

  it("rejects an underscore app id that Android might otherwise accept", async () => {
    const root = await project();
    await config(root, 'export default { app: { id: "com.studio_fox.game" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_ID_INVALID/u);
  });

  it("rejects an invalid app name with the named code", async () => {
    const root = await project();
    await config(root, "export default { app: { name: 42 } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_NAME_INVALID/u);
  });

  it("rejects an invalid app version with the named code", async () => {
    const root = await project();
    await config(root, 'export default { app: { version: "v1" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_VERSION_INVALID/u);
  });

  it("rejects a prerelease app version with the named code", async () => {
    const root = await project();
    await config(root, 'export default { app: { version: "1.2.3-beta" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_VERSION_INVALID/u);
  });

  it("rejects an invalid app build with the named code", async () => {
    const root = await project();
    await config(root, "export default { app: { build: 0 } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_APP_BUILD_INVALID/u);
  });

  it("rejects a non-PNG icon with the named code", async () => {
    const root = await project();
    await config(root, 'export default { app: { icon: "icon.jpg" } };');
    await expectActionableFailure(
      root,
      "TN_CONFIG_ICON_INVALID",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
  });

  it("rejects corrupt PNG content with the named code", async () => {
    const root = await project();
    const corruptPng = Buffer.from(VALID_PNG);
    corruptPng.writeUInt8(corruptPng.readUInt8(41) ^ 0xff, 41);
    await writeFile(path.join(root, "icon.png"), corruptPng);
    await config(root, 'export default { app: { icon: "icon.png" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ICON_INVALID/u);
  });

  it("rejects a missing icon instead of silently using the platform default", async () => {
    const root = await project();
    await config(root, 'export default { app: { icon: "missing.png" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_ICON_MISSING/u);
  });

  it("rejects a config/package native-entry conflict", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fox-game", threenative: { nativeEntry: "src/game.ts" } }),
    );
    await config(root, 'export default { nativeEntry: "src/game.ts" };');
    await expectActionableFailure(
      root,
      "TN_CONFIG_CONFLICT",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
  });

  it("rejects a native entry outside the project with the named code", async () => {
    const root = await project();
    await config(root, 'export default { nativeEntry: "../game.ts" };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_NATIVE_ENTRY_INVALID/u);
  });

  it("rejects an empty native entry with the named code", async () => {
    const root = await project();
    await config(root, 'export default { nativeEntry: "" };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_NATIVE_ENTRY_MISSING/u);
  });

  it("rejects a malformed group with the named code", async () => {
    const root = await project();
    await config(root, "export default { display: false };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_GROUP_INVALID/u);
  });

  it("rejects an unknown config key with the named code", async () => {
    const root = await project();
    await config(root, "export default { plugins: {} };");
    await expectActionableFailure(
      root,
      "TN_CONFIG_UNKNOWN_KEY",
      "config validation",
      path.join(root, "threenative.config.ts"),
    );
  });

  it("rejects an invalid fullscreen value with the named code", async () => {
    const root = await project();
    await config(root, 'export default { display: { fullscreen: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_FULLSCREEN_INVALID/u);
  });

  it("rejects an invalid keep-screen-on value with the named code", async () => {
    const root = await project();
    await config(root, 'export default { display: { keepScreenOn: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_KEEP_SCREEN_ON_INVALID/u);
  });

  it("rejects an invalid window title with the named code", async () => {
    const root = await project();
    await config(root, "export default { window: { title: 42 } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_WINDOW_TITLE_INVALID/u);
  });

  it("rejects an invalid window width with the named code", async () => {
    const root = await project();
    await config(root, "export default { window: { width: 0 } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_WINDOW_WIDTH_INVALID/u);
  });

  it("rejects an invalid window height with the named code", async () => {
    const root = await project();
    await config(root, "export default { window: { height: 1.5 } };");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_WINDOW_HEIGHT_INVALID/u);
  });

  it("rejects an invalid resizable value with the named code", async () => {
    const root = await project();
    await config(root, 'export default { window: { resizable: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_WINDOW_RESIZABLE_INVALID/u);
  });

  it("rejects an invalid maximized value with the named code", async () => {
    const root = await project();
    await config(root, 'export default { window: { maximized: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_WINDOW_MAXIMIZED_INVALID/u);
  });

  it("rejects an invalid renderer value with the named code", async () => {
    const root = await project();
    await config(root, 'export default { renderer: { preferWebGPU: "yes" } };');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_RENDERER_INVALID/u);
  });

  it.each([
    "export default { renderer: { resolutionScale: 0 } };",
    'export default { renderer: { android: { resolutionScale: "small" } } };',
    // Above one is a drawing buffer larger than the surface, which the engine refuses; the
    // scaffold has to refuse it in the same place, or a game learns the rule from a crash.
    "export default { renderer: { resolutionScale: 1.5 } };",
    "export default { renderer: { android: { resolutionScale: 2 } } };",
  ])("rejects an invalid renderer resolution scale with the named code", async (source) => {
    const root = await project();
    await config(root, source);
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_RENDERER_RESOLUTION_SCALE_INVALID/u);
  });

  it('accepts the shipped "auto" scale and the Android sampling override', async () => {
    // The templates ship `resolutionScale: "auto"`. A scaffold validator that rejects what the
    // templates ship fails every generated project on its first command.
    const root = await project();
    await config(
      root,
      'export default { renderer: { resolutionScale: "auto", antialias: true,' +
        " android: { resolutionScale: 0.44, antialias: false } } };",
    );
    const loaded = await loadConfig(root);
    expect(loaded.renderer).toEqual({
      android: { antialias: false, resolutionScale: 0.44 },
      antialias: true,
      preferWebGPU: true,
      resolutionScale: "auto",
    });
  });

  it("rejects a config with no default export object", async () => {
    const root = await project();
    await config(root, "export const game = {}; ");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_DEFAULT_MISSING/u);
  });

  it("rejects a config that cannot be transpiled", async () => {
    const root = await project();
    await config(root, "export default { ; ");
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_TRANSPILE_FAILED/u);
  });

  it("rejects a config that fails while loading", async () => {
    const root = await project();
    await config(root, 'throw new Error("config failed");');
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_LOAD_FAILED/u);
  });

  it("keeps loading provenance tied to the config source, not an embedded error-code prefix", async () => {
    const root = await project();
    await config(root, 'throw new Error("TN_CONFIG_PACKAGE_INVALID: config-owned failure");');
    await expectActionableFailure(
      root,
      "TN_CONFIG_LOAD_FAILED",
      "config loading",
      path.join(root, "threenative.config.ts"),
    );
    let message = "";
    try {
      await loadConfig(root);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toContain("package manifest layer failed");
  });

  it("rejects a second package.json config surface", async () => {
    const root = await project();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "fox-game", threenative: { orientation: "portrait" } }),
    );
    await expect(loadConfig(root)).rejects.toThrow(/TN_CONFIG_UNKNOWN_KEY/u);
  });

  it("cleans the transpiled temporary module after loading", async () => {
    const root = await project();
    await config(root, "export default {}; ");
    await loadConfig(root);
    const files = await readdir(root);
    expect(files.some((file) => /^\\.threenative\\.config\\./u.test(file))).toBe(false);
  });
});

// One valid value for every key the loader accepts under `assets.*`, nested sections included.
const SEAM_SAMPLE = {
  audio: "none",
  budget: { uncooked: "none", total: 1000000 },
  concurrency: 2,
  exclude: ["*.glb"],
  lod: false,
  models: {
    compact: false,
    lightmap: { atlasSize: 128, padding: 2 },
    passes: {
      dedup: true,
      meshopt: false,
      prune: true,
      quantize: true,
      reorder: false,
      restTracks: false,
    },
    quantize: { normalBits: 8, positionBits: 12, uvBits: 12 },
    sharedImages: true,
    simplify: { ratio: 0.5 },
    textures: "none",
    virtual: {
      groupSize: 4,
      maxTriangles: 1000,
      minSourceTriangles: 500,
      minTriangles: 100,
      simplifyRatio: 0.5,
    },
  },
  nativePackage: true,
  output: "public",
  source: "assets",
  targets: { maxTriangles: 100_000, maxTextureDimension: 2048 },
  textures: "none",
};
type Equals<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

it("accepts every assets.* key on both sides of the config/compiler seam", async () => {
  const sorted = (keys: readonly string[]) => [...keys].sort();
  // The sample names every key of each list, and each list is the code's own.
  expect(sorted(Object.keys(SEAM_SAMPLE))).toEqual(sorted(ASSETS_CONFIG_KEYS));
  expect(sorted(Object.keys(SEAM_SAMPLE.models))).toEqual(sorted(MODELS_CONFIG_KEYS));
  expect(sorted(Object.keys(SEAM_SAMPLE.models.lightmap))).toEqual(sorted(LIGHTMAP_CONFIG_KEYS));
  expect(sorted(Object.keys(SEAM_SAMPLE.models.passes))).toEqual(sorted(MODEL_PASS_KEYS));
  expect(sorted(Object.keys(SEAM_SAMPLE.models.quantize))).toEqual(sorted(MODEL_QUANTIZE_KEYS));
  expect(sorted(Object.keys(SEAM_SAMPLE.models.virtual))).toEqual(sorted(MODEL_VIRTUAL_KEYS));
  // The compiler's lists must name the same keys as the loader's, in both directions.
  expect(sorted(assetKeys.ASSETS_CONFIG_KEYS)).toEqual(sorted(ASSETS_CONFIG_KEYS));
  expect(sorted(assetKeys.MODELS_CONFIG_KEYS)).toEqual(sorted(MODELS_CONFIG_KEYS));
  expect(sorted(assetKeys.LIGHTMAP_CONFIG_KEYS)).toEqual(sorted(LIGHTMAP_CONFIG_KEYS));
  expect(sorted(assetKeys.MODEL_PASS_KEYS)).toEqual(sorted(MODEL_PASS_KEYS));
  expect(sorted(assetKeys.MODEL_QUANTIZE_KEYS)).toEqual(sorted(MODEL_QUANTIZE_KEYS));
  expect(sorted(assetKeys.MODEL_VIRTUAL_KEYS)).toEqual(sorted(MODEL_VIRTUAL_KEYS));
  // Core's public type must name the same model keys as the loader.
  const coreModelKeysMatch: Equals<
    keyof IThreeNativeModelsConfig,
    (typeof MODELS_CONFIG_KEYS)[number]
  > = true;
  expect(coreModelKeysMatch).toBe(true);

  const root = await project();
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/keep.txt"), "kept");
  await config(root, `export default { assets: ${JSON.stringify(SEAM_SAMPLE)} };`);
  const loaded = await loadConfig(root);
  await compileAssets({ cwd: root, config: loaded.assets });
  await compileAssets({ cwd: root, config: SEAM_SAMPLE as never });
});

it("rejects an unknown assets.* key at every level on both sides of the seam", async () => {
  const levels = [
    { assets: { bogus: true } },
    { assets: { models: { bogus: true } } },
    { assets: { models: { lightmap: { atlasSize: 128, padding: 2, bogus: true } } } },
    { assets: { models: { passes: { bogus: true } } } },
    { assets: { models: { quantize: { bogus: 8 } } } },
    { assets: { models: { virtual: { bogus: 2 } } } },
  ];
  for (const level of levels) {
    // A fresh project per level, so a cached config module cannot answer for the next one.
    const root = await project();
    await mkdir(path.join(root, "assets"));
    await writeFile(path.join(root, "assets/keep.txt"), "kept");
    await config(root, `export default ${JSON.stringify(level)};`);
    await expect(loadConfig(root)).rejects.toThrow("TN_CONFIG_UNKNOWN_KEY");
    await expect(compileAssets({ cwd: root, config: level.assets as never })).rejects.toThrow(
      "TN_ASSETS_CONFIG_UNKNOWN_KEY",
    );
  }
});

it("rejects a lightmap atlas size that is not a multiple of four on both sides of the seam", async () => {
  const root = await project();
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets/keep.txt"), "kept");
  await config(
    root,
    "export default { assets: { models: { lightmap: { atlasSize: 130, padding: 2 } } } };",
  );
  await expect(loadConfig(root)).rejects.toThrow("TN_CONFIG_ASSETS_INVALID");
  await expect(
    compileAssets({
      cwd: root,
      config: { models: { lightmap: { atlasSize: 130, padding: 2 } } } as never,
    }),
  ).rejects.toThrow("TN_ASSETS_CONFIG_INVALID");
});

// Templates whose imports the native engine does not bind yet (PRD-573 slice 8). Each pins
// `engine: "threejs"` with a comment, and leaves this list when the pin goes.
const LEGACY_PINNED_TEMPLATES = ["action-rpg", "runner", "sailing", "snow"];

it("gives every freshly scaffolded template the threenative engine unless it names its threejs pin", async () => {
  const root = await makeTempDir("threenative-scaffold-engine-");
  roots.push(root);
  const templates = discoverTemplateNames(path.resolve("packages/create-threenative/templates"));
  expect(templates.filter((name) => LEGACY_PINNED_TEMPLATES.includes(name))).toEqual(
    LEGACY_PINNED_TEMPLATES,
  );
  for (const template of templates) {
    const { target } = await createProject({ install: false, target: template, template }, root);
    const pinned = LEGACY_PINNED_TEMPLATES.includes(template);
    expect(await loadConfig(target), template).toMatchObject({
      engine: pinned ? "threejs" : "threenative",
    });
    const source = await readFile(path.join(target, "threenative.config.ts"), "utf8");
    expect(source.includes("PRD-573 slice 8"), `${template} names its pin`).toBe(pinned);
  }
});
