// Run with <out dir> (the starter art's `desert_flora/`); needs @threenative/procedural-environment.
// Bakes the desert's plants and dead wood once into GLBs the species pack (`render/props/pack.ts`)
// draws. Valley of the Gods has no Poly Haven scan for these species, so they are Arbor and
// forest-kit presets: the same preset, seed and level always write the same bytes.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bakeVegetation } from "@threenative/procedural-environment";

const out = process.argv[2];
if (!out) throw new Error("bake-flora: pass the output folder, e.g. starter-assets/desert_flora");

/**
 * The saguaro's own surface: Arbor's drawn cactus bark is a flat pinstripe on a column that is all
 * silhouette, so the two saguaros carry the photographed skin `make-cactus-skin.mjs` builds.
 * `--assets` names the folder those PNGs live in when it is not the output one.
 */
const assets = process.argv.includes("--assets")
  ? process.argv[process.argv.indexOf("--assets") + 1]
  : out;
const CACTUS = {
  barkImage: join(assets, "saguaro-skin.png"),
  barkNormalImage: join(assets, "saguaro-skin-nor.png"),
};

/** [file, preset, seed, { level: file suffix }, skin?]: the file names `pack.ts` quotes. */
const ROWS = [
  // Utah juniper: the gnarled grey-green `olive` crown is the nearest Arbor form.
  ["juniper-a", "olive", 1, { 1: "", 2: "-far" }],
  ["juniper-b", "olive", 2, { 1: "", 2: "-far" }],
  // Saguaro: the cactus the request names first; Arbor's columnar form with its arms, under the
  // ribbed skin and its relief.
  ["saguaro-a", "saguaro", 1, { 0: "", 2: "-far" }, CACTUS],
  ["saguaro-b", "saguaro", 4, { 0: "", 2: "-far" }, CACTUS],
  ["sage", "creosote", 1, { 0: "" }],
  ["creosote-b", "creosote", 3, { 0: "" }],
  ["thornbush-b", "thornbush", 4, { 0: "" }],
  ["agave-b", "agave", 5, { 0: "" }],
  ["blackbrush", "thornbush", 1, { 0: "" }],
  ["yucca", "agave", 1, { 0: "" }],
  ["bunchgrass-a", "bunchgrass", 1, { 0: "" }],
  ["bunchgrass-b", "bunchgrass", 2, { 0: "" }],
  ["drygrass", "drygrass", 1, { 0: "" }],
  ["marigold", "marigold", 1, { 0: "" }],
  ["branch", "branch", 1, { 0: "" }],
  ["branch-b", "branch", 2, { 0: "" }],
  ["twig", "twig", 1, { 0: "" }],
];

await mkdir(out, { recursive: true });
const scratch = await mkdtemp(join(tmpdir(), "desert-flora-"));
try {
  for (const [file, preset, seed, levels, skin] of ROWS) {
    const lods = Object.keys(levels).map(Number);
    for (const level of await bakeVegetation({ preset, seed, lods, out: scratch, ...skin })) {
      await cp(level.path, join(out, `${file}${levels[level.lod]}.glb`));
      console.log(
        `${file}${levels[level.lod]}.glb  ${preset}@${seed} lod${level.lod}  ${level.triangles} triangles`,
      );
    }
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
