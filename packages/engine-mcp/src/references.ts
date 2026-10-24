import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

/**
 * Game reference cards: what a classic game's decompilation says about how a mechanic feels.
 *
 * The data lives in its own CC-BY repository, never in this MIT package, and arrives as release
 * assets: `index.json.gz` (every game plus one stub per map node and card, the only file search
 * reads) and `game-<id>.json` (one game's repository map and cards, fetched when detail asks for
 * it). Search memory therefore grows with the stub count, not with the card bodies.
 */

export interface IReferenceGameRow {
  readonly id: string;
  readonly title: string;
  readonly platform: string;
  readonly repo: string;
  /** 1 has a map and cards; 2 is a title and a link that an agent explores when it needs it. */
  readonly tier: 1 | 2;
}

export interface IReferenceStub {
  readonly id: string;
  readonly game: string;
  readonly kind: "node" | "card";
  readonly name: string;
  readonly summary: string;
  readonly tags: readonly string[];
  readonly capabilities: readonly string[];
}

export interface IReferenceIndex {
  readonly version: 1;
  readonly games: readonly IReferenceGameRow[];
  readonly stubs: readonly IReferenceStub[];
}

export interface IReferenceNode {
  readonly id: string;
  readonly name: string;
  readonly purpose: string;
  readonly parent?: string;
  readonly paths: readonly string[];
  readonly functions: readonly {
    readonly name: string;
    readonly path: string;
    readonly lines: readonly [number, number];
  }[];
  readonly dependsOn: readonly string[];
}

export interface IReferenceCard {
  readonly id: string;
  readonly node: string;
  readonly name: string;
  readonly summary: string;
  readonly behavior: string;
  readonly constants: readonly {
    readonly name: string;
    readonly value: number | string;
    readonly unit: string;
    readonly source: string;
  }[];
  readonly sources: readonly { readonly path: string; readonly line: number }[];
  readonly capabilities: readonly string[];
  readonly tags: readonly string[];
}

export interface IReferenceGame {
  readonly version: 1;
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  /** Every path and line in the map and the cards is read at this commit. */
  readonly sha: string;
  readonly nodes: readonly IReferenceNode[];
  readonly cards: readonly IReferenceCard[];
}

const DEFAULT_REFERENCES_URL =
  "https://github.com/jonit-dev/threenative-game-refs/releases/latest/download/";
const FETCH_TIMEOUT_MS = 5_000;
const ID = /^[a-z0-9][a-z0-9-]*$/u;

export function referencesBaseUrl(): string {
  const value = process.env.THREENATIVE_REFERENCES_URL?.trim() || DEFAULT_REFERENCES_URL;
  return value.endsWith("/") ? value : `${value}/`;
}

export function referencesCacheDir(): string {
  const override = process.env.THREENATIVE_REFERENCES_CACHE?.trim();
  const source = createHash("sha256").update(referencesBaseUrl()).digest("hex").slice(0, 16);
  if (override) return path.join(path.resolve(override), source);
  const cacheHome = process.env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache");
  return path.join(cacheHome, "threenative", "refs", source);
}

/** Cards an agent saved for a game it explored itself; they belong to the game project. */
export function localReferencesDir(cwd = process.cwd()): string {
  return path.join(cwd, ".threenative", "refs");
}

function fail(where: string, reason: string): never {
  throw new Error(`TN_REFERENCES_MALFORMED: ${where}: ${reason}`);
}

function record(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(where, "expected an object");
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  // Unknown keys are refused, not ignored: a card must not smuggle a `code` field past review.
  if (unknown.length > 0)
    fail(where, `unknown field ${unknown.map((key) => `'${key}'`).join(", ")}`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(where, "expected a non-empty string");
  if (/```|~~~/u.test(value)) fail(where, "holds a code block; describe the behaviour instead");
  return value;
}

function id(value: unknown, where: string): string {
  const result = text(value, where);
  if (!ID.test(result)) fail(where, `'${result}' is not a lowercase kebab-case id`);
  return result;
}

function texts(value: unknown, where: string): readonly string[] {
  if (!Array.isArray(value)) fail(where, "expected an array of strings");
  return value.map((entry, index) => text(entry, `${where}[${index}]`));
}

function list<T>(value: unknown, where: string, item: (entry: unknown, at: string) => T): T[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value.map((entry, index) => item(entry, `${where}[${index}]`));
}

function line(value: unknown, where: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) fail(where, "expected a line number");
  return value as number;
}

function prose(value: unknown, where: string): string {
  const result = text(value, where);
  // Cards describe behaviour; decompiled code stays in the repository the card cites.
  if (result.includes("```")) fail(where, "holds a code block; describe the behaviour instead");
  return result;
}

function validateStub(value: unknown, where: string): IReferenceStub {
  const stub = record(value, where, [
    "id",
    "game",
    "kind",
    "name",
    "summary",
    "tags",
    "capabilities",
  ]);
  if (stub.kind !== "node" && stub.kind !== "card") fail(`${where}.kind`, "expected node or card");
  return {
    capabilities: texts(stub.capabilities, `${where}.capabilities`),
    game: id(stub.game, `${where}.game`),
    id: id(stub.id, `${where}.id`),
    kind: stub.kind,
    name: text(stub.name, `${where}.name`),
    summary: prose(stub.summary, `${where}.summary`),
    tags: texts(stub.tags, `${where}.tags`),
  };
}

export function validateReferenceIndex(value: unknown, where = "index"): IReferenceIndex {
  const index = record(value, where, ["version", "games", "stubs"]);
  if (index.version !== 1) fail(`${where}.version`, "expected 1");
  const games = list(index.games, `${where}.games`, (entry, at) => {
    const game = record(entry, at, ["id", "title", "platform", "repo", "tier"]);
    if (game.tier !== 1 && game.tier !== 2) fail(`${at}.tier`, "expected 1 or 2");
    return {
      id: id(game.id, `${at}.id`),
      platform: text(game.platform, `${at}.platform`),
      repo: text(game.repo, `${at}.repo`),
      tier: game.tier as 1 | 2,
      title: text(game.title, `${at}.title`),
    };
  });
  const stubs = list(index.stubs, `${where}.stubs`, validateStub);
  unique(
    games.map((game) => game.id),
    `${where}.games`,
  );
  unique(
    stubs.map((stub) => `${stub.game}/${stub.kind}/${stub.id}`),
    `${where}.stubs`,
  );
  for (const stub of stubs)
    if (!games.some((game) => game.id === stub.game)) fail(where, `missing game '${stub.game}'`);
  return { games, stubs, version: 1 };
}

function validateNode(value: unknown, where: string): IReferenceNode {
  const node = record(value, where, [
    "id",
    "name",
    "purpose",
    "parent",
    "paths",
    "functions",
    "dependsOn",
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
        lines: [from, to] as const,
        name: text(fn.name, `${at}.name`),
        path: text(fn.path, `${at}.path`),
      };
    }),
    id: id(node.id, `${where}.id`),
    name: text(node.name, `${where}.name`),
    paths: texts(node.paths, `${where}.paths`),
    purpose: prose(node.purpose, `${where}.purpose`),
    ...(node.parent === undefined ? {} : { parent: id(node.parent, `${where}.parent`) }),
  };
}

function validateCard(value: unknown, where: string): IReferenceCard {
  const card = record(value, where, [
    "id",
    "node",
    "name",
    "summary",
    "behavior",
    "constants",
    "sources",
    "capabilities",
    "tags",
  ]);
  return {
    behavior: prose(card.behavior, `${where}.behavior`),
    capabilities: texts(card.capabilities, `${where}.capabilities`),
    constants: list(card.constants, `${where}.constants`, (entry, at) => {
      const constant = record(entry, at, ["name", "value", "unit", "source"]);
      if (
        (typeof constant.value !== "number" || !Number.isFinite(constant.value)) &&
        typeof constant.value !== "string"
      )
        fail(`${at}.value`, "expected a number or a string");
      return {
        name: text(constant.name, `${at}.name`),
        source: text(constant.source, `${at}.source`),
        unit: text(constant.unit, `${at}.unit`),
        value:
          typeof constant.value === "string" ? text(constant.value, `${at}.value`) : constant.value,
      };
    }),
    id: id(card.id, `${where}.id`),
    name: text(card.name, `${where}.name`),
    node: id(card.node, `${where}.node`),
    sources: list(card.sources, `${where}.sources`, (entry, at) => {
      const source = record(entry, at, ["path", "line"]);
      return { line: line(source.line, `${at}.line`), path: text(source.path, `${at}.path`) };
    }),
    summary: prose(card.summary, `${where}.summary`),
    tags: texts(card.tags, `${where}.tags`),
  };
}

function unique(ids: readonly string[], where: string): void {
  const seen = new Set<string>();
  for (const value of ids) {
    if (seen.has(value)) fail(where, `duplicate id '${value}'`);
    seen.add(value);
  }
}

export function validateReferenceGame(value: unknown, where = "game"): IReferenceGame {
  const game = record(value, where, ["version", "id", "title", "repo", "sha", "nodes", "cards"]);
  if (game.version !== 1) fail(`${where}.version`, "expected 1");
  const nodes = list(game.nodes, `${where}.nodes`, validateNode);
  const cards = list(game.cards, `${where}.cards`, validateCard);
  unique(
    nodes.map((node) => node.id),
    `${where}.nodes`,
  );
  unique(
    cards.map((card) => card.id),
    `${where}.cards`,
  );
  const nodeIds = new Set(nodes.map((node) => node.id));
  for (const node of nodes) {
    for (const dependency of node.dependsOn)
      if (!nodeIds.has(dependency)) fail(where, `missing dependency '${dependency}'`);
    const ancestors = new Set([node.id]);
    let parent = node.parent;
    while (parent !== undefined) {
      if (ancestors.has(parent)) fail(where, `cyclic parent '${parent}'`);
      ancestors.add(parent);
      parent = nodes.find((entry) => entry.id === parent)?.parent;
    }
  }
  for (const node of nodes)
    if (node.parent !== undefined && !nodeIds.has(node.parent))
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
    version: 1,
  };
}

/** The stubs search reads for one game file: one per map node, one per card. */
export function referenceStubs(game: IReferenceGame): IReferenceStub[] {
  return [
    ...game.nodes.map((node) => ({
      capabilities: [],
      game: game.id,
      id: node.id,
      kind: "node" as const,
      name: node.name,
      summary: node.purpose,
      tags: [],
    })),
    ...game.cards.map((card) => ({
      capabilities: card.capabilities,
      game: game.id,
      id: card.id,
      kind: "card" as const,
      name: card.name,
      summary: card.summary,
      tags: card.tags,
    })),
  ];
}

/**
 * One release asset through the cache: a conditional GET with the stored ETag, the cached copy on
 * a 304 or when the network is gone, and a throw when there is neither. `parse` runs before the
 * cache is written, so a malformed release throws and never replaces the last good copy.
 */
async function cachedAsset<T>(name: string, parse: (body: Buffer) => T): Promise<T> {
  const file = path.join(referencesCacheDir(), name);
  const etagFile = `${file}.etag`;
  let response: Response;
  try {
    const etag = existsSync(file) && existsSync(etagFile) ? readFileSync(etagFile, "utf8") : "";
    response = await fetch(new URL(name, referencesBaseUrl()), {
      headers: etag.length > 0 ? { "if-none-match": etag } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  let body: Buffer;
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

function parseJson(body: Buffer, name: string): unknown {
  try {
    return JSON.parse(body.toString("utf8")) as unknown;
  } catch (error) {
    return fail(name, `cannot parse JSON: ${String(error)}`);
  }
}

let indexLoad: Promise<IReferenceIndex> | undefined;
const gameLoads = new Map<string, Promise<IReferenceGame>>();

/** The index, refreshed once per server process; a failed refresh is retried on the next call. */
export function loadReferenceIndex(): Promise<IReferenceIndex> {
  indexLoad ??= cachedAsset("index.json.gz", (body) =>
    validateReferenceIndex(parseJson(gunzipSync(body), "index.json.gz"), "index.json.gz"),
  ).catch((error: unknown) => {
    indexLoad = undefined;
    throw error;
  });
  return indexLoad;
}

export function loadLocalReferenceGames(cwd = process.cwd()): IReferenceGame[] {
  const directory = localReferencesDir(cwd);
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) =>
      validateReferenceGame(
        parseJson(readFileSync(path.join(directory, file)), file),
        path.join(".threenative", "refs", file),
      ),
    );
}

/** One game's map and cards: the project's own saved copy first, then the release. */
export function loadReferenceGame(gameId: string, cwd = process.cwd()): Promise<IReferenceGame> {
  const local = loadLocalReferenceGames(cwd).find((game) => game.id === gameId);
  if (local !== undefined) return Promise.resolve(local);
  const name = `game-${id(gameId, "game id")}.json`;
  let load = gameLoads.get(name);
  if (load === undefined) {
    load = cachedAsset(name, (body) => {
      const game = validateReferenceGame(parseJson(body, name), name);
      if (game.id !== gameId) fail(name, `id '${game.id}' differs from requested '${gameId}'`);
      return game;
    }).catch((error: unknown) => {
      gameLoads.delete(name);
      throw error;
    });
    gameLoads.set(name, load);
  }
  return load;
}

function atomicWrite(file: string, value: string | Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, value);
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const CONTRIBUTION_REPO = "jonit-dev/threenative-game-refs";

/**
 * Saves what an agent mapped in a game it explored, merged by id over its earlier save, and
 * returns the issue that offers it to the shared data repository for review.
 */
export function saveReferenceGame(
  value: unknown,
  cwd = process.cwd(),
): {
  readonly saved: string;
  readonly contribution: { readonly command: string; readonly title: string };
} {
  const incoming = record(value, "reference", [
    "version",
    "id",
    "title",
    "repo",
    "sha",
    "nodes",
    "cards",
  ]);
  const gameId = id(incoming.id, "reference.id");
  const file = path.join(localReferencesDir(cwd), `${gameId}.json`);
  const previous = existsSync(file)
    ? validateReferenceGame(parseJson(readFileSync(file), file), file)
    : undefined;
  const merge = (old: readonly { readonly id: string }[], next: unknown): unknown[] => {
    if (!Array.isArray(next)) fail("reference", "expected an array");
    const replacements = new Set(
      next.map((entry: unknown) =>
        typeof entry === "object" && entry !== null && "id" in entry ? entry.id : undefined,
      ),
    );
    return [...old.filter((entry) => !replacements.has(entry.id)), ...next];
  };
  const merged = validateReferenceGame(
    previous === undefined || previous.sha !== incoming.sha
      ? incoming
      : {
          ...incoming,
          cards: merge(previous.cards, incoming.cards),
          nodes: merge(previous.nodes, incoming.nodes),
        },
    "reference",
  );
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWrite(file, `${JSON.stringify(merged, null, 2)}\n`);
  const relative = path.relative(cwd, file);
  const title = `Reference cards: ${merged.title} (${merged.nodes.length} nodes, ${merged.cards.length} cards)`;
  return {
    contribution: {
      command: `gh issue create --repo ${CONTRIBUTION_REPO} --title ${shellQuote(title)} --body-file ${shellQuote(relative)}`,
      title,
    },
    saved: relative,
  };
}
