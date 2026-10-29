import type { IFrameBudgetWindow } from "../frame-budget.js";

export interface IDebugSource {
  readonly area: string;
  readonly caller: string;
  readonly lever?: string;
  readonly unit?: string;
}

interface IDebugHost {
  process?: { env?: Record<string, unknown> };
  // biome-ignore lint/style/useNamingConvention: public launch flag shared with native and worker hosts.
  __THREENATIVE_DEBUG__?: unknown;
  __tnEngineCost?: Record<string, number>;
  __tnDebugSources?: Record<string, IDebugSource>;
}

/** Read at installation, using the same launch seams as spansRequested(). */
export function debugRequested(): boolean {
  const host = globalThis as IDebugHost;
  return (
    host.process?.env?.TN_DEBUG === "1" ||
    host.__THREENATIVE_DEBUG__ === true ||
    /[?&]tnDebug=1(?:&|$)/u.test(globalThis.location?.search ?? "")
  );
}

/** Debug-only producers call this; the existing engine-cost reader owns the per-frame difference. */
export function countDebug(
  name: string,
  value: number,
  area: string,
  caller: string,
  unit = "count",
): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`TN_DEBUG: invalid ${name} observation.`);
  const host = globalThis as IDebugHost;
  host.__tnEngineCost ??= {};
  host.__tnDebugSources ??= {};
  host.__tnEngineCost[name] = (host.__tnEngineCost[name] ?? 0) + value;
  host.__tnDebugSources[name] ??= { area, caller, unit };
}

/** Call only from an installed debug branch; preserves thrown errors and records their cost. */
export function measureDebug<T>(name: string, area: string, caller: string, run: () => T): T {
  const start = performance.now();
  try {
    return run();
  } finally {
    countDebug(`${name}Ms`, performance.now() - start, area, caller, "ms");
    countDebug(`${name}Calls`, 1, area, caller);
  }
}

/** GC entries are optional platform observations, and the observer exists only during a debug game. */
export function observeDebugGc(): (() => void) | undefined {
  if (!globalThis.PerformanceObserver?.supportedEntryTypes?.includes("gc")) return undefined;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      countDebug("gcPauses", 1, "memory", "PerformanceObserver.gc");
      countDebug("gcPauseMs", entry.duration, "memory", "PerformanceObserver.gc", "ms");
    }
  });
  observer.observe({ type: "gc" });
  return () => observer.disconnect();
}

function sourceOf(name: string): IDebugSource {
  const source = (globalThis as IDebugHost).__tnDebugSources?.[name];
  if (source !== undefined)
    return { ...source, unit: source.unit ?? (name.endsWith("Ms") ? "ms" : "count") };
  const areas: readonly (readonly [RegExp, string])[] = [
    [/bridge|children|wrapper|share|scratch|widen|overflow/iu, "bridge"],
    [/velocity|temporal|history|rejected|clamped/iu, "temporal"],
    [
      /heap|memory|live|released|allocated|gc|CreatedBytes|FreedBytes|handleCreates|handleReleases/iu,
      "memory",
    ],
    [/gpu|map|timestamp|gate|submit|completion/iu, "gpu"],
    [/matrix|travers|transform|hierarchy|walk/iu, "scene"],
  ];
  const area = areas.find(([pattern]) => pattern.test(name))?.[1] ?? "renderer";
  const nativeCallers: readonly (readonly [RegExp, string])[] = [
    [/^gate/u, "renderer/frame_gate.h:FrameGate::decline"],
    [/^(pipeline|bindGroups)/u, "renderer/pipeline_cache.cpp"],
    [/^(buffer|texture|queue|readback)/u, "renderer/gpu_resources.cpp"],
    [/^handle/u, "foundation/handles.cpp"],
    [
      /^(velocity|temporal|timestamp|gpuTimestamp|render|shadow|aux|uniform|attribute)/u,
      "renderer/renderer.cpp",
    ],
    [/^cull/u, "scene/projected_cull.cpp"],
    [/scene|matrix|hierarchy/iu, "scene/object3d.cpp"],
  ];
  const site = nativeCallers.find(([pattern]) => pattern.test(name))?.[1];
  const async = /queueCallback|queueDelivery/iu.test(name);
  return {
    area,
    caller: /^gc/u.test(name)
      ? `packages/runtime-native/src/adapters/v8/adapter.cpp (${name})`
      : site === undefined
        ? `engine counter: ${name}`
        : `packages/runtime-native/src/engine/${site} (${name})`,
    unit: async ? "async-ms" : name.endsWith("Ms") ? "ms" : "count",
  };
}

function leverOf(area: string): string | undefined {
  const anchor: Record<string, string> = {
    bridge:
      "2026-10-27--web-engine-bridge-keep-what-game-code-reads-again-three-native-back-end--keep",
    renderer:
      "2026-10-27--wasted-work-on-the-shooter-counted-by-class--diagnostic-2-of-6-classes-have-a-fix-in-another-lane",
    scene:
      "2026-10-27--a-scratch-objects-death-leaves-the-hierarchy-counter-alone-native-engine--keep",
    ui: "2026-10-14--publishuistate-serializes-a-changed-hud-frame-once-instead-of-three-times--keep",
    update:
      "2026-10-27--rapier-step-grew-from-21-to-34-66-ms-a-frame-in-profiler-round-2--not-a-cause-host-load",
    host: "method-lessons",
  };
  return anchor[area] === undefined ? undefined : `PERFORMANCE-LEARNINGS.md#${anchor[area]}`;
}

/** One report from the budget's own completed window; counts remain counts, including unknown cost. */
export function formatDebugReport(window: IFrameBudgetWindow): string {
  const interval =
    window.presented.samples > 0 && window.presented.mean > 0 ? window.presented.mean : undefined;
  const engine = window.counters?.engine ?? {};
  const durationMs = window.durationMs;
  const observations = Object.fromEntries(
    Object.entries(engine).map(([name, series]) => {
      if (!Number.isFinite(series.mean) || series.mean < 0)
        throw new Error(`TN_DEBUG: invalid ${name} series.`);
      const source = sourceOf(name);
      const rate = source.unit === "count" || source.unit?.endsWith("bytes");
      return [
        name,
        {
          ...series,
          ...source,
          ...(rate
            ? {
                perSecond:
                  durationMs !== undefined && durationMs > 0 && series.samples === window.frames
                    ? (series.mean * series.samples * 1000) / durationMs
                    : null,
              }
            : {}),
        },
      ];
    }),
  );
  const offenders: Array<{
    name: string;
    area: string;
    caller: string;
    ms: number;
    share: number | null;
    basis: string;
    lever?: string;
  }> = [];
  const add = (name: string, ms: number, source: IDebugSource, basis: string): void => {
    if (ms <= 0) return;
    const lever = source.lever ?? leverOf(source.area);
    offenders.push({
      name,
      ms,
      area: source.area,
      caller: source.caller,
      share: interval === undefined ? null : ms / interval,
      basis,
      ...(lever === undefined ? {} : { lever }),
    });
  };
  for (const [name, series] of Object.entries(engine)) {
    const source = sourceOf(name);
    if (source.unit === "ms" || source.unit === "estimated-ms")
      add(
        name,
        series.mean,
        source,
        source.unit === "estimated-ms" ? "estimated-getter-equivalent" : "measured",
      );
    if (
      name.startsWith("bridge:") &&
      !name.startsWith("bridge:widen") &&
      (engine.bridgeCrossings?.mean ?? 0) > 0
    )
      add(
        name,
        series.mean * ((engine.bridgeCrossingMs?.mean ?? 0) / (engine.bridgeCrossings?.mean ?? 1)),
        source,
        "estimated-getter-equivalent",
      );
  }
  for (const [name, series] of Object.entries(window.phases))
    add(
      `phase.${name}`,
      series.mean,
      { area: name === "hostGap" ? "host" : name, caller: "FixedStepLoop", unit: "ms" },
      "measured-parent",
    );
  for (const [name, ms] of [
    ["main", window.gpuMain],
    ["shadow", window.gpuShadow],
    ["other", window.gpuOther],
    ["compute", window.gpuCompute],
  ] as const)
    if (ms !== undefined)
      add(
        `gpu.${name}`,
        ms,
        { area: "gpu", caller: "GPU timestamp query", unit: "ms" },
        "gpu-execution",
      );
  // Async wall times are observations. They overlap the frame and are not CPU work.
  offenders.sort((a, b) => (b.share ?? -1) - (a.share ?? -1) || a.name.localeCompare(b.name));
  const findings: Array<{
    code: string;
    ratio?: number;
    perFrame?: number;
    share: number | null;
    caller: string;
    lever?: string;
  }> = [];
  const total = (name: string): number | undefined => {
    const series = engine[name];
    return series === undefined ? undefined : series.mean * series.samples;
  };
  const ratio = (code: string, numerator: string, denominator: string, limit: number): void => {
    const n = total(numerator);
    const d = total(denominator);
    if (n === undefined || d === undefined || d <= 0 || n / d <= limit) return;
    const source = sourceOf(numerator);
    const timing = engine[`${numerator}Ms`];
    const lever = source.lever ?? leverOf(source.area);
    findings.push({
      code,
      ratio: n / d,
      share: timing === undefined || interval === undefined ? null : timing.mean / interval,
      caller: source.caller,
      ...(lever === undefined ? {} : { lever }),
    });
  };
  ratio("temporal-missing-velocity", "velocitySkippedDraws", "velocityEligibleDraws", 0);
  ratio("temporal-missing-velocity", "velocitySkipped", "velocityCandidates", 0);
  ratio("temporal-history-unavailable", "temporalInvalidHistoryFrames", "temporalActiveFrames", 0);
  ratio("temporal-history-unavailable", "temporalHistoryInvalidFrames", "temporalActiveFrames", 0);
  ratio("temporal-history-unavailable", "temporalInvalidFrames", "temporalActiveFrames", 0);
  const activity = (code: string, counter: string): void => {
    const value = engine[counter]?.mean;
    if (value === undefined || value <= 0) return;
    const source = sourceOf(counter);
    const lever = source.lever ?? leverOf(source.area);
    findings.push({
      code,
      perFrame: value,
      share: null,
      caller: source.caller,
      ...(lever === undefined ? {} : { lever }),
    });
  };
  activity("timestamp-oversampling", "gpuTimestampUnrequestedSamples");
  activity("bridge-arena-overflow", "bridgeOverflowAllocations");
  activity("gate-capacity-decline", "gateDeclinedCapacity");
  activity("gate-completion-age-decline", "gateDeclinedAge");
  ratio("bridge-typed-array-widening", "bridgeTypedEncodedBytes", "bridgeTypedSourceBytes", 1);
  // Memory/population changes are observations until measured cost or a lifetime invariant fails.
  return `TN_DEBUG_REPORT:${JSON.stringify({ window: window.window, frames: window.frames, durationMs: durationMs ?? null, intervalMs: interval ?? null, offenders, findings, observations, longTasks: window.longTasks, gpu: window.gpu, passes: window.passes })}`;
}

/** A single slow named callback exceeds the interval the loop actually observed. Debug-only. */
export function debugHotCalls(window: IFrameBudgetWindow): string | undefined {
  const interval = window.presented.mean;
  if (!(interval > 0)) return undefined;
  const calls = Object.entries(window.counters?.engine ?? {})
    .flatMap(([name, series]) => {
      const source = sourceOf(name);
      return source.area === "update" && source.unit === "ms" && series.p95 > interval
        ? [
            {
              name,
              caller: source.caller,
              ms: series.p95,
              share: series.p95 / interval,
              lever: source.lever ?? leverOf(source.area),
            },
          ]
        : [];
    })
    .sort((a, b) => b.share - a.share);
  return calls.length === 0
    ? undefined
    : `TN_HOT_CALL:${JSON.stringify({ window: window.window, intervalMs: interval, calls })}`;
}
