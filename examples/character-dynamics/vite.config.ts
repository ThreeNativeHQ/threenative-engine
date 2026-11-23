// The owned Wasm C++ engine renders this scene by default (engine default since 2026-10-15).
// `TN_ENGINE=threejs` is the named override: plain upstream three, the control arm.
const headers = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};
const owned = process.env.TN_ENGINE !== "threejs";
const WASM_ENGINE = new URL(
  "../../packages/runtime-native/build/web/tn-native-engine-web.mjs",
  import.meta.url,
).pathname;

export default async () => {
  const { createWebEnginePlugin } = await import(
    "../../packages/create-threenative/src/web-engine.ts"
  );
  return {
    preview: { headers },
    server: { headers },
    resolve: { dedupe: ["three"] },
    plugins: owned ? [createWebEnginePlugin({ engine: "threenative", wasm: WASM_ENGINE })] : [],
  };
};
