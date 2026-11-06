// Offline kit authoring; recipes, assets and sky choices remain in the copied game source.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { starterAssetsDir } from "./kit-assets.js";
export { starterAssetsDir } from "./kit-assets.js";
import type { ITerrainState } from "./core/types.js";
import type { IWorldPackageAsset, IWorldPackageManifest } from "./core/world-package.js";
import {
  TerrainEvaluator,
  applyPlacementOverrides,
  bakeWorldPackage,
  decodeRAW16,
} from "./index.js";

type KitAsset = {
  readonly near: string;
  readonly bounds: IWorldPackageAsset["bounds"];
  readonly maxDistance?: number;
} & (
  | { readonly mid?: undefined; readonly midDistance?: undefined }
  | { readonly mid: string; readonly midDistance: number }
);

interface IKitCookInput {
  readonly state: ITerrainState;
  readonly species: Readonly<
    Record<
      string,
      {
        glb: string;
        bounds: IWorldPackageAsset["bounds"];
        lods: { distance: number; glb: string }[];
        maxDistance?: number;
      }
    >
  >;
  readonly materials: {
    texturesDir: string;
    layers: {
      id: string;
      diff: string;
      nrm: string;
      diffMimeType: "image/jpeg";
      nrmMimeType: "image/jpeg";
    }[];
  };
  readonly out: string;
  readonly extraLayers: Readonly<Record<string, string>>;
}

export interface IBakeKitOptions {
  readonly sky: string;
  /** Supplied by the kit; terrain does not depend on the optional asset cook. */
  readonly cookTerrainWorld?: (input: IKitCookInput) => Promise<{
    manifest: IWorldPackageManifest;
    placementCounts: Readonly<Record<string, number>>;
    worldGlb: Uint8Array;
    worldPackage?: ReturnType<typeof bakeWorldPackage>;
  }>;
}

/** `--key value` after the script; `--assets` and `--out` default as noted below. */
function flag(name: string, fallback: string) {
  const at = process.argv.indexOf(`--${name}`);
  if (at === -1) return fallback;
  const value = process.argv[at + 1];
  if (value === undefined || value === "" || value.startsWith("--")) {
    throw new Error(`bake: --${name} needs a nonempty directory value`);
  }
  return resolve(value);
}

/**
 * Bake a copied kit, optionally using the caller's installed world cook.
 * @situation bake a copied terrain starter kit into its offline world package
 * @constraint Node authoring only; recipes, asset tables and sky paths stay in the game
 * @requires npm i -D @threenative/terrain
 * @example await bakeKit(import.meta.url, { sky: "hdri/game-sky.hdr" });
 */
export async function bakeKit(
  url: string,
  { sky, cookTerrainWorld }: IBakeKitOptions,
): Promise<void> {
  const here = dirname(fileURLToPath(url));
  const assetsDir = process.argv.includes("--assets")
    ? flag("assets", "")
    : await starterAssetsDir();
  const outDir = flag("out", join(here, "world"));

  const recipe = JSON.parse(await readFile(join(here, "recipe.json"), "utf8"));
  // shortcut: starter heights use a 0.1 m lattice; revise decoding if their precision changes.
  for (const layer of recipe.recipe.layers) {
    const data = layer.params?.data;
    if (data?.raw16 === undefined) continue;
    const raw = await readFile(join(here, data.raw16));
    data.values = Array.from(decodeRAW16(raw, data).values, (value) => Math.round(value * 10) / 10);
  }
  const assetTable = JSON.parse(await readFile(join(here, "assets.json"), "utf8")) as Record<
    string,
    KitAsset
  >;
  const surface = JSON.parse(await readFile(join(here, "surface.json"), "utf8"));

  const state = applyPlacementOverrides(
    new TerrainEvaluator({ cacheMB: 0 }).evaluate(recipe.recipe),
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
  const cooked = cookTerrainWorld
    ? await cookTerrainWorld({
        state,
        species: Object.fromEntries(
          Object.entries(assetTable).map(([id, spec]) => [
            id,
            {
              glb: join(assetsDir, spec.near),
              bounds: spec.bounds,
              lods: spec.mid
                ? [{ distance: spec.midDistance ?? 40, glb: join(assetsDir, spec.mid) }]
                : [],
              maxDistance: spec.maxDistance,
            },
          ]),
        ),
        materials: {
          texturesDir: assetsDir,
          layers: [surface.base, ...surface.layers].map((layer) => ({
            id: layer.id,
            ...surface.sources[layer.id],
            diffMimeType: "image/jpeg" as const,
            nrmMimeType: "image/jpeg" as const,
          })),
        },
        out: outDir,
        extraLayers: { table: "terrain-table.json" },
      })
    : undefined;
  const baked =
    cooked?.worldPackage ??
    bakeWorldPackage(state, {
      assets: cooked?.manifest.assets ?? assets,
      ...(cooked ? {} : { layers: { table: "terrain-table.json" } }),
    });
  const manifest = cooked?.manifest ?? baked.manifest;
  const { splat, files } = baked;
  const written = new Map<string, number>();

  async function write(relative: string, bytes: string | Uint8Array) {
    await mkdir(join(outDir, dirname(relative)), { recursive: true });
    await writeFile(join(outDir, relative), bytes);
    written.set(relative, bytes.length);
  }

  async function copy(from: string, to: string) {
    await mkdir(join(outDir, dirname(to)), { recursive: true });
    await copyFile(join(assetsDir, from), join(outDir, to));
    written.set(to, (await readFile(join(outDir, to))).byteLength);
  }

  if (!cooked) await write("world.json", `${JSON.stringify(manifest, null, 2)}\n`);
  // The lake and river the generator evaluated, so the game draws the water the bake shaped.
  const round = (value: number) => Math.round(value * 1_000) / 1_000;
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
  if (!cooked) {
    for (const [name, bytes] of Object.entries(files)) await write(name, bytes);
    for (const spec of Object.values(assetTable)) {
      await copy(spec.near, `models/${spec.near.split("/").at(-1)}`);
      if (spec.mid) await copy(spec.mid, `models/${spec.mid.split("/").at(-1)}`);
    }
  }
  // The sky the props are lit by (CC0 Poly Haven Kloofendal); world.ts gives it to their materials.
  await copy(sky, "sky.hdr");
  // The cook copies the layer maps itself when it runs.
  if (!cooked)
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

  if (cooked) {
    console.log(
      `${Object.entries(cooked.placementCounts)
        .map(([asset, count]) => `${asset} ${String(count)}`)
        .join(
          ", ",
        )} placements; world.glb ${String(cooked.worldGlb.length)} B; ${Math.round(performance.now() - started)} ms`,
    );
  } else {
    const perAsset: Record<string, number> = {};
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
  }
}
