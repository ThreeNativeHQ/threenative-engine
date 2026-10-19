import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import {
  assertFluidCapture,
  fluidConsumerFailureDiagnostics,
  fluidConsumerFailureEvidence,
} from "./fluid-collision-proof.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const project = path.join(root, "examples/prd476-fluid-particles");
const output = path.join(root, "artifacts/fluid-consumers");
await mkdir(output, { recursive: true });
assert.equal(
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  "",
  "Fluid consumer proof requires clean committed source",
);
const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const qualification =
  "Existing consumer correctness on browser WebGPU; no hardware frame-time claim.";
const variants = [];
let activeVariant: "dam" | "coupling" | undefined;
let lastReport: Parameters<typeof fluidConsumerFailureEvidence>[0];
let failureDiagnostics: ReturnType<typeof fluidConsumerFailureDiagnostics> = null;
try {
  execFileSync("pnpm", ["exec", "vite", "build"], { cwd: project, stdio: "inherit" });
  for (const variant of ["dam", "coupling"] as const) {
    activeVariant = variant;
    failureDiagnostics = null;
    lastReport = undefined;
    const directory = path.join(output, variant);
    const scenario =
      variant === "dam"
        ? "fluid-particles.playtest.json"
        : "fluid-particles-coupling.playtest.json";
    const report = await runStandalonePlaytest({
      artifactDirectory: directory,
      projectPath: project,
      scenarioPath: `playtests/${scenario}`,
      port: 0,
      allowSoftwareAdapter: true,
      browserArgs: [
        ...WEBGPU_BROWSER_ARGS,
        ...(process.env.TN_FLUID_CI_OBSERVER === "1" ? ["--enable-logging=stderr"] : []),
      ],
      headless: false,
      timeoutMs: 600_000,
      trace: false,
      server: {
        command: "pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort",
        timeoutMs: 60_000,
      },
      url: `http://127.0.0.1:5173/${variant === "coupling" ? "?scene=coupling" : ""}`,
    });
    lastReport = report;
    failureDiagnostics = fluidConsumerFailureDiagnostics(report.diagnostics);
    assertFluidCapture(report);
    const filenames = (await readdir(directory)).filter((name) => name.endsWith(".png"));
    const authoredImages =
      variant === "dam"
        ? ["gated.png", "running.png", "settled.png", "after.png"]
        : ["falling.png", "splash.png", "settled.png", "after.png"];
    assert.ok(
      authoredImages.every((name) => filenames.includes(name)),
      "Consumer screenshots must include every authored step and final image",
    );
    const images = await Promise.all(
      filenames.map(async (filename) => ({
        filename,
        sha256: createHash("sha256")
          .update(await readFile(path.join(directory, filename)))
          .digest("hex"),
      })),
    );
    variants.push({
      variant,
      adapter: report.capture?.adapter,
      assertions: report.assertionResults?.map(({ id, pass }: { id: string; pass: boolean }) => ({
        id,
        pass,
      })),
      images,
    });
    await writeFile(
      path.join(output, "summary.json"),
      `${JSON.stringify({ sourceSha, qualification, variants }, null, 2)}\n`,
    );
  }
  await writeFile(
    path.join(output, "summary.json"),
    `${JSON.stringify({ sourceSha, qualification, pass: true, variants }, null, 2)}\n`,
  );
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    `${JSON.stringify({ sourceSha, qualification, pass: false, variant: activeVariant, diagnostics: failureDiagnostics, evidence: fluidConsumerFailureEvidence(lastReport, error) }, null, 2)}\n`,
  );
  throw error;
}
