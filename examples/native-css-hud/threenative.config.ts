import type { IThreeNativeConfig } from "@threenative/core";

const config: IThreeNativeConfig = {
  // The native CSS engine paints through the legacy desktop host; the engine player draws a "web" or "native" UI.
  engine: "threejs",
  app: {
    id: "com.threenative.nativecsshud",
    name: "native-css-hud",
    version: "1.0.0",
    build: 1,
  },
  display: {
    orientation: "landscape",
  },
  window: {
    width: 1280,
    height: 720,
  },
  nativeEntry: "src/native.tsx",
  // The whole point of the fixture: real Tailwind/CSS, painted by the native CSS engine, with no
  // WebView and no Chromium process. `"web"` stays the default for every other game.
  ui: { renderer: "native-css" },
};

export default config;
