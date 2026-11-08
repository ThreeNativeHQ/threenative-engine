import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { makeTempDir } from "../../../test-support/temp-dir.js";

import { main } from "../src/runner/cli.js";
import { hashArtifact, resolveBuildReport, withPerformanceBudget } from "../src/runner/buildReport.js";
import type { IStandalonePlaytestConfig } from "../src/runner/config.js";
import { evaluatePerformanceAssertion } from "../src/evaluators/render-evidence.js";
import { loadPlaytestScenario, type IPlaytestPerformanceAssertion } from "../src/index.js";

/**
 * The digests of the fixture below, asserted to the same constants in
 * `create-threenative/__tests__/build-report.spec.ts`.
 *
 * The two `hashArtifact` implementations exist because the two packages share no dependency by
 * design, so nothing but a pinned value proves they are one algorithm. A changed fixture constant in
 * one spec and not the other is a red test, which is exactly when it should be one.
 */
const FIXTURE_DIRECTORY_SHA256 = "30263b095da6a3cdaba7338a6882fba33c971daf6896338be4d1b6629652ff1c";
const FIXTURE_FILE_SHA256 = "3598ce6f965b2481fe26316c06b30950c46ac7f8e7229f104aa78f579997668d";

const SCENARIO = {
  assert: { performance: { maxTriangles: 900 } },
  name: "build-report-budget",
  schemaVersion: 1,
  steps: [{ kind: "wait", waitTicks: 1 }],
  target: "web",
  viewport: { height: 720, width: 1280 },
  warmupFrames: 1,
};

afterEach(() => {
  process.exitCode = undefined;
});

async function fixture(): Promise<{ artifact: string; report: string; root: string }> {
  const root = await makeTempDir("playtest-build-report-");
  const artifact = join(root, "dist");
  await mkdir(join(artifact, "assets"), { recursive: true });
  await writeFile(join(artifact, "index.html"), "<!doctype html><title>game</title>");
  await writeFile(join(artifact, "assets", "logo.bin"), "logo");
  const report = join(root, "dist.build-report.json");
  await writeReport(report, {
    artifact: await hashArtifact(artifact),
    measured: { artifactBytes: 42, packagedAssetBytes: 4 },
    manifestSha256: null,
    performanceBudget: { maxDrawCalls: 1 },
    profile: "capped",
    schemaVersion: 1,
    target: "web",
  });
  return { artifact, report, root };
}

async function writeReport(reportPath: string, report: unknown): Promise<void> {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

function config(overrides: Partial<IStandalonePlaytestConfig>): IStandalonePlaytestConfig {
  return {
    artifactDirectory: "artifacts/playtest-build-report",
    headless: true,
    projectPath: ".",
    scenarioPath: "scenario.json",
    timeoutMs: 1_000,
    trace: false,
    url: "http://127.0.0.1:5173",
    ...overrides,
  };
}

test("the artifact hash is the one the build computes, pinned in both packages", async () => {
  const { artifact } = await fixture();

  const file = await hashArtifact(join(artifact, "assets", "logo.bin"));
  expect(file).toEqual({ kind: "file", name: "logo.bin", sha256: FIXTURE_FILE_SHA256 });
  const tree = await hashArtifact(artifact);
  expect(tree.kind).toBe("directory");
  expect(tree.name).toBe("dist");
  expect(tree.sha256).toBe(FIXTURE_DIRECTORY_SHA256);
  // A byte inside a file, a file renamed and a file added each change the directory digest; the
  // path the tree happens to live under does not.
  await writeFile(join(artifact, "assets", "logo.bin"), "logo!");
  expect((await hashArtifact(artifact)).sha256).not.toBe(FIXTURE_DIRECTORY_SHA256);
  await writeFile(join(artifact, "assets", "logo.bin"), "logo");
  await rename(join(artifact, "assets", "logo.bin"), join(artifact, "assets", "mark.bin"));
  expect((await hashArtifact(artifact)).sha256).not.toBe(FIXTURE_DIRECTORY_SHA256);
});

test("a report whose artifact has changed since the build refuses the run, naming both hashes", async () => {
  const { artifact, report, root } = await fixture();
  const before = (await hashArtifact(artifact)).sha256;
  await writeFile(join(artifact, "index.html"), "<!doctype html><title>edited</title>");
  const after = (await hashArtifact(artifact)).sha256;

  await expect(
    resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
  ).rejects.toThrow(
    new RegExp(`TN_PLAYTEST_BUILD_REPORT_STALE.*${before}.*${after}`, "su"),
  );
  // The same refusal through the CLI: exit 2, the diagnostic naming the report, and no run.
  const errors: string[] = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    errors.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let exitCode: number;
  try {
    exitCode = await main([
      "--project", root,
      "--artifact", artifact,
      "--build-report", report,
      "--scenario", "missing.playtest.json",
    ]);
  } finally {
    process.stderr.write = originalWrite;
  }
  expect(exitCode).toBe(2);
  expect(process.exitCode).toBe(2);
  expect(errors.join("")).toContain("TN_PLAYTEST_BUILD_REPORT_STALE");
});

test("a report built for another target is refused rather than evaluated", async () => {
  const { artifact, report } = await fixture();
  const parsed = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  await writeReport(report, { ...parsed, target: "android" });

  await expect(
    resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
  ).rejects.toThrow(/TN_PLAYTEST_BUILD_REPORT_INVALID.*'android'.*'web'/su);
});

test("a misspelled ceiling, an unknown key and a wrong type are all exit 2, never a narrowed run", async () => {
  const { artifact, report } = await fixture();
  const parsed = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  for (const performanceBudget of [
    { maxFrameMsP59: 16 },
    { maxDrawCalls: "1" },
    { maxPhaseMsP95: { rnder: 12 } },
    { maxPassDrawCalls: {} },
  ]) {
    await writeReport(report, { ...parsed, performanceBudget });
    await expect(
      resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
    ).rejects.toThrow(/TN_PLAYTEST_BUILD_REPORT_INVALID/u);
  }
  await writeReport(report, { ...parsed, extra: true });
  await expect(
    resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
  ).rejects.toThrow(/report\.extra is not recognised/u);
  await writeFile(report, "{ not json");
  await expect(
    resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
  ).rejects.toThrow(/is not valid JSON/u);
});

test("a report that omits its budget is refused, not read as a profile with no ceilings", async () => {
  const { artifact, report } = await fixture();
  const parsed = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  // A build always writes the key (`null` when the profile declares none), so an absent one is a
  // report that lost its ceilings — the run must stop, not pass with the bound deleted.
  delete parsed.performanceBudget;
  await writeReport(report, parsed);

  await expect(
    resolveBuildReport(config({ artifactPath: artifact, buildReportPath: report })),
  ).rejects.toThrow(/TN_PLAYTEST_BUILD_REPORT_INVALID.*performanceBudget/su);
});

test("a budget the target cannot observe is refused before the run, not dropped", async () => {
  const { artifact, report } = await fixture();
  const parsed = JSON.parse(await readFile(report, "utf8")) as Record<string, unknown>;
  await writeReport(report, { ...parsed, target: "android" });

  await expect(
    resolveBuildReport(config({
      android: { activity: ".MainActivity", packageName: "com.mystral.engine" },
      artifactPath: artifact,
      buildReportPath: report,
      target: "android",
    })),
  ).rejects.toThrow(/cannot observe.*measured on: browser, desktop/su);
});

test("the browser lane is told which build it is exercising, or it is not", async () => {
  const { report } = await fixture();
  await expect(resolveBuildReport(config({ buildReportPath: report }))).rejects.toThrow(
    /does not say which artifact/u,
  );
});

test("the budget reaches the scenario per key, and a known violation fails on its own reason", async () => {
  const { artifact, report, root } = await fixture();
  const adopted = await resolveBuildReport(
    config({ artifactPath: artifact, buildReportPath: report }),
  );
  expect(adopted.performanceBudget).toEqual({ maxDrawCalls: 1 });

  const scenarioPath = join(root, "budget.playtest.json");
  await writeFile(scenarioPath, JSON.stringify(SCENARIO));
  const scenario = withPerformanceBudget(
    await loadPlaytestScenario(root, "budget.playtest.json"),
    adopted.performanceBudget,
  );
  // The scenario's own ceiling survives; the build's adds the one it did not declare.
  expect(scenario.assert?.performance).toEqual({ maxDrawCalls: 1, maxTriangles: 900 });

  const drawn = evaluatePerformanceAssertion(
    { maxDrawCalls: 1 },
    Array.from({ length: 8 }, () => ({ drawCalls: 64, frameMs: 8 })),
    "playtest",
  );
  const bound = drawn.assertions.find(({ id }) => id === "performance.maxDrawCalls");
  expect(bound?.pass).toBe(false);
  expect(drawn.diagnostics.map(({ code }) => code)).toContain(
    "TN_PLAYTEST_PERFORMANCE_ASSERTION_FAILED",
  );
  expect(drawn.diagnostics[0]?.message).toMatch(/maxDrawCalls expected at most 1 draw calls, observed 64/u);
});

test("a budget with no measured series fails; it never passes on nothing", () => {
  const budget: IPlaytestPerformanceAssertion = { maxDrawCalls: 1 };
  const nothing = evaluatePerformanceAssertion(budget, [], undefined);
  expect(nothing.assertions.every(({ pass }) => !pass)).toBe(true);
  expect(nothing.diagnostics.map(({ code }) => code)).toContain(
    "TN_PLAYTEST_PERFORMANCE_SAMPLES_MISSING",
  );
  expect(
    nothing.assertions.find(({ id }) => id === "performance.maxDrawCalls")?.details,
  ).toMatchObject({ actual: null, expected: 1 });
});
