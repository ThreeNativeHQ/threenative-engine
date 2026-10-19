import { installThreePlaytestBridge } from "@threenative/playtest/three";
import { NoToneMapping, PerspectiveCamera, Scene, WebGPURenderer } from "three/webgpu";
import { createTemporalAAFixture } from "../../packages/runtime-native/conformance/scenes/shared/temporal-aa-fixture.js";

const query = new URLSearchParams(location.search);
const variantName = query.get("variant") ?? "temporal";
const measurement = query.has("measure");
const raw4 = query.has("raw4");
// The scaled arm is the browser control for the native conformance capture, which publishes the
// 1280x720 display raster. Its measurement size would put the two hosts on different raster pairs.
const scaled = variantName.startsWith("scaled");
// Each 4x reference arm renders its own family's reference role at four times the display raster
// and is downsampled by the scorer, exactly as the original route does.
const supersampled = variantName === "supersampled" || variantName === "quality-supersampled";
const family = variantName.startsWith("quality-") ? "quality-" : "";
const rasterScale = supersampled ? 4 : 1;
const width = measurement && !scaled ? 640 * rasterScale : 1280;
const height = measurement && !scaled ? 360 * rasterScale : 720;
const renderer = new WebGPURenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(width, height);
renderer.toneMapping = NoToneMapping;
document.body.appendChild(renderer.domElement);
await renderer.init();
const scene = new Scene();
const camera = new PerspectiveCamera(50, 1280 / 720, 0.1, 100);
const fixture = createTemporalAAFixture(
  renderer,
  scene,
  camera,
  supersampled ? `${family}reference` : variantName,
  measurement,
  scaled ? (variantName.includes("lifecycle") ? 36 : 20) : null,
  { raw4 },
);
// Three advances NodeUpdateType.FRAME from its existing animation clock. Multiple synchronous
// renders would reuse one temporal result, so each deterministic step waits for that boundary.
async function advance(ticks) {
  for (let index = 0; index < ticks; index++) {
    await new Promise(requestAnimationFrame);
    fixture.render();
    await fixture.sampleVelocity();
  }
  return ticks;
}
let startupError;
try {
  // The scaled arm's raster transition is at frame 20, so startup stops short of it and the
  // scenario's own ticks are what cross it.
  await advance(scaled ? 5 : 20);
} catch (error) {
  startupError = error instanceof Error ? error.stack : String(error);
  console.error(startupError);
}
installThreePlaytestBridge({
  camera,
  scene,
  renderer,
  diagnostics: () =>
    startupError === undefined ? [] : [{ code: "TN_TEMPORAL_STARTUP_FAILED", error: startupError }],
  fixedStep: async (ticks) => {
    if (startupError !== undefined) throw new Error(startupError);
    return advance(ticks);
  },
  resources: { read: () => ({ temporal: fixture.observation() }) },
  tick: () => fixture.observation().frame,
});
