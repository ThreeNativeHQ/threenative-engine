import { createEngineFreshnessPlugin, createWebBrandPlugin } from "create-threenative";
import { defineConfig } from "vite";

/**
 * The lab runs on the default engine, the Wasm build of the owned C++ engine over WebGPU, the same
 * way a scaffolded kit does: the brand plugin reads `threenative.config.ts` and binds `three` to the
 * engine, and the freshness plugin refuses a Wasm older than the engine sources it was built from.
 */
export default defineConfig({
  plugins: [createEngineFreshnessPlugin(), createWebBrandPlugin()],
});
