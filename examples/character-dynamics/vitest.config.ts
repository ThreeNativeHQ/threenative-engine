import { defineConfig } from "vitest/config";

// Unit tests run in node; the Wasm engine plugin in vite.config.ts is for the browser only.
export default defineConfig({ test: { include: ["__tests__/**/*.spec.ts"] } });
