import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { assertCaptureNotBlank } from "../packages/playtest/dist/capture.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import { requireTemporalRenderEvidence } from "./temporal-aa-evidence.js";
import { type ILinearFrame, linearFrame, measureSequence } from "./temporal-aa-quality.js";

/** Motion-family arms under test; `supersampled` is the 4x reference every arm is scored against. */
const ARMS = ["supersampled", "reference", "temporal", "zero-velocity"];
const REFERENCE_ARM = "supersampled";
/** temporal may not exceed this share of the no-AA reference's moving-edge error. */
const GHOST_MAX_RATIO = 0.75;
/** zero-velocity must degrade the metric by at least this factor versus temporal. */
const ZERO_VELOCITY_MIN_RATIO = 1.25;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RAW4 = process.env.TN_RAW4 === "1";
const output = path.join(root, `artifacts/temporal-aa/ghosting${RAW4 ? "-raw4" : ""}`);
const scenario = JSON.parse(
  await readFile(
    path.join(root, "examples/abyss-framework/playtests/temporal-motion.playtest.json"),
    "utf8",
  ),
);
// Hardware WebGPU is opt-in (TN_WEBGPU_HARDWARE=1): the Vulkan/ANGLE flags lose the device on a runner
// without a GPU. Without them a headless Linux run serves WebGPU from SwiftShader, so the adapter is
// always recorded in the summary.
const HARDWARE_WEBGPU_ARGS = [
  "--enable-unsafe-webgpu",
  "--enable-features=Vulkan",
  "--use-angle=vulkan",
  "--use-vulkan",
  "--disable-vulkan-surface",
  "--no-sandbox",
];
const frames: Record<string, ILinearFrame[]> = {};
const provenance = [];
for (const variant of ARMS) {
  const artifactDirectory = path.join(output, variant);
  await mkdir(artifactDirectory, { recursive: true });
  const scale = variant.endsWith("supersampled") ? 4 : 1;
  const scenarioPath = path.join(artifactDirectory, "scenario.json");
  await writeFile(
    scenarioPath,
    JSON.stringify({ ...scenario, viewport: { width: 640 * scale, height: 360 * scale } }, null, 2),
  );
  const report = await runStandalonePlaytest({
    allowSoftwareAdapter: true,
    artifactDirectory,
    browserArgs: [
      ...WEBGPU_BROWSER_ARGS,
      ...(process.env.TN_WEBGPU_HARDWARE === "1" ? HARDWARE_WEBGPU_ARGS : []),
    ],
    headless: false,
    port: 0,
    projectPath: path.join(root, "examples/abyss-framework"),
    scenarioPath,
    server: {
      command:
        "pnpm exec vite build --config temporal.vite.config.ts && pnpm exec vite preview --config temporal.vite.config.ts --host 127.0.0.1 --port $PORT --strictPort",
      timeoutMs: 60_000,
    },
    timeoutMs: 120_000,
    trace: false,
    url: `http://127.0.0.1:5173/temporal.html?measure&variant=${variant}${RAW4 ? "&raw4" : ""}`,
  }).catch(async (error: unknown) => {
    await writeFile(
      path.join(artifactDirectory, "failure.json"),
      JSON.stringify(
        { variant, error: error instanceof Error ? error.stack : String(error) },
        null,
        2,
      ),
    );
    throw error;
  });
  await writeFile(path.join(artifactDirectory, "report.json"), JSON.stringify(report, null, 2));
  requireTemporalRenderEvidence(report, variant);
  const series = report.observations?.resourceSeries;
  assert.ok(series);
  assert.equal(series.length, 16, `${variant}: every captured frame needs an observation`);
  const currentFrames: ILinearFrame[] = [];
  frames[variant] = currentFrames;
  const hashes = [];
  for (let index = 0; index < 16; index++) {
    const frame = index + 21;
    const filename = `frame-${frame}.png`;
    const bytes = await readFile(path.join(artifactDirectory, filename));
    const stats = assertCaptureNotBlank(bytes, `${variant}/${filename}`);
    assert.deepEqual([stats.width, stats.height], [640 * scale, 360 * scale]);
    currentFrames.push(linearFrame(PNG.sync.read(bytes), 640, 360));
    hashes.push({ frame, filename, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  provenance.push({ variant, capture: report.capture, hashes });
}
const reference = frames[REFERENCE_ARM];
assert.ok(reference, `${REFERENCE_ARM} frames required`);
const results: Record<string, ReturnType<typeof measureSequence>> = {};
for (const variant of ARMS) {
  const sequence = frames[variant];
  assert.ok(sequence);
  results[variant] = measureSequence(reference, sequence, 8);
}
const temporal = results.temporal;
const referenceArm = results.reference;
const zeroVelocity = results["zero-velocity"];
assert.ok(temporal && referenceArm && zeroVelocity);
assert.ok(
  temporal.movingEdgeError !== null &&
    referenceArm.movingEdgeError !== null &&
    zeroVelocity.movingEdgeError !== null,
  "Moving-object edges must be measurable",
);
const temporalProvenance = provenance.find((arm) => arm.variant === "temporal");
assert.ok(temporalProvenance);
const adapter = {
  vendor: temporalProvenance.capture?.adapter.vendor ?? null,
  architecture: temporalProvenance.capture?.adapter.architecture ?? null,
};
const sourceSha = execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
const ghostRatio = temporal.movingEdgeError / referenceArm.movingEdgeError;
const zeroVelocityRatio = zeroVelocity.movingEdgeError / temporal.movingEdgeError;
const pass = ghostRatio <= GHOST_MAX_RATIO && zeroVelocityRatio >= ZERO_VELOCITY_MIN_RATIO;
const summary = {
  movingEdgeError: {
    supersampled: results.supersampled?.movingEdgeError ?? null,
    reference: referenceArm.movingEdgeError,
    temporal: temporal.movingEdgeError,
    zeroVelocity: zeroVelocity.movingEdgeError,
  },
  ratios: { ghost: ghostRatio, zeroVelocity: zeroVelocityRatio },
  thresholds: { GHOST_MAX_RATIO, ZERO_VELOCITY_MIN_RATIO },
  adapter,
  sourceSha,
  pass,
};
await writeFile(path.join(output, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
assert.ok(
  pass,
  `Temporal ghosting unqualified: temporal ${temporal.movingEdgeError} reference ${referenceArm.movingEdgeError} zeroVelocity ${zeroVelocity.movingEdgeError} (ratios ${ghostRatio}, ${zeroVelocityRatio})`,
);
console.log(
  `Temporal ghosting: temporal ${temporal.movingEdgeError} reference ${referenceArm.movingEdgeError} zeroVelocity ${zeroVelocity.movingEdgeError} (ratios ${ghostRatio}, ${zeroVelocityRatio})`,
);
