import { defineConfig } from "vite";

/**
 * The PRD's one-spell bundle proof: build Fireball alone and check no other spell came with it.
 * A separate config because the lab's own entry intentionally imports all six.
 */
export default defineConfig({
  build: {
    emptyOutDir: true,
    lib: { entry: "src/one-spell.ts", fileName: () => "one-spell.js", formats: ["es"] },
    minify: "esbuild",
    outDir: "dist-one-spell",
    rollupOptions: { external: ["three", "three/webgpu", "three/tsl"] },
  },
});
