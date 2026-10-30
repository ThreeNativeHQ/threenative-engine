/**
 * Where the main-thread frame goes, by stage (PRD-771).
 *
 * The frame budget's `render` phase wraps one synchronous `renderer.render()` call, and on the owned
 * Wasm engine that call holds the scene walk, the draw plan, the encode, the post passes and the queue
 * submit, all in C++. A phase that large with nothing named inside it is a question, not a measurement.
 * This splits it with one clock read per boundary, so the split rides every window rather than a
 * diagnostic flag:
 *
 *  - the JS before the engine call (cull, `beforeRender`, reconcile, LOD, matrix walk) and after it;
 *  - the engine's own CPU stages, from the running totals the Wasm facade publishes in
 *    `renderer.info.engine.cpuMs` (three-native `gpu-stages.ts`), differenced per frame;
 *  - what is left of the call, named: JS inside `render()` around the Wasm call, and Wasm time no stage owns.
 *
 * The stages partition the render phase. `wasmOther` and `engineJs` are subtractions, published as
 * stages (`wasmRendererGap` is what `Renderer::render` spends outside its plan and encode halves) so the unlocated time is a number and never a quiet category. On an engine that publishes no
 * stage totals (upstream three), the whole call is `engineJs`.
 */

import type { IFrameCounters } from "./FrameCounters.js";

/** The stages of the render phase, in the order a frame spends them. They sum to the frame's `render` phase. */
export const RENDER_STAGES = [
  "jsBefore",
  "engineJs",
  "wasmScene",
  "wasmPlan",
  "wasmCompute",
  "wasmEncode",
  "wasmPost",
  "wasmSubmit",
  "wasmPoll",
  "wasmTail",
  "wasmRendererGap",
  "wasmDatabaseGap",
  "wasmTargets",
  "wasmOther",
  "jsAfter",
] as const;

export type RenderStage = (typeof RENDER_STAGES)[number];

/**
 * Parts of a stage, published beside it and never added to the sum: `wasmPlan` holds all three, in the order the
 * renderer runs them, and what is left of it is the rest of the prepare half.
 */
export const STAGE_PARTS = ["planVirtualPages", "planDraws", "planShadowLists"] as const;

export type StagePart = (typeof STAGE_PARTS)[number];

/** One frame's stages in milliseconds, reused across frames so the read allocates nothing. */
export type IFrameStageSample = Record<RenderStage | StagePart, number | undefined>;

/** The running totals the Wasm facade publishes (`renderer.info.engine.cpuMs`), in ms. */
export interface IEngineCpuTotals {
  readonly cpuVirtualPagesMs: number;
  readonly cpuPlanMs: number;
  readonly cpuShadowBuildMs: number;
  readonly cpuPrepareMs: number;
  readonly cpuEncodeMs: number;
  readonly cpuPostMs: number;
  readonly cpuSceneMs: number;
  readonly hostRenderMs: number;
  readonly hostComputeMs: number;
  readonly hostSubmitMs: number;
  readonly hostPollMs: number;
  readonly hostTailMs: number;
  readonly rendererMs: number;
  readonly hostDatabaseMs: number;
  readonly hostTargetMs: number;
}

const TOTAL_NAMES = [
  "cpuVirtualPagesMs",
  "cpuPlanMs",
  "cpuShadowBuildMs",
  "cpuPrepareMs",
  "cpuEncodeMs",
  "cpuPostMs",
  "cpuSceneMs",
  "hostRenderMs",
  "hostComputeMs",
  "hostSubmitMs",
  "hostPollMs",
  "hostTailMs",
  "rendererMs",
  "hostDatabaseMs",
  "hostTargetMs",
] as const satisfies readonly (keyof IEngineCpuTotals)[];

/** A fresh sample with every stage at zero. */
export function emptyStageSample(): IFrameStageSample {
  return {
    engineJs: 0,
    jsAfter: 0,
    jsBefore: 0,
    planDraws: 0,
    planShadowLists: 0,
    planVirtualPages: 0,
    wasmCompute: 0,
    wasmDatabaseGap: 0,
    wasmEncode: 0,
    wasmOther: 0,
    wasmPlan: 0,
    wasmPoll: 0,
    wasmPost: 0,
    wasmRendererGap: 0,
    wasmScene: 0,
    wasmSubmit: 0,
    wasmTail: 0,
    wasmTargets: 0,
  };
}

/** Every stage and part that only the engine's totals can fill. */
const UNMEASURED_WITHOUT_TOTALS = [
  "wasmScene",
  "wasmPlan",
  "wasmCompute",
  "wasmEncode",
  "wasmPost",
  "wasmSubmit",
  "wasmPoll",
  "wasmTail",
  "wasmRendererGap",
  "wasmDatabaseGap",
  "wasmTargets",
  "wasmOther",
  "planVirtualPages",
  "planDraws",
  "planShadowLists",
] as const;

const positive = (value: number): number => (value > 0 ? value : 0);

interface IEngineCpuHost {
  readonly info?: { readonly engine?: { readonly cpuMs?: Partial<IEngineCpuTotals> } };
}

/**
 * The reader `game.ts` calls once per rendered frame with the three JS timings of that frame. It returns the
 * frame's stages (the same object every call) or `undefined` for the baseline read, so a run's first frame
 * is not charged everything since boot.
 *
 * `renderer` is the raw renderer; one that publishes no stage totals gets the whole call as `engineJs`.
 * Wasm time is wall time on the page's clock; the totals only ever grow, so a negative difference (a
 * restarted engine) reads as zero rather than a negative stage.
 */
export function createStageReader(
  renderer: () => unknown,
): (jsBefore: number, engineCall: number, jsAfter: number) => IFrameStageSample | undefined {
  const sample = emptyStageSample();
  const last = new Float64Array(TOTAL_NAMES.length);
  let haveLast = false;
  return (jsBefore, engineCall, jsAfter) => {
    sample.jsBefore = positive(jsBefore);
    sample.jsAfter = positive(jsAfter);
    const totals = (renderer() as IEngineCpuHost | null | undefined)?.info?.engine?.cpuMs;
    if (totals === undefined) {
      // A stage the engine did not measure is absent, never zero: the window leaves it out and the sum skips it.
      sample.engineJs = positive(engineCall);
      for (const name of UNMEASURED_WITHOUT_TOTALS) sample[name] = undefined;
      return sample;
    }
    let delta0 = 0;
    const delta = (index: number): number => {
      const total = totals[TOTAL_NAMES[index] as keyof IEngineCpuTotals] ?? 0;
      const previous = last[index] ?? 0;
      last[index] = total;
      delta0 = positive(total - previous);
      return delta0;
    };
    const virtualPages = delta(0);
    const draws = delta(1);
    const shadowLists = delta(2);
    const prepare = delta(3);
    const encode = delta(4);
    const post = delta(5);
    const scene = delta(6);
    const host = delta(7);
    const compute = delta(8);
    const submit = delta(9);
    const poll = delta(10);
    const tail = delta(11);
    const inRenderer = delta(12);
    const inDatabase = delta(13);
    const targets = delta(14);
    if (!haveLast) {
      haveLast = true;
      return undefined;
    }
    const encodeOnly = positive(encode - post);
    sample.wasmScene = scene;
    sample.wasmPlan = prepare;
    sample.wasmCompute = compute;
    sample.wasmEncode = encodeOnly;
    sample.wasmPost = post;
    sample.wasmSubmit = submit;
    sample.wasmPoll = poll;
    sample.wasmTail = tail;
    sample.wasmRendererGap = positive(inRenderer - prepare - encode);
    sample.wasmDatabaseGap = positive(inDatabase - scene - inRenderer);
    sample.wasmTargets = targets;
    sample.planVirtualPages = virtualPages;
    sample.planDraws = draws;
    sample.planShadowLists = shadowLists;
    sample.wasmOther = positive(host - (inDatabase + targets + compute + submit + poll + tail));
    sample.engineJs = positive(engineCall - host);
    return sample;
  };
}

/**
 * Whether this launch reads the stage meters. On unless the launch turns them off: `?tnStages=0` in the URL,
 * `TN_STAGES=0` in a native host's environment, or `globalThis.__tnStages = false` before the game boots.
 * Off, the frame reads no extra clock, the engine reads none around its stages, and the window carries no
 * `stages`: the paired A/B that prices the meters runs one build with this switch alone.
 */
export function stageMetersRequested(): boolean {
  const host = globalThis as { process?: { env?: Record<string, unknown> }; __tnStages?: unknown };
  const fromEnv = host.process?.env?.TN_STAGES;
  if (fromEnv === "0" || fromEnv === "false") return false;
  const query = globalThis.location?.search;
  if (typeof query === "string" && /[?&]tnStages=(?:0|false)(?:&|$)/u.test(query)) return false;
  return host.__tnStages !== false;
}

interface IEngineWorkHost {
  readonly info?: {
    readonly engine?: {
      readonly work?: {
        readonly dirtyTransforms?: number;
        readonly castersMoving?: number;
        readonly queueWriteBytes?: number;
      };
    };
  };
}

/**
 * The frame's work counts beside its stages (PRD-771), as `IFrameCounters` fields: transforms moved, shadow
 * casters judged moving, bytes the GPU queue took (`gpuBytes`, buffer writes only), the engine ABI calls
 * (`hostCalls`, which on the owned engine are the bridge crossings the caller passes in) and the JS heap the
 * frame grew (`jsAllocBytes`, from `performance.memory`; a frame the collector ran in reads 0, so it is a floor).
 * The first read is the baseline. A count the engine does not publish stays absent, never zero.
 */
export function createWorkReader(
  renderer: () => unknown,
): (
  crossings: number | undefined,
) =>
  | Pick<
      IFrameCounters,
      "castersMoving" | "dirtyTransforms" | "gpuBytes" | "hostCalls" | "jsAllocBytes"
    >
  | undefined {
  let last: { dirty: number; moving: number; bytes: number } | undefined;
  let heap: number | undefined;
  return (crossings) => {
    const work = (renderer() as IEngineWorkHost | null | undefined)?.info?.engine?.work;
    const memory = (globalThis.performance as { memory?: { usedJSHeapSize?: unknown } } | undefined)
      ?.memory?.usedJSHeapSize;
    const used = typeof memory === "number" && Number.isFinite(memory) ? memory : undefined;
    const grown = used === undefined || heap === undefined ? undefined : positive(used - heap);
    heap = used;
    if (
      work === undefined ||
      typeof work.dirtyTransforms !== "number" ||
      typeof work.castersMoving !== "number" ||
      typeof work.queueWriteBytes !== "number"
    )
      return undefined;
    const now = {
      dirty: work.dirtyTransforms,
      moving: work.castersMoving,
      bytes: work.queueWriteBytes,
    };
    const previous = last;
    last = now;
    if (previous === undefined) return undefined;
    return {
      castersMoving: positive(now.moving - previous.moving),
      dirtyTransforms: positive(now.dirty - previous.dirty),
      gpuBytes: positive(now.bytes - previous.bytes),
      ...(crossings === undefined ? {} : { hostCalls: crossings }),
      ...(grown === undefined ? {} : { jsAllocBytes: grown }),
    };
  };
}
