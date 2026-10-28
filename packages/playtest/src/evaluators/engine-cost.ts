import type { IEvaluationContext } from "./context.js";

/** The engine's frame-budget window; its `counters.engine` holds every engine work counter (core FrameCounters.ts). */
export const FRAME_BUDGET_MARKER = "TN_FRAME_BUDGET:";
/** three-native's census, printed while a playtest bounds engine counters: who crossed, by name. */
export const BRIDGE_CENSUS_MARKER = "TN_BRIDGE_CENSUS:";

interface ISummary {
  readonly mean?: number;
  readonly max?: number;
}

interface IEngineCostWindow {
  readonly window?: number;
  /** Each counter's per-frame mean over the window. */
  readonly perFrame: Readonly<Record<string, number | undefined>>;
  /** Each counter's single-frame maximum over the window. */
  readonly maxFrame: Readonly<Record<string, number | undefined>>;
  /** The census printed last before the window closed. */
  readonly top?: readonly { readonly name?: string; readonly perFrame?: number; readonly caller?: string }[];
}

/**
 * Every `TN_FRAME_BUDGET` window that carries engine counters, in console order, with the latest
 * `TN_BRIDGE_CENSUS` before it; a budget line that does not parse is kept as `undefined`.
 * `counters.bridgeCrossings` (the back end's JS->Wasm count) joins under its own name.
 */
export function engineCostWindows(lines: readonly string[]): (IEngineCostWindow | undefined)[] {
  const windows: (IEngineCostWindow | undefined)[] = [];
  let top: IEngineCostWindow["top"];
  for (const line of lines) {
    if (typeof line !== "string") continue;
    const census = line.indexOf(BRIDGE_CENSUS_MARKER);
    if (census !== -1) {
      try {
        top = (JSON.parse(line.slice(census + BRIDGE_CENSUS_MARKER.length)) as { top?: IEngineCostWindow["top"] }).top;
      } catch {
        top = undefined;
      }
      continue;
    }
    const at = line.indexOf(FRAME_BUDGET_MARKER);
    if (at === -1) continue;
    let report: { window?: number; counters?: { engine?: Record<string, ISummary>; bridgeCrossings?: ISummary } };
    try {
      report = JSON.parse(line.slice(at + FRAME_BUDGET_MARKER.length)) as typeof report;
    } catch {
      windows.push(undefined);
      continue;
    }
    const engine = report.counters?.engine;
    if (engine === undefined) continue;
    const series: Record<string, ISummary> = {
      ...engine,
      ...(report.counters?.bridgeCrossings === undefined ? {} : { bridgeCrossings: report.counters.bridgeCrossings }),
    };
    const pick = (field: keyof ISummary) =>
      Object.fromEntries(Object.entries(series).map(([name, summary]) => [name, summary[field]]));
    windows.push({ maxFrame: pick("max"), perFrame: pick("mean"), top, ...(report.window === undefined ? {} : { window: report.window }) });
  }
  return windows;
}

function topCaller(window: IEngineCostWindow): string {
  const top = window.top?.[0];
  return top === undefined ? "no census before this window" : `${top.name ?? "?"} ${top.perFrame ?? "?"}/frame from ${top.caller ?? "unknown"}`;
}

/**
 * `assert.engineCost`: every window holds every bound. Fails closed on no window, an unreadable
 * window, and a bounded counter a window does not report.
 */
export function emitEngineCost(ctx: IEvaluationContext): void {
  const assertion = ctx.scenarioAssertions.engineCost;
  if (assertion === undefined) return;
  const windows = engineCostWindows((ctx.input.report.observations?.console ?? []).map(({ text }) => text));
  const stillWindows = assertion.still?.windows ?? 0;
  const skipped = assertion.skipWindows ?? 0;
  // A moving bound needs at least one window after the skipped and still ones.
  const needed = Math.max(assertion.minWindows ?? 1, skipped + stillWindows + (assertion.moving === undefined ? 0 : 1));
  const readable = windows.filter((window): window is IEngineCostWindow => window !== undefined);
  const observed = readable.length >= needed && readable.length === windows.length;
  ctx.assertions.push({ details: { windows: windows.length, unreadable: windows.length - readable.length, needed }, id: "engineCost.observed", pass: observed });
  if (!observed) {
    ctx.diagnostics.push({
      code: "TN_PLAYTEST_ENGINE_COST_UNOBSERVED",
      message: `engineCost needs ${needed} readable TN_FRAME_BUDGET window(s) with counters.engine; the run printed ${windows.length}, ${windows.length - readable.length} unreadable.`,
      observedRuntimePath: "observations.json/console",
      severity: "error",
      suggestion: "Run with the playtest runner (it sets __THREENATIVE_ENGINE_COST__, which turns the counters on) on a fixed-step clock, long enough for each 300-tick TN_FRAME_BUDGET window the bounds need.",
    });
    return;
  }
  const bounded = readable.slice(skipped);
  for (const [kind, table, scope, windows] of [
    ["perFrame", assertion.maxPerFrame, "maxPerFrame", bounded],
    ["maxFrame", assertion.maxInFrame, "maxInFrame", bounded],
    ["perFrame", assertion.still?.maxPerFrame, "still.maxPerFrame", bounded.slice(0, stillWindows)],
    ["perFrame", assertion.moving?.maxPerFrame, "moving.maxPerFrame", bounded.slice(stillWindows)],
    ["maxFrame", assertion.moving?.maxInFrame, "moving.maxInFrame", bounded.slice(stillWindows)],
  ] as const) {
    for (const [name, bound] of Object.entries(table ?? {})) {
      const values = windows.map((window) => window[kind]?.[name]);
      const missing = values.findIndex((value) => typeof value !== "number" || !Number.isFinite(value));
      const worst = windows.reduce<IEngineCostWindow | undefined>(
        (top, window) => ((window[kind]?.[name] ?? -1) > (top?.[kind]?.[name] ?? -1) ? window : top),
        undefined,
      );
      const value = worst?.[kind]?.[name] ?? Number.NaN;
      const pass = missing === -1 && value <= bound;
      const id = `engineCost.${scope}.${name}`;
      ctx.assertions.push({ details: { bound, value, window: worst?.window, source: assertion.source }, id, pass });
      if (pass) continue;
      ctx.diagnostics.push({
        code: "TN_PLAYTEST_ENGINE_COST_OVER_BOUND",
        message:
          missing !== -1
            ? `engineCost: window ${windows[missing]?.window ?? missing + 1} reports no '${name}' (${kind}); a bounded counter must be measured in every window.`
            : `engineCost: '${name}' ${kind === "perFrame" ? "per frame" : "in one frame"}${scope.startsWith("still") ? " while still" : scope.startsWith("moving") ? " in play" : ""} reached ${value} in window ${worst?.window ?? "?"}, over the bound ${bound} (${assertion.source}). Top crossing: ${topCaller(worst as IEngineCostWindow)}.`,
        observedRuntimePath: "observations.json/console",
        severity: "error",
        suggestion: "Read TN_FRAME_BUDGET.counters.engine and the TN_BRIDGE_CENSUS before it: the counter names the cost class, and the top caller names the code that pays it. Fix that code or the engine path under it; never raise the bound to pass.",
      });
    }
  }
}
