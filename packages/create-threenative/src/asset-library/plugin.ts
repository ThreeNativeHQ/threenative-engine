// `createAssetLibraryPlugin` (PRD-915): the dev-only Vite plugin that mounts the shared Asset
// Library. `apply: "serve"` is the whole production story: `threenative build` and `vite build`
// never load it, so not one byte of the workbench reaches `dist/`.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { WEB_ENGINE_ID } from "../web-engine.js";
import { projectSource } from "./project-source.js";
import type { IAssetCatalog, IAssetLibraryServer, IAssetLibrarySource } from "./types.js";

export interface IAssetLibraryOptions {
  /** Where the library is served, with leading and trailing slashes. Default `/__assets/`. */
  readonly mountPath?: string;
  /** The sidebar heading and page title. Default "Asset Library". */
  readonly title?: string;
  /** Extra sources beside the project's own files. */
  readonly sources?: readonly IAssetLibrarySource[];
  /** List the project's `assets/`, `src/**\/*.story.ts` and the Scene Bundler. Default true. */
  readonly project?: boolean;
  /** The `Game | Asset Library` switcher on the game page in `pnpm dev`. Default true. */
  readonly devShell?: boolean;
  /** Attach `@threenative/procedural-environment`'s bake catalog when the project has it. Default true. */
  readonly procedural?: boolean;
  /** List every `@threenative/core/vfx` effect as a story when the project's core has them. Default true. */
  readonly vfx?: boolean;
}

/** The slice of Vite's plugin surface this plugin uses, so the type needs no `vite` import. */
export interface IAssetLibraryVitePlugin {
  readonly name: string;
  readonly apply: "serve";
  readonly enforce: "pre";
  config(user: { readonly optimizeDeps?: { readonly entries?: string | readonly string[] } }): {
    optimizeDeps?: { entries: string[] };
  };
  configResolved(config: { readonly root: string }): void;
  readonly resolveId: {
    readonly order: "pre";
    handler(
      this: {
        resolve(
          source: string,
          importer?: string,
          options?: object,
        ): Promise<{ id: string } | null>;
      },
      source: string,
      importer?: string,
    ): Promise<string | null>;
  };
  load(id: string): Promise<string | null>;
  configureServer(server: IViteServer): void;
  transformIndexHtml: {
    readonly order: "post";
    handler(html: string, context: { readonly path: string }): string;
  };
}

type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;
interface IViteServer extends IAssetLibraryServer {
  readonly config: { readonly root: string; readonly logger?: { info(message: string): void } };
  readonly httpServer?: { once(event: "listening", listener: () => void): unknown } | null;
  readonly resolvedUrls?: { readonly local?: readonly string[] } | null;
  readonly middlewares: { use(handler: Middleware): void };
  transformIndexHtml(url: string, html: string): Promise<string>;
}

const ENTRY = "virtual:tn-asset-library/entry";
const STORY = "virtual:tn-asset-library/story/";
const RESOLVED = "\0tn-asset-library/";

/** The prebuilt client: beside this module in `dist`, or the package's `dist` when run from source. */
function clientDir(): string {
  for (const candidate of ["./asset-library/", "../../dist/asset-library/"]) {
    const dir = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path.join(dir, "client.js"))) return dir;
  }
  throw new Error(
    "TN_ASSET_LIBRARY_CLIENT_MISSING: build create-threenative (`pnpm --filter create-threenative build`); dist/asset-library/client.js is missing.",
  );
}

/** Upstream three's package directory as the project resolves it. */
function threeDir(root: string): string {
  const require = createRequire(path.join(root, "package.json"));
  const main = require.resolve("three");
  return path.resolve(path.dirname(main), "..");
}

/** Pose Lab's mountable handler, carried by `@threenative/core` (`mcp/pose-lab.mjs`), if installed. */
async function poseLab(root: string) {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const core = path.dirname(require.resolve("@threenative/core/package.json"));
    const file = path.join(core, "mcp", "pose-lab.mjs");
    if (!existsSync(file)) return undefined;
    const module = (await import(pathToFileURL(file).href)) as {
      createPoseLabHandler(
        project: string,
      ): (req: IncomingMessage, res: ServerResponse, pathname: string) => Promise<void>;
    };
    return module.createPoseLabHandler(root);
  } catch {
    return undefined;
  }
}

/** The procedural catalog bridge: the project's `@threenative/procedural-environment`, if it has one. */
async function proceduralSource(root: string): Promise<IAssetLibrarySource | undefined> {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const entry = require.resolve("@threenative/procedural-environment/asset-library");
    const module = (await import(pathToFileURL(entry).href)) as {
      proceduralEnvironmentSource(options: { root: string; save: boolean }): IAssetLibrarySource;
    };
    return module.proceduralEnvironmentSource({ root, save: true });
  } catch {
    return undefined;
  }
}

const VFX_IMPORT = "@threenative/core/vfx";
const VFX_PATH = /^vfx:create\w+$/u;

/**
 * The VFX bridge (PRD-917): one story per `@threenative/core/vfx` effect, listed from the project's
 * core capability manifest, so the library and the capability search read the same rows.
 */
function vfxSource(root: string): IAssetLibrarySource | undefined {
  try {
    const require = createRequire(path.join(root, "package.json"));
    const core = path.dirname(require.resolve("@threenative/core/package.json"));
    const manifest = JSON.parse(readFileSync(path.join(core, "capabilities.json"), "utf8")) as {
      readonly entries: readonly {
        readonly symbol: string;
        readonly importPath: string;
        readonly kind: string;
        readonly example?: string;
      }[];
    };
    const effects = manifest.entries.filter(
      (entry) =>
        entry.importPath === VFX_IMPORT &&
        entry.kind === "function" &&
        VFX_PATH.test(`vfx:${entry.symbol}`),
    );
    if (effects.length === 0) return undefined;
    return {
      id: "vfx",
      catalog: () => ({
        elements: effects.map((entry) => ({
          id: `vfx:${entry.symbol}`,
          name: vfxTitle(entry.symbol),
          kind: "story",
          source: "vfx",
          styleTags: ["vfx"],
          path: `vfx:${entry.symbol}`,
          ...(entry.example ? { bake: entry.example } : {}),
        })),
        styles: { vfx: "VFX" },
        kinds: { story: { pack: "Code stories", name: "Code stories" } },
      }),
    };
  } catch {
    return undefined;
  }
}

/** `createHealingAura` -> `Healing Aura`. */
function vfxTitle(symbol: string): string {
  return symbol.slice("create".length).replace(/([a-z])([A-Z])/gu, "$1 $2");
}

/** Merges every source's catalog; each element keeps the id of the source that listed it. */
export async function mergedCatalog(
  sources: readonly IAssetLibrarySource[],
): Promise<IAssetCatalog> {
  const parts = await Promise.all(
    sources.map(async (source) => ({ source, catalog: await source.catalog() })),
  );
  return {
    elements: parts.flatMap(({ source, catalog }) =>
      catalog.elements.map((element) => ({ ...element, source: source.id })),
    ),
    biomes: parts.flatMap(({ catalog }) => catalog.biomes ?? []),
    styles: Object.assign({}, ...parts.map(({ catalog }) => catalog.styles)),
    controls: Object.assign({}, ...parts.map(({ catalog }) => catalog.controls ?? {})),
    kinds: Object.assign({}, ...parts.map(({ catalog }) => catalog.kinds ?? {})),
  };
}

const json = (res: ServerResponse, status: number, body: unknown): true => {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
  return true;
};

/**
 * The `Game | Asset Library` switcher: a script on the game page, in `pnpm dev` only. It mounts
 * nothing until the user picks Asset Library (no iframe, no fetch, no context, no timer); then it
 * holds the page's animation frames while the library shows and pauses the library on the way
 * back. It never runs in an iframe (Studio), under automation (playtests), or with `?noDevShell=1`.
 */
export function devShellScript(mount: string): string {
  return `(() => {
  const mount = ${JSON.stringify(mount)};
  if (window.self !== window.top || navigator.webdriver || new URLSearchParams(location.search).get("noDevShell") === "1") return;
  let frame, held = [], holding = false;
  const raf = window.requestAnimationFrame.bind(window);
  const hold = (on) => {
    if (!holding) {
      holding = true;
      // The game's own loop asks for each frame; while the library shows, the ask waits.
      window.requestAnimationFrame = (cb) => (window.__tnAssetShellHold ? (held.push(cb), 0) : raf(cb));
    }
    window.__tnAssetShellHold = on;
    if (!on) for (const cb of held.splice(0)) raf(cb);
  };
  const bar = document.createElement("div");
  bar.id = "tn-dev-shell";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Dev view");
  // A faint DEV pill in the bottom-right corner, out of the game's view; it opens into the two tabs
  // when pointed at or focused, and stays open while the library shows.
  bar.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;display:flex;gap:2px;padding:2px;border-radius:999px;background:#020407e6;border:1px solid #2e3438;font:600 12px system-ui,sans-serif;transition:opacity .15s";
  const tab = (label, library) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("role", "tab");
    b.dataset.view = library ? "assets" : "game";
    b.style.cssText = "cursor:pointer;border:0;border-radius:999px;padding:4px 12px;background:transparent;color:#c9cdcf";
    b.onclick = () => show(library);
    bar.append(b);
    return b;
  };
  // Say what this is: a dev-server tool, so nobody looks for it in a shipped game.
  bar.title = "Dev only: shown by pnpm dev, not in production builds";
  const badge = document.createElement("span");
  badge.textContent = "DEV";
  badge.tabIndex = 0;
  badge.style.cssText = "align-self:center;padding:2px 6px 2px 8px;color:#e0fb50;font:700 10px system-ui,sans-serif;letter-spacing:.08em";
  bar.append(badge);
  const game = tab("Game", false);
  const library = tab("Asset Library", true);
  let open = false, pointed = false;
  const fold = () => {
    const shown = open || pointed || !!bar.querySelector(":focus-visible");
    for (const b of [game, library]) b.style.display = shown ? "" : "none";
    badge.style.padding = shown ? "2px 6px 2px 8px" : "4px 10px";
    bar.style.opacity = shown ? "1" : ".55";
  };
  bar.onmouseenter = () => { pointed = true; fold(); };
  bar.onmouseleave = () => { pointed = false; fold(); };
  bar.addEventListener("focusin", fold);
  bar.addEventListener("focusout", () => setTimeout(fold));
  const mark = (lib) => {
    for (const [b, on] of [[game, !lib], [library, lib]]) {
      b.setAttribute("aria-selected", String(on));
      b.style.background = on ? "#e0fb50" : "transparent";
      b.style.color = on ? "#020407" : "#c9cdcf";
    }
  };
  const show = (lib) => {
    if (lib && !frame) {
      frame = document.createElement("iframe");
      frame.id = "tn-asset-library-frame";
      frame.title = "Asset Library";
      frame.src = mount;
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#222425";
      document.body.append(frame);
    }
    if (frame) {
      frame.style.display = lib ? "block" : "none";
      frame.contentWindow?.postMessage({ type: lib ? "tn-asset-library:resume" : "tn-asset-library:pause" }, "*");
    }
    hold(lib);
    mark(lib);
    open = lib;
    fold();
  };
  mark(false);
  fold();
  const add = () => document.body.append(bar);
  if (document.body) add(); else document.addEventListener("DOMContentLoaded", add);
})();`;
}

export function createAssetLibraryPlugin(
  options: IAssetLibraryOptions = {},
): IAssetLibraryVitePlugin {
  const mount = options.mountPath ?? "/__assets/";
  if (!mount.startsWith("/") || !mount.endsWith("/"))
    throw new Error(
      `createAssetLibraryPlugin: mountPath must start and end with "/", got ${JSON.stringify(mount)}`,
    );
  let root = process.cwd();
  let dir = "";
  const sources: IAssetLibrarySource[] = [...(options.sources ?? [])];
  let attached: Promise<unknown> = Promise.resolve();
  /** A client module as the page imports it: an absolute file goes through `/@fs`. */
  const specOf = (client: string) => (path.isAbsolute(client) ? `/@fs${client}` : client);
  /** The files whose bare `three` is the shell's (upstream three), never the game's engine. */
  const shellFiles = () => [
    path.join(dir, "client.js"),
    ...sources.flatMap((s) => (s.client && path.isAbsolute(s.client) ? [s.client] : [])),
  ];

  return {
    name: "threenative-asset-library",
    apply: "serve",
    enforce: "pre",
    // Vite's start-up scan crawls only the HTML pages, so a module first met in a story was
    // optimized late, and its `full-reload` reloaded the game page under the library as well.
    // Scanning the stories too bundles their imports before the first page loads.
    config(user) {
      if (options.project === false) return {};
      return {
        optimizeDeps: {
          entries: [...(user.optimizeDeps?.entries ? [] : ["**/*.html"]), "src/**/*.story.ts"],
        },
      };
    },
    configResolved(config) {
      root = config.root;
    },
    // `pre` runs this ahead of every plugin's resolveId: a kit's engine alias is listed first and
    // would otherwise claim the shell's `three` before this hook ever saw it.
    resolveId: {
      order: "pre",
      async handler(source, importer) {
        if (source === ENTRY) return `${RESOLVED}entry`;
        if (source.startsWith(STORY))
          return RESOLVED + source.slice("virtual:tn-asset-library/".length);
        // The shell draws with upstream three's WebGLRenderer, which the Wasm engine does not bind:
        // only the shell's own `three` skips the engine alias. Code stories keep the game's.
        if (
          source === "three" &&
          dir &&
          importer &&
          shellFiles().includes(importer.split("?")[0] as string)
        ) {
          const resolved = await this.resolve(source, importer, { skipSelf: true });
          if (resolved?.id === WEB_ENGINE_ID || resolved?.id.startsWith("\0"))
            return path.join(threeDir(root), "build", "three.module.js");
        }
        return null;
      },
    },
    async load(id) {
      if (id === `${RESOLVED}entry`) {
        await attached;
        const clients = sources.filter((source) => source.client);
        const config = { base: mount, title: options.title ?? "Asset Library" };
        return [
          ...clients.map(
            (source, i) =>
              `import client${i} from ${JSON.stringify(specOf(source.client as string))};`,
          ),
          `globalThis.__TN_ASSET_LIBRARY__ = { ...${JSON.stringify(config)}, clients: { ${clients
            .map((source, i) => `${JSON.stringify(source.id)}: client${i}`)
            .join(", ")} } };`,
          `await import(${JSON.stringify(`/@fs${path.join(dir, "client.js")}`)});`,
        ].join("\n");
      }
      if (id.startsWith(`${RESOLVED}story/`)) {
        const file = decodeURIComponent(id.slice(`${RESOLVED}story/`.length).replace(/\.js$/u, ""));
        if (VFX_PATH.test(file)) {
          const symbol = file.slice("vfx:".length);
          return `import { mountStory } from ${JSON.stringify(`/@fs${path.join(dir, "story-frame.js")}`)};
import { vfxStory } from ${JSON.stringify(`/@fs${path.join(dir, "vfx-story.js")}`)};
import { GPUParticles3D } from "@threenative/core";
import { ${symbol} } from ${JSON.stringify(VFX_IMPORT)};
await mountStory(vfxStory(${JSON.stringify(vfxTitle(symbol))}, ${symbol}, GPUParticles3D));`;
        }
        const spec = JSON.stringify(`/${file}`);
        // The story module is this entry's HMR boundary: an edit to it (or to anything it imports)
        // swaps the story in place and keeps the props, without reloading the shell or the game.
        return `import { mountStory } from ${JSON.stringify(`/@fs${path.join(dir, "story-frame.js")}`)};
import story from ${spec};
const handle = await mountStory(story);
if (import.meta.hot) import.meta.hot.accept(${spec}, (next) => next && handle.replace(next.default));`;
      }
      return null;
    },
    configureServer(server) {
      dir = clientDir();
      const pose =
        options.project === false ? Promise.resolve(undefined) : poseLab(server.config.root);
      const ready = (async () => {
        const handler = await pose;
        if (options.project !== false)
          sources.push(projectSource({ root: server.config.root, poseLab: handler !== undefined }));
        if (options.procedural !== false && !sources.some((s) => s.id === "procedural")) {
          const procedural = await proceduralSource(server.config.root);
          if (procedural) sources.push(procedural);
        }
        if (options.vfx !== false && !sources.some((s) => s.id === "vfx")) {
          const vfx = vfxSource(server.config.root);
          if (vfx) sources.push(vfx);
        }
        for (const source of sources) source.configureServer?.(server);
        return handler;
      })();
      attached = ready;
      const html = (page: "index.html" | "story.html", entry: string) =>
        readFileSync(path.join(dir, page), "utf8")
          .replaceAll("%BASE%", mount)
          .replace("%STYLE%", () => readFileSync(path.join(dir, "client.css"), "utf8"))
          .replace("%ENTRY%", entry);
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://library");
        if (!url.pathname.startsWith(mount)) return next();
        const rest = url.pathname.slice(mount.length);
        const answer = async (): Promise<boolean> => {
          const pose = await ready;
          if (rest === "" || rest === "index.html") {
            res.setHeader("content-type", "text/html");
            res.end(
              await server.transformIndexHtml(
                url.pathname + url.search,
                html("index.html", `/@id/${ENTRY}`),
              ),
            );
            return true;
          }
          if (rest === "story.html") {
            const file = url.searchParams.get("path") ?? "";
            const valid = /^src\/[\w./-]+\.story\.ts$/u.test(file) || VFX_PATH.test(file);
            if (!valid || file.includes(".."))
              return json(res, 400, {
                error: "story.html needs ?path=src/<name>.story.ts or ?path=vfx:create<Effect>",
              });
            const page = html("story.html", `/@id/${STORY}${encodeURIComponent(file)}.js`);
            res.setHeader("content-type", "text/html");
            res.end(await server.transformIndexHtml(url.pathname + url.search, page));
            return true;
          }
          if (rest === "favicon.svg") {
            res.setHeader("content-type", "image/svg+xml");
            res.end(await readFile(path.join(dir, "favicon.svg")));
            return true;
          }
          if (rest.startsWith("basis/")) {
            // KTX2 textures transcode with three's own Basis transcoder.
            const name = path.basename(rest);
            if (!/^basis_transcoder\.(js|wasm)$/u.test(name)) return false;
            res.setHeader(
              "content-type",
              name.endsWith(".wasm") ? "application/wasm" : "text/javascript",
            );
            res.end(
              await readFile(
                path.join(threeDir(server.config.root), "examples/jsm/libs/basis", name),
              ),
            );
            return true;
          }
          if (rest === "pose" || rest.startsWith("pose/")) {
            if (!pose)
              return json(res, 404, { error: "Pose Lab needs @threenative/core 0.3.24 or later." });
            await pose(req, res, `/${rest.slice("pose/".length)}`.replace(/^\/pose$/u, "/"));
            return true;
          }
          if (rest === "api/catalog") return json(res, 200, await mergedCatalog(sources));
          const api = /^api\/([\w-]+)\/(.+)$/u.exec(rest);
          const source = api && sources.find((s) => s.id === api[1]);
          if (api && source?.handle) return source.handle(api[2] as string, url, req, res);
          return false;
        };
        answer()
          .then((handled) => {
            if (!handled) next();
          })
          .catch((error: Error) => json(res, 500, { error: error.message }));
      });
      const banner = () => {
        const local = server.resolvedUrls?.local?.[0];
        if (local) server.config.logger?.info(`  ➜  Asset Library: ${new URL(mount, local).href}`);
      };
      server.httpServer?.once("listening", () => setTimeout(banner, 0));
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (options.devShell === false || context.path.startsWith(mount)) return html;
        return html.replace(/<head([^>]*)>/u, `<head$1><script>${devShellScript(mount)}</script>`);
      },
    },
  };
}
