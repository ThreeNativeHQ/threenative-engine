import { isDeepStrictEqual } from "node:util";
import {
  type IRiggingRun,
  riggingComparison,
  riggingRuns,
  summarizeRiggingRun,
} from "./src/physics/benchmark.js";
import type { ISecondaryFrameSample } from "./src/physics/timing-window.js";
import { requiredAt } from "./src/physics/vendor/required-at.js";

type Disposition = "PASS" | "FAIL" | "INCONCLUSIVE";
function requireEvidence(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`TN_AVBD_COMPARISON: ${message}`);
}
function record(value: unknown): Record<string, unknown> {
  requireEvidence(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "missing object observation",
  );
  return value as Record<string, unknown>;
}
function number(value: unknown, name: string): number {
  requireEvidence(
    typeof value === "number" && Number.isFinite(value) && value >= 0,
    `invalid ${name}`,
  );
  return value;
}
function array(value: unknown, size?: number): unknown[] {
  requireEvidence(
    Array.isArray(value) && (size === undefined || value.length === size),
    "incomplete array observation",
  );
  requireEvidence(
    Array.from(value).every((item) => item !== undefined),
    "sparse array observation",
  );
  return value;
}
const costs = [
  "cpuSubmissionMs",
  "diagnosticSubmissionMs",
  "gpuLowerMs",
  "gpuUpperMs",
  "diagnosticTailUpperMs",
] as const;
function pipelineIdentity(value: unknown): string {
  const compilation = record(value);
  const census = record(compilation.census);
  const counts = record(census.counts);
  requireEvidence(
    Number.isSafeInteger(compilation.compileCount) &&
      number(compilation.compileCount, "compile count") >= 0,
    "missing compile count",
  );
  requireEvidence(
    census.complete === true &&
      census.overflowed === false &&
      census.unsupported === false &&
      counts.failures === 0 &&
      counts.pending === 0 &&
      counts.droppedEvents === 0,
    "incomplete pipeline census",
  );
  const identity = [
    compilation.compileCount,
    ...[
      "creations",
      "uniquePrograms",
      "uniquePipelines",
      "recordedEvents",
      "deviceCreations",
      "directCreations",
    ].map((key) => {
      const observed = number(counts[key], `pipeline ${key}`);
      requireEvidence(Number.isSafeInteger(observed), "fractional pipeline counter");
      return observed;
    }),
  ];
  return JSON.stringify(identity);
}
function readiness(value: unknown, run: IRiggingRun): Record<string, unknown> {
  const observed = record(value);
  const clock = record(observed.clock);
  const warmup = record(observed.warmup);
  const compilation = record(warmup.observed);
  const startup = record(observed.startup);
  requireEvidence(
    observed.run === run.id && clock.mode === "wall-clock" && Number.isSafeInteger(clock.tick),
    "missing actual live producer clock",
  );
  number(clock.tick, "clock tick");
  number(clock.timeMs, "clock time");
  requireEvidence(
    warmup.unsupported === false &&
      warmup.timedOut === false &&
      warmup.abandoned === 0 &&
      compilation.status === "complete" &&
      compilation.failed === 0 &&
      compilation.pending === 0 &&
      startup.phase === "ready" &&
      startup.compileSettled === true &&
      observed.compiling === false,
    "incomplete post-ready warmup",
  );
  return observed;
}
function checkedRows(value: unknown, run: IRiggingRun): readonly ISecondaryFrameSample[] {
  const rows = array(value, 1800);
  const queries = new Set<string>();
  let previousTick: number | undefined;
  let previousAt: number | undefined;
  let identity: string | undefined;
  let tickCount = 0;
  let elapsed = 0;
  for (const [index, value] of rows.entries()) {
    const row = record(value);
    const at = number(row.renderCallbackAtMs, "render callback");
    const interval = number(row.renderCallbackElapsedMs, "render interval");
    requireEvidence(
      row.frame === index + 300 && interval > 0 && (previousAt === undefined || at > previousAt),
      "missing or reordered measured render frame",
    );
    if (previousAt !== undefined)
      requireEvidence(
        Math.abs(at - previousAt - interval) < 1e-6,
        "render interval does not reproduce raw boundary",
      );
    previousAt = at;
    elapsed += interval;
    const currentIdentity = pipelineIdentity(row.compilation);
    identity ??= currentIdentity;
    requireEvidence(currentIdentity === identity, "pipeline creation changed in measured window");
    const ticks = array(row.ticks);
    requireEvidence(ticks.length <= 5, "fixed catch-up capacity exceeded");
    const lower: number[] = [];
    const sums = Object.fromEntries(costs.map((key) => [key, 0])) as Record<
      (typeof costs)[number],
      number
    >;
    for (const value of ticks) {
      const tick = record(value);
      const id = number(tick.tick, "fixed tick");
      requireEvidence(
        Number.isSafeInteger(id) &&
          id <= 12000 &&
          (previousTick === undefined || id === previousTick + 1),
        "missing or duplicated fixed tick",
      );
      previousTick = id;
      tickCount++;
      for (const key of costs) sums[key] += number(tick[key], key);
      requireEvidence(
        number(tick.gpuLowerMs, "GPU lower") > 0 &&
          number(tick.gpuUpperMs, "GPU upper") >= number(tick.gpuLowerMs, "GPU lower"),
        "invalid mandatory GPU interval",
      );
      requireEvidence(
        run.arm !== "candidate" ||
          number(tick.gpuUpperMs, "GPU upper") + 1e-9 >=
            number(tick.gpuLowerMs, "GPU lower") +
              number(tick.diagnosticTailUpperMs, "diagnostic tail"),
        "candidate queue envelope does not contain solver and diagnostic intervals",
      );
      lower.push(number(tick.gpuLowerMs, "GPU lower"));
      const phases = array(tick.phaseMs, 4).map((phase) => number(phase, "GPU phase"));
      requireEvidence(
        phases.every((phase) => phase > 0) &&
          (run.arm === "spring"
            ? tick.gpuLowerMs === Math.max(...phases)
            : number(tick.gpuLowerMs, "GPU lower") + 1e-9 >= phases.reduce((a, b) => a + b, 0)),
        "mandatory phase durations do not support the GPU lower bound",
      );
      const ids = array(tick.queryIds, run.arm === "candidate" ? 11 : 4);
      for (const [stamp, value] of ids.entries()) {
        requireEvidence(
          typeof value === "string" && value.length > 0 && !queries.has(value),
          "duplicate or missing GPU query",
        );
        requireEvidence(
          run.arm === "candidate"
            ? value === `${run.id}:candidate:${id}:stamp:${stamp}`
            : value.startsWith(`${run.id}:spring:`),
          "GPU query belongs to another arm",
        );
        queries.add(value);
      }
      requireEvidence(
        run.diagnostics || tick.diagnosticSubmissionMs === 0,
        "optional diagnostics entered primary submission",
      );
    }
    sums.gpuLowerMs = Math.max(0, ...lower);
    for (const key of costs)
      requireEvidence(
        number(row[key], key) === sums[key],
        `frame ${key} differs from actual fixed receipts`,
      );
  }
  requireEvidence(
    tickCount > 0 && Math.abs(tickCount - (elapsed * 60) / 1000) <= 5,
    "fixed ticks do not cover measured live elapsed time",
  );
  return rows as unknown as readonly ISecondaryFrameSample[];
}
function branch(pass: boolean, fail: boolean): Disposition {
  return pass ? "PASS" : fail ? "FAIL" : "INCONCLUSIVE";
}

/** Consumes the existing runner console artifact; missing proof throws and cannot become NO-GO. */
export function qualifyRiggingTiming(value: unknown) {
  const entries = array(value);
  requireEvidence(entries.length <= 30000, "console artifact exceeds bounded capacity");
  const observed = new Map<string, Record<string, unknown>[]>();
  const markers: string[] = [];
  for (const entry of entries) {
    const text = record(entry).text;
    requireEvidence(typeof text === "string", "console text is absent");
    requireEvidence(
      !text.includes("TN_AVBD_BENCHMARK_FAILED:"),
      "producer reported benchmark failure",
    );
    const match = /TN_AVBD_(BENCHMARK_PLAN|TIMING_READY|TIMING_ROWS|TIMING_RESULT):/.exec(text);
    if (match === null) continue;
    requireEvidence(text.length <= 2 * 1024 * 1024, "timing console row exceeds bounded capacity");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.slice(match.index + match[0].length));
    } catch (cause) {
      throw new Error("TN_AVBD_COMPARISON: malformed timing console JSON", { cause });
    }
    const marker = match[1];
    requireEvidence(marker !== undefined, "missing console marker");
    markers.push(marker);
    const values = observed.get(marker) ?? [];
    values.push(record(parsed));
    observed.set(marker, values);
  }
  const plans = observed.get("BENCHMARK_PLAN") ?? [];
  const ready = observed.get("TIMING_READY") ?? [];
  const chunks = observed.get("TIMING_ROWS") ?? [];
  const results = observed.get("TIMING_RESULT") ?? [];
  requireEvidence(
    plans.length === 1 && ready.length === 7 && chunks.length === 105 && results.length === 7,
    "all seven complete independently identified windows are required",
  );
  requireEvidence(
    isDeepStrictEqual(plans[0], { frozen: riggingComparison, runs: riggingRuns }),
    "frozen workload or solver revision changed",
  );
  requireEvidence(
    isDeepStrictEqual(markers, [
      "BENCHMARK_PLAN",
      ...riggingRuns.flatMap(() => [
        "TIMING_READY",
        ...Array.from({ length: 15 }, () => "TIMING_ROWS"),
        "TIMING_RESULT",
      ]),
    ]),
    "producer markers are reordered or interleaved",
  );
  let previousEndMs = -1;
  const runs = riggingRuns.map((run, runIndex) => {
    const result = record(results[runIndex]);
    requireEvidence(
      isDeepStrictEqual(result.run, run) && isDeepStrictEqual(result.frozen, riggingComparison),
      "run order or frozen workload changed",
    );
    const readyReceipt = readiness(result.readiness, run);
    requireEvidence(
      isDeepStrictEqual(ready[runIndex], readyReceipt),
      "readiness receipt changed before publication",
    );
    const rows = checkedRows(
      chunks.slice(runIndex * 15, (runIndex + 1) * 15).flatMap((chunk, index) => {
        requireEvidence(
          chunk.run === run.id && chunk.chunk === index && chunk.chunks === 15,
          "missing, duplicate or reordered timing chunk",
        );
        return array(chunk.rows, 120);
      }),
      run,
    );
    const summary = summarizeRiggingRun(rows);
    requireEvidence(
      isDeepStrictEqual(result.summary, summary),
      "summary differs from full-precision raw rows",
    );
    requireEvidence(
      number(summary.gpuLowerP95, "GPU lower p95") > 0 &&
        number(summary.gpuQueueUpperP95, "GPU upper p95") >= summary.gpuLowerP95,
      "positive measured GPU p95 bounds are required before comparison",
    );
    const admission = record(result.admission);
    const quality = record(result.quality);
    requireEvidence(
      Number.isSafeInteger(admission.firstTick) && Number.isSafeInteger(admission.skippedReceipts),
      "missing admission boundary",
    );
    const firstTick = number(admission.firstTick, "first admitted tick");
    requireEvidence(
      firstTick <= 12000 &&
        admission.skippedReceipts === firstTick &&
        firstTick <= summary.firstTick,
      "admission tick boundary changed",
    );
    const firstRow = requiredAt(rows, 0);
    const readyAtMs = number(record(readyReceipt.clock).timeMs, "ready time");
    requireEvidence(
      readyAtMs > previousEndMs &&
        number(admission.atMs, "admission time") >= readyAtMs &&
        number(admission.atMs, "admission time") <=
          firstRow.renderCallbackAtMs - firstRow.renderCallbackElapsedMs &&
        readyReceipt.compileCount === firstRow.compilation?.compileCount,
      "readiness/admission does not identify a sequential post-ready measured window",
    );
    requireEvidence(
      quality.staleTicks === 0 &&
        Number.isSafeInteger(quality.fixedStep) &&
        number(quality.fixedStep, "observed step") === summary.lastTick + 1,
      "final physical observation is stale or predates timing",
    );
    const bytes = number(quality.bytes, "readback bytes");
    requireEvidence(
      Number.isSafeInteger(bytes) && bytes > 0,
      "physical readback byte count is absent",
    );
    const stretch = number(quality.sailStretchP95, "sail p95 stretch");
    const error = number(quality.sailEdgeErrorP95, "sail p95 constraint error");
    if (run.arm === "candidate") {
      number(quality.ropeExtensionMaximum, "rope extension");
      number(quality.proxyPenetration, "proxy depth");
    } else
      requireEvidence(
        quality.ropeExtensionMaximum === null && quality.proxyPenetration === null,
        "spring arm falsely claims ropes/proxy measurements",
      );
    previousEndMs = requiredAt(rows, 1799).renderCallbackAtMs;
    return { run, summary, quality, stretch, error };
  });
  const pairs = [1, 2, 3].map((pair) => {
    const candidate = runs.find(
      (result) => result.run.pair === pair && result.run.arm === "candidate",
    );
    const spring = runs.find((result) => result.run.pair === pair && result.run.arm === "spring");
    requireEvidence(
      candidate !== undefined && spring !== undefined,
      "missing primary paired workload",
    );
    const c = candidate.summary;
    const s = spring.summary;
    const gpuRatioBounds = [
      number(c.gpuLowerP95 / s.gpuQueueUpperP95, "GPU ratio lower"),
      number(c.gpuQueueUpperP95 / s.gpuLowerP95, "GPU ratio upper"),
    ] as const;
    const stretchRatio =
      spring.stretch === 0 ? null : number(candidate.stretch / spring.stretch, "stretch ratio");
    return {
      pair,
      candidate: candidate.run.id,
      spring: spring.run.id,
      matchedQualitySpeed: branch(
        candidate.error <= spring.error && gpuRatioBounds[1] <= 1.1,
        candidate.error > spring.error || gpuRatioBounds[0] > 1.1,
      ),
      matchedBudgetStretch: branch(
        stretchRatio !== null && gpuRatioBounds[1] <= 1 && stretchRatio <= 0.75,
        stretchRatio === null || gpuRatioBounds[0] > 1 || stretchRatio > 0.75,
      ),
      gpuRatioBounds,
      stretchRatio,
      absoluteGpu: branch(c.gpuQueueUpperP95 <= 4, c.gpuLowerP95 > 4),
      cpuSubmission: branch(c.cpuSubmissionP95 <= 0.5, c.cpuSubmissionP95 > 0.5),
      comparisonQuality: branch(candidate.stretch <= 0.05, candidate.stretch > 0.05),
    };
  });
  const usefulTradeoff = branch(
    pairs.every((pair) => pair.matchedQualitySpeed === "PASS") ||
      pairs.every((pair) => pair.matchedBudgetStretch === "PASS"),
    pairs.some((pair) => pair.matchedQualitySpeed === "FAIL") &&
      pairs.some((pair) => pair.matchedBudgetStretch === "FAIL"),
  );
  const requirements = [
    usefulTradeoff,
    ...pairs.flatMap((pair) => [pair.absoluteGpu, pair.cpuSubmission, pair.comparisonQuality]),
  ];
  const performanceDisposition: Disposition = requirements.includes("FAIL")
    ? "FAIL"
    : requirements.every((result) => result === "PASS")
      ? "PASS"
      : "INCONCLUSIVE";
  return {
    performanceDisposition,
    usefulTradeoff,
    pairs,
    runs,
    diagnostics: runs.find((result) => result.run.diagnostics),
    overallDisposition: "requires separate browser/native correctness and lifecycle evidence",
    bounds:
      "queue elapsed upper and maximum mandatory interval lower; phase/tick sums alone decide no GPU bar",
  };
}
