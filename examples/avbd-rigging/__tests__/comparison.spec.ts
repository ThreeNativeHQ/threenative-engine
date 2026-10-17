import { expect, it } from "vitest";
import { riggingComparison, riggingRuns, summarizeRiggingRun } from "../src/physics/benchmark.js";
import { qualifyRiggingTiming } from "../verify-comparison.js";

function fixture(cpu = 0.2, springLower = 2.8) {
  const census = {
    complete: true,
    overflowed: false,
    unsupported: false,
    counts: {
      lookups: 0,
      creations: 2,
      failures: 0,
      pending: 0,
      uniquePrograms: 2,
      uniquePipelines: 2,
      recordedEvents: 2,
      droppedEvents: 0,
      nodeBuilds: 0,
      deviceCreations: 2,
      directCreations: 0,
    },
  };
  const entries: { text: string; type: string }[] = [];
  const emit = (marker: string, value: unknown) =>
    entries.push({ type: "log", text: `${marker}:${JSON.stringify(value)}` });
  emit("TN_AVBD_BENCHMARK_PLAN", { frozen: riggingComparison, runs: riggingRuns });
  for (const [runIndex, run] of riggingRuns.entries()) {
    const offset = runIndex * 50000;
    const readiness = {
      run: run.id,
      clock: { mode: "wall-clock", tick: 100, timeMs: offset + 900 },
      warmup: {
        unsupported: false,
        timedOut: false,
        abandoned: 0,
        observed: { status: "complete", failed: 0, pending: 0 },
      },
      startup: { phase: "ready", compileSettled: true },
      compiling: false,
      compileCount: 1,
    };
    emit("TN_AVBD_TIMING_READY", readiness);
    const rows = Array.from({ length: 1800 }, (_, index) => {
      const tick = index + 300;
      const lower = run.arm === "candidate" ? 2 : springLower;
      const upper = Math.max(3, lower + 0.1);
      const sample = {
        tick,
        cpuSubmissionMs: cpu,
        diagnosticSubmissionMs: run.diagnostics ? 0.1 : 0,
        gpuLowerMs: lower,
        gpuUpperMs: upper,
        diagnosticTailUpperMs: run.diagnostics ? 0.1 : 0,
        queryIds:
          run.arm === "candidate"
            ? Array.from({ length: 11 }, (_, stamp) => `${run.id}:candidate:${tick}:stamp:${stamp}`)
            : Array.from({ length: 4 }, (_, pass) => `${run.id}:spring:${tick}-${pass}`),
        phaseMs: run.arm === "spring" ? [springLower, 0.5, 0.5, 0.5] : [0.5, 0.5, 0.5, 0.5],
      };
      return {
        frame: tick,
        renderCallbackAtMs: offset + 1000 + (tick * 1000) / 60,
        renderCallbackElapsedMs: 1000 / 60,
        ticks: [sample],
        cpuSubmissionMs: cpu,
        diagnosticSubmissionMs: sample.diagnosticSubmissionMs,
        gpuLowerMs: lower,
        gpuUpperMs: upper,
        diagnosticTailUpperMs: sample.diagnosticTailUpperMs,
        compilation: { compileCount: 1, census },
      };
    });
    for (let chunk = 0; chunk < 15; chunk++)
      emit("TN_AVBD_TIMING_ROWS", {
        run: run.id,
        chunk,
        chunks: 15,
        rows: rows.slice(chunk * 120, (chunk + 1) * 120),
      });
    const quality = {
      sailStretchP95: run.arm === "candidate" ? 0.02 : 0.04,
      sailEdgeErrorP95: run.arm === "candidate" ? 0.02 : 0.04,
      fixedStep: 2100,
      staleTicks: 0,
      bytes: run.arm === "candidate" ? 245760 : 20480,
      ropeExtensionMaximum: run.arm === "candidate" ? 0.01 : null,
      proxyPenetration: run.arm === "candidate" ? 0.001 : null,
    };
    emit("TN_AVBD_TIMING_RESULT", {
      run,
      summary: summarizeRiggingRun(rows),
      quality,
      frozen: riggingComparison,
      readiness,
      admission: { firstTick: 0, skippedReceipts: 0, atMs: offset + 1000 },
    });
  }
  return entries;
}
it("checks complete raw rows and reports both conservative branches without manufacturing overall GO", () => {
  const result = qualifyRiggingTiming(fixture());
  expect(result.performanceDisposition).toBe("PASS");
  expect(result.pairs).toHaveLength(3);
  expect(result.pairs.every((pair) => pair.matchedQualitySpeed === "PASS")).toBe(true);
  expect(result.pairs.every((pair) => pair.matchedBudgetStretch === "INCONCLUSIVE")).toBe(true);
  expect(result.overallDisposition).toBe(
    "requires separate browser/native correctness and lifecycle evidence",
  );
});
it.each(["missing", "duplicate", "window", "query", "clock", "summary", "revision", "census"])(
  "rejects malformed %s evidence before any performance verdict",
  (mode) => {
    const entries = fixture();
    const index = entries.findIndex((entry) => entry.text.startsWith("TN_AVBD_TIMING_ROWS:"));
    const entry = entries[index];
    if (entry === undefined) throw Error("missing fixture");
    const data = JSON.parse(entry.text.slice("TN_AVBD_TIMING_ROWS:".length));
    if (mode === "missing") entries.splice(index, 1);
    if (mode === "duplicate") entries.push(entry);
    if (mode === "window") data.rows[0].frame = 301;
    if (mode === "query") data.rows[1].ticks[0].queryIds = data.rows[0].ticks[0].queryIds;
    if (mode === "census") data.rows[1].compilation.census.counts.creations++;
    if (["window", "query", "census"].includes(mode))
      entry.text = `TN_AVBD_TIMING_ROWS:${JSON.stringify(data)}`;
    if (mode === "clock" || mode === "summary" || mode === "revision") {
      const r = entries.find((value) => value.text.startsWith("TN_AVBD_TIMING_RESULT:"));
      if (r === undefined) throw Error("missing result fixture");
      const value = JSON.parse(r.text.slice("TN_AVBD_TIMING_RESULT:".length));
      if (mode === "clock") value.readiness.clock.mode = "fixed-step";
      if (mode === "summary") value.summary.gpuLowerP95 = 0;
      if (mode === "revision") value.frozen.solver = "other-revision";
      r.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
    }
    expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
  },
);
it("fails the original full-precision CPU bar instead of rounding 0.501 ms to a pass", () => {
  expect(qualifyRiggingTiming(fixture(0.501)).performanceDisposition).toBe("FAIL");
});
it.each([
  "spring lower",
  "candidate phase",
  "zero phase",
  "future quality",
  "failure marker",
  "marker order",
  "ready time",
  "ready compile",
  "overlapping runs",
])("rejects the reviewed %s evidence defect", (mode) => {
  const entries = fixture();
  if (mode === "failure marker")
    entries.push({ type: "error", text: "TN_AVBD_BENCHMARK_FAILED:invalid state" });
  if (mode === "marker order") {
    const [ready] = entries.splice(1, 1);
    if (ready === undefined) throw Error("missing readiness fixture");
    entries.splice(16, 0, ready);
  }
  for (const entry of entries) {
    const separator = entry.text.indexOf(":");
    if (entry.text.startsWith("TN_AVBD_BENCHMARK_FAILED:")) continue;
    const value = JSON.parse(entry.text.slice(separator + 1));
    if (entry.text.startsWith("TN_AVBD_TIMING_ROWS:") && value.chunk === 0) {
      const row = value.rows[0];
      const tick = row.ticks[0];
      if (mode === "spring lower" && value.run === "pair1-spring")
        row.gpuLowerMs = tick.gpuLowerMs = 3;
      if (mode === "candidate phase" && value.run === "pair1-candidate") tick.phaseMs[0] = 2.5;
      if (mode === "zero phase" && value.run === "pair1-candidate") tick.phaseMs[0] = 0;
    }
    if (entry.text.startsWith("TN_AVBD_TIMING_RESULT:") && mode === "future quality")
      value.quality.fixedStep++;
    const ready = entry.text.startsWith("TN_AVBD_TIMING_READY:")
      ? value
      : entry.text.startsWith("TN_AVBD_TIMING_RESULT:")
        ? value.readiness
        : undefined;
    if (ready?.run === "pair1-candidate") {
      if (mode === "ready time") ready.clock.timeMs = 6000;
      if (mode === "ready compile") ready.compileCount = 2;
    }
    if (ready?.run === "pair1-spring" && mode === "overlapping runs") ready.clock.timeMs = 2000;
    entry.text = `${entry.text.slice(0, separator + 1)}${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it("does not award relative stretch improvement over a zero baseline", () => {
  const entries = fixture(0.2, 3);
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_RESULT:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
    value.quality.sailStretchP95 = 0;
    entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  }
  const result = qualifyRiggingTiming(entries);
  expect(result.pairs.every((pair) => pair.matchedBudgetStretch === "FAIL")).toBe(true);
});
it("rejects each common branch when a different pair disproves it", () => {
  const entries = fixture();
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_RESULT:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
    if (value.run.id === "pair1-candidate") value.quality.sailEdgeErrorP95 = 0.05;
    if (value.run.id === "pair2-candidate") value.quality.sailStretchP95 = 0.04;
    entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  }
  const result = qualifyRiggingTiming(entries);
  expect(result.pairs[0]?.matchedQualitySpeed).toBe("FAIL");
  expect(result.pairs[1]?.matchedBudgetStretch).toBe("FAIL");
  expect(result.usefulTradeoff).toBe("FAIL");
});
it("rejects a diagnostic tail outside its candidate queue envelope", () => {
  const entries = fixture();
  for (const entry of entries) {
    const prefix = entry.text.slice(0, entry.text.indexOf(":") + 1);
    const value = JSON.parse(entry.text.slice(prefix.length));
    if (prefix === "TN_AVBD_TIMING_ROWS:" && value.run === "candidate-diagnostics")
      for (const row of value.rows)
        row.diagnosticTailUpperMs = row.ticks[0].diagnosticTailUpperMs = 1.1;
    if (prefix === "TN_AVBD_TIMING_RESULT:" && value.run.id === "candidate-diagnostics")
      value.summary.diagnosticTailQueueUpperP95 = 1.1;
    entry.text = `${prefix}${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it("rejects negative producer clock ticks", () => {
  const entries = fixture();
  for (const entry of entries) {
    const prefix = entry.text.slice(0, entry.text.indexOf(":") + 1);
    const value = JSON.parse(entry.text.slice(prefix.length));
    if (prefix === "TN_AVBD_TIMING_READY:") value.clock.tick = -1;
    if (prefix === "TN_AVBD_TIMING_RESULT:") value.readiness.clock.tick = -1;
    entry.text = `${prefix}${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it("rejects admission inside the first included render interval", () => {
  const entries = fixture();
  const entry = entries.find((value) => value.text.startsWith("TN_AVBD_TIMING_RESULT:"));
  if (entry === undefined) throw Error("missing fixture");
  const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
  value.admission.atMs = 5999;
  entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it("rejects zero-duration p95 ratios from mostly empty measured frames", () => {
  const entries = fixture();
  const rowsByRun = new Map<string, Parameters<typeof summarizeRiggingRun>[0]>();
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_ROWS:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_ROWS:".length));
    const offset = riggingRuns.findIndex((run) => run.id === value.run) * 50000;
    for (const row of value.rows) {
      row.renderCallbackElapsedMs = 0.001;
      row.renderCallbackAtMs = offset + 1000 + (row.frame - 299) * 0.001;
      if (row.frame !== 300) {
        row.ticks = [];
        for (const key of [
          "cpuSubmissionMs",
          "diagnosticSubmissionMs",
          "gpuLowerMs",
          "gpuUpperMs",
          "diagnosticTailUpperMs",
        ])
          row[key] = 0;
      }
    }
    rowsByRun.set(value.run, [...(rowsByRun.get(value.run) ?? []), ...value.rows]);
    entry.text = `TN_AVBD_TIMING_ROWS:${JSON.stringify(value)}`;
  }
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_RESULT:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
    const rows = rowsByRun.get(value.run.id);
    if (rows === undefined) throw Error("missing fixture");
    value.summary = summarizeRiggingRun(rows);
    value.quality.fixedStep = 301;
    value.admission.atMs -= 1;
    entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it.each(["gpu", "stretch"])("rejects nonfinite derived %s ratios", (mode) => {
  const entries = fixture();
  const rows: Parameters<typeof summarizeRiggingRun>[0][number][] = [];
  for (const entry of entries) {
    const prefix = entry.text.slice(0, entry.text.indexOf(":") + 1);
    const value = JSON.parse(entry.text.slice(prefix.length));
    if (mode === "gpu" && prefix === "TN_AVBD_TIMING_ROWS:" && value.run === "pair1-spring") {
      for (const row of value.rows) {
        row.gpuLowerMs = row.ticks[0].gpuLowerMs = 1e-320;
        row.ticks[0].phaseMs = [1e-320, 1e-320, 1e-320, 1e-320];
      }
      rows.push(...value.rows);
    }
    if (prefix === "TN_AVBD_TIMING_RESULT:" && value.run.id === "pair1-spring") {
      if (mode === "gpu") value.summary = summarizeRiggingRun(rows);
      else value.quality.sailStretchP95 = 1e-320;
    }
    entry.text = `${prefix}${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it.each(["cpu", "gpu"])("rejects rounded frame %s costs at the original bar", (mode) => {
  const entries = fixture(mode === "cpu" ? 0.5000000005 : 0.2, mode === "gpu" ? 4 : 2.8);
  const rowsByRun = new Map<string, Parameters<typeof summarizeRiggingRun>[0]>();
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_ROWS:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_ROWS:".length));
    for (const row of value.rows) {
      if (mode === "cpu") row.cpuSubmissionMs = 0.5;
      else if (value.run.includes("candidate")) {
        row.gpuUpperMs = 4;
        row.ticks[0].gpuUpperMs = 4.0000000005;
      }
    }
    rowsByRun.set(value.run, [...(rowsByRun.get(value.run) ?? []), ...value.rows]);
    entry.text = `TN_AVBD_TIMING_ROWS:${JSON.stringify(value)}`;
  }
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_RESULT:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
    const rows = rowsByRun.get(value.run.id);
    if (rows === undefined) throw Error("missing fixture");
    value.summary = summarizeRiggingRun(rows);
    entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  }
  expect(() => qualifyRiggingTiming(entries)).toThrow(/TN_AVBD_COMPARISON/);
});
it("does not award25percent improvement to equal positive subnormal stretches", () => {
  const entries = fixture(0.2, 3);
  for (const entry of entries) {
    if (!entry.text.startsWith("TN_AVBD_TIMING_RESULT:")) continue;
    const value = JSON.parse(entry.text.slice("TN_AVBD_TIMING_RESULT:".length));
    value.quality.sailStretchP95 = Number.MIN_VALUE;
    if (value.run.arm === "candidate") value.quality.sailEdgeErrorP95 = 0.05;
    entry.text = `TN_AVBD_TIMING_RESULT:${JSON.stringify(value)}`;
  }
  const result = qualifyRiggingTiming(entries);
  expect(result.pairs.every((pair) => pair.matchedBudgetStretch === "FAIL")).toBe(true);
  expect(result.performanceDisposition).toBe("FAIL");
});
