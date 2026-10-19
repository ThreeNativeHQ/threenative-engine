import type { IThreeNativeConfig } from "@threenative/core";

// The native proof needs an app identity and a native entry; the web dev server reads the same file
// through `threenative build`, so there is one description of this example.
const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.prd493terrainsplat",
    name: "PRD-493 Terrain Splat",
    version: "1.0.0",
    build: 1,
  },
  display: {
    fullscreen: true,
    keepScreenOn: true,
    orientation: "landscape",
  },
  nativeEntry: "src/game.ts",
  renderer: { preferWebGPU: true },
  ui: { renderer: "native" },
};

export default config;
