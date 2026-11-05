import { type IMeasuredBands, measureBands } from "./bands.js";
import { type IBiomeSpec, validateBiome } from "./biome.js";
import type { ITerrainState } from "./types.js";
import {
  type IBakeWorldPackageOptions,
  type IBakedWorldPackage,
  type IWorldPackageAsset,
  bakeWorldPackage,
} from "./world-package.js";

/**
 * The four stages a scatter runs, named after the PCG elements that do each one
 * (`UPCGSurfaceSamplerSettings`, `UPCGDensityFilterSettings`, `UPCGSelfPruningSettings`,
 * `UPCGStaticMeshSpawnerSettings`; UE 5.8.3). In this package they are the fields of
 * `IScatterParams`, evaluated by `Terrain.evaluate()` in this order:
 *
 * - `surfaceSample` — `count`, `seed`, `offsetY`: where a candidate lands.
 * - `densityFilter` — `minSlope`/`maxSlope`, `minHeight`/`maxHeight`, `avoidWater`, `mask`: whether
 *   the ground there accepts one.
 * - `selfPrune` — `minDistance`: whether it is too close to one already accepted.
 * - `meshSpawn` — `asset`, `scale`, `alignToNormal`: what is stamped, and how.
 *
 * A bake needs no second scatter engine: this function receives the placements those stages
 * produced and turns them into the world package a game streams.
 */
export type IBakeBiomeStage = "surfaceSample" | "densityFilter" | "selfPrune" | "meshSpawn";

export const BAKE_BIOME_STAGES: readonly IBakeBiomeStage[] = [
  "surfaceSample",
  "densityFilter",
  "selfPrune",
  "meshSpawn",
];

export interface IBakeBiomeOptions extends Omit<IBakeWorldPackageOptions, "assets"> {
  /** The evaluated recipe: heights, splat and the placements the scatter stages accepted. */
  readonly state: ITerrainState;
  /** The biome the bake is for. Validated here, so an inline spec fails closed at the bake. */
  readonly spec: IBiomeSpec;
  /** Every asset an instance may reference, `glb`, bounds and its levels. An unknown one fails. */
  readonly assets: Readonly<Record<string, IWorldPackageAsset>>;
}

export interface IBakedBiome extends IBakedWorldPackage {
  /** The biome's band rows resolved against this state's own height range. */
  readonly bands: IMeasuredBands;
  /** Placements the package carries, one row per asset, in the package's own run order. */
  readonly placements: readonly { readonly asset: string; readonly count: number }[];
}

/**
 * Bake one biome: the recipe's evaluated state and the world package it streams.
 *
 * This is the composition `terrain_generate` and a game's build script both call, so the file layout
 * a player streams is decided in one place. The biome is validated first — an inline spec from a
 * request is checked here, not trusted — and the package's own placement runs are checked against
 * the state they came from, so a bake can never ship a cell list that lost instances.
 * @requires npm i -D @threenative/terrain
 * @situation bake one biome's world package from an evaluated recipe and a biome file
 * @constraint every instance's asset must be in `assets`; every instance must land in exactly one cell run
 * @example const baked = bakeBiome({ state: terrain.evaluate(), spec: validateBiome(json, "savanna"), assets });
 */
export function bakeBiome(options: IBakeBiomeOptions): IBakedBiome {
  const spec = validateBiome(options.spec, options.spec.look);
  const baked = bakeWorldPackage(options.state, {
    assets: options.assets,
    ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
    ...(options.layers === undefined ? {} : { layers: options.layers }),
    ...(options.names === undefined ? {} : { names: options.names }),
  });
  let placed = 0;
  const counts = new Map<string, number>();
  for (const cell of baked.manifest.cells)
    for (const run of cell.runs) {
      placed += run.count;
      counts.set(run.asset, (counts.get(run.asset) ?? 0) + run.count);
    }
  if (placed !== options.state.instances.length)
    throw new Error(
      `${spec.look}: the package carries ${String(placed)} placements for ${String(options.state.instances.length)} instances.`,
    );
  return {
    ...baked,
    bands: measureBands(spec.layers, options.state.height),
    placements: [...counts.entries()].map(([asset, count]) => ({ asset, count })),
  };
}
