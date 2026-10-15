import type { IThreeNativeConfig } from "@threenative/core";

// Typed rather than `satisfies`, so `vite.config.ts` can read `config.assets` and hand the same
// options to the dev watcher that `threenative build` uses.
const config: IThreeNativeConfig = {
  // The GPU gates build this example for web, and the web Wasm engine does not run its TSL yet (PRD-573 slice 8).
  engine: "legacy",
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
