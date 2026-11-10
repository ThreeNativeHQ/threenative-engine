import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { PLAYTEST_ASSERTION_REGISTRY } from "../assertion-schema.js";
import type { IPlaytestPerformanceAssertion, IPlaytestScenario } from "../scenario.js";
import { validatePerformanceAssertion } from "../scenario/schema-accessors.js";
import type { IStandalonePlaytestConfig } from "./config.js";
import { PlaytestCliUsageError } from "./config.js";

/**
 * The report `<artifact>.build-report.json` that `threenative build` publishes beside an artifact.
 *
 * A profile's `performanceBudget` rides in it, so the ceilings a build was declared against travel
 * with the bytes they were declared for, and `--build-report` can refuse a run whose artifact is
 * not the one the budget was measured on. The closed shape is read, never trusted: an unknown key
 * or a wrong type stops the run rather than narrowing it.
 */
export interface IBuildReport {
  readonly artifact: {
    readonly kind: "directory" | "file";
    readonly name: string;
    readonly sha256: string;
  };
  readonly measured?: unknown;
  readonly manifestSha256?: unknown;
  readonly performanceBudget?: unknown;
  readonly profile: string | null;
  readonly schemaVersion: 1;
  readonly target: string;
}

const REPORT_KEYS: readonly string[] = [
  "artifact",
  "measured",
  "manifestSha256",
  "performanceBudget",
  "profile",
  "schemaVersion",
  "target",
];

/** A report target is a build target; the browser lane is the one that runs the `web` build. */
const REPORT_TARGETS: readonly string[] = ["android", "desktop", "ios", "web"];

function invalid(reportPath: string, detail: string): Error {
  return new Error(`TN_PLAYTEST_BUILD_REPORT_INVALID: ${reportPath}: ${detail}`);
}

/**
 * The scenario validator's own verdict, minus its "Playtest scenario '…' is invalid" opener.
 *
 * Reusing that validator is what keeps a budget key the harness would not evaluate from reaching a
 * run, and its message names the offender precisely. The opener does not: it would call the build
 * report a playtest scenario, and this message already says which file it is about.
 */
function harnessDetail(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Playtest scenario '.*' is invalid: /su, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireKeys(
  value: unknown,
  label: string,
  keys: readonly string[],
  reportPath: string,
): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(reportPath, `${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) throw invalid(reportPath, `${label}.${key} is not recognised.`);
  }
  return value;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under `target`, as `/`-joined relative paths in a stable order. */
async function listFiles(target: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(target, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listFiles(path.join(target, entry.name), relative)));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}

/**
 * Content identity for the artifact under test, byte for byte what `threenative build` computed.
 *
 * The two packages share no dependency by design, so the algorithm is written twice and pinned
 * once: `create-threenative/__tests__/build-report.spec.ts` hashes the same fixture to the same
 * digest, which is what makes these one rule rather than two that happen to agree today.
 */
export async function hashArtifact(
  target: string,
): Promise<{ kind: "directory" | "file"; name: string; sha256: string }> {
  const name = path.basename(target);
  if (!(await stat(target)).isDirectory()) {
    return { kind: "file", name, sha256: sha256(await readFile(target)) };
  }
  const lines: string[] = [];
  for (const file of await listFiles(target)) {
    lines.push(`${file} ${sha256(await readFile(path.join(target, file)))}`);
  }
  return { kind: "directory", name, sha256: sha256(Buffer.from(lines.join("\n"), "utf8")) };
}

/** The path this run measures: the target's own flag when it has one, `--artifact` otherwise. */
function artifactUnderTest(config: IStandalonePlaytestConfig): string {
  const target = config.target ?? "browser";
  const own = target === "desktop"
    ? config.desktop?.executable
    : target === "ios"
      ? config.ios?.appPath
      : undefined;
  if (own !== undefined) {
    if (config.artifactPath !== undefined) {
      throw new PlaytestCliUsageError(
        `The ${target} target already names the artifact under test; drop --artifact or the target's own flag.`,
      );
    }
    return own;
  }
  if (config.artifactPath === undefined) {
    throw new PlaytestCliUsageError(
      `The ${target} target does not say which artifact it is about to run; pass --artifact <path> beside --build-report.`,
    );
  }
  return config.artifactPath;
}

async function readReport(reportPath: string): Promise<IBuildReport> {
  let raw: string;
  try {
    raw = await readFile(reportPath, "utf8");
  } catch (error) {
    throw invalid(reportPath, `could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw invalid(reportPath, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const report = requireKeys(parsed, "report", REPORT_KEYS, reportPath) as Partial<IBuildReport> as IBuildReport;
  // A build always writes `performanceBudget`, `null` when no profile declared one, so a report
  // *missing* the key is not a profile without ceilings — it is a report whose ceilings were
  // removed, and a run that adopted it would pass on a bound nothing evaluates any more.
  if (!("performanceBudget" in report)) {
    throw invalid(
      reportPath,
      "report.performanceBudget is missing; a build always writes it, null when no profile declares one.",
    );
  }
  if (report.schemaVersion !== 1) {
    throw invalid(reportPath, `schemaVersion must be 1, received ${JSON.stringify(report.schemaVersion)}.`);
  }
  if (typeof report.target !== "string" || !REPORT_TARGETS.includes(report.target)) {
    throw invalid(reportPath, `target must be one of ${REPORT_TARGETS.join(", ")}.`);
  }
  if (report.profile !== null && typeof report.profile !== "string") {
    throw invalid(reportPath, "profile must be a profile name or null.");
  }
  const artifact = requireKeys(report.artifact, "report.artifact", ["kind", "name", "sha256"], reportPath);
  if (artifact.kind !== "directory" && artifact.kind !== "file") {
    throw invalid(reportPath, "report.artifact.kind must be 'directory' or 'file'.");
  }
  if (typeof artifact.name !== "string" || artifact.name.length === 0) {
    throw invalid(reportPath, "report.artifact.name must be a non-empty basename.");
  }
  if (typeof artifact.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(artifact.sha256)) {
    throw invalid(reportPath, "report.artifact.sha256 must be a sha256 hex digest.");
  }
  const measured = requireKeys(report.measured, "report.measured", ["artifactBytes", "packagedAssetBytes"], reportPath);
  for (const key of ["artifactBytes", "packagedAssetBytes"]) {
    if (typeof measured[key] !== "number" || !Number.isFinite(measured[key] as number)) {
      throw invalid(reportPath, `report.measured.${key} must be a number.`);
    }
  }
  if (report.manifestSha256 !== null && typeof report.manifestSha256 !== "string") {
    throw invalid(reportPath, "report.manifestSha256 must be a sha256 hex digest or null.");
  }
  if (report.performanceBudget !== null && report.performanceBudget !== undefined) {
    // The harness's own validator, so a budget key nothing could evaluate is refused here rather
    // than merged into a run that would never look at it.
    try {
      validatePerformanceAssertion(report.performanceBudget, reportPath, "performanceBudget");
    } catch (error) {
      throw invalid(reportPath, harnessDetail(error));
    }
  }
  return report;
}

/**
 * A report's target must be the artifact this run is about to launch.
 *
 * A web budget proved against a web build says nothing about the APK beside it, and a desktop one
 * says nothing about a browser, so the two are refused before a frame is drawn rather than
 * evaluated against a series that happened to arrive.
 */
function assertTargetMatches(report: IBuildReport, reportPath: string, target: string): void {
  const runTarget = target === "browser" ? "web" : target;
  if (report.target === runTarget) return;
  throw invalid(
    reportPath,
    `was built for '${report.target}' but this run's target is '${runTarget}'. A budget measured on one artifact cannot bound another.`,
  );
}

/**
 * Merge a profile's budget into one scenario's performance assertion, per key.
 *
 * The scenario's own value wins where it declares one — a scenario is the more specific statement
 * about its own run — and the budget fills the rest, including creating the assertion on a scenario
 * that had none: a budget nobody bounds is not a budget.
 */
export function withPerformanceBudget(
  scenario: IPlaytestScenario,
  budget: IPlaytestPerformanceAssertion | undefined,
): IPlaytestScenario {
  if (budget === undefined) return scenario;
  const declared = scenario.assert?.performance;
  // The three per-key maps merge key by key too: a scenario bounding one pass is not a statement
  // about the other three.
  const maps = {
    maxPassDrawCalls: { ...budget.maxPassDrawCalls, ...declared?.maxPassDrawCalls },
    maxPassTriangles: { ...budget.maxPassTriangles, ...declared?.maxPassTriangles },
    maxPhaseMsP95: { ...budget.maxPhaseMsP95, ...declared?.maxPhaseMsP95 },
  };
  const performance: IPlaytestPerformanceAssertion = {
    ...budget,
    ...declared,
    ...Object.fromEntries(Object.entries(maps).filter(([, value]) => Object.keys(value).length > 0)),
  };
  return { ...scenario, assert: { ...scenario.assert, performance } };
}

/**
 * Read, prove and adopt a build report, before anything launches.
 *
 * Every way this can be wrong is exit 2 — the run never reached assertions: a report that is
 * malformed, a report for another target, a report whose artifact is not the bytes under test, and
 * a budget the target cannot observe. None of them is an assertion failure, because in none of them
 * did the game get a chance to be measured.
 */
export async function resolveBuildReport(
  config: IStandalonePlaytestConfig,
): Promise<IStandalonePlaytestConfig> {
  if (config.buildReportPath === undefined) return config;
  const reportPath = config.buildReportPath;
  const report = await readReport(reportPath);
  assertTargetMatches(report, reportPath, config.target ?? "browser");
  const artifact = artifactUnderTest(config);
  let measured: { kind: "directory" | "file"; name: string; sha256: string };
  try {
    measured = await hashArtifact(artifact);
  } catch (error) {
    throw invalid(
      reportPath,
      `names artifact '${report.artifact.name}', which could not be hashed at ${artifact}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (measured.sha256 !== report.artifact.sha256 || measured.kind !== report.artifact.kind) {
    throw new Error(
      `TN_PLAYTEST_BUILD_REPORT_STALE: ${reportPath} describes artifact '${report.artifact.name}' with sha256 ${report.artifact.sha256} (${report.artifact.kind}), but ${artifact} now hashes to ${measured.sha256} (${measured.kind}). Rebuild, or point --build-report at the build you are running.`,
    );
  }
  const budget = report.performanceBudget === null || report.performanceBudget === undefined
    ? undefined
    : validatePerformanceAssertion(report.performanceBudget, reportPath, "performanceBudget");
  assertPerformanceObservable(budget, config.target ?? "browser", reportPath);
  return { ...config, performanceBudget: budget };
}

/**
 * Refuse a budget the run's target cannot measure, naming the targets that can.
 *
 * A dropped budget is a ceiling nobody checks; an evaluated one on a target with no frame series is
 * a failure that looks like the game's. The registry's own `supportedOn` for `performance` is the
 * answer, read from the same place every other assertion reads it from.
 */
function assertPerformanceObservable(
  budget: IPlaytestPerformanceAssertion | undefined,
  target: string,
  reportPath: string,
): void {
  if (budget === undefined) return;
  const entry = PLAYTEST_ASSERTION_REGISTRY.find(({ kind }) => kind === "performance");
  const supported = entry?.supportedOn ?? [];
  if (supported.includes(target as (typeof supported)[number])) return;
  throw invalid(
    reportPath,
    `declares a performanceBudget, which the '${target}' target cannot observe. Bounds on frames are measured on: ${supported.join(", ")}.`,
  );
}
