import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// A deterministic fixture with no cooked assets. Use the freshly built public playtest bridge.
export default defineConfig({
  publicDir: false,
  build: {
    emptyOutDir: true,
    outDir: "../../artifacts/tone-fixture",
    rollupOptions: { input: fileURLToPath(new URL("tone.html", import.meta.url)) },
  },
});
