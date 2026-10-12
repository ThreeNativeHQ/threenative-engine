import { makeTempDirSync } from '../../../test-support/temp-dir.js';
import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { createRequire, syncBuiltinESMExports } from "node:module";
import * as esbuild from "esbuild";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { afterEach, expect, test, vi } from "vitest";
import { workflowBlockScalars } from "./runtime-test-utils.js";
import { absoluteErrorRatio } from "../conformance/metrics.mjs";
import { isMultitouchProofSatisfied } from "../conformance/multitouch-proof.mjs";
import {
  compareCaptures,
  compareScreenSpaceGlyphs,
  inspectCapture,
  inspectScreenSpaceGlyphs,
} from "../conformance/metrics.mjs";
import {
  androidMultitouchArgs,
  shouldRunAndroidMultitouch,
} from "../conformance/parity-extras.mjs";
import {
  createProjectRegistry,
  projectId,
  resolveParityProject,
} from "../conformance/project-mode.mjs";
import {
  bundle,
  androidDeviceKind,
  androidDeathExcerpt,
  androidDependencyBlocker,
  ANDROID_CAPTURE_SIZE,
  androidDisplayRestoreTarget,
  androidRotationRestoreTarget,
  androidDisplaySize,
  androidForegroundBlocker,
  androidLog,
  androidWindowDump,
  androidFocusedWindowOwner,
  androidSystemDialog,
  buildProvenance,
  captureBrowserCanvas,
  hardwareAdapterBlocker,
  missingHardwareReferenceBlocker,
  makeEntry,
  launchAndroidConformanceActivity,
  runCommand,
  validateWindowedSurfaceOutput,
  temporalCaptureLabel,
  unexpectedBlockedRows,
  expiredExclusions,
  reportExitCode,
  validateRegistry,
  validateReport,
} from "../conformance/run-conformance.mjs";
import { SDL3_ANDROID_VERSION } from "../scripts/package-android.mjs";
import {
  buildAndroidConformanceAsset,
  parseConformanceBundleArgs,
} from "../scripts/build-android-conformance.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const runner = join(root, "conformance/run-conformance.mjs");
const SDL3_AAR = `SDL3-${SDL3_ANDROID_VERSION}.aar`;

function run(args, env = {}) {
  return spawnSync(process.execPath, [runner, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      // A runner spawned by a test is a nested lane, never the outermost one: it must not
      // register its own parity lease, or it collides with the live lease the suite wrapper
      // (run-test-suite.sh) already holds and every package-test run fails TN_WORKTREE_OWNED.
      TN_GATE_NESTED: "1",
      ...process.env,
      ...env,
    },
    timeout: 120_000,
  });
}

test("a software adapter blocks a hardware row instead of failing it", () => {
  // GitHub-hosted runners expose SwiftShader. Every realism row sets requiresHardwareAdapter, and
  // reporting them as failures claimed 13 effects were measured and wrong on a machine that never
  // ran them; the same rows pass on a real adapter.
  const swiftshader = hardwareAdapterBlocker(
    'TN_CONFORMANCE_HARDWARE_ADAPTER_REQUIRED:{"architecture":"swiftshader","vendor":"google"}',
  );
  assert.match(swiftshader, /Requires a hardware GPU adapter/u);
  assert.match(swiftshader, /swiftshader/u);

  // A genuine failure must stay a failure.
  assert.equal(hardwareAdapterBlocker("TN_CONFORMANCE_FROZEN_TEMPORAL_HISTORY:realism-taa"), null);
  assert.equal(hardwareAdapterBlocker("Error: page crashed"), null);
  assert.equal(hardwareAdapterBlocker(undefined), null);
});

test("native lanes do not launch hardware rows without a browser reference", () => {
  const missing = "/tmp/three-native-missing-hardware-reference.png";
  assert.match(
    missingHardwareReferenceBlocker({ requiresHardwareAdapter: true }, missing, () => false),
    /Missing browser reference capture/u,
  );
  assert.equal(
    missingHardwareReferenceBlocker({ requiresHardwareAdapter: false }, missing, () => false),
    null,
  );
  assert.equal(
    missingHardwareReferenceBlocker({ requiresHardwareAdapter: true }, missing, () => true),
    null,
  );
});

test("the GPU scene BVH row requires a hardware adapter", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const row = registry.tests.find(({ id }) => id === "76-gpu-scene-bvh");
  assert.equal(row?.requiresHardwareAdapter, true);
});

test("a SwiftShader lane blocks only the rows it is allowed to leave unrun", () => {
  // Fixture is the real web report from the Android parity run that failed on 2026-08-31, with the
  // adapter refusals reclassified the way the runner now reports them.
  const report = JSON.parse(
    readFileSync(join(root, "tests/fixtures/web-report-swiftshader.json"), "utf8"),
  );
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  assert.equal(report.summary.blocked, 15);
  assert.deepEqual(unexpectedBlockedRows(report, registry), []);

  // A row blocked for any other reason is a lane defect and must not hide inside the allowance.
  const broken = {
    ...report,
    results: [...report.results, { id: "01-basic-cube", status: "blocked", blockedReason: "timed out" }],
  };
  assert.deepEqual(unexpectedBlockedRows(broken, registry), [
    { id: "01-basic-cube", reason: "timed out" },
  ]);

  // So is a hardware row blocked without the adapter reason.
  const mislabelled = {
    ...report,
    results: [{ id: "realism-ssr", status: "blocked", blockedReason: "bundle failed" }],
  };
  assert.deepEqual(unexpectedBlockedRows(mislabelled, registry), [
    { id: "realism-ssr", reason: "bundle failed" },
  ]);

  const missingHardwareReference = {
    ...report,
    results: [{
      id: "realism-ssr",
      status: "blocked",
      blockedReason: "Missing browser reference capture: /tmp/realism-ssr.png",
    }],
  };
  assert.deepEqual(unexpectedBlockedRows(missingHardwareReference, registry), []);
});

test("a registered, unexpired exclusion is an expected block; anything else is not", () => {
  // The desktop parity lane failed on every run before this: `desktop-multitouch-input` has been
  // registered, owned by PRD-077 and dated since 2026-08-15, the runner blocks the row with a
  // TN_PARITY_ROW_EXCLUDED reason that names it — and this gate had never heard of the exclusion
  // list, so it reported the row as an unexpected lane defect and `check-lane-blocks.mjs` exited 1.
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const exclusion = registry.exclusions.find(({ id }) => id === "desktop-multitouch-input");
  assert.equal(exclusion?.target, "desktop");
  assert.equal(exclusion?.row, "90-multitouch-input");

  const blockedReason = `TN_PARITY_ROW_EXCLUDED: ${exclusion.id} — host constraint.`;
  const report = {
    target: "desktop",
    results: [{ id: exclusion.row, status: "blocked", blockedReason }],
    summary: { blocked: 1, fail: 0, pass: 0 },
  };
  const before = Date.parse(`${exclusion.expires}T00:00:00.000Z`) - 1;
  assert.deepEqual(unexpectedBlockedRows(report, registry, before), []);

  // Expiry still bites. `expiredExclusions` exits 2 for a lapsed entry; forgiving it here as well
  // would leave the date enforcing nothing at all.
  const after = Date.parse(`${exclusion.expires}T00:00:00.000Z`);
  assert.deepEqual(unexpectedBlockedRows(report, registry, after), [
    { id: exclusion.row, reason: blockedReason },
  ]);

  // The marker is not a free pass: the same row on a lane the exclusion does not name is a defect.
  assert.deepEqual(
    unexpectedBlockedRows({ ...report, target: "android" }, registry, before),
    [{ id: exclusion.row, reason: blockedReason }],
  );

  // And a marker with no registry entry behind it stays a defect too.
  const unregistered = {
    ...report,
    results: [{
      id: "01-basic-cube",
      status: "blocked",
      blockedReason: "TN_PARITY_ROW_EXCLUDED: invented-on-the-spot",
    }],
  };
  assert.deepEqual(unexpectedBlockedRows(unregistered, registry, before), [
    { id: "01-basic-cube", reason: "TN_PARITY_ROW_EXCLUDED: invented-on-the-spot" },
  ]);
});

test("the runner applies an active target exclusion before native prerequisites", () => {
  const out = makeTempDirSync("threenative-row-exclusion-");
  try {
    const result = run([
      "--target",
      "android-hardware",
      "--device",
      "unavailable",
      "--only-tests",
      "90-document-window-stubs",
      "--out",
      out,
    ]);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8"));
    const row = report.results.find(({ id }) => id === "90-document-window-stubs");
    assert.equal(row?.status, "blocked");
    assert.match(
      row?.blockedReason ?? "",
      /^TN_PARITY_ROW_EXCLUDED: android-hardware-canvas2d-document-window-stubs/u,
    );
  } finally {
    rmSync(out, { force: true, recursive: true });
  }
});

test("both parity ledgers compute their exit cell with the runner's own rule", async () => {
  // The workflow used to restate the rule inline, and the copy knew only `fail` and `blocked`. A
  // report whose Android multitouch proof failed was therefore written down as exit 2 while the
  // runner emits 1, and `parity:ledger` — which recomputes the cell precisely to catch a
  // hand-written number — reported the contradiction on top of the real failure.
  const workflow = readFileSync(
    join(root, "../../.github/workflows/native-platforms.yml"),
    "utf8",
  );
  assert.equal(workflow.includes("summary.fail > 0 ? 1 : summary.blocked > 0 ? 2 : 0"), false);
  assert.equal(workflow.split("reportExitCode(report)").length - 1, 2);

  const { reportExitCode } = await import("../conformance/run-conformance.mjs");
  const summary = { blocked: 18, fail: 0, pass: 74 };
  assert.equal(reportExitCode({ summary }), 2);
  assert.equal(
    reportExitCode({ summary, supplemental: { androidMultitouch: { status: "fail" } } }),
    1,
  );
});

test("velocity conformance captures the motion window instead of the settled frame", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const velocity = registry.tests.find(({ id }) => id === "realism-velocity");
  assert.deepEqual(velocity?.temporal, {
    settledFrame: 8,
    nextFrame: 9,
    assertsDifferenceFromFrameZero: true,
    capture: "settled",
  });
  assert.equal(velocity?.captureFrames, 12);
  assert.equal(temporalCaptureLabel(velocity), "settled");
  assert.equal(temporalCaptureLabel({}), "next");
});

test("browser capture waits for submitted WebGPU work before requesting a compositor screenshot", async () => {
  const dir = makeTempDirSync("threenative-browser-queue-drain-");
  try {
    const scene = "conformance/scenes/shared/first-proof-game.js";
    const ordinaryPath = makeEntry(
      { captureFrames: 2, id: "queue-drain", scene },
      "browser",
      1234,
      dir,
    );
    const ordinary = readFileSync(ordinaryPath, "utf8");
    assert.match(
      ordinary,
      /onSubmittedWorkDone[\s\S]*__tn_conformance__\/complete/u,
      "a software WebGPU queue must finish before its compositor capture is requested",
    );
    assert.doesNotMatch(ordinary, /canvas\.toBlob/u);

    const temporalPath = makeEntry(
      { id: "queue-drain-temporal", scene, temporal: { settledFrame: 2 } },
      "browser",
      1234,
      dir,
    );
    const temporal = readFileSync(temporalPath, "utf8");
    assert.match(
      temporal,
      /captureFrame = async[\s\S]*onSubmittedWorkDone[\s\S]*__tn_conformance__\/complete/u,
      "every temporal frame must drain its queue before capture",
    );

    const calls = [];
    const page = {
      locator(selector) {
        calls.push(["locator", selector]);
        return {
          async screenshot(options) {
            calls.push(["screenshot", options]);
          },
        };
      },
    };
    await captureBrowserCanvas(page, "/tmp/composited.png");
    assert.deepEqual(calls, [
      ["locator", "#c"],
      ["screenshot", { path: "/tmp/composited.png", timeout: 90_000 }],
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("windowed surface proof requires two non-null views and no device error", () => {
  const healthy = [
    'TN_SURFACE_FRAME:{"view":true,"present":1}',
    'TN_SURFACE_FRAME:{"view":true,"present":2}',
    "TN_PRESENTS:2",
  ].join("\n");
  assert.deepEqual(validateWindowedSurfaceOutput(healthy, { frames: 2 }), {
    errors: [],
    frames: 2,
    presents: 2,
  });

  const missingView = healthy.replace('"view":true', '"view":false');
  assert.match(
    validateWindowedSurfaceOutput(missingView, { frames: 2 }).errors.join("\n"),
    /non-null view/u,
  );
  assert.match(
    validateWindowedSurfaceOutput(healthy.replace(/TN_SURFACE_FRAME:[^\n]+/gu, ""), { frames: 2 }).errors.join("\n"),
    /surface frame marker/u,
  );
  assert.match(
    validateWindowedSurfaceOutput(`${healthy}\nDevice error (Validation): surface`, { frames: 2 }).errors.join("\n"),
    /device error/u,
  );
  assert.match(
    validateWindowedSurfaceOutput(`${healthy}\n[WebGPU] sRGB presentation bridge failed`, { frames: 2 }).errors.join("\n"),
    /presentation bridge failed/u,
  );
});

test("allowFailure survives a spawn error, not just a non-zero exit", () => {
  // An Android run finished its conformance work at 74 passed, 0 failed, and was then discarded by
  // `spawnSync adb ETIMEDOUT` raised from the display-size restore — a teardown command the caller
  // had already marked allowFailure. A timeout is not the caller changing its mind about whether
  // that command matters.
  const slow = runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
    allowFailure: true,
    timeout: 100,
  });
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.status, 0);

  // Without allowFailure the same timeout still stops the run.
  assert.throws(
    () => runCommand(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeout: 100 }),
    /ETIMEDOUT|timed out/iu,
  );

  // And a plain non-zero exit under allowFailure is unchanged: returned, not thrown, not timedOut.
  const failed = runCommand(process.execPath, ["-e", "process.exit(3)"], { allowFailure: true });
  assert.equal(failed.status, 3);
  assert.equal(failed.timedOut, undefined);
});

test("the workspace test lane stays runtime-free and runs the native contract suite", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const testScript = manifest.scripts?.test ?? "";

  assert.match(testScript, /vitest/, "package test must run the imported contract suite");
  assert.doesNotMatch(
    testScript,
    /cmake|gradle|xcodebuild|native:build/,
    "default package tests must not require a native toolchain",
  );
});

test("Android supplemental proof forwards the device without a literal option separator", () => {
  assert.deepEqual(androidMultitouchArgs("/runtime", "emulator-5556"), [
    "--dir",
    "/runtime",
    "native:verify:android:multitouch",
    "--device",
    "emulator-5556",
  ]);
});

test("dry run validates and bundles implemented rows without a browser or native runtime", () => {
  const dir = makeTempDirSync("threenative-conformance-");
  try {
    const out = join(dir, "dry-report.json");
    const proc = run(["--dry-run", "--out", out], {
      FIREFOX_BIN: join(dir, "missing-firefox"),
      TN_RUNTIME: join(dir, "missing-runtime"),
      MYSTRAL_BIN: "",
    });

    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
    const implemented = registry.tests.filter((entry) => entry.status === "implemented").length;
    assert.equal(report.mode, "dry-run");
    assert.equal(report.summary.validated, implemented);
    assert.equal(report.summary.pass, 0, "dry run must not claim runtime conformance passes");
    assert.equal(report.host.browser, null);
    assert.equal(report.host.runtime, null);
    assert.deepEqual(
      report.results.map((result) => result.id),
      registry.tests.map((entry) => entry.id),
      "non-project reports must retain every registry row in exact order",
    );
    assert.ok(
      report.results
        .filter((result) => result.status === "validated")
        .every((result) => result.browserBundle && result.nativeBundle),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // This bundles every registry row twice, once per target, so its cost tracks the registry's
  // size rather than anything constant. At a 60 s budget it measured 56.8 s standalone on an idle
  // machine — a 5% margin — and it went red in three separate agent lanes on the same day, each of
  // which spent time proving the red was not theirs. A budget that close to the work is a coin
  // flip reported as a defect.
  //
  // Being generous costs nothing here, because the wall clock never guarded coverage in the first
  // place: `report.summary.validated === implemented` above is what fails when rows stop being
  // bundled, and it fails on the count no matter how fast or slow the run was. The timeout is a
  // hang detector and only ever was one, so 240 s is the right size for it.
}, 240_000);

test("project mode resolves the configured native entry and dry-bundles only that project", () => {
  const dir = makeTempDirSync("threenative-parity-project-");
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ threenative: { nativeEntry: "src/portable.ts" } }),
    );
    writeFileSync(
      join(dir, "src/portable.ts"),
      "const isDev = import.meta.env?.DEV === true; export default { ctx: null, async start() { this.ctx = { renderer: { isDev }, scene: {}, camera: {} }; } };\n",
    );
    const out = join(dir, "dry-report.json");
    const proc = run(["--dry-run", "--project", dir, "--out", out]);

    assert.equal(proc.status, 0, proc.stderr || proc.stdout);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.project.root, dir);
    assert.equal(report.project.nativeEntry, "src/portable.ts");
    assert.equal(report.results.length, 1);
    assert.equal(report.results[0].status, "validated");
    assert.match(report.results[0].id, /^project-[a-f0-9]{12}$/u);
    assert.ok(report.results[0].browserBundle);
    assert.ok(report.results[0].nativeBundle);
    const nativeBundle = readFileSync(join(root, report.results[0].nativeBundle), "utf8");
    assert.doesNotThrow(
      () => Function(nativeBundle),
      "native project bundles must compile in the runtime's plain-script mode",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project mode fails closed for a missing or escaping native entry", () => {
  const dir = makeTempDirSync("threenative-parity-project-");
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ threenative: { nativeEntry: "../outside.ts" } }),
    );
    assert.throws(() => resolveParityProject(dir), /TN_PARITY_NATIVE_ENTRY_OUTSIDE_PROJECT/u);
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ threenative: { nativeEntry: "src/missing.ts" } }),
    );
    assert.throws(() => resolveParityProject(dir), /TN_PARITY_NATIVE_ENTRY_MISSING/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent project lanes use project-specific generated scene identities", () => {
  assert.notEqual(projectId({ root: "/project/minimal" }), projectId({ root: "/project/starter" }));
  const source = readFileSync(runner, "utf8");
  assert.match(source, /project-scene.*projectId\(project\)/u);
});

test("project browser captures wait for asynchronous WebGPU pipelines to render", () => {
  const registry = createProjectRegistry(
    { schemaVersion: 1, threeVersion: "test", exclusions: [] },
    "scene.js",
    { root: "/project", nativeEntry: "src/game.ts" },
  );
  assert.equal(registry.tests[0].captureFrames, 60);
  assert.deepEqual(registry.tests[0].tolerance, {
    pixelMismatchRatio: 0.03,
    perceptualDeltaE: 6,
  });
  const source = readFileSync(runner, "utf8");
  assert.match(source, /test\.captureFrames \?\? 2/u);
});

test("browser capture resolves scaffold public assets from the server root", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(source, /<base href="\/">/u);
});

test("physical Android target distinguishes emulators and requires an explicit device", () => {
  assert.equal(androidDeviceKind({ qemu: "1", hardware: "ranchu" }), "emulator");
  assert.equal(androidDeviceKind({ qemu: "0", hardware: "qcom" }), "physical");
  const dir = makeTempDirSync("threenative-physical-report-");
  try {
    const out = join(dir, "report.json");
    const proc = run(["--target", "android-hardware", "--out", out]);
    assert.equal(proc.status, 2, proc.stderr || proc.stdout);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.target, "android-hardware");
    assert.ok(report.results.every((result) => result.status === "blocked"));
    assert.match(
      report.results.find((result) => result.blockedReason)?.blockedReason ?? "",
      /TN_PARITY_PHYSICAL_DEVICE_REQUIRED/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android capture rejects system ANR and error overlays", () => {
  assert.equal(
    androidSystemDialog(
      "Window #6 Window{c387534 u0 Application Not Responding: com.android.systemui}:\n",
    ),
    "Application Not Responding: com.android.systemui",
  );
  assert.equal(
    androidSystemDialog("Window{123 u0 Application Error: com.example.game}\n"),
    "Application Error: com.example.game",
  );
  assert.equal(androidSystemDialog("mCurrentFocus=Window{123 u0 com.threenative.game}"), null);
});

test("Android capture waits for the pinned landscape size instead of reporting a rotation as a pixel mismatch", () => {
  assert.equal(ANDROID_CAPTURE_SIZE, "1280x720");
  assert.equal(
    androidDisplaySize("Physical size: 1080x2400\nOverride size: 1280x720"),
    "1280x720",
  );
  // Mid-rotation the override still reads the portrait panel; that is the state that produced a
  // 720x1280 capture and a red row blaming the pixels.
  assert.equal(androidDisplaySize("Physical size: 1080x2400"), "1080x2400");
  assert.equal(androidDisplaySize("wm: command not found"), null);

  const source = readFileSync(runner, "utf8");
  assert.match(source, /await waitForAndroidDisplaySize\(common, ANDROID_CAPTURE_SIZE\)/u);
  assert.match(source, /TN_ANDROID_DISPLAY_ORIENTATION: captured \$\{capture\.width\}/u);
});

test("the foreground guard reads a window dump that actually carries mCurrentFocus", () => {
  // 2026-08-19: the emulator lane reported 66 rows of TN_ANDROID_FOCUS_UNKNOWN and stopped before
  // any pixel comparison. Nothing was wrong with the guard or the renderer. Android 15 (API 35)
  // stopped printing `mCurrentFocus` under the `windows` subcommand, and the lane was asking for
  // exactly that dump. A guard fed a dump the field was never in fails closed forever, which reads
  // as a lane that cannot be run rather than as a lane asking the wrong question.
  //
  // Both strings below are real `adb -s emulator-5554` output from
  // sdk_gphone64_x86_64, ro.build.version.sdk=35, on 2026-08-19.
  const apiThirtyFiveWindowsSubcommand = [
    "WINDOW MANAGER WINDOWS (dumpsys window windows)",
    "  Window #0 Window{52ed8e5 u0 ScreenDecorOverlayBottom}:",
    "    mDisplayId=0 rootTaskId=1 mSession=Session{9a1cfb6 829:u0a10181}",
    "    mOwnerUid=10181 showForAllUsers=true package=com.android.systemui appop=NONE",
  ].join("\n");
  const apiThirtyFiveFullDump = [
    "  mLayoutSeq=4948",
    "  mCurrentFocus=Window{2528440 u0 com.threenative.game/com.threenative.runtime.MystralActivity}",
    "  mFocusedApp=ActivityRecord{585e449 u0 com.threenative.game/com.threenative.runtime.MystralActivity t296}",
  ].join("\n");

  // The field is genuinely absent from the subcommand the lane used, so the guard was right to
  // refuse. This row is the defect, recorded rather than argued.
  assert.equal(androidFocusedWindowOwner(apiThirtyFiveWindowsSubcommand), null);
  assert.match(
    androidForegroundBlocker(apiThirtyFiveWindowsSubcommand),
    /TN_ANDROID_FOCUS_UNKNOWN/u,
  );

  const asked = [];
  const common = (...args) => {
    asked.push(args.join(" "));
    return {
      stdout: args.at(-1) === "windows" ? apiThirtyFiveWindowsSubcommand : apiThirtyFiveFullDump,
    };
  };
  // The dump the lane takes must be one the field is in, on this API level.
  assert.equal(androidForegroundBlocker(androidWindowDump(common)), null);
  assert.deepEqual(asked, ["shell dumpsys window"]);

  // And the call sites take it through that helper, so a revert to the `windows` subcommand turns
  // this test red instead of turning 66 conformance rows red.
  const source = readFileSync(runner, "utf8");
  assert.match(source, /androidForegroundBlocker\(androidWindowDump\(common\)\)/u);
  assert.doesNotMatch(source, /common\("shell", "dumpsys", "window", "windows"\)/u);
});

test("a capture is refused when any window but the app owns focus", () => {
  // 2026-08-17: a physical Pixel 8 sat behind Android's "app which is currently being tested"
  // prompt with the notification shade above it. That dialog is neither an ANR nor an Application
  // Error, so the old check saw nothing, and the lane photographed the home screen 67 times and
  // reported 67 rows of pixelMismatchRatio 1.000.
  const blocked = "  mCurrentFocus=Window{f453d09 u0 android}";
  assert.match(androidForegroundBlocker(blocked), /TN_ANDROID_FOREGROUND_WINDOW: 'android' owns focus/u);
  assert.equal(androidFocusedWindowOwner(blocked), "android");

  const ours = "  mCurrentFocus=Window{a1 u0 com.threenative.game/com.threenative.runtime.MystralActivity}";
  assert.equal(androidForegroundBlocker(ours), null);

  // A dump with no focus line is not a pass. Fail closed.
  assert.match(androidForegroundBlocker("nothing here"), /TN_ANDROID_FOCUS_UNKNOWN/u);

  // The two strings the old check knew about still fail, by their own code.
  assert.match(
    androidForegroundBlocker("Window{1 u0 Application Error: com.threenative.game}"),
    /TN_ANDROID_SYSTEM_DIALOG/u,
  );

  const source = readFileSync(runner, "utf8");
  assert.match(source, /const beforeCaptureBlocker = androidForegroundBlocker\(/u);
  assert.match(source, /const afterCaptureBlocker = androidForegroundBlocker\(/u);
});

test("Android conformance dismisses immersive confirmation before its first activity launch", () => {
  const calls = [];
  const common = (...args) => {
    calls.push(args);
    return { stdout: args.includes("start") ? "Status: ok" : "" };
  };

  const result = launchAndroidConformanceActivity(common, "emulator-5554");

  assert.deepEqual(calls, [
    ["shell", "settings", "put", "secure", "immersive_mode_confirmations", "confirmed"],
    // Suppresses the system ANR dialog. On run 33703705629, 73 of this lane's 74 failures were
    // `TN_ANDROID_SYSTEM_DIALOG: Application Not Responding: com.android.launcher3` — the
    // launcher, not the game, going Not Responding on a software-GL runner and taking focus.
    ["shell", "settings", "put", "global", "hide_error_dialogs", "1"],
    // And dismiss the one already up: `hide_error_dialogs` prevents future dialogs, but the
    // launcher ANRs during boot, before any of this runs. Run 33726448043 failed all 74 rows on
    // that stale dialog with the setting already in place.
    ["shell", "am", "force-stop", "com.android.launcher3"],
    ["shell", "am", "broadcast", "-a", "android.intent.action.CLOSE_SYSTEM_DIALOGS"],
    [
      "shell",
      "am",
      "start",
      "-W",
      "-n",
      "com.threenative.game/com.threenative.runtime.MystralActivity",
    ],
  ]);
  assert.equal(result.stdout, "Status: ok");
});

test("a leaked capture-size override is reset rather than restored back onto the device", () => {
  // The 2026-08-17 defect, as a unit. A previous run left `Override size: 1280x720` on a physical
  // Pixel 8; every later row read that as the operator's setting and put it back, so the phone
  // stayed letterboxed while every restore reported success.
  assert.equal(
    androidDisplayRestoreTarget("Physical size: 1080x2400\nOverride size: 1280x720"),
    "reset",
  );
  // No override to begin with is the ordinary case and still resets.
  assert.equal(androidDisplayRestoreTarget("Physical size: 1080x2400"), "reset");
  // An override the operator set for their own reasons is preserved.
  assert.equal(
    androidDisplayRestoreTarget("Physical size: 1080x2400\nOverride size: 800x600"),
    "800x600",
  );

  const source = readFileSync(runner, "utf8");
  // The restore is read back, because exit status is what the command claims and this is what the
  // device is.
  assert.match(source, /TN_ANDROID_DISPLAY_LEAKED/u);
  // A per-row finally cannot survive a signal, and this lane mutates hardware.
  assert.match(source, /armAndroidDisplayGuard\(tools\.adb, serial, rotationRestore\)/u);
  assert.match(source, /process\.once\("exit", reset\)/u);
});

test("a leaked rotation lock is reset rather than restored back onto the device", () => {
  // The 2026-09-05 defect. The lane wrote `accelerometer_rotation 0` and `user_rotation 0` and had
  // no restore path at all, so a physical Pixel 8 was left with auto-rotate off and rotation
  // pinned. Reading that pair back is indistinguishable from this lane's own leak, so it resets.
  assert.deepEqual(androidRotationRestoreTarget("0", "0"), {
    accelerometer_rotation: "1",
    user_rotation: "0",
  });
  // Auto-rotate on is the ordinary case and survives untouched.
  assert.deepEqual(androidRotationRestoreTarget("1", "0"), {
    accelerometer_rotation: "1",
    user_rotation: "0",
  });
  // An operator locked to a rotation this lane never writes is preserved.
  assert.deepEqual(androidRotationRestoreTarget("0", "3"), {
    accelerometer_rotation: "0",
    user_rotation: "3",
  });
  // Unset or unreadable settings fall back to the shipped default rather than writing junk.
  for (const dump of ["null", "", "  ", undefined, "9"])
    assert.deepEqual(androidRotationRestoreTarget(dump, dump), {
      accelerometer_rotation: "1",
      user_rotation: "0",
    });
  // adb appends a newline; the parse must not be fooled by it.
  assert.deepEqual(androidRotationRestoreTarget("1\n", "2\n"), {
    accelerometer_rotation: "1",
    user_rotation: "2",
  });

  const source = readFileSync(runner, "utf8");
  // Rotation is read before it is overwritten, or the baseline is the lane's own lock.
  assert.match(source, /rotationRestore = androidRotationRestoreTarget\([\s\S]*?accelerometer_rotation[\s\S]*?user_rotation/u);
  // Restored in the row's finally, read back, and reported when it does not take.
  assert.match(source, /finally \{[\s\S]*?rotationRestore/u);
  assert.match(source, /TN_ANDROID_ROTATION_LEAKED/u);
  // And on the paths that skip every finally in this file.
  assert.match(source, /"settings", "put", "system", setting, value[\s\S]*?Same reasoning as above/u);
});

test("Android rows uninstall the test package before each large debug APK install", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(source, /androidArgs\(serial, "uninstall", APP_ID\)/u);
  assert.match(source, /await wait\(2_000\);\s+const install/u);
  assert.match(source, /freshInstall: true/u);
});

test("Android parity owns the standalone multitouch proof without contaminating project mode", () => {
  assert.equal(
    shouldRunAndroidMultitouch({ dryRun: false, project: null, target: "android" }),
    true,
  );
  assert.equal(
    shouldRunAndroidMultitouch({ dryRun: false, project: { root: "/project" }, target: "android" }),
    false,
  );
  assert.equal(
    shouldRunAndroidMultitouch({ dryRun: true, project: null, target: "android" }),
    false,
  );
  const source = readFileSync(runner, "utf8");
  assert.match(source, /report\.supplemental[\s\S]*androidMultitouch/u);
  assert.match(source, /process\.exitCode = reportExitCode\(report\)/u);
  assert.doesNotMatch(
    source,
    /androidMultitouch\?\.status === "fail" \? 1 : reportExitCode/u,
    "the runner must not maintain a second Android-only exit rule",
  );
});

test("Android runs its standalone multitouch proof before the serial parity rows", () => {
  const source = readFileSync(runner, "utf8");
  const supplemental = source.indexOf("androidMultitouch: runAndroidMultitouchProof({");
  const rows = source.indexOf("if (dryRun || target !== \"web\") await executeRows(0);");

  assert.ok(supplemental >= 0, "the Android supplemental proof must remain wired into the report");
  assert.ok(rows >= 0, "the serial parity rows must remain wired into the runner");
  assert.ok(
    supplemental < rows,
    "the required device proof must run while the emulator is fresh, before the parity rows",
  );
});

test("the exported exit rule owns a failing Android multitouch supplemental result", () => {
  assert.equal(
    reportExitCode({
      summary: { pass: 67, fail: 0, blocked: 0 },
      supplemental: { androidMultitouch: { status: "fail", exitCode: 1 } },
    }),
    1,
  );
});

test("Android reports fail closed when multitouch supplemental evidence is missing", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const report = {
    schemaVersion: "0.3.0",
    registrySchemaVersion: registry.schemaVersion,
    threeVersion: registry.threeVersion,
    mode: "execution",
    target: "android",
    project: null,
    provenance: buildProvenance(),
    summary: { pass: 0, fail: 0, blocked: registry.tests.length, planned: 0, validated: 0 },
    results: registry.tests.map(({ id }) => ({ id, status: "blocked" })),
  };
  assert.match(validateReport(report, registry).join("\n"), /androidMultitouch pass or fail/u);
  report.supplemental = { androidMultitouch: { status: "fail", exitCode: 1 } };
  assert.deepEqual(validateReport(report, registry), []);
});

test("report validation rejects a pass with null metrics or incomplete browser execution", () => {
  const dir = makeTempDirSync("threenative-conformance-");
  try {
    const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
    const results = registry.tests.map((entry) => ({
      id: entry.id,
      status: entry.status === "implemented" ? "pass" : "planned",
      browser: entry.status === "implemented" ? { completed: false, screenshot: null } : null,
      native: entry.status === "implemented" ? { completed: true, screenshot: "native.png" } : null,
      metrics: { pixelMismatchRatio: null, perceptualDeltaE: null },
      gpuValidationErrors: [],
    }));
    const report = {
      schemaVersion: "0.2.0",
      registrySchemaVersion: registry.schemaVersion,
      threeVersion: registry.threeVersion,
      mode: "execution",
      summary: {
        pass: results.filter((entry) => entry.status === "pass").length,
        fail: 0,
        blocked: 0,
        planned: results.filter((entry) => entry.status === "planned").length,
        validated: 0,
      },
      results,
    };
    const reportPath = join(dir, "invalid-report.json");
    writeFileSync(reportPath, JSON.stringify(report));

    const proc = run(["--validate-report", reportPath]);
    assert.notEqual(proc.status, 0);
    assert.match(
      proc.stderr,
      /completed browser execution|finite pixelMismatchRatio|finite perceptualDeltaE/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ImageMagick Q16 HDRI absolute error is normalized to a pixel ratio", () => {
  assert.equal(absoluteErrorRatio("65535", 100, "ImageMagick 7.1.2-10 Q16-HDRI"), 0.01);
  assert.equal(absoluteErrorRatio("1", 100, "ImageMagick 7.1.2-10 Q16-HDRI"), 0.01);
  assert.ok(Number.isNaN(absoluteErrorRatio("65535", 100, "unknown quantum depth")));
});

test("bounded execution rejects unknown conformance ids before claiming a report", () => {
  const proc = run(["--dry-run", "--only-tests", "not-a-row"]);
  assert.notEqual(proc.status, 0);
  assert.match(proc.stderr, /Unknown --only-tests/u);
});

test("registry exclusions fail closed without an owner, reason, or explicit excluded status", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  assert.deepEqual(validateRegistry(registry), []);

  const malformed = structuredClone(registry);
  malformed.exclusions[0].owner = "";
  malformed.exclusions[1].reason = "";
  malformed.exclusions[2].status = "planned";
  const errors = validateRegistry(malformed).join("\n");
  assert.match(errors, /owner must be a non-empty string/u);
  assert.match(errors, /reason must be a non-empty string/u);
  assert.match(errors, /status must be excluded/u);
});

test("registry exclusion expiry is validated and surfaced as blocked evidence", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const exclusion = registry.exclusions.find(({ id }) => id === "desktop-multitouch-input");
  assert.equal(expiredExclusions(registry, Date.parse("2026-12-30T23:59:59.000Z")).length, 0);
  assert.deepEqual(
    expiredExclusions(registry, Date.parse("2027-01-01T00:00:00.000Z")).map(({ id }) => id),
    [
      "desktop-multitouch-input",
      "android-canvas2d-document-window-stubs",
      "android-hardware-canvas2d-document-window-stubs",
    ],
  );
  assert.equal(validateRegistry(registry).length, 0);

  const malformed = structuredClone(registry);
  malformed.exclusions.find(({ id }) => id === exclusion.id).expires = "2026-02-30";
  assert.match(validateRegistry(malformed).join("\n"), /expires must be an ISO date/u);
});

test("an exclusion row must name a registry test id or it binds to nothing", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  assert.deepEqual(validateRegistry(registry), []);

  const malformed = structuredClone(registry);
  malformed.exclusions.find(({ id }) => id === "desktop-multitouch-input").row =
    "90-multitouch-inpu";
  assert.match(
    validateRegistry(malformed).join("\n"),
    /desktop-multitouch-input: row must name a registry test id/u,
  );

  const rowless = structuredClone(registry);
  const target = rowless.exclusions.find(({ id }) => id === "desktop-multitouch-input");
  delete target.row;
  assert.deepEqual(validateRegistry(rowless), []);
});

test("generatedPlaytestProofs fail closed on unknown ids and missing proof files", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  assert.deepEqual(validateRegistry(registry), []);

  const typo = structuredClone(registry);
  typo.generatedPlaytestProofs[0].proof = "packages/runtime-native/does-not-exist.json";
  assert.match(
    validateRegistry(typo).join("\n"),
    /generated-shooter-input-control: proof must reference an existing file/u,
  );

  const duplicateId = structuredClone(registry);
  duplicateId.generatedPlaytestProofs[1].id = registry.tests[0].id;
  assert.match(
    validateRegistry(duplicateId).join("\n"),
    /duplicate id/u,
  );
});


test("help exits without starting any parity lane", () => {
  const proc = run(["--help"]);
  assert.equal(proc.status, 0, proc.stderr || proc.stdout);
  assert.match(proc.stdout, /--target web\|desktop\|android\|ios\|all/u);
  assert.doesNotMatch(proc.stdout, /"wrote"/u);
});

test("execution reports use only pass, fail, or blocked and blocked exits 2", () => {
  const dir = makeTempDirSync("threenative-conformance-");
  try {
    const out = join(dir, "desktop-report.json");
    const proc = run(
      [
        "--target",
        "desktop",
        "--only-tests",
        "15-mesh-toon-material-gradientmap",
        "--reference",
        join(dir, "missing-reference"),
        "--out",
        out,
      ],
      { THREENATIVE_RUNTIME_BINARY: join(dir, "missing-runtime") },
    );
    assert.equal(proc.status, 2, proc.stderr || proc.stdout);
    const report = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(report.mode, "execution");
    assert.ok(report.results.every(({ status }) => ["pass", "fail", "blocked"].includes(status)));
    assert.ok(report.summary.blocked > 0);
    assert.match(
      report.results.find((result) => result.id === "15-mesh-toon-material-gradientmap")
        ?.blockedReason ?? "",
      /TN_PARITY_DESKTOP_RUNTIME_MISSING/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("uniform captures fail closed even when reference and candidate bytes match", () => {
  const uniform = new PNG({ width: 2, height: 1 });
  uniform.data.set([12, 34, 56, 255, 12, 34, 56, 255]);
  const uniformPng = PNG.sync.write(uniform);
  assert.throws(() => inspectCapture(uniformPng), /uniform/u);
  assert.throws(() => compareCaptures(uniformPng, uniformPng), /uniform/u);

  uniform.data.set([12, 34, 56, 255, 13, 34, 56, 255]);
  const visiblePng = PNG.sync.write(uniform);
  assert.deepEqual(compareCaptures(visiblePng, visiblePng), {
    pixelMismatchRatio: 0,
    perceptualDeltaE: 0,
    width: 2,
    height: 1,
  });

  // An RGB reference carries no alpha: a candidate's alpha cannot differ from it, its colour can.
  const rgbReference = PNG.sync.write(uniform, { colorType: 2 });
  const transparent = new PNG({ width: 2, height: 1 });
  transparent.data.set([12, 34, 56, 0, 13, 34, 56, 255]);
  assert.equal(compareCaptures(rgbReference, PNG.sync.write(transparent)).pixelMismatchRatio, 0);
  assert.equal(compareCaptures(visiblePng, PNG.sync.write(transparent)).pixelMismatchRatio, 0.5);
  transparent.data.set([12, 34, 57, 0], 0);
  assert.equal(compareCaptures(rgbReference, PNG.sync.write(transparent)).pixelMismatchRatio, 0.5);
});

test("screen-space glyph raster fails closed on missing pixels and drifting bounds", () => {
  const glyphCapture = (offsetX, count = 1_000) => {
    const png = new PNG({ width: 64, height: 32 });
    png.data.fill(255);
    for (let index = 0; index < png.data.length; index += 4) {
      png.data[index] = 20;
      png.data[index + 1] = 24;
      png.data[index + 2] = 32;
    }
    for (let pixel = 0; pixel < count; pixel += 1) {
      const x = offsetX + (pixel % 40);
      const y = 3 + Math.floor(pixel / 40);
      const index = (y * png.width + x) * 4;
      png.data.set([246, 224, 94, 255], index);
    }
    return PNG.sync.write(png);
  };
  assert.equal(inspectScreenSpaceGlyphs(glyphCapture(4)).brightPixels, 1_000);
  assert.deepEqual(compareScreenSpaceGlyphs(glyphCapture(4), glyphCapture(5)).boundsDelta, [
    1, 0, 1, 0,
  ]);
  assert.throws(() => inspectScreenSpaceGlyphs(glyphCapture(4, 999)), /expected at least 1000/u);
  assert.throws(
    () => compareScreenSpaceGlyphs(glyphCapture(4), glyphCapture(6)),
    /bounds drift/u,
  );
});

test("Android conformance override requires an explicit matching bundle hash", () => {
  const dir = makeTempDirSync("threenative-android-conformance-");
  try {
    const bundle = join(dir, "row.js");
    const output = join(dir, "assets/scripts/main.js");
    writeFileSync(bundle, 'console.info("TN_CONFORMANCE_READY:test");\n');
    const hash = createHash("sha256").update(readFileSync(bundle)).digest("hex");
    assert.throws(() => parseConformanceBundleArgs(["--bundle", bundle]), /requires both/u);
    assert.throws(
      () => buildAndroidConformanceAsset({ bundle, expectedSha256: "0".repeat(64), output }),
      /hash mismatch/u,
    );
    const metadata = buildAndroidConformanceAsset({ bundle, expectedSha256: hash, output });
    assert.equal(metadata.outputSha256, hash);
    assert.deepEqual(readFileSync(output), readFileSync(bundle));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android parity blocks before Gradle when the pinned SDL3 AAR is absent", () => {
  const dir = makeTempDirSync("threenative-android-deps-");
  try {
    const reason = androidDependencyBlocker(dir);
    assert.match(reason ?? "", /^TN_PARITY_ANDROID_DEPS_BLOCKED:/u);
    assert.match(
      reason ?? "",
      new RegExp(`${SDL3_AAR.replaceAll(".", "\\.")} does not exist`, "u"),
    );
    assert.match(reason ?? "", /checked source and packaged Android dependency layouts/u);
    assert.match(reason ?? "", /libmystral-runtime\.so/u);
    assert.match(reason ?? "", /pnpm native:build/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android parity blocks a partial packaged layout even when the source AAR exists", () => {
  const dir = makeTempDirSync("threenative-android-partial-prebuilt-");
  try {
    mkdirSync(join(dir, "third_party/sdl3-android"), { recursive: true });
    writeFileSync(join(dir, "third_party/sdl3-android", SDL3_AAR), "fixture");
    mkdirSync(join(dir, "android/prebuilt"), { recursive: true });
    writeFileSync(join(dir, "android/prebuilt", SDL3_AAR), "fixture");

    assert.ok(androidDependencyBlocker(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android parity accepts a source-only SDL3 dependency layout", () => {
  const dir = makeTempDirSync("threenative-android-source-only-");
  try {
    mkdirSync(join(dir, "third_party/sdl3-android"), { recursive: true });
    writeFileSync(join(dir, "third_party/sdl3-android", SDL3_AAR), "fixture");

    assert.equal(androidDependencyBlocker(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Android parity accepts a complete packaged dependency layout", () => {
  const dir = makeTempDirSync("threenative-android-prebuilt-");
  try {
    const files = [
      join("android/prebuilt", SDL3_AAR),
      "android/prebuilt/jniLibs/arm64-v8a/libSDL3.so",
      "android/prebuilt/jniLibs/arm64-v8a/libmystral-runtime.so",
      "android/prebuilt/jniLibs/x86_64/libSDL3.so",
      "android/prebuilt/jniLibs/x86_64/libmystral-runtime.so",
    ];
    for (const file of files) {
      mkdirSync(join(dir, file, ".."), { recursive: true });
      writeFileSync(join(dir, file), "fixture");
    }
    assert.equal(androidDependencyBlocker(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("root parity command and Gradle lane use an explicit checksum-locked override", () => {
  const rootManifest = JSON.parse(readFileSync(join(root, "../../package.json"), "utf8"));
  assert.match(rootManifest.scripts?.parity ?? "", /run-conformance\.mjs/u);
  const gradle = readFileSync(join(root, "android/app/build.gradle.kts"), "utf8");
  assert.match(gradle, /threenativeConformanceBundleSha256/u);
  assert.match(gradle, /buildAndroidConformanceBundle/u);
  assert.match(gradle, /else dependsOn\("buildAndroidFirstProofBundle"\)/u);
});

// The assertion above is only worth anything if the fold it reads through still tells the two
// shapes apart. `|` is what the lane shipped between 2026-09-01 and 2026-09-02: the action feeds
// the emulator one line at a time, so everything after the first line vanished and
// `run-conformance.mjs` ran with no `--target` at all. `>-` is the fix. A helper that flattened
// both to the same string would report the broken lane as healthy.
test("the workflow scalar fold tells a dropped-argument literal block from a folded one", () => {
  const folded = [
    "        with:",
    "          script: >-",
    "            node run-conformance.mjs --target android",
    "            --device emulator-5554 --out artifacts/conformance/android",
    "        - name: next",
  ].join("\n");
  const literal = folded.replace("script: >-", "script: |").replace(
    "--target android",
    "--target android \\",
  );

  assert.deepEqual(workflowBlockScalars(folded, "script"), [
    "node run-conformance.mjs --target android --device emulator-5554 --out artifacts/conformance/android",
  ]);
  // Every line after the first is a separate command to the emulator shell, so the arguments are
  // not on the invocation the lane actually runs.
  const [literalScript] = workflowBlockScalars(literal, "script");
  assert.equal(literalScript?.split("\n")[0], "node run-conformance.mjs --target android \\");
  assert.doesNotMatch(
    literalScript?.split("\n")[0] ?? "",
    /--device emulator-5554/u,
    "a literal block hands the emulator a first line with no device",
  );
});

test("native workflow runs the complete checksum-locked Android emulator parity lane", () => {
  const workflow = readFileSync(join(root, "../../.github/workflows/native-platforms.yml"), "utf8");
  assert.match(workflow, /packages\/runtime-native\/\*\*/u);
  assert.match(workflow, /android-actions\/setup-android@v4/u);
  assert.match(workflow, /download-deps\.mjs --android/u);
  // The folded value, not the file's wrapping: the emulator action hands `script` to the shell as
  // one string, so this asserts the command the lane runs rather than where the line happens to
  // break. Matching the raw text pinned a `\`-continued shape whose every argument the action
  // dropped, and would reject the one-line form that fixed it.
  const emulatorScript = workflowBlockScalars(workflow, "script").find((script) =>
    script.includes("run-conformance.mjs"),
  );
  assert.ok(emulatorScript, "the emulator lane has no run-conformance script block");
  assert.match(emulatorScript, /--target android --device emulator-5554/u);
  assert.doesNotMatch(workflow, /implemented-only/u);
});

test("parity lanes restore workspace imports before conformance bundling", () => {
  const workflow = readFileSync(join(root, "../../.github/workflows/native-platforms.yml"), "utf8");
  for (const name of ["android-emulator-parity", "desktop-parity"]) {
    const start = workflow.indexOf(`  ${name}:\n`);
    assert.ok(start >= 0, `missing parity lane: ${name}`);
    const tail = workflow.slice(start + `  ${name}:\n`.length);
    const next = tail.search(/^ {2}[a-z][a-z-]*:\n/mu);
    const section = next < 0 ? tail : tail.slice(0, next);
    const build = section.indexOf("uses: ./.github/actions/workspace-dist");
    const capture = section.indexOf("- name: Capture browser references");
    assert.ok(build >= 0, `${name} must restore or build its workspace imports`);
    assert.ok(capture > build, `${name} must have workspace imports before conformance bundling`);
    assert.doesNotMatch(section, /pnpm tsx scripts\/workspace-packages\.ts build/u);
  }
});

test("the parity registry binds the simultaneous stick-and-jump proof to Android injection", () => {
  const registry = JSON.parse(readFileSync(join(root, "conformance/registry.json"), "utf8"));
  const proof = registry.tests.find((entry) => entry.id === "90-multitouch-input");
  assert.deepEqual(proof, {
    category: "input",
    desktopGate: false,
    id: "90-multitouch-input",
    inputProof: "multitouch",
    required: true,
    scene: "conformance/scenes/shared/multitouch-input.js",
    status: "implemented",
    title: "simultaneous stick and jump input",
    tolerance: { perceptualDeltaE: 3, pixelMismatchRatio: 0.01 },
  });
  const runner = readFileSync(join(root, "conformance/run-conformance.mjs"), "utf8");
  assert.match(runner, /androidMultitouchScript/u);
  assert.match(runner, /isMultitouchProofSatisfied\(proof\)/u);
  assert.match(runner, /TN_MULTITOUCH_PROOF_PASS/u);
});

test("the browser multitouch control can drop one pointer and remains fail-closed", () => {
  const runner = readFileSync(join(root, "conformance/run-conformance.mjs"), "utf8");
  assert.match(runner, /TN_MULTITOUCH_DROP_POINTER/u);
  assert.match(runner, /MULTITOUCH_PROOF_POINTS\.slice\(0, 1\)/u);
  assert.match(runner, /TN_MULTITOUCH_TIMEOUT_MS/u);
});

test("multitouch proof rejects sequential contacts and accepts overlapping contacts", () => {
  const sequential = [
    { leftGround: false, moved: true, pointers: 1, simultaneous: false },
    { leftGround: true, moved: true, pointers: 1, simultaneous: false },
  ];
  const overlapping = [
    { leftGround: false, moved: true, pointers: 2, simultaneous: false },
    { leftGround: true, moved: true, pointers: 2, simultaneous: true },
  ];

  assert.equal(sequential.some(isMultitouchProofSatisfied), false);
  assert.equal(overlapping.some(isMultitouchProofSatisfied), true);
});

test("multitouch proof rejects two pointers that never overlapped the stick and jump halves", () => {
  assert.equal(
    isMultitouchProofSatisfied({
      leftGround: true,
      moved: true,
      pointers: 2,
      simultaneous: false,
    }),
    false,
  );
});

test("Android screenshot capture preserves PNG bytes", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(
    source,
    /androidArgs\(serial, "exec-out", "screencap", "-p"\),[\s\S]*?binary: true/u,
    "adb screencap must not decode binary PNG output as UTF-8 text",
  );
});

test("Android capture uses reference dimensions and restores the prior display override", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(source, /common\("shell", "wm", "size", ANDROID_CAPTURE_SIZE\)/u);
  // Was `displayRestore = /^Override size:` inline, which echoed a leaked override straight back
  // onto the device. The decision now lives in `androidDisplayRestoreTarget`, which is tested
  // against the leak case directly rather than by matching the source line that caused it.
  assert.match(source, /displayRestore = androidDisplayRestoreTarget\(originalSize\)/u);
  assert.match(source, /finally \{[\s\S]*?displayRestore/u);
  assert.match(
    source,
    /restoreOnDevice\(tools\.adb, serial, "wm", "size", displayRestore\)/u,
  );
  // The restore survives a momentary adbd drop: it waits for the device once and retries.
  assert.match(
    source,
    /function restoreOnDevice[\s\S]*?allowFailure: true[\s\S]*?"wait-for-device"[\s\S]*?return run\(\);/u,
  );
});

test("Android log capture retries one transient adbd failure", () => {
  const temp = makeTempDirSync("tn-android-log-retry-");
  try {
    const state = join(temp, "state.txt");
    const adb = join(temp, "adb");
    writeFileSync(
      adb,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"logcat -d -v threadtime"* ]]; then
  if [[ ! -f "${state}" ]]; then
    touch "${state}"
    exit 255
  fi
  printf '09-27 22:59:00.000  123  456 I MystralRuntime: TN_SURFACE_FRAME:{"view":true}\n'
  exit 0
fi
if [[ "$*" == *"wait-for-device"* ]]; then
  exit 0
fi
echo "unexpected adb args: $*" >&2
exit 2
`,
    );
    chmodSync(adb, 0o755);

    assert.match(androidLog(adb, "emulator-5554"), /TN_SURFACE_FRAME/u);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("Android checks liveness after its marker, settle window, and screenshot", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(
    source,
    /conformance marker[\s\S]*?await wait\(settleMs\)[\s\S]*?settle window[\s\S]*?screencap[\s\S]*?after screenshot capture/u,
  );
});

test("Linux desktop parity selects SDL X11 because the native surface does not support Wayland", () => {
  const source = readFileSync(runner, "utf8");
  assert.match(source, /process\.platform === "linux"[\s\S]*SDL_VIDEODRIVER: "x11"/u);
});

test("a pre-marker death excerpt carries the app's own diagnostic lines, not death chatter", () => {
  // PRD-166 phase 3: the full-lane rerun's row error appended a raw 400-char tail that was
  // Window Manager lines merely naming the app, crowding out the scene trace that names the
  // stage the process reached. The excerpt must prefer the app's TN_* diagnostics and fall back
  // to the bare message when the log has none.
  const log = [
    "08-22 15:14:15.900  8101  8120 I MystralJS: [info] TN_PRD166_TRACE:{\"stage\":\"viewport-begin\",\"index\":1,\"width\":1024,\"height\":768}",
    "08-22 15:14:15.901  8101  8120 I MystralJS: [info] TN_PRD166_TRACE:{\"stage\":\"set-size-returned\",\"index\":1,\"width\":1024,\"height\":768}",
    "08-22 15:14:16.156   588  1949 W ActivityTaskManager: Unable to send transaction to client proc com.threenative.game: no app thread",
  ].join("\n");

  const excerpt = androidDeathExcerpt("Android process exited before the conformance marker.", log);
  assert.match(excerpt, /Android process exited before the conformance marker\./u);
  assert.match(excerpt, /set-size-returned/u, "the app's last diagnostic line must survive");
  assert.doesNotMatch(excerpt, /no app thread/u, "death chatter must not crowd out diagnostics");
  assert.equal(
    androidDeathExcerpt("Android process exited before the conformance marker.", ""),
    "Android process exited before the conformance marker.",
  );
});

vi.mock("esbuild", async () => {
  const actual = await vi.importActual("esbuild");
  return { ...actual, build: vi.fn(actual.build), stop: vi.fn(actual.stop) };
});
afterEach(async () => {
  vi.useRealTimers();
  await esbuild.stop();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

function bundleFixture(body = "export const choice = import.meta.env?.DEV;") {
  const dir = makeTempDirSync("threenative-bundle-service-");
  const entry = join(dir, "entry.ts");
  const out = join(dir, "output.js");
  writeFileSync(entry, body);
  return { dir, entry, out, compiler: join(root, "node_modules/.bin/esbuild") };
}

test("conformance API preserves changing NODE_PATH lookup, bytes and maps", async () => {
  const fixture = bundleFixture('export { choice } from "conformance-node-path-only";');
  try {
    for (const value of [undefined, ""]) {
      vi.stubEnv("NODE_PATH", value);
      const result = {};
      assert.equal(await bundle(fixture.entry, fixture.out, result, "browser", fixture.compiler, true), false);
      assert.match(result.browser.stderr, /conformance-node-path-only/u);
    }
    for (const choice of ["first", "second"]) {
      const modules = join(fixture.dir, choice);
      const dependency = join(modules, "conformance-node-path-only");
      mkdirSync(dependency, { recursive: true });
      writeFileSync(join(dependency, "index.js"), `export const choice = ${JSON.stringify(choice)};`);
      vi.stubEnv("NODE_PATH", [join(fixture.dir, "missing"), modules].join(delimiter));
      const cli = spawnSync(process.execPath, [join(root, "node_modules/esbuild/bin/esbuild"), fixture.entry, "--bundle", `--outfile=${fixture.out}`, "--format=esm", "--platform=browser", "--sourcemap", "--log-level=silent"], { cwd: root, encoding: "utf8", env: { ...process.env }, timeout: 120_000 });
      assert.equal(cli.status, 0, cli.stderr);
      const expected = readFileSync(fixture.out);
      const map = readFileSync(`${fixture.out}.map`);
      assert.equal(await bundle(fixture.entry, fixture.out, {}, "browser", fixture.compiler, true), true);
      assert.deepEqual(readFileSync(fixture.out), expected);
      assert.deepEqual(readFileSync(`${fixture.out}.map`), map);
    }
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("serial conformance bundles reuse the compiler service instead of launching each CLI", async () => {
  const fixture = bundleFixture();
  const calls = vi.spyOn(childProcess, "spawnSync");
  syncBuiltinESMExports();
  try {
    assert.equal(await bundle(fixture.entry, fixture.out, {}, "browser", fixture.compiler, true), true);
    assert.equal(await bundle(fixture.entry, fixture.out, {}, "native", fixture.compiler, true), true);
    assert.equal(calls.mock.calls.filter(([command]) => command === fixture.compiler).length, 0);
  } finally {
    calls.mockRestore();
    syncBuiltinESMExports();
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

for (const [side, format, conditions] of [
  ["browser", "esm", []], ["native", "esm", ["threenative-native"]],
  ["native", "iife", ["alpha", "beta"]],
  ["browser", "esm", [""]],
  ["browser", "esm", ["alpha,beta"]],
]) test(`conformance API preserves CLI bytes and linked maps for ${side}/${format}/${conditions}`, async () => {
  const fixture = bundleFixture('import choice from "choices"; export const value = [choice, import.meta.env?.DEV];');
  const modules = join(fixture.dir, "node_modules/choices");
  mkdirSync(modules, { recursive: true });
  writeFileSync(join(modules, "package.json"), JSON.stringify({ type: "module", exports: { alpha: "./alpha.js", beta: "./beta.js", "threenative-native": "./native.js", module: "./module.js", default: "./default.js" } }));
  for (const name of ["alpha", "beta", "native", "module", "default"]) writeFileSync(join(modules, `${name}.js`), `export default ${JSON.stringify(name)};`);
  try {
    const proc = spawnSync(fixture.compiler, [fixture.entry, "--bundle", `--outfile=${fixture.out}`, `--format=${format}`, "--platform=browser", "--sourcemap", ...(side === "native" ? ['--define:import.meta.env={"BASE_URL":"/","DEV":false,"MODE":"production","PROD":true,"SSR":false}'] : []), ...conditions.map(c => `--conditions=${c}`)], { cwd: root, encoding: "utf8", timeout: 120_000 });
    assert.equal(proc.status, 0, proc.stderr);
    const output = readFileSync(fixture.out);
    const map = readFileSync(`${fixture.out}.map`);
    assert.equal(await bundle(fixture.entry, fixture.out, {}, side, fixture.compiler, true, format, conditions), true);
    assert.deepEqual(readFileSync(fixture.out), output);
    assert.deepEqual(readFileSync(`${fixture.out}.map`), map);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("conformance bundle errors retain the row side and primary import failure", async () => {
  const fixture = bundleFixture('import missing from "no-such-package-for-conformance"; export default missing;');
  try {
    const result = {};
    assert.equal(await bundle(fixture.entry, fixture.out, result, "native", fixture.compiler, true), false);
    assert.equal(result.status, "fail");
    assert.equal(result.native.phase, "bundle");
    assert.match(result.native.stderr, /no-such-package-for-conformance/u);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("an absent compiler remains a failed dry run and a blocked execution", async () => {
  const fixture = bundleFixture();
  try {
    for (const dry of [true, false]) {
      const result = {};
      assert.equal(await bundle(fixture.entry, fixture.out, result, "browser", join(fixture.dir, "missing-esbuild"), dry), false);
      assert.equal(result.status, dry ? "fail" : "blocked");
      assert.match(result.blockedReason, /Install JavaScript dependencies/u);
    }
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a stuck compiler fails at the existing 120-second boundary and stops its service", async () => {
  const fixture = bundleFixture();
  vi.useFakeTimers();
  esbuild.build.mockImplementationOnce(() => new Promise(() => {}));
  try {
    const result = {};
    const pending = Promise.resolve(bundle(fixture.entry, fixture.out, result, "browser", fixture.compiler, true));
    await vi.advanceTimersByTimeAsync(119_999);
    assert.equal(result.status, undefined);
    await vi.advanceTimersByTimeAsync(1);
    assert.equal(await pending, false);
    assert.equal(result.status, "fail");
    assert.match(result.browser.stderr, /120000|ETIMEDOUT/u);
    expect(esbuild.stop).toHaveBeenCalled();
    assert.equal(vi.getTimerCount(), 0);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

test("a timeout preserves its primary error when compiler cleanup also fails", async () => {
  const fixture = bundleFixture();
  vi.useFakeTimers();
  esbuild.build.mockImplementationOnce(() => new Promise(() => {}));
  esbuild.stop.mockRejectedValueOnce(new Error("cleanup failure receipt"));
  try {
    const result = {};
    const pending = bundle(fixture.entry, fixture.out, result, "native", fixture.compiler, true);
    await vi.advanceTimersByTimeAsync(120_000);
    assert.equal(await pending, false);
    assert.match(result.native.stderr, /TN_CONFORMANCE_BUNDLE_TIMEOUT/u);
    assert.match(result.native.cleanupError, /cleanup failure receipt/u);
    assert.equal(result.native.timedOut, true);
    assert.equal(vi.getTimerCount(), 0);
  } finally { rmSync(fixture.dir, { recursive: true, force: true }); }
});

for (const invalid of [false, true]) test(`the compiler service closes after terminal ${invalid ? "error" : "success"}`, () => {
  const dir = makeTempDirSync("threenative-service-cleanup-");
  const events = join(dir, "service-events.jsonl");
  const observer = join(dir, "observer.cjs");
  writeFileSync(observer, `
const cp = require('node:child_process');
const {appendFileSync} = require('node:fs');
const {syncBuiltinESMExports} = require('node:module');
const original = cp.spawn;
cp.spawn = function(command, args, options) {
  const child = original.apply(this, arguments);
  if (args?.some(value => String(value).startsWith('--service='))) {
    appendFileSync(${JSON.stringify(events)}, JSON.stringify({phase:'start',pid:child.pid})+'\\n');
    // Keep this test's observer alive until close: a missing terminal stop must be detected.
    child.unref = () => child;
    child.on('close', (code, signal) => appendFileSync(${JSON.stringify(events)}, JSON.stringify({phase:'close',pid:child.pid,code,signal})+'\\n'));
  }
  return child;
};
syncBuiltinESMExports();
`);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ threenative: { nativeEntry: "game.ts" } }));
  writeFileSync(join(dir, "game.ts"), invalid ? 'import missing from "cleanup-missing-package"; export default missing;' : 'export default { start() {} };');
  try {
    const proc = run(["--dry-run", "--project", dir, "--out", join(dir, "report.json")], {
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --require=${observer}`,
    });
    assert.equal(proc.status, invalid ? 1 : 0, proc.error?.message || proc.stderr || proc.stdout);
    const recorded = readFileSync(events, "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.equal(recorded.filter(event => event.phase === "start").length, 1);
    assert.equal(recorded.filter(event => event.phase === "close").length, 1);
    assert.equal(recorded[0].pid, recorded[1].pid);
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8"));
    assert.equal(report.summary.pass, 0);
    assert.equal(report.summary.validated, invalid ? 0 : 1);
    if (invalid) assert.match(report.results[0].native.stderr, /cleanup-missing-package/u);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test("vehicle conformance resolves Rapier from its own clean catalog importer", async () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies["@dimforge/rapier3d-compat"], "catalog:");
  const dir = makeTempDirSync("threenative-vehicle-importer-");
  try {
    const fixture = join(dir, "vehicle-physics.js");
    writeFileSync(fixture, readFileSync(join(root, "conformance/scenes/shared/vehicle-physics.js")));
    // This clean importer has only its declared Rapier dependency. No workspace root,
    // sibling physics importer or ambient NODE_PATH can satisfy the fixture import.
    const require = createRequire(join(root, "package.json"));
    const rapierEntry = require.resolve("@dimforge/rapier3d-compat");
    const dependency = join(dir, "node_modules/@dimforge");
    mkdirSync(dependency, { recursive: true });
    symlinkSync(dirname(rapierEntry), join(dependency, "rapier3d-compat"));
    const result = await esbuild.build({
      absWorkingDir: dir,
      entryPoints: [fixture],
      bundle: true,
      write: false,
      platform: "browser",
      format: "esm",
      nodePaths: [],
      external: ["three/webgpu", "../../../../physics/*", "./scene-support.js"],
      metafile: true,
      logLevel: "silent",
    });
    assert.ok(Object.keys(result.metafile.inputs).some(input => input.includes("rapier")));
    assert.ok(result.outputFiles[0].contents.length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
