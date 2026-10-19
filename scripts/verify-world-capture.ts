/** Hosted diagnostic capture only: the hardware visual gate must still reject this software run. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { softwareAdapterName } from "../packages/playtest/src/runner/browser.js";
import type { IStandalonePlaytestReport } from "../packages/playtest/src/runner/shared.js";
import { assertFrameShowsSomething } from "./capture-guard.js";

const labels = [
  "phase477-pose-start",
  ...Array.from(
    { length: 32 },
    (_, index) => `phase477-walk-${String(index + 1).padStart(2, "0")}`,
  ),
  "phase477-pose-end",
];

export function verifyWorldCaptureReport(
  report: Pick<IStandalonePlaytestReport, "pass" | "capture" | "diagnostics" | "observations">,
  directory: string,
) {
  assert.equal(report.pass, true, "WorldProbe scenario must pass");
  assert(Array.isArray(report.diagnostics), "runtime diagnostics are required");
  for (const diagnostic of report.diagnostics)
    assert(
      diagnostic.severity !== "error" && diagnostic.code !== "TN_PLAYTEST_SOFTWARE_DEVICE_LOST",
      `${diagnostic.code}: ${diagnostic.message}`,
    );
  assert(Array.isArray(report.observations?.console), "console observations are required");
  for (const entry of report.observations.console)
    assert(
      entry.type !== "error" &&
        entry.source !== "page-error" &&
        entry.source !== "unhandled-rejection",
      `console error: ${entry.text}`,
    );
  assert(report.capture, "capture provenance is required");
  const { viewport } = report.capture;
  return labels.map((label) => {
    const image = `${label}.png`;
    const png = readFileSync(path.join(directory, image));
    const stats = assertFrameShowsSomething(png, image);
    assert.equal(stats.width, viewport.width, `${image}: viewport width differs`);
    assert.equal(stats.height, viewport.height, `${image}: viewport height differs`);
    return { image, sha256: createHash("sha256").update(png).digest("hex"), ...stats };
  });
}

export function assertWorldCaptureGateRejection(
  result: { status: number | null; stderr: string },
  adapter: Readonly<Record<string, string>> | undefined,
): void {
  assert(softwareAdapterName(adapter), "hosted diagnostic capture must name its software adapter");
  assert.equal(result.status, 2, "strict visual gate must reject the software capture");
  assert.equal(
    result.stderr.trim(),
    "TN_WORLD_VISUAL_INVALID: requires hardware WebGPU browser capture provenance",
    "strict visual gate must reject software provenance, not fail for another reason",
  );
}

async function main(): Promise<void> {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const output = path.join(root, "artifacts/world-capture");
  const artifactDirectory = path.join(output, "capture");
  const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const qualification =
    "Diagnostic WorldProbe capture/import only; software rendering is not hardware visual acceptance, performance evidence, a before/after comparison, or native proof.";
  const write = (file: string, value: unknown) =>
    writeFileSync(path.join(output, file), `${JSON.stringify(value, null, 2)}\n`);
  mkdirSync(output, { recursive: true });
  // A repeated invocation cannot silently replace screenshots from an earlier run.
  mkdirSync(artifactDirectory);
  write("attempt.json", { sourceSha, qualification, status: "started" });
  try {
    if (process.env.EXPECTED_SOURCE_SHA)
      assert.equal(
        sourceSha,
        process.env.EXPECTED_SOURCE_SHA,
        "checkout must match the PR head SHA",
      );
    const { WEBGPU_BROWSER_ARGS, runStandalonePlaytest } = await import(
      "../packages/playtest/dist/runner/index.js"
    );
    const report = await runStandalonePlaytest({
      // Deliberate diagnostic permission only. The original hardware gate below is unchanged.
      allowSoftwareAdapter: true,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: path.join(root, "examples/abyss-framework"),
      scenarioPath: "playtests/phase477-world-capture.playtest.json",
      server: {
        command: "pnpm exec vite --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 120_000,
      },
      timeoutMs: 300_000,
      trace: false,
      url: "http://127.0.0.1:5173/?world",
    });
    write("capture/report.json", report);
    write("capture/observations.json", report.observations);
    const frames = verifyWorldCaptureReport(report, artifactDirectory);
    write("frames.json", frames);
    const importerArgs = [
      "--import",
      "tsx",
      "scripts/world-capture-manifest.ts",
      artifactDirectory,
      sourceSha,
      "30",
    ];
    const imported = spawnSync(process.execPath, importerArgs, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    write("importer.json", {
      sourceSha,
      args: importerArgs,
      status: imported.status,
      signal: imported.signal,
      stdout: imported.stdout,
      stderr: imported.stderr,
      error: imported.error?.message,
    });
    assert.equal(imported.status, 0, `capture importer failed: ${imported.stderr}`);
    const manifest = path.join(artifactDirectory, "world-capture.json");
    const gateArgs = [
      "--import",
      "tsx",
      "scripts/world-visual-gate.ts",
      "--before",
      manifest,
      "--after",
      manifest,
      "--out",
      path.join(output, "strict-gate"),
    ];
    const gate = spawnSync(process.execPath, gateArgs, {
      cwd: root,
      encoding: "utf8",
      timeout: 120_000,
    });
    write("strict-gate.json", {
      sourceSha,
      qualification,
      args: gateArgs,
      status: gate.status,
      signal: gate.signal,
      stdout: gate.stdout,
      stderr: gate.stderr,
      error: gate.error?.message,
    });
    assertWorldCaptureGateRejection(gate, report.capture?.adapter);
    write("summary.json", {
      sourceSha,
      qualification,
      diagnosticPass: true,
      hardwareVisualAcceptance: false,
      capture: report.capture,
      frameCount: frames.length,
      importedManifest: "capture/world-capture.json",
      strictGate: { status: gate.status, reason: gate.stderr.trim() },
    });
    console.log(
      `WorldProbe: ${frames.length} diagnostic frames imported; original gate rejected software provenance. Artifacts: ${output}`,
    );
  } catch (error) {
    write("failure.json", {
      sourceSha,
      qualification,
      diagnosticPass: false,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
