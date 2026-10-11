// Bakes this folder's recipe into a self-contained world package. Run it once from your game
// project, then serve the folder it writes:
//   node src/terrain/forest/bake.mjs [--assets <dir>] [--out <dir>]
// The engine's `WorldCells` streams `world/world.json` and `loadTerrainSplat` textures its ground;
// the game never evaluates terrain at runtime. The cook in `@threenative/assets` writes the
// instanced `world.glb` and the species models the manifest names.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cookTerrainWorld } from "@threenative/assets";
import {
  Terrain,
  applyPlacementOverrides,
  bakeWorldPackage,
  decodeRAW16,
} from "@threenative/terrain";

const here = dirname(fileURLToPath(import.meta.url));

/** `--key value` after the script; `--assets` and `--out` default as noted below. */
function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`bake: --${name} needs a nonempty directory value`);
  }
  return resolve(value);
}

// The installed kit ships its models and textures beside the package manifest, so a copied kit
// finds them without asking the game for a path. `--assets` overrides that for a local checkout.
const installed = dirname(fileURLToPath(import.meta.resolve("@threenative/terrain/package.json")));
const assetsDir = flag("assets", join(installed, "starter-assets"));
const outDir = flag("out", join(here, "world"));

const recipe = JSON.parse(await readFile(join(here, "recipe.json"), "utf8"));
// shortcut: starter heights use a 0.1 m lattice; revise decoding if their precision changes.
for (const layer of recipe.recipe.layers) {
  const data = layer.params?.data;
  if (data?.raw16 === undefined) continue;
  const raw = await readFile(join(here, data.raw16));
  data.values = Array.from(decodeRAW16(raw, data).values, (value) => Math.round(value * 10) / 10);
}
const assetTable = JSON.parse(await readFile(join(here, "assets.json"), "utf8"));
const surface = JSON.parse(await readFile(join(here, "surface.json"), "utf8"));

const state = applyPlacementOverrides(
  Terrain.fromJSON(recipe.recipe).evaluate(),
  recipe.placementOverrides ?? {},
);

const species = Object.fromEntries(
  Object.entries(assetTable).map(([id, spec]) => [
    id,
    {
      glb: join(assetsDir, spec.near),
      bounds: spec.bounds,
      lods: spec.mid ? [{ distance: spec.midDistance ?? 40, glb: join(assetsDir, spec.mid) }] : [],
      maxDistance: spec.maxDistance,
    },
  ]),
);

async function write(relative, bytes) {
  await mkdir(join(outDir, dirname(relative)), { recursive: true });
  await writeFile(join(outDir, relative), bytes);
}

async function copy(from, to) {
  await mkdir(join(outDir, dirname(to)), { recursive: true });
  await copyFile(join(assetsDir, from), join(outDir, to));
}

const started = performance.now();
// The cook writes `world.json`, `world.glb`, the heightmap, placements and splat, and every
// species model under `models/<species-id>.glb`, all from the real evaluated state.
const cooked = await cookTerrainWorld({
  state,
  species,
  // The cook embeds the ground's base albedo and normal in `world.glb`; the full multilayer
  // surface appearance is still to come, so only the base layer is handed over here.
  materials: {
    layers: [
      {
        id: surface.base.id,
        diff: join(assetsDir, surface.sources[surface.base.id].diff),
        nrm: join(assetsDir, surface.sources[surface.base.id].nrm),
        diffMimeType: "image/jpeg",
        nrmMimeType: "image/jpeg",
      },
    ],
  },
  out: outDir,
  extraLayers: { table: "terrain-table.json" },
});

// The lake and river the generator evaluated, so the game draws the water the bake shaped.
const round = (value) => Math.round(value * 1_000) / 1_000;
await write(
  "water.json",
  `${JSON.stringify(
    {
      lakes: state.waters.map((lake) => ({
        id: lake.id,
        at: lake.at,
        radius: lake.radius,
        level: lake.level,
      })),
      rivers: state.rivers.map((river) => ({
        id: river.id,
        width: round(river.width),
        points: river.points.map((point) => point.map(round)),
      })),
    },
    null,
    2,
  )}\n`,
);

// The cook owns the manifest and the models; only the surface table and its images are left.
// `bakeWorldPackage` is the one public source of the splat mask layout the table needs, and its
// asset map is the cooked manifest's, so no stale basename reaches the table.
const { splat } = bakeWorldPackage(state, { assets: cooked.manifest.assets });
// `sources` is the bake's own lookup: the runtime reads only base/layers/splat/textures.
await write(
  "terrain-table.json",
  `${JSON.stringify({ ...surface, splat, textures: "textures" }, null, 2)}\n`,
);
for (const layer of [surface.base, ...surface.layers]) {
  const source = surface.sources[layer.id];
  await copy(source.diff, `${surface.textures}/${layer.id}_diff.jpg`);
  await copy(source.nrm, `${surface.textures}/${layer.id}_nrm.jpg`);
}
// The sky the props are lit by (CC0 Poly Haven Kloofendal); world.ts gives it to their materials.
await copy("hdri/kloofendal_48d_partly_cloudy_1k.hdr", "sky.hdr");

console.log(
  `${Object.entries(cooked.placementCounts)
    .map(([asset, count]) => `${asset} ${String(count)}`)
    .join(
      ", ",
    )} placements; world.glb ${String(cooked.worldGlb.length)} B; ${Math.round(performance.now() - started)} ms`,
);
