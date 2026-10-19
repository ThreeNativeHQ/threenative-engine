import type { IThreeNativeConfig } from "@threenative/core";

// The plain-CSS arm of the native-css fixture: same game, same click, no Tailwind anywhere in the
// styling pipeline. Proves the backend resolves ordinary hand-written CSS, not only Tailwind output.
const config: IThreeNativeConfig = {
  app: {
    id: "com.threenative.nativecssplain",
    name: "native-css-plain",
    version: "1.0.0",
    build: 1,
  },
  display: { orientation: "landscape" },
  window: { width: 1280, height: 720 },
  nativeEntry: "src/native.tsx",
  ui: { renderer: "native-css" },
};

export default config;
