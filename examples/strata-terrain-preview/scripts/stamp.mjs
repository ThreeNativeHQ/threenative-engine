// The bake's stamp: every input a bake depends on, hashed, and whether the written worlds are stale.
//
// `pnpm dev` checks the cache on every start; strong erosion runs only on a cold bake. The recipes
// are seeded and deterministic, so a bake is only needed when the recipe, the palette it colours
// with, the biome files or the terrain build it evaluates against has changed. `bake.mjs --force`
// overrides. `process.exit` is not how this skips — it would take the importer down with it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { terrainPalette } from "../src/render/palette.js";
import { WORLD_NAMES as WORLDS } from "../src/render/worldNames.js";

const { realContinuation, recipes } = await import("./recipe.mjs");

const drawn = new Set(["forest", "coastal"]);
const biomeFile = (name) =>
  new URL(`../../../packages/terrain/starter/${name}/biome.data.json`, import.meta.url);

/** Every file a bake reads besides the recipes: the game's own source and the package build. */
const SOURCES = [
  "../src/render/terrain.ts",
  "../src/render/skyVisibility.ts",
  "../src/render/biomes.ts",
  "../src/world/terrainAssets.ts",
  "../src/render/benchmark.ts",
  "../src/render/propWorld.ts",
  "../src/render/props.ts",
  "../src/render/worldNames.ts",
  "./bake.mjs",
  "./props.mjs",
  "./recipe.mjs",
  "./stamp.mjs",
  "../../../packages/terrain/dist/index.js",
];

const hash = createHash("sha256");
hash.update(
  JSON.stringify(Object.fromEntries(Object.entries(recipes).map(([n, t]) => [n, t.toJSON()]))),
);
hash.update(
  JSON.stringify(
    Object.fromEntries(
      Object.entries(realContinuation).map(([name, terrain]) => [name, terrain.toJSON()]),
    ),
  ),
);
hash.update(JSON.stringify(terrainPalette));
for (const name of WORLDS) hash.update(readFileSync(biomeFile(name)));
for (const file of SOURCES) hash.update(await readFile(new URL(file, import.meta.url)));

/** This bake's inputs, as one digest. */
export const stamp = hash.digest("hex");

/**
 * Whether the files are already baked from these inputs: the stamp matches and no output is newer
 * than it. `drawn` worlds live inside baked.json; the rest are written beside it, so checking the
 * drawn set's own filenames would stat files that never exist and re-bake on every start.
 */
export async function isFresh(outputDir) {
  try {
    const url = new URL(".bake-stamp", outputDir);
    const [old, out] = await Promise.all([readFile(url, "utf8"), stat(url)]);
    const undrawn = WORLDS.filter((name) => !drawn.has(name));
    const stale = (
      await Promise.all(
        [
          "baked.json",
          "horizon.json",
          ...undrawn.map((name) => `${name}.json`),
          ...WORLDS.flatMap((name) => [
            `${name}.props.json`,
            `${name}.canopy.bin`,
            `${name}.sky.bin`,
            `${name}.world.json`,
            `${name}.layers.json`,
            `${name}.splat.rgba8`,
          ]),
        ].map((file) =>
          stat(new URL(file, outputDir)).then(
            (s) => s.mtimeMs > out.mtimeMs,
            () => true,
          ),
        ),
      )
    ).some(Boolean);
    return old.trim() === stamp && !stale;
  } catch {
    // No stamp yet: bake.
    return false;
  }
}
