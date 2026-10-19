import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCaptureNotBlank } from "../packages/playtest/dist/capture.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import { assertVelocityCaptureDiagnostics } from "./velocity-capture-proof.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts/velocity-history");
await mkdir(output, { recursive: true });
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await writeFile(
  path.join(output, "attempt.json"),
  `${JSON.stringify({ sourceSha, status: "started" }, null, 2)}\n`,
);
// PRD-550 phase 1. The temporal-off cost arm prices actual frame submission against split-control
// noise, so a runner other jobs share reports their load as render cost and `p95NoiseExcessMs` goes
// red on unrelated work. That arm runs on the performance-regression lane; the history arm, which is
// the correctness gate, stays on the merge path.
const requested =
  process.argv
    .slice(2)
    .find((value) => value.startsWith("--variant="))
    ?.slice("--variant=".length) ?? "both";
if (!["history", "cost", "both"].includes(requested)) {
  throw new Error(
    `usage: verify-velocity-history.ts [--variant=<history|cost|both>], got ${requested}`,
  );
}
const runHistory = requested !== "cost";
const runCost = requested !== "history";
try {
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "velocity.vite.config.ts"], {
    cwd: path.join(root, "examples/abyss-framework"),
    stdio: "inherit",
  });
  const results = [];
  const variants = [
    {
      variant: "without-history",
      query: "?without-history",
      kind: "BatchedMesh",
      failures: ["movingPixels", "oracleMaxErrorPixels", "footprintMaxErrorPixels"],
    },
    { variant: "tracked", query: "", kind: "BatchedMesh", failures: [] },
    { variant: "instanced", query: "?instanced", kind: "InstancedMesh", failures: [] },
    {
      variant: "instanced-recompile",
      query: "?instanced&recompile",
      kind: "InstancedMesh",
      failures: [],
    },
    {
      variant: "instanced-dynamic",
      query: "?instanced&dynamic",
      kind: "InstancedMesh",
      failures: [],
    },
    {
      variant: "aggregate-batch",
      query: "?aggregate-history",
      kind: "BatchedMesh",
      failures: ["staticMax", "stationaryMax", "outsideFootprintMax"],
    },
    {
      variant: "aggregate-instance",
      query: "?instanced&aggregate-history",
      kind: "InstancedMesh",
      failures: ["staticMax", "stationaryMax", "outsideFootprintMax"],
    },
    { variant: "skinned", query: "?skinned", kind: "SkinnedMesh", failures: [] },
    {
      // Original root-motion acceptance: each current pixel uses the scheduled previous bind inverse.
      variant: "skinned-world",
      query: "?skinned&world-motion",
      kind: "SkinnedMesh",
      failures: [],
    },
    {
      // Original world-history mutation: the current world matrix must erase root-motion velocity.
      variant: "skinned-world-current-history",
      query: "?skinned&world-motion&current-world-history",
      kind: "SkinnedMesh",
      failures: ["movingPixels", "oracleMaxErrorPixels", "footprintMaxErrorPixels"],
    },
    {
      variant: "skinned-current-history",
      query: "?skinned&current-as-previous",
      kind: "SkinnedMesh",
      failures: ["movingPixels", "oracleMaxErrorPixels", "footprintMaxErrorPixels"],
    },
    { variant: "late-write", query: "?instanced&late-write", kind: "InstancedMesh", failures: [] },
    {
      variant: "premature-commit",
      query: "?instanced&late-write&premature-commit",
      kind: "InstancedMesh",
      failures: ["movingPixels", "oracleMaxErrorPixels", "footprintMaxErrorPixels"],
    },
  ];
  const historyVariants = runHistory ? variants : [];
  for (const { variant, query, kind, failures } of historyVariants) {
    const artifactDirectory = path.join(output, variant);
    const report = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: path.join(root, "examples/abyss-framework"),
      scenarioPath: "playtests/velocity-history.playtest.json",
      server: {
        command:
          "pnpm exec vite preview --config velocity.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      timeoutMs: 60_000,
      trace: false,
      url: `http://127.0.0.1:5173/velocity.html${query}`,
    });
    await writeFile(
      path.join(artifactDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    results.push({ variant, report });
    await writeFile(path.join(output, "reports.json"), `${JSON.stringify(results, null, 2)}\n`);
    assertVelocityCaptureDiagnostics(report.diagnostics, failures.length > 0);
    assert.equal(report.capture?.rendererKind, "webgpu", `${variant}: must render WebGPU`);
    assert.ok(
      report.capture?.adapter &&
        Object.values(report.capture.adapter).some((value) => value.trim() !== ""),
      `${variant}: adapter identity required`,
    );
    const images = (await readdir(artifactDirectory)).filter((name) => name.endsWith(".png"));
    assert.ok(images.includes("after.png"), `${variant}: final runtime screenshot required`);
    for (const name of images)
      assertCaptureNotBlank(
        await readFile(path.join(artifactDirectory, name)),
        `${variant}/${name}`,
      );
    assert.equal(
      report.pass,
      failures.length === 0,
      `${variant}: ${JSON.stringify(report.diagnostics)}`,
    );
    assert.deepEqual(
      (report.assertionResults ?? []).filter(({ pass }) => !pass).map(({ id }) => id),
      failures.map((name) => `resource.motion.${name}`),
    );
    const snapshot = report.observations?.resources.motion?.after;
    assert.ok(snapshot && typeof snapshot === "object" && !Array.isArray(snapshot));
    assert.ok("geometryKind" in snapshot && "lateWrites" in snapshot && "recompiles" in snapshot);
    assert.ok("worldMotion" in snapshot && "currentWorldHistory" in snapshot);
    assert.equal(snapshot.geometryKind, kind, `${variant}: actual geometry class`);
    assert.equal(
      snapshot.lateWrites,
      query.includes("late-write") ? 8 : 0,
      `${variant}: writes after scheduling`,
    );
    assert.equal(snapshot.recompiles, query.includes("recompile") ? 1 : 0, `${variant}: rebuilds`);
    assert.equal(snapshot.worldMotion, query.includes("world-motion"), `${variant}: world motion`);
    assert.equal(
      snapshot.currentWorldHistory,
      query.includes("current-world-history"),
      `${variant}: world-history mutation`,
    );
  }
  const temporalOffCost = [];
  const costVariants = runCost
    ? [
        { name: "temporal-off-cost", query: "", failures: [] },
        {
          name: "temporal-off-after-consumer-diagnostic",
          query: "?from-temporal",
          failures: [],
        },
      ]
    : [];
  for (const costVariant of costVariants) {
    const costDirectory = path.join(output, costVariant.name);
    const costReport = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory: costDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: path.join(root, "examples/abyss-framework"),
      scenarioPath: "playtests/velocity-cost.playtest.json",
      server: {
        command:
          "pnpm exec vite preview --config velocity.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      timeoutMs: 180_000,
      trace: false,
      url: `http://127.0.0.1:5173/velocity-cost.html${costVariant.query}`,
    });
    await writeFile(
      path.join(costDirectory, "report.json"),
      `${JSON.stringify(costReport, null, 2)}\n`,
    );
    assertVelocityCaptureDiagnostics(costReport.diagnostics, costVariant.failures.length > 0);
    assert.equal(costReport.capture?.rendererKind, "webgpu", "temporal-off: must render WebGPU");
    assert.ok(
      costReport.capture?.adapter &&
        Object.values(costReport.capture.adapter).some((value) => value.trim() !== ""),
      "temporal-off: adapter identity required",
    );
    assertCaptureNotBlank(
      await readFile(path.join(costDirectory, "after.png")),
      "temporal-off-cost/after.png",
    );
    assert.equal(
      costReport.pass,
      costVariant.failures.length === 0,
      `temporal-off cost: ${JSON.stringify(costReport.diagnostics)}`,
    );
    assert.deepEqual(
      (costReport.assertionResults ?? [])
        .filter((result) => !result.pass)
        .map((result) => result.id),
      costVariant.failures,
    );
    const costSnapshot = costReport.observations?.resources.cost?.after;
    assert.ok(costSnapshot && typeof costSnapshot === "object" && !Array.isArray(costSnapshot));
    assert.ok("transitions" in costSnapshot && "activeVelocityTargets" in costSnapshot);
    assert.equal(costSnapshot.transitions, costVariant.query === "" ? 0 : 3);
    assert.equal(costSnapshot.activeVelocityTargets, costVariant.query === "" ? 0 : 1);
    temporalOffCost.push({
      variant: costVariant.name,
      pass: costReport.pass,
      capture: costReport.capture,
      measurement: costReport.observations?.resources.cost,
      diagnostics: costReport.diagnostics,
    });
  }
  if (runHistory) {
    assert.ok(
      !(await readFile(path.join(output, "without-history/after.png"))).equals(
        await readFile(path.join(output, "tracked/after.png")),
      ),
      "Actual velocity visualization must change when history is removed.",
    );
  }
  const qualification = [
    runHistory && "actual WebGPU velocity MRT readback and screenshots",
    runCost &&
      "software-only temporal-off CPU submission cost, including three temporal-consumer on/off transitions",
  ]
    .filter(Boolean)
    .join(" plus ")
    .concat("; no native, ghosting or hardware-performance claim");
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify({ sourceSha, variant: requested, pass: true, qualification, temporalOffCost, variants: results.map(({ variant, report }) => ({ variant, pass: report.pass, capture: report.capture, motion: report.observations?.resources.motion, diagnostics: report.diagnostics })) }, null, 2)}\n`,
  );
  console.log(
    `Velocity ${requested}: expected outcomes observed for ${String(runHistory ? "the authored motion/control variants, including exact skinned coverage and the original world-history control" : "the temporal-off submission cost arm")}. Artifacts: ${output}`,
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    `${JSON.stringify({ sourceSha, pass: false, error: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined }, null, 2)}\n`,
  );
  throw error;
}
