import { LANDFORMS, type LandformKind } from "./presets.js";

/**
 * A biome as a data file: the rules one world grows by, and no appearance at all.
 *
 * A biome says which landform and seed it was generated from, which trees, grass and ground bands
 * it holds, which water it floods, where it puts the player and the detail, the words a request may
 * use for it, and the *name* of the look it is graded under. It carries no colour, no material and
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
  /** Mean spacing just past the edge, and where the far spacing is reached. */
  readonly spacing: readonly [number, number];
  /** Slope fade, degrees. */
  readonly slope: readonly [number, number];
  /** Chevron distance from the origin beyond which nothing is planted. */
  readonly reach: number;
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
  readonly landform: LandformKind;
  readonly sizeMeters: number;
  readonly seed: number;
  readonly foliage: readonly IFoliageType[];
  readonly grass: readonly IGrassType[];
  readonly layers: readonly ILayerInfo[];
  readonly water: readonly IBiomeWaterBody[];
  readonly spawn: ISpawnSpec;
  /** The words a request may use for this biome; its own name comes first. */
  readonly aliases: readonly string[];
}

const SPEC_FIELDS = [
  "look",
  "landform",
  "sizeMeters",
  "seed",
  "foliage",
  "grass",
  "layers",
  "water",
  "spawn",
  "aliases",
] as const;
const FOLIAGE_FIELDS = [
  "species",
  "density",
  "slope",
  "height",
  "spacing",
  "collision",
  "far",
] as const;
const FAR_FIELDS = ["cell", "spacing", "slope", "reach", "impostor"] as const;
const GRASS_FIELDS = ["species", "density", "slope", "height", "spacing"] as const;
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
function interval(
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

/** A point in world metres: `size` finite numbers, in no order. */
function point(value: unknown, biome: string, field: string, size: number): readonly number[] {
  if (!Array.isArray(value) || value.length !== size)
    fail(biome, field, `must be an array of ${size} numbers`);
  return value.map((entry, index) => {
    if (typeof entry !== "number" || !Number.isFinite(entry))
      fail(biome, `${field}[${index}]`, "must be a finite number");
    return entry;
  });
}

function far(value: unknown, biome: string, field: string): IFarFieldRule | null {
  if (value === null) return null;
  const far = closed(value, biome, field, FAR_FIELDS);
  return {
    cell: positive(far.cell, biome, `${field}.cell`),
    spacing: interval(far.spacing, biome, `${field}.spacing`, 2) as unknown as readonly [
      number,
      number,
    ],
    slope: interval(far.slope, biome, `${field}.slope`, 2, 0, 90) as unknown as readonly [
      number,
      number,
    ],
    reach: positive(far.reach, biome, `${field}.reach`),
    impostor: count(far.impostor, biome, `${field}.impostor`),
  };
}

function foliage(value: unknown, biome: string, field: string): IFoliageType {
  const row = closed(value, biome, field, FOLIAGE_FIELDS);
  const height =
    row.height === null
      ? null
      : (interval(row.height, biome, `${field}.height`, 2) as unknown as readonly [number, number]);
  return {
    species: text(row.species, biome, `${field}.species`),
    density: count(row.density, biome, `${field}.density`),
    slope: interval(row.slope, biome, `${field}.slope`, 2, 0, 90) as unknown as readonly [
      number,
      number,
    ],
    height,
    spacing: interval(row.spacing, biome, `${field}.spacing`, 2) as unknown as readonly [
      number,
      number,
    ],
    collision: oneOf(row.collision, biome, `${field}.collision`, COLLISION_CLASSES),
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
    slope: interval(row.slope, biome, `${field}.slope`, 2, 0, 90) as unknown as readonly [
      number,
      number,
    ],
    height:
      row.height === null
        ? null
        : (interval(row.height, biome, `${field}.height`, 2) as unknown as readonly [
            number,
            number,
          ]),
    spacing: positive(row.spacing, biome, `${field}.spacing`),
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

function spawn(value: unknown, biome: string): ISpawnSpec {
  const row = closed(value, biome, "spawn", SPAWN_FIELDS);
  return {
    at: point(row.at, biome, "spawn.at", 2) as unknown as readonly [number, number],
    cameraOffset: point(row.cameraOffset, biome, "spawn.cameraOffset", 3) as unknown as readonly [
      number,
      number,
      number,
    ],
    focus: point(row.focus, biome, "spawn.focus", 2) as unknown as readonly [number, number],
  };
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
    landform: oneOf(root.landform, biome, "landform", LANDFORM_KINDS),
    sizeMeters: positive(root.sizeMeters, biome, "sizeMeters"),
    seed: whole(root.seed, biome, "seed"),
    foliage: rows(root.foliage, "foliage", (entry, at) => foliage(entry, biome, at)),
    grass: rows(root.grass, "grass", (entry, at) => grass(entry, biome, at)),
    layers: rows(root.layers, "layers", (entry, at) => layer(entry, biome, at)),
    water: rows(root.water, "water", (entry, at) => water(entry, biome, at)),
    spawn: spawn(root.spawn, biome),
    aliases: (aliases as unknown[]).map((word, index) =>
      text(word, biome, `aliases[${index}]`).toLowerCase(),
    ),
  };
}
