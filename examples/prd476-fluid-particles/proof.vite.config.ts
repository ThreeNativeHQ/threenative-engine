import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Exercise this checkout's solver with the freshly built public playtest bridge.
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: [
      {
        find: /^@threenative\/core$/,
        replacement: fileURLToPath(
          new URL("../../packages/core/src/fluid-particles.ts", import.meta.url),
        ),
      },
    ],
  },
  build: {
    emptyOutDir: true,
    outDir: "../../artifacts/fluid-collision-fixture",
    rollupOptions: { input: fileURLToPath(new URL("proof.html", import.meta.url)) },
  },
});
