/**
 * Bakes the adventure kit's forest-floor props into the shared template assets.
 *
 * The kit is generated source: it loads these GLBs at run time and re-materials them in
 * `src/render/foliage.ts`, so a game changes the look without a package edit. Run this after any
 * change to the bake, and commit the bytes it writes:
 *
 *   pnpm tsx scripts/bake-floor-assets.ts
 */
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bakeVegetation } from "../packages/procedural-vegetation/src/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const assets = path.resolve(here, "../packages/create-threenative/template-assets/assets");

/**
 * `file` is the name the kit's source quotes, so `create-threenative` copies it into a scaffolded
 * project's `assets/`; the number is the level of detail. Seeds are pinned so a rerun is byte for
 * byte the same file.
 */
const ROWS = [
  { file: "floor-log", lods: [0, 1], preset: "log", seed: 11 },
  { file: "floor-stump", lods: [0], preset: "stump", seed: 12 },
  { file: "floor-twig", lods: [0], preset: "twig", seed: 13 },
  { file: "floor-litter", lods: [0], preset: "leaflitter", seed: 14 },
  { file: "floor-fern", lods: [0], preset: "swordfern", seed: 15 },
] as const;

const temporary = await mkdtemp(path.join(os.tmpdir(), "tn-floor-assets-"));
try {
  for (const row of ROWS) {
    const baked = await bakeVegetation({
      lods: [...row.lods],
      out: temporary,
      preset: row.preset,
      seed: row.seed,
    });
    for (const entry of baked) {
      const name = `${row.file}-${entry.lod}.glb`;
      await cp(entry.path, path.join(assets, name));
      console.info(`${name}  ${entry.triangles} triangles`);
    }
  }
  const written = (await readdir(assets)).filter((name) => name.startsWith("floor-"));
  console.info(
    `\n${written.length} forest-floor assets in ${path.relative(process.cwd(), assets)}`,
  );
} finally {
  await rm(temporary, { force: true, recursive: true });
}
