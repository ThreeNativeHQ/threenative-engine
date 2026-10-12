// CPU-only differential: call the real pinned TRAANode's camera-jitter methods, no renderer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(new URL("../../../core/package.json", import.meta.url));
const { default: TRAANode } = await import(pathToFileURL(require.resolve("three/addons/tsl/display/TRAANode.js")));
const { PerspectiveCamera, OrthographicCamera, WebGPUCoordinateSystem } = await import(pathToFileURL(require.resolve("three/webgpu")));
const offsets = [];
const camera = {
  updateProjectionMatrix() {},
  projectionMatrix: {},
  setViewOffset(_w, _h, x, y) { offsets.push([x, y]); },
  clearViewOffset() {},
};
const effect = new TRAANode(null, null, null, camera);
effect._originalProjectionMatrix.copy = () => {};
effect._velocityNode = { setProjectionMatrix() {} };
for (let i = 0; i < 96; ++i) {
  effect.setViewOffset(320, 240);
  effect.clearViewOffset();
}
const input = readFileSync(0, "utf8");
if (process.argv.includes("--projection")) {
  const line = input.split("\n").find((line) => line.startsWith("TRAA_PROJECTIONS "));
  assert.ok(line, "Null backend must emit the real TraaPass.begin projections");
  const matrices = JSON.parse(line.slice("TRAA_PROJECTIONS ".length));
  for (const [kind, camera] of [new PerspectiveCamera(90, 4 / 3, 1, 10), new OrthographicCamera(-1, 1, 1, -1, 0, 1)].entries()) {
    camera.coordinateSystem = WebGPUCoordinateSystem;
    camera.updateProjectionMatrix();
    const effect = new TRAANode(null, null, null, camera);
    effect._velocityNode = { setProjectionMatrix() {} };
    assert.equal(matrices[kind].length, 96);
    for (let i = 0; i < 96; ++i) {
      effect.setViewOffset(320, 240);
      camera.projectionMatrix.elements.forEach((value, j) => assert.ok(Math.abs(value - matrices[kind][i][j]) < 1e-14, `${kind}/${i}/${j}`));
      effect.clearViewOffset();
    }
    effect.dispose();
  }
  console.log("TRAA perspective/orthographic projection matrices equal pinned three across 96 frames");
  process.exit(0);
}
const native = JSON.parse(input.split("\n")[0]);
assert.deepEqual(native, offsets);
assert.deepEqual(native[31], native[0]);
effect.dispose();
console.log("TRAA jitter equals pinned three across 96 frames (including three's 31-frame wrap)");

// Check the actual production resolve expressions on a greyscale 3x3 neighbourhood.
// Null validates WGSL, but cannot execute pixels; scalar greyscale makes vector math exact.
const source = readFileSync(new URL("../../src/engine/renderer/post/traa.cpp", import.meta.url), "utf8");
// Null cannot execute pixels. Pin the production copy boundary here; traa_reset_seed
// separately checks the copied bytes on a rendering backend.
const rendererSource = readFileSync(new URL("../../src/engine/renderer/renderer.cpp", import.meta.url), "utf8");
const render = rendererSource.slice(rendererSource.indexOf("uint64_t Renderer::render("));
assert.ok(render.indexOf("traa_->seedHistory(encoder, sceneColor_)") >= 0);
assert.ok(render.indexOf("traa_->seedHistory(encoder, sceneColor_)") < render.indexOf("WGPURenderPassEncoder pass = wgpuCommandEncoderBeginRenderPass(encoder, &passDesc)"),
  "reset must copy previous beauty before the scene overwrites it");
const seed = source.slice(source.indexOf("void TraaPass::seedHistory("), source.indexOf("void TraaPass::resolve("));
assert.match(seed, /if \(!needsSeed\(\)\) return;/);
assert.match(seed, /src\.texture = beauty; dst\.texture = historyColor_;/);
assert.match(seed, /wgpuCommandEncoderCopyTextureToTexture/);
assert.doesNotMatch(source.slice(source.indexOf("void TraaPass::resolve(")), /copy\(beauty, historyColor_/);
console.log("TRAA reset copies previous beauty before the scene render");
assert.match(source, /textureSampleLevel\(beauty, linearSampler, input\.uv, 0\.0\)/);
assert.match(source, /textureSampleLevel\(history, linearSampler, historyUV, 0\.0\)/);
function expression(name, values) {
  const match = source.match(new RegExp(`(?:let|var) ${name} = ([^;]+);`));
  assert.ok(match, `missing resolve expression: ${name}`);
  return evaluate(match[1], values);
}
function evaluate(body, values) {
  const scalar = body.replaceAll("vec4(0.0)", "0").replaceAll(/\.(?:rgb|r|g|b)\b/g, "");
  return Function(...Object.keys(values), "max", "sqrt", "mix", "dot", "clamp", "select", `return ${scalar}`)(
    ...Object.values(values), Math.max, Math.sqrt, (a, b, t) => a + (b - a) * t, (a) => a,
    (x, low, high) => Math.min(high, Math.max(low, x)), (a, b, condition) => condition ? b : a,
  );
}
function blend(current, old, neighbours) {
  const values = { current, old, motion: 0, valid: true, currentWeight: expression("currentWeight", {}) };
  for (const [, body] of source.matchAll(/^\s*currentWeight = ([^;]+);/gm)) values.currentWeight = evaluate(body, values);
  values.gamma = expression("gamma", values);
  values.moment1 = current + neighbours.reduce((a, b) => a + b, 0);
  values.moment2 = current * current + neighbours.reduce((a, b) => a + b * b, 0);
  for (const name of ["mean", "variance", "low", "high"]) values[name] = expression(name, values);
  values.clipped = Math.min(values.high, Math.max(values.low, old));
  for (const name of ["compressedCurrent", "compressedHistory", "historyWeight"]) values[name] = expression(name, { ...values, luminance: 1 });
  values.currentWeight /= values.compressedCurrent + 1;
  const result = source.match(/return \(current \* currentWeight \+ clipped \* historyWeight\) \/ max\(currentWeight \+ historyWeight, 0\.00001\);/);
  assert.ok(result, "production flicker reduction changed");
  return (current * values.currentWeight + values.clipped * values.historyWeight) / Math.max(values.currentWeight + values.historyWeight, 0.00001);
}
assert.equal(blend(0.5, 0.5, Array(8).fill(0.5)), 0.5);
assert.ok(Math.abs(blend(0.8, 0.2, [0, 1, 0, 1, 0, 1, 0, 1]) - 578 / 2575) < 1e-12);
assert.ok(Math.abs(blend(0.5, 4, Array(8).fill(0.5)) - 0.5) < 1e-7);
console.log("TRAA production variance/flicker blend passes synthetic 3x3 history checks");
