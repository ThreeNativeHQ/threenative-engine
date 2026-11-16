import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { workflowBlockScalars } from "./runtime-test-utils.js";
import {
  OVERLAY_ANCHOR,
  OVERLAY_VIEWPORTS,
  assertAnchorHeld,
  assertRenderedSize,
  overlayRenderPlan,
} from "../conformance/overlay-anchor.mjs";
import {
  createProjectRegistry,
  projectId,
  resolveParityProject,
} from "../conformance/project-mode.mjs";
import {
  androidEmulatorBlocker,
  assertAndroidEmulator,
  buildProvenance,
  defaultDesktopRuntimePath,
  desktopRuntimeBuildCommands,
  prepareDesktopRuntime,
  validateRegistry,
  validateReport,
} from "../conformance/run-conformance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function registry() {
  return JSON.parse(read("conformance/registry.json"));
}

test("the parity registry implements Tier 1 and Tier 2 rows and documents exclusions", () => {
  const value = registry();
  assert.deepEqual(validateRegistry(value), []);
  for (const id of [
    "10-mesh-basic-material",
    "11-mesh-standard-material",
    "12-pbr-material",
    "13-texture-material",
    "14-transparent-material",
    "15-mesh-toon-material-gradientmap",
    "16-vertex-colors",
    "17-shadow-map",
    "18-fog",
    "19-double-sided",
    "20-ambient-light",
    "21-directional-light",
    "22-hemisphere-light",
    "23-point-light",
    "24-spot-light",
    "25-camera-parented-overlay",
    "26-orthographic-camera",
    "27-instanced-mesh",
    "28-shape-geometry",
    "29-line-segments",
    "90-document-window-stubs",
    "91-local-storage",
    "92-worker",
    "93-offscreen-canvas",
    "94-audio-context",
    "95-timers",
    "96-create-image-bitmap",
  ]) {
    const row = value.tests.find((entry) => entry.id === id);
    assert.equal(row?.status, "implemented", `${id} must be implemented`);
    assert.ok(row?.scene && existsSync(join(root, row.scene)), `${id} scene must exist`);
  }
  assert.deepEqual(value.exclusions.map(({ id, owner }) => [id, owner]), [
    ["react-dom-tailwind-hud", "PRD-055"],
    ["rapier-wasm-mobile", "PRD-046"],
    ["recast-wasm-mobile", "PRD-052"],
    ["raw-glsl-shader-material-webgpu", "PRD-054"],
    // Moved from PRD-064 on 2026-08-15. The exclusion's reason was "the desktop lane has no
    // native multitouch injector"; it has one, and what it lacks is a host that delivers what
    // the injector writes. PRD-077 owns that finding, so it owns the exclusion.
    ["desktop-multitouch-input", "PRD-077"],
    ["android-canvas2d-document-window-stubs", "runtime-native"],
    ["android-hardware-canvas2d-document-window-stubs", "runtime-native"],
    // The gather's desktop comparison failed on the merge queue's llvmpipe runner while the web
    // lane passed the same row; PRD-644 AC-1 owns the desktop proof and removes the exclusion when
    // the row passes there.
    ["screen-probe-gather-desktop", "PRD-644"],
  ]);
});

test("registry validation rejects undocumented or malformed exclusions", () => {
  const value = registry();
  const malformed = structuredClone(value);
  malformed.exclusions[0].owner = "";
  malformed.exclusions[1].reason = "";
  malformed.exclusions[2].status = "planned";
  const errors = validateRegistry(malformed).join("\n");
  assert.match(errors, /owner must be a non-empty string/u);
  assert.match(errors, /reason must be a non-empty string/u);
  assert.match(errors, /status must be excluded/u);
});

test("execution reports have only pass, fail, and blocked states", () => {
  const value = registry();
  const results = value.tests.map(({ id }) => ({ id, status: "blocked" }));
  const report = {
    schemaVersion: "0.3.0",
    registrySchemaVersion: value.schemaVersion,
    threeVersion: value.threeVersion,
    mode: "execution",
    target: "desktop",
    provenance: buildProvenance(),
    summary: { pass: 0, fail: 0, blocked: results.length, planned: 0, validated: 0 },
    results,
  };
  assert.deepEqual(validateReport(report, value), []);
  report.results[0].status = "planned";
  assert.match(validateReport(report, value).join("\n"), /may not use status planned/u);
});

test("an excluded desktop row cannot be claimed as a pass", () => {
  const value = registry();
  const results = value.tests.map(({ id }) => ({ id, status: "blocked" }));
  const row = results.find(({ id }) => id === "90-multitouch-input");
  Object.assign(row, {
    status: "pass",
    browser: { completed: true, uniform: false },
    native: { completed: true, uniform: false },
    metrics: { pixelMismatchRatio: 0, perceptualDeltaE: 0 },
    gpuValidationErrors: [],
  });
  const report = {
    schemaVersion: "0.3.0",
    registrySchemaVersion: value.schemaVersion,
    threeVersion: value.threeVersion,
    mode: "execution",
    target: "desktop",
    provenance: buildProvenance(),
    summary: { pass: 1, fail: 0, blocked: results.length - 1, planned: 0, validated: 0 },
    results,
  };
  assert.match(validateReport(report, value).join("\n"), /desktop-multitouch-input is excluded/u);
});

test("native captures are inspected for uniformity and marker liveness after settling", () => {
  const runner = read("conformance/run-conformance.mjs");
  assert.match(runner, /const capture = inspectCapture\(png\)/u);
  assert.match(runner, /uniform: capture\.uniform/u);
  assert.match(runner, /Android process died during the \$\{settleMs\} ms settle window/u);
  assert.match(runner, /verifyApkBundle\(apk, bundlePath/u);
  assert.match(runner, /let devices;[\s\S]*TN_PARITY_ANDROID_ADB_BLOCKED/u);
  assert.match(read("android/app/build.gradle.kts"), /buildAndroidConformanceBundle/u);
});

test("project mode keeps the native entry inside the project and gives it a stable row", () => {
  assert.equal(projectId({ root: "/tmp/project" }).length, "project-".length + 12);
  assert.throws(
    () => resolveParityProject("/tmp/does-not-exist-threenative-parity"),
    /TN_PARITY_PROJECT_MISSING/u,
  );
  const project = { root: "/tmp/game", nativeEntry: "src/game.ts" };
  const generated = createProjectRegistry(
    { schemaVersion: "0.1.0", threeVersion: "0.185.1", exclusions: [] },
    "artifacts/conformance/project-scene.js",
    project,
  );
  assert.equal(generated.tests[0].status, "implemented");
  assert.equal(generated.tests[0].captureFrames, 60);
});

test("the desktop lane provisions the runtime from a clean checkout before it runs a row", () => {
  const commands = desktopRuntimeBuildCommands();
  assert.deepEqual(
    commands.map(({ args }) => args[0].split("/").slice(-2).join("/")),
    ["scripts/download-deps.mjs", "scripts/native-build.mjs"],
    "provisioning must run the repository's own dependency download and native build",
  );

  const calls = [];
  const prepared = prepareDesktopRuntime("/nowhere/mystral", {
    env: {},
    exists: (path) => calls.length > 0 && path === "/nowhere/mystral",
    run: (command, args) => calls.push([command, args[0]]),
  });
  assert.equal(calls.length, 2, "a missing runtime provisions instead of failing the row");
  assert.deepEqual(prepared, { runtime: "/nowhere/mystral", blockedReason: null });
});

test("desktop provisioning that cannot run reports blocked, never a failed assertion", () => {
  const failed = prepareDesktopRuntime("/nowhere/mystral", {
    env: {},
    exists: () => false,
    run: () => {
      throw new Error("cmake: command not found");
    },
  });
  assert.equal(failed.runtime, null);
  assert.match(failed.blockedReason, /TN_PARITY_DESKTOP_RUNTIME_BUILD_BLOCKED/u);
  assert.match(failed.blockedReason, /cmake: command not found/u);

  const silent = prepareDesktopRuntime("/nowhere/mystral", {
    env: {},
    exists: () => false,
    run: () => undefined,
  });
  assert.equal(silent.runtime, null);
  assert.match(silent.blockedReason, /without producing the expected runtime binary/u);

  const configured = prepareDesktopRuntime("/nowhere/mystral", {
    env: { TN_RUNTIME: "/nowhere/mystral" },
    exists: () => false,
    run: () => assert.fail("an explicitly configured runtime must never trigger a build"),
  });
  assert.equal(configured.runtime, null);
  assert.match(configured.blockedReason, /TN_PARITY_DESKTOP_RUNTIME_MISSING/u);

  assert.match(defaultDesktopRuntimePath("linux"), /build\/tn-linux\/mystral$/u);
  assert.match(defaultDesktopRuntimePath("win32"), /build[\\/]tn-windows[\\/]mystral\.exe$/u);
});

test("the emulator lane refuses physical hardware and reports a missing AVD as blocked", () => {
  assert.equal(assertAndroidEmulator({ qemu: "1", hardware: "ranchu" }), "emulator");
  assert.throws(
    () => assertAndroidEmulator({ qemu: "0", hardware: "qcom" }, "R5CT12345"),
    /TN_PARITY_ANDROID_EMULATOR_REQUIRED: R5CT12345/u,
  );

  assert.equal(androidEmulatorBlocker([{ serial: "emulator-5554" }], [], null), null);
  assert.match(
    androidEmulatorBlocker([], [], null),
    /TN_PARITY_ANDROID_AVD_MISSING: .*has no AVD to boot/su,
  );
  assert.match(
    androidEmulatorBlocker([], ["Pixel_6_API_34"], "Pixel_9_API_35"),
    /requested AVD 'Pixel_9_API_35' is not installed. Installed AVDs: Pixel_6_API_34/u,
  );
  assert.equal(androidEmulatorBlocker([], ["Pixel_6_API_34"], null), null);
});

test("CI invokes web references and the Android emulator lane on runtime changes", () => {
  const workflow = readFileSync(join(root, "../../.github/workflows/native-platforms.yml"), "utf8");
  assert.match(workflow, /android-emulator-parity/u);
  assert.match(workflow, /java-version: "17"/u);
  assert.match(workflow, /--target web/u);
  // See conformance-runner.test.mjs: the emulator action folds `script` into one string, so the
  // assertion belongs on the folded command and not on the file's line breaks.
  const emulatorScript = workflowBlockScalars(workflow, "script").find((script) =>
    script.includes("run-conformance.mjs"),
  );
  assert.ok(emulatorScript, "the emulator lane has no run-conformance script block");
  assert.match(emulatorScript, /--target android --device emulator-5554/u);
});

test("the camera-parented overlay row resizes for real and observes the drawing buffer", () => {
  assert.equal(OVERLAY_VIEWPORTS.length, 4);
  assert.deepEqual(
    overlayRenderPlan({ height: 720, width: 1280 }).at(-1),
    { height: 720, width: 1280 },
    "the row must return to the capture size so the reference comparison still applies",
  );
  assert.equal(overlayRenderPlan({ height: 900, width: 1600 }).length, 5);

  // A renderer that ignored setSize leaves the drawing buffer at its old size. That must throw.
  assert.throws(
    () => assertRenderedSize({ height: 1280, width: 720 }, { height: 720, width: 1280 }),
    /TN_CONFORMANCE_RESIZE_NOT_APPLIED/u,
  );
  assert.throws(
    () => assertRenderedSize({ height: 720, width: 1280 }, undefined),
    /TN_CONFORMANCE_RESIZE_NOT_APPLIED/u,
  );
  assert.deepEqual(
    assertRenderedSize({ height: 720, width: 1280 }, { height: 720, width: 1280 }),
    { height: 720, width: 1280 },
  );

  const anchored = { x: OVERLAY_ANCHOR.x + 48, y: OVERLAY_ANCHOR.y + 14 };
  assert.deepEqual(assertAnchorHeld({ height: 768, width: 1024 }, anchored), anchored);
  assert.throws(
    () => assertAnchorHeld({ height: 768, width: 1024 }, { x: anchored.x + 6, y: anchored.y }),
    /TN_CONFORMANCE_OVERLAY_ANCHOR_DRIFTED/u,
  );
  assert.throws(
    () => assertAnchorHeld({ height: 768, width: 1024 }, { x: Number.NaN, y: anchored.y }),
    /TN_CONFORMANCE_OVERLAY_ANCHOR_DRIFTED/u,
  );

  // The scene must actually call both, against the canvas rather than the requested numbers,
  // and derive its viewports from the plan. The loop carries the PRD-166 trace ladder
  // (viewport-begin/set-size-returned/render-returned/viewport-passed), so the shape is
  // index-based rather than for-of; the ladder is what names a native death for logcat.
  const scene = read("conformance/scenes/shared/camera-parented-overlay.js");
  assert.match(scene, /renderer\.setSize\(size\.width, size\.height, false\)/u);
  assert.match(scene, /assertRenderedSize\(size, \{ height: canvas\.height, width: canvas\.width \}\)/u);
  assert.match(scene, /const plan = overlayRenderPlan\(dimensions\)/u);
  assert.match(scene, /for \(let index = 0; index < plan\.length; index \+= 1\)/u);
  assert.match(scene, /trace\("set-size-returned"/u);
  assert.match(scene, /trace\("viewport-passed"/u);
});
