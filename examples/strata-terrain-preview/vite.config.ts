import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { terrainEditor } from "@threenative/terrain/editor/server";
import { starterAssetsDir } from "@threenative/terrain/kit";
import { type Plugin, defineConfig } from "vite";

/**
 * The game's own licensed art, served beside the starter's.
 *
 * `publicDir` is one directory, and it is already the terrain package's CC0
 * starter sets. The prepared Fab pines are this example's own art, they are
 * licensed and cannot be committed, and they live in a gitignored folder that
 * only exists on the machine that ran `scripts/prep-fab-pines.py` — so they are
 * a second static root rather than a copy of the first. The Landscape Pro
 * vegetation `scripts/prep-landscape-pro.mjs` copies is a third, for the same
 * reason and with the same failure behaviour.
 *
 * A missing directory is not an error: the loaders in `src/render/prepared.ts`
 * and `src/render/pack.ts` treat a refused model as "this game has no prepared
 * art" and draw the procedural spruce instead, which is what CI gets.
 *
 * The Landscape Pro root serves a *path*, not a flat namespace, because a
 * cooked pack model names its own textures as `../../../shared/images/<hash>` —
 * reproducing the asset pipeline's own layout is what lets a GLB copied here
 * resolve its images without being repacked. The traversal check is therefore a
 * per-segment test rather than "no separator anywhere".
 */
function preparedAssets(): Plugin {
  const roots: { mount: string; dir: string; flat: boolean }[] = [
    { dir: "./src/world", flat: true, mount: "/world" },
    { dir: "./local-assets/temperate", flat: false, mount: "/temperate" },
    { dir: "./local-assets/temperate/basis", flat: true, mount: "/basis" },
    { dir: "./local-assets/prepared", flat: true, mount: "/prepared" },
    { dir: "./local-assets/landscape-pro", flat: false, mount: "/landscape-pro" },
    // The Basis transcoder a cooked KTX2 model decodes through, which the engine's asset pipeline
    // copies into `public/basis/` and this example has no pipeline. Same source, same path.
    { dir: "./local-assets/landscape-pro/basis", flat: true, mount: "/basis" },
    // Explicit `?stage=before|after` forest arms: each folder is a baked copy of the forest kit.
    { dir: "./local-assets/forest-stage", flat: false, mount: "/forest-stage" },
  ].map((entry) => ({
    ...entry,
    dir: fileURLToPath(new URL(entry.dir, import.meta.url)),
  }));
  const types: Record<string, string> = {
    ".glb": "model/gltf-binary",
    ".json": "application/json",
    ".jpg": "image/jpeg",
    ".ktx2": "image/ktx2",
    ".png": "image/png",
  };
  const serve = (server: {
    middlewares: {
      use: (
        route: string,
        handler: (request: IncomingMessage, response: ServerResponse, next: () => void) => void,
      ) => void;
    };
  }) => {
    for (const entry of roots)
      server.middlewares.use(entry.mount, (request, response, next) => {
        const name = (request.url ?? "").split("?")[0]?.replace(/^\/+/, "") ?? "";
        // No segment may be `..`, on either root: a crafted URL cannot walk out
        // of the folder and read the licensed originals sitting beside it. The
        // prepared root is flat and refuses separators outright, because its
        // resolver only ever asks for a name; the pack root keeps them,
        // because a cooked GLB resolves its own images through them.
        const bad = name === "" || name.includes("..") || (!entry.flat && name.endsWith("/"));
        const path = bad || (entry.flat && name.includes("/")) ? undefined : `${entry.dir}/${name}`;
        if (path === undefined || !existsSync(path) || !statSync(path).isFile()) {
          next();
          return;
        }
        response.setHeader(
          "content-type",
          types[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream",
        );
        response.setHeader("cache-control", "no-cache");
        createReadStream(path).pipe(response);
      });
  };
  return {
    name: "strata-prepared-assets",
    configureServer: serve,
    configurePreviewServer: serve,
    generateBundle() {
      for (const world of ["forest", "coastal", "alpine", "desert", "tundra"])
        for (const suffix of ["placements.bin", "world.json", "layers.json", "splat.rgba8"])
          this.emitFile({
            type: "asset",
            fileName: `world/${world}.${suffix}`,
            source: readFileSync(new URL(`./src/world/${world}.${suffix}`, import.meta.url)),
          });
    },
  };
}

export default defineConfig({
  // The starter PBR sets are the terrain package's prepared art, served to the game rather than
  // duplicated into this example's `public/`: `/leafy_grass/…` reaches the same bytes in dev and in
  // a build, and `ctx.assets` loads them by that path.
  publicDir: await starterAssetsDir(),
  plugins: [
    terrainEditor({
      documentPath: fileURLToPath(new URL("./terrain/world.json", import.meta.url)),
    }),
    preparedAssets(),
  ],
  server: { host: "127.0.0.1" },
  optimizeDeps: { exclude: ["@threenative/terrain/editor"] },
});
