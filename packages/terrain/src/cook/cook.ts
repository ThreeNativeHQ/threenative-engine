import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type IBakeBiomeOptions, bakeBiome } from "../biome/bake-biome.js";
import { type IBiomeSpec, type IBiomeWaterBody, validateBiome } from "../biome/biome.js";
import { decodeRAW16 } from "../core/io.js";
import { round } from "../core/math.js";
import { Terrain } from "../core/terrain.js";
import type { ITerrainState } from "../core/types.js";
import { assertDistFresh } from "../dist-fresh.js";
import { RING_SCALE, applyGround, farRing, forestFloor } from "../ground/ground.js";
import { landform } from "../ground/presets.js";
import type { LandformKind } from "../ground/presets.js";
import type { IGroundRequest } from "../ground/surveys.js";
import { starterAssetsDir } from "../kit-assets.js";
import { TERRAIN_KITS, newBiomeSpec, resolveAssetSource } from "../mcp/tools.js";
import { growArborRows, growArborSpecies, parseArborSpecies } from "../population/arbor-species.js";
import { type IAssetSpec, parseBounds, scatterFoliage } from "../population/foliage.js";
import { applyPlacementOverrides } from "../population/placements.js";
import type { IEcoregionRow } from "../request/ecoregions.js";
import type { TerrainFeature } from "../request/request-words.js";
import {
  applyWaterRows,
  carveFeatures,
  placeLakes,
  routeRivers,
  shapeCoast,
  unpinLakes,
} from "../water/stages.js";
import { worldReply } from "./reply.js";

/** One cook request, passed as the child's only argument. The parent validates every field first. */
export interface ICookRequest {
  kit: string;
  assetSource?: string;
  out: string;
  /** The game project root: `@threenative/assets` is resolved from here, never bundled. */
  projectRoot: string;
  sizeMeters?: number;
  seed?: number;
  /** Cook one of the seven landform presets instead of the starter's authored heightmap crop. */
  landform?: LandformKind;
  /** A biome spec passed with the request, instead of the starter's own `biome.data.json`. */
  spec?: unknown;
  /** The biome's name, for the result; the starter's kit name when omitted. */
  biome?: string;
  /** Water bodies that replace the biome's declared ones, `IBiomeWaterBody` rows. */
  water?: readonly IBiomeWaterBody[];
  /** Shapes carved into the ground: a canyon's cut, a fjord's sea inlet. */
  features?: readonly TerrainFeature[];
  /** The ground the recipe starts from; omitted, a landform preset is grounded on its kind's survey. */
  ground?: IGroundRequest;
  /** `"none"` cooks no far ring; omitted, a mountain landform on a survey gets one. */
  backdrop?: "none";
  /** The range the far ring's massif comes from, when the request names it apart from the ground. */
  backdropRange?: LandformKind;
  /** `arbor:<preset>[@seed]`: a request that names a tree, drawn by Arbor in place of the kit's tree. */
  treeSpecies?: string;
  /** The ecoregion a request word named: its site grounds the world and its canopy rows plant it. */
  region?: IEcoregionRow;
}

/** The package's own asset manifest, as a starter's `assets.json` writes it: layers and their maps. */
/** The slice of `@threenative/assets` this cook calls; the module is loaded from the game project. */
export interface ICooker {
  cookTerrainWorld(options: { preparedWorld: Record<string, unknown> }): Promise<{
    worldGlb: Uint8Array;
  }>;
  cookTerrainWorld(options: Record<string, unknown>): Promise<{
    worldGlb: Uint8Array;
    manifest: {
      assets: unknown;
      extent: { minX: number; minZ: number; sizeX: number; sizeZ: number };
      terrain: {
        columns: number;
        heightmap: string;
        heightMax: number;
        heightMin: number;
        rows: number;
        spacing: number;
      };
    };
    placementCounts: unknown;
  }>;
}

/** The starter's `surface.json`: the base material, its layers and each layer's maps. */
interface ISurface {
  base: { id: string };
  layers: { id: string }[];
  sources: Record<string, { diff: string; nrm: string }>;
  textures: string;
}

const MISSING_ASSETS =
  "terrain_generate needs @threenative/assets in the game project. Run: npm i -D @threenative/assets";

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

/** Cooks one starter kit into `request.out` and returns the one-line summary the parent relays. */
export async function cookKit(request: ICookRequest): Promise<string> {
  assertDistFresh();
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
  // Kit source ships in the package; binary assets resolve locally or from the pinned release.
  const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const kitDir = join(packageRoot, "starter", request.kit);
  const assetsDir = await starterAssetsDir();

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
  // The Arbor bake is a cook input: the cooked world streams its own copy, so the source GLBs go.
  const scratch = await mkdtemp(join(tmpdir(), "tn-arbor-"));
  // This cook owns `out` from here on, so a failure leaves nothing partial behind.
  try {
    return await cookInto({ ...request, assetSource }, cooker, kitDir, assetsDir, scratch);
  } catch (error) {
    await rm(request.out, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function cookInto(
  request: ICookRequest,
  cooker: ICooker,
  kitDir: string,
  assetsDir: string,
  scratch: string,
): Promise<string> {
  const started = performance.now();
  // The starter's biome file is the world's own record of the biome; the bake validates it here, so
  // a starter that drifts from the schema fails at its cook instead of at a game's load. A request's
  // own spec replaces the file, a region replaces the fields its row names (the same overrides
  // `terrain_biome_new` takes), and its `water` rows replace only what the biome declares it floods.
  const file = request.spec ?? JSON.parse(await readFile(join(kitDir, "biome.data.json"), "utf8"));
  const based =
    request.region === undefined
      ? file
      : newBiomeSpec(file, request.region.id, request.region.overrides as Record<string, unknown>);
  const declared = (
    request.water === undefined
      ? based
      : { ...(based as Record<string, unknown>), water: request.water }
  ) as unknown;
  const declaredBiome = validateBiome(declared, request.biome ?? request.region?.id ?? request.kit);
  if (request.treeSpecies !== undefined && parseArborSpecies(request.treeSpecies) === undefined)
    throw new Error(
      `cook: treeSpecies '${request.treeSpecies}' must read arbor:<preset> or arbor:<preset>@<seed>.`,
    );
  // A spec names its own shape, size and seed, so its ground comes from the preset it carries. A
  // starter keeps its authored crop unless the request overrides the shape; the kit still supplies
  // the surface, the assets and the art.
  const kind =
    request.landform ?? (request.spec === undefined ? undefined : declaredBiome.landform);
  const recipe =
    kind === undefined
      ? JSON.parse(await readFile(join(kitDir, "recipe.json"), "utf8"))
      : {
          recipe: landform(kind, {
            resolution: 257,
            seed: request.seed ?? declaredBiome.seed,
            size: request.sizeMeters ?? declaredBiome.sizeMeters,
          }).toJSON(),
        };
  const unrouted =
    request.water === undefined ? [] : applyWaterRows(recipe.recipe.layers, request.water);
  // `fromJSON` reads `config`, so an override written beside it would be accepted and then ignored.
  if (request.sizeMeters !== undefined) recipe.recipe.config.size = request.sizeMeters;
  if (request.seed !== undefined) recipe.recipe.config.seed = request.seed;
  // Before any evaluation: the ground is what the preset's later layers reshape, and a survey that
  // cannot be read fails here rather than after a long bake. A region's own place is a forest floor at
  // the world's own square, gated where it is cut; an explicit `ground` still wins over it.
  const ground =
    request.ground === undefined && request.region !== undefined
      ? await forestFloor(recipe.recipe, request.region.site, request.seed)
      : await applyGround(recipe.recipe, request, kind);
  const farRingResult = await farRing(
    request,
    kind,
    ground,
    recipe.recipe.config,
    declaredBiome.spawn.cameraOffset,
  );
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
  // A region's rows are that region's stand: the kit's authored canopy is replaced by them, and the
  // understorey, the stones, the road and the water stay the kit's own. The replaced tree art is
  // dropped before it is baked, so the world ships no tree nothing draws.
  const canopy = request.region?.canopy ?? [];
  for (const id of canopy) delete assetTable[id];
  if (canopy.length > 0) {
    recipe.recipe.layers = recipe.recipe.layers.filter(
      (layer: { params?: { asset?: unknown }; type?: string }) =>
        layer.type !== "scatter" || !canopy.includes(layer.params?.asset as string),
    );
  }
  // The kit's own `arbor` rows, `arbor:<preset>[@seed]` species and a request's tree word join the
  // table before any scatter.
  const kitArbor = await growArborRows(assetTable, request.projectRoot, scratch, assetsDir);
  const biome = await growArborSpecies({
    assetTable,
    biome: declaredBiome,
    projectRoot: request.projectRoot,
    scratch,
    ...(request.treeSpecies === undefined ? {} : { treeSpecies: request.treeSpecies }),
  });
  // Baked Arbor trees carry `_WIND`; the game sways them with the copy-out `starter/arbor/wind.ts`.
  const arborTrees = kitArbor || biome !== declaredBiome;

  // A landform preset authors the ground and no scatter rules, so the biome file's foliage is placed
  // on it through the stages every starter scatter runs.
  // A river the recipe has no layer for runs down the finished ground, survey or preset alike.
  carveFeatures(recipe.recipe, request.features ?? []);
  shapeCoast(recipe.recipe);
  // A starter's lake is pinned to its own crop's heights. On a survey or heightmap that replaced the
  // crop it would stand under the ground, so it moves to the new ground's own basin, or is left out
  // where that ground holds none (Hainich is a karst plateau: no lake, as on the real place).
  const replaced = ground.ground.source === "survey" || ground.ground.source === "heightmap";
  if (kind === undefined && replaced) placeLakes(recipe.recipe, unpinLakes(recipe.recipe), false);
  const lakes = unrouted.filter((row) => row.kind === "lake");
  if (lakes.length > 0) placeLakes(recipe.recipe, lakes);
  const rivers = unrouted.filter((row) => row.kind === "river");
  if (rivers.length > 0) routeRivers(recipe.recipe, rivers);
  const evaluated = Terrain.fromJSON(recipe.recipe).evaluate();
  const state = applyPlacementOverrides(
    // A region always places its own rows: they are the stand, whether or not the kit shipped one.
    scatterFoliage(evaluated, biome, kind, assetTable, request.region !== undefined),
    recipe.placementOverrides ?? {},
  );

  // A row's `far.impostor` ends its species' far-level ladder: a level past the impostor never draws.
  const impostors = new Map(
    biome.foliage.flatMap((row) =>
      row.far?.impostor === undefined ? [] : [[row.species, row.far.impostor] as const],
    ),
  );
  const species = Object.fromEntries(
    Object.entries(assetTable).map(([id, spec]) => [
      id,
      {
        glb: resolve(assetsDir, spec.near),
        bounds: parseBounds(spec.bounds, id),
        lods: spec.mid
          ? [{ distance: spec.midDistance ?? 40, glb: resolve(assetsDir, spec.mid) }]
          : [],
        maxDistance: spec.maxDistance,
        ...(impostors.has(id) ? { impostorDistance: impostors.get(id) } : {}),
      },
    ]),
  );

  const cooked = await cooker.cookTerrainWorld({
    state,
    species,
    materials: {
      texturesDir: assetsDir,
      layers: [surface.base, ...surface.layers].map((layer) => {
        const source = surface.sources[layer.id];
        if (source === undefined) throw new Error(`cook: no source for layer '${layer.id}'.`);
        return { id: layer.id, ...source, diffMimeType: "image/jpeg", nrmMimeType: "image/jpeg" };
      }),
    },
    out: request.out,
    extraLayers: { table: "terrain-table.json" },
  });

  const readme =
    farRingResult.decision.source === "massif"
      ? `${ground.readme ?? ""}\n## Far ring\n\nring.json continues the survey to ${RING_SCALE} times the world's size, with ${farRingResult.decision.name} (${farRingResult.decision.lat}, ${farRingResult.decision.lon}) standing past the playable square.\n\n${farRingResult.decision.attribution}\n`
      : ground.readme;
  if (readme !== undefined) await writeFile(join(request.out, "README.md"), readme);
  if (farRingResult.file !== undefined)
    await writeFile(join(request.out, "ring.json"), farRingResult.file);

  await writeFile(
    join(request.out, "water.json"),
    `${JSON.stringify(
      {
        lakes: state.waters.map((lake) => ({
          id: lake.id,
          // The reply names each body's kind, so the file records it: an ocean is not a lake.
          kind: lake.kind ?? "lake",
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

  // The starter's biome file is the world's own record of the biome; the bake validates it at the
  // top of this cook, so what it returns is the spec this world was baked from. The cook asks for the
  // rows' own seeds: it bakes a preset's ground with the kit's asset table, not the game's ordered
  // stream, which a game with its own container reads through `scatter` instead.
  const { bands, package: pkg } = bakeBiome({
    state,
    spec: biome,
    assets: cooked.manifest.assets as Required<IBakeBiomeOptions>["assets"],
    stream: "seeded",
  });
  if (pkg === null) throw new Error("cook: the bake wrote no world package.");
  const { splat, manifest, files } = pkg;
  await writeFile(
    join(request.out, "terrain-table.json"),
    `${JSON.stringify({ ...surface, splat, textures: "textures" }, null, 2)}\n`,
  );
  await copyFile(
    join(assetsDir, "hdri", "kloofendal_48d_partly_cloudy_1k.hdr"),
    join(request.out, "sky.hdr"),
  );

  // The editable recipe, with the heightmap inlined, is what `terrain_patch` takes back.
  await writeFile(join(request.out, "recipe.json"), JSON.stringify(recipe.recipe));

  return worldReply({
    request,
    cooked,
    baked: { manifest, splat, files },
    bands,
    state,
    biome,
    ground,
    farRing: farRingResult,
    seed: recipe.recipe.config.seed,
    arborTrees,
    started,
  });
}
