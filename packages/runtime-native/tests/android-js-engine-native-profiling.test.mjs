import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  nativeBindingDefinition,
  nativeDefinition,
} from "../../../test-support/native-definition.js";

function source(relativePath) {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

const cmake = source("../CMakeLists.txt");
const gradle = source("../android/app/build.gradle.kts");
const androidMain = source("../src/platform/android_main.cpp");
const runtime = source("../src/runtime.cpp");
const context = source("../src/webgpu/context.cpp");
const runtimeHeader = source("../include/mystral/runtime.h");
const bindingsHeader = source("../include/mystral/webgpu/bindings.h");
const nativeSmoke = source("../../../examples/native-smoke/src/game.ts");
const measurementRunner = source("../scripts/measure-android-js-engine.mjs");

test("Android measurement controls remain default-off and pass through Gradle", () => {
  assert.match(cmake, /option\(TN_ANDROID_VSYNC[^\n]+ ON\)/u);
  for (const flag of ["TN_ANDROID_JS_PROFILE", "TN_ANDROID_JS_PROFILE_BUSY_LOOP"]) {
    assert.match(cmake, new RegExp(`option\\(${flag}[^\\n]+ OFF\\)`, "u"));
    assert.match(cmake, new RegExp(`${flag}=\\$<BOOL:\\$\\{${flag}\\}>`, "u"));
    assert.match(gradle, new RegExp(`-D${flag}=\\$\\{`, "u"));
  }
  assert.match(gradle, /gradleProperty\("threenativeVsync"\)\.orElse\("true"\)/u);
  assert.match(gradle, /gradleProperty\("threenativeJsProfile"\)\.orElse\("false"\)/u);
  assert.match(gradle, /gradleProperty\("threenativeJsProfileBusyLoop"\)\.orElse\("false"\)/u);
  for (const setting of [
    "EXTRA_DRAW_CONTROL",
    "FRAME_WINDOW",
    "MATERIALS",
    "MESHES",
    "PURE_JS_ITERATIONS",
    "PURE_JS_OBJECTS",
    "VISIBILITY",
    "WARMUP_FRAMES",
  ]) {
    assert.match(gradle, new RegExp(`THREENATIVE_JS_PROFILE_${setting}`, "u"));
  }
  assert.match(gradle, /inputs\.properties\(jsProfileEnvironment\)/u);
});

test("V8 callback churn harness verifies lifetime and reports throughput", () => {
  const lifetimeHarness = source("handle_lifetime_test.cpp");
  assert.match(lifetimeHarness, /callback-churn=/u);
  assert.match(lifetimeHarness, /callbacks-per-second=/u);
});

test("wgpu upload staging is a default-on build toggle passed through Gradle", () => {
  assert.match(cmake, /option\(TN_WEBGPU_UPLOAD_STAGING[^\n]+ ON\)/u);
  assert.match(cmake, /TN_WEBGPU_UPLOAD_STAGING=\$<BOOL:\$\{TN_WEBGPU_UPLOAD_STAGING\}>/u);
  assert.match(gradle, /gradleProperty\("threenativeUploadStaging"\)\.orElse\("true"\)/u);
  assert.match(gradle, /-DTN_WEBGPU_UPLOAD_STAGING=\$\{/u);
});

test("writeBuffer stages into mapped blocks flushed at every queue boundary", () => {
  const writeBuffer = nativeBindingDefinition("GPUQueue", "writeBuffer").text;
  assert.match(writeBuffer, /stageWriteInUploadStaging/u);
  assert.match(
    writeBuffer,
    /wgpuQueueWriteBuffer\(state->queue, buffer, offset, source, writeSize\)/u,
  );
  for (const [surface, method] of [
    ["GPUQueue", "submit"],
    ["GPUQueue", "writeTexture"],
    ["GPUQueue", "onSubmittedWorkDone"],
    ["GPUBuffer", "mapAsync"],
  ]) {
    assert.match(
      nativeBindingDefinition(surface, method).text,
      /flushUploadStaging\(state\)/u,
      `${surface}.${method} must flush staged writes before crossing its queue boundary`,
    );
  }
});

test("RuntimeConfig vsync selects and preserves a supported presentation mode", () => {
  assert.match(
    androidMain,
    /config\.vsync = config\.maxFps != 0 && config\.maxFps < 60/u,
    "Android full-refresh, high-refresh and uncapped requests must avoid FIFO's missed-vblank divisor",
  );
  assert.match(
    runtime,
    /configureSurface\(width_, height_,\s*config_\.vsync && !platform::presentUncapped\(\)\)/u,
  );
  assert.match(runtime, /getPresentMode\(\)/u);
  assert.match(context, /capabilities\.presentModes\[i\] == WGPUPresentMode_Immediate/u);
  assert.match(context, /capabilities\.presentModes\[i\] == WGPUPresentMode_Mailbox/u);
  assert.match(context, /Uncapped presentation requested but unsupported; refusing FIFO fallback/u);
  assert.match(context, /configureSurface\(width, height, vsync_\)/u);
  assert.match(
    nativeDefinition("syncSurfaceSizeToCanvas").text,
    /config\.presentMode = state->presentation\.presentMode/u,
  );
});

test("display.maxFps configures the native presentation ceiling", () => {
  assert.match(runtimeHeader, /uint32_t maxFps = 60/u);
  assert.match(bindingsHeader, /mystral\/webgpu\/presentation\.h/u);
  assert.match(
    source("../include/mystral/webgpu/presentation.h"),
    /setPresentationCapHz\(uint32_t/u,
  );
  assert.match(runtime, /setPresentationCapHz\(config_\.maxFps\)/u);
  assert.match(androidMain, /config\.maxFps/u);
  assert.match(nativeDefinition("reportPresentTick").text, /TN_PRESENTS_TICK:[\s\S]*capHz/u);
});

test("native profiling reports direct and bundled render commands per submit", () => {
  const marker = nativeDefinition("emitAndroidJsNativeProfile").text;
  for (const field of [
    "engine",
    "calls",
    "commands",
    "commandNs",
    "setPipeline",
    "setBindGroup",
    "draw",
    "drawIndexed",
    "bundleDrawIndexed",
    "executeBundles",
    "writeBuffer",
    "writeBufferBytes",
    "writeBufferDistinctTargets",
    "writeBufferSmallCalls",
    "writeBufferSmallNs",
    "writeBufferMediumCalls",
    "writeBufferMediumNs",
    "writeBufferLargeCalls",
    "writeBufferLargeNs",
    "endRenderPass",
    "beginRenderPass",
    "submit",
    "devicePoll",
    "bundlesExecuted",
    "setVertexBuffer",
    "setIndexBuffer",
    "bindingNs",
    "frameOpDrainNs",
    "frameOpReplayNs",
    "submitPollNs",
    "presentNs",
    "presentThreadCpuNs",
  ]) {
    assert.ok(marker.includes(`\\\"${field}\\\"`), `profile marker must contain ${field}`);
  }
  assert.match(marker, /state->profiling\.androidJsNativeProfile = \{\};/u);
  assert.ok(marker.includes('\\"engine\\":\\"" << state->engine->getName()'));

  const replay = nativeDefinition("replayFrameRecords").text;
  for (const command of ["WriteBuffer", "SetPipeline", "DrawIndexed", "Submit", "DevicePoll"]) {
    assert.match(
      replay,
      new RegExp(`endProfiledBinding\\(state, ProfiledRenderCommand::${command}`, "u"),
      `packed replay must time ${command}`,
    );
  }
  assert.match(
    nativeBindingDefinition("GPUDevice", "createBuffer").text,
    /androidJsProfileBufferRegistry/u,
  );

  const uploadMarker = marker;
  for (const field of [
    "frame",
    "writeBufferUsage",
    "writeBufferFullCalls",
    "writeBufferPartialCalls",
  ]) {
    assert.ok(uploadMarker.includes(`\\"${field}\\"`), `upload marker must contain ${field}`);
  }
});

test("busy-loop negative control stays inside timed bindings", () => {
  assert.match(nativeDefinition("beginProfiledBinding").text, /profilingBusyLoop\(\)/u);
});

test("frame window spans exactly the declared number of render intervals", () => {
  assert.match(
    nativeSmoke,
    /#profileFrames === profile\.warmupFrames \+ 1[\s\S]*#profileFrames !== profile\.warmupFrames \+ profile\.frameWindow \+ 1/u,
  );
});

test("measurement installs the immutable archived APK it reports", () => {
  const archiveAt = measurementRunner.indexOf("copyFileSync(builtApkPath, archivedApkPath)");
  const verifyAt = measurementRunner.indexOf("await verifyAndroidFirstProof(proofOptions)");
  assert.ok(archiveAt >= 0 && verifyAt > archiveAt);
  assert.match(
    measurementRunner.slice(archiveAt, verifyAt),
    /"--apk",\s+archivedApkPath,[\s\S]*"--skip-build"/u,
  );
  assert.match(measurementRunner, /TN_ANDROID_JS_SKIP_INSTALL_NOT_EVIDENCE_ELIGIBLE/u);
});

test("the native profile marker reports render-thread CPU, not just wall time", () => {
  // Wall-clock phase timings on a FIFO-presented surface are dominated by vblank waits, which
  // is why desktop A/Bs cannot be judged on fps (PRD-222 F11). CLOCK_THREAD_CPUTIME_ID on the
  // render thread measures the work itself and is comparable across platforms.
  assert.match(nativeDefinition("readRenderThreadCpuNs").text, /CLOCK_THREAD_CPUTIME_ID/u);
  const marker = nativeDefinition("emitAndroidJsNativeProfile").text;
  assert.match(marker, /\\"threadCpuNs\\":/u);
  assert.match(marker, /renderThreadCpuNs/u);
});
