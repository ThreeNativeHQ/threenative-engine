import type { IThreeNativeConfig } from "@threenative/core";

export default {
  // This fixture proves the Three.js host's QuickJS asset fallback: it packages the appended-game
  // executable and runs it. The default engine builds the V8 engine player directory instead.
  engine: "threejs",
  app: { id: "com.threenative.vq01", name: "VQ-01 native assets", version: "1.0.0", build: 1 },
  assets: {
    source: ".generated/assets",
    output: ".generated/public",
    audio: "none",
    budget: "none",
    lod: false,
    // Ask for compression. The actual selected QuickJS runtime must remove it, not the fixture.
    textures: { overrides: [{ glob: "*.png", codec: "uastc" }] },
    models: {
      compact: false,
      passes: { dedup: false, meshopt: true, prune: false, quantize: false, reorder: false },
      textures: "none",
      virtual: "none",
    },
  },
  nativeEntry: "src/game.ts",
  display: { fullscreen: false, maxFps: 60 },
  window: { width: 960, height: 640, title: "VQ-01 native asset fallback", resizable: false },
  renderer: { preferWebGPU: true, resolutionScale: 1 },
  ui: { renderer: "native" },
} satisfies IThreeNativeConfig;
