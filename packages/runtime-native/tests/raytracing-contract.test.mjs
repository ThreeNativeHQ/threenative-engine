import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { nativeDefinition } from "../../../test-support/native-definition.js";

const root = fileURLToPath(new URL("../", import.meta.url));

function read(path) {
  return readFileSync(join(root, path), "utf8");
}

function assertNativeRayTracingGate(body) {
  const refusal = body.indexOf("engine->throwException(kNativeRayTracingUnavailableMessage);");
  const backendCall = body.indexOf("g_rtBackend->traceRays(traceOptions);");
  if (refusal < 0) {
    throw new Error("RED observed: native traceRays refusal gate missing");
  }
  if (backendCall < 0 || refusal > backendCall) {
    throw new Error("RED observed: native traceRays backend call is not behind the refusal gate");
  }
  assert.match(body, /return engine->newUndefined\(\);/u);
}

function assertBatchGate(body) {
  const gate = body.indexOf("found.rayBatch");
  const firstRead = body.indexOf("getArrayBufferData");
  if (gate < 0 || firstRead < gate) {
    throw new Error("RED observed: traceRayBatch reads caller memory before the capability check");
  }
  for (const code of [
    "TN_NATIVE_RAYTRACING_UNAVAILABLE",
    "TN_NATIVE_RAYTRACING_BATCH_INVALID",
    "TN_NATIVE_RAYTRACING_BATCH_FAILED",
  ]) {
    assert.ok(body.includes(code), `traceRayBatch must name ${code}`);
  }
}

// Dawn duplicates an imported fd, so the importer closes its own copy. Without this, every call leaked two fds.
function assertImportedFdIsClosed(transport) {
  if (!/WGPUSharedFence fence = wgpuDeviceImportSharedFence\(device, &descriptor\);\s*close\(fd\);/u.test(transport)) {
    throw new Error("RED observed: the imported fence fd is not closed");
  }
}

// A host-memory batch must not reuse the fence or the buffers of a shared trace still in flight.
function assertStagedBatchWaitsForSharedTrace(vulkan) {
  const staged = vulkan.slice(vulkan.indexOf("TraceRayBatchResult VulkanRTBackend::traceRayBatch("));
  if (!/reclaimSharedTrace\(\)/u.test(staged.slice(0, staged.indexOf("VulkanTLAS* tlas")))) {
    throw new Error("RED observed: traceRayBatch does not wait for a shared trace in flight");
  }
}

function assertGpuBatchGate(body) {
  const gate = body.indexOf("!found.rayBatch || !found.sharedTransport || !shared.available");
  const firstRead = body.indexOf("_bufferId");
  if (gate < 0 || firstRead < gate) {
    throw new Error("RED observed: traceRayBatchGpu reads a GPUBuffer before the transport check");
  }
  for (const code of [
    "TN_NATIVE_RAYTRACING_UNAVAILABLE",
    "TN_NATIVE_RAYTRACING_BATCH_INVALID",
    "TN_NATIVE_RAYTRACING_BATCH_FAILED",
  ]) {
    assert.ok(body.includes(code), `traceRayBatchGpu must name ${code}`);
  }
}

test("native traceRayBatch checks the batch capability before it reads caller memory", () => {
  assertBatchGate(nativeDefinition("js_traceRayBatch").text);
});

test("negative control: dropping the capability check makes the batch contract red", () => {
  const body = nativeDefinition("js_traceRayBatch").text;
  const mutated = body.replace("if (!found.rayBatch) {", "if (false) {");
  assert.notEqual(mutated, body, "the mutation must remove the live capability check");
  assert.throws(() => assertBatchGate(mutated), /RED observed: traceRayBatch reads caller memory/u);
});

test("native traceRays refuses before any backend can report success", () => {
  assertNativeRayTracingGate(nativeDefinition("js_traceRays").text);
});

test("every native preset exposes the same refusal surface", () => {
  const runtime = read("src/runtime.cpp");
  const setupStart = runtime.indexOf("void setupRayTracing()");
  const setupEnd = runtime.indexOf("/**", setupStart);
  assert.ok(setupStart >= 0 && setupEnd > setupStart, "runtime raytracing setup is missing");
  const setup = runtime.slice(setupStart, setupEnd);
  assert.doesNotMatch(setup, /MYSTRAL_HAS_RAYTRACING/u);
  assert.match(setup, /initializeRTBindings\(jsEngine_\.get\(\)\)/u);

  const shutdownStart = runtime.indexOf("void shutdown()");
  const shutdownEnd = runtime.indexOf("void ", shutdownStart + "void shutdown()".length);
  assert.ok(shutdownStart >= 0 && shutdownEnd > shutdownStart, "runtime shutdown is missing");
  const shutdown = runtime.slice(shutdownStart, shutdownEnd);
  assert.doesNotMatch(shutdown, /MYSTRAL_HAS_RAYTRACING/u);
  assert.match(shutdown, /cleanupRTBindings\(\)/u);
});

test("native refusal exceptions reach JavaScriptCore and QuickJS", () => {
  const quickjs = read("src/js/quickjs_engine.cpp");
  assert.match(quickjs, /JSValue takeNativeCallbackException\(\)/u);
  assert.match(
    quickjs,
    /const bool callbackException = engine[\s\S]*return JS_Throw\(ctx, engine->takeNativeCallbackException\(\)\);/u,
  );

  const jsc = read("src/js/jsc_engine.mm");
  assert.match(jsc, /JSValueRef takeNativeCallbackException\(\)/u);
  assert.match(
    jsc,
    /\*exception = callbackData->engine->takeNativeCallbackException\(\);[\s\S]*return nullptr;/u,
  );
});

test("negative control: restoring the old accept path makes the refusal contract red", () => {
  const bindings = nativeDefinition("js_traceRays").text;
  const gate = `if (!kNativeRayTracingResultInteropAvailable) {
        engine->throwException(kNativeRayTracingUnavailableMessage);
        return engine->newUndefined();
    }
`;
  const mutated = bindings.replace(gate, "");
  assert.notEqual(mutated, bindings, "the mutation must remove the live refusal gate");
  assert.throws(
    () => assertNativeRayTracingGate(mutated),
    /RED observed: native traceRays refusal gate missing/u,
  );
});

test("registry marks the refusal scene as native-unavailable until readback exists", () => {
  const registry = JSON.parse(read("conformance/registry.json"));
  const row = registry.tests.find((entry) => entry.id === "98-native-raytracing-refusal");
  assert.deepEqual(
    {
      availability: row?.availability,
      desktopGate: row?.desktopGate,
      required: row?.required,
      status: row?.status,
    },
    {
      availability: "unavailable-until-readback",
      desktopGate: true,
      required: true,
      status: "implemented",
    },
  );
  const scene = read("conformance/scenes/shared/raytracing-refusal.js");
  assert.match(scene, /globalThis\.mystralRT/u);
  assert.match(scene, /TN_NATIVE_RAYTRACING_UNAVAILABLE/u);
  assert.match(scene, /native raytracing refusal:/u);
});

test("registry runs the probe trace row on the desktop lane and the scene names its proof", () => {
  const registry = JSON.parse(read("conformance/registry.json"));
  const row = registry.tests.find((entry) => entry.id === "raytracing-probe-trace");
  assert.deepEqual(
    { desktopGate: row?.desktopGate, required: row?.required, status: row?.status },
    { desktopGate: true, required: true, status: "implemented" },
  );
  const scene = read("conformance/scenes/shared/raytracing-probe-trace.js");
  assert.match(scene, /mystralRT/u);
  assert.match(scene, /traceRayBatch/u);
  assert.match(scene, /bvhIntersectFirstHit/u);
  assert.match(scene, /TN_RT_PROBE_TRACE/u);
  // The web never claims a hardware trace, and a host without one skips with its reason.
  assert.match(scene, /hardwareTrace: "not claimed"/u);
  assert.match(scene, /skipped: true, reason/u);
});

test("native traceRayBatchGpu checks the shared transport before it reads a GPUBuffer", () => {
  assertGpuBatchGate(nativeDefinition("js_traceRayBatchGpu").text);
});

test("negative control: dropping the shared transport check makes the GPU batch contract red", () => {
  const body = nativeDefinition("js_traceRayBatchGpu").text;
  const mutated = body.replace("if (!found.rayBatch || !found.sharedTransport || !shared.available) {", "if (false) {");
  assert.notEqual(mutated, body, "the mutation must remove the live transport check");
  assert.throws(() => assertGpuBatchGate(mutated), /RED observed: traceRayBatchGpu reads a GPUBuffer/u);
});

test("capabilities report the shared transport and why it is off", () => {
  const body = nativeDefinition("js_capabilities").text;
  assert.match(body, /"sharedTransport"/u);
  assert.match(body, /"sharedTransportReason"/u);
  assert.match(body, /webgpu::sharedTraceStatus\(\)/u);
});

test("the shared transport imports its two fences once and closes the fd copies it holds", () => {
  const transport = read("src/webgpu/shared_trace.cpp");
  assertImportedFdIsClosed(transport);
  assert.equal(transport.match(/importFence\(/gu)?.length, 3, "one definition and the two attach-time imports");
  // A failure after the trace is submitted leaves a semaphore signaled with no waiter, so the transport stops.
  assert.match(transport, /g\.broken = message/u);
  // The first call has no earlier trace to wait for.
  assert.match(transport, /g\.raysFreePending \? g\.raysFree : nullptr/u);
});

test("the Vulkan backend keeps its trace semaphores for the life of the shared images", () => {
  const vulkan = read("src/raytracing/vulkan_rt.cpp");
  const trace = vulkan.slice(vulkan.indexOf("SharedTraceResult VulkanRTBackend::traceShared("));
  assert.doesNotMatch(trace.slice(0, trace.indexOf("#else  // _WIN32")), /vkCreateSemaphore|vkGetSemaphoreFdKHR_/u);
  assertStagedBatchWaitsForSharedTrace(vulkan);
});

test("negative control: the two bugs the first smoke found make the transport contract red", () => {
  const transport = read("src/webgpu/shared_trace.cpp");
  const noClose = transport.replace("    close(fd);\n    return fence;", "    return fence;");
  assert.notEqual(noClose, transport, "the mutation must remove the close");
  assert.throws(() => assertImportedFdIsClosed(noClose), /RED observed: the imported fence fd is not closed/u);

  const vulkan = read("src/raytracing/vulkan_rt.cpp");
  const noReclaim = vulkan.replace("    reclaimSharedTrace();\n    if (!batchReady_) return fail(\"the batch path is not available (\"", "    if (!batchReady_) return fail(\"the batch path is not available (\"");
  assert.notEqual(noReclaim, vulkan, "the mutation must remove the reclaim");
  assert.throws(() => assertStagedBatchWaitsForSharedTrace(noReclaim), /RED observed: traceRayBatch does not wait/u);
});

test("the scene proves the GPU transport against the exact trace, before and after the timed calls", () => {
  const scene = read("conformance/scenes/shared/raytracing-probe-trace.js");
  assert.match(scene, /traceRayBatchGpu/u);
  assert.match(scene, /capabilities\.sharedTransport === true/u);
  assert.match(scene, /parityAfterTimedCalls/u);
  assert.match(scene, /TN_RT_GPU_TRANSPORT_ERROR/u);
});
