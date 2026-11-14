import { LANDFORMS, type LandformKind } from "../ground/presets.js";

/**
 * A biome as a data file: the rules one world grows by, and no appearance at all.
 *
 * A biome says which landform and seed it was generated from, which baked bundle its world is read
 * from, which trees, grass and ground bands it holds, which water it floods, where it puts the
 * player and the detail, the words a request may use for it, and the *name* of the look it is graded
 * under. It carries no colour, no material and
 * no shading: those stay game source, and the game resolves `look` to its own preset. A sixth biome
 * is therefore a new file beside the five, not a new branch in the code that reads them.
 *
 * Every field is required, so a mistyped or missing one fails rather than falling back to a default
 * (`validateBiome`).
 */

/** Where the far field past the playable square is planted, and where it stops. */
export interface IFarFieldRule {
  /** Candidate grid, metres: at most one tree per cell. */
  readonly cell: number;
  /** Mean spacing just past the edge, and at the far reach. */
  readonly spacing: readonly [number, number];
  /** Metres past the square's edge where the near spacing starts, and where the far one is reached. */
  readonly spacingAt: readonly [number, number];
  /** Slope fade, degrees, and the gentler slopes a meadow clearing fades out over. */
  readonly slope: readonly [number, number];
  readonly meadowSlope: readonly [number, number];
  /** Chevron distance from the origin beyond which nothing is planted. */
  readonly reach: number;
  /** How far the treeline wanders with noise, metres. */
  readonly treelineJitter: number;
  /** Stand-noise threshold band: the square plants above its own `standThreshold`. */
  readonly stand: readonly [number, number];
  /** The far field's own seed: it draws from one stream of its own, never the bake's. */
  readonly seed: number;
  /** Metres at which a far tree becomes the engine's whole-asset impostor. */
  readonly impostor: number;
}

/** One species a biome plants, and the ground it accepts. `species` is the asset the game resolves. */
export interface IFoliageType {
  readonly species: string;
  /** How many of them the rule accepts. */
  readonly density: number;
  /** Degrees, inclusive. */
  readonly slope: readonly [number, number];
  /** Metres above the world's floor, or null for no limit. */
  readonly height: readonly [number, number] | null;
  /** Metres between instances, at the tightest and the loosest. */
  readonly spacing: readonly [number, number];
  /** What a placement stops the player with. */
  readonly collision: "none" | "trunk" | "hull";
  /** The spacing follows the stand field, a closed core packing tighter than an open edge. */
  readonly stands: boolean;
  /** The least meadow weight, 0..1, a spot must carry for this species to stand on it. */
  readonly grassThreshold: number;
  /** The least stand-field weight, 0..1, a spot must carry for this species to stand on it. */
  readonly standThreshold: number;
  readonly far: IFarFieldRule | null;
}

/** One ground-cover species and the ground it accepts, on a grid of `spacing` metres. */
export interface IGrassType {
  readonly species: string;
  /** How much of that ground it covers, 0..1. */
  readonly density: number;
  readonly slope: readonly [number, number];
  readonly height: readonly [number, number] | null;
  readonly spacing: number;
  /** Degrees past `slope[1]` the meadow runs out over. */
  readonly slopeFalloff: number;
  /** Metres over which the cover fades out at the `height` ceiling. */
  readonly heightFalloff: number;
  /**
   * The mat field's band, `[threshold, span]`: the weight the cover is gone at and the weight over
   * which it reaches full, on the field a mat plain is measured by. Null on ground without mats.
   */
  readonly mats: readonly [number, number] | null;
  /** Metres above the waterline a plant stands at. */
  readonly waterMargin: number;
  /** A beach that thins over the waterline, over `width` metres; null on a shore with none. */
  readonly beach: readonly [number, number] | null;
  /** Metres between plants in the dense detail disc around a place the player stands. */
  readonly detailSpacing: number;
  /** The drift this cover grows on: the field it reads and the band it fades over. */
  readonly drift: ICoverDriftRow;
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
}

/** The ground model an ordered biome's generators run: a wood, a crag, a dune field or a mat plain. */
export type CoverGround = "wood" | "crag" | "mesa" | "mats";

/** The drift a biome's ground cover grows on: one value-noise field, sampled at these numbers. */
export interface ICoverDriftRow {
  /** The field the drift is measured on: a wood's stands, or a mat plain's mats. */
  readonly field: "stand" | "mats";
  /** Metres⁻¹ the field is sampled at, in x and z: a small frequency drifts in broad patches. */
  readonly frequency: readonly [number, number];
  /** The share of the cover that stands everywhere. */
  readonly offset: number;
  /** How much of the cover rides the field above that floor. */
  readonly amplitude: number;
  /** The field weight the drift is gone at, and the weight over which it reaches full. */
  readonly band: readonly [number, number];
}

/**
 * The understorey: the layer a closed wood carries under its canopy, and how thick it grows.
 *
 * A wood is the only ground that grows one today, but its numbers are the file's, not the code's: a
 * woodland that wants more bracken, more thicket or more needle litter edits its own row.
 */
export interface IUnderstoreySpec {
  /** How many candidates the understorey's loop draws; zero plants the layer not at all. */
  readonly attempts: number;
  /** A multiplier on the chance of each placement: 1 is the layer the wood was graded on. */
  readonly litter: number;
  readonly fern: number;
  readonly bush: number;
  /** The meadow flowers of the light gaps, which this stream plants as poppies. */
  readonly flower: number;
  /** Fallen wood under a closed stand: boughs and logs. 0 grows none. */
  readonly deadfall: number;
  /** The share of ground-cover candidates dropped under a crown, 0 to 1. */
  readonly shade: number;
  /** How far from a trunk its crown shades the ground, in metres. */
  readonly shadeRadius: number;
}

/**
 * What a biome's one ordered stream runs on: its cover model, its seed, and the places it keeps open.
 *
 * The numbers here are the game's, not the row's: a stream is one sequence of draws for the whole
 * biome, so the seed and the clearing discs belong to the biome and not to a species.
 */
export interface ICoverSpec {
  readonly ground: CoverGround;
  /** The seed one ordered stream starts from. */
  readonly seed: number;
  /** The most candidates a stand's loop draws before it settles for what it has. */
  readonly attempts: number;
  /** Radius at the widest point of the game's biggest stone, which normalizes a cobble's scale. */
  readonly stoneRadius: number;
  /** Circles kept clear, `[x, z, radius]`: the places a player walks. */
  readonly clearings: readonly (readonly [number, number, number])[];
  /** The layer under a closed wood's canopy: how many draws, and how thick each one grows. */
  readonly understorey: IUnderstoreySpec;
}

/** A ground layer's band, as fractions of the measured height range. */
export interface ILayerInfo {
  /** The ground layer this band feeds; the game resolves the name to its own material. */
  readonly layer: string;
  readonly from: number;
  readonly to: number;
  /** Snow: the steepness it starts to shed at, and the steepness it is gone by. */
  readonly shedFrom?: number;
  readonly shedTo?: number;
}

/** One water body: a river's ribbon, a lake's footprint, or the ocean the world stands in. */
export interface IBiomeWaterBody {
  readonly kind: "river" | "lake" | "ocean";
  /** River: its ribbon width, in metres. */
  readonly width?: number;
  /** Lake: the radius of its footprint, in metres. */
  readonly radius?: number;
  /** River: how far it cuts below its banks. */
  readonly depth?: number;
  /** Ocean: the sea level the world floods to. */
  readonly level?: number;
}

/**
 * The baked bundle a biome's world is read from: the file under the game's `world/` folder.
 *
 * A bundle holds one world or several: two biomes generated from the same DEM share one file, so a
 * world is named by the file and the key it sits under, not by a branch in the loader.
 */
export interface IBakeBundle {
  /** File stem under `world/`, without its extension. */
  readonly file: string;
  /** The key this biome's world sits under when the file holds several, else null. */
  readonly key: string | null;
}

/** Where the world puts the player, the launch camera and its dense detail. */
export interface ISpawnSpec {
  /** World x and z the player starts at. */
  readonly at: readonly [number, number];
  /** Metres the launch camera stands back and up from the spawn. */
  readonly cameraOffset: readonly [number, number, number];
  /** World x and z the dense ground cover is placed around: a meadow is a place, not a texture. */
  readonly focus: readonly [number, number];
}

export interface IBiomeSpec {
  /** The name of the look the game grades this biome under; the package reads no colour. */
  readonly look: string;
  readonly bake: IBakeBundle;
  readonly landform: LandformKind;
  readonly sizeMeters: number;
  readonly seed: number;
  /**
   * How the rows place: `ordered` runs every generator from one stream in one fixed order, `seeded`
   * runs each rule from its own seed. `ordered` carries the game's own counts; `seeded` is the
   * package's own sampler.
   */
  readonly stream: "ordered" | "seeded";
  /** The cover a stream runs on: its model, its seed and the discs it keeps clear. */
  readonly cover: ICoverSpec;
  readonly foliage: readonly IFoliageType[];
  readonly grass: readonly IGrassType[];
  readonly layers: readonly ILayerInfo[];
  readonly water: readonly IBiomeWaterBody[];
  readonly spawn: ISpawnSpec;
  /** The species that live here, by asset id: the pack resolves each to its own art. */
  readonly species: readonly string[];
  /** The words a request may use for this biome; its own name comes first. */
  readonly aliases: readonly string[];
}

const SPEC_FIELDS = [
  "look",
  "bake",
  "landform",
  "sizeMeters",
  "seed",
  "stream",
  "cover",
  "foliage",
  "grass",
  "layers",
  "water",
  "spawn",
  "species",
  "aliases",
] as const;
const COVER_FIELDS = [
  "ground",
  "seed",
  "attempts",
  "stoneRadius",
  "clearings",
  "understorey",
] as const;
const UNDERSTOREY_FIELDS = [
  "attempts",
  "litter",
  "fern",
  "bush",
  "flower",
  "deadfall",
  "shade",
  "shadeRadius",
] as const;
const COVER_GROUNDS = ["wood", "crag", "mesa", "mats"] as const;
const STREAMS = ["ordered", "seeded"] as const;
const DRIFT_FIELDS = ["field", "frequency", "offset", "amplitude", "band"] as const;
const DRIFT_FIELDS_NAMES = ["stand", "mats"] as const;
const FOLIAGE_FIELDS = [
  "species",
  "density",
  "slope",
  "height",
  "spacing",
  "collision",
  "stands",
  "grassThreshold",
  "standThreshold",
  "far",
] as const;
const FAR_FIELDS = [
  "cell",
  "spacing",
  "spacingAt",
  "slope",
  "meadowSlope",
  "reach",
  "treelineJitter",
  "stand",
  "seed",
  "impostor",
] as const;
const GRASS_FIELDS = [
  "species",
  "density",
  "slope",
  "height",
  "spacing",
  "slopeFalloff",
  "heightFalloff",
  "mats",
  "waterMargin",
  "beach",
  "detailSpacing",
  "drift",
  "bladeScale",
  "bladeJitter",
  "scrubChance",
  "scrubScale",
  "scrubJitter",
  "scrubBush",
  "shoreGround",
  "cobbledBed",
] as const;
const BAKE_FIELDS = ["file", "key"] as const;
const LAYER_FIELDS = ["layer", "from", "to", "shedFrom", "shedTo"] as const;
const LAYER_REQUIRED = ["layer", "from", "to"] as const;
const WATER_FIELDS = ["kind", "width", "radius", "depth", "level"] as const;
const WATER_REQUIRED = ["kind"] as const;
const SPAWN_FIELDS = ["at", "cameraOffset", "focus"] as const;
const LANDFORM_KINDS = Object.keys(LANDFORMS) as LandformKind[];
const COLLISION_CLASSES = ["none", "trunk", "hull"] as const;
const WATER_KINDS = ["river", "lake", "ocean"] as const;

function fail(biome: string, field: string, problem: string): never {
  throw new TypeError(`${biome}: biome field '${field}' ${problem}.`);
}

/** An object with exactly `fields`, every one of them present. */
function closed(
  value: unknown,
  biome: string,
  field: string,
  fields: readonly string[],
  required: readonly string[] = fields,
): Record<string, unknown> {
  const at = (name: string) => (field === "" ? name : `${field}.${name}`);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(biome, field || "<file>", "must be an object");
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!fields.includes(key)) fail(biome, at(key), "is not a field a biome has");
  for (const key of required) if (!(key in record)) fail(biome, at(key), "is missing");
  return record;
}

function count(value: unknown, biome: string, field: string, min = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(biome, field, "must be a finite number");
  if (value < min) fail(biome, field, `must be at least ${min}`);
  return value;
}

function positive(value: unknown, biome: string, field: string): number {
  const number = count(value, biome, field);
  if (number === 0) fail(biome, field, "must be greater than 0");
  return number;
}

function whole(value: unknown, biome: string, field: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail(biome, field, "must be a whole number");
  if (value < min) fail(biome, field, `must be at least ${min}`);
  return value;
}

/** A 0..1 weight. */
function share(value: unknown, biome: string, field: string): number {
  const number = count(value, biome, field);
  if (number > 1) fail(biome, field, "must be at most 1");
  return number;
}

function flag(value: unknown, biome: string, field: string): boolean {
  if (typeof value !== "boolean") fail(biome, field, "must be true or false");
  return value;
}

function text(value: unknown, biome: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "")
    fail(biome, field, "must be a non-empty string");
  return value;
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  biome: string,
  field: string,
  options: T,
): T[number] {
  if (typeof value !== "string" || !options.includes(value))
    fail(biome, field, `must be one of ${options.join(", ")}`);
  return value as T[number];
}

/** An interval of `size` numbers, ascending: a slope band, a spacing band, a footprint. */
function intervalOf(
  value: unknown,
  biome: string,
  field: string,
  size: number,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== size)
    fail(biome, field, `must be an array of ${size} numbers`);
  const numbers = value.map((entry, index) => count(entry, biome, `${field}[${index}]`, min));
  if (size === 2 && (numbers[0] as number) > (numbers[1] as number))
    fail(biome, field, "must ascend");
  for (const [index, entry] of numbers.entries())
    if (entry > max) fail(biome, `${field}[${index}]`, `must be at most ${max}`);
  return numbers;
}

/** A field weight band, `[threshold, span]`: neither ascends, and a zero span covers nothing. */
function band(value: unknown, biome: string, field: string): readonly [number, number] {
  if (!Array.isArray(value) || value.length !== 2)
    fail(biome, field, "must be an array of 2 numbers");
  const [threshold = 0, span = 0] = value.map((entry, index) =>
    share(entry, biome, `${field}[${index}]`),
  );
  if (span === 0) fail(biome, `${field}[1]`, "must be greater than 0");
  return [threshold, span];
}

/** An ascending pair. Returns a tuple, so a validated field needs no cast where it is read. */
function pair(
  value: unknown,
  biome: string,
  field: string,
  min = 0,
  max = Number.POSITIVE_INFINITY,
): readonly [number, number] {
  const [first = 0, second = 0] = intervalOf(value, biome, field, 2, min, max);
  return [first, second];
}

/** A point in world metres: `size` finite numbers, in no order. */
function pointOf(value: unknown, biome: string, field: string, size: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== size)
    fail(biome, field, `must be an array of ${size} numbers`);
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry))
      fail(biome, `${field}[${index}]`, "must be a finite number");
    return entry ?? 0;
  });
}

/** A 2D world point. */
function point2(value: unknown, biome: string, field: string): readonly [number, number] {
  const [x = 0, z = 0] = pointOf(value, biome, field, 2);
  return [x, z];
}

/** A 3D offset in metres. */
function point3(value: unknown, biome: string, field: string): readonly [number, number, number] {
  const [x = 0, y = 0, z = 0] = pointOf(value, biome, field, 3);
  return [x, y, z];
}

function far(value: unknown, biome: string, field: string): IFarFieldRule | null {
  if (value === null) return null;
  const far = closed(value, biome, field, FAR_FIELDS);
  return {
    cell: positive(far.cell, biome, `${field}.cell`),
    spacing: pair(far.spacing, biome, `${field}.spacing`),
    spacingAt: pair(far.spacingAt, biome, `${field}.spacingAt`),
    slope: pair(far.slope, biome, `${field}.slope`, 0, 90),
    meadowSlope: pair(far.meadowSlope, biome, `${field}.meadowSlope`, 0, 90),
    reach: positive(far.reach, biome, `${field}.reach`),
    treelineJitter: count(far.treelineJitter, biome, `${field}.treelineJitter`),
    stand: pair(far.stand, biome, `${field}.stand`, 0, 1),
    seed: whole(far.seed, biome, `${field}.seed`),
    impostor: count(far.impostor, biome, `${field}.impostor`),
  };
}

/** Two sampling frequencies, neither of which orders the other: a field's x and z rates. */
function frequencies(value: unknown, biome: string, field: string): readonly [number, number] {
  const [x = 0, z = 0] = pointOf(value, biome, field, 2);
  if (x <= 0 || z <= 0) fail(biome, field, "must be two positive frequencies");
  return [x, z];
}

function driftRow(value: unknown, biome: string, field: string): ICoverDriftRow {
  const row = closed(value, biome, field, DRIFT_FIELDS);
  return {
    field: oneOf(row.field, biome, `${field}.field`, DRIFT_FIELDS_NAMES),
    frequency: frequencies(row.frequency, biome, `${field}.frequency`),
    offset: share(row.offset, biome, `${field}.offset`),
    amplitude: share(row.amplitude, biome, `${field}.amplitude`),
    band: band(row.band, biome, `${field}.band`),
  };
}

/** A clearing circle: `[x, z, radius]`, radius in metres. */
function clearing(value: unknown, biome: string, field: string): readonly [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3)
    fail(biome, field, "must be an array of 3 numbers");
  const [x = 0, z = 0, radius = 0] = pointOf(value, biome, field, 3);
  if (radius <= 0) fail(biome, `${field}[2]`, "must be greater than 0");
  return [x, z, radius];
}

function understorey(value: unknown, biome: string): IUnderstoreySpec {
  const row = closed(value, biome, "cover.understorey", UNDERSTOREY_FIELDS);
  return {
    attempts: whole(row.attempts, biome, "cover.understorey.attempts"),
    litter: count(row.litter, biome, "cover.understorey.litter"),
    fern: count(row.fern, biome, "cover.understorey.fern"),
    bush: count(row.bush, biome, "cover.understorey.bush"),
    flower: count(row.flower, biome, "cover.understorey.flower"),
    deadfall: count(row.deadfall, biome, "cover.understorey.deadfall"),
    shade: share(row.shade, biome, "cover.understorey.shade"),
    shadeRadius: count(row.shadeRadius, biome, "cover.understorey.shadeRadius"),
  };
}

function cover(value: unknown, biome: string): ICoverSpec {
  const row = closed(value, biome, "cover", COVER_FIELDS);
  const clearings = row.clearings;
  if (!Array.isArray(clearings)) fail(biome, "cover.clearings", "must be an array");
  return {
    ground: oneOf(row.ground, biome, "cover.ground", COVER_GROUNDS),
    seed: whole(row.seed, biome, "cover.seed"),
    attempts: whole(row.attempts, biome, "cover.attempts", 1),
    stoneRadius: positive(row.stoneRadius, biome, "cover.stoneRadius"),
    clearings: clearings.map((entry, index) => clearing(entry, biome, `cover.clearings[${index}]`)),
    understorey: understorey(row.understorey, biome),
  };
}

function foliage(value: unknown, biome: string, field: string): IFoliageType {
  const row = closed(value, biome, field, FOLIAGE_FIELDS);
  const height = row.height === null ? null : pair(row.height, biome, `${field}.height`);
  return {
    species: text(row.species, biome, `${field}.species`),
    density: count(row.density, biome, `${field}.density`),
    slope: pair(row.slope, biome, `${field}.slope`, 0, 90),
    height,
    spacing: pair(row.spacing, biome, `${field}.spacing`),
    collision: oneOf(row.collision, biome, `${field}.collision`, COLLISION_CLASSES),
    stands: flag(row.stands, biome, `${field}.stands`),
    grassThreshold: share(row.grassThreshold, biome, `${field}.grassThreshold`),
    standThreshold: share(row.standThreshold, biome, `${field}.standThreshold`),
    far: far(row.far, biome, `${field}.far`),
  };
}

function grass(value: unknown, biome: string, field: string): IGrassType {
  const row = closed(value, biome, field, GRASS_FIELDS);
  const density = count(row.density, biome, `${field}.density`);
  if (density > 1) fail(biome, `${field}.density`, "must be at most 1");
  return {
    species: text(row.species, biome, `${field}.species`),
    density,
    slope: pair(row.slope, biome, `${field}.slope`, 0, 90),
    height: row.height === null ? null : pair(row.height, biome, `${field}.height`),
    spacing: positive(row.spacing, biome, `${field}.spacing`),
    slopeFalloff: count(row.slopeFalloff, biome, `${field}.slopeFalloff`),
    heightFalloff: count(row.heightFalloff, biome, `${field}.heightFalloff`),
    mats: row.mats === null ? null : band(row.mats, biome, `${field}.mats`),
    waterMargin: count(row.waterMargin, biome, `${field}.waterMargin`),
    beach: row.beach === null ? null : pair(row.beach, biome, `${field}.beach`),
    detailSpacing: positive(row.detailSpacing, biome, `${field}.detailSpacing`),
    drift: driftRow(row.drift, biome, `${field}.drift`),
    bladeScale: count(row.bladeScale, biome, `${field}.bladeScale`),
    bladeJitter: count(row.bladeJitter, biome, `${field}.bladeJitter`),
    scrubChance: share(row.scrubChance, biome, `${field}.scrubChance`),
    scrubScale: count(row.scrubScale, biome, `${field}.scrubScale`),
    scrubJitter: count(row.scrubJitter, biome, `${field}.scrubJitter`),
    scrubBush: flag(row.scrubBush, biome, `${field}.scrubBush`),
    shoreGround: flag(row.shoreGround, biome, `${field}.shoreGround`),
    cobbledBed: flag(row.cobbledBed, biome, `${field}.cobbledBed`),
  };
}

function layer(value: unknown, biome: string, field: string): ILayerInfo {
  const row = closed(value, biome, field, LAYER_FIELDS, LAYER_REQUIRED);
  const from = count(row.from, biome, `${field}.from`);
  const to = count(row.to, biome, `${field}.to`);
  if (from >= to) fail(biome, field, "must end above where it starts");
  const shedFrom =
    row.shedFrom === undefined ? undefined : count(row.shedFrom, biome, `${field}.shedFrom`, 0);
  const shedTo =
    row.shedTo === undefined ? undefined : count(row.shedTo, biome, `${field}.shedTo`, 0);
  for (const [key, entry] of [
    ["shedFrom", shedFrom],
    ["shedTo", shedTo],
  ] as const)
    if (entry !== undefined && entry > 1) fail(biome, `${field}.${key}`, "must be at most 1");
  if (shedFrom !== undefined && shedTo !== undefined && shedFrom >= shedTo)
    fail(biome, field, "must shed from a gentler slope than it sheds to");
  return {
    layer: text(row.layer, biome, `${field}.layer`),
    from,
    to,
    shedFrom,
    shedTo,
  };
}

function water(value: unknown, biome: string, field: string): IBiomeWaterBody {
  const row = closed(value, biome, field, WATER_FIELDS, WATER_REQUIRED);
  const kind = oneOf(row.kind, biome, `${field}.kind`, WATER_KINDS);
  const width = row.width === undefined ? undefined : positive(row.width, biome, `${field}.width`);
  const radius =
    row.radius === undefined ? undefined : positive(row.radius, biome, `${field}.radius`);
  const depth = row.depth === undefined ? undefined : positive(row.depth, biome, `${field}.depth`);
  const level = row.level === undefined ? undefined : count(row.level, biome, `${field}.level`);
  // A body without the measurement its kind draws is a shape the game cannot make.
  if (kind === "river" && width === undefined) fail(biome, `${field}.width`, "is missing");
  if (kind === "lake" && radius === undefined) fail(biome, `${field}.radius`, "is missing");
  if (kind === "ocean" && level === undefined) fail(biome, `${field}.level`, "is missing");
  return { kind, width, radius, depth, level };
}

function bake(value: unknown, biome: string): IBakeBundle {
  const row = closed(value, biome, "bake", BAKE_FIELDS);
  return {
    file: text(row.file, biome, "bake.file"),
    key: row.key === null ? null : text(row.key, biome, "bake.key"),
  };
}

function spawn(value: unknown, biome: string): ISpawnSpec {
  const row = closed(value, biome, "spawn", SPAWN_FIELDS);
  return {
    at: point2(row.at, biome, "spawn.at"),
    cameraOffset: point3(row.cameraOffset, biome, "spawn.cameraOffset"),
    focus: point2(row.focus, biome, "spawn.focus"),
  };
}

/** The species ids a biome holds: a non-empty list of names, each once. */
function species(value: unknown, biome: string): string[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(biome, "species", "must be a non-empty array of asset ids");
  const names = value.map((name, index) => text(name, biome, `species[${index}]`));
  for (const [index, name] of names.entries())
    if (names.indexOf(name) !== index) fail(biome, `species[${index}]`, `repeats '${name}'`);
  return names;
}

/**
 * One biome file, checked field by field. The file is `biome.data.json`: `biome.json` is Biome's own
 * configuration name, and a data file called that is parsed as a project config and fails the lint.
 * @situation read a biome's rules from `starter/<biome>/biome.data.json` before a game or a cook uses them
 * @constraint The file carries no appearance; colours, materials and shading stay game source
 * @example const spec = validateBiome(JSON.parse(text), "forest");
 * @requires npm i @threenative/terrain
 */
export function validateBiome(spec: unknown, name: string): IBiomeSpec {
  if (typeof name !== "string" || name.trim() === "")
    throw new TypeError("validateBiome needs the biome's name");
  const biome = name;
  const root = closed(spec, biome, "", SPEC_FIELDS);
  const aliases = root.aliases;
  if (!Array.isArray(aliases) || aliases.length === 0)
    fail(biome, "aliases", "must be a non-empty array of words");
  const rows = <T>(value: unknown, field: string, one: (entry: unknown, at: string) => T): T[] => {
    if (!Array.isArray(value)) fail(biome, field, "must be an array");
    return value.map((entry, index) => one(entry, `${field}[${index}]`));
  };
  return {
    look: text(root.look, biome, "look"),
    bake: bake(root.bake, biome),
    landform: oneOf(root.landform, biome, "landform", LANDFORM_KINDS),
    sizeMeters: positive(root.sizeMeters, biome, "sizeMeters"),
    seed: whole(root.seed, biome, "seed"),
    stream: oneOf(root.stream, biome, "stream", STREAMS),
    cover: cover(root.cover, biome),
    foliage: rows(root.foliage, "foliage", (entry, at) => foliage(entry, biome, at)),
    grass: rows(root.grass, "grass", (entry, at) => grass(entry, biome, at)),
    layers: rows(root.layers, "layers", (entry, at) => layer(entry, biome, at)),
    water: rows(root.water, "water", (entry, at) => water(entry, biome, at)),
    spawn: spawn(root.spawn, biome),
    species: species(root.species, biome),
    aliases: (aliases as unknown[]).map((word, index) =>
      text(word, biome, `aliases[${index}]`).toLowerCase(),
    ),
  };
}
