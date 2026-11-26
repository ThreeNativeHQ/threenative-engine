// Cloudflare public asset catalog source for the shared Asset Library (PRD-120 / PRD-915).
// Fetches only `catalog.json` on startup, and lazy-loads each `.glb` on demand when a row is
// selected, caching downloads locally under `node_modules/.cache/tn-asset-library/cloudflare/`.
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { IAssetCatalog, IAssetElement, IAssetLibrarySource } from "./types.js";

const DEFAULT_ORIGIN = "https://gateway.threenative.com";
const CATALOG_TTL_MS = 5 * 60 * 1000;
const CATALOG_TIMEOUT_MS = 5000;
const GLB_TIMEOUT_MS = 30_000;
const UUID_FILE_RE = /^file\/([0-9a-f-]{36})\.glb$/iu;
const UUID_RE = /^[0-9a-f-]{36}$/iu;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

const CATEGORY_PREFIXES: readonly (readonly [string, string])[] = [
  ["wolf-", "Animals"],
  ["floor-", "Forest Floor"],
  ["tree-", "Trees"],
  ["cover-", "Ground Cover"],
  ["debris-", "Forest Debris"],
  ["rock-", "Rock Formations"],
  ["city-", "City"],
  ["station-", "Station Kit"],
  ["frontier-", "Frontier Kit"],
  ["pickup-", "Pickups"],
  ["mechanism-", "Mechanism Kit"],
  ["rail-", "Rail Kit"],
  ["sports-", "Sports Kit"],
  ["logistics-", "Logistics Kit"],
  ["workshop-", "Workshop Kit"],
  ["tavern-", "Tavern Kit"],
  ["stylized-", "Stylized Biome Kit"],
  ["dungeon-", "Dungeon Kit"],
  ["village-", "Village Kit"],
  ["toybox-", "Toybox Kit"],
];

interface IPublicCatalogItem {
  readonly id: string;
  readonly slug: string;
  readonly prompt: string;
  readonly tags: string;
  readonly type: string;
  readonly origin: string;
  readonly license: string;
  readonly author: string;
  readonly byteSize: number;
}

export interface ICloudflareSourceOptions {
  /** Project root (`save` copies selected `.glb` files into `<root>/assets/models/`). */
  readonly root: string;
  /** Cloudflare gateway base URL. Default `https://gateway.threenative.com`. */
  readonly origin?: string;
  /** Disk cache directory. Default `<root>/node_modules/.cache/tn-asset-library/cloudflare`. */
  readonly cache?: string;
  /** Offer a `save` route copying the cached `.glb` into `<root>/assets/models/<slug>.glb`. */
  readonly save?: boolean;
  /** Custom `fetch` implementation for tests. */
  readonly fetcher?: typeof fetch;
}

function sendJson(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
  return true;
}

function categoryForSlug(slug: string): string {
  for (const [prefix, category] of CATEGORY_PREFIXES) {
    if (slug.startsWith(prefix)) return category;
  }
  return "Models";
}

function displayNameFor(item: IPublicCatalogItem): string {
  // Asset Library prompts carry trailing ` (Category; kind; ...)` metadata; keep the readable title.
  const stripped = item.prompt
    .replace(
      /\s*\([^)]*\b(?:tree|cover|debris|rock|city|station|frontier|pickup|mechanism|rail|sports|logistics|workshop|tavern|stylized|dungeon|village|toybox)\b[^)]*\)$/iu,
      "",
    )
    .trim();
  const text = stripped || item.slug.replace(/-/gu, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function toAssetElement(item: IPublicCatalogItem): IAssetElement {
  return {
    bake: `asset_download({ provider: "threenative", id: "${item.id}", slug: "${item.slug}" })`,
    category: categoryForSlug(item.slug),
    id: item.slug,
    kind: "cloud",
    name: displayNameFor(item),
    source: "cloudflare",
    styleTags: ["cloud"],
  };
}

function emptyCatalog(): IAssetCatalog {
  return { elements: [], kinds: {}, styles: {} };
}

/** Lazy-loading Cloudflare public catalog source (`gateway.threenative.com/api/assets/public/*`). */
export function cloudflareCatalogSource(options: ICloudflareSourceOptions): IAssetLibrarySource {
  const root = path.resolve(options.root);
  const origin = options.origin ?? DEFAULT_ORIGIN;
  const cacheDir =
    options.cache ?? path.join(root, "node_modules", ".cache", "tn-asset-library", "cloudflare");
  const fetcher = options.fetcher ?? fetch;

  let cachedItems: IPublicCatalogItem[] = [];
  let cachedAt = 0;
  let catalogInflight: Promise<IPublicCatalogItem[]> | undefined;
  const fileInflight = new Map<string, Promise<string>>();

  async function loadItems(force = false): Promise<IPublicCatalogItem[]> {
    if (!force && cachedAt > 0 && Date.now() - cachedAt < CATALOG_TTL_MS) return cachedItems;
    catalogInflight ??= (async () => {
      try {
        const res = await fetcher(new URL("/api/assets/public/catalog.json", origin), {
          signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
        });
        if (!res.ok) return cachedItems;
        const parsed = (await res.json()) as { items?: IPublicCatalogItem[] };
        cachedItems = (parsed.items ?? []).filter((entry) => entry.type === "model");
        cachedAt = Date.now();
        return cachedItems;
      } catch {
        // Stay resilient offline: fail open so local project/procedural assets still load.
        return cachedItems;
      } finally {
        catalogInflight = undefined;
      }
    })();
    return await catalogInflight;
  }

  async function ensureGlbFile(id: string): Promise<string> {
    if (!UUID_RE.test(id)) throw new Error(`Invalid public asset id "${id}"`);
    const cachedFile = path.join(cacheDir, `${id}.glb`);
    const info = await stat(cachedFile).catch(() => undefined);
    if (info?.isFile() && info.size > 0) return cachedFile;

    const existingJob = fileInflight.get(id);
    if (existingJob) return await existingJob;

    const job = (async () => {
      try {
        const res = await fetcher(new URL(`/api/assets/public/${id}`, origin), {
          signal: AbortSignal.timeout(GLB_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`Cloudflare asset ${id} answered ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength === 0) throw new Error(`Cloudflare asset ${id} was empty`);
        await mkdir(cacheDir, { recursive: true });
        await writeFile(cachedFile, bytes);
        return cachedFile;
      } finally {
        fileInflight.delete(id);
      }
    })();
    fileInflight.set(id, job);
    return await job;
  }

  async function handleBake(url: URL, base: string, res: ServerResponse): Promise<true> {
    const slug = url.searchParams.get("id") ?? "";
    const items = await loadItems();
    const item = items.find((entry) => entry.slug === slug);
    if (!item) return sendJson(res, 404, { error: `Unknown Cloudflare asset "${slug}"` });
    const saveUrl = options.save
      ? `${base}save?id=${encodeURIComponent(item.id)}&slug=${encodeURIComponent(item.slug)}`
      : undefined;
    return sendJson(res, 200, {
      bounds: { max: [1, 2, 1], min: [-1, 0, -1] },
      call: `// Download via threenative-assets MCP:\n// asset_download({ provider: "threenative", id: "${item.id}", slug: "${item.slug}" })`,
      ms: 0,
      path: `cloudflare/${item.slug}.glb`,
      ...(saveUrl ? { save: saveUrl } : {}),
      triangles: 0,
      url: `${base}file/${item.id}.glb`,
    });
  }

  async function handleSave(url: URL, res: ServerResponse): Promise<true> {
    const id = url.searchParams.get("id") ?? "";
    const slug = url.searchParams.get("slug") ?? "";
    if (!UUID_RE.test(id) || !SLUG_RE.test(slug)) {
      return sendJson(res, 400, { error: "Invalid Cloudflare asset save parameters" });
    }
    const cachedFile = await ensureGlbFile(id);
    const dest = path.join(root, "assets", "models", `${slug}.glb`);
    await mkdir(path.dirname(dest), { recursive: true });
    await copyFile(cachedFile, dest);
    return sendJson(res, 200, { written: path.relative(root, dest).split(path.sep).join("/") });
  }

  return {
    id: "cloudflare",
    async catalog(): Promise<IAssetCatalog> {
      const items = await loadItems();
      if (items.length === 0) return emptyCatalog();
      return {
        elements: items.map(toAssetElement),
        kinds: {
          cloud: {
            lazy: true,
            lod: false,
            name: "Cloudflare Catalog",
            pack: "Cloudflare Catalog",
            seed: false,
          },
        },
        styles: { cloud: "Cloudflare Catalog" },
      };
    },
    async handle(
      route: string,
      url: URL,
      req: IncomingMessage,
      res: ServerResponse,
    ): Promise<boolean> {
      const base = url.pathname.slice(0, url.pathname.length - route.length);
      if (route === "bake") return await handleBake(url, base, res);
      const match = UUID_FILE_RE.exec(route);
      if (match?.[1]) {
        const cachedFile = await ensureGlbFile(match[1]);
        res.statusCode = 200;
        res.setHeader("content-type", "model/gltf-binary");
        res.setHeader("cache-control", "public, max-age=31536000, immutable");
        res.end(await readFile(cachedFile));
        return true;
      }
      if (route === "save" && req.method === "POST" && options.save) {
        return await handleSave(url, res);
      }
      return false;
    },
  };
}
