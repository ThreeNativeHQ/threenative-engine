#!/usr/bin/env node
import { realpathSync, statSync, readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, appendFileSync, mkdtempSync, renameSync, readdirSync } from 'fs';
import path from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import os from 'os';
import { promisify } from 'util';
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
  if (override) return path.join(path.resolve(override), source);
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "threenative", "refs", source);
}
function localReferencesDir(cwd = process.cwd()) {
  return path.join(cwd, ".threenative", "refs");
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
  if (path.isAbsolute(result) || result.split("/").includes("..") || !/^[a-zA-Z0-9_./-]+$/u.test(result))
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
    const game = record(entry, at, [
      "id",
      "title",
      "platform",
      "repo",
      "tier",
      "kind",
      "rating",
      "genre",
      "subgenre"
    ]);
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
  const file = path.join(referencesCacheDir(), name);
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
  mkdirSync(path.dirname(file), { recursive: true });
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
      parseJson(readFileSync(path.join(directory, file)), file),
      path.join(".threenative", "refs", file)
    );
    if (game.id !== path.basename(file, ".json"))
      fail(file, `id '${game.id}' differs from filename`);
    return game;
  });
}
function loadReferenceGame(gameId, cwd = process.cwd()) {
  id(gameId, "game id");
  const file = path.join(localReferencesDir(cwd), `${gameId}.json`);
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
  const file = path.join(localReferencesDir(cwd), `${gameId}.json`);
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
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(merged, null, 2)}
`);
  const relative = path.relative(cwd, file);
  const title = `Reference cards: ${merged.title} (${merged.nodes.length} nodes, ${merged.cards.length} cards)`;
  return {
    contribution: {
      command: `gh issue create --repo ${CONTRIBUTION_REPO} --title ${shellQuote(title)} --body-file ${shellQuote(relative)}`,
      title
    },
    saved: relative
  };
}
var WATCH_TOOLS = [
  ["yt-dlp", "install it with `pipx install yt-dlp`"],
  ["ffmpeg", "install it with `sudo apt install ffmpeg` or `brew install ffmpeg`"]
];
var WATCH_TIMEOUT_MS = 3e5;
function onPath(name) {
  return [
    ...(process.env.PATH ?? "").split(path.delimiter),
    path.join(os.homedir(), ".local", "bin")
  ].filter((directory) => directory.length > 0).some((directory) => existsSync(path.join(directory, name)));
}
async function watchReference(options) {
  for (const [name, install] of WATCH_TOOLS)
    if (!onPath(name))
      throw new Error(`TN_WATCH_TOOL_MISSING: ${name} is not on PATH: ${install}.`);
  const url = new URL("watch.mjs", referencesBaseUrl()).href;
  try {
    await cachedAsset("watch.mjs", (body) => body, GAME_FETCH_TIMEOUT_MS);
  } catch (error) {
    throw new Error(`TN_WATCH_UNAVAILABLE: cannot fetch ${url}: ${String(error)}`);
  }
  const out = mkdtempSync(path.join(os.tmpdir(), "threenative-watch-"));
  const flags = Object.entries({
    "--duration": options.duration,
    "--frames": options.frames,
    "--at": options.at,
    "--pick": options.pick,
    "--from": options.from
  }).flatMap(([flag, value]) => value === void 0 ? [] : [flag, String(value)]);
  try {
    await promisify(execFile)(
      process.execPath,
      [path.join(referencesCacheDir(), "watch.mjs"), options.query, ...flags, "--out", out],
      { maxBuffer: 16 * 1024 * 1024, timeout: WATCH_TIMEOUT_MS }
    );
  } catch (error) {
    rmSync(out, { recursive: true, force: true });
    const stderr = String(error.stderr ?? "").trim();
    throw new Error(`TN_WATCH_FAILED: ${stderr || String(error)}`);
  }
  const watch = JSON.parse(readFileSync(path.join(out, "watch.json"), "utf8"));
  return {
    sheet: watch.sheet === null ? null : path.join(out, watch.sheet),
    frames: watch.frames.map((frame) => path.join(out, frame.path)),
    watch,
    guidance: "Read the sheet first: every frame in order. Then aim with pick, from or at. Reference only: borrow the mechanic, never commit the frames."
  };
}

// src/index.ts
var ENGINE_MCP_TOOL_NAMES = [
  "engine_search_capabilities",
  "engine_capability_detail",
  "engine_search_references",
  "engine_reference_detail",
  "engine_save_reference",
  "engine_watch_reference"
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
  "your"
]);
var MAX_COMPLETE_REQUEST_RESULTS = 15;
var MAX_SITUATION_RESULTS = 5;
var MAX_NEAR_MATCHES = 3;
var RELEVANCE_FLOOR = 0.27;
var AUTHORING_INSTRUCTIONS = "Follow the Authoring flow in the game's AGENTS.md (the threenative-capabilities skill holds the detail): search capabilities and references before the first new src/ file, for a new game and for every change to an existing game. Follow binding capability constraints. Execute with subagents focused on specific areas: bounded tasks, file ownership, then coordinator integration before mechanics playtests. References borrow mechanics only: no code, level layouts, character names or art; cite pinned file:line sources.";
var GENERIC_GUIDANCE = "No installed engine capability matches this situation. Decompose it into concrete mechanics and write the game-owned behavior in your project's src/; inspect the relevant template AGENTS.md before adding a package.";
function defaultManifestPath(cwd = process.cwd()) {
  const override = process.env.THREENATIVE_CAPABILITIES_MANIFEST;
  if (override !== void 0 && override.trim().length > 0) return path.resolve(cwd, override);
  for (let directory = path.resolve(cwd); ; directory = path.dirname(directory)) {
    const nodeModules = path.join(directory, "node_modules");
    const installed = path.join(nodeModules, "@threenative", "core", "capabilities.json");
    if (existsSync(installed)) {
      const relative = path.relative(realpathSync(directory), realpathSync(nodeModules));
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
        return installed;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  for (let directory = path.dirname(fileURLToPath(import.meta.url)); ; directory = path.dirname(directory)) {
    const repository = path.join(directory, "packages", "core", "capabilities.json");
    if (existsSync(repository)) return repository;
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  return path.resolve(cwd, DEFAULT_MANIFEST_FILE);
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
var manifestCache = /* @__PURE__ */ new Map();
function loadCapabilityManifest(file = defaultManifestPath()) {
  let raw;
  let stamp;
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
    const manifest = validateManifest(JSON.parse(raw), file);
    manifestCache.set(file, { stamp, manifest });
    return manifest;
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
  if (token === "leaves") return "leaf";
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
var STOP_WORD_STEMS = new Set([...STOP_WORDS].map(stem));
function splitSymbolCase(value) {
  return value.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2");
}
function capabilitySituationTokens(value) {
  return splitSymbolCase(value).toLocaleLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 1 && !STOP_WORDS.has(token)).map(stem).filter((token) => !STOP_WORD_STEMS.has(token));
}
var tokenCache = /* @__PURE__ */ new Map();
var TOKEN_CACHE_LIMIT = 2e4;
function tokens(value) {
  let cached = tokenCache.get(value);
  if (cached === void 0) {
    if (tokenCache.size >= TOKEN_CACHE_LIMIT) tokenCache.clear();
    cached = Object.freeze(capabilitySituationTokens(value));
    tokenCache.set(value, cached);
  }
  return cached;
}
function lexicalIndex(rows, fieldsOf, boosts) {
  const fields = rows.map(
    (row) => fieldsOf(row).map((phrases) => phrases.map((text2) => ({ text: text2, words: tokens(text2) })))
  );
  const lengths = boosts.map((_, field) => {
    const phrases = fields.flatMap((row) => row[field] ?? []).filter(({ words }) => words.length);
    return phrases.reduce((sum, { words }) => sum + words.length, 0) / (phrases.length || 1);
  });
  const frequency = /* @__PURE__ */ new Map();
  const documents = fields.map((row) => {
    const seen = /* @__PURE__ */ new Set();
    const indexed = row.map(
      (phrases, field) => phrases.map(({ text: text2, words }) => {
        const terms = /* @__PURE__ */ new Map();
        for (const word of words) {
          seen.add(word);
          terms.set(word, (terms.get(word) ?? 0) + 1);
        }
        const average = lengths[field] || 1;
        const norm = 1 - BM25_B + BM25_B * (words.length / average);
        return { boost: (boosts[field] ?? 0) / norm, terms, text: text2, words };
      })
    );
    for (const word of seen) frequency.set(word, (frequency.get(word) ?? 0) + 1);
    return indexed;
  });
  const idf = /* @__PURE__ */ new Map();
  for (const [word, df] of frequency) {
    idf.set(word, Math.log1p((rows.length - df + 0.5) / (df + 0.5)));
  }
  return { documents, idf };
}
var BM25_B = 0.45;
var BM25_K1 = 1.2;
var DISTINCTIVE_FLOOR = Math.log1p(1 / 0.02);
var CAPABILITY_IDF_LIMIT = 4;
function hasTokenSubsequence(haystack, needle) {
  return needle.length > 0 && needle.length <= haystack.length && haystack.some(
    (word, start) => word === needle[0] && needle.every((part, offset) => haystack[start + offset] === part)
  );
}
function lexicalQuery(words, idf, maxWeight = Number.POSITIVE_INFINITY) {
  const weights = new Map(
    [...new Set(words)].map((word) => [word, Math.min(idf.get(word) ?? 2, maxWeight)])
  );
  const total = [...weights.values()].reduce((sum, weight) => sum + weight, 0);
  return { total, weights, words };
}
function scoreField(phrase, query) {
  let matched = 0;
  let count = 0;
  let score = 0;
  for (const [word, tf] of phrase.terms) {
    const weight = query.weights.get(word);
    if (weight === void 0) continue;
    matched += weight;
    count += 1;
    score += weight * saturate(tf * phrase.boost);
  }
  if (count === 0) return void 0;
  const exact = hasTokenSubsequence(query.words, phrase.words) || hasTokenSubsequence(phrase.words, query.words);
  const bonus = exact ? 1.6 : 1;
  const distinctive = exact && (count > 1 || query.weights.size === 1 || matched >= DISTINCTIVE_FLOOR) || matched >= DISTINCTIVE_FLOOR && (count > 1 || phrase.words.length <= 3);
  return { boost: phrase.boost * bonus, count, distinctive, exact, phrase, score: score * bonus };
}
function bestField(phrases, query, isAlias = false) {
  let best;
  for (const phrase of phrases ?? []) {
    const match = scoreField(phrase, query);
    if (match === void 0 || isAlias && match.count === 1 && phrase.words.length > 1) continue;
    if (best === void 0 || match.score > best.score) best = match;
  }
  return best;
}
function saturate(tf) {
  return (BM25_K1 + 1) * tf / (BM25_K1 + tf);
}
function bm25f(query, fields, clauses = []) {
  if (fields.every((field) => field === void 0)) return 0;
  let matched = 0;
  let score = 0;
  for (const [word, weight] of query.weights) {
    let tf = 0;
    for (const field of fields) {
      if (field !== void 0) tf += field.boost * (field.phrase.terms.get(word) ?? 0);
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
  const evidence = 1 - 0.25 * Math.exp(-matched / 5);
  return score / matched * coverage ** 0.65 * evidence;
}
function weakMatch(score) {
  return RELEVANCE_FLOOR * score / (1 + score);
}
function nameWords(value) {
  return splitSymbolCase(value.replace(/([a-zA-Z])(\d+)/gu, "$1 $2")).toLowerCase().split(/[^a-z]+/u).filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}
function normaliseName(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}
function spelledNames(value) {
  const words = value.toLowerCase().match(/[a-z0-9]+/gu) ?? [];
  const names = /* @__PURE__ */ new Set();
  for (let start = 0; start < words.length; start += 1) {
    let name = "";
    for (const word of words.slice(start, start + 4)) {
      name += word;
      names.add(name);
    }
  }
  return names;
}
function capabilityQuery(situation, idf, scope) {
  const clauses = scope === "request" ? situation.split(/[,;:\n]|[.!?]+(?=\s|$)/u) : [situation];
  const identifiers = situation.match(/[a-zA-Z0-9_$]+(?:\.[a-zA-Z0-9_$]+)*/gu) ?? [];
  const verbatim = new Set(identifiers);
  for (const identifier of identifiers) {
    const qualified = /^([A-Z][\w$]*)\./u.exec(identifier)?.[1];
    if (qualified !== void 0) verbatim.add(qualified);
  }
  return {
    ...lexicalQuery(tokens(situation), idf, CAPABILITY_IDF_LIMIT),
    clauses,
    clauseQueries: clauses.length < 2 ? [] : clauses.map((clause) => lexicalQuery(tokens(clause), idf, CAPABILITY_IDF_LIMIT)).filter((clause) => clause.weights.size > 1),
    names: spelledNames(situation),
    nameWords: nameWords(situation),
    normalised: normaliseName(situation),
    verbatim
  };
}
function scoreSymbolName(entry, { name, specificity, words }, query) {
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
  if (words.length > 1 && specificity >= DISTINCTIVE_FLOOR && words.every((word) => query.nameWords.includes(word))) {
    return { score: 0.55 + share * 0.6, specificity };
  }
  return void 0;
}
var LIFECYCLE_INTENT = /* @__PURE__ */ new Map([
  [
    "ctx.quit",
    /\bquit\b|\b(?:close|exit)\s+(?:the\s+)?(?:app(?:lication)?|game|window)\b|\b(?:app(?:lication)?|game|window)\s+(?:is\s+)?(?:closed|closes)\b/iu
  ],
  [
    "leaveScene",
    /\b(?:leave|leaving|exit|exiting|unload)\s+(?:(?:the|a|current)\s+)*(?:scene|level)\b/iu
  ],
  [
    "onLaunchFailure",
    /\b(?:launch|startup|boot)\s+(?:fails?|failed|failure|error|crash)\b|\b(?:fail(?:s|ed)?|error|crash)\s+(?:to\s+|during\s+)?(?:launch|start|boot)\b/iu
  ]
]);
function capabilityScore(query, entry, nameInfo, fields, scope) {
  const symbol = scoreSymbolName(entry, nameInfo, query);
  const intent = LIFECYCLE_INTENT.get(entry.symbol);
  const explicit = intent === void 0 || scope === "mechanic" && entry.symbol !== "ctx.quit" || query.verbatim.has(entry.symbol) || query.normalised === nameInfo.name || query.clauses.some((clause) => intent.test(clause));
  if (symbol !== void 0 && explicit && symbol.score >= 1.8) {
    return { ...symbol, matchedSituation: entry.symbol };
  }
  const name = bestField(fields[0], query);
  const alias = bestField(fields[1], query, true);
  const situation = bestField(fields[2], query);
  const summary = bestField(fields[3], query);
  const anchoredName = name !== void 0 && (name.count > 1 || name.phrase.words[0] === query.words[0] && (situation?.count ?? 0) > 1);
  const lexical = bm25f(
    query,
    [anchoredName ? name : void 0, alias, situation, summary],
    query.clauseQueries
  );
  const distinctive = alias?.distinctive && entry.situations.length > 0 || situation?.distinctive || summary?.distinctive;
  const score = distinctive && explicit ? lexical : weakMatch(lexical);
  if (symbol !== void 0 && explicit && symbol.score > score) {
    return { ...symbol, matchedSituation: entry.symbol };
  }
  return {
    matchedSituation: lexical === 0 ? "" : situation?.phrase.text ?? entry.situations[0] ?? entry.summary,
    score,
    specificity: 0
  };
}
function notOwnedSituationScore(query, situations) {
  if (query.length === 0) return { matchedSituation: "", score: 0 };
  let best = 0;
  let matchedSituation = "";
  for (const situation of situations) {
    const phrase = tokens(situation);
    const overlap = new Set(phrase.filter((token) => query.includes(token))).size;
    const score = overlap / Math.max(query.length, phrase.length);
    const phraseBonus = hasTokenSubsequence(query, phrase) || hasTokenSubsequence(phrase, query) ? 1 : 0;
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
  const response = withReferenceTools(
    situation,
    searchMechanics(situation, manifest, scope, starterKits.length === 0)
  );
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
  "engine_save_reference",
  "engine_watch_reference"
];
function withReferenceTools(situation, response) {
  if (!REVERSE_ENGINEER.test(situation)) return { referenceTools: REFERENCE_TOOLS, ...response };
  return {
    referenceTools: REFERENCE_TOOLS,
    ...response,
    guidance: `Reverse engineer the game with engine_search_references, then engine_reference_detail for its pinned cards. ${response.guidance}`
  };
}
function indexCapabilities(entries) {
  const { documents, idf } = lexicalIndex(
    entries,
    (entry) => [
      [entry.symbol],
      entry.aliases,
      entry.situations,
      entry.summary.split(/(?<=[.!?])\s+/u)
    ],
    [2.8, 2.1, 1.25, 0.4]
  );
  return {
    entries: entries.map((entry, index) => {
      const words = nameWords(entry.symbol);
      const specificity = words.reduce((sum, word) => sum + (idf.get(stem(word)) ?? 0), 0);
      return {
        entry,
        fields: documents[index] ?? [],
        symbol: { name: normaliseName(entry.symbol), specificity, words }
      };
    }),
    idf
  };
}
var capabilityIndexes = /* @__PURE__ */ new WeakMap();
function capabilityIndex(entries) {
  let index = capabilityIndexes.get(entries);
  if (index === void 0) {
    index = indexCapabilities(entries);
    capabilityIndexes.set(entries, index);
  }
  return index;
}
function searchMechanics(situation, manifest, scope, suggest = true) {
  const limit = scope === "request" ? MAX_COMPLETE_REQUEST_RESULTS : MAX_SITUATION_RESULTS;
  const { entries, idf } = capabilityIndex(manifest.entries);
  const query = capabilityQuery(situation, idf, scope);
  const notOwned = notOwnedMatch(manifest, query.words);
  const specific = notOwned !== void 0 && isSpecificNotOwnedMatch(query.words, notOwned.matchedSituation);
  const optionalPackage = specific ? `@threenative/${notOwned.entry.id}` : void 0;
  const includesEntry = (entry) => optionalPackage === void 0 || entry.importPath === optionalPackage || entry.importPath.startsWith(`${optionalPackage}/`);
  if (specific && !manifest.entries.some(includesEntry)) {
    return { guidance: notOwned.entry.guidance, results: [], verdict: "none" };
  }
  const floor = optionalPackage === void 0 ? RELEVANCE_FLOOR : Number.MIN_VALUE;
  const seen = /* @__PURE__ */ new Set();
  const scored = entries.flatMap(
    ({ entry, fields, symbol }) => includesEntry(entry) ? [{ entry, ...capabilityScore(query, entry, symbol, fields, scope) }] : []
  ).filter(({ matchedSituation }) => matchedSituation.length > 0).sort(
    (left, right) => right.score - left.score || right.specificity - left.specificity || `${left.entry.importPath}:${left.entry.symbol}`.localeCompare(
      `${right.entry.importPath}:${right.entry.symbol}`
    )
  ).filter(({ entry }) => {
    const key = capabilitySearchKey(entry);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const results = scored.filter(({ score }) => score >= floor).slice(0, limit).map(({ entry, matchedSituation, score }) => ({
    constraints: entry.constraints,
    ...entry.deprecated === void 0 ? {} : { deprecated: entry.deprecated },
    example: entry.example,
    importPath: entry.importPath,
    matchedSituation,
    ...entry.overrides === void 0 ? {} : { overrides: entry.overrides },
    ...entry.requires === void 0 ? {} : { requires: entry.requires },
    score,
    signature: entry.signature,
    summary: entry.summary,
    symbol: entry.symbol
  }));
  if (results.length > 0)
    return { guidance: specific ? notOwned.entry.guidance : "", results, verdict: "matched" };
  const nearMatches = suggest && notOwned === void 0 ? scored.filter(({ score }) => score < floor).slice(0, MAX_NEAR_MATCHES).map(({ entry, matchedSituation, score }) => ({
    importPath: entry.importPath,
    matchedSituation,
    score,
    summary: entry.summary,
    symbol: entry.symbol
  })) : [];
  return {
    guidance: notOwned?.entry.guidance ?? GENERIC_GUIDANCE,
    results: [],
    verdict: "none",
    ...nearMatches.length > 0 ? { nearMatches } : {}
  };
}
function editDistance(a, b) {
  let costs = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j += 1) {
      next.push(
        Math.min(
          (next[j] ?? 0) + 1,
          (costs[j + 1] ?? 0) + 1,
          (costs[j] ?? 0) + (a[i] === b[j] ? 0 : 1)
        )
      );
    }
    costs = next;
  }
  return costs[b.length] ?? a.length;
}
function nearbySymbols(symbol, entries) {
  const sought = normaliseName(symbol);
  if (sought.length < 3 || sought.length > 80) return "";
  const names = [...new Set(entries.map((entry) => entry.symbol))];
  const best = names.map((name) => {
    const full = normaliseName(name);
    const member = normaliseName(name.split(".").at(-1) ?? name);
    const distance = [full, member].filter((part) => Math.abs(part.length - sought.length) <= 2).reduce((lowest, part) => Math.min(lowest, editDistance(part, sought)), 3);
    return { distance, name };
  }).filter(({ distance }) => distance <= (sought.length >= 7 ? 2 : 1)).sort((a, b) => a.distance - b.distance || a.name.localeCompare(b.name)).slice(0, 3);
  return best.length ? ` Did you mean ${best.map(({ name }) => `'${name}'`).join(" or ")}?` : "";
}
function capabilityDetails(symbol, manifestFile = defaultManifestPath(), importPath) {
  if (typeof symbol !== "string" || symbol.trim().length === 0)
    throw new Error("engine_capability_detail requires a non-empty symbol string.");
  const entries = loadCapabilityManifest(manifestFile).entries.filter(
    (candidate) => importPath === void 0 || candidate.importPath === importPath
  );
  const matches = entries.filter((candidate) => candidate.symbol === symbol);
  if (matches.length === 0)
    throw new Error(
      `Unknown engine capability '${symbol}'${importPath === void 0 ? "" : ` in '${importPath}'`}.${nearbySymbols(symbol, entries)}`
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
    description: 'Search the installed engine by concrete gameplay mechanic or by an exact exported symbol name. Decompose genres first. Use scope "request" for the mechanically explicit full request and "mechanic" for each focused search; matchedSituation and score explain every result. A row carries the answer (importPath, signature, example, constraints, overrides, deprecations), so call engine_capability_detail only for a symbol the search did not return. The response verdict "none" is an actionable answer with guidance, not a failed search; its nearMatches are below-floor suggestions that are not binding capabilities.',
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
    description: "Reverse engineer classic games: search mechanic cards and repository map nodes from their decomps. Tier-2 titles link to repos to explore and save. References describe feel only; borrow algorithms, cite pinned sources, copy no code or art. An empty reply lists nearMatches: near misses that are suggestions, not capabilities.",
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
  },
  {
    name: "engine_watch_reference",
    description: "Watch what you reverse engineer: see a game mechanic before you build it. Searches YouTube for gameplay of a reference game, download one short segment and slice frames plus one contact sheet into a tmp folder. Returns sheet (read it first), frames and watch.json (video, segment, frame times). Needs yt-dlp and ffmpeg. Frames are reference only: never commit them.",
    annotations: { destructiveHint: false, openWorldHint: true, readOnlyHint: true },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "Game and mechanic, e.g. 'super mario 64 triple jump'."
        },
        duration: { type: "number", description: "Seconds of gameplay to sample (default 90)." },
        frames: { type: "number", description: "Frames to slice from the segment (default 12)." },
        at: { type: "string", description: "Exact timestamps, comma separated, e.g. '12,35,61'." },
        pick: { type: "number", description: "Search result index (default 0, the top one)." },
        from: {
          type: "string",
          description: "Segment start: seconds, mm:ss or NN% (default 10%)."
        }
      },
      required: ["query"]
    }
  }
];
function toolDefinitions() {
  return TOOL_DEFINITIONS;
}
var DEFAULT_LOG_FILE = path.join(".threenative", "engine-mcp.log");
var logBroken = false;
function logToolCall(entry) {
  if (logBroken) return;
  const target = process.env.THREENATIVE_ENGINE_MCP_LOG ?? DEFAULT_LOG_FILE;
  if (target === "off") return;
  try {
    mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
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
  return { content: [{ text: JSON.stringify(value), type: "text" }] };
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
  const { documents, idf } = lexicalIndex(
    candidates,
    (stub) => [[stub.name], [stub.title], stub.tags, [stub.summary]],
    [2.4, 1.6, 1.2, 0.7]
  );
  const query = lexicalQuery(tokens(situation), idf);
  const scored = candidates.map((stub, index) => {
    const matches = documents[index]?.map((field) => bestField(field, query)) ?? [];
    const [name, title, tag, summary] = matches;
    const score = bm25f(query, matches);
    const content = [name, tag, summary].reduce(
      (best, match) => match !== void 0 && (best === void 0 || match.score > best.score) ? match : best,
      void 0
    );
    const matched = content ?? title;
    const relevant = matches.some((match) => match?.distinctive);
    return {
      near: { score, situation: matched?.phrase.text ?? "" },
      stub: {
        ...stub,
        matchedSituation: relevant ? matched?.phrase.text ?? "" : "",
        score: relevant ? score : 0
      }
    };
  });
  const results = scored.filter(({ stub }) => stub.score >= RELEVANCE_FLOOR).sort((a, b) => b.stub.score - a.stub.score || a.stub.id.localeCompare(b.stub.id)).slice(0, limit).map(({ stub }) => stub);
  const nearMatches = results.length === 0 ? referenceSuggestions(scored) : [];
  return {
    guidance: "",
    results,
    // An empty reply still names what came close, with the ids engine_reference_detail takes, so a
    // miss is not a dead end (PRD-063). The score is the one the phrase reached: a capability search
    // drops a row for being under the floor, while a reference search also drops it for resting on a
    // word too common to answer alone, so a suggestion here can outscore the floor and still not be
    // a result. Reference rows carry no binding promise either way.
    ...nearMatches.length > 0 ? { nearMatches } : {}
  };
}
function referenceSuggestions(scored) {
  return scored.filter(({ near }) => near.score > 0 && near.situation.length > 0).sort((a, b) => b.near.score - a.near.score || a.stub.id.localeCompare(b.stub.id)).slice(0, MAX_NEAR_MATCHES).map(({ near, stub }) => ({
    game: stub.game,
    id: stub.id,
    kind: stub.kind,
    matchedSituation: near.situation,
    // A tier-2 title is a repository, not a card: engine_reference_detail refuses kind "game", so
    // the link is what makes the suggestion actionable.
    ..."repo" in stub && typeof stub.repo === "string" && stub.repo.length > 0 ? { repo: stub.repo } : {},
    score: near.score,
    summary: stub.summary,
    title: stub.title
  }));
}
function searchSituation(tool, argumentsValue) {
  const { situation, query } = argumentsValue;
  if (typeof situation === "string" && situation.trim().length > 0) return situation;
  const hint = query === void 0 ? "" : " Pass 'situation' instead of 'query'.";
  throw new Error(`${tool} requires a string 'situation' argument with text.${hint}`);
}
async function handleToolCall(params, manifestFile) {
  const name = params.name;
  const argumentsValue = isRecord(params.arguments) ? params.arguments : {};
  if (name === "engine_search_capabilities") {
    const situation = searchSituation(name, argumentsValue);
    const scope = argumentsValue.scope === void 0 ? "mechanic" : argumentsValue.scope;
    if (scope !== "request" && scope !== "mechanic")
      throw new Error("engine_search_capabilities scope must be 'request' or 'mechanic'.");
    const response = searchCapabilities(situation, manifestFile, scope);
    logToolCall({
      results: response.results.map((result) => result.symbol),
      scope,
      situation,
      tool: name,
      verdict: response.verdict
    });
    return toolText({
      ...response,
      references: await searchReferences(situation, 3).catch((error) => ({
        results: [],
        guidance: `references unavailable: ${String(error)}`
      }))
    });
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
    const situation = searchSituation(name, argumentsValue);
    const response = await searchReferences(situation);
    logToolCall({
      tool: name,
      situation,
      results: response.results.map((entry) => entry.id)
    });
    return toolText(response);
  }
  if (name === "engine_reference_detail") {
    if (typeof argumentsValue.game !== "string" || typeof argumentsValue.id !== "string" || argumentsValue.kind !== "node" && argumentsValue.kind !== "card")
      throw new Error(
        'engine_reference_detail requires "game" and "id" strings and "kind":"node" or "kind":"card".'
      );
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
  if (name === "engine_watch_reference") {
    const { query, duration, frames, at, pick, from } = argumentsValue;
    if (typeof query !== "string" || !query.trim())
      throw new Error("engine_watch_reference requires a non-empty string 'query'.");
    for (const [key, value] of Object.entries({ duration, frames, pick }))
      if (value !== void 0 && typeof value !== "number")
        throw new Error(`engine_watch_reference '${key}' must be a number when given.`);
    for (const [key, value] of Object.entries({ at, from }))
      if (value !== void 0 && typeof value !== "string")
        throw new Error(`engine_watch_reference '${key}' must be a string when given.`);
    const result = await watchReference({
      query,
      ...typeof duration === "number" ? { duration } : {},
      ...typeof frames === "number" ? { frames } : {},
      ...typeof at === "string" ? { at } : {},
      ...typeof pick === "number" ? { pick } : {},
      ...typeof from === "string" ? { from } : {}
    });
    logToolCall({ tool: name, query, sheet: result.sheet });
    return toolText(result);
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
        serverInfo: { name: "threenative-engine-mcp", version: "0.2.23" }
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
    let text2 = result.content[0].text;
    try {
      text2 = JSON.stringify(JSON.parse(text2), null, 2);
    } catch {
    }
    io.stdout(`${text2}
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
if (entryPath !== void 0 && realpathSync(path.resolve(entryPath)) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    runServer();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  }
}

export { ENGINE_MCP_TOOL_NAMES, RELEVANCE_FLOOR, capabilityDetail, capabilityDetails, capabilitySituationTokens, defaultManifestPath, handleLine, loadCapabilityManifest, runCli, runServer, searchCapabilities, toolDefinitions };
