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
    maxFps: 60,
  },
  window: {
    title: "__PROJECT_NAME__",
    width: 1280,
    height: 720,
    maximized: false,
    resizable: true,
  },
  bootSplash: { backgroundColor: "#061b2b" },
  nativeEntry: "src/game.ts",
  renderer: {
    preferWebGPU: true,
    resolutionScale: "auto",
    // Multisampling resolves triangle edges. A cutout silhouette — foliage, a fence, hair — is
    // carved inside the triangle by an alpha test, so it resolves through the coverage mask or
    // not at all, which is what this spends the samples above on. It costs no target and no
    // extra pass; set it false for a deliberately hard-edged look. `TN_ALPHA_ANTIALIASING`
    // reports what it did, and says so when a single-sampled surface leaves it nothing to do.
    alphaAntialiasing: true,
  },
  ui: { renderer: "web" },
  assets: {
    audio: {
      // The three storm clips are the authored waveform, not material to be conditioned. Each is
      // a Float32 WAV baked by `tools/make-storm-audio.mjs` from the reference study's own maths,
      // and the default pass would move them: a peak ceiling on the wind bed (which peaks above
      // 1.0 by design) and a Vorbis round trip on all three. `conditioning: "none"` ships the bytes
      // as committed — measurement, the receipt, and each loop's seam assertion all still run, so
      // this buys preservation, not silence.
      overrides: [
        { conditioning: "none", glob: "rain-loop.wav", loop: true },
        { conditioning: "none", glob: "thunder.wav" },
        { conditioning: "none", glob: "wind-loop.wav", loop: true },
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
