// Stages the five authored inputs of each starter terrain kit, with credits for what the kit cites.
// It reads packages/terrain/starter and starter-assets. It writes template-assets/terrain.
// It plans every kit before it writes. A missing credit stops the run before any file changes.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { starterAssetsDir } from "../../terrain/dist/kit.js";

const KITS = ["alpine", "coastal", "desert", "forest", "tundra"];
const INPUTS = ["assets.json", "bake.mjs", "heightmap.r16", "recipe.json", "surface.json"];
// Each bakeKit call supplies the sky HDRI copied to sky.hdr.
const SKY_SOURCE = /^\s*sky: "(hdri\/[^"]+\.hdr)",$/gmu;
// The sky record names no set. These fields hold its own provenance.
const SKY_FIELDS = ["asset", "author", "bytes", "license", "sha256", "url"];
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const terrainRoot = path.resolve(packageRoot, "..", "terrain");

// Every string inside a parsed JSON value.
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}

function missingRecord(kit, what, ref) {
  return new Error(
    `TN_TERRAIN_STAGE_METADATA: ${kit} cites ${what} ${ref}. starter-assets/credits.json has no record for it.`,
  );
}

// Reads the one sky HDRI that a bake copies. Its record must carry its own provenance.
async function skyRecord(kit, dir, credits) {
  const bake = await readFile(path.join(dir, "bake.mjs"), "utf8");
  const found = [...bake.matchAll(SKY_SOURCE)];
  if (found.length !== 1) {
    throw new Error(
      `TN_TERRAIN_STAGE_METADATA: ${kit} bake.mjs must supply one sky HDRI to bakeKit. Found ${found.length}.`,
    );
  }
  const file = found[0][1];
  const record = credits.files.find((entry) => entry.file === file);
  if (!record) throw missingRecord(kit, "sky HDRI", file);
  for (const field of SKY_FIELDS) {
    if (!record[field]) {
      throw new Error(
        `TN_TERRAIN_STAGE_METADATA: ${kit} sky HDRI ${file} has no ${field}. starter-assets/credits.json must set it.`,
      );
    }
  }
  return record;
}

// Selects the credit records one kit cites. It writes nothing.
async function planKit(kit, credits) {
  const dir = path.join(terrainRoot, "starter", kit);
  const surface = JSON.parse(await readFile(path.join(dir, "surface.json"), "utf8"));
  const assets = JSON.parse(await readFile(path.join(dir, "assets.json"), "utf8"));

  const files = new Map();
  for (const ref of strings(surface.sources)) {
    const record = credits.files.find((entry) => entry.file === ref);
    if (!record) throw missingRecord(kit, "texture", ref);
    files.set(record.file, record);
  }

  const sets = {};
  for (const { set } of files.values()) {
    if (!Object.hasOwn(credits.sets, set)) throw missingRecord(kit, "set", set);
    sets[set] = credits.sets[set];
  }

  // The sky record names no set, so it joins the files after the set lookup.
  const sky = await skyRecord(kit, dir, credits);
  files.set(sky.file, sky);

  // A prop folder matches a prepared asset by its URL slug, such as fir_tree_01.
  const preparedAssets = new Set();
  for (const ref of strings(assets)) {
    const slug = ref.split("/")[0];
    const matches = credits.prepared.assets.filter((asset) => asset.url.split("/").pop() === slug);
    if (matches.length === 0) throw missingRecord(kit, "prop", ref);
    for (const match of matches) preparedAssets.add(match);
  }

  return {
    kit,
    credit: {
      version: credits.version,
      kit,
      purpose:
        "Credits for the sets, textures, props and sky this kit cites. Each record is copied from starter-assets/credits.json.",
      source: credits.source,
      sourceUrl: credits.sourceUrl,
      license: credits.license,
      licenseUrl: credits.licenseUrl,
      sets,
      files: [...files.values()],
      prepared: { assets: [...preparedAssets] },
    },
  };
}

async function writeKit(kit, credit) {
  const out = path.join(packageRoot, "template-assets", "terrain", kit);
  await mkdir(out, { recursive: true });
  for (const file of INPUTS) {
    await copyFile(path.join(terrainRoot, "starter", kit, file), path.join(out, file));
  }
  await writeFile(path.join(out, "credits.json"), `${JSON.stringify(credit, null, 2)}\n`);
}

const credits = JSON.parse(
  await readFile(path.join(await starterAssetsDir(), "credits.json"), "utf8"),
);
const plans = [];
for (const kit of KITS) plans.push(await planKit(kit, credits));
for (const { kit, credit } of plans) await writeKit(kit, credit);
