// `pnpm asset-library`: a Storybook-shaped viewer for every element this package bakes.
// The page asks this server for the catalog and for bakes; the server calls the package's own
// built bake functions, so the viewer shows exactly what a game gets and nothing the package lacks.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Plugin, defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(here, ".cache");

type Package = typeof import("../src/index.js");
const load = (): Promise<Package> =>
  import(pathToFileURL(path.join(here, "../dist/index.js")).href) as Promise<Package>;

/** Every bake the viewer can ask for, keyed by element kind. */
async function bake(pkg: Package, q: URLSearchParams) {
  const id = q.get("id") ?? "";
  const kind = q.get("kind") ?? "";
  const seed = Number(q.get("seed") ?? 1);
  const lods = [Number(q.get("lod") ?? 0)];
  const out = path.join(cache, kind);
  if (kind === "rock")
    return pkg.bakeRock({ form: id, biome: q.get("biome") ?? "hills", seed, lods, out });
  if (kind === "tree" || kind === "cover" || kind === "debris")
    return pkg.bakeVegetation({ preset: id, seed, lods, out });
  throw new Error(`asset-library: unknown kind "${kind}"`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const baked = new Map<string, Promise<unknown>>();

/** One bake per distinct query, shared by every request that asks for it while it runs. */
function bakeOnce(q: URLSearchParams): Promise<unknown> {
  const key = q.toString();
  const known = baked.get(key);
  if (known) return known;
  const started = performance.now();
  const job = load()
    .then((pkg) => bake(pkg, q))
    .then(([entry]) => ({
      ...entry,
      ms: Math.round(performance.now() - started),
      url: `/api/file/${path.relative(cache, entry?.path ?? "")}`,
    }));
  baked.set(key, job);
  job.catch(() => baked.delete(key));
  return job;
}

async function file(res: ServerResponse, name: string): Promise<void> {
  const target = path.resolve(cache, decodeURIComponent(name));
  if (!target.startsWith(cache + path.sep)) return send(res, 403, { error: "outside cache" });
  res.setHeader("content-type", "model/gltf-binary");
  res.end(await readFile(target));
}

async function route(url: URL, res: ServerResponse): Promise<boolean> {
  if (url.pathname === "/api/catalog") {
    const pkg = await load();
    send(res, 200, { biomes: pkg.environmentBiomes(), elements: pkg.environmentElements() });
  } else if (url.pathname === "/api/bake") send(res, 200, await bakeOnce(url.searchParams));
  else if (url.pathname.startsWith("/api/file/")) await file(res, url.pathname.slice(10));
  else return false;
  return true;
}

function api(): Plugin {
  return {
    name: "asset-library-api",
    configureServer(server) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        route(new URL(req.url ?? "/", "http://library"), res)
          .then((handled) => handled || next())
          .catch((error: Error) => send(res, 500, { error: error.message }));
      });
    },
  };
}

export default defineConfig({ root: here, plugins: [api()], server: { open: true } });
