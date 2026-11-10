import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * PRD-865: one capability search should answer, and find a symbol by its name.
 *
 * Two arms over one frozen gold set: the base (the engine-mcp `src/` at a pinned commit, extracted
 * with `git archive`) and the candidate (this working tree). Both read the same manifest and the
 * same queries, so every difference is the change under test. The held-out half is frozen by
 * sha256 in the fixture and in the PRD, and nothing here reads it by hand: the harness reports its
 * numbers and the acceptance thresholds compare them.
 */

export const GOLD_RELATIVE_PATH = path.join(
  "packages",
  "engine-mcp",
  "__tests__",
  "fixtures",
  "search-gold.json",
);
const MANIFEST_RELATIVE_PATH = path.join("packages", "create-threenative", "capabilities.json");
const SOURCE_RELATIVE_PATH = path.join("packages", "engine-mcp", "src");
const ARTIFACT_RELATIVE_PATH = path.join("artifacts", "capability-search-ab.json");

export const SEARCH_GOLD_QUERY_COUNT = 150;
export const SEARCH_GOLD_HELDOUT_COUNT = 50;
export const SEARCH_GOLD_EXACT_SYMBOL_COUNT = 20;

export type GoldKind = "exact-symbol" | "mechanic" | "request";
export type GoldSplit = "dev" | "heldout";

export interface IGoldRow {
  readonly id: string;
  readonly query: string;
  readonly kind: GoldKind;
  readonly split: GoldSplit;
  readonly expect: readonly string[];
  /** Where the query came from: a real session log, or the symbol an agent reached for by name. */
  readonly source: string;
  readonly note?: string;
}

export interface IGoldSet {
  readonly version: 1;
  /** sha256 of the held-out rows as written, so a later edit to them fails the gate. */
  readonly heldoutSha256: string;
  readonly rows: readonly IGoldRow[];
}

export type CapabilityScope = "mechanic" | "request";

export interface IArmSearchResult {
  readonly symbol: string;
  readonly importPath: string;
  readonly signature?: string;
  readonly matchedSituation: string;
  readonly score: number;
}

export interface IArmSearchResponse {
  readonly verdict: "matched" | "none" | "starterKit";
  readonly results: readonly IArmSearchResult[];
  readonly guidance: string;
}

export interface IArmModule {
  readonly searchCapabilities: (
    situation: string,
    manifestFile?: string,
    scope?: CapabilityScope,
  ) => IArmSearchResponse;
  readonly capabilityDetails: (
    symbol: string,
    manifestFile?: string,
    importPath?: string,
  ) => readonly unknown[];
}

export interface IArmRow {
  readonly id: string;
  readonly kind: GoldKind;
  readonly split: GoldSplit;
  readonly rank: number;
  readonly reciprocalRank: number;
  readonly searchBytes: number;
  readonly detailBytes: number;
  readonly detailsOpened: number;
  readonly tokensToAnswer: number;
  readonly symbols: readonly string[];
}

export interface IArmMetric {
  readonly rows: number;
  readonly recall1: number;
  readonly recall5: number;
  readonly mrr: number;
}

export interface IArmReport extends IArmMetric {
  readonly answered: number;
  readonly tokensToAnswer: number;
  readonly searchBytes: number;
  readonly detailBytes: number;
  readonly byKind: Readonly<Record<GoldKind, IArmMetric>>;
  readonly results: readonly IArmRow[];
}

export interface IThreshold {
  readonly name: string;
  readonly candidate: number;
  readonly base: number;
  readonly required: string;
  readonly pass: boolean;
}

export interface ILiveRun {
  readonly brief: string;
  readonly run: number;
  readonly toolCalls: number;
  readonly responseBytes: number;
  readonly capabilityBytes: number;
  readonly correct: boolean;
  /** A run whose CLI failed is not a cheap run; it is a hole in the measurement. */
  readonly failed: boolean;
}

export interface ILiveArm {
  readonly rows: readonly ILiveRun[];
  readonly toolCalls: number;
  readonly responseBytes: number;
  readonly capabilityBytes: number;
  readonly correctRate: number;
  readonly failed: number;
}

const KINDS: readonly GoldKind[] = ["exact-symbol", "mechanic", "request"];
const SPLITS: readonly GoldSplit[] = ["dev", "heldout"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metadataError(message: string): Error {
  return new Error(`TN_CAPABILITY_SEARCH_GOLD: ${message}`);
}

/** The held-out rows exactly as the fixture writes them, so the hash covers content and order. */
export function heldoutHash(rows: readonly unknown[]): string {
  const heldout = rows.filter(
    (row) => isRecord(row) && (row as { split?: unknown }).split === "heldout",
  );
  return createHash("sha256").update(JSON.stringify(heldout)).digest("hex");
}

export function goldRowIdentity(row: IGoldRow): string {
  return [row.id, row.query, row.kind, row.split, row.expect.join(","), row.source].join("\u0000");
}

/**
 * Loads and validates the gold set against the manifest it is measured with. Every expected symbol
 * has to exist: a typo in a label turns into a miss that no scorer can fix, and the gate would then
 * be measuring the label rather than the search.
 */
export function validateGoldSet(value: unknown, manifestSymbols: ReadonlySet<string>): IGoldSet {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rows)) {
    throw metadataError("root must contain version 1 and a rows array");
  }
  if (typeof value.heldoutSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.heldoutSha256)) {
    throw metadataError("heldoutSha256 must be a sha256 hex digest");
  }
  const ids = new Set<string>();
  const queries = new Set<string>();
  const rows = value.rows.map((raw, index): IGoldRow => {
    if (!isRecord(raw)) throw metadataError(`row ${index} is malformed`);
    const { id, query, kind, split, expect, source, note } = raw;
    if (typeof id !== "string" || id.trim().length === 0)
      throw metadataError(`row ${index} has no id`);
    if (typeof query !== "string" || query.trim().length === 0)
      throw metadataError(`${id}: query must be a non-empty string`);
    if (typeof kind !== "string" || !KINDS.includes(kind as GoldKind))
      throw metadataError(`${id}: kind must be one of ${KINDS.join(", ")}`);
    if (typeof split !== "string" || !SPLITS.includes(split as GoldSplit))
      throw metadataError(`${id}: split must be one of ${SPLITS.join(", ")}`);
    if (typeof source !== "string" || source.trim().length === 0)
      throw metadataError(`${id}: source must be a non-empty string`);
    if (
      !Array.isArray(expect) ||
      expect.length === 0 ||
      !expect.every((s) => typeof s === "string")
    )
      throw metadataError(`${id}: expect must be a non-empty string array`);
    if (note !== undefined && typeof note !== "string")
      throw metadataError(`${id}: note must be a string when given`);
    if (ids.has(id)) throw metadataError(`duplicate row id '${id}'`);
    if (queries.has(query)) throw metadataError(`duplicate query '${query}'`);
    ids.add(id);
    queries.add(query);
    for (const symbol of expect) {
      if (!manifestSymbols.has(symbol)) {
        throw metadataError(`${id}: symbol '${symbol}' is absent from the manifest`);
      }
    }
    return {
      expect: [...(expect as string[])],
      id,
      kind: kind as GoldKind,
      ...(note === undefined ? {} : { note }),
      query,
      source,
      split: split as GoldSplit,
    };
  });
  const heldout = heldoutHash(value.rows);
  if (heldout !== value.heldoutSha256) {
    throw metadataError(
      `held-out rows changed: sha256 ${heldout} does not match the frozen ${value.heldoutSha256}`,
    );
  }
  return { heldoutSha256: value.heldoutSha256, rows, version: 1 };
}

export async function loadGoldSet(
  manifestFile: string,
  goldFile = path.resolve(GOLD_RELATIVE_PATH),
): Promise<IGoldSet> {
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as {
    entries: readonly { symbol: string }[];
  };
  const symbols = new Set(manifest.entries.map((entry) => entry.symbol));
  return validateGoldSet(JSON.parse(await readFile(goldFile, "utf8")), symbols);
}

/** sha256 over every source file, so the two arms are provably different code. */
export async function sourceHash(directory: string): Promise<string> {
  const files = (await readdir(directory, { recursive: true }))
    .map((entry) => path.join(directory, entry))
    .sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(directory, file));
    hash.update("\u0000");
    hash.update(await readFile(file));
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

async function loadArm(sourceDirectory: string): Promise<IArmModule> {
  const module = (await import(pathToFileURL(path.join(sourceDirectory, "index.ts")).href)) as
    | IArmModule
    | { default: IArmModule };
  const arm = "searchCapabilities" in module ? module : module.default;
  if (
    typeof arm?.searchCapabilities !== "function" ||
    typeof arm.capabilityDetails !== "function"
  ) {
    throw metadataError(`${sourceDirectory} does not export the capability search surface`);
  }
  return arm;
}

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

/**
 * Real response bytes a row costs, plus the detail each top-5 row still forces. A row that carries
 * its own `signature` answers by itself; the base row does not, and its rule opens every hit.
 */
export function measureArm(arm: IArmModule, rows: readonly IGoldRow[], manifestFile: string) {
  return rows.map((row): IArmRow => {
    const response = arm.searchCapabilities(
      row.query,
      manifestFile,
      row.kind === "request" ? "request" : "mechanic",
    );
    const symbols = response.results.map((result) => result.symbol);
    const rank = symbols.findIndex((symbol) => row.expect.includes(symbol));
    let detailBytes = 0;
    let detailsOpened = 0;
    for (const result of response.results.slice(0, 5)) {
      if (result.signature !== undefined) continue;
      detailsOpened += 1;
      try {
        detailBytes += bytes(arm.capabilityDetails(result.symbol, manifestFile, result.importPath));
      } catch {
        // A row whose symbol no longer resolves already costs the author a failed call; count the
        // bytes the error itself costs rather than inventing a payload for it.
        detailBytes += `Unknown engine capability '${result.symbol}'.`.length;
      }
    }
    const searchBytes = bytes(response);
    return {
      detailBytes,
      detailsOpened,
      id: row.id,
      kind: row.kind,
      split: row.split,
      rank,
      reciprocalRank: rank < 0 ? 0 : 1 / (rank + 1),
      searchBytes,
      symbols,
      tokensToAnswer: (searchBytes + detailBytes) / 4,
    };
  });
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

function metricFor(rows: readonly IArmRow[]): IArmMetric {
  return {
    mrr:
      rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.reciprocalRank, 0) / rows.length,
    recall1: ratio(rows.filter((row) => row.rank === 0).length, rows.length),
    recall5: ratio(rows.filter((row) => row.rank >= 0 && row.rank < 5).length, rows.length),
    rows: rows.length,
  };
}

export function reportArm(
  arm: IArmModule,
  gold: IGoldSet,
  manifestFile: string,
  split: GoldSplit,
): IArmReport {
  const rows = gold.rows.filter((row) => row.split === split);
  const measured = measureArm(arm, rows, manifestFile);
  const metric = metricFor(measured);
  const byKind = Object.fromEntries(
    KINDS.map((kind) => [kind, metricFor(measured.filter((row) => row.kind === kind))]),
  ) as Record<GoldKind, IArmMetric>;
  // Tokens is what an answer costs, so it is averaged over the rows that reached one. A miss is
  // cheap and answers nothing; recall already counts it, and pricing the miss at zero here would
  // reward the arm that fails, which is the opposite of what this gate is for.
  const answered = measured.filter((row) => row.rank >= 0 && row.rank < 5);
  const total = (rows: readonly IArmRow[], key: "searchBytes" | "detailBytes" | "tokensToAnswer") =>
    rows.reduce((sum, row) => sum + row[key], 0);
  return {
    ...metric,
    answered: answered.length,
    byKind,
    detailBytes: total(measured, "detailBytes"),
    results: measured,
    searchBytes: total(measured, "searchBytes"),
    tokensToAnswer: answered.length === 0 ? 0 : total(answered, "tokensToAnswer") / answered.length,
  };
}

/** The AC-3 and AC-4 gates, all on the frozen held-out half. */
export function compareArms(
  base: IArmReport,
  candidate: IArmReport,
): {
  readonly thresholds: readonly IThreshold[];
  readonly dropped: readonly string[];
} {
  // The same rows on both sides: the arm that answers more rows must not pay for them here, and
  // the arm that fails a row must not look cheap because it answered nothing.
  const common = base.results
    .filter((row) => row.rank >= 0 && row.rank < 5)
    .map((row) => row.id)
    .filter((id) => {
      const other = candidate.results.find((row) => row.id === id);
      return other !== undefined && other.rank >= 0 && other.rank < 5;
    });
  const commonTokens = (report: IArmReport): number => {
    const rows = report.results.filter((row) => common.includes(row.id));
    return rows.length === 0
      ? 0
      : rows.reduce((sum, row) => sum + row.tokensToAnswer, 0) / rows.length;
  };
  const thresholds: IThreshold[] = [
    {
      base: base.recall5,
      candidate: candidate.recall5,
      name: "heldout recall@5 gain",
      pass: candidate.recall5 >= base.recall5 + 0.1,
      required: `>= ${(base.recall5 + 0.1).toFixed(3)} (+0.10)`,
    },
    {
      base: base.recall1,
      candidate: candidate.recall1,
      name: "heldout recall@1 gain",
      pass: candidate.recall1 >= base.recall1 + 0.05,
      required: `>= ${(base.recall1 + 0.05).toFixed(3)} (+0.05)`,
    },
    {
      base: commonTokens(base),
      candidate: commonTokens(candidate),
      name: `tokens to answer (${common.length} rows both answer)`,
      pass: commonTokens(candidate) <= commonTokens(base) * 0.7,
      required: `<= ${(commonTokens(base) * 0.7).toFixed(0)} (-30%)`,
    },
  ];
  const dropped = base.results
    .filter((row) => row.rank >= 0 && row.rank < 5)
    .filter((row) => {
      const after = candidate.results.find((other) => other.id === row.id);
      return after === undefined || after.rank < 0 || after.rank >= 5;
    })
    .map((row) => row.id);
  thresholds.push({
    base: 0,
    candidate: dropped.length,
    name: "queries that leave the top 5",
    pass: dropped.length <= 1,
    required: "<= 1",
  });
  return { dropped, thresholds };
}

const LIVE_BRIEFS: readonly { readonly query: string; readonly expect: readonly string[] }[] = [
  { expect: ["godrays"], query: "volumetric sun shafts through a window into a dusty room" },
  {
    expect: ["traa"],
    query: "the TRAA stage that resolves jittered frames on alpha-tested foliage",
  },
  {
    expect: ["mergeParts"],
    query: "merge many static meshes into one mesh per material, keeping authored UVs and normals",
  },
  {
    expect: ["NavigationAgent3D"],
    query: "an enemy that walks around walls to reach the player",
  },
  { expect: ["GPUParticles3D"], query: "dust particles trailing behind a running player" },
  { expect: ["SoftBody3D"], query: "cloth sails that billow in the wind on a ship" },
  { expect: ["Joint3D"], query: "a hinged door that swings on a pivot when pushed" },
  { expect: ["texturePass"], query: "compile textures to BC7 blocks for the GPU" },
  { expect: ["RigidBody3D"], query: "a cannonball that falls, bounces and rolls on the ground" },
  {
    expect: ["InstancedBatch"],
    query: "thousands of identical blocks drawn in one instanced batch",
  },
];

export const BASE_RULE =
  "Read every capability hit with engine_capability_detail before you use it.";
export const CANDIDATE_RULE =
  "Read every capability hit's row. Call engine_capability_detail only for a symbol the search did not return.";

interface IClaudeStreamEvent {
  readonly type?: string;
  readonly result?: string;
  readonly message?: {
    readonly content?: readonly {
      readonly type?: string;
      readonly id?: string;
      readonly name?: string;
      readonly content?: readonly { readonly type?: string; readonly text?: string }[];
    }[];
  };
}

interface ILiveParse {
  readonly answer: string;
  readonly toolCalls: number;
  readonly responseBytes: number;
  /** Bytes the capability answer itself costs: the search payload without its reference stubs. */
  readonly capabilityBytes: number;
}

/**
 * A search response also carries three reference stubs, which this change does not touch and which
 * dominate a short response. They are counted separately so the byte comparison measures the rows
 * that changed rather than a constant every arm pays.
 */
function parseLiveOutput(text: string): ILiveParse {
  let toolCalls = 0;
  let responseBytes = 0;
  let capabilityBytes = 0;
  let answer = "";
  const tools = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    let event: IClaudeStreamEvent;
    try {
      event = JSON.parse(line) as IClaudeStreamEvent;
    } catch {
      continue;
    }
    if (event.type === "result" && typeof event.result === "string") answer = event.result;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name?.startsWith("mcp__engine__") === true) {
        toolCalls += 1;
        if (block.id !== undefined) tools.set(block.id, block.name);
      }
      if (block.type !== "tool_result") continue;
      const result = block as {
        readonly tool_use_id?: string;
        readonly content?: readonly { readonly type?: string; readonly text?: string }[];
      };
      const name = result.tool_use_id === undefined ? undefined : tools.get(result.tool_use_id);
      for (const part of result.content ?? []) {
        if (part.type !== "text" || typeof part.text !== "string") continue;
        const size = Buffer.byteLength(part.text);
        responseBytes += size;
        if (name !== "mcp__engine__engine_search_capabilities") {
          capabilityBytes += size;
          continue;
        }
        let withoutReferences = size;
        try {
          const payload = JSON.parse(part.text) as { references?: unknown };
          // Measured by re-serializing the payload without its stubs as the old server printed it, so
          // the payload-only figure compares indented bytes to indented bytes and takes the
          // serialization change out of it rather than crediting it twice.
          withoutReferences = Buffer.byteLength(
            JSON.stringify({ ...payload, references: undefined }, null, 2),
          );
        } catch {
          withoutReferences = size;
        }
        capabilityBytes += Math.min(size, withoutReferences);
      }
    }
  }
  return { answer, capabilityBytes, responseBytes, toolCalls };
}

function claudeBinary(): string {
  return process.env.CLAUDE_BIN ?? "claude";
}

/**
 * Live arm: the same ten briefs, each asked once through the arm's own MCP server with the arm's
 * own rule as the prompt prefix. Counted are the MCP calls the agent made, the bytes those calls
 * returned, and whether the answer named a correct symbol — a smaller row that costs one more
 * round trip is not a win, so bytes and calls are both reported.
 */
async function runLiveArm(
  name: "base" | "candidate",
  sourceDirectory: string,
  manifestFile: string,
  runs: number,
): Promise<ILiveArm> {
  const root = process.cwd();
  const tsx = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const workdir = await mkdtemp(path.join(os.tmpdir(), `tn-search-ab-${name}-`));
  const configFile = path.join(workdir, "mcp.json");
  await writeFile(
    configFile,
    `${JSON.stringify(
      {
        mcpServers: {
          engine: {
            args: [tsx, path.join(sourceDirectory, "index.ts")],
            command: process.execPath,
            env: {
              THREENATIVE_CAPABILITIES_MANIFEST: manifestFile,
              THREENATIVE_ENGINE_MCP_LOG: path.join(workdir, "engine-mcp.log"),
            },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const rule = name === "base" ? BASE_RULE : CANDIDATE_RULE;
  const rows: ILiveRun[] = [];
  try {
    for (const brief of LIVE_BRIEFS) {
      for (let run = 1; run <= runs; run += 1) {
        const prompt = `${rule} Find the engine capability for: ${brief.query}. Print its import line and its signature. Write no code and no files.`;
        let stdout = "";
        try {
          stdout = execFileSync(
            claudeBinary(),
            [
              "-p",
              "--model",
              "sonnet",
              "--strict-mcp-config",
              "--mcp-config",
              configFile,
              "--output-format",
              "stream-json",
              "--verbose",
              "--allowedTools",
              "mcp__engine__engine_search_capabilities,mcp__engine__engine_capability_detail",
            ],
            // The prompt goes on stdin: `claude -p` refuses a positional prompt after its flags.
            {
              cwd: workdir,
              encoding: "utf8",
              input: prompt,
              maxBuffer: 64 * 1024 * 1024,
              timeout: 300_000,
            },
          );
        } catch (error) {
          process.stderr.write(`${name}: live run failed for '${brief.query}': ${String(error)}\n`);
          rows.push({
            brief: brief.query,
            capabilityBytes: 0,
            correct: false,
            failed: true,
            responseBytes: 0,
            run,
            toolCalls: 0,
          });
          continue;
        }
        const parsed = parseLiveOutput(stdout);
        rows.push({
          brief: brief.query,
          capabilityBytes: parsed.capabilityBytes,
          correct: brief.expect.some((symbol) => parsed.answer.includes(symbol)),
          failed: false,
          responseBytes: parsed.responseBytes,
          run,
          toolCalls: parsed.toolCalls,
        });
      }
    }
  } finally {
    await rm(workdir, { force: true, recursive: true });
  }
  const completed = rows.filter((row) => !row.failed);
  return {
    capabilityBytes: rows.reduce((sum, row) => sum + row.capabilityBytes, 0),
    correctRate: ratio(completed.filter((row) => row.correct).length, completed.length),
    failed: rows.filter((row) => row.failed).length,
    responseBytes: rows.reduce((sum, row) => sum + row.responseBytes, 0),
    rows,
    toolCalls: rows.reduce((sum, row) => sum + row.toolCalls, 0),
  };
}

export function formatTable(arm: string, report: IArmReport, base?: IArmReport): string {
  const delta = (value: number, other: number | undefined) =>
    other === undefined ? "" : ` (${value - other >= 0 ? "+" : ""}${(value - other).toFixed(3)})`;
  const lines = [
    `${arm}: ${report.rows} rows (${report.answered} answered)  recall@1 ${report.recall1.toFixed(3)}${delta(report.recall1, base?.recall1)}  recall@5 ${report.recall5.toFixed(3)}${delta(report.recall5, base?.recall5)}  MRR ${report.mrr.toFixed(3)}${delta(report.mrr, base?.mrr)}  tokens ${report.tokensToAnswer.toFixed(0)}${delta(report.tokensToAnswer, base?.tokensToAnswer)}`,
  ];
  for (const kind of KINDS) {
    const metric = report.byKind[kind];
    const other = base?.byKind[kind];
    lines.push(
      `  ${kind.padEnd(12)} rows ${String(metric.rows).padStart(3)}  recall@1 ${metric.recall1.toFixed(3)}${delta(metric.recall1, other?.recall1)}  recall@5 ${metric.recall5.toFixed(3)}${delta(metric.recall5, other?.recall5)}`,
    );
  }
  return lines.join("\n");
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

export async function main(args: readonly string[]): Promise<number> {
  const root = process.cwd();
  const base = flagValue(args, "--base") ?? "ecd2a1a56";
  if (!/^[0-9a-f]{7,40}$/u.test(base)) {
    process.stderr.write(`--base must be a commit sha, got '${base}'\n`);
    return 1;
  }
  const manifestFile = path.resolve(root, MANIFEST_RELATIVE_PATH);
  const reportOnly = hasFlag(args, "--report-only");
  const workdir = await mkdtemp(path.join(os.tmpdir(), "tn-search-ab-base-"));
  try {
    const archive = execFileSync("git", ["archive", base, SOURCE_RELATIVE_PATH], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    execFileSync("tar", ["-x", "-C", workdir], { input: archive });
    const baseDirectory = path.join(workdir, SOURCE_RELATIVE_PATH);
    if (!existsSync(path.join(baseDirectory, "index.ts"))) {
      process.stderr.write(`TN_CAPABILITY_SEARCH_AB: ${base} has no ${SOURCE_RELATIVE_PATH}\n`);
      return 1;
    }
    const candidateDirectory = path.resolve(root, SOURCE_RELATIVE_PATH);
    const baseHash = await sourceHash(baseDirectory);
    const candidateHash = await sourceHash(candidateDirectory);
    process.stdout.write(
      `base      ${base}  ${baseHash}\ncandidate ${"working tree".padEnd(base.length)}  ${candidateHash}\n`,
    );
    if (baseHash === candidateHash) {
      process.stderr.write(
        `TN_CAPABILITY_SEARCH_AB: both arms are the same source (${baseHash}); nothing to compare\n`,
      );
      return 1;
    }
    const gold = await loadGoldSet(manifestFile, path.resolve(root, GOLD_RELATIVE_PATH));
    const baseArm = await loadArm(baseDirectory);
    const candidateArm = await loadArm(candidateDirectory);
    const baseHeldout = reportArm(baseArm, gold, manifestFile, "heldout");
    const candidateHeldout = reportArm(candidateArm, gold, manifestFile, "heldout");
    const baseDev = reportArm(baseArm, gold, manifestFile, "dev");
    const candidateDev = reportArm(candidateArm, gold, manifestFile, "dev");
    process.stdout.write(
      `\nheld-out (${gold.heldoutSha256.slice(0, 12)})\n${formatTable("base     ", baseHeldout)}\n${formatTable("candidate", candidateHeldout, baseHeldout)}\n`,
    );
    process.stdout.write(
      `\ndev (tuning only)\n${formatTable("base     ", baseDev)}\n${formatTable("candidate", candidateDev, baseDev)}\n`,
    );
    const { dropped, thresholds: offlineThresholds } = compareArms(baseHeldout, candidateHeldout);
    const thresholds: IThreshold[] = [...offlineThresholds];
    process.stdout.write("\ngates\n");
    for (const threshold of thresholds) {
      process.stdout.write(
        `  ${threshold.pass ? "pass" : "FAIL"}  ${threshold.name}: ${threshold.candidate.toFixed(3)} (required ${threshold.required})\n`,
      );
    }
    if (dropped.length > 0) process.stdout.write(`  left the top 5: ${dropped.join(", ")}\n`);
    const live = hasFlag(args, "--live")
      ? {
          base: await runLiveArm(
            "base",
            baseDirectory,
            manifestFile,
            Number(flagValue(args, "--runs") ?? 1),
          ),
          candidate: await runLiveArm(
            "candidate",
            candidateDirectory,
            manifestFile,
            Number(flagValue(args, "--runs") ?? 1),
          ),
        }
      : undefined;
    if (live !== undefined) {
      process.stdout.write(
        `\nlive (${String(LIVE_BRIEFS.length)} briefs)\n  base      calls ${live.base.toolCalls}  capability bytes ${live.base.capabilityBytes}  all bytes ${live.base.responseBytes}  correct ${live.base.correctRate.toFixed(2)}\n  candidate calls ${live.candidate.toolCalls}  capability bytes ${live.candidate.capabilityBytes}  all bytes ${live.candidate.responseBytes}  correct ${live.candidate.correctRate.toFixed(2)}\n`,
      );
      thresholds.push(
        {
          base: 0,
          candidate: live.base.failed + live.candidate.failed,
          name: "live runs that completed",
          pass: live.base.failed === 0 && live.candidate.failed === 0,
          required: "0",
        },
        {
          base: live.base.toolCalls,
          candidate: live.candidate.toolCalls,
          name: "live MCP tool calls",
          pass: live.candidate.toolCalls <= live.base.toolCalls * 0.7,
          required: `<= ${(live.base.toolCalls * 0.7).toFixed(0)} (-30%)`,
        },
        {
          base: live.base.responseBytes,
          candidate: live.candidate.responseBytes,
          name: "live MCP response bytes",
          pass: live.candidate.responseBytes <= live.base.responseBytes * 0.7,
          required: `<= ${(live.base.responseBytes * 0.7).toFixed(0)} (-30%)`,
        },
        {
          base: live.base.correctRate,
          candidate: live.candidate.correctRate,
          name: "live correct-symbol rate",
          pass: live.candidate.correctRate >= live.base.correctRate,
          required: `>= ${live.base.correctRate.toFixed(2)}`,
        },
      );
      process.stdout.write(
        `  note  capability payload only (reference stubs excluded): ${live.base.capabilityBytes} -> ${live.candidate.capabilityBytes} (${((live.candidate.capabilityBytes / live.base.capabilityBytes - 1) * 100).toFixed(1)}%)\n`,
      );
      for (const threshold of thresholds.slice(-4)) {
        process.stdout.write(
          `  ${threshold.pass ? "pass" : "FAIL"}  ${threshold.name}: ${threshold.candidate} (required ${threshold.required})\n`,
        );
      }
    }
    const artifactFile = path.resolve(root, ARTIFACT_RELATIVE_PATH);
    await mkdir(path.dirname(artifactFile), { recursive: true });
    await writeFile(
      artifactFile,
      `${JSON.stringify(
        {
          base: { hash: baseHash, ref: base },
          candidate: { hash: candidateHash, ref: "working tree" },
          generatedAt: new Date().toISOString(),
          gold: { heldoutSha256: gold.heldoutSha256, rows: gold.rows.length },
          live,
          offline: {
            base: { dev: baseDev, heldout: baseHeldout },
            candidate: { dev: candidateDev, heldout: candidateHeldout },
            dropped,
          },
          thresholds,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    process.stdout.write(`\nartifact ${path.relative(root, artifactFile)}\n`);
    const failed = thresholds.filter((threshold) => !threshold.pass);
    if (failed.length === 0 || reportOnly) return 0;
    process.stderr.write(
      `TN_CAPABILITY_SEARCH_AB: ${failed.map((threshold) => threshold.name).join(", ")} below target\n`,
    );
    return 1;
  } finally {
    await rm(workdir, { force: true, recursive: true });
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
