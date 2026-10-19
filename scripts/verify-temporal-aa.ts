import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertCaptureNotBlank } from "../packages/playtest/dist/capture.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";

import { requireTemporalRenderEvidence } from "./temporal-aa-evidence.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(root, "artifacts/temporal-aa");
await mkdir(output, { recursive: true });
const summaries = [];
let referenceFrame: number | undefined;
for (const variant of ["reference", "temporal", "cut", "projection", "resize"] as const) {
  const artifactDirectory = path.join(output, variant);
  await mkdir(artifactDirectory, { recursive: true });
  const report = await runStandalonePlaytest({
    allowSoftwareAdapter: true,
    artifactDirectory,
    browserArgs: [...WEBGPU_BROWSER_ARGS],
    headless: false,
    port: 0,
    projectPath: path.join(root, "examples/abyss-framework"),
    scenarioPath: "playtests/temporal-aa.playtest.json",
    server: {
      command:
        "pnpm exec vite build --config temporal.vite.config.ts && pnpm exec vite preview --config temporal.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
      timeoutMs: 60_000,
    },
    timeoutMs: 60_000,
    trace: false,
    url: `http://127.0.0.1:5173/temporal.html?variant=${variant}`,
  }).catch(async (error: unknown) => {
    await writeFile(
      path.join(artifactDirectory, "failure.json"),
      `${JSON.stringify(
        {
          variant,
          pass: false,
          error: error instanceof Error ? error.stack : String(error),
        },
        null,
        2,
      )}\n`,
    );
    throw error;
  });
  await writeFile(
    path.join(artifactDirectory, "report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  requireTemporalRenderEvidence(report, variant);
  const observed = report.observations?.resources?.temporal?.after as
    | {
        frame: number;
        stages: string[];
        rigidHistory: boolean;
        skinnedHistory: boolean;
        instancedHistory: boolean;
        aa: {
          frame: number;
          inputWidth: number;
          inputHeight: number;
          outputWidth: number;
          outputHeight: number;
          historyValid: boolean;
        } | null;
        lastReset: { resetReason: string } | null;
      }
    | undefined;
  assert.ok(observed && observed.frame >= 24, `${variant}: actual rendered frames required`);
  if (referenceFrame === undefined) referenceFrame = observed.frame;
  else
    assert.equal(
      observed.frame,
      referenceFrame,
      `${variant}: capture the same deterministic pose as the reference`,
    );
  for (const kind of ["rigidHistory", "skinnedHistory", "instancedHistory"] as const) {
    assert.equal(observed[kind], true, `${variant}: ${kind} must use the existing tracker`);
  }
  if (variant === "reference") {
    assert.equal(observed.aa, null);
    assert.deepEqual(observed.stages, []);
  } else {
    assert.deepEqual(observed.stages, ["traa"]);
    assert.ok(observed.aa, `${variant}: temporal result absent`);
    assert.equal(
      observed.aa.frame,
      observed.frame,
      `${variant}: every counted step must actually resolve`,
    );
    assert.equal(observed.aa.historyValid, true, `${variant}: history must recover after reset`);
    assert.equal(observed.aa.inputWidth, variant === "resize" ? 960 : 1280);
    assert.equal(observed.aa.inputHeight, variant === "resize" ? 540 : 720);
    assert.equal(observed.aa.outputWidth, observed.aa.inputWidth);
    assert.equal(observed.aa.outputHeight, observed.aa.inputHeight);
    const reset = {
      temporal: "initial",
      cut: "camera-cut",
      projection: "projection-change",
      resize: "resize",
    }[variant];
    assert.equal(observed.lastReset?.resetReason, reset);
  }
  for (const filename of ["before.png", "after.png"]) {
    const image = assertCaptureNotBlank(
      await readFile(path.join(artifactDirectory, filename)),
      `${variant}/${filename}`,
    );
    assert.ok(
      image.width >= 960 && image.height >= 540,
      `${variant}: actual canvas capture required`,
    );
  }
  summaries.push({ variant, capture: report.capture, observed });
}
const reference = await readFile(path.join(output, "reference/after.png"));
const temporal = await readFile(path.join(output, "temporal/after.png"));
assert.ok(
  !reference.equals(temporal),
  "Enabling temporal AA must change the actual rendered pixels",
);
await writeFile(
  path.join(output, "summary.json"),
  `${JSON.stringify(
    {
      qualification:
        "full-resolution runtime correctness only; software adapters allowed, no native, image-quality superiority or hardware-performance claim",
      pass: true,
      variants: summaries,
    },
    null,
    2,
  )}\n`,
);
console.log(
  `Temporal AA: five actual runtime variants captured with adapter and history evidence at ${output}`,
);
