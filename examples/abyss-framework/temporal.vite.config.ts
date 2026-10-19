import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Asset-free qualification scene, using this checkout's bundled bridge and render source directly.
export default defineConfig({
  build: { rollupOptions: { input: fileURLToPath(new URL("./temporal.html", import.meta.url)) } },
  resolve: {
    alias: {
      "@threenative/playtest/three": fileURLToPath(
        new URL("../../packages/playtest/dist/three/index.js", import.meta.url),
      ),
    },
  },
});
