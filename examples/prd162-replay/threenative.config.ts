import type { IThreeNativeConfig } from "@threenative/core";

export default {
  // Proves the legacy desktop host's replay; the default engine is native.
  engine: "legacy",
  app: {
    id: "com.threenative.prd162replay",
    name: "PRD-162 portable replay",
    version: "1.0.0",
    build: 1,
  },
  display: {
    orientation: "landscape",
    fullscreen: false,
    keepScreenOn: true,
  },
  nativeEntry: "src/game.ts",
  renderer: { preferWebGPU: true },
  window: {
    title: "PRD-162 portable replay",
    width: 640,
    height: 360,
    resizable: false,
  },
} satisfies IThreeNativeConfig;
