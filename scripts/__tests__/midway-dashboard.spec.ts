import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type IMidwayRun,
  cullOf,
  frameBudget,
  loadMidwayRuns,
  matrixWalk,
  parityOf,
  playerFrames,
  runOf,
  runsDir,
  scanJson,
  uiRoundTrip,
} from "../midway-bench/dashboard.js";
import {
  abPairsOf,
  breakdownOf,
  buildsOf,
  gapOf,
  groupsOf,
  instrM,
  kpisOf,
  midwayOf,
  prdProgress,
  progressOf,
  trendsOf,
} from "../midway-bench/kpis.js";

const frame = (cpu: number, ms = 40) =>
  `TN_PLAYER_FRAME:${JSON.stringify({ cpuFrameCpuMs: cpu, frameMs: ms, bridgeCalls: 10, hostCpuMs: { update: 1 } })}`;
const budget = (p50: number) =>
  `TN_FRAME_BUDGET:${JSON.stringify({ fps: 60, frame: { p50, p95: p50 * 2 }, hitches: 1 })}`;
const ui = (ms: number) => `TN_UI_SNAPSHOT:${JSON.stringify({ requests: 1, lastRoundTripMs: ms })}`;
const proj = (visited: number) =>
  `TN_PROJECTION:{"matrixWorld":{"mode":"visible","visited":${visited}},"path":"js"}`;
const parityText = (pass: boolean) =>
  `${JSON.stringify({ pass, frames: Object.fromEntries(["takeoff", "cockpit", "reargun"].map((p) => [p, { nativeMeanSsim: [0.95, 0.95], nativeWorstTile: 0.8, pass }])) })}\nPARITY ${pass ? "PASS" : "FAIL"}`;
let clock = 0;
/** The player path line a desktop run log carries. */
const pkgLine = (name: string) =>
  `"url": "/home/u/.cache/tmp-tn/${name}/tn-native-engine-player-v8"`;
const run = (dir: string, log: string, parity?: string) => {
  const [, tag, arm] = /^(.+)-(legacy|native|desktop)$/.exec(dir) as [
    string,
    string,
    "legacy" | "native" | "desktop",
  ];
  return runOf(dir, tag, arm, ++clock, log, parity);
};

describe("scanJson", () => {
  it("reads escaped playtest log lines with nested objects", () => {
    const escaped = frame(9).replaceAll('"', '\\"');
    const { values, skipped } = scanJson(`{"text": "${escaped}"}`, "TN_PLAYER_FRAME:");
    expect(values).toHaveLength(1);
    expect(values[0]).toMatchObject({ cpuFrameCpuMs: 9, hostCpuMs: { update: 1 } });
    expect(skipped).toBe(0);
  });

  it("skips and counts truncated, non-object and invalid lines", () => {
    const text = [
      frame(1),
      'TN_PLAYER_FRAME:{"cpuFrameCpuMs":',
      "TN_PLAYER_FRAME:nope",
      "TN_PLAYER_FRAME:{bad json}",
      frame(3),
    ].join("\n");
    const { values, skipped } = scanJson(text, "TN_PLAYER_FRAME:");
    expect(values).toHaveLength(2);
    expect(skipped).toBe(3);
  });
});

describe("log reducers", () => {
  it("takes medians over the last samples and the nearest-rank frame p95", () => {
    const log = [frame(100), ...[1, 2, 3, 4, 5].map((n) => frame(n, n * 10))].join("\n");
    const { frames } = playerFrames(log, 5);
    expect(frames?.n).toBe(5);
    expect(frames?.medians.cpuFrameCpuMs).toBe(3);
    expect(frames?.frameP95).toBe(40);
  });

  it("reports no samples, not zero, for an empty log", () => {
    expect(playerFrames("nothing here").frames).toBeUndefined();
    expect(frameBudget("").budget).toBeUndefined();
    expect(uiRoundTrip("").ui).toBeUndefined();
    expect(matrixWalk("")).toBeUndefined();
  });

  it("drops frame budget windows without a numeric p50", () => {
    const r = frameBudget(
      [
        budget(10),
        budget(20),
        'TN_FRAME_BUDGET:{"frame":{"p50":"x"}}',
        "TN_FRAME_BUDGET:{oops",
      ].join("\n"),
    );
    expect(r.budget).toMatchObject({ windows: 2, frameP50: 15, fps: 60, hitches: 1 });
    expect(r.skipped).toBe(2);
  });

  it("computes the HUD round trip p50 and p95", () => {
    const log = Array.from({ length: 100 }, (_, i) => ui(i + 1)).join("\n");
    expect(uiRoundTrip(log).ui).toEqual({ n: 100, p50: 50.5, p95: 95 });
  });

  it("reads matrix visits from escaped and plain projection lines and keeps the last", () => {
    const log = `${proj(9000)}\n${proj(1200).replaceAll('"', '\\"')}`;
    expect(matrixWalk(log)).toEqual({ n: 2, last: 1200, max: 9000 });
  });

  it("treats a malformed parity.json as missing and flags it", () => {
    expect(parityOf("{ not json")).toBeUndefined();
    expect(parityOf('{"pass":"yes","frames":{}}')).toBeUndefined();
    expect(parityOf(parityText(true))?.frames.takeoff).toMatchObject({
      pass: true,
      worstTile: 0.8,
      meanSsim: 0.95,
    });
    const r = run("x1-desktop", frame(5), "garbage");
    expect(r.parityMalformed).toBe(true);
    expect(r.parity).toBeUndefined();
  });

  it("marks a run with no usable lines as no samples", () => {
    const r = run("x1-desktop", "TN_PLAYER_FRAME:{broken");
    expect(r.status).toBe("no samples");
    expect(r.skipped).toBe(1);
    expect(r.desktop).toBeUndefined();
  });
});

describe("PRD-610 KPIs", () => {
  const runs = (desktopMs: number, hud: number, visited: number, parity = true): IMidwayRun[] => [
    run("ref1-legacy", budget(10)),
    run("ref2-legacy", budget(12)),
    run("c1-native", budget(9), parityText(true)),
    run("w1-desktop", [frame(desktopMs), ui(hud), proj(visited)].join("\n"), parityText(parity)),
  ];
  const verdicts = (list: IMidwayRun[]) =>
    Object.fromEntries(kpisOf(list).map((k) => [k.id, k.verdict]));

  it("passes when every target holds", () => {
    expect(verdicts(runs(8, 10, 1000))).toEqual({
      "AC-3": "pass",
      "AC-4": "pending",
      "AC-5": "pass",
      "AC-6": "pass",
      "AC-7": "pass",
    });
  });

  it("fails each target independently", () => {
    expect(verdicts(runs(14, 20, 5000))).toEqual({
      "AC-3": "fail",
      "AC-4": "pending",
      "AC-5": "fail",
      "AC-6": "fail",
      "AC-7": "pass",
    });
  });

  it("fails a faster desktop run when parity fails", () => {
    const ac6 = kpisOf(runs(5, 10, 1000, false)).find((k) => k.id === "AC-6");
    expect(ac6?.verdict).toBe("fail");
    expect(ac6?.detail).toContain("parity FAIL");
  });

  it("is pending, never pass, with no data", () => {
    expect(Object.values(verdicts([]))).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(verdicts([run("ref1-legacy", budget(10))])["AC-6"]).toBe("pending");
  });
});

describe("groups and loading", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it("groups A/B runs by tag prefix and arm", () => {
    const list = [1, 2, 3].flatMap((n) => [
      run(`walk-a${n}-desktop`, frame(10 + n)),
      run(`walk-b${n}-desktop`, frame(5 + n)),
    ]);
    const groups = groupsOf(list);
    expect(groups.map((g) => [g.group, g.runs, g.cpuFrameMs])).toEqual([
      ["walk-a", 3, 12],
      ["walk-b", 3, 7],
    ]);
  });

  it("loads <tag>-<arm> dirs oldest first and ignores everything else", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "midway-runs-"));
    dirs.push(root);
    for (const name of ["a1-desktop", "empty-desktop", "notes", "prof-desktop"])
      await mkdir(path.join(root, name));
    await writeFile(path.join(root, "prof-desktop", "run.log"), frame(9));
    await writeFile(path.join(root, "prof.perf.data"), "");
    await writeFile(
      path.join(root, "a1-desktop", "run.log"),
      [frame(7), ui(5), proj(900)].join("\n"),
    );
    await writeFile(path.join(root, "a1-desktop", "parity.json"), parityText(true));
    await writeFile(path.join(root, "empty-desktop", "run.log"), "");
    await writeFile(path.join(root, "loose-desktop"), "a file, not a run dir");
    const loaded = await loadMidwayRuns(root);
    expect(loaded.map((r) => [r.dir, r.status])).toEqual([
      ["a1-desktop", "ok"],
      ["empty-desktop", "no samples"],
    ]);
    expect(loaded[0]).toMatchObject({ tag: "a1", group: "a", parity: { pass: true } });
    expect(await loadMidwayRuns(path.join(root, "missing"))).toEqual([]);
  });

  it("defaults the runs dir under the home directory and honours MIDWAY_RUNS", () => {
    expect(runsDir({})).toBe(path.join(os.homedir(), ".cache", "tmp-tn", "midway-runs"));
    expect(runsDir({ MIDWAY_RUNS: "/data/runs" })).toBe("/data/runs");
  });
});

describe("progress, trends and PRD boxes", () => {
  it("counts ticked and open AC boxes, and reports none for a file without them", () => {
    const md =
      "- [x] AC-1 [local]: a\n- [ ] AC-2 [local]: b\n- [X] AC-3: c\n  - [x] AC-9 nested\n- [ ] not an ac\n";
    expect(prdProgress(md)).toEqual({
      done: 2,
      total: 3,
      ticked: ["AC-1", "AC-3"],
      open: ["AC-2"],
    });
    expect(prdProgress("# no boxes here")).toBeUndefined();
    expect(midwayOf([]).prd).toBeUndefined();
    expect(midwayOf([], md).prd?.done).toBe(2);
  });

  it("measures the fraction from baseline to target for lower and higher is better", () => {
    expect(progressOf(10_000, 5_750, 1_500)).toBeCloseTo(0.5);
    expect(progressOf(0.5, 1, 1)).toBe(1);
    expect(progressOf(0.8, 0.6, 1)).toBeCloseTo(-1);
    expect(progressOf(5, 5, 5)).toBe(1);
    expect(progressOf(5, 6, 5)).toBe(0);
  });

  it("scores a KPI from the first recorded run, with a regression below zero", () => {
    const list = [
      run("ref1-legacy", budget(10)),
      run(
        "w1-desktop",
        [pkgLine("pkg-a"), frame(20), ui(80), proj(9000)].join("\n"),
        parityText(true),
      ),
      run(
        "w2-desktop",
        [pkgLine("pkg-b"), frame(12), ui(90), proj(5250)].join("\n"),
        parityText(true),
      ),
    ];
    const kpi = Object.fromEntries(kpisOf(list).map((k) => [k.id, k]));
    expect(kpi["AC-3"]).toMatchObject({
      baseline: 9000,
      current: 5250,
      baselineBuild: "pkg-a",
      build: "pkg-b",
      verdict: "fail",
    });
    expect(kpi["AC-3"]?.progress).toBeCloseTo(0.5);
    expect(kpi["AC-5"]?.progress).toBeLessThan(0);
    expect(kpi["AC-6"]).toMatchObject({ baseline: 0.5, current: 10 / 12 });
    expect(kpi["AC-4"]).toMatchObject({ verdict: "pending" });
    expect(kpi["AC-4"]?.current).toBeUndefined();
  });

  it("reads the cull share from cull.json and ignores bad files", () => {
    expect(cullOf('{"sharePct":1.4}')).toBe(1.4);
    for (const bad of ["", "{", '{"sharePct":"x"}', '{"sharePct":-1}', undefined])
      expect(cullOf(bad)).toBeUndefined();
    const list = [runOf("c1-desktop", "c1", "desktop", 1, frame(5), undefined, '{"sharePct":1.5}')];
    expect(kpisOf(list).find((k) => k.id === "AC-4")).toMatchObject({
      verdict: "pass",
      current: 1.5,
    });
  });

  it("builds trends with the legacy target and the improvement against the first desktop run", () => {
    const list = [
      run("ref1-legacy", budget(11)),
      run("a1-desktop", [pkgLine("pkg-a"), frame(20)].join("\n")),
      run("a2-desktop", [pkgLine("pkg-b"), frame(15)].join("\n")),
    ];
    const ms = trendsOf(list).find((t) => t.id === "ms");
    expect(ms?.target).toBe(11);
    expect(ms?.points.map((p) => p.build)).toEqual(["three.js", "pkg-a", "pkg-b"]);
    expect(ms?.deltaPct).toBeCloseTo(25);
    expect(
      trendsOf([run("a1-desktop", frame(20))]).find((t) => t.id === "ms")?.deltaPct,
    ).toBeUndefined();
  });

  it("splits the desktop frame into game, render, other and present", () => {
    const line = `TN_PLAYER_FRAME:${JSON.stringify({ cpuFrameCpuMs: 10, gameJsCpuMs: 6, renderCpuMs: 3, presentCpuMs: 30 })}`;
    expect(breakdownOf([run("a1-desktop", line)])).toEqual({
      build: "unknown build",
      runs: 1,
      gameJs: 6,
      render: 3,
      other: 1,
      present: 30,
    });
    expect(breakdownOf([])).toBeUndefined();
  });

  it("applies the keep rule: every B beats every A", () => {
    const set = (a: number[], b: number[]) => [
      ...a.map((v, i) => run(`t-a${i + 1}-desktop`, frame(v))),
      ...b.map((v, i) => run(`t-b${i + 1}-desktop`, frame(v))),
    ];
    const keep = abPairsOf(set([14, 15, 16], [10, 11, 12]))[0];
    expect(keep).toMatchObject({ stem: "t", verdict: "keep", metric: "ms" });
    expect(keep?.steps[0]).toMatchObject({ from: "a", to: "b", medianFrom: 15, medianTo: 11 });
    expect(abPairsOf(set([14, 15, 16], [10, 11, 14]))[0]?.verdict).toBe("reject");
    expect(abPairsOf(set([14, 15, 16], []))[0]?.verdict).toBe("pending");
    expect(abPairsOf([run("solo-desktop", frame(5))])).toEqual([]);
  });

  it("decides on instructions per frame when every run carries them, and shows ms beside it", () => {
    const fi = (cpu: number, kinstr: number) =>
      `TN_PLAYER_FRAME:${JSON.stringify({ cpuFrameCpuMs: cpu, cpuFrameKInstructions: kinstr })}`;
    // ms says B is slower (host noise), instructions say every B beats every A.
    const list = [
      run("t-a1-desktop", fi(10, 52_000)),
      run("t-a2-desktop", fi(11, 51_500)),
      run("t-b1-desktop", fi(13, 48_000)),
      run("t-b2-desktop", fi(12, 49_000)),
    ];
    const pair = abPairsOf(list)[0];
    expect(pair).toMatchObject({ metric: "instr", verdict: "keep" });
    expect(pair?.steps[0]).toMatchObject({
      medianFrom: 51.75,
      medianTo: 48.5,
      msFrom: 10.5,
      msTo: 12.5,
    });
    // One run without the counter drops the whole group back to ms, where B loses.
    const mixed = [...list.slice(0, 3), run("t-b2-desktop", frame(12))];
    expect(abPairsOf(mixed)[0]).toMatchObject({ metric: "ms", verdict: "reject" });
    expect(instrM(list[0] as IMidwayRun)).toBe(52);
    expect(buildsOf(list)[0]?.instrM).toBeCloseTo(50.25);
    expect(trendsOf(list).find((t) => t.id === "instr")?.points[0]?.v).toBeCloseTo(50.25);
  });

  it("compares consecutive arms of a three-arm rotation tag", () => {
    const fi = (kinstr: number) =>
      `TN_PLAYER_FRAME:${JSON.stringify({ cpuFrameCpuMs: 10, cpuFrameKInstructions: kinstr })}`;
    const rot = (base: number[], ac3: number[], ac4: number[]) => [
      ...base.map((v, i) => run(`instr-base${i + 1}-desktop`, fi(v))),
      ...ac3.map((v, i) => run(`instr-ac3${i + 1}-desktop`, fi(v))),
      ...ac4.map((v, i) => run(`instr-ac4${i + 1}-desktop`, fi(v))),
    ];
    const [pair] = abPairsOf(rot([60_000, 61_000], [55_000, 56_000], [50_000, 51_000]));
    expect(pair?.stem).toBe("instr");
    expect(pair?.arms.map((a) => a.name)).toEqual(["base", "ac3", "ac4"]);
    expect(pair?.arms[1]?.runs.map((r) => r.round)).toEqual([1, 2]);
    expect(pair?.steps.map((s) => [s.from, s.to, s.verdict])).toEqual([
      ["base", "ac3", "keep"],
      ["ac3", "ac4", "keep"],
    ]);
    expect(pair?.verdict).toBe("keep");
    const worse = abPairsOf(rot([60_000, 61_000], [55_000, 56_000], [50_000, 57_000]))[0];
    expect(worse?.steps.map((s) => s.verdict)).toEqual(["keep", "reject"]);
    expect(worse?.verdict).toBe("reject");
  });

  it("reports the native and web Wasm gap to three.js in ms and percent", () => {
    const list = [
      run("r1-legacy", budget(10)),
      run("r2-legacy", budget(12)),
      run("d1-desktop", frame(14.3)),
      run("c1-native", budget(8.8)),
    ];
    const gap = gapOf(list);
    expect(gap.legacyMs).toBe(11);
    expect(gap.desktop).toMatchObject({ direction: "slower", build: "unknown build" });
    expect(gap.desktop?.absMs).toBeCloseTo(3.3);
    expect(gap.desktop?.pct).toBeCloseTo(30);
    expect(gap.wasm?.direction).toBe("faster");
    expect(gap.wasm?.pct).toBeCloseTo(-20);
    expect(gapOf([run("d1-desktop", frame(5))])).toEqual({
      legacyMs: undefined,
      desktop: undefined,
      wasm: undefined,
    });
  });

  it("gives each trend its three.js and web Wasm benchmark lines when they exist", () => {
    const list = [
      run("r1-legacy", [budget(10), proj(6000)].join("\n")),
      run("c1-native", budget(9)),
      run("d1-desktop", [frame(14), ui(60), proj(5000)].join("\n")),
    ];
    const by = Object.fromEntries(trendsOf(list).map((t) => [t.id, t.benchmarks]));
    expect(by.ms).toEqual([
      { arm: "legacy", label: "three.js", value: 10 },
      { arm: "native", label: "web Wasm", value: 9 },
    ]);
    expect(by.matrix).toEqual([{ arm: "legacy", label: "three.js", value: 6000 }]);
    expect(by.hud).toEqual([]);
  });

  it("reads the package from the player path in the log", () => {
    expect(run("x1-desktop", `${pkgLine("pkg-ac4b")}\n${frame(5)}`).pkg).toBe("pkg-ac4b");
    expect(run("x1-desktop", frame(5)).pkg).toBeUndefined();
    expect(run("x1-desktop", `"url": "/a/player-base/tn-native-engine-player-v8"`).pkg).toBe(
      "player-base",
    );
  });

  it("scores the newest build, not the newest run, and aggregates a build by its median", () => {
    const d = (dir: string, pkg: string, cpu: number, hud: number, visited: number) =>
      run(dir, [pkgLine(pkg), frame(cpu), ui(hud), proj(visited)].join("\n"), parityText(true));
    const list = [
      run("ref1-legacy", budget(10)),
      d("a1-desktop", "pkg-old", 20, 80, 9000),
      d("b1-desktop", "pkg-new", 14, 40, 3000),
      d("b2-desktop", "pkg-new", 12, 50, 3400),
      d("b3-desktop", "pkg-new", 16, 60, 3200),
      // An old-build run that finished last must not become "current".
      d("a2-desktop", "pkg-old", 22, 90, 9500),
    ];
    const kpi = Object.fromEntries(kpisOf(list).map((k) => [k.id, k]));
    expect(kpi["AC-3"]).toMatchObject({
      build: "pkg-new",
      runs: 3,
      current: 3200,
      baselineBuild: "pkg-old",
      baseline: 9250,
    });
    expect(kpi["AC-5"]).toMatchObject({ current: 50 });
    expect(kpi["AC-6"]?.current).toBeCloseTo(10 / 14);
    const ms = trendsOf(list).find((t) => t.id === "ms");
    expect(ms?.points.filter((p) => p.arm === "desktop")).toEqual([
      { build: "pkg-old", arm: "desktop", v: 21, runs: 2 },
      { build: "pkg-new", arm: "desktop", v: 14, runs: 3 },
    ]);
    expect(gapOf(list).desktop).toMatchObject({ build: "pkg-new", runs: 3, ms: 14 });
    expect(breakdownOf(list)).toMatchObject({ build: "pkg-new", runs: 3 });
    expect(buildsOf(list).map((b) => [b.build, b.runs, b.ms])).toEqual([
      ["pkg-old", 2, 21],
      ["pkg-new", 3, 14],
    ]);
  });

  it("keeps profiled perf- runs out of every score but lists them", () => {
    const d = (dir: string, pkg: string, cpu: number, visited: number) =>
      run(dir, [pkgLine(pkg), frame(cpu), ui(30), proj(visited)].join("\n"), parityText(true));
    const list = [
      run("ref1-legacy", budget(10)),
      d("a1-desktop", "pkg-old", 20, 9000),
      d("b1-desktop", "pkg-new", 14, 3000),
      d("perf-b-desktop", "pkg-prof", 40, 100),
    ];
    expect(list.map((r) => r.profiled)).toEqual([undefined, undefined, undefined, true]);
    const m = midwayOf(list);
    expect(m.runs).toHaveLength(4);
    expect(m.builds.map((b) => b.build)).toEqual(["pkg-old", "pkg-new"]);
    expect(m.kpis.find((k) => k.id === "AC-3")).toMatchObject({ build: "pkg-new", current: 3000 });
    expect(m.gap.desktop).toMatchObject({ build: "pkg-new", ms: 14 });
    expect(m.trends.find((t) => t.id === "ms")?.points.map((p) => p.build)).not.toContain(
      "pkg-prof",
    );
    expect(m.abPairs).toEqual([]);
  });
});
