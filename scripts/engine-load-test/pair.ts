// A same-run A/B between two ThreeNative desktop arms (legacy `tn-desktop` against the owned engine
// `tn-engine-desktop`). Both arms run the same ladder in alternating order, and no ratio is printed unless
// every facet of "they drew the same scene" holds: the parity guard (`parity.ts`) is the gate, so an arm that
// drew fewer lights, no bloom or no shadows ends the run with the table of what differs, never with a ratio.
import { DEFAULT_AXES, isRealisticRung } from "../../examples/engine-load-test/src/workload.js";
import {
  type Facets,
  type IParityRow,
  assertSymmetricSpans,
  parityProblem,
  parityRows,
} from "./parity.js";
import {
  BenchError,
  type IRunReport,
  type IRungSummary,
  SUMMARY_PHASES,
  type SummaryPhase,
  checkEquivalence,
  isSoftwareRasteriser,
  percentile,
  pooledPhaseStats,
  renderAxes,
  rungKey,
  summarize,
} from "./report.js";
import { type IVisualParity, visualParity } from "./visual.js";

/** Per-rung series a report carries beside `frameMs`; the arms must carry the same ones. */
const SERIES = ["stepMs", "collapseMs"] as const;

/** The families of per-frame series a report carries, the instrument gap `assertSymmetricSpans` is for. */
export function seriesFamilies(report: IRunReport): string[] {
  const found = new Set<string>(["frameMs"]);
  for (const rung of report.rungs)
    for (const name of SERIES) if (rung[name] !== undefined) found.add(name);
  return [...found];
}

/** A frame clock that never moves inside a frame prints one repeated value; a real one does not. */
function clockMoves(report: IRunReport): boolean {
  return report.rungs.every(
    (rung) => new Set(rung.frameMs.map((sample) => Math.round(sample * 100))).size > 1,
  );
}

/**
 * Every fact one run can differ in without anyone noticing, read from the run's own output. A fact the run
 * does not state is absent, which `parityRows` treats as a failure when it is required.
 */
export function reportFacets(report: IRunReport): Facets {
  const facets: Facets = {
    "adapter class": isSoftwareRasteriser(report.driver.adapter)
      ? "software rasteriser"
      : "hardware",
    "build type": report.build.type,
    "frame clock": clockMoves(report) ? "moving" : "frozen",
    "refresh Hz": String(report.display.refreshHz),
    surface: `${report.display.width}x${report.display.height}`,
    vsync: report.display.vsync ? "on" : "off",
    "workload axes": renderAxes(report.axes ?? DEFAULT_AXES),
  };
  for (const rung of report.rungs) {
    const key = rungKey(rung.mode, rung.objectCount);
    facets[`${key} frames`] = String(rung.frameMs.length);
    facets[`${key} placement`] = rung.positionHash;
    facets[`${key} scene`] = rung.ladder === undefined ? "-" : JSON.stringify(rung.ladder);
    facets[`${key} fox`] =
      rung.foxMeasurement === undefined ? "-" : `${rung.foxMeasurement.heightM.toFixed(2)} m`;
  }
  return facets;
}

/** Crossings per frame (p50) an R-ladder rung may make on the engine player: 4x the measured 62. */
export const HOST_PROJECTION_CROSSING_BUDGET = 256;

export interface IPairVerdict {
  problem?: string;
  rows: IParityRow[];
  visual: IVisualParity[];
}

/**
 * The guard over every run of both arms. The report-level equivalence checks (`checkEquivalence`: triangle
 * counts within 5%, fox sizes, display, build type) run pairwise and join the table as rows; the series
 * families must match; and the surface, vsync, clock and rasteriser must hold the fixed values of a real
 * uncapped hardware run on both arms.
 */
export function pairVerdict(
  left: readonly IRunReport[],
  right: readonly IRunReport[],
  labels: readonly [string, string],
): IPairVerdict {
  if (left.length === 0 || right.length === 0)
    throw new BenchError("TN_BENCH_PARITY", "a pair needs at least one run of each arm", 1);
  const shared: Array<{ facet: string; left: string; pass: boolean; right: string }> = [];
  left.forEach((run, index) => {
    const other = right[index] ?? right[right.length - 1];
    if (other === undefined) return;
    for (const failure of checkEquivalence(run, other)) {
      // `TN_BENCH_WAIVE=drawCalls` names the one facet a host that batches the authored scene itself (the
      // engine player under host projection) legitimately moves: it submits far fewer draws for the same
      // triangles. Triangles are not waived: both arms treat the projected cubes as one cull unit and count
      // effect passes alike, so an R5 pair is 155,919 triangles on each. The row stays in the table, marked
      // waived; the fox size, the placements and the probe frame still have to match.
      const waived = (process.env.TN_BENCH_WAIVE ?? "")
        .split(",")
        .some((name) => name !== "" && failure.field.startsWith(name));
      shared.push({
        facet: `${failure.rung} ${failure.field}${waived ? " (waived: TN_BENCH_WAIVE)" : ""}`,
        left: failure.left,
        pass: waived,
        right: failure.right,
      });
    }
  });
  // The 2x on the R ladder stands on host projection: 62 crossings per R5 frame against 17,669 with
  // core's JS mirror (PRD-573 v1.11 step 3). A run that drifts back towards the mirror is refused here,
  // on a counter, before its timing can be read as a regression of something else.
  for (const run of [...left, ...right])
    for (const rung of run.rungs) {
      if (!isRealisticRung(rung.mode) || rung.bridgeCalls === undefined) continue;
      const sorted = [...rung.bridgeCalls].sort((a, b) => a - b);
      const p50 = sorted[Math.floor(sorted.length / 2)] ?? 0;
      if (p50 > HOST_PROJECTION_CROSSING_BUDGET)
        shared.push({
          facet: `${rungKey(rung.mode, rung.objectCount)} crossings per frame (budget ${HOST_PROJECTION_CROSSING_BUDGET})`,
          left: String(p50),
          pass: false,
          right: `<= ${HOST_PROJECTION_CROSSING_BUDGET}`,
        });
    }
  try {
    assertSymmetricSpans(left.flatMap(seriesFamilies), right.flatMap(seriesFamilies), labels);
  } catch {
    shared.push({
      facet: "series families",
      left: [...new Set(left.flatMap(seriesFamilies))].join(","),
      pass: false,
      right: [...new Set(right.flatMap(seriesFamilies))].join(","),
    });
  }
  const visual = visualParity(left, right);
  for (const item of visual)
    shared.push({
      facet: `${item.key} round ${item.round} repeat ${item.repeat} visual${item.error === undefined ? "" : ` ${item.error}`}${item.waived ? " (waived: TN_BENCH_WAIVE=visual)" : ""}`,
      left: item.score === null ? "missing" : item.score.toFixed(4),
      right: `<= ${item.threshold}`,
      pass: item.waived || item.error === undefined,
    });
  const rows = parityRows(left.map(reportFacets), right.map(reportFacets), {
    expected: { "adapter class": "hardware", "frame clock": "moving", vsync: "off" },
    required: ["adapter class", "frame clock", "surface", "vsync"],
    shared,
  });
  const problem = parityProblem(rows, labels);
  return { ...(problem === undefined ? {} : { problem }), rows, visual };
}

export interface IPairRow {
  visual: { score: number | null; threshold: number; waived: boolean };
  key: string;
  left: IRungSummary & { fps: number; fpsLow1: number };
  /** Timing ratios are left over right; FPS is right over left. Above 1 means the right arm is faster. */
  ratio: { cpu?: number; fps: number; p50: number; p95: number; p99: number; threadCpu?: number };
  /** Per phase, the right arm's p50 over the left arm's: below 1 means the right arm spends less there. */
  phaseRatio: Partial<Record<SummaryPhase, number>>;
  right: IRungSummary & { fps: number; fpsLow1: number };
}

/** Frame rates from recorded wall times, with no empty or invalid series accepted. */
export function frameRates(frameMs: readonly number[]): { fps: number; fpsLow1: number } {
  const p99 = percentile(frameMs, 0.99);
  if (frameMs.some((ms) => !Number.isFinite(ms) || ms <= 0))
    throw new BenchError("TN_BENCH_BAD_SHAPE", "frame samples must be finite and positive");
  const mean = frameMs.reduce((sum, ms) => sum + ms / frameMs.length, 0);
  const fps = 1000 / mean;
  const fpsLow1 = 1000 / p99;
  if (!Number.isFinite(fps) || !Number.isFinite(fpsLow1))
    throw new BenchError("TN_BENCH_BAD_SHAPE", "frame rates must be finite");
  return { fps, fpsLow1 };
}

function medianOf(values: readonly number[]): number {
  return percentile(values, 0.5);
}

/** One summary per rung key, medians taken over every run of the arm (and so over its repeats). */
function pooled(runs: readonly IRunReport[]): Map<string, IPairRow["left"]> {
  const byKey = new Map<string, IRungSummary[]>();
  for (const run of runs)
    for (const summary of summarize(run)) {
      const key = rungKey(summary.mode, summary.objectCount);
      byKey.set(key, [...(byKey.get(key) ?? []), summary]);
    }
  const out = new Map<string, IPairRow["left"]>();
  for (const [key, list] of byKey) {
    const first = list[0] as IRungSummary;
    const cpu = list.map((item) => item.cpuMsPerFrame);
    const thread = list.map((item) => item.threadCpuP50);
    const present = list.map((item) => item.presentCpuP50);
    const crossings = list.map((item) => item.crossingsP50);
    const compiles = list.map((item) => item.pipelineCompiles);
    const phases = pooledPhaseStats(list.map((item) => item.phases));
    out.set(key, {
      ...first,
      ...frameRates(
        runs.flatMap((run) =>
          run.rungs
            .filter((rung) => rungKey(rung.mode, rung.objectCount) === key)
            .flatMap((rung) => rung.frameMs),
        ),
      ),
      ...(phases === undefined ? {} : { phases }),
      ...(cpu.every((value) => value !== undefined)
        ? { cpuMsPerFrame: medianOf(cpu as number[]) }
        : {}),
      drawCalls: medianOf(list.map((item) => item.drawCalls)),
      hitches: medianOf(list.map((item) => item.hitches)),
      p50: medianOf(list.map((item) => item.p50)),
      p95: medianOf(list.map((item) => item.p95)),
      p99: medianOf(list.map((item) => item.p99)),
      ...(compiles.every((value) => value !== undefined)
        ? { pipelineCompiles: medianOf(compiles as number[]) }
        : {}),
      repeats: list.reduce((sum, item) => sum + item.repeats, 0),
      ...(thread.every((value) => value !== undefined)
        ? { threadCpuP50: medianOf(thread as number[]) }
        : {}),
      ...(present.every((value) => value !== undefined)
        ? { presentCpuP50: medianOf(present as number[]) }
        : {}),
      ...(crossings.every((value) => value !== undefined)
        ? { crossingsP50: medianOf(crossings as number[]) }
        : {}),
      triangles: medianOf(list.map((item) => item.triangles)),
    });
  }
  return out;
}

/** The comparison rows. Throws unless the parity verdict passed: this is the only door to a ratio. */
export function pairRows(
  left: readonly IRunReport[],
  right: readonly IRunReport[],
  labels: readonly [string, string],
): IPairRow[] {
  const verdict = pairVerdict(left, right, labels);
  const failed = verdict.visual.find((item) => item.error !== undefined && !item.waived);
  if (failed?.error !== undefined)
    throw new BenchError(
      failed.error,
      `${failed.key} round ${failed.round} repeat ${failed.repeat}: visual ${failed.score ?? "missing"} > ${failed.threshold}`,
      1,
    );
  if (verdict.problem !== undefined) throw new BenchError("TN_BENCH_PARITY", verdict.problem, 1);
  const a = pooled(left);
  const b = pooled(right);
  return [...a.keys()]
    .filter((key) => b.has(key))
    .sort()
    .map((key) => {
      const l = a.get(key) as IPairRow["left"];
      const r = b.get(key) as IPairRow["right"];
      const phaseRatio: Partial<Record<SummaryPhase, number>> = {};
      for (const name of SUMMARY_PHASES) {
        const [from, to] = [l.phases?.[name]?.p50, r.phases?.[name]?.p50];
        if (from !== undefined && to !== undefined && from > 0) phaseRatio[name] = to / from;
      }
      const visual = verdict.visual.filter((item) => item.key === key);
      return {
        visual: {
          score: visual.some((item) => item.score === null)
            ? null
            : Math.max(...visual.map((item) => item.score as number)),
          threshold: (visual[0] as IVisualParity).threshold,
          waived: (visual[0] as IVisualParity).waived,
        },
        key,
        left: l,
        phaseRatio,
        ratio: {
          fps: r.fps / l.fps,
          ...(l.cpuMsPerFrame !== undefined && r.cpuMsPerFrame !== undefined && r.cpuMsPerFrame > 0
            ? { cpu: l.cpuMsPerFrame / r.cpuMsPerFrame }
            : {}),
          p50: l.p50 / r.p50,
          p95: l.p95 / r.p95,
          p99: l.p99 / r.p99,
          // The v1.11 KPI: thread CPU without the present call, the same instrument in both arms.
          ...(l.threadCpuP50 !== undefined && r.threadCpuP50 !== undefined && r.threadCpuP50 > 0
            ? { threadCpu: l.threadCpuP50 / r.threadCpuP50 }
            : {}),
        },
        right: r,
      };
    });
}

const f = (value: number | undefined, digits = 2): string =>
  value === undefined ? "n/a" : value.toFixed(digits);

/** The A/B table. Load is per run, so a run taken under load is visible beside its numbers. */
export function renderPairMarkdown(
  left: readonly IRunReport[],
  right: readonly IRunReport[],
  labels: readonly [string, string],
): string {
  const rows = pairRows(left, right, labels);
  const load = (runs: readonly IRunReport[]): string =>
    runs
      .map((run) =>
        run.hostLoad === undefined
          ? "?"
          : `${run.hostLoad.load1.toFixed(1)}${run.hostLoad.absolutes === "valid" ? "" : "!"}`,
      )
      .join(" ");
  const lines = [
    `### ${labels[0]} against ${labels[1]}`,
    "",
    `- host load (1 min, \`!\` = invalid-absolute above half the cores): ${labels[0]} ${load(left)}; ${labels[1]} ${load(right)}`,
    `- ratio is ${labels[0]} over ${labels[1]}: above 1 means ${labels[1]} is cheaper`,
    "",
    ...((process.env.TN_BENCH_WAIVE ?? "").split(",").includes("visual")
      ? ["- WAIVED: TN_BENCH_WAIVE=visual"]
      : []),
    "| rung | arm | p50 ms | p95 ms | p99 ms | fps | 1% low fps | hitches | draws | compiles | cpu ms/frame (inclusive) | thread cpu p50 (no present) | present cpu p50 | crossings p50 | ratio p50 | ratio cpu | ratio thread cpu | visual |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const row of rows) {
    for (const [label, summary] of [
      [labels[0], row.left],
      [labels[1], row.right],
    ] as const)
      lines.push(
        `| ${row.key} | ${label} | ${f(summary.p50)} | ${f(summary.p95)} | ${f(summary.p99)} | ${f(summary.fps)} | ${f(summary.fpsLow1)} | ${summary.hitches} | ${summary.drawCalls} | ${summary.pipelineCompiles ?? "n/a"} | ${f(summary.cpuMsPerFrame)} | ${f(summary.threadCpuP50)} | ${f(summary.presentCpuP50)} | ${summary.crossingsP50 ?? "n/a"} | ${label === labels[1] ? f(row.ratio.p50) : ""} | ${label === labels[1] ? f(row.ratio.cpu) : ""} | ${label === labels[1] ? f(row.ratio.threadCpu) : ""} | ${row.visual.score === null ? "missing" : f(row.visual.score, 4)} / ${row.visual.threshold}${row.visual.waived ? " (waived: TN_BENCH_WAIVE=visual)" : ""} |`,
      );
  }
  lines.push(...renderPhaseBlock(rows, labels));
  return lines.join("\n");
}

/**
 * Where each arm's frame CPU goes: per rung and phase, p50 and mean thread CPU ms per frame for both arms and
 * the right arm's p50 over the left's. The page's five phases and `other` sum to the frame's thread CPU without
 * the present call; `present` is the swap call, which sits outside that figure. A rung where either arm has no
 * phases is left out.
 */
export function renderPhaseBlock(
  rows: readonly IPairRow[],
  labels: readonly [string, string],
): string[] {
  const shown = rows.filter(
    (row) => row.left.phases !== undefined && row.right.phases !== undefined,
  );
  if (shown.length === 0) return [];
  const lines = [
    "",
    "#### Where the frame goes",
    "",
    `${labels.every((label) => label.endsWith("-web")) ? "Main-thread ms per frame on one clock (performance.now(): a page has no thread CPU clock, so this is wall time on the page's thread)" : "Thread cpu ms per frame on one clock (CLOCK_THREAD_CPUTIME_ID)"}. \`other\` is the frame minus the five phases; \`present\` is outside the no-present frame. Ratio is ${labels[1]} over ${labels[0]}, below 1 means ${labels[1]} spends less.`,
    "",
    `| rung | phase | ${labels[0]} p50 | ${labels[0]} mean | ${labels[1]} p50 | ${labels[1]} mean | ratio p50 |`,
    "|---|---|---|---|---|---|---|",
  ];
  for (const row of shown)
    for (const name of SUMMARY_PHASES) {
      const [l, r] = [row.left.phases?.[name], row.right.phases?.[name]];
      if (l === undefined && r === undefined) continue;
      lines.push(
        `| ${row.key} | ${name} | ${f(l?.p50, 3)} | ${f(l?.mean, 3)} | ${f(r?.p50, 3)} | ${f(r?.mean, 3)} | ${f(row.phaseRatio[name])} |`,
      );
    }
  for (const row of shown) {
    const crossings = [
      [labels[0], row.left.crossingTop],
      [labels[1], row.right.crossingTop],
    ] as const;
    for (const [label, top] of crossings)
      if (top !== undefined && top.length > 0)
        lines.push(
          "",
          `Top crossings per frame, ${row.key} ${label}: ${top.map(([name, perFrame]) => `${name} ${perFrame}`).join(", ")}`,
        );
  }
  return lines;
}
