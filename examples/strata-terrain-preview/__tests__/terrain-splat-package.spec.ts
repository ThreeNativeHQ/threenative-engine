import assert from "node:assert/strict";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import * as url from "node:url";
import { runInNewContext } from "node:vm";
import { MATERIAL_IDS, Terrain } from "@threenative/terrain";
import { starterAssetsDir } from "@threenative/terrain/kit";
import ts from "typescript";
import { expect, it } from "vitest";
import { BIOMES } from "../src/render/biomes.js";
import { GROUND_MAPS, GROUND_TILE } from "../src/world/terrainAssets.js";

const base = new URL("../", import.meta.url);
const bake = readFileSync(new URL("scripts/bake.mjs", base), "utf8");
const declaration = ts
  .createSourceFile("bake.mjs", bake, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  .statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "terrainSurfacePackage",
  );
assert(declaration);
// Execute only the actual packaging function; importing bake would run all five authoring recipes.
const pack = runInNewContext(`(${declaration.getText().replace(/^export /u, "")})`, {
  assert,
  MATERIAL_IDS,
  GROUND_TILE,
  GROUND_MAPS,
});

it("exports actual authored weights in package-ground row order and the existing layer schema", () => {
  const terrain = new Terrain({ size: 2, resolution: 17, seed: 1 })
    .paint({ at: [-1, -1], radius: 0.4, material: "dirt" })
    .paint({ at: [1, -1], radius: 0.4, material: "rock" })
    .paint({ at: [-1, 1], radius: 0.4, material: "snow" })
    .paint({ at: [1, 1], radius: 0.4, material: "moss" });
  const state = terrain.evaluate();
  const before = state.splat.slice();
  const { world, table, splat } = pack("forest", state, GROUND_MAPS);
  expect(world).toEqual({
    version: 1,
    extent: { minX: -1, minZ: -1, sizeX: 2, sizeZ: 2 },
    terrain: { layers: { table: "forest.layers.json", splat: "forest.splat.rgba8" } },
  });
  expect(splat.byteLength).toBe(17 * 17 * 4 * 2);
  // First raw row is +Z: snow in the first plane's alpha, moss in the second plane's alpha.
  expect(Array.from(splat.slice(0, 4))).toEqual([0, 0, 0, 255]);
  expect(Array.from(splat.slice(17 * 17 * 4 + 16 * 4, 17 * 17 * 4 + 17 * 4))).toEqual([
    0, 0, 0, 255,
  ]);
  // Last raw row is -Z: dirt in green, rock in blue.
  expect(Array.from(splat.slice(16 * 17 * 4, 16 * 17 * 4 + 4))).toEqual([0, 255, 0, 0]);
  expect(Array.from(splat.slice(16 * 17 * 4 + 16 * 4, 17 * 17 * 4))).toEqual([0, 0, 255, 0]);
  expect(table.splat.masks).toEqual({
    grass: [0, "r"],
    dirt: [0, "g"],
    rock: [0, "b"],
    snow: [0, "a"],
    sand: [1, "r"],
    mud: [1, "g"],
    road: [1, "b"],
    moss: [1, "a"],
  });
  expect(table.layers.map((layer: { id: string }) => layer.id)).toEqual([
    "dirt",
    "moss",
    "sand",
    "rock",
    "snow",
  ]);
  expect(table.base.maps).toEqual({
    diffuse: `../${GROUND_MAPS.grass.diffuse}`,
    normal: `../${GROUND_MAPS.grass.normal}`,
  });
  expect(table.layers[2].normal).toBe(false);
  expect(state.splat).toEqual(before);
  expect(() => pack("bad", { ...state, splat: state.splat.slice(1) }, GROUND_MAPS)).toThrow(
    /invalid splat grid/u,
  );
  const invalid = state.splat.slice();
  invalid[0] = Number.NaN;
  expect(() => pack("bad", { ...state, splat: invalid }, GROUND_MAPS)).toThrow(/nonfinite splat/u);
});

it("references available starter maps and the runtime's CC0 fallback for optional licensed maps", async () => {
  const root = await starterAssetsDir();
  const state = new Terrain({ size: 2, resolution: 17 }).evaluate();
  for (const biome of Object.values(BIOMES)) {
    const maps =
      biome.world === "forest" || biome.world === "coastal"
        ? { ...GROUND_MAPS, dirt: BIOMES.alpine.maps.dirt }
        : biome.maps;
    const { table } = pack(biome.world, state, maps);
    for (const layer of [table.base, ...table.layers]) {
      for (const map of Object.values(layer.maps) as string[])
        expect(fs.existsSync(path.resolve(root, "world", map)), `${biome.world}: ${map}`).toBe(
          true,
        );
    }
    if (biome.world === "alpine")
      expect(table.layers.find((layer: { id: string }) => layer.id === "rock").maps.diffuse).toBe(
        `../${GROUND_MAPS.rock.diffuse}`,
      );
  }
});

it("delivers flat descriptors, tables, raw masks and placements through Vite and native staging", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "strata-splat-"));
  try {
    mkdirSync(path.join(root, "src/world"), { recursive: true });
    mkdirSync(path.join(root, "scripts"));
    mkdirSync(path.join(root, "starter"));
    const files = ["forest", "coastal", "alpine", "desert", "tundra"].flatMap((world) =>
      ["world.json", "layers.json", "splat.rgba8", "placements.bin"].map(
        (suffix) => `${world}.${suffix}`,
      ),
    );
    for (const name of [...files, "baked.json", ".bake-stamp"])
      writeFileSync(path.join(root, "src/world", name), name);
    const execute = async (relative: string) => {
      const source = readFileSync(new URL(relative, base), "utf8").replaceAll(
        "import.meta.url",
        JSON.stringify(pathToFileURL(path.join(root, relative)).href),
      );
      const code = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const exports: Record<string, unknown> = {};
      const dependencies: Record<string, unknown> = {
        "node:fs": fs,
        "node:path": path,
        "node:url": url,
        "@threenative/terrain/kit": { starterAssetsDir: async () => path.join(root, "starter") },
        "@threenative/terrain/editor/server": { terrainEditor: () => ({}) },
        vite: { defineConfig: (config: unknown) => config },
      };
      await runInNewContext(`(async () => { ${code}\n })()`, {
        exports,
        console,
        Buffer,
        URL,
        require: (name: string) => {
          assert(name in dependencies, name);
          return dependencies[name];
        },
      });
      return exports.default as { plugins: Array<{ generateBundle?: (this: unknown) => void }> };
    };
    const config = await execute("vite.config.ts");
    const emitted: Array<{ fileName: string; source: Buffer }> = [];
    config.plugins
      .find((plugin) => plugin.generateBundle)
      ?.generateBundle?.call({ emitFile: (file: (typeof emitted)[number]) => emitted.push(file) });
    expect(emitted.map((file) => file.fileName).sort()).toEqual(
      files.map((name) => `world/${name}`).sort(),
    );
    for (const file of emitted) expect(file.source.toString()).toBe(path.basename(file.fileName));
    await execute("scripts/stage-native-assets.mjs");
    expect(fs.readdirSync(path.join(root, "assets/world")).sort()).toEqual(files.sort());
    for (const name of files)
      expect(readFileSync(path.join(root, "assets/world", name), "utf8")).toBe(name);
    rmSync(path.join(root, "src/world/forest.splat.rgba8"));
    expect(() =>
      config.plugins
        .find((plugin) => plugin.generateBundle)
        ?.generateBundle?.call({ emitFile() {} }),
    ).toThrow(/ENOENT/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
