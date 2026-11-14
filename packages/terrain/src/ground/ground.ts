import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ICookRequest } from "../cook/cook.js";
import { decodeHeightPNG, decodeRAW16 } from "../core/io.js";
import { hashString, random, round } from "../core/math.js";
import { terrainStats } from "../core/stats.js";
import { Terrain } from "../core/terrain.js";
import type { Layer } from "../core/types.js";
import { placeMassif } from "./massif.js";
import { LANDFORMS, type LandformKind } from "./presets.js";
import { surveyHeights } from "./survey.js";
import { MASSIFS, SURVEYS, locationSurvey } from "./surveys.js";
import type { IGroundDecision, IGroundRequest, ISurveyRow } from "./surveys.js";

/**
 * The ground stage: where a world's heights come from (a survey, a caller's heightmap or the
 * preset's own noise), and the far ring that continues that survey past the playable square.
 */
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
export async function readGroundHeightmap(
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
export function applyGroundLayer(
  layers: Layer[],
  grid: IGroundGrid,
  scale: number,
  offset: number,
): void {
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
export interface IGroundResult {
  readonly ground: IGroundDecision;
  readonly readme?: string;
  /** The survey the ground was cut from, and the metres it was mapped through: world = raw·scale + offset. */
  readonly survey?: { readonly row: ISurveyRow; readonly scale: number; readonly offset: number };
}

/**
 * A seed moves a landform's survey crop up to 0.6 of its extent across the same range, so seeds give
 * different real valleys of one range instead of one crop (PRD-866). No seed keeps the row's crop.
 */
export function seededCrop(row: ISurveyRow, seed: number | undefined): ISurveyRow {
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
export async function forestFloor(
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
    if (
      isForestFloor(grid.max - grid.min, stats.slopeP90, size, flatShare(grid.values, resolution))
    )
      break;
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

/**
 * The forest floor gate: metres of relief per 512 m of side, and the 90th-percentile slope in
 * degrees. Relief over a square grows with its side at the same slope (a 1024 m valley spans about
 * 130 m), so the relief bar scales with it and never drops under 90 m; the slope keeps it walkable.
 */
const FLOOR_RELIEF = 90;
const FLOOR_SLOPE = 28;

/**
 * The share of a survey's cells that are dead flat, which in 3DEP is a lake: the survey is
 * hydro-flattened, so a water body is stored as its surface. The cook writes no water for it, so
 * the forest would draw it as a bare level lawn (PRD-866: it moved seed 3 off such a spot).
 */
const FLOOR_FLAT = 0.02;

/** The share of interior cells whose four neighbours all sit within 2 cm of them. */
export function flatShare(values: ArrayLike<number>, resolution: number): number {
  let flat = 0;
  for (let r = 1; r < resolution - 1; r++)
    for (let c = 1; c < resolution - 1; c++) {
      const h = values[r * resolution + c] as number;
      const near = [
        values[r * resolution + c - 1],
        values[r * resolution + c + 1],
        values[(r - 1) * resolution + c],
        values[(r + 1) * resolution + c],
      ] as number[];
      if (near.every((n) => Math.abs(n - h) < 0.02)) flat++;
    }
  return flat / (resolution - 2) ** 2;
}

/** Whether a surveyed square of `size` metres is a forest floor, and holds no flattened lake. */
export function isForestFloor(relief: number, slopeP90: number, size: number, flat = 0): boolean {
  return (
    relief <= FLOOR_RELIEF * Math.max(1, size / 512) &&
    slopeP90 <= FLOOR_SLOPE &&
    flat <= FLOOR_FLAT
  );
}

/**
 * The ground the world starts from, and what it came from. A landform preset is grounded on the real
 * survey its kind names unless the request says otherwise, scaled to the preset's own relief so the
 * world keeps the slopes it was calibrated for; a survey a request located is scaled the same way. A
 * starter that no landform replaced keeps its authored crop, which is already a real survey.
 */
export async function applyGround(
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
export const RING_SCALE = 10;

/**
 * The bearings the far ring's massif is drawn from: the direction the kit's own spawn camera looks
 * (against its `cameraOffset`), 25 degrees either side. Drawn from the whole circle, a seed put its
 * mountain behind the camera and the forest "under mountains" showed low hills (PRD-866 three-seed
 * judge, 2026-11-10, seeds 1 and 3).
 */
export function massifBearing(
  cameraOffset: readonly [number, number, number],
): readonly [number, number] {
  const look = (Math.atan2(-cameraOffset[2], -cameraOffset[0]) * 180) / Math.PI;
  return [look - MASSIF_SPREAD, look + MASSIF_SPREAD];
}
const MASSIF_SPREAD = 25;
const MASSIF_ATTEMPTS = 6;
/** The share of a massif's lower half under 40 degrees that still reads as a wooded foot. */
const WOODED_FOOT = 0.6;

/**
 * The share of a massif's lower slopes, 50 m above its foot to half its height, under 40 degrees:
 * where a forest can climb the mountain it stands under.
 */
export function woodedFoot(
  detail: {
    readonly columns: number;
    readonly rows: number;
    readonly spacing: number;
    readonly heights: ArrayLike<number>;
  },
  height: number,
): number {
  const at = (r: number, c: number) => detail.heights[r * detail.columns + c] as number;
  let floor = Number.POSITIVE_INFINITY;
  for (let i = 0; i < detail.heights.length; i++)
    floor = Math.min(floor, detail.heights[i] as number);
  const steep = Math.tan((40 * Math.PI) / 180);
  let lower = 0;
  let gentle = 0;
  for (let r = 1; r < detail.rows - 1; r++)
    for (let c = 1; c < detail.columns - 1; c++) {
      const h = at(r, c);
      if (h < floor + 50 || h > floor + height / 2) continue;
      const dx = (at(r, c + 1) - at(r, c - 1)) / (2 * detail.spacing);
      const dz = (at(r + 1, c) - at(r - 1, c)) / (2 * detail.spacing);
      lower++;
      if (Math.hypot(dx, dz) < steep) gentle++;
    }
  return lower === 0 ? 0 : gentle / lower;
}

/** The far ring a cook writes beside the world (`ring.json`), and what the result reports of it. */
export interface IFarRing {
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
export async function farRing(
  request: ICookRequest,
  kind: LandformKind | undefined,
  ground: IGroundResult,
  config: { readonly size: number; readonly seed: number },
  cameraOffset: readonly [number, number, number],
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
  // A forest stands under the mountain, so its lower slopes must take trees: the first of a few
  // seeded placements whose foot is wooded wins, else the most wooded one. Facing the camera, Grand
  // Teton's steep side put 58% of its foot under 40 degrees (PRD-866, small forest, seed 4).
  let chosen: ReturnType<typeof placeMassif> | undefined;
  let best = -1;
  for (let attempt = 0; attempt < MASSIF_ATTEMPTS && best < WOODED_FOOT; attempt++) {
    const placed = placeMassif(host, {
      seed: (request.seed ?? config.seed) + attempt * 7919,
      tile: tiles,
      keepOut: config.size * 1.25,
      bearing: massifBearing(cameraOffset),
    });
    const foot = woodedFoot(placed.placement.detail, placed.placement.height);
    if (foot > best) {
      best = foot;
      chosen = placed;
    }
  }
  const { terrain, placement } = chosen as ReturnType<typeof placeMassif>;
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
