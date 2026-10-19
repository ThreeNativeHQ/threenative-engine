import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import { assertFluidCapture } from "./fluid-collision-proof.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "examples/prd476-fluid-particles");
const output = path.join(root, "artifacts/fluid-collision");
await mkdir(output, { recursive: true });
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const inputs = [
  "packages/core/src/fluid-particles.ts",
  "packages/core/src/gpu-readback.ts",
  "packages/core/patches/three@0.185.1.patch",
  "examples/prd476-fluid-particles/src/collision-proof.ts",
  "examples/prd476-fluid-particles/playtests/fluid-collision.playtest.json",
  "examples/prd476-fluid-particles/proof.html",
  "examples/prd476-fluid-particles/proof.vite.config.ts",
  "scripts/fluid-collision-proof.ts",
  "scripts/verify-fluid-collision.ts",
];
// Never label uncommitted shader/fixture bytes with the repository's previous HEAD.
execFileSync("git", ["ls-files", "--error-unmatch", "--", ...inputs], { cwd: root });
execFileSync("git", ["diff", "--quiet", "HEAD", "--", ...inputs], { cwd: root });
const sourceFiles = await Promise.all(
  inputs.map(async (filename) => ({
    filename,
    sha256: createHash("sha256")
      .update(await readFile(path.join(root, filename)))
      .digest("hex"),
  })),
);
const qualification = "Rendered browser GPU correctness; no native or hardware-performance claim.";
const variants = [];
try {
  execFileSync("pnpm", ["exec", "vite", "build", "--config", "proof.vite.config.ts"], {
    cwd: project,
    stdio: "inherit",
  });
  for (const variant of ["gate", "gate-disabled"] as const) {
    const artifactDirectory = path.join(output, variant);
    const report = await runStandalonePlaytest({
      allowSoftwareAdapter: true,
      artifactDirectory,
      browserArgs: [...WEBGPU_BROWSER_ARGS],
      headless: false,
      port: 0,
      projectPath: project,
      scenarioPath: "playtests/fluid-collision.playtest.json",
      server: {
        command:
          "pnpm exec vite preview --config proof.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      timeoutMs: 120_000,
      trace: false,
      url: `http://127.0.0.1:5173/proof.html${variant === "gate-disabled" ? "?gate=off" : ""}`,
    });
    for (const [phase, completedScopes] of [
      ["before", 1],
      ["after", 2],
    ] as const) {
      const gpu = report.observations?.resources.FluidGPU?.[phase] as
        | Record<string, unknown>
        | undefined;
      assert.equal(
        gpu?.completedScopes,
        completedScopes,
        "Actual GPU validation must complete before sampling",
      );
      assert.equal(gpu?.errors, 0, "Actual GPU validation must be clean");
    }
    const images = [];
    for (const filename of ["before.png", "after.png"]) {
      const bytes = await readFile(path.join(artifactDirectory, filename));
      assert.ok(bytes.length > 0, `${variant}: empty screenshot`);
      images.push({ filename, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    variants.push({
      variant,
      pass: report.pass,
      adapter: report.capture?.adapter,
      rendererKind: report.capture?.rendererKind,
      assertions: report.assertionResults?.map(({ id, pass }) => ({ id, pass })),
      diagnostics: report.diagnostics.map(({ code }) => code),
      measurements: report.observations?.resources.FluidCollision,
      gpuValidation: report.observations?.resources.FluidGPU,
      images,
    });
    await writeFile(
      path.join(output, "summary.json"),
      `${JSON.stringify({ sourceSha, sourceFiles, qualification, variants }, null, 2)}\n`,
    );
    assertFluidCapture(
      report,
      variant === "gate-disabled" ? "resource.FluidCollision.collisionPassed" : undefined,
    );
  }
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify({ sourceSha, sourceFiles, qualification, expectedOutcomesPassed: true, variants }, null, 2)}\n`,
  );
  console.log(
    "Fluid collision: actual gate passed and missing-gate control failed only the collision assertion.",
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    `${JSON.stringify({ sourceSha, qualification, pass: false }, null, 2)}\n`,
  );
  throw error;
}
