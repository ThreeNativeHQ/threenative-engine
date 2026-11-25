// `threenative()` (PRD-915): every Vite plugin and dev-server default the kits share, in one call.
// A kit's `vite.config.ts` names only what is its own (React, Tailwind); a new piece of plumbing
// lands here once instead of being stamped into sixteen configs and every game made from them.
import { existsSync } from "node:fs";
import path from "node:path";
import { type IAssetLibraryOptions, createAssetLibraryPlugin } from "./asset-library/plugin.js";
import { loadConfig } from "./config.js";
import { createEngineCatalogPlugin } from "./engine-catalog.js";
import { createEngineFreshnessPlugin } from "./engine-freshness.js";
import { createWebBrandPlugin } from "./web-brand.js";
import { webRuntimeDecoders } from "./web-engine.js";

export interface IThreeNativeKitOptions {
  /** The Asset Library at `/__assets/` and the `Game | Asset Library` switcher; `false` drops both. */
  readonly assetLibrary?: IAssetLibraryOptions | false;
  /** Recompile `assets/` into `public/` while `pnpm dev` runs. Default true. */
  readonly assetsWatch?: boolean;
}

interface IDevServer {
  readonly config: { readonly root: string; readonly publicDir: string };
  readonly ws: { send(payload: { type: "full-reload" }): void };
  readonly httpServer?: { once(event: "close", listener: () => void): unknown } | null;
}

/**
 * Recompiles assets/ into public/ while the dev server runs, so editing a texture does not
 * need a rebuild. Serve-only by declaration: builds compile through `threenative build`.
 */
export function createAssetsWatchPlugin() {
  return {
    name: "threenative-assets-watch",
    apply: "serve" as const,
    // A cook writes many files into `public/`, and Vite reloaded the page for each of them: 45 reloads
    // in a second left the GPU holding one device per reload until it ran out of memory. A `public/` file
    // is no module, so no reload belongs to it; the settled cook reloads the page once instead.
    hotUpdate({ file, server }: { readonly file: string; readonly server: IDevServer }) {
      return file.startsWith(`${server.config.publicDir}/`) ? [] : undefined;
    },
    async configureServer(server: IDevServer) {
      // The game's own `@threenative/assets` (a peer), so the dev cook is the build's cook.
      const [{ watchAssets }, config] = await Promise.all([
        import("@threenative/assets"),
        loadConfig(server.config.root),
      ]);
      const handle = watchAssets({
        ...(config.assets ? { config: config.assets } : {}),
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

/** Dev-server and build defaults every kit carried: a polling watch, and the worker page's twin. */
function kitDefaults() {
  return {
    name: "threenative-kit-defaults",
    config(user: {
      readonly root?: string;
      readonly build?: {
        readonly rollupOptions?: { readonly input?: unknown };
        readonly rolldownOptions?: { readonly input?: unknown };
      };
    }) {
      const root = path.resolve(user.root ?? process.cwd());
      // A build that names its own input keeps it: the native HUD build sets one page with code
      // splitting off, and this hook runs inside build(), after that override.
      const named = user.build?.rollupOptions?.input ?? user.build?.rolldownOptions?.input;
      return {
        server: {
          watch: {
            ignored: ["**/artifacts/**", "**/screenshots/**", "**/playtests/**"],
            usePolling: true,
          },
        },
        // `index.html` runs the game in a worker (the default); `main.html` runs it on the page thread.
        ...(named === undefined && existsSync(path.join(root, "main.html"))
          ? { build: { rollupOptions: { input: { index: "index.html", main: "main.html" } } } }
          : {}),
      };
    },
  };
}

/**
 * Every plugin a ThreeNative kit needs, in order: engine freshness, brand and web engine, the
 * engine catalog, the Asset Library, the assets watch, and the dev-server defaults.
 *
 * @example
 * export default defineConfig({ plugins: [threenative(), react(), tailwindcss()] });
 */
export function threenative(options: IThreeNativeKitOptions = {}) {
  return [
    createEngineFreshnessPlugin(),
    createWebBrandPlugin(),
    createEngineCatalogPlugin(),
    ...(options.assetLibrary === false ? [] : [createAssetLibraryPlugin(options.assetLibrary)]),
    ...(options.assetsWatch === false ? [] : [createAssetsWatchPlugin()]),
    kitDefaults(),
  ];
}
