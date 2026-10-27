#!/usr/bin/env node
import { realpathSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, renameSync, readdirSync } from 'fs';
import path2 from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import os from 'os';
import { gunzipSync } from 'zlib';

var DEFAULT_REFERENCES_URL = "https://github.com/ThreeNativeHQ/threenative-reverse-engineer-mcp/releases/latest/download/";
var FETCH_TIMEOUT_MS = 5e3;
var GAME_FETCH_TIMEOUT_MS = 3e4;
var ID = /^[a-z0-9][a-z0-9-]*$/u;
function referencesBaseUrl() {
  const value = process.env.THREENATIVE_REFERENCES_URL?.trim() || DEFAULT_REFERENCES_URL;
  return value.endsWith("/") ? value : `${value}/`;
}
function referencesCacheDir() {
  const override = process.env.THREENATIVE_REFERENCES_CACHE?.trim();
  const source = createHash("sha256").update(referencesBaseUrl()).digest("hex").slice(0, 16);
  if (override) return path2.join(path2.resolve(override), source);
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path2.join(os.homedir(), ".cache");
  return path2.join(cacheHome, "threenative", "refs", source);
}
function localReferencesDir(cwd = process.cwd()) {
  return path2.join(cwd, ".threenative", "refs");
}
function fail(where, reason) {
  throw new Error(`TN_REFERENCES_MALFORMED: ${where}: ${reason}`);
}
function record(value, where, keys) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(where, "expected an object");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0)
    fail(where, `unknown field ${unknown.map((key) => `'${key}'`).join(", ")}`);
  return value;
}
function text(value, where) {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(where, "expected a non-empty string");
  if (/```|~~~/u.test(value)) fail(where, "holds a code block; describe the behaviour instead");
  return value;
}
function id(value, where) {
  const result = text(value, where);
  if (!ID.test(result)) fail(where, `'${result}' is not a lowercase kebab-case id`);
  return result;
}
function texts(value, where) {
  if (!Array.isArray(value)) fail(where, "expected an array of strings");
  return value.map((entry, index) => text(entry, `${where}[${index}]`));
}
function list(value, where, item) {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value.map((entry, index) => item(entry, `${where}[${index}]`));
}
function line(value, where) {
  if (!Number.isInteger(value) || value < 1) fail(where, "expected a line number");
  return value;
}
function sourcePath(value, where) {
  const result = text(value, where);
  if (path2.isAbsolute(result) || result.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/u.test(result))
    fail(where, "expected a safe relative source path");
  return result;
}
function prose(value, where) {
  const result = text(value, where);
  if (result.includes("```")) fail(where, "holds a code block; describe the behaviour instead");
  return result;
}
function validateStub(value, where) {
  const stub = record(value, where, [
    "id",
    "game",
    "kind",
    "name",
    "summary",
    "tags",
    "capabilities"
  ]);
  if (stub.kind !== "node" && stub.kind !== "card") fail(`${where}.kind`, "expected node or card");
  return {
    capabilities: texts(stub.capabilities, `${where}.capabilities`),
    game: id(stub.game, `${where}.game`),
    id: id(stub.id, `${where}.id`),
    kind: stub.kind,
    name: text(stub.name, `${where}.name`),
    summary: prose(stub.summary, `${where}.summary`),
    tags: texts(stub.tags, `${where}.tags`)
  };
}
function validateReferenceIndex(value, where = "index") {
  const index = record(value, where, ["version", "games", "stubs"]);
  if (index.version !== 1) fail(`${where}.version`, "expected 1");
  const games = list(index.games, `${where}.games`, (entry, at) => {
    const game = record(entry, at, ["id", "title", "platform", "repo", "tier"]);
    if (game.tier !== 1 && game.tier !== 2) fail(`${at}.tier`, "expected 1 or 2");
    return {
      id: id(game.id, `${at}.id`),
      platform: text(game.platform, `${at}.platform`),
      repo: text(game.repo, `${at}.repo`),
      tier: game.tier,
      title: text(game.title, `${at}.title`)
    };
  });
  const stubs = list(index.stubs, `${where}.stubs`, validateStub);
  unique(
    games.map((game) => game.id),
    `${where}.games`
  );
  unique(
    stubs.map((stub) => `${stub.game}/${stub.kind}/${stub.id}`),
    `${where}.stubs`
  );
  for (const stub of stubs)
    if (!games.some((game) => game.id === stub.game)) fail(where, `missing game '${stub.game}'`);
  return { games, stubs, version: 1 };
}
function validateNode(value, where) {
  const node = record(value, where, [
    "id",
    "name",
    "purpose",
    "parent",
    "paths",
    "functions",
    "dependsOn"
  ]);
  return {
    dependsOn: texts(node.dependsOn, `${where}.dependsOn`),
    functions: list(node.functions, `${where}.functions`, (entry, at) => {
      const fn = record(entry, at, ["name", "path", "lines"]);
      if (!Array.isArray(fn.lines) || fn.lines.length !== 2)
        fail(`${at}.lines`, "expected [from, to]");
      const from = line(fn.lines[0], `${at}.lines[0]`);
      const to = line(fn.lines[1], `${at}.lines[1]`);
      if (to < from) fail(`${at}.lines`, "ends before it starts");
      return {
        lines: [from, to],
        name: text(fn.name, `${at}.name`),
        path: sourcePath(fn.path, `${at}.path`)
      };
    }),
    id: id(node.id, `${where}.id`),
    name: text(node.name, `${where}.name`),
    paths: list(node.paths, `${where}.paths`, sourcePath),
    purpose: prose(node.purpose, `${where}.purpose`),
    ...node.parent === void 0 ? {} : { parent: id(node.parent, `${where}.parent`) }
  };
}
function validateCard(value, where) {
  const card = record(value, where, [
    "id",
    "node",
    "name",
    "summary",
    "behavior",
    "constants",
    "sources",
    "capabilities",
    "tags"
  ]);
  const sources = list(card.sources, `${where}.sources`, (entry, at) => {
    const source = record(entry, at, ["path", "line"]);
    return { line: line(source.line, `${at}.line`), path: sourcePath(source.path, `${at}.path`) };
  });
  if (sources.length === 0) fail(`${where}.sources`, "expected at least one source");
  return {
    behavior: prose(card.behavior, `${where}.behavior`),
    capabilities: texts(card.capabilities, `${where}.capabilities`),
    constants: list(card.constants, `${where}.constants`, (entry, at) => {
      const constant = record(entry, at, ["name", "value", "unit", "source"]);
      if ((typeof constant.value !== "number" || !Number.isFinite(constant.value)) && typeof constant.value !== "string")
        fail(`${at}.value`, "expected a number or a string");
      const source = text(constant.source, `${at}.source`);
      const citation = /^(.*):([1-9][0-9]*)$/u.exec(source);
      if (!citation) fail(`${at}.source`, "expected source path:line");
      sourcePath(citation[1], `${at}.source`);
      return {
        name: text(constant.name, `${at}.name`),
        source,
        unit: text(constant.unit, `${at}.unit`),
        value: typeof constant.value === "string" ? text(constant.value, `${at}.value`) : constant.value
      };
    }),
    id: id(card.id, `${where}.id`),
    name: text(card.name, `${where}.name`),
    node: id(card.node, `${where}.node`),
    sources,
    summary: prose(card.summary, `${where}.summary`),
    tags: texts(card.tags, `${where}.tags`)
  };
}
function unique(ids, where) {
  const seen = /* @__PURE__ */ new Set();
  for (const value of ids) {
    if (seen.has(value)) fail(where, `duplicate id '${value}'`);
    seen.add(value);
  }
}
function validateReferenceGame(value, where = "game") {
  const game = record(value, where, ["version", "id", "title", "repo", "sha", "nodes", "cards"]);
  if (game.version !== 1) fail(`${where}.version`, "expected 1");
  const nodes = list(game.nodes, `${where}.nodes`, validateNode);
  const cards = list(game.cards, `${where}.cards`, validateCard);
  unique(
    nodes.map((node) => node.id),
    `${where}.nodes`
  );
  unique(
    cards.map((card) => card.id),
    `${where}.cards`
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const dependency of node.dependsOn)
      if (!nodeIds.has(dependency)) fail(where, `missing dependency '${dependency}'`);
    const ancestors = /* @__PURE__ */ new Set([node.id]);
    let parent = node.parent;
    while (parent !== void 0) {
      if (ancestors.has(parent)) fail(where, `cyclic parent '${parent}'`);
      ancestors.add(parent);
      parent = nodes.find((entry) => entry.id === parent)?.parent;
    }
  }
  for (const node of nodes)
    if (node.parent !== void 0 && !nodeIds.has(node.parent))
      fail(`${where}.nodes.${node.id}.parent`, `no node '${node.parent}'`);
  for (const card of cards)
    if (!nodeIds.has(card.node)) fail(`${where}.cards.${card.id}.node`, `no node '${card.node}'`);
  const sha = text(game.sha, `${where}.sha`);
  if (!/^[0-9a-f]{40}$/u.test(sha)) fail(`${where}.sha`, "expected a commit SHA");
  return {
    cards,
    id: id(game.id, `${where}.id`),
    nodes,
    repo: text(game.repo, `${where}.repo`),
    sha,
    title: text(game.title, `${where}.title`),
    version: 1
  };
}
function referenceStubs(game) {
  return [
    ...game.nodes.map((node) => ({
      capabilities: [],
      game: game.id,
      id: node.id,
      kind: "node",
      name: node.name,
      summary: node.purpose,
      tags: []
    })),
    ...game.cards.map((card) => ({
      capabilities: card.capabilities,
      game: game.id,
      id: card.id,
      kind: "card",
      name: card.name,
      summary: card.summary,
      tags: card.tags
    }))
  ];
}
async function cachedAsset(name, parse, timeout = FETCH_TIMEOUT_MS) {
  const file = path2.join(referencesCacheDir(), name);
  const etagFile = `${file}.etag`;
  let response;
  try {
    const etag2 = existsSync(file) && existsSync(etagFile) ? readFileSync(etagFile, "utf8") : "";
    response = await fetch(new URL(name, referencesBaseUrl()), {
      headers: etag2.length > 0 ? { "if-none-match": etag2 } : {},
      signal: AbortSignal.timeout(timeout)
    });
  } catch (error) {
    if (existsSync(file)) return parse(readFileSync(file));
    throw new Error(`TN_REFERENCES_UNAVAILABLE: ${name}: ${String(error)}`);
  }
  if (response.status === 304 && existsSync(file)) return parse(readFileSync(file));
  if (!response.ok) {
    if (existsSync(file)) return parse(readFileSync(file));
    throw new Error(`TN_REFERENCES_UNAVAILABLE: ${name}: HTTP ${response.status}`);
  }
  let body;
  try {
    body = Buffer.from(await response.arrayBuffer());
  } catch (error) {
    if (existsSync(file)) return parse(readFileSync(file));
    throw new Error(`TN_REFERENCES_UNAVAILABLE: ${name}: ${String(error)}`);
  }
  const parsed = parse(body);
  mkdirSync(path2.dirname(file), { recursive: true });
  atomicWrite(file, body);
  const etag = response.headers.get("etag");
  if (etag === null) rmSync(etagFile, { force: true });
  else writeFileSync(etagFile, etag);
  return parsed;
}
function parseJson(body, name) {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    return fail(name, `cannot parse JSON: ${String(error)}`);
  }
}
var indexLoad;
var gameLoads = /* @__PURE__ */ new Map();
function loadReferenceIndex() {
  indexLoad ??= cachedAsset(
    "index.json.gz",
    (body) => validateReferenceIndex(parseJson(gunzipSync(body), "index.json.gz"), "index.json.gz")
  ).catch((error) => {
    indexLoad = void 0;
    throw error;
  });
  return indexLoad;
}
function loadLocalReferenceGames(cwd = process.cwd()) {
  const directory = localReferencesDir(cwd);
  if (!existsSync(directory)) return [];
  return readdirSync(directory).filter((file) => file.endsWith(".json")).sort().map((file) => {
    const game = validateReferenceGame(
      parseJson(readFileSync(path2.join(directory, file)), file),
      path2.join(".threenative", "refs", file)
    );
    if (game.id !== path2.basename(file, ".json"))
      fail(file, `id '${game.id}' differs from filename`);
    return game;
  });
}
function loadReferenceGame(gameId, cwd = process.cwd()) {
  id(gameId, "game id");
  const file = path2.join(localReferencesDir(cwd), `${gameId}.json`);
  if (existsSync(file)) {
    const local = validateReferenceGame(parseJson(readFileSync(file), file), file);
    if (local.id !== gameId) fail(file, `id '${local.id}' differs from requested '${gameId}'`);
    return Promise.resolve(local);
  }
  return loadReleaseReferenceGame(gameId);
}
function loadReleaseReferenceGame(gameId) {
  const name = `game-${id(gameId, "game id")}.json`;
  let load = gameLoads.get(name);
  if (load === void 0) {
    load = cachedAsset(
      name,
      (body) => {
        const game = validateReferenceGame(parseJson(body, name), name);
        if (game.id !== gameId) fail(name, `id '${game.id}' differs from requested '${gameId}'`);
        return game;
      },
      GAME_FETCH_TIMEOUT_MS
    ).catch((error) => {
      gameLoads.delete(name);
      throw error;
    });
    gameLoads.set(name, load);
  }
  return load;
}
function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, value);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
var CONTRIBUTION_REPO = "ThreeNativeHQ/threenative-reverse-engineer-mcp";
function saveReferenceGame(value, cwd = process.cwd()) {
  const incoming = record(value, "reference", [
    "version",
    "id",
    "title",
    "repo",
    "sha",
    "nodes",
    "cards"
  ]);
  const gameId = id(incoming.id, "reference.id");
  const file = path2.join(localReferencesDir(cwd), `${gameId}.json`);
  const previous = existsSync(file) ? validateReferenceGame(parseJson(readFileSync(file), file), file) : void 0;
  if (previous !== void 0 && previous.sha !== incoming.sha)
    fail(
      "reference.sha",
      `saved game '${gameId}' is pinned to ${previous.sha}; cannot merge revision ${String(incoming.sha)}`
    );
  const merge = (old, next) => {
    if (!Array.isArray(next)) fail("reference", "expected an array");
    const replacements = new Set(
      next.map(
        (entry) => typeof entry === "object" && entry !== null && "id" in entry ? entry.id : void 0
      )
    );
    return [...old.filter((entry) => !replacements.has(entry.id)), ...next];
  };
  const merged = validateReferenceGame(
    previous === void 0 ? incoming : {
      ...incoming,
      cards: merge(previous.cards, incoming.cards),
      nodes: merge(previous.nodes, incoming.nodes)
    },
    "reference"
  );
  mkdirSync(path2.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(merged, null, 2)}
`);
  const relative = path2.relative(cwd, file);
  const title = `Reference cards: ${merged.title} (${merged.nodes.length} nodes, ${merged.cards.length} cards)`;
  return {
    contribution: {
      command: `gh issue create --repo ${CONTRIBUTION_REPO} --title ${shellQuote(title)} --body-file ${shellQuote(relative)}`,
      title
    },
    saved: relative
  };
}

// src/index.ts
var ENGINE_MCP_TOOL_NAMES = [
  "engine_search_capabilities",
  "engine_capability_detail",
  "engine_search_references",
  "engine_reference_detail",
  "engine_save_reference"
];
var DEFAULT_MANIFEST_FILE = "capabilities.json";
var STOP_WORDS = /* @__PURE__ */ new Set([
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
  "your"
]);
var MAX_COMPLETE_REQUEST_RESULTS = 15;
var MAX_SITUATION_RESULTS = 5;
var RELEVANCE_FLOOR = 0.27;
var AUTHORING_INSTRUCTIONS = "Invoke threenative-capabilities to route authoring. New games: steps 1-8 \u2014 prompt, matching starter kit (minimal fallback), mechanics references PLUS built-in capabilities, core-mechanics plan via prd-creator, required textures, execute, mechanics playtest, reference-image visual judge. Existing games: steps 5-7 only \u2014 required textures, execute and mechanics playtest using existing context; no kit selection, rediscovery, whole-game replanning or added step 8. In both routes, execute plan with subagents focused on specific areas: bounded tasks, file ownership, then coordinator integration before step 7 mechanics playtests. Follow binding capability constraints. References borrow mechanics only: no code, level layouts, character names or art; cite pinned file:line sources.";
var GENERIC_GUIDANCE = "No installed engine capability matches this situation. Decompose it into concrete mechanics and write the game-owned behavior in your project's src/; inspect the relevant template AGENTS.md before adding a package.";
function defaultManifestPath(cwd = process.cwd()) {
  const override = process.env.THREENATIVE_CAPABILITIES_MANIFEST;
  if (override !== void 0 && override.trim().length > 0) return path2.resolve(cwd, override);
  for (let directory = path2.resolve(cwd); ; directory = path2.dirname(directory)) {
    const nodeModules = path2.join(directory, "node_modules");
    const installed = path2.join(nodeModules, "@threenative", "core", "capabilities.json");
    if (existsSync(installed)) {
      const relative = path2.relative(realpathSync(directory), realpathSync(nodeModules));
      if (relative !== ".." && !relative.startsWith(`..${path2.sep}`) && !path2.isAbsolute(relative))
        return installed;
    }
    const parent = path2.dirname(directory);
    if (parent === directory) break;
  }
  for (let directory = path2.dirname(fileURLToPath(import.meta.url)); ; directory = path2.dirname(directory)) {
    const repository = path2.join(directory, "packages", "core", "capabilities.json");
    if (existsSync(repository)) return repository;
    const parent = path2.dirname(directory);
    if (parent === directory) break;
  }
  return path2.resolve(cwd, DEFAULT_MANIFEST_FILE);
}
function manifestError(file, reason) {
  return new Error(`TN_ENGINE_CAPABILITIES_MANIFEST: ${file}: ${reason}`);
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function validateManifest(value, file) {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.entries) || !Array.isArray(value.notOwned)) {
    throw manifestError(
      file,
      "root must contain manifest version 2, entries array, and notOwned array"
    );
  }
  for (const [index, raw] of value.entries.entries()) {
    if (!isRecord(raw) || typeof raw.symbol !== "string" || typeof raw.package !== "string" || typeof raw.importPath !== "string" || typeof raw.kind !== "string" || typeof raw.signature !== "string" || typeof raw.summary !== "string" || typeof raw.example !== "string" || !Array.isArray(raw.situations) || !Array.isArray(raw.aliases) || !Array.isArray(raw.constraints) || raw.requires !== void 0 && !isStringArray(raw.requires) || raw.deprecated !== void 0 && !isStringArray(raw.deprecated) || !raw.situations.every((situation) => typeof situation === "string") || !raw.aliases.every((alias) => typeof alias === "string") || !raw.constraints.every((constraint) => typeof constraint === "string")) {
      throw manifestError(file, `entry ${index} is malformed`);
    }
  }
  for (const [index, raw] of (Array.isArray(value.starterKits) ? value.starterKits : []).entries()) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.title !== "string" || typeof raw.blurb !== "string" || !isStringArray(raw.words)) {
      throw manifestError(file, `starterKits ${index} is malformed`);
    }
  }
  const notOwnedIds = /* @__PURE__ */ new Set();
  for (const [index, raw] of value.notOwned.entries()) {
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.id.trim().length === 0 || !Array.isArray(raw.situations) || raw.situations.length === 0 || !raw.situations.every(
      (situation) => typeof situation === "string" && situation.trim().length > 0
    ) || typeof raw.guidance !== "string" || raw.guidance.trim().length === 0) {
      throw manifestError(file, `notOwned ${index} is malformed`);
    }
    if (notOwnedIds.has(raw.id)) {
      throw manifestError(file, `notOwned contains duplicate id '${raw.id}'`);
    }
    notOwnedIds.add(raw.id);
  }
  return value;
}
function loadCapabilityManifest(file = defaultManifestPath()) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw manifestError(file, `cannot read committed manifest: ${String(error)}`);
  }
  try {
    return validateManifest(JSON.parse(raw), file);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("TN_ENGINE_CAPABILITIES_MANIFEST:"))
      throw error;
    throw manifestError(file, `cannot parse JSON: ${String(error)}`);
  }
}
function undouble(stem2) {
  const last = stem2.at(-1);
  return stem2.length > 3 && last !== void 0 && last === stem2.at(-2) && !"aeiou".includes(last) ? stem2.slice(0, -1) : stem2;
}
function stem(token) {
  const stripped = suffixStripped(token);
  return stripped.length > 3 && stripped.endsWith("e") ? stripped.slice(0, -1) : stripped;
}
function suffixStripped(token) {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ing")) return undouble(token.slice(0, -3));
  if (token.length > 4 && token.endsWith("ed")) return undouble(token.slice(0, -2));
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}
function capabilitySituationTokens(value) {
  return value.toLocaleLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 1 && !STOP_WORDS.has(token)).map(stem);
}
var tokens = capabilitySituationTokens;
function tokenWeights(entries) {
  const frequency = /* @__PURE__ */ new Map();
  let situations = 0;
  for (const entry of entries) {
    for (const situation of [...entry.situations, ...entry.aliases]) {
      situations += 1;
      for (const token of new Set(tokens(situation)))
        frequency.set(token, (frequency.get(token) ?? 0) + 1);
    }
  }
  const weights = /* @__PURE__ */ new Map();
  for (const [token, count] of frequency) weights.set(token, Math.log(1 + situations / count));
  return weights;
}
function weightOf(weights, token) {
  return weights.get(token) ?? 0;
}
var DISTINCTIVE_SITUATION_SHARE = 0.02;
var DISTINCTIVE_FLOOR = Math.log(1 + 1 / DISTINCTIVE_SITUATION_SHARE);
var AGREEMENT_WEIGHT = 0.4;
var LONE_WORD_COVERAGE = 0.22;
function agreement(situation, query) {
  const matched = situation.filter((token) => query.has(token)).length;
  return 1 + AGREEMENT_WEIGHT * Math.max(0, matched - 1);
}
function scorePhrase(value, queryTokens, queryText, weights) {
  const phrase = tokens(value);
  const unique2 = [...new Set(phrase)];
  const total = unique2.reduce((sum, token) => sum + weightOf(weights, token), 0);
  const matched = unique2.filter((token) => queryTokens.has(token)).reduce((sum, token) => sum + weightOf(weights, token), 0);
  const phraseBonus = phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0;
  if (total === 0 || matched === 0 && phraseBonus === 0) return void 0;
  const coverage = matched / total;
  const agreed = agreement(unique2, queryTokens);
  return { agreed, coverage, matched, phraseBonus, score: coverage * agreed + phraseBonus };
}
function isDistinctivePhrase(candidate) {
  if (candidate.phraseBonus > 0) return true;
  if (candidate.matched < DISTINCTIVE_FLOOR) return false;
  return !(candidate.agreed === 1 && candidate.coverage < LONE_WORD_COVERAGE);
}
function scoreReadableSituations(situations, queryTokens, queryText, weights) {
  let best = 0;
  let matchedSituation = "";
  let bestReadableScore = 0;
  let bestReadableSituation = situations[0] ?? "";
  for (const situation of situations) {
    const candidate = scorePhrase(situation, queryTokens, queryText, weights);
    if (candidate === void 0) continue;
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
function scoreAliases(aliases, queryTokens, queryText, weights) {
  let best = 0;
  for (const alias of aliases) {
    const candidate = scorePhrase(alias, queryTokens, queryText, weights);
    if (candidate !== void 0) best = Math.max(best, candidate.score);
  }
  return best;
}
function situationScore(query, situations, aliases, weights) {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  const queryTokens = new Set(query);
  const queryText = query.join(" ");
  const readable = scoreReadableSituations(situations, queryTokens, queryText, weights);
  const best = Math.max(readable.best, scoreAliases(aliases, queryTokens, queryText, weights));
  const matchedSituation = readable.matchedSituation.length > 0 ? readable.matchedSituation : best >= RELEVANCE_FLOOR ? readable.bestReadableSituation : "";
  return matchedSituation.length > 0 ? { matchedSituation, score: best } : { matchedSituation: "", score: 0 };
}
function notOwnedSituationScore(query, situations) {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  const queryText = query.join(" ");
  let best = 0;
  let matchedSituation = "";
  for (const situation of situations) {
    const phrase = tokens(situation);
    const overlap = new Set(phrase.filter((token) => query.includes(token))).size;
    const score = overlap / Math.max(query.length, phrase.length);
    const phraseBonus = phrase.join(" ").includes(queryText) || queryText.includes(phrase.join(" ")) ? 1 : 0;
    if (overlap < (query.length >= 4 ? 2 : 1) && phraseBonus === 0) continue;
    const candidate = score + phraseBonus;
    if (candidate > best) {
      best = candidate;
      matchedSituation = situation;
    }
  }
  return { matchedSituation, score: best };
}
function notOwnedMatch(manifest, query) {
  return manifest.notOwned.map((entry) => ({ entry, ...notOwnedSituationScore(query, entry.situations) })).filter(
    ({ matchedSituation, score }) => matchedSituation.length > 0 && score >= RELEVANCE_FLOOR
  ).sort(
    (left, right) => right.score - left.score || left.entry.id.localeCompare(right.entry.id)
  )[0];
}
function isSpecificNotOwnedMatch(query, matchedSituation) {
  const queryText = query.join(" ");
  const phrase = tokens(matchedSituation);
  const phraseText = phrase.join(" ");
  if (queryText === phraseText) return true;
  if (query.length === 1 && phrase.length <= 2 && phrase.includes(query[0] ?? "")) return true;
  if (query.length > phrase.length + 1) return false;
  return new Set(phrase.filter((token) => query.includes(token))).size >= 2;
}
function capabilitySearchKey(entry) {
  return `${entry.importPath}
${entry.summary}
${entry.situations.join("\n")}`;
}
function matchedStarterKits(situation, kits) {
  const words = (text2) => ` ${text2.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim()} `;
  const request = words(situation);
  const claims = kits.map((kit) => ({
    kit,
    spans: kit.words.flatMap((word) => {
      const at = request.indexOf(words(word));
      return at < 0 ? [] : [{ at, end: at + words(word).length }];
    })
  }));
  const inside = (span, own) => claims.some(
    (other) => other !== own && other.spans.some(
      (o) => o.at <= span.at && o.end >= span.end && o.end - o.at > span.end - span.at
    )
  );
  return claims.map((claim) => ({
    at: Math.min(...claim.spans.filter((span) => !inside(span, claim)).map((span) => span.at)),
    kit: claim.kit
  })).filter(({ at }) => Number.isFinite(at)).sort((left, right) => left.at - right.at).map(({ kit: { blurb, name, title } }) => ({
    blurb,
    command: `npx create-threenative <dir> --template ${name}`,
    name,
    title
  }));
}
function searchCapabilities(situation, manifestFile = defaultManifestPath(), scope = "mechanic") {
  if (typeof situation !== "string" || situation.trim().length === 0)
    throw new Error("engine_search_capabilities requires a non-empty situation string.");
  const manifest = loadCapabilityManifest(manifestFile);
  const starterKits = matchedStarterKits(situation, manifest.starterKits ?? []);
  const response = withReferenceTools(situation, searchMechanics(situation, manifest, scope));
  if (starterKits.length === 0) return response;
  return {
    starterKits,
    ...response,
    ...response.verdict === "none" ? {
      guidance: `Scaffold from the starter kit first, then search the mechanics it does not cover. ${response.guidance}`,
      verdict: "starterKit"
    } : {}
  };
}
var REVERSE_ENGINEER = /\breverse[\s-]?engineer|\bdecomp|\bdisassembl/iu;
var REFERENCE_TOOLS = [
  "engine_search_references",
  "engine_reference_detail",
  "engine_save_reference"
];
function withReferenceTools(situation, response) {
  if (!REVERSE_ENGINEER.test(situation)) return response;
  return {
    referenceTools: REFERENCE_TOOLS,
    ...response,
    guidance: `Reverse engineer the game with engine_search_references, then engine_reference_detail for its pinned cards. ${response.guidance}`
  };
}
function searchMechanics(situation, manifest, scope) {
  const query = tokens(situation);
  const limit = scope === "request" ? MAX_COMPLETE_REQUEST_RESULTS : MAX_SITUATION_RESULTS;
  const weights = tokenWeights(manifest.entries);
  const notOwned = notOwnedMatch(manifest, query);
  if (notOwned !== void 0 && isSpecificNotOwnedMatch(query, notOwned.matchedSituation)) {
    return {
      guidance: notOwned.entry.guidance,
      results: [],
      verdict: "none"
    };
  }
  const results = manifest.entries.map((entry) => ({ entry, ...situationScore(query, entry.situations, entry.aliases, weights) })).filter(
    ({ matchedSituation, score }) => matchedSituation.length > 0 && score >= RELEVANCE_FLOOR
  ).sort(
    (left, right) => right.score - left.score || `${left.entry.importPath}:${left.entry.symbol}`.localeCompare(
      `${right.entry.importPath}:${right.entry.symbol}`
    )
  ).filter(
    (candidate, index, candidates) => candidates.findIndex(
      (other) => capabilitySearchKey(other.entry) === capabilitySearchKey(candidate.entry)
    ) === index
  ).slice(0, limit).map(({ entry, matchedSituation, score }) => ({
    constraints: entry.constraints,
    example: entry.example,
    importPath: entry.importPath,
    matchedSituation,
    ...entry.requires === void 0 ? {} : { requires: entry.requires },
    score,
    summary: entry.summary,
    symbol: entry.symbol
  }));
  if (results.length > 0) return { guidance: "", results, verdict: "matched" };
  return {
    guidance: notOwned?.entry.guidance ?? GENERIC_GUIDANCE,
    results: [],
    verdict: "none"
  };
}
function capabilityDetails(symbol, manifestFile = defaultManifestPath(), importPath) {
  if (typeof symbol !== "string" || symbol.trim().length === 0)
    throw new Error("engine_capability_detail requires a non-empty symbol string.");
  const matches = loadCapabilityManifest(manifestFile).entries.filter(
    (candidate) => candidate.symbol === symbol && (importPath === void 0 || candidate.importPath === importPath)
  );
  if (matches.length === 0)
    throw new Error(
      `Unknown engine capability '${symbol}'${importPath === void 0 ? "" : ` in '${importPath}'`}.`
    );
  return matches;
}
function capabilityDetail(symbol, manifestFile = defaultManifestPath(), importPath) {
  const matches = capabilityDetails(symbol, manifestFile, importPath);
  if (matches.length > 1)
    throw new Error(
      `Ambiguous engine capability '${symbol}': pass importPath, one of ${matches.map((match) => `'${match.importPath}'`).join(", ")}.`
    );
  return matches[0];
}
var TOOL_DEFINITIONS = [
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "engine_search_capabilities",
    description: 'Search the installed engine by concrete gameplay mechanic. Decompose genres first. Use scope "request" for the mechanically explicit full request and "mechanic" for each focused search; matchedSituation and score explain every result. The response verdict "none" is an actionable answer with guidance, not a failed search.',
    inputSchema: {
      additionalProperties: false,
      properties: {
        scope: {
          description: "Use request for the complete cross-system game request; use mechanic or omit it for one mechanic.",
          enum: ["request", "mechanic"],
          type: "string"
        },
        situation: { type: "string" }
      },
      required: ["situation"],
      type: "object"
    }
  },
  {
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: true },
    name: "engine_capability_detail",
    description: "Inspect one engine capability's import, signature, example, constraints, and overrides. When several packages export the symbol, every match is returned under `matches`.",
    inputSchema: {
      additionalProperties: false,
      properties: {
        importPath: {
          description: "The search result's importPath; required when two packages export the same symbol.",
          type: "string"
        },
        symbol: { type: "string" }
      },
      required: ["symbol"],
      type: "object"
    }
  },
  {
    name: "engine_search_references",
    description: "Reverse engineer classic games: search mechanic cards and repository map nodes from their decomps. Tier-2 titles link to repos to explore and save. References describe feel only; borrow algorithms, cite pinned sources, copy no code or art.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { situation: { type: "string" } },
      required: ["situation"]
    }
  },
  {
    name: "engine_reference_detail",
    description: "Reverse engineer a game: read its pinned map or mechanic card. A node includes files, key functions, dependencies and child nodes; a card includes constants and sources.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        game: { type: "string" },
        id: { type: "string" },
        kind: { type: "string", enum: ["node", "card"] }
      },
      required: ["game", "id", "kind"]
    }
  },
  {
    name: "engine_save_reference",
    description: "Save what you reverse engineer: validate and save a pinned game's repository map and mechanic cards to .threenative/refs, merged by id at the same SHA; conflicting revisions are refused. Pass a game object with version:1, id, title, repo, sha, nodes and cards. Returns a POSIX-shell contribution command for review; does not send it. Unknown fields and fenced code are refused.",
    annotations: { destructiveHint: false, openWorldHint: false, readOnlyHint: false },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        game: {
          type: "object",
          description: "Pinned game reference: version, id, title, repo, sha (40 hex), nodes [{id,name,purpose,parent?,paths,functions:[{name,path,lines:[from,to]}],dependsOn}], cards [{id,node,name,summary,behavior,constants:[{name,value,unit,source}],sources:[{path,line}],capabilities,tags}]. No extra fields or code fences."
        }
      },
      required: ["game"]
    }
  }
];
function toolDefinitions() {
  return TOOL_DEFINITIONS;
}
var DEFAULT_LOG_FILE = path2.join(".threenative", "engine-mcp.log");
var logBroken = false;
function logToolCall(entry) {
  if (logBroken) return;
  const target = process.env.THREENATIVE_ENGINE_MCP_LOG ?? DEFAULT_LOG_FILE;
  if (target === "off") return;
  try {
    mkdirSync(path2.dirname(path2.resolve(target)), { recursive: true });
    appendFileSync(target, `${JSON.stringify({ time: (/* @__PURE__ */ new Date()).toISOString(), ...entry })}
`);
  } catch (error) {
    logBroken = true;
    process.stderr.write(`engine-mcp log disabled (${target}): ${String(error)}
`);
  }
}
function jsonRpcError(id2, code, message) {
  return JSON.stringify({ id: id2, jsonrpc: "2.0", error: { code, message } });
}
function jsonRpcResult(id2, result) {
  return JSON.stringify({ id: id2, jsonrpc: "2.0", result });
}
function writeLine(value) {
  process.stdout.write(`${value}
`);
}
function toolText(value) {
  return { content: [{ text: JSON.stringify(value, null, 2), type: "text" }] };
}
async function searchReferences(situation, limit = 5) {
  const local = loadLocalReferenceGames();
  let release;
  try {
    release = await loadReferenceIndex();
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith("TN_REFERENCES_UNAVAILABLE:")))
      throw error;
    if (local.length === 0)
      return {
        results: [],
        guidance: "references unavailable: no release cache or network; capability search still works."
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
      tier: 1
    }))
  ];
  const stubs = [
    ...(release?.stubs ?? []).filter(
      (stub) => !localKeys.has(`${stub.game}/${stub.kind}/${stub.id}`)
    ),
    ...localStubs
  ];
  const titles = new Map(games.map((game) => [game.id, game.title]));
  const candidates = [
    ...stubs.map((stub) => ({
      ...stub,
      title: titles.get(stub.game) ?? ""
    })),
    ...games.filter((game) => game.tier === 2).map((game) => ({
      ...game,
      game: game.id,
      kind: "game",
      name: game.title,
      summary: game.title,
      tags: [],
      capabilities: [],
      guidance: "Explore this repository, then call engine_save_reference."
    }))
  ];
  const phrases = candidates.map((stub) => ({
    situations: [stub.name, stub.summary, ...stub.tags],
    aliases: [stub.title]
  }));
  const weights = tokenWeights(phrases);
  const query = tokens(situation);
  return {
    guidance: "",
    results: candidates.map((stub, index) => {
      const content = situationScore(query, phrases[index]?.situations ?? [], [], weights);
      const title = scoreAliases(
        phrases[index]?.aliases ?? [],
        new Set(query),
        query.join(" "),
        weights
      );
      return { ...stub, ...content, score: content.score + title };
    }).filter((stub) => stub.score >= RELEVANCE_FLOOR).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit)
  };
}
async function handleToolCall(params, manifestFile) {
  const name = params.name;
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  if (name === "engine_search_capabilities") {
    if (typeof argumentsValue.situation !== "string")
      throw new Error("engine_search_capabilities requires a string 'situation' argument.");
    const scope = argumentsValue.scope === void 0 ? "mechanic" : argumentsValue.scope;
    if (scope !== "request" && scope !== "mechanic")
      throw new Error("engine_search_capabilities scope must be 'request' or 'mechanic'.");
    const response = searchCapabilities(argumentsValue.situation, manifestFile, scope);
    logToolCall({
      results: response.results.map((result) => result.symbol),
      scope,
      situation: argumentsValue.situation,
      tool: name,
      verdict: response.verdict
    });
    return toolText(
      response.verdict === "none" ? {
        ...response,
        references: await searchReferences(argumentsValue.situation, 3).catch(
          (error) => ({
            results: [],
            guidance: `references unavailable: ${String(error)}`
          })
        )
      } : response
    );
  }
  if (name === "engine_capability_detail") {
    if (typeof argumentsValue.symbol !== "string")
      throw new Error("engine_capability_detail requires a string 'symbol' argument.");
    if (argumentsValue.importPath !== void 0 && typeof argumentsValue.importPath !== "string")
      throw new Error("engine_capability_detail 'importPath' must be a string when given.");
    const matches = capabilityDetails(
      argumentsValue.symbol,
      manifestFile,
      argumentsValue.importPath
    );
    const detail = matches.length === 1 ? matches[0] : {
      guidance: `${matches.length} packages export '${argumentsValue.symbol}'. Import the match whose summary fits; pass importPath to get one.`,
      matches
    };
    logToolCall({
      importPath: argumentsValue.importPath,
      symbol: argumentsValue.symbol,
      tool: name
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
      results: response.results.map((entry) => entry.id)
    });
    return toolText(response);
  }
  if (name === "engine_reference_detail") {
    if (typeof argumentsValue.game !== "string" || typeof argumentsValue.id !== "string" || argumentsValue.kind !== "node" && argumentsValue.kind !== "card")
      throw new Error("engine_reference_detail requires game, id and kind (node or card).");
    let game = await loadReferenceGame(argumentsValue.game);
    const { id: id2, kind } = argumentsValue;
    let entry = kind === "node" ? game.nodes.find((node) => node.id === id2) : game.cards.find((card) => card.id === id2);
    if (!entry) {
      game = await loadReleaseReferenceGame(argumentsValue.game);
      entry = kind === "node" ? game.nodes.find((node) => node.id === id2) : game.cards.find((card) => card.id === id2);
    }
    if (!entry) throw new Error(`No reference ${kind} '${id2}' in '${game.id}'.`);
    logToolCall({ tool: name, game: game.id, id: id2, kind });
    return toolText({
      game: game.id,
      title: game.title,
      repo: game.repo,
      sha: game.sha,
      ...kind === "node" ? { node: entry, children: game.nodes.filter((node) => node.parent === id2) } : { card: entry }
    });
  }
  if (name === "engine_save_reference") {
    const saved = saveReferenceGame(argumentsValue.game);
    logToolCall({ tool: name, saved: saved.saved });
    return toolText(saved);
  }
  throw new Error(`Unknown engine MCP tool '${String(name)}'.`);
}
async function handleLine(line2, manifestFile) {
  if (line2.trim().length === 0) return void 0;
  let request;
  try {
    request = JSON.parse(line2);
  } catch (error) {
    return jsonRpcError(null, -32700, `Invalid JSON: ${String(error)}`);
  }
  if (!isRecord(request) || request.id === void 0 || typeof request.method !== "string")
    return void 0;
  try {
    if (request.method === "initialize") {
      return jsonRpcResult(request.id, {
        capabilities: { tools: { listChanged: false } },
        instructions: AUTHORING_INSTRUCTIONS,
        protocolVersion: "2025-06-18",
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.6" }
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
    if (request.method === "tools/call") logToolCall({ error: message, request: request.params });
    return jsonRpcError(request.id, -32e3, message);
  }
}
async function runCli(argv, manifestFile = defaultManifestPath(), io = {
  stderr: (text2) => void process.stderr.write(text2),
  stdout: (text2) => void process.stdout.write(text2)
}) {
  const [name, json = "{}"] = argv;
  try {
    const result = await handleToolCall(
      { arguments: JSON.parse(json), name },
      manifestFile
    );
    io.stdout(`${result.content[0].text}
`);
    return 0;
  } catch (error) {
    io.stderr(`${name}: ${error instanceof Error ? error.message : String(error)}
`);
    return 1;
  }
}
function runServer(manifestFile = defaultManifestPath()) {
  const tool = process.argv[2];
  if (tool?.startsWith("engine_") === true) {
    void runCli(process.argv.slice(2), manifestFile).then((code) => {
      process.exitCode = code;
    });
    return;
  }
  loadCapabilityManifest(manifestFile);
  const input = createInterface({ input: process.stdin });
  void loadReferenceIndex().catch((error) => process.stderr.write(`${String(error)}
`));
  input.on("line", (line2) => {
    void handleLine(line2, manifestFile).then((response) => {
      if (response !== void 0) writeLine(response);
    });
  });
}
var entryPath = process.argv[1];
if (entryPath !== void 0 && realpathSync(path2.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runServer();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}

export { ENGINE_MCP_TOOL_NAMES, RELEVANCE_FLOOR, capabilityDetail, capabilityDetails, capabilitySituationTokens, defaultManifestPath, handleLine, loadCapabilityManifest, runCli, runServer, searchCapabilities, toolDefinitions };
