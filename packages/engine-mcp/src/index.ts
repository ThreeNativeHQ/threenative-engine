import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import {
  type IReferenceIndex,
  loadLocalReferenceGames,
  loadReferenceGame,
  loadReferenceIndex,
  loadReleaseReferenceGame,
  referenceStubs,
  saveReferenceGame,
  watchReference,
} from "./references.js";

export interface ICapabilityEntry {
  readonly symbol: string;
  readonly package: string;
  readonly importPath: string;
  readonly kind: string;
  readonly signature: string;
  readonly summary: string;
  readonly situations: readonly string[];
  readonly aliases: readonly string[];
  readonly example: string;
  readonly constraints: readonly string[];
  readonly overrides?: readonly string[];
  readonly requires?: readonly string[];
  /** Absent unless something on this entry is deprecated; each string names what, and what to use. */
  readonly deprecated?: readonly string[];
}

export interface INotOwnedCapability {
  readonly id: string;
  readonly situations: readonly string[];
  readonly guidance: string;
}

export interface ICapabilityManifest {
  readonly version: number;
  readonly entries: readonly ICapabilityEntry[];
  readonly notOwned: readonly INotOwnedCapability[];
  readonly starterKits?: readonly IStarterKit[];
}

export interface IStarterKit {
  readonly name: string;
  readonly title: string;
  readonly blurb: string;
  /** Genre plus kit.json aliases, lowercase. */
  readonly words: readonly string[];
}

export interface IStarterKitResult {
  readonly name: string;
  readonly title: string;
  readonly blurb: string;
  readonly command: string;
}

/**
 * One search answer, equal to the capability detail minus `situations` and `aliases`. `signature`,
 * `overrides` and `deprecated` were the three fields a row lacked, so every hit cost a detail call
 * that added nothing else an author works from.
 */
export interface ICapabilitySearchResult {
  readonly symbol: string;
  readonly importPath: string;
  readonly signature: string;
  readonly summary: string;
  readonly example: string;
  readonly constraints: readonly string[];
  readonly overrides?: readonly string[];
  readonly requires?: readonly string[];
  readonly deprecated?: readonly string[];
  readonly matchedSituation: string;
  readonly score: number;
}

export interface ICapabilitySearchResponse {
  /** Present when the request names a genre or game a starter kit covers; it leads the response. */
  readonly starterKits?: readonly IStarterKitResult[];
  /** Present when the request asks to reverse engineer a game: the tools that read its pinned decomp. */
  readonly referenceTools?: readonly string[];
  /** "starterKit": a kit matched but no engine capability did; scaffold the kit, then search its gaps. */
  readonly verdict: "matched" | "none" | "starterKit";
  readonly results: readonly ICapabilitySearchResult[];
  readonly guidance: string;
}

export interface ICapabilityDetail extends ICapabilityEntry {}

export interface IEngineTool {
  readonly name: string;
  readonly description: string;
  readonly annotations: {
    readonly destructiveHint: false;
    readonly openWorldHint: boolean;
    readonly readOnlyHint: boolean;
  };
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<
      string,
      {
        readonly description?: string;
        readonly enum?: readonly string[];
        readonly type: "string" | "object" | "number";
      }
    >;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export const ENGINE_MCP_TOOL_NAMES = [
  "engine_search_capabilities",
  "engine_capability_detail",
  "engine_search_references",
  "engine_reference_detail",
  "engine_save_reference",
  "engine_watch_reference",
] as const;

const DEFAULT_MANIFEST_FILE = "capabilities.json";
/**
 * Words that carry no mechanic, and so must never carry a match.
 *
 * The list began as the two dozen words the manifest's own situations repeat. A request is not
 * written in that voice: it is a sentence, and a sentence is mostly grammar. `as` and `where` were
 * scored as content, so *"obstacles repeat **as** thousands of blocks"* ranked
 * `softwareAdapterName` on *"reject a SwiftShader adapter **as** evidence"*, and *"a runner
 * **where** chunks stream"* ranked `GTAONode` on *"darken the contact **where** an object meets
 * the floor"* — two capabilities from a lane that has nothing to do with the game, above the
 * particle system the request asked for by name.
 *
 * Spatial and quantitative words stay out of this list on purpose: `above`, `behind`, `near`,
 * `up`, `down`, `many` and `first` are mechanics in a game, not grammar.
 */
const STOP_WORDS = new Set([
  "a",
  "add",
  "after",
  "again",
  "all",
  "also",
  "an",
  "and",
  "any",
  "are",
  "around",
  "as",
  "at",
  "be",
  "because",
  "been",
  "being",
  "both",
  "build",
  "but",
  "by",
  "can",
  "create",
  "do",
  "does",
  "each",
  "either",
  "else",
  "every",
  "for",
  "from",
  "game",
  "get",
  "give",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "keep",
  "let",
  "made",
  "make",
  "may",
  "might",
  "must",
  "no",
  "nor",
  "not",
  "of",
  "on",
  "once",
  "one",
  "only",
  "or",
  "other",
  "our",
  "own",
  "put",
  "rather",
  "same",
  "shall",
  "should",
  "since",
  "so",
  "some",
  "such",
  "take",
  "than",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "though",
  "thus",
  "to",
  "too",
  "use",
  "very",
  "was",
  "want",
  "way",
  "we",
  "well",
  "were",
  "what",
  "when",
  "whenever",
  "where",
  "whether",
  "which",
  "while",
  "who",
  "whose",
  "why",
  "will",
  "with",
  "within",
  "without",
  "would",
  "yet",
  "you",
  "your",
]);
const MAX_COMPLETE_REQUEST_RESULTS = 15;
const MAX_SITUATION_RESULTS = 5;
/** Chosen by the current-manifest threshold sweep: the highest recalled candidate at 0.27. */
export const RELEVANCE_FLOOR = 0.27;
const AUTHORING_INSTRUCTIONS =
  "Follow the Authoring flow in the game's AGENTS.md (the threenative-capabilities skill holds the detail): search capabilities and references before the first new src/ file, for a new game and for every change to an existing game. Follow binding capability constraints. Execute with subagents focused on specific areas: bounded tasks, file ownership, then coordinator integration before mechanics playtests. References borrow mechanics only: no code, level layouts, character names or art; cite pinned file:line sources.";
const GENERIC_GUIDANCE =
  "No installed engine capability matches this situation. Decompose it into concrete mechanics and write the game-owned behavior in your project's src/; inspect the relevant template AGENTS.md before adding a package.";

export function defaultManifestPath(cwd = process.cwd()): string {
  const override = process.env.THREENATIVE_CAPABILITIES_MANIFEST;
  if (override !== undefined && override.trim().length > 0) return path.resolve(cwd, override);
  // The manifest that cannot drift is the one shipped inside the installed `@threenative/core`:
  // it is generated by the same build as the engine the project actually runs. A copy committed
  // into a project drifts the moment the engine dependency moves — twenty-four sandbox games had
  // committed copies between 115 and 231 entries against the same engine. Walk up so an MCP host
  // that launches from a nested working directory still finds the project root.
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    const nodeModules = path.join(directory, "node_modules");
    const installed = path.join(nodeModules, "@threenative", "core", "capabilities.json");
    if (existsSync(installed)) {
      const relative = path.relative(realpathSync(directory), realpathSync(nodeModules));
      // An ancestor's node_modules symlink can belong to another project entirely.
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        return installed;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  // Running from the engine repository itself (the sandbox root's MCP config points straight at
  // `packages/engine-mcp/dist`): answer with the repository's own generated manifest rather than
  // any project's snapshot.
  for (
    let directory = path.dirname(fileURLToPath(import.meta.url));
    ;
    directory = path.dirname(directory)
  ) {
    const repository = path.join(directory, "packages", "core", "capabilities.json");
    if (existsSync(repository)) return repository;
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  // Last resort, unchanged from the original default: a bare checkout with a committed copy and
  // no installed engine package.
  return path.resolve(cwd, DEFAULT_MANIFEST_FILE);
}

function manifestError(file: string, reason: string): Error {
  return new Error(`TN_ENGINE_CAPABILITIES_MANIFEST: ${file}: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function validateManifest(value: unknown, file: string): ICapabilityManifest {
  if (
    !isRecord(value) ||
    value.version !== 2 ||
    !Array.isArray(value.entries) ||
    !Array.isArray(value.notOwned)
  ) {
    throw manifestError(
      file,
      "root must contain manifest version 2, entries array, and notOwned array",
    );
  }
  for (const [index, raw] of value.entries.entries()) {
    // Every field `ICapabilityEntry` declares is checked, `kind` and `example` included. They were
    // the two that were not, and they are the two an authoring agent is handed most directly: a
    // manifest missing `example` validated cleanly and then answered `engine_search_capabilities`
    // with `example: undefined` typed as a string. A capability tool that reports a usage example
    // it does not have is worse than one that refuses to start.
    if (
      !isRecord(raw) ||
      typeof raw.symbol !== "string" ||
      typeof raw.package !== "string" ||
      typeof raw.importPath !== "string" ||
      typeof raw.kind !== "string" ||
      typeof raw.signature !== "string" ||
      typeof raw.summary !== "string" ||
      typeof raw.example !== "string" ||
      !Array.isArray(raw.situations) ||
      !Array.isArray(raw.aliases) ||
      !Array.isArray(raw.constraints) ||
      (raw.requires !== undefined && !isStringArray(raw.requires)) ||
      (raw.deprecated !== undefined && !isStringArray(raw.deprecated)) ||
      !raw.situations.every((situation) => typeof situation === "string") ||
      !raw.aliases.every((alias) => typeof alias === "string") ||
      !raw.constraints.every((constraint) => typeof constraint === "string")
    ) {
      throw manifestError(file, `entry ${index} is malformed`);
    }
  }
  for (const [index, raw] of (Array.isArray(value.starterKits)
    ? value.starterKits
    : []
  ).entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.name !== "string" ||
      typeof raw.title !== "string" ||
      typeof raw.blurb !== "string" ||
      !isStringArray(raw.words)
    ) {
      throw manifestError(file, `starterKits ${index} is malformed`);
    }
  }
  const notOwnedIds = new Set<string>();
  for (const [index, raw] of value.notOwned.entries()) {
    if (
      !isRecord(raw) ||
      typeof raw.id !== "string" ||
      raw.id.trim().length === 0 ||
      !Array.isArray(raw.situations) ||
      raw.situations.length === 0 ||
      !raw.situations.every(
        (situation) => typeof situation === "string" && situation.trim().length > 0,
      ) ||
      typeof raw.guidance !== "string" ||
      raw.guidance.trim().length === 0
    ) {
      throw manifestError(file, `notOwned ${index} is malformed`);
    }
    if (notOwnedIds.has(raw.id)) {
      throw manifestError(file, `notOwned contains duplicate id '${raw.id}'`);
    }
    notOwnedIds.add(raw.id);
  }
  return value as unknown as ICapabilityManifest;
}

export function loadCapabilityManifest(file = defaultManifestPath()): ICapabilityManifest {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw manifestError(file, `cannot read committed manifest: ${String(error)}`);
  }
  try {
    return validateManifest(JSON.parse(raw) as unknown, file);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TN_ENGINE_CAPABILITIES_MANIFEST:"))
      throw error;
    throw manifestError(file, `cannot parse JSON: ${String(error)}`);
  }
}

/** Collapses the doubled consonant an English suffix leaves behind: `dragg` → `drag`. */
function undouble(stem: string): string {
  const last = stem.at(-1);
  return stem.length > 3 && last !== undefined && last === stem.at(-2) && !"aeiou".includes(last)
    ? stem.slice(0, -1)
    : stem;
}

/**
 * One word, one token, whichever inflection the author reached for.
 *
 * The index is written in the vocabulary of the situation — *let the player click on a thing* —
 * and a request is written in the vocabulary of the game — *drag a crate by clicking on it*.
 * Without `-ing` and `-ed`, `clicking` and `click` were different tokens, that request scored
 * zero against every pointer capability, and the agent hand-wrote a `Raycaster` the framework
 * already ships. Both sides run through the same stemmer, so an over-eager strip costs nothing:
 * only a collision between two distinct words would, and the suffixes here do not produce one
 * across this manifest.
 */
function stem(token: string): string {
  const stripped = suffixStripped(token);
  // Drop a trailing silent `e` last, on every word rather than only on the stripped ones, so that
  // `hinge` and `hinged` land on one token instead of two. Stripping `-ed` alone leaves `hing`
  // beside an unstripped `hinge`, which is the same miss the suffixes were added to close.
  return stripped.length > 3 && stripped.endsWith("e") ? stripped.slice(0, -1) : stripped;
}

function suffixStripped(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ing")) return undouble(token.slice(0, -3));
  if (token.length > 4 && token.endsWith("ed")) return undouble(token.slice(0, -2));
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

/**
 * `STOP_WORDS` after the stemmer, so the post-stem filter still catches the inflection of a
 * stop word whose own stem is a different string: `makes` → `mak`, `gives` → `giv`, `having` →
 * `hav`. Testing the raw set after stemming let every one of those through.
 */
const STOP_WORD_STEMS = new Set([...STOP_WORDS].map(stem));

/**
 * `mergeParts` in a request and `merge parts` in a situation are the same two words, and only the
 * second one used to be findable: the index read `mergeparts` as one token while the request that
 * named the symbol read `mergeParts`. Splitting the case boundary here, on both sides, is what
 * makes a symbol name searchable; it costs nothing on prose, which has no case boundary to split.
 */
function splitSymbolCase(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2");
}

export function capabilitySituationTokens(value: string): string[] {
  return splitSymbolCase(value)
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem)
    .filter((token) => !STOP_WORD_STEMS.has(token));
}

const tokens = capabilitySituationTokens;

/**
 * How much a word narrows the search, measured against this manifest rather than assumed.
 *
 * `player` and `scene` appear in dozens of situations and separate nothing; `buoyancy`, `hinge`
 * and `click` appear in one or two and are the whole answer. Counting raw token overlap made a
 * verbose request score by length: a long request divides its overlap by its own word count, so
 * every capability landed on the same near-zero score and the ranking fell through to the
 * alphabet. That is how a physics-puzzle request came back holding `attachToBone`.
 */
function tokenWeights(
  entries: readonly Pick<ICapabilityEntry, "situations" | "aliases">[],
): ReadonlyMap<string, number> {
  const frequency = new Map<string, number>();
  let situations = 0;
  for (const entry of entries) {
    for (const situation of [...entry.situations, ...entry.aliases]) {
      situations += 1;
      for (const token of new Set(tokens(situation)))
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const weights = new Map<string, number>();
  for (const [token, count] of frequency) weights.set(token, Math.log(1 + situations / count));
  return weights;
}

/** A word the index has never used narrows nothing here, whatever it means elsewhere. */
function weightOf(weights: ReadonlyMap<string, number>, token: string): number {
  return weights.get(token) ?? 0;
}

/**
 * The weights a name and a summary are read with, indexed apart from the situations on purpose.
 * Folding one summary and one symbol document per entry into the situation index moved the coverage
 * of every existing match: `SnowField` fell under `RELEVANCE_FLOOR` for "fresh snowfall slowly
 * fills old tracks back in", a row the recall budget had held. A channel added to help a name must
 * not retune the prose index it is added beside.
 */
/**
 * The words a name is spelled with, on both sides of a match. `GPUParticles3D` is "gpu particles"
 * to a reader: glueing the digit run on (`particles3d`) meant that capability matched no request
 * that said "particles", and a digit carries no name in this manifest, so `Area3D` is `area` and
 * `Joint3D` is `joint`.
 */
function nameWords(value: string): readonly string[] {
  return tokens(value.replace(/([a-zA-Z])(\d+)/gu, "$1 $2")).filter((token) => !/\d/u.test(token));
}

/** `mergeParts`, `MERGEPARTS`, `merge parts` and `merge-parts` are the same name to a reader. */
function normaliseName(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "");
}

/** The words a request spells, before the stemmer and the stop list: a name is matched as written. */
function spelledWords(value: string): readonly string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length > 0);
}

/**
 * Does the request spell this name, as whole words and in order? `CharacterBody3D movement` and
 * `character body 3d` both spell `CharacterBody3D`; `physics` does not spell `afterPhysics`, and
 * `the viewer` does not spell the `View` symbol, because a run of whole words has to match the
 * whole name. A run longer than four words is never a name an author types.
 */
function spellsName(situation: string, symbol: string): boolean {
  const words = spelledWords(situation);
  const whole = normaliseName(symbol);
  for (let start = 0; start < words.length; start += 1) {
    let piece = "";
    for (let end = start; end < words.length && end < start + 4; end += 1) {
      piece += normaliseName(words[end] ?? "");
      if (piece === whole) return true;
      if (piece.length >= whole.length) break;
    }
  }
  return false;
}

function nameTokenWeights(entries: readonly ICapabilityEntry[]): ReadonlyMap<string, number> {
  return tokenWeights(
    entries.map((entry) => ({
      aliases: [nameWords(entry.symbol).join(" ")],
      situations: [entry.summary],
    })),
  );
}

/**
 * A word is distinctive enough to carry a match alone when the index uses it in at most this
 * share of its situations. `player` reaches 2.5% and separates nothing; `particle` reaches 0.9%
 * and names one capability. The old rule — a query of four words or more needs two overlapping
 * tokens — threw away exactly the case this search exists for: one word that names the capability
 * outright, in a sentence otherwise made of scenery.
 */
const DISTINCTIVE_SITUATION_SHARE = 0.02;
const DISTINCTIVE_FLOOR = Math.log(1 + 1 / DISTINCTIVE_SITUATION_SHARE);
/** How much each word of agreement beyond the first is worth, as a multiplier on coverage. */
const AGREEMENT_WEIGHT = 0.4;
/** How much of a situation a single matched word must account for to answer on its own. */
const LONE_WORD_COVERAGE = 0.22;

/**
 * How much of the agreement rests on more than one word.
 *
 * The distinctive-word floor is what makes a one-word match possible at all, and it is also how
 * a homonym wins: `cycle` reaches one situation (a walk cycle) and `health` reaches one (an asset
 * health report), so each cleared the floor alone and displaced the answer a reader wanted — a
 * day/night cycle is `solarPosition`, a health bar is the UI state bridge. Neither is a scoring
 * accident that a threshold can fix, because both single-word matches are genuinely rare words.
 *
 * What separates them is corroboration: the right answer usually agrees on *several* words, and
 * the homonym on exactly one. This multiplies coverage by that agreement, so a two-word match at
 * modest coverage outranks a one-word match at high coverage, and a one-word match still ranks
 * above nothing at all.
 */
function agreement(situation: readonly string[], query: ReadonlySet<string>): number {
  const matched = situation.filter((token) => query.has(token)).length;
  return 1 + AGREEMENT_WEIGHT * Math.max(0, matched - 1);
}

interface IPhraseScore {
  readonly agreed: number;
  readonly coverage: number;
  readonly matched: number;
  readonly phraseBonus: number;
  readonly score: number;
}

function scorePhrase(
  value: string,
  queryTokens: ReadonlySet<string>,
  queryText: string,
  weights: ReadonlyMap<string, number>,
): IPhraseScore | undefined {
  const phrase = tokens(value);
  const unique = [...new Set(phrase)];
  const total = unique.reduce((sum, token) => sum + weightOf(weights, token), 0);
  const matched = unique
    .filter((token) => queryTokens.has(token))
    .reduce((sum, token) => sum + weightOf(weights, token), 0);
  const phraseBonus =
    phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0;
  if (total === 0 || (matched === 0 && phraseBonus === 0)) return undefined;
  const coverage = matched / total;
  const agreed = agreement(unique, queryTokens);
  return { agreed, coverage, matched, phraseBonus, score: coverage * agreed + phraseBonus };
}

function isDistinctivePhrase(candidate: IPhraseScore): boolean {
  if (candidate.phraseBonus > 0) return true;
  if (candidate.matched < DISTINCTIVE_FLOOR) return false;
  return !(candidate.agreed === 1 && candidate.coverage < LONE_WORD_COVERAGE);
}

interface IReadabilityScore {
  readonly best: number;
  readonly matchedSituation: string;
  readonly bestReadableSituation: string;
}

function scoreReadableSituations(
  situations: readonly string[],
  queryTokens: ReadonlySet<string>,
  queryText: string,
  weights: ReadonlyMap<string, number>,
): IReadabilityScore {
  let best = 0;
  let matchedSituation = "";
  let bestReadableScore = 0;
  let bestReadableSituation = situations[0] ?? "";
  for (const situation of situations) {
    const candidate = scorePhrase(situation, queryTokens, queryText, weights);
    if (candidate === undefined) continue;
    if (candidate.score > bestReadableScore) {
      bestReadableScore = candidate.score;
      bestReadableSituation = situation;
    }
    if (isDistinctivePhrase(candidate) && candidate.score > best) {
      best = candidate.score;
      matchedSituation = situation;
    }
  }
  return { best, bestReadableSituation, matchedSituation };
}

function scoreAliases(
  aliases: readonly string[],
  queryTokens: ReadonlySet<string>,
  queryText: string,
  weights: ReadonlyMap<string, number>,
): number {
  let best = 0;
  for (const alias of aliases) {
    const candidate = scorePhrase(alias, queryTokens, queryText, weights);
    if (candidate !== undefined) best = Math.max(best, candidate.score);
  }
  return best;
}

function situationScore(
  query: readonly string[],
  situations: readonly string[],
  aliases: readonly string[],
  weights: ReadonlyMap<string, number>,
): { readonly matchedSituation: string; readonly score: number } {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  const queryTokens = new Set(query);
  const queryText = query.join(" ");
  const readable = scoreReadableSituations(situations, queryTokens, queryText, weights);
  const best = Math.max(readable.best, scoreAliases(aliases, queryTokens, queryText, weights));
  const matchedSituation =
    readable.matchedSituation.length > 0
      ? readable.matchedSituation
      : best >= RELEVANCE_FLOOR
        ? readable.bestReadableSituation
        : "";
  return matchedSituation.length > 0
    ? { matchedSituation, score: best }
    : { matchedSituation: "", score: 0 };
}

/**
 * A request that names a symbol the manifest exports is the strongest statement it can make, and
 * the situation scorer cannot see it: `godrays` is a name, and the index held only its prose. The
 * lead is gated on how much of the request the symbol accounts for, so a request that mentions
 * `view` or `read` in passing does not get answered with the `View` or `readFile` symbol.
 */
const EXACT_SYMBOL_LEAD = 4;
/**
 * A name match scores on how much of the request the name accounts for: a request that is mostly
 * one name leads at full strength, and a name mentioned inside a rich sentence barely moves. That
 * is what separates `Area3D trigger` (about the area) from `first person view with a weapon held
 * in the hand` (about the camera, which merely says "view") without a list of English homonyms.
 */
const NAME_BASE_LEAD = 2;
const NAME_SHARE_LEAD = 1.4;
/**
 * A name the name index uses everywhere names nothing. `playtest` reaches 81 of its 1 062
 * documents and `Scene` 44, so a request mentioning either is asking about a scene or a playtest,
 * not for a symbol; `godrays` and `traa` reach 2 and `mergeParts`' own words reach 11 and 15.
 */
const SYMBOL_WEIGHT_FLOOR = 4.2;
/**
 * A one-word name spelled in passing also has to hold this much of the request. `depth` is rare
 * enough for the weight floor, and a request about underwater fog still says it once; below this
 * share the word is scenery and the row it would lead is a wrong answer at a weak score.
 */
const SINGLE_WORD_SHARE_FLOOR = 0.3;

interface ISymbolScore {
  readonly score: number;
  /** How much a name narrows this index, so `godrays` outranks `Scene` when both are spelled. */
  readonly specificity: number;
}

function scoreSymbolName(
  symbol: string,
  situation: string,
  queryTokens: ReadonlySet<string>,
  weights: ReadonlyMap<string, number>,
): ISymbolScore | undefined {
  const name = [...new Set(nameWords(symbol))];
  if (name.length === 0) return undefined;
  const nameWeights = name.map((token) => weightOf(weights, token));
  // Summing, not taking the max, is what makes `gpu particles` prefer `GPUParticles3D` over the
  // generic `Particles`: the longer name accounts for more of the request.
  const specificity = nameWeights.reduce((sum, weight) => sum + weight, 0);
  const requestTotal = [...queryTokens].reduce((sum, token) => sum + weightOf(weights, token), 0);
  const share = requestTotal === 0 ? 0 : specificity / requestTotal;
  const nameScore = NAME_BASE_LEAD + NAME_SHARE_LEAD * Math.min(1, share);
  // A request that spells the name — `add godrays`, `use rapier`, `GPUParticles3D sparks`,
  // `use addInSlices for loading` — is asking for that symbol: equality with the whole name, not
  // with what the stemmer leaves of it, which is how `afterPhysics` once answered "physics".
  if (spellsName(situation, symbol)) {
    if (normaliseName(situation) === normaliseName(symbol)) {
      return { score: EXACT_SYMBOL_LEAD, specificity };
    }
    // A one-word name spelled inside a longer request is the weakest form of the signal: `view`,
    // `scene`, `depth`, `velocity` and `connect` are ordinary English that a request uses without
    // naming the symbol. It must then earn its place twice — the word has to be one the name index
    // rarely uses, and it has to hold a real share of the request — or `camera follows the player
    // with a third person view` answers the React `View` rectangle over the camera it asks for.
    if (name.length === 1) {
      if (weightOf(weights, name[0] ?? "") < SYMBOL_WEIGHT_FLOOR) return undefined;
      if (share < SINGLE_WORD_SHARE_FLOOR) return undefined;
      return { score: (NAME_BASE_LEAD + NAME_SHARE_LEAD) * Math.min(1, share), specificity };
    }
    return { score: nameScore, specificity };
  }
  // A one-word name has to be spelled; a name scattered through the prose needs the gates below.
  if (name.length < 2) return undefined;
  const queryWords = new Set(nameWords(situation));
  if (!name.every((token) => queryWords.has(token))) return undefined;
  // A name made of words the index uses everywhere names nothing; the share-scaled score already
  // keeps a name mentioned in passing behind the mechanic the request is actually about.
  if (Math.max(...nameWeights) < SYMBOL_WEIGHT_FLOOR) return undefined;
  return { score: nameScore, specificity };
}

/**
 * The summary corroborates; it never outranks a situation. It is the one line written for a reader
 * who already knows the name (`ThreeNative equivalent for realism-effects traa`), so it answers a
 * retired or thinly described capability and stays quiet next to a real situation match.
 */
const SUMMARY_WEIGHT = 0.4;

function summaryScore(
  summary: string,
  queryTokens: ReadonlySet<string>,
  queryText: string,
  weights: ReadonlyMap<string, number>,
): number {
  const candidate = scorePhrase(summary, queryTokens, queryText, weights);
  return candidate === undefined ? 0 : candidate.score * SUMMARY_WEIGHT;
}

/** Every channel a capability answer can come from, combined; the symbol leads and explains itself. */
interface ICapabilityScore {
  readonly matchedSituation: string;
  readonly score: number;
  /** Only a name carries one; it orders two names spelled in the same request. */
  readonly specificity: number;
}

function capabilityScore(
  query: readonly string[],
  entry: ICapabilityEntry,
  weights: ReadonlyMap<string, number>,
  nameWeights: ReadonlyMap<string, number>,
  situation: string,
): ICapabilityScore {
  const situations = {
    ...situationScore(query, entry.situations, entry.aliases, weights),
    specificity: 0,
  };
  if (query.length === 0) return situations;
  const queryTokens = new Set(query);
  const symbol = scoreSymbolName(entry.symbol, situation, queryTokens, nameWeights);
  const summary = summaryScore(entry.summary, queryTokens, query.join(" "), nameWeights);
  const symbolScore = symbol?.score ?? 0;
  const best = Math.max(situations.score, symbolScore, summary);
  if (best <= situations.score) return situations;
  if (symbol !== undefined && symbolScore >= best) {
    return { matchedSituation: entry.symbol, score: symbolScore, specificity: symbol.specificity };
  }
  // A summary-only answer still needs a readable explanation, and the entry's own first situation
  // is the sentence a reader recognises; an entry with no situations keeps the summary itself.
  return {
    matchedSituation: situations.matchedSituation || entry.situations[0] || entry.summary,
    score: best,
    specificity: 0,
  };
}

function notOwnedSituationScore(
  query: readonly string[],
  situations: readonly string[],
): { readonly matchedSituation: string; readonly score: number } {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  const queryText = query.join(" ");
  let best = 0;
  let matchedSituation = "";
  for (const situation of situations) {
    const phrase = tokens(situation);
    const overlap = new Set(phrase.filter((token) => query.includes(token))).size;
    const score = overlap / Math.max(query.length, phrase.length);
    const phraseBonus =
      phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0;
    if (overlap < (query.length >= 4 ? 2 : 1) && phraseBonus === 0) continue;
    const candidate = score + phraseBonus;
    if (candidate > best) {
      best = candidate;
      matchedSituation = situation;
    }
  }
  return { matchedSituation, score: best };
}

function notOwnedMatch(
  manifest: ICapabilityManifest,
  query: readonly string[],
):
  | {
      readonly entry: INotOwnedCapability;
      readonly matchedSituation: string;
      readonly score: number;
    }
  | undefined {
  return manifest.notOwned
    .map((entry) => ({ entry, ...notOwnedSituationScore(query, entry.situations) }))
    .filter(
      ({ matchedSituation, score }) => matchedSituation.length > 0 && score >= RELEVANCE_FLOOR,
    )
    .sort(
      (left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id),
    )[0];
}

function isSpecificNotOwnedMatch(query: readonly string[], matchedSituation: string): boolean {
  const queryText = query.join(" ");
  const phrase = tokens(matchedSituation);
  const phraseText = phrase.join(" ");
  if (queryText === phraseText) return true;
  if (query.length === 1 && phrase.length <= 2 && phrase.includes(query[0] ?? "")) return true;
  if (query.length > phrase.length + 1) return false;
  return new Set(phrase.filter((token) => query.includes(token))).size >= 2;
}

function capabilitySearchKey(entry: ICapabilityEntry): string {
  // One export declaration can expose a primary helper plus inspection aliases. The manifest
  // correctly keeps every public symbol for detail lookup, but returning the same declaration
  // twice wastes a broad authoring search slot.
  //
  // The signature was part of this key and defeated it: `androidMailboxPaths`,
  // `DeviceBridgeTransport`, `deviceMailboxPaths`, `DeviceMailboxTransport`,
  // `deviceTimeoutDiagnostic` and `validateDeviceEndpoint` carry one summary and one pair of
  // situations between them and differ only in how they are declared. Six of a request's fifteen
  // slots went to that one answer, and the capabilities the request had named by word were pushed
  // out below them. Same import path, same summary, same situations is one answer.
  return `${entry.importPath}\n${entry.summary}\n${entry.situations.join("\n")}`;
}

/** Kits whose genre or kit.json alias is a whole word or phrase of the request, earliest first. */
function matchedStarterKits(
  situation: string,
  kits: readonly IStarterKit[],
): readonly IStarterKitResult[] {
  const words = (text: string) =>
    ` ${text
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, " ")
      .trim()} `;
  const request = words(situation);
  const claims = kits.map((kit) => ({
    kit,
    spans: kit.words.flatMap((word) => {
      const at = request.indexOf(words(word));
      return at < 0 ? [] : [{ at, end: at + words(word).length }];
    }),
  }));
  // A kit word inside a longer phrase another kit claims is that kit's: "mario kart" is the kart
  // kit's, not the collectathon's "mario".
  const inside = (span: { at: number; end: number }, own: (typeof claims)[number]) =>
    claims.some(
      (other) =>
        other !== own &&
        other.spans.some(
          (o) => o.at <= span.at && o.end >= span.end && o.end - o.at > span.end - span.at,
        ),
    );
  return claims
    .map((claim) => ({
      at: Math.min(...claim.spans.filter((span) => !inside(span, claim)).map((span) => span.at)),
      kit: claim.kit,
    }))
    .filter(({ at }) => Number.isFinite(at))
    .sort((left, right) => left.at - right.at)
    .map(({ kit: { blurb, name, title } }) => ({
      blurb,
      command: `npx create-threenative <dir> --template ${name}`,
      name,
      title,
    }));
}

export function searchCapabilities(
  situation: string,
  manifestFile = defaultManifestPath(),
  scope: "mechanic" | "request" = "mechanic",
): ICapabilitySearchResponse {
  if (typeof situation !== "string" || situation.trim().length === 0)
    throw new Error("engine_search_capabilities requires a non-empty situation string.");
  const manifest = loadCapabilityManifest(manifestFile);
  const starterKits = matchedStarterKits(situation, manifest.starterKits ?? []);
  const response = withReferenceTools(situation, searchMechanics(situation, manifest, scope));
  if (starterKits.length === 0) return response;
  // The kit leads the response; the mechanics it does not cover follow unchanged.
  return {
    starterKits,
    ...response,
    ...(response.verdict === "none"
      ? {
          guidance: `Scaffold from the starter kit first, then search the mechanics it does not cover. ${response.guidance}`,
          verdict: "starterKit" as const,
        }
      : {}),
  };
}

const REVERSE_ENGINEER = /\breverse[\s-]?engineer|\bdecomp|\bdisassembl/iu;
const REFERENCE_TOOLS = [
  "engine_search_references",
  "engine_reference_detail",
  "engine_save_reference",
  "engine_watch_reference",
];

/** Every search names the reference tools (PRD-827), so "double jump" learns pinned game
 * references exist; a reverse-engineer request also leads its guidance with them (PRD-735). */
function withReferenceTools(situation: string, response: ICapabilitySearchResponse) {
  if (!REVERSE_ENGINEER.test(situation)) return { referenceTools: REFERENCE_TOOLS, ...response };
  return {
    referenceTools: REFERENCE_TOOLS,
    ...response,
    guidance: `Reverse engineer the game with engine_search_references, then engine_reference_detail for its pinned cards. ${response.guidance}`,
  };
}

function searchMechanics(
  situation: string,
  manifest: ICapabilityManifest,
  scope: "mechanic" | "request",
): ICapabilitySearchResponse {
  const query = tokens(situation);
  const limit = scope === "request" ? MAX_COMPLETE_REQUEST_RESULTS : MAX_SITUATION_RESULTS;
  const weights = tokenWeights(manifest.entries);
  const nameWeights = nameTokenWeights(manifest.entries);
  const notOwned = notOwnedMatch(manifest, query);
  if (notOwned !== undefined && isSpecificNotOwnedMatch(query, notOwned.matchedSituation)) {
    return {
      guidance: notOwned.entry.guidance,
      results: [],
      verdict: "none",
    };
  }
  const results = manifest.entries
    .map((entry) => ({ entry, ...capabilityScore(query, entry, weights, nameWeights, situation) }))
    .filter(
      ({ matchedSituation, score }) => matchedSituation.length > 0 && score >= RELEVANCE_FLOOR,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.specificity - left.specificity ||
        `${left.entry.importPath}:${left.entry.symbol}`.localeCompare(
          `${right.entry.importPath}:${right.entry.symbol}`,
        ),
    )
    .filter(
      (candidate, index, candidates) =>
        candidates.findIndex(
          (other) => capabilitySearchKey(other.entry) === capabilitySearchKey(candidate.entry),
        ) === index,
    )
    .slice(0, limit)
    .map(({ entry, matchedSituation, score }) => ({
      constraints: entry.constraints,
      ...(entry.deprecated === undefined ? {} : { deprecated: entry.deprecated }),
      example: entry.example,
      importPath: entry.importPath,
      matchedSituation,
      ...(entry.overrides === undefined ? {} : { overrides: entry.overrides }),
      ...(entry.requires === undefined ? {} : { requires: entry.requires }),
      score,
      signature: entry.signature,
      summary: entry.summary,
      symbol: entry.symbol,
    }));
  if (results.length > 0) return { guidance: "", results, verdict: "matched" };
  return {
    guidance: notOwned?.entry.guidance ?? GENERIC_GUIDANCE,
    results: [],
    verdict: "none",
  };
}

/**
 * Every manifest entry named `symbol` (optionally in one `importPath`); throws when there is none.
 * Two packages can export one name (`createThreeObject` from raw-unreal and ueformat), so a lookup
 * by name alone must return both — answering with the first hides the second from detail.
 */
export function capabilityDetails(
  symbol: string,
  manifestFile = defaultManifestPath(),
  importPath?: string,
): readonly ICapabilityDetail[] {
  if (typeof symbol !== "string" || symbol.trim().length === 0)
    throw new Error("engine_capability_detail requires a non-empty symbol string.");
  const matches = loadCapabilityManifest(manifestFile).entries.filter(
    (candidate) =>
      candidate.symbol === symbol &&
      (importPath === undefined || candidate.importPath === importPath),
  );
  if (matches.length === 0)
    throw new Error(
      `Unknown engine capability '${symbol}'${importPath === undefined ? "" : ` in '${importPath}'`}.`,
    );
  return matches;
}

/** One capability's detail; code callers must name `importPath` when the symbol is shared. */
export function capabilityDetail(
  symbol: string,
  manifestFile = defaultManifestPath(),
  importPath?: string,
): ICapabilityDetail {
  const matches = capabilityDetails(symbol, manifestFile, importPath);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous engine capability '${symbol}': pass importPath, one of ${matches
        .map((match) => `'${match.importPath}'`)
        .join(", ")}.`,
    );
  return matches[0] as ICapabilityDetail;
}

const TOOL_DEFINITIONS: readonly IEngineTool[] = [
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "engine_search_capabilities",
    description:
      'Search the installed engine by concrete gameplay mechanic or by an exact exported symbol name. Decompose genres first. Use scope "request" for the mechanically explicit full request and "mechanic" for each focused search; matchedSituation and score explain every result. A row carries the answer (importPath, signature, example, constraints, overrides, deprecations), so call engine_capability_detail only for a symbol the search did not return. The response verdict "none" is an actionable answer with guidance, not a failed search.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        scope: {
          description:
            "Use request for the complete cross-system game request; use mechanic or omit it for one mechanic.",
          enum: ["request", "mechanic"],
          type: "string",
        },
        situation: { type: "string" },
      },
      required: ["situation"],
      type: "object",
    },
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "engine_capability_detail",
    description:
      "Inspect one engine capability's import, signature, example, constraints, and overrides. When several packages export the symbol, every match is returned under `matches`.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        importPath: {
          description:
            "The search result's importPath; required when two packages export the same symbol.",
          type: "string",
        },
        symbol: { type: "string" },
      },
      required: ["symbol"],
      type: "object",
    },
  },
  {
    name: "engine_search_references",
    description:
      "Reverse engineer classic games: search mechanic cards and repository map nodes from their decomps. Tier-2 titles link to repos to explore and save. References describe feel only; borrow algorithms, cite pinned sources, copy no code or art.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { situation: { type: "string" } },
      required: ["situation"],
    },
  },
  {
    name: "engine_reference_detail",
    description:
      "Reverse engineer a game: read its pinned map or mechanic card. A node includes files, key functions, dependencies and child nodes; a card includes constants and sources.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        game: { type: "string" },
        id: { type: "string" },
        kind: { type: "string", enum: ["node", "card"] },
      },
      required: ["game", "id", "kind"],
    },
  },
  {
    name: "engine_save_reference",
    description:
      "Save what you reverse engineer: validate and save a pinned game's repository map and mechanic cards to .threenative/refs, merged by id at the same SHA; conflicting revisions are refused. Pass a game object with version:1, id, title, repo, sha, nodes and cards. Returns a POSIX-shell contribution command for review; does not send it. Unknown fields and fenced code are refused.",
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        game: {
          type: "object",
          description:
            "Pinned game reference: version, id, title, repo, sha (40 hex), nodes [{id,name,purpose,parent?,paths,functions:[{name,path,lines:[from,to]}],dependsOn}], cards [{id,node,name,summary,behavior,constants:[{name,value,unit,source}],sources:[{path,line}],capabilities,tags}]. No extra fields or code fences.",
        },
      },
      required: ["game"],
    },
  },
  {
    name: "engine_watch_reference",
    description:
      "Watch what you reverse engineer: see a game mechanic before you build it. Searches YouTube for gameplay of a reference game, download one short segment and slice frames plus one contact sheet into a tmp folder. Returns sheet (read it first), frames and watch.json (video, segment, frame times). Needs yt-dlp and ffmpeg. Frames are reference only: never commit them.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Game and mechanic, e.g. 'super mario 64 triple jump'.",
        },
        duration: { type: "number", description: "Seconds of gameplay to sample (default 90)." },
        frames: { type: "number", description: "Frames to slice from the segment (default 12)." },
        at: { type: "string", description: "Exact timestamps, comma separated, e.g. '12,35,61'." },
        pick: { type: "number", description: "Search result index (default 0, the top one)." },
        from: {
          type: "string",
          description: "Segment start: seconds, mm:ss or NN% (default 10%).",
        },
      },
      required: ["query"],
    },
  },
];

export function toolDefinitions(): readonly IEngineTool[] {
  return TOOL_DEFINITIONS;
}

const DEFAULT_LOG_FILE = path.join(".threenative", "engine-mcp.log");
let logBroken = false;

/**
 * Appends one JSON line per tool call so a finished session's capability searches can be read
 * back. The default target is `.threenative/engine-mcp.log` under the launch directory — the game
 * project root — and `THREENATIVE_ENGINE_MCP_LOG` names another file or `off` to disable it.
 * A log that cannot be written reports once on stderr and then stays quiet: a read-only tool must
 * never fail because its record keeping did.
 */
function logToolCall(entry: Record<string, unknown>): void {
  if (logBroken) return;
  const target = process.env.THREENATIVE_ENGINE_MCP_LOG ?? DEFAULT_LOG_FILE;
  if (target === "off") return;
  try {
    mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`);
  } catch (error) {
    logBroken = true;
    process.stderr.write(`engine-mcp log disabled (${target}): ${String(error)}\n`);
  }
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ id, jsonrpc: "2.0", error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ id, jsonrpc: "2.0", result });
}

function writeLine(value: string): void {
  process.stdout.write(`${value}\n`);
}

/**
 * The tool's text payload. Compact, because it is model context: indentation cost 11.6% of every
 * response and answered nothing. `runCli` re-indents its own copy, so the human-facing command
 * stays readable (PRD-865).
 */
function toolText(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ text: JSON.stringify(value), type: "text" }] };
}

async function searchReferences(situation: string, limit = 5) {
  const local = loadLocalReferenceGames();
  let release: IReferenceIndex | undefined;
  try {
    release = await loadReferenceIndex();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("TN_REFERENCES_UNAVAILABLE:")))
      throw error;
    if (local.length === 0)
      return {
        results: [],
        guidance:
          "references unavailable: no release cache or network; capability search still works.",
      };
  }
  const localIds = new Set(local.map((game) => game.id));
  const localStubs = local.flatMap(referenceStubs);
  const localKeys = new Set(localStubs.map((stub) => `${stub.game}/${stub.kind}/${stub.id}`));
  const games = [
    ...(release?.games ?? []).filter((game) => !localIds.has(game.id)),
    ...local.map((game) => ({
      id: game.id,
      title: game.title,
      repo: game.repo,
      platform: "local",
      tier: 1 as const,
    })),
  ];
  const stubs = [
    ...(release?.stubs ?? []).filter(
      (stub) => !localKeys.has(`${stub.game}/${stub.kind}/${stub.id}`),
    ),
    ...localStubs,
  ];
  const titles = new Map(games.map((game) => [game.id, game.title]));
  const candidates = [
    ...stubs.map((stub) => ({
      ...stub,
      title: titles.get(stub.game) ?? "",
    })),
    ...games
      .filter((game) => game.tier === 2)
      .map((game) => ({
        ...game,
        game: game.id,
        kind: "game",
        name: game.title,
        summary: game.title,
        tags: [],
        capabilities: [],
        guidance: "Explore this repository, then call engine_save_reference.",
      })),
  ];
  const phrases = candidates.map((stub) => ({
    situations: [stub.name, stub.summary, ...stub.tags],
    aliases: [stub.title],
  }));
  const weights = tokenWeights(phrases);
  const query = tokens(situation);
  return {
    guidance: "",
    results: candidates
      .map((stub, index) => {
        const content = situationScore(query, phrases[index]?.situations ?? [], [], weights);
        // A shared game title must not erase agreement with the requested mechanic.
        const title = scoreAliases(
          phrases[index]?.aliases ?? [],
          new Set(query),
          query.join(" "),
          weights,
        );
        return { ...stub, ...content, score: content.score + title };
      })
      .filter((stub) => stub.score >= RELEVANCE_FLOOR)
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, limit),
  };
}

async function handleToolCall(
  params: Record<string, unknown>,
  manifestFile: string,
): Promise<{ content: [{ type: "text"; text: string }] }> {
  const name = params.name;
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  // The raw value goes to the validator, never through String(): a numeric or null argument
  // must come back as a tool error the authoring agent can read, not a vacuous empty search
  // that looks like the engine having no such capability.
  if (name === "engine_search_capabilities") {
    if (typeof argumentsValue.situation !== "string")
      throw new Error("engine_search_capabilities requires a string 'situation' argument.");
    const scope = argumentsValue.scope === undefined ? "mechanic" : argumentsValue.scope;
    if (scope !== "request" && scope !== "mechanic")
      throw new Error("engine_search_capabilities scope must be 'request' or 'mechanic'.");
    const response = searchCapabilities(argumentsValue.situation, manifestFile, scope);
    logToolCall({
      results: response.results.map((result) => result.symbol),
      scope,
      situation: argumentsValue.situation,
      tool: name,
      verdict: response.verdict,
    });
    // Up to three reference stubs on every search; an offline host still gets its capability hits.
    return toolText({
      ...response,
      references: await searchReferences(argumentsValue.situation, 3).catch((error: unknown) => ({
        results: [],
        guidance: `references unavailable: ${String(error)}`,
      })),
    });
  }
  if (name === "engine_capability_detail") {
    if (typeof argumentsValue.symbol !== "string")
      throw new Error("engine_capability_detail requires a string 'symbol' argument.");
    if (argumentsValue.importPath !== undefined && typeof argumentsValue.importPath !== "string")
      throw new Error("engine_capability_detail 'importPath' must be a string when given.");
    const matches = capabilityDetails(
      argumentsValue.symbol,
      manifestFile,
      argumentsValue.importPath,
    );
    // A shared name answers in one call with every match rather than an error: the agent reads
    // both summaries and imports the right one without a second round trip.
    const detail =
      matches.length === 1
        ? matches[0]
        : {
            guidance: `${matches.length} packages export '${argumentsValue.symbol}'. Import the match whose summary fits; pass importPath to get one.`,
            matches,
          };
    logToolCall({
      importPath: argumentsValue.importPath,
      symbol: argumentsValue.symbol,
      tool: name,
    });
    return toolText(detail);
  }
  if (name === "engine_search_references") {
    if (typeof argumentsValue.situation !== "string" || !argumentsValue.situation.trim())
      throw new Error("engine_search_references requires a non-empty string 'situation'.");
    const response = await searchReferences(argumentsValue.situation);
    logToolCall({
      tool: name,
      situation: argumentsValue.situation,
      results: response.results.map((entry) => entry.id),
    });
    return toolText(response);
  }
  if (name === "engine_reference_detail") {
    if (
      typeof argumentsValue.game !== "string" ||
      typeof argumentsValue.id !== "string" ||
      (argumentsValue.kind !== "node" && argumentsValue.kind !== "card")
    )
      throw new Error("engine_reference_detail requires game, id and kind (node or card).");
    let game = await loadReferenceGame(argumentsValue.game);
    const { id, kind } = argumentsValue;
    let entry =
      kind === "node"
        ? game.nodes.find((node) => node.id === id)
        : game.cards.find((card) => card.id === id);
    if (!entry) {
      game = await loadReleaseReferenceGame(argumentsValue.game);
      entry =
        kind === "node"
          ? game.nodes.find((node) => node.id === id)
          : game.cards.find((card) => card.id === id);
    }
    if (!entry) throw new Error(`No reference ${kind} '${id}' in '${game.id}'.`);
    logToolCall({ tool: name, game: game.id, id, kind });
    return toolText({
      game: game.id,
      title: game.title,
      repo: game.repo,
      sha: game.sha,
      ...(kind === "node"
        ? { node: entry, children: game.nodes.filter((node) => node.parent === id) }
        : { card: entry }),
    });
  }
  if (name === "engine_save_reference") {
    const saved = saveReferenceGame(argumentsValue.game);
    logToolCall({ tool: name, saved: saved.saved });
    return toolText(saved);
  }
  if (name === "engine_watch_reference") {
    const { query, duration, frames, at, pick, from } = argumentsValue;
    if (typeof query !== "string" || !query.trim())
      throw new Error("engine_watch_reference requires a non-empty string 'query'.");
    for (const [key, value] of Object.entries({ duration, frames, pick }))
      if (value !== undefined && typeof value !== "number")
        throw new Error(`engine_watch_reference '${key}' must be a number when given.`);
    for (const [key, value] of Object.entries({ at, from }))
      if (value !== undefined && typeof value !== "string")
        throw new Error(`engine_watch_reference '${key}' must be a string when given.`);
    const result = await watchReference({
      query,
      ...(typeof duration === "number" ? { duration } : {}),
      ...(typeof frames === "number" ? { frames } : {}),
      ...(typeof at === "string" ? { at } : {}),
      ...(typeof pick === "number" ? { pick } : {}),
      ...(typeof from === "string" ? { from } : {}),
    });
    logToolCall({ tool: name, query, sheet: result.sheet });
    return toolText(result);
  }
  throw new Error(`Unknown engine MCP tool '${String(name)}'.`);
}

/**
 * Handles one raw stdin line and returns the JSON-RPC response to write, or `undefined` when the
 * line must be consumed silently. Extracted so the stdio contract is testable without a live
 * `process.stdin`: this framing is the whole surface an authoring agent's MCP client speaks.
 */
export async function handleLine(line: string, manifestFile: string): Promise<string | undefined> {
  if (line.trim().length === 0) return undefined;
  let request: unknown;
  try {
    request = JSON.parse(line) as unknown;
  } catch (error) {
    return jsonRpcError(null, -32700, `Invalid JSON: ${String(error)}`);
  }
  if (!isRecord(request) || request.id === undefined || typeof request.method !== "string")
    return undefined;
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        capabilities: { tools: { listChanged: false } },
        instructions: AUTHORING_INSTRUCTIONS,
        protocolVersion: "2025-06-18",
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.12" },
      });
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS });
    }
    if (request.method === "tools/call") {
      if (!isRecord(request.params)) throw new Error("tools/call requires an object params value.");
      return jsonRpcResult(request.id, await handleToolCall(request.params, manifestFile));
    }
    return jsonRpcError(request.id, -32601, `Method not found: ${request.method}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // A rejected call is the most useful line in the log: it is where an authoring agent asked
    // for something the engine could not answer.
    if (request.method === "tools/call") logToolCall({ error: message, request: request.params });
    return jsonRpcError(request.id, -32000, message);
  }
}

/**
 * One tool call from the command line: `engine.mjs <tool> '<json arguments>'` prints the tool's
 * text and exits 0, or names the error and exits 1. A session started outside the project never
 * loads its `.mcp.json`, and this is how it still searches (PRD-750 kit-loop row 1).
 */
export async function runCli(
  argv: readonly string[],
  manifestFile = defaultManifestPath(),
  io: { stderr: (text: string) => void; stdout: (text: string) => void } = {
    stderr: (text: string) => void process.stderr.write(text),
    stdout: (text: string) => void process.stdout.write(text),
  },
): Promise<number> {
  const [name, json = "{}"] = argv;
  try {
    const result = await handleToolCall(
      { arguments: JSON.parse(json) as unknown, name },
      manifestFile,
    );
    let text = result.content[0].text;
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      // Not JSON: print it as the tool wrote it.
    }
    io.stdout(`${text}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export function runServer(manifestFile = defaultManifestPath()): void {
  const tool = process.argv[2];
  if (tool?.startsWith("engine_") === true) {
    void runCli(process.argv.slice(2), manifestFile).then((code) => {
      process.exitCode = code;
    });
    return;
  }
  // Load before accepting requests. A missing manifest is a startup failure, never an empty tool
  // response that an authoring agent could mistake for the engine having no capabilities.
  loadCapabilityManifest(manifestFile);
  const input = createInterface({ input: process.stdin });
  void loadReferenceIndex().catch((error: unknown) => process.stderr.write(`${String(error)}\n`));
  input.on("line", (line) => {
    void handleLine(line, manifestFile).then((response) => {
      if (response !== undefined) writeLine(response);
    });
  });
}

const entryPath = process.argv[1];
if (
  entryPath !== undefined &&
  realpathSync(path.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))
) {
  try {
    runServer();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
