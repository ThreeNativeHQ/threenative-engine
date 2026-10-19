import type { IThreeNativeConfig } from "@threenative/core";

// Typed rather than `satisfies`, so `vite.config.ts` can read `config.assets` and hand the same
// options to the dev watcher that `threenative build` uses.
const config: IThreeNativeConfig = {
  // Pinned to the legacy engine: vq-locomotion-game.ts clips the first-person body with a
  // three/webgpu ClippingGroup, and the Wasm engine has no ClippingGroup or clippingPlanes yet
  // (TN_NATIVE_UNCATALOGUED_CLIPPINGGROUP, PRD-621). Delete this line once the engine clips a group.
  engine: "threejs",
  app: {
    id: "com.threenative.loadingleak",
    name: "ThreeNative Loading Leak",
    version: "1.0.0",
    build: 1,
  },
  display: {
    fullscreen: true,
    keepScreenOn: true,
    orientation: "landscape",
  },
  nativeEntry: "src/loading-leak-game.ts",
  renderer: { preferWebGPU: true },
};

export default config;
