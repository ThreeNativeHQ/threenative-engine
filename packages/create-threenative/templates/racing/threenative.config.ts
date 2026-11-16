import type { IThreeNativeConfig } from "@threenative/core";

const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.__PROJECT_ID__",
    name: "__PROJECT_NAME__",
    version: "1.0.0",
    build: 1,
    icon: "public/icon.png",
    icons: { web: { favicon: "public/favicon.svg" } },
  },
  display: {
    orientation: "landscape",
    fullscreen: true,
    keepScreenOn: true,
    // No `maxFps`: the engine targets the display's own refresh rate, capped at 120 on desktop
    // and web and 60 on mobile, and reports the resolved value in every `TN_FRAME_BUDGET` window.
    // Set a number to override it, or 0 to remove the ceiling.
  },
  window: {
    title: "__PROJECT_NAME__",
    width: 1280,
    height: 720,
    maximized: false,
    resizable: true,
  },
  bootSplash: {
    backgroundColor: "#07111d",
  },
  nativeEntry: "src/game.ts",
  renderer: {
    preferWebGPU: true, // Use WebGPU when the host exposes it.
    // The engine holds the `display.maxFps` budget by scaling the 3D drawing buffer, and reports
    // the scale it settled on in every `TN_FRAME_BUDGET` window. Replace with a number in (0, 1]
    // to pin it — the loop stops and the reporting does not. CSS, UI and camera framing never move.
    resolutionScale: "auto",
    // Multisampling resolves triangle edges. A cutout silhouette — foliage, a fence, hair — is
    // carved inside the triangle by an alpha test, so it resolves through the coverage mask or
    // not at all, which is what this spends the samples above on. It costs no target and no
    // extra pass; set it false for a deliberately hard-edged look. `TN_ALPHA_ANTIALIASING`
    // reports what it did, and says so when a single-sampled surface leaves it nothing to do.
    alphaAntialiasing: true,
  },
  // One UI on every target: src/ui/ renders through the platform's own browser-class renderer,
  // so the same React, Tailwind, CSS and SVG run on web, desktop, Android and iOS alike.
  // Switch to "native" for a UI drawn as part of the rendered frame, with no web view and no
  // extra process — and own the appearance difference that comes with it.
  ui: { renderer: "web" },
  assets: {
    audio: {
      // The engine bed and the tyre squeal are loops this kit pitches and opens live, so the two
      // claims that matter are their joins: declaring `loop` makes the audio pass measure the seam
      // and fail the build on a click. `crossFadeMs: 0` because the bake already makes the join
      // exact — every frequency in the bed is a whole number of cycles per loop — and a 250 ms
      // cross-fade over a clean seam would smear a quarter of a second of the engine into itself
      // on every lap. The nitro burst is a one-shot and is declared not to loop.
      overrides: [
        { glob: "engine-loop.wav", loop: { crossFadeMs: 0 } },
        { glob: "tyre-squeal.wav", loop: { crossFadeMs: 0 } },
        { glob: "nitro-burst.wav", loop: false },
      ],
    },
  },
  // One asset tree, one compiler, one representation per artifact. Uncomment, then cook:
  //   threenative build --target android   # cooks defaults.android; --profile <name> beats it
  // buildProfiles: {
  //   defaults: { android: "compact" },
  //   profiles: {
  //     compact: {
  //       assets: { textures: { maxSize: 1024 }, models: { textures: { maxSize: 1024 } } },
  //     } },
  // },
  // Contract, byte definitions, the build report:
  //   node_modules/create-threenative/agent-docs/references/build-profiles.md
};

export default config;
