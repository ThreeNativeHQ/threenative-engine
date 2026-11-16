import { foliageScatterRules } from "../biome/bake-biome.js";
import type { IBiomeSpec } from "../biome/biome.js";
import { finalizeState } from "../core/operations.js";
import type { IScatterClear, ITerrainState } from "../core/types.js";
import type { LandformKind } from "../ground/presets.js";

/** A species box in metres: min at its foot, max at its crown. */
export interface IBounds {
  min: [number, number, number];
  max: [number, number, number];
}

function isTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/** Narrows a species `bounds` field; a missing or malformed box fails the cook instead of passing through. */
export function parseBounds(value: unknown, species: string): IBounds {
  const box = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const { min, max } = box;
  if (
    !isTriple(min) ||
    !isTriple(max) ||
    min.some((entry, axis) => entry > (max[axis] as number))
  ) {
    throw new Error(
      `cook: species '${species}' bounds must be { min: [x,y,z], max: [x,y,z] } with min <= max.`,
    );
  }
  return { min, max };
}

/** One row of the starter's `assets.json`: the art a species id draws, and whether it is the kit's tree. */
export interface IAssetSpec {
  near: string;
  mid?: string;
  midDistance?: number;
  maxDistance?: number;
  bounds: unknown;
  /** The kit's own tree: the art that stands in for the species a biome's tree row names. */
  tree?: boolean;
}

export const PLAY_AREA_CLEAR_RADIUS = 4;
// The mask's soft edge is the outer 2% of its radius, where a tree still passes by chance: the
// mask is drawn that much wider, so the whole promised radius is clear (a denser forest row put a
// trunk at 22.79 m).
const PLAY_AREA_CLEAR: IScatterClear = {
  mask: { type: "circle", at: [0, 0], radius: PLAY_AREA_CLEAR_RADIUS / 0.98, falloff: 0.02 },
  opacity: 1,
};

/**
 * A biome's foliage rows as the scatter rules `Terrain.evaluate()` runs, on the ground a preset or a
 * region's stand stands on.
 *
 * A starter's own recipe already authors its stand, so its rows are placed only when the request's
 * rows replaced that stand (`replacedStand`): a region's canopy is the region's, and the kit's ferns,
 * stones and water stay the kit's.
 */
export function scatterFoliage(
  state: ITerrainState,
  biome: IBiomeSpec,
  kind: LandformKind | undefined,
  assetTable: Record<string, IAssetSpec>,
  replacedStand = false,
): ITerrainState {
  if (kind === undefined && !replacedStand) return state;
  const tree = Object.keys(assetTable).find((id) => assetTable[id]?.tree === true);
  // The file carries one tree row, as the ordered scatter reads it, and it is the row a kit's own
  // tree stands in for; a shrub row keeps its own species or draws nothing.
  const foliage = biome.foliage.flatMap((row, at) => {
    if (row.density === 0) return [];
    if (row.species in assetTable) return [row];
    return at === 0 && tree !== undefined ? [{ ...row, species: tree }] : [];
  });
  if (foliage.length === 0) return state;
  return finalizeState({
    ...state,
    scatterRules: [
      ...state.scatterRules,
      ...foliageScatterRules(foliage, state.height).map((rule) => ({
        ...rule,
        clear: [...rule.clear, PLAY_AREA_CLEAR],
      })),
    ],
  });
}
