import path from "node:path";
import { type IResolvedThreeNativeConfig, loadConfig } from "./config.js";
import { type IWebEnginePlugin, createWebEnginePlugin } from "./web-engine.js";

export interface IWebBrandVitePlugin {
  readonly name: string;
  readonly enforce: "pre";
  config(config: { readonly root?: string }): Promise<
    { optimizeDeps: { exclude: string[] } } | undefined
  >;
  resolveId(source: string, importer?: string): string | null;
  load(id: string): Promise<string | null>;
  configResolved(config: { readonly root: string }): Promise<void>;
  transformIndexHtml(html: string): string;
  generateBundle(this: {
    emitFile(asset: { fileName: string; source: string; type: "asset" }): void;
  }): void;
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
        };
      return undefined;
    },
    resolveId(source, importer) {
      return engine?.resolveId(source, importer) ?? null;
    },
    async load(id) {
      return engine?.load(id) ?? null;
    },
    async configResolved(resolved) {
      root = resolved.root;
      config = await loadConfig(root);
      // The Wasm engine is the browser's. `runtime-native/scripts/bundle.mjs` builds a native
      // bundle through the project's own Vite config and names its target here: that bundle is one
      // script inside a non-async function, which the engine module's top-level await cannot parse
      // in, and its host brings its own engine.
      if (config.engine === "threenative" && process.env.THREENATIVE_NATIVE_BUNDLE === undefined)
        engine = createWebEnginePlugin({ root, engine: config.engine });
    },
    transformIndexHtml(html) {
      if (config === undefined) throw new Error("TN_WEB_BRAND_CONFIG_MISSING");
      return updateLaunchMarkup(root, config, html);
    },
    generateBundle() {
      if (config === undefined) throw new Error("TN_WEB_BRAND_CONFIG_MISSING");
      this.emitFile({
        fileName: "manifest.webmanifest",
        source: renderWebManifest(root, config),
        type: "asset",
      });
    },
  };
}
