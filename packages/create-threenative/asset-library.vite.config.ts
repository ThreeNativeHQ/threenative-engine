// Builds the Asset Library's browser half into dist/asset-library/ (PRD-915): the shell (upstream
// three addons inlined, `three` left to the dev server), the story frame (`three` and
// `three/webgpu` left to the game), the VFX story (`@threenative/core` left to the game too), Tailwind compiled once so no kit needs it.
import { cpSync } from "node:fs";
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const here = path.join(import.meta.dirname, "src/asset-library/client");
const out = path.join(import.meta.dirname, "dist/asset-library");

export default defineConfig({
  root: here,
  plugins: [
    tailwindcss(),
    {
      name: "asset-library-pages",
      closeBundle() {
        for (const file of ["index.html", "story.html", "favicon.svg"])
          cpSync(path.join(here, file), path.join(out, file));
      },
    },
  ],
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: true,
    sourcemap: false,
    target: "es2022",
    lib: {
      entry: {
        client: path.join(here, "main.ts"),
        "story-frame": path.join(here, "../story-frame.ts"),
        "vfx-story": path.join(here, "../vfx-story.ts"),
      },
      formats: ["es"],
      cssFileName: "client",
    },
    rollupOptions: {
      external: (id) =>
        id === "three" || id === "three/webgpu" || id.startsWith("@threenative/core"),
    },
  },
});
