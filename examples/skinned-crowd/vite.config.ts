// Microsecond CPU spans need the isolated browser clock.
const headers = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

// `TN_BENCH_TARGET=web-engine` binds every `three` import to the owned Wasm engine instead of upstream
// three, the same arm `examples/engine-load-test` already carries. Without it this page is the plain
// three.js control, which is what most of its playtests assert against; the batch's own scenario
// (`animation-tick-batch`) needs the engine, because the JS loop it replaces only exists there.
const webEngine = process.env.TN_BENCH_TARGET === "web-engine";
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
    plugins: webEngine ? [createWebEnginePlugin({ engine: "threenative", wasm: WASM_ENGINE })] : [],
  };
};
