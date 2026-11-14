import { VirtualShadowNode } from "@threenative/core";
import type { IFrameBudgetWindow, IRaycastOptions } from "@threenative/core";
import type { CharacterBody3D, IPhysicsContext } from "@threenative/physics";
import { CollisionShape3D } from "@threenative/physics";
import type { Box3 } from "three";
import {
  Frustum,
  InstancedMesh,
  type Intersection,
  Matrix4,
  type Mesh,
  type Object3D,
  type PerspectiveCamera,
  Vector3,
} from "three";
import type { WorldName } from "./render/biomes.js";
import {
  beginViewVisit,
  medianOfGrowingSamples as median,
  retainViewWindow,
} from "./viewStatistics.js";

/**
 * What this example measures about its own frame, and the state it reports those measurements
 * through. `src/game.ts` wires the scene; the counters live here.
 *
 * The window groups and the drawn-frame counts are module-level on purpose: `ctx.goto` builds a new
 * scene for the next world, and the numbers a run reports are the run's, not one scene's.
 */
export const initialDiagnosticsState = {
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
  world: "forest",
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
export type DiagnosticsState = typeof initialDiagnosticsState;

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
/** Frames this run drew in each world; a world the run did not reach reports zero. */
const rendered = new Map<string, number>();

/** A group to latch a closed window into: the same accumulator, one per world and view. */
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

/** Start a scene's view accounting: the player view it opens in, and nothing measured yet. */
export function beginScene(world: string): void {
  views.current = `${world}:player`;
  views.visit = beginViewVisit();
  views.firstGpuFrame = Number.POSITIVE_INFINITY;
  views.measured = "";
  const group = viewGroup(views.current);
  viewBudgets.set(views.current, group);
}

/** The camera cycle moved to another view: a keyed group for it, and a fresh measurement. */
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
  readonly world: WorldName;
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

/** The frame-budget window closed: latch it, and update the numbers the run reports. */
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
 */
export function observeFrame(world: string, ctx: ICounterCtx): void {
  rendered.set(world, (rendered.get(world) ?? 0) + 1);
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

/** Publish the measurements and the scene's own facts into state, twice per second. */
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
    riverFrameP50: p50Of("forest:river"),
    playerFrameP50: p50Of("forest:player"),
    meadowFrameP50: p50Of("forest:meadow-close"),
    meadowFrameP99: p99Of("forest:meadow-close"),
    meadowTriangles: trianglesOf("forest:meadow-close"),
    overviewFrameP50: p50Of("forest:overview"),
    overviewFrameP99: p99Of("forest:overview"),
    overviewTriangles: trianglesOf("forest:overview"),
    alpineRenderedFrames: rendered.get("alpine") ?? 0,
    desertRenderedFrames: rendered.get("desert") ?? 0,
    tundraRenderedFrames: rendered.get("tundra") ?? 0,
    alpineFrameP50: p50Of("alpine:ridge"),
    desertFrameP50: p50Of("desert:mesa"),
    tundraFrameP50: p50Of("tundra:plain"),
    alpineOverviewFrameP50: p50Of("alpine:overview"),
    desertOverviewFrameP50: p50Of("desert:overview"),
    tundraOverviewFrameP50: p50Of("tundra:overview"),
  });
}

/** The scene is gone: nothing is on screen, so no window can belong to a view. */
export function leaveScene(): void {
  views.current = "";
  views.visit = beginViewVisit();
  views.firstGpuFrame = Number.POSITIVE_INFINITY;
  views.measured = "";
}

/**
 * What one scene measures about the player, the ground and the props, step by step.
 *
 * The scene builds the world and calls `step()` from its physics hook; the counters and the probes
 * live here. Each probe fails closed by the same rule the scene had: a contact the run cannot
 * observe throws rather than publishing a healthy-looking zero.
 */
export interface IMeasureOptions {
  readonly world: string;
  readonly physics: IPhysicsContext;
  readonly raycast: (options: IRaycastOptions) => Intersection | undefined;
  readonly actor: Mesh;
  readonly player: CharacterBody3D;
  /** The baked world's own size, in metres: the square the player can walk off. */
  readonly size: number;
  readonly mesh: Mesh | undefined;
  /** The drawn triangles of the staged world's ground, when the run draws a staged world. */
  readonly stage: IStagedWorld | undefined;
  /** The invisible asymmetric fixture the bilinear-difference probe walks. */
  readonly fixture: { heightAt: (x: number, z: number) => number };
  readonly probeMesh: Mesh;
  /** True while the figure plays a swim clip: the playtest reads swimming that way. */
  readonly swimmingClip: () => boolean;
  /** True once the scene holds prop colliders to probe. */
  readonly hasPropColliders: () => boolean;
  readonly eye: () => Vector3;
  readonly camera: () => PerspectiveCamera;
  readonly ocean: IOceanSample | undefined;
  readonly spawnReady: () => boolean;
  readonly terrainTargets: () => Object3D | readonly Object3D[] | undefined;
  readonly view: () => string;
}

interface IStagedWorld {
  readonly world: {
    stats: () => unknown;
    traverseVisible: (callback: (object: Object3D) => void) => void;
  };
  readonly ground: { readonly body: { readonly id: number | string } };
}

interface IOceanSample {
  readonly steps: number;
  readonly sampleHeight: (x: number, z: number) => { readonly height: number } | undefined;
}

/** The measurements a scene publishes each time `publish` runs. */
export interface IMeasureFacts {
  readonly travel: number;
  readonly straightTravel: number;
  readonly edgeOvershoot: number;
  readonly grounded: boolean;
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
  readonly farForestInView: number;
}

export interface IMeasure {
  /** One fixed physics step: travel, contact, the edge, the swim and the water's own samples. */
  readonly step: () => void;
  /** The drawn prop counts and the cover in front of the eye, every thirtieth step. */
  readonly countProps: (meshes: InstancedMesh[], farWorld: Object3D | undefined) => void;
  readonly facts: () => IMeasureFacts;
}

/**
 * The asymmetric fixture: eight seeded points where a bilinear height and the drawn triangle disagree,
 * walked by both paths — the picker's triangles and the solver's own ray. It throws when either path
 * answers nothing, because a run that cannot see the ground must not publish a healthy zero.
 */
export interface IContactProbeOptions {
  readonly mesh: { updateMatrixWorld: (force?: boolean) => unknown } | undefined;
  readonly probeMesh: { updateMatrixWorld: (force?: boolean) => unknown };
  readonly raycast: (options: IRaycastOptions) => Intersection | undefined;
  readonly physics: IPhysicsContext;
  readonly fixture: { heightAt: (x: number, z: number) => number };
}

export interface IContactWitness {
  readonly bilinearDifference: number;
  readonly contactSamples: number;
  readonly maxContactError: number;
}

export function witnessAsymmetricContact(options: IContactProbeOptions): IContactWitness {
  options.probeMesh.updateMatrixWorld(true);
  options.mesh?.updateMatrixWorld(true);
  let maxContactError = 0;
  let bilinearDifference = 0;
  let contactSamples = 0;
  const points = [
    [-7.75, -7.75],
    [-7.25, -7.25],
    [-7.75, -7.25],
    [-7.25, -7.75],
    [-8, -8],
    [-7, -8],
    [0, 0],
    [7.5, 7.5],
  ];
  for (const [x, z] of points) {
    const wx = 600 + (x as number);
    const visual = options.raycast({
      origin: new Vector3(wx, 200, z),
      direction: new Vector3(0, -1, 0),
      targets: options.probeMesh as Object3D,
    });
    const physical = options.physics.directSpaceState.intersectRay({
      from: { x: wx, y: 200, z: z as number },
      to: { x: wx, y: -100, z: z as number },
      collisionMask: 2,
    });
    if (!visual || !physical) throw new Error("Missing asymmetric terrain contact");
    maxContactError = Math.max(maxContactError, Math.abs(visual.point.y - physical.position.y));
    bilinearDifference = Math.max(
      bilinearDifference,
      Math.abs(visual.point.y - options.fixture.heightAt(x as number, z as number)),
    );
    contactSamples++;
  }
  return { bilinearDifference, contactSamples, maxContactError };
}

export function createMeasure(options: IMeasureOptions): IMeasure {
  const { actor, physics, player } = options;
  const previous = actor.position.clone();
  const origin = actor.position.clone();
  // The owner's report, measured the same with or without prop collision: frames in which the
  // player's capsule, less a 5 cm skin, crosses into a rock or trunk body.
  const propProbe = CollisionShape3D.capsule(0.5, 0.3);
  const farFrustum = new Frustum();
  const farMatrix = new Matrix4();
  const farPoint = new Vector3();
  let travel = 0;
  let straightTravel = 0;
  let propOverlapFrames = 0;
  // Metres past the playable square's edge the player reached: onto the surroundings' hills.
  let edgeOvershoot = Number.NEGATIVE_INFINITY;
  // Swimming as the playtest reads it: samples swimming with a swim clip on, those of them off
  // the bed, and how many times the player climbed back out.
  let swimSamples = 0;
  let swimFloatSamples = 0;
  let swimExits = 0;
  let swimDrift = 0;
  let wasSwimming = false;
  let contactSamples = 0;
  let maxContactError = 0;
  let bilinearDifference = 0;
  let waveSamples = 0;
  let minWave = Number.POSITIVE_INFINITY;
  let maxWave = Number.NEGATIVE_INFINITY;
  let minSlope = Number.POSITIVE_INFINITY;
  let maxSlope = Number.NEGATIVE_INFINITY;
  let propCounts = { draws: 0, instances: 0, triangles: 0 };
  let coverNearEye = 0;
  let coverFar = 0;
  let farForestInView = 0;
  let frames = 0;

  const step = (): void => {
    const dx = actor.position.x - previous.x;
    const dz = actor.position.z - previous.z;
    travel += Math.hypot(dx, dz);
    previous.copy(actor.position);
    straightTravel = Math.max(
      straightTravel,
      Math.hypot(actor.position.x - origin.x, actor.position.z - origin.z),
    );
    // What the water moved, not what the keys moved: the share of this step's travel along the
    // current, counted only while swimming with no input of the player's own. 0 with
    // `?current=off`, which is its before arm.
    if (player.swimming && player.velocity.x === 0 && player.velocity.z === 0) {
      const { x: cx, z: cz } = player.currentVelocity;
      const speed = Math.hypot(cx, cz);
      if (speed > 0) swimDrift += (dx * cx + dz * cz) / speed;
    }
    if (
      options.hasPropColliders() &&
      physics.directSpaceState.intersectShape({
        shape: propProbe,
        position: actor.position,
        collisionMask: 16,
        maxResults: 1,
      }).length > 0
    )
      propOverlapFrames++;
    // Query actual triangles, not bilinear interpolation, after the shared solver step.
    if (frames === 0) {
      const witness = witnessAsymmetricContact({
        mesh: options.mesh,
        probeMesh: options.probeMesh,
        raycast: options.raycast,
        physics,
        fixture: options.fixture,
      });
      contactSamples = witness.contactSamples;
      maxContactError = Math.max(maxContactError, witness.maxContactError);
      bilinearDifference = Math.max(bilinearDifference, witness.bilinearDifference);
    }
    // A staged world admits no terrain tile before its first update, which the loop's settle
    // steps precede, so its contact is observed once its spawn region is ready.
    // A staged world streams around the camera, so a benchmark view far from the player has no
    // ground under it; the player is held there (see the scene) and its contact is not asked for.
    // Past the square the player stands on the surroundings, whose collider is their drawn
    // triangles (see the walls the scene builds): physics alone answers there, and no picking tree
    // is built.
    const onSurroundings =
      options.stage === undefined &&
      Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) > options.size / 2 - 1;
    edgeOvershoot = Math.max(
      edgeOvershoot,
      Math.max(Math.abs(actor.position.x), Math.abs(actor.position.z)) - options.size / 2,
    );
    if (player.swimming && options.swimmingClip()) swimSamples++;
    if (player.swimming && !player.grounded) swimFloatSamples++;
    if (wasSwimming && !player.swimming) swimExits++;
    wasSwimming = player.swimming;
    if (options.stage === undefined || (options.spawnReady() && options.view() === "player")) {
      const terrainTargets = options.terrainTargets();
      const visual =
        !onSurroundings &&
        terrainTargets &&
        options.raycast({
          origin: new Vector3(actor.position.x, 300, actor.position.z),
          direction: new Vector3(1, -400, 1).normalize(),
          targets: terrainTargets,
        });
      // The same line as the visual ray, started a metre above the feet: from 300 m, a stage
      // tree the player stands against is the first body under it, not the ground.
      const start = options.stage || onSurroundings ? actor.position.y + 1 : 300;
      const lead = (300 - start) / 400;
      const physical = physics.directSpaceState.intersectRay({
        from: { x: actor.position.x + lead, y: start, z: actor.position.z + lead },
        to: { x: actor.position.x + 1, y: -100, z: actor.position.z + 1 },
        // The kit's ground keeps the default layer; here the ground alone, not a rock beside it.
        collisionMask: options.stage ? 1 : 8,
      });
      if (
        (!visual && !onSurroundings) ||
        !physical ||
        (options.stage && physical.body.id !== options.stage.ground.body.id)
      )
        throw new Error(
          `Missing playable terrain contact: world=${options.world}, frame=${frames}, player=${actor.position.toArray()}, visual=${!!visual}, physical=${!!physical}, body=${physical?.body.id}:${physical?.body.entity}, expectedGround=${options.stage?.ground.body.id}, terrain=${options.mesh?.position.toArray() ?? "stage"}`,
        );
      if (visual) {
        maxContactError = Math.max(maxContactError, Math.abs(visual.point.y - physical.position.y));
        contactSamples++;
      }
    }
    const wave = options.ocean?.sampleHeight(130, 140);
    const east = options.ocean?.sampleHeight(131, 140);
    if (wave && east) {
      waveSamples++;
      minWave = Math.min(minWave, wave.height);
      maxWave = Math.max(maxWave, wave.height);
      // Stale CPU sample slopes are a proxy; they do not qualify rendered normals.
      const slope = east.height - wave.height;
      minSlope = Math.min(minSlope, slope);
      maxSlope = Math.max(maxSlope, slope);
    }
    frames++;
  };

  const countProps = (meshes: InstancedMesh[], farWorld: Object3D | undefined): void => {
    propCounts = {
      draws: meshes.length,
      instances: meshes.reduce((sum, draw) => sum + draw.count, 0),
      triangles: meshes.reduce(
        (sum, draw) => sum + (draw.count * (draw.geometry.index?.count ?? 0)) / 3,
        0,
      ),
    };
    // What the vista's meadow puts in front of the eye; skipped in the player view.
    coverNearEye = 0;
    coverFar = 0;
    if (options.view() !== "player") {
      const eye = options.eye();
      for (const draw of meshes) {
        const grass = /^(grass|meadow):/.test(draw.name);
        const local = draw.instanceMatrix.array;
        const world = draw.matrixWorld.elements;
        for (let i = 0; i < draw.count; i++) {
          const x = local[i * 16 + 12] as number;
          const y = local[i * 16 + 13] as number;
          const z = local[i * 16 + 14] as number;
          const dx =
            (world[0] as number) * x +
            (world[4] as number) * y +
            (world[8] as number) * z +
            (world[12] as number) -
            eye.x;
          const dz =
            (world[2] as number) * x +
            (world[6] as number) * y +
            (world[10] as number) * z +
            (world[14] as number) -
            eye.z;
          const square = dx * dx + dz * dz;
          if (square < 1600) coverNearEye++;
          if (grass && square >= 10000 && square < 40000) coverFar++;
        }
      }
    }
    // The far forest's drawn instances whose root is inside the camera's frustum.
    farForestInView = 0;
    if (farWorld && options.view() !== "player") {
      const camera = options.camera();
      camera.updateMatrixWorld(true);
      farFrustum.setFromProjectionMatrix(
        farMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
        camera.coordinateSystem,
      );
      farWorld.traverse((node) => {
        if (!(node instanceof InstancedMesh) || !node.visible || !node.layers.isEnabled(0)) return;
        const local = node.instanceMatrix.array;
        for (let i = 0; i < node.count; i++) {
          farPoint
            .set(
              local[i * 16 + 12] as number,
              local[i * 16 + 13] as number,
              local[i * 16 + 14] as number,
            )
            .applyMatrix4(node.matrixWorld);
          if (farFrustum.containsPoint(farPoint)) farForestInView++;
        }
      });
    }
  };

  return {
    step,
    countProps,
    facts: () => ({
      travel,
      straightTravel,
      edgeOvershoot,
      grounded: player.grounded,
      propOverlapFrames,
      swimming: player.swimming,
      immersionDepth: player.immersionDepth,
      swimSamples,
      swimFloatSamples,
      swimExits,
      swimDrift,
      contactSamples,
      maxContactError,
      bilinearDifference,
      oceanSteps: options.ocean?.steps ?? 0,
      waveSamples,
      waveRange: waveSamples ? maxWave - minWave : 0,
      sampleSlopeRange: waveSamples ? maxSlope - minSlope : 0,
      propCounts,
      coverNearEye,
      coverFar,
      farForestInView,
    }),
  };
}

/**
 * What the reveal cost, measured from the frame it completes: batches published in view, shadows
 * invalidated, impostors still pending, and every pipeline the device created since.
 *
 * One source counts the pipelines, picked at the reveal: three's census on its backend, else the
 * owned engine's own compile count. The owned engine builds pipelines inside Wasm, where the census
 * sees none and stays incomplete.
 */
export interface IRevealProbeOptions {
  readonly camera: () => PerspectiveCamera;
  readonly pipelineCensus: () =>
    | { readonly complete: boolean; readonly counts: { readonly deviceCreations?: number } }
    | undefined;
  readonly engineCompiles: () => number | undefined;
  /** True while a loading overlay covers the world: the reveal has not happened yet. */
  readonly covered: () => boolean;
  readonly phase: () => string;
  readonly shadowNode: () => unknown;
  /** Impostors still pending across every streamed world. */
  readonly pendingImpostors: () => number;
  readonly released: () => boolean;
  readonly afterPhysics: (callback: () => void) => unknown;
  readonly revealed: () => void;
}

export interface IRevealProbe {
  /** The loading screen reported its reveal: take the baseline this probe measures against. */
  readonly initialize: () => void;
  /** A props batch was published; count it when the reveal frustum holds it. */
  readonly publishedBatch: (bounds: Box3) => void;
  /** The measured numbers as plain data: the run report's `props.reveal` readout. */
  readonly readout: () => Readonly<Record<string, number | string | boolean>>;
}

export function createRevealProbe(options: IRevealProbeOptions): IRevealProbe {
  const reveal = {
    startedMs: -1,
    elapsedMs: 0,
    complete: false,
    samples: 0,
    publishedBatchesInView: -1,
    shadowInvalidated: -1,
    impostorPendingPeak: -1,
    pipelinesCreated: -1,
    pipelineCensusAvailable: false,
    pipelineSource: "none",
    // Device pipeline creations from the reveal to now, for the whole session: a walk and a
    // camera turn must build none either (`playtests/loop.playtest.json`). -1: not measured.
    pipelinesSinceReveal: -1,
  };
  let shadowAtReveal = -1;
  let pipelinesAtReveal: number | undefined;
  let pipelineSource: "census" | "engine" | undefined;
  const frustum = new Frustum();
  const matrix = new Matrix4();
  const idle = (): boolean =>
    options.released() || reveal.complete || reveal.startedMs < 0 || options.covered();
  const shadows = (): { readonly stats: { readonly byInvalidation: number } } => {
    const node = options.shadowNode();
    if (!(node instanceof VirtualShadowNode))
      throw new Error("Reveal probe requires virtual shadows");
    return node;
  };
  const pipelineCount = (source: typeof pipelineSource): number | undefined => {
    if (source === "census") {
      const census = options.pipelineCensus();
      return census?.complete === true ? census.counts.deviceCreations : undefined;
    }
    return source === "engine" ? options.engineCompiles() : undefined;
  };
  const initialize = (): void => {
    if (options.released() || reveal.complete || reveal.startedMs >= 0) return;
    if (options.covered() || options.phase() !== "ready")
      throw new Error("Reveal probe requires ready props and an uncovered world");
    const node = shadows();
    pipelineSource = pipelineCount("census") !== undefined ? "census" : "engine";
    reveal.startedMs = performance.now();
    reveal.publishedBatchesInView = 0;
    shadowAtReveal = node.stats.byInvalidation;
    pipelinesAtReveal = pipelineCount(pipelineSource);
    if (pipelinesAtReveal !== undefined) reveal.pipelineSource = pipelineSource;
    const camera = options.camera();
    camera.updateMatrixWorld(true);
    frustum.setFromProjectionMatrix(
      matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem,
    );
  };
  options.afterPhysics(() => {
    if (idle() || options.phase() !== "ready") return;
    const node = shadows();
    const creations = pipelineCount(pipelineSource);
    reveal.samples++;
    reveal.elapsedMs = performance.now() - reveal.startedMs;
    reveal.shadowInvalidated = node.stats.byInvalidation - shadowAtReveal;
    reveal.impostorPendingPeak = Math.max(reveal.impostorPendingPeak, options.pendingImpostors());
    reveal.pipelineCensusAvailable = creations !== undefined && pipelinesAtReveal !== undefined;
    if (creations !== undefined && pipelinesAtReveal !== undefined)
      reveal.pipelinesCreated = creations - pipelinesAtReveal;
    reveal.complete = reveal.elapsedMs >= 3000;
    if (reveal.complete) options.revealed();
  });
  options.afterPhysics(() => {
    if (options.released() || pipelinesAtReveal === undefined) return;
    const creations = pipelineCount(pipelineSource);
    reveal.pipelinesSinceReveal = creations === undefined ? -1 : creations - pipelinesAtReveal;
  });
  return {
    initialize,
    readout: () => ({ ...reveal }),
    publishedBatch: (bounds) => {
      if (reveal.startedMs < 0 || reveal.complete) return;
      if (frustum.intersectsBox(bounds)) reveal.publishedBatchesInView++;
    },
  };
}
