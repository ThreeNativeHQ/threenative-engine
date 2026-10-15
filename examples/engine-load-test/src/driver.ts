// The measurement driver both web arms share. The TN arm and the `plain-three-webgpu` control must
// frame the same scene on the same clock, so the loop, the adapter read, the identity and the
// report shape live here once and an arm supplies only what is genuinely its own: its name, its
// build notes, its engine version, and the capabilities it owns (the render projection and the
// stage profiler). Nothing here imports the framework, because the control arm's whole claim is
// that it does not.
import type { installRendererStageHooks } from "../../../scripts/render-profile/renderer-stage-hooks.js";
import {
  type CollapseFactory,
  type ICharacterCrowd,
  type ILoadTestHarness,
  type ILoadTestRung,
  VIEWPORT_HEIGHT,
  VIEWPORT_WIDTH,
  createLoadTestHarness,
} from "./game.js";
import {
  type IModuleGraphEntry,
  extractModuleSpecifiers,
  hashServedModuleGraph,
  hashWorkloadModuleGraph,
  isBenchmarkWorkloadModule,
  sha256,
} from "./identity.js";
import {
  type IFoxMeasurement,
  type IFrameStats,
  type ILadderCounts,
  ladderRank,
} from "./ladder.js";
import { PHASES, createPhaseRecorder, topCrossings } from "./phases.js";
import {
  FRAMES_PER_RUNG,
  type IWorkloadAxes,
  LADDER,
  RENDER_MODES,
  REPEATS,
  type RenderMode,
  WARMUP_FRAMES,
  isProjectedRung,
  isRealisticRung,
  parseAxesRecord,
  percentile,
} from "./workload.js";

export interface IRungReport {
  /**
   * PRD-449 §7.4's primary metric: the wall time from immediately after one untimed pre-drain,
   * through `measuredFrames` rendered frames, to immediately after one final timed completion drain,
   * divided by that count.
   *
   * The window is wall time, not the sum of the CPU submit spans plus a tail drain. GPU work can land
   * during the browser's rAF waits, so adding up submit spans measures CPU occupancy and misses the
   * waits entirely; it is not how long N *completed* frames took. Those waits are therefore *inside*
   * this window, which makes the number **cadence-inclusive browser completed-work delivery** — how
   * fast the surface actually delivered N finished frames at its presentation cadence — and never an
   * uncapped capacity figure. `cpuSubmitMeanMs` is the uncapped CPU half; read the two together and
   * neither stands in for the other.
   *
   * `null` when the arm's renderer exposes no queue to observe completion on, which is a hole in the
   * measurement and never a zero and never the submit proxy.
   */
  completedWorkMeanMs: number | null;
  /** Non-null exactly when `completedWorkMeanMs` is null: why finished work was unobservable. */
  completedWorkReason: string | null;
  /** The CPU submit half of the same window. A proxy, reported apart from `completedWorkMeanMs`. */
  cpuSubmitMeanMs: number;
  drawCalls: number;
  /** Fill/drain policy and timing scope for `completedWorkMeanMs`, recorded on every rung. */
  drainPolicy: string;
  /**
   * The legacy series: successive render-producing rAF intervals, measured frames only. Unchanged by
   * the completed-work window, because the pre-drain sits on the boundary — the first measured
   * interval is read from the drained clock, so the drain enters neither series.
   */
  frameMs: number[];
  /** Frames the timed window covered, which is `frames` past the untimed warmup. */
  measuredFrames: number;
  /** PRD-464: how big R3's characters came out, so the two engines' foxes are compared as sizes. */
  foxMeasurement?: IFoxMeasurement;
  /** PRD-464: the rung's asserted scene cost, read off the built scene at the mid-measurement frame. */
  ladder?: ILadderCounts;
  /** PRD-464: what the rung's own read-back frame said about itself, sampled on the last warmup frame. */
  renderCheck?: IFrameStats;
  framePng?: string;
  /** Pipelines created inside the measured window; warmup compiles are not counted. */
  pipelineCompiles: number;
  stageReport?: unknown;
  stepMs?: number[];
  /**
   * With `phases=1`: the page's own frame work (step plus render submission) per frame, on `performance.now`.
   * A browser exposes no thread CPU clock, so this is the web arms' frame-CPU series; the GPU process's
   * present is outside it, as `presentCpuMs` is outside the desktop figure.
   */
  threadCpuMs?: number[];
  /** With `phases=1`: the five `PHASES` per frame on the same clock as `threadCpuMs`. */
  phases?: Record<string, number[]>;
  /** With `crossings=1` on the engine arm: JS-to-Wasm get/set/invoke calls per frame. */
  bridgeCalls?: number[];
  /** With `crossings=1`: the names crossed most, per frame. */
  crossingTop?: Array<[string, number]>;
  mode: RenderMode;
  objectCount: number;
  /** SHA-256 of every initial position read from the built scene, before animation or projection. */
  initialPlacementSha256: string;
  positionHash: string;
  repeat: number;
  triangles: number;
  visibleObjects: number;
}

/** What one web arm tells the shared driver about itself. */
export interface ILadderArm {
  arm: string;
  buildNotes: string;
  /** The render projection, for the arm that has one. L3 and the culling A/B need it. */
  createCollapse?: CollapseFactory;
  engineName: string;
  engineVersion: string;
  /** The culling A/B, which only exists where there is a projection to plan with. */
  measureCulling?: (renderer: ILoadTestHarness["renderer"]) => Promise<unknown>;
  rendererLabel: string;
  /**
   * PRD-464 R3's skinned characters, built by the arm that owns the framework. Omitted by the
   * `plain-three-webgpu` control, which never asks for a ladder rung, so a run that does ask for
   * one without a factory fails closed at `setRung` rather than measuring R1 under an R3 name.
   */
  createCharacters?: () => Promise<ICharacterCrowd>;
  /** Opt-in renderer-stage profiling. It inflates absolute frame time, so it is never a default. */
  stageHooks?: typeof installRendererStageHooks;
}

interface IUserAgentData {
  architecture?: string;
  brands?: readonly { brand: string; version: string }[];
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
  model?: string;
  platform?: string;
}

const parameters = new URLSearchParams(globalThis.location.search);
const holdFrame = parameters.has("holdFrame") ? Number(parameters.get("holdFrame")) : undefined;
const frames = readInteger("frames", FRAMES_PER_RUNG);
const warmup = readInteger("warmup", WARMUP_FRAMES);
const repeats = readInteger("repeats", REPEATS);
const ladder = readLadder();
const modes = readModes();
const axes = readAxes();

function readInteger(name: string, fallback: number): number {
  const raw = parameters.get(name);
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 0) throw new Error(`TN_BENCH_BAD_PARAM:${name}`);
  return value;
}

function readLadder(): number[] {
  const raw = parameters.get("ladder");
  if (raw === null) return [...LADDER];
  return raw.split(",").map((part) => {
    const value = Number.parseInt(part, 10);
    if (!Number.isFinite(value) || value < 0) throw new Error("TN_BENCH_BAD_PARAM:ladder");
    return value;
  });
}

function readModes(): RenderMode[] {
  const raw = parameters.get("modes");
  if (raw === null) return ["L1", "L2"];
  return raw.split(",").map((part) => {
    if (!(RENDER_MODES as readonly string[]).includes(part))
      throw new Error("TN_BENCH_BAD_PARAM:modes");
    return part as RenderMode;
  });
}

// Every axis is optional and defaults to the PRD-117 scene; `parseAxesRecord` validates the rest.
function readAxes(): IWorkloadAxes {
  return parseAxesRecord(Object.fromEntries(parameters.entries()));
}

function nextFrame(): Promise<number> {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

// Per-frame phases on `performance.now`, the one clock both web arms have (`--pair` asks for it).
const phases =
  parameters.get("phases") === "1" ? createPhaseRecorder(() => performance.now()) : undefined;
// The engine arm's call census (`browser-backend.ts` `countCall`): a Map per crossing name. It costs a
// string and a Map write per crossing, so it is its own opt-in and never on in a timed run.
const callCounts = parameters.get("crossings") === "1" ? new Map<string, number>() : undefined;
if (callCounts !== undefined)
  (globalThis as { __tnCallCounts?: Map<string, number> }).__tnCallCounts = callCounts;
const census = (): Record<string, number> => Object.fromEntries(callCounts ?? []);
const censusTotal = (): number => {
  let total = 0;
  for (const count of callCounts?.values() ?? []) total += count;
  return total;
};
// The engine arm's crossing counter (`browser-entry.ts`): one increment per crossing, so it is on in every
// timed run, and each measured frame reports its bridgeCalls for the pair's crossing budget.
// Read per frame: the engine binds it when `three` loads, and tn-web never does.
const crossingCount = (): number | undefined =>
  (globalThis as { __tnCrossingCount?: () => number }).__tnCrossingCount?.();

/** Startup and memory of a web arm, read in the page (PRD-573 slice 7). */
export interface IWebMetrics {
  startup: {
    /** `performance.now()` when the entry ran: the engine module (fetch, compile, instantiate) is before it. */
    entryMs: number;
    /** `performance.now()` once the first rung's first frame was submitted; null before any frame. */
    firstFrameMs: number | null;
    /** Every `WebAssembly` compile or instantiate the page made before the entry, ms each. */
    wasmInstantiateMs: number[];
  };
  memory: {
    /** Largest `performance.memory.usedJSHeapSize` seen after a rung; null where the browser hides it. */
    jsHeapUsedBytes: number | null;
    /** Largest Wasm linear memory seen after a rung; null for an arm with no engine module. */
    wasmMemoryBytes: number | null;
  };
}
const entryMs = performance.now();
let firstFrameMs: number | undefined;
let jsHeapUsedBytes: number | null = null;
let wasmMemoryBytes: number | null = null;
function sampleMemory(): void {
  const heap = (performance as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
  if (typeof heap === "number") jsHeapUsedBytes = Math.max(jsHeapUsedBytes ?? 0, heap);
  const wasm = (globalThis as { __tnWasmMemoryBytes?: () => number }).__tnWasmMemoryBytes?.();
  if (typeof wasm === "number") wasmMemoryBytes = Math.max(wasmMemoryBytes ?? 0, wasm);
}

// Opt-in and never part of a published ladder: wrapping every renderer stage inflates the
// absolute frame time, so a profiled run's proportions are the finding and its milliseconds are
// not comparable to anything.
const profileStages = parameters.get("stages") === "1";

/** The resolved measurement window, so a rung outside the ladder frames like one inside it. */
export interface ILadderKnobs {
  frames: number;
  repeats: number;
  warmup: number;
}

export const LADDER_KNOBS: ILadderKnobs = { frames, repeats, warmup };

/**
 * PRD-449 §7.4's fill/drain policy and timing scope, recorded on every rung: one untimed pre-drain so
 * the window never opens with earlier work in flight, one post-measurement drain so the tail is inside
 * it, and no per-frame fence — a fence per frame is the thing the primary metric exists to avoid.
 * `timing-scope` says the window is wall time with the browser's presentation cadence inside it, so a
 * reader cannot mistake the metric for uncapped capacity.
 */
export const DRAIN_POLICY =
  "pre-drain:untimed,post-drain:timed,per-frame-fence:none,timing-scope:cadence-inclusive-browser-delivery";

/** The clock a measurement reads. Injected so the boundary is provable without a browser. */
export type MeasurementClock = { nextFrame: () => Promise<number>; now: () => number };

const BROWSER_CLOCK: MeasurementClock = {
  nextFrame,
  now: () => performance.now(),
};

/**
 * The one finished-work observation a WebGPU arm can make, or `undefined` when this renderer holds
 * no queue to ask — a WebGL context, a stubbed backend, a backend that moved the seam. Undefined is a
 * hole in the measurement, never a licence to publish the CPU submit time as finished work.
 */
function queueCompletion(renderer: unknown): (() => Promise<void>) | undefined {
  const queue = (
    renderer as {
      backend?: { device?: { queue?: { onSubmittedWorkDone?: () => Promise<void> } } };
    }
  ).backend?.device?.queue;
  const done = queue?.onSubmittedWorkDone;
  if (typeof done !== "function") return undefined;
  return () => (done as () => Promise<void>).call(queue);
}

export async function measureRung(
  harness: ILoadTestHarness,
  arm: ILadderArm,
  rung: ILoadTestRung,
  repeat: number,
  knobs: ILadderKnobs = LADDER_KNOBS,
  clock: MeasurementClock = BROWSER_CLOCK,
): Promise<IRungReport> {
  // Fail closed before the scene is even built: a window with no measured frame would divide by
  // zero and report an infinite or `NaN` throughput, which reads as a win rather than as a bug.
  if (knobs.warmup >= knobs.frames)
    throw new Error(`TN_BENCH_WARMUP_GE_FRAMES:${knobs.warmup}/${knobs.frames}`);
  harness.setRung(rung);
  const initialPlacementSha256 = await sha256(harness.placementBytes);
  // L3, L4 and the realistic-scene rungs bake across frames. Drive it to "applied" before a single
  // sample is taken, or the rung times the bake and reports it as the steady-state cost.
  if (isProjectedRung(rung.mode)) {
    harness.beginCollapse();
    for (let settle = 0; settle < 5_000 && harness.collapseStatus() === "pending"; settle += 1) {
      // Draw occasionally while the pass bakes. Every frame pays the un-collapsed scene's cost and
      // timed the desktop arm out at 16 384; never drawing is worse, because the native host drives
      // `requestAnimationFrame` from its present loop, so a settle that never renders never gets
      // another callback and hangs at full CPU. One frame in eight keeps the pump alive cheaply.
      harness.step(settle);
      if (settle % 8 === 0) await harness.render();
      await nextFrame();
    }
    // L4's question is what the shipped default costs on a scene nothing may batch, so the
    // projection declining is that row's answer, not a failure — and `drawCalls` is what records
    // which of the two happened. Only L3's two guards stay strict, because their whole point is
    // that an un-projected frame must never be published under an L3 label. The realistic-scene
    // rungs are L3's authoring, so they keep both guards: a ladder row that quietly measured the
    // un-projected scene would be a different experiment from the one its name states.
    if (rung.mode === "L3" || isRealisticRung(rung.mode)) {
      // `projected` is the projection's applied state, where the pass this replaced said `applied`.
      // `hostProjected` is the same verdict where the host renderer batches the authored scene itself
      // (the Wasm engine's `__tnProjectionReport`), as `native-run.ts` accepts it on the engine player.
      if (harness.collapseStatus() !== "projected" && harness.collapseStatus() !== "hostProjected")
        throw new Error(`TN_BENCH_COLLAPSE_${harness.collapseStatus().toUpperCase()}`);
      // Fail closed on the frozen scene. The pass this replaced could classify a moving object as
      // static and render a still picture at a very fast frame time, which is indistinguishable from
      // a win unless the rung refuses to report. The projection cannot freeze an object — every one
      // of them carries its own instance matrix — so the equivalent assertion is that every object is
      // actually in the optimized lane rather than quietly sitting on the exact one.
      //
      // `>=`, not `===`: the count is every projected object in the scene, and the scene holds a
      // ground plane besides the rung's cubes. The old equality held only because the ground was
      // static and so was never a "moving part"; under the projection there is no static/moving split
      // to exclude it, which is the whole point of the replacement.
      const moving = harness.collapseMovingParts();
      if (moving < rung.objectCount)
        throw new Error(`TN_BENCH_COLLAPSE_FROZE:${moving}/${rung.objectCount}`);
    }
  }
  const frameMs: number[] = [];
  const stepMs: number[] = [];
  const threadCpuMs: number[] = [];
  const phaseMs: number[][] = PHASES.map(() => []);
  const bridgeCalls: number[] = [];
  let censusAtOpen: Record<string, number> | undefined;
  let drawCalls = 0;
  let triangles = 0;
  let visibleObjects = 0;
  let ladder: ILadderCounts | undefined;
  let foxMeasurement: IFoxMeasurement | undefined;
  let renderCheck: IFrameStats | undefined;
  // The completed-work window's CPU half: every measured update+render span, summed. Kept as its own
  // diagnostic rather than folded into the primary metric — the wall window is what the PRD measures,
  // and this is the uncapped submit cost the window's cadence otherwise hides.
  let submitMs = 0;
  const completion = queueCompletion(harness.renderer);
  let windowStart: number | undefined;
  let compilesAtWindowStart = 0;
  let previous = clock.now();
  const statsFrame = Math.floor((knobs.frames + knobs.warmup) / 2);
  const hooks =
    profileStages && arm.stageHooks !== undefined
      ? arm.stageHooks(harness.renderer, { mode: "full" })
      : undefined;
  for (let frameIndex = 0; frameIndex < knobs.frames; frameIndex += 1) {
    if (frameIndex === knobs.warmup) {
      hooks?.reset();
      // One untimed pre-drain. Work submitted by the warmup must have landed before the window
      // opens, or the first measured frame pays for it and the mean is pessimistic by an amount
      // that has nothing to do with the engine.
      if (completion !== undefined) await completion();
      // The drain sits on the boundary, so one drained read starts both series: the completed-work
      // wall window and the legacy frame-interval series. It is untimed work in neither.
      windowStart = clock.now();
      previous = windowStart;
      compilesAtWindowStart = harness.pipelineCompiles();
      // Phases opened before the window (the settle, the warmup probe) are not the window's.
      phases?.take();
      if (callCounts !== undefined) censusAtOpen = census();
    }
    const submittedAt = clock.now();
    const callsBefore = crossingCount() ?? (callCounts === undefined ? 0 : censusTotal());
    harness.step(frameIndex);
    await harness.render();
    const submitted = clock.now() - submittedAt;
    firstFrameMs ??= performance.now();
    // `?holdFrame=N` keeps frame N on screen and stops: the visual judge's captures are one pose on every arm
    // (the bench steps by frame index). A held run never reports.
    if (frameIndex === holdFrame) {
      (globalThis as { __TN_BENCH_HELD__?: number }).__TN_BENCH_HELD__ = frameIndex;
      await new Promise<never>(() => {});
    }
    const taken = phases?.take();
    if (frameIndex >= knobs.warmup) {
      submitMs += submitted;
      if (taken !== undefined) {
        threadCpuMs.push(Math.round(submitted * 1000) / 1000);
        taken.forEach((ms, index) => phaseMs[index]?.push(Math.round(ms * 1000) / 1000));
      }
      const crossed = crossingCount();
      if (crossed !== undefined) bridgeCalls.push(crossed - callsBefore);
      else if (callCounts !== undefined) bridgeCalls.push(censusTotal() - callsBefore);
    }
    // Read before yielding: three's own rAF resets the per-frame counters, so a read after
    // `nextFrame()` reports zero draws no matter what was submitted.
    if (frameIndex === statsFrame) {
      const stats = harness.stats();
      drawCalls = stats.drawCalls;
      triangles = stats.triangles;
      visibleObjects = stats.visibleObjects;
      // Read at the same frame as the counters: the rung's asserted scene cost is a property of
      // the scene it is measuring, and a rung that lost it mid-window must not report a number.
      ladder = harness.ladderCounts();
      foxMeasurement = harness.foxMeasurement();
    }
    // PRD-464: the ladder's own proof that the rung drew something. Taken on the last warmup frame,
    // outside the window — the read-back stalls the GPU, and a stalled frame inside the window would
    // be reported as this rung's cost.
    if (frameIndex === knobs.warmup - 1 && isRealisticRung(rung.mode))
      renderCheck = await harness.probeFrame();
    await clock.nextFrame();
    const now = clock.now();
    const interval = now - previous;
    previous = now;
    if (frameIndex >= knobs.warmup) {
      frameMs.push(interval);
      stepMs.push(harness.stepMs);
    }
  }
  // One post-measurement drain, and timed: the last measured frame's GPU work has to land inside the
  // window or the tail is missing and the mean is optimistic. The window closes on the drained clock,
  // so it is wall time for N completed frames — the rAF waits included, and that is the point.
  if (completion !== undefined) await completion();
  const windowEnd = clock.now();
  // Unreachable while `warmup < frames` is enforced above; stated so a future knob cannot make the
  // window unstarted and report a mean over a window that never opened.
  if (windowStart === undefined)
    throw new Error(`TN_BENCH_WINDOW_UNSTARTED:${knobs.warmup}/${knobs.frames}`);
  const measuredFrames = knobs.frames - knobs.warmup;
  const stageReport = hooks?.snapshot({ measuredFrameCount: measuredFrames });
  hooks?.dispose();
  sampleMemory();
  const capture = (globalThis as { __TN_BENCH_CAPTURE__?: () => Promise<string> })
    .__TN_BENCH_CAPTURE__;
  const framePng = await capture?.();
  const crossingTop =
    censusAtOpen === undefined ? undefined : topCrossings(censusAtOpen, census(), measuredFrames);
  return {
    ...(phases === undefined
      ? {}
      : {
          threadCpuMs,
          phases: Object.fromEntries(PHASES.map((name, index) => [name, phaseMs[index] ?? []])),
        }),
    ...(bridgeCalls.length === 0 ? {} : { bridgeCalls }),
    ...(crossingTop === undefined ? {} : { crossingTop }),
    completedWorkMeanMs:
      completion === undefined ? null : (windowEnd - windowStart) / measuredFrames,
    completedWorkReason: completion === undefined ? "queue-completion-unavailable" : null,
    cpuSubmitMeanMs: submitMs / measuredFrames,
    drawCalls,
    drainPolicy: DRAIN_POLICY,
    frameMs,
    measuredFrames,
    ...(foxMeasurement === undefined ? {} : { foxMeasurement }),
    ...(ladder === undefined ? {} : { ladder }),
    ...(renderCheck === undefined ? {} : { renderCheck }),
    ...(framePng === undefined ? {} : { framePng }),
    pipelineCompiles: harness.pipelineCompiles() - compilesAtWindowStart,
    stageReport,
    stepMs,
    mode: rung.mode,
    objectCount: rung.objectCount,
    initialPlacementSha256,
    positionHash: harness.positionHash,
    repeat,
    triangles,
    visibleObjects,
  };
}

function observed(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`TN_BENCH_IDENTITY_MISSING:${field}`);
  return value;
}

function resolveServedModuleUrl(specifier: string, parentUrl: string): string {
  let resolved: URL;
  try {
    resolved = new URL(specifier, parentUrl);
  } catch {
    throw new Error(`TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:${specifier}`);
  }
  if (
    resolved.protocol !== "http:" &&
    resolved.protocol !== "https:" &&
    resolved.protocol !== "data:"
  ) {
    throw new Error(`TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:${resolved.protocol}`);
  }
  return resolved.href;
}

async function servedModuleGraph(roots: readonly string[]): Promise<IModuleGraphEntry[]> {
  const pending = [...roots];
  const seen = new Set<string>();
  const entries: IModuleGraphEntry[] = [];
  while (pending.length > 0) {
    const url = pending.shift();
    if (url === undefined || seen.has(url)) continue;
    seen.add(url);
    const entry = await readServedModule(url);
    entries.push(entry);
    const { bytes } = entry;
    const source = new TextDecoder().decode(bytes);
    for (const specifier of extractModuleSpecifiers(source)) {
      pending.push(resolveServedModuleUrl(specifier, url));
    }
  }
  return entries;
}

async function readServedModule(url: string): Promise<IModuleGraphEntry> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:${response.status}`);
  return { bytes: new Uint8Array(await response.arrayBuffer()), url };
}

function inferArchitecture(platform: string): string {
  if (/x86_64|amd64/i.test(platform)) return "x86_64";
  if (/aarch64|arm64/i.test(platform)) return "arm64";
  if (/arm/i.test(platform)) return "arm";
  if (/x86|i[3-6]86/i.test(platform)) return "x86";
  throw new Error(`TN_BENCH_IDENTITY_MISSING:architecture:${platform}`);
}

async function ladderIdentity(
  adapterLabel: string,
  canvas: HTMLCanvasElement,
): Promise<Record<string, string>> {
  const data = (navigator as unknown as { userAgentData?: IUserAgentData }).userAgentData;
  const highEntropy =
    data?.getHighEntropyValues === undefined
      ? {}
      : await data.getHighEntropyValues(["architecture", "model", "platform"]);
  const operatingSystem = observed(
    highEntropy.platform ?? data?.platform ?? navigator.platform,
    "operatingSystem",
  );
  const architecture = observed(
    highEntropy.architecture ?? data?.architecture ?? inferArchitecture(operatingSystem),
    "architecture",
  );
  const browser = observed(navigator.userAgent, "browser");
  const browserBrands = data?.brands?.map(({ brand, version }) => `${brand} ${version}`).join(", ");
  const jsRuntime = observed(browserBrands || browser, "jsRuntime");
  const gpu = observed(adapterLabel, "gpu");
  const device = observed(
    highEntropy.model || `${operatingSystem}-${architecture}-${gpu}`,
    "device",
  );
  const sourceSha = observed(parameters.get("sourceSha"), "sourceSha");
  const entryUrl = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src;
  if (entryUrl === undefined) throw new Error("TN_BENCH_IDENTITY_ARTIFACT_UNAVAILABLE:entry");
  const artifactModules = await servedModuleGraph([entryUrl]);
  const workloadUrls = [
    new URL("./game.ts", import.meta.url).href,
    new URL("./workload.ts", import.meta.url).href,
  ];
  // Vite emits these TS sources as byte-for-byte assets for the production identity. Their
  // relative imports point at source-tree paths, not executable dist chunks, so hash the two
  // observed assets directly. The dev server serves a traversable source graph instead.
  const workloadGraph = productionBuild()
    ? await Promise.all(workloadUrls.map(readServedModule))
    : await servedModuleGraph(workloadUrls);
  const workloadModules = workloadGraph.filter(isBenchmarkWorkloadModule);
  const artifactHash = await hashServedModuleGraph(artifactModules);
  const workloadHash = await hashWorkloadModuleGraph(
    workloadModules,
    {
      axes,
      frames,
      ladder,
      modes,
      repeats,
      warmup,
      workload: "moving-l2-l3-16384",
      render: `${VIEWPORT_WIDTH}x${VIEWPORT_HEIGHT}`,
    },
    workloadGraph,
  );
  return {
    architecture,
    artifactHash,
    browser,
    device,
    graphicsBackend: "WebGPU",
    gpu,
    instrumentationRevision: "engine-load-test-v2",
    jsRuntime,
    // Web reports use the served module identity for the comparator's binary slot.
    nativeBinaryHash: artifactHash,
    operatingSystem,
    presentMode: parameters.get("vsync") === "on" ? "vsync" : "immediate",
    resolution: `${canvas.width}x${canvas.height}`,
    sourceSha,
    workloadHash,
  };
}

// Read from the adapter the browser actually handed out, never assumed: a run that silently fell
// back to a software rasteriser must be visible in the published report (PRD-117 §4.5).
export async function describeAdapter(): Promise<string> {
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (gpu === undefined) throw new Error("TN_BENCH_IDENTITY_MISSING:gpu");
  const adapter = (await gpu.requestAdapter()) as { info?: Record<string, string> } | null;
  const info = adapter?.info;
  if (info === undefined || info === null) throw new Error("TN_BENCH_IDENTITY_MISSING:gpu");
  const parts = [info.vendor, info.architecture, info.device, info.description].filter(
    (part) => typeof part === "string" && part.length > 0,
  );
  if (parts.length === 0) throw new Error("TN_BENCH_IDENTITY_MISSING:gpu");
  return parts.join(" / ");
}

// The bundler, not the collector, decides this: Vite replaces the member expression at build time
// and only a production bundle is built with `PROD` true. The literal access is load-bearing for
// the same reason it is in `packages/core/src/game.ts` — any indirection survives into the bundle.
function productionBuild(): boolean {
  return (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true;
}

/** Runs one arm's ladder and parks its §5.1 run report on `window` for the collector to read. */
export async function runLadderArm(
  canvas: HTMLCanvasElement,
  status: HTMLElement,
  arm: ILadderArm,
): Promise<unknown> {
  canvas.width = VIEWPORT_WIDTH;
  canvas.height = VIEWPORT_HEIGHT;
  // Loaded once, before any rung is built, so the R3 character's first measured frame is a skinning
  // frame rather than a decode frame. An arm that was asked for a character rung and has no factory
  // is told here, once, instead of at the first `setRung` deep inside the loop.
  // Only R3 and above draw the crowd, so R1 and R2 do not pay to build 50 rigs they never attach.
  const wantsCharacters = modes.some(
    (mode) => isRealisticRung(mode) && ladderRank(mode) >= ladderRank("R3"),
  );
  if (wantsCharacters && arm.createCharacters === undefined)
    throw new Error("TN_BENCH_NO_CHARACTER_FACTORY");
  const characters =
    wantsCharacters && arm.createCharacters !== undefined
      ? await arm.createCharacters()
      : undefined;
  const harness = await createLoadTestHarness(
    canvas,
    await describeAdapter(),
    true,
    axes,
    arm.createCollapse,
    undefined,
    characters,
    undefined,
    phases,
  );
  const rungs: IRungReport[] = [];
  for (const objectCount of ladder) {
    for (const mode of modes) {
      for (let repeat = 0; repeat < repeats; repeat += 1) {
        status.textContent = `N=${objectCount} ${mode} repeat ${repeat + 1}/${repeats}`;
        const report = await measureRung(harness, arm, { mode, objectCount }, repeat);
        rungs.push(report);
        status.textContent = `N=${objectCount} ${mode} repeat ${repeat + 1}/${repeats} — p95 ${percentile(report.frameMs, 0.95).toFixed(2)} ms`;
      }
    }
  }
  const culling =
    arm.measureCulling === undefined ? undefined : await arm.measureCulling(harness.renderer);
  if (culling !== undefined) console.info(`TN_CULLING_RUNG:${JSON.stringify(culling)}`);
  const identity = parameters.has("sourceSha")
    ? await ladderIdentity(harness.adapterLabel, canvas)
    : undefined;
  const report = {
    arm: arm.arm,
    axes,
    build: {
      notes: `${productionBuild() ? "vite production build" : "vite dev build"}, ${arm.buildNotes}`,
      type: "release",
    },
    device: {
      battery: null,
      label: parameters.get("device") ?? "desktop-chrome-linux",
    },
    display: {
      height: VIEWPORT_HEIGHT,
      refreshHz: readInteger("refreshHz", 60),
      vsync: parameters.get("vsync") === "on",
      width: VIEWPORT_WIDTH,
    },
    driver: { adapter: harness.adapterLabel, renderer: arm.rendererLabel },
    engine: { name: arm.engineName, version: arm.engineVersion },
    ...(culling === undefined ? {} : { culling }),
    identity: identity,
    rungs,
    web: {
      startup: {
        entryMs,
        firstFrameMs: firstFrameMs ?? null,
        wasmInstantiateMs:
          (globalThis as { __tnWasmInstantiateMs?: number[] }).__tnWasmInstantiateMs ?? [],
      },
      memory: { jsHeapUsedBytes, wasmMemoryBytes },
    } satisfies IWebMetrics,
  };
  (globalThis as unknown as Record<string, unknown>).__ENGINE_LOAD_TEST__ = report;
  status.textContent = `done — ${rungs.length} rungs`;
  harness.dispose();
  return report;
}
