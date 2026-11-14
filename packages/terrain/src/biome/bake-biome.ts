import { Heightfield } from "@threenative/core/world";
import type { IScatterRule, ITerrainState } from "../core/types.js";
import {
  type IBakeWorldPackageOptions,
  type IBakedWorldPackage,
  type IWorldPackageAsset,
  bakeWorldPackage,
} from "../package/world-package.js";
import {
  type IOrderedScatter,
  type IOrderedScatterField,
  orderedScatterRules,
  scatterProps,
} from "../population/scatter-ordered.js";
import { type IMeasuredBands, measureBands } from "./bands.js";
import { type IBiomeSpec, type IFoliageType, validateBiome } from "./biome.js";

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
  /**
   * Every asset an instance may reference, `glb`, bounds and its levels. An unknown one fails.
   * Absent, the bake writes no package and hands the instances back: a game that keeps its own
   * container for now reads `scatter` instead of a streamed package.
   */
  readonly assets?: Readonly<Record<string, IWorldPackageAsset>>;
  /** How the rows place. Defaults to the biome file's own `stream`. */
  readonly stream?: "ordered" | "seeded";
}

/**
 * A biome's foliage rows as the scatter rules `Terrain.evaluate()` runs, so a preset's ground — which
 * authors no rule of its own — grows the stand its biome file describes.
 *
 * Each field lands on the stage that reads it: `density` is `surfaceSample`'s count, `slope` and the
 * `height` band are `densityFilter`, `spacing[0]` is `selfPrune`'s distance, and `species` is
 * `meshSpawn`'s asset. The row's height band is measured above the world's floor, so `heights` is
 * that world's own field: the rules this returns read metres, and `finalizeState` places them.
 * @situation place a biome file's trees on a landform preset, which carries no scatter rule
 * @constraint `species` must name an asset the cook has art for; the caller filters the rest
 * @example const rules = foliageScatterRules(spec.foliage, state.height);
 */
export function foliageScatterRules(
  foliage: readonly IFoliageType[],
  heights: ArrayLike<number>,
): IScatterRule[] {
  // The floor the rows measure above, taken the way `measureBands` takes the height range.
  const [floor] = measureBands([], heights).elevationRange;
  return foliage.map((row) => ({
    id: `foliage:${row.species}`,
    asset: row.species,
    count: row.density,
    minSlope: row.slope[0],
    maxSlope: row.slope[1],
    minDistance: row.spacing[0],
    ...(row.height === null
      ? {}
      : { minHeight: floor + row.height[0], maxHeight: floor + row.height[1] }),
    avoidWater: true,
    opacity: 1,
    clear: [],
  }));
}

export interface IBakedBiome {
  /** The streamed package, or null when the call named no assets to write one. */
  readonly package: IBakedWorldPackage | null;
  /** The biome's band rows resolved against this state's own height range. */
  readonly bands: IMeasuredBands;
  /** Placements the bake made, one row per asset. */
  readonly placements: readonly { readonly asset: string; readonly count: number }[];
  /** The ordered stream's instances, in draw order; null when the rows ran on their own seeds. */
  readonly scatter: IOrderedScatter | null;
}

/**
 * The biome's far-impostor distance, carried into each species' asset record.
 *
 * `far.impostor` was validated and then read by nothing: a game stating it got no impostor distance
 * in `world.json`, so the engine's whole-asset impostor never engaged. A caller that names its own
 * `impostorDistance` keeps it — this fills the gap, it does not override a choice.
 */
export function withImpostorDistances(
  assets: Readonly<Record<string, IWorldPackageAsset>> | undefined,
  spec: IBiomeSpec,
): Readonly<Record<string, IWorldPackageAsset>> | undefined {
  if (assets === undefined) return undefined;
  const distances = new Map<string, number>();
  for (const foliage of spec.foliage) {
    const distance = foliage.far?.impostor;
    if (distance === undefined) continue;
    // The contract refuses a value that is not positive, and one that is not beyond every LOD's own
    // distance — checked here so a biome states its mistake at bake time, not at load.
    if (!Number.isFinite(distance) || distance <= 0)
      throw new Error(
        `${spec.look}: ${foliage.species}.far.impostor must be a positive distance, got ${String(distance)}.`,
      );
    distances.set(foliage.species, distance);
  }
  if (distances.size === 0) return assets;
  const filled: Record<string, IWorldPackageAsset> = {};
  for (const [species, asset] of Object.entries(assets)) {
    const distance = distances.get(species);
    if (distance === undefined || asset.impostorDistance !== undefined) {
      filled[species] = asset;
      continue;
    }
    const gate = asset.lods?.reduce((furthest, lod) => Math.max(furthest, lod.distance), 0) ?? 0;
    if (distance <= gate)
      throw new Error(
        `${species}: impostorDistance (${String(distance)}) must follow every authored LOD gate (furthest ${String(gate)}), or the impostor replaces a level that still draws.`,
      );
    filled[species] = { ...asset, impostorDistance: distance };
  }
  return filled;
}

/**
 * Bake one biome: the recipe's evaluated state and the world package it streams.
 *
 * This is the composition `terrain_generate` and a game's build script both call, so the file layout
 * a player streams is decided in one place. The biome is validated first — an inline spec from a
 * request is checked here, not trusted — and the package's own placement runs are checked against
 * the state they came from, so a bake can never ship a cell list that lost instances.
 * @requires npm i -D @threenative/terrain
 * An agent does not write this call to get a world: the `threenative-terrain` MCP tool
 * `terrain_generate` takes the request in words ("a pine forest under snowy mountains with a river",
 * "a volcanic island", or `ground: { location }` for a real place) and cooks the world.glb,
 * recipe.json and world.json a game loads with `ctx.assets.model`.
 * @situation bake one biome's world package from an evaluated recipe and a biome file
 * @situation generate terrain with mountains, hills, a river, a lake or an island from a request in words
 * @situation generate a landscape or open world map for a game
 * @situation procedural terrain for a level: a volcanic island, a mountain valley or a coast
 * @situation make a canyon, a volcano, a fjord, a desert, a tundra or a forest world
 * @situation cook the real terrain of a place on Earth from its latitude and longitude
 * @constraint every instance's asset must be in `assets`; every instance must land in exactly one cell run
 * @example const baked = bakeBiome({ state: terrain.evaluate(), spec: validateBiome(json, "savanna"), assets });
 */
export function bakeBiome(options: IBakeBiomeOptions): IBakedBiome {
  const spec = validateBiome(options.spec, options.spec.look);
  // An ordered biome runs its fifteen generators on one stream, so this bake owns the instances
  // instead of reading the ones the recipe's own rules accepted.
  const scatter =
    (options.stream ?? spec.stream) === "ordered"
      ? scatterProps(
          orderedField(options.state, spec),
          { x: spec.spawn.focus[0], z: spec.spawn.focus[1] },
          spec.cover.clearings,
        )
      : null;
  const state: ITerrainState =
    scatter === null ? options.state : { ...options.state, instances: scatter.placements };
  const assets = withImpostorDistances(options.assets, spec);
  const baked =
    assets === undefined
      ? null
      : bakeWorldPackage(state, {
          assets,
          ...(options.cellSize === undefined ? {} : { cellSize: options.cellSize }),
          ...(options.layers === undefined ? {} : { layers: options.layers }),
          ...(options.names === undefined ? {} : { names: options.names }),
        });
  const counts = new Map<string, number>();
  if (baked !== null) {
    let placed = 0;
    for (const cell of baked.manifest.cells)
      for (const run of cell.runs) {
        placed += run.count;
        counts.set(run.asset, (counts.get(run.asset) ?? 0) + run.count);
      }
    if (placed !== state.instances.length)
      throw new Error(
        `${spec.look}: the package carries ${String(placed)} placements for ${String(state.instances.length)} instances.`,
      );
  } else if (scatter !== null) {
    for (const [asset, count] of Object.entries(scatter.counts)) counts.set(asset, count);
  }
  return {
    package: baked,
    bands: measureBands(spec.layers, options.state.height),
    placements: [...counts.entries()].map(([asset, count]) => ({ asset, count })),
    scatter,
  };
}

/**
 * The ground an ordered biome's generators read: the state's own field and water, and the rows.
 *
 * The heightfield is the state's samples on their own lattice, built here so a bake needs no game
 * object: `heightAt` and `normalAt` are core's, the same ones the game samples its ground with, so a
 * rule that probes a slope a metre out reads the same value on both sides.
 */
function orderedField(state: ITerrainState, spec: IBiomeSpec): IOrderedScatterField {
  return {
    erosion: state.erosion,
    field: new Heightfield({
      rows: state.resolution,
      columns: state.resolution,
      width: state.size,
      depth: state.size,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(state.height),
    }),
    resolution: state.resolution,
    size: state.size,
    waterLevel: state.waters.find((water) => water.kind === "ocean")?.level ?? null,
    rules: orderedScatterRules(spec),
    spec,
    rivers: state.rivers,
    lakes: state.waters.flatMap((water) =>
      water.kind === "lake" && water.at !== undefined && water.radius !== undefined
        ? [{ at: water.at, radius: water.radius, level: water.level ?? 0 }]
        : [],
    ),
  };
}
