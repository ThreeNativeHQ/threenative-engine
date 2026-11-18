import type { IFrameBudgetWindow } from "@threenative/core";
import {
  beginViewVisit,
  medianOfGrowingSamples as median,
  retainViewWindow,
} from "./view-statistics.js";

/**
 * The state one world's measurements are reported through, with its own name in it. The game spreads
 * this into its own state and adds the look values it also reports; the counters live here.
 *
 * The window groups and the drawn-frame counts are module-level on purpose: `ctx.goto` builds a new
 * scene for the next world, and the numbers a run reports are the run's, not one scene's.
 *
 * @requires npm i -D @threenative/terrain @threenative/physics
 * @situation start a kit's game state with the measurements every streamed starter world reports
 * @constraint the world name is the one this state measures; a blank name fails rather than reporting ""
 * @example const state = { ...createDiagnosticsState("forest"), showcase: false };
 */
export function createDiagnosticsState(world: string) {
  if (world.trim() === "")
    throw new Error(
      "TN_STARTER_DIAGNOSTICS_DATA: a diagnostics state needs the world it measures.",
    );
  return {
    elevationMin: 0,
    elevationMax: 0,
    snowFrom: 0,
    snowTo: 0,
    worldReady: false,
    spawnReadiness: [] as Array<Record<string, string | number | boolean>>,
    loadingError: "",
    spawnCellsRequired: 0,
    spawnCellsLoaded: 0,
    streamingResidentCells: 0,
    streamingLoadedCells: 0,
    streamingEvictions: 0,
    streamingInstances: 0,
    streamingFailures: 0,
    streamingPendingPrewarm: 0,
    streamingLoadsInFlight: 0,
    streamingAdmissionMs: 0,
    streamingAdmissionBacklog: 0,
    timeToReadyMs: -1,
    enterMs: -1,
    tasksAvailable: false,
    longestLoadTaskMs: -1,
    afterFirstFrameTaskMs: -1,
    maxViewGpuMs: -1,
    measuredGpuViewCount: 0,
    viewGpu: [] as {
      view: string;
      gpuMs: number;
      gpuMain: number;
      gpuShadow: number;
      gpuOther: number;
      windows: number;
      passes: Record<string, { triangles: number; draws: number }>;
      scale: number;
      samples: number;
    }[],
    world,
    groundBiome: "baked",
    terrainTransportBound: false,
    erosionFlowSamples: 0,
    erosionDepositSamples: 0,
    frames: 0,
    travel: 0,
    /** The farthest the player stood from where it spawned, in a straight line on the ground plane. */
    straightTravel: 0,
    edgeOvershoot: Number.NEGATIVE_INFINITY,
    grounded: false,
    /** Rock and trunk bodies resident around the player (`ScatterColliders`). */
    propColliders: 0,
    /** Frames the player's capsule crossed into a rock or trunk; 0 while props are solid. */
    propOverlapFrames: 0,
    swimming: false,
    immersionDepth: 0,
    swimSamples: 0,
    swimFloatSamples: 0,
    swimExits: 0,
    /** Metres the river current carried the player along itself, while swimming. */
    swimDrift: 0,
    contactSamples: 0,
    maxContactError: 0,
    bilinearDifference: 0,
    oceanSteps: 0,
    waveSamples: 0,
    waveRange: 0,
    sampleSlopeRange: 0,
    lakePlacementError: 1,
    lakeSurfaceCount: 0,
    riverSurfaceCount: 0,
    lakeTriangles: 0,
    lakeFootprintError: 1,
    sunX: -180,
    propDraws: 0,
    propInstances: 0,
    propTriangles: 0,
    /** Drawn prop instances within 40 m of the eye in a fixed view (0 in the player view). */
    coverNearEye: 0,
    /** Drawn grass instances 100-200 m from the eye in a fixed view: the far slopes' cover. */
    coverFar: 0,
    /** Spruce planted past the square (`farForest.ts`), and those drawn inside the view's frustum. */
    farForest: 0,
    farForestInView: 0,
    preparedLodBaseSpread: 0,
    compressedTexturesPrepared: 0,
    preparedLevelsWithoutSolid: 0,
    view: "player",
    revealComplete: false,
    windowDrawCalls: 0,
    windowFrameMs: 0,
    currentViewWindows: 0,
    viewFrameP50s: [] as { view: string; p50: number; presentedP95: number; windows: number }[],
    maxViewFrameP50: 0,
    maxViewPresentedP95: 0,
    measuredViewCount: 0,
    riverFrameP50: 0,
    playerFrameP50: 0,
    meadowFrameP50: 0,
    meadowFrameP99: 0,
    meadowTriangles: 0,
    overviewFrameP50: 0,
    overviewFrameP99: 0,
    overviewTriangles: 0,
    alpineRenderedFrames: 0,
    desertRenderedFrames: 0,
    tundraRenderedFrames: 0,
    alpineFrameP50: 0,
    desertFrameP50: 0,
    tundraFrameP50: 0,
    alpineOverviewFrameP50: 0,
    desertOverviewFrameP50: 0,
    tundraOverviewFrameP50: 0,
  };
}
export type DiagnosticsState = ReturnType<typeof createDiagnosticsState>;

/** The last closed frame-budget window, published into state by the scene. */
export const budget = {
  drawCalls: 0,
  frameMs: 0,
  tasksAvailable: false,
  longestTaskMs: -1,
  afterFirstFrameTaskMs: -1,
};

export const launchedAt =
  typeof performance !== "undefined" && Number.isFinite(performance.timeOrigin)
    ? performance.timeOrigin
    : Date.now();

/**
 * Per-view frame cost, latched across the windows that closed while that camera was up.
 *
 * `budget` alone cannot answer "did the trees cost more at the meadow or at the overview": a playtest
 * cycles the cameras faster than a window closes, so the one number it holds belongs to whichever
 * view happened to be current. This keeps every window grouped by the view that was on screen, and
 * reports the median of each group's p50s and the worst p99 — the worst, because a LOD band that pops
 * once is a one-frame cost the median hides.
 */
export interface IViewWindow {
  readonly view: string;
  readonly p50s: number[];
  readonly p99s: number[];
  /** Presented-frame interval p95 per window: the whole frame the player sees, GPU included. */
  readonly presentedP95s: number[];
  readonly triangles: number[];
  readonly gpuMs: number[];
  readonly gpuMain: number[];
  readonly gpuShadow: number[];
  readonly gpuOther: number[];
  readonly passes: Record<string, { triangles: number; draws: number }>[];
  readonly surfaces: { scale: number; samples: number }[];
}

/** The view on screen and the GPU frame its first sample belongs to. */
const views = {
  current: "",
  visit: beginViewVisit(),
  measured: "",
  firstGpuFrame: Number.POSITIVE_INFINITY,
};
export const viewBudgets = new Map<string, IViewWindow>();

/**
 * A group to latch a closed window into: the same accumulator, one per world and view.
 *
 * @requires npm i -D @threenative/terrain
 * @situation keep one measured view's frame windows together across scenes
 * @example const group = viewGroup("forest:overview");
 */
export function viewGroup(view: string): IViewWindow {
  return {
    view,
    p50s: [],
    p99s: [],
    presentedP95s: [],
    triangles: [],
    gpuMs: [],
    gpuMain: [],
    gpuShadow: [],
    gpuOther: [],
    passes: [],
    surfaces: [],
  };
}

/**
 * Start a scene's view accounting: the player view it opens in, and nothing measured yet.
 *
 * @requires npm i -D @threenative/terrain
 * @situation start the run's view accounting when a scene enters
 * @example beginScene("forest");
 */
export function beginScene(world: string): void {
  views.current = `${world}:player`;
  views.visit = beginViewVisit();
  views.firstGpuFrame = Number.POSITIVE_INFINITY;
  views.measured = "";
  const group = viewGroup(views.current);
  viewBudgets.set(views.current, group);
}

/**
 * The camera cycle moved to another view: a keyed group for it, and a fresh measurement.
 *
 * @requires npm i -D @threenative/terrain
 * @situation switch the measured view when the benchmark camera cycle moves
 * @example const { windows } = enterView("forest", "overview");
 */
export function enterView(world: string, view: string): { current: string; windows: number } {
  views.current = `${world}:${view}`;
  views.visit = beginViewVisit();
  views.firstGpuFrame = Number.POSITIVE_INFINITY;
  views.measured = "";
  // Cumulative, not reset: a view is entered once per cycle but latched across every pass the run
  // makes through it, so a second visit measures the same framing with more samples behind it
  // rather than starting the count from nothing.
  if (!viewBudgets.has(views.current)) viewBudgets.set(views.current, viewGroup(views.current));
  return { current: views.current, windows: views.visit.windows };
}

/** What a scene says about itself for one report: everything the counters cannot know. */
export interface ISceneFacts {
  readonly world: string;
  readonly groundBiome: string;
  readonly elevation: readonly [number, number];
  readonly snowBand: readonly [number, number];
  readonly worldReady: boolean;
  readonly spawnReadiness: DiagnosticsState["spawnReadiness"];
  readonly spawnCells: { readonly required: number; readonly loaded: number };
  readonly streaming:
    | {
        readonly residentCells: number;
        readonly loadedCells: number;
        readonly evictions: number;
        readonly instances: number;
        readonly failures: number;
        readonly pendingPrewarm: number;
        readonly loadsInFlight: number;
        readonly admissionMs: number;
        readonly admissionBacklog: number;
      }
    | undefined;
  readonly terrainTransportBound: boolean;
  readonly erosion: { readonly flow: number; readonly deposition: number };
  readonly sunX: number;
  readonly frames: number;
  readonly travel: number;
  readonly straightTravel: number;
  readonly edgeOvershoot: number;
  readonly grounded: boolean;
  readonly propColliders: number;
  readonly propOverlapFrames: number;
  readonly swimming: boolean;
  readonly immersionDepth: number;
  readonly swimSamples: number;
  readonly swimFloatSamples: number;
  readonly swimExits: number;
  readonly swimDrift: number;
  readonly contactSamples: number;
  readonly maxContactError: number;
  readonly bilinearDifference: number;
  readonly oceanSteps: number;
  readonly waveSamples: number;
  readonly waveRange: number;
  readonly sampleSlopeRange: number;
  readonly propCounts: {
    readonly draws: number;
    readonly instances: number;
    readonly triangles: number;
  };
  readonly coverNearEye: number;
  readonly coverFar: number;
  readonly farForest: number;
  readonly farForestInView: number;
  readonly preparedLodBaseSpread: number;
  readonly compressedTexturesPrepared: number;
  readonly preparedLevelsWithoutSolid: number;
}

/**
 * The frame-budget window closed: latch it, and update the numbers the run reports.
 *
 * @requires npm i -D @threenative/terrain
 * @situation read the engine's own closed frame window into the run's report
 * @example frameBudget: { onWindow: observeWindow }
 */
export function observeWindow(window: IFrameBudgetWindow): void {
  budget.drawCalls = Object.values(window.passes ?? {}).reduce(
    (sum, pass) => sum + (pass.draws.mean * pass.frames) / window.frames,
    0,
  );
  budget.frameMs = window.frame.p50;
  budget.tasksAvailable = window.longTasks.available;
  if (window.longTasks.available) {
    budget.longestTaskMs = window.longTasks.longestMs;
    budget.afterFirstFrameTaskMs = window.longTasks.afterFirstFrameMs;
  }
  const group = viewBudgets.get(views.current);
  if (group && retainViewWindow(views.visit, window, views.firstGpuFrame)) {
    if (
      window.gpuMs !== undefined &&
      window.gpuFrames &&
      window.gpuFrames.first >= views.firstGpuFrame &&
      window.surface?.compiling !== true
    ) {
      group.gpuMs.push(window.gpuMs);
      if (window.gpuMain !== undefined) group.gpuMain.push(window.gpuMain);
      if (window.gpuShadow !== undefined) group.gpuShadow.push(window.gpuShadow);
      if (window.gpuOther !== undefined) group.gpuOther.push(window.gpuOther);
      group.passes.push(
        Object.fromEntries(
          Object.entries(window.passes ?? {}).map(([pass, counts]) => [
            pass,
            // A kind can run several times per frame (world + fullscreen AO are nested).
            // Summarising individual calls' p50 hides the world behind the one-triangle quads.
            {
              triangles: Math.round((counts.triangles.mean * counts.frames) / window.frames),
              draws: (counts.draws.mean * counts.frames) / window.frames,
            },
          ]),
        ),
      );
      if (window.surface)
        group.surfaces.push({
          scale: window.surface.resolutionScale,
          samples: window.surface.sampleCount,
        });
    }
    group.p50s.push(window.frame.p50);
    group.p99s.push(window.frame.p99);
    group.presentedP95s.push(window.presented.p95);
    group.triangles.push(
      // The world pass is nested beneath AO; its full-screen passes submit one triangle.
      Object.values(window.passes ?? {}).reduce((sum, pass) => sum + pass.triangles.max, 0),
    );
  }
}

/** The scene it is counting and the phase the run is in: what a frame counter asks the game. */
export interface ICounterCtx {
  readonly startup: { readonly phase: string };
  readonly renderer: {
    readonly gpuFrameSample?: () => { readonly frame: number } | undefined;
    readonly gpuFrameAge?: () => number | undefined;
  };
  readonly state: { getState: () => DiagnosticsState };
}

/**
 * One world frame was drawn: count it, and open a fresh GPU sample window if the view or the
 * readiness changed. Called from the render hook, before the camera is placed.
 *
 * @requires npm i -D @threenative/terrain
 * @situation count a drawn frame and open the next GPU sample window
 * @example ctx.beforeRender(() => observeFrame(ctx));
 */
export function observeFrame(ctx: ICounterCtx): void {
  views.visit.ready = ctx.state.getState().worldReady && ctx.startup.phase === "ready";
  if (!views.visit.ready) views.visit.discard = true;
  const ready = ctx.state.getState().worldReady && ctx.startup.phase === "ready";
  if (views.measured !== views.current || !ready) {
    views.measured = views.current;
    views.firstGpuFrame = Number.POSITIVE_INFINITY;
  }
  if (views.firstGpuFrame === Number.POSITIVE_INFINITY && ready) {
    const sample = ctx.renderer.gpuFrameSample?.();
    const age = ctx.renderer.gpuFrameAge?.();
    if (sample && age !== undefined) views.firstGpuFrame = sample.frame + age + 1;
  }
}

/** The windows that closed while a view was up, as the run report reads them. */
function viewReports(): {
  viewFrameP50s: DiagnosticsState["viewFrameP50s"];
  viewGpu: DiagnosticsState["viewGpu"];
} {
  const viewFrameP50s = [...viewBudgets.values()].map((group) => ({
    view: group.view,
    p50: median(group.p50s),
    presentedP95: median(group.presentedP95s),
    windows: group.p50s.length,
  }));
  const viewGpu = [...viewBudgets.values()]
    .filter((group) => group.gpuMs.length > 0)
    .map((group) => ({
      view: group.view,
      gpuMs: median(group.gpuMs),
      gpuMain: group.gpuMain.length ? median(group.gpuMain) : -1,
      gpuShadow: group.gpuShadow.length ? median(group.gpuShadow) : -1,
      gpuOther: group.gpuOther.length ? median(group.gpuOther) : -1,
      windows: group.gpuMs.length,
      passes: Object.fromEntries(
        Object.keys(group.passes[0] ?? {}).map((pass) => [
          pass,
          {
            triangles: median(group.passes.map((window) => window[pass]?.triangles ?? 0)),
            draws: median(group.passes.map((window) => window[pass]?.draws ?? 0)),
          },
        ]),
      ),
      scale: median(group.surfaces.map((surface) => surface.scale)),
      samples: median(group.surfaces.map((surface) => surface.samples)),
    }));
  return { viewFrameP50s, viewGpu };
}

/** A view's median p50, and its worst p99: a band that pops once is a cost the median hides. */
const p50Of = (view: string): number => median(viewBudgets.get(view)?.p50s ?? []);
const p99Of = (view: string): number => Math.max(0, ...(viewBudgets.get(view)?.p99s ?? []));
const trianglesOf = (view: string): number => median(viewBudgets.get(view)?.triangles ?? []);

/**
 * Publish the measurements and the scene's own facts into state, twice per second.
 *
 * @requires npm i -D @threenative/terrain
 * @situation write the measured view and frame numbers into the game's state
 * @example publish(ctx, { world, worldReady, frames, ...facts });
 */
export function publish(
  ctx: {
    readonly state: {
      set: (patch: Partial<DiagnosticsState>) => void;
      getState: () => DiagnosticsState;
    };
  },
  facts: ISceneFacts,
): void {
  const { viewFrameP50s, viewGpu } = viewReports();
  const [elevationMin, elevationMax] = facts.elevation;
  const [snowFrom, snowTo] = facts.snowBand;
  const streaming = facts.streaming;
  ctx.state.set({
    viewGpu,
    elevationMin,
    elevationMax,
    snowFrom,
    snowTo,
    maxViewGpuMs: viewGpu.length ? Math.max(...viewGpu.map((group) => group.gpuMs)) : -1,
    measuredGpuViewCount: viewGpu.length,
    tasksAvailable: budget.tasksAvailable,
    longestLoadTaskMs: budget.longestTaskMs,
    afterFirstFrameTaskMs: budget.afterFirstFrameTaskMs,
    currentViewWindows: views.visit.windows,
    viewFrameP50s,
    maxViewFrameP50: Math.max(0, ...viewFrameP50s.map((group) => group.p50)),
    maxViewPresentedP95: Math.max(0, ...viewFrameP50s.map((group) => group.presentedP95)),
    measuredViewCount: viewFrameP50s.filter((group) => group.windows > 0).length,
    world: facts.world,
    groundBiome: facts.groundBiome,
    worldReady: facts.worldReady,
    spawnReadiness: facts.spawnReadiness,
    spawnCellsRequired: facts.spawnCells.required,
    spawnCellsLoaded: facts.spawnCells.loaded,
    streamingResidentCells: streaming?.residentCells ?? 0,
    streamingLoadedCells: streaming?.loadedCells ?? 0,
    streamingEvictions: streaming?.evictions ?? 0,
    streamingInstances: streaming?.instances ?? 0,
    streamingFailures: streaming?.failures ?? 0,
    streamingPendingPrewarm: streaming?.pendingPrewarm ?? 0,
    streamingLoadsInFlight: streaming?.loadsInFlight ?? 0,
    streamingAdmissionMs: streaming?.admissionMs ?? 0,
    streamingAdmissionBacklog: streaming?.admissionBacklog ?? 0,
    terrainTransportBound: facts.terrainTransportBound,
    erosionFlowSamples: facts.erosion.flow,
    erosionDepositSamples: facts.erosion.deposition,
    sunX: facts.sunX,
    frames: facts.frames,
    travel: facts.travel,
    straightTravel: facts.straightTravel,
    edgeOvershoot: facts.edgeOvershoot,
    grounded: facts.grounded,
    propColliders: facts.propColliders,
    propOverlapFrames: facts.propOverlapFrames,
    swimming: facts.swimming,
    immersionDepth: facts.immersionDepth,
    swimSamples: facts.swimSamples,
    swimFloatSamples: facts.swimFloatSamples,
    swimExits: facts.swimExits,
    swimDrift: facts.swimDrift,
    contactSamples: facts.contactSamples,
    maxContactError: facts.maxContactError,
    bilinearDifference: facts.bilinearDifference,
    oceanSteps: facts.oceanSteps,
    waveSamples: facts.waveSamples,
    waveRange: facts.waveRange,
    sampleSlopeRange: facts.sampleSlopeRange,
    propDraws: facts.propCounts.draws,
    propInstances: facts.propCounts.instances,
    propTriangles: facts.propCounts.triangles,
    coverNearEye: facts.coverNearEye,
    coverFar: facts.coverFar,
    farForest: facts.farForest,
    farForestInView: facts.farForestInView,
    preparedLodBaseSpread: facts.preparedLodBaseSpread,
    compressedTexturesPrepared: facts.compressedTexturesPrepared,
    preparedLevelsWithoutSolid: facts.preparedLevelsWithoutSolid,
    windowDrawCalls: budget.drawCalls,
    windowFrameMs: budget.frameMs,
    // Every camera cost, published as plain state so the run report carries the numbers rather than
    // a console ring buffer that outlives neither run.
    // The starter kit's own benchmark view names, under the world being measured. A kit that renames
    // a view owns that row in its own state; the package never spells a world or a view out.
    riverFrameP50: p50Of(`${facts.world}:river`),
    playerFrameP50: p50Of(`${facts.world}:player`),
    meadowFrameP50: p50Of(`${facts.world}:meadow-close`),
    meadowFrameP99: p99Of(`${facts.world}:meadow-close`),
    meadowTriangles: trianglesOf(`${facts.world}:meadow-close`),
    overviewFrameP50: p50Of(`${facts.world}:overview`),
    overviewFrameP99: p99Of(`${facts.world}:overview`),
    overviewTriangles: trianglesOf(`${facts.world}:overview`),
  });
}

/**
 * The scene is gone: nothing is on screen, so no window can belong to a view.
 *
 * @requires npm i -D @threenative/terrain
 * @situation stop attributing windows to a view when its scene is left
 * @example leaveScene();
 */
export function leaveScene(): void {
  views.current = "";
  views.visit = beginViewVisit();
  views.firstGpuFrame = Number.POSITIVE_INFINITY;
  views.measured = "";
}

// The measure half lives one file over: the counters above and the probes below are separate
// concerns, and the kit source keeps importing both from here.
export {
  createMeasure,
  createRevealProbe,
  type IContactProbeOptions,
  type IContactWitness,
  type IMeasure,
  type IMeasureFacts,
  type IMeasureOptions,
  type IRevealProbe,
  type IRevealProbeOptions,
  witnessAsymmetricContact,
} from "./measure.js";
