import tailwindcss from "@tailwindcss/vite";
import { watchAssets } from "@threenative/assets";
import react from "@vitejs/plugin-react";
import {
  createEngineCatalogPlugin,
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
    // A cook writes many files into `public/`, and Vite reloaded the page for each of them: 45 reloads
    // in a second left the GPU holding one device per reload until it ran out of memory. A `public/` file
    // is no module, so no reload belongs to it; the settled cook reloads the page once instead.
    hotUpdate({ file, server }) {
      return file.startsWith(`${server.config.publicDir}/`) ? [] : undefined;
    },
    async configureServer(server) {
      const handle = watchAssets({
        config: config.assets,
        cwd: server.config.root,
        runtimeDecoders: webRuntimeDecoders(config),
        onChange: ({ compiled }) => {
          if (compiled.length > 0) server.ws.send({ type: "full-reload" });
        },
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
    createEngineCatalogPlugin(),
    react(),
    tailwindcss(),
    assetsWatchPlugin(),
  ],
  server: {
    watch: {
      ignored: ["**/artifacts/**", "**/screenshots/**", "**/playtests/**"],
      usePolling: true,
    },
  },
});
