export const EXPECTED_THREE_VERSION = "0.187.0";

export interface IRendererStageSample {
  readonly calls: number;
  readonly callsPerMeasuredFrame?: number;
  readonly inclusiveMs: number;
  readonly inclusiveMsPerMeasuredFrame?: number;
  /**
   * The single most expensive call to this stage.
   *
   * Reported because a total divided by a call count is not a per-call cost when one call does
   * something categorically different. Measured in three 0.185.1: `nodes.updateBefore` averages
   * about 5.7 µs over ~394 calls a frame, and one of those calls renders the shadow map and
   * takes 3,600 µs. Reading the mean alone turns a render pass into a per-draw cost, which is
   * exactly the misreading this field exists to prevent — compare `maxMs` against
   * `inclusiveMs / calls` before calling any stage expensive per call.
   */
  readonly maxMs: number;
  readonly timing: "inclusive";
}

export interface IRendererStageReport {
  readonly attribution: {
    readonly mode: "inclusive-overlap-declared";
    readonly note: string;
  };
  readonly counters: {
    readonly computeFrameCalls: number;
    readonly drawCalls: number;
    readonly drawCounterSource: "info.render.drawCalls";
    readonly renderCalls: number;
    readonly renderFrameCalls: number;
    readonly triangles: number;
  };
  readonly frame: {
    readonly nestedRenderSceneCalls: number;
    readonly outputTransformRenderSceneCalls: number;
    readonly passCalls: number;
    readonly topLevelRenderSceneCalls: number;
  };
  readonly measuredFrameCount?: number;
  readonly missingStages: readonly string[];
  readonly overlap: readonly IRendererStageOverlap[];
  readonly reachableStages: readonly string[];
  readonly stages: Record<string, IRendererStageSample>;
  readonly threeVersion: string;
  readonly version: 2;
}

export interface IRendererStageOverlap {
  readonly child: string;
  readonly note: string;
  readonly parent: string;
}

export interface IRendererStageHooks {
  readonly dispose: () => void;
  readonly reset: () => void;
  readonly snapshot: (options?: IRendererStageSnapshotOptions) => IRendererStageReport;
}

export interface IRendererStageSnapshotOptions {
  readonly measuredFrameCount?: number;
}

export interface IRendererStageHookOptions {
  readonly clock?: () => number;
  /**
   * `full` wraps every reachable candidate for deterministic unit tests and short probes.
   * `safe` drops high-frequency per-render-object/per-draw wrappers for measured runs.
   */
  readonly mode?: "full" | "safe";
  readonly threeVersion?: string;
}

type AnyFunction = (...args: unknown[]) => unknown;

type HookTarget = {
  readonly object: Record<string, unknown>;
  readonly method: string;
  readonly required: boolean;
  readonly stage: string;
};

interface IStageMutable {
  calls: number;
  inclusiveMs: number;
  maxMs: number;
  timing: "inclusive";
}

/**
 * Version 2 adds a required `maxMs` to every stage.
 *
 * The bump is not cosmetic: a version-1 report has no slowest-call field, so it validates as a
 * stage whose calls are uniform, and that reading turned a shadow-map render into a per-draw
 * cost in this repository's performance record. A reader that cannot tell the two shapes apart
 * would repeat it, so the shapes carry different numbers.
 */
export const rendererStageReportSchema = {
  attributionMode: "inclusive-overlap-declared",
  stageTiming: "inclusive",
  version: 2,
} as const;

const REQUIRED_RENDERER_METHODS = [
  "_renderScene",
  "_projectObject",
  "_renderObjects",
  "_renderObjectDirect",
];

const OVERLAP: readonly IRendererStageOverlap[] = [
  {
    child: "renderer.projectObject",
    note: "Traversal/list build is inside renderer.renderScene inclusive time.",
    parent: "renderer.renderScene",
  },
  {
    child: "renderList.sort",
    note: "Render-list sort is inside renderer.renderScene inclusive time when sorting is enabled.",
    parent: "renderer.renderScene",
  },
  {
    child: "renderer.renderObjects",
    note: "Render object submission is inside renderer.renderScene inclusive time.",
    parent: "renderer.renderScene",
  },
  {
    child: "renderer.renderObjectDirect",
    note: "Direct object handling is inside renderer.renderObjects inclusive time.",
    parent: "renderer.renderObjects",
  },
  {
    child: "backend.draw",
    note: "Backend draw is inside renderer.renderObjectDirect inclusive time.",
    parent: "renderer.renderObjectDirect",
  },
];

function stage(stages: Map<string, IStageMutable>, name: string): IStageMutable {
  let value = stages.get(name);
  if (value === undefined) {
    value = { calls: 0, inclusiveMs: 0, maxMs: 0, timing: "inclusive" };
    stages.set(name, value);
  }
  return value;
}

function finiteCounter(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`Renderer stage report requires finite ${label}.`);
  }
  return value;
}

function optionalMeasuredFrameCount(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Renderer stage report measuredFrameCount must be a positive integer.");
  }
  return value;
}

function isPromiseLike(
  value: unknown,
): value is PromiseLike<unknown> & { finally?: (callback: () => void) => unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function requireMethod(
  object: Record<string, unknown>,
  method: string,
  owner: string,
): AnyFunction {
  const value = object[method];
  if (typeof value !== "function")
    throw new Error(`Unsupported three@${EXPECTED_THREE_VERSION}: missing ${owner}.${method}.`);
  return value as AnyFunction;
}

function optionalMethod(object: unknown, method: string): object is Record<string, AnyFunction> {
  return (
    typeof object === "object" &&
    object !== null &&
    typeof (object as Record<string, unknown>)[method] === "function"
  );
}

function collectTargets(
  renderer: Record<string, unknown>,
  mode: "full" | "safe",
): { missing: string[]; targets: HookTarget[] } {
  for (const method of REQUIRED_RENDERER_METHODS) requireMethod(renderer, method, "renderer");

  const missing: string[] = [];
  const targets: HookTarget[] = [
    { object: renderer, method: "_renderScene", required: true, stage: "renderer.renderScene" },
    { object: renderer, method: "_renderObjects", required: true, stage: "renderer.renderObjects" },
  ];
  if (mode === "full")
    targets.push({
      object: renderer,
      method: "_projectObject",
      required: true,
      stage: "renderer.projectObject",
    });
  else missing.push("renderer.projectObject (dropped in safe mode to bound overhead)");
  if (mode === "full") {
    targets.push({
      object: renderer,
      method: "_renderObjectDirect",
      required: true,
      stage: "renderer.renderObjectDirect",
    });
  }

  const renderLists = renderer._renderLists;
  if (optionalMethod(renderLists, "get")) {
    const originalGet = renderLists.get;
    targets.push({ object: renderLists, method: "get", required: false, stage: "renderLists.get" });
    // `RenderList` instances are produced by get(); their `sort()` method is not exposed on
    // the manager. The get wrapper below lazily wraps the returned instance by identity.
    void originalGet;
  } else {
    missing.push("renderList.sort (renderer._renderLists.get unavailable)");
  }

  const managers = [
    ["_nodes", "getForRender", "nodes.getForRender"],
    ["_nodes", "updateBefore", "nodes.updateBefore"],
    ["_nodes", "updateForRender", "nodes.updateForRender"],
    ["_nodes", "updateAfter", "nodes.updateAfter"],
    ["_geometries", "updateForRender", "geometries.updateForRender"],
    ["_bindings", "updateForRender", "bindings.updateForRender"],
    ["_pipelines", "getForRender", "pipelines.getForRender"],
    ["_textures", "updateRenderTarget", "textures.updateRenderTarget"],
    ["_objects", "get", "renderObjects.get"],
    ["_objects", "createRenderObject", "renderObjects.createRenderObject"],
    ["backend", "beginRender", "backend.beginRender"],
    ["backend", "draw", "backend.draw"],
    ["backend", "finishRender", "backend.finishRender"],
  ] as const;

  const highFrequencyStages = new Set([
    "nodes.getForRender",
    "nodes.updateBefore",
    "nodes.updateForRender",
    "nodes.updateAfter",
    "geometries.updateForRender",
    "bindings.updateForRender",
    "pipelines.getForRender",
    "renderObjects.get",
    "renderObjects.createRenderObject",
    "backend.draw",
  ]);
  for (const [property, method, name] of managers) {
    if (mode === "safe" && highFrequencyStages.has(name)) {
      missing.push(`${name} (dropped in safe mode to bound overhead)`);
      continue;
    }
    const object = renderer[property];
    if (optionalMethod(object, method))
      targets.push({ object, method, required: false, stage: name });
    else missing.push(`${name} (${property}.${method} unavailable)`);
  }

  return { missing, targets };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Installation owns hook target collection, wrapper lifecycle, and report closures so restore/reset state stays colocated.
export function installRendererStageHooks(
  rendererInput: unknown,
  options: IRendererStageHookOptions = {},
): IRendererStageHooks {
  const threeVersion = options.threeVersion ?? EXPECTED_THREE_VERSION;
  if (threeVersion !== EXPECTED_THREE_VERSION) {
    throw new Error(
      `Renderer stage hooks require exact three@${EXPECTED_THREE_VERSION}; got ${threeVersion}.`,
    );
  }
  if (typeof rendererInput !== "object" || rendererInput === null) {
    throw new Error("Renderer stage hooks require a renderer object.");
  }

  const renderer = rendererInput as Record<string, unknown>;
  const clock = options.clock ?? (() => performance.now());
  const stages = new Map<string, IStageMutable>();
  const originals: { object: Record<string, unknown>; method: string; original: AnyFunction }[] =
    [];
  const wrappedRenderLists: { list: Record<string, unknown>; originalSort: AnyFunction }[] = [];
  const wrappedRenderListOriginals = new WeakMap<object, AnyFunction>();
  let disposed = false;
  let renderSceneDepth = 0;
  let topLevelRenderSceneCalls = 0;
  let nestedRenderSceneCalls = 0;
  let outputTransformRenderSceneCalls = 0;
  let passCalls = 0;

  const mode = options.mode ?? "full";
  const { missing, targets } = collectTargets(renderer, mode);

  const wrapFunction = (
    object: Record<string, unknown>,
    method: string,
    stageName: string,
    original: AnyFunction,
  ): AnyFunction => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: One wrapper owns sync/error/promise accounting so stage timings and depth restoration stay atomic.
    const wrapped = function rendererStageWrapped(this: unknown, ...args: unknown[]) {
      const before = clock();
      const isRenderScene = stageName === "renderer.renderScene";
      let renderSceneDepthIncremented = false;
      if (isRenderScene) {
        if (renderSceneDepth === 0) topLevelRenderSceneCalls += 1;
        else nestedRenderSceneCalls += 1;
        if (args[2] === false) outputTransformRenderSceneCalls += 1;
        passCalls += 1;
        renderSceneDepth += 1;
        renderSceneDepthIncremented = true;
      }
      const record = () => {
        const elapsed = clock() - before;
        const current = stage(stages, stageName);
        current.calls += 1;
        const safe = Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
        current.inclusiveMs += safe;
        if (safe > current.maxMs) current.maxMs = safe;
        if (renderSceneDepthIncremented) renderSceneDepth -= 1;
      };
      try {
        const result = original.apply(this, args);
        if (isPromiseLike(result)) {
          if (typeof result.finally === "function") return result.finally(record);
          return Promise.resolve(result).finally(record);
        }
        record();
        return result;
      } catch (error) {
        record();
        throw error;
      }
    };
    Object.defineProperty(wrapped, "name", {
      configurable: true,
      value: `${method}RendererStageHook`,
    });
    object[method] = wrapped;
    return wrapped;
  };

  try {
    for (const target of targets) {
      const original = requireMethod(target.object, target.method, target.stage);
      originals.push({ object: target.object, method: target.method, original });
      if (target.stage === "renderLists.get") {
        target.object[target.method] = function renderListsGetRendererStageHook(
          this: unknown,
          ...args: unknown[]
        ) {
          const before = clock();
          try {
            const list = original.apply(this, args);
            if (
              typeof list === "object" &&
              list !== null &&
              optionalMethod(list, "sort") &&
              !wrappedRenderListOriginals.has(list)
            ) {
              const sortOriginal = requireMethod(list, "sort", "renderList");
              wrappedRenderListOriginals.set(list, sortOriginal);
              wrappedRenderLists.push({ list, originalSort: sortOriginal });
              list.sort = wrapFunction(list, "sort", "renderList.sort", sortOriginal);
            }
            return list;
          } finally {
            const elapsed = clock() - before;
            const current = stage(stages, "renderLists.get");
            current.calls += 1;
            current.inclusiveMs += Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0;
          }
        };
      } else {
        wrapFunction(target.object, target.method, target.stage, original);
      }
    }
  } catch (error) {
    for (let index = originals.length - 1; index >= 0; index -= 1) {
      const item = originals[index];
      if (item) item.object[item.method] = item.original;
    }
    throw error;
  }

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (let index = wrappedRenderLists.length - 1; index >= 0; index -= 1) {
      const item = wrappedRenderLists[index];
      if (item) item.list.sort = item.originalSort;
    }
    for (let index = originals.length - 1; index >= 0; index -= 1) {
      const item = originals[index];
      if (item) item.object[item.method] = item.original;
    }
  };

  const reset = () => {
    stages.clear();
    renderSceneDepth = 0;
    topLevelRenderSceneCalls = 0;
    nestedRenderSceneCalls = 0;
    outputTransformRenderSceneCalls = 0;
    passCalls = 0;
  };

  const snapshot = (options: IRendererStageSnapshotOptions = {}): IRendererStageReport => {
    const info = renderer.info as
      | { compute?: { frameCalls?: unknown }; render?: Record<string, unknown> }
      | undefined;
    const render = info?.render;
    const drawCalls = finiteCounter(render?.drawCalls, "info.render.drawCalls");
    const measuredFrameCount = optionalMeasuredFrameCount(options.measuredFrameCount);
    const stagesForReport = Object.fromEntries(
      [...stages.entries()].map(([name, value]) => [
        name,
        {
          ...value,
          ...(measuredFrameCount === undefined
            ? {}
            : {
                callsPerMeasuredFrame: value.calls / measuredFrameCount,
                inclusiveMsPerMeasuredFrame: value.inclusiveMs / measuredFrameCount,
              }),
        },
      ]),
    );
    const report: IRendererStageReport = {
      attribution: {
        mode: "inclusive-overlap-declared",
        note: "Stage timings are inclusive. Overlapping parent/child stages are declared and must not be summed as total attribution.",
      },
      counters: {
        computeFrameCalls: finiteCounter(info?.compute?.frameCalls ?? 0, "info.compute.frameCalls"),
        drawCalls,
        drawCounterSource: "info.render.drawCalls",
        renderCalls: finiteCounter(render?.calls ?? 0, "info.render.calls"),
        renderFrameCalls: finiteCounter(render?.frameCalls ?? 0, "info.render.frameCalls"),
        triangles: finiteCounter(render?.triangles ?? 0, "info.render.triangles"),
      },
      frame: {
        nestedRenderSceneCalls,
        outputTransformRenderSceneCalls,
        passCalls,
        topLevelRenderSceneCalls,
      },
      ...(measuredFrameCount === undefined ? {} : { measuredFrameCount }),
      missingStages: [...missing],
      overlap: OVERLAP,
      reachableStages: [...stages.keys()].sort(),
      stages: stagesForReport,
      threeVersion,
      version: 2,
    };
    return validateRendererStageReport(report);
  };

  return { dispose, reset, snapshot };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation is intentionally explicit so malformed experimental reports fail with precise field names.
export function validateRendererStageReport(report: unknown): IRendererStageReport {
  if (typeof report !== "object" || report === null)
    throw new Error("Renderer stage report must be an object.");
  const candidate = report as Partial<IRendererStageReport> & { attribution?: { mode?: string } };
  if (candidate.version !== 2) throw new Error("Renderer stage report version must be 2.");
  if (candidate.threeVersion !== EXPECTED_THREE_VERSION)
    throw new Error(`Renderer stage report must pin three@${EXPECTED_THREE_VERSION}.`);
  if (candidate.attribution?.mode !== "inclusive-overlap-declared") {
    throw new Error(
      "Renderer stage report must declare inclusive overlap metadata; summed inclusive attribution is rejected.",
    );
  }
  if (!Array.isArray(candidate.overlap) || candidate.overlap.length === 0) {
    throw new Error("Renderer stage report must include overlap metadata.");
  }
  if (typeof candidate.stages !== "object" || candidate.stages === null) {
    throw new Error("Renderer stage report requires stages.");
  }
  for (const [name, value] of Object.entries(candidate.stages)) {
    if (typeof value !== "object" || value === null) throw new Error(`Stage ${name} is invalid.`);
    const stageValue = value as Partial<IRendererStageSample>;
    if (stageValue.timing !== "inclusive")
      throw new Error(`Stage ${name} must declare inclusive timing.`);
    finiteCounter(stageValue.calls, `${name}.calls`);
    finiteCounter(stageValue.inclusiveMs, `${name}.inclusiveMs`);
    // Required, not optional: a report without it reads as a stage whose calls are uniform, and
    // that is the assumption that turned a shadow pass into a per-draw cost.
    finiteCounter(stageValue.maxMs, `${name}.maxMs`);
    if (stageValue.callsPerMeasuredFrame !== undefined)
      finiteCounter(stageValue.callsPerMeasuredFrame, `${name}.callsPerMeasuredFrame`);
    if (stageValue.inclusiveMsPerMeasuredFrame !== undefined)
      finiteCounter(stageValue.inclusiveMsPerMeasuredFrame, `${name}.inclusiveMsPerMeasuredFrame`);
  }
  optionalMeasuredFrameCount(candidate.measuredFrameCount);
  finiteCounter(candidate.counters?.drawCalls, "counters.drawCalls");
  if (candidate.counters?.drawCounterSource !== "info.render.drawCalls") {
    throw new Error(
      "Renderer stage report rejected render.calls draw-counter misuse; use info.render.drawCalls.",
    );
  }
  return candidate as IRendererStageReport;
}
