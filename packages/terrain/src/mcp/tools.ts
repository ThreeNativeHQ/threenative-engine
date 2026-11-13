import { lstat, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { BIOME_WORD_ROWS, biomeWordList } from "../core/biome-words.js";
import { type IBiomeSpec, type IBiomeWaterBody, validateBiome } from "../core/biome.js";
import { TERRAIN_KITS, type TerrainKit } from "../core/kits.js";
import { OPERATION_TYPES } from "../core/operations.js";
import { LANDFORMS, type LandformKind } from "../core/presets.js";
import {
  BACKDROP_WORDS,
  BIOME_OWN,
  DEFAULT_BIOME,
  FEATURE_WORD_ROWS,
  LANDFORM_BIOME,
  LANDFORM_WORD_ROWS,
  REQUEST_KNOWN_WORDS,
  REQUEST_STOP_WORDS,
  SIZE_WORD_ROWS,
  TREE_WORD_ROWS,
  WATER_WORD_ROWS,
} from "../core/request-words.js";
import type { TerrainFeature } from "../core/request-words.js";
import { MASSIFS, locationSurvey } from "../core/surveys.js";
import type { IGroundChoice, IGroundRequest } from "../core/surveys.js";
import { Terrain } from "../core/terrain.js";
import type { LayerPatch, PatchCommand } from "../core/terrain.js";
import type { ITerrainDocument, Layer } from "../core/types.js";
import { ARBOR_TREE_IDS } from "./arbor-species.js";

export { TERRAIN_KITS, type TerrainKit } from "../core/kits.js";

const ARBOR_SPECIES_NOTE = `A species named \`arbor:<preset>[@seed]\` (for example arbor:oak@7) is a procedural Arbor tree the cook bakes and scatters; needs npm i -D @threenative/procedural-vegetation; set the row's far.impostor beyond 190 m, past the tree's last LOD. Presets: ${ARBOR_TREE_IDS.join(", ")}.`;

export interface IGenerateInput {
  kit: TerrainKit;
  /** The biome's own rules, when the request carries a spec instead of a starter's file. */
  spec?: IBiomeSpec;
  /** One of `LANDFORMS`: a shape the five starters do not ship cooks from its preset. */
  landform?: LandformKind;
  sizeMeters?: number;
  seed?: number;
  /** Replaces the water bodies the biome declares: what the world floods. */
  water?: readonly IBiomeWaterBody[];
  /** Shapes carved into the ground whatever it is: a canyon's cut, a fjord's sea inlet. */
  features?: readonly TerrainFeature[];
  /** Where the ground comes from; a landform preset's own survey unless this names another source. */
  ground?: IGroundRequest;
  /** `"none"` cooks no far ring; omitted, a mountain landform on a survey gets one with a massif. */
  backdrop?: "none";
  /** The range the far ring's massif comes from, when a request word names it apart from the ground. */
  backdropRange?: LandformKind;
  /** `arbor:<preset>[@seed]`, drawn in place of the kit's tree; a request's tree word sets it. */
  treeSpecies?: string;
  out?: string;
}

/** What decided a choice: an argument the request carried, a word, or nothing at all. */
export type IRequestSource = "argument" | "default" | { readonly word: string };

/** One choice the request made, with the argument or the word that made it. */
export interface IChoice<T> {
  readonly value: T;
  readonly source: IRequestSource;
}

/** Each choice a request decides, in the order the tool reads them; `null` is "the biome's own". */
export interface IGenerateDecided {
  readonly biome: IChoice<TerrainKit>;
  readonly landform: IChoice<LandformKind | null>;
  readonly water: IChoice<readonly IBiomeWaterBody[] | null>;
  readonly sizeMeters: IChoice<number | null>;
  /** The features carved into the ground, or none. */
  readonly features: IChoice<readonly TerrainFeature[]>;
  readonly ground: IChoice<IGroundChoice>;
  /** The far ring: `"massif"` for a mountain landform cooked on a survey, else `"none"`. */
  readonly backdrop: IChoice<"massif" | "none">;
  /** The Arbor species that replaces the kit's tree (`arbor:<preset>`), or null for the kit's own. */
  readonly tree: IChoice<string | null>;
}

/** A parsed request: the cook's own input, and the record of what its words and arguments decided. */
export interface IGenerateRequest {
  readonly input: IGenerateInput;
  readonly decided: IGenerateDecided;
  /** Request words of three letters or more that named no row, in request order. */
  readonly unused: readonly string[];
}

const PATCH_OPS: readonly string[] = ["upsert", "update", "remove", "move", "toggle"];

/**
 * The `ground` argument, shared by both cook tools: the same three sources, the same closed shape.
 * A landform preset is grounded on its kind's survey unless this names another source.
 */
const GROUND_SCHEMA = {
  description:
    'Where the ground comes from. "procedural" keeps the landform preset\'s own noise; { heightmap } names a 16-bit grayscale PNG or a square .r16 file (min and max in metres, needed when the file carries no range); { location } cuts a survey at that latitude and longitude. Omitted, a landform preset is grounded on the real survey its kind names, and the result reports it as `ground` with its attribution.',
  anyOf: [
    { type: "string", enum: ["procedural"] },
    {
      type: "object",
      properties: {
        heightmap: {
          type: "string",
          description: "Path to a .png or .r16 height file, relative to the project.",
        },
        min: { type: "number", description: "Lowest elevation in the file, metres." },
        max: { type: "number", description: "Highest elevation in the file, metres." },
      },
      required: ["heightmap"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        location: {
          type: "object",
          properties: { lat: { type: "number" }, lon: { type: "number" } },
          required: ["lat", "lon"],
          additionalProperties: false,
        },
      },
      required: ["location"],
      additionalProperties: false,
    },
  ],
} as const;

export const TERRAIN_TOOLS = [
  {
    name: "terrain_generate",
    description:
      "Choose from a request, an explicit kit or a biome and cook one editable starter terrain kit (forest, coastal, alpine, desert or tundra) into a world.glb; `biome` names a starter or one of its alias words, or carries an inline IBiomeSpec whose own landform, size and seed build the ground; `landform` swaps the ground for one of the seven shape presets (alpine, temperateMountains, rollingHills, desertMesa, coastalCliffs, tundra, volcanic) and keeps the kit's surface and assets; `water` replaces the water bodies the biome declares and changes the cooked world: an ocean row floods to its level, a river or lake row re-shapes the recipe's own river or lake in order (width or radius), a recipe layer with no row is removed, and a river or lake row with no layer to take it fails. A `request`'s words also decide the landform (mountains, hills, mesa, cliffs, volcano), the water (river, lake, island, ocean), the features carved into any ground (canyon, gorge, ravine: a steep cut across it; fjord, inlet: a sea inlet into the land) and the size (huge, small: the biome's own size scaled); an explicit `landform`, `water` or `sizeMeters` wins over a word. A landform preset's ground is a real survey of the place its kind names, fetched from the AWS terrain tiles, resampled onto the recipe's grid, cooked with the attribution its source requires, and reported as `ground`; the preset's erosion and grain still run on top of it. `ground` replaces that choice: \"procedural\" cooks the preset's own noise, { heightmap } reads a 16-bit grayscale PNG or a square .r16 grid, { location } cuts a survey at a latitude and longitude. An alpine or temperateMountains world on a survey also writes ring.json, its survey continued to ten times the world's size with one real whole mountain from that range past the square, reported as `backdrop`; `backdrop: \"none\"` cooks none. The result's `decided` names each choice with the word behind it or `argument`, and `unused` lists the request words that named nothing. A request that names only a starter (no shape, water, feature, size, seed or ground of its own) is that starter as shipped, judged and measured, reported as `source: \"catalog:<kit>\"`; anything else is `\"cooked\"`. The reply's `seed` is the seed the world was cooked with: pass another `seed` for a variation of the same request. A request repeated in the same project is copied from its cook cache (`node_modules/.cache/threenative-terrain`) and reported as `cache: \"hit\"`. Returns the kit as recipe, the biome it bakes, the water bodies the cooked world floods, measured from the evaluated state as `water.json` records them, its band rows resolved against the cooked heights (`bands`), the world.glb, recipe.json and world.json paths, triangles, instances and draws measured from the produced GLB's default scene, a ctx.assets.model load snippet, and `grass`: the lines that grow the biome's grass rows as a streamed, swaying GrassField3D on the cooked ground through grassFieldFromBiome (null when the biome has no grass row; the blade and material come from the game's src/render/grass.ts). triangles counts every instance of the LOD0 default scene in full, before distance LOD and culling, instances sums the EXT_mesh_gpu_instancing instances, and draws counts primitives across instanced and non-instanced meshes, an instanced primitive counting once.",
    inputSchema: {
      type: "object",
      properties: {
        kit: { type: "string", enum: [...TERRAIN_KITS] },
        biome: {
          description: `A starter biome's name or alias word (forest, woods, beach, ...), or an inline IBiomeSpec object; a spec cooks with \`kit\`'s surface and assets, forest's when kit is absent. ${ARBOR_SPECIES_NOTE}`,
          anyOf: [{ type: "string", minLength: 1 }, { type: "object" }],
        },
        landform: { type: "string", enum: Object.keys(LANDFORMS) },
        request: {
          type: "string",
          minLength: 1,
          description:
            "What the world should be, in any words: a biome, a landform (mountains, hills, canyon, volcano, fjord, ...), water (river, lake, sea, ...) and a size (huge, small); an explicit argument wins over a word. A request with no biome word takes the biome its sea or shape suits, else the forest; `decided` names the word behind each choice and `unused` the words that named nothing. A tree word (oak, birch, aspen, cedar, maple, cypress, olive, acacia, baobab, palm, bamboo, cactus, ...) cooks that Arbor species in place of the kit's tree and is reported as `decided.tree`; a spec's own species rows win. A real place's name is not geocoded: pass its latitude and longitude as `ground: { location }` to cook that place's survey.",
        },
        sizeMeters: { type: "number", exclusiveMinimum: 0 },
        seed: { type: "integer" },
        water: {
          type: "array",
          items: { type: "object" },
          description:
            "IBiomeWaterBody rows that replace the biome's declared water: river (width), lake (radius), ocean (level).",
        },
        ground: GROUND_SCHEMA,
        backdrop: {
          type: "string",
          enum: ["none"],
          description:
            '"none" cooks no far ring. Omitted, an alpine or temperateMountains world on a survey gets ring.json: its survey continued to ten times the world\'s size, with one real whole mountain (a seeded pick, pose and height) standing past the playable square.',
        },
        out: {
          type: "string",
          description:
            "Relative directory under the project's assets.source that must not exist yet; the default is assets.source/worlds/<kit>.",
        },
      },
      anyOf: [{ required: ["request"] }, { required: ["kit"] }, { required: ["biome"] }],
      additionalProperties: false,
    },
  },
  {
    name: "terrain_biome_new",
    description:
      "Make a new biome from a shipped one and cook it: copies the base biome's biome.data.json into <assets.source>/biomes/<name>/, applies the overrides, validates the file with validateBiome, then cooks it with the base kit's surface and assets and the biome's own landform preset. One call writes only under <assets.source>/biomes/<name>/, its cooked world included. Its ground comes from the biome's landform, the real survey that kind names unless `ground` names another source. Returns the same cook result as terrain_generate plus the biome file path and the biome's resolved `bands`. No code changes anywhere: the biome is data.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", enum: [...TERRAIN_KITS] },
        name: {
          type: "string",
          pattern: "^[a-z][a-z0-9-]{0,31}$",
          description: "The new biome's folder and look name; lowercase, no spaces.",
        },
        overrides: {
          type: "object",
          description: `IBiomeSpec fields to change on the base file (landform, foliage, grass, layers, water, spawn, species, aliases, bake). An unknown field fails. ${ARBOR_SPECIES_NOTE}`,
        },
        ground: GROUND_SCHEMA,
        out: {
          type: "string",
          description:
            "Relative directory under the project's assets.source that must not exist yet; the default is assets.source/biomes/<name>/world.",
        },
      },
      required: ["from", "name"],
      additionalProperties: false,
    },
  },
  {
    name: "terrain_patch",
    description:
      "Apply editor commands (upsert, update, remove, move, toggle) to a terrain recipe and return the edited recipe.",
    inputSchema: {
      type: "object",
      properties: {
        recipe: { type: "object" },
        commands: { type: "array", items: { type: "object" } },
      },
      required: ["recipe", "commands"],
      additionalProperties: false,
    },
  },
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Rejects any field the tool does not declare, so a typo never falls back to a default. */
function closedRecord(
  input: unknown,
  tool: string,
  fields: readonly string[],
): Record<string, unknown> {
  if (!isRecord(input)) throw new TypeError(`${tool}: arguments must be an object.`);
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new TypeError(`${tool}: unknown field '${key}'.`);
  }
  return input;
}

function relativeDirectory(out: unknown): string {
  if (
    typeof out !== "string" ||
    out.trim() === "" ||
    isAbsolute(out) ||
    out.split(/[\\/]/).includes("..")
  ) {
    throw new TypeError("terrain_generate: out must be a relative directory inside the project.");
  }
  return out;
}

const GENERATE_FIELDS = [
  "request",
  "kit",
  "biome",
  "landform",
  "sizeMeters",
  "seed",
  "water",
  "ground",
  "backdrop",
  "out",
];
const BIOME_NEW_FIELDS = ["from", "name", "overrides", "ground", "out"];

/** A new biome's folder name, and the look it will resolve under the game it is baked for. */
export interface IBiomeNewInput {
  from: TerrainKit;
  name: string;
  overrides?: Record<string, unknown>;
  /** The ground the cooked world starts from, as on `terrain_generate`. */
  ground?: IGroundRequest;
  out?: string;
}

const LANDFORM_KINDS = Object.keys(LANDFORMS) as readonly LandformKind[];

/**
 * The `biome` argument: a starter's name or one of its alias words resolves the kit, and an inline
 * `IBiomeSpec` carries the biome's own rules. Anything else fails naming what this field accepts.
 */
function parseBiomeArgument(biome: unknown): { kit?: TerrainKit; spec?: IBiomeSpec } {
  if (biome === undefined) return {};
  if (typeof biome === "string") {
    const word = biome.trim().toLowerCase();
    const kit = BIOME_WORD_ROWS.find(([, names]) => names.includes(word))?.[0];
    if (kit === undefined) {
      throw new TypeError(
        `terrain_generate: biome '${biome}' matches no biome. Try one of: ${biomeWordList()}.`,
      );
    }
    return { kit };
  }
  if (isRecord(biome)) {
    const look = biome.look;
    return { spec: validateBiome(biome, typeof look === "string" ? look : "biome") };
  }
  throw new TypeError(
    "terrain_generate: biome must be a starter name, an alias word or a biome spec object.",
  );
}

/** The `landform` argument: one of the seven presets, or nothing. */
function parseLandform(value: unknown): LandformKind | undefined {
  if (value === undefined) return undefined;
  if (!LANDFORM_KINDS.includes(value as LandformKind))
    throw new TypeError(`terrain_generate: landform must be one of ${LANDFORM_KINDS.join(", ")}.`);
  return value as LandformKind;
}

/** The `sizeMeters` argument: the world's own size in metres, or nothing. */
function parseSize(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    throw new TypeError("terrain_generate: sizeMeters must be a positive finite number.");
  return value;
}

/** `water` replaces the biome's declared bodies; the rows themselves are checked at the bake. */
function parseWater(water: unknown): readonly IBiomeWaterBody[] | undefined {
  if (water === undefined) return undefined;
  if (!Array.isArray(water) || water.some((body) => !isRecord(body))) {
    throw new TypeError("terrain_generate: water must be an array of water body objects.");
  }
  return water as readonly IBiomeWaterBody[];
}

/**
 * The `ground` argument: "procedural", a heightmap file, or a latitude and longitude. Closed to those
 * three forms, so a misspelt source fails here instead of cooking the default it did not ask for.
 */
function parseGround(value: unknown, tool: string): IGroundRequest | undefined {
  if (value === undefined) return undefined;
  if (value === "procedural") return "procedural";
  const forms = `${tool}: ground must be "procedural", { heightmap } or { location }.`;
  if (!isRecord(value)) throw new TypeError(forms);
  for (const key of Object.keys(value)) {
    if (!["heightmap", "location", "min", "max"].includes(key)) {
      throw new TypeError(`${tool}: ground field '${key}' is not a ground source.`);
    }
  }
  const { heightmap, location, min, max } = value;
  if (heightmap !== undefined) {
    if (typeof heightmap !== "string" || !/\.(png|r16)$/iu.test(heightmap)) {
      throw new TypeError(`${tool}: ground.heightmap must name a .png or .r16 file.`);
    }
    if ((min === undefined) !== (max === undefined)) {
      throw new TypeError(`${tool}: ground.heightmap needs min and max together, in metres.`);
    }
    if (min !== undefined && max !== undefined) {
      if (
        typeof min !== "number" ||
        typeof max !== "number" ||
        !Number.isFinite(min) ||
        !Number.isFinite(max)
      )
        throw new TypeError(`${tool}: ground.heightmap min and max must be finite metres.`);
      if (max <= min) throw new TypeError(`${tool}: ground.heightmap max must exceed min.`);
      return { heightmap, min, max };
    }
    return { heightmap };
  }
  if (location !== undefined) {
    if (!isRecord(location) || Object.keys(location).some((key) => !["lat", "lon"].includes(key))) {
      throw new TypeError(`${tool}: ground.location must be { lat, lon }.`);
    }
    const { lat, lon } = location;
    if (typeof lat !== "number" || typeof lon !== "number") {
      throw new TypeError(`${tool}: ground.location lat and lon must be numbers.`);
    }
    // The row a bare coordinate builds is validated here too, so a bad coordinate never reaches a fetch.
    locationSurvey(lat, lon);
    return { location: { lat, lon } };
  }
  throw new TypeError(forms);
}

/**
 * The first row a request names, in table order, with the word that named it: the tables decide
 * ties, and the record names the word the caller wrote first, so it reads back like the request.
 */
/** Whether `word` follows a backdrop word ("under", "below", ...), with at most "the" between. */
function backdropWordAt(words: readonly string[], word: string): boolean {
  const at = words.indexOf(word);
  const before = words[at - 1] === "the" ? words[at - 2] : words[at - 1];
  return before !== undefined && BACKDROP_WORDS.includes(before);
}

function rowHit<ROW>(
  rows: readonly (readonly [ROW, readonly string[]])[],
  words: readonly string[],
): { readonly row: ROW; readonly word: string } | undefined {
  for (const [row, names] of rows) {
    const word = words.find((candidate) => names.includes(candidate));
    if (word !== undefined) return { row, word };
  }
  return undefined;
}

/** Whether the biome already declares this body, kind and measurement alike. */
function declaredWater(rows: readonly IBiomeWaterBody[], row: IBiomeWaterBody): boolean {
  return rows.some(
    (own) =>
      own.kind === row.kind &&
      own.width === row.width &&
      own.radius === row.radius &&
      own.level === row.level,
  );
}

/**
 * One `terrain_generate` request, read whole: the cook's input, and the record of what decided each
 * choice. The biome comes from a word as it always has; the request's words also name the landform,
 * the water and the size, in the order `request-words.ts` lists them.
 *
 * An argument always wins over a word. A spec is argued too, because it is the biome's whole
 * declaration: a word fills a choice the caller left open, never one an argument already made.
 */
export function parseGenerateRequest(input: unknown): IGenerateRequest {
  const args = closedRecord(input, "terrain_generate", GENERATE_FIELDS);
  const { request, sizeMeters, seed, out } = args;
  if (request !== undefined && (typeof request !== "string" || request.trim() === "")) {
    throw new TypeError("terrain_generate: request must be a non-empty string.");
  }
  if (request === undefined && args.kit === undefined && args.biome === undefined) {
    throw new TypeError("terrain_generate: give a request, a kit or a biome.");
  }
  const words = typeof request === "string" ? request.toLowerCase().split(/[^a-z]+/u) : [];
  const { kit: biomeKit, spec } = parseBiomeArgument(args.biome);
  const biomeWord = rowHit(BIOME_WORD_ROWS, words);
  const arguedKit = args.kit ?? biomeKit;
  // A request that names no biome still names a world: its sea or its shape picks the starter whose
  // surface suits it, and with neither the forest cooks. `decided.biome` says which word chose it.
  let inferred: { readonly kit: TerrainKit; readonly word: string } | undefined;
  if (arguedKit === undefined && spec === undefined && biomeWord === undefined) {
    // The sea row by kind, not the first water word: "an island with a lake" still names a sea.
    const sea = rowHit(
      WATER_WORD_ROWS.filter(([row]) => row.kind === "ocean"),
      words,
    );
    const shape = rowHit(LANDFORM_WORD_ROWS, words);
    if (sea !== undefined) inferred = { kit: "coastal", word: sea.word };
    else if (shape !== undefined && !backdropWordAt(words, shape.word))
      inferred = { kit: LANDFORM_BIOME[shape.row], word: shape.word };
  }
  const kit =
    arguedKit ??
    // A spec carries no appearance, so it cooks with the forest starter's surface and assets.
    (spec === undefined ? (biomeWord?.row ?? inferred?.kit ?? DEFAULT_BIOME) : "forest");
  if (typeof kit !== "string" || !(TERRAIN_KITS as readonly string[]).includes(kit)) {
    throw new TypeError(
      `terrain_generate: kit must be one of ${TERRAIN_KITS.join(", ")}. Words a request may use: ${biomeWordList()}.`,
    );
  }
  const parsed: IGenerateInput = { kit: kit as TerrainKit };
  if (spec !== undefined) parsed.spec = spec;
  const own = BIOME_OWN[kit as TerrainKit];
  // The three choices, read in the order `request-words.ts` lists them. An argument wins over a
  // word, a spec declares all three, and a word that names what the biome already declares leaves
  // the starter's own ground, water and size alone: only a different choice replaces them.
  const landformArgument = parseLandform(args.landform);
  const landformWord = rowHit(LANDFORM_WORD_ROWS, words);
  let landform: IChoice<LandformKind | null>;
  if (landformArgument !== undefined) {
    parsed.landform = landformArgument;
    landform = { value: landformArgument, source: "argument" };
  } else if (spec !== undefined) {
    landform = { value: spec.landform, source: "argument" };
  } else if (landformWord === undefined) {
    landform = { value: null, source: "default" };
  } else if (backdropWordAt(words, landformWord.word)) {
    // "under mountains": the ground stays the kit's own landform, cut from its survey so a seed moves
    // it, and the word's range stands past the square.
    parsed.landform = own.landform;
    parsed.backdropRange = landformWord.row;
    landform = { value: own.landform, source: "default" };
  } else {
    landform = { value: landformWord.row, source: { word: landformWord.word } };
    if (landformWord.row !== own.landform) parsed.landform = landformWord.row;
  }
  const waterWord = rowHit(WATER_WORD_ROWS, words);
  const waterArgument = parseWater(args.water);
  let water: IChoice<readonly IBiomeWaterBody[] | null>;
  if (waterArgument !== undefined) {
    parsed.water = waterArgument;
    water = { value: waterArgument, source: "argument" };
  } else if (spec !== undefined) {
    water = { value: spec.water, source: "argument" };
  } else if (waterWord === undefined) {
    water = { value: null, source: "default" };
  } else {
    // Every body the request names, once each: "a volcanic island with a lake" is a sea and a lake.
    const bodies = WATER_WORD_ROWS.filter(([, names]) => words.some((w) => names.includes(w))).map(
      ([row]) => row,
    );
    if (parsed.landform === undefined && bodies.every((row) => declaredWater(own.water, row))) {
      // The biome's authored recipe is the world, and it already floods these bodies: the words name them.
      water = { value: own.water, source: { word: waterWord.word } };
    } else {
      parsed.water = bodies;
      water = { value: parsed.water, source: { word: waterWord.word } };
    }
  }
  const sizeArgument = parseSize(sizeMeters);
  const sizeWord = rowHit(SIZE_WORD_ROWS, words);
  let size: IChoice<number | null>;
  if (sizeArgument !== undefined) {
    parsed.sizeMeters = sizeArgument;
    size = { value: sizeArgument, source: "argument" };
  } else if (spec !== undefined) {
    size = { value: spec.sizeMeters, source: "argument" };
  } else if (sizeWord === undefined) {
    size = { value: null, source: "default" };
  } else {
    // A size word scales the biome's own size, so the word never invents a world size of its own.
    parsed.sizeMeters = Math.round(own.sizeMeters * sizeWord.row);
    size = { value: parsed.sizeMeters, source: { word: sizeWord.word } };
  }
  const featureHits = FEATURE_WORD_ROWS.flatMap(([feature, names]) => {
    const word = words.find((w) => names.includes(w));
    return word === undefined ? [] : [{ feature, word }];
  });
  let features: IChoice<readonly TerrainFeature[]> = { value: [], source: "default" };
  if (featureHits.length > 0) {
    parsed.features = featureHits.map((hit) => hit.feature);
    features = {
      value: parsed.features,
      source: { word: (featureHits[0] as { word: string }).word },
    };
  }
  // The ground a preset cooks, unless the request names another source: a preset is grounded on its
  // kind's survey, and a starter keeps the crop it authored (which is a survey of its own). The kind
  // is the cook's own rule, not the word that named it: a word naming the biome's authored landform
  // leaves the starter's recipe alone, so its ground is the starter's crop, not a fetched survey.
  const groundArgument = parseGround(args.ground, "terrain_generate");
  const presetKind = parsed.landform ?? (spec === undefined ? undefined : spec.landform);
  let ground: IChoice<IGroundChoice>;
  if (groundArgument !== undefined) {
    parsed.ground = groundArgument;
    ground = { value: groundArgument, source: "argument" };
  } else {
    ground = { value: presetKind === undefined ? "starter" : "survey", source: "default" };
  }
  // The far ring follows the ground: only a mountain preset that stands on a real survey has a range
  // to continue, so a procedural or file ground cooks none and fetches nothing more.
  let backdrop: IChoice<"massif" | "none">;
  if (args.backdrop !== undefined) {
    if (args.backdrop !== "none")
      throw new TypeError('terrain_generate: backdrop must be "none" when given.');
    parsed.backdrop = "none";
    backdrop = { value: "none", source: "argument" };
  } else {
    const surveyed =
      ground.value === "survey" || (typeof ground.value === "object" && "location" in ground.value);
    const range = parsed.backdropRange ?? presetKind;
    const mountain = range !== undefined && MASSIFS[range] !== undefined;
    backdrop = { value: surveyed && mountain ? "massif" : "none", source: "default" };
  }
  // A spec declares its own species rows, so only a request with no spec takes a tree word.
  const treeWord = spec === undefined ? rowHit(TREE_WORD_ROWS, words) : undefined;
  let tree: IChoice<string | null> = { value: null, source: "default" };
  if (treeWord !== undefined) {
    parsed.treeSpecies = `arbor:${treeWord.row}`;
    tree = { value: parsed.treeSpecies, source: { word: treeWord.word } };
  }
  if (seed !== undefined) {
    if (typeof seed !== "number" || !Number.isSafeInteger(seed)) {
      throw new TypeError("terrain_generate: seed must be a safe integer.");
    }
    parsed.seed = seed;
  }
  if (out !== undefined) parsed.out = relativeDirectory(out);
  let biomeSource: IRequestSource = "default";
  if (arguedKit !== undefined) biomeSource = "argument";
  else if (biomeWord !== undefined) biomeSource = { word: biomeWord.word };
  else if (inferred !== undefined) biomeSource = { word: inferred.word };
  return {
    input: parsed,
    decided: {
      biome: { value: kit as TerrainKit, source: biomeSource },
      landform,
      water,
      sizeMeters: size,
      features,
      ground,
      backdrop,
      tree,
    },
    // What is left is what the tool could not act on: a retry names a word, not a guess.
    unused: [...new Set(words)].filter(
      (word) => word.length >= 3 && !REQUEST_STOP_WORDS.has(word) && !REQUEST_KNOWN_WORDS.has(word),
    ),
  };
}

/** The cook's own input, without the record of what decided it. */
export function parseGenerateInput(input: unknown): IGenerateInput {
  return parseGenerateRequest(input).input;
}

/**
 * A `terrain_biome_new` request: a shipped base, a folder-safe new name, an optional set of spec
 * overrides and an optional output directory.
 */
export function parseBiomeNewInput(input: unknown): IBiomeNewInput {
  const args = closedRecord(input, "terrain_biome_new", BIOME_NEW_FIELDS);
  const from = args.from;
  if (typeof from !== "string" || !(TERRAIN_KITS as readonly string[]).includes(from))
    throw new TypeError(`terrain_biome_new: from must be one of ${TERRAIN_KITS.join(", ")}.`);
  const name = args.name;
  if (typeof name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/u.test(name))
    throw new TypeError(
      "terrain_biome_new: name must be lowercase letters, digits and dashes, starting with a letter.",
    );
  // A shipped kit's folder belongs to the package; a new biome must not shadow or overwrite one.
  if ((TERRAIN_KITS as readonly string[]).includes(name))
    throw new TypeError(`terrain_biome_new: '${name}' is a shipped biome; choose a new name.`);
  const overrides = args.overrides;
  if (overrides !== undefined && !isRecord(overrides))
    throw new TypeError("terrain_biome_new: overrides must be an object.");
  const parsed: IBiomeNewInput = { from: from as TerrainKit, name };
  if (overrides !== undefined) parsed.overrides = { ...overrides };
  const ground = parseGround(args.ground, "terrain_biome_new");
  if (ground !== undefined) parsed.ground = ground;
  if (args.out !== undefined) parsed.out = relativeDirectory(args.out);
  return parsed;
}

/**
 * A new biome's file: the base spec with the request's overrides applied, its `look` and first
 * `aliases` word defaulting to the new name. Validated, so an override the schema does not have
 * fails here and names the field rather than reaching a bake.
 */
export function newBiomeSpec(
  base: unknown,
  name: string,
  overrides: Record<string, unknown> = {},
): IBiomeSpec {
  return validateBiome(
    {
      ...(base as Record<string, unknown>),
      ...overrides,
      aliases: (overrides.aliases as string[] | undefined) ?? [name],
      look: (overrides.look as string | undefined) ?? name,
    },
    name,
  );
}

/**
 * Resolves `out` under `root` and fails closed unless the real path stays inside the real root.
 * The deepest existing ancestor is resolved through `realpath`, so a symlinked `out` or a symlinked
 * ancestor that leaves the root is rejected, as is a dangling link. Returns the verified real path.
 * With `assetSource`, the same guard requires `out` under it: the cook writes a manifest the build
 * reads, and a directory outside `assets.source` never reaches that manifest.
 */
export async function resolveOutput(
  root: string,
  out: string,
  assetSource?: string,
): Promise<string> {
  const realRoot = await realpath(root);
  let existing = resolve(realRoot, out);
  const tail: string[] = [];
  for (;;) {
    try {
      existing = await realpath(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // ENOENT on a path that lstat finds is a dangling symlink, which a mkdir would follow.
      if (
        await lstat(existing).then(
          () => true,
          () => false,
        )
      ) {
        throw new Error(`terrain_generate: out '${out}' passes through a dangling symlink.`);
      }
      tail.unshift(basename(existing));
      existing = dirname(existing);
    }
  }
  const real = join(existing, ...tail);
  const inside = relative(realRoot, real);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new Error(`terrain_generate: out '${out}' resolves outside the project.`);
  }
  if (assetSource !== undefined) {
    const under = relative(assetSource, real);
    if (under === "" || under === ".." || under.startsWith(`..${sep}`) || isAbsolute(under))
      throw new Error(
        `terrain_generate: out '${out}' must be under assets.source ('${relative(realRoot, assetSource)}') so the build lists the world in its manifest.`,
      );
  }
  await assertOutputFree(real);
  return real;
}

/** Fails closed when the output directory already exists, so a cook never replaces files. */
export async function assertOutputFree(dir: string): Promise<void> {
  const entries = await readdir(dir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (entries !== undefined) {
    throw new Error(`terrain_generate: out '${dir}' already exists; choose a new directory.`);
  }
}

function isTerrainDocument(input: unknown): input is ITerrainDocument {
  Terrain.fromJSON(JSON.stringify(input));
  return true;
}

function isLayer(input: unknown): input is Layer {
  isTerrainDocument({ version: 1, config: new Terrain().config, layers: [input] });
  return true;
}

function isLayerPatch(
  patch: Record<string, unknown>,
): patch is Record<string, unknown> & LayerPatch {
  if (patch.mask !== undefined && patch.mask !== null) {
    isLayer({ id: "validation", type: "noise", params: {}, mask: patch.mask });
  }
  return (
    (patch.type === undefined || OPERATION_TYPES.some((type) => type === patch.type)) &&
    (patch.name === undefined || typeof patch.name === "string") &&
    (patch.enabled === undefined || typeof patch.enabled === "boolean") &&
    (patch.opacity === undefined ||
      (typeof patch.opacity === "number" && Number.isFinite(patch.opacity))) &&
    (patch.params === undefined || isRecord(patch.params))
  );
}

function parseCommand(command: unknown, index: number): PatchCommand {
  if (!isRecord(command) || !PATCH_OPS.includes(command.op as string)) {
    throw new TypeError(
      `terrain_patch: command ${index} op must be one of ${PATCH_OPS.join(", ")}.`,
    );
  }
  if (command.op === "upsert") {
    if (!isRecord(command.layer)) {
      throw new TypeError(`terrain_patch: command ${index} needs a layer object.`);
    }
    if (!isLayer(command.layer)) {
      throw new TypeError(`terrain_patch: command ${index} needs a valid layer.`);
    }
    return { ...command, op: "upsert", layer: command.layer };
  }
  if (typeof command.id !== "string") {
    throw new TypeError(`terrain_patch: command ${index} needs a layer id.`);
  }
  const id = command.id;
  switch (command.op) {
    case "update": {
      if (!isRecord(command.patch) || !isLayerPatch(command.patch)) {
        throw new TypeError(`terrain_patch: command ${index} needs a valid patch object.`);
      }
      return { ...command, op: "update", id, patch: command.patch };
    }
    case "move":
      if (typeof command.index !== "number" || !Number.isInteger(command.index)) {
        throw new TypeError(`terrain_patch: command ${index} needs an integer index.`);
      }
      return { ...command, op: "move", id, index: command.index };
    case "toggle":
      if (command.enabled !== undefined && typeof command.enabled !== "boolean") {
        throw new TypeError(`terrain_patch: command ${index} enabled must be a boolean.`);
      }
      return { ...command, op: "toggle", id };
    case "remove":
      return { ...command, op: "remove", id };
    default:
      throw new TypeError(`terrain_patch: command ${index} has an unknown op.`);
  }
}

export function parsePatchInput(input: unknown): {
  recipe: ITerrainDocument;
  commands: PatchCommand[];
} {
  const args = closedRecord(input, "terrain_patch", ["recipe", "commands"]);
  if (!isRecord(args.recipe)) {
    throw new TypeError("terrain_patch: recipe must be a terrain document object.");
  }
  if (!Array.isArray(args.commands)) {
    throw new TypeError("terrain_patch: commands must be an array.");
  }
  if (!isTerrainDocument(args.recipe)) {
    throw new TypeError("terrain_patch: recipe must be a valid terrain document.");
  }
  const commands = args.commands.map(parseCommand);
  patchRecipe(args.recipe, commands);
  return { recipe: args.recipe, commands };
}

/** Applies commands in one editor transaction and returns the edited recipe document. */
export function patchRecipe(
  recipe: ITerrainDocument,
  commands: readonly PatchCommand[],
): ITerrainDocument {
  return Terrain.fromJSON(recipe).applyPatch(commands).toJSON() as ITerrainDocument;
}

/** Read the same TypeScript config the game builds, using its installed Vite loader. */
export async function resolveAssetSource(projectRoot: string): Promise<string> {
  const configFile = join(projectRoot, "threenative.config.ts");
  const exists = await lstat(configFile).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  let source: unknown = "assets";
  if (exists) {
    const { loadConfigFromFile } = await import("vite");
    const loaded = await loadConfigFromFile(
      { command: "build", mode: "production" },
      configFile,
      projectRoot,
    );
    const assets: unknown = (loaded?.config as Record<string, unknown> | undefined)?.assets;
    if (assets !== undefined) {
      if (!isRecord(assets)) throw new TypeError("terrain_generate: assets must be an object.");
      source = assets.source === undefined ? "assets" : assets.source;
    }
  }
  if (typeof source !== "string" || source.trim() === "") {
    throw new TypeError("terrain_generate: assets.source must be a non-empty path.");
  }
  const configuredRoot = resolve(projectRoot, source);
  const sourceRoot = await realpath(configuredRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return configuredRoot;
    throw error;
  });
  const inside = relative(projectRoot, sourceRoot);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
    throw new TypeError("terrain_generate: assets.source must be inside the project.");
  }
  return sourceRoot;
}
