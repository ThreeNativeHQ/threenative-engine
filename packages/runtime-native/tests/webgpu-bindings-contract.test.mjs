import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  nativeBindingDefinition,
  nativeDefinition,
} from "../../../test-support/native-definition.js";
import { makeTempDirSync } from "../../../test-support/temp-dir.js";
import { runNativeBehavior } from "../scripts/run-native-behavior.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");
const behaviorContract = process.env.TN_NATIVE_BEHAVIOR_CONTRACT;

function blockBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing start marker: ${startMarker}`);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `missing ${signature}`);
  const open = source.indexOf("{", start);
  assert.ok(open > start, `missing body for ${signature}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] !== "}") continue;
    depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  assert.fail(`unterminated body for ${signature}`);
}

function assertRequiredFeatureBuilder(source) {
  const body = functionBody(source, "static RequiredFeatures buildRequiredFeatures(");
  for (const feature of [
    "TextureCompressionBC",
    "TextureCompressionETC2",
    "TextureCompressionASTC",
    "TimestampQuery",
    "RG11B10UfloatRenderable",
  ]) {
    assert.match(
      body,
      new RegExp(`appendIfSupported\\s*\\(\\s*WGPUFeatureName_${feature}\\b`, "u"),
      `buildRequiredFeatures must probe/request ${feature}`,
    );
  }
  assert.match(
    body,
    /#if\s+MYSTRAL_HAS_CORE_FEATURES_AND_LIMITS[\s\S]*appendIfSupported\s*\(\s*WGPUFeatureName_CoreFeaturesAndLimits\b[\s\S]*#endif/u,
    "CoreFeaturesAndLimits must be probed/requested when the backend exposes it",
  );
  assert.match(
    body,
    /if\s*\(\s*allowIndirectFirstInstance\s*\)[\s\S]*appendIfSupported\s*\(\s*WGPUFeatureName_IndirectFirstInstance\b[\s\S]*else\s*\{[\s\S]*IndirectFirstInstance feature disabled/u,
    "IndirectFirstInstance must follow the feature-builder policy input",
  );
  assert.match(
    source,
    /#if\s+defined\(MYSTRAL_WEBGPU_WGPU_MODERN\)\s*&&\s*defined\(__ANDROID__\)\s*const bool allowIndirectFirstInstance\s*=\s*false;[\s\S]*#else\s*const bool allowIndirectFirstInstance\s*=\s*true;[\s\S]*#endif/u,
    "Android modern wgpu must use the indirect-first-instance workaround",
  );
}

const REQUIRED_FEATURE_IDENTIFIERS = [
  "IndirectFirstInstance",
  "TextureAdapterSpecificFormatFeatures",
  "TextureCompressionBC",
  "TextureCompressionETC2",
  "TextureCompressionASTC",
  "TimestampQuery",
  "RG11B10UfloatRenderable",
  "CoreFeaturesAndLimits",
  "TransientAttachments",
];

function featureIdentifiers(text) {
  return new Set(REQUIRED_FEATURE_IDENTIFIERS.filter((identifier) => text.includes(identifier)));
}

function removeOccurrence(source, needle, occurrence) {
  let offset = -1;
  for (let index = 0; index < occurrence; index += 1) {
    offset = source.indexOf(needle, offset + 1);
    assert.ok(offset >= 0, `expected occurrence ${occurrence} of ${needle}`);
  }
  return `${source.slice(0, offset)}${source.slice(offset + needle.length)}`;
}

function assertRequestedAndReportedFeatureSets(source) {
  const requested = featureIdentifiers(
    functionBody(source, "static RequiredFeatures buildRequiredFeatures("),
  );
  const reported = featureIdentifiers(functionBody(source, "static void reportGrantedFeatures("));
  assert.deepEqual(
    reported,
    requested,
    "reportGrantedFeatures must expose every feature the builder can request",
  );
}

function assertFeatureUnpackAtEveryInitialization(source) {
  const starts = [...source.matchAll(/const auto requiredFeatures = buildRequiredFeatures\(/gu)]
    .map(({ index }) => index);
  assert.equal(starts.length, 3, "headless, windowed, and display-backed paths must build features");
  for (const start of starts) {
    const end = source.indexOf("reportGrantedFeatures", start);
    assert.ok(end > start, "each initialization path must report its granted features");
    const block = source.slice(start, end);
    assert.match(block, /hasIndirectFirstInstance_\s*=\s*requiredFeatures\.hasIndirectFirstInstance;/u);
    assert.match(block, /hasTimestampQuery_\s*=\s*requiredFeatures\.hasTimestampQuery;/u);
    assert.match(block, /deviceDesc\.requiredFeatureCount\s*=\s*requiredFeatures\.names\.size\(\);/u);
    assert.match(block, /deviceDesc\.requiredFeatures\s*=\s*!requiredFeatures\.names\.empty\(\)/u);
  }
}

function assertActualIndirectFeatureSurface(source) {
  const adapter = functionBody(source, "static js::JSValueHandle handleGpuAdapterFeaturesHas(");
  const device = functionBody(source, "static js::JSValueHandle handleGpuDeviceFeaturesHas(");
  const adapterIndirect = adapter.match(
    /if\s*\(featureName\s*==\s*"indirect-first-instance"\)\s*\{[\s\S]*?\n\s*\}/u,
  )?.[0];
  const deviceIndirect = device.match(
    /if\s*\(featureName\s*==\s*"indirect-first-instance"\)\s*\{[\s\S]*?\n\s*\}/u,
  )?.[0];
  assert.ok(adapterIndirect, "adapter indirect-first-instance branch is present");
  assert.ok(deviceIndirect, "device indirect-first-instance branch is present");
  assert.match(
    adapterIndirect,
    /wgpuAdapterHasFeature\(\s*state->adapter,\s*WGPUFeatureName_IndirectFirstInstance\)\s*!=\s*0/u,
    "adapter.features.has must report the adapter's actual indirect-first-instance support",
  );
  assert.match(
    deviceIndirect,
    /wgpuDeviceHasFeature\(\s*state->device,\s*WGPUFeatureName_IndirectFirstInstance\)\s*!=\s*0/u,
    "device.features.has must report the device's actual granted indirect-first-instance support",
  );
  assert.doesNotMatch(
    adapterIndirect,
    /newBoolean\(true\)/u,
    "adapter.features.has must not advertise an unqueried indirect-first-instance feature",
  );
  assert.doesNotMatch(
    deviceIndirect,
    /newBoolean\(true\)/u,
    "device.features.has must not advertise an unrequested indirect-first-instance feature",
  );
}

function assertBothBackendsMapRg11Feature(source) {
  const marker = 'if (featureName == "rg11b10ufloat-renderable")';
  const markerStart = source.indexOf(marker);
  assert.ok(markerStart >= 0, "RG11B10UfloatRenderable JS feature mapping is present");
  const conditionalStart = source.lastIndexOf("#if", markerStart);
  assert.ok(conditionalStart >= 0, "RG11B10UfloatRenderable mapping has a backend guard");
  const mappingWindow = source.slice(conditionalStart, markerStart + 180);
  assert.match(
    mappingWindow,
    /#if\s+defined\(MYSTRAL_WEBGPU_DAWN\)\s*\|\|\s*defined\(MYSTRAL_WEBGPU_WGPU\)/u,
    "RG11B10UfloatRenderable mapping must compile for Dawn and wgpu-native",
  );
  assert.match(
    mappingWindow,
    /if\s*\(featureName\s*==\s*"rg11b10ufloat-renderable"\)\s*return\s+WGPUFeatureName_RG11B10UfloatRenderable;/u,
    "RG11B10UfloatRenderable must map to the bundled WebGPU enum",
  );
}

function handlerForRow(surface, name) {
  return nativeBindingDefinition(surface, name).text;
}

test("feature sets report actual adapter support and device grants", () => {
  assertActualIndirectFeatureSurface(read("src/webgpu/bindings.cpp"));
});

test("native requestAdapter publishes the real adapter.info identity", () => {
  const bindings = read("src/webgpu/bindings.cpp");
  assert.match(bindings, /wgpuAdapterGetInfo\(state->adapter, &adapterInfo\)/u);
  assert.match(bindings, /setProperty\(adapter, "info", info\)/u);
  assert.match(bindings, /wgpuAdapterInfoFreeMembers\(adapterInfo\)/u);

  // Core reads the software-adapter fact from these four names, so the host has to publish exactly
  // them: a rename on either side would leave `softwareAdapter` absent on native while the web
  // lane kept working, which is a silent platform split rather than a failure.
  for (const field of ["architecture", "description", "device", "vendor"]) {
    assert.match(bindings, new RegExp(`"${field}", state->engine->newString`, "u"), `native adapter.info must publish ${field}`);
  }

  const withoutInfo = bindings.replace(
    /WGPUAdapterInfo adapterInfo = \{\};[\s\S]*?wgpuAdapterInfoFreeMembers\(adapterInfo\);/u,
    "",
  );
  assert.notEqual(withoutInfo, bindings, "negative control must remove the adapter.info bridge");
  assert.throws(
    () => assert.match(withoutInfo, /setProperty\(adapter, "info", info\)/u),
    /setProperty/u,
    "the regression must fail when native adapter identity is hidden from the census",
  );
});

test("RG11B10UfloatRenderable is mapped for both shipped WebGPU backends", () => {
  assertBothBackendsMapRg11Feature(read("src/webgpu/bindings.cpp"));
});

test("every binding translation unit that polls wgpu-native includes its extension declaration", () => {
  const bindingsDirectory = join(root, "src/webgpu");
  const pollingSources = readdirSync(bindingsDirectory)
    .filter((name) => name.startsWith("bindings") && name.endsWith(".cpp"))
    .map((name) => ({ name, source: read(`src/webgpu/${name}`) }))
    .filter(({ source }) => source.includes("wgpuDevicePoll("));

  assert.ok(pollingSources.length > 0, "expected at least one wgpuDevicePoll binding caller");
  for (const { name, source } of pollingSources) {
    assert.match(
      source,
      /#include\s+[<"](?:webgpu|wgpu)\/wgpu\.h[>"]|WGPUBool\s+wgpuDevicePoll\s*\(/u,
      `${name} calls wgpuDevicePoll without including or declaring the wgpu-native extension API`,
    );
  }
});

function assertBindGroupViewOwnership(bindGroup) {
  assert.match(
    bindGroup,
    /auto releaseAutoCreatedViews = \[&autoCreatedViews\]\(\) \{\s*for \(auto v : autoCreatedViews\) \{\s*wgpuTextureViewRelease\(v\);\s*\}\s*\};/u,
    "createBindGroup must own its automatically created views locally",
  );
  const failureStart = bindGroup.indexOf("if (!bindGroup) {");
  const failureRelease = bindGroup.indexOf("releaseAutoCreatedViews();", failureStart);
  const failureReturn = bindGroup.indexOf("return state->engine->newUndefined();", failureStart);
  const successRelease = bindGroup.indexOf("releaseAutoCreatedViews();", failureRelease + 1);
  const wrapperCreation = bindGroup.indexOf("auto jsBindGroup = createNativeWrapper(");
  assert.ok(failureStart >= 0, "createBindGroup must check the native handle");
  assert.ok(failureRelease > failureStart, "the failure path must release every created view");
  assert.ok(failureRelease < failureReturn, "view cleanup must precede the error return");
  assert.ok(successRelease > failureReturn, "the successful path must retain its view cleanup");
  assert.ok(
    successRelease < wrapperCreation,
    "successful ownership must be released before wrapping",
  );
}

function assertNullResourceValidation(bindGroup) {
  assert.ok(
    bindGroup.includes(
      "if (state->engine->isUndefined(resource) || state->engine->isNull(resource)) {",
    ),
    "a valid layout must not accept a null or undefined resource",
  );
  for (const failure of [
    'return failResource("resource", "resource handle is null or undefined", bgEntry.binding);',
    'return failResource("buffer", "native handle is null", bgEntry.binding);',
    'return failResource("sampler", "native handle is null", bgEntry.binding);',
    'return failResource("texture view", "native handle is null", bgEntry.binding);',
    'return failResource("resource", "native handle is null", bgEntry.binding);',
  ]) {
    assert.ok(bindGroup.includes(failure), `missing fail-closed resource path: ${failure}`);
  }
  assert.doesNotMatch(bindGroup, /\[WebGPU\] Warning: (Sampler|TextureView|Resource at binding)/u);
}

test("bind-group creation releases automatically created views on failure and success", () => {
  assert.doesNotThrow(() =>
    assertBindGroupViewOwnership(handlerForRow("GPUDevice", "createBindGroup")),
  );
});

test("bind-group creation rejects null sampler, view, buffer, and generic resources", () => {
  assert.doesNotThrow(() =>
    assertNullResourceValidation(handlerForRow("GPUDevice", "createBindGroup")),
  );
});

test("resource validation contract rejects restoring the warning path", () => {
  const warningPath = handlerForRow("GPUDevice", "createBindGroup").replace(
    'return failResource("sampler", "native handle is null", bgEntry.binding);',
    'std::cerr << "[WebGPU] Warning: Sampler is null" << std::endl;',
  );
  assert.throws(() => assertNullResourceValidation(warningPath));
});

test("bind-group ownership contract rejects removing failure-path view cleanup", () => {
  const withoutFailureCleanup = handlerForRow("GPUDevice", "createBindGroup").replace(
    /if \(!bindGroup\) \{\n\s*releaseAutoCreatedViews\(\);/u,
    "if (!bindGroup) {",
  );
  assert.throws(() => assertBindGroupViewOwnership(withoutFailureCleanup));
});

function assertBindGroupNativeResultCheck(bindGroup) {
  assert.match(
    bindGroup,
    /WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup\(state->device, &bgDesc\);[\s\S]*?if \(!bindGroup\) \{[\s\S]*?state->engine->throwException\("Failed to create bind group"\);[\s\S]*?return state->engine->newUndefined\(\);/u,
    "native bind-group creation failure must not escape as a wrapper",
  );
}

test("bind-group creation retains its post-call null native-handle guard", () => {
  assert.doesNotThrow(() =>
    assertBindGroupNativeResultCheck(handlerForRow("GPUDevice", "createBindGroup")),
  );
});

test("bind-group native-result contract rejects deleting the post-call guard", () => {
  const withoutGuard = handlerForRow("GPUDevice", "createBindGroup").replace(
    /(WGPUBindGroup bindGroup = wgpuDeviceCreateBindGroup\(state->device, &bgDesc\);)\n\s*if \(!bindGroup\) \{[\s\S]*?state->engine->throwException\("Failed to create bind group"\);[\s\S]*?return state->engine->newUndefined\(\);\n\s*\}/u,
    "$1",
  );
  assert.throws(() => assertBindGroupNativeResultCheck(withoutGuard));
});

test("all JS engines expose owned destination and descriptor controls", () => {
  const engine = read("include/mystral/js/engine.h");

  assert.match(engine, /bool enumerable = false;/u);
  assert.match(engine, /bool configurable = false;/u);
  assert.match(
    engine,
    /virtual bool getPropertyInfo\(JSValueHandle obj, const char\* name, JSPropertyInfo& info\) = 0;/u,
  );
  assert.match(engine, /virtual void releasePropertyInfo\(JSPropertyInfo& info\) = 0;/u);
  assert.match(engine, /virtual bool hasProperty\(JSValueHandle obj, const char\* name\) = 0;/u);
  assert.match(engine, /virtual bool deleteProperty\(JSValueHandle obj, const char\* name\) = 0;/u);
  assert.match(engine, /virtual bool isBindingDestination\(JSValueHandle value\) = 0;/u);
  for (const implementationPath of [
    "src/js/v8_engine.cpp",
    "src/js/quickjs_engine.cpp",
    "src/js/jsc_engine.mm",
  ]) {
    const source = read(implementationPath);
    assert.match(
      source,
      /bool getPropertyInfo\(JSValueHandle obj, const char\* name, JSPropertyInfo& info\) override/u,
    );
    assert.match(source, /void releasePropertyInfo\(JSPropertyInfo& info\) override/u);
    assert.match(source, /bool hasProperty\(JSValueHandle obj, const char\* name\) override/u);
    assert.match(source, /bool deleteProperty\(JSValueHandle obj, const char\* name\) override/u);
    assert.match(source, /bool isBindingDestination\(JSValueHandle value\) override/u);
    assert.doesNotMatch(source, /JavaScript property assignment did not create a property/u);
    assert.doesNotMatch(source, /JSValueIsStrictEqual\(context_, stored/u);
  }
});

test("binding destination ownership is unforgeable from JavaScript", () => {
  const v8 = read("src/js/v8_engine.cpp");
  const quickjs = read("src/js/quickjs_engine.cpp");
  const jsc = read("src/js/jsc_engine.mm");

  assert.match(v8, /bindingDestinationKey_\.Reset\(isolate_, v8::Private::New/u);
  assert.match(v8, /local->IsProxy\(\)/u);
  assert.match(quickjs, /JS_NewClassID\(runtime_, &bindingDestinationClassId_\)/u);
  assert.match(quickjs, /JS_NewObjectProtoClass\(/u);
  assert.match(quickjs, /JS_GetClassID\(object\) != bindingDestinationClassId_/u);
  assert.doesNotMatch(quickjs, /bindingDestinationMarker_|JS_NewSymbol/u);
  assert.match(jsc, /JSValueIsObjectOfClass\(context_, object, ordinaryObjectClass_\)/u);
  assert.match(jsc, /JSObjectSetPrototype\(context_, object, objectPrototype_\)/u);

  const destinationBlocks = [
    blockBetween(v8, "bool isBindingDestination", "bool isSameValue"),
    blockBetween(quickjs, "bool isBindingDestination", "bool isSameValue"),
    blockBetween(jsc, "bool isBindingDestination", "bool isSameValue"),
  ];
  for (const destinationBlock of destinationBlocks) {
    assert.doesNotMatch(
      destinationBlock,
      /context->Global|JS_GetGlobalObject|JSContextGetGlobalObject/u,
      "an exotic global object must not be a binding destination",
    );
  }
});

test("binding destinations reject proxies before descriptor traversal", () => {
  const engine = read("include/mystral/js/engine.h");
  const v8 = read("src/js/v8_engine.cpp");
  const quickjs = read("src/js/quickjs_engine.cpp");
  const jsc = read("src/js/jsc_engine.mm");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");

  assert.match(engine, /side-effect-free binding destination/u);
  assert.match(v8, /IsProxy\(\)/u);
  assert.match(quickjs, /JS_IsProxy/u);
  assert.match(jsc, /JSValueIsObjectOfClass/u);
  assert.match(nativeControl, /a rejected proxy descriptor trap ran/u);
  assert.match(nativeControl, /a rejected proxy set trap ran/u);
  assert.match(nativeControl, /getProperty\(revoked/u);
});

test("descriptor snapshot ownership is explicit for V8, QuickJS, and JSC", () => {
  const implementation = nativeDefinition("installBindingTable").text;
  const v8 = read("src/js/v8_engine.cpp");
  const quickjs = read("src/js/quickjs_engine.cpp");
  const jsc = read("src/js/jsc_engine.mm");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");

  assert.match(v8, /void releasePropertyInfo\([\s\S]*frameHandles_\.erase/u);
  assert.match(quickjs, /void releasePropertyInfo\([\s\S]*JS_FreeValue/u);
  assert.match(jsc, /info\.value\s*=\s*\{\(void\*\)value, context_\};[\s\S]*JSValueProtect/u);
  assert.match(jsc, /void releasePropertyInfo\([\s\S]*JSValueUnprotect/u);
  assert.match(jsc, /reflectSet_[\s\S]*JSValueProtect/u);
  assert.match(jsc, /replaceLastException\([\s\S]*JSValueProtect/u);
  assert.match(jsc, /getException\(\)[\s\S]*JSValueUnprotect/u);
  assert.match(jsc, /~JSCEngine\(\)[\s\S]*clearLastException/u);
  assert.match(
    implementation,
    /engine->freezeHandle\(function\)[\s\S]*protectedExpectedValues\.push_back\(function\)/u,
  );
  assert.match(
    implementation,
    /for \(auto it = protectedExpectedValues\.rbegin\(\)[\s\S]*engine->freeHandle\(\*it\)/u,
  );
  assert.doesNotMatch(
    blockBetween(jsc, "bool setProperty(JSValueHandle obj", "JSValueHandle getProperty"),
    /JSObjectSetProperty/u,
  );
  assert.match(
    nativeControl,
    /setProperty\(revoked[\s\S]*engine->gc\(\);[\s\S]*engine->getException\(\)/u,
  );
});

test("QuickJS teardown does not execute pending binding callbacks", () => {
  const quickjs = read("src/js/quickjs_engine.cpp");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");
  const destructor = blockBetween(
    quickjs,
    "~QuickJSEngine() override",
    "EngineType getType() const override",
  );

  assert.doesNotMatch(destructor, /JS_ExecutePendingJob/u);
  assert.match(nativeControl, /queued QuickJS callback executed during runtime teardown/u);
});

function behaviorExecutable(body) {
  const directory = makeTempDirSync("tn-native-behavior-");
  const path = join(directory, "probe.mjs");
  writeFileSync(path, `${body}\n`);
  return path;
}

test.runIf(!behaviorContract || behaviorContract === "webgpu")(
  "native behavior preserves binding transactions and active wrapper state",
  () => {
    const productExecutable = process.env.TN_NATIVE_BEHAVIOR_EXECUTABLE;
    const fixture = behaviorExecutable(`
    console.log("proof: public-binding-surface");
    console.log("proof: detached-bundle-method-after-gc");
    console.log("proof: bundle-method-pinned-during-reentrant-gc");
    console.log("proof: call-trace");
    console.log("proof: async-observation");
    console.log("proof: whole-table-verification");
    console.log("proof: wrapper-rollback");
  `);
    const executable = productExecutable ?? process.execPath;
    const args = productExecutable ? [] : [fixture];
    const result = runNativeBehavior(
      executable,
      [
        "public-binding-surface",
        "detached-bundle-method-after-gc",
        "bundle-method-pinned-during-reentrant-gc",
        "call-trace",
        "async-observation",
        "whole-table-verification",
        "wrapper-rollback",
      ],
      args,
    );
    assert.deepEqual(result.proofs, [
      "public-binding-surface",
      "detached-bundle-method-after-gc",
      "bundle-method-pinned-during-reentrant-gc",
      "call-trace",
      "async-observation",
      "whole-table-verification",
      "wrapper-rollback",
    ]);
  },
);

test.runIf(!behaviorContract || behaviorContract === "creation")(
  "WebGPU creation rejects invalid sampler and bind-group handles at the API call",
  () => {
    const productExecutable = process.env.TN_NATIVE_BEHAVIOR_EXECUTABLE;
    const fixture = behaviorExecutable('console.log("proof: creation-refusal");');
    const result = runNativeBehavior(
      productExecutable ?? process.execPath,
      ["creation-refusal"],
      productExecutable ? [] : [fixture],
    );
    assert.deepEqual(result.proofs, ["creation-refusal"]);
  },
);

test.runIf(!behaviorContract || behaviorContract === "command-encoder")(
  "GPUCommandEncoder installs its table once per class, not per call",
  () => {
    const productExecutable = process.env.TN_NATIVE_BEHAVIOR_EXECUTABLE;
    const fixture = behaviorExecutable('console.log("proof: command-encoder-class-table");');
    const result = runNativeBehavior(
      productExecutable ?? process.execPath,
      ["command-encoder-class-table"],
      productExecutable ? [] : [fixture],
    );
    assert.deepEqual(result.proofs, ["command-encoder-class-table"]);
  },
);

test.runIf(!behaviorContract || behaviorContract === "render-pass")(
  "GPURenderPassEncoder installs once per class and resolves its paired encoder",
  () => {
    const productExecutable = process.env.TN_NATIVE_BEHAVIOR_EXECUTABLE;
    const fixture = behaviorExecutable('console.log("proof: render-pass-class-table");');
    const result = runNativeBehavior(
      productExecutable ?? process.execPath,
      ["render-pass-class-table"],
      productExecutable ? [] : [fixture],
    );
    assert.deepEqual(result.proofs, ["render-pass-class-table"]);
  },
);

test("wrapper rollback behavior proof fails closed", () => {
  const missing = behaviorExecutable('console.log("native executable passed");');
  assert.throws(
    () => runNativeBehavior(process.execPath, ["wrapper-rollback"], [missing]),
    /native behavior proof is missing: wrapper-rollback/u,
  );

  const duplicate = behaviorExecutable(`
    console.log("proof: wrapper-rollback");
    console.log("proof: wrapper-rollback");
  `);
  assert.throws(
    () => runNativeBehavior(process.execPath, ["wrapper-rollback"], [duplicate]),
    /native behavior proof is duplicated: wrapper-rollback/u,
  );
});

test("QuickJS callback result tests cover transfer and protected duplication on both engines", () => {
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");

  assert.match(nativeControl, /unprotected-result/u);
  assert.match(nativeControl, /protected-result/u);
  assert.match(
    nativeControl,
    /checkQuickJSCallbackResultOwnership\(\*first\)[\s\S]*checkQuickJSCallbackResultOwnership\(\*second\)/u,
  );
});

test("QuickJS centrally replaces and clears owned exception values", () => {
  const quickjs = read("src/js/quickjs_engine.cpp");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");
  const destructor = blockBetween(
    quickjs,
    "~QuickJSEngine() override",
    "EngineType getType() const override",
  );

  assert.match(
    quickjs,
    /void clearLastException\(\)[\s\S]*JS_IsNull\(lastException_\)[\s\S]*JS_IsUndefined\(lastException_\)[\s\S]*JS_FreeValue/u,
  );
  assert.match(
    quickjs,
    /void replaceLastException\(JSValue exception\)[\s\S]*clearLastException\(\)[\s\S]*lastException_ = exception/u,
  );
  assert.match(
    quickjs,
    /JSValue takeNativeCallbackException\(\)[\s\S]*lastException_ = JS_UNDEFINED/u,
  );
  assert.equal(
    quickjs.match(/lastException_\s*=/gu)?.length,
    4,
    "only clear, replace, takeNativeCallbackException, and the member initializer may assign lastException_",
  );
  assert.match(destructor, /clearLastException\(\)[\s\S]*JS_FreeContext/u);
  for (const directReplacement of [
    blockBetween(quickjs, "JSValueHandle evalWithResult", "bool evalScript("),
    blockBetween(
      quickjs,
      "JSValueHandle evalScriptWithResult",
      "// ========================================================================\n    // Global Object Access",
    ),
    blockBetween(
      quickjs,
      "JSValueHandle call(",
      "// ========================================================================\n    // Memory Management",
    ),
  ]) {
    assert.match(directReplacement, /replaceLastException\(exception\)/u);
    assert.doesNotMatch(directReplacement, /lastException_ = exception/u);
  }
  assert.match(
    nativeControl,
    /quickjs-first-unconsumed[\s\S]*quickjs-second-unconsumed[\s\S]*quickjs-call-unconsumed[\s\S]*quickjs-outstanding-at-teardown/u,
  );
});

test("JSC native callbacks use callable private data with owner-qualified lifetime", () => {
  const jsc = read("src/js/jsc_engine.mm");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");
  const newFunction = blockBetween(
    jsc,
    "JSValueHandle newFunction",
    "// ========================================================================\n    // Value Conversion",
  );

  assert.doesNotMatch(jsc, /g_nativeFunctions|nativeFunctionKeys_/u);
  assert.match(
    jsc,
    /struct NativeFunctionData[\s\S]*NativeFunction callback[\s\S]*JSGlobalContextRef owner/u,
  );
  assert.match(
    newFunction,
    /JSObjectMake\(\s*context_, nativeFunctionClass_,\s*new NativeFunctionData/u,
  );
  assert.match(jsc, /nativeFunctionDefinition\.finalize = &finalizeNativeFunction/u);
  assert.match(jsc, /nativeFunctionDefinition\.callAsFunction = &nativeCallback/u);
  assert.match(jsc, /JSObjectGetPrivate\(function\)/u);
  assert.match(jsc, /callbackData->owner != JSContextGetGlobalContext\(ctx\)/u);
  assert.match(jsc, /delete static_cast<NativeFunctionData\*>\(JSObjectGetPrivate\(object\)\)/u);
  assert.match(jsc, /replaceLastException\([\s\S]*JSValueProtect/u);
  assert.match(jsc, /reflectSet_[\s\S]*JSObjectCallAsFunction/u);
  assert.match(
    nativeControl,
    /Runtime::create\(config\)[\s\S]*replacement\.reset\(\)[\s\S]*surviving engine callback changed after replacement teardown/u,
  );
});

test("all engines implement Object.is SameValue and QuickJS performance uses its callback context", () => {
  const v8 = read("src/js/v8_engine.cpp");
  const quickjs = read("src/js/quickjs_engine.cpp");
  const jsc = read("src/js/jsc_engine.mm");
  const nativeControl = read("tests/webgpu_bindings_reentrancy_test.cpp");

  assert.match(v8, /->SameValue\(/u);
  assert.doesNotMatch(
    blockBetween(
      v8,
      "bool isSameValue",
      "// ========================================================================\n    // Object Operations",
    ),
    /StrictEquals/u,
  );
  assert.match(quickjs, /JS_IsSameValue\(context_/u);
  assert.doesNotMatch(quickjs, /engineInstance_/u);
  assert.match(
    quickjs,
    /js_performance_now[\s\S]*JS_GetContextOpaque\(ctx\)[\s\S]*engine->startTime_/u,
  );
  assert.match(jsc, /std::signbit/u);
  assert.match(jsc, /std::isnan/u);
  assert.match(nativeControl, /SameValue rollback verification/u);
  assert.match(
    nativeControl,
    /first\.reset\(\)[\s\S]*performance\.now\(\) > 0[\s\S]*lost its context owner/u,
  );
});

function assertEveryTableInstallIsChecked(candidate) {
  const calls = candidate.match(/installBindingTable\(/gu) ?? [];
  const checked = candidate.match(/if \(!installBindingTable\(/gu) ?? [];
  assert.ok(calls.length > 0, "expected binding-table installation sites");
  assert.equal(
    checked.length,
    calls.length,
    "every dynamic table/factory installation must propagate failure",
  );
}

test("top-level WebGPU table installation propagates every failure", () => {
  const installer = nativeDefinition("installWebGPUBindingTables").text;
  assertEveryTableInstallIsChecked(installer);

  const ignoredFailure = installer.replace("if (!installBindingTable(", "installBindingTable(");
  assert.throws(() => assertEveryTableInstallIsChecked(ignoredFailure), /propagate failure/u);
});

test("texture and pipeline wrapper factories propagate table-install failure", () => {
  const factories = read("src/webgpu/wrapper_factories.cpp");
  assert.match(factories, /#include "mystral\/webgpu\/registration_table\.h"/u);
  assert.match(factories, /installBindingTable\(/u);
  for (const key of ['"GPUTexture", "createView"', '"GPUTexture", "destroy"']) {
    assert.match(factories, new RegExp(`\\{${key}`, "u"));
  }
  assert.match(
    factories,
    /const char\* pipelineSurface = renderPipeline \? "GPURenderPipeline" : "GPUComputePipeline"/u,
  );
  assert.match(factories, /\{pipelineSurface, "getBindGroupLayout"/u);
  assert.doesNotMatch(factories, /newFunction\(/u);
  assertEveryTableInstallIsChecked(factories);

  const ignoredFailure = factories.replace("if (!installBindingTable(", "installBindingTable(");
  assert.throws(() => assertEveryTableInstallIsChecked(ignoredFailure), /propagate failure/u);
});

function assertSurfaceViewLifetime(state, factories, presentation, frameStream, commands) {
  assert.match(state, /std::unordered_map<uint64_t, WGPUTextureView> currentSurfaceTextureViews/u);
  assert.match(factories, /trackCurrentSurfaceTextureView\(state, viewId, view\)/u);
  assert.match(factories, /untrackCurrentSurfaceTextureView\(state, viewId\)/u);
  assert.ok(
    (presentation.match(/releaseCurrentSurfaceTextureViews\(state\)/gu) ?? []).length >= 3,
    "present, resize, and detach must release every view of the current surface texture",
  );
  assert.match(frameStream, /isCurrentSurfaceTextureView\(state, c\.view\)/u);
  assert.match(frameStream, /isCurrentSurfaceTextureView\(state, c\.resolveTarget\)/u);
  assert.match(commands, /isCurrentSurfaceTextureView\(state, view\)/u);
  assert.match(commands, /isCurrentSurfaceTextureView\([\s\S]*colorAttachment\.resolveTarget/u);
  assert.doesNotMatch(frameStream, /c\.view == state->presentation\.currentTextureView/u);
}

test("all views created from one surface texture share the host-frame lifetime", () => {
  const inputs = [
    read("src/webgpu/bindings_state.h"),
    read("src/webgpu/wrapper_factories.cpp"),
    read("src/webgpu/bindings_presentation.cpp"),
    read("src/webgpu/bindings_frame_stream.cpp"),
    read("src/webgpu/bindings_commands.cpp"),
  ];
  assertSurfaceViewLifetime(...inputs);

  const latestViewOnly = inputs[3].replace(
    "isCurrentSurfaceTextureView(state, c.view)",
    "c.view == state->presentation.currentTextureView",
  );
  assert.throws(
    () => assertSurfaceViewLifetime(inputs[0], inputs[1], inputs[2], latestViewOnly, inputs[4]),
    /isCurrentSurfaceTextureView/u,
  );
});

test("backend and canvas contexts do not use process-global ownership", () => {
  const context = read("src/webgpu/context.cpp");
  assert.doesNotMatch(read("src/js/v8_engine.cpp"), /g_protectedHandles/u);
  const quickjs = read("src/js/quickjs_engine.cpp");
  assert.doesNotMatch(quickjs, /g_protectedHandles/u);
  assert.doesNotMatch(
    blockBetween(
      quickjs,
      "void freezeHandle(JSValueHandle value)",
      "size_t outstandingHandleCount() const override",
    ),
    /JS_DupValue/u,
  );
  const canvas2d = [
    "evalCanvasScript",
    "createCanvas2DJSObject",
    "createCanvas2DContext",
    "getCanvas2DContextFromJS",
  ]
    .map((symbol) => nativeDefinition(symbol).text)
    .join("\n");
  assert.doesNotMatch(canvas2d, /g_canvas2dContexts|g_jsEngine/u);
  assert.doesNotMatch(canvas2d, /engine->freezeHandle\(jsCtx\)/u);
  assert.match(context, /RequiredFeatures buildRequiredFeatures\(WGPUAdapter adapter/u);
  assertRequiredFeatureBuilder(context);
  assertRequestedAndReportedFeatureSets(context);
  assertFeatureUnpackAtEveryInitialization(context);
  assert.equal(
    context.match(/buildRequiredFeatures\(adapter_/gu)?.length,
    3,
    "headless, windowed, and display-backed device creation must share the feature builder",
  );
  assert.doesNotMatch(context, /requiredFeatures(?:Android|Dawn|WGPU)\[/u);

  const withoutBc = context.replace(
    /appendIfSupported\s*\(\s*WGPUFeatureName_TextureCompressionBC[\s\S]*?\)\s*;/u,
    "/* removed by the audited-feature negative control */",
  );
  assert.notEqual(withoutBc, context, "negative control must remove BC from the feature builder");
  assert.throws(
    () => assertRequiredFeatureBuilder(withoutBc),
    /TextureCompressionBC/u,
    "the contract must fail when an audited feature is removed",
  );

  const withoutTextureReporter = context.replace(
    /\s*\{static_cast<WGPUFeatureName>\(WGPUNativeFeature_TextureAdapterSpecificFormatFeatures\), "texture-adapter-specific-format-features"\},/u,
    "",
  );
  assert.notEqual(withoutTextureReporter, context, "negative control must remove the native feature reporter");
  assert.throws(
    () => assertRequestedAndReportedFeatureSets(withoutTextureReporter),
    /reportGrantedFeatures/u,
    "the contract must fail when a requested feature is omitted from reporting",
  );

  const withoutWindowedTimestamp = removeOccurrence(
    context,
    "hasTimestampQuery_ = requiredFeatures.hasTimestampQuery;",
    2,
  );
  assert.notEqual(withoutWindowedTimestamp, context, "negative control must remove a timestamp unpack");
  assert.throws(
    () => assertFeatureUnpackAtEveryInitialization(withoutWindowedTimestamp),
    /hasTimestampQuery_|three.*paths/u,
    "the contract must fail when one initialization path drops timestamp state",
  );
});

test("GPU video fallback rejects missing binding state before callback registration", () => {
  const publicHeader = read("include/mystral/video/video_recorder.h");
  const factory = read("src/video/video_recorder.cpp");
  const fallback = read("src/video/gpu_readback_recorder.cpp");
  const cli = read("src/cli/main.cpp");

  assert.match(publicHeader, /VideoRecorder::create\(device, queue, instance, bindingsState\)/u);
  assert.match(publicHeader, /void\* bindingsState\s*\)/u);
  assert.match(factory, /if \(!bindingsState\)[\s\S]*requires an owning WebGPU bindings state/u);
  assert.match(fallback, /if \(!bindingsState_\)[\s\S]*return false;/u);
  assert.match(fallback, /if \(!bindingsState\)[\s\S]*return nullptr;/u);
  assert.match(cli, /VideoRecorder::create\([\s\S]*getWebGPUBindingsState\(\)/u);

  const withoutFactoryGuard = factory.replace(/if \(!bindingsState\) \{[\s\S]*?\n\s*\}/u, "");
  assert.throws(
    () => assert.match(withoutFactoryGuard, /if \(!bindingsState\)/u),
    /bindingsState/u,
  );
});

test("the missing-state video guard is wired to a native executable", () => {
  assert.match(
    read("CMakeLists.txt"),
    /add_executable\(threenative-video-recorder-state-test EXCLUDE_FROM_ALL[\s\S]*video_recorder_state_test\.cpp\)/u,
  );
  assert.match(
    read("tests/video_recorder_state_test.cpp"),
    /native video recorder missing-state guard passed/u,
  );
});
