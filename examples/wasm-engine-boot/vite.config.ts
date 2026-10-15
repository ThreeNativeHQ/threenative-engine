import { createWebBrandPlugin } from "create-threenative";
import { defineConfig } from "vite";

// Four pages: the core game (index.html), three alone on the Wasm renderer (renderer.html), the
// minimal template's post chain on it (post.html) and TSL compute on it (compute.html).
export default defineConfig({
  // As every template lists it: the brand plugin follows the config's engine, `pnpm dev` included.
  plugins: [createWebBrandPlugin()],
  // Unminified so an engine refusal names the call site that reached it.
  // WASM_BOOT_PAGES=renderer builds the three-only page alone, while core cannot bundle on the
  // engine yet (PRD-540 phase 2 box 2).
  build: {
    minify: false,
    rollupOptions: {
      input:
        process.env.WASM_BOOT_PAGES === "renderer"
          ? ["renderer.html", "post.html", "compute.html"]
          : ["index.html", "renderer.html", "post.html", "compute.html"],
    },
  },
});
