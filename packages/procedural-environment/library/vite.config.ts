// `pnpm asset-library`: a Storybook-shaped viewer for every element this package bakes.
// The page asks this server for the catalog and for bakes; the server calls the package's own
// built bake functions, so the viewer shows exactly what a game gets and nothing the package lacks.
import { readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import { type Plugin, defineConfig } from "vite";
import { cityModules, cityRoadDefaults, cityRoadEdgeModules } from "../src/city.js";
import { stylizedAssets } from "../src/stylized.js";
import Outcrop from "../vendor/outcrop.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const cache = path.join(here, ".cache");

type Package = typeof import("../src/index.js");
const dist = path.join(here, "../dist/index.js");
/** Config reloads share Node's module cache, so each config needs a fresh starting version. */
let version = Date.now();
const load = (): Promise<Package> =>
  import(`${pathToFileURL(dist).href}?v=${version}`) as Promise<Package>;
const roadsWithSockets = cityModules()
  .filter(({ edges }) => edges.length > 0)
  .map(({ id }) => id);

/** One control in the viewer's panel; `only` limits it to those element ids. Unset = the bake's default. */
interface IControl {
  key: string;
  label: string;
  type: "range" | "select" | "toggle" | "text";
  group?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  default?: number | string | boolean;
  only?: string[];
}

const unit = (key: string, label: string, group: string): IControl => ({
  key,
  label,
  type: "range",
  group,
  min: 0,
  max: 1,
  step: 0.01,
});
const ROCK_TRAITS: IControl[] = [
  unit("roughness", "Roughness", "Shape"),
  unit("chipping", "Chipping", "Shape"),
  unit("fracture", "Fracture", "Shape"),
  unit("columnar", "Columnar", "Shape"),
  unit("strata", "Strata", "Shape"),
  { key: "layers", label: "Beds", type: "range", group: "Shape", min: 2, max: 30, step: 1 },
  { key: "tilt", label: "Bed tilt", type: "range", group: "Shape", min: -35, max: 35, step: 1 },
  unit("weathering", "Weathering", "Shape"),
];
const ROCK_SURFACE: IControl[] = [
  unit("banding", "Banding", "Surface"),
  unit("edgeWear", "Edge wear", "Surface"),
  unit("cavity", "Crevices", "Surface"),
  unit("moss", "Moss", "Surface"),
  unit("sand", "Sand", "Surface"),
  unit("lichen", "Lichen", "Surface"),
  unit("snow", "Snow", "Surface"),
  unit("tide", "Tide line", "Surface"),
];
const SIZE: IControl[] = ["Width", "Height", "Depth"].map((label, k) => ({
  key: `size${k}`,
  label: `${label} x`,
  type: "range",
  group: "Size",
  min: 0.4,
  max: 2.5,
  step: 0.05,
  default: 1,
}));
const TEXTURES: IControl = {
  key: "textures",
  label: "Textures",
  type: "select",
  options: ["scans", "generated"],
  default: "scans",
};

/** The panel each kind shows. A kind missing here gets seed and LOD only. */
function controls(biomes: string[]): Record<string, IControl[]> {
  return {
    tree: [TEXTURES],
    cover: [TEXTURES],
    debris: [TEXTURES],
    rock: [
      { key: "biome", label: "Biome", type: "select", options: biomes, default: "hills" },
      { key: "detail", label: "Detail", type: "range", min: 0, max: 1, step: 0.05, default: 0.3 },
      {
        key: "module",
        label: "Module along X",
        type: "range",
        min: -3,
        max: 3,
        step: 1,
        default: 0,
        only: ["cliff"],
      },
      ...SIZE,
      ...ROCK_TRAITS,
      ...ROCK_SURFACE,
    ],
    city: [
      {
        key: "roadWidth",
        label: "Road width (m)",
        type: "range",
        min: 6,
        max: 16,
        step: 0.25,
        default: cityRoadDefaults.roadWidth,
        only: ["straight", "curve"],
        group: "Road geometry",
      },
      {
        key: "roadLength",
        label: "Road length (m)",
        type: "range",
        min: 8,
        max: 200,
        step: 1,
        default: cityRoadDefaults.roadLength,
        only: ["straight"],
        group: "Road geometry",
      },
      {
        key: "bendAngle",
        label: "Bend angle (°)",
        type: "range",
        min: 5,
        max: 180,
        step: 1,
        default: cityRoadDefaults.bendAngle,
        only: ["curve"],
        group: "Road geometry",
      },
      {
        key: "bendRadius",
        label: "Bend radius (m)",
        type: "range",
        min: 12,
        max: 120,
        step: 1,
        default: cityRoadDefaults.bendRadius,
        only: ["curve"],
        group: "Road geometry",
      },
      {
        key: "bendSide",
        label: "Bend direction",
        type: "select",
        options: ["left", "right"],
        default: cityRoadDefaults.bendSide,
        only: ["curve"],
        group: "Road geometry",
      },
      {
        key: "roadSurface",
        label: "Road surface",
        type: "select",
        options: ["asphalt", "concrete", "paving"],
        default: cityRoadDefaults.roadSurface,
        only: roadsWithSockets,
        group: "Road finish",
      },
      {
        key: "sidewalk",
        label: "Sidewalks",
        type: "toggle",
        default: true,
        only: cityRoadEdgeModules,
        group: "Road finish",
      },
      {
        key: "curb",
        label: "Curbs",
        type: "toggle",
        default: true,
        only: cityRoadEdgeModules,
        group: "Road finish",
      },
      {
        key: "markings",
        label: "Lane markings",
        type: "toggle",
        default: true,
        only: ["straight", "curve"],
        group: "Road finish",
      },
      { key: "detail", label: "Detail", type: "range", min: 0, max: 2, step: 1, default: 2 },
      { key: "wet", label: "Wetness", type: "range", min: 0, max: 100, step: 1, default: 30 },
      { key: "floors", label: "Floors", type: "range", min: 2, max: 12, step: 1, default: 4 },
      { key: "text", label: "Sign text", type: "text", default: "" },
      { key: "dressing", label: "Street fixtures", type: "toggle", default: true },
    ],
  };
}

const num = (q: URLSearchParams, key: string) => (q.has(key) ? Number(q.get(key)) : undefined);
const pick = (q: URLSearchParams, list: IControl[]) => {
  const out: Record<string, number> = {};
  for (const { key } of list) if (q.has(key)) out[key] = Number(q.get(key));
  return Object.keys(out).length ? out : undefined;
};

const opt = <T>(key: string, value: T | undefined) => (value === undefined ? {} : { [key]: value });

function rockBake(
  pkg: Package,
  q: URLSearchParams,
  base: { seed: number; lods: number[]; out: string },
) {
  const id = q.get("id") ?? "";
  const form = Outcrop.FORMS[id]?.size ?? [1, 1, 1];
  const scale = SIZE.map(({ key }) => num(q, key) ?? 1);
  const size = scale.some((v) => v !== 1)
    ? (form.map((v, k) => v * (scale[k] as number)) as [number, number, number])
    : undefined;
  return pkg.bakeRock({
    form: id,
    biome: q.get("biome") ?? "hills",
    ...base,
    ...opt("detail", num(q, "detail")),
    ...opt("module", num(q, "module") || undefined),
    ...opt("size", size),
    ...opt("traits", pick(q, ROCK_TRAITS)),
    ...opt("surface", pick(q, ROCK_SURFACE)),
  });
}

function cityBake(pkg: Package, q: URLSearchParams, base: { seed: number; out: string }) {
  const toggle = (key: string) => {
    const value = q.get(key);
    if (value === null) return undefined;
    if (value !== "true" && value !== "false") throw new Error(`Invalid toggle: ${key}`);
    return value === "true";
  };
  return pkg.bakeCity({
    module: q.get("id") ?? "",
    ...base,
    ...opt("detail", num(q, "detail")),
    ...opt("wet", num(q, "wet")),
    ...opt("floors", num(q, "floors")),
    ...opt("text", q.get("text") ?? undefined),
    ...opt("dressing", toggle("dressing")),
    ...opt("roadWidth", num(q, "roadWidth")),
    ...opt("roadLength", num(q, "roadLength")),
    ...opt("bendAngle", num(q, "bendAngle")),
    ...opt("bendRadius", num(q, "bendRadius")),
    ...opt("bendSide", q.get("bendSide") ?? undefined),
    ...opt("roadSurface", q.get("roadSurface") ?? undefined),
    ...opt("sidewalk", toggle("sidewalk")),
    ...opt("curb", toggle("curb")),
    ...opt("markings", toggle("markings")),
  });
}

/** Every bake the viewer can ask for, keyed by element kind; a query key is a control's key. */
function bake(pkg: Package, q: URLSearchParams) {
  const kind = q.get("kind") ?? "";
  const seed = num(q, "seed") ?? (kind === "city" ? 31082 : 1);
  const lods = [num(q, "lod") ?? 0];
  const out = path.join(cache, kind);
  if (kind === "rock") return rockBake(pkg, q, { seed, lods, out });
  if (kind === "city") return cityBake(pkg, q, { seed, out });
  if (kind === "tree" || kind === "cover" || kind === "debris")
    return pkg.bakeVegetation({
      preset: q.get("id") ?? "",
      seed,
      lods,
      out,
      ...opt("textures", q.get("textures") === "generated" ? ("generated" as const) : undefined),
    });
  throw new Error(`asset-library: no bake for kind "${kind}"`);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const baked = new Map<string, Promise<unknown>>();

const fileUrl = (file = ""): string => `/api/file/${path.relative(cache, file)}?v=${version}`;

/** One bake per distinct query, shared by every request that asks for it while it runs. */
function bakeOnce(q: URLSearchParams): Promise<unknown> {
  const key = q.toString();
  const known = baked.get(key);
  if (known) return known;
  const started = performance.now();
  let call = "";
  // The exact call the bake made, for the docs panel: the viewer's flat controls are nested here.
  const record = (pkg: Package): Package =>
    new Proxy(pkg, {
      get: (target, name: string) => {
        const value = target[name as keyof Package];
        if (typeof value !== "function" || !name.startsWith("bake")) return value;
        return (options: { out: string }) => {
          call = `await ${name}(${JSON.stringify({ ...options, out: `assets/${q.get("kind")}` })});`;
          return (value as (o: unknown) => unknown)(options);
        };
      },
    });
  const job = load()
    .then((pkg) => bake(record(pkg), q))
    .then(([entry]) => ({
      ...entry,
      call,
      ms: Math.round(performance.now() - started),
      url: fileUrl(entry?.path),
      ...(entry?.rock
        ? { rockMaps: { detail: fileUrl(entry.rock.detail), normal: fileUrl(entry.rock.normal) } }
        : {}),
    }));
  baked.set(key, job);
  job.catch(() => baked.delete(key));
  return job;
}

async function file(res: ServerResponse, name: string): Promise<void> {
  const target = path.resolve(cache, decodeURIComponent(name));
  if (!target.startsWith(cache + path.sep)) return send(res, 403, { error: "outside cache" });
  res.setHeader("content-type", target.endsWith(".webp") ? "image/webp" : "model/gltf-binary");
  res.end(await readFile(target));
}

async function route(url: URL, res: ServerResponse): Promise<boolean> {
  if (url.pathname === "/api/catalog") {
    const pkg = await load();
    const biomes = pkg.environmentBiomes();
    send(res, 200, {
      biomes,
      styles: { realistic: "Realistic", stylized: "Stylized" },
      elements: [
        ...pkg.environmentElements().map((entry) => ({ ...entry, styleTags: ["realistic"] })),
        ...stylizedAssets().map((entry) => ({
          ...entry,
          styleTags: ["stylized"],
        })),
      ],
      controls: controls(biomes.map((biome) => biome.id)),
    });
  } else if (url.pathname === "/api/bake") send(res, 200, await bakeOnce(url.searchParams));
  else if (url.pathname.startsWith("/api/file/")) await file(res, url.pathname.slice(10));
  else return false;
  return true;
}

function api(): Plugin {
  return {
    name: "asset-library-api",
    configureServer(server) {
      // Live: `tsup --watch` rewrites dist; drop every bake and reload the page on the new code.
      server.watcher.add(dist);
      server.watcher.on("all", (event, changed) => {
        if (changed !== dist || event === "unlink") return;
        version++;
        baked.clear();
        void rm(cache, { force: true, recursive: true }).then(() =>
          server.ws.send({ type: "full-reload" }),
        );
      });
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
        route(new URL(req.url ?? "/", "http://library"), res)
          .then((handled) => handled || next())
          .catch((error: Error) => send(res, 500, { error: error.message }));
      });
    },
  };
}

export default defineConfig({
  root: here,
  plugins: [tailwindcss(), api()],
  server: { open: true },
});
