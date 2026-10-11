// Bakes this folder's recipe into a self-contained world package. Run it once from your game
// project, then serve the folder it writes:
//   node src/terrain/tundra/bake.mjs [--assets <dir>] [--out <dir>]
// The engine's `WorldCells` streams `world/world.json` and `loadTerrainSplat` textures its ground;
// the game never evaluates terrain at runtime.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Terrain, applyPlacementOverrides, bakeWorldPackage } from "@threenative/terrain";

const here = dirname(fileURLToPath(import.meta.url));

/** `--key value` after the script; `--assets` and `--out` default as noted below. */
function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : resolve(process.argv[at + 1] ?? "");
}

// The installed kit ships its models and textures beside the package manifest, so a copied kit
// finds them without asking the game for a path. `--assets` overrides that for a local checkout.
const installed = dirname(fileURLToPath(import.meta.resolve("@threenative/terrain/package.json")));
const assetsDir = flag("assets", join(installed, "starter-assets"));
const outDir = flag("out", join(here, "world"));

const recipe = JSON.parse(await readFile(join(here, "recipe.json"), "utf8"));
const assetTable = JSON.parse(await readFile(join(here, "assets.json"), "utf8"));
const surface = JSON.parse(await readFile(join(here, "surface.json"), "utf8"));

const state = applyPlacementOverrides(
  Terrain.fromJSON(recipe.recipe).evaluate(),
  recipe.placementOverrides ?? {},
);

const assets = Object.fromEntries(
  Object.entries(assetTable).map(([id, spec]) => [
    id,
    {
      bounds: spec.bounds,
      glb: `models/${spec.near.split("/").at(-1)}`,
      ...(spec.mid
        ? { lods: [{ distance: spec.midDistance, glb: `models/${spec.mid.split("/").at(-1)}` }] }
        : {}),
      maxDistance: spec.maxDistance,
    },
  ]),
);

const started = performance.now();
const { manifest, splat, files } = bakeWorldPackage(state, {
  assets,
  layers: { table: "terrain-table.json" },
});
const written = new Map();

async function write(relative, bytes) {
  await mkdir(join(outDir, dirname(relative)), { recursive: true });
  await writeFile(join(outDir, relative), bytes);
  written.set(relative, bytes.length ?? bytes.byteLength);
}

async function copy(from, to) {
  await mkdir(join(outDir, dirname(to)), { recursive: true });
  await copyFile(join(assetsDir, from), join(outDir, to));
  written.set(to, (await readFile(join(outDir, to))).byteLength);
}

await write("world.json", `${JSON.stringify(manifest, null, 2)}\n`);
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
for (const [name, bytes] of Object.entries(files)) await write(name, bytes);
for (const spec of Object.values(assetTable)) {
  await copy(spec.near, `models/${spec.near.split("/").at(-1)}`);
  if (spec.mid) await copy(spec.mid, `models/${spec.mid.split("/").at(-1)}`);
}
// The sky the props are lit by (CC0 Poly Haven Kloofendal); world.ts gives it to their materials.
await copy("hdri/kloofendal_48d_partly_cloudy_1k.hdr", "sky.hdr");
for (const layer of [surface.base, ...surface.layers]) {
  const source = surface.sources[layer.id];
  await copy(source.diff, `${surface.textures}/${layer.id}_diff.jpg`);
  await copy(source.nrm, `${surface.textures}/${layer.id}_nrm.jpg`);
}
// `sources` is the bake's own lookup: the runtime reads only base/layers/splat/textures.
await write(
  "terrain-table.json",
  `${JSON.stringify({ ...surface, splat, textures: "textures" }, null, 2)}\n`,
);

const perAsset = {};
for (const cell of manifest.cells)
  for (const run of cell.runs) perAsset[run.asset] = (perAsset[run.asset] ?? 0) + run.count;
const total = [...written.values()].reduce((sum, bytes) => sum + bytes, 0);
console.log(
  `${Object.entries(perAsset)
    .map(([asset, count]) => `${asset} ${String(count)}`)
    .join(", ")} placements; ${[...written]
    .map(([name, bytes]) => `${name} ${String(bytes)} B`)
    .join(", ")}; ${String(total)} B total; ${Math.round(performance.now() - started)} ms`,
);
