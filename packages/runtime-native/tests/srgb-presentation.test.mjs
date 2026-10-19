import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { nativeDefinition } from "../../../test-support/native-definition.js";

const WEBGPU_SOURCE_ROOT = fileURLToPath(new URL("../src/webgpu", import.meta.url));

function presentationDefinitions() {
  return {
    configure: nativeDefinition("configureCanvasContext").text,
    context: nativeDefinition("configureSurface").text,
    createTexture: nativeDefinition("createLinearPresentationTexture").text,
    format: nativeDefinition("linearSurfaceFormat").text,
    init: nativeDefinition("initBindings", { root: WEBGPU_SOURCE_ROOT }).text,
    linearRequested: nativeDefinition("linearSurfaceRequested").text,
    marker: nativeDefinition("reportSurfaceFormatMarker").text,
    pipeline: nativeDefinition("ensureSrgbPresentationPipeline").text,
    present: nativeDefinition("presentPendingSurface").text,
    republish: nativeDefinition("republishSurface").text,
    selection: nativeDefinition("selectSurfaceFormat", { root: WEBGPU_SOURCE_ROOT }).text,
  };
}

function assertPresentationBridge(definitions) {
  assert.match(
    definitions.format,
    /RGBA8UnormSrgb[\s\S]*return WGPUTextureFormat_RGBA8Unorm/u,
    "an sRGB-only RGBA surface must expose a linear canvas texture",
  );
  assert.match(
    definitions.createTexture,
    /WGPUTextureUsage_RenderAttachment[\s\S]*WGPUTextureUsage_TextureBinding[\s\S]*WGPUTextureUsage_CopySrc/u,
  );
  assert.match(definitions.pipeline, /fn srgbToLinear\(value: vec3f\)/u);
  assert.match(definitions.pipeline, /colorTarget\.format = state->presentation\.nativeSurfaceFormat/u);
  assert.match(
    definitions.present,
    /presentLinearTextureToSrgbSurface\(state, state->presentation\.currentTextureView\)/u,
  );
  assert.match(
    definitions.configure,
    /configuredFormat != linearSurfaceFormat\(state->presentation\.nativeSurfaceFormat\)/u,
    "the shared canvas configuration must fail closed on a mismatched format",
  );
}

function assertSuccessfulPresentAccounting(definitions) {
  const present = definitions.present;
  const result = present.indexOf("const bool presented =");
  const success = present.indexOf("if (presented)");
  const count = present.indexOf("state->profiling.presentCount += 1;");
  const marker = present.indexOf("TN_SURFACE_FRAME:");
  assert.ok(result >= 0, "surface presentation must record the bridge result");
  assert.ok(success > result, "successful-present accounting must follow the bridge result");
  assert.ok(count > success, "presentCount must increase only after a successful present");
  assert.ok(marker > success, "TN_SURFACE_FRAME must describe a successful present");
}

function assertSurfaceFormatMarker(definitions) {
  assert.match(
    definitions.marker,
    /TN_SURFACE_FORMAT:\{[\s\S]*\}/u,
    "the negotiated surface and render formats must be machine-readable",
  );
  assert.match(definitions.marker, /formatToString\(nativeFormat\)/u);
  assert.match(definitions.marker, /formatToString\(renderFormat\)/u);
  assert.match(definitions.init, /reportSurfaceFormatMarker\(/u);
  assert.match(definitions.republish, /reportSurfaceFormatMarker\(/u);
}

function assertLinearSurfaceAblation(definitions) {
  assert.match(definitions.linearRequested, /debug\.threenative\.linear_surface/u);
  assert.match(definitions.linearRequested, /THREENATIVE_LINEAR_SURFACE/u);
  assert.match(definitions.context, /linearSurfaceRequested\(\)/u);
  assert.match(definitions.selection, /TN_LINEAR_SURFACE_UNSUPPORTED/u);
}

test("sRGB-only native surfaces present Three.js encoded output through a linear canvas", () => {
  assert.doesNotThrow(() => {
    const definitions = presentationDefinitions();
    assertPresentationBridge(definitions);
    assertSuccessfulPresentAccounting(definitions);
    assertSurfaceFormatMarker(definitions);
    assertLinearSurfaceAblation(definitions);
  });
});

test("surface marker contract fails closed when startup reporting is removed", () => {
  const definitions = presentationDefinitions();
  assert.throws(() =>
    assertSurfaceFormatMarker({
      ...definitions,
      init: definitions.init.replace("reportSurfaceFormatMarker", "removedSurfaceFormatMarker"),
    }),
  );
});

test("presentation contract rejects removal of the inverse transfer", () => {
  const definitions = presentationDefinitions();
  definitions.pipeline = definitions.pipeline.replace(
    "fn srgbToLinear(value: vec3f) -> vec3f",
    "fn preserveEncodedValue(value: vec3f) -> vec3f",
  );
  assert.throws(() => assertPresentationBridge(definitions));
});

test("the shared presentation bridge maps normalized canvas coordinates to the whole drawable", () => {
  const pipeline = presentationDefinitions().pipeline;
  assert.match(pipeline, /@location\(0\) uv: vec2f/u);
  assert.match(pipeline, /textureDimensions\(sourceTexture\)/u);
  assert.doesNotMatch(pipeline, /textureLoad\(sourceTexture, vec2i\(position\.xy\)/u);
  assert.match(pipeline, /requiresSrgbPresentationBridge/u,
    "size-only linear presentation must not apply the inverse sRGB transfer");
});
