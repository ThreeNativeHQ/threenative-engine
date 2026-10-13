import type { IThreeNativeConfig } from "@threenative/core";

// PRD-540: the smallest core game and a bare three page, both built on the Wasm engine.
const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.wasmengineboot",
    name: "wasm-engine-boot",
    version: "1.0.0",
    build: 1,
  },
  engine: "native",
  window: { title: "wasm-engine-boot", width: 640, height: 360 },
  nativeEntry: "src/game.ts",
  renderer: { preferWebGPU: true, resolutionScale: 1 },
  ui: { renderer: "native" },
};

export default config;
