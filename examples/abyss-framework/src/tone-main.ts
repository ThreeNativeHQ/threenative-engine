import { installThreePlaytestBridge } from "@threenative/playtest/three";
import { LinearToneMapping, WebGPURenderer } from "three/webgpu";
import { createToneCalibration } from "./render/toneCalibration.js";

const { camera, scene } = createToneCalibration();
const renderer = new WebGPURenderer({ antialias: false });
renderer.setPixelRatio(1);
renderer.setSize(1280, 720);
renderer.toneMapping = LinearToneMapping;
renderer.toneMappingExposure = new URLSearchParams(location.search).has("underexposed") ? 0.25 : 1;
document.body.appendChild(renderer.domElement);
await renderer.init();
await renderer.renderAsync(scene, camera);
let tick = 0;
installThreePlaytestBridge({
  camera,
  diagnostics: () => [],
  fixedStep: async (ticks) => {
    tick += ticks;
    await renderer.renderAsync(scene, camera);
    return ticks;
  },
  renderer,
  resources: { read: () => ({ exposure: renderer.toneMappingExposure }) },
  scene,
  tick: () => tick,
});
