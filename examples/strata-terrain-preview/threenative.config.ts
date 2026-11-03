import type { IThreeNativeConfig } from "@threenative/core";

/**
 * The owned engine for the terrain preview: `engine: "threenative"` draws through the C++ engine
 * compiled to Wasm (`build/web/tn-native-engine-web-threads.mjs`) instead of upstream three.
 *
 * This is the opt-in lane (`pnpm build:engine`). The plain `vite build` beside it keeps the
 * upstream-three path every existing playtest and CI lane of this example measures, so switching
 * the measured engine is a deliberate choice and not a silent one.
 *
 * `TN_ENGINE=threenative pnpm dev` serves this lane (2026-11-03: the licensed forest loads and draws
 * on it, `wasmPlan` stages in `TN_FRAME_BUDGET`). The page needs COOP/COEP, which that plugin sets,
 * or the threaded engine refuses with `TN_WEB_THREADS_OFF`.
 */
const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.strataterrainpreview",
    name: "strata-terrain-preview",
    version: "1.0.0",
    build: 1,
  },
  engine: "threenative",
  nativeEntry: "src/game.ts",
  renderer: { preferWebGPU: true, resolutionScale: 1 },
  ui: { renderer: "native" },
  window: { height: 900, title: "Strata terrain preview", width: 1600 },
};

export default config;
