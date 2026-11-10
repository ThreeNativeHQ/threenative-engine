import { existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type IBakeBiomeOptions, bakeBiome, foliageScatterRules } from "../core/bake-biome.js";
import { type IBiomeSpec, type IBiomeWaterBody, validateBiome } from "../core/biome.js";
import { createFlow, fillDepressions, routeFlow } from "../core/fluvial.js";
import { decodeHeightPNG, decodeRAW16 } from "../core/io.js";
import { placeMassif } from "../core/massif.js";
import { hashString, random } from "../core/math.js";
import { finalizeState } from "../core/operations.js";
import { applyPlacementOverrides } from "../core/placements.js";
import { LANDFORMS, landform } from "../core/presets.js";
import type { LandformKind } from "../core/presets.js";
import { terrainStats } from "../core/stats.js";
import { MASSIFS, SURVEYS, locationSurvey } from "../core/surveys.js";
import type { IGroundDecision, IGroundRequest, ISurveyRow } from "../core/surveys.js";
import { Terrain } from "../core/terrain.js";
import type {
  IScatterClear,
  ITerrainDocument,
  ITerrainState,
  Layer,
  SplinePoint,
} from "../core/types.js";
import { starterAssetsDir } from "../kit-assets.js";
import { measureGlb } from "./glb-stats.js";
import { surveyHeights } from "./survey.js";
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
  /** Cook one of the seven landform presets instead of the starter's authored heightmap crop. */
  landform?: LandformKind;
  /** A biome spec passed with the request, instead of the starter's own `biome.data.json`. */
  spec?: unknown;
  /** The biome's name, for the result; the starter's kit name when omitted. */
  biome?: string;
  /** Water bodies that replace the biome's declared ones, `IBiomeWaterBody` rows. */
  water?: readonly IBiomeWaterBody[];
  /** The ground the recipe starts from; omitted, a landform preset is grounded on its kind's survey. */
  ground?: IGroundRequest;
  /** `"none"` cooks no far ring; omitted, a mountain landform on a survey gets one. */
  backdrop?: "none";
  /** The range the far ring's massif comes from, when the request names it apart from the ground. */
  backdropRange?: LandformKind;
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
  /** The kit's own tree: the art that stands in for the species a biome's tree row names. */
  tree?: boolean;
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

interface IWaterLayer {
  type: string;
  id: string;
  params: Record<string, unknown>;
}

/**
 * Makes the recipe flood what the water rows say, so the ground and `water.json` follow the request.
 *
 * A row has no position and no path, so a river or lake row re-shapes the recipe's own layer of that
 * kind, in order: a river sets the ribbon width (and depth), a lake its radius. A layer with no row
 * is removed, and an ocean row adds a layer, since the ocean needs no seed. A river row with no layer
 * comes back to be routed down the finished ground (`routeRivers`); a lake row with no layer has no
 * basin to sit in, so it fails instead of echoing.
 */
function applyWaterRows(
  layers: IWaterLayer[],
  rows: readonly IBiomeWaterBody[],
): IBiomeWaterBody[] {
  const unrouted: IBiomeWaterBody[] = [];
  const queue = (kind: string): IWaterLayer[] =>
    layers.filter((layer) =>
      kind === "river"
        ? layer.type === "river"
        : layer.type === "water" && layer.params.kind !== "ocean",
    );
  const rivers = queue("river");
  const lakes = queue("lake");
  const keep = new Set<IWaterLayer>();
  for (const row of rows) {
    if (row.kind === "ocean") {
      layers.push({
        id: `ocean-${keep.size}`,
        type: "water",
        params: { kind: "ocean", level: row.level },
      });
      keep.add(layers[layers.length - 1] as IWaterLayer);
      continue;
    }
    const layer = (row.kind === "river" ? rivers : lakes).shift();
    if (layer === undefined && row.kind === "river") {
      unrouted.push(row);
      continue;
    }
    if (layer === undefined) {
      throw new Error(
        `cook: water row '${row.kind}' has no ${row.kind} layer in the recipe to take it.`,
      );
    }
    if (row.kind === "river") {
      // The row's width is the ribbon the world floods; the layer's own width stays the carved bed.
      layer.params.waterWidth =
        (row.width as number) / ((layer.params.width as number | undefined) ?? 12);
      if (row.depth !== undefined) layer.params.depth = row.depth;
    } else layer.params.radius = row.radius;
    keep.add(layer);
  }
  const dropped = layers.filter(
    (layer) => (layer.type === "river" || layer.type === "water") && !keep.has(layer),
  );
  for (const layer of dropped) layers.splice(layers.indexOf(layer), 1);
  return unrouted;
}

/**
 * Gives each river row a layer down the ground's own drainage: the main stem of the largest basin
 * that leaves the world, then the next largest at least an eighth of the world away. The stem runs
 * from where its catchment is a tenth of the outlet's to the edge, every 16 m. Bed, depth and
 * shoulder are the forest starter's river (7 m bed for a 5.32 m ribbon).
 */
function routeRivers(
  recipe: ITerrainDocument & { layers: Layer[] },
  rows: readonly IBiomeWaterBody[],
): void {
  const state = Terrain.fromJSON(recipe).evaluate();
  const { resolution: n, size } = state;
  const filled = Float64Array.from(state.height);
  fillDepressions(filled, n);
  const flow = createFlow(n);
  routeFlow(filled, n, flow);
  const roots: number[] = [];
  for (let i = 0; i < n * n; i += 1) if ((flow.receiver[i] as number) < 0) roots.push(i);
  roots.sort((a, b) => (flow.cells[b] as number) - (flow.cells[a] as number));
  const world = (i: number): [number, number] => [
    ((i % n) / (n - 1) - 0.5) * size,
    (Math.floor(i / n) / (n - 1) - 0.5) * size,
  ];
  const outlets: number[] = [];
  for (const root of roots) {
    if (outlets.length === rows.length) break;
    const [x, z] = world(root);
    const apart = outlets.every((o) => {
      const [ox, oz] = world(o);
      return Math.hypot(x - ox, z - oz) >= size / 8;
    });
    if (apart) outlets.push(root);
  }
  const step = Math.max(1, Math.round((16 / size) * (n - 1)));
  rows.forEach((row, index) => {
    const outlet = outlets[index];
    if (outlet === undefined)
      throw new Error(`cook: water row 'river' found no drainage basin to run down.`);
    // Up the stem: always the donor carrying the most water, until the catchment is a tenth.
    const stem = [outlet];
    const source = (flow.cells[outlet] as number) * 0.1;
    for (let cell = outlet; ; ) {
      let next = -1;
      const x = cell % n;
      const z = Math.floor(cell / n);
      for (let dz = -1; dz <= 1; dz += 1)
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          if (x + dx < 0 || x + dx >= n || z + dz < 0 || z + dz >= n) continue;
          const j = cell + dz * n + dx;
          if (flow.receiver[j] !== cell) continue;
          if (next < 0 || (flow.cells[j] as number) > (flow.cells[next] as number)) next = j;
        }
      if (next < 0 || (flow.cells[next] as number) < source) break;
      stem.push(next);
      cell = next;
    }
    if (stem.length < 2 * step)
      throw new Error(`cook: water row 'river' found no stem longer than 32 m to run down.`);
    // Source first, the edge last: downstream order, as the starters author theirs.
    const cells = stem.reverse().filter((_, k) => k % step === 0 || k === stem.length - 1);
    const points: SplinePoint[] = cells.map((cell) => {
      const [x, z] = world(cell);
      return [x, null, z];
    });
    const bed = (row.width as number) / 0.76;
    recipe.layers.push({
      enabled: true,
      opacity: 1,
      id: `river-${index}`,
      type: "river",
      params: {
        followTerrain: true,
        points,
        width: bed,
        waterWidth: 0.76,
        depth: row.depth ?? 1.8,
        shoulder: 10,
      },
    } as Layer);
  });
}

/**
 * The water bodies the cooked world floods, read from the evaluated state `water.json` also comes
 * from: a lake at its own level and radius, the ocean at its level, a river at its ribbon width.
 */
function floodedBodies(state: ITerrainState): IBiomeWaterBody[] {
  return [
    ...state.waters.map(
      (water): IBiomeWaterBody =>
        water.kind === "ocean"
          ? { kind: "ocean", level: water.level }
          : { kind: "lake", radius: water.radius ?? state.size, level: water.level },
    ),
    ...state.rivers.map((river): IBiomeWaterBody => ({ kind: "river", width: round(river.width) })),
  ];
}

/**
 * The evaluated state with the biome's own foliage placed on it.
 *
 * A landform preset authors the ground and no scatter rules, so the rows of the biome file drive the
 * stages every starter scatter runs. A row names the species the game draws, and the kit names the
 * art that stands in for its tree (`tree: true`, the CC0 `fir` for the preview's licensed `spruce`),
 * so a preset's ground grows the stand the file declares instead of a treeless world. Any other row
 * the pack ships no art for draws nothing: the pack is the one art set a cook has. A starter keeps
 * its authored rules, so its cook stays the world its own bake writes.
 */
/**
 * The radius, in metres, around the world's centre that a preset's trees keep out of. The starter
 * game's arena stands there (template `render/arena.ts` `ARENA`: ±13 m by ±11 m inside 1 m walls,
 * a half-diagonal of 18.4 m), and the cook seats the ground under its floor, so a tree inside it
 * grows through the floor or a wall; the radius adds a fir crown (3.6 m) and rounds up.
 * ponytail: fixed to the starter arena; read the game's own footprint once a cook can see it.
 */
export const PLAY_AREA_CLEAR_RADIUS = 23;
// The mask's soft edge is the outer 2% of its radius, where a tree still passes by chance: the
// mask is drawn that much wider, so the whole promised radius is clear (a denser forest row put a
// trunk at 22.79 m).
const PLAY_AREA_CLEAR: IScatterClear = {
  mask: { type: "circle", at: [0, 0], radius: PLAY_AREA_CLEAR_RADIUS / 0.98, falloff: 0.02 },
  opacity: 1,
};

function scatterFoliage(
  state: ITerrainState,
  biome: IBiomeSpec,
  kind: LandformKind | undefined,
  assetTable: Record<string, IAssetSpec>,
): ITerrainState {
  if (kind === undefined) return state;
  const tree = Object.keys(assetTable).find((id) => assetTable[id]?.tree === true);
  // The file carries one tree row, as the ordered scatter reads it, and it is the row a kit's own
  // tree stands in for; a shrub row keeps its own species or draws nothing.
  const foliage = biome.foliage.flatMap((row, at) => {
    if (row.density === 0) return [];
    if (row.species in assetTable) return [row];
    return at === 0 && tree !== undefined ? [{ ...row, species: tree }] : [];
  });
  if (foliage.length === 0) return state;
  return finalizeState({
    ...state,
    scatterRules: [
      ...state.scatterRules,
      ...foliageScatterRules(foliage, state.height).map((rule) => ({
        ...rule,
        clear: [...rule.clear, PLAY_AREA_CLEAR],
      })),
    ],
  });
}

/** One decoded ground grid in metres: a survey row, or the caller's own heightmap. */
interface IGroundGrid {
  readonly width: number;
  readonly height: number;
  readonly values: ArrayLike<number>;
}

/**
 * A caller's own ground. A 16-bit grayscale PNG written by `encodeHeightPNG` carries its elevation
 * range in the file; a `.r16` grid carries none, so its range must be named. Both fail closed and
 * name `ground.heightmap`: a wrongly scaled ground is a silently wrong world, not a small loss.
 */
async function readGroundHeightmap(
  projectRoot: string,
  asked: { readonly heightmap: string; readonly min?: number; readonly max?: number },
): Promise<IGroundGrid> {
  const file = isAbsolute(asked.heightmap)
    ? asked.heightmap
    : resolve(projectRoot, asked.heightmap);
  const bytes = await readFile(file).catch(() => {
    throw new Error(`terrain_generate: ground.heightmap '${asked.heightmap}' cannot be read.`);
  });
  const range =
    asked.min === undefined || asked.max === undefined
      ? undefined
      : { min: asked.min, max: asked.max };
  try {
    if (file.toLowerCase().endsWith(".r16")) {
      const side = Math.sqrt(bytes.length / 2);
      if (!Number.isInteger(side)) {
        throw new TypeError("a .r16 grid has no width of its own, so it must be square");
      }
      if (range === undefined) {
        throw new TypeError("a .r16 grid carries no elevation range; name min and max in metres");
      }
      return decodeRAW16(bytes, { width: side, height: side, ...range });
    }
    const decoded = await decodeHeightPNG(bytes, range ?? {});
    if (decoded.bitDepth !== 16) {
      throw new TypeError(`it is ${decoded.bitDepth}-bit; export a 16-bit grayscale PNG`);
    }
    if (!decoded.hasEmbeddedRange && range === undefined) {
      throw new TypeError("it carries no elevation range; name min and max in metres");
    }
    return decoded;
  } catch (error) {
    throw new TypeError(
      `terrain_generate: ground.heightmap '${asked.heightmap}': ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Puts one decoded grid where the recipe's ground layer is: the macro `noise` layer a preset authors,
 * or the authored crop a starter ships. A preset's shape stamps are dropped with it, because the real
 * ground already has the massif, cone or crater they would duplicate; the finishing passes (erosion,
 * terrace, talus, grain) still run on top, in the order the preset calibrated them.
 */
function applyGroundLayer(layers: Layer[], grid: IGroundGrid, scale: number, offset: number): void {
  const at = layers.findIndex((layer) => layer.type === "heightmap" || layer.type === "noise");
  const replaced = layers[at];
  if (replaced === undefined)
    throw new Error("cook: the recipe authors no ground layer to replace.");
  const preset = replaced.type === "noise";
  layers[at] = {
    id: "ground",
    type: "heightmap",
    enabled: replaced.enabled ?? true,
    opacity: replaced.opacity ?? 1,
    params: {
      // The recipe inlines its heights, so they are plain numbers on a 0.1 m lattice like the
      // starters' own crops: the same precision, and the same size of recipe.json.
      data: {
        width: grid.width,
        height: grid.height,
        values: Array.from(grid.values, (value) => Math.round(value * 10) / 10),
      },
      scale,
      offset,
    },
  };
  if (!preset) return;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index] as Layer;
    const shape = layer.type === "stamp" ? layer.params.shape : undefined;
    if (shape === "mountain" || shape === "crater") layers.splice(index, 1);
  }
}

/** What the cook put under the world, and the attribution a survey requires beside it. */
interface IGroundResult {
  readonly ground: IGroundDecision;
  readonly readme?: string;
  /** The survey the ground was cut from, and the metres it was mapped through: world = raw·scale + offset. */
  readonly survey?: { readonly row: ISurveyRow; readonly scale: number; readonly offset: number };
}

/**
 * A seed moves a landform's survey crop up to 0.6 of its extent across the same range, so seeds give
 * different real valleys of one range instead of one crop (PRD-866). No seed keeps the row's crop.
 */
function seededCrop(row: ISurveyRow, seed: number | undefined): ISurveyRow {
  if (seed === undefined) return row;
  const next = random(hashString(`survey:${seed}`));
  const east = (next() * 2 - 1) * 0.6 * row.extentMeters;
  const north = (next() * 2 - 1) * 0.6 * row.extentMeters;
  return {
    ...row,
    lat: row.lat + north / 111_320,
    lon: row.lon + east / (111_320 * Math.cos((row.lat * Math.PI) / 180)),
  };
}

/**
 * The ground of a world under mountains (PRD-866): a true-scale patch of the kit's survey, the world's
 * own size at its own metres, so the far ring around it and the massif past it keep real proportions.
 * Squeezing the row's 6 km into the square shrank a valley into a model range. The seed picks the
 * spot inside the row's extent; a spot too steep or too tall for a forest floor takes the next one,
 * and the row's own centre (a surveyed forest) is the last.
 */
async function forestFloor(
  document: { config: { resolution: number; size: number }; layers: Layer[] },
  row: ISurveyRow,
  seed: number | undefined,
): Promise<IGroundResult> {
  const { resolution, size } = document.config;
  const next = random(hashString(`floor:${seed ?? 0}`));
  const spots = Array.from({ length: seed === undefined ? 0 : 12 }, () => {
    const east = (next() * 2 - 1) * 0.4 * row.extentMeters;
    const north = (next() * 2 - 1) * 0.4 * row.extentMeters;
    return [north, east] as const;
  });
  // Terrarium's finest zoom: about 3.7 m at 40 degrees, for a 2 m grid over 512 m.
  const patch = (north: number, east: number): ISurveyRow => ({
    ...row,
    lat: row.lat + north / 111_320,
    lon: row.lon + east / (111_320 * Math.cos((row.lat * Math.PI) / 180)),
    extentMeters: size,
    zoom: 15,
  });
  let picked: { survey: ISurveyRow; grid: Awaited<ReturnType<typeof surveyHeights>> } | undefined;
  for (const [north, east] of [...spots, [0, 0] as const]) {
    const survey = patch(north, east);
    const grid = await surveyHeights(survey, resolution);
    const stats = terrainStats(grid.values, resolution, size);
    picked = { survey, grid };
    // A forest floor: the pinned valley spans 41 m and its steepest tenth 22 degrees.
    if (grid.max - grid.min <= FLOOR_RELIEF && stats.slopeP90 <= FLOOR_SLOPE) break;
  }
  const { survey, grid } = picked as NonNullable<typeof picked>;
  applyGroundLayer(document.layers, grid, 1, -grid.min);
  // Real ground is already eroded. The preset's fluvial pass, built to wear a scaled or noise ground,
  // lowered this border 10-40 m under the ring that continues it, so a true-scale floor takes the
  // surveyed worlds' surface pass instead: runoff and talus that move the geology under a metre and
  // still write the flow, sediment, deposition and talus channels.
  const at = document.layers.findIndex((layer) => layer.type === "erode");
  document.layers = document.layers.filter((layer) => layer.type !== "erode");
  document.layers.splice(at < 0 ? 1 : at, 0, ...structuredClone(SURVEYED_EROSION));
  return {
    survey: { row: survey, scale: 1, offset: -grid.min },
    ground: {
      source: "survey",
      name: survey.name,
      lat: survey.lat,
      lon: survey.lon,
      attribution: survey.attribution,
    },
    readme: groundReadme(survey),
  };
}

/** The attribution rides with the kit: the data source requires it wherever the world is shipped. */
const groundReadme = (survey: ISurveyRow): string =>
  [
    "# Cooked terrain world",
    "",
    `The ground is a real survey: ${survey.name} at ${survey.lat}, ${survey.lon},`,
    `${survey.extentMeters} m across at zoom ${survey.zoom}, resampled onto the recipe's grid.`,
    "",
    "## Data attribution",
    "",
    survey.attribution,
    "",
  ].join("\n");

/** The surveyed worlds' surface pass (the strata example's forest recipe), as recipe layers. */
const SURVEYED_EROSION: Layer[] = [
  {
    type: "erode",
    id: "surface-runoff",
    params: {
      method: "hydraulic",
      droplets: 20_000,
      maxSteps: 45,
      capacity: 2,
      erosion: 0.015,
      strength: 0.002,
      deposition: 0.2,
      evaporation: 0.035,
    },
  } as Layer,
  {
    type: "erode",
    id: "loose-talus",
    params: { method: "thermal", talus: 38, iterations: 1, rate: 0.004 },
  } as Layer,
];

/** The forest floor gate: metres of relief and the 90th-percentile slope, degrees. */
const FLOOR_RELIEF = 90;
const FLOOR_SLOPE = 28;

/**
 * The ground the world starts from, and what it came from. A landform preset is grounded on the real
 * survey its kind names unless the request says otherwise, scaled to the preset's own relief so the
 * world keeps the slopes it was calibrated for; a survey a request located is scaled the same way. A
 * starter that no landform replaced keeps its authored crop, which is already a real survey.
 */
async function applyGround(
  document: { config: { resolution: number; size: number }; layers: Layer[] },
  request: ICookRequest,
  kind: LandformKind | undefined,
): Promise<IGroundResult> {
  const asked = request.ground;
  if (asked === "procedural") return { ground: { source: "procedural" } };
  if (asked !== undefined && "heightmap" in asked) {
    // The caller's own metres, as the starters' authored crops are: no rescale of data we did not pick.
    applyGroundLayer(document.layers, await readGroundHeightmap(request.projectRoot, asked), 1, 0);
    return { ground: { source: "heightmap", heightmap: asked.heightmap } };
  }
  const survey =
    asked !== undefined
      ? locationSurvey(asked.location.lat, asked.location.lon)
      : kind === undefined
        ? undefined
        : seededCrop(SURVEYS[kind], request.seed);
  if (survey === undefined) return { ground: { source: "procedural" } };
  if (request.backdropRange !== undefined && asked === undefined)
    // The row itself, not the seeded crop above: the floor picks its own spot inside the row.
    return forestFloor(document, kind === undefined ? survey : SURVEYS[kind], request.seed);
  const grid = await surveyHeights(survey, document.config.resolution);
  const relief =
    kind === undefined ? undefined : LANDFORMS[kind].reliefRatio * document.config.size;
  // Without a preset the survey keeps its own metres; with one, its range fills that preset's relief.
  const scale = relief === undefined ? 1 : relief / (grid.max - grid.min || 1);
  applyGroundLayer(document.layers, grid, scale, -grid.min * scale);
  return {
    survey: { row: survey, scale, offset: -grid.min * scale },
    ground: {
      source: "survey",
      name: survey.name,
      lat: survey.lat,
      lon: survey.lon,
      attribution: survey.attribution,
    },
    // The attribution rides with the kit: the data source requires it wherever the world is shipped.
    readme: groundReadme(survey),
  };
}

/**
 * The far ring's side as a multiple of the world's: the ground's survey continued past its edge, as
 * far as a collar a game draws around its square (the Strata preview's is 5 km around 512 m).
 */
const RING_SCALE = 10;

/** The far ring a cook writes beside the world (`ring.json`), and what the result reports of it. */
interface IFarRing {
  readonly decision:
    | { readonly source: "none" }
    | {
        readonly source: "massif";
        readonly name: string;
        readonly lat: number;
        readonly lon: number;
        readonly attribution: string;
        readonly at: readonly [number, number];
        readonly rotation: number;
        readonly mirror: boolean;
        readonly height: number;
      };
  readonly file?: string;
}

/**
 * The ground's survey continued to ten times the world's side, with one real whole mountain from the
 * landform's own range placed past the playable square (`placeMassif`, PRD-866). The ring takes the
 * ground's own scale, so it meets the world's edge; the mountain keeps its true metres, because a
 * preset squeezes kilometres of survey into its square and Longs Peak at that scale is a 60 m hill.
 * Every tile is fetched before the bake; one that is neither cached nor fetchable fails the cook
 * naming it, as the ground does.
 */
async function farRing(
  request: ICookRequest,
  kind: LandformKind | undefined,
  ground: IGroundResult,
  config: { readonly size: number; readonly seed: number },
): Promise<IFarRing> {
  const range = request.backdropRange ?? kind;
  const rows = range === undefined ? undefined : MASSIFS[range];
  if (request.backdrop === "none" || rows === undefined || ground.survey === undefined)
    return { decision: { source: "none" } };
  const { row, scale, offset } = ground.survey;
  const resolution = 257;
  // One zoom finer than its row (about 15 m at z13): the massif's detail is a game's relief map.
  const MASSIF_RESOLUTION = 257;
  const fetchMassif = async (massif: ISurveyRow) => {
    const grid = await surveyHeights({ ...massif, zoom: massif.zoom + 1 }, MASSIF_RESOLUTION).catch(
      (error: unknown) => {
        throw new Error(
          `cook: far-ring massif '${massif.name}': ${error instanceof Error ? error.message : String(error)} Pass backdrop: "none" to cook without the far ring.`,
        );
      },
    );
    return {
      id: massif.name,
      size: massif.extentMeters,
      resolution: MASSIF_RESOLUTION,
      heights: grid.values,
    };
  };
  const [ringGrid, ...tiles] = await Promise.all([
    surveyHeights(
      { ...row, extentMeters: row.extentMeters * RING_SCALE, zoom: Math.max(1, row.zoom - 2) },
      resolution,
    ),
    ...rows.map(fetchMassif),
  ]);
  const size = config.size * RING_SCALE;
  const host = new Terrain({ size, resolution, seed: config.seed }).heightmap({
    id: "ring",
    data: {
      width: resolution,
      height: resolution,
      values: Array.from(ringGrid.values, (value) => value * scale + offset),
    },
  });
  const { terrain, placement } = placeMassif(host, {
    seed: request.seed ?? config.seed,
    tile: tiles,
    keepOut: config.size * 1.25,
  });
  const picked = rows[tiles.findIndex((tile) => tile.id === placement.tile)] as ISurveyRow;
  const decision = {
    source: "massif" as const,
    name: picked.name,
    lat: picked.lat,
    lon: picked.lon,
    attribution: picked.attribution,
    at: [round(placement.at[0]), round(placement.at[1])] as const,
    rotation: round(placement.rotation),
    mirror: placement.mirror,
    height: round(placement.height),
  };
  const heights = Array.from(terrain.evaluate().height, round);
  // The massif at its own tile spacing: a game's relief map reads it where the ring's cells are too
  // coarse for its ridges.
  const { detail } = placement;
  const massif = {
    ...decision,
    detail: { ...detail, heights: Array.from(detail.heights, (h) => Math.round(h * 10) / 10) },
  };
  return {
    decision,
    file: `${JSON.stringify({ size, resolution, heights, massif })}\n`,
  };
}

async function cookInto(
  request: ICookRequest,
  cooker: ICooker,
  kitDir: string,
  assetsDir: string,
): Promise<string> {
  const started = performance.now();
  // The starter's biome file is the world's own record of the biome; the bake validates it here, so
  // a starter that drifts from the schema fails at its cook instead of at a game's load. A request's
  // own spec replaces the file, and its `water` rows replace only what the biome declares it floods.
  const file = request.spec ?? JSON.parse(await readFile(join(kitDir, "biome.data.json"), "utf8"));
  const declared = (
    request.water === undefined
      ? file
      : { ...(file as Record<string, unknown>), water: request.water }
  ) as unknown;
  const biome = validateBiome(declared, request.biome ?? request.kit);
  // A spec names its own shape, size and seed, so its ground comes from the preset it carries. A
  // starter keeps its authored crop unless the request overrides the shape; the kit still supplies
  // the surface, the assets and the art.
  const kind = request.landform ?? (request.spec === undefined ? undefined : biome.landform);
  const recipe =
    kind === undefined
      ? JSON.parse(await readFile(join(kitDir, "recipe.json"), "utf8"))
      : {
          recipe: landform(kind, {
            resolution: 257,
            seed: request.seed ?? biome.seed,
            size: request.sizeMeters ?? biome.sizeMeters,
          }).toJSON(),
        };
  const unrouted =
    request.water === undefined ? [] : applyWaterRows(recipe.recipe.layers, request.water);
  // `fromJSON` reads `config`, so an override written beside it would be accepted and then ignored.
  if (request.sizeMeters !== undefined) recipe.recipe.config.size = request.sizeMeters;
  if (request.seed !== undefined) recipe.recipe.config.seed = request.seed;
  // Before any evaluation: the ground is what the preset's later layers reshape, and a survey that
  // cannot be read fails here rather than after a long bake.
  const ground = await applyGround(recipe.recipe, request, kind);
  const farRingResult = await farRing(request, kind, ground, recipe.recipe.config);
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

  // A landform preset authors the ground and no scatter rules, so the biome file's foliage is placed
  // on it through the stages every starter scatter runs.
  // A river the recipe has no layer for runs down the finished ground, survey or preset alike.
  if (unrouted.length > 0) routeRivers(recipe.recipe, unrouted);
  const evaluated = Terrain.fromJSON(recipe.recipe).evaluate();
  const state = applyPlacementOverrides(
    scatterFoliage(evaluated, biome, kind, assetTable),
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
    biome: biome.look,
    ground: ground.ground,
    backdrop: farRingResult.decision,
    water: floodedBodies(state),
    bands,
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
      "const terrainCentre = { x: terrainWorld.extent.minX + terrainWorld.extent.sizeX / 2, z: terrainWorld.extent.minZ + terrainWorld.extent.sizeZ / 2 };",
      "// Seats the cooked centre pad 5 cm under the game's floor (y = 0), so the floor draws over it. Add",
      "// terrainSeat to a terrainField.heightAt read. Named override: terrainSeat = 0 keeps the cooked heights.",
      "const terrainSeat = -terrainField.heightAt(terrainCentre.x, terrainCentre.z) - 0.05;",
      "const terrainAnchor = new TerrainAnchor();",
      "terrainAnchor.position.set(terrainCentre.x, terrainSeat, terrainCentre.z);",
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
      "  world.position.y = terrainSeat;",
      "  ctx.add(world);",
      "} catch (error) { terrainAnchor.removeFromParent(); throw error; }",
      'const loadCells = (follow: TerrainAnchor, invalidate?: NonNullable<TerrainWorldOptions["shadows"]>["invalidate"]) => { terrainFollow = follow; terrainInvalidate = invalidate; };',
      "// Call loadCells(player.mesh) after creating the player; optionally forward streamed shadow invalidation.",
    ].join("\n"),
  });
}
