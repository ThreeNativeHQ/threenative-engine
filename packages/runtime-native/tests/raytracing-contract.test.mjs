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
