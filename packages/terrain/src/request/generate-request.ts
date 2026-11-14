import { type IBiomeSpec, type IBiomeWaterBody, validateBiome } from "../biome/biome.js";
import { TERRAIN_KITS, type TerrainKit } from "../biome/kits.js";
import { LANDFORMS, type LandformKind } from "../ground/presets.js";
import { type IGroundChoice, type IGroundRequest, MASSIFS } from "../ground/surveys.js";
import { closedRecord, isRecord, parseGround, relativeDirectory } from "./args.js";
import { BIOME_WORD_ROWS, biomeWordList } from "./biome-words.js";
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
} from "./request-words.js";
import type { TerrainFeature } from "./request-words.js";

// The request layer: a request's words and arguments to one decided cook input, with the record of
// what decided each choice. Nothing here evaluates a ground or writes a file.

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
