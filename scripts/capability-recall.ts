import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ICapabilitySearchResult,
  defaultManifestPath,
  loadCapabilityManifest,
  searchCapabilities,
} from "../packages/engine-mcp/src/index.js";

export type CapabilityRecallScope = "request" | "mechanic";

export interface ICapabilityRecallRow {
  readonly id: string;
  readonly query: string;
  readonly scope: CapabilityRecallScope;
  readonly source: string;
  readonly expect: readonly string[];
  readonly reject: readonly string[];
  readonly notOwned?: string;
}
export interface ICapabilityRecallCorpus {
  readonly version: 1;
  readonly rows: readonly ICapabilityRecallRow[];
}

export interface ICapabilityRecallBudget {
  readonly version: 1;
  readonly zeroResultRate: number;
  readonly unresolvedResultRate: number;
  readonly recallAtK: number;
  readonly rejectHits: number;
  readonly rowCount: number;
  readonly rowIds: readonly string[];
  readonly recalledRows: readonly string[];
  readonly notOwnedRows: Readonly<Record<string, string>>;
}

export interface IRecallRowResult {
  readonly id: string;
  readonly query: string;
  readonly scope: CapabilityRecallScope;
  readonly source: string;
  readonly returned: readonly string[];
  readonly expected: readonly string[];
  readonly rejected: readonly string[];
  readonly notOwned?: string;
  readonly guided: boolean;
  readonly zeroResult: boolean;
  readonly unresolvedResult: boolean;
  readonly recalled: boolean;
  readonly rejectHit: boolean;
}

export interface IRecallMetrics {
  readonly rowCount: number;
  readonly zeroResults: number;
  readonly zeroResultRate: number;
  readonly unresolvedResults: number;
  readonly unresolvedResultRate: number;
  readonly guided: number;
  readonly actionable: number;
  readonly recalled: number;
  readonly recallAtK: number;
  readonly rejectHits: number;
}

export interface IRecallMeasurement {
  readonly metrics: IRecallMetrics;
  readonly rows: readonly IRecallRowResult[];
}

export interface IRecallRegression {
  readonly metric:
    | "zeroResultRate"
    | "unresolvedResultRate"
    | "recallAtK"
    | "rejectHits"
    | "rowCount"
    | "rowIds"
    | "recalledRows"
    | "notOwnedRows";
  readonly message: string;
  readonly rowIds: readonly string[];
}

export interface IRecallReport extends IRecallMeasurement {
  readonly budget: ICapabilityRecallBudget;
  readonly regressions: readonly IRecallRegression[];
}

export interface IHarvestCandidate {
  readonly query: string;
  readonly source: string;
  readonly scope: CapabilityRecallScope;
}

export interface ICapabilitySearchResponse {
  readonly verdict: "matched" | "none";
  readonly results: readonly ICapabilitySearchResult[];
  readonly guidance: string;
}

export type CapabilitySearcher = (
  query: string,
  manifestFile: string,
  scope: CapabilityRecallScope,
) => readonly ICapabilitySearchResult[] | ICapabilitySearchResponse;

export class CapabilityRecallError extends Error {
  constructor(message: string) {
    super(`TN_CAPABILITY_RECALL: ${message}`);
    this.name = "CapabilityRecallError";
  }
}

const CORPUS_RELATIVE_PATH = path.join("scripts", "fixtures", "capability-recall", "corpus.json");
const BUDGET_RELATIVE_PATH = path.join("scripts", "fixtures", "capability-recall", "budget.json");
const MANIFEST_RELATIVE_PATH = path.join("packages", "create-threenative", "capabilities.json");
const TEMPLATE_NAMES = [
  "action-rpg",
  "minimal",
  "platformer",
  "racing",
  "rain",
  "sailing",
  "shooter",
  "snow",
  "starter",
  "tower-defense",
] as const;
const BRIEF_NAMES = [
  "endless-runner",
  "exploration",
  "fps",
  "open-world",
  "physics-puzzle",
  "platformer",
  "topdown-action",
] as const;
const SOURCE_PATTERN = /^(brief|sandbox|template):([a-z0-9-]+)#(.+)$/u;
const HEADING_PATTERN = /^\s{0,3}#{1,6}\s+(.+?)\s*#?\s*$/u;

function recallError(message: string): CapabilityRecallError {
  return new CapabilityRecallError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw recallError(`${label} must be a non-empty string`);
  }
  return value;
}

function validateCorpusRow(raw: unknown, index: number, file: string): ICapabilityRecallRow {
  if (!isRecord(raw)) throw recallError(`${file}: row ${index} is malformed`);
  const id = requireNonEmptyString(raw.id, `${file}: row ${index}.id`);
  const query = requireNonEmptyString(raw.query, `${file}: row ${index}.query`);
  const source = requireNonEmptyString(raw.source, `${file}: row ${index}.source`);
  if (raw.scope !== "request" && raw.scope !== "mechanic") {
    throw recallError(`${file}: row ${index}.scope must be request or mechanic`);
  }
  const expected = raw.expect;
  const rejected = raw.reject;
  if (!strings(expected) || expected.length === 0) {
    throw recallError(`${file}: row ${index}.expect must contain at least one symbol`);
  }
  if (!strings(rejected)) {
    throw recallError(`${file}: row ${index}.reject must be a string array`);
  }
  if (new Set(expected).size !== expected.length) {
    throw recallError(`${file}: row ${index}.expect contains duplicate symbols`);
  }
  if (new Set(rejected).size !== rejected.length) {
    throw recallError(`${file}: row ${index}.reject contains duplicate symbols`);
  }
  if (expected.some((symbol) => rejected.includes(symbol))) {
    throw recallError(`${file}: row ${index} cannot expect and reject the same symbol`);
  }
  const notOwned =
    raw.notOwned === undefined
      ? undefined
      : requireNonEmptyString(raw.notOwned, `${file}: row ${index}.notOwned`);
  return {
    expect: [...expected],
    id,
    ...(notOwned === undefined ? {} : { notOwned }),
    query: query.trim(),
    reject: [...rejected],
    scope: raw.scope,
    source: source.trim(),
  };
}

export function validateCorpus(value: unknown, file = "corpus.json"): ICapabilityRecallCorpus {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.rows)) {
    throw recallError(`${file}: root must contain version 1 and a rows array`);
  }

  const ids = new Set<string>();
  const rows = value.rows.map((raw, index) => {
    const row = validateCorpusRow(raw, index, file);
    if (ids.has(row.id)) throw recallError(`${file}: duplicate row id '${row.id}'`);
    ids.add(row.id);
    return row;
  });

  if (rows.length === 0) throw recallError(`${file}: corpus has no rows`);
  return { rows, version: 1 };
}

function validateBudgetRowIds(value: unknown, rowCount: number, file: string): readonly string[] {
  if (!strings(value) || value.some((id) => id.trim().length === 0)) {
    throw recallError(`${file}: rowIds must be an array of non-empty row ids`);
  }
  if (new Set(value).size !== value.length) {
    throw recallError(`${file}: rowIds contains duplicate row ids`);
  }
  if (value.length !== rowCount) {
    throw recallError(`${file}: rowIds length must equal rowCount`);
  }
  return [...value];
}

function validateNotOwnedRows(value: unknown, file: string): Readonly<Record<string, string>> {
  if (!isRecord(value)) {
    throw recallError(`${file}: notOwnedRows must be an object of corpus row ids to manifest ids`);
  }
  const rows: Record<string, string> = {};
  for (const [rowId, notOwnedId] of Object.entries(value)) {
    if (
      rowId.trim().length === 0 ||
      typeof notOwnedId !== "string" ||
      notOwnedId.trim().length === 0
    ) {
      throw recallError(
        `${file}: notOwnedRows must map non-empty row ids to non-empty manifest ids`,
      );
    }
    rows[rowId] = notOwnedId;
  }
  return rows;
}

function notOwnedRowMap(
  rows: readonly Pick<IRecallRowResult, "id" | "notOwned">[],
): Readonly<Record<string, string>> {
  return rows.reduce<Record<string, string>>((mapped, row) => {
    if (row.notOwned !== undefined) mapped[row.id] = row.notOwned;
    return mapped;
  }, {});
}

export function validateBudget(value: unknown, file = "budget.json"): ICapabilityRecallBudget {
  if (!isRecord(value) || value.version !== 1) {
    throw recallError(`${file}: root must contain version 1`);
  }
  const zeroResultRate = value.zeroResultRate;
  const recallAtK = value.recallAtK;
  if (
    typeof zeroResultRate !== "number" ||
    !Number.isFinite(zeroResultRate) ||
    zeroResultRate < 0 ||
    zeroResultRate > 1
  ) {
    throw recallError(`${file}: zeroResultRate must be a finite number between 0 and 1`);
  }
  const unresolvedResultRate = value.unresolvedResultRate;
  if (
    typeof unresolvedResultRate !== "number" ||
    !Number.isFinite(unresolvedResultRate) ||
    unresolvedResultRate < 0 ||
    unresolvedResultRate > 1
  ) {
    throw recallError(`${file}: unresolvedResultRate must be a finite number between 0 and 1`);
  }
  if (
    typeof recallAtK !== "number" ||
    !Number.isFinite(recallAtK) ||
    recallAtK < 0 ||
    recallAtK > 1
  ) {
    throw recallError(`${file}: recallAtK must be a finite number between 0 and 1`);
  }
  const rejectHits = value.rejectHits;
  if (typeof rejectHits !== "number" || !Number.isInteger(rejectHits) || rejectHits < 0) {
    throw recallError(`${file}: rejectHits must be a non-negative integer`);
  }
  const rowCount = value.rowCount;
  if (typeof rowCount !== "number" || !Number.isInteger(rowCount) || rowCount < 1) {
    throw recallError(`${file}: rowCount must be a positive integer`);
  }
  const recalledRows = value.recalledRows;
  if (!strings(recalledRows) || recalledRows.some((id) => id.trim().length === 0)) {
    throw recallError(`${file}: recalledRows must be an array of non-empty row ids`);
  }
  if (new Set(recalledRows).size !== recalledRows.length) {
    throw recallError(`${file}: recalledRows contains duplicate row ids`);
  }
  const rowIds = validateBudgetRowIds(value.rowIds, rowCount, file);
  const notOwnedRows = validateNotOwnedRows(value.notOwnedRows, file);
  return {
    recallAtK,
    recalledRows: [...recalledRows],
    rejectHits,
    rowCount,
    rowIds: [...rowIds],
    version: 1,
    zeroResultRate,
    unresolvedResultRate,
    notOwnedRows,
  };
}

async function readJson(file: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    throw recallError(`${file}: cannot read file: ${String(error)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw recallError(`${file}: cannot parse JSON: ${String(error)}`);
  }
}

export async function loadCorpus(file = defaultCorpusPath()): Promise<ICapabilityRecallCorpus> {
  return validateCorpus(await readJson(file), file);
}

export async function loadBudget(file = defaultBudgetPath()): Promise<ICapabilityRecallBudget> {
  return validateBudget(await readJson(file), file);
}

export function defaultCorpusPath(root = process.cwd()): string {
  return path.resolve(root, CORPUS_RELATIVE_PATH);
}

export function defaultBudgetPath(root = process.cwd()): string {
  return path.resolve(root, BUDGET_RELATIVE_PATH);
}

export function recallManifestPath(root = process.cwd()): string {
  return process.env.THREENATIVE_CAPABILITIES_MANIFEST === undefined
    ? path.resolve(root, MANIFEST_RELATIVE_PATH)
    : defaultManifestPath(root);
}

function briefFile(root: string, genre: string): string {
  if (!BRIEF_NAMES.includes(genre as (typeof BRIEF_NAMES)[number])) {
    throw recallError(`unknown brief genre '${genre}'`);
  }
  return path.resolve(root, "docs", "benchmark", "genres", genre, "brief.md");
}

function templateFile(root: string, template: string): string {
  if (!TEMPLATE_NAMES.includes(template as (typeof TEMPLATE_NAMES)[number])) {
    throw recallError(`unknown template '${template}'`);
  }
  return path.resolve(root, "packages", "create-threenative", "templates", template, "AGENTS.md");
}

function briefBullets(text: string): readonly { readonly index: number; readonly text: string }[] {
  const bullets: { index: number; text: string }[] = [];
  let parts: string[] | undefined;
  const finishBullet = () => {
    if (parts === undefined) return;
    bullets.push({ index: bullets.length + 1, text: parts.join(" ") });
    parts = undefined;
  };

  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("- ")) {
      finishBullet();
      parts = [line.slice(2).trim()];
    } else if (parts !== undefined && /^\s{2,}\S/u.test(line)) {
      parts.push(line.trim());
    } else {
      finishBullet();
    }
  }
  finishBullet();
  return bullets;
}

function parseSource(source: string): {
  readonly kind: "brief" | "sandbox" | "template";
  readonly name: string;
  readonly key: string;
} {
  const match = SOURCE_PATTERN.exec(source);
  if (
    match === null ||
    (match[1] !== "brief" && match[1] !== "sandbox" && match[1] !== "template")
  ) {
    throw recallError(
      `source '${source}' must be brief:<genre>#<bullet-index>, sandbox:<game>#<file> or template:<name>#<heading>`,
    );
  }
  const kind = match[1];
  const name = match[2];
  const key = match[3];
  if (kind === undefined || name === undefined || key === undefined) {
    throw recallError(`source '${source}' is incomplete`);
  }
  return { key, kind, name };
}

async function resolveSource(row: ICapabilityRecallRow, root: string): Promise<void> {
  const parsed = parseSource(row.source);
  // A sandbox pointer is provenance only. The games live outside this repository and are not
  // tracked, so there is no in-repo file for the source check to open; a brief bullet and a
  // template heading keep the exact-match guarantee because both are checked in.
  if (parsed.kind === "sandbox") return;
  const file =
    parsed.kind === "brief" ? briefFile(root, parsed.name) : templateFile(root, parsed.name);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    throw recallError(`${row.id}: source '${row.source}' cannot be read: ${String(error)}`);
  }

  if (parsed.kind === "brief") {
    const index = Number(parsed.key);
    const bullet = briefBullets(text).find((candidate) => candidate.index === index);
    if (!Number.isInteger(index) || index < 1 || bullet === undefined) {
      throw recallError(`${row.id}: source '${row.source}' no longer resolves`);
    }
    if (bullet.text !== row.query) {
      throw recallError(`${row.id}: source '${row.source}' no longer matches its query`);
    }
    return;
  }

  const headingExists = text
    .split(/\r?\n/u)
    .some((line) => HEADING_PATTERN.exec(line)?.[1]?.trim() === parsed.key);
  if (!headingExists) throw recallError(`${row.id}: source '${row.source}' no longer resolves`);
}

export async function resolveCorpusSources(
  rows: readonly ICapabilityRecallRow[],
  root = process.cwd(),
): Promise<void> {
  for (const row of rows) await resolveSource(row, root);
}

function validateManifestExpectations(
  rows: readonly ICapabilityRecallRow[],
  manifestFile: string,
): {
  readonly notOwned: ReadonlyMap<string, string>;
  readonly symbols: ReadonlySet<string>;
} {
  let manifest: ReturnType<typeof loadCapabilityManifest>;
  try {
    manifest = loadCapabilityManifest(manifestFile);
  } catch (error) {
    throw recallError(`manifest cannot be loaded: ${String(error)}`);
  }
  const symbols = new Set(manifest.entries.map((entry) => entry.symbol));
  const notOwned = new Map(manifest.notOwned.map((entry) => [entry.id, entry.guidance] as const));
  for (const row of rows) {
    for (const symbol of [...row.expect, ...row.reject]) {
      if (!symbols.has(symbol)) {
        throw recallError(`${row.id}: symbol '${symbol}' is absent from manifest ${manifestFile}`);
      }
    }
    if (row.notOwned !== undefined && !notOwned.has(row.notOwned)) {
      throw recallError(
        `${row.id}: notOwned id '${row.notOwned}' is absent from manifest ${manifestFile}`,
      );
    }
  }
  return { notOwned, symbols };
}

function checkedSymbols(
  results: readonly ICapabilitySearchResult[],
  row: ICapabilityRecallRow,
): readonly string[] {
  const symbols = results.map((result) => result.symbol);
  if (symbols.some((symbol) => typeof symbol !== "string" || symbol.trim().length === 0)) {
    throw recallError(`${row.id}: search returned a result without a symbol`);
  }
  return symbols;
}

function responseResults(
  response: readonly ICapabilitySearchResult[] | ICapabilitySearchResponse,
  row: ICapabilityRecallRow,
  expectedGuidance: string | undefined,
): { readonly guided: boolean; readonly results: readonly ICapabilitySearchResult[] } {
  if (!isCapabilitySearchResponse(response)) {
    if (expectedGuidance !== undefined) {
      throw recallError(`${row.id}: expected a verified not-owned response envelope`);
    }
    return { guided: false, results: response };
  }
  if (response.verdict !== "matched" && response.verdict !== "none") {
    throw recallError(`${row.id}: search returned an invalid verdict`);
  }
  if (typeof response.guidance !== "string" || !Array.isArray(response.results)) {
    throw recallError(`${row.id}: search returned a malformed response envelope`);
  }
  if (
    response.verdict === "matched" &&
    (response.results.length === 0 || response.guidance !== "")
  ) {
    throw recallError(`${row.id}: matched search response must contain results and no guidance`);
  }
  if (response.verdict === "none" && response.results.length > 0) {
    throw recallError(`${row.id}: none search response must not contain results`);
  }
  const guided =
    expectedGuidance !== undefined &&
    response.verdict === "none" &&
    response.guidance === expectedGuidance;
  if (expectedGuidance !== undefined && !guided) {
    throw recallError(`${row.id}: not-owned response guidance does not match its manifest entry`);
  }
  return { guided, results: response.results };
}

function isCapabilitySearchResponse(
  response: readonly ICapabilitySearchResult[] | ICapabilitySearchResponse,
): response is ICapabilitySearchResponse {
  return !Array.isArray(response);
}

export function measureRecall(
  rows: readonly ICapabilityRecallRow[],
  manifestFile: string,
  searcher: CapabilitySearcher = searchCapabilities,
): IRecallMeasurement {
  const manifestExpectations = validateManifestExpectations(rows, manifestFile);
  const rowResults = rows.map((row): IRecallRowResult => {
    let results: readonly ICapabilitySearchResult[] | ICapabilitySearchResponse;
    try {
      results = searcher(row.query, manifestFile, row.scope);
    } catch (error) {
      throw recallError(`${row.id}: search failed: ${String(error)}`);
    }
    const checked = responseResults(
      results,
      row,
      row.notOwned === undefined ? undefined : manifestExpectations.notOwned.get(row.notOwned),
    );
    const returned = checkedSymbols(checked.results, row);
    const expected = row.expect.filter((symbol) => returned.includes(symbol));
    const rejected = row.reject.filter((symbol) => returned.includes(symbol));
    return {
      expected,
      guided: checked.guided,
      id: row.id,
      ...(row.notOwned === undefined ? {} : { notOwned: row.notOwned }),
      query: row.query,
      recalled: expected.length > 0,
      rejected,
      rejectHit: rejected.length > 0,
      returned,
      scope: row.scope,
      source: row.source,
      unresolvedResult: returned.length === 0 && !checked.guided,
      zeroResult: returned.length === 0,
    };
  });
  const rowCount = rowResults.length;
  if (rowCount === 0) throw recallError("cannot score an empty corpus");
  const zeroResults = rowResults.filter((row) => row.zeroResult).length;
  const unresolvedResults = rowResults.filter((row) => row.unresolvedResult).length;
  const guided = rowResults.filter((row) => row.guided).length;
  const recalled = rowResults.filter((row) => row.recalled).length;
  const rejectHits = rowResults.filter((row) => row.rejectHit).length;
  return {
    metrics: {
      recallAtK: recalled / rowCount,
      recalled,
      rejectHits,
      rowCount,
      zeroResultRate: zeroResults / rowCount,
      zeroResults,
      unresolvedResultRate: unresolvedResults / rowCount,
      unresolvedResults,
      guided,
      actionable: guided + recalled,
    },
    rows: rowResults,
  };
}

function rowIds(
  rows: readonly IRecallRowResult[],
  predicate: (row: IRecallRowResult) => boolean,
): readonly string[] {
  return rows.filter(predicate).map((row) => row.id);
}

function pinnedNotOwnedRegression(
  measurement: IRecallMeasurement,
  budget: ICapabilityRecallBudget,
): IRecallRegression | undefined {
  const currentNotOwnedRows = new Map(Object.entries(notOwnedRowMap(measurement.rows)));
  const expectedNotOwnedRows = new Map(Object.entries(budget.notOwnedRows));
  const changedNotOwnedRows = [
    ...expectedNotOwnedRows.keys(),
    ...currentNotOwnedRows.keys(),
  ].filter(
    (id, index, ids) =>
      ids.indexOf(id) === index && expectedNotOwnedRows.get(id) !== currentNotOwnedRows.get(id),
  );
  if (changedNotOwnedRows.length === 0) return undefined;
  return {
    message: `pinned notOwned rows changed; expected ${[...expectedNotOwnedRows.entries()].map(([id, value]) => `${id}=${value}`).join(", ") || "(none)"}; current ${[...currentNotOwnedRows.entries()].map(([id, value]) => `${id}=${value}`).join(", ") || "(none)"}`,
    metric: "notOwnedRows",
    rowIds: changedNotOwnedRows,
  };
}

export function compareBudget(
  measurement: IRecallMeasurement,
  budget: ICapabilityRecallBudget,
): readonly IRecallRegression[] {
  const { metrics } = measurement;
  const regressions: IRecallRegression[] = [];
  if (metrics.unresolvedResultRate > budget.unresolvedResultRate + Number.EPSILON) {
    regressions.push({
      message: `unresolvedResultRate ${metrics.unresolvedResultRate.toFixed(6)} exceeds floor ${budget.unresolvedResultRate.toFixed(6)}`,
      metric: "unresolvedResultRate",
      rowIds: rowIds(measurement.rows, (row) => row.unresolvedResult),
    });
  }
  if (metrics.recallAtK + Number.EPSILON < budget.recallAtK) {
    regressions.push({
      message: `recallAtK ${metrics.recallAtK.toFixed(6)} is below floor ${budget.recallAtK.toFixed(6)}`,
      metric: "recallAtK",
      rowIds: rowIds(measurement.rows, (row) => !row.recalled),
    });
  }
  if (metrics.rejectHits > budget.rejectHits) {
    regressions.push({
      message: `rejectHits ${metrics.rejectHits} exceeds floor ${budget.rejectHits}`,
      metric: "rejectHits",
      rowIds: rowIds(measurement.rows, (row) => row.rejectHit),
    });
  }
  const notOwnedRegression = pinnedNotOwnedRegression(measurement, budget);
  if (notOwnedRegression !== undefined) regressions.push(notOwnedRegression);
  if (metrics.rowCount < budget.rowCount) {
    regressions.push({
      message: `rowCount ${metrics.rowCount} is below floor ${budget.rowCount}`,
      metric: "rowCount",
      rowIds: ["corpus"],
    });
  }
  const baselineIds = new Set(budget.rowIds);
  const currentIds = new Set(measurement.rows.map((row) => row.id));
  const missingIds = budget.rowIds.filter((id) => !currentIds.has(id));
  const addedIds = measurement.rows.filter((row) => !baselineIds.has(row.id)).map((row) => row.id);
  if (missingIds.length > 0 || addedIds.length > 0) {
    regressions.push({
      message: `corpus row ids changed; missing ${missingIds.join(", ") || "(none)"}; added ${addedIds.join(", ") || "(none)"}`,
      metric: "rowIds",
      rowIds: [...missingIds, ...addedIds],
    });
  }
  const recalledById = new Map(measurement.rows.map((row) => [row.id, row.recalled]));
  const regressedRows = budget.recalledRows.filter((id) => recalledById.get(id) !== true);
  if (regressedRows.length > 0) {
    regressions.push({
      message: `${regressedRows.length} previously recalled ${regressedRows.length === 1 ? "row" : "rows"} no longer ${regressedRows.length === 1 ? "reaches" : "reach"} an expected symbol`,
      metric: "recalledRows",
      rowIds: regressedRows,
    });
  }
  return regressions;
}

export function formatRecallReport(report: IRecallReport): string {
  const lines = [
    `Capability recall (${report.metrics.rowCount} rows)`,
    "id | scope | results | recalled | reject | returned",
    ...report.rows.map(
      (row) =>
        `${row.id} | ${row.scope} | ${row.returned.length} | ${row.recalled ? "yes" : "no"} | ${row.rejectHit ? "yes" : "no"} | ${row.returned.join(", ") || "(none)"}`,
    ),
    "",
    `zeroResultRate: ${report.metrics.zeroResultRate.toFixed(6)} (${report.metrics.zeroResults}/${report.metrics.rowCount})`,
    `unresolvedResultRate: ${report.metrics.unresolvedResultRate.toFixed(6)} (${report.metrics.unresolvedResults}/${report.metrics.rowCount})`,
    `actionable: ${report.metrics.actionable}/${report.metrics.rowCount} (${report.metrics.recalled} distinct-symbol, ${report.metrics.guided} guided not-owned)`,
    `recallAtK: ${report.metrics.recallAtK.toFixed(6)} (${report.metrics.recalled}/${report.metrics.rowCount})`,
    `rejectHits: ${report.metrics.rejectHits}`,
    `rowCount: ${report.metrics.rowCount}`,
  ];
  const misses = report.rows.filter((row) => !row.recalled);
  lines.push("", `Misses (${misses.length})`);
  lines.push(...misses.map((row) => `- ${row.id}: ${row.query}`));
  if (report.regressions.length > 0) {
    lines.push("", "Regressions");
    for (const regression of report.regressions) {
      lines.push(`- ${regression.metric}: ${regression.message}`);
      lines.push(`  rows: ${regression.rowIds.join(", ") || "(none)"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function sourceHeadingCandidates(text: string): readonly string[] {
  return text
    .split(/\r?\n/u)
    .map((line) => HEADING_PATTERN.exec(line)?.[1]?.trim())
    .filter((heading): heading is string => heading !== undefined && heading.length > 0);
}

export async function harvestCandidates(
  root = process.cwd(),
): Promise<readonly IHarvestCandidate[]> {
  const candidates: IHarvestCandidate[] = [];
  for (const genre of BRIEF_NAMES) {
    const file = briefFile(root, genre);
    const text = await readFile(file, "utf8");
    for (const bullet of briefBullets(text)) {
      if (bullet.text.includes("sealed proof")) continue;
      candidates.push({
        query: bullet.text,
        scope: "mechanic",
        source: `brief:${genre}#${bullet.index}`,
      });
    }
  }
  for (const template of TEMPLATE_NAMES) {
    const text = await readFile(templateFile(root, template), "utf8");
    for (const heading of sourceHeadingCandidates(text)) {
      candidates.push({
        query: heading,
        scope: "mechanic",
        source: `template:${template}#${heading}`,
      });
    }
  }
  return candidates;
}

export function formatHarvest(candidates: readonly IHarvestCandidate[]): string {
  return [
    `Harvest candidates (${candidates.length})`,
    ...candidates.map((candidate) => `${candidate.source} [${candidate.scope}] ${candidate.query}`),
    "",
    "Harvest only prints candidates; it never edits corpus.json or invents expect/reject sets.",
    "",
  ].join("\n");
}

async function writeBudget(file: string, measurement: IRecallMeasurement): Promise<void> {
  const { metrics } = measurement;
  await writeFile(
    file,
    `${JSON.stringify(
      {
        recallAtK: metrics.recallAtK,
        recalledRows: rowIds(measurement.rows, (row) => row.recalled),
        rejectHits: metrics.rejectHits,
        rowCount: metrics.rowCount,
        rowIds: measurement.rows.map((row) => row.id),
        version: 1,
        zeroResultRate: metrics.zeroResultRate,
        unresolvedResultRate: metrics.unresolvedResultRate,
        notOwnedRows: notOwnedRowMap(measurement.rows),
      } satisfies ICapabilityRecallBudget,
      null,
      2,
    )}\n`,
    "utf8",
  );
}

export interface IRecallRunOptions {
  readonly root?: string;
  readonly corpusFile?: string;
  readonly budgetFile?: string;
  readonly manifestFile?: string;
  readonly updateBudget?: boolean;
}

export async function runRecall(options: IRecallRunOptions = {}): Promise<IRecallReport> {
  const root = path.resolve(options.root ?? process.cwd());
  const corpus = await loadCorpus(options.corpusFile ?? defaultCorpusPath(root));
  await resolveCorpusSources(corpus.rows, root);
  const manifestFile = options.manifestFile ?? recallManifestPath(root);
  const measurement = measureRecall(corpus.rows, manifestFile);
  const budget = await loadBudget(options.budgetFile ?? defaultBudgetPath(root));
  const regressions = compareBudget(measurement, budget);
  if (options.updateBudget === true) {
    if (regressions.length > 0) {
      throw recallError(
        `cannot update budget while measurements regress: ${regressions.map((item) => item.message).join("; ")}`,
      );
    }
    await writeBudget(options.budgetFile ?? defaultBudgetPath(root), measurement);
  }
  return { ...measurement, budget, regressions };
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

export async function main(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const root = process.cwd();
  try {
    if (hasFlag(args, "--harvest")) {
      const candidates = await harvestCandidates(root);
      const output = hasFlag(args, "--json")
        ? `${JSON.stringify(candidates, null, 2)}\n`
        : formatHarvest(candidates);
      process.stdout.write(output);
      return 0;
    }
    const report = await runRecall({ root, updateBudget: hasFlag(args, "--update-budget") });
    process.stdout.write(
      hasFlag(args, "--json") ? `${JSON.stringify(report, null, 2)}\n` : formatRecallReport(report),
    );
    if (report.regressions.length > 0) return 1;
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && path.resolve(entryPath) === fileURLToPath(import.meta.url)) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
