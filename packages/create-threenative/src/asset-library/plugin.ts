// `createAssetLibraryPlugin` (PRD-915): the dev-only Vite plugin that mounts the shared Asset
// Library. `apply: "serve"` is the whole production story: `threenative build` and `vite build`
// never load it, so not one byte of the workbench reaches `dist/`.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type IDashboardApi, createDashboardApi } from "../dashboard/api.js";
import { WEB_ENGINE_ID } from "../web-engine.js";
import { cloudflareCatalogSource } from "./cloudflare-source.js";
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
  /** The `Game | Dashboard` switcher on the game page in `pnpm dev`. Default true. */
  readonly devShell?: boolean;
  /**
   * Where the Dev Dashboard is served (PRD-918), with leading and trailing slashes. Default
   * `/__dashboard/`. The Asset Library is its first section; `mountPath` keeps working.
   */
  readonly dashboardPath?: string;
  /** Attach `@threenative/procedural-environment`'s bake catalog when the project has it. Default true. */
  readonly procedural?: boolean;
  /** List every `@threenative/core/vfx` effect as a story when the project's core has them. Default true. */
  readonly vfx?: boolean;
  /** Attach the lazy-loading Cloudflare public catalog (`gateway.threenative.com`, or pass a custom origin). */
  readonly cloudflare?: boolean | string;
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
  readonly httpServer?: {
    once(event: "listening" | "close", listener: () => void): unknown;
  } | null;
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
    settings: Object.assign({}, ...parts.map(({ catalog }) => catalog.settings ?? {})),
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

/** The `TN_*` markers the dev shell keeps for Performance & Health (PRD-923). */
export const DEV_SHELL_MARKERS = [
  "TN_FRAME_BUDGET",
  "TN_FRAME_SPANS",
  "TN_SCENE_WARNING",
  "TN_RENDER_PROJECTION",
  "TN_HOT_CALL",
  "TN_ASSET_UNUSED",
  "TN_ALPHA_ANTIALIASING",
] as const;

/**
 * The `Game | Dashboard` switcher (PRD-918): a script on the game page, in `pnpm dev` only. It
 * mounts nothing until the user picks Dashboard (no iframe, no fetch, no context, no timer); then it
 * holds the page's animation frames while the Dashboard shows and pauses it on the way back. It
 * never runs in an iframe (Studio), under automation (playtests), or with `?noDevShell=1`.
 *
 * It also keeps the last 60 s (600 lines at most) of the game's own `TN_*` performance markers in a
 * ring buffer (PRD-923): an array push per marker line and no DOM work, handed to the Dashboard's
 * Performance & Health view when it opens. "Dock live strip" returns to the game with a small
 * readout that updates once per `TN_FRAME_BUDGET` window.
 */
export function devShellScript(mount: string, dashboard = mount): string {
  return `(() => {
  const dashboard = ${JSON.stringify(dashboard)};
  if (window.self !== window.top || navigator.webdriver || new URLSearchParams(location.search).get("noDevShell") === "1") return;
  // ── passive TN_* ring buffer: one push per marker line, nothing else while the Dashboard is closed ──
  const codes = new Set(${JSON.stringify(DEV_SHELL_MARKERS)});
  const ring = [];
  let docked;
  const keep = (level, args) => {
    const first = args[0];
    if (typeof first !== "string" || first.charCodeAt(0) !== 84 || !first.startsWith("TN_")) return;
    const code = /^TN_[A-Z0-9_]+/.exec(first)?.[0];
    if (!code || !codes.has(code)) return;
    const t = performance.now();
    ring.push({ t, level, code, text: first.length > 8000 ? first.slice(0, 8000) : first });
    while (ring.length > 600 || ring[0].t < t - 60000) ring.shift();
    if (docked && (code === "TN_FRAME_BUDGET" || code === "TN_SCENE_WARNING" || code === "TN_HOT_CALL")) docked(code, first);
  };
  for (const level of ["log", "info", "debug", "warn", "error"]) {
    const original = console[level];
    console[level] = function (...args) {
      keep(level, args);
      return original.apply(this, args);
    };
  }
  window.__tnDevMarkers = ring;
  // A worker game's lines arrive on core's dev relay (DEV_MARKER_CHANNEL): a page cannot read a worker's console.
  if (typeof BroadcastChannel === "function") new BroadcastChannel("threenative-dev-markers").onmessage = (event) => keep(event.data?.level ?? "log", [event.data?.text]);
  let frame, held = [], holding = false;
  const raf = window.requestAnimationFrame.bind(window);
  const hold = (on) => {
    if (!holding) {
      holding = true;
      // The game's own loop asks for each frame; while the Dashboard shows, the ask waits.
      window.requestAnimationFrame = (cb) => (window.__tnAssetShellHold ? (held.push(cb), 0) : raf(cb));
    }
    window.__tnAssetShellHold = on;
    if (!on) for (const cb of held.splice(0)) raf(cb);
  };
  const font = "Inter,ui-sans-serif,system-ui,sans-serif";
  const bar = document.createElement("div");
  bar.id = "tn-dev-shell";
  bar.setAttribute("role", "tablist");
  bar.setAttribute("aria-label", "Dev view");
  // A faint DEV pill in the bottom-right corner, out of the game's view; it opens into the two tabs
  // when pointed at or focused, and stays open while the Dashboard shows.
  bar.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:2147483647;display:flex;gap:2px;padding:2px;border-radius:999px;background:#08090ce6;border:1px solid #24262c;font:600 12px " + font + ";transition:opacity .15s";
  const tab = (label, open) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.setAttribute("role", "tab");
    b.dataset.view = open ? "dashboard" : "game";
    b.style.cssText = "cursor:pointer;border:0;border-radius:999px;padding:4px 12px;background:transparent;color:#a9abb0;font:inherit";
    b.onclick = () => show(open);
    bar.append(b);
    return b;
  };
  // Say what this is: a dev-server tool, so nobody looks for it in a shipped game.
  bar.title = "Dev only: shown by pnpm dev, not in production builds";
  const badge = document.createElement("span");
  badge.textContent = "DEV";
  badge.tabIndex = 0;
  badge.style.cssText = "align-self:center;padding:2px 6px 2px 8px;color:#e0fb50;font:700 10px " + font + ";letter-spacing:.08em";
  bar.append(badge);
  const game = tab("Game", false);
  const panel = tab("Dashboard", true);
  let open = false, pointed = false;
  const fold = () => {
    const shown = open || pointed || !!bar.querySelector(":focus-visible");
    for (const b of [game, panel]) b.style.display = shown ? "" : "none";
    badge.style.padding = shown ? "2px 6px 2px 8px" : "4px 10px";
    bar.style.opacity = shown ? "1" : ".55";
  };
  bar.onmouseenter = () => { pointed = true; fold(); };
  bar.onmouseleave = () => { pointed = false; fold(); };
  bar.addEventListener("focusin", fold);
  bar.addEventListener("focusout", () => setTimeout(fold));
  const mark = (on) => {
    for (const [b, selected] of [[game, !on], [panel, on]]) {
      b.setAttribute("aria-selected", String(selected));
      b.style.background = selected ? "#e0fb50" : "transparent";
      b.style.color = selected ? "#05070a" : "#a9abb0";
    }
  };
  const post = (message) => frame?.contentWindow?.postMessage(message, location.origin);
  const markers = () => post({ type: "tn-dashboard:markers", events: ring.slice() });
  const show = (on) => {
    if (on && !frame) {
      frame = document.createElement("iframe");
      frame.id = "tn-dev-dashboard-frame";
      frame.title = "ThreeNative Dev Dashboard";
      frame.src = dashboard;
      frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:2147483646;background:#08090c";
      frame.addEventListener("load", markers);
      document.body.append(frame);
    }
    if (frame) {
      frame.style.display = on ? "block" : "none";
      post({ type: on ? "tn-asset-library:resume" : "tn-asset-library:pause" });
      if (on) markers();
    }
    if (on) undock();
    hold(on);
    mark(on);
    open = on;
    fold();
  };
  // ── the optional live dock strip (PRD-923): Studio-themed, beside the pill, one write per window ──
  let strip;
  const undock = () => { strip?.remove(); strip = undefined; docked = undefined; };
  const dock = () => {
    show(false);
    if (strip) return;
    strip = document.createElement("div");
    strip.id = "tn-dev-dock";
    strip.setAttribute("role", "status");
    strip.style.cssText = "position:fixed;right:8px;top:8px;z-index:2147483647;display:flex;gap:12px;align-items:center;padding:5px 6px 5px 12px;border-radius:10px;background:#101115ee;border:1px solid #24262c;color:#f4f5f6;font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace";
    const cell = (label) => {
      const wrap = document.createElement("span");
      const name = document.createElement("span");
      name.textContent = label + " ";
      name.style.color = "#a9abb0";
      const value = document.createElement("b");
      value.textContent = "–";
      wrap.append(name, value);
      strip.append(wrap);
      return value;
    };
    const fps = cell("FPS"), p95 = cell("p95"), draws = cell("draws"), warn = cell("warn");
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.title = "Close the live strip";
    close.style.cssText = "cursor:pointer;border:0;border-radius:6px;padding:1px 8px;background:#17181d;color:#f4f5f6;font:600 15px/1 system-ui,sans-serif";
    close.onclick = undock;
    strip.append(close);
    let warnings = 0;
    docked = (code, text) => {
      if (code !== "TN_FRAME_BUDGET") { warnings += 1; warn.textContent = String(warnings); warn.style.color = "#fbbf24"; return; }
      try {
        const w = JSON.parse(text.slice(text.indexOf("{")));
        const f = w.presentedFps ?? w.fps;
        fps.textContent = f === undefined ? "–" : Math.round(f).toString();
        fps.style.color = f !== undefined && w.targetFps && f < w.targetFps * 0.9 ? "#fbbf24" : "#4ade80";
        const ms = w.presented?.p95 ?? w.frame?.p95;
        p95.textContent = ms === undefined ? "–" : ms.toFixed(1) + " ms";
        const d = w.passes?.main?.draws?.mean;
        draws.textContent = d === undefined ? "–" : Math.round(d).toString();
      } catch {}
    };
    for (const event of ring) if (event.code === "TN_FRAME_BUDGET") docked(event.code, event.text);
    document.body.append(strip);
  };
  window.addEventListener("message", (event) => {
    if (event.origin !== location.origin || event.source !== frame?.contentWindow) return;
    const type = event.data?.type;
    if (type === "tn-dashboard:request-markers") markers();
    else if (type === "tn-dashboard:dock") dock();
    else if (type === "tn-dashboard:game") show(false);
    else if (type === "tn-dashboard:clear-markers") ring.length = 0;
  });
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
  const dashboard = options.dashboardPath ?? "/__dashboard/";
  for (const [name, value] of [
    ["mountPath", mount],
    ["dashboardPath", dashboard],
  ] as const)
    if (!value.startsWith("/") || !value.endsWith("/"))
      throw new Error(
        `createAssetLibraryPlugin: ${name} must start and end with "/", got ${JSON.stringify(value)}`,
      );
  let api: IDashboardApi | undefined;
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
        const config = {
          base: mount,
          title: options.title ?? "Asset Library",
          dashboard,
          project: options.project !== false,
        };
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
      const attachCloudflare = (target: typeof sources, root: string): void => {
        if (options.cloudflare === false || target.some((s) => s.id === "cloudflare")) return;
        const explicit = options.cloudflare === true || typeof options.cloudflare === "string";
        if (!explicit && process.env.VITEST) return;
        target.push(
          cloudflareCatalogSource({
            origin: typeof options.cloudflare === "string" ? options.cloudflare : undefined,
            root,
            save: options.project !== false,
          }),
        );
      };
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
        attachCloudflare(sources, server.config.root);
        for (const source of sources) source.configureServer?.(server);
        return handler;
      })();
      attached = ready;
      const html = (page: "index.html" | "story.html", entry: string) =>
        readFileSync(path.join(dir, page), "utf8")
          .replaceAll("%BASE%", mount)
          .replace("%STYLE%", () => readFileSync(path.join(dir, "client.css"), "utf8"))
          .replace("%ENTRY%", entry);
      if (options.project !== false) {
        api = createDashboardApi({
          root: server.config.root,
          url: () => server.resolvedUrls?.local?.[0],
        });
        server.httpServer?.once("close", () => api?.close());
      }
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://library");
        // The Dashboard (PRD-918) is the same page as the library, plus its own API.
        const onDashboard = url.pathname.startsWith(dashboard);
        if (!onDashboard && !url.pathname.startsWith(mount)) return next();
        const rest = url.pathname.slice((onDashboard ? dashboard : mount).length);
        if (onDashboard && rest.startsWith("api/")) {
          if (!api) return next();
          api
            .handle(rest.slice("api/".length), url, req, res)
            .then((handled) => {
              if (!handled) json(res, 404, { error: `no dashboard route ${req.method} ${rest}` });
            })
            .catch((error: Error) => json(res, 500, { error: error.message }));
          return;
        }
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
        if (!local) return;
        if (options.project !== false)
          server.config.logger?.info(`  ➜  Dashboard: ${new URL(dashboard, local).href}`);
        server.config.logger?.info(`  ➜  Asset Library: ${new URL(mount, local).href}`);
      };
      server.httpServer?.once("listening", () => setTimeout(banner, 0));
    },
    transformIndexHtml: {
      order: "post",
      handler(html, context) {
        if (
          options.devShell === false ||
          context.path.startsWith(mount) ||
          context.path.startsWith(dashboard)
        )
          return html;
        const target = options.project === false ? mount : dashboard;
        return html.replace(
          /<head([^>]*)>/u,
          `<head$1><script>${devShellScript(mount, target)}</script>`,
        );
      },
    },
  };
}
