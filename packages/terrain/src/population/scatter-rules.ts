import type { IBiomeSpec, IFoliageType, IGrassType, IUnderstoreySpec } from "../biome/biome.js";
import { type ICoverField, MATS_FIELD, STAND_FIELD } from "./cover-field.js";

/** The ordered scatter's rules: every number one biome's generators read, from its biome rows. */
/** The cover drift a biome's blades grow on, read from its grass row. */
export interface ICoverFieldDrift {
  /** The value-noise field the drift is measured on. */
  readonly field: ICoverField;
  /** Metres⁻¹ the field is sampled at, in x and z: a small frequency drifts in broad patches. */
  readonly frequency: readonly [number, number];
  /** The share of the cover that stands everywhere. */
  readonly amplitude: number;
  /** How much of the cover rides the field above that floor. */
  readonly offset: number;
  /** The field weight the drift is gone at, and the weight over which it reaches full. */
  readonly band: readonly [number, number];
}

/** The two fields a drift can name: a wood's stands, or a mat plain's mats. */
export type CoverFieldName = "stand" | "mats";

/** Every number one biome's ordered generators read: its tree row, its grass row and its cover. */
export interface IOrderedScatterRules {
  /** The species a stand is made of. */
  readonly treeAsset: "spruce" | "sapling";
  /** How many trees the rule accepts. */
  readonly treeCount: number;
  /** Metres a trunk keeps from its neighbour at a closed stand core (first) and in the open. */
  readonly treeSpacing: readonly [number, number];
  /** Whether the tree's spacing follows the stand mask, or is the same everywhere. */
  readonly treeStands: boolean;
  /** Degrees: a tree will not stand on ground steeper than this. */
  readonly treeSlopeLimit: number;
  /** Metres above the playable floor a tree stops, where the treeline is below the peaks. */
  readonly treeHeightCeiling: number | null;
  /** The ground cover's grid cell, in metres. */
  readonly grassCell: number;
  /** How much of the ground this world covers; 0 leaves the bare rock bare. */
  readonly grassDensity: number;
  /** Degrees: the meadow runs out here, over the next `grassSlopeFalloff` degrees. */
  readonly grassSlopeLimit: number;
  readonly grassSlopeFalloff: number;
  /** Metres above the waterline a plant stands at. */
  readonly grassWaterMargin: number;
  /** A beach that thins over `waterline + waterMargin`, over `width` metres; absent on dry worlds. */
  readonly grassBeach: readonly [number, number] | null;
  /** Ground height, and the metres it takes to fade, that keep a meadow off the peaks. */
  readonly grassHeight: readonly [number, number] | null;
  /** The mat field's band the cover thins on, `[threshold, span]`; null on ground without mats. */
  readonly grassMats: readonly [number, number] | null;
  /** Metres between plants in the dense detail disc around a place the player stands. */
  readonly grassDetailSpacing: number;
  /** The least meadow weight, 0..1, a tree accepts. */
  readonly treeGrassThreshold: number;
  /** The least stand-field weight, 0..1, a tree accepts. */
  readonly treeStandThreshold: number;
  /** The ground the row was graded on: which of the four cover models the generators run. */
  readonly ground: "wood" | "crag" | "mesa" | "mats";
  /** The seed the one ordered stream starts from. */
  readonly seed: number;
  /** The most candidates a stand's loop draws before it settles for what it has. */
  readonly attempts: number;
  /** The cover drift a blade grows on: the field, its sampling and the band it fades over. */
  readonly drift: ICoverFieldDrift;
  /** A blade's scale where the ground is dry, and the share of it the draw adds. */
  readonly bladeScale: number;
  readonly bladeJitter: number;
  /** The chance a grass cell also grows a scrub, and the scrub's own scale band. */
  readonly scrubChance: number;
  readonly scrubScale: number;
  readonly scrubJitter: number;
  /** Whether a grass cell also grows the odd bush. */
  readonly scrubBush: boolean;
  /** Whether blades grow tall on the wet sand of a shore. */
  readonly shoreGround: boolean;
  /** Whether the rivers' beds and banks are dressed with cobbles. */
  readonly cobbledBed: boolean;
  /** Radius at the widest point of the game's biggest stone, which normalizes a cobble's scale. */
  readonly stoneRadius: number;
  /** The layer under a closed wood's canopy: how many candidates, and a multiplier per placement. */
  readonly understorey: IUnderstoreySpec;
}

/**
 * A biome's rows as the ordered generators read them.
 *
 * The rule is short and shared; only these numbers differ between a wood, a barren shoulder, a dune
 * field and a tundra, so the biome file names them rather than the code. A biome whose tree is not
 * one this generator has art for fails here, naming the species, rather than planting nothing.
 * @requires npm i -D @threenative/terrain
 * @situation run a biome file's rows through the ordered scatter
 * @constraint the file carries one foliage row, one grass row and a cover block
 * @example const rules = orderedScatterRules(spec);
 */
export function orderedScatterRules(spec: IBiomeSpec): IOrderedScatterRules {
  const tree = spec.foliage[0] as IFoliageType | undefined;
  const grass = spec.grass[0] as IGrassType | undefined;
  if (tree === undefined || grass === undefined)
    throw new RangeError(`${spec.look}: an ordered biome needs one tree and one ground cover`);
  if (spec.cover === null)
    throw new RangeError(`${spec.look}: an ordered biome needs its cover block`);
  if (tree.species !== "spruce" && tree.species !== "sapling")
    throw new RangeError(`${spec.look}: no ordered rule for the tree '${tree.species}'`);
  const { cover } = spec;
  const drift = grass.drift;
  if (drift === null) throw new RangeError(`${spec.look}: an ordered biome needs its cover drift`);
  return {
    ground: cover.ground,
    seed: cover.seed,
    attempts: cover.attempts,
    drift: {
      field: drift.field === "mats" ? MATS_FIELD : STAND_FIELD,
      frequency: drift.frequency,
      amplitude: drift.amplitude,
      offset: drift.offset,
      band: drift.band,
    },
    bladeScale: grass.bladeScale,
    bladeJitter: grass.bladeJitter,
    scrubChance: grass.scrubChance,
    scrubScale: grass.scrubScale,
    scrubJitter: grass.scrubJitter,
    scrubBush: grass.scrubBush,
    shoreGround: grass.shoreGround,
    cobbledBed: grass.cobbledBed,
    stoneRadius: cover.stoneRadius,
    understorey: cover.understorey,
    treeAsset: tree.species,
    treeCount: tree.density,
    treeSpacing: tree.spacing,
    treeStands: tree.stands,
    treeSlopeLimit: tree.slope[1],
    treeHeightCeiling: tree.height === null ? null : tree.height[1],
    treeGrassThreshold: tree.grassThreshold,
    treeStandThreshold: tree.standThreshold,
    grassCell: grass.spacing,
    grassDensity: grass.density,
    grassSlopeLimit: grass.slope[1],
    grassSlopeFalloff: grass.slopeFalloff,
    grassWaterMargin: grass.waterMargin,
    grassBeach: grass.beach,
    grassHeight: grass.height === null ? null : [grass.height[1], grass.heightFalloff],
    grassMats: grass.mats,
    grassDetailSpacing: grass.detailSpacing,
  };
}
