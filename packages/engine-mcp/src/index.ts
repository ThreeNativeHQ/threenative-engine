import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
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
  /**
   * Suggestions under the relevance floor, on a generic `none` only (PRD-063). They share a
   * situation word but are not binding capabilities, and a not-owned request never carries them:
   * "write it in src/" is then the whole answer, and a near symbol would send the author elsewhere.
   */
  readonly nearMatches?: readonly ICapabilityNearMatch[];
}

/** One row of `nearMatches`: enough to recognise the capability, none of the detail a hit carries. */
export interface ICapabilityNearMatch {
  readonly symbol: string;
  readonly importPath: string;
  readonly summary: string;
  readonly matchedSituation: string;
  readonly score: number;
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
/** A miss still shows this many rows that shared a situation word, so the author sees what is near. */
const MAX_NEAR_MATCHES = 3;
/** Chosen by the current-manifest threshold sweep: the highest recalled candidate at 0.27. */
export const RELEVANCE_FLOOR = 0.27;
const AUTHORING_INSTRUCTIONS =
  "Follow the Authoring flow in the game's AGENTS.md (the threenative-capabilities skill holds the detail): search capabilities and references before the first new src/ file, for a new game and for every change to an existing game. Follow binding capability constraints. Execute with subagents focused on specific areas: bounded tasks, file ownership, then coordinator integration before mechanics playtests. Use reference cards to build similar mechanics tuned to this game. Read relevant pinned source only for open questions and when authorized. Cite file:line. Keep upstream code, close translations, level layouts, character names, and distinctive audiovisual elements out of the game.";
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

/** Every search and detail call reads the manifest, so a parsed copy is kept per file and
 * reused until the file's mtime or size changes. Callers only read it. */
const manifestCache = new Map<string, { stamp: string; manifest: ICapabilityManifest }>();

export function loadCapabilityManifest(file = defaultManifestPath()): ICapabilityManifest {
  let raw: string;
  let stamp: string;
  try {
    const stat = statSync(file);
    stamp = `${stat.mtimeMs}:${stat.size}`;
    const cached = manifestCache.get(file);
    if (cached?.stamp === stamp) return cached.manifest;
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw manifestError(file, `cannot read committed manifest: ${String(error)}`);
  }
  try {
    const manifest = validateManifest(JSON.parse(raw) as unknown, file);
    manifestCache.set(file, { stamp, manifest });
    return manifest;
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
 * already ships. Identifiers use unstemmed words so ordinary inflections cannot spell a symbol.
 */
function stem(token: string): string {
  if (token === "leaves") return "leaf";
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

/** Search tokenizes every entry's situations on every call; the text repeats, so the result is
 * kept. Frozen so a caller cannot change a shared array. */
const tokenCache = new Map<string, readonly string[]>();
// ponytail: clear-all at 20k strings; an LRU only if a long-lived server ever thrashes it.
const TOKEN_CACHE_LIMIT = 20_000;

function tokens(value: string): readonly string[] {
  let cached = tokenCache.get(value);
  if (cached === undefined) {
    if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
    cached = Object.freeze(capabilitySituationTokens(value));
    tokenCache.set(value, cached);
  }
  return cached;
}

/** Field normalization is independent of how much prose a package documents for an export. */
interface IIndexedPhrase {
  readonly text: string;
  readonly words: readonly string[];
  readonly terms: ReadonlyMap<string, number>;
  readonly boost: number;
}

function lexicalIndex<T>(
  rows: readonly T[],
  fieldsOf: (row: T) => readonly (readonly string[])[],
  boosts: readonly number[],
) {
  const fields = rows.map((row) =>
    fieldsOf(row).map((phrases) => phrases.map((text) => ({ text, words: tokens(text) }))),
  );
  const lengths = boosts.map((_, field) => {
    const phrases = fields.flatMap((row) => row[field] ?? []).filter(({ words }) => words.length);
    return phrases.reduce((sum, { words }) => sum + words.length, 0) / (phrases.length || 1);
  });
  const frequency = new Map<string, number>();
  const documents = fields.map((row) => {
    const seen = new Set<string>();
    const indexed = row.map((phrases, field) =>
      phrases.map(({ text, words }): IIndexedPhrase => {
        const terms = new Map<string, number>();
        for (const word of words) {
          seen.add(word);
          terms.set(word, (terms.get(word) ?? 0) + 1);
        }
        const average = lengths[field] || 1;
        const norm = 1 - BM25_B + BM25_B * (words.length / average);
        return { boost: (boosts[field] ?? 0) / norm, terms, text, words };
      }),
    );
    for (const word of seen) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    return indexed;
  });
  const idf = new Map<string, number>();
  for (const [word, df] of frequency) {
    idf.set(word, Math.log1p((rows.length - df + 0.5) / (df + 0.5)));
  }
  return { documents, idf };
}

const BM25_B = 0.45;
const BM25_K1 = 1.2;
const DISTINCTIVE_FLOOR = Math.log1p(1 / 0.02);
const CAPABILITY_IDF_LIMIT = 4;

function hasTokenSubsequence(haystack: readonly string[], needle: readonly string[]): boolean {
  return (
    needle.length > 0 &&
    needle.length <= haystack.length &&
    haystack.some(
      (word, start) =>
        word === needle[0] && needle.every((part, offset) => haystack[start + offset] === part),
    )
  );
}

function lexicalQuery(
  words: readonly string[],
  idf: ReadonlyMap<string, number>,
  maxWeight = Number.POSITIVE_INFINITY,
) {
  const weights = new Map(
    [...new Set(words)].map((word) => [word, Math.min(idf.get(word) ?? 2, maxWeight)]),
  );
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return { total, weights, words };
}

type ILexicalQuery = ReturnType<typeof lexicalQuery>;

interface IFieldMatch {
  readonly phrase: IIndexedPhrase;
  readonly boost: number;
  readonly score: number;
  readonly count: number;
  readonly exact: boolean;
  readonly distinctive: boolean;
}

function scoreField(phrase: IIndexedPhrase, query: ILexicalQuery): IFieldMatch | undefined {
  let matched = 0;
  let count = 0;
  let score = 0;
  for (const [word, tf] of phrase.terms) {
    const weight = query.weights.get(word);
    if (weight === undefined) continue;
    matched += weight;
    count += 1;
    score += weight * saturate(tf * phrase.boost);
  }
  if (count === 0) return undefined;
  const exact =
    hasTokenSubsequence(query.words, phrase.words) ||
    hasTokenSubsequence(phrase.words, query.words);
  const bonus = exact ? 1.6 : 1;
  const distinctive =
    (exact && (count > 1 || query.weights.size === 1 || matched >= DISTINCTIVE_FLOOR)) ||
    (matched >= DISTINCTIVE_FLOOR && (count > 1 || phrase.words.length <= 3));
  return { boost: phrase.boost * bonus, count, distinctive, exact, phrase, score: score * bonus };
}

/** There can be many ways to ask for the same mechanic. Only the best phrase in a field votes. */
function bestField(
  phrases: readonly IIndexedPhrase[] | undefined,
  query: ILexicalQuery,
  isAlias = false,
) {
  let best: IFieldMatch | undefined;
  for (const phrase of phrases ?? []) {
    const match = scoreField(phrase, query);
    if (match === undefined || (isAlias && match.count === 1 && phrase.words.length > 1)) continue;
    if (best === undefined || match.score > best.score) best = match;
  }
  return best;
}

function saturate(tf: number): number {
  return ((BM25_K1 + 1) * tf) / (BM25_K1 + tf);
}

/** BM25F saturates term frequency after combining the independently normalized fields. */
function bm25f(
  query: ILexicalQuery,
  fields: readonly (IFieldMatch | undefined)[],
  clauses: readonly ILexicalQuery[] = [],
): number {
  if (fields.every((field) => field === undefined)) return 0;
  let matched = 0;
  let score = 0;
  for (const [word, weight] of query.weights) {
    let tf = 0;
    for (const field of fields) {
      if (field !== undefined) tf += field.boost * (field.phrase.terms.get(word) ?? 0);
    }
    if (tf === 0) continue;
    matched += weight;
    score += weight * saturate(tf);
  }
  if (matched === 0) return 0;
  let coverage = matched / query.total;
  for (const clause of clauses) {
    let clauseMatched = 0;
    let count = 0;
    for (const [word, weight] of clause.weights) {
      if (!fields.some((field) => field?.phrase.terms.has(word))) continue;
      clauseMatched += weight;
      count += 1;
    }
    if (count > 1) coverage = Math.max(coverage, 0.55 * (clauseMatched / clause.total));
  }
  // Reward corroborating terms with diminishing returns so one rare scene detail cannot lead.
  const evidence = 1 - 0.25 * Math.exp(-matched / 5);
  return (score / matched) * coverage ** 0.65 * evidence;
}

function weakMatch(score: number): number {
  return (RELEVANCE_FLOOR * score) / (1 + score);
}

/** Identifier matching uses whole, unstemmed words and runs before field scoring. */
function nameWords(value: string): string[] {
  return splitSymbolCase(value.replace(/([a-zA-Z])(\d+)/gu, "$1 $2"))
    .toLowerCase()
    .split(/[^a-z]+/u)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function normaliseName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function spelledNames(value: string): ReadonlySet<string> {
  const words = value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const names = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    let name = "";
    for (const word of words.slice(start, start + 4)) {
      name += word;
      names.add(name);
    }
  }
  return names;
}

function capabilityQuery(
  situation: string,
  idf: ReadonlyMap<string, number>,
  scope: "mechanic" | "request",
) {
  const clauses = scope === "request" ? situation.split(/[,;:\n]|[.!?]+(?=\s|$)/u) : [situation];
  const identifiers = situation.match(/[a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)*/gu) ?? [];
  const verbatim = new Set(identifiers);
  // A method spelling also names its exported class, such as `Scene.render`.
  for (const identifier of identifiers) {
    const qualified = /^([A-Z][\w$]*)\./u.exec(identifier)?.[1];
    if (qualified !== undefined) verbatim.add(qualified);
  }
  // Rare props and scene details should leave room for the mechanic a request asks for.
  return {
    ...lexicalQuery(tokens(situation), idf, CAPABILITY_IDF_LIMIT),
    clauses,
    clauseQueries:
      clauses.length < 2
        ? []
        : clauses
            .map((clause) => lexicalQuery(tokens(clause), idf, CAPABILITY_IDF_LIMIT))
            .filter((clause) => clause.weights.size > 1),
    names: spelledNames(situation),
    nameWords: nameWords(situation),
    normalised: normaliseName(situation),
    verbatim,
  };
}

type ICapabilityQuery = ReturnType<typeof capabilityQuery>;

interface IIndexedSymbol {
  readonly name: string;
  readonly specificity: number;
  readonly words: readonly string[];
}

function scoreSymbolName(
  entry: ICapabilityEntry,
  { name, specificity, words }: IIndexedSymbol,
  query: ICapabilityQuery,
) {
  if (query.normalised === name) return { score: 5, specificity };
  if (query.verbatim.has(entry.symbol) && /[A-Z0-9.]/u.test(entry.symbol)) {
    return { score: 4, specificity };
  }

  const share = Math.min(1, specificity / query.total);
  if (query.names.has(name)) {
    if (words.length > 1) return { score: 2 + share, specificity };
    if (specificity >= 2.5 && share >= 0.3) return { score: 3.4 * share, specificity };
  }
  if (words.length > 1 && hasTokenSubsequence(query.nameWords, words)) {
    return { score: 1.8 + share, specificity };
  }
  if (
    words.length > 1 &&
    specificity >= DISTINCTIVE_FLOOR &&
    words.every((word) => query.nameWords.includes(word))
  ) {
    return { score: 0.55 + share * 0.6, specificity };
  }
  return undefined;
}

const LIFECYCLE_INTENT = new Map<string, RegExp>([
  [
    "ctx.quit",
    /\bquit\b|\b(?:close|exit)\s+(?:the\s+)?(?:app(?:lication)?|game|window)\b|\b(?:app(?:lication)?|game|window)\s+(?:is\s+)?(?:closed|closes)\b/iu,
  ],
  [
    "leaveScene",
    /\b(?:leave|leaving|exit|exiting|unload)\s+(?:(?:the|a|current)\s+)*(?:scene|level)\b/iu,
  ],
  [
    "onLaunchFailure",
    /\b(?:launch|startup|boot)\s+(?:fails?|failed|failure|error|crash)\b|\b(?:fail(?:s|ed)?|error|crash)\s+(?:to\s+|during\s+)?(?:launch|start|boot)\b/iu,
  ],
]);

interface ICapabilityScore {
  readonly matchedSituation: string;
  readonly score: number;
  readonly specificity: number;
}

function capabilityScore(
  query: ICapabilityQuery,
  entry: ICapabilityEntry,
  nameInfo: IIndexedSymbol,
  fields: readonly (readonly IIndexedPhrase[])[],
  scope: "mechanic" | "request",
): ICapabilityScore {
  const symbol = scoreSymbolName(entry, nameInfo, query);
  const intent = LIFECYCLE_INTENT.get(entry.symbol);
  const explicit =
    intent === undefined ||
    (scope === "mechanic" && entry.symbol !== "ctx.quit") ||
    query.verbatim.has(entry.symbol) ||
    query.normalised === nameInfo.name ||
    query.clauses.some((clause) => intent.test(clause));
  if (symbol !== undefined && explicit && symbol.score >= 1.8) {
    return { ...symbol, matchedSituation: entry.symbol };
  }
  const name = bestField(fields[0], query);
  const alias = bestField(fields[1], query, true);
  const situation = bestField(fields[2], query);
  const summary = bestField(fields[3], query);
  const anchoredName =
    name !== undefined &&
    (name.count > 1 || (name.phrase.words[0] === query.words[0] && (situation?.count ?? 0) > 1));
  const lexical = bm25f(
    query,
    [anchoredName ? name : undefined, alias, situation, summary],
    query.clauseQueries,
  );
  const distinctive =
    (alias?.distinctive && entry.situations.length > 0) ||
    situation?.distinctive ||
    summary?.distinctive;
  const score = distinctive && explicit ? lexical : weakMatch(lexical);
  if (symbol !== undefined && explicit && symbol.score > score) {
    return { ...symbol, matchedSituation: entry.symbol };
  }
  return {
    matchedSituation:
      lexical === 0 ? "" : (situation?.phrase.text ?? entry.situations[0] ?? entry.summary),
    score,
    specificity: 0,
  };
}

function notOwnedSituationScore(
  query: readonly string[],
  situations: readonly string[],
): { readonly matchedSituation: string; readonly score: number } {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  let best = 0;
  let matchedSituation = "";
  for (const situation of situations) {
    const phrase = tokens(situation);
    const overlap = new Set(phrase.filter((token) => query.includes(token))).size;
    const score = overlap / Math.max(query.length, phrase.length);
    const phraseBonus =
      hasTokenSubsequence(query, phrase) || hasTokenSubsequence(phrase, query) ? 1 : 0;
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
  // A kit that answers ends the search, so the suggestion column is not built for it either: the
  // response would otherwise carry nearMatches beside a verdict that is not a miss at all.
  const response = withReferenceTools(
    situation,
    searchMechanics(situation, manifest, scope, starterKits.length === 0),
  );
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

function indexCapabilities(entries: readonly ICapabilityEntry[]) {
  const { documents, idf } = lexicalIndex(
    entries,
    (entry) => [
      [entry.symbol],
      entry.aliases,
      entry.situations,
      entry.summary.split(/(?<=[.!?])\s+/u),
    ],
    [2.8, 2.1, 1.25, 0.4],
  );
  return {
    entries: entries.map((entry, index) => {
      const words = nameWords(entry.symbol);
      const specificity = words.reduce((sum, word) => sum + (idf.get(stem(word)) ?? 0), 0);
      return {
        entry,
        fields: documents[index] ?? [],
        symbol: { name: normaliseName(entry.symbol), specificity, words },
      };
    }),
    idf,
  };
}

const capabilityIndexes = new WeakMap<
  readonly ICapabilityEntry[],
  ReturnType<typeof indexCapabilities>
>();

function capabilityIndex(entries: readonly ICapabilityEntry[]) {
  let index = capabilityIndexes.get(entries);
  if (index === undefined) {
    index = indexCapabilities(entries);
    capabilityIndexes.set(entries, index);
  }
  return index;
}

function searchMechanics(
  situation: string,
  manifest: ICapabilityManifest,
  scope: "mechanic" | "request",
  /** False when a starter kit already answers: a suggestion beside a definite kit is noise. */
  suggest = true,
): ICapabilitySearchResponse {
  const limit = scope === "request" ? MAX_COMPLETE_REQUEST_RESULTS : MAX_SITUATION_RESULTS;
  const { entries, idf } = capabilityIndex(manifest.entries);
  const query = capabilityQuery(situation, idf, scope);
  const notOwned = notOwnedMatch(manifest, query.words);
  const specific =
    notOwned !== undefined && isSpecificNotOwnedMatch(query.words, notOwned.matchedSituation);
  // A not-owned entry can name an optional engine package (`procedural-environment`): the framework
  // has no such system, but that package is indexed here. Its own exports answer the query, beside
  // the install line; only a package the manifest does not index ends the search at `none`.
  const optionalPackage = specific ? `@threenative/${notOwned.entry.id}` : undefined;
  const includesEntry = (entry: ICapabilityEntry) =>
    optionalPackage === undefined ||
    entry.importPath === optionalPackage ||
    entry.importPath.startsWith(`${optionalPackage}/`);
  if (specific && !manifest.entries.some(includesEntry)) {
    return { guidance: notOwned.entry.guidance, results: [], verdict: "none" };
  }
  // A specific not-owned match already ties the request to the optional package.
  const floor = optionalPackage === undefined ? RELEVANCE_FLOOR : Number.MIN_VALUE;
  const seen = new Set<string>();
  const scored = entries
    .flatMap(({ entry, fields, symbol }) =>
      includesEntry(entry)
        ? [{ entry, ...capabilityScore(query, entry, symbol, fields, scope) }]
        : [],
    )
    .filter(({ matchedSituation }) => matchedSituation.length > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.specificity - left.specificity ||
        `${left.entry.importPath}:${left.entry.symbol}`.localeCompare(
          `${right.entry.importPath}:${right.entry.symbol}`,
        ),
    )
    .filter(({ entry }) => {
      const key = capabilitySearchKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const results = scored
    .filter(({ score }) => score >= floor)
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
  if (results.length > 0)
    return { guidance: specific ? notOwned.entry.guidance : "", results, verdict: "matched" };
  // Only a generic miss suggests anything: "write it in src/" is the whole answer for a not-owned
  // request, and an empty list is noise beside a definite one.
  const nearMatches =
    suggest && notOwned === undefined
      ? scored
          .filter(({ score }) => score < floor)
          .slice(0, MAX_NEAR_MATCHES)
          .map(({ entry, matchedSituation, score }) => ({
            importPath: entry.importPath,
            matchedSituation,
            score,
            summary: entry.summary,
            symbol: entry.symbol,
          }))
      : [];
  return {
    guidance: notOwned?.entry.guidance ?? GENERIC_GUIDANCE,
    results: [],
    verdict: "none",
    ...(nearMatches.length > 0 ? { nearMatches } : {}),
  };
}

function editDistance(a: string, b: string): number {
  let costs = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      next.push(
        Math.min(
          (next[j] ?? 0) + 1,
          (costs[j + 1] ?? 0) + 1,
          (costs[j] ?? 0) + (a[i] === b[j] ? 0 : 1),
        ),
      );
    }
    costs = next;
  }
  return costs[b.length] ?? a.length;
}

function nearbySymbols(symbol: string, entries: readonly ICapabilityEntry[]): string {
  const sought = normaliseName(symbol);
  if (sought.length < 3 || sought.length > 80) return "";
  const names = [...new Set(entries.map((entry) => entry.symbol))];
  const best = names
    .map((name) => {
      const full = normaliseName(name);
      const member = normaliseName(name.split(".").at(-1) ?? name);
      const distance = [full, member]
        .filter((part) => Math.abs(part.length - sought.length) <= 2)
        .reduce((lowest, part) => Math.min(lowest, editDistance(part, sought)), 3);
      return { distance, name };
    })
    .filter(({ distance }) => distance <= (sought.length >= 7 ? 2 : 1))
    .sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name))
    .slice(0, 3);
  return best.length ? ` Did you mean ${best.map(({ name }) => `'${name}'`).join(" or ")}?` : "";
}

/**
 * Every manifest entry named `symbol` (optionally in one `importPath`); throws when there is none.
 * Two packages can export one name (`createThreeObject` from raw-unreal and ueformat), so a lookup
 * by name alone must return both.
 */
export function capabilityDetails(
  symbol: string,
  manifestFile = defaultManifestPath(),
  importPath?: string,
): readonly ICapabilityDetail[] {
  if (typeof symbol !== "string" || symbol.trim().length === 0)
    throw new Error("engine_capability_detail requires a non-empty symbol string.");
  const entries = loadCapabilityManifest(manifestFile).entries.filter(
    (candidate) => importPath === undefined || candidate.importPath === importPath,
  );
  const matches = entries.filter((candidate) => candidate.symbol === symbol);
  if (matches.length === 0)
    throw new Error(
      `Unknown engine capability '${symbol}'${importPath === undefined ? "" : ` in '${importPath}'`}.${nearbySymbols(symbol, entries)}`,
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
      'Search the installed engine by concrete gameplay mechanic or by an exact exported symbol name. Decompose genres first. Use scope "request" for the mechanically explicit full request and "mechanic" for each focused search; matchedSituation and score explain every result. A row carries the answer (importPath, signature, example, constraints, overrides, deprecations), so call engine_capability_detail only for a symbol the search did not return. The response verdict "none" is an actionable answer with guidance, not a failed search; its nearMatches are below-floor suggestions that are not binding capabilities.',
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
      "Reverse engineer classic games: search mechanic cards and repository map nodes from their decomps. Tier-2 titles link to repos to explore and save. References describe feel only; borrow algorithms, cite pinned sources, copy no code or art. An empty reply lists nearMatches: near misses that are suggestions, not capabilities.",
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
  const { documents, idf } = lexicalIndex(
    candidates,
    (stub) => [[stub.name], [stub.title], stub.tags, [stub.summary]],
    [2.4, 1.6, 1.2, 0.7],
  );
  const query = lexicalQuery(tokens(situation), idf);
  const scored = candidates.map((stub, index) => {
    const matches = documents[index]?.map((field) => bestField(field, query)) ?? [];
    const [name, title, tag, summary] = matches;
    const score = bm25f(query, matches);
    const content = [name, tag, summary].reduce<IFieldMatch | undefined>(
      (best, match) =>
        match !== undefined && (best === undefined || match.score > best.score) ? match : best,
      undefined,
    );
    const matched = content ?? title;
    const relevant = matches.some((match) => match?.distinctive);
    return {
      near: { score, situation: matched?.phrase.text ?? "" },
      stub: {
        ...stub,
        matchedSituation: relevant ? (matched?.phrase.text ?? "") : "",
        score: relevant ? score : 0,
      },
    };
  });
  const results = scored
    .filter(({ stub }) => stub.score >= RELEVANCE_FLOOR)
    .sort((a, b) => b.stub.score - a.stub.score || a.stub.id.localeCompare(b.stub.id))
    .slice(0, limit)
    .map(({ stub }) => stub);
  // Built only on a miss, so a full reply pays nothing for a column it does not show.
  const nearMatches = results.length === 0 ? referenceSuggestions(scored) : [];
  return {
    guidance: "",
    results,
    // An empty reply still names what came close, with the ids engine_reference_detail takes, so a
    // miss is not a dead end (PRD-063). The score is the one the phrase reached: a capability search
    // drops a row for being under the floor, while a reference search also drops it for resting on a
    // word too common to answer alone, so a suggestion here can outscore the floor and still not be
    // a result. Reference rows carry no binding promise either way.
    ...(nearMatches.length > 0 ? { nearMatches } : {}),
  };
}

/** The near misses of a reference search, in the shape engine_reference_detail can open. */
function referenceSuggestions(
  scored: readonly {
    near: { score: number; situation: string };
    stub: Record<string, unknown> & {
      game: string;
      id: string;
      kind: string;
      summary: string;
      title: string;
    };
  }[],
): readonly Record<string, unknown>[] {
  return scored
    .filter(({ near }) => near.score > 0 && near.situation.length > 0)
    .sort((a, b) => b.near.score - a.near.score || a.stub.id.localeCompare(b.stub.id))
    .slice(0, MAX_NEAR_MATCHES)
    .map(({ near, stub }) => ({
      game: stub.game,
      id: stub.id,
      kind: stub.kind,
      matchedSituation: near.situation,
      // A tier-2 title is a repository, not a card: engine_reference_detail refuses kind "game", so
      // the link is what makes the suggestion actionable.
      ...("repo" in stub && typeof stub.repo === "string" && stub.repo.length > 0
        ? { repo: stub.repo }
        : {}),
      score: near.score,
      summary: stub.summary,
      title: stub.title,
    }));
}

function searchSituation(tool: string, argumentsValue: Record<string, unknown>): string {
  const { situation, query } = argumentsValue;
  if (typeof situation === "string" && situation.trim().length > 0) return situation;
  const hint = query === undefined ? "" : " Pass 'situation' instead of 'query'.";
  throw new Error(`${tool} requires a string 'situation' argument with text.${hint}`);
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
    const situation = searchSituation(name, argumentsValue);
    const scope = argumentsValue.scope === undefined ? "mechanic" : argumentsValue.scope;
    if (scope !== "request" && scope !== "mechanic")
      throw new Error("engine_search_capabilities scope must be 'request' or 'mechanic'.");
    const response = searchCapabilities(situation, manifestFile, scope);
    logToolCall({
      results: response.results.map((result) => result.symbol),
      scope,
      situation,
      tool: name,
      verdict: response.verdict,
    });
    // Up to three reference stubs on every search; an offline host still gets its capability hits.
    return toolText({
      ...response,
      references: await searchReferences(situation, 3).catch((error: unknown) => ({
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
    const situation = searchSituation(name, argumentsValue);
    const response = await searchReferences(situation);
    logToolCall({
      tool: name,
      situation,
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
      throw new Error(
        'engine_reference_detail requires "game" and "id" strings and "kind":"node" or "kind":"card".',
      );
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
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.26" },
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
