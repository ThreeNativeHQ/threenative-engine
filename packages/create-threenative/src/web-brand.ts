import path from "node:path";
import { type IResolvedThreeNativeConfig, loadConfig } from "./config.js";
import { type IWebEnginePlugin, WEB_ENGINE_ID, createWebEnginePlugin } from "./web-engine.js";

export interface IWebBrandVitePlugin {
  readonly name: string;
  readonly enforce: "pre";
  config(config: { readonly root?: string }): Promise<
    { optimizeDeps: { exclude: string[] } } | undefined
  >;
  resolveId(source: string, importer?: string): string | null;
  load(id: string): Promise<string | null>;
  configResolved(config: {
    readonly root: string;
    readonly command?: "build" | "serve";
  }): Promise<void>;
  transformIndexHtml(
    html: string,
    context?: { readonly bundle?: Readonly<Record<string, IBundleFile>> },
  ): string;
  configureServer(server: IMiddlewareServer): void;
  configurePreviewServer(server: IMiddlewareServer): void;
  generateBundle(this: {
    emitFile(asset: { fileName: string; source: string; type: "asset" }): void;
  }): void;
}

type Middleware = (
  req: { url?: string },
  res: { setHeader(key: string, value: string): void; end(body: string): void },
  next: () => void,
) => void;

interface IMiddlewareServer {
  readonly middlewares: { use(handler: Middleware): void };
}

/**
 * Cross-origin isolation (PRD-752 phase 4): the threaded web engine runs on shared memory, which a
 * browser gives only to a page served with both headers. Every asset a kit loads is same-origin, so
 * `require-corp` blocks nothing; a game that loads cross-origin assets without CORP headers switches
 * to `credentialless`. A host that cannot set headers gets them from the build's service worker.
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = {
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** `?tnIsolation=0` serves a page without the headers: the single-thread arm of an A/B on one build. */
export const isolationMiddleware: Middleware = (req, res, next) => {
  if (!/[?&]tnIsolation=0(?:&|$)/u.test(req.url ?? ""))
    for (const [key, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(key, value);
  next();
};

/**
 * The same headers for a static host that reads a `_headers` file (Netlify, Cloudflare Pages), plus
 * a year-long immutable cache for Vite's content-hashed `assets/` files (PRD-860): a repeat visit
 * then reads them from disk with no revalidation round trip, and a new build has new names.
 */
export function renderIsolationHeaders(): string {
  return `/*\n${Object.entries(ISOLATION_HEADERS)
    .map(([key, value]) => `  ${key}: ${value}\n`)
    .join("")}/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`;
}

/**
 * A host that cannot set headers (itch.io, GitHub Pages, a plain static server) still gets isolation:
 * the build ships this service worker, which adds the headers to every response it serves. The page
 * registers it and reloads once; a page the worker cannot isolate starts the engine, which refuses.
 */
export const ISOLATION_WORKER_FILE = "tn-isolation-sw.js";
export function renderIsolationWorker(): string {
  return `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(
    fetch(request).then((response) => {
      if (response.status === 0) return response;
      const headers = new Headers(response.headers);
${Object.entries({ ...ISOLATION_HEADERS, "Cross-Origin-Resource-Policy": "cross-origin" })
  .map(
    ([key, value]) => `      headers.set("${key}", "${value}");
`,
  )
  .join(
    "",
  )}      return new Response(response.body, { headers, status: response.status, statusText: response.statusText });
    }),
  );
});
`;
}

/**
 * Runs before the game module: registers the worker and reloads once under it. `__tnIsolation`
 * settles only when that cannot help, so the engine's refusal waits for it and never races a reload.
 * The session flag stops a reload loop on a host the worker cannot isolate.
 */
const ISOLATION_BOOT = `<script>(() => {
  const key = "tnIsolationReload";
  const store = (use) => { try { return use(sessionStorage); } catch { return null; } };
  if (globalThis.crossOriginIsolated) return void store((s) => s.removeItem(key));
  if (!isSecureContext || !("serviceWorker" in navigator) || /[?&]tnIsolation=0(?:&|$)/.test(location.search)) return;
  globalThis.__tnIsolation = navigator.serviceWorker.register("${ISOLATION_WORKER_FILE}")
    .then(() => navigator.serviceWorker.ready)
    .then(() => {
      if (store((s) => s.getItem(key)) !== null) return void store((s) => s.removeItem(key));
      if (store((s) => (s.setItem(key, "1"), true)) !== true) return;
      location.reload();
      return new Promise(() => {});
    }, () => {});
})();</script>`;

/**
 * The build identity `ctx.assets.memo` keys on (PRD-860): the hashed entry script, which changes
 * whenever any of the game's code does. Only a production page has one; the dev server's entry is
 * `src/main.ts`, so a dev page writes none and generated content rebuilds every run there.
 */
export function withBuildId(html: string): string {
  const entry = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]*\/assets\/[^"]+\.js)"/iu.exec(
    html,
  )?.[1];
  if (entry === undefined) return html;
  return html.replace(
    /<script/iu,
    `<script>globalThis.__TN_BUILD_ID__ = ${JSON.stringify(entry).replaceAll("<", "\\u003c")};</script>\n    <script`,
  );
}

export interface IBundleFile {
  readonly fileName: string;
  readonly type: string;
  readonly moduleIds?: readonly string[];
}

/**
 * Starts the engine's Wasm download with the page (PRD-860). The glue that fetches it loads only
 * after the entry script ran, so a first visit's network idled until ~330 ms and the 1 MB module
 * ended at ~800 ms; Rapier's chunk then waited for the engine to boot. This head script preloads the
 * Wasm the page will run (the threads build only when isolated: otherwise the isolation worker may
 * reload the page) and, once it lands, Rapier, so each gets the whole link in turn. Only for a Wasm
 * this browser has not fetched: a preloaded response loses V8's compiled-code cache, and a repeat
 * visit that recompiled the module was ~150 ms slower on a laptop.
 */
export function withEnginePreload(
  html: string,
  bundle: Readonly<Record<string, IBundleFile>> | undefined,
  threaded: boolean,
): string {
  if (bundle === undefined) return html;
  const files = Object.values(bundle);
  const entry = /<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]*)"/iu.exec(html)?.[1];
  const entryFile = files.find((file) => entry?.endsWith(file.fileName) === true);
  if (entry === undefined || entryFile === undefined) return html;
  const base = entry.slice(0, entry.length - entryFile.fileName.length);
  const href = (test: (file: IBundleFile) => boolean): string | undefined => {
    const found = files.find(test);
    return found === undefined ? undefined : base + found.fileName;
  };
  const threads = href((file) => /tn-native-engine-web-threads-[^/]*\.wasm$/u.test(file.fileName));
  const plain = href((file) =>
    /tn-native-engine-web-(?!threads-)[^/]*\.wasm$/u.test(file.fileName),
  );
  const wasm = threaded ? threads : plain;
  if (wasm === undefined) return html;
  const rapier = href(
    (file) =>
      file.type === "chunk" &&
      file.moduleIds?.some((id) => id.includes("/@dimforge/rapier3d")) === true,
  );
  const quote = (value: string | undefined) =>
    JSON.stringify(value ?? null).replaceAll("<", "\\u003c");
  const script = `<script>(() => {
  const link = (rel, href, as) => {
    const tag = Object.assign(document.createElement("link"), { rel, href, crossOrigin: "anonymous" });
    if (as !== undefined) tag.as = as;
    return document.head.appendChild(tag);
  };
  if (${threaded} && !globalThis.crossOriginIsolated) return;
  const href = ${quote(wasm)};
  const store = (use) => { try { return use(localStorage); } catch { return null; } };
  if (store((s) => s.getItem("tnEngineWasm")) === href) return;
  const wasm = link("preload", href, "fetch");
  const rapier = ${quote(rapier)};
  wasm.onload = wasm.onerror = () => {
    store((s) => s.setItem("tnEngineWasm", href));
    if (rapier !== null) link("modulepreload", rapier);
  };
})();</script>`;
  return html.replace(/<script/iu, `${script}\n    <script`);
}

function htmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

function publicUrl(root: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const relative = path.isAbsolute(value) ? path.relative(root, value) : value;
  const normalized = relative.replaceAll(path.sep, "/").replace(/^public\//u, "");
  return `/${normalized.replace(/^\//u, "")}`;
}

function manifestIcon(
  root: string,
  source: string | undefined,
  purpose: string,
): Record<string, string> | undefined {
  const url = publicUrl(root, source);
  if (url === undefined) return undefined;
  const type = url.endsWith(".svg") ? "image/svg+xml" : "image/png";
  return { purpose, src: url, type };
}

export function renderWebManifest(root: string, config: IResolvedThreeNativeConfig): string {
  const web = config.app.icons?.web;
  const fallback = web?.favicon ?? config.app.icon;
  const icons = [
    manifestIcon(root, fallback, "any"),
    manifestIcon(root, web?.maskable ?? config.app.icon, "maskable"),
    manifestIcon(root, web?.monochrome, "monochrome"),
  ].filter((icon): icon is Record<string, string> => icon !== undefined);
  const background = config.bootSplash?.backgroundColor ?? "#000000";
  const manifest = Object.fromEntries([
    ["background_color", background],
    ["display", "fullscreen"],
    ["icons", icons],
    ["name", config.app.name],
    ["orientation", config.display.orientation],
    ["short_name", config.app.name],
    ["start_url", "."],
    ["theme_color", background],
  ]);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function metadataLinks(root: string, config: IResolvedThreeNativeConfig): string {
  const web = config.app.icons?.web;
  const favicon = publicUrl(root, web?.favicon ?? config.app.icon);
  const appleTouch = publicUrl(root, web?.appleTouch ?? config.app.icon);
  const links = [
    favicon === undefined ? undefined : `<link rel="icon" href="${htmlAttribute(favicon)}" />`,
    appleTouch === undefined
      ? undefined
      : `<link rel="apple-touch-icon" href="${htmlAttribute(appleTouch)}" />`,
    '<link rel="manifest" href="/manifest.webmanifest" />',
  ].filter((link): link is string => link !== undefined);
  const background = config.bootSplash?.backgroundColor ?? "#000000";
  links.push(`<meta name="theme-color" content="${htmlAttribute(background)}" />`);
  return links.join("\n    ");
}

function updateLaunchMarkup(
  root: string,
  config: IResolvedThreeNativeConfig,
  html: string,
): string {
  let output = html.replace(
    /(<title[^>]*>)[\s\S]*?(<\/title>)/iu,
    `$1${htmlAttribute(config.app.name)}$2`,
  );
  output = output.replace(
    /(<[^>]*data-threenative-launch-name[^>]*>)[\s\S]*?(<\/[^>]+>)/iu,
    `$1${htmlAttribute(config.app.name)}$2`,
  );
  const launchImage = publicUrl(root, config.bootSplash?.image);
  if (launchImage !== undefined) {
    output = output.replace(
      /<img([^>]*data-threenative-launch-image[^>]*)>/iu,
      (_match, attributes: string) =>
        `<img${attributes.replace(/\s+hidden(?:="[^"]*")?/iu, "")} src="${htmlAttribute(launchImage)}">`,
    );
  }
  const links = metadataLinks(root, config);
  if (publicUrl(root, config.app.icons?.web?.favicon ?? config.app.icon) !== undefined)
    output = output.replace(/\s*<link\s+rel="icon"[^>]*>/giu, "");
  output = output.replace(/\s*<link\s+rel="apple-touch-icon"[^>]*>/giu, "");
  output = output.replace(/\s*<link\s+rel="manifest"[^>]*>/giu, "");
  output = output.replace(/(<\/head>)/iu, `    ${links}\n  $1`);
  return output;
}

export function createWebBrandPlugin(): IWebBrandVitePlugin {
  let root = process.cwd();
  let config: IResolvedThreeNativeConfig | undefined;
  let engine: IWebEnginePlugin | undefined;
  // Set once the threaded engine is in the bundle: only then does the page need isolation at boot.
  let threaded = false;
  const load = async (id: string): Promise<string | null> => {
    const code = (await engine?.load(id)) ?? null;
    if (id === WEB_ENGINE_ID && code !== null) threaded = true;
    return code;
  };
  return {
    name: "threenative-web-brand",
    enforce: "pre",
    async config(vite) {
      const loaded = await loadConfig(path.resolve(vite.root ?? process.cwd()));
      // The dep optimizer does not run resolveId, so a pre-bundled dependency (core) would inline the
      // upstream packages the engine replaces; three-mesh-bvh builds a refused Line3 at module scope.
      if (loaded.engine === "threenative" && process.env.THREENATIVE_NATIVE_BUNDLE === undefined)
        return {
          optimizeDeps: { exclude: ["three", "three/webgpu", "three/tsl", "three-mesh-bvh"] },
          // Vite runs only `worker.plugins` on a worker bundle, so a game booted in a worker
          // (PRD-752) needs the same resolver, as ES output for the engine's top-level await.
          worker: {
            format: "es",
            plugins: () => [
              {
                name: "threenative-web-engine-worker",
                enforce: "pre",
                resolveId: (source: string, importer?: string) =>
                  engine?.resolveId(source, importer) ?? null,
                load,
              },
            ],
          },
        };
      return undefined;
    },
    resolveId(source, importer) {
      return engine?.resolveId(source, importer) ?? null;
    },
    load,
    async configResolved(resolved) {
      root = resolved.root;
      config = await loadConfig(root);
      // The Wasm engine is the browser's. `runtime-native/scripts/bundle.mjs` builds a native
      // bundle through the project's own Vite config and names its target here: that bundle is one
      // script inside a non-async function, which the engine module's top-level await cannot parse
      // in, and its host brings its own engine.
      if (config.engine === "threenative" && process.env.THREENATIVE_NATIVE_BUNDLE === undefined)
        engine = createWebEnginePlugin({
          root,
          engine: config.engine,
          strict: resolved.command !== "build",
        });
    },
    transformIndexHtml(html, context) {
      if (config === undefined) throw new Error("TN_WEB_BRAND_CONFIG_MISSING");
      const output = withBuildId(updateLaunchMarkup(root, config, html));
      // Before the first script, so it runs ahead of the game module.
      const isolated = threaded
        ? output.replace(/<script/iu, `${ISOLATION_BOOT}\n    <script`)
        : output;
      return withEnginePreload(isolated, context?.bundle, threaded);
    },
    // Every page links the manifest, and only a build emits it: in dev Vite would answer the link
    // with index.html, which the browser reports as a manifest syntax error on each load.
    configureServer(server) {
      if (config?.engine === "threenative") server.middlewares.use(isolationMiddleware);
      server.middlewares.use((req, res, next) => {
        if (req.url?.split("?")[0] !== "/manifest.webmanifest" || config === undefined)
          return next();
        res.setHeader("Content-Type", "application/manifest+json");
        res.end(renderWebManifest(root, config));
      });
    },
    configurePreviewServer(server) {
      if (config?.engine === "threenative") server.middlewares.use(isolationMiddleware);
    },
    generateBundle() {
      if (config === undefined) throw new Error("TN_WEB_BRAND_CONFIG_MISSING");
      this.emitFile({
        fileName: "manifest.webmanifest",
        source: renderWebManifest(root, config),
        type: "asset",
      });
      if (config.engine === "threenative")
        this.emitFile({ fileName: "_headers", source: renderIsolationHeaders(), type: "asset" });
      if (threaded)
        this.emitFile({
          fileName: ISOLATION_WORKER_FILE,
          source: renderIsolationWorker(),
          type: "asset",
        });
    },
  };
}
