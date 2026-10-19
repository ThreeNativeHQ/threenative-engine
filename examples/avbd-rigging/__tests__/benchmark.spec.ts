import { describe, expect, it, vi } from "vitest";
import { RiggingBenchmark, summarizeRiggingRun } from "../src/physics/benchmark.js";
import type { ISecondaryTickReceipt } from "../src/physics/timing-window.js";
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
const ready = { ready: true, compiling: false, compileCount: 1, census } as const;
function fixture() {
  const generation = {};
  const receipts: ISecondaryTickReceipt[] = [];
  let paused = false;
  let land: (() => void) | undefined;
  let reject: ((error: unknown) => void) | undefined;
  const settled = new Promise<void>((resolve, fail) => {
    land = resolve;
    reject = fail;
  });
  const source = {
    count: () => receipts.length,
    receipt: (index: number) => {
      const receipt = receipts[index];
      if (receipt === undefined) throw new Error("missing tick");
      return receipt;
    },
    settle: vi.fn(() => {
      expect(paused).toBe(true);
      return settled;
    }),
  };
  const benchmark = new RiggingBenchmark(source, () => {
    paused = true;
  });
  const add = () => {
    const tick = receipts.length;
    receipts.push({
      generation,
      tick,
      read: () => ({
        tick,
        cpuSubmissionMs: 0.501,
        diagnosticSubmissionMs: 0,
        gpuLowerMs: 2,
        gpuUpperMs: 3,
        diagnosticTailUpperMs: 0,
        queryIds: [`q:${tick}`],
        phaseMs: [0.5, 0.5, 0.5, 0.5],
      }),
    });
  };
  const fill = (readiness = ready) => {
    for (let frame = 0; frame < 2100; frame++) {
      add();
      benchmark.render((frame * 1000) / 60, false, readiness);
    }
  };
  return { benchmark, source, add, fill, land, reject, isPaused: () => paused };
}
describe("paired benchmark on the existing render/fixed callbacks", () => {
  it("counts no readiness frames before a real fixed receipt, then pauses before settling exact windows", async () => {
    const f = fixture();
    expect(f.benchmark.render(0, false, ready)).toBeUndefined();
    expect(f.benchmark.frames).toBe(0);
    f.fill();
    expect(f.benchmark.frames).toBe(2100);
    expect(f.isPaused()).toBe(true);
    expect(f.source.settle).toHaveBeenCalledOnce();
    expect(f.benchmark.render(35000, true, ready)).toBeUndefined();
    f.land?.();
    await Promise.resolve();
    const rows = f.benchmark.render(35001, true, ready);
    expect(rows).toHaveLength(1800);
    const summary = summarizeRiggingRun(rows ?? []);
    expect(summary).toMatchObject({
      measuredFrames: 1800,
      activeFrames: 1800,
      zeroTickFrames: 0,
      measuredTicks: 1800,
      firstTick: 300,
      lastTick: 2099,
      cpuSubmissionP95: 0.501,
      activeFrameCpuSubmissionP95: 0.501,
      fixedTickCpuSubmissionP95: 0.501,

      gpuLowerP95: 2,
      phaseSumP95: 2,
    });
    expect(summary.coveredRenderCallbackMs).toBeCloseTo(30000, 8);
    expect(f.benchmark.render(35002, true, ready)).toBeUndefined();
  });
  it("rejects any fixed dispatch after sealing even when the maps have not yet completed", () => {
    const f = fixture();
    f.fill();
    f.add();
    expect(() => f.benchmark.render(35000, true, ready)).toThrow(/TN_RIGGING_TIMING_SEALED/);
  });
  it("keeps asynchronous undefined failures permanently invalid rather than producing zero cost", async () => {
    const f = fixture();
    f.fill();
    f.reject?.(undefined);
    await Promise.resolve();
    for (let i = 0; i < 2; i++) {
      let failed = false;
      try {
        f.benchmark.render(35000 + i, true, ready);
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
    }
  });
  it("never publishes a late settled window from a retired scene", async () => {
    const f = fixture();
    f.fill();
    f.benchmark.retire();
    f.land?.();
    await Promise.resolve();
    expect(() => f.benchmark.render(35000, true, ready)).toThrow(/TN_RIGGING_TIMING_STALE/);
  });
});

it("admits no frame until readiness is observed and preserves actual fixed-tick identities", () => {
  const f = fixture();
  for (let tick = 0; tick < 12; tick++) f.add();
  expect(f.benchmark.render(200, false, { ...ready, ready: false })).toBeUndefined();
  expect(f.benchmark.frames).toBe(0);
  expect(f.benchmark.render(217, false, ready)).toBeUndefined();
  expect(f.benchmark.frames).toBe(1);
});
it("rejects compilation or loss of readiness inside the post-ready measured interval", () => {
  for (const mode of ["compiling", "count", "ready"]) {
    const f = fixture();
    for (let frame = 0; frame < 300; frame++) {
      f.add();
      f.benchmark.render((frame * 1000) / 60, false, {
        ...ready,
      });
    }
    f.add();
    expect(() =>
      f.benchmark.render(5000, false, {
        ...ready,
        ready: mode !== "ready",
        compiling: mode === "compiling",
        compileCount: mode === "count" ? 2 : 1,
      }),
    ).toThrow(/TN_RIGGING_TIMING_READINESS/);
  }
});

it.each(["creation", "failure", "pending", "overflow", "incomplete", "device"])(
  "rejects %s census changes even when explicit compileCount stays unchanged",
  (mode) => {
    const f = fixture();
    f.add();
    f.benchmark.render(0, false, ready);
    f.add();
    const changed = { ...census, counts: { ...census.counts } };
    if (mode === "creation") changed.counts.creations++;
    if (mode === "failure") changed.counts.failures++;
    if (mode === "pending") changed.counts.pending++;
    if (mode === "overflow") changed.overflowed = true;
    if (mode === "incomplete") changed.complete = false;
    if (mode === "device") changed.counts.deviceCreations++;
    expect(() => f.benchmark.render(1000 / 60, false, { ...ready, census: changed })).toThrow(
      /TN_RIGGING_TIMING_READINESS/,
    );
  },
);

it("saves counts-only census rows when the public source contains its full event history", async () => {
  const f = fixture();
  const fullCensus = {
    ...census,
    events: [{ sentinel: "must-not-repeat" }],
    build: { identity: "full-source" },
  };
  f.fill({ ...ready, census: fullCensus });
  f.land?.();
  await Promise.resolve();
  const rows = f.benchmark.render(35001, true, ready);
  expect(rows).toHaveLength(1800);
  expect(rows?.[0]?.compilation?.census.counts.creations).toBe(2);
  expect(JSON.stringify(rows)).not.toContain("must-not-repeat");
  expect(Object.keys(rows?.[0]?.compilation?.census ?? {}).sort()).toEqual([
    "complete",
    "counts",
    "overflowed",
    "unsupported",
  ]);
});
