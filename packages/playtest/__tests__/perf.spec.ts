import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";
import {
  assessPerfMarkers,
  formatPerfReport,
  newestProcessLines,
  parsePerformanceMarkers,
  parsePerfArgs,
  perfCommand,
  rankExactReasons,
  type IFrameBudgetWindowJson,
} from "../src/runner/perf.js";
import { PlaytestCliUsageError } from "../src/runner/config.js";

/**
 * Marker fixtures follow the live shapes: TN_FRAME_BUDGET is emitted by
 * packages/core/src/frame-budget.ts; TN_HOST_GAP by packages/runtime-native/src/runtime.cpp.
 * Both were only ever read by hand before this command existed — these lines mirror the ones in
 * docs/verification/runtime-perf-state.md.
 */

function budgetLine(windowId: number, fps: number, frameP95: number, renderP50: number): string {
  return `TN_FRAME_BUDGET:{"window":${windowId},"frames":300,"hitches":0,"fps":${fps},` +
    `"presented":{"samples":300,"mean":49.4,"p50":49.4,"p95":51.0,"p99":53.0,"max":66.0},` +
    `"frame":{"samples":300,"mean":30.0,"p50":28.0,"p95":${frameP95},"p99":44.0,"max":52.0},` +
    `"phases":{"hostGap":{"samples":300,"mean":22.0,"p50":22.0,"p95":29.1,"p99":33.0,"max":40.0},` +
    `"update":{"samples":300,"mean":2.5,"p50":2.4,"p95":3.0,"p99":4.0,"max":9.0},` +
    `"render":{"samples":300,"mean":${renderP50.toFixed(2)},"p50":${renderP50.toFixed(2)},"p95":33.5,"p99":38.0,"max":45.0},` +
    `"overlay":{"samples":300,"mean":0.01,"p50":0.01,"p95":0.02,"p99":0.03,"max":0.05},` +
    `"residual":{"samples":300,"mean":0.4,"p50":0.4,"p95":0.8,"p99":1.0,"max":2.0}},` +
    `"shares":{"render":0.55}}`;
}

const hostGapLine = "TN_HOST_GAP:{\"frames\":300,\"periodP50Ms\":48.75,\"periodMeanMs\":49.1," +
  "\"segments\":{\"present\":{\"p50Ms\":14.57,\"meanMs\":14.6},\"frameReplay\":{\"p50Ms\":7.95,\"meanMs\":8.0}," +
  "\"devicePoll\":{\"p50Ms\":0.28,\"meanMs\":0.3},\"timers\":{\"p50Ms\":0.001,\"meanMs\":0.002}}," +
  "\"sumP50Ms\":23.02}";

/** TN_FRAME_HITCH is emitted by packages/runtime-native/include/mystral/cold_start.h. */
const hitchLine =
  "TN_FRAME_HITCH:{\"window\":300,\"maxMs\":203.114,\"maxAtFrame\":41,\"p99Ms\":8.221," +
  "\"p50Ms\":7.940,\"pipelineCompileMs\":198.400,\"pipelineCompileCalls\":1}";

/** The pre-PRD-327 shape: no pipelineCompile fields. Must keep parsing. */
const legacyHitchLine =
  "TN_FRAME_HITCH:{\"window\":300,\"maxMs\":12.002,\"maxAtFrame\":3,\"p99Ms\":9.1,\"p50Ms\":7.8}";

afterEach(() => {
  vi.restoreAllMocks();
});

function sampleStream(): string {
  return [
    "08-27 20:15:56.123  4321  5678 I MystralStdio: LaunchState: COLD",
    "08-27 20:15:56.124  4321  5678 I MystralStdio: Present mode: mailbox (vsync=false)",
    budgetLine(1, 12.5, 55.0, 25.0),
    hostGapLine,
    "some other console noise",
    budgetLine(2, 20.55, 45.7, 16.61),
    hostGapLine,
    budgetLine(3, 20.9, 45.7, 16.8),
  ].join("\n");
}

describe("parsePerformanceMarkers", () => {
  it("reads budget, host-gap and present-mode lines out of a mixed logcat stream", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    expect(parsed.budgets).toHaveLength(3);
    expect(parsed.budgets[1]?.fps).toBeCloseTo(20.55);
    expect(parsed.budgets[1]?.frame?.p95).toBeCloseTo(45.7);
    expect(parsed.budgets[1]?.phases?.render?.p50).toBeCloseTo(16.61);
    expect(parsed.hostGaps).toHaveLength(2);
    expect(parsed.hostGaps[0]?.segments.present?.p50Ms).toBeCloseTo(14.57);
    expect(parsed.hostGaps[0]?.periodP50Ms).toBeCloseTo(48.75);
    expect(parsed.presentMode).toBe("mailbox (vsync=false)");
  });

  it("counts a frame-budget window once when Android mirrors it to both runtime log tags", () => {
    const mirrored = [
      budgetLine(1, 59.99, 17.3, 7.0),
      budgetLine(2, 66.93, 13.1, 6.7),
      budgetLine(3, 68.35, 12.7, 6.7),
    ].flatMap((line) => [
      `I MystralStdio: [log] ${line}`,
      `I MystralJS: [log] ${line}`,
    ]).join("\n");

    const parsed = parsePerformanceMarkers(mirrored);
    const report = assessPerfMarkers(parsed, { minFps: 60, requireWindows: 2 }, "logcat: pixel");

    expect(parsed.budgets.map(({ window }) => window)).toEqual([1, 2, 3]);
    expect(report.discardedWindows).toEqual([1]);
    expect(report.pass).toBe(true);
  });

  it("throws, naming the marker, when a marker line carries unparsable JSON", () => {
    // The package rule: a meter line that cannot be read must fail, never silently vanish —
    // an absent window and an unreadable window are different defects and both are failures.
    expect(() => parsePerformanceMarkers(`ok\nTN_FRAME_BUDGET:{"window":1,`)).toThrow(/TN_PERF_MARKER_MALFORMED/);
    expect(() => parsePerformanceMarkers("ok\nTN_HOST_GAP:{not json")).toThrow(/TN_PERF_MARKER_MALFORMED/);
  });

  it("finds nothing in a stream without markers, and that nothing is a failure downstream", () => {
    const parsed = parsePerformanceMarkers("no markers here\njust a log\n");
    expect(parsed.budgets).toHaveLength(0);
    expect(assessPerfMarkers(parsed, { requireWindows: 2 }, "test").pass).toBe(false);
  });

  it("reads a hitch window with its late-sync-compile fields, and a pre-PRD-327 line without them", () => {
    const parsed = parsePerformanceMarkers(`noise\n${hitchLine}\n${legacyHitchLine}\n`);
    expect(parsed.hitches).toHaveLength(2);
    expect(parsed.hitches[0]?.maxMs).toBeCloseTo(203.114);
    expect(parsed.hitches[0]?.pipelineCompileMs).toBeCloseTo(198.4);
    expect(parsed.hitches[0]?.pipelineCompileCalls).toBe(1);
    // Old hosts omit the fields; absence parses as absence, never as a measured zero.
    expect(parsed.hitches[1]?.pipelineCompileMs).toBeUndefined();
    expect(parsed.hitches[1]?.pipelineCompileCalls).toBeUndefined();
  });

  it("counts a mirrored hitch line once", () => {
    const parsed = parsePerformanceMarkers(
      `I MystralStdio: [log] ${hitchLine}\nI MystralJS: [log] ${hitchLine}\n`,
    );
    expect(parsed.hitches).toHaveLength(1);
  });
});

describe("assessPerfMarkers", () => {
  it("discards window 1 as startup and bounds the steady windows", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { requireWindows: 2 }, "test");
    expect(report.discardedWindows).toEqual([1]);
    expect(report.pass).toBe(true);
    expect(report.violations).toHaveLength(0);
  });

  it("fails on the steady window that violates a bound, not on the median", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { maxFrameMsP95: 45.0, minFps: 25, requireWindows: 2 }, "test");
    const codes = report.violations.map(({ code }) => code);
    expect(codes).toContain("TN_PERF_MAX_FRAME_P95");
    expect(codes).toContain("TN_PERF_MIN_FPS");
    expect(report.pass).toBe(false);
    // Window 1 (12.5 fps, 55.0 ms p95) is discarded; the violation comes from steady windows only.
    expect(report.violations.every(({ window }) => window !== 1)).toBe(true);
  });

  it("refuses to assess when fewer steady windows arrived than required", () => {
    // A single window is reported but never counted as steady evidence: with one window there
    // is nothing to compare it against, so the startup rule cannot even discard it.
    const parsed = parsePerformanceMarkers(budgetLine(1, 20.0, 40.0, 16.0));
    const report = assessPerfMarkers(parsed, { requireWindows: 2 }, "test");
    expect(report.discardedWindows).toEqual([]);
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_WINDOWS_MISSING", observed: 1, bound: 2 }),
    ]);
    expect(report.pass).toBe(false);
  });

  it("fails closed when a frame-p95 bound is requested but the window carries no frame summary", () => {
    // A meter line without the frame summary cannot prove a frame bound; that is a named
    // failure, never a silent pass-through of an unmeasured window.
    const both = parsePerformanceMarkers(
      'TN_FRAME_BUDGET:{"window":1,"frames":300,"hitches":0,"fps":20.0}\n' +
      'TN_FRAME_BUDGET:{"window":2,"frames":300,"hitches":0,"fps":20.0}\n' +
      'TN_FRAME_BUDGET:{"window":3,"frames":300,"hitches":0,"fps":20.0}',
    );
    const report = assessPerfMarkers(both, { maxFrameMsP95: 33, requireWindows: 2 }, "test");
    expect(report.violations.every(({ code }) => code === "TN_PERF_BOUNDS_NOT_ASSESSABLE")).toBe(true);
    expect(report.pass).toBe(false);
  });
});

describe("a frame rate the run cannot vouch for", () => {
  const virtual = { strategy: "private-xvfb", virtual: true } as const;
  const host = { strategy: "host", virtual: false } as const;

  it("refuses an fps bound on a private Xvfb instead of satisfying it with a wrong number", () => {
    // Measured on midway's desktop build under the capture-lock Xvfb: window 2 reported 1123.60 fps
    // and window 3 20000.00, and `--min-fps 55` PASSED. Same package's `trace` refuses to print a
    // frame rate from a private display at all (13.3 fps there against 57.7 on the real one).
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { minFps: 55, requireWindows: 2 }, "test", virtual);
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_VIRTUAL_DISPLAY", observed: undefined, bound: 55 }),
    ]);
    expect(report.pass).toBe(false);
    expect(report.display).toEqual({
      fpsSuppressed: true,
      reason: "a private-xvfb display",
      strategy: "private-xvfb",
      virtual: true,
    });
  });

  it("assesses the same bound when the operator acknowledges the display", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(
      parsed,
      { allowVirtualDisplay: true, minFps: 55, requireWindows: 2 },
      "test",
      virtual,
    );
    // The windows in this fixture are 20.55 and 20.9 fps, so the bound genuinely fails — the point
    // is that it is assessed rather than refused, and the number is presented.
    expect(report.violations.map(({ code }) => code)).toEqual(["TN_PERF_MIN_FPS", "TN_PERF_MIN_FPS"]);
    expect(report.display).toEqual({
      fpsSuppressed: false,
      reason: "a private-xvfb display",
      strategy: "private-xvfb",
      virtual: true,
    });
  });

  it("leaves a run on a vouched-for display exactly as it was", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { minFps: 20, requireWindows: 2 }, "test", host);
    expect(report.violations).toEqual([]);
    expect(report.display).toEqual({ fpsSuppressed: false, strategy: "host", virtual: false });
    // A source that carries no display knowledge — a log file from elsewhere — is untouched.
    expect(assessPerfMarkers(parsed, { minFps: 20, requireWindows: 2 }, "test").display).toBeUndefined();
  });

  it("still assesses a frame-duration bound, which the run did measure", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { maxFrameMsP95: 45.0, requireWindows: 2 }, "test", virtual);
    // Both steady windows carry a 45.7 ms frame p95, and a bound is checked against every steady
    // window rather than the median — so two violations, and the frame rate never enters it.
    expect(report.violations.map(({ code }) => code)).toEqual([
      "TN_PERF_MAX_FRAME_P95",
      "TN_PERF_MAX_FRAME_P95",
    ]);
    expect(report.pass).toBe(false);
  });

  it("prints no frame-rate column, and says why rather than leaving it blank", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const text = formatPerfReport(
      assessPerfMarkers(parsed, { minFps: 55, requireWindows: 2 }, "test", virtual),
    );
    expect(text).toContain("fps suppressed");
    expect(text).toContain("private-xvfb");
    expect(text).toContain("TN_PLAYTEST_HOST_DISPLAY=1");
    expect(text).toContain("--allow-virtual-display");
    // The column header carries no `fps`, and no window row prints one.
    expect(text).not.toMatch(/^window\s+fps/mu);
    expect(text.split("\n").some((line) => /^\d+\*?\s+20\.\d/u.test(line))).toBe(false);
    // The phase rows the native lane quotes are untouched.
    expect(text).toContain("host gap segments");
    expect(text).toContain("render p50/p95");
  });

  it("prints the frame rate again once the operator has acknowledged the display", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const text = formatPerfReport(
      assessPerfMarkers(parsed, { allowVirtualDisplay: true, requireWindows: 2 }, "test", virtual),
    );
    expect(text).not.toContain("fps suppressed");
    expect(text).toMatch(/^window\s+fps/mu);
  });

  it("parses the acknowledgement off the command line, defaulting to off", () => {
    expect(parsePerfArgs(["--file", "a.log"]).allowVirtualDisplay).toBe(false);
    expect(parsePerfArgs(["--file", "a.log", "--allow-virtual-display"]).allowVirtualDisplay).toBe(true);
  });
});

describe("parsePerfArgs", () => {
  it("requires exactly one source", () => {
    expect(() => parsePerfArgs(["--text"])).toThrow(PlaytestCliUsageError);
    expect(() => parsePerfArgs(["--file", "a.log", "--logcat", "X"])).toThrow(/mutually exclusive/u);
    expect(() => parsePerfArgs(["--frobnicate"])).toThrow(/unknown flag/u);
    expect(() => parsePerfArgs(["--min-fps", "fast"])).toThrow(/needs a number/u);
  });

  it("keeps defaults where the protocol rules live", () => {
    const args = parsePerfArgs(["--file", "a.log"]);
    // Two steady windows by default: window 1 is discarded, so a complete run closes three.
    expect(args.requireWindows).toBe(2);
    expect(args.timeoutSeconds).toBe(180);
    expect(args.hostArgs).toEqual([]);
  });

  it("refuses a value-taking flag that has no value instead of dropping it", () => {
    expect(() => parsePerfArgs(["--executable", "host", "--host-arg"])).toThrow(/--host-arg needs a value/u);
    expect(() => parsePerfArgs(["--file", "a.log", "--min-fps", ""])).toThrow(/--min-fps needs a number/u);
  });
});

describe("a logcat buffer that holds an earlier launch", () => {
  it("reads only the markers of the newest process", () => {
    const earlier = [budgetLine(1, 12, 55, 25), budgetLine(2, 12, 55, 25)].map((line) => `I/MystralStdio( 1111): ${line}`);
    const later = [budgetLine(1, 60, 20, 10), budgetLine(2, 60, 20, 10)].map((line) => `I/MystralStdio( 2222): ${line}`);
    const parsed = parsePerformanceMarkers(newestProcessLines([...earlier, ...later].join("\n")));
    expect(parsed.budgets.map(({ fps }) => fps)).toEqual([60, 60]);
  });
});

describe("perfCommand", () => {
  it("exits 2 preserving an explicit host-display failure before starting the executable", async () => {
    const errors: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    vi.stubGlobal("process", {
      ...process,
      env: { ...process.env, DISPLAY: undefined, TN_PLAYTEST_HOST_DISPLAY: "1" },
      platform: "linux",
    });
    try {
      const code = await perfCommand(["--executable", "/must-not-launch"]);
      expect(code).toBe(2);
      const report = JSON.parse(errors.join(""));
      expect(report.pass).toBe(false);
      expect(report.diagnostics[0].code).toBe("TN_PLAYTEST_HOST_DISPLAY_UNAVAILABLE");
    } finally {
      vi.unstubAllGlobals();
      errSpy.mockRestore();
    }
  });

  it("exits 0 on a passing file source and prints the report as JSON", async () => {
    const dir = await makeTempDir("tn-perf-");
    const path = join(dir, "host.log");
    await writeFile(path, sampleStream(), "utf8");
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const code = await perfCommand(["--file", path]);
    spy.mockRestore();
    expect(code).toBe(0);
    const report = JSON.parse(written.join("")) as { pass: boolean; presentMode?: string };
    expect(report.pass).toBe(true);
    expect(report.presentMode).toBe("mailbox (vsync=false)");
  });

  it("exits 1 when a bound fails and 2 when no markers arrived", async () => {
    const dir = await makeTempDir("tn-perf-");
    const failing = join(dir, "failing.log");
    await writeFile(failing, sampleStream(), "utf8");
    const boundSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const failedCode = await perfCommand(["--file", failing, "--min-fps", "30"]);
    boundSpy.mockRestore();
    expect(failedCode).toBe(1);

    const empty = join(dir, "empty.log");
    await writeFile(empty, "nothing here\n", "utf8");
    const emptySpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const emptyCode = await perfCommand(["--file", empty]);
    emptySpy.mockRestore();
    expect(emptyCode).toBe(2);
  });

  it("exits 2, naming the defect, when a marker line is malformed", async () => {
    const dir = await makeTempDir("tn-perf-");
    const path = join(dir, "broken.log");
    await writeFile(path, `TN_FRAME_BUDGET:{"window":1,`, "utf8");
    const errors: string[] = [];
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      errors.push(String(chunk));
      return true;
    });
    const code = await perfCommand(["--file", path]);
    errSpy.mockRestore();
    expect(code).toBe(2);
    expect(errors.join("")).toContain("TN_PERF_MARKER_MALFORMED");
  });

  it("fails a host that exits non-zero after enough windows, even though its markers pass", async () => {
    // Three windows cover the default two steady windows. The runner then stops the host, and the
    // host answers that SIGTERM by exiting 139. A plain signal kill would read as the runner's own stop.
    const output = [budgetLine(1, 60, 20, 10), budgetLine(2, 60, 20, 10), budgetLine(3, 60, 20, 10)].join("\n");
    const script = `process.on("SIGTERM", () => process.exit(139)); setInterval(() => {}, 1000); process.stdout.write(${JSON.stringify(`${output}\n`)});`;
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    const code = await perfCommand(["--executable", process.execPath, "--host-arg", "-e", "--host-arg", script]);
    spy.mockRestore();
    expect(code).toBe(1);
    const report = JSON.parse(written.join("")) as { pass: boolean; violations: Array<{ code: string; observed?: number }> };
    expect(report.pass).toBe(false);
    expect(report.violations).toContainEqual(expect.objectContaining({ code: "TN_PERF_HOST_EXIT", observed: 139 }));
  });
});

describe("budget fixture sanity", () => {
  it("keeps the fixture windows typeable as IFrameBudgetWindowJson", () => {
    const parsed = parsePerformanceMarkers(budgetLine(9, 60, 16.7, 5.0));
    const window: IFrameBudgetWindowJson = parsed.budgets[0] as IFrameBudgetWindowJson;
    expect(window.window).toBe(9);
    expect(window.frames).toBe(300);
  });
});

describe("formatPerfReport", () => {
  it("renders windows, the startup discard, host-gap segments and the verdict as text", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { requireWindows: 2 }, "executable: mystral run game.js");
    const text = formatPerfReport(report);
    expect(text).toContain("perf — 3 window(s)");
    expect(text).toContain("present mode: mailbox (vsync=false)");
    expect(text).toContain("1*");
    expect(text).toContain("window 1 always lies");
    expect(text).toContain("frameReplay");
    expect(text).toContain("PASS");
  });

  it("renders a failed bound with its observed value and bound", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const report = assessPerfMarkers(parsed, { minFps: 30, requireWindows: 2 }, "test");
    const text = formatPerfReport(report);
    expect(text).toMatch(/FAIL TN_PERF_MIN_FPS: window [23] observed 20\.\d+ against bound 30/u);
  });

  it("names the late sync compile a hitch window covered, and says nothing when there was none", () => {
    const parsed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${hitchLine}\n${budgetLine(2, 53, 20, 10)}\n${legacyHitchLine}\n`,
    );
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 1 }, "log"));
    expect(text).toContain("hitch windows (post-launch, 2): worst 203.114 ms");
    expect(text).toContain(
      "late sync compile: 198.400 ms across 1 call(s) in the window whose worst frame landed at frame 41",
    );
    expect(text).not.toContain("none reported");
  });

  it("names the absence rather than reading an old host's missing field as a zero", () => {
    const parsed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${legacyHitchLine}\n${budgetLine(2, 53, 20, 10)}\n`,
    );
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 1 }, "log"));
    expect(text).toContain(
      "late sync compile: unreported — this host predates the pipelineCompile fields (TN_FRAME_HITCH without them)",
    );
  });

  it("reports a measured zero as a zero when a new host names the field with no late compile", () => {
    const zeroHitchLine =
      "TN_FRAME_HITCH:{\"window\":300,\"maxMs\":9.9,\"maxAtFrame\":7,\"p99Ms\":9.1,\"p50Ms\":7.8," +
      "\"pipelineCompileMs\":0.000,\"pipelineCompileCalls\":0}";
    const parsed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${zeroHitchLine}\n${budgetLine(2, 53, 20, 10)}\n`,
    );
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 1 }, "log"));
    expect(text).toContain("late sync compile: none — every window reported pipelineCompileCalls 0");
  });

  it("prints the GPU-selected main-pass triangle count and names the CPU capacity figure", () => {
    // Three counts an indirect batch at its merged geometry's capacity, so the CPU figure is the
    // ceiling over what the kernel can select. Quoting only that one put 338 million triangles on
    // a scene that drew 402 thousand.
    const withPasses = (gpu: boolean): string =>
      `${budgetLine(1, 30, 40, 20)}\n` +
      `TN_FRAME_BUDGET:{"window":2,"frames":300,"hitches":0,"fps":30,${withPassesBody(gpu)}}\n`;
    const withPassesBody = (gpu: boolean): string =>
      `"passes":{"main":{"frames":300,"draws":{"mean":30,"p50":30,"p95":30},` +
      `"triangles":{"mean":338000000,"p50":338000000,"p95":338000000}` +
      (gpu ? `,"gpuTriangles":402000}}` : "}}");

    const gpuText = formatPerfReport(
      assessPerfMarkers(parsePerformanceMarkers(withPasses(true)), { requireWindows: 1 }, "log"),
    );
    expect(gpuText).toContain("main pass triangles: 402,000 GPU-selected, 338,000,000 CPU capacity");

    const cpuText = formatPerfReport(
      assessPerfMarkers(parsePerformanceMarkers(withPasses(false)), { requireWindows: 1 }, "log"),
    );
    expect(cpuText).toContain("the GPU-selected count was not reported");
  });

  it("prints no triangle line for a window that submitted no pass", () => {
    const text = formatPerfReport(assessPerfMarkers(parsePerformanceMarkers(sampleStream()), { requireWindows: 1 }, "log"));
    expect(text).not.toContain("main pass triangles");
  });

  it("prints no hitch section for a stream without hitch lines", () => {
    const parsed = parsePerformanceMarkers(sampleStream());
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 2 }, "test"));
    expect(text).not.toContain("hitch windows");
  });
});

/** `TN_FRAME_BUDGET` as PRD-494 reports it: the main pass split by origin, beside its own draws. */
const drawSourceLine =
  'TN_FRAME_BUDGET:{"window":3,"frames":300,"hitches":0,"fps":20.9,' +
  '"passes":{"main":{"draws":{"samples":300,"mean":323.0,"p50":323,"p95":337,"p99":340,"max":344},' +
  '"drawsBySource":{"gpuScene":{"samples":300,"mean":211.0,"p50":211,"p95":219,"p99":222,"max":228},' +
  '"chunks":{"samples":300,"mean":30.0,"p50":30,"p95":32,"p99":33,"max":34},' +
  '"terrain":{"samples":300,"mean":62.0,"p50":62,"p95":64,"p99":65,"max":66},' +
  '"other":{"samples":300,"mean":20.0,"p50":20,"p95":22,"p99":23,"max":24}},"frames":300},' +
  '"shadow":{"draws":{"samples":300,"mean":316.0,"p50":316,"p95":330,"p99":335,"max":340},' +
  '"frames":300}},"gpuStale":0}';

describe("main-pass draws by source in the perf report", () => {
  it("reports triangle capacity, selected work and draw origins from the same pass", () => {
    const jointLine = drawSourceLine.replace(
      '"main":{',
      '"main":{"triangles":{"mean":338000000,"p50":338000000,"p95":338000000},"gpuTriangles":402000,',
    );
    const parsed = parsePerformanceMarkers(`${budgetLine(1, 30, 40, 20)}\n${jointLine}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));
    expect(text).toContain("main pass triangles: 402,000 GPU-selected, 338,000,000 CPU capacity");
    expect(text).toContain("gpuScene 211, terrain 62, chunks 30, other 20 — 323 draws in the pass");
  });

  it("should print one line, ranked, against the pass's own draws", () => {
    const parsed = parsePerformanceMarkers(`${budgetLine(1, 30, 40, 20)}\n${drawSourceLine}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));
    const line = text.split("\n").find((row) => row.includes("main-pass draws by source")) ?? "";

    expect(line).toBe(
      "main-pass draws by source, window 3 p50: gpuScene 211, terrain 62, chunks 30, other 20 — 323 draws in the pass",
    );
  });

  it("should say the split was not reported rather than print an empty ranking", () => {
    const parsed = parsePerformanceMarkers(`${budgetLine(1, 30, 40, 20)}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));

    expect(text).toContain("main-pass draws by source: not reported");
  });
});

const projectionLine =
  'TN_PROJECTION:{"drawsActual":315,"drawsPlanned":118,' +
  '"exact":{"skinned":96,"multiMaterial":12,"lod":4,"instanced":6},' +
  '"exactObjects":118,"projecting":true,"reasonCode":"projected","sourceRenderables":780,"window":2}';

const declinedProjectionLine =
  'TN_PROJECTION:{"drawsActual":40,"drawsPlanned":40,"exact":{},"exactObjects":0,' +
  '"projecting":false,"reason":"fewer than 200 batchable meshes; the mirror would cost more ' +
  'than it saves","reasonCode":"belowMeshFloor","sourceRenderables":40,"window":2}';

const timedProjectionLine =
  'TN_PROJECTION:{"drawsActual":315,"drawsPlanned":118,' +
  '"exact":{"skinned":96},"exactObjects":96,"projecting":true,"reasonCode":"projected",' +
  '"sourceRenderables":780,"timings":{"compileMs":0,"reconcileMs":12.5,' +
  '"lastReconcileMs":0.42,"maxReconcileMs":1.1},"window":2}';

describe("projection markers in the perf report", () => {
  it("should rank reasons by draw count", () => {
    expect(rankExactReasons({ instanced: 6, lod: 4, multiMaterial: 12, skinned: 96 })).toEqual([
      { count: 96, reason: "skinned" },
      { count: 12, reason: "multiMaterial" },
      { count: 6, reason: "instanced" },
      { count: 4, reason: "lod" },
    ]);
  });

  it("should print the exact lane ranked, largest reason first", () => {
    const parsed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${budgetLine(2, 53, 20, 10)}\n${projectionLine}\n`,
    );
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 1 }, "log"));

    expect(text).toContain("780 authored renderables, 118 draws planned");
    expect(text).toContain("all passes; the plan counts the colour pass only");
    const skinned = text.indexOf("skinned");
    const lod = text.indexOf("lod ");
    expect(skinned).toBeGreaterThan(0);
    expect(skinned).toBeLessThan(lod);
  });

  it("should print the decline and its reason rather than an empty table", () => {
    const parsed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${declinedProjectionLine}\n`,
    );
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));

    expect(text).toContain("scene projection: DECLINED (belowMeshFloor)");
    expect(text).toContain("fewer than 200 batchable meshes");
  });

  it("should say the projection was not reported rather than imply an empty lane", () => {
    const parsed = parsePerformanceMarkers(`${budgetLine(1, 30, 40, 20)}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));

    expect(text).toContain("scene projection: not reported");
    expect(text).not.toContain("exact lane");
  });

  it("should count a mirrored Android projection line once", () => {
    const parsed = parsePerformanceMarkers(`${projectionLine}\n${projectionLine}\n`);
    expect(parsed.projections).toHaveLength(1);
  });

  it("should throw on a malformed projection line rather than skip it", () => {
    expect(() => parsePerformanceMarkers('ok\nTN_PROJECTION:{"window":1,')).toThrow(
      /TN_PERF_MARKER_MALFORMED/u,
    );
  });

  it("should carry the projection's reconcile timing through the parser", () => {
    const parsed = parsePerformanceMarkers(`${timedProjectionLine}\n`);
    expect(parsed.projections[0]?.timings?.reconcileMs).toBeCloseTo(12.5);
    expect(parsed.projections[0]?.timings?.lastReconcileMs).toBeCloseTo(0.42);
  });

  it("should print the per-frame reconcile term and name its absence", () => {
    const timed = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${budgetLine(2, 53, 20, 10)}\n${timedProjectionLine}\n`,
    );
    expect(formatPerfReport(assessPerfMarkers(timed, { requireWindows: 1 }, "log"))).toContain(
      "reconcile: 0.420 ms last frame, 12.500 ms cumulative",
    );

    // A line from a runtime older than the timing field must say so, never imply zero reconcile.
    const legacy = parsePerformanceMarkers(
      `${budgetLine(1, 30, 40, 20)}\n${budgetLine(2, 53, 20, 10)}\n${projectionLine}\n`,
    );
    expect(formatPerfReport(assessPerfMarkers(legacy, { requireWindows: 1 }, "log"))).toContain(
      "reconcile: unreported",
    );
  });

  it("should reject a projection line whose timing is not a finite number", () => {
    const malformed = projectionLine.replace(
      '"window":2',
      '"timings":{"compileMs":0,"reconcileMs":"fast","lastReconcileMs":0.4,"maxReconcileMs":1},"window":2',
    );
    expect(() => parsePerformanceMarkers(malformed)).toThrow(/TN_PERF_MARKER_MALFORMED/u);
  });
});

describe("the GPU column never reads as a measured zero", () => {
  it("should name the reason when no window carries gpuMs", () => {
    const parsed = parsePerformanceMarkers(`${budgetLine(1, 30, 40, 20)}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));

    expect(text).toContain("gpu: not reported");
    expect(text).toContain("timestamp-query");
    expect(text).toContain("TN_WEBGPU_FEATURES");
    // No column at all rather than a column of dashes a reader would total.
    expect(text).not.toContain("gpu ms");
  });

  it("should say unmeasured for a single window the device refused", () => {
    const withGpu = budgetLine(1, 30, 40, 20).replace('"window":1', '"window":1,"gpuMs":4.5');
    const parsed = parsePerformanceMarkers(`${withGpu}\n${budgetLine(2, 30, 40, 20)}\n`);
    const text = formatPerfReport(assessPerfMarkers(parsed, { requireWindows: 0 }, "log"));

    expect(text).toContain("gpu ms");
    expect(text).toContain("4.50");
    expect(text).toContain("unmeasured");
    expect(text).not.toContain("gpu: not reported");
  });
});

describe("the two TN_FRAME_HITCH payloads", () => {
  // The native host emits a 300-frame window; core's frame budget emits one line per present gap
  // over `hitchMs` ({gapMs, uptimeMs, wallClock}) on every platform. Both carry the same marker.
  const windowLine =
    'TN_FRAME_HITCH:{"window":300,"maxMs":203.114,"maxAtFrame":41,"p99Ms":8.221,"p50Ms":7.940}';
  const gapLines = [
    'TN_FRAME_HITCH:{"gapMs":3000.14,"uptimeMs":10177.57,"wallClock":1789852713865}',
    'TN_FRAME_HITCH:{"gapMs":2102.54,"uptimeMs":13362.72,"wallClock":1789852717050}',
  ];

  it("sorts a gap line into its own series rather than into the window series", () => {
    const parsed = parsePerformanceMarkers([windowLine, ...gapLines].join("\n"));
    expect(parsed.hitches).toHaveLength(1);
    expect(parsed.presentGaps).toHaveLength(2);
    expect(parsed.presentGaps[0]).toMatchObject({ gapMs: 3000.14, uptimeMs: 10177.57 });
  });

  it("reports a gap-only run as gaps, with no NaN and no misattributed reason", () => {
    // Measured on midway's native launch log: three gap lines of 2.1-3.0 s beside the host's
    // windows made this reader print `worst NaN ms` and blame an older host for fields that were
    // never in the line.
    const report = assessPerfMarkers(parsePerformanceMarkers(gapLines.join("\n")), { requireWindows: 0 }, "test");
    const text = formatPerfReport(report);
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("hitch windows");
    expect(text).not.toContain("predates the pipelineCompile fields");
    expect(text).toContain("present gaps (2): worst 3000.140 ms at uptime 10178 ms");
  });

  it("keeps the window figures and the compile note when both series are present", () => {
    const report = assessPerfMarkers(
      parsePerformanceMarkers([windowLine, ...gapLines].join("\n")),
      { requireWindows: 0 },
      "test",
    );
    const text = formatPerfReport(report);
    expect(text).toContain("present gaps (2): worst 3000.140 ms");
    expect(text).toContain("hitch windows (post-launch, 1): worst 203.114 ms");
    // The window genuinely carries no compile fields, so this note is still the honest one.
    expect(text).toContain("predates the pipelineCompile fields");
  });

  it("names a line that is neither shape instead of rendering a number it never received", () => {
    const bare = 'TN_FRAME_HITCH:{"window":300,"maxAtFrame":41}';
    expect(() => parsePerformanceMarkers(bare)).toThrow(/TN_PERF_MARKER_MALFORMED:.*maxMs/u);
  });
});

describe("attributing a present gap to the host's own slow phases", () => {
  // The real pair from midway's native launch log: the host attributed the stall to the image
  // decode and its outer watcher bracketed the same stretch.
  const neverMind = {
    budgets: [],
    discardedWindows: [],
    hitches: [],
    hostGaps: [],
    pass: true,
    presentGaps: [{ gapMs: 3000.14, uptimeMs: 10177.57 }],
    presents: [],
    presentMode: undefined,
    projections: [],
    slowPhases: [
      { atMs: 9945.939384, ms: 2965.129, phase: "imageDecodeDrain" },
      { atMs: 10419.748819, ms: 473.653, phase: "animationFrames" },
      { atMs: 10438.395025, ms: 3457.714, phase: "pollEvents" },
    ],
    source: "test",
    violations: [],
  };

  it("names the innermost phases, never the watcher that contains them", () => {
    const text = formatPerfReport(neverMind);
    expect(text).toContain("imageDecodeDrain 2965.129 ms");
    expect(text).toContain("animationFrames 473.653 ms");
    // `pollEvents` brackets the whole iteration: it contains both, so naming it says nothing.
    expect(text).not.toContain("pollEvents");
  });

  it("says when a gap had no phase inside it, and when the log carries none at all", () => {
    const none = { ...neverMind, slowPhases: [] };
    expect(formatPerfReport({ ...none, presentGaps: [{ gapMs: 900, uptimeMs: 5000 }] })).toContain(
      "no slow phase reported in this log",
    );
    const outsideOnly = { ...neverMind, presentGaps: [{ gapMs: 120, uptimeMs: 4000 }] };
    expect(formatPerfReport(outsideOnly)).toContain("no slow phase fell inside it");
  });

  it("keeps its cap and its ordering when many phases overlap", () => {
    // Nesting as the host really reports it: one watcher per iteration, containing the phases the
    // iteration ran — plus a fourth phase whose span ends before the gap begins.
    const many = {
      ...neverMind,
      slowPhases: [
        { atMs: 9945.94, ms: 2965.13, phase: "outermostInner" },
        { atMs: 10419.75, ms: 473.65, phase: "secondInner" },
        { atMs: 10100, ms: 300, phase: "thirdInner" },
        { atMs: 10438.4, ms: 3457.71, phase: "iterationWatcher" },
        { atMs: 4000, ms: 500, phase: "beforeTheGap" },
      ],
    };
    const line = formatPerfReport(many).split("\n").find((entry) => entry.includes("gap 3000.140"));
    expect(line).toBeDefined();
    expect(line).not.toContain("iterationWatcher");
    expect(line).not.toContain("beforeTheGap");
    expect(line?.match(/Inner/g)).toHaveLength(3);
    expect(line?.indexOf("outermostInner")).toBeLessThan(line?.indexOf("secondInner") ?? 0);
    expect(line?.indexOf("secondInner")).toBeLessThan(line?.indexOf("thirdInner") ?? 0);
  });
});

describe("a loop cadence the display never saw", () => {
  // The host counts loop frames and presents separately; the presentation cap lets a loop iterate
  // many times per present. These are midway's native launch numbers: 1740 frames, 133 presents,
  // cap 60 Hz — beside a window this reader printed as 2631 fps.
  const tick = 'TN_PRESENTS_TICK:{"frames":1740,"presents":133,"textureMB":886,"textures":221,"bufferMB":45,"capHz":60}';
  const window = 'TN_FRAME_BUDGET:{"window":3,"frames":300,"hitches":0,"fps":2631.58,' +
    '"presented":{"samples":300,"mean":0.38,"p50":0.03,"p95":0.1,"p99":8.15,"max":47.77},' +
    '"frame":{"samples":300,"mean":0.3,"p50":0.2,"p95":0.4,"p99":0.6,"max":1.0},' +
    '"phases":{"render":{"samples":300,"mean":0.1,"p50":0.1,"p95":0.2,"p99":0.3,"max":0.4}}}';

  const report = (allowVirtualDisplay: boolean) =>
    assessPerfMarkers(
      parsePerformanceMarkers([tick, window].join("\n")),
      { allowVirtualDisplay, minFps: 55, requireWindows: 0 },
      "test",
    );

  it("refuses the frame rate and the fps bound the log cannot support", () => {
    const refused = report(false);
    expect(refused.display).toMatchObject({
      fpsSuppressed: true,
      reason: "the host presented 133 of 1740 loop frames (cap 60 Hz)",
      virtual: false,
    });
    expect(refused.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_VIRTUAL_DISPLAY", bound: 55 }),
    ]);
    expect(refused.pass).toBe(false);
    const text = formatPerfReport(refused);
    expect(text).toContain("the host presented 133 of 1740 loop frames (cap 60 Hz)");
    expect(text).not.toMatch(/^window\s+fps/mu);
    // The phase rows the native lane quotes survive, and the window itself is still listed.
    expect(text).toContain("render p50/p95");
  });

  it("prints the frame rate when the display saw every frame", () => {
    const honest = 'TN_PRESENTS_TICK:{"frames":1740,"presents":1738,"capHz":60}';
    const allowed = assessPerfMarkers(
      parsePerformanceMarkers([honest, window].join("\n")),
      { minFps: 55, requireWindows: 0 },
      "test",
    );
    expect(allowed.display).toBeUndefined();
    const text = formatPerfReport(allowed);
    expect(text).toMatch(/^window\s+fps/mu);
    // 2631 fps clears a 55 fps bound honestly here: this display really saw the frames.
    expect(text).not.toContain("TN_PERF_VIRTUAL_DISPLAY");
    expect(allowed.violations).toEqual([]);
  });

  it("lets the operator accept it explicitly, and still records what was accepted", () => {
    const accepted = report(true);
    expect(accepted.display).toMatchObject({
      fpsSuppressed: false,
      reason: "the host presented 133 of 1740 loop frames (cap 60 Hz)",
    });
    // 2631 loop fps clears a 55 fps bound; the acknowledgement is what makes that printable, and
    // the report keeps the reason beside it.
    expect(accepted.violations).toEqual([]);
    expect(formatPerfReport(accepted)).toMatch(/^window\s+fps/mu);
  });
});

describe("a window that carries the display's own rate", () => {
  const tick = 'TN_PRESENTS_TICK:{"frames":1740,"presents":133,"capHz":60}';
  // What the engine reports once the host can count presents: the loop's cadence, and the rate the
  // display actually ran at, side by side in one window.
  const window = 'TN_FRAME_BUDGET:{"window":3,"frames":300,"hitches":0,"presents":18,"presentedFps":60.4,' +
    '"fps":2631.58,"presented":{"samples":300,"mean":0.38,"p50":0.03,"p95":0.1,"p99":8.15,"max":47.77},' +
    '"frame":{"samples":300,"mean":0.3,"p50":0.2,"p95":0.4,"p99":0.6,"max":1.0},' +
    '"phases":{"render":{"samples":300,"mean":0.1,"p50":0.1,"p95":0.2,"p99":0.3,"max":0.4}}}';

  it("prints the display's rate without suppressing it, even though the loop outran it", () => {
    const report = assessPerfMarkers(
      parsePerformanceMarkers([tick, window].join("\n")),
      { minFps: 55, requireWindows: 0 },
      "test",
    );
    expect(report.display?.fpsSuppressed).not.toBe(true);
    expect(report.violations).toEqual([]);
    const text = formatPerfReport(report);
    expect(text).toMatch(/^window\s+fps/mu);
    expect(text).toContain("60.40");
    expect(text).not.toContain("2631.58");
  });

  it("assesses the fps bound against the display's rate, not the loop's", () => {
    // 60.4 clears a 55 bound. A 70 bound must fail on the display's rate even though the loop's
    // 2631 would clear it — that is the whole reason the two are separate numbers.
    const failing = assessPerfMarkers(
      parsePerformanceMarkers([tick, window].join("\n")),
      { minFps: 70, requireWindows: 0 },
      "test",
    );
    expect(failing.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_MIN_FPS", observed: 60.4 }),
    ]);
  });
});

describe("windows too short to carry a display rate", () => {
  const tick = 'TN_PRESENTS_TICK:{"frames":1740,"presents":133,"capHz":60}';
  const zero = 'TN_FRAME_BUDGET:{"window":2,"frames":300,"hitches":0,"presents":0,"fps":20000,' +
    '"presented":{"samples":300,"mean":0.05,"p50":0.03,"p95":0.1,"p99":1,"max":2},' +
    '"frame":{"samples":300,"mean":0.04,"p50":0.02,"p95":0.08,"p99":1,"max":2},' +
    '"phases":{"render":{"samples":300,"mean":0.01,"p50":0.01,"p95":0.02,"p99":0.1,"max":0.2}}}';
  const rated = 'TN_FRAME_BUDGET:{"window":3,"frames":300,"hitches":0,"presents":18,"presentedFps":60.4,' +
    '"fps":2631.58,"presented":{"samples":300,"mean":0.38,"p50":0.03,"p95":0.1,"p99":8.15,"max":47.77},' +
    '"frame":{"samples":300,"mean":0.3,"p50":0.2,"p95":0.4,"p99":0.6,"max":1.0},' +
    '"phases":{"render":{"samples":300,"mean":0.1,"p50":0.1,"p95":0.2,"p99":0.3,"max":0.4}}}';

  it("prints a zero-present window as zero, never the loop's cadence", () => {
    const report = assessPerfMarkers(
      parsePerformanceMarkers([tick, zero, rated].join("\n")),
      { requireWindows: 0 },
      "test",
    );
    const text = formatPerfReport(report);
    const rows = text.split("\n").filter((line) => /^\d+\*?\s/.test(line));
    expect(rows.some((row) => row.includes("0.00"))).toBe(true);
    expect(rows.some((row) => row.includes("20000.00"))).toBe(false);
    expect(report.display?.fpsSuppressed).not.toBe(true);
    // A bare zero is true and reads as a frozen game, so the windows that had nothing to measure
    // are named.
    expect(text).toContain("windows 2 presented nothing in their loop frames");
  });

  it("refuses an fps bound when no window produced a rate, instead of passing it", () => {
    const report = assessPerfMarkers(
      parsePerformanceMarkers([tick, zero].join("\n")),
      { minFps: 55, requireWindows: 0 },
      "test",
    );
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_BOUNDS_NOT_ASSESSABLE", bound: 55 }),
    ]);
    expect(report.pass).toBe(false);
  });

  it("assesses the bound on the windows that do carry a rate", () => {
    const report = assessPerfMarkers(
      parsePerformanceMarkers([tick, zero, rated].join("\n")),
      { minFps: 70, requireWindows: 0 },
      "test",
    );
    expect(report.violations).toEqual([
      expect.objectContaining({ code: "TN_PERF_MIN_FPS", observed: 60.4, window: 3 }),
    ]);
  });
});
