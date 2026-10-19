import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import { assertToneCaptureDiagnostics } from "./tone-capture-proof.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts/tone-exposure");
await mkdir(output, { recursive: true });
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
await writeFile(
  path.join(output, "attempt.json"),
  `${JSON.stringify({ sourceSha, status: "started" }, null, 2)}\n`,
);
try {
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "tone.vite.config.ts"], {
    cwd: path.join(root, "examples/abyss-framework"),
    stdio: "inherit",
  });
  const reports = [];
  for (const variant of ["underexposed", "restored"] as const) {
    const artifactDirectory = path.join(output, variant);
    const report = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: path.join(root, "examples/abyss-framework"),
      scenarioPath: "playtests/tone.playtest.json",
      server: {
        command:
          "pnpm exec vite preview --config tone.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      timeoutMs: 30_000,
      trace: false,
      url: `http://127.0.0.1:5173/tone.html${variant === "underexposed" ? "?underexposed" : ""}`,
    });
    await writeFile(
      path.join(artifactDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await writeFile(
      path.join(artifactDirectory, "observations.json"),
      `${JSON.stringify(report.observations, null, 2)}\n`,
    );
    reports.push(report);
    await writeFile(path.join(output, "reports.json"), `${JSON.stringify(reports, null, 2)}\n`);
    assertToneCaptureDiagnostics(report.diagnostics, variant);
    assert.ok(report.capture?.adapter, `${variant}: adapter provenance is required`);
    assert.ok(
      Object.values(report.capture.adapter).some((value) => value.trim() !== ""),
      `${variant}: adapter identity must not be empty`,
    );
    assert.equal(report.capture.rendererKind, "webgpu", `${variant}: must exercise WebGPU`);
    for (const frame of ["tone-0.png", "after.png"])
      assert.ok(
        (await readFile(path.join(artifactDirectory, frame))).length > 0,
        `${variant}: ${frame} is required`,
      );
    assert.equal(
      report.pass,
      variant === "restored",
      `${variant}: ${JSON.stringify(report.diagnostics)}`,
    );
    if (variant === "underexposed")
      assert.deepEqual(
        (report.assertionResults ?? [])
          .filter(({ pass }) => !pass)
          .map(({ id }) => id)
          .sort(),
        ["tone.0.mean", "tone.0.p99", "tone.1.mean", "tone.1.p99"],
      );
  }
  assert.ok(
    !(await readFile(path.join(output, "underexposed/tone-0.png"))).equals(
      await readFile(path.join(output, "restored/tone-0.png")),
    ),
    "Exposure mutation must change captured pixels",
  );
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify(
      {
        sourceSha,
        qualification:
          "rendered-pixel correctness only; software adapters allowed, no native or hardware-performance claim",
        pass: true,
        variants: reports.map((report, index) => ({
          variant: index === 0 ? "underexposed" : "restored",
          capture: report.capture,
          pass: report.pass,
          tone: report.observations?.tone,
        })),
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `Tone exposure: underexposed failed and restored passed; runtime screenshots and reports: ${output}`,
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    `${JSON.stringify(
      {
        sourceSha,
        pass: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      null,
      2,
    )}\n`,
  );
  throw error;
}
