/** Hosted software regression contract only; never hardware qualification or a visual verdict. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IStandalonePlaytestReport } from "../packages/playtest/src/runner/shared.js";

export const BASELINE_SHA = "88b988cd70d5db7266eb0281e5f74bd0e030b3e7";
const ORDER = ["before", "after", "after", "before", "before", "after"] as const;
const late = ["publishedBatchesInView", "shadowInvalidated", "impostorPendingPeak"].map(
  (key) => `component.props.reveal.${key}`,
);
type StartupReport = Pick<
  IStandalonePlaytestReport,
  "pass" | "capture" | "diagnostics" | "observations" | "assertionResults"
>;
interface IStartupRun {
  arm: "before" | "after";
  status: number | null;
  report: StartupReport;
}

export function verifyStartupRuns(runs: readonly IStartupRun[]) {
  assert.deepEqual(
    runs.map(({ arm }) => arm),
    ORDER,
    "require three alternating pairs",
  );
  const times: { before: number[]; after: number[] } = { before: [], after: [] };
  let adapter: unknown;
  for (const { arm, status, report } of runs) {
    assert(status === 0 || (arm === "before" && status === 1), "subprocess failure");
    assert(
      Array.isArray(report.diagnostics) && report.diagnostics.length === 0,
      "diagnostics must be empty",
    );
    assert(Array.isArray(report.observations?.console), "console observations missing");
    assert(
      report.observations.console.every(
        (entry) =>
          entry.type !== "error" &&
          entry.source !== "page-error" &&
          entry.source !== "unhandled-rejection",
      ),
      "console diagnostics",
    );
    assert(
      typeof report.capture?.adapter?.vendor === "string" &&
        report.capture.adapter.vendor.trim() &&
        typeof report.capture.adapter.architecture === "string" &&
        report.capture.adapter.architecture.trim(),
      "adapter identity missing",
    );
    assert.equal(report.capture.rendererKind, "webgpu");
    assert.deepEqual(report.capture.viewport, { width: 1280, height: 720 });
    adapter ??= report.capture.adapter;
    assert.deepEqual(report.capture.adapter, adapter, "adapter changed between runs");
    assert(
      Array.isArray(report.assertionResults) && report.assertionResults.length > 0,
      "assertions missing",
    );
    const assertions = new Map(report.assertionResults.map((a) => [a.id, a]));
    assert.equal(assertions.size, report.assertionResults.length, "duplicate assertions");
    const value = (id: string): unknown => {
      const assertion = assertions.get(id);
      assert(assertion?.pass === true, `missing or failed ${id}`);
      return (assertion.details as { after?: unknown })?.after;
    };
    const positive = (id: string, minimum: number) => {
      const result = value(id);
      assert(
        typeof result === "number" && Number.isFinite(result) && result >= minimum,
        `invalid ${id}`,
      );
      return result;
    };
    value("diagnostics");
    assert.equal(value("component.props.reveal.complete"), true);
    const samples = positive("component.props.reveal.samples", 2);
    assert(Number.isInteger(samples), "malformed samples");
    positive("component.props.reveal.elapsedMs", 3000);
    times[arm].push(positive("resource.GameState.timeToReadyMs", Number.MIN_VALUE));
    for (const id of late) {
      const counter = assertions.get(id);
      const observed = (counter?.details as { after?: unknown })?.after;
      assert(
        typeof observed === "number" && Number.isFinite(observed) && observed >= 0,
        `missing or malformed ${id}`,
      );
      if (arm === "after") {
        assert.equal(counter?.pass, true, id);
        assert.equal(observed, 0, id);
      }
    }
    assert(
      report.assertionResults.every(
        (a) => a.pass === true || (arm === "before" && late.includes(a.id)),
      ),
      "unexpected assertion failure",
    );
    assert.equal(
      report.pass,
      report.assertionResults.every((a) => a.pass === true),
    );
    assert.equal(status, report.pass ? 0 : 1, "subprocess/report disagreement");
  }
  const median = (values: number[]) => {
    const value = values.sort((a, b) => a - b)[1];
    assert(value !== undefined, "median requires three observations");
    return value;
  };
  const before = median(times.before);
  const after = median(times.after);
  const ratio = after / before;
  assert(
    Number.isFinite(ratio) && after <= before * 1.25,
    `startup median ${after}/${before} = ${ratio} exceeds 1.25`,
  );
  return {
    before,
    after,
    ratio,
    times,
    adapter,
    qualification: "software regression contract; no hardware or visual qualification",
  };
}

export function parseStartupReport(log: string): StartupReport {
  for (const match of log.matchAll(/^\{/gm)) {
    try {
      const parsed = JSON.parse(log.slice(match.index));
      if (parsed.assertionResults) return parsed;
    } catch {
      /* Display/lock JSON precedes the final runner report. */
    }
  }
  throw new Error("missing or malformed startup report");
}

export function verifyStartupPackageIdentity(
  baseline: Record<string, unknown>,
  candidate: Record<string, unknown>,
) {
  for (const field of [
    "name",
    "version",
    "private",
    "type",
    "engines",
    "packageManager",
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ])
    assert.deepEqual(candidate[field], baseline[field], `incompatible package identity: ${field}`);
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: root, encoding: "utf8" },
  ).trim();
  const baseline = path.join(path.dirname(commonDirectory), ".worktrees/strata-startup-baseline");
  const output = path.join(root, "artifacts/strata-startup");
  mkdirSync(output, { recursive: true });
  const git = (cwd: string) =>
    execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
  assert.equal(git(baseline), BASELINE_SHA, "baseline must remain reviewed source");
  assert.match(process.env.EXPECTED_SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(git(root), process.env.EXPECTED_SOURCE_SHA, "candidate must match scoped source");
  for (const file of ["pnpm-lock.yaml", "pnpm-workspace.yaml"])
    assert.equal(
      readFileSync(path.join(root, file), "utf8"),
      readFileSync(path.join(baseline, file), "utf8"),
      `incompatible identity: ${file}`,
    );
  const packageIdentity = (cwd: string) =>
    JSON.parse(
      readFileSync(path.join(cwd, "examples/strata-terrain-preview/package.json"), "utf8"),
    );
  verifyStartupPackageIdentity(packageIdentity(baseline), packageIdentity(root));
  for (const cwd of [root, baseline])
    assert.equal(
      realpathSync(
        path.join(cwd, "examples/strata-terrain-preview/node_modules/@threenative/core"),
      ),
      realpathSync(path.join(cwd, "packages/core")),
      "game must resolve its own core",
    );
  const scenario = JSON.parse(
    readFileSync(
      path.join(root, "examples/strata-terrain-preview/playtests/reveal.playtest.json"),
      "utf8",
    ),
  );
  assert.deepEqual(scenario.viewport, { width: 1280, height: 720 });
  // Drop only diagnostic images: hosted WebGPU screenshots can time out. Preserve every assertion.
  scenario.artifacts.screenshots = false;
  for (const step of scenario.steps) step.screenshot = undefined;
  const scenarioPath = path.join(output, "frozen.playtest.json");
  writeFileSync(scenarioPath, JSON.stringify(scenario));
  const toolchain = (cwd: string) =>
    execFileSync("pnpm", ["exec", "vite", "--version"], {
      cwd: path.join(cwd, "examples/strata-terrain-preview"),
      encoding: "utf8",
    }).trim();
  const compiler = toolchain(root);
  assert.equal(toolchain(baseline), compiler, "compiler identity differs");
  writeFileSync(
    path.join(output, "identity.json"),
    JSON.stringify({
      baseline: BASELINE_SHA,
      candidate: git(root),
      node: process.version,
      workload: createHash("sha256").update(JSON.stringify(scenario)).digest("hex"),
      browser: execFileSync("pnpm", ["exec", "playwright", "--version"], {
        cwd: root,
        encoding: "utf8",
      }),
      compiler,
    }),
  );
  const runs: IStartupRun[] = [];
  const deadline = Date.now() + 8 * 60_000;
  for (const [index, arm] of ORDER.entries()) {
    const directory = path.join(output, `${index + 1}-${arm}`);
    mkdirSync(directory);
    const fd = openSync(path.join(directory, "run.log"), "w");
    const cwd = arm === "before" ? baseline : root;
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "packages/playtest/dist/runner/cli.js"),
        scenarioPath,
        "--url",
        "http://127.0.0.1:16181/?world=forest",
        "--server-command",
        "pnpm --filter strata-terrain-preview exec vite preview --host 127.0.0.1 --port 16181 --strictPort",
        "--browser-recipe",
        "webgpu",
        "--headed",
        "--no-screenshots",
        "--allow-software",
        "--timeout",
        "75000",
        "--artifacts",
        directory,
      ],
      {
        cwd,
        stdio: ["ignore", fd, fd],
        timeout: Math.max(1, Math.min(80_000, deadline - Date.now())),
        killSignal: "SIGKILL",
      },
    );
    closeSync(fd);
    assert(!result.error && !result.signal, `subprocess failed: ${result.error ?? result.signal}`);
    const log = readFileSync(path.join(directory, "run.log"), "utf8");
    const report = parseStartupReport(log);
    writeFileSync(path.join(directory, "report.json"), JSON.stringify(report));
    runs.push({ arm, status: result.status, report });
  }
  const summary = verifyStartupRuns(runs);
  writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
