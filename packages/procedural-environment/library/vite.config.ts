// `pnpm asset-library`: the engine's view of every element this package bakes, served by the
// shared Asset Library (create-threenative's `createAssetLibraryPlugin`, PRD-915). This file only
// names the source; the shell, viewers and API live once in create-threenative.
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAssetLibraryPlugin } from "create-threenative/asset-library";
import { defineConfig } from "vite";
import { proceduralEnvironmentSource } from "../src/asset-library.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, "../dist/index.js");
/** Config reloads share Node's module cache, so each import of the rebuilt dist needs a new version. */
let version = Date.now();
const source = proceduralEnvironmentSource({
  root: here,
  cache: path.join(here, ".cache"),
  // The package's built bake functions, so the library shows exactly what a game gets.
  load: () => import(`${pathToFileURL(dist).href}?v=${version}`),
  client: path.join(here, "../src/asset-library-client.ts"),
});

export default defineConfig({
  root: here,
  plugins: [
    createAssetLibraryPlugin({
      mountPath: "/",
      title: "Procedural Asset Library",
      project: false,
      devShell: false,
      sources: [
        {
          ...source,
          // Live: `tsup --watch` rewrites dist; drop every bake and reload the page on the new code.
          configureServer(server) {
            server.watcher.add(dist);
            server.watcher.on("all", (event, changed) => {
              if (changed !== dist || event === "unlink") return;
              version++;
              void source.reset().then(() => server.ws.send({ type: "full-reload" }));
            });
          },
        },
      ],
    }),
  ],
  server: { open: true },
});
