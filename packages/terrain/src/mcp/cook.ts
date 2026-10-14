import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodeRAW16 } from "../core/io.js";
import { applyPlacementOverrides } from "../core/placements.js";
import { Terrain } from "../core/terrain.js";
import { bakeWorldPackage } from "../core/world-package.js";
import { starterAssetsDir } from "../kit-assets.js";
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

  const { splat, manifest, files } = bakeWorldPackage(state, {
    assets: cooked.manifest.assets as Parameters<typeof bakeWorldPackage>[1]["assets"],
  });
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

  const shown = relative(await realpath(request.projectRoot), request.out)
    .split(sep)
    .join("/");
  // The same source-relative key resolves through the dev and production asset manifests.
  const url = relative(request.assetSource as string, request.out)
    .split(sep)
    .join("/");
  const worldUrl = `${url}/world.json`;
  const ring =
    Math.ceil(Math.max(manifest.extent.sizeX, manifest.extent.sizeZ) / manifest.cellSize / 2) + 1;
  const instances = manifest.cells.reduce(
    (count, cell) => count + cell.runs.reduce((sum, run) => sum + run.count, 0),
    0,
  );
  const placementBytes = files[manifest.placements];
  if (placementBytes === undefined)
    throw new Error("cook: world package has no placement records.");
  const budgets = {
    residentCells: Math.max(1, manifest.cells.length),
    instances: Math.max(1, instances),
    bytes: Math.max(1, placementBytes.byteLength),
  };
  const heightmapUrl = `${url}/${cooked.manifest.terrain.heightmap}`;
  // The GLB carries no collider, so the snippet also builds the ground; aliases dodge stock names.
  const physical = JSON.stringify({
    extent: cooked.manifest.extent,
    terrain: cooked.manifest.terrain,
  });
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
      'import { WorldCells as TerrainWorldCells, Heightfield as TerrainHeightfield, heightSamplerFromHeightmap as sampleTerrainHeight, loadWorldHeightmap as loadTerrainHeightmap, loadTerrainSplat, type IWorldCellsLoadOptions as TerrainWorldOptions } from "@threenative/core/world";',
      'import { CollisionShape3D as TerrainCollisionShape, RigidBody3D as TerrainRigidBody } from "@threenative/physics";',
      'import { Object3D as TerrainAnchor } from "three";',
      `const terrainWorld = ${physical};`,
      `const [terrainHeightmapUrl] = await ctx.assets.resolve(${JSON.stringify(heightmapUrl)});`,
      'if (terrainHeightmapUrl === undefined) throw new Error("terrain: the world heightmap is not served.");',
      "const terrainHeights = await loadTerrainHeightmap(terrainHeightmapUrl);",
      "const terrainField = TerrainHeightfield.fromSampler({",
      "  columns: terrainWorld.terrain.columns,",
      "  depth: terrainWorld.extent.sizeZ,",
      "  origin: { x: terrainWorld.extent.minX + terrainWorld.extent.sizeX / 2, z: terrainWorld.extent.minZ + terrainWorld.extent.sizeZ / 2 },",
      "  rows: terrainWorld.terrain.rows,",
      "  sampleHeight: sampleTerrainHeight(terrainWorld.terrain, terrainWorld.extent, terrainHeights),",
      "  width: terrainWorld.extent.sizeX,",
      "});",
      "const terrainAnchor = new TerrainAnchor();",
      "terrainAnchor.position.set(terrainWorld.extent.minX + terrainWorld.extent.sizeX / 2, 0, terrainWorld.extent.minZ + terrainWorld.extent.sizeZ / 2);",
      "const terrainBody = new TerrainRigidBody({",
      '  entity: "terrain",',
      "  object: terrainAnchor,",
      "  physics: ctx.physics,",
      "  shape: TerrainCollisionShape.heightfield(terrainField.rows, terrainField.columns, terrainField.toColliderHeights(), { x: terrainWorld.extent.sizeX, y: 1, z: terrainWorld.extent.sizeZ }),",
      '  type: "fixed",',
      "});",
      "let world: TerrainWorldCells | undefined;",
      "let terrainSurface: Awaited<ReturnType<typeof loadTerrainSplat>> | undefined;",
      "// The anchor owns the streamed world, caller-supplied surface and full-world collider.",
      'terrainAnchor.addEventListener("removed", () => { world?.dispose(); terrainSurface?.dispose(); terrainBody.dispose(); });',
      "ctx.add(terrainAnchor);",
      "let terrainFollow = terrainAnchor;",
      'let terrainInvalidate: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"];',
      "try {",
      `  terrainSurface = await loadTerrainSplat({ assets: ctx.assets, renderer: ctx.renderer, url: ${JSON.stringify(worldUrl)} });`,
      "  world = await TerrainWorldCells.load({",
      `  assets: ctx.assets, url: ${JSON.stringify(worldUrl)}, surface: terrainSurface,`,
      "  follow: { get position() { return terrainFollow.position; } },",
      `  ring: ${ring}, budgets: ${JSON.stringify(budgets)}, terrain: { streamRadius: ${ring + 1} },`,
      "  shadows: { cast: true, receive: true, invalidate: (region) => terrainInvalidate?.(region) },",
      "});",
      "  ctx.add(world);",
      "} catch (error) { terrainAnchor.removeFromParent(); throw error; }",
      'const loadCells = (follow: TerrainAnchor, invalidate?: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"]) => { terrainFollow = follow; terrainInvalidate = invalidate; };',
      "// Call loadCells(player.mesh) after creating the player; optionally forward streamed shadow invalidation.",
    ].join("\n"),
  });
}
