import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "../../test-support/temp-dir.js";
import {
  type IAttempt,
  type IGitState,
  type IMonitorData,
  parsePrdProgress,
  readAttempts,
  readIterations,
  renderProgressHtml,
  safeArtifactHref,
} from "../engine-load-test/monitor.js";

import type { ICampaignRunRecord } from "../engine-load-test/campaign-report.js";
import type { IRunReport } from "../engine-load-test/report.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

function campaignRecord(overrides: Partial<ICampaignRunRecord> = {}): Record<string, unknown> {
  return {
    arm: {
      arm: "tn-native",
      backend: "vulkan",
      build: "release",
      buildSha256: DIGEST_A,
      engineVersion: "0.9.0",
      flags: { shadows: false, msaa: "off" },
    },
    block: 3,
    campaignId: "prd-449-2026-09-27-a",
    checksums: {
      "runs/prd-449-2026-09-27-a/block-3/tn-native.json": DIGEST_B,
      "runs/a/block-3/tn-native.frames.json": DIGEST_B,
    },
    conformance: { evidencePath: "conformance/tn-native.json", reason: null, status: "passed" },
    derivationVersion: 1,
    durations: {
      measured: { unit: "ms", value: 30_000 },
      startup: { reason: "not a startup profile", unit: "ms", value: null },
      warmup: { unit: "ms", value: 10_000 },
    },
    experiment: {
      executionProtocol: "deterministic-throughput",
      fixtureRevision: "cubes@2",
      load: "100k",
      optimizationClass: "default",
      renderingProfile: "common-1920x1080",
      variant: "all-rotating",
      workload: "bevy-many-cubes",
    },
    fixtureSha256: DIGEST_A,
    machine: {
      cpu: "AMD Ryzen 9 7950X",
      gpu: "Radeon RX 7900 XTX",
      operatingSystem: "Linux 6.11",
      preflight: { competingGpuWork: false, powerMode: "performance" },
    },
    metrics: {
      completedWorkMeanMsPerFrame: { unit: "ms/frame", value: 8.4 },
      frameP99Ms: { reason: "no per-frame intervals recorded", unit: "ms", value: null },
    },
    order: 2,
    planSha256: DIGEST_A,
    rawSeries: [
      { metric: "frameMs", path: "runs/a/block-3/tn-native.frames.json", sampleCount: 6000 },
    ],
    reason: null,
    runId: "prd-449-2026-09-27-a-b03-o02",
    schemaVersion: 2,
    session: "session-2",
    sourceSha256: DIGEST_B,
    status: "valid",
    timingDefinition: "completed-work mean over 6000 rendered frames, drained once at the boundary",
    ...overrides,
  };
}

const PRD = `**Status:** PARTIAL — two boxes landed

## 9. Verification strategy

- [ ] a box outside any phase section is not a phase box

### Phase 1: Freeze sources

- [x] landed box
- [ ] open box

### Phase 2: Measure

- [x] another landed box
`;

const HOSTILE = `<img src=x onerror="alert('x')"> & </script>`;

const MIXED_HEADINGS = `**Status:** mixed heading levels

### 3.1 Optimization classes

- [ ] prose box before any phase is not a phase box

### Phase 1: Freeze sources

- [x] landed box
- [ ] open box

### 6.1 Canonical fixture contract

- [x] subsection box still belongs to the phase it sits in

### Phase 2: Measure

- [x] another landed box
`;

function gitState(overrides: Partial<IGitState> = {}): IGitState {
  return {
    base: "1111111",
    baseError: null,
    branch: "feat/prd-449",
    commits: [],
    head: "2222222",
    worktree: "prd-449-cross-engine-benchmarks",
    ...overrides,
  };
}

function data(overrides: Partial<IMonitorData> = {}): IMonitorData {
  const { phases, status } = parsePrdProgress(PRD);
  return {
    attempts: [],
    attemptsRoot: "artifacts/engine-load-test/prd-449",
    generatedAt: "2026-09-27T10:00:00.000Z",
    git: gitState(),
    prd: {
      done: phases.reduce((sum, phase) => sum + phase.done, 0),
      file: "docs/PRDs/done/PRD-449-cross-engine-benchmarks-and-html-report.md",
      missing: null,
      phases,
      status,
      total: phases.reduce((sum, phase) => sum + phase.total, 0),
    },
    ...overrides,
  };
}

async function campaignDir(): Promise<string> {
  return makeTempDir("tn-monitor-");
}

describe("PRD-449 campaign progress monitor", () => {
  it("counts only phase boxes and says pending for an empty campaign", () => {
    const html = renderProgressHtml(data());
    expect(html).toContain("2/3");
    expect(html).not.toContain("1/4");
    // Two pending tables: iterations and retained attempts. The PRD's own boxes are not pending.
    expect(html.match(/pending — nothing recorded yet/g)).toHaveLength(2);
    expect(html).toContain("PARTIAL — two boxes landed");
    // Nothing measured is invented for a campaign that has kept nothing yet.
    expect(html).toContain("No qualified iterations yet");
    expect(html).toContain("Latest qualified candidate");
    expect(html).toContain("Δ original baseline");
    expect(html).toContain("No qualified run");
    expect(html).not.toContain("0.0%");
    expect(html).not.toContain("<polyline");
    // Offline self-refresh, no network: a meta refresh, and the manual button still there.
    expect(html).toContain('<meta http-equiv="refresh" content="15">');
    expect(html).toContain("location.reload()");
  });

  it("counts a `###` subsection as no row and no stolen box", () => {
    const { phases, status } = parsePrdProgress(MIXED_HEADINGS);
    expect(phases).toEqual([
      { done: 2, name: "Phase 1: Freeze sources", total: 3 },
      { done: 1, name: "Phase 2: Measure", total: 1 },
    ]);
    expect(status).toBe("mixed heading levels");

    const html = renderProgressHtml(
      data({
        prd: {
          done: 3,
          file: "docs/PRDs/done/PRD-449-cross-engine-benchmarks-and-html-report.md",
          missing: null,
          phases,
          status,
          total: 4,
        },
      }),
    );
    expect(html).toContain("2/3");
    expect(html).not.toContain("3.1 Optimization classes");
    expect(html).not.toContain("6.1 Canonical fixture contract");
  });

  it("lists every kept attempt in chronological order, invalid and unreadable included", async () => {
    const root = await campaignDir();
    const runs = path.join(root, "runs");
    await mkdir(path.join(runs, "block-2"), { recursive: true });
    await writeFile(
      path.join(runs, "block-2", "run.json"),
      JSON.stringify({ recordedAt: "2026-09-02T09:00:00Z", runStatus: "invalid" }),
    );
    await writeFile(
      path.join(runs, "aaa-early.json"),
      JSON.stringify({
        recordedAt: "2026-09-01T09:00:00Z",
        rungs: [{ frameMs: [12.3], p95: 9.9 }],
      }),
    );
    await writeFile(path.join(runs, "zzz-truncated.json"), "{ truncated");
    // Frozen Godot source and compatibility records live beside `runs/`; they are inputs, not
    // attempts, so an attempt table that lists them is reporting a benchmark nobody ran.
    await mkdir(path.join(root, "godot-benchmarks", "src"), { recursive: true });
    await writeFile(
      path.join(root, "godot-benchmarks", "src", "extension_api.json"),
      JSON.stringify({ recordedAt: "2026-09-03T09:00:00Z", rungs: [] }),
    );

    const attempts = await readAttempts(root);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "recorded",
      "invalid",
      "unreadable",
    ]);
    expect(attempts[1]?.timeSource).toBe("record");
    // Sources are relative to the campaign root, where progress.html is written.
    expect(attempts.map((attempt) => attempt.source)).toEqual([
      "runs/aaa-early.json",
      "runs/block-2/run.json",
      "runs/zzz-truncated.json",
    ]);

    const html = renderProgressHtml(
      data({
        attempts,
        attemptsRoot: root,
        git: gitState({
          // Same day, and sha order is the opposite of git --reverse order: sorting by date then
          // sha would show "second landed" first.
          commits: [
            { date: "2026-09-01", sha: "bb22cc3", subject: "first landed" },
            { date: "2026-09-01", sha: "aa11bb2", subject: "second landed" },
          ],
        }),
      }),
    );
    expect(html.indexOf("runs/aaa-early.json")).toBeLessThan(html.indexOf("runs/block-2/run.json"));
    expect(html.indexOf("runs/block-2/run.json")).toBeLessThan(
      html.indexOf("runs/zzz-truncated.json"),
    );
    expect(html).not.toContain("extension_api.json");
    expect(html).toContain('href="runs/aaa-early.json"');
    expect(html).toContain('href="runs/block-2/run.json"');
    expect(html).toContain("invalid");
    expect(html.indexOf("bb22cc3")).toBeLessThan(html.indexOf("aa11bb2"));
    // A run's own numbers stay in that run's file; the page reports only its status and path.
    expect(html).not.toMatch(/>12\.3<|>9\.9</u);
  });

  it("escapes untrusted text and links only paths inside the campaign root", async () => {
    const root = await campaignDir();
    const hostileName = "<img src=x onerror=alert(1)>.json";
    await mkdir(path.join(root, "runs"), { recursive: true });
    await writeFile(path.join(root, "runs", hostileName), JSON.stringify({ runStatus: HOSTILE }));
    const attempts = await readAttempts(root);

    const html = renderProgressHtml(
      data({
        attempts,
        attemptsRoot: root,
        git: gitState({ commits: [{ date: "2026-09-01", sha: "aaaaaaa", subject: HOSTILE }] }),
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("</script>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;/script&gt;");
    // An in-root file is linked with a percent-encoded relative href, never raw markup.
    expect(html).toContain(`href="runs/${encodeURIComponent(hostileName)}"`);

    expect(safeArtifactHref(root, path.join(root, "runs", "run.json"))).toBe("runs/run.json");
    expect(safeArtifactHref(root, path.join(root, "runs", "block-1", "run.json"))).toBe(
      "runs/block-1/run.json",
    );
    expect(safeArtifactHref(root, path.join(root, "..", "escape.json"))).toBeNull();
    expect(safeArtifactHref(root, path.join(root, "https:", "evil.json"))).toBeNull();
    expect(safeArtifactHref(root, root)).toBeNull();
  });
});

describe("performance iteration evidence", () => {
  it("renders real iteration trends only for matching, retained, checksummed hardware runs", async () => {
    const root = await campaignDir();
    await mkdir(path.join(root, "runs"));
    await mkdir(path.join(root, "iterations"));
    const raw = "[10,8,6]";
    await writeFile(path.join(root, "samples.json"), raw);
    const checksum = createHash("sha256").update(raw).digest("hex");
    for (const [id, value] of [
      ["baseline", 10],
      ["incumbent", 8],
      ["candidate", 6],
    ] as const) {
      await writeFile(
        path.join(root, "runs", `${id}.json`),
        JSON.stringify(
          campaignRecord({
            runId: id,
            rawSeries: [{ metric: "frameMs", path: "samples.json", sampleCount: 3 }],
            checksums: { "samples.json": checksum },
            metrics: { completedWorkMeanMsPerFrame: { unit: "ms/frame", value } },
          }),
        ),
      );
    }
    const iteration = {
      id: "iteration-1",
      sequence: 1,
      baselineRunId: "baseline",
      incumbentRunId: "incumbent",
      candidateRunId: "candidate",
      hypothesis: "Reduce dispatch",
      bottleneck: "Submission",
      nextHypothesis: "Measure batching",
      decision: "keep",
    };
    await writeFile(path.join(root, "iterations", "one.json"), JSON.stringify(iteration));
    const collected = {
      attempts: await readAttempts(root),
      attemptsRoot: root,
      ...(await readIterations(root)),
    };
    const html = renderProgressHtml(data(collected));
    expect(html).toContain("<polyline");
    expect(html).toContain("6.000 ms/frame");
    expect(html).toContain(">6.000</strong>");
    expect(html).toContain(">-40.0%</strong>");
    expect(html).toContain(">-25.0%</strong>");
    expect(html).toContain("-40.0% / -25.0%");
    expect(html).toContain('href="runs/candidate.json"');
    expect(html).toContain("Measure batching");
    expect(renderProgressHtml(data({ ...collected, iterations: [] }))).not.toContain("<polyline");
    const candidate = collected.attempts.find((attempt) => attempt.run?.runId === "candidate");
    if (!candidate?.run) throw new Error("Missing candidate fixture");
    const originalRun = candidate.run;
    candidate.run = {
      ...originalRun,
      experiment: { ...originalRun.experiment, load: "different-load" },
    };
    expect(renderProgressHtml(data(collected))).not.toContain("<polyline");
    candidate.run = originalRun;
    expect(
      renderProgressHtml(
        data({ ...collected, iterations: [{ ...iteration, decision: "invalid" }] }),
      ),
    ).not.toContain("<polyline");
    candidate.run = { ...candidate.run, machine: { ...candidate.run.machine, gpu: "SwiftShader" } };
    expect(renderProgressHtml(data(collected))).toContain("No qualified iterations yet");
    expect(renderProgressHtml(data(collected))).not.toContain("-40.0%");
    await writeFile(path.join(root, "samples.json"), "changed");
    const corrupted = await readAttempts(root);
    expect(corrupted.every((attempt) => attempt.evidenceError?.includes("checksum"))).toBe(true);
    expect(renderProgressHtml(data({ ...collected, attempts: corrupted }))).not.toContain(
      "<polyline",
    );
  });

  it("reports malformed iteration records without fabricating a timeline", async () => {
    const root = await campaignDir();
    await mkdir(path.join(root, "iterations"));
    await writeFile(path.join(root, "iterations", "broken.json"), "{}");
    const result = await readIterations(root);
    expect(result.iterations).toEqual([]);
    expect(result.iterationErrors[0]).toContain("Missing id");
  });
});

it("plots exploratory pilot samples and distinguishes observed, zero, null and absent means", () => {
  const pilot: IRunReport = {
    arm: "tn-web",
    build: { type: "release", notes: "vite production build" },
    device: { battery: null, label: "desktop" },
    display: { height: 1080, width: 1920, refreshHz: 60, vsync: false },
    driver: { adapter: "nvidia / turing", renderer: "three/webgpu WebGPURenderer" },
    engine: { name: "threenative", version: "0.9.0" },
    rungs: [
      {
        mode: "L1",
        objectCount: 1024,
        repeat: 1,
        frameMs: [2, 4, 3, 5],
        drawCalls: 1,
        triangles: 12288,
        visibleObjects: 1024,
        positionHash: "fixture",
      },
    ],
  };
  const attempt = {
    kind: "attempt" as const,
    status: "recorded",
    time: "2026-09-27T10:00:00Z",
    timeSource: "filesystem" as const,
    source: "pilots/hardware.json",
    pilot,
  };
  const html = renderProgressHtml(data({ pilots: [attempt] }));
  expect(html).toContain("Latest hardware pilot frame trace");
  expect(html).toContain("4 samples · p50 3.000 ms · p95 5.000 ms");
  const points = html
    .match(/<polyline points="([^"]+)"/)?.[1]
    ?.split(" ")
    .map((point) => point.split(",").map(Number));
  expect(points).toHaveLength(4);
  expect(points?.map((point) => point[0])).toEqual([
    55, 251.66666666666666, 448.3333333333333, 645,
  ]);
  expect(points?.[0]?.[1]).toBeCloseTo(127.2727);
  expect(points?.[3]?.[1]).toBeCloseTo(48.1818);
  expect(html).toContain('href="pilots/hardware.json"');
  expect(html).toContain("not completed-work time or iteration improvement");
  expect(html).toContain("No qualified iterations yet");
  expect(html).toContain("No qualified run");
  const rung = pilot.rungs[0];
  if (!rung) throw new Error("Missing pilot rung fixture");
  const withObservation = (value: number | null): string =>
    renderProgressHtml(
      data({
        pilots: [
          {
            ...attempt,
            pilot: {
              ...pilot,
              rungs: [
                {
                  ...rung,
                  completedWorkMeanMs: value,
                  completedWorkReason: value === null ? "GPU drain unavailable <unsafe>" : null,
                  cpuSubmitMeanMs: 0,
                  measuredFrames: 4,
                  drainPolicy: "drain after final frame",
                },
              ],
            },
          },
        ],
      }),
    );
  const measured = withObservation(18.125);
  expect(measured).toContain("18.125 ms/frame");
  expect(measured).toContain("0.000 ms/frame");
  expect(measured).toContain("Exploratory, cadence-inclusive browser delivery");
  expect(measured).toContain("Measured frames</span><strong>4</strong>");
  expect(measured).toContain("Drain policy: drain after final frame");
  expect(measured).toContain("No qualified run");
  const currentExperiment = measured
    .split("<h2>Current experiment</h2>")[1]
    ?.split("</section>")[0];
  expect(currentExperiment).toContain(
    "completed-work mean 18.125 ms/frame; CPU submit mean 0.000 ms/frame",
  );
  expect(currentExperiment).toContain("Stage/GPU attribution is unavailable");
  expect(currentExperiment).toContain("Profile CPU submission and individual render stages");
  expect(currentExperiment).toContain("no diagnosed bottleneck or speedup");

  const unavailable = withObservation(null);
  expect(unavailable).toContain("Completed-work mean</span><strong>—</strong>");
  expect(unavailable).toContain("Unavailable: GPU drain unavailable &lt;unsafe&gt;");
  expect(unavailable).not.toContain("18.125 ms/frame");
  expect(html).toContain("Not recorded");

  expect(
    renderProgressHtml(
      data({
        pilots: [
          { ...attempt, pilot: { ...pilot, build: { ...pilot.build, notes: "vite dev build" } } },
        ],
      }),
    ),
  ).not.toContain("Latest hardware pilot frame trace");
  expect(
    renderProgressHtml(
      data({
        pilots: [
          {
            ...attempt,
            pilot: { ...pilot, driver: { ...pilot.driver, adapter: "google / swiftshader" } },
          },
        ],
      }),
    ),
  ).not.toContain("Latest hardware pilot frame trace");
});

it("puts the measured pilot's own metrics and per-frame line first, and invents no speedup", () => {
  // The real 60-frame NVIDIA production run, sampled exactly as retained on disk: 56 frames at
  // 3.000 ms, then 4.255 ms, then three outliers, so p95 = 4.255 ms and not the mean.
  const frameMs = [10.105, 4.775, 10.1, 4.255, ...Array<string | number>(56).fill(3)];
  const pilot: IRunReport = {
    arm: "tn-web",
    build: { type: "release", notes: "vite production build, SceneRenderProjection consumer" },
    device: { battery: null, label: "desktop" },
    display: { height: 1080, width: 1920, refreshHz: 60, vsync: false },
    driver: { adapter: "nvidia / turing", renderer: "three/webgpu WebGPURenderer" },
    engine: { name: "threenative", version: "0.9.0" },
    rungs: [
      {
        mode: "L1",
        objectCount: 1024,
        repeat: 0,
        frameMs: frameMs.map(Number),
        drawCalls: 1,
        triangles: 12288,
        visibleObjects: 1024,
        positionHash: "fixture",
        completedWorkMeanMs: 3.4741666664679847,
        cpuSubmitMeanMs: 3.0559999977548915,
        measuredFrames: 60,
        drainPolicy: "drain after final frame",
      },
    ],
  };
  const html = renderProgressHtml(
    data({
      pilots: [
        {
          kind: "attempt" as const,
          status: "recorded",
          time: "2026-09-27T18:37:46.000Z",
          timeSource: "filesystem" as const,
          source: "pilots/tn-completed-work-2026-09-27.json",
          pilot,
        },
      ],
    }),
  );
  // Four separate observations, each with its own value: no submit/completed-work substitution.
  expect(html).toContain("Completed-work mean</span><strong>3.474 ms/frame</strong>");
  expect(html).toContain("Frame interval p95</span><strong>4.255 ms</strong>");
  expect(html).toContain("CPU submit mean</span><strong>3.056 ms/frame</strong>");
  expect(html).toContain("Measured frames</span><strong>60</strong>");
  expect(html).toContain("Exploratory · one run · cadence-inclusive");
  expect(html).toContain('href="pilots/tn-completed-work-2026-09-27.json"');
  // The measured run leads: its own section, its own line, and the empty qualified trend after it.
  expect(html.indexOf("Latest hardware pilot frame trace")).toBeLessThan(
    html.indexOf("Latest qualified candidate"),
  );
  expect(html.indexOf("Latest hardware pilot frame trace")).toBeLessThan(
    html.indexOf("No qualified iterations yet"),
  );
  const firstLine = html
    .match(/<polyline points="([^"]+)"/)?.[1]
    ?.split(" ")
    .map((point) => point.split(",").map(Number));
  expect(firstLine).toHaveLength(60);
  expect(firstLine?.at(0)).toEqual([55, 180 - (10.105 / 11.1155) * 145]);
  // No qualified run exists, so no delta, percentage or multiple is derived from the pilot above.
  expect(html).not.toMatch(/-?\d+\.\d%/u);
  expect(html).toContain("<strong>—</strong>");
  expect(html).not.toMatch(/\d\s*×/u);
  expect(html).toContain("No qualified run");
});

it("keeps the latest invalid or rejected iteration visible as the current experiment", () => {
  for (const decision of ["invalid", "reject"] as const) {
    const iteration = {
      id: "iteration-latest",
      sequence: 2,
      baselineRunId: "absent-baseline",
      incumbentRunId: "absent-incumbent",
      candidateRunId: "absent-candidate",
      hypothesis: "Profile dispatch",
      bottleneck: "Recorded submission hypothesis",
      nextHypothesis: "Repeat after fixing the invalid sample window",
      decision,
    };
    const html = renderProgressHtml(
      data({
        iterations: [
          { ...iteration, id: "iteration-earlier", sequence: 1, bottleneck: "Earlier hypothesis" },
          iteration,
        ],
      }),
    );
    const panel = html.split("<h2>Current experiment</h2>")[1]?.split("</section>")[0];
    expect(panel).toContain("Recorded submission hypothesis");
    expect(panel).toContain("Repeat after fixing the invalid sample window");
    expect(panel).toContain("iteration-latest");
    expect(panel).not.toContain("Earlier hypothesis");
    expect(panel).not.toContain("Profile CPU submission and individual render stages");
    expect(html).toContain("No qualified iterations yet");
  }
});

type TRenderMode = IRunReport["rungs"][number]["mode"];

interface IScoreboardRung {
  drawCalls: number;
  mode: TRenderMode;
  objectCount: number;
  p50: number;
  p95: number;
}

/** 100 frames: 94 at the run's p50 and 6 at its p95, so summarize() returns both exactly and a
 *  fixture's p95 can disagree with its p50 — which is what the worst-case sub-line is for. */
function frames(p50: number, p95: number): number[] {
  return [...Array<number>(94).fill(p50), ...Array<number>(6).fill(p95)];
}

/** One retained run file, named the way the repeated experiment names it, carrying one rung per
 *  row that run measured. A run that never wrote a rung simply has no such entry here. */
function scoreboardRun(
  source: string,
  engine: "godot" | "threenative",
  rungs: IScoreboardRung[],
): IAttempt {
  return {
    kind: "attempt" as const,
    source,
    status: "recorded",
    time: "2026-09-27T23:00:00Z",
    timeSource: "filesystem" as const,
    pilot: {
      arm: engine === "godot" ? "godot-desktop" : "tn-desktop",
      build: { type: "release", notes: "release export" },
      device: { battery: null, label: "desktop-native-linux" },
      display: { height: 720, width: 1280, refreshHz: 60, vsync: false },
      driver: { adapter: "native host surface", renderer: "renderer" },
      engine: { name: engine, version: engine === "godot" ? "4.7.1-stable" : "workspace" },
      rungs: rungs.map((rung) => ({
        drawCalls: rung.drawCalls,
        frameMs: frames(rung.p50, rung.p95),
        mode: rung.mode,
        objectCount: rung.objectCount,
        positionHash: "e9a32f01",
        repeat: 0,
        triangles: 49_155,
        visibleObjects: rung.objectCount,
      })),
    } as IRunReport,
  };
}

const TN_R1 = "pilots/scoreboard-tn-r1-2026-09-27.json";
const TN_R3 = "pilots/scoreboard-tn-r3-2026-09-27.json";
const GODOT_R3 = "pilots/scoreboard-godot-r3-2026-09-27.json";

interface IRowFixture {
  drawCalls?: number;
  mode: TRenderMode;
  objectCount?: number;
  p95?: number;
  /** One p50 per run that measured this row; a run with no entry never wrote the rung. */
  p50s: number[];
}

/** The three alternating run files one arm keeps, each carrying every row under test — which is how
 *  the real run files are shaped. A row's spread is the range of its own run p50s, so the win is
 *  tested against the spread the runs actually show. */
function scoreboardRuns(engine: "godot" | "threenative", rows: IRowFixture[]): IAttempt[] {
  const label = engine === "godot" ? "godot" : "tn";
  const runCount = Math.max(...rows.map((row) => row.p50s.length));
  return Array.from({ length: runCount }, (_, run) =>
    scoreboardRun(
      `pilots/scoreboard-${label}-r${run + 1}-2026-09-27.json`,
      engine,
      rows.flatMap((row) => {
        const p50 = row.p50s[run];
        return p50 === undefined
          ? []
          : [
              {
                drawCalls: row.drawCalls ?? 3,
                mode: row.mode,
                objectCount: row.objectCount ?? 4096,
                p50,
                p95: row.p95 ?? p50 * 1.5,
              },
            ];
      }),
    ),
  );
}

const GODOT_BOX1000 = "pilots/godot-lights-meshes-box1000-upstream-2026-09-27.json";

const box1000Results = { render_cpu: 0.6345, render_gpu: 0.4795, time: 4.028 };
const box1000 = {
  benchmarks: [
    { category: "Rendering > Lights And Meshes", name: "Box 1000", results: box1000Results },
  ],
  engine: { version: "v4.7.1.stable.official" },
  system: { cpu_name: "AMD Ryzen 9 5900X", os: "Linux" },
};

describe("ThreeNative against Godot scoreboard", () => {
  // The cube scoreboard's own section. PRD-464's realistic-scene ladder is rendered above it and
  // uses the same table markup, so a bare "first compare-table" would read the ladder instead.
  const cubeSection = (html: string): string =>
    html.slice(
      html.indexOf('<section class="panel" aria-label="ThreeNative against Godot scoreboard">'),
    );

  const tableOf = (html: string): string => {
    const section = cubeSection(html);
    return section.slice(
      section.indexOf('<table class="compare-table">'),
      section.indexOf("</table>", section.indexOf('<table class="compare-table">')),
    );
  };

  const bannerOf = (html: string): string => {
    const section = cubeSection(html);
    return section.slice(
      section.indexOf('<div class="verdict-banner">'),
      section.indexOf('<table class="compare-table">'),
    );
  };

  it("calls a win only when the gap beats the run-to-run spread, and reports the spread beside it", () => {
    const html = renderProgressHtml(
      data({
        pilots: [
          ...scoreboardRuns("threenative", [{ mode: "L3", p50s: [3.4, 3.45, 3.5], p95: 6 }]),
          ...scoreboardRuns("godot", [{ drawCalls: 2, mode: "L1", p50s: [4, 4.1, 4.2], p95: 5 }]),
        ],
      }),
    );
    // First thing on the page, above every later section.
    expect(html.indexOf("ThreeNative vs Godot — 1,024 + 4,096 cubes")).toBeLessThan(
      html.indexOf("Qualified iterations"),
    );
    const table = tableOf(html);
    // The banner is the first thing inside the scoreboard, and counts every head-to-head row.
    expect(bannerOf(html)).toContain(
      'ThreeNative wins <span class="win-tn">1</span>, Godot wins <span class="win-godot">0</span>, ties 5 — of 6 head-to-head rows',
    );
    // The three named scenes, grouped by row name, at both cube counts.
    expect(table).toContain("Same scene, shipped defaults");
    expect(table).toContain("Can&#39;t batch (unique material per cube)");
    expect(table).toContain("Explicit instancing (both)");
    expect(table).toContain("1,024 cubes");
    expect(table).toContain("4,096 cubes");
    // Median of the run p50s, with the spread and run count the win was tested against.
    expect(table).toContain("3.45 ms (±0.10, 3 runs)");
    expect(table).toContain("4.10 ms (±0.20, 3 runs)");
    expect(table).toContain("p95 6.00 ms");
    expect(table).toContain("ThreeNative wins — 1.2x faster on a typical frame");
    expect(table).toContain('<span class="pill win-tn">TN</span>');
    // TN takes the median and loses the worst-case frame: the cell says both instead of picking one.
    expect(table).toContain("p95 goes the other way: Godot 5.00 vs 6.00 ms");
    // Draw calls come from the first retained run, Godot against TN.
    expect(table).toContain("2 vs 3");
    // Every run file is named; the ones not retained yet are named in their place.
    expect(table).toContain(`href="${TN_R1}"`);
    expect(table).toContain(`href="${TN_R3}"`);
    expect(table).toContain(`href="${GODOT_R3}"`);
    expect(table).toContain("scoreboard-tn-r2-2026-09-27.json");
    // The single-pilot rows and their per-frame series are gone, not hidden.
    expect(table).not.toContain("TN auto-batching OFF (diagnostic)");
    expect(table).not.toContain("shipped-default-40warmup");
    expect(html).not.toContain("per-frame series");
    expect(html).not.toContain("TN internal diagnostic");
    // Bars for the rows that have runs, each group titled with its own verdict.
    expect(html).toContain('class="scoreboard-bars"');
    expect(html.match(/<rect x="52"/gu)).toHaveLength(2);
    expect(html).toContain('<text class="group win-tn" x="430"');
    expect(html).toContain('<text class="group tie" x="430"');
    // Where a row loses, in the same runs as the table.
    const losses = html.slice(html.indexOf("<h3>Where TN loses</h3>"), html.indexOf("</ul>"));
    expect(losses).toContain(
      "Same scene, shipped defaults · 4,096 cubes: Godot ahead by 1.00 ms on p95",
    );
    expect(losses).not.toContain("ms on p50");
    // The protocol the runs were collected under is stated, and the qualification gaps collapsed.
    expect(html).toContain("3 alternating runs per engine, 40 warmup frames then 120 measured");
    expect(html).toContain("1280x720 uncapped on a physical display");
    const afterTable = html.slice(html.indexOf("</table>"));
    expect(html).toContain("<summary>Methodology and caveats</summary>");
    expect(table).not.toContain("L1 has a known output/draw mismatch");
    expect(afterTable).toContain("L1 has a known output/draw mismatch");
    expect(afterTable).toContain("a win is only called when the gap between the two medians beats");
  });

  it("reads a gap inside the spread, or a single run, as a tie", () => {
    const tie = renderProgressHtml(
      data({
        pilots: [
          // The L3 rows are 0.10 ms apart, but each side's own three runs span 0.40 ms.
          ...scoreboardRuns("threenative", [
            // One L4 run each, 2.2 ms apart: a single run is a measurement of the run, not a win.
            { drawCalls: 2_375, mode: "L4", p50s: [1.5] },
            { mode: "L3", p50s: [3.4, 3.6, 3.8] },
          ]),
          ...scoreboardRuns("godot", [
            { drawCalls: 2, mode: "L4", p50s: [3.7] },
            { mode: "L1", p50s: [3.5, 3.7, 3.9] },
          ]),
        ],
      }),
    );
    const table = tableOf(tie);
    expect(table).toContain("Tie — within run-to-run noise");
    expect(table).toContain('<span class="pill tie">Tie</span>');
    expect(table).not.toContain("x faster on a typical frame");
    expect(table).toContain("1.50 ms (±0.00, 1 run)");
    expect(bannerOf(tie)).toContain(
      'ThreeNative wins <span class="win-tn">0</span>, Godot wins <span class="win-godot">0</span>, ties 6 — of 6 head-to-head rows',
    );
    expect(tie).not.toContain("is faster in");
  });

  it("counts a win, a loss and a tie in the same banner", () => {
    const html = renderProgressHtml(
      data({
        pilots: [
          ...scoreboardRuns("threenative", [
            { mode: "L2", p50s: [4, 4.1, 4.2] },
            { mode: "L3", p50s: [2, 2.1, 2.2] },
            { mode: "L4", p50s: [3, 3.1, 3.2] },
          ]),
          ...scoreboardRuns("godot", [
            { mode: "L1", p50s: [4, 4.1, 4.2] },
            { mode: "L2", p50s: [2, 2.1, 2.2] },
            { mode: "L4", p50s: [3, 3.1, 3.2] },
          ]),
        ],
      }),
    );
    expect(bannerOf(html)).toContain(
      'ThreeNative wins <span class="win-tn">1</span>, Godot wins <span class="win-godot">1</span>, ties 4 — of 6 head-to-head rows',
    );
    const table = tableOf(html);
    expect(table).toContain("ThreeNative wins — 2.0x faster on a typical frame");
    expect(table).toContain('<span class="pill win-godot">Godot</span>');
    expect(table).toContain("Tie — within run-to-run noise");
  });

  it("renders a row whose runs are not retained as pending, never as a number or a near neighbour", () => {
    const empty = renderProgressHtml(data());
    const table = tableOf(empty);
    // Both engine cells, the winner cell and the draw-call cell of all six rows.
    expect(table.match(/pending — no retained runs yet/gu)).toHaveLength(24);
    expect(table).not.toMatch(/\d+\.\d\d ms/u);
    expect(table).not.toContain("faster");
    // Nobody measured a win, so the score claims none and the loss list stays off the page.
    expect(bannerOf(empty)).toContain(
      'ThreeNative wins <span class="win-tn">0</span>, Godot wins <span class="win-godot">0</span>, ties 6 — of 6 head-to-head rows',
    );
    expect(empty).not.toContain("Where TN loses");
    expect(empty).toContain('class="scoreboard-bars"');

    // A half-written experiment is pending for the sides that have not landed, not a win.
    const partial = renderProgressHtml(
      data({
        pilots: [
          scoreboardRun(TN_R1, "threenative", [
            { drawCalls: 3, mode: "L3", objectCount: 1024, p50: 2, p95: 3 },
          ]),
          ...scoreboardRuns("godot", [{ mode: "L1", objectCount: 1024, p50s: [4, 4.1, 4.2] }]),
        ],
      }),
    );
    const partialTable = tableOf(partial);
    expect(partialTable).toContain("2.00 ms (±0.00, 1 run)");
    expect(partialTable).toContain("Tie — within run-to-run noise");
    expect(partialTable).toContain("pending — no retained runs yet");
    // The runner appends .json to --out, so a name that already ended in .json lands as .json.json.
    const doubled = renderProgressHtml(
      data({
        pilots: [
          scoreboardRun(`${TN_R1}.json`, "threenative", [
            { drawCalls: 3, mode: "L3", objectCount: 1024, p50: 2, p95: 3 },
          ]),
        ],
      }),
    );
    expect(tableOf(doubled)).toContain("2.00 ms (±0.00, 1 run)");
  });

  it("reports the measured fix against the same engine, paired block by block", () => {
    const ab = (side: "before" | "after", block: number, p50: number): IAttempt =>
      scoreboardRun(
        `pilots/tn-desktop-4096-l3-ab-${side}-${block}-2026-09-27.json`,
        "threenative",
        [{ drawCalls: 3, mode: "L3", objectCount: 4096, p50, p95: p50 * 1.5 }],
      );
    const html = renderProgressHtml(
      data({
        pilots: [
          ab("before", 1, 10),
          ab("after", 1, 6),
          ab("before", 2, 12),
          ab("after", 2, 7),
          ab("before", 3, 14),
          ab("after", 3, 8),
        ],
      }),
    );
    const panel = html.slice(
      html.indexOf('<section class="panel" aria-label="TN fixes this round">'),
    );
    expect(panel).toContain("Projection reconcile: TN shipped-default frame 12.00 → 7.00 ms");
    expect(panel).toContain("median of 3 paired blocks (−42%), faster in 3/3");
    expect(panel).toContain('href="pilots/tn-desktop-4096-l3-ab-before-1-2026-09-27.json"');
    expect(panel).toContain('href="pilots/tn-desktop-4096-l3-ab-after-3-2026-09-27.json"');
    expect(panel).toContain("Block 2:");
    // Right after the scoreboard, before the next section.
    expect(html.indexOf("TN fixes this round")).toBeGreaterThan(html.indexOf("scoreboard-bars"));
    expect(html.indexOf("TN fixes this round")).toBeLessThan(html.indexOf("Qualified iterations"));

    // A half-written pair set reports the file counts it has instead of a pairing it cannot prove.
    const unpaired = renderProgressHtml(
      data({
        pilots: [ab("before", 1, 10), ab("before", 2, 12), ab("before", 3, 14), ab("after", 9, 6)],
      }),
    );
    expect(unpaired).toContain("median of 3 before files against 1 after files");
    expect(unpaired).not.toContain("faster in");

    // Nothing retained yet: no improvement claimed at all.
    expect(renderProgressHtml(data())).toContain(
      "No retained before/after block yet, so no improvement is claimed.",
    );
  });

  it("parses a Godot upstream benchmark file and refuses a malformed one", async () => {
    const root = await campaignDir();
    await mkdir(path.join(root, "pilots"));
    await writeFile(path.join(root, "pilots", "good.json"), JSON.stringify(box1000));
    await writeFile(
      path.join(root, "pilots", "bad.json"),
      JSON.stringify({ benchmarks: [{ name: "Box 1000", results: { render_cpu: "fast" } }] }),
    );
    const attempts = await readAttempts(root, "pilots");
    const good = attempts.find((attempt) => attempt.source === "pilots/good.json");
    const bad = attempts.find((attempt) => attempt.source === "pilots/bad.json");
    expect(good?.godotBenchmarks?.[0]?.results.render_cpu).toBe(0.6345);
    expect(good?.pilot).toBeUndefined();
    expect(bad?.godotBenchmarks).toBeUndefined();
    expect(bad?.evidenceError).toContain("render_cpu");
    // Named as unavailable, not rendered as an empty benchmark and not dropped.
    const html = renderProgressHtml(data({ pilots: attempts, attemptsRoot: root }));
    expect(html).toContain("Evidence unavailable:");
    expect(html).toContain("Godot upstream benchmark file");
  });
});

// PRD-464's realistic-scene ladder. A rung that did not record its own counts and a non-blank
// read-back frame never became a report, so every number here is behind a scene that was proved to
// have rendered; what the monitor has to get right is which rung is in which run file, and what it
// says when a rung is not there yet.
describe("the realistic-scene ladder on the monitor page", () => {
  /** The ladder's own run files: R1-R4 at 720p, R5 in its own 1080p family. */
  function ladderRuns(
    engine: "godot" | "threenative",
    rows: IRowFixture[],
    family: "ladder" | "ladder1080" = "ladder",
  ): IAttempt[] {
    const label = engine === "godot" ? "godot" : "tn";
    const runCount = Math.max(...rows.map((row) => row.p50s.length));
    return Array.from({ length: runCount }, (_, run) =>
      scoreboardRun(
        `pilots/${family}-${label}-r${run + 1}-2026-09-27.json`,
        engine,
        rows.flatMap((row) => {
          const p50 = row.p50s[run];
          return p50 === undefined
            ? []
            : [
                {
                  drawCalls: row.drawCalls ?? 3,
                  mode: row.mode,
                  objectCount: row.objectCount ?? 4096,
                  p50,
                  p95: row.p95 ?? p50 * 1.5,
                },
              ];
        }),
      ),
    );
  }

  const sectionOf = (html: string): string =>
    html.slice(
      html.indexOf('<section class="panel" aria-label="Realistic scene ladder">'),
      html.indexOf('<section class="panel" aria-label="ThreeNative against Godot scoreboard">'),
    );

  const LADDER_TN = [
    { mode: "R1" as TRenderMode, p50s: [8, 8.1, 8.2] },
    { mode: "R2" as TRenderMode, p50s: [9, 9.1, 9.2] },
    { mode: "R3" as TRenderMode, p50s: [10, 10.1, 10.2] },
    { mode: "R4" as TRenderMode, p50s: [12, 12.1, 12.2] },
  ];
  const LADDER_GODOT = [
    { mode: "R1" as TRenderMode, p50s: [6, 6.1, 6.2] },
    { mode: "R2" as TRenderMode, p50s: [6.5, 6.6, 6.7] },
    { mode: "R3" as TRenderMode, p50s: [7, 7.1, 7.2] },
    { mode: "R4" as TRenderMode, p50s: [9, 9.1, 9.2] },
  ];

  it("opens on the 1080p headline in frames per second, with the ladder under it", () => {
    const html = renderProgressHtml(
      data({
        pilots: [
          // The tag comes from the cube scoreboard's own run files, so one of them is present.
          scoreboardRun(TN_R1, "threenative", [
            { drawCalls: 3, mode: "L3", objectCount: 4096, p50: 2, p95: 3 },
          ]),
          ...ladderRuns("threenative", LADDER_TN),
          ...ladderRuns("godot", LADDER_GODOT),
          ...ladderRuns("threenative", [{ mode: "R5", p50s: [16.7, 16.7, 16.7] }], "ladder1080"),
          ...ladderRuns("godot", [{ mode: "R5", p50s: [20, 20, 20] }], "ladder1080"),
        ],
      }),
    );
    const section = sectionOf(html);
    // 1000 / the median p50 of the retained runs, and the verdict is the scoreboard's own rule.
    expect(section).toContain("Full scene at 1080p: ThreeNative 59.9 fps vs Godot 50.0 fps");
    expect(section).toContain(">godotRatio</th>");
    expect(section).toContain("<td>1.20</td>");
    expect(section).toContain('<span class="pill win-tn">TN</span>');
    expect(section).toContain("ThreeNative — 1.2x faster on a typical frame");
    // Every rung, what it added, and both engines' medians with the spread beside them.
    for (const label of [
      "R1 Sun",
      "R2 Lights",
      "R3 Characters",
      "R4 Post",
      "R5 Full scene at 1920x1080",
    ])
      expect(section).toContain(label);
    expect(section).toContain("Fifty Khronos Fox glTFs, each playing Run at a staggered offset.");
    expect(section).toContain("8.10 ms (±0.20, 3 runs)");
    expect(section).toContain("6.10 ms (±0.20, 3 runs)");
    // A rung Godot took is called a Godot win, in the same runs as the table.
    expect(section).toContain('<span class="pill win-godot">Godot</span>');
    // The 1080p rung is read out of its own run files, and every run file is named.
    expect(section).toContain('href="pilots/ladder1080-tn-r1-2026-09-27.json"');
    expect(section).toContain('href="pilots/ladder-tn-r1-2026-09-27.json"');
    expect(section).toContain('href="pilots/ladder-godot-r3-2026-09-27.json"');
    // The headline and the ladder come before the cube scoreboard, not after it.
    expect(html.indexOf("Full scene at 1080p:")).toBeLessThan(
      html.indexOf("ThreeNative vs Godot — 1,024 + 4,096 cubes"),
    );
    expect(html.indexOf("Realistic scene ladder")).toBeLessThan(
      html.indexOf("ThreeNative vs Godot — 1,024 + 4,096 cubes"),
    );
  });

  it("reads a missing rung as pending, in the headline and in the table", () => {
    const html = renderProgressHtml(
      data({
        pilots: [
          scoreboardRun(TN_R1, "threenative", [
            { drawCalls: 3, mode: "L3", objectCount: 4096, p50: 2, p95: 3 },
          ]),
          // R1-R4 measured; the 1080p run was never taken.
          ...ladderRuns("threenative", LADDER_TN),
          ...ladderRuns("godot", LADDER_GODOT),
        ],
      }),
    );
    const section = sectionOf(html);
    // No fabricated fps from a rung that has no runs, and no verdict either.
    expect(section).toContain(
      "Full scene at 1080p: ThreeNative pending — no retained runs yet fps vs Godot pending — no retained runs yet fps",
    );
    expect(section).not.toContain("1080p: ThreeNative 0.0 fps");
    // The R5 row is pending on both sides, and names the run files that would fill it.
    expect(section).toContain("ladder1080-tn-r1-2026-09-27.json");
    expect(section).toContain("ladder1080-godot-r3-2026-09-27.json");
    // The rungs that did run are still read as numbers.
    expect(section).toContain("8.10 ms (±0.20, 3 runs)");
  });

  it("claims no fps and no rung at all when no ladder run is retained", () => {
    const section = sectionOf(renderProgressHtml(data()));
    expect(section).toContain("Full scene at 1080p: ThreeNative pending");
    expect(section).toContain("fps vs Godot pending");
    expect(section).not.toMatch(/\d+\.\d fps/u);
    // Every rung is still named, so a reader can see what is missing rather than an empty section.
    for (const label of [
      "R1 Sun",
      "R2 Lights",
      "R3 Characters",
      "R4 Post",
      "R5 Full scene at 1920x1080",
    ])
      expect(section).toContain(label);
  });
});
