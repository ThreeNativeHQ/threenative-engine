// `@threenative/procedural-environment/asset-library` (PRD-915): this package's bake catalog as one
// source of the shared Asset Library (`createAssetLibraryPlugin` in create-threenative). The page
// asks it for the catalog and for bakes; it calls the package's own bake functions, so the library
// shows exactly what a game gets. `save` copies a bake into the game's `assets/`.
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Outcrop from "../vendor/outcrop.js";
import { cityModules, cityRoadDefaults, cityRoadEdgeModules } from "./city.js";
import { frontierAccent, frontierModules } from "./frontier.js";
import { logisticsAccent, logisticsModules, logisticsShelfCount } from "./logistics.js";
import { litMechanismModules, mechanismAccent } from "./mechanisms.js";
import { flatPickupModules, pickupAccent } from "./pickups.js";
import { railAccent, railModules } from "./rail.js";
import { sportsDimensions, sportsModules } from "./sports.js";
import { stationAccent, stationRoofModules } from "./station.js";
import { stylizedAssets } from "./stylized.js";
import {
  workshopAccent,
  workshopHeights,
  workshopOpeningModules,
  workshopSeatCounts,
  workshopShelfCount,
  workshopWidths,
} from "./workshop.js";

const frontierPaintable = frontierModules
  .filter(({ id }) => id !== "ore")
  .map(({ id }) => `frontier-${id}`);

type Package = typeof import("./index.js");

/** One control in the library's panel; `only` limits it to those element ids. Unset = the bake's default. */
interface IControl {
  key: string;
  label: string;
  type: "range" | "select" | "toggle" | "text" | "color";
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
  const roadsWithSockets = cityModules()
    .filter(({ edges }) => edges.length > 0)
    .map(({ id }) => id);
  const road = (control: IControl): IControl => ({ group: "Road geometry", ...control });
  const finish = (control: IControl): IControl => ({ group: "Road finish", ...control });
  return {
    tree: [TEXTURES],
    cover: [TEXTURES],
    debris: [TEXTURES],
    mechanism: [
      { key: "accent", label: "Accent color", type: "color", default: mechanismAccent },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
      {
        key: "active",
        label: "Active",
        type: "toggle",
        default: false,
        only: litMechanismModules.map((id) => `mechanism-${id}`),
      },
    ],
    workshop: [
      { key: "accent", label: "Accent color", type: "color", default: workshopAccent },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
      ...(
        [
          ["width", "Width", workshopWidths],
          ["height", "Seat height", workshopHeights],
        ] as const
      ).flatMap(([key, label, ranges]) =>
        Object.entries(ranges).map(
          ([id, range]): IControl => ({
            key,
            label,
            type: "range",
            step: 0.01,
            ...range,
            only: [`workshop-${id}`],
          }),
        ),
      ),
      {
        key: "open",
        label: "Open",
        type: "toggle",
        default: false,
        only: workshopOpeningModules.map((id) => `workshop-${id}`),
      },
      ...Object.entries(workshopSeatCounts).map(
        ([id, seats]): IControl => ({
          key: "seats",
          label: "Seats",
          type: "range",
          step: seats.max - seats.min,
          ...seats,
          only: [`workshop-${id}`],
        }),
      ),
      {
        key: "shelves",
        label: "Shelf levels",
        type: "range",
        ...workshopShelfCount,
        step: 1,
        only: ["workshop-bookcase"],
      },
    ],
    logistics: [
      {
        key: "accent",
        label: "Accent color",
        type: "color",
        default: logisticsAccent,
        only: logisticsModules
          .filter(({ id }) => id !== "pallet")
          .map(({ id }) => `logistics-${id}`),
      },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
      {
        key: "shelves",
        label: "Shelf levels",
        type: "range",
        ...logisticsShelfCount,
        step: 1,
        only: ["logistics-rack"],
      },
      {
        key: "open",
        label: "Doors open",
        type: "toggle",
        default: false,
        only: ["logistics-container"],
      },
    ],
    sports: [
      ...sportsModules.map(
        ({ id, accent }): IControl => ({
          key: "accent",
          label: "Accent color",
          type: "color",
          default: accent,
          only: [`sports-${id}`],
        }),
      ),
      ...Object.entries(sportsDimensions).flatMap(([id, dimensions]) =>
        Object.entries(dimensions).map(
          ([key, rules]): IControl => ({
            key,
            ...rules,
            type: "range",
            step: 0.01,
            only: [`sports-${id}`],
          }),
        ),
      ),
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
    ],
    rail: [
      {
        key: "accent",
        label: "Accent color",
        type: "color",
        default: railAccent,
        only: railModules
          .filter(({ id }) => ["ramp", "bridge", "stop", "cart"].includes(id))
          .map(({ id }) => `rail-${id}`),
      },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
    ],
    pickup: [
      { key: "accent", label: "Accent color", type: "color", default: pickupAccent },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
      {
        key: "pose",
        label: "Pose",
        type: "select",
        options: ["upright", "flat"],
        default: "upright",
        only: flatPickupModules.map((id) => `pickup-${id}`),
      },
    ],
    frontier: [
      {
        key: "accent",
        label: "Team color",
        type: "color",
        default: frontierAccent,
        only: frontierPaintable,
      },
      { key: "scale", label: "Scale", type: "range", min: 0.5, max: 2, step: 0.05, default: 1 },
    ],
    station: [
      { key: "accent", label: "Accent paint", type: "color", default: stationAccent },
      { key: "roof", label: "Ceiling", type: "toggle", default: false, only: stationRoofModules },
    ],
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
      road({
        key: "roadWidth",
        label: "Road width (m)",
        type: "range",
        min: 6,
        max: 16,
        step: 0.25,
        default: cityRoadDefaults.roadWidth,
        only: ["straight", "curve"],
      }),
      road({
        key: "roadLength",
        label: "Road length (m)",
        type: "range",
        min: 8,
        max: 200,
        step: 1,
        default: cityRoadDefaults.roadLength,
        only: ["straight"],
      }),
      road({
        key: "bendAngle",
        label: "Bend angle (°)",
        type: "range",
        min: 5,
        max: 180,
        step: 1,
        default: cityRoadDefaults.bendAngle,
        only: ["curve"],
      }),
      road({
        key: "bendRadius",
        label: "Bend radius (m)",
        type: "range",
        min: 12,
        max: 120,
        step: 1,
        default: cityRoadDefaults.bendRadius,
        only: ["curve"],
      }),
      road({
        key: "bendSide",
        label: "Bend direction",
        type: "select",
        options: ["left", "right"],
        default: cityRoadDefaults.bendSide,
        only: ["curve"],
      }),
      finish({
        key: "roadSurface",
        label: "Road surface",
        type: "select",
        options: ["asphalt", "concrete", "paving"],
        default: cityRoadDefaults.roadSurface,
        only: roadsWithSockets,
      }),
      finish({
        key: "sidewalk",
        label: "Sidewalks",
        type: "toggle",
        default: true,
        only: cityRoadEdgeModules,
      }),
      finish({
        key: "curb",
        label: "Curbs",
        type: "toggle",
        default: true,
        only: cityRoadEdgeModules,
      }),
      finish({
        key: "markings",
        label: "Lane markings",
        type: "toggle",
        default: true,
        only: ["straight", "curve"],
      }),
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

function toggle(q: URLSearchParams, key: string): boolean | undefined {
  const value = q.get(key);
  if (value === null) return undefined;
  if (value !== "true" && value !== "false") throw new Error(`Invalid toggle: ${key}`);
  return value === "true";
}

function cityBake(pkg: Package, q: URLSearchParams, base: { seed: number; out: string }) {
  return pkg.bakeCity({
    module: q.get("id") ?? "",
    ...base,
    ...opt("detail", num(q, "detail")),
    ...opt("wet", num(q, "wet")),
    ...opt("floors", num(q, "floors")),
    ...opt("text", q.get("text") ?? undefined),
    ...opt("dressing", toggle(q, "dressing")),
    ...opt("roadWidth", num(q, "roadWidth")),
    ...opt("roadLength", num(q, "roadLength")),
    ...opt("bendAngle", num(q, "bendAngle")),
    ...opt("bendRadius", num(q, "bendRadius")),
    ...opt("bendSide", q.get("bendSide") ?? undefined),
    ...opt("roadSurface", q.get("roadSurface") ?? undefined),
    ...opt("sidewalk", toggle(q, "sidewalk")),
    ...opt("curb", toggle(q, "curb")),
    ...opt("markings", toggle(q, "markings")),
  });
}

/** Every bake the library can ask for, keyed by element kind; a query key is a control's key. */
function bake(pkg: Package, q: URLSearchParams, cache: string) {
  const kind = q.get("kind") ?? "";
  const seed = num(q, "seed") ?? (kind === "city" ? 31082 : 1);
  const lods = [num(q, "lod") ?? 0];
  const out = path.join(cache, kind);
  switch (kind) {
    case "rock":
      return rockBake(pkg, q, { seed, lods, out });
    case "city":
      return cityBake(pkg, q, { seed, out });
    case "mechanism":
      return pkg.bakeMechanism({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
        ...opt("active", toggle(q, "active")),
      });
    case "workshop":
      return pkg.bakeWorkshop({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
        ...opt("width", num(q, "width")),
        ...opt("height", num(q, "height")),
        ...opt("open", toggle(q, "open")),
        ...opt("seats", num(q, "seats")),
        ...opt("shelves", num(q, "shelves")),
      });
    case "logistics":
      return pkg.bakeLogistics({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
        ...opt("shelves", num(q, "shelves")),
        ...opt("open", toggle(q, "open")),
      });
    case "sports":
      return pkg.bakeSports({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
        ...opt("span", num(q, "span")),
        ...opt("height", num(q, "height")),
      });
    case "rail":
      return pkg.bakeRail({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
      });
    case "frontier":
    case "pickup":
      return (kind === "frontier" ? pkg.bakeFrontier : pkg.bakePickup)({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("scale", num(q, "scale")),
        ...(kind === "pickup" ? opt("pose", q.get("pose") ?? undefined) : {}),
      });
    case "station":
      return pkg.bakeStation({
        module: q.get("id") ?? "",
        seed,
        out,
        ...opt("accent", q.get("accent") ?? undefined),
        ...opt("roof", toggle(q, "roof")),
      });
    case "tree":
    case "cover":
    case "debris":
      return pkg.bakeVegetation({
        preset: q.get("id") ?? "",
        seed,
        lods,
        out,
        ...opt("textures", q.get("textures") === "generated" ? ("generated" as const) : undefined),
      });
    default:
      throw new Error(`asset-library: no bake for kind "${kind}"`);
  }
}

function send(res: ServerResponse, status: number, body: unknown): true {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(body));
  return true;
}

const KINDS = {
  tree: { lod: true },
  cover: { lod: true },
  debris: { lod: true },
  rock: { lod: true },
  city: {},
  workshop: { name: "Workshop Kit" },
  logistics: { name: "Logistics Kit" },
  sports: { name: "Sports Kit" },
  rail: { name: "Rail Kit" },
  mechanism: { name: "Mechanism Kit" },
  pickup: { name: "Pickups" },
  frontier: { name: "Frontier Kit" },
  station: { name: "Station Kit" },
  stylized: { runtime: true, name: "Stylized Biome Kit", pack: "Biome Kit" },
  dungeon: { runtime: true, pack: "Dungeon Kit" },
  village: { runtime: true, pack: "Village Kit" },
  toybox: { runtime: true, pack: "Toybox Kit" },
};

export interface IProceduralEnvironmentSourceOptions {
  /** The project root: bakes cache under `node_modules/.cache/`, saves land under `assets/`. */
  readonly root: string;
  /** Offer "Save to assets/" (copies a bake into `<root>/assets/procedural/<kind>/`). Default false. */
  readonly save?: boolean;
  /** Where bakes are written. Default `<root>/node_modules/.cache/tn-asset-library/procedural`. */
  readonly cache?: string;
  /** Loads the bake functions; the engine's own library re-imports a rebuilt `dist` through it. */
  readonly load?: () => Promise<Package>;
  /** The browser client module; default this package's prebuilt `asset-library-client.js`. */
  readonly client?: string;
}

/** The shape `createAssetLibraryPlugin({ sources })` takes; structural, so no create-threenative import. */
export interface IProceduralSource {
  readonly id: "procedural";
  readonly client: string;
  catalog(): Promise<unknown>;
  handle(route: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<boolean>;
  /** Drops every cached bake (the engine library calls it when `dist` is rebuilt). */
  reset(): Promise<void>;
}

/**
 * This package's bake catalog as a source of the shared Asset Library (`/__assets/` in a kit).
 *
 * @situation browse and bake procedural trees, rocks, cliffs and city modules in the asset library of a game
 * @situation save a procedural bake into the game's assets folder from the asset library
 * @requires npm i -D @threenative/procedural-environment
 * @example createAssetLibraryPlugin({ sources: [proceduralEnvironmentSource({ root, save: true })] })
 */
export function proceduralEnvironmentSource(
  options: IProceduralEnvironmentSourceOptions,
): IProceduralSource {
  const root = path.resolve(options.root);
  const cache =
    options.cache ?? path.join(root, "node_modules", ".cache", "tn-asset-library", "procedural");
  const load = options.load ?? (() => import("./index.js"));
  let version = Date.now();
  const baked = new Map<string, Promise<unknown>>();
  const fileUrl = (base: string, file = "") =>
    `${base}file/${path.relative(cache, file).split(path.sep).join("/")}?v=${version}`;

  /** One bake per distinct query, shared by every request that asks for it while it runs. */
  function bakeOnce(q: URLSearchParams, base: string): Promise<unknown> {
    const key = q.toString();
    const known = baked.get(key);
    if (known) return known;
    const started = performance.now();
    let call = "";
    // The exact call the bake made, for the docs panel: the flat controls are nested here.
    const record = (pkg: Package): Package =>
      new Proxy(pkg, {
        get: (target, name: string) => {
          const value = target[name as keyof Package];
          if (typeof value !== "function" || !name.startsWith("bake")) return value;
          return (bakeOptions: { out: string }) => {
            call = `await ${name}(${JSON.stringify({ ...bakeOptions, out: `assets/${q.get("kind")}` })});`;
            return (value as (o: unknown) => unknown)(bakeOptions);
          };
        },
      });
    const job = load()
      .then((pkg) => bake(record(pkg), q, cache))
      .then(([entry]) => ({
        ...entry,
        call,
        ms: Math.round(performance.now() - started),
        url: fileUrl(base, entry?.path),
        ...(entry?.rock
          ? {
              rockMaps: {
                detail: fileUrl(base, entry.rock.detail),
                normal: fileUrl(base, entry.rock.normal),
              },
            }
          : {}),
        ...(options.save
          ? {
              save: `${base}save?file=${encodeURIComponent(path.relative(cache, entry?.path ?? ""))}`,
            }
          : {}),
      }));
    baked.set(key, job);
    job.catch(() => baked.delete(key));
    return job;
  }

  const inCache = (name: string) => {
    const target = path.resolve(cache, decodeURIComponent(name));
    return target.startsWith(cache + path.sep) ? target : undefined;
  };

  return {
    id: "procedural",
    client: options.client ?? fileURLToPath(new URL("./asset-library-client.js", import.meta.url)),
    async catalog() {
      const pkg = await load();
      const biomes = pkg.environmentBiomes();
      return {
        biomes,
        styles: { realistic: "Realistic", stylized: "Stylized", hybrid: "Stylized realism" },
        elements: [
          ...pkg.environmentElements().map((entry) => ({
            ...entry,
            styleTags: [
              [
                "station",
                "frontier",
                "pickup",
                "mechanism",
                "rail",
                "sports",
                "logistics",
                "workshop",
              ].includes(entry.kind)
                ? "stylized"
                : "realistic",
            ],
          })),
          ...stylizedAssets().map((entry) => ({
            ...entry,
            styleTags: [entry.kind === "toybox" ? "hybrid" : "stylized"],
          })),
        ],
        controls: controls(biomes.map((biome) => biome.id)),
        kinds: KINDS,
      };
    },
    async handle(route, url, req, res) {
      const base = url.pathname.slice(0, url.pathname.length - route.length);
      if (route === "bake") {
        send(res, 200, await bakeOnce(url.searchParams, base));
        return true;
      }
      if (route.startsWith("file/")) {
        const target = inCache(route.slice("file/".length));
        if (!target) return send(res, 403, { error: "outside cache" });
        res.setHeader(
          "content-type",
          target.endsWith(".webp") ? "image/webp" : "model/gltf-binary",
        );
        res.end(await readFile(target));
        return true;
      }
      if (route === "save" && req.method === "POST" && options.save) {
        // A bake is cached GLB plus maps; saving copies the GLB into the game's own source tree.
        const target = inCache(url.searchParams.get("file") ?? "");
        if (!target || !target.endsWith(".glb"))
          return send(res, 400, { error: "not a cached bake" });
        const kind = path.relative(cache, target).split(path.sep)[0] ?? "misc";
        const out = path.join(root, "assets", "procedural", kind, path.basename(target));
        await mkdir(path.dirname(out), { recursive: true });
        await copyFile(target, out);
        send(res, 200, { written: path.relative(root, out).split(path.sep).join("/") });
        return true;
      }
      return false;
    },
    async reset() {
      version++;
      baked.clear();
      await rm(cache, { force: true, recursive: true });
    },
  };
}
