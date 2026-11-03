import type { IThreeNativeConfig } from "@threenative/core";

/**
 * The owned engine for the terrain preview: `engine: "threenative"` draws through the C++ engine
 * compiled to Wasm (`build/web/tn-native-engine-web-threads.mjs`) instead of upstream three.
 *
 * This is the opt-in lane (`pnpm build:engine`). The plain `vite build` beside it keeps the
 * upstream-three path every existing playtest and CI lane of this example measures, so switching
 * the measured engine is a deliberate choice and not a silent one.
 *
 * KNOWN BLOCKED (2026-11-03): the engine build boots — worker threads on, `path: "host"`, 60.0 fps
 * presented on an RTX 2080 — and then dies in the forest world builder with
 * `TN_STARTUP_FAILED: i.addEventListener is not a function`. The game hooks `dispose` on its own
 * geometry, materials and render targets (`src/render/terrain.ts`, `ocean.ts`, `waterProof.ts`);
 * `Geometry` derives `EventDispatcher` in C++ but the ABI never exposes `addEventListener`, and
 * `Material`/`Texture`/`RenderTarget` do not derive it at all. three dispatches `dispose` on all of
 * them (r186+), so games legitimately rely on it. Until the engine binds and dispatches those
 * events (an ABI change), this lane cannot run the preview. Also needs the page served with
 * COOP/COEP, or the threaded engine refuses with `TN_WEB_THREADS_OFF`.
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
