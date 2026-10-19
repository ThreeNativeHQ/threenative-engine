import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { loadPlaytestScenario } from "../packages/playtest/dist/index.js";
import {
  WEBGPU_BROWSER_ARGS,
  runStandalonePlaytest,
} from "../packages/playtest/dist/runner/index.js";
import {
  fogCaptureIsValid,
  fogCaptureScenario,
  qualifyFogExposureControls,
} from "./verify-volumetric-fog.js";

import { defaultCaptureLockRoot } from "../packages/playtest/src/runner/captureLock.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const fixture = path.join(root, "examples/abyss-framework/vq-fog");
const artifacts = path.join(root, "artifacts/consolidation/joint-gpu");
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() !== "")
  throw new Error("Joint GPU qualification requires a clean committed source tree.");
const lockRoot = defaultCaptureLockRoot();
if (lockRoot !== "/tmp/threenative-playtest-capture")
  throw new Error(`Joint GPU requires the normal shared lease root, received ${lockRoot}`);
const holderPath = path.join(lockRoot, "lock/holder.json");
const leaseRecords: Record<string, unknown>[] = [];
let currentArm = "";
const cases = ["off", "fog", "exposure", "both", "repeat", "rebuild-resize", "dispose"] as const;
const controls: Parameters<typeof qualifyFogExposureControls>[0] = {};
const outcomes: Record<string, unknown>[] = [];
const summary = {
  lockRoot,
  holderPath,
  leaseRecords,
  sourceSha: sha,
  pass: false,
  outcomes,
  qualification:
    "Actual browser WebGPU functional integration; adapter recorded per arm, no performance or native claim.",
};
await mkdir(artifacts, { recursive: true });
execFileSync(
  process.execPath,
  [
    "examples/abyss-framework/node_modules/vite/bin/vite.js",
    "build",
    "--config",
    path.join(fixture, "vite.config.ts"),
  ],
  { cwd: root, stdio: "inherit" },
);
const bundleFiles = await readFile(path.join(fixture, "dist/index.html"));
const bundleIndexSha256 = createHash("sha256").update(bundleFiles).digest("hex");
// Let the public runner acquire/release the normal global lease for each serial arm.
// An outer lease would deadlock when the runner detects its own live holder.
process.env.CAPTURE_LOCK = "1";
process.env.CAPTURE_LOCK_TIMEOUT_MS = "60000";
const observer = setInterval(() => {
  try {
    const holder = JSON.parse(readFileSync(holderPath, "utf8"));
    if (holder.pid !== process.pid || leaseRecords.some((record) => record.arm === currentArm))
      return;
    const record = { arm: currentArm, holderPath, holder, observedAt: new Date().toISOString() };
    leaseRecords.push(record);
    console.info(`JOINT_GPU_LEASE:${JSON.stringify(record)}`);
  } catch {
    /* A released lease has no holder; read-only observation never alters it. */
  }
}, 250);
console.info(`JOINT_GPU_START:${sha}`);
try {
  for (const name of cases) {
    currentArm = name;
    const fog = name !== "off" && name !== "exposure";
    const exposure = !["off", "fog"].includes(name);
    const scenario = fogCaptureScenario(fog ? "fog" : "off", fog ? "KeyF" : "KeyO");
    scenario.name = `joint-fog-exposure-${name}`;
    const wait = { kind: "wait" as const, waitFrames: 60, release: true };
    const action = (key: string) => ({ press: [key], holdTicks: 1, release: true });
    const textureBoundary = {
      waitForResource: { id: "state", path: "stableTextureFrames", gte: 3 },
      timeoutMs: 30_000,
      release: true,
    };
    const freshReadback = {
      waitForResource: { id: "state", path: "exposureFreshSamples", gte: 1 },
      timeoutMs: 30_000,
      release: true,
    };
    const resource = (key: string, equals: number | boolean) => ({
      waitForResource: { id: "state", path: key, equals },
      timeoutMs: 30_000,
      release: true,
    });
    if (exposure)
      scenario.steps.push(
        action("Digit9"),
        wait,
        textureBoundary,
        freshReadback,
        resource("exposureSettled", true),
      );
    if (name === "rebuild-resize")
      scenario.steps.push(
        action("KeyC"),
        wait,
        textureBoundary,
        freshReadback,
        resource("exposureSettled", true),
        action("KeyR"),
        wait,
        textureBoundary,
        resource("targetWidth", 320),
        resource("targetHeight", 240),
        freshReadback,
        resource("exposureSettled", true),
        action("KeyT"),
        wait,
        textureBoundary,
        resource("targetWidth", 640),
        resource("targetHeight", 400),
        freshReadback,
        resource("exposureSettled", true),
      );
    if (name === "dispose") {
      scenario.steps.push(
        action("Digit0"),
        wait,
        textureBoundary,
        action("KeyO"),
        wait,
        textureBoundary,
      );
      const targets = scenario.assert?.components?.find((c) => c.component === "targets");
      const mode = scenario.assert?.components?.find((c) => c.component === "mode");
      if (targets !== undefined) targets.equals = 0;
      if (mode !== undefined) mode.equals = "off";
      scenario.assert?.components?.push(
        ...["liveTargets", "exposureApplied"].map((component) => ({
          entity: "fog",
          component,
          equals: component === "liveTargets" ? 0 : false,
          allowTrivial: "Actual graph disposal must return to the off ownership baseline.",
        })),
        { entity: "fog", component: "releasedExposures", gte: 1, changed: true },
      );
    } else if (exposure)
      scenario.assert?.components?.push(
        ...["exposureApplied", "exposureMeasured", "exposureSettled"].map((component) => ({
          entity: "fog",
          component,
          equals: true,
          allowTrivial: "Capture requires actual finite settled GPU readback.",
        })),
      );
    const directory = path.join(artifacts, name);
    await mkdir(directory, { recursive: true });
    const scenarioPath = path.join(directory, "scenario.playtest.json");
    await writeFile(scenarioPath, JSON.stringify(scenario, null, 2));
    await loadPlaytestScenario(root, scenarioPath);
    const report = await runStandalonePlaytest({
      artifactDirectory: directory,
      projectPath: fixture,
      scenarioPath,
      target: "browser",
      headless: false,
      allowSoftwareAdapter: true,
      browserArgs: WEBGPU_BROWSER_ARGS,
      port: 0,
      url: "http://127.0.0.1:5173/",
      timeoutMs: 120_000,
      trace: false,
      server: {
        cwd: root,
        command:
          "node examples/abyss-framework/node_modules/vite/bin/vite.js preview --config examples/abyss-framework/vq-fog/vite.config.ts --host 127.0.0.1 --port ${PORT}",
        timeoutMs: 60_000,
      },
    });
    const state = report.observations?.resources?.state?.after as
      | Record<string, unknown>
      | undefined;
    const valid = fogCaptureIsValid(report);
    outcomes.push({
      name,
      sourceSha: sha,
      bundleIndexSha256,
      pass: valid,
      capture: report.capture,
      diagnostics: report.diagnostics,
      state,
    });
    await writeFile(path.join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
    if (!valid || state === undefined) throw new Error(`Joint ${name}: runtime/capture rejected.`);
    const png = PNG.sync.read(await readFile(path.join(directory, "after.png")));
    if (png.width !== 640 || png.height !== 400)
      throw new Error(`Joint ${name}: viewport mismatch.`);
    controls[name] = { pixels: png.data, state };
    if (
      name === "rebuild-resize" &&
      (state.releasedExposures !== 1 ||
        state.liveTargets !== 1 ||
        state.targetWidth !== 640 ||
        state.targetHeight !== 400 ||
        state.exposureMeasured !== true ||
        state.exposureSettled !== true ||
        Number(state.exposureLuminance) <= 0 ||
        !Number.isFinite(state.exposureLuminance) ||
        !Number.isFinite(state.exposureStops))
    )
      throw new Error("Combined rebuild/resize did not preserve a finite live graph.");
  }
  if (controls.dispose?.state.textures !== controls.off?.state.textures)
    throw new Error(
      "Combined disposal did not return actual renderer texture memory to the off control baseline.",
    );
  outcomes.push({ response: qualifyFogExposureControls(controls) });
  summary.pass = true;
} finally {
  clearInterval(observer);
  await writeFile(path.join(artifacts, "summary.json"), JSON.stringify(summary, null, 2));
  console.info(`JOINT_GPU_TERMINAL_RELEASE:${sha}:${summary.pass}`);
}
