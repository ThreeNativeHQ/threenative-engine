import tailwindcss from "@tailwindcss/vite";
import { watchAssets } from "@threenative/assets";
import react from "@vitejs/plugin-react";
import {
  createEngineFreshnessPlugin,
  createWebBrandPlugin,
  webRuntimeDecoders,
} from "create-threenative";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import config from "./threenative.config.js";

/**
 * Recompiles assets/ into public/ while the dev server runs, so editing a texture does not
 * need a rebuild. Serve-only by declaration: builds compile through `threenative build`.
 */
function assetsWatchPlugin(): Plugin {
  return {
    name: "threenative-assets-watch",
    apply: "serve",
    async configureServer(server) {
      const handle = watchAssets({
        config: config.assets,
        cwd: server.config.root,
        runtimeDecoders: webRuntimeDecoders(config),
      });
      server.httpServer?.once("close", () => handle.close());
      // Nothing is served before the first cook settles: until it does, `public/` has no
      // `assets.manifest.json` and every asset answers from its source fallback.
      await handle.ready;
    },
  };
}

export default defineConfig({
  plugins: [
    createEngineFreshnessPlugin(),
    createWebBrandPlugin(),
    react(),
    tailwindcss(),
    assetsWatchPlugin(),
  ],
  // `index.html` runs the game in a worker (the default); `main.html` runs it on the page thread.
  build: { rollupOptions: { input: { index: "index.html", main: "main.html" } } },
  server: {
    watch: {
      ignored: ["**/artifacts/**", "**/screenshots/**", "**/playtests/**"],
      usePolling: true,
    },
  },
});
