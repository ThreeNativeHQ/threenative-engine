import { readLaunchValue } from "./debug.js";
import { INSTANCED_LOD_MAX_PIXEL_ERROR } from "./instanced-batch-lod.js";
import type { IWorldCellsLoadOptions } from "./world-cell-data.js";
import type { IWorldCell, IWorldPackage } from "./world-package.js";

/**
 * `world-cells.ts`'s load options: the defaults a package does not name, the three places a launch
 * states a switch, and the validation that turns a malformed option into a throw before a frame.
 *
 * The defaults live here rather than beside the class so the numbers a game can override are one
 * file: a change to a default is a change to this module, and the class only reads what it exports.
 * The launch readers are the option layer's own — `world-gpu-scene.ts` keeps the subsystem switches
 * (`gpuScene`, `bundles`, `gpuSceneValidate`, `shadowGpuKeys`), and this file keeps the ones the
 * world owns as a whole (impostors, the adaptive bias and its share of the frame).
 */

export const DEFAULT_TILE_RESOLUTION = 129;

/**
 * One tile vertex per heightmap sample, rounded up so every default lod factor (1, 2, 4) divides it
 * and capped at the old fixed 129. A finer tile only interpolates the same samples: 129 over a 2 m
 * heightmap drew 3.01M terrain triangles, 25 ms on an Iris Xe (PRD-762).
 */
export function tileResolutionFor(tileSize: number, spacing: number): number {
  const cells = Math.ceil(tileSize / spacing / 4) * 4;
  return Math.min(DEFAULT_TILE_RESOLUTION, Math.max(9, cells + 1));
}

export const DEFAULT_ADMISSION_BUDGET_MS = 2;
/**
 * How much more one `update` may admit while the startup cover hides the world: 8x takes the 2 ms
 * default to one 60 Hz frame. Nobody sees frame pacing behind an opaque loading screen, and at 2 ms
 * a 10-17 fps test lane spent 16 s (web) and about 47 s (native) admitting a spawn backlog of about
 * 1,200 builds. The loader still presents every frame. Scaling keeps a game's own split between
 * several worlds; `coveredAdmissionBudgetMs` and `coveredFreshMeshesPerUpdate` name the covered
 * values outright.
 */
export const COVERED_BUDGET_SCALE = 8;
/**
 * How far the follow point has to move before a residency pass is worth repeating. Below it the
 * ring, the refilter brackets and every tile's LOD level are the same numbers, so the pass would
 * re-derive the set it already holds. Half a metre is under one 2 m heightmap cell and far under a
 * 128 m cell, so nothing that could change an answer is skipped.
 */
export const SETTLED_FOLLOW_METRES = 0.5;
/**
 * How far the follow point has to move before the `maxDistance`/`lods` refilter pass runs again.
 * That pass walks every resident cell's batches, derives both distance brackets and sorts what it
 * found, and on a 2 km walk at 0.3 m a frame it ran every second frame for the same brackets — a
 * third of the world's `update`. Two metres is the same order as the per-asset hysteresis the pass
 * already applies (`threshold / 8`, 3.75 m for a 30 m gate), so a level switch or a cull lands
 * within about two metres of the distance that asked for it, on a level the player is still walking
 * toward. Raise it when a game's gates are far apart, lower it when placements sit inside one.
 */
export const LEVEL_REFILTER_STEP_METRES = 2;
/**
 * The projection a baked chain's levels are switched at when the world names none: 60° of vertical
 * field of view over 1080 raster rows, which is the desktop view a switch distance is a function of.
 * See `autoLod`.
 */
const DEFAULT_AUTO_LOD_FOV_Y = 60;
const DEFAULT_AUTO_LOD_VIEWPORT_HEIGHT = 1080;
/**
 * The screen-space error budget a baked chain's levels are switched at, in pixels, when the world
 * names none. See `IWorldCellsLoadOptions.autoLod`.
 */
export const DEFAULT_AUTO_LOD_MAX_PIXEL_ERROR = INSTANCED_LOD_MAX_PIXEL_ERROR;
/** An asset shorter than this casts into the finest level only; see the layer above. */
export const SMALL_CASTER_METRES = 1.5;
/**
 * Placements filtered per unit of admission work.
 *
 * One unit is what a frame can overshoot its budget by, so it is sized to stay small rather than to
 * divide the work evenly: a slice is a few hundred placements' worth of matrix maths, tens of
 * microseconds, whatever the cell holds. ponytail: a count, not a time — the budget is the clock,
 * and this only decides how often it is read.
 */
export const ADMISSION_SLICE_PLACEMENTS = 256;

export interface IWorldCellsInit extends IWorldCellsLoadOptions {
  readonly reachRanges: Map<
    IWorldCell,
    Map<string, { min: number; max: number; minY: number; maxY: number }>
  >;
  readonly manifest: IWorldPackage;
  readonly placements: ArrayBuffer;
  readonly heightmap: Uint16Array;
  readonly baseUrl: string;
  /** `baseUrl` as the loader keys it: no leading slash, which is what a manifest lists. */
  readonly logicalBase: string;
  /**
   * Asset ids the package named twice for one model, each pointing at the id that is kept. Built
   * once in `load`, where the loader can be asked what each path really fetches; empty when nothing
   * is a duplicate. See {@link assetAliases}.
   */
  readonly aliases: ReadonlyMap<string, string>;
  /**
   * Whether `load` fabricated the loader it hands in as `assets` instead of the game supplying one.
   * `load` always passes a loader to the constructor, so `assets === undefined` cannot tell an owned
   * loader from a caller's; this is the bit that can. Left out, ownership is `assets === undefined`.
   */
  readonly ownsAssets?: boolean;
}

/**
 * Pixels one world unit covers at unit depth, from the vertical field of view and the raster height.
 * The scale `ModelLod` divides an error by; see `IWorldCellsLoadOptions.autoLod`.
 */
export function autoLodScale(autoLod: IWorldCellsLoadOptions["autoLod"]): number {
  const fovY = autoLod?.fovY ?? DEFAULT_AUTO_LOD_FOV_Y;
  const viewportHeight = autoLod?.viewportHeight ?? DEFAULT_AUTO_LOD_VIEWPORT_HEIGHT;
  if (!Number.isFinite(fovY) || fovY <= 0 || fovY >= 180)
    throw new Error("WorldCells autoLod.fovY must be a finite angle in (0, 180) degrees.");
  if (!Number.isFinite(viewportHeight) || !(viewportHeight > 0))
    throw new Error(
      "WorldCells autoLod.viewportHeight must be a positive number of raster pixels.",
    );
  return viewportHeight / (2 * Math.tan((fovY * Math.PI) / 360));
}

/** The screen-space error budget a synthesized level is switched at, in pixels. */
export function autoLodPixelError(autoLod: IWorldCellsLoadOptions["autoLod"]): number {
  const maxPixelError = autoLod?.maxPixelError ?? DEFAULT_AUTO_LOD_MAX_PIXEL_ERROR;
  if (!Number.isFinite(maxPixelError) || maxPixelError <= 0)
    throw new Error("WorldCells autoLod.maxPixelError must be a positive number of pixels.");
  return maxPixelError;
}

/** Default fraction of a 60 fps frame the main pass may take before the bias rises. */
export const DEFAULT_MAIN_GPU_SHARE = 0.5;

/**
 * One launch override, read once: the environment, then the query string, then the global a test
 * sets. The same three ways a debug flag is asked, but the answer is kept as text so a number can
 * be parsed by the caller rather than rounded here.
 */
function launchValue(parameter: string, flag: string, globalName: string): string | undefined {
  return readLaunchValue({ environment: flag, global: globalName, query: parameter });
}

/**
 * Whether a launch opts into the whole-asset impostors: off unless `?tnImpostors=1`, `TN_IMPOSTORS=1`
 * or `__tnImpostors = 1` says so. Opt-in because the judged Machinefall capture of the default
 * (PRD-473 AC-3, 2026-10-14) read REGRESSION — ground shadows and canopy density differ — and its
 * pinned frame windows showed no frame-time gain, so a game gets the source levels it had until the
 * proof passes. `impostors: true` still asks explicitly.
 */
export function impostorsRequested(): boolean {
  const raw = launchValue("tnImpostors", "TN_IMPOSTORS", "__tnImpostors");
  return raw === "1" || raw === "true";
}

/** Whether the adaptive LOD bias runs: on unless a launch pins it off. */
export function adaptiveLodRequested(): boolean {
  const raw = launchValue("tnAdaptiveLod", "TN_ADAPTIVE_LOD", "__tnAdaptiveLod");
  return raw === undefined ? true : raw !== "0" && raw !== "false";
}

/** The main-pass GPU share: the option, then the launch override, then 0.5. */
export function mainGpuShare(option: number | undefined): number {
  const raw = launchValue("tnMainGpuShare", "TN_MAIN_GPU_SHARE", "__tnMainGpuShare");
  const launched = raw === undefined ? undefined : Number(raw);
  const share = option ?? launched ?? DEFAULT_MAIN_GPU_SHARE;
  if (!Number.isFinite(share) || share <= 0 || share > 1)
    throw new Error("WorldCells mainGpuShare must be a number in (0, 1].");
  return share;
}

/**
 * Whether an asset whose cull ends inside the near ring keeps a far aggregate: `"ring"` unless the
 * caller names the `"always"` override. A misspelled value throws rather than silently picking one.
 */
export function impostorFarOption(value: "ring" | "always" | undefined): "ring" | "always" {
  if (value === undefined) return "ring";
  if (value === "ring" || value === "always") return value;
  throw new Error('WorldCells impostorFar must be "ring" or "always".');
}
