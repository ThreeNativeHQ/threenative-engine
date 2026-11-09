import { createRandom } from "@threenative/core";
import type { Heightfield } from "@threenative/core/world";
import { ImprovedNoise } from "three/addons/math/ImprovedNoise.js";
import type { IBiomeSpec, IFoliageType, IGrassType, IUnderstoreySpec } from "./biome.js";
import { type ICoverField, MATS_FIELD, STAND_FIELD, fieldWeight } from "./cover-field.js";
import { slopeQuantile } from "./math.js";
import type { IErosionMaps, IPlacement } from "./types.js";
import { createSegmentIndex } from "./water.js";

/**
 * The ordered scatter: one stream of draws, in one fixed order, for a biome whose rules are code.
 *
 * A biome that says `"stream": "ordered"` does not place one rule at a time from a seed per rule. It
 * runs fifteen generators — a stand loop, an understorey, clumped ground cover, three grids, a tide
 * line, a river walk, a detail disc and a cobbled bed — and draws every candidate from one
 * `createRandom` stream in that order. The order IS the rule: change one draw and every later
 * placement moves. So this file is the generator, copied line for line from the game that graded it
 * (Strata's `examples/strata-terrain-preview/src/render/scatter.ts` at `5afb42b1c`), and its look and
 * tuning numbers are read from the biome's rows instead of from the game's look.
 *
 * What stays in code is the algorithm's own structure: the cell of the spacing grid, the understorey
 * loop's count, the candidate budget of each grid, the detail disc's two radii. A number here is the
 * shape of the rule, not the look of a biome; a number in a row is the look.
 *
 * The four stages the PRD names are these generators' four jobs, in order: `surfaceSample` draws a
 * candidate, `densityFilter` refuses it on slope, water, height, meadow weight and the stand field,
 * `selfPrune` keeps its spacing against the accepted ones, and `meshSpawn` stamps the asset with its
 * yaw, scale and normal.
 */

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

/** A field the placement rule reads: the world's baked transport and sampled geometry. */
export interface IOrderedScatterField {
  readonly erosion?: IErosionMaps;
  readonly field: Heightfield;
  readonly resolution: number;
  readonly size: number;
  readonly waterLevel: number | null;
  /** The rows the generators run, resolved from the biome file. */
  readonly rules: IOrderedScatterRules;
  /** The biome file itself: the water bodies its rivers are read from. */
  readonly spec: IBiomeSpec;
  /** Still water: nothing grows below a lake's level inside its reach. */
  readonly rivers?: readonly {
    readonly points: readonly (readonly number[])[];
    readonly width: number;
  }[];
  readonly lakes?: readonly {
    readonly at: readonly number[];
    readonly radius: number;
    readonly level: number;
  }[];
}

/** Every placement, for one world, from one ordered stream. */
export interface IOrderedScatter {
  readonly placements: IPlacement[];
  /** How many of each prop was accepted, for the report and the playtest's own state. */
  readonly counts: Record<string, number>;
}

const tundraCover = (x: number, z: number): number => fieldWeight(MATS_FIELD, x, z);

/**
 * What the ground is where a prop wants to stand.
 *
 * `grass` is how much of that sample is meadow, in 0..1. The bake painted its own palette into the
 * vertex colours, and the same signal the ground material uses to blend its layers is the signal
 * here: green over red is grass, red over green is the road, the dirt patch and the beach.
 */
export function grassWeight(data: IOrderedScatterField, x: number, z: number): number {
  // terrain.ts now blends by actual landform, not the bake's old brown palette.
  // Match its meadow/rock/alpine and beach reaches so a green surface grows real cover.
  const rules = data.rules;
  const height = clampedHeight(data, x, z);
  if (rules.grassBeach && data.waterLevel !== null)
    return (
      clamp01((height - data.waterLevel - rules.grassBeach[0]) / rules.grassBeach[1]) *
      clamp01((rules.grassSlopeLimit - slopeDegrees(data, x, z)) / rules.grassSlopeFalloff)
    );
  if (data.waterLevel !== null && height < data.waterLevel + rules.grassWaterMargin) return 0;
  const slope = slopeDegrees(data, x, z);
  if (rules.grassDensity === 0) return 0; // This 3690 m glacial shoulder is above the treeline.
  const meadow = clamp01((rules.grassSlopeLimit - slope) / rules.grassSlopeFalloff);
  // One rule, three numbers: the density the biome covers, the height band a meadow fades out at,
  // and the mat field it thins on. A dune field's density runs 0.32, a mat plain's field runs the
  // cover out below 0.47, a wood's meadow fades out 66 m up. A sixth biome sets the numbers.
  const fade =
    rules.grassHeight === null
      ? 1
      : clamp01((rules.grassHeight[0] - height) / rules.grassHeight[1]);
  const mats =
    rules.grassMats === null
      ? 1
      : clamp01((forestWeight(x * 9.8, z * 8.7) - rules.grassMats[0]) / rules.grassMats[1]);
  return meadow * rules.grassDensity * fade * mats;
}

/** A value clamped to 0..1, because a density is a probability and a probability above one is a bug. */
/**
 * The transport the erosion passes measured at one vertex, as a share: hydraulic deposit and received
 * talus, damped by the sediment still in the water. A stone's ground is where this is high.
 */
function depositAtIndex(data: Pick<IOrderedScatterField, "erosion">, vertex: number): number {
  const sediment = data.erosion?.sediment[vertex] ?? 0;
  const hydraulic = (data.erosion?.deposition[vertex] ?? 0) / (1 + Math.sqrt(sediment));
  return Math.min(1, hydraulic * 0.25 + (data.erosion?.talus[vertex] ?? 0) * 0.3);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** The world's edge, clamped: a slope probe a metre outside the field is a probe of nothing. */
function clampedHeight(data: IOrderedScatterField, x: number, z: number): number {
  const limit = data.size / 2 - 0.001;
  return data.field.heightAt(
    Math.min(limit, Math.max(-limit, x)),
    Math.min(limit, Math.max(-limit, z)),
  );
}

/** Slope at a sample, in degrees. A spruce will not stand on a cliff; grass will not either. */
export function slopeDegrees(data: IOrderedScatterField, x: number, z: number): number {
  const step = data.size / (data.resolution - 1);
  const dx = clampedHeight(data, x + step, z) - clampedHeight(data, x - step, z);
  const dz = clampedHeight(data, x, z + step) - clampedHeight(data, x, z - step);
  return (Math.atan(Math.hypot(dx, dz) / (2 * step)) * 180) / Math.PI;
}

/**
 * Stand density, 0..1, as value noise rather than a sum of sines.
 *
 * The old mask was `0.52 + 0.27·sin(0.035x + 0.018z) + …`: three plane waves, which is a stripe
 * generator. A threshold through it puts the trees on diagonals at one spacing and one height, and
 * that regularity — not the tree model — is what read as "Tree Tree Tree" from the air. Two octaves
 * of value noise give stands with lobed, irregular edges instead.
 */
export function forestWeight(x: number, z: number): number {
  return fieldWeight(STAND_FIELD, x, z);
}

const fieldNoise = new ImprovedNoise();
const sample01 = (x: number, y: number, z: number): number =>
  clamp01(fieldNoise.noise(x, y, z) * 0.5 + 0.5);

/**
 * How thickly the ground cover stands at (x, z), on the drift the biome's look names: one curve, a
 * floor plus an amplitude over that field's own weight band.
 *
 * The looks differ in the numbers and nothing else: a wood keeps 65% of its cover everywhere and
 * drifts the rest with its stands, a dune field falls to 8% between the washes, a crest reads a
 * coarser stand field, and a mat plain reads the mats. A sixth look tunes them without a branch.
 */
export function coverDriftWeight(drift: ICoverFieldDrift, x: number, z: number): number {
  const [frequencyX, frequencyZ] = drift.frequency;
  const [threshold, span] = drift.band;
  const weight = fieldWeight(drift.field, x * frequencyX, z * frequencyZ);
  return drift.offset + drift.amplitude * clamp01((weight - threshold) / span);
}

/** The understorey the starter woods were graded on: the draws every later layer was placed after. */
const GRADED_UNDERSTOREY = { attempts: 14000, litter: 1, fern: 1, bush: 1, flower: 1 } as const;
const GRASS_FULL = 22;
const GRASS_THIN = 62;

/**
 * Every placement, for one world, from one seed: the game's own rule set, in its own draw order.
 * @requires npm i -D @threenative/terrain
 * @situation bake a biome that says `"stream": "ordered"`
 * @constraint `data.rules` is the biome's rows, and `data.field` the ground they were graded on
 * @example const { placements, counts } = scatterProps(data, focus, clearings);
 */
export function scatterProps(
  data: IOrderedScatterField,
  focus: { x: number; z: number },
  clearings: readonly (readonly [number, number, number])[] = [],
): IOrderedScatter {
  const { spec, rules } = data;
  const temperate = rules.ground === "wood";
  const desert = rules.ground === "mesa";
  const tundra = rules.ground === "mats";
  const alpine = rules.ground === "crag";
  const treeLimit = rules.treeCount;
  const placements: IPlacement[] = [];
  const counts: Record<string, number> = Object.fromEntries(
    [
      "boulder",
      "bush",
      "fern",
      "grass",
      "litter",
      "poppy",
      "sapling",
      "scrub",
      "spruce",
      "riverrock",
      "scree",
      "cliff",
      "mountain",
      "volcanic",
      "reveal",
    ].map((name) => [name, 0]),
  );
  const random = createRandom(rules.seed);
  const half = data.size / 2;
  const inside = (x: number, z: number) => Math.abs(x) < half - 3 && Math.abs(z) < half - 3;
  // River segments indexed by their reach (`@threenative/terrain`), so a candidate tests only the
  // segments that can reach it rather than every segment of every river.
  const riverIndex = createSegmentIndex(
    spec.water.some((body) => body.kind === "river")
      ? (data.rivers ?? []).flatMap((river) =>
          river.points.flatMap((b, index) => {
            const a = river.points[index - 1];
            return a
              ? [
                  {
                    a: [a[0] ?? 0, a[2] ?? 0] as const,
                    b: [b[0] ?? 0, b[2] ?? 0] as const,
                    reach: river.width * 2.5,
                    data: { a, b, reach: river.width * 2.5 },
                  },
                ]
              : [];
          }),
        )
      : [],
    32,
  );
  const nearRiver = (x: number, z: number): boolean =>
    riverIndex.nearby(x, z).some(({ a, b, reach }) => {
      const dx = (b[0] ?? 0) - (a[0] ?? 0);
      const dz = (b[2] ?? 0) - (a[2] ?? 0);
      const t = clamp01(
        ((x - (a[0] ?? 0)) * dx + (z - (a[2] ?? 0)) * dz) / (dx * dx + dz * dz || 1),
      );
      const distance = Math.hypot(x - (a[0] ?? 0) - t * dx, z - (a[2] ?? 0) - t * dz);
      const level = (a[1] ?? 0) + t * ((b[1] ?? 0) - (a[1] ?? 0));
      return distance < reach && clampedHeight(data, x, z) < level + 0.35;
    });
  const wet = (x: number, z: number) =>
    (data.waterLevel !== null && clampedHeight(data, x, z) < data.waterLevel + 0.35) ||
    (tundra && nearRiver(x, z)) ||
    (data.lakes ?? []).some(
      (lake) =>
        Math.hypot(x - (lake.at[0] ?? 0), z - (lake.at[1] ?? 0)) < lake.radius &&
        clampedHeight(data, x, z) < lake.level + 0.35,
    );
  const depositsAt = (x: number, z: number): number => {
    const column = Math.max(
      0,
      Math.min(data.resolution - 1, Math.round((x / data.size + 0.5) * (data.resolution - 1))),
    );
    const row = Math.max(
      0,
      Math.min(data.resolution - 1, Math.round((z / data.size + 0.5) * (data.resolution - 1))),
    );
    return depositAtIndex(data, row * data.resolution + column);
  };
  // A placement draws its own pose from `poseDraw`, and an unplaced one takes that draw and leaves
  // nothing: a layer on a stream of its own, or a candidate a rule removes, moves no later layer.
  let poseDraw: () => number = random;
  let placing = true;
  const put = (asset: string, x: number, z: number, scale: number, suffix = "") => {
    if (!inside(x, z) || (asset !== "riverrock" && asset !== "pebble" && wet(x, z))) return;
    if (data.erosion && asset === "scree" && depositsAt(x, z) < 0.08) {
      // The light DEM transport pass is bounded to <1 m. Existing surveyed talus remains scree
      // even when this tiny additional pass deposited almost nothing on it.
      const slope = slopeDegrees(data, x, z);
      if (!(alpine || desert) || slope < 18 || slope > 38) return;
    }
    if (asset === "cliff") {
      // Stones normalize their largest dimension to 18 m. This envelope covers every yaw.
      const reach = 18 * Math.SQRT1_2 * scale;
      if (
        data.waterLevel !== null ||
        [-reach, 0, reach].some((dx) =>
          [-reach, 0, reach].some(
            (dz) =>
              grassWeight(data, x + dx, z + dz) > 0.05 || slopeDegrees(data, x + dx, z + dz) < 43,
          ),
        )
      )
        return;
    }
    if (alpine && asset === "mountain" && (Math.abs(x) > half - 48 || Math.abs(z) > half - 48))
      return;
    if (desert && ["boulder", "scree", "volcanic", "reveal"].includes(asset)) {
      const height = clampedHeight(data, x, z);
      const slope = slopeDegrees(data, x, z);
      const neighbours = [
        [-18, 0],
        [18, 0],
        [0, -18],
        [0, 18],
      ].map(([dx, dz]) => clampedHeight(data, x + (dx ?? 0), z + (dz ?? 0)));
      const foot = slope < 35 && Math.max(...neighbours) > height + 8;
      const rim = slope < 24 && Math.min(...neighbours) < height - 8;
      if (!foot && !rim) return;
    }
    const index = counts[asset] ?? 0;
    const crag = asset === "mountain" || asset === "volcanic" || asset === "reveal";
    const bedded = temperate && ["boulder", "riverrock", "scree", "pebble"].includes(asset);
    const normal = crag || bedded ? data.field.normalAt(x, z) : undefined;
    if (crag && normal) {
      normal.y += 0.65;
      normal.normalize();
    }
    const rotation =
      crag && normal
        ? Math.atan2(normal.x, normal.z) + (poseDraw() - 0.5) * 0.6
        : poseDraw() * Math.PI * 2;
    if (!placing) return;
    placements.push({
      asset,
      id: `temperate-${asset}:${index}${suffix}`,
      layer: `temperate-${asset}`,
      alignToNormal: crag || bedded || (temperate && (asset === "spruce" || asset === "sapling")),
      normal:
        (crag || bedded) && normal
          ? normal.toArray()
          : temperate && (asset === "spruce" || asset === "sapling")
            ? [Math.sin(x * 1.17 + z) * 0.045, 1, Math.cos(z * 1.31 - x) * 0.045]
            : [0, 1, 0],
      position: [x, clampedHeight(data, x, z), z],
      rotation,
      scale,
    });
    counts[asset] = index + 1;
  };
  const nearEye = (x: number, z: number) =>
    clearings.some(([cx, cz, radius]) => Math.hypot(x - cx, z - cz) < radius * 1.6);
  // Each trunk: x, z, its spacing reach, and its crown scale (0 when the water takes the trunk).
  const cells = new Map<string, [number, number, number, number][]>();
  const CELL = 7;
  // Poisson disc whose radius follows the stand mask: a closed core packs tight, an edge opens out.
  // There is no per-cell occupancy, because one tree per cell IS the lattice the old rule drew.
  const crowded = (x: number, z: number, reach: number) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++)
      for (let dx = -1; dx <= 1; dx++)
        for (const [tx, tz, tr] of cells.get(`${cx + dx},${cz + dz}`) ?? [])
          if (Math.hypot(tx - x, tz - z) < Math.max(reach, tr)) return true;
    return false;
  };
  // A crown's shade: a standing trunk within the radius times that tree's own scale, so a veteran
  // shades wider than a pole and a trunk the water takes shades nothing. The cell ring covers the
  // tallest tree's radius, so a shade wider than one cell still sees every trunk inside it.
  const shaded = (x: number, z: number, radius: number) => {
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    const ring = Math.ceil((radius * 2) / CELL);
    for (let dz = -ring; dz <= ring; dz++)
      for (let dx = -ring; dx <= ring; dx++)
        for (const [tx, tz, , crown] of cells.get(`${cx + dx},${cz + dz}`) ?? [])
          if (Math.hypot(tx - x, tz - z) < radius * crown) return true;
    return false;
  };
  const treeAsset = rules.treeAsset;
  // Moisture is measured, not painted: a hollow sits below its neighbours and holds water, and that
  // is where ferns, litter and the riparian species go.
  const hollow = (x: number, z: number): number => {
    const here = clampedHeight(data, x, z);
    const around = [-26, -13, 13, 26].map(
      (d) => (clampedHeight(data, x + d, z) + clampedHeight(data, x, z + d)) / 2,
    );
    return clamp01(((Math.max(...around) - here) / 3.5 + 0.15) * 0.5);
  };
  for (let tries = 0; (counts[treeAsset] ?? 0) < treeLimit && tries < rules.attempts; tries++) {
    const x = (random() - 0.5) * data.size;
    const z = (random() - 0.5) * data.size;
    if (
      !inside(x, z) ||
      wet(x, z) ||
      nearEye(x, z) ||
      slopeDegrees(data, x, z) > rules.treeSlopeLimit ||
      (data.waterLevel !== null &&
        clampedHeight(data, x, z) < data.waterLevel + rules.grassWaterMargin) ||
      (rules.treeHeightCeiling !== null && clampedHeight(data, x, z) > rules.treeHeightCeiling) ||
      grassWeight(data, x, z) < rules.treeGrassThreshold ||
      forestWeight(x, z) < rules.treeStandThreshold
    )
      continue;
    const stand = forestWeight(x, z);
    const reach = rules.treeStands
      ? rules.treeSpacing[1] - rules.treeSpacing[0] * clamp01((stand - 0.28) / 0.5)
      : rules.treeSpacing[0];
    if (crowded(x, z, reach)) continue;
    const key = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
    const bucket = cells.get(key) ?? [];
    cells.set(key, bucket);
    // Age structure from its own field, so a dense core is not one height: most of a stand is
    // mid-sized, a few are veterans, and the young crowd the light gaps.
    const age = sample01(x * 0.021, 7, z * 0.021);
    const scale = temperate
      ? 0.42 + 1.18 * age ** 1.6 + random() * 0.16
      : (tundra ? 0.25 : 0.55) + random() * 0.35;
    const standing = !BANK.some(([dx, dz]) => wet(x + dx, z + dz) || nearRiver(x + dx, z + dz));
    bucket.push([x, z, reach, standing ? scale : 0]);
    put(treeAsset, x, z, scale);
    // Regeneration at stand edges; ferns stay under established crowns.
    const edge = stand < 0.57;
    for (let i = 0; i < (tundra ? 0 : edge ? 2 : 1); i++) {
      const angle = random() * Math.PI * 2;
      const reachOut = 2 + random() * 4;
      const sx = x + Math.cos(angle) * reachOut;
      const sz = z + Math.sin(angle) * reachOut;
      if (!nearEye(sx, sz) && grassWeight(data, sx, sz) > 0.25)
        put("sapling", sx, sz, 0.55 + random() * 0.9);
    }
    if (temperate)
      for (let i = 0; i < 2; i++)
        put("fern", x + (random() - 0.5) * 7, z + (random() - 0.5) * 7, 0.6 + random() * 0.75);
  }
  if (temperate) {
    // The understorey is the layer the wood was missing: bracken and needle litter under a closed
    // canopy, thickets in the light gaps and along the wet ground, all keyed to the same stand mask.
    // Needle litter is a half-metre twig: it is worth 9000 of them and no more, because past sixteen
    // metres it is sub-pixel and the count is pure host cost. The count and the four chances below
    // are the file's, so a wood thickens this layer by editing its own row; a multiplier of 1 leaves
    // every draw of this stream exactly where the graded wood put it.
    const understoreyPass = (draw: () => number, row: IUnderstoreySpec) => {
      for (let i = 0; i < row.attempts; i++) {
        const x = (draw() - 0.5) * data.size;
        const z = (draw() - 0.5) * data.size;
        if (!inside(x, z) || wet(x, z) || nearEye(x, z)) continue;
        if (slopeDegrees(data, x, z) > 30) continue;
        const stand = forestWeight(x, z);
        const damp = hollow(x, z);
        const open = grassWeight(data, x, z);
        if (open < 0.28) continue;
        // Litter: the floor of a closed stand, thickest where the canopy is and under the drip line.
        if (stand > 0.44 && draw() < ((stand - 0.4) * 1.9 + damp * 0.25) * row.litter)
          put("litter", x, z, 0.65 + draw() * 1.1);
        // Bracken: shade and damp, not open meadow.
        if (stand > 0.4 && damp > 0.25 && draw() < damp * 0.55 * row.fern)
          put("fern", x, z, 0.7 + draw() * 0.8);
        // Thickets: the light gaps, the stand edge and the wet hollow — where a wood lets a bush in.
        if (stand < 0.66 && draw() < (0.05 + damp * 0.16 + (stand < 0.5 ? 0.06 : 0)) * row.bush)
          put("bush", x, z, 0.5 + draw() * 1.1);
        // Meadow flowers want light and a little soil, so they take the gaps, not the canopy floor.
        if (stand < 0.58 && damp > 0.18 && draw() < (0.02 + damp * 0.05) * row.flower)
          put("poppy", x, z, 0.75 + draw() * 0.6);
      }
    };
    // The shared stream leaves this layer where the graded loop left it, whatever the row grows:
    // a row that thickens the ferns must not move a boulder two layers later. The graded row draws
    // and places on the shared stream; any other row lets the graded draws pass unplaced and grows
    // from a stream of its own.
    const row = rules.understorey;
    const graded =
      row.attempts === GRADED_UNDERSTOREY.attempts &&
      row.litter === 1 &&
      row.fern === 1 &&
      row.bush === 1 &&
      row.flower === 1;
    placing = graded;
    understoreyPass(random, { ...row, ...GRADED_UNDERSTOREY });
    placing = true;
    if (!graded) {
      poseDraw = createRandom(rules.seed + 13);
      understoreyPass(poseDraw, row);
      poseDraw = random;
    }
  }
  // Tundra and desert are not carpets. Both grow in clumps with bare ground between them, and both
  // read as a mown lawn when every plant sits on its own lattice point — so each grows a cluster of
  // tufts around a chosen centre instead of one plant per cell.
  if (tundra || desert) {
    for (let i = 0; i < (tundra ? 1100 : 900); i++) {
      const cx = (random() - 0.5) * data.size;
      const cz = (random() - 0.5) * data.size;
      if (!inside(cx, cz)) continue;
      // Tundra follows its own mat field; desert follows the washes, which are the low ground.
      const bias = tundra
        ? clamp01((tundraCover(cx, cz) - 0.42) / 0.3)
        : clamp01((hollow(cx, cz) - 0.1) * 1.5);
      if (random() > 0.3 + bias * 0.65) continue;
      const radius = tundra ? 1.2 + random() * 3 : 1.8 + random() * 4.5;
      const tufts = tundra ? 8 + Math.floor(random() * 14) : 5 + Math.floor(random() * 9);
      for (let k = 0; k < tufts; k++) {
        const angle = random() * Math.PI * 2;
        const out = radius * Math.sqrt(random());
        cover(cx + Math.cos(angle) * out, cz + Math.sin(angle) * out, 0.85);
      }
    }
  }
  // Metre-scale outcrops follow the surveyed walls; the DEM owns every ridge and couloir.
  if (alpine) {
    for (let z = -half + 48; z < half - 48; z += 24)
      for (let x = -half + 48; x < half - 48; x += 24) {
        const sx = x + (random() - 0.5) * 12;
        const sz = z + (random() - 0.5) * 12;
        if (slopeDegrees(data, sx, sz) < 40 || clampedHeight(data, sx, sz) < 65 || random() > 0.55)
          continue;
        const metres = 2 + random() * 3;
        put("mountain", sx, sz, metres / 24);
        const fall = data.field.normalAt(sx, sz);
        const length = Math.hypot(fall.x, fall.z) || 1;
        const overlapX = sx + (fall.x / length) * metres * 0.28;
        const overlapZ = sz + (fall.z / length) * metres * 0.28;
        if (
          clampedHeight(data, overlapX, overlapZ) > 42 &&
          slopeDegrees(data, overlapX, overlapZ) > 28
        )
          put("mountain", overlapX, overlapZ, (metres * 0.85) / 24);
        // A broad toe of small angular debris, widening downhill from each exposed wall.
        for (let k = 0; k < 28; k++) {
          const down = 16 + random() * 24;
          const across = (random() - 0.5) * down;
          const tx = sx + (fall.x * down - fall.z * across) / length;
          const tz = sz + (fall.z * down + fall.x * across) / length;
          if (slopeDegrees(data, tx, tz) < 38) put("scree", tx, tz, 0.08 + random() * 0.28);
        }
      }
  }
  if (desert) {
    for (let z = -half + 18; z < half - 18; z += 9)
      for (let x = -half + 18; x < half - 18; x += 9) {
        const sx = x + (random() - 0.5) * 7;
        const sz = z + (random() - 0.5) * 7;
        if (random() < 0.7) put("volcanic", sx, sz, 0.06 + random() * 0.12);
        if (random() < 0.5) put("reveal", sx, sz, 0.15 + random() * 0.2);
      }
  }
  // Rock clusters follow exposed slopes rather than evenly spaced lawn ornaments.
  for (let i = 0; i < (temperate ? 1100 : 2400); i++) {
    const x = (random() - 0.5) * data.size;
    const z = (random() - 0.5) * data.size;
    if (!inside(x, z) || wet(x, z)) continue;
    const slope = slopeDegrees(data, x, z);
    const deposits = depositsAt(x, z);
    if (
      (slope < (tundra ? 3 : desert ? 8 : 15) && deposits < 0.18) ||
      random() > 0.38 ||
      nearEye(x, z)
    )
      continue;
    if (slope > 43) {
      if (temperate && random() < 0.22) put("cliff", x, z, 0.65 + random() * 0.5);
      continue;
    }
    if (deposits > 0.12 && slope < 40 && random() < 0.65) {
      for (let k = 0; k < 3; k++)
        put("scree", x + (random() - 0.5) * 8, z + (random() - 0.5) * 8, 0.12 + random() * 0.3);
    }
    if (alpine && slope > 18 && slope < 38) {
      for (let k = 0; k < 8; k++) {
        const sx = x + (random() - 0.5) * 14;
        const sz = z + (random() - 0.5) * 14;
        if (slopeDegrees(data, sx, sz) < 42) put("scree", sx, sz, 0.12 + random() * 0.22);
      }
    }
    for (let k = 0; k < 2 + Math.floor(random() * 3); k++)
      put("boulder", x + (random() - 0.5) * 8, z + (random() - 0.5) * 8, 0.45 + random() * 0.8);
  }
  if (temperate && data.waterLevel !== null) {
    // Reuse the river stones for a broken rocky tide line, below the vegetation's beach exclusion.
    for (let i = 0; i < 2200; i++) {
      const x = (random() - 0.5) * data.size;
      const z = (random() - 0.5) * data.size;
      const above = clampedHeight(data, x, z) - data.waterLevel;
      if (above < 0.4 || above > 4.8 || slopeDegrees(data, x, z) > 38 || random() > 0.28) continue;
      put("riverrock", x, z, 0.8 + random() * 2.4);
      if (random() < 0.22) put("boulder", x + 1.2, z - 1.2, 0.3 + random() * 0.5);
    }
  }
  for (const river of data.rivers ?? []) {
    for (let i = 1; i < river.points.length; i++) {
      const a = river.points[i - 1];
      const b = river.points[i];
      if (!a || !b) continue;
      const dx = (b[0] ?? 0) - (a[0] ?? 0);
      const dz = (b[2] ?? 0) - (a[2] ?? 0);
      const length = Math.hypot(dx, dz);
      for (let at = 0; at < length; at += 2.4) {
        const side = random() < 0.5 ? -1 : 1;
        const reach = river.width * (0.42 + random() * 0.3) * side;
        put(
          "riverrock",
          (a[0] ?? 0) + (dx * at) / length - (dz / length) * reach,
          (a[2] ?? 0) + (dz * at) / length + (dx / length) * reach,
          0.5 + random() * 1.2,
        );
      }
    }
  }
  const shadeDraw = createRandom(rules.seed + 14);
  function coverAt(x: number, z: number, density: number): void {
    if (
      !inside(x, z) ||
      wet(x, z) ||
      slopeDegrees(data, x, z) > 34 ||
      (tundra ? clamp01((tundraCover(x, z) - 0.47) / 0.3) : grassWeight(data, x, z)) < 0.22
    )
      return;
    const drift = coverDriftWeight(rules.drift, x, z);
    if (random() > density * drift) return;
    // A shore's blades grow tall where the sand is wet; elsewhere they keep the look's own scale.
    const shore =
      rules.shoreGround &&
      clampedHeight(data, x, z) < (data.waterLevel ?? 0) + rules.grassWaterMargin;
    put("grass", x, z, (shore ? 2.2 : rules.bladeScale) + random() * rules.bladeJitter);
    if (desert) {
      for (let tuft = 0; tuft < 3; tuft++)
        put(
          "grass",
          x + (random() - 0.5) * 1.4,
          z + (random() - 0.5) * 1.4,
          0.65 + random() * 0.55,
        );
    }
    if (random() < rules.scrubChance)
      put(
        "scrub",
        x + (random() - 0.5),
        z + (random() - 0.5),
        rules.scrubScale + random() * rules.scrubJitter,
      );
    if (rules.scrubBush && random() < 0.02)
      put("bush", x + (random() - 0.5) * 2, z + (random() - 0.5) * 2, 0.6 + random() * 0.45);
  }
  // A crown thins the grass under it: the share of candidates a shaded spot loses, and how far out
  // a trunk shades the ground. The share is drawn from a stream of its own and a removed candidate
  // still takes its draws, so the shade moves no blade that it does not remove.
  function cover(x: number, z: number, density: number): void {
    placing = !(
      rules.understorey.shade > 0 &&
      shaded(x, z, rules.understorey.shadeRadius) &&
      shadeDraw() < rules.understorey.shade
    );
    coverAt(x, z, density);
    placing = true;
  }
  // A cheap carpet on every grass cell; dense detail at all walking/benchmark eyes, not one disc.
  for (let z = -half + 3; z < half - 3; z += rules.grassCell)
    for (let x = -half + 3; x < half - 3; x += rules.grassCell)
      cover(
        x + (random() - 0.5) * (temperate ? 1.5 : desert ? 6 : tundra ? 1.7 : 3),
        z + (random() - 0.5) * (temperate ? 1.5 : desert ? 6 : tundra ? 1.7 : 3),
        0.7,
      );
  const eyes = [focus, ...clearings.map(([x, z]) => ({ x, z }))];
  for (const eye of eyes) {
    // The forest's thinned walking-eye carpet stays as tuned; other biomes take their own spacing.
    const eyeStep = rules.grassDetailSpacing;
    const eyeReach = temperate ? GRASS_THIN : GRASS_FULL + 22;
    // Uniform rejection sampling in the eye disc avoids a carpet of parallel jittered rows.
    if (tundra) {
      for (let i = 0; i < Math.ceil((Math.PI * eyeReach ** 2) / eyeStep ** 2); i++) {
        const angle = random() * Math.PI * 2;
        const distance = Math.sqrt(random()) * eyeReach;
        const density = Math.max(
          0.08,
          1 - Math.max(0, distance - GRASS_FULL) / (eyeReach - GRASS_FULL),
        );
        cover(eye.x + Math.cos(angle) * distance, eye.z + Math.sin(angle) * distance, density);
      }
      continue;
    }
    for (let dz = -eyeReach; dz < eyeReach; dz += eyeStep)
      for (let dx = -eyeReach; dx < eyeReach; dx += eyeStep) {
        const distance = Math.hypot(dx, dz);
        if (distance > eyeReach) continue;
        const density = Math.max(
          0.08,
          1 - Math.max(0, distance - GRASS_FULL) / (eyeReach - GRASS_FULL),
        );
        cover(eye.x + dx + (random() - 0.5) * 0.6, eye.z + dz + (random() - 0.5) * 0.6, density);
      }
    for (let p = 0; p < (temperate ? 14 : 0); p++) {
      const angle = random() * Math.PI * 2;
      const reach = random() * 32;
      const px = eye.x + Math.cos(angle) * reach;
      const pz = eye.z + Math.sin(angle) * reach;
      if (forestWeight(px, pz) > 0.62 && !nearEye(px, pz)) continue;
      const radius = 2.5 + random() * 3.5;
      for (let k = 0; k < 100; k++) {
        const x = px + (random() - 0.5) * radius * 2;
        const z = pz + (random() - 0.5) * radius * 2;
        if (
          Math.hypot(x - px, z - pz) > radius ||
          slopeDegrees(data, x, z) > 28 ||
          grassWeight(data, x, z) < 0.4
        )
          continue;
        put("poppy", x, z, 0.8 + random() * 0.4);
      }
    }
  }
  if (temperate) {
    // Separate seed: dressing the rock/shore never reshuffles the established stands.
    const dressing = createRandom(rules.seed + 12);
    // Rock outcrops take this terrain's own steepest ground: its steepest 2%, but never ground gentler
    // than 30 degrees would allow (`@threenative/terrain` slopeQuantile).
    const outcropSlope = Math.min(
      30,
      slopeQuantile(
        { height: data.field.heights, resolution: data.resolution, size: data.size },
        0.98,
      ),
    );
    for (let z = -half + 12; z < half - 12; z += 12)
      for (let x = -half + 12; x < half - 12; x += 12) {
        const sx = x + (dressing() - 0.5) * 10;
        const sz = z + (dressing() - 0.5) * 10;
        const slope = slopeDegrees(data, sx, sz);
        const height = clampedHeight(data, sx, sz);
        const shore =
          data.waterLevel !== null &&
          height > data.waterLevel + 0.4 &&
          height < data.waterLevel + 7;
        if (nearEye(sx, sz) || wet(sx, sz)) continue;
        if (shore && slope > 12 && dressing() < 0.65)
          put("mountain", sx, sz, (5 + dressing() * 10) / 24, ":outcrop");
        else if (slope > outcropSlope && slope < 64 && dressing() < 0.6)
          put("mountain", sx, sz, (10 + dressing() * 10) / 24, ":outcrop");
      }
  }
  // A cobbled river's bed and banks: cobbles across the wetted bed (seen through the water), a few
  // stones tall enough to break the surface in the shallows, and larger river rocks on the waterline.
  // Last, so every placement above keeps its place in the seed's sequence. The file says whose bed
  // is cobbled.
  if (rules.cobbledBed)
    for (const river of data.rivers ?? [])
      for (let i = 1; i < river.points.length; i++) {
        const [ax = 0, ay = 0, az = 0] = river.points[i - 1] ?? [];
        const [bx = 0, by = 0, bz = 0] = river.points[i] ?? [];
        const length = Math.hypot(bx - ax, bz - az) || 1;
        const ux = (bx - ax) / length;
        const uz = (bz - az) / length;
        for (let at = 0; at < length; at += 0.6) {
          const level = ay + ((by - ay) * at) / length;
          const across = (o: number) => [ax + ux * at - uz * o, az + uz * at + ux * o] as const;
          const depth = (o: number) => level - clampedHeight(data, ...across(o));
          for (let n = 0; n < 6; n++) {
            const o = (random() - 0.5) * 18;
            const d = depth(o);
            // A cobble 0.16-0.6 m across; the generator's boulder is 2 x ROCK.radius wide.
            if (d > 0.05 && d < 1.6)
              put("pebble", ...across(o), (0.08 + random() ** 2 * 0.22) / rules.stoneRadius);
          }
          for (const side of [-1, 1]) {
            let edge = 0;
            while (edge < 12 && depth(side * edge) > 0) edge += 0.5;
            const o = side * (edge - 1 - random() * 1.5);
            const d = depth(o);
            // Buried by a third, a boulder stands 2 x radius x flatten x 0.68 = 1.6 m per unit scale.
            if (random() < 0.08 && d > 0.12 && d < 0.5)
              put("pebble", ...across(o), (d + 0.12 + random() * 0.2) / 1.6);
            // Bank rocks gather where the current dropped them, in runs with gaps between, and lie
            // half in the water: from a metre inside the waterline to its edge.
            const [x, z] = across(side * edge);
            const run = clamp01((sample01(x * 0.06, 11, z * 0.06) - 0.42) / 0.2);
            if (random() < run * 0.45)
              for (let k = random() < 0.4 ? 2 : 1; k > 0; k--)
                put(
                  "riverrock",
                  ...across(side * (edge - 1.1 + random() * 1.2)),
                  0.6 + random() ** 1.5 * 1.6,
                );
          }
        }
      }
  // Nothing grows under the river or the lake the player swims in (`world/water.ts` reads the same
  // splines, levels and reach), and a trunk stands a metre clear of the water. One pass over the
  // finished list, not a candidate test, so the seed's sequence and every dry placement stay put.
  const drowned = ({ asset, position: [x, , z] }: IPlacement) =>
    GROWING.has(asset) &&
    (TRUNKS.has(asset) ? BANK : BANK.slice(0, 1)).some(
      ([dx, dz]) => wet(x + dx, z + dz) || nearRiver(x + dx, z + dz),
    );
  const growing: Record<string, number> = {};
  const kept = placements
    .filter((placement) => !drowned(placement))
    .map((placement) => {
      if (!GROWING.has(placement.asset)) return placement;
      const index = growing[placement.asset] ?? 0;
      growing[placement.asset] = index + 1;
      return { ...placement, id: `temperate-${placement.asset}:${index}` };
    });
  for (const asset of GROWING) if (asset in counts) counts[asset] = growing[asset] ?? 0;
  return { counts, placements: kept };
}

/** What a river or lake must not grow, and what keeps a bank margin: trunks. */
const GROWING = new Set(["spruce", "sapling", "bush", "fern", "grass", "scrub", "poppy", "litter"]);
const TRUNKS = new Set(["spruce", "sapling"]);
const BANK = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;
