/**
 * Put the licensed Landscape Pro 2.0 species this world draws where the game can load them.
 *
 *   node scripts/prep-landscape-pro.mjs [--raw]
 *
 * **The pack is never committed.** The Fab Standard License does not permit redistributing a
 * paid pack's assets through a public repository, so the bytes live in this example's gitignored
 * `local-assets/landscape-pro/` and this script — not the files — is what is committed. On CI, on
 * a fresh clone and in a review that folder does not exist, `src/render/prepared.ts` fails soft
 * per file, and the procedural spruce, boulder, fern, grass and poppy are what draw instead.
 *
 * Two sources, and the measured reason for preferring the first:
 *
 *   - **cooked** (default): `public/` from the owner's Wildwood sandbox, which is where the
 *     ThreeNative asset pipeline already cooked this listing. Landscape Pro ships as Unreal
 *     `.uasset` source, 4.9–9.4 MB per mesh because every model embeds the whole shared material
 *     library; the cook drops that to a 5–215 KB mesh plus content-addressed UASTC images in
 *     `shared/images/`, meshopt-compressed with `KHR_mesh_quantization`. Same geometry, ~60x the
 *     bytes, and the loader here already speaks every extension it uses.
 *   - **--raw**: the uncooked `assets/fab/<listing>/Models/*.glb` import, self-contained with its
 *     textures embedded. It draws identically and costs 200 MB of downloads instead of 14.
 *
 * The copy is deliberately dumb — copy the file, copy the images its own JSON chunk names, write
 * nothing else — so the folder it produces is exactly what the game loads, with no intermediate
 * representation to keep in step.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../local-assets/landscape-pro", import.meta.url));
/** The listing, and where the owner's sandbox keeps the two trees of the same import. */
const LISTING = "1ac647da-b1bc-4e72-a56d-60aaeb6918e1";
const SANDBOX = process.env.LANDSCAPE_PRO ?? "/home/joao/projects/threenative/sandbox/wildwood";
const MODELS = `fab/${LISTING}/Models`;

/**
 * The species this world draws, in the order `src/render/pack.ts` asks for them.
 *
 * Chosen for the triangle budget and the silhouette, not for completeness: the pack holds
 * 52 meshes and this is the seven the Temperate world actually grows. `SM_pine01` and
 * `SM_pine03` are the canopy (12.5k and 9.3k triangles, 10.0 m and 9.5 m as they ship),
 * `SM_pine-small01` is the young generation at 530 triangles, `SM_bush01` the shrub the wood
 * edges grow, `SM_grass_bush01`/`03` the ground cover over the grass, and the two rocks plus
 * `SM_RockGroup01` are the stone. `SM_pine02/04/05` are 12–20k triangles each and the forest
 * reads the same with or without them; add a row here and one in `pack.ts` when a capture says
 * the wood is too uniform.
 */
const SPECIES = [
  "SM_pine01",
  "SM_pine03",
  "SM_pine-small01",
  "SM_bush01",
  "SM_grass_bush01_lod00",
  "SM_grass_bush03_lod00",
  "SM_rock01_lod000",
  "SM_rock04_lod000",
  "SM_RockGroup01",
];

/** The images a model names, read out of its own glTF JSON chunk rather than a manifest. */
function imagesOf(glb) {
  const data = readFileSync(glb);
  const length = data.readUInt32LE(8);
  let offset = 12;
  while (offset < length) {
    const chunkLength = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    if (type === 0x4e4f534a) {
      const json = JSON.parse(data.toString("utf8", offset + 8, offset + 8 + chunkLength));
      return [...new Set((json.images ?? []).map((image) => image.uri).filter(Boolean))];
    }
    offset += 8 + chunkLength;
  }
  return [];
}

const raw = process.argv.includes("--raw");
const source = raw ? join(SANDBOX, "assets") : join(SANDBOX, "public");

/**
 * Where one logical asset path actually is in this tree.
 *
 * A cooked tree writes content-addressed names (`SM_pine01.b946c627.glb`) and describes them in
 * `assets.manifest.json`; a raw tree keeps the logical name. Read the manifest when it is there
 * and fall through to the logical name when it is not, so the same script serves both.
 */
function locate(logical) {
  const manifest = join(source, "assets.manifest.json");
  if (existsSync(manifest)) {
    const entry = JSON.parse(readFileSync(manifest, "utf8")).entries?.[logical];
    if (entry !== undefined) return join(source, entry.output);
  }
  return join(source, logical);
}

mkdirSync(join(OUT, MODELS), { recursive: true });
mkdirSync(join(OUT, "shared/images"), { recursive: true });

// Counted once per written file: several species share one content-addressed image, and a total
// that counted it twice would overstate what the download costs.
const written = new Set();
const bytes = () => [...written].reduce((sum, file) => sum + statSync(file).size, 0);
const report = [];
for (const name of SPECIES) {
  const from = locate(`${MODELS}/${name}.glb`);
  if (!existsSync(from)) {
    console.error(
      [
        `[prep] missing ${from}`,
        `[prep] download the pack (fabcli download ${LISTING} --engine UE_4.27 --platform Windows)`,
        "[prep] and import it with tools/import-landscape-pro.mjs in the Wildwood sandbox, or point",
        "[prep] LANDSCAPE_PRO at a tree that already has it.",
      ].join("\n"),
    );
    process.exit(1);
  }
  const to = join(OUT, `${MODELS}/${name}.glb`);
  copyFileSync(from, to);
  written.add(to);
  // A cooked model points at `../../../shared/images/…` relative to itself, which resolves to
  // `<mount>/shared/images/…` — the layout the dev server's second static root reproduces.
  const images = imagesOf(from);
  for (const uri of images) {
    const image = locate(`${MODELS}/${uri}`);
    const target = join(OUT, `shared/images/${image.slice(image.lastIndexOf("/") + 1)}`);
    copyFileSync(image, target);
    written.add(target);
    mkdirSync(dirname(target), { recursive: true });
  }
  report.push(`${name} ${(statSync(to).size / 1024).toFixed(0)}KB/${String(images.length)}img`);
}

// The Basis transcoder, copied from this project's own three.js rather than from the pack: a
// cooked KTX2 model needs it at `<basePath>basis/` to decode at runtime, the engine's asset
// pipeline is what normally puts it there, and this example has no asset pipeline. It is three's own
// Apache-2.0 file, not pack bytes, and it lands in the same gitignored folder.
const transcoder = createRequire(import.meta.url).resolve(
  "three/examples/jsm/libs/basis/basis_transcoder.js",
);
mkdirSync(join(OUT, "basis"), { recursive: true });
for (const file of ["basis_transcoder.js", "basis_transcoder.wasm"]) {
  const from = join(transcoder, "..", file);
  if (!existsSync(from)) {
    console.error(`[prep] three's Basis transcoder is missing at ${from}`);
    process.exit(1);
  }
  copyFileSync(from, join(OUT, `basis/${file}`));
}

console.log(`[prep] ${raw ? "raw" : "cooked"} -> ${OUT}`);
console.log(`[prep] ${report.join(" ")}`);
console.log(
  `[prep] ${SPECIES.length} species, ${String(written.size)} files, ` +
    `${(bytes() / 1048576).toFixed(1)} MiB, nothing committed`,
);
