import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  CPU_POSES,
  type IMidwayRun,
  cullOf,
  frameBudget,
  loadMidwayRuns,
  loadedHost,
  matchedCpuWindows,
  matrixWalk,
  nativeWindowCompletion,
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
  legacyMs,
  mainThreadMs,
  matchedOf,
  midwayOf,
  prdProgress,
  progressOf,
  trendsOf,
  winnerOf,
} from "../midway-bench/kpis.js";

const frame = (cpu: number, ms = 40) =>
  `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, cpuFrameKInstructions: cpu * 1000, cpuFrameCpuMs: cpu, frameMs: ms, bridgeCalls: 10, hostCpuMs: { update: 1 } })}`;
const worldCounters = {
  worldVisitCounterVersion: 2,
  worldUpdateVisits: 1,
  joinDependencyVisits: 2,
  gpuBoundaryVisits: 3,
  gpuProjectionBoundaryVisits: 4,
  gpuPlanValidationVisits: 5,
  gpuPlanMaintenanceVisits: 6,
  worldWorkVisitsTotal: 21,
};
const worldCountersV3 = {
  ...worldCounters,
  worldVisitCounterVersion: 3,
  worldDirtyPropagationVisits: 7,
  worldSubtreeSkipVisits: 8,
  transformTrackingNotifications: 999,
  worldWorkVisitsTotal: 36,
};
const worldFrame = (counters: Record<string, unknown> = worldCounters) =>
  `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, cpuFrameKInstructions: 10000, cpuFrameCpuMs: 10, frameMs: 20, ...counters })}`;
const budget = (p50: number) =>
  `TN_FRAME_BUDGET:${JSON.stringify({ fps: 60, frame: { p50, p95: p50 * 2 }, hitches: 1 })}`;
const report = (clock: "wall-clock" | "fixed-step") =>
  `\n${JSON.stringify({ assertionResults: [{ id: "diagnostics", pass: true }], clock, pass: true, runtime: "web", scenario: "midway-flight-bench", url: "http://127.0.0.1:43243" }, null, 2)}`;
const ui = (ms: number) => `TN_UI_SNAPSHOT:${JSON.stringify({ requests: 1, lastRoundTripMs: ms })}`;
const proj = (visited: number) =>
  `TN_PROJECTION:{"matrixWorld":{"mode":"visible","visited":${visited}},"path":"js"}`;
const parityText = (pass: boolean) =>
  `${JSON.stringify({ pass, frames: Object.fromEntries(["takeoff", "cockpit", "reargun"].map((p) => [p, { nativeMeanSsim: [0.95, 0.95], nativeWorstTile: 0.8, pass }])) })}\nPARITY ${pass ? "PASS" : "FAIL"}`;
const cpuReport = (cpuMs: number, runtime = "web") => ({
  ...JSON.parse(report("fixed-step")),
  runtime,
  ...(runtime === "native" ? { target: "desktop" } : {}),
  acquisition: {
    requestUrls: ["http://localhost/assets/game.js"],
    cpuWindows: Object.values(CPU_POSES).map((label, i) => ({
      label,
      frames: 1000,
      startTick: i * 1001 + 1,
      endTick: i * 1001 + 1001,
      updates: 1000,
      renders: 1000,
      mainThread: {
        pid: 10,
        tid: 10,
        starttime: "10",
        cpuNs: cpuMs * (i + 1) * 1000000,
        cpuMsPerFrame: (cpuMs * (i + 1)) / 1000,
        instructionsPerFrame: 100 * (i + 1),
        cyclesPerFrame: 200,
        cpuMs: cpuMs * (i + 1),
        instructions: 100000 * (i + 1),
        cycles: 200000,
      },
      processTree: { cpuMs: cpuMs * (i + 1) * 2, pids: [10, 11] },
      host: { load: [0, 0, 0], governors: { policy0: "performance" } },
    })),
  },
});
const hold = (held: boolean, tick: number) =>
  `TN_PLAYER_RENDER_HOLD:${JSON.stringify({ held, tick })}`;
/** Host frames bracketed by hold markers; `lead` is how far the runner's game clock is ahead of the host tick. */
const cpuRecords = (windows: readonly { startTick: number }[], lead = 0) =>
  windows.flatMap((w) => [
    hold(true, w.startTick - lead),
    ...Array.from(
      { length: 1000 },
      (_, i) =>
        `TN_PLAYER_FRAME:${JSON.stringify({ tick: w.startTick - lead + i + 1, updates: 1 })}`,
    ),
    hold(false, w.startTick - lead + 1000),
  ]);
const cpuLog = (cpuMs: number, arm: string, commit = "a".repeat(40)) => {
  const r = cpuReport(cpuMs, arm === "desktop" ? "native" : "web");
  return `arm=${arm} buildMode=${arm === "desktop" ? "desktop-bundle" : "production"} engineCommit=${commit}\n${arm === "desktop" ? cpuRecords(r.acquisition.cpuWindows).join("\n") : ""}\n${JSON.stringify(r, null, 2)}`;
};
let clock = 0;
/** The player path line a desktop run log carries. */
const pkgLine = (name: string) =>
  `"url": "/home/u/.cache/tmp-tn/${name}/tn-native-engine-player-v8"`;
const run = (dir: string, log: string, parity?: string) => {
  const [, tag, arm] = /^(.+)-(legacy|native|desktop)$/.exec(dir) as unknown as [
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
  it("rejects v2 samples carrying either v3 work counter even when zero", () => {
    for (const key of ["worldDirtyPropagationVisits", "worldSubtreeSkipVisits"]) {
      const { frames } = playerFrames(worldFrame({ ...worldCounters, [key]: 0 }));
      expect(frames?.worldWork).toBeUndefined();
      expect(frames?.worldWorkInvalid).toBe(true);
      expect(frames?.medians.cpuFrameCpuMs).toBe(10);
    }
  });

  it("includes dirty propagation and subtree checks in v3 without adding tracking notifications", () => {
    const { frames } = playerFrames(
      [
        worldFrame(worldCountersV3),
        worldFrame({
          ...worldCountersV3,
          worldDirtyPropagationVisits: 9,
          worldWorkVisitsTotal: 38,
        }),
      ].join("\n"),
    );
    expect(frames?.worldWork).toEqual({ version: 3, n: 2, median: 37, max: 38 });
    expect(frames?.worldWorkInvalid).toBeUndefined();
    expect(frames?.medians.cpuFrameCpuMs).toBe(10);
  });

  it.each([
    { ...worldCountersV3, worldDirtyPropagationVisits: undefined },
    { ...worldCountersV3, worldSubtreeSkipVisits: undefined },
    { ...worldCountersV3, worldDirtyPropagationVisits: -1 },
    { ...worldCountersV3, worldSubtreeSkipVisits: 1.5 },
    { ...worldCountersV3, worldDirtyPropagationVisits: Number.MAX_SAFE_INTEGER + 1 },
    { ...worldCountersV3, worldWorkVisitsTotal: 21 },
    { ...worldCountersV3, worldWorkVisitsTotal: 1035 },
    { ...worldCountersV3, worldVisitCounterVersion: 4 },
    worldCounters,
  ])("rejects malformed v3 and mixed v2/v3 tails without hiding CPU: %j", (counters) => {
    const { frames } = playerFrames([worldFrame(worldCountersV3), worldFrame(counters)].join("\n"));
    expect(frames?.worldWork).toBeUndefined();
    expect(frames?.worldWorkInvalid).toBe(true);
    expect(frames?.n).toBe(2);
    expect(frames?.medians.cpuFrameKInstructions).toBe(10000);
  });
  it("summarizes whole-frame world work over the same complete active tail", () => {
    const { frames } = playerFrames(
      [
        frame(100),
        worldFrame(),
        worldFrame({ ...worldCounters, worldUpdateVisits: 5, worldWorkVisitsTotal: 25 }),
        worldFrame({ ...worldCounters, updates: 0, worldWorkVisitsTotal: -1 }),
      ].join("\n"),
      2,
    );
    expect(frames?.worldWork).toEqual({ version: 2, n: 2, median: 23, max: 25 });
    expect(frames?.worldWorkInvalid).toBeUndefined();
    expect(frames?.medians.cpuFrameCpuMs).toBe(10);
  });

  it.each([
    { ...worldCounters, worldUpdateVisits: -1 },
    { ...worldCounters, joinDependencyVisits: 1.5 },
    { ...worldCounters, gpuBoundaryVisits: Number.MAX_SAFE_INTEGER + 1 },
    { ...worldCounters, worldWorkVisitsTotal: 22 },
    { ...worldCounters, gpuPlanMaintenanceVisits: undefined },
    { ...worldCounters, worldVisitCounterVersion: undefined },
    { ...worldCounters, worldVisitCounterVersion: 3 },
    { ...worldCounters, worldVisitCounterVersion: "2" },
    { ...worldCounters, worldWorkVisitsTotal: undefined },
    {},
  ])("keeps CPU measurements but rejects invalid or mixed world counters: %j", (counters) => {
    const { frames } = playerFrames([worldFrame(), worldFrame(counters)].join("\n"));
    expect(frames?.worldWork).toBeUndefined();
    expect(frames?.worldWorkInvalid).toBe(true);
    expect(frames?.n).toBe(2);
    expect(frames?.medians.cpuFrameKInstructions).toBe(10000);
  });

  it("leaves historical frames without world counters unchanged", () => {
    const { frames } = playerFrames([frame(1), frame(3)].join("\n"));
    expect(frames?.worldWork).toBeUndefined();
    expect(frames?.worldWorkInvalid).toBeUndefined();
    expect(frames?.medians.cpuFrameCpuMs).toBe(2);
  });
  it("selects complete active frames before taking the tail, excluding the real capture spike", () => {
    // resume-seek-a1-desktop: active tick 2001 and the zero-update screenshot at tick 2423.
    const active = {
      updates: 1,
      tick: 2001,
      frameMs: 48.611908,
      cpuFrameCpuMs: 11.562833999996656,
      cpuFrameKInstructions: 20255,
    };
    const capture = {
      updates: 0,
      tick: 2423,
      frameMs: 265.092619,
      cpuFrameCpuMs: 213.33693999999377,
      cpuFrameKInstructions: 1245880,
    };
    const log = [
      active,
      capture,
      capture,
      { ...active, cpuFrameCpuMs: null },
      { ...active, cpuFrameKInstructions: "missing" },
      { ...active, updates: -1 },
      { ...active, frameMs: null },
      { ...active, cpuFrameKInstructions: 0 },
      { ...active, cpuFrameCpuMs: 0 },
      { ...active, frameMs: 0 },
    ]
      .map((sample) => `TN_PLAYER_FRAME:${JSON.stringify(sample)}`)
      .join("\n");
    expect(playerFrames(log, 1).frames).toMatchObject({
      n: 1,
      eligible: 1,
      excluded: 9,
      medians: { cpuFrameCpuMs: active.cpuFrameCpuMs, cpuFrameKInstructions: 20255 },
      frameP95: active.frameMs,
    });
  });

  it("exposes fewer than 1000 eligible active frames even when captures fill the log", () => {
    const active = `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: 10, cpuFrameKInstructions: 20000 })}`;
    const capture = `TN_PLAYER_FRAME:${JSON.stringify({ updates: 0, frameMs: 229, cpuFrameCpuMs: 139, cpuFrameKInstructions: 1250000 })}`;
    const { frames } = playerFrames(
      [...Array(999).fill(active), ...Array(5).fill(capture)].join("\n"),
    );
    expect(frames).toMatchObject({ n: 999, eligible: 999, excluded: 5 });
  });

  it("takes medians over the last samples and the nearest-rank frame p95", () => {
    const log = [frame(100), ...[1, 2, 3, 4, 5].map((n) => frame(n, n * 10))].join("\n");
    const { frames } = playerFrames(log, 5);
    expect(frames?.n).toBe(5);
    expect(frames?.medians.cpuFrameCpuMs).toBe(3);
    expect(frames?.frameP95).toBe(40);
  });

  it("takes the median of main-thread CPU cycles from player frames", () => {
    const log = [300, 100, 200]
      .map(
        (cpuFrameKCycles) =>
          `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: 10, cpuFrameKInstructions: 20000, cpuFrameKCycles })}`,
      )
      .join("\n");
    expect(playerFrames(log).frames?.medians.cpuFrameKCycles).toBe(200);
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
        budget(10) + report("wall-clock"),
        budget(20) + report("wall-clock"),
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
    run("ref1-legacy", budget(10) + report("wall-clock")),
    run("ref2-legacy", budget(12) + report("wall-clock")),
    run("c1-native", budget(9) + report("wall-clock"), parityText(true)),
    run("w1-desktop", [frame(desktopMs), ui(hud), proj(visited)].join("\n"), parityText(parity)),
  ];
  const verdicts = (list: IMidwayRun[]) =>
    Object.fromEntries(kpisOf(list).map((k) => [k.id, k.verdict]));

  it("passes when every target holds", () => {
    expect(verdicts(runs(8, 10, 1000))).toEqual({
      "AC-3": "pass",
      "AC-4": "pending",
      "AC-5": "pass",
      "AC-19": "pending",
      "AC-7": "pending",
    });
  });

  it("fails each target independently", () => {
    expect(verdicts(runs(14, 20, 5000))).toEqual({
      "AC-3": "fail",
      "AC-4": "pending",
      "AC-5": "fail",
      "AC-19": "pending",
      "AC-7": "pending",
    });
  });

  it("keeps historical CPU pending even when parity fails", () => {
    const ac6 = kpisOf(runs(5, 10, 1000, false)).find((k) => k.id === "AC-19");
    expect(ac6?.verdict).toBe("pending");
    expect(ac6?.current).toBeUndefined();
  });

  it("is pending, never pass, with no data", () => {
    expect(Object.values(verdicts([]))).toEqual([
      "pending",
      "pending",
      "pending",
      "pending",
      "pending",
    ]);
    expect(verdicts([run("ref1-legacy", budget(10) + report("wall-clock"))])["AC-19"]).toBe(
      "pending",
    );
  });
});

it("reports baseline change separately from progress toward the target", () => {
  const list = [
    run("old-desktop", [pkgLine("pkg-old"), frame(10), ui(68)].join("\n")),
    run("new-desktop", [pkgLine("pkg-new"), frame(10), ui(105)].join("\n")),
  ];
  const k = kpisOf(list).find((k) => k.id === "AC-5");
  expect(k?.baselineDeltaPct).toBeCloseTo(((105 - 68) / 68) * 100);
  expect(k?.progress).toBeCloseTo(-0.7212475634);
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

  it("retains timing-excluded runs without using them in HUD scores", async () => {
    const root = await makeTempDir("midway-runs-");
    dirs.push(root);
    for (const [name, pkg, ms] of [
      ["solo-desktop", "pkg-solo", 68],
      ["parallel-desktop", "pkg-parallel", 105],
    ] as const) {
      await mkdir(path.join(root, name));
      await writeFile(
        path.join(root, name, "run.log"),
        [pkgLine(pkg), frame(10), ui(ms)].join("\n"),
      );
    }
    // The exclusion can arrive after a run was cached; its raw readings remain inspectable.
    await loadMidwayRuns(root);
    await writeFile(
      path.join(root, "parallel-desktop", "timing-exclusion.txt"),
      "Concurrent Midway instances",
    );
    await writeFile(path.join(root, "parallel-desktop", "rejected.txt"), "Keep rule failed");
    await writeFile(
      path.join(root, "solo-desktop", "retained.txt"),
      "Retained measured reference; not a winner",
    );
    const list = await loadMidwayRuns(root);
    expect(list).toHaveLength(2);
    expect(list.find((r) => r.tag === "solo")?.retention).toBe(
      "Retained measured reference; not a winner",
    );
    expect(list.find((r) => r.tag === "parallel")).toMatchObject({
      timingExclusion: "Concurrent Midway instances",
      rejection: "Keep rule failed",
      ui: { p95: 105 },
    });
    const scored = midwayOf(list);
    expect(scored.runs).toHaveLength(2);
    expect(scored.candidate.kpis.find((k) => k.id === "AC-5")).toMatchObject({
      current: 68,
      build: "pkg-solo",
    });
  });

  it("surfaces a completed timing-excluded structural candidate without qualifying it", () => {
    const reference = run(
      "isolated-cache-a1-desktop",
      [pkgLine("pkg-ac10-cache-a1"), frame(10), proj(5816)].join("\n"),
    );
    const candidate = run(
      "structural-m-desktop",
      [pkgLine("pkg-m"), ...Array(1000).fill(worldFrame()), proj(4363)].join("\n"),
      parityText(true),
    );
    candidate.timingExclusion = "Foreign GPU workload";
    const incomplete = run("later-incomplete-desktop", frame(1));
    const state = midwayOf([reference, candidate, incomplete]);
    expect(state.candidate.structural).toMatchObject({
      dir: candidate.dir,
      build: "pkg-m",
      projection: 4363,
      pinnedProjection: 5816,
      worldWork: { version: 2, n: 1000, median: 21, max: 21 },
      timingExclusion: "Foreign GPU workload",
    });
    expect(state.candidate.structural?.projectionReductionPct).toBeCloseTo(24.9828);
    expect(state.winner.status).toBe("unqualified");
    expect(state.selection.build).toBe(reference.pkg);
    expect(state.candidate.gap.desktop?.build).not.toBe(candidate.pkg);
  });

  it("keeps malformed v3 candidates out of selection and the pinned headline", () => {
    const reference = run(
      "isolated-cache-a1-desktop",
      [pkgLine("pkg-ac10-cache-a1"), frame(10), proj(5816)].join("\n"),
    );
    const candidate = run(
      "invalid-v3-desktop",
      [
        pkgLine("pkg-invalid-v3"),
        ...Array(999).fill(worldFrame(worldCountersV3)),
        worldFrame({ ...worldCountersV3, worldDirtyPropagationVisits: undefined }),
        proj(3),
      ].join("\n"),
      parityText(true),
    );
    candidate.timingExclusion = "Experimental telemetry";
    const state = midwayOf([reference, candidate]);
    expect(state.candidate.structural).toBeUndefined();
    expect(state.selection.build).toBe(reference.pkg);
    expect(state.winner.status).toBe("unqualified");
  });

  it("shows the best package median, including timing-excluded repeats, ahead of a latest regression", async () => {
    const d = (dir: string, pkg: string, visited: number, pass = true, count = 1000) =>
      run(
        dir,
        [pkgLine(pkg), ...Array(count).fill(worldFrame()), proj(visited)].join("\n"),
        parityText(pass),
      );
    const reference = d("isolated-cache-a1-desktop", "pkg-ac10-cache-a1", 5816);
    const r1 = d("r1-desktop", "pkg-r", 3469);
    r1.timingExclusion = "Timing qualification pending";
    const r2 = d("r2-desktop", "pkg-r", 3467);
    const state = midwayOf([
      reference,
      r1,
      r2,
      d("s1-desktop", "pkg-s", 3592),
      { ...d("rejected-u-desktop", "pkg-u", 2596), rejection: "Instructions regressed <keep>" },
      d("outlier1-desktop", "pkg-outlier", 1),
      d("outlier2-desktop", "pkg-outlier", 9000),
      d("incomplete-desktop", "pkg-incomplete", 2, true, 999),
      d("failed-desktop", "pkg-failed", 3, false),
      d("perf-diagnostic-desktop", "pkg-diagnostic", 4),
      ...[undefined, undefined, "", " "].map((pkg, i) => ({
        ...d(`unidentified${i}-desktop`, "pkg-placeholder", 2),
        pkg,
      })),
      ...["TN_AC3_RIG:", "TN_AC3_WALK:", "TN_AC3_ROOT:"].map((marker, i) =>
        run(
          `instrumented${i}-desktop`,
          [
            pkgLine(`pkg-instrumented${i}`),
            ...Array(1000).fill(worldFrame()),
            proj(3339),
            `${marker}{}`,
          ].join("\n"),
          parityText(true),
        ),
      ),
    ]);
    expect(state.candidate.structural).toMatchObject({
      build: "pkg-r",
      projection: 3468,
      runs: 2,
      projections: [3469, 3467],
      target: 1500,
      pinnedProjection: 5816,
    });
    expect(state.kpis.find((k) => k.id === "AC-3")).toMatchObject({
      current: 3468,
      baseline: 5816,
      detail: expect.stringContaining("experimental · not accepted"),
    });
    expect(state.candidate.structural?.pinnedProjection).toBe(5816);
    const withT = midwayOf([
      ...state.runs,
      d("t1-desktop", "pkg-t", 3211),
      d("t2-desktop", "pkg-t", 2955),
    ]);
    expect(withT.kpis.find((k) => k.id === "AC-3")?.current).toBe(3083);
    expect(state.winner.status).toBe("unqualified");
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const elements = new Map<string, { innerHTML?: string; textContent?: string }>();
    const renderState = (state: ReturnType<typeof midwayOf>) =>
      runInNewContext(`${script}\nrender(state);`, {
        state,
        document: {
          getElementById: (id: string) => {
            if (!elements.has(id)) elements.set(id, {});
            return elements.get(id);
          },
        },
      });
    renderState(state);
    expect(html).toContain("Best measured experimental · not accepted");
    expect(html).toContain("Now: Phase 2 · AC14 done · AC15 matched counter baseline pending");
    expect(elements.get("focus")?.textContent).toContain("AC15 matched counter baseline pending");
    expect(elements.get("focus")?.textContent).toContain("AC16/17/18/5/19");
    expect(elements.get("focus")?.textContent).toContain("CPU measurement alone cannot pass AC19");
    expect(elements.get("kpis")?.innerHTML).toContain(">DEFERRED</span>");
    for (const text of [
      "3,468",
      "3,469 / 3,467",
      "1,500",
      "Not accepted",
      "structural metric only",
    ])
      expect(elements.get("candidate")?.innerHTML).toContain(text);
    expect(elements.get("runs")?.innerHTML).toContain("rejected-u-desktop");
    expect(elements.get("runs")?.innerHTML).toContain("Instructions regressed &lt;keep&gt;");
    expect(elements.get("runs")?.innerHTML).toContain(">rejected</span>");
    expect(state.builds.some((b) => b.build === "pkg-u")).toBe(false);
    renderState({
      ...state,
      kpis: state.kpis.map((k) =>
        k.id === "AC-3" ? { ...k, current: 1400, verdict: "pass", ticked: true } : k,
      ),
    });
    expect(elements.get("kpis")?.innerHTML).toContain("AC-3 ✓");
    expect(elements.get("kpis")?.innerHTML).toContain(">PASS</span>");
    expect(elements.get("kpis")?.innerHTML).not.toContain(">DEFERRED</span>");
    expect(elements.get("focus")?.textContent).toContain("AC15 matched counter baseline pending");
    renderState({
      ...state,
      kpis: state.kpis.filter((k) => k.id !== "AC-3"),
      candidate: { ...state.candidate, structural: undefined },
    });
    expect(elements.get("focus")?.textContent).toContain("AC15 matched counter baseline pending");
  });

  it("loads <tag>-<arm> dirs oldest first and ignores everything else", async () => {
    const root = await makeTempDir("midway-runs-");
    dirs.push(root);
    for (const name of ["a1-desktop", "empty-desktop", "notes", "prof-desktop"])
      await mkdir(path.join(root, name));
    await writeFile(path.join(root, "prof-desktop", "run.log"), frame(9));
    await writeFile(path.join(root, "prof.perf.data"), "");
    await mkdir(path.join(root, "busy-desktop"));
    await writeFile(path.join(root, "busy-desktop", "run.log"), frame(9));
    await writeFile(
      path.join(root, "busy-desktop", "host-load.txt"),
      "cores 24\nload 4.1\nload 48.9\n",
    );
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

  it("marks a host loaded above three quarters of its cores, and nothing else", () => {
    expect(loadedHost("cores 24\nload 4.1\nload 18.5\n")).toBe(true);
    expect(loadedHost("cores 24\nload 4.1\nload 18\n")).toBe(false);
    expect(loadedHost(undefined)).toBe(false);
    expect(loadedHost("cores x\nload 99\n")).toBe(false);
    expect(loadedHost("cores 24\n")).toBe(false);
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
      run("ref1-legacy", budget(10) + report("wall-clock")),
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
    expect(kpi["AC-19"]).toMatchObject({ verdict: "pending" });
    expect(kpi["AC-19"]?.current).toBeUndefined();
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

  it("falls back only from a missing pinned cull share to complete eligible measured runs", async () => {
    const d = (dir: string, pkg: string, cull?: number, count = 1000, pass = true) =>
      runOf(
        dir,
        dir.replace(/-desktop$/, ""),
        "desktop",
        ++clock,
        [pkgLine(pkg), ...Array(count).fill(worldFrame()), ui(30), proj(4000)].join("\n"),
        parityText(pass),
        cull === undefined ? undefined : JSON.stringify({ sharePct: cull }),
      );
    const reference = d("isolated-cache-a1-desktop", "pkg-ac10-cache-a1");
    const measured = d("meter-desktop", "pkg-meter", 3.977027234);
    const list = [
      reference,
      measured,
      d("later-missing-desktop", "pkg-missing"),
      d("short-desktop", "pkg-short", 0.1, 999),
      d("bad-parity-desktop", "pkg-bad-parity", 0.1, 1000, false),
      { ...d("profiled-desktop", "pkg-profiled", 0.1), profiled: true as const },
      { ...d("timing-excluded-desktop", "pkg-timing-excluded", 0.1), timingExclusion: "Busy host" },
      { ...d("rejected-desktop", "pkg-rejected", 0.1), rejection: "Keep rule failed" },
      { ...d("unknown-desktop", "pkg-unknown", 0.1), pkg: undefined },
      { ...d("malformed-desktop", "pkg-malformed", 0.1), skipped: 1 },
    ];
    const state = midwayOf(list);
    expect(state.kpis.find((k) => k.id === "AC-4")).toMatchObject({
      current: 3.977027234,
      baseline: 3.977027234,
      build: "pkg-meter",
      target: 2,
      verdict: "fail",
      ticked: false,
      detail: expect.stringContaining("measured experimental · not accepted"),
    });
    expect(state.selection.build).toBe(reference.pkg);
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const output = { value: "" };
    runInNewContext(`${script}\noutput.value = kpi(data);`, {
      output,
      data: state.kpis.find((k) => k.id === "AC-4"),
      document: { getElementById: () => ({ addEventListener() {} }) },
    });
    expect(output.value).toContain("3.98<small>%</small>");
    expect(output.value).toContain(">FAIL</span>");
    expect(output.value).toContain("measured experimental · not accepted");
    expect(output.value).not.toContain("AC-4 ✓");
    reference.cullPct = 1.9;
    expect(midwayOf(list).kpis.find((k) => k.id === "AC-4")).toMatchObject({
      current: 1.9,
      build: reference.pkg,
    });
  });

  it("builds trends with the legacy target and the improvement against the first desktop run", () => {
    const list = [
      run("ref1-legacy", budget(11) + report("wall-clock")),
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

  it("colors only explicit experiment decisions and keeps rejected history outside scores", async () => {
    const d = (dir: string, pkg: string, cpu: number, visited: number) =>
      run(
        dir,
        [
          pkgLine(pkg),
          ...Array(1000).fill(worldFrame({ ...worldCounters, cpuFrameCpuMs: cpu })),
          ui(30),
          proj(visited),
        ].join("\n"),
        parityText(true),
      );
    const baseline = d("baseline-desktop", "pkg-old", 10, 5000);
    const kept = d("retained-desktop", "pkg-retained", 8, 3083);
    kept.retention = "Retained measured reference, not a qualified winner";
    const rejected = d("rejected-desktop", "pkg-rejected", 1, 100);
    rejected.rejection = "Instruction regression <keep rule>";
    rejected.timingExclusion = "Timing noisy; rejection remains visible";
    const pending = d("latest-pending-desktop", "pkg-pending", 9, 4000);
    const state = midwayOf([baseline, kept, rejected, pending]);
    const trend = state.trends.find((t) => t.id === "ms");
    expect(trend?.points.map((p) => [p.build, p.decision])).toEqual([
      ["pkg-old", "pending"],
      ["pkg-retained", "retained"],
      ["pkg-rejected", "rejected"],
      ["pkg-pending", "pending"],
    ]);
    expect(trend?.deltaPct).toBeCloseTo(10);
    expect(state.builds.some((b) => b.build === "pkg-rejected")).toBe(false);
    expect(state.candidate.structural?.build).toBe(kept.pkg);
    expect(state.winner.status).toBe("unqualified");
    const numericKeep = midwayOf(
      [1, 2].flatMap((round) =>
        [10, 8].map((cpu, i) =>
          run(
            `rule-${i === 0 ? "a" : "b"}${round}-desktop`,
            [
              pkgLine(i === 0 ? "pkg-rule-a" : "pkg-rule-b"),
              ...Array(1000).fill(
                worldFrame({
                  ...worldCounters,
                  cpuFrameCpuMs: cpu,
                  cpuFrameKInstructions: cpu * 1000,
                }),
              ),
              proj(5000),
            ].join("\n"),
            parityText(true),
          ),
        ),
      ),
    );
    expect(numericKeep.abPairs[0]?.verdict).toBe("keep");
    expect(
      numericKeep.trends.find((t) => t.id === "ms")?.points.every((p) => p.decision === "pending"),
    ).toBe(true);
    const mixed = midwayOf([kept, { ...rejected, pkg: kept.pkg }]).trends.find((t) => t.id === "ms")
      ?.points[0];
    expect(mixed).toMatchObject({
      decision: "pending",
      decisionReason: expect.stringContaining("Mixed"),
    });
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const elements = new Map<string, { innerHTML?: string; textContent?: string }>();
    runInNewContext(`${script}\nrender(state);`, {
      state,
      document: {
        getElementById: (id: string) => {
          if (!elements.has(id)) elements.set(id, {});
          return elements.get(id);
        },
      },
    });
    const svg = elements.get("trend")?.innerHTML;
    expect(svg).toContain('data-decision="retained"');
    expect(svg).toContain('data-decision="rejected"');
    expect(svg).toContain('data-decision="pending"');
    expect(svg).toContain("Instruction regression &lt;keep rule&gt;");
    expect(svg).toContain('stroke="var(--desktop)"');
    const legend = elements.get("trendLegend")?.innerHTML;
    for (const text of [
      "runtime lines",
      "Native engine (desktop)",
      "retained",
      "rejected",
      "pending",
      "not qualified winner",
    ])
      expect(legend).toContain(text);
  });

  it("splits the desktop frame into game, render, other and present", () => {
    const line = `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 40, cpuFrameKInstructions: 20000, cpuFrameCpuMs: 10, gameJsCpuMs: 6, renderCpuMs: 3, presentCpuMs: 30 })}`;
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
    expect(keep).toMatchObject({ stem: "t", verdict: "keep", metric: "instr" });
    expect(keep?.steps[0]).toMatchObject({ from: "a", to: "b", medianFrom: 15, medianTo: 11 });
    expect(abPairsOf(set([14, 15, 16], [10, 11, 14]))[0]?.verdict).toBe("reject");
    expect(abPairsOf(set([14, 15, 16], []))[0]?.verdict).toBe("pending");
    expect(abPairsOf([run("solo-desktop", frame(5))])).toEqual([]);
  });

  it("decides on instructions per frame when every run carries them, and shows ms beside it", () => {
    const fi = (cpu: number, kinstr: number) =>
      `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: cpu, cpuFrameKInstructions: kinstr })}`;
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
    // A parsed frame without instructions cannot enter the shared CPU/instruction window.
    const incomplete = run(
      "t-b2-desktop",
      `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: 12 })}`,
    );
    expect(incomplete.desktop).toBeUndefined();
    expect(abPairsOf([...list.slice(0, 3), incomplete])[0]?.arms[1]?.runs).toHaveLength(1);
    expect(instrM(list[0] as IMidwayRun)).toBe(52);
    expect(buildsOf(list)[0]?.instrM).toBeCloseTo(50.25);
    expect(trendsOf(list).find((t) => t.id === "instr")?.points[0]?.v).toBeCloseTo(50.25);
  });

  it("compares consecutive arms of a three-arm rotation tag", () => {
    const fi = (kinstr: number) =>
      `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: 10, cpuFrameKInstructions: kinstr })}`;
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

  it("rejects historical mixed wall/native CPU gaps", () => {
    const list = [
      run("r1-legacy", budget(10) + report("wall-clock")),
      run("r2-legacy", budget(12) + report("wall-clock")),
      run("d1-desktop", frame(14.3)),
      run("c1-native", budget(8.8) + report("wall-clock")),
    ];
    const gap = gapOf(list);
    expect(gap).toEqual({ legacyMs: undefined, desktop: undefined, wasm: undefined });
    expect(gapOf([run("d1-desktop", frame(5))])).toEqual({
      legacyMs: undefined,
      desktop: undefined,
      wasm: undefined,
    });
  });

  it("gives each trend its three.js and web Wasm benchmark lines when they exist", () => {
    const list = [
      run("r1-legacy", [proj(6000), budget(10) + report("wall-clock")].join("\n")),
      run("c1-native", budget(9) + report("wall-clock")),
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
      run("ref1-legacy", budget(10) + report("wall-clock")),
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
    expect(kpi["AC-19"]?.current).toBeUndefined();
    const ms = trendsOf(list).find((t) => t.id === "ms");
    expect(ms?.points.filter((p) => p.arm === "desktop")).toMatchObject([
      { build: "pkg-old", arm: "desktop", v: 21, runs: 2 },
      { build: "pkg-new", arm: "desktop", v: 14, runs: 3 },
    ]);
    expect(gapOf(list).desktop).toBeUndefined();
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
      run("ref1-legacy", budget(10) + report("wall-clock")),
      d("a1-desktop", "pkg-old", 20, 9000),
      d("b1-desktop", "pkg-new", 14, 3000),
      d("perf-b-desktop", "pkg-prof", 40, 100),
    ];
    expect(list.map((r) => r.profiled)).toEqual([undefined, undefined, undefined, true]);
    const m = midwayOf(list);
    expect(m.runs).toHaveLength(4);
    expect(m.builds.map((b) => b.build)).toEqual(["pkg-old", "pkg-new"]);
    expect(m.candidate.kpis.find((k) => k.id === "AC-3")).toMatchObject({
      build: "pkg-new",
      current: 3000,
    });
    expect(m.gap.desktop).toBeUndefined();
    expect(m.candidate.gap.desktop).toBeUndefined();
    expect(m.trends.find((t) => t.id === "ms")?.points.map((p) => p.build)).not.toContain(
      "pkg-prof",
    );
    expect(m.abPairs).toEqual([]);
  });
});

describe("deliberate winner lock", () => {
  const retainedPair = () =>
    ["t", "t2"].map((suffix, i) => ({
      ...run(
        `ac3-calibration-20261014T135316Z-${suffix}-desktop`,
        [
          pkgLine("pkg-ac3-calibration-20261014T135316Z-t"),
          ...Array(1000).fill(frame(i ? 7.209072 : 6.8815515)),
          ui(26),
          proj(i ? 2955 : 3211),
        ].join("\n"),
        parityText(true),
      ),
      retention: "Retained measured reference; not a qualified winner",
    }));

  it("pins both retained calibration repeats without promoting a winner", () => {
    const pair = retainedPair();
    const state = midwayOf([run("reference-legacy", budget(11) + report("wall-clock")), ...pair]);
    expect(state.selection).toMatchObject({
      role: "pinned reference / not qualified",
      build: pair[0]?.pkg,
      runs: pair.map((r) => r.dir),
    });
    expect(state.winner.status).toBe("unqualified");
    expect(state.gap.desktop).toBeUndefined();
    expect(state.kpis.find((k) => k.id === "AC-3")?.current).toBe(3083);
    expect(state.kpis.find((k) => k.id === "AC-5")?.current).toBe(26);
    expect(state.trends.find((t) => t.id === "ms")?.points).toHaveLength(2);
  });

  it("falls back from a missing or invalid repeat rather than claiming a retained pair", () => {
    const old = run("isolated-cache-a1-desktop", `${pkgLine("pkg-ac10-cache-a1")}\n${frame(9)}`);
    const [first, second] = retainedPair() as [IMidwayRun, IMidwayRun];
    if (!second.parity || !second.desktop) throw new Error("Missing retained fixture samples");
    for (const invalid of [
      undefined,
      { ...second, retention: undefined },
      { ...second, rejection: "Rejected" },
      { ...second, profiled: true as const },
      { ...second, timingExclusion: "Busy host" },
      { ...second, skipped: 1 },
      { ...second, pkg: "pkg-unapproved" },
      { ...second, parity: undefined },
      { ...second, parity: { ...second.parity, pass: false } },
      { ...second, desktop: { ...second.desktop, n: 999 } },
      { ...second, desktop: { ...second.desktop, worldWorkInvalid: true as const } },
    ]) {
      const partial = invalid ? [first, invalid] : [first];
      expect(midwayOf([old, ...partial]).selection.runs).toEqual([old.dir]);
      expect(midwayOf(partial).selection.runs).toEqual([]);
    }
  });

  const fixture = () => {
    const list: IMidwayRun[] = [];
    for (let i = 1; i <= 3; i++) {
      for (const [arm, cpu, instructions, hud] of [
        ["a", 12, 24000, 60],
        ["b", 10, 22000, 40],
      ] as const) {
        list.push(
          run(
            `locked-${arm}${i}-desktop`,
            [
              pkgLine(`pkg-${arm}`),
              Array(1000)
                .fill(
                  `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: cpu, cpuFrameKInstructions: instructions })}`,
                )
                .join("\n"),
              ui(hud),
              proj(5000),
            ].join("\n"),
            parityText(true),
          ),
        );
      }
    }
    const pins = (pkg: string) =>
      list
        .filter((r) => r.pkg === pkg)
        .map((r) => ({ dir: r.dir, evidenceSha256: r.evidenceSha256 }));
    return {
      list,
      lock: {
        package: "pkg-b",
        qualification: {
          reviewedBy: "owner",
          isolated: true,
          sameWorkload: true,
          sameHud: true,
          sameEnvironment: true,
        },
        baseline: pins("pkg-a"),
        candidate: pins("pkg-b"),
      },
    };
  };

  it("never accepts newest or fastest runs without a valid explicit lock", () => {
    const { list } = fixture();
    for (const text of [undefined, "{", "null", "{}"])
      expect(winnerOf(list, text).status).toBe("unqualified");
    const state = midwayOf(list);
    expect(state.winner.status).toBe("unqualified");
    expect(state.gap.desktop).toBeUndefined();
    expect(state.breakdown).toBeUndefined();
    expect(state.kpis.filter((k) => k.id !== "AC-3").every((k) => k.current === undefined)).toBe(
      true,
    );
    expect(state.kpis.find((k) => k.id === "AC-3")).toMatchObject({
      current: 5000,
      detail: expect.stringContaining("experimental · not accepted"),
    });
    expect(state.candidate.kpis.some((k) => k.current !== undefined)).toBe(true);
  });

  it("keeps the exact measured reference visible independently of qualification and newer runs", () => {
    const original = run(
      "original1-desktop",
      [pkgLine("pkg-ac1"), frame(14.319), ui(68), proj(9818)].join("\n"),
      parityText(true),
    );
    const reference = run(
      "isolated-cache-a1-desktop",
      [pkgLine("pkg-ac10-cache-a1"), frame(9.253), ui(99), proj(5816)].join("\n"),
      parityText(true),
    );
    const samePackage = run(
      "later-a1-desktop",
      [pkgLine("pkg-ac10-cache-a1"), frame(99)].join("\n"),
    );
    const rejected = run(
      "isolated-cache-b1-desktop",
      [pkgLine("pkg-ac10-cache-b1"), frame(13.028)].join("\n"),
    );
    const state = midwayOf([
      run("ref1-legacy", budget(11.3) + report("wall-clock")),
      original,
      reference,
      samePackage,
      rejected,
    ]);
    expect(state.winner.status).toBe("unqualified");
    expect(state.selection).toMatchObject({
      role: "pinned reference / not qualified",
      runs: [reference.dir],
    });
    expect(state.gap.desktop).toBeUndefined();
    expect(state.candidate.gap.desktop).toBeUndefined();
    expect(state.runs).toHaveLength(5);
    expect(state.kpis.find((k) => k.id === "AC-3")).toMatchObject({
      baseline: 9818,
      current: 5816,
      baselineBuild: "pkg-ac1",
    });
    expect(state.kpis.find((k) => k.id === "AC-5")).toMatchObject({
      baseline: 68,
      current: 99,
      baselineBuild: "pkg-ac1",
    });
    expect(state.kpis.find((k) => k.id === "AC-19")?.baseline).toBeUndefined();
  });

  it("pins only the approved runs even when a later candidate is faster or slower", () => {
    const { list, lock } = fixture();
    const pair = retainedPair();
    for (const cpu of [1, 99]) {
      const later = run(
        "new1-desktop",
        [pkgLine("pkg-new"), ...Array(1000).fill(frame(cpu)), ui(1), proj(1000)].join("\n"),
        parityText(true),
      );
      later.cullPct = 3.977027234;
      const state = midwayOf(
        [...list, ...pair, later, run("ref1-legacy", budget(11) + report("wall-clock"))],
        undefined,
        JSON.stringify(lock),
      );
      expect(state.winner).toMatchObject({ status: "accepted", build: "pkg-b" });
      expect(state.gap.desktop).toBeUndefined();
      expect(state.candidate.structural?.projection).toBe(1000);
      expect(state.kpis.find((k) => k.id === "AC-3")).toMatchObject({
        build: "pkg-b",
        current: 5000,
      });
      expect(state.kpis.find((k) => k.id === "AC-4")?.current).toBeUndefined();
      expect(state.candidate.gap.desktop).toBeUndefined();
      expect(state.runs).toHaveLength(10);
    }
  });

  it("requires reviewer approval of controls and at least three complete distinct alternating pairs", () => {
    const { list, lock } = fixture();
    for (const changed of [
      { ...lock, qualification: { ...lock.qualification, isolated: false } },
      { ...lock, qualification: { ...lock.qualification, reviewedBy: "" } },
      { ...lock, candidate: lock.candidate.slice(0, 2) },
      { ...lock, candidate: [lock.candidate[0], lock.candidate[0], lock.candidate[2]] },
      { ...lock, baseline: [...lock.baseline].reverse() },
      { ...lock, package: "pkg-new" },
    ])
      expect(winnerOf(list, JSON.stringify(changed)).status).toBe("unqualified");
  });

  it("requires 1000 complete active frames in both pinned arms", () => {
    for (const index of [0, 1]) {
      const { list, lock } = fixture();
      const original = list[index] as IMidwayRun;
      const active = frame(index === 0 ? 12 : 10);
      const capture = `TN_PLAYER_FRAME:${JSON.stringify({ updates: 0, frameMs: 229, cpuFrameCpuMs: 139, cpuFrameKInstructions: 1250000 })}`;
      list[index] = run(
        original.dir,
        [
          pkgLine(original.pkg as string),
          ...Array(999).fill(active),
          ...Array(5).fill(capture),
          ui(40),
        ].join("\n"),
        parityText(true),
      );
      list[index].mtimeMs = original.mtimeMs;
      (index === 0 ? lock.baseline : lock.candidate)[0] = {
        dir: original.dir,
        evidenceSha256: list[index].evidenceSha256,
      };
      expect(list[index].desktop).toMatchObject({ n: 999, eligible: 999, excluded: 5 });
      expect(winnerOf(list, JSON.stringify(lock))).toMatchObject({
        status: "unqualified",
        reason: expect.stringContaining("1000 complete active frames"),
      });
    }
  });

  it("rejects mutated evidence, excluded runs, missing parity and absent counters", () => {
    const { list, lock } = fixture();
    for (const patch of [
      { evidenceSha256: "0".repeat(64) },
      { timingExclusion: "Concurrent player" },
      { rejection: "Keep rule failed" },
      { profiled: true as const },
      { parity: undefined },
      { desktop: { n: 1, eligible: 1, excluded: 0, medians: { cpuFrameCpuMs: 10 } } },
      { ui: undefined },
      { skipped: 1 },
    ]) {
      const changed = list.map((r, i) => (i === 1 ? { ...r, ...patch } : r));
      expect(winnerOf(changed, JSON.stringify(lock)).status).toBe("unqualified");
    }
  });

  it("rejects a pinned run with malformed world counters while retaining CPU samples", () => {
    const { list, lock } = fixture();
    const original = list[1];
    if (!original) throw new Error("Missing candidate run fixture");
    list[1] = run(
      original.dir,
      [
        pkgLine("pkg-b"),
        ...Array(999).fill(worldFrame()),
        worldFrame({ ...worldCounters, worldWorkVisitsTotal: 22 }),
        ui(40),
      ].join("\n"),
      parityText(true),
    );
    list[1].mtimeMs = original.mtimeMs;
    lock.candidate[0] = { dir: list[1].dir, evidenceSha256: list[1].evidenceSha256 };
    expect(list[1].desktop).toMatchObject({ n: 1000, worldWorkInvalid: true });
    expect(winnerOf(list, JSON.stringify(lock))).toMatchObject({
      status: "unqualified",
      reason: expect.stringContaining("world counters"),
    });
  });

  it("rejects instruction overlap and CPU or HUD regressions despite passing parity", () => {
    for (const [cpu, instructions, hud] of [
      [10, 24000, 40],
      [13, 22000, 40],
      [10, 22000, 61],
    ] as const) {
      const { list, lock } = fixture();
      list[1] = run(
        "locked-b1-desktop",
        [
          pkgLine("pkg-b"),
          Array(1000)
            .fill(
              `TN_PLAYER_FRAME:${JSON.stringify({ updates: 1, frameMs: 20, cpuFrameCpuMs: cpu, cpuFrameKInstructions: instructions })}`,
            )
            .join("\n"),
          ui(hud),
        ].join("\n"),
        parityText(true),
      );
      list[1].mtimeMs = (list[0]?.mtimeMs ?? 0) + 0.5;
      lock.candidate[0] = { dir: list[1].dir, evidenceSha256: list[1].evidenceSha256 };
      expect(winnerOf(list, JSON.stringify(lock)).status).toBe("unqualified");
    }
  });
});

describe("PRD-610 browser acquisition", () => {
  const desktop = (cpu: number) =>
    runOf(
      "d1-desktop",
      "d1",
      "desktop",
      ++clock,
      [pkgLine("pkg-d"), frame(cpu)].join("\n"),
      parityText(true),
    );

  it("does not qualify fixed-step browser CPU against native", () => {
    const list = [run("ref1-legacy", budget(11.3) + report("fixed-step")), desktop(8)];
    expect(kpisOf(list).find((k) => k.id === "AC-19")?.verdict).toBe("pending");
  });

  it("does not qualify an unknown browser acquisition against native", () => {
    const list = [run("ref1-legacy", budget(11.3)), desktop(8)];
    expect(kpisOf(list).find((k) => k.id === "AC-19")?.verdict).toBe("pending");
  });

  it("rejects wall-clock browser wall time against native CPU", () => {
    const list = [run("ref1-legacy", budget(11.3) + report("wall-clock")), desktop(8)];
    expect(kpisOf(list).find((k) => k.id === "AC-19")?.verdict).toBe("pending");
  });

  it("rejects mixed browser acquisitions in a ratio", () => {
    const mixed = [
      run("ref1-legacy", budget(11.3) + report("wall-clock")),
      runOf(
        "c1-native",
        "c1",
        "native",
        ++clock,
        budget(8) + report("fixed-step"),
        parityText(true),
      ),
    ];
    expect(kpisOf(mixed).find((k) => k.id === "AC-7")?.verdict).toBe("pending");
  });

  it("rejects browser wall-clock ratios as matched CPU", () => {
    const same = [
      run("ref1-legacy", budget(11.3) + report("wall-clock")),
      runOf(
        "c1-native",
        "c1",
        "native",
        ++clock,
        budget(8) + report("wall-clock"),
        parityText(true),
      ),
    ];
    expect(kpisOf(same).find((k) => k.id === "AC-7")?.verdict).toBe("pending");
  });
});

describe("measurement defect regressions", () => {
  it.each([
    "",
    "wall-clock",
    "fixed-step",
    "unknown",
    "dev-client",
    "missing",
    "malformed",
    "mismatch",
    "stale",
    "stale-build",
    "stale-desktop",
    "no-requests",
    "unbuilt",
    "matched",
    "matched-wall",
    "matched-invalid",
    "matched-missing",
    "matched-duplicate-wait",
    "matched-missing-wait",
    "native-matched",
    "native-production",
    "native-dev-client",
  ])(
    "runs production acquisition case %j through the actual flight script",
    async (browserClock) => {
      const root = await makeTempDir("midway-flight-");
      try {
        const player = path.join(root, "desktop");
        await mkdir(player);
        await writeFile(path.join(root, "engine.bin"), "engine");
        await writeFile(path.join(player, "game.js"), "bundle");
        const sha = (text: string) => createHash("sha256").update(text).digest("hex");
        const commit = "a".repeat(40);
        const provenance = {
          buildProtocol: browserClock === "unbuilt" ? undefined : "midway-clean-build-v1",
          engineCommit: commit,
          artifacts: { "engine.bin": sha("engine") },
        };
        if (browserClock !== "missing")
          await writeFile(
            path.join(root, "midway-provenance.json"),
            browserClock === "malformed" ? "{}" : JSON.stringify(provenance),
          );
        await writeFile(
          path.join(player, "midway-provenance.json"),
          JSON.stringify({
            buildProtocol: "midway-clean-build-v1",
            engineCommit: browserClock === "mismatch" ? "b".repeat(40) : commit,
            artifacts: { "game.js": sha("bundle") },
          }),
        );
        if (browserClock === "stale") await writeFile(path.join(root, "engine.bin"), "changed");
        await mkdir(path.join(root, "dist"));
        await writeFile(path.join(root, "dist/game.js"), "production");
        await writeFile(
          path.join(root, "dist.build-report.json"),
          JSON.stringify({
            schemaVersion: 1,
            target: "web",
            artifact: { kind: "directory", sha256: sha(`game.js ${sha("production")}`) },
          }),
        );
        if (browserClock === "stale-build")
          await writeFile(path.join(root, "dist/game.js"), "changed");
        if (browserClock === "stale-desktop")
          await writeFile(path.join(player, "game.js"), "changed");
        const acquisition =
          browserClock === "no-requests"
            ? undefined
            : {
                requestUrls: [
                  ["dev-client", "native-dev-client"].includes(browserClock)
                    ? "http://localhost:5173/@vite/client"
                    : "http://localhost:5173/assets/game.js",
                ],
              };
        const terminalReport = ["matched", "native-matched"].includes(browserClock)
          ? cpuReport(120)
          : JSON.parse(report(browserClock === "fixed-step" ? "fixed-step" : "wall-clock"));
        if (["matched", "native-matched"].includes(browserClock) && acquisition)
          Object.assign(acquisition, terminalReport.acquisition);
        await writeFile(
          path.join(root, "fixture.report"),
          `\n${JSON.stringify({ ...terminalReport, acquisition }, null, 2)}`,
        );
        const bin = path.join(root, "node_modules/.bin");
        await mkdir(bin, { recursive: true });
        const runner = path.join(bin, "threenative-playtest");
        const pnpm = path.join(bin, "pnpm");
        await writeFile(
          runner,
          '#!/bin/sh\nprintf "invocation\\n" >> "$ARGV_LOG"\nprintf "%s\\n" "${TN_PLAYTEST_CPU_WINDOW_LABELS:-}" > "$CPU_ENV_LOG"\nprintf "%s\\n" "$@" >> "$ARGV_LOG"\nwhile [ "$#" -gt 0 ]; do if [ "$1" = --artifacts ]; then shift; OUT=$1; elif [ "$1" = --server-command ]; then shift; SERVER=$1; fi; shift; done\nPORT=54321 sh -c "$SERVER" || exit $?\ncat fixture.report\n',
        );
        await writeFile(
          pnpm,
          '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BUILD_LOG"\n[ "$2" != tsx ] || echo "PARITY PASS"\nexit 0\n',
        );
        await chmod(runner, 0o755);
        await chmod(pnpm, 0o755);
        const argvLog = path.join(root, "argv.log");
        let scenarioPath = path.resolve("scripts/midway-bench/flight-bench.playtest.json");
        if (["matched-duplicate-wait", "matched-missing-wait"].includes(browserClock)) {
          const scenario = JSON.parse(await readFile(scenarioPath, "utf8"));
          if (browserClock === "matched-duplicate-wait") scenario.steps.push(scenario.steps[3]);
          else scenario.steps.splice(3, 1);
          scenarioPath = path.join(root, "bad-waits.playtest.json");
          await writeFile(scenarioPath, JSON.stringify(scenario));
        }
        const result = spawnSync(
          "sh",
          [
            path.resolve("scripts/midway-bench/flight.sh"),
            browserClock.startsWith("native-") ? "native" : "legacy",
            "smoke",
          ],
          {
            encoding: "utf8",
            timeout: 10000,
            env: {
              ...process.env,
              PATH: `${bin}:${process.env.PATH}`,
              MIDWAY_MATCHED_CPU:
                browserClock === "matched-invalid"
                  ? "bad"
                  : browserClock.includes("matched")
                    ? "1"
                    : "0",
              CPU_ENV_LOG: path.join(root, "cpu-env.log"),
              MIDWAY_BROWSER_CLOCK: ["", "wall-clock", "fixed-step", "unknown"].includes(
                browserClock,
              )
                ? browserClock
                : [
                      "matched",
                      "matched-missing",
                      "matched-duplicate-wait",
                      "matched-missing-wait",
                      "native-matched",
                    ].includes(browserClock)
                  ? ""
                  : "wall-clock",
              MIDWAY_PLAYER_DIR: player,
              MIDWAY_PARITY_REFS: "reference-a reference-b",
              CASE: browserClock,
              BUILD_LOG: path.join(root, "build.log"),
              MIDWAY_LEGACY_DIR: root,
              MIDWAY_NATIVE_DIR: root,
              MIDWAY_RUNS: path.join(root, "runs"),
              MIDWAY_SCENARIO: scenarioPath,
              ARGV_LOG: argvLog,
              TN_HEAVY_LOCK: "",
              TN_VK_ICD: "",
              TN_VK_LIB: "",
            },
          },
        );
        if (
          [
            "unknown",
            "matched-wall",
            "matched-invalid",
            "matched-duplicate-wait",
            "matched-missing-wait",
          ].includes(browserClock)
        ) {
          expect(result.status).toBe(2);
          expect(result.stderr).toMatch(
            /MIDWAY_BROWSER_CLOCK|MIDWAY_MATCHED_CPU|requires fixed-step|missing\/nonunique/,
          );
          await expect(readFile(argvLog, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
          return;
        }
        if (
          [
            "dev-client",
            "missing",
            "malformed",
            "mismatch",
            "stale",
            "stale-build",
            "stale-desktop",
            "no-requests",
            "unbuilt",
            "native-dev-client",
            "matched-missing",
          ].includes(browserClock)
        ) {
          expect(result.status, result.stdout + result.stderr).not.toBe(0);
          expect(result.stdout + result.stderr).toMatch(
            /provenance|commit|stale|vite.client|acquisition/i,
          );
          return;
        }
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(
          (await readFile(path.join(root, "build.log"), "utf8")).startsWith(
            "run build:web\nexec vite preview --host 127.0.0.1 --port 54321 --strictPort\n",
          ),
        ).toBe(true);
        const flightLog = await readFile(
          path.join(
            root,
            `runs/smoke-${browserClock.startsWith("native-") ? "native" : "legacy"}/run.log`,
          ),
          "utf8",
        );
        expect(flightLog).toContain(`engineCommit=${commit}`);
        expect(run("smoke-legacy", flightLog).clock).toBe(
          ["fixed-step", "matched", "native-matched"].includes(browserClock)
            ? "fixed-step"
            : "wall-clock",
        );
        if (["matched", "native-matched"].includes(browserClock)) {
          expect(JSON.parse(await readFile(path.join(root, "cpu-env.log"), "utf8"))).toEqual(
            Object.values(CPU_POSES),
          );
          const derived = JSON.parse(
            await readFile(
              path.join(
                root,
                `runs/smoke-${browserClock.startsWith("native-") ? "native" : "legacy"}/matched-cpu.playtest.json`,
              ),
              "utf8",
            ),
          );
          expect(
            derived.steps
              .filter((step: { label: string }) =>
                Object.values(CPU_POSES).includes(step.label as never),
              )
              .map((step: { waitTicks: number }) => step.waitTicks),
          ).toEqual([1000, 1000, 1000]);
        }
        const argv = (await readFile(argvLog, "utf8")).trimEnd().split("\n");
        expect(argv).toEqual([
          "invocation",
          "--scenario",
          ["matched", "native-matched"].includes(browserClock)
            ? path.join(
                root,
                `runs/smoke-${browserClock.startsWith("native-") ? "native" : "legacy"}/matched-cpu.playtest.json`,
              )
            : path.resolve("scripts/midway-bench/flight-bench.playtest.json"),
          "--browser-recipe",
          "webgpu",
          "--timeout",
          "180000",
          "--headed",
          "--artifacts",
          path.join(root, `runs/smoke-${browserClock.startsWith("native-") ? "native" : "legacy"}`),
          ...(["fixed-step", "matched", "native-matched"].includes(browserClock)
            ? []
            : ["--live-clock"]),
          "--server-command",
          "pnpm exec vite preview --host 127.0.0.1 --port $PORT --strictPort",
        ]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    "packages/core/__tests__/source.spec.ts",
    "packages/runtime-native/tests/native-engine/compute_test.cpp",
    "scripts/__tests__/source.spec.ts",
    "packages/runtime-native/src/engine/source.cpp",
  ])("scopes both provenance guards to production inputs: %s", async (file) => {
    const root = await makeTempDir("midway-source-scope-");
    try {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, "package.json"), '{"name":"threenative"}');
      await writeFile(path.join(root, file), "committed");
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--quiet",
          "-m",
          "source",
        ],
        { cwd: root },
      );
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const install = await readFile(path.resolve("scripts/midway-bench/install.sh"), "utf8");
      const bundler = await readFile(
        path.resolve("packages/runtime-native/scripts/bundle-native-engine.mjs"),
        "utf8",
      );
      const installGuard = install.match(/const sourceCommit = \(\) => \{[\s\S]*?\n {4}\};/)?.[0];
      const bundleGuard = bundler.match(
        / {2}let engineCommit;[\s\S]*?(?= {2}entry = resolve\(entry\);)/,
      )?.[0];
      expect(installGuard).toBeDefined();
      expect(bundleGuard).toBeDefined();
      const context = {
        repo: root,
        execFileSync,
        readFileSync,
        realpathSync,
        path,
        resolve: path.resolve,
        git: (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(),
      };
      const production = file.includes("/src/");
      // Exercise modified, staged and untracked inputs with the real git pathspecs.
      for (const state of ["modified", "staged", "untracked"]) {
        if (state === "untracked")
          execFileSync("git", ["rm", "--cached", "--force", file], { cwd: root });
        await writeFile(path.join(root, file), "dirty");
        if (state === "staged") execFileSync("git", ["add", file], { cwd: root });
        const sourceCommit = () =>
          runInNewContext(`(() => { ${installGuard}; return sourceCommit(); })()`, context);
        if (production) expect(sourceCommit).toThrow("clean owning engine checkout");
        else expect(sourceCommit()).toBe(commit);
        expect(runInNewContext(`(() => { ${bundleGuard}; return engineCommit; })()`, context)).toBe(
          production ? undefined : commit,
        );
        expect(await readFile(path.join(root, file), "utf8")).toBe("dirty");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["dirty", "build-failure"])(
    "refuses a source/build provenance gap: %s",
    async (state) => {
      const root = await makeTempDir("midway-dirty-source-");
      try {
        await mkdir(path.join(root, "scripts/midway-bench"), { recursive: true });
        await mkdir(path.join(root, "packages"));
        await mkdir(path.join(root, "bin"));
        await writeFile(
          path.join(root, "bin/pnpm"),
          '#!/bin/sh\necho "fixture build failed" >&2\nexit 47\n',
        );
        await chmod(path.join(root, "bin/pnpm"), 0o755);
        await copyFile(
          path.resolve("scripts/midway-bench/install.sh"),
          path.join(root, "scripts/midway-bench/install.sh"),
        );
        await writeFile(path.join(root, "package.json"), '{"name":"threenative"}');
        await writeFile(path.join(root, "packages/engine.cpp"), "committed");
        execFileSync("git", ["init", "--quiet", root]);
        execFileSync("git", ["add", "."], { cwd: root });
        execFileSync(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.com",
            "commit",
            "--quiet",
            "-m",
            "source",
          ],
          { cwd: root },
        );
        if (state === "dirty") await writeFile(path.join(root, "packages/engine.cpp"), "dirty");
        const result = spawnSync("sh", [path.join(root, "scripts/midway-bench/install.sh"), root], {
          encoding: "utf8",
          timeout: 10000,
          env: {
            ...process.env,
            PATH: `${path.join(root, "bin")}:${process.env.PATH}`,
            MIDWAY_PACKS: path.join(root, "packs"),
          },
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          state === "dirty" ? "clean owning engine checkout" : "fixture build failed",
        );
        await expect(
          readFile(path.join(root, "packs/midway-provenance.json")),
        ).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readFile(path.join(root, "packages/engine.cpp"), "utf8")).toBe(
          state === "dirty" ? "dirty" : "committed",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("packs patched Three with strict exports using incremental native builds", async () => {
    const root = await makeTempDir("midway-pack-");
    try {
      const native = path.join(root, "packages/runtime-native");
      const three = path.join(root, "packages/core/node_modules/three");
      const packs = path.join(root, "packs");
      const game = path.join(root, "game");
      const bin = path.join(root, "bin");
      for (const dir of [
        "scripts/midway-bench",
        "packages/core",
        "bin",
        "game",
        "packages/runtime-native/scripts",
        "packages/runtime-native/build/wasm",
        "packages/runtime-native/build/tn-engine-ui",
        "packages/core/node_modules/three/build",
      ]) {
        await mkdir(path.join(root, dir), { recursive: true });
      }
      await copyFile(
        path.resolve("scripts/midway-bench/install.sh"),
        path.join(root, "scripts/midway-bench/install.sh"),
      );
      await writeFile(path.join(root, "package.json"), '{"name":"threenative"}');
      await writeFile(path.join(root, ".gitignore"), "node_modules/\nbuild/\n");
      await writeFile(
        path.join(root, "packages/core/package.json"),
        '{"name":"@threenative/core"}',
      );
      await writeFile(
        path.join(three, "package.json"),
        JSON.stringify({ name: "three", exports: { ".": "./build/three.cjs" } }),
      );
      await writeFile(
        path.join(three, "build/three.cjs"),
        "module.exports = 'patched upstream Three';",
      );
      await writeFile(
        path.join(native, "scripts/build-native-ui-overlay.mjs"),
        "// Fixture overlay build.\n",
      );
      for (const dir of ["wasm", "tn-engine-ui"]) {
        await writeFile(
          path.join(native, "build", dir, "CMakeCache.txt"),
          `CMAKE_HOME_DIRECTORY:INTERNAL=${native}\n`,
        );
      }
      await writeFile(path.join(game, "package.json"), '{"dependencies":{"react":"19.2.0"}}');
      await writeFile(
        path.join(bin, "pnpm"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'build') process.exit(0);
if (args[0] === 'install') {
  fs.writeFileSync('pnpm-lock.yaml', 'fixture lock');
} else if (args.includes('pack')) {
  const key = args[0] === 'pack' ? JSON.parse(fs.readFileSync('package.json')).name : path.basename(args[1]);
  const name = key === 'three' || key === 'create-threenative' ? key : 'threenative-' + key;
  const bytes = key === 'three' ? fs.readFileSync('build/three.cjs') : 'fixture package';
  fs.writeFileSync(path.join(args[args.indexOf('--pack-destination') + 1], name + '-1.0.0.tgz'), bytes);
} else process.exit(48);
`,
      );
      await writeFile(
        path.join(bin, "cmake"),
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.cwd(), 'cmake-calls.jsonl'), JSON.stringify(args) + '\\n');
if (args.includes('tn-native-engine-player-v8')) fs.writeFileSync(path.join(args[1], 'tn-native-engine-player-v8'), 'fixture built player');
`,
      );
      await chmod(path.join(bin, "pnpm"), 0o755);
      await chmod(path.join(bin, "cmake"), 0o755);
      execFileSync("git", ["init", "--quiet", root]);
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "--quiet",
          "-m",
          "source",
        ],
        { cwd: root },
      );
      const commit = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim();
      const result = spawnSync("sh", [path.join(root, "scripts/midway-bench/install.sh"), game], {
        encoding: "utf8",
        timeout: 10000,
        env: { ...process.env, MIDWAY_PACKS: packs, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(await readFile(path.join(packs, "three-1.0.0.tgz"), "utf8")).toBe(
        "module.exports = 'patched upstream Three';",
      );
      const receipt = JSON.parse(
        await readFile(path.join(packs, "midway-provenance.json"), "utf8"),
      );
      expect(receipt.engineCommit).toBe(commit);
      expect(Object.keys(receipt.artifacts)).toHaveLength(8);
      expect(receipt.playerSha256).toBe(
        createHash("sha256").update("fixture built player").digest("hex"),
      );
      const pkg = JSON.parse(await readFile(path.join(game, "package.json"), "utf8"));
      expect(pkg.dependencies.react).toBe("19.2.0");
      expect(pkg.pnpm.overrides.three).toBe(`file:${path.join(packs, "three-1.0.0.tgz")}`);
      const calls = (await readFile(path.join(root, "cmake-calls.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls).toEqual([
        ["--build", path.join(native, "build/wasm"), "--target", "tn-native-engine-web"],
        [
          "--build",
          path.join(native, "build/tn-engine-ui"),
          "--target",
          "tn-native-engine-player-v8",
        ],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["missing", "stale", "valid"])(
    "requires genuine cached package provenance for --no-pack: %s",
    async (state) => {
      const root = await makeTempDir("midway-install-");
      try {
        const packs = path.join(root, "packs");
        const bin = path.join(root, "bin");
        await mkdir(packs);
        await mkdir(bin);
        await mkdir(path.join(root, "node_modules/three"), { recursive: true });
        await writeFile(path.join(root, "node_modules/three/package.json"), "{}");
        await writeFile(path.join(root, "pnpm-lock.yaml"), "lock");
        await writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ dependencies: { react: "19.2.0", three: "0.185.1" } }),
        );
        const artifacts: Record<string, string> = {};
        for (const name of [
          "threenative-core",
          "threenative-physics",
          "threenative-ui",
          "threenative-assets",
          "threenative-playtest",
          "threenative-runtime-native",
          "create-threenative",
          "three",
        ]) {
          const file = `${name}-1.0.0.tgz`;
          await writeFile(path.join(packs, file), "packed");
          artifacts[file] = createHash("sha256").update("packed").digest("hex");
        }
        const engineCommit = "c".repeat(40);
        if (state !== "missing")
          await writeFile(
            path.join(packs, "midway-provenance.json"),
            JSON.stringify({ buildProtocol: "midway-clean-build-v1", engineCommit, artifacts }),
          );
        if (state === "stale") await writeFile(path.join(packs, "three-1.0.0.tgz"), "changed");
        await writeFile(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
        await chmod(path.join(bin, "pnpm"), 0o755);
        const result = spawnSync(
          "sh",
          [path.resolve("scripts/midway-bench/install.sh"), root, "--no-pack"],
          {
            encoding: "utf8",
            timeout: 10000,
            env: { ...process.env, MIDWAY_PACKS: packs, PATH: `${bin}:${process.env.PATH}` },
          },
        );
        if (state !== "valid") {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toMatch(/provenance/);
          return;
        }
        expect(result.status, result.stdout + result.stderr).toBe(0);
        const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
        expect(pkg.dependencies.react).toBe("19.2.0");
        expect(pkg.dependencies.three).toBe(`file:${path.join(packs, "three-1.0.0.tgz")}`);
        const receipt = JSON.parse(
          await readFile(path.join(root, "midway-provenance.json"), "utf8"),
        );
        expect(receipt.engineCommit).toBe(engineCommit);
        expect(receipt.artifacts["node_modules/three"]).toMatch(/^[a-f0-9]{64}$/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each(["valid", "stale-player", "wrong-commit", "unbuilt"])(
    "checks desktop build provenance: %s",
    async (state) => {
      const root = await makeTempDir("midway-package-");
      try {
        const script = path.resolve("packages/runtime-native/scripts/package-engine-desktop.mjs");
        const { packageEngineDesktop } = await import(script);
        const player = path.join(root, "player");
        const output = path.join(root, "desktop");
        const engineCommit = "d".repeat(40);
        await writeFile(player, "player");
        const buildReceipt = path.join(root, "build-receipt.json");
        await writeFile(
          buildReceipt,
          JSON.stringify({
            buildProtocol: state === "unbuilt" ? undefined : "midway-clean-build-v1",
            engineCommit: state === "wrong-commit" ? "e".repeat(40) : engineCommit,
            playerSha256: createHash("sha256")
              .update(state === "stale-player" ? "old-player" : "player")
              .digest("hex"),
          }),
        );
        const packaging = packageEngineDesktop(
          { project: root, entry: "unused", player, output, buildReceipt },
          {
            bundle: async ({ outfile }: { outfile: string }) => {
              await writeFile(outfile, "bundle");
              return { engineCommit };
            },
            cook: async () => {
              await mkdir(path.join(output, "native"));
              await writeFile(path.join(output, "native/assets.tnpk"), "assets");
            },
          },
        );
        if (state !== "valid") {
          await expect(packaging).rejects.toThrow("TN_ENGINE_PROVENANCE_INVALID");
          await expect(readFile(path.join(output, "midway-provenance.json"))).rejects.toMatchObject(
            { code: "ENOENT" },
          );
          return;
        }
        await packaging;
        const verify = () =>
          spawnSync(
            "sh",
            [path.resolve("scripts/midway-bench/install.sh"), output, "--verify", output],
            { encoding: "utf8", timeout: 10000 },
          );
        const valid = verify();
        expect(valid.status, valid.stderr).toBe(0);
        expect(valid.stdout.trim()).toBe(engineCommit);
        await writeFile(path.join(output, "native/new.bin"), "added");
        const stale = verify();
        expect(stale.status).not.toBe(0);
        expect(stale.stderr).toContain("stale directory provenance");
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("takes acquisition from the terminal report despite an earlier unrelated clock", () => {
    const log = `message: {"clock":"wall-clock"}\n${budget(11.3)}${report("fixed-step")}`;
    const r = run("ref1-legacy", log);
    expect(r.clock).toBe("fixed-step");
    expect(mainThreadMs(r)).toBeUndefined();
    expect(r.budget?.frameP50).toBe(11.3);
  });

  it("does not acquire a clock from missing, malformed or injected reports", () => {
    for (const tail of [
      "",
      ' "clock": "wall-clock"',
      '\n{"clock":"wall-clock"}',
      report("wall-clock").slice(0, -1),
      report("wall-clock").replace('"pass": true', '"pass": false'),
      `${report("fixed-step")}\nmessage: {"clock":"wall-clock"}`,
      `${report("fixed-step")}\n{"clock":"wall-clock"}`,
    ]) {
      const r = run("ref1-legacy", `message: {"clock":"wall-clock"}\n${budget(11.3)}${tail}`);
      expect(r.clock, tail).toBeUndefined();
      expect(mainThreadMs(r), tail).toBeUndefined();
    }
  });

  it("excludes fixed-step and unknown browser CPU from every reference and trend", () => {
    for (const clock of [undefined, "fixed-step"] as const) {
      const list = [
        run("ref1-legacy", budget(11.3) + (clock ? report(clock) : "")),
        run("c1-native", budget(8) + (clock ? report(clock) : ""), parityText(true)),
        run("d1-desktop", frame(9), parityText(true)),
      ];
      expect(legacyMs(list)).toBeUndefined();
      expect(gapOf(list)).toEqual({ legacyMs: undefined, desktop: undefined, wasm: undefined });
      const ms = trendsOf(list).find((t) => t.id === "ms");
      expect(ms?.target).toBeUndefined();
      expect(ms?.benchmarks).toEqual([]);
      expect(ms?.points.map((p) => p.arm)).toEqual(["desktop"]);
      for (const k of kpisOf(list).filter((k) => ["AC-19", "AC-7"].includes(k.id))) {
        expect(k.verdict).toBe("pending");
        expect(k.current).toBeUndefined();
        expect(k.baseline).toBeUndefined();
        expect(k.detail).toContain("matched fixed-step OS windows");
      }
    }
  });
});

describe("AC15 matched OS CPU", () => {
  const pairs = () =>
    Array.from({ length: 3 }, (_, i) => [
      run(`matched-a${i}-legacy`, cpuLog(120, "legacy")),
      run(`matched-b${i}-desktop`, cpuLog(80, "desktop"), parityText(true)),
    ]).flat();
  it("computes exact per-pose CPU, instructions and process-tree readings", () => {
    const list = pairs();
    for (const r of list.filter((r) => r.arm === "desktop")) {
      const rear = r.cpuWindows?.find((w) => w.label === CPU_POSES.reargun);
      if (rear) rear.mainThread.cpuMs = 120;
    }
    const visualRef = run("visual-ref-legacy", cpuLog(120, "legacy"));
    visualRef.mtimeMs = 0;
    const rows = matchedOf([visualRef, ...list]);
    expect(rows.map((p) => [p.pose, p.ratio, p.qualified, p.pairs])).toEqual([
      ["takeoff", 1.5, true, 3],
      ["cockpit", 1.5, true, 3],
      ["reargun", 3, true, 3],
    ]);
    expect(rows[1]).toMatchObject({
      legacyCpuMs: 0.24,
      nativeCpuMs: 0.16,
      legacyInstructions: 200,
      nativeInstructions: 200,
      legacyTreeCpuMs: 0.48,
      nativeTreeCpuMs: 0.32,
    });
    expect(midwayOf(list).kpis.find((k) => k.id === "AC-19")).toMatchObject({
      verdict: "fail",
      target: 2,
      current: 1.5,
    });
  });
  it("keeps a single pair and nonalternating runs pending", () => {
    expect(matchedOf(pairs().slice(0, 2)).every((p) => p.ratio === 1.5 && !p.qualified)).toBe(true);
    const list = pairs();
    list.forEach((r, i) => {
      r.mtimeMs = r.arm === "legacy" ? i : i + 20;
    });
    expect(matchedOf(list).every((p) => !p.qualified)).toBe(true);
  });
  it("requires matching engine commits and passing native parity", () => {
    const list = pairs();
    for (const r of list.filter((r) => r.arm === "desktop")) r.engineCommit = "b".repeat(40);
    expect(matchedOf(list).every((p) => p.ratio === undefined && !p.qualified)).toBe(true);
    const failed = pairs();
    const failedRun = failed[1] as IMidwayRun;
    failedRun.parity = parityOf(parityText(false));
    expect(matchedOf(failed).every((p) => !p.qualified)).toBe(true);
  });
  it.each([
    "frames",
    "updates",
    "renders",
    "cpuMs",
    "instructions",
    "cycles",
    "tree",
    "pids",
    "duplicate",
  ])("rejects incomplete or invalid window %s", (field) => {
    const r = cpuReport(120);
    const w = r.acquisition.cpuWindows[0] as (typeof r.acquisition.cpuWindows)[number];
    if (["frames", "updates", "renders"].includes(field))
      delete (w as unknown as Record<string, unknown>)[field];
    else if (field === "tree") w.processTree.cpuMs = 0;
    else if (field === "pids") w.processTree.pids = [];
    else if (field === "duplicate") r.acquisition.cpuWindows[1] = w;
    else (w.mainThread as unknown as Record<string, unknown>)[field] = 0;
    expect(matchedCpuWindows(`\n${JSON.stringify(r)}`)).toBeUndefined();
  });
  it("never restores the historical ratio in the dashboard headline", () => {
    const state = midwayOf([
      run("ref-legacy", budget(15.1) + report("wall-clock")),
      run("d-desktop", frame(10), parityText(true)),
    ]);
    expect(state.matchedCpu.every((p) => p.ratio === undefined)).toBe(true);
    expect(state.kpis.find((k) => k.id === "AC-19")?.current).toBeUndefined();
    expect(state.gap.desktop).toBeUndefined();
  });
  describe("unpaired provisional readings", () => {
    const commit = "c".repeat(40);
    const failure =
      "TN_PLAYTEST_CPU_WINDOW_FAILED: expected 1000 updates/renders, observed 1000/1002";
    const failedNative = () =>
      `arm=desktop buildMode=desktop-bundle engineCommit=${commit}\n${JSON.stringify(
        {
          diagnostics: [{ code: "TN_PLAYTEST_RUNNER_FAILED", message: failure, severity: "error" }],
          pass: false,
        },
        null,
        2,
      )}\n`;
    const page = async (state: unknown, call: string) => {
      const html = await readFile(
        new URL("../midway-bench/dashboard.html", import.meta.url),
        "utf8",
      );
      const script = (html.split("<script>")[1] as string)
        .split("</script>")[0]
        ?.replace("tick(); setInterval(tick, 5000);", "");
      const els: Record<string, { innerHTML: string }> = {};
      const out = runInNewContext(`${script}\n${call}`, {
        data: JSON.parse(JSON.stringify(state)),
        document: {
          getElementById: (id: string) => {
            els[id] ??= { innerHTML: "" };
            return els[id];
          },
        },
      });
      return { els, out };
    };
    it("shows the independent legacy window as provisional and keeps the failed native run unqualified", () => {
      const legacy = run("prov-a1-legacy", cpuLog(120, "legacy", commit));
      const failed = run("prov-b1-desktop", failedNative());
      expect(failed).toMatchObject({ status: "no samples", failure });
      const rows = matchedOf([legacy, failed]);
      expect(rows.map((p) => [p.pose, p.pairs, p.qualified, p.ratio])).toEqual([
        ["takeoff", 0, false, undefined],
        ["cockpit", 0, false, undefined],
        ["reargun", 0, false, undefined],
      ]);
      expect(rows.map((p) => p.unpaired?.legacy)).toEqual(
        [0.12, 0.24, 0.36].map((cpuMs, i) => ({
          run: "prov-a1-legacy",
          commit,
          cpuMs,
          instructions: 100 * (i + 1),
          treeCpuMs: cpuMs * 2,
        })),
      );
      expect(rows.every((p) => p.unpaired?.native === undefined)).toBe(true);
      expect(rows.every((p) => p.unpaired?.nativeState === "failed")).toBe(true);
      expect(rows[0]?.unpaired?.note).toContain(`prov-b1-desktop: ${failure}`);
      const state = midwayOf([legacy, failed]);
      const ac19 = state.kpis.find((k) => k.id === "AC-19");
      expect(ac19?.verdict).toBe("pending");
      expect(ac19?.current).toBeUndefined();
      expect(ac19?.detail).toMatch(/PROVISIONAL.*prov-a1-legacy.*observed 1000\/1002/s);
      expect(state.gap.desktop).toBeUndefined();
      expect(state.gap.legacyMs).toBeUndefined();
    });
    it("leaves profiled, excluded, rejected and wall-clock legacy runs out", () => {
      const failed = run("prov-b1-desktop", failedNative());
      const profiled = run("perf-prov-legacy", cpuLog(120, "legacy", commit));
      expect(profiled.profiled).toBe(true);
      const excluded = run("prov-x1-legacy", cpuLog(120, "legacy", commit));
      excluded.timingExclusion = "shared host";
      const rejected = run("prov-y1-legacy", cpuLog(120, "legacy", commit));
      rejected.rejection = "failed keep rule";
      const wall = run("prov-w1-legacy", budget(15.1) + report("wall-clock"));
      for (const legacy of [profiled, excluded, rejected, wall])
        expect(matchedOf([legacy, failed]).map((p) => p.unpaired)).toEqual([
          undefined,
          undefined,
          undefined,
        ]);
    });
    it("never pairs readings from different engine commits", () => {
      const legacy = run("prov-a2-legacy", cpuLog(120, "legacy", commit));
      const native = run(
        "prov-b2-desktop",
        cpuLog(80, "desktop", "d".repeat(40)),
        parityText(true),
      );
      const rows = matchedOf([legacy, native]);
      expect(rows.every((p) => p.pairs === 0 && !p.qualified && p.ratio === undefined)).toBe(true);
      expect(rows[1]?.unpaired).toMatchObject({
        legacy: { run: "prov-a2-legacy", commit, cpuMs: 0.24 },
        native: { run: "prov-b2-desktop", commit: "d".repeat(40), cpuMs: 0.16 },
        nativeState: "measured",
      });
    });
    it("shows the latest native failure instead of a stale independent reading", () => {
      const legacy = run("prov-a2-legacy", cpuLog(120, "legacy", commit));
      const native = run("prov-b2-desktop", cpuLog(80, "desktop", "d".repeat(40)));
      const failed = run("prov-b3-desktop", failedNative());
      legacy.mtimeMs = 1;
      native.mtimeMs = 2;
      failed.mtimeMs = 3;
      const rows = matchedOf([failed, legacy, native]);
      expect(rows.every((p) => p.unpaired?.nativeState === "failed")).toBe(true);
      expect(rows.every((p) => p.unpaired?.native === undefined)).toBe(true);
      expect(rows[0]?.unpaired?.note).toContain(`prov-b3-desktop: ${failure}`);
    });
    it("renders provisional legacy values, the native failure and a pending ratio", async () => {
      const state = midwayOf([
        run("prov-a1-legacy", cpuLog(120, "legacy", commit)),
        run("prov-b1-desktop", failedNative()),
      ]);
      const { els } = await page(state, "renderGap(data);");
      expect(els.gap?.innerHTML).toMatch(/^<div class="scroll"><table>.*<\/table><\/div><p /);
      expect(els.gap?.innerHTML).toContain("PROVISIONAL");
      expect(els.gap?.innerHTML).toContain("prov-a1-legacy");
      expect(els.gap?.innerHTML).toContain(failure);
      expect(els.gap?.innerHTML).toMatch(/0\.12 \/ failed/);
      expect(els.gap?.innerHTML).not.toMatch(/0\.12[^<]*no samples/);
      expect(els.gap?.innerHTML).not.toMatch(/\d(?:\.\d+)?x</);
      const { out: card } = await page(state, 'kpi(data.kpis.find((k) => k.id === "AC-19"))');
      expect(card).toContain("PROVISIONAL");
      expect(card).toContain('class="kpi pending"');
      const { els: overview } = await page(state, "side(data);");
      expect(overview.side?.innerHTML).toContain("provisional");
      expect(overview.side?.innerHTML).toContain("failed");
    });
  });
  it("keeps the wide matched CPU table in its own scroll container and shrinkable grid tracks", async () => {
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const gap = { innerHTML: "" };
    const row = { pose: "takeoff", arm: "desktop", pairs: 0, qualified: false };
    runInNewContext(`${script}\nrenderGap(data);`, {
      data: { matchedCpu: [{ ...row, detail: `pending/unavailable: ${"x".repeat(200)}` }] },
      document: { getElementById: () => gap },
    });
    // A nowrap table in an auto grid track stretched the page from 1600 px to 2471 px.
    expect(gap.innerHTML).toMatch(/^<div class="scroll"><table>.*<\/table><\/div><p /);
    expect(html).toMatch(/\.stack\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
    expect(html).toMatch(
      /max-width:1100px\)\s*\{\s*\.hero\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });
});

it("shows newest exact-window acquisitions above headlines without scoring sampled timings", async () => {
  const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
  const script = (html.split("<script>")[1] as string)
    .split("</script>")[0]
    ?.replace("tick(); setInterval(tick, 5000);", "");
  const windows = cpuReport(120).acquisition.cpuWindows;
  const rows = Array.from({ length: 7 }, (_, i) => ({
    dir: `recent-${i}`,
    arm: "desktop",
    mtimeMs: 1700000000000 + i * 1000,
    cpuWindows: windows,
  }));
  const output = runInNewContext(`${script}\nrecentMeasurements(data)`, {
    data: [
      ...rows,
      { dir: "missing-windows", mtimeMs: 1800000000000 },
      { ...rows[6], dir: "sampled", mtimeMs: 1700000008000, profiled: true },
    ],
    document: { getElementById: () => ({}) },
  });
  expect(html.indexOf('id="recent"')).toBeLessThan(html.indexOf('id="hero"'));
  expect(output.indexOf("sampled</td>")).toBeLessThan(output.indexOf("recent-6</td>"));
  expect(output).toContain("instrumented diagnostic");
  expect(output).toContain("sampled · excluded");
  expect(output).toContain("unqualified");
  expect(output).toContain("run-log time");
  expect(output).not.toContain("missing-windows");
  expect(output).not.toContain("recent-2</td>");
  expect(output.match(/instrumented diagnostic/g)).toHaveLength(3);
});

it("reconciles exact CPU boundaries rather than release/sample ticks", () => {
  const r = cpuReport(120, "native");
  const frames = cpuRecords(r.acquisition.cpuWindows);
  const log = (records: string[], report = r) => `${records.join("\n")}\n${JSON.stringify(report)}`;
  expect(nativeWindowCompletion(log(frames))).toBe("reconciled");
  expect(matchedCpuWindows(log(frames))).toHaveLength(3);
  // The runner's game-clock window ticks and the host's driven ticks differ by a constant (the game
  // led by 60 on Midway); frames outside a bracket (unheld draws between windows) do not count.
  const led = cpuRecords(r.acquisition.cpuWindows, -60);
  const between = 'TN_PLAYER_FRAME:{"tick":1,"updates":0}';
  expect(nativeWindowCompletion(log([between, ...led, between]))).toBe("reconciled");
  expect(matchedCpuWindows(log(frames, { ...r, observations: { signalSeries: [] } }))).toHaveLength(
    3,
  );
  for (const records of [
    frames.filter((_, i) => i !== 1),
    [...frames.slice(0, 2), frames[1] as string, ...frames.slice(2)],
    [...frames, "TN_PLAYER_FRAME:{bad}"],
    frames.map((f, i) => (i === 1 ? f.replace('"updates":1', '"updates":0') : f)),
    frames.map((f, i) => (i === 1 ? f.replace(/"tick":\d+/, '"tick":2.5') : f)),
    frames.slice(0, -1),
    [frames[0] as string, ...frames],
    frames.filter((f) => !f.startsWith("TN_PLAYER_RENDER_HOLD:")),
  ]) {
    expect(nativeWindowCompletion(log(records))).toBe("invalid");
    expect(matchedCpuWindows(log(records))).toBeUndefined();
  }
  expect(nativeWindowCompletion(log([]))).toBe("unavailable");
  expect(matchedCpuWindows(log([]))).toBeUndefined();
  expect(matchedCpuWindows(log(frames, { ...r, target: "android" }))).toBeUndefined();
  expect(matchedCpuWindows(JSON.stringify(cpuReport(120)))).toHaveLength(3);
});

it("excludes stack-sampled CPU windows even with valid counters and completion", () => {
  for (const profile of [{ kind: "perf-record", path: "/tmp/pose.perf.data" }, null, false, ""]) {
    const r = cpuReport(120, "native");
    Object.assign(r.acquisition.cpuWindows[0] as object, { profile });
    const log = `${cpuRecords(r.acquisition.cpuWindows).join("\n")}\n${JSON.stringify(r)}`;
    expect(nativeWindowCompletion(log)).toBe("reconciled");
    expect(matchedCpuWindows(log)).toBeUndefined();
    expect(run("sampled-desktop", log, parityText(true)).profiled).toBe(true);
  }
});

it("rejects invalid tick boundaries and host metadata", () => {
  for (const change of [
    { mainThread: undefined },
    { startTick: -1 },
    { startTick: 0.5 },
    { startTick: undefined },
    { endTick: 1000 },
    { endTick: Number.MAX_SAFE_INTEGER + 1 },
    { host: { load: [0], governors: {} } },
    { host: { load: [0, -1, 0], governors: {} } },
    { host: { load: [0, 0, 0], governors: ["performance"] } },
    { host: { load: [0, 0, 0], governors: { policy0: "" } } },
  ]) {
    const r = cpuReport(120);
    Object.assign(r.acquisition.cpuWindows[0] as object, change);
    expect(matchedCpuWindows(JSON.stringify(r))).toBeUndefined();
  }
});

it("keeps AC19 pending even when matched CPU reaches 2x", () => {
  const list = Array.from({ length: 3 }, (_, i) => [
    run(`speed-a${i}-legacy`, cpuLog(240, "legacy")),
    run(`speed-b${i}-desktop`, cpuLog(80, "desktop"), parityText(true)),
  ]).flat();
  expect(kpisOf(list).find((k) => k.id === "AC-19")).toMatchObject({
    target: 2,
    current: 3,
    verdict: "pending",
  });
});

describe("Midway hero", () => {
  const A = "a".repeat(40);
  const B = "b".repeat(40);
  const NOW = 10_000_000;
  const stamp = (r: IMidwayRun, mtimeMs: number) => {
    r.mtimeMs = mtimeMs;
    return r;
  };
  const arms = (list: IMidwayRun[], prd?: string) => midwayOf(list, prd, undefined, NOW).hero;
  const draw = async (state: ReturnType<typeof midwayOf>, call: string) => {
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const els: Record<string, { innerHTML: string; hidden?: boolean }> = {};
    const out = runInNewContext(`${script}\n${call}`, {
      data: JSON.parse(JSON.stringify(state)),
      document: {
        getElementById: (id: string) => {
          els[id] ??= { innerHTML: "" };
          return els[id];
        },
      },
    });
    return { els, out };
  };
  const pair = (commit: string, desktopMs: number, t: number, wasm = false) => [
    stamp(run(`h-a${t}-legacy`, cpuLog(120, "legacy", commit)), t),
    stamp(run(`h-b${t}-desktop`, cpuLog(desktopMs, "desktop", commit), parityText(true)), t + 1),
    ...(wasm
      ? [stamp(run(`h-c${t}-native`, cpuLog(80, "native", commit), parityText(true)), t + 2)]
      : []),
  ];
  const wasmFailure = (commit?: string) =>
    `${commit ? `arm=native buildMode=production engineCommit=${commit}\n` : ""}${JSON.stringify({
      diagnostics: [
        {
          code: "TN_PLAYTEST_RUNNER_FAILED",
          message: "page.evaluate: TN_ABI_6: get uuid unsupported",
          severity: "error",
        },
      ],
      pass: false,
    })}\n`;

  it("renders the native desktop and web Wasm panels with their own targets", async () => {
    const state = midwayOf([...pair(A, 80, 10, true)], undefined, undefined, NOW);
    const [desktop, wasm] = state.hero.arms;
    expect([desktop?.target, desktop?.stretch, wasm?.target, wasm?.stretch]).toEqual([
      2,
      3,
      1.5,
      undefined,
    ]);
    expect([desktop?.state, desktop?.pairs, wasm?.state, wasm?.pairs]).toEqual([
      "provisional",
      1,
      "provisional",
      1,
    ]);
    // 120 / 80 on the desktop: needs 0.5x more and 80 - 120 / 2 = 20 ms less on the engine main thread.
    expect(desktop?.poses[0]).toMatchObject({ ratio: 1.5, needRatio: 0.5, nativeIpc: 0.5 });
    expect(desktop?.poses[0]?.needMs).toBeCloseTo(0.08 - 0.12 / 2);
    const { els } = await draw(state, "renderHero(data);");
    const html = els.hero?.innerHTML ?? "";
    for (const text of [
      'data-arm="desktop"',
      'data-arm="native"',
      "Native desktop vs three.js",
      "Web Wasm vs three.js",
      "PROVISIONAL",
      "1 of 3 pairs",
      "1.50x",
      "stretch <b>3x</b>",
      "target <b>1.5x</b>",
      "first measurement",
      "IPC",
    ])
      expect(html).toContain(text);
    expect(html).toContain("target met");
  });

  it("never shows an old failed web Wasm run from another or unknown commit", async () => {
    for (const failed of [wasmFailure(B), wasmFailure()]) {
      const list = [stamp(run("old-c1-native", failed), 1), ...pair(A, 80, 10)];
      const wasm = arms(list).arms[1];
      expect(wasm).toMatchObject({ state: "nodata", pairs: 0, running: false });
      expect(wasm?.reason).toBeUndefined();
      expect(wasm?.poses.every((p) => p.ratio === undefined)).toBe(true);
      const { els } = await draw(midwayOf(list, undefined, undefined, NOW), "renderHero(data);");
      expect(els.hero?.innerHTML).toContain(`no matched run at engine ${A.slice(0, 7)}`);
      expect(els.hero?.innerHTML).not.toContain("get uuid");
    }
    // The same failure at the current commit is shown, with its short reason.
    const current = [stamp(run("c1-native", wasmFailure(A)), 20), ...pair(A, 80, 10)];
    expect(arms(current).arms[1]).toMatchObject({
      state: "failed",
      reason: expect.stringContaining("get uuid"),
    });
  });

  it("reads RUNNING while the matched run has no terminal report, and NO DATA once it goes quiet", async () => {
    const live = `arm=native buildMode=production engineCommit=${A}\n> build:web\nvite building`;
    const list = [stamp(run("h-c10-native", live), NOW - 60_000), ...pair(A, 80, 10)];
    expect(arms(list).arms[1]).toMatchObject({ state: "running", running: true, pairs: 0 });
    const { els } = await draw(midwayOf(list, undefined, undefined, NOW), "renderHero(data);");
    expect(els.hero?.innerHTML).toContain("RUNNING");
    expect(els.hero?.innerHTML).toContain("matched flight in progress");
    // Desktop keeps its pair and is not marked running.
    expect(arms(list).arms[0]).toMatchObject({ state: "provisional", running: false });
    const stale = [stamp(run("h-c10-native", live), 5), ...pair(A, 80, 10)];
    expect(arms(stale).arms[1]).toMatchObject({ state: "nodata", running: false });
  });

  it("shows the move against the previous engine commit and charts two commits", async () => {
    const list = [...pair(B, 100, 10), ...pair(A, 80, 20)];
    const desktop = arms(list).arms[0];
    expect(desktop?.previousCommit).toBe(B);
    expect(desktop?.poses[0]?.deltaRatio).toBeCloseTo(1.5 - 1.2);
    const state = midwayOf(list, undefined, undefined, NOW);
    const { els, out } = await draw(state, "renderHero(data); progress(data);");
    expect(els.hero?.innerHTML).toContain("▲ better +0.30x vs bbbbbbb");
    expect(out).toContain("<svg");
    expect(out).toContain("Matched ratio per pose by engine commit");
    // One commit has no line to draw.
    const single = await draw(
      midwayOf(pair(A, 80, 10), undefined, undefined, NOW),
      "progress(data);",
    );
    expect(single.out).toBe("");
    // A slower engine reads red and worse.
    const worse = midwayOf([...pair(B, 80, 10), ...pair(A, 100, 20)], undefined, undefined, NOW);
    const html = (await draw(worse, "renderHero(data);")).els.hero?.innerHTML;
    expect(html).toContain("▼ worse −0.30x vs bbbbbbb");
  });

  it("keeps AC-20 in the acceptance strip", async () => {
    const prd = "- [x] AC-1 [local]: done\n- [ ] AC-20 [local]: ipc\n- [ ] AC-15 [local]: ratio\n";
    const state = midwayOf(pair(A, 80, 10), prd, undefined, NOW);
    expect(state.prd?.open).toContain("AC-20");
    const { els } = await draw(state, "$('ring').innerHTML = ring(data.prd);");
    expect(els.ring?.innerHTML).toContain("AC-20");
  });
});

describe("exploratory application-completion windows", () => {
  const window = {
    label: "ac19-takeoff-completion",
    metric: "application-completion-interval",
    clock: "wall-clock",
    source: "render-callback-return",
    timebase: "performance-now-ms",
    epoch: 1,
    startTick: 1847,
    startMs: 0,
    endMs: 5000,
    durationMs: 5000,
    intervalCount: 100,
    completionIntervalP50Ms: 50,
    samples: Array.from({ length: 101 }, (_, i) => ({ sequence: i + 1, completedAtMs: i * 50 })),
    provenance: { requestedDisplay: ":0", qualified: false },
  };
  const observed = (value: unknown = window, pass = true) =>
    run(
      "ac19-takeoff-legacy",
      JSON.stringify({
        ...cpuReport(120),
        clock: "wall-clock",
        pass,
        acquisition: { completionWindow: value },
      }),
    );
  it("retains completed raw cadence as excluded exploratory data without CPU qualification", () => {
    const row = observed();
    expect(row.completionWindow).toMatchObject({
      label: window.label,
      completionIntervalP50Ms: 50,
      intervalCount: 100,
      durationMs: 5000,
      source: "render-callback-return",
      clock: "wall-clock",
    });
    expect(row.status).toBe("ok");
    expect(row.timingExclusion).toMatch(/exploratory/iu);
    expect(row.cpuWindows).toBeUndefined();
    const native = runOf(
      "ac19-takeoff-desktop",
      "ac19-takeoff",
      "desktop",
      1,
      JSON.stringify({
        ...cpuReport(120, "native"),
        clock: "wall-clock",
        acquisition: {
          completionWindow: {
            ...window,
            source: "present-return",
            timebase: "steady-clock-ms",
          },
        },
      }),
    );
    expect(native.completionWindow?.source).toBe("present-return");
    expect(matchedOf([row]).every((pose) => !pose.qualified && pose.ratio === undefined)).toBe(
      true,
    );
  });
  it("hides missing, failed and invalid cadence while excluding every attempted completion run", () => {
    for (const change of [
      { completionIntervalP50Ms: 0 },
      { completionIntervalP50Ms: null },
      { completionIntervalP50Ms: "50" },
      { intervalCount: 99 },
      { durationMs: 4999 },
      { source: "gpu-present" },
      { clock: "fixed-step" },
      { metric: "fps" },
      { timebase: "Date.now" },
    ]) {
      const row = observed({ ...window, ...change });
      expect(row.completionWindow).toBeUndefined();
      expect(row.timingExclusion).toMatch(/exploratory/iu);
    }
    expect(observed(window, false).completionWindow).toBeUndefined();
    expect(run("ordinary-legacy", JSON.stringify(cpuReport(120))).completionWindow).toBeUndefined();
  });
  it("shows single-pose completion p50 beside exact CPU rows without inventing missing poses", async () => {
    const html = await readFile(new URL("../midway-bench/dashboard.html", import.meta.url), "utf8");
    const script = (html.split("<script>")[1] as string)
      .split("</script>")[0]
      ?.replace("tick(); setInterval(tick, 5000);", "");
    const output = runInNewContext(`${script}\nrecentMeasurements(data)`, {
      data: [observed(), { dir: "invalid-cadence", mtimeMs: 1 }],
      document: { getElementById: () => ({}) },
    });
    expect(output).toContain("ac19-takeoff-completion");
    expect(output).toContain("50.00");
    expect(output).toContain("100 intervals");
    expect(output).toContain("render-callback-return");
    expect(output).toContain("application completion");
    expect(output).toContain("unqualified");
    expect(output).not.toContain("invalid-cadence");
  });
});
