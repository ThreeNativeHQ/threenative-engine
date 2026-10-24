import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

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

export interface ICapabilitySearchResult {
  readonly symbol: string;
  readonly importPath: string;
  readonly summary: string;
  readonly example: string;
  readonly constraints: readonly string[];
  readonly requires?: readonly string[];
  readonly matchedSituation: string;
  readonly score: number;
}

export interface ICapabilitySearchResponse {
  /** Present when the request names a genre or game a starter kit covers; it leads the response. */
  readonly starterKits?: readonly IStarterKitResult[];
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
    readonly openWorldHint: false;
    readonly readOnlyHint: true;
  };
  readonly inputSchema: {
    readonly type: "object";
    readonly properties: Record<
      string,
      {
        readonly description?: string;
        readonly enum?: readonly string[];
        readonly type: "string";
      }
    >;
    readonly required: readonly string[];
    readonly additionalProperties: false;
  };
}

export const ENGINE_MCP_TOOL_NAMES = [
  "engine_search_capabilities",
  "engine_capability_detail",
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
  'Before authoring, infer concrete gameplay mechanics. Preserve the request\'s distinctive fantasy: choose the smallest loop that uses its characteristic setting, traversal medium, or simulation instead of a generic character game with themed props, and search those implied mechanics even when the user did not name engine terms. Search the mechanically explicit complete request with scope "request", then each mechanic with scope "mechanic". When the request names a game or genre a starter kit covers (engine_search_capabilities leads with it), scaffold from that kit first with the command it gives, then search the mechanics the kit does not cover. Inspect capability detail and obey constraints before implementing. Capability detail is authoritative on platform support: never invent a platform limitation it does not state. A response with verdict "none" is an actionable answer: follow its guidance and write game-owned behavior in src/ instead of rephrasing the same request.';
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

export function capabilitySituationTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token))
    .map(stem);
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
function tokenWeights(entries: readonly ICapabilityEntry[]): ReadonlyMap<string, number> {
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
  return kits
    .map((kit) => ({
      at: Math.min(...kit.words.map((word) => request.indexOf(words(word))).filter((i) => i >= 0)),
      kit,
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
  const response = searchMechanics(situation, manifest, scope);
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

function searchMechanics(
  situation: string,
  manifest: ICapabilityManifest,
  scope: "mechanic" | "request",
): ICapabilitySearchResponse {
  const query = tokens(situation);
  const limit = scope === "request" ? MAX_COMPLETE_REQUEST_RESULTS : MAX_SITUATION_RESULTS;
  const weights = tokenWeights(manifest.entries);
  const notOwned = notOwnedMatch(manifest, query);
  if (notOwned !== undefined && isSpecificNotOwnedMatch(query, notOwned.matchedSituation)) {
    return {
      guidance: notOwned.entry.guidance,
      results: [],
      verdict: "none",
    };
  }
  const results = manifest.entries
    .map((entry) => ({ entry, ...situationScore(query, entry.situations, entry.aliases, weights) }))
    .filter(
      ({ matchedSituation, score }) => matchedSituation.length > 0 && score >= RELEVANCE_FLOOR,
    )
    .sort(
      (left, right) =>
        right.score - left.score ||
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
      example: entry.example,
      importPath: entry.importPath,
      matchedSituation,
      ...(entry.requires === undefined ? {} : { requires: entry.requires }),
      score,
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
      'Search the installed engine by concrete gameplay mechanic. Decompose genres first. Use scope "request" for the mechanically explicit full request and "mechanic" for each focused search; matchedSituation and score explain every result. The response verdict "none" is an actionable answer with guidance, not a failed search.',
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

function toolText(value: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ text: JSON.stringify(value, null, 2), type: "text" }] };
}

function handleToolCall(
  params: Record<string, unknown>,
  manifestFile: string,
): { content: [{ type: "text"; text: string }] } {
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
    return toolText(response);
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
  throw new Error(`Unknown engine MCP tool '${String(name)}'.`);
}

/**
 * Handles one raw stdin line and returns the JSON-RPC response to write, or `undefined` when the
 * line must be consumed silently. Extracted so the stdio contract is testable without a live
 * `process.stdin`: this framing is the whole surface an authoring agent's MCP client speaks.
 */
export function handleLine(line: string, manifestFile: string): string | undefined {
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
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.6" },
      });
    }
    if (request.method === "tools/list") {
      return jsonRpcResult(request.id, { tools: TOOL_DEFINITIONS });
    }
    if (request.method === "tools/call") {
      if (!isRecord(request.params)) throw new Error("tools/call requires an object params value.");
      return jsonRpcResult(request.id, handleToolCall(request.params, manifestFile));
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

export function runServer(manifestFile = defaultManifestPath()): void {
  // Load before accepting requests. A missing manifest is a startup failure, never an empty tool
  // response that an authoring agent could mistake for the engine having no capabilities.
  loadCapabilityManifest(manifestFile);
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const response = handleLine(line, manifestFile);
    if (response !== undefined) writeLine(response);
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
