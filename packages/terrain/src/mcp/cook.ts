import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeRAW16 } from "../core/io.js";
import { applyPlacementOverrides } from "../core/placements.js";
import { Terrain } from "../core/terrain.js";
import { bakeWorldPackage } from "../core/world-package.js";
import { measureGlb } from "./glb-stats.js";
import { TERRAIN_KITS, resolveAssetSource } from "./tools.js";

/** One cook request, passed as the child's only argument. The parent validates every field first. */
export interface ICookRequest {
  kit: string;
  assetSource?: string;
  out: string;
  /** The game project root: `@threenative/assets` is resolved from here, never bundled. */
  projectRoot: string;
  sizeMeters?: number;
  seed?: number;
}

export interface IBounds {
  min: [number, number, number];
  max: [number, number, number];
}

interface IAssetSpec {
  near: string;
  mid?: string;
  midDistance?: number;
  maxDistance?: number;
  bounds: unknown;
}

interface ISurface {
  base: { id: string };
  layers: { id: string }[];
  sources: Record<string, { diff: string; nrm: string }>;
  textures: string;
}

/** The slice of `@threenative/assets` this cook calls; the module is loaded from the game project. */
interface ICooker {
  cookTerrainWorld(options: Record<string, unknown>): Promise<{
    worldGlb: Uint8Array;
    manifest: { assets: unknown };
    placementCounts: unknown;
  }>;
}

const MISSING_ASSETS =
  "terrain_generate needs @threenative/assets in the game project. Run: npm i -D @threenative/assets";

function isTriple(value: unknown): value is [number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
  );
}

/** Narrows a species `bounds` field; a missing or malformed box fails the cook instead of passing through. */
export function parseBounds(value: unknown, species: string): IBounds {
  const box = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const { min, max } = box;
  if (
    !isTriple(min) ||
    !isTriple(max) ||
    min.some((entry, axis) => entry > (max[axis] as number))
  ) {
    throw new Error(
      `cook: species '${species}' bounds must be { min: [x,y,z], max: [x,y,z] } with min <= max.`,
    );
  }
  return { min, max };
}

/** The package entry file under `projectRoot/node_modules`, found by walking upward like Node does. */
function installedEntry(projectRoot: string, name: string): string | undefined {
  let directory = resolve(projectRoot);
  while (true) {
    const manifestFile = join(directory, "node_modules", name, "package.json");
    if (existsSync(manifestFile)) {
      const manifest = JSON.parse(readFileSync(manifestFile, "utf8")) as {
        exports?: { "."?: { import?: string } | string };
        main?: string;
      };
      const root = manifest.exports?.["."];
      const relative = (typeof root === "string" ? root : root?.import) ?? manifest.main;
      return relative === undefined ? undefined : resolve(dirname(manifestFile), relative);
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/** Loads `@threenative/assets` from the game project; its absence is an actionable error, not a stack. */
export async function loadCooker(projectRoot: string): Promise<ICooker> {
  const entry = installedEntry(projectRoot, "@threenative/assets");
  if (entry === undefined || !existsSync(entry)) throw new Error(MISSING_ASSETS);
  const loaded = (await import(pathToFileURL(entry).href)) as Partial<ICooker>;
  if (typeof loaded.cookTerrainWorld !== "function") {
    throw new Error(`${MISSING_ASSETS} (the installed version has no cookTerrainWorld).`);
  }
  return loaded as ICooker;
}

const round = (value: number) => Math.round(value * 1_000) / 1_000;

/** Cooks one starter kit into `request.out` and returns the one-line summary the parent relays. */
export async function cookKit(request: ICookRequest): Promise<string> {
  if (!(TERRAIN_KITS as readonly string[]).includes(request.kit)) {
    throw new Error(`cook: unknown kit '${request.kit}'.`);
  }
  const assetSource = request.assetSource ?? (await resolveAssetSource(request.projectRoot));
  const logicalOut = relative(assetSource, request.out);
  if (logicalOut === "" || logicalOut === ".." || logicalOut.startsWith(`..${sep}`)) {
    throw new Error(
      "terrain_generate: out must be under assets.source so the build can list it in the manifest.",
    );
  }
  const cooker = await loadCooker(request.projectRoot);
  // The starter kits and their species models ship beside this file in the package.
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const kitDir = join(packageRoot, "starter", request.kit);
  const assetsDir = join(packageRoot, "starter-assets");

  // Fail closed before any evaluation: a non-recursive mkdir claims `out` atomically, so two cooks cannot share it.
  await mkdir(dirname(request.out), { recursive: true });
  try {
    await mkdir(request.out);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`cook: out '${request.out}' already exists.`);
    }
    throw error;
  }
  // This cook owns `out` from here on, so a failure leaves nothing partial behind.
  try {
    return await cookInto({ ...request, assetSource }, cooker, kitDir, assetsDir);
  } catch (error) {
    await rm(request.out, { recursive: true, force: true });
    throw error;
  }
}

async function cookInto(
  request: ICookRequest,
  cooker: ICooker,
  kitDir: string,
  assetsDir: string,
): Promise<string> {
  const started = performance.now();
  const recipe = JSON.parse(await readFile(join(kitDir, "recipe.json"), "utf8"));
  if (request.sizeMeters !== undefined) recipe.recipe.size = request.sizeMeters;
  if (request.seed !== undefined) recipe.recipe.seed = request.seed;
  // shortcut: starter heights use a 0.1 m lattice; revise decoding if their precision changes.
  for (const layer of recipe.recipe.layers) {
    const data = layer.params?.data;
    if (data?.raw16 === undefined) continue;
    const raw = await readFile(join(kitDir, data.raw16));
    data.values = Array.from(
      decodeRAW16(raw, data).values,
      (value: number) => Math.round(value * 10) / 10,
    );
  }
  const assetTable = JSON.parse(await readFile(join(kitDir, "assets.json"), "utf8")) as Record<
    string,
    IAssetSpec
  >;
  const surface = JSON.parse(await readFile(join(kitDir, "surface.json"), "utf8")) as ISurface;

  const state = applyPlacementOverrides(
    Terrain.fromJSON(recipe.recipe).evaluate(),
    recipe.placementOverrides ?? {},
  );

  const species = Object.fromEntries(
    Object.entries(assetTable).map(([id, spec]) => [
      id,
      {
        glb: join(assetsDir, spec.near),
        bounds: parseBounds(spec.bounds, id),
        lods: spec.mid
          ? [{ distance: spec.midDistance ?? 40, glb: join(assetsDir, spec.mid) }]
          : [],
        maxDistance: spec.maxDistance,
      },
    ]),
  );

  const baseSource = surface.sources[surface.base.id];
  if (baseSource === undefined) {
    throw new Error(`cook: no source for base layer '${surface.base.id}'.`);
  }
  const cooked = await cooker.cookTerrainWorld({
    state,
    species,
    // The cook embeds the ground's base albedo and normal in `world.glb`; only the base layer is handed over.
    materials: {
      layers: [
        {
          id: surface.base.id,
          diff: join(assetsDir, baseSource.diff),
          nrm: join(assetsDir, baseSource.nrm),
          diffMimeType: "image/jpeg",
          nrmMimeType: "image/jpeg",
        },
      ],
    },
    out: request.out,
    extraLayers: { table: "terrain-table.json" },
  });

  await writeFile(
    join(request.out, "water.json"),
    `${JSON.stringify(
      {
        lakes: state.waters.map((lake) => ({
          id: lake.id,
          at: lake.at,
          radius: lake.radius,
          level: lake.level,
        })),
        rivers: state.rivers.map((river) => ({
          id: river.id,
          width: round(river.width),
          points: river.points.map((point) => point.map(round)),
        })),
      },
      null,
      2,
    )}\n`,
  );

  const { splat } = bakeWorldPackage(state, {
    assets: cooked.manifest.assets as Parameters<typeof bakeWorldPackage>[1]["assets"],
  });
  await writeFile(
    join(request.out, "terrain-table.json"),
    `${JSON.stringify({ ...surface, splat, textures: "textures" }, null, 2)}\n`,
  );
  await mkdir(join(request.out, surface.textures), { recursive: true });
  for (const layer of [surface.base, ...surface.layers]) {
    const source = surface.sources[layer.id];
    if (source === undefined) throw new Error(`cook: no source for layer '${layer.id}'.`);
    await copyFile(
      join(assetsDir, source.diff),
      join(request.out, surface.textures, `${layer.id}_diff.jpg`),
    );
    await copyFile(
      join(assetsDir, source.nrm),
      join(request.out, surface.textures, `${layer.id}_nrm.jpg`),
    );
  }
  await copyFile(
    join(assetsDir, "hdri", "kloofendal_48d_partly_cloudy_1k.hdr"),
    join(request.out, "sky.hdr"),
  );

  // The editable recipe, with the heightmap inlined, is what `terrain_patch` takes back.
  await writeFile(join(request.out, "recipe.json"), JSON.stringify(recipe.recipe));

  const shown = relative(await realpath(request.projectRoot), request.out)
    .split(sep)
    .join("/");
  // The same source-relative key resolves through the dev and production asset manifests.
  const url = relative(request.assetSource as string, request.out)
    .split(sep)
    .join("/");
  return JSON.stringify({
    recipe: request.kit,
    out: shown,
    worldGlb: `${shown}/world.glb`,
    recipeJson: `${shown}/recipe.json`,
    worldPackage: `${shown}/world.json`,
    ...measureGlb(cooked.worldGlb),
    placementCounts: cooked.placementCounts,
    worldGlbBytes: cooked.worldGlb.length,
    ms: Math.round(performance.now() - started),
    load: [
      `const world = await ctx.assets.model("${url}/world.glb");`,
      "ctx.scene.add(world.scene);",
      `// recipe: ${shown}/recipe.json (pass it to terrain_patch to edit)`,
    ].join("\n"),
  });
}
