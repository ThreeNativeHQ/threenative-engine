import type { IThreeNativeConfig } from "@threenative/core";

// Typed rather than `satisfies`, so `vite.config.ts` can read `config.assets` and hand the same
// options to the dev watcher that `threenative build` uses.
const config: IThreeNativeConfig = {
  // Temporary legacy pin (PRD-617 debt): CI jobs run `threenative build` here and CI does not build the
  // product web Wasm engine, so a native-engine build stops at TN_WASM_ENGINE_MISSING. Drop the pin when CI builds it.
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
