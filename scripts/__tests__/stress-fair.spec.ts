import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const {
  abba,
  closeStrayPages,
  fileName,
  parseArm,
  poolRuns,
  holdoutOf,
  holdoutReport,
  presentedFromStarts,
  saveRun,
  waitGpuIdle,
  waitQuiet,
} = await import(new URL("../stress-fair.mjs", import.meta.url).href);

/** A clock and a /proc/loadavg stub: one reading per `pollMs` step. */
const clock = (loads: number[]) => {
  let at = 0;
  let index = 0;
  return {
    now: () => at,
    readLoad: () => loads[Math.min(index++, loads.length - 1)],
    wait: async (ms: number) => {
      at += ms;
    },
  };
};

describe("stress-fair (PRD-770)", () => {
  it("orders the arms ABBA", () => {
    expect(abba(["a", "b"])).toEqual(["a", "b", "b", "a"]);
    expect(abba(["a", "b", "c"])).toEqual(["a", "b", "c", "c", "b", "a"]);
  });

  it("reads engine=url and takes the URL flags as the variant", () => {
    expect(parseArm("threenative-wasm=http://x:5740/main.html?stress&plainShadow")).toMatchObject({
      engine: "threenative-wasm",
      variant: "plainShadow",
    });
    expect(parseArm("three-vanilla=http://x:5736/main.html?stress").variant).toBe("stress");
    expect(() => parseArm("godot=http://x/")).toThrow(/engine/u);
    expect(() => parseArm("http://x/")).toThrow(/engine/u);
  });

  it("starts only after the load stays under 12 for 60 s", async () => {
    // 5 s polls: loud, then quiet readings for 60+ s
    const stub = clock([19, 15, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    const load = await waitQuiet({ ...stub, pollMs: 5000 });
    expect(load).toBe(3);
    expect(stub.now()).toBe(10_000 + 60_000 + 0);
  });

  it("restarts the 60 s hold when the load spikes, and times out inside the lock", async () => {
    const spike = clock([3, 3, 3, 3, 3, 3, 13, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
    await waitQuiet({ ...spike, pollMs: 5000 });
    expect(spike.now()).toBeGreaterThanOrEqual(30_000 + 5000 + 60_000);
    const busy = clock([19]);
    await expect(waitQuiet({ ...busy, pollMs: 5000, timeoutMs: 20 * 60_000 })).rejects.toThrow(
      /lock released/u,
    );
  });

  it("pools the valid runs and drops a run whose load rose above 18", () => {
    const run = (fps: number, load: number[], sha = "aaaaaaaaaaaa") => ({
      url: "u",
      load,
      build: { kind: "wasm", sha256: sha, commit: "c" },
      report: { metrics: { fps, gpuP95Ms: null }, counts: {} },
    });
    const pooled = poolRuns([run(40, [3, 4]), run(50, [3, 18.5]), run(60, [2, 3])]);
    expect(pooled).toMatchObject({ runs: 2, voidRuns: 1 });
    expect(pooled.report.metrics).toEqual({ fps: 50, gpuP95Ms: null });
    expect(poolRuns([run(40, [19])])).toBeUndefined();
    expect(() => poolRuns([run(40, [3]), run(50, [3], "bbbbbbbbbbbb")])).toThrow(
      /different builds/u,
    );
  });

  // PRD-828 AC-1 measures the JS frame stages, and a window measures an arm twice: the pooled report has
  // to carry one number per stage, or the bar is decided by which run happened to be first.
  it("pools the frame stages across the valid runs", () => {
    const run = (update: number, stages: Record<string, number> | undefined) => ({
      url: "u",
      load: [3],
      build: { kind: "wasm", sha256: "aaaaaaaaaaaa", commit: "c" },
      report: { metrics: { fps: 60 }, counts: {}, stages },
    });
    const all = { jsBefore: 2.06, update: 2.34, engineJs: 0.78, residual: 0.39 };
    const pooled = poolRuns([run(2.34, all), run(2.46, { ...all, update: 2.46 })]);
    expect(pooled?.report.stages).toEqual({
      jsBefore: 2.06,
      update: 2.4,
      engineJs: 0.78,
      residual: 0.39,
    });
    // A stage only one run measured is that run's value, never null and never zero.
    const partial = poolRuns([run(2, { update: 2 }), run(4, { update: 4, residual: 0.5 })]);
    expect(partial?.report.stages).toEqual({ update: 3, residual: 0.5 });
    // An arm whose report carries no stages keeps none: absent, never zero.
    expect(poolRuns([run(2, undefined), run(3, undefined)])?.report.stages).toBeUndefined();
  });
  it("starts a run only after the GPU stays under 10% for 5 s, and refuses after the timeout", async () => {
    let at = 0;
    const clockOf = {
      now: () => at,
      wait: async (ms: number) => {
        at += ms;
      },
    };
    // A stray page keeps the GPU at 30%, then it closes: 3 s under the limit is not enough, 5 s is.
    const readings = [30, 30, 3, 3, 3, 12, 3, 3, 3, 3, 3, 3];
    let index = 0;
    await waitGpuIdle({ ...clockOf, read: () => readings[Math.min(index++, readings.length - 1)] });
    expect(at).toBe(11_000); // the 12% spike restarts the 5 s hold at t=6 s
    at = 0;
    await expect(waitGpuIdle({ ...clockOf, read: () => 30, timeoutMs: 60_000 })).rejects.toThrow(
      /GPU stayed at or above 10%.*run refused/u,
    );
    expect(() =>
      waitGpuIdle({
        ...clockOf,
        read: () => {
          throw new Error("cannot read GPU utilization");
        },
      }),
    ).rejects.toThrow(/cannot read/u);
  });

  it("closes every page that is not about:blank before a run", async () => {
    const pages = [
      { id: "a", url: "about:blank" },
      { id: "b", url: "http://127.0.0.1:5738/main.html?stress" },
    ];
    const closed: string[] = [];
    const urls = await closeStrayPages({
      pages: async () => pages,
      close: async (page: { id: string }) => void closed.push(page.id),
    });
    expect(urls).toEqual(["http://127.0.0.1:5738/main.html?stress"]);
    expect(closed).toEqual(["b"]);
  });
  it("tells two arms of one engine apart by the value of a URL flag", () => {
    const develop = parseArm("threenative-wasm=http://127.0.0.1:5740/main.html?stress&arm=develop");
    const fb1 = parseArm("threenative-wasm=http://127.0.0.1:5742/main.html?stress&arm=fb1");
    expect(develop.variant).toBe("arm=develop");
    expect(fb1.variant).toBe("arm=fb1");
    expect(parseArm("threenative-wasm=http://x:1/main.html?stress&arm=a&plainShadow").variant).toBe(
      "arm=a&plainShadow",
    );
    // Same engine and same flag keys, other port: still another file.
    expect(fileName("t", "vsync", `${develop.engine} ${develop.url}`)).not.toBe(
      fileName("t", "vsync", `${fb1.engine} ${fb1.url}`),
    );
  });

  it("writes every run to the out dir before pooling can refuse the window", () => {
    const outDir = makeTempDirSync("tn-fair-spec-");
    const run = (sha: string, index: number) => ({
      engine: "threenative-wasm",
      url: "http://127.0.0.1:5740/main.html?stress",
      load: [3],
      build: { kind: "wasm", sha256: sha, commit: "c" },
      report: { metrics: { fps: 60 }, counts: {} },
      index,
    });
    const firstRun = run("aaaaaaaaaaaa", 0);
    const runs = [firstRun, run("bbbbbbbbbbbb", 1)];
    const options = { outDir, tag: "t" };
    for (const entry of runs) saveRun(options, "vsync", entry);
    // The pool refuses (two builds under one URL) after the evidence is on disk.
    expect(() => poolRuns(runs)).toThrow(/different builds/u);
    for (const index of [0, 1])
      expect(
        existsSync(
          join(outDir, fileName("t", "vsync", `${firstRun.engine} ${firstRun.url}`, index)),
        ),
      ).toBe(true);
  });

  it("writes 4 files for 4 runs of 2 arms: an arm's second run does not overwrite its first", () => {
    const outDir = makeTempDirSync("tn-fair-spec-");
    const arms = ["5740", "5742"].map((port) =>
      parseArm(`threenative-wasm=http://127.0.0.1:${port}/main.html?stress&arm=${port}`),
    );
    const order = abba(arms);
    const options = { outDir, tag: "t" };
    for (const arm of order)
      saveRun(options, "uncapped", {
        engine: arm.engine,
        url: arm.url,
        load: [3],
        build: { kind: "wasm", sha256: "aaaaaaaaaaaa", commit: "c" },
        report: { metrics: { fps: 60 }, counts: {} },
      });
    expect(readdirSync(outDir)).toHaveLength(4);
  });

  describe("holdoutReport", () => {
    const window = (frameP50: number) => ({
      fps: 60,
      frames: 300,
      hitches: 0,
      presented: { mean: 16.7, p50: 16.7, p95: 17 },
      frame: { p50: frameP50, p95: frameP50 + 2, p99: frameP50 + 4 },
      phases: { render: { p50: 3 }, update: { p50: 1 } },
      passes: { main: { draws: { p50: 40 }, triangles: { p50: 500_000 } } },
    });

    it("pools a real game's frame-budget windows after warm-up, so a kit can prove a keep", () => {
      // Three warm-up windows (shader compiles) would read 90 ms; the steady ones read 5, 6 and 7.
      const windows = [90, 90, 90, 5, 7, 6].map(window);
      const report = holdoutReport(windows, { name: "shooter", viewport: "1280x720" });
      expect(report).toMatchObject({ preset: "holdout:shooter", windows: 3 });
      expect(report.metrics).toMatchObject({
        frameP50Ms: 6,
        frameP95Ms: 8,
        frameWorstP95Ms: 9,
        mainDraws: 40,
        mainTrianglesM: 0.5,
        gpuP95Ms: null,
      });
    });

    it("refuses a game that measured nothing: a holdout with no windows is no holdout", () => {
      expect(() =>
        holdoutReport([90, 90, 90, 5].map(window), { name: "shooter", viewport: "1280x720" }),
      ).toThrow(/need 3 or more/u);
      expect(holdoutOf("holdout=shooter&arm=base")).toBe("shooter");
      expect(holdoutOf("play&arm=base")).toBeUndefined();
    });
  });

  describe("presentedFromStarts", () => {
    const seriesOf = (gaps: number[]) => {
      const starts = [0];
      for (const gap of gaps) starts.push((starts.at(-1) ?? 0) + gap);
      return starts;
    };

    it("reads the real frame interval, with the p95 tail from the frame starts", () => {
      const gaps = Array.from({ length: 100 }, (_, index) => (index % 10 === 0 ? 20 : 15));
      expect(presentedFromStarts(seriesOf(gaps), 60)).toEqual({
        presentedP50Ms: 15,
        presentedP95Ms: 20,
        presentedP99Ms: 20,
      });
      // One 80 ms stutter in 200 frames is invisible to p95 and is the p99.
      const stutter = Array.from({ length: 200 }, (_, index) => (index % 67 === 0 ? 80 : 10));
      expect(presentedFromStarts(seriesOf(stutter), 60)).toMatchObject({
        presentedP95Ms: 10,
        presentedP99Ms: 80,
      });
    });

    it("counts only the report's own last seconds, so load and warm-up frames stay out", () => {
      const starts = seriesOf([...Array(10).fill(500), ...Array(100).fill(10)]);
      expect(presentedFromStarts(starts, 1).presentedP95Ms).toBe(10);
    });

    it("fails closed when the window holds no intervals", () => {
      expect(() => presentedFromStarts([5], 60)).toThrow(/frame intervals/u);
    });
  });
});
