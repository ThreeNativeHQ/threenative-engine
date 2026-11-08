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
assert.deepEqual(native[32], native[0]);
assert.notDeepEqual(native[31], native[0]);
effect.dispose();
console.log("TRAA jitter equals pinned three across 96 frames (three's 32-frame wrap)");

// The resolve's own arithmetic (variance clamp, luminance-compressed weights) and its reset seed are pixel
// behaviour: renderer_test.cpp's traa_resolve_blend and traa_reset_seed read them back from the GPU.
