import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cookTerrainWorld } from "@threenative/assets";
import {
  Terrain,
  applyPlacementOverrides,
  bakeWorldPackage,
  decodeRAW16,
} from "@threenative/terrain";

/** One cook request, passed as the child's only argument. The parent validates every field first. */
interface ICookRequest {
  kit: string;
  out: string;
  sizeMeters?: number;
  seed?: number;
}

interface IAssetSpec {
  near: string;
  mid?: string;
  midDistance?: number;
  maxDistance?: number;
  bounds: unknown;
}

interface ISurface {
  base: { id: string };
  layers: { id: string }[];
  sources: Record<string, { diff: string; nrm: string }>;
  textures: string;
}

const request = JSON.parse(process.argv[2] ?? "null") as ICookRequest | null;
if (request === null || request.kit !== "forest") {
  throw new Error("cook-child: request must name the forest kit.");
}
// The starter kit and its species models ship beside this file in the package source tree.
const kitDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "starter", "forest");
const assetsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "starter-assets");

// Fail closed before any evaluation: a non-recursive mkdir claims `out` atomically, so two cooks cannot share it.
await mkdir(dirname(request.out), { recursive: true });
try {
  await mkdir(request.out);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === "EEXIST") {
    throw new Error(`cook-child: out '${request.out}' already exists.`);
  }
  throw error;
}

const started = performance.now();
const recipe = JSON.parse(await readFile(join(kitDir, "recipe.json"), "utf8"));
if (request.sizeMeters !== undefined) recipe.recipe.size = request.sizeMeters;
if (request.seed !== undefined) recipe.recipe.seed = request.seed;
// shortcut: starter heights use a 0.1 m lattice; revise decoding if their precision changes.
for (const layer of recipe.recipe.layers) {
  const data = layer.params?.data;
  if (data?.raw16 === undefined) continue;
  const raw = await readFile(join(kitDir, data.raw16));
  data.values = Array.from(
    decodeRAW16(raw, data).values,
    (value: number) => Math.round(value * 10) / 10,
  );
}
const assetTable = JSON.parse(await readFile(join(kitDir, "assets.json"), "utf8")) as Record<
  string,
  IAssetSpec
>;
const surface = JSON.parse(await readFile(join(kitDir, "surface.json"), "utf8")) as ISurface;

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

const baseSource = surface.sources[surface.base.id];
if (baseSource === undefined) {
  throw new Error(`cook-child: no source for base layer '${surface.base.id}'.`);
}
const cooked = await cookTerrainWorld({
  state,
  species,
  // The cook embeds the ground's base albedo and normal in `world.glb`; only the base layer is handed over.
  materials: {
    layers: [
      {
        id: surface.base.id,
        diff: join(assetsDir, baseSource.diff),
        nrm: join(assetsDir, baseSource.nrm),
        diffMimeType: "image/jpeg",
        nrmMimeType: "image/jpeg",
      },
    ],
  },
  out: request.out,
  extraLayers: { table: "terrain-table.json" },
});

const round = (value: number) => Math.round(value * 1_000) / 1_000;
await writeFile(
  join(request.out, "water.json"),
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

const { splat } = bakeWorldPackage(state, { assets: cooked.manifest.assets });
await writeFile(
  join(request.out, "terrain-table.json"),
  `${JSON.stringify({ ...surface, splat, textures: "textures" }, null, 2)}\n`,
);
await mkdir(join(request.out, surface.textures), { recursive: true });
for (const layer of [surface.base, ...surface.layers]) {
  const source = surface.sources[layer.id];
  if (source === undefined) throw new Error(`cook-child: no source for layer '${layer.id}'.`);
  await copyFile(
    join(assetsDir, source.diff),
    join(request.out, surface.textures, `${layer.id}_diff.jpg`),
  );
  await copyFile(
    join(assetsDir, source.nrm),
    join(request.out, surface.textures, `${layer.id}_nrm.jpg`),
  );
}
await copyFile(
  join(assetsDir, "hdri", "kloofendal_48d_partly_cloudy_1k.hdr"),
  join(request.out, "sky.hdr"),
);

// The parent reads this single JSON line as the tool result.
console.log(
  JSON.stringify({
    out: request.out,
    placementCounts: cooked.placementCounts,
    worldGlbBytes: cooked.worldGlb.length,
    ms: Math.round(performance.now() - started),
  }),
);
