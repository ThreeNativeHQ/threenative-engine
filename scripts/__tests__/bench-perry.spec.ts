import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareArms,
  compareToIncumbent,
  ledgerLine,
  loadIncumbent,
  parseBenchArgs,
  parseLedger,
  parsePerfSelf,
  parsePlayerMetrics,
  readHostLoad,
  reportHtml,
  reportMarkdown,
  runBench,
} from "../bench-perry.js";

const idle = { load: () => ({ load1: 1, cores: 12 }), sleep: async () => {} };
const TAILWIND_CDN = "https://cdn.tailwindcss.com/3.4.17";
const sample = (scale = 1) => ({
  gameJsMs: 0.5 * scale,
  renderMs: 0.6 * scale,
  cpuFrameMs: 1.1 * scale,
  frameMs: 28.5,
  bridgeCalls: 42,
});
const markers = (scale = 1) =>
  [
    `TN_PLAYER_TIMING:${JSON.stringify({ firstFrameMs: 753 * scale, readyMs: 3000 * scale })}`,
    ...[sample(scale), sample(scale), sample(scale)].map(
      (frame) => `TN_PLAYER_FRAME:${JSON.stringify(frame)}`,
    ),
  ].join("\n");
const measurement = (scale = 1) => parsePlayerMetrics(markers(scale));
const fixturePath = path.join(import.meta.dirname, "fixtures/perry-bench/journey-r13.json");

describe("Perry native benchmark", () => {
  it.each([
    {
      name: "cgroup PSI before system PSI",
      cgroup: "some avg10=0.00 avg60=1.00 avg300=2.00 total=10",
      system: "some avg10=90.00 avg60=90.00 avg300=90.00 total=20",
      pressure: 0,
      source: "/sys/fs/cgroup/bench.scope/cpu.pressure",
    },
    {
      name: "system PSI when cgroup PSI is missing",
      cgroup: undefined,
      system: "some avg10=3.25 avg60=2.00 avg300=1.00 total=10",
      pressure: 3.25,
      source: "/proc/pressure/cpu",
    },
    {
      name: "system PSI when cgroup PSI is malformed",
      cgroup: "some avg10=NaN avg60=0.00\nfull avg10=0.00",
      system: "full avg10=0.00\nsome avg10=7.50 avg60=1.00",
      pressure: 7.5,
      source: "/proc/pressure/cpu",
    },
    {
      name: "load when neither PSI file exists",
      cgroup: undefined,
      system: undefined,
      pressure: null,
      source: undefined,
    },
    {
      name: "load when PSI has no valid some avg10",
      cgroup: "some\nfull avg10=0.00",
      system: "some avg10=101.00 avg60=1.00",
      pressure: null,
      source: undefined,
    },
  ])("reads $name", async ({ cgroup, system, pressure, source }) => {
    const files: Record<string, string | undefined> = {
      "/proc/self/cgroup": "0::/bench.scope\n",
      "/sys/fs/cgroup/bench.scope/cpu.pressure": cgroup,
      "/proc/pressure/cpu": system,
    };
    const reads: string[] = [];
    const reading = await readHostLoad(async (file) => {
      reads.push(file);
      const text = files[file];
      if (text === undefined) throw new Error("unavailable");
      return text;
    });
    expect(reading.cpuPressure).toBe(pressure);
    expect(reading.cpuPressureSource).toBe(source);
    expect(reads).toEqual([
      "/proc/self/cgroup",
      "/sys/fs/cgroup/bench.scope/cpu.pressure",
      ...(source === "/sys/fs/cgroup/bench.scope/cpu.pressure" ? [] : ["/proc/pressure/cpu"]),
    ]);
  });
  it("fails closed on real r13 output: fixed-step ready is not wall time and CPU splits are missing", async () => {
    const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
    expect(fixture.startup.timeline.readyMs).toBeCloseTo(16.666667);
    expect(() =>
      parsePlayerMetrics(fixture.console.map((entry: { text: string }) => entry.text).join("\n")),
    ).toThrow("Missing");
  });
  it("parses the shared player emission contract without using presentation cadence", () => {
    expect(measurement()).toMatchObject({
      firstFrameMs: 753,
      readyMs: 3000,
      gameJsMs: 0.5,
      renderMs: 0.6,
      cpuFrameMs: 1.1,
      samples: 2,
      bridgeCalls: 42,
    });
    expect(parsePlayerMetrics(markers().replaceAll('"frameMs":28.5', '"frameMs":300'))).toEqual(
      measurement(),
    );
  });
  it("marks any slower Perry metric MISS, including report-only render", () => {
    expect(compareArms({ perry: [measurement(1.01)], v8: [measurement()] })).toMatchObject({
      verdict: "MISS",
      exitCode: 1,
    });
    const renderSlower = { ...measurement(0.3), renderMs: 0.7 };
    expect(
      compareArms({ perry: [renderSlower], v8: [measurement()] }).rows.find(
        (row) => row.metric === "renderMs",
      )?.verdict,
    ).toBe("MISS");
  });
  it("passes boundaries using run medians and reports min/max", () => {
    const run = { ...measurement(), gameJsMs: 0.25, cpuFrameMs: 1.1 * 0.68, readyMs: 990 };
    const comparison = compareArms({
      perry: [run, run, { ...run, readyMs: 900 }],
      v8: [measurement(), measurement(), measurement()],
    });
    expect(comparison).toMatchObject({ verdict: "PASS", exitCode: 0 });
    expect(comparison.rows.find((row) => row.metric === "readyMs")?.perry).toEqual({
      median: 990,
      min: 900,
      max: 990,
    });
  });
  it("rejects missing, malformed, zero and inconsistent observations", () => {
    expect(() => parsePlayerMetrics(markers().replaceAll('"gameJsMs":0.5,', ""))).toThrow(
      "gameJsMs",
    );
    expect(() => parsePlayerMetrics("TN_PLAYER_TIMING:{")).toThrow();
    expect(() => parsePlayerMetrics(markers().split("\n").slice(0, 2).join("\n"))).toThrow(
      "Zero steady",
    );
    expect(() =>
      compareArms({ perry: [{ ...measurement(), samples: 0 }], v8: [measurement()] }),
    ).toThrow("samples");
    expect(() => compareArms({ perry: [], v8: [] })).toThrow("Missing");
    expect(() =>
      parsePlayerMetrics(markers().replaceAll('"cpuFrameMs":1.1', '"cpuFrameMs":0.1')),
    ).toThrow("Inconsistent");
  });
  it("parses defaults and every requested argument, rejecting invalid flags", () => {
    expect(parseBenchArgs(["--perry", "/tmp/game"])).toMatchObject({
      runs: 3,
      perf: false,
      open: false,
      perry: "/tmp/game",
    });
    expect(parseBenchArgs(["--perry", "/tmp/game", "--open"]).open).toBe(true);
    expect(
      parseBenchArgs([
        "--",
        "--project",
        "/tmp/project",
        "--scenario",
        "play.json",
        "--perry",
        "/tmp/game",
        "--v8-bundle",
        "/tmp/v8",
        "--runs",
        "5",
        "--perf",
        "--open",
      ]),
    ).toEqual({
      project: "/tmp/project",
      scenario: "/tmp/project/play.json",
      perry: "/tmp/game",
      v8Bundle: "/tmp/v8",
      runs: 5,
      perf: true,
      open: true,
      maxLoad: 0.75,
      maxCpuPressure: 10,
    });
    expect(parseBenchArgs(["--perry", "x", "--max-load", "2"]).maxLoad).toBe(2);
    expect(parseBenchArgs(["--perry", "x", "--max-cpu-pressure", "25"]).maxCpuPressure).toBe(25);
    for (const argv of [
      [],
      ["--perry"],
      ["--unknown"],
      ["--perry", "x", "--runs", "0"],
      ["--perry", "x", "--runs", "1.5"],
      ["--perry", "x", "--perry", "y"],
      ["--perry", "x", "--max-load", "0"],
      ["--perry", "x", "--max-load", "abc"],
      ["--perry", "x", "--max-cpu-pressure", "-1"],
      ["--perry", "x", "--max-cpu-pressure", "101"],
      ["--perry", "x", "--max-cpu-pressure", "abc"],
    ])
      expect(() => parseBenchArgs(argv)).toThrow();
  });
  it("writes a fixed nine-column ledger with all ratios or a measurement failure", () => {
    const comparison = compareArms({ perry: [measurement(0.3)], v8: [measurement()] });
    expect(ledgerLine("time", "head", "123456789abcdef", comparison)).toBe(
      "time\thead\t123456789abc\t0.300000\t0.300000\t0.300000\t0.300000\t0.300000\tPASS\n",
    );
    expect(ledgerLine("time", "head", "hash")).toBe(
      "time\thead\thash\tNA\tNA\tNA\tNA\tNA\tMEASUREMENT_FAILURE\n",
    );
  });
  it("folds self-time leaf symbols and keeps the report below 40 lines", () => {
    const stacks = parsePerfSelf(
      "# Overhead Symbol\n  20.00% [.] game                 -          -  \n  5.00% [.] game\n  30.00% [k] present\n",
    );
    expect(stacks).toEqual([
      { symbol: "present", percent: 30 },
      { symbol: "game", percent: 25 },
    ]);
    expect(() => parsePerfSelf("# no samples")).toThrow("No perf");
    const report = reportMarkdown({
      time: "time",
      load: [1, 2, 3],
      comparison: compareArms({ perry: [measurement()], v8: [measurement()] }),
      stacks: { perry: stacks, v8: stacks },
    });
    expect(report.trim().split("\n").length).toBeLessThanOrEqual(40);
    expect(report).not.toMatch(/fps/i);
  });
  it("renders one self-contained dashboard with every metric, a MISS marker and no external URL", () => {
    const stacks = parsePerfSelf("  30.00% [.] present\n");
    const html = reportHtml({
      time: "2026-01-01T00:00:00.000Z",
      load: [1, 2, 3],
      head: "abcdef1234567890",
      perrySha256: "deadbeefcafe",
      comparison: compareArms({ perry: [measurement(1.01)], v8: [measurement()] }),
      stacks: { perry: stacks, v8: stacks },
      ledger: parseLedger(
        "t1\thead\t123456789abc\t0.5\t0.5\t0.5\t0.5\t0.5\tPASS\n" +
          "t2\thead\t123456789abc\tNA\tNA\tNA\tNA\tNA\tMEASUREMENT_FAILURE\n",
      ),
    });
    for (const metric of ["firstFrameMs", "gameJsMs", "renderMs", "cpuFrameMs", "readyMs"])
      expect(html).toContain(`<article data-metric="${metric}"`);
    expect(html).toContain('data-verdict="MISS"');
    expect(html).toContain("<svg");
    expect(html).toContain("present");
    // The pinned Tailwind Play CDN is the only external origin.
    expect(html).toContain(TAILWIND_CDN);
    expect(html.replace(TAILWIND_CDN, "")).not.toContain("http");
    // Previous ledger row was 0.5x everywhere, this run is 1.01x: regressed, +102%.
    expect(html).toContain('data-trend="regressed"');
    expect(html).toContain("+102%");
    expect(html).not.toMatch(/fps/i);
    // The previous row benched binary 123456789abc, this run deadbeefcafe: say so beside "vs last".
    expect(html).toContain('data-other-binary="123456789abc"');
    const same = reportHtml({
      time: "2026-01-01T00:00:00.000Z",
      load: [1, 2, 3],
      perrySha256: "123456789abcdef",
      comparison: compareArms({ perry: [measurement(1.01)], v8: [measurement()] }),
      ledger: parseLedger("t1\thead\t123456789abc\t0.5\t0.5\t0.5\t0.5\t0.5\tPASS\n"),
    });
    expect(same).not.toContain("data-other-binary");
  });
  it("gates a candidate against the incumbent: REGRESSED exits 3, within margin is SAME, missing throws", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "bench-perry-incumbent-"));
    await writeFile(path.join(temp, "game"), "binary");
    await writeFile(path.join(temp, "game.js"), "bundle");
    await mkdir(path.join(temp, "native"));
    await writeFile(path.join(temp, "native/assets.tnpk"), "assets");
    await writeFile(path.join(temp, "scenario.json"), JSON.stringify({ assert: {} }));
    let launches = 0;
    const execute = async (command: string, args: string[]) => {
      if (command === "git") return { code: 0, stdout: "head", stderr: "" };
      launches++;
      const artifacts = args[args.indexOf("--artifacts") + 1] ?? "";
      await mkdir(artifacts, { recursive: true });
      const text = markers(path.basename(artifacts).startsWith("perry") ? 0.3 : 1);
      await writeFile(
        path.join(artifacts, "console.json"),
        JSON.stringify(text.split("\n").map((line) => ({ text: line }))),
      );
      return { code: 0, stdout: "{}", stderr: "" };
    };
    // The candidate ratio is 0.3 on every metric.
    const incumbentDir = async (name: string, ratio: number, runs = 1) => {
      const dir = path.join(temp, name);
      await mkdir(dir);
      const arms = { perry: [] as unknown[], v8: [] as unknown[] };
      for (let i = 0; i < runs; i++) {
        // Per-run ratios ratio*(0.9, 1.1, 1.0...) widen the margin to 2x the largest deviation.
        arms.perry.push(measurement(0.3 * (i === 0 ? 1 : 1.5)));
        arms.v8.push(measurement());
      }
      const comparison = compareArms({ perry: [measurement(ratio)], v8: [measurement()] });
      await writeFile(path.join(dir, "result.json"), JSON.stringify({ comparison, arms }));
      return dir;
    };
    const argv = (incumbent?: string) => [
      "--project",
      temp,
      "--scenario",
      "scenario.json",
      "--perry",
      path.join(temp, "game"),
      "--v8-bundle",
      temp,
      "--runs",
      "1",
      ...(incumbent ? ["--incumbent", incumbent] : []),
    ];
    const out = path.join(temp, "artifacts");
    try {
      const better = await incumbentDir("better", 0.1);
      expect(await runBench(argv(better), execute, out, idle)).toBe(3);
      const index = await readFile(path.join(out, "index.html"), "utf8");
      expect(index).toContain("REGRESSION vs incumbent");
      expect(index).toContain("do not commit");
      expect(index).toContain('data-incumbent="REGRESSED"');
      const ledger = await readFile(path.join(out, "ledger.tsv"), "utf8");
      expect(ledger.trim().split("\n").at(-1)).toMatch(/\tREGRESSION$/);
      const dirs = (await readdir(out)).filter((name) => name.startsWith("20")).sort();
      const result = JSON.parse(
        await readFile(path.join(out, dirs.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(result.regression.verdict).toBe("REGRESSION");
      const first = result.regression.rows[0];
      expect(first).toMatchObject({ metric: "firstFrameMs", margin: 0.03, verdict: "REGRESSED" });
      expect(first.incumbent).toBeCloseTo(0.1, 6);

      // 0.305 -> 0.3 is inside the 3% margin: SAME, exit follows the V8 verdict (PASS = 0).
      const same = await incumbentDir("same", 0.305);
      expect(await runBench(argv(same), execute, out, idle)).toBe(0);
      const sameDirs = (await readdir(out)).filter((name) => name.startsWith("20")).sort();
      const sameResult = JSON.parse(
        await readFile(path.join(out, sameDirs.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(sameResult.regression.verdict).toBe("OK");
      expect(
        sameResult.regression.rows.every((row: { verdict: string }) => row.verdict === "SAME"),
      ).toBe(true);

      // A noisy incumbent (per-run ratios 0.3 and 0.45) widens the margin, capped at 10%, so a
      // cold-cache outlier run cannot hide a 20% regression (0.25 -> 0.3).
      const noisy = compareToIncumbent(
        compareArms({ perry: [measurement(0.3)], v8: [measurement()] }),
        await loadIncumbent(await incumbentDir("noisy", 0.25, 2)),
      );
      expect(noisy.rows[0]?.margin).toBeCloseTo(0.1, 5);
      expect(noisy.rows[0]?.verdict).toBe("REGRESSED");

      // Fail closed: a missing incumbent throws, and the bench measures nothing.
      await expect(loadIncumbent(path.join(temp, "missing"))).rejects.toThrow(
        "Cannot read incumbent",
      );
      const before = launches;
      expect(await runBench(argv(path.join(temp, "missing")), execute, out, idle)).toBe(2);
      expect(launches).toBe(before);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("refuses to measure on an overloaded host: waits, then exits 2 at the start or the end", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "bench-perry-load-"));
    await writeFile(path.join(temp, "game"), "binary");
    await writeFile(path.join(temp, "game.js"), "bundle");
    await mkdir(path.join(temp, "native"));
    await writeFile(path.join(temp, "native/assets.tnpk"), "assets");
    await writeFile(path.join(temp, "scenario.json"), JSON.stringify({ assert: {} }));
    let launches = 0;
    const execute = async (command: string, args: string[]) => {
      if (command === "git") return { code: 0, stdout: "head", stderr: "" };
      launches++;
      const artifacts = args[args.indexOf("--artifacts") + 1] ?? "";
      await mkdir(artifacts, { recursive: true });
      const text = markers(path.basename(artifacts).startsWith("perry") ? 0.3 : 1);
      await writeFile(
        path.join(artifacts, "console.json"),
        JSON.stringify(text.split("\n").map((line) => ({ text: line }))),
      );
      return { code: 0, stdout: "{}", stderr: "" };
    };
    const argv = (...extra: string[]) => [
      "--project",
      temp,
      "--scenario",
      "scenario.json",
      "--perry",
      path.join(temp, "game"),
      "--v8-bundle",
      temp,
      "--runs",
      "1",
      ...extra,
    ];
    const out = path.join(temp, "artifacts");
    // Readings come from a script; the last one repeats.
    const hostOf = (loads: number[], pressures?: number[]) => {
      const calls = { sleeps: 0, reads: 0 };
      return {
        calls,
        host: {
          load: () => {
            const index = calls.reads++;
            return {
              load1: loads[Math.min(index, loads.length - 1)] ?? 0,
              cores: 12,
              ...(pressures
                ? {
                    cpuPressure: pressures[Math.min(index, pressures.length - 1)],
                    cpuPressureSource: "/sys/fs/cgroup/bench.scope/cpu.pressure",
                  }
                : {}),
            };
          },
          sleep: async () => {
            calls.sleeps++;
          },
        },
      };
    };
    const latest = async () => {
      const dirs = (await readdir(out)).filter((name) => name.startsWith("20")).sort();
      return JSON.parse(await readFile(path.join(out, dirs.at(-1) ?? "", "result.json"), "utf8"));
    };
    try {
      // 9.01 > 0.75 x 12 cores is overloaded; 9 is not.
      const stuck = hostOf([20]);
      expect(await runBench(argv(), execute, out, stuck.host)).toBe(2);
      expect(launches).toBe(0);
      expect(stuck.calls.sleeps).toBe(20);
      expect((await latest()).error).toBe("host overloaded: load 20.00 on 12 cores");
      expect((await readFile(path.join(out, "ledger.tsv"), "utf8")).trim()).toMatch(
        /\tMEASUREMENT_FAILURE$/,
      );
      expect(await readFile(path.join(out, "index.html"), "utf8")).toContain("host overloaded");

      const settles = hostOf([20, 20, 5, 5]);
      expect(await runBench(argv(), execute, out, settles.host)).toBe(0);
      expect(settles.calls.sleeps).toBe(2);
      expect((await latest()).hostLoad).toMatchObject({
        maxLoadPerCore: 0.75,
        start: { load1: 5, cores: 12 },
        end: { load1: 5, cores: 12 },
      });

      const measured = await readFile(path.join(out, "index.html"), "utf8");
      const before = launches;
      expect(await runBench(argv(), execute, out, hostOf([5, 20]).host)).toBe(2);
      expect(launches).toBeGreaterThan(before);
      expect((await latest()).error).toBe("host overloaded: load 20.00 on 12 cores");
      // A failed run keeps its own report; the dashboard still shows the last measured run.
      expect(await readFile(path.join(out, "index.html"), "utf8")).toBe(measured);

      expect(await runBench(argv("--max-load", "2"), execute, out, hostOf([20]).host)).toBe(0);

      const pressureStuck = hostOf([1], [20]);
      const beforePressure = launches;
      expect(await runBench(argv(), execute, out, pressureStuck.host)).toBe(2);
      expect(launches).toBe(beforePressure);
      expect(pressureStuck.calls.sleeps).toBe(20);
      expect((await latest()).error).toContain("CPU pressure 20.00%");

      const pressureLow = hostOf([50], [0, 10]);
      expect(await runBench(argv(), execute, out, pressureLow.host)).toBe(0);
      expect(pressureLow.calls.sleeps).toBe(0);
      expect((await latest()).hostLoad).toMatchObject({
        maxLoadPerCore: 0.75,
        maxCpuPressure: 10,
        start: { load1: 50, cores: 12, cpuPressure: 0 },
        end: { load1: 50, cores: 12, cpuPressure: 10 },
      });
      const report = await readFile(path.join(out, (await latest()).time, "report.md"), "utf8");
      expect(report).toContain("CPU pressure some avg10: 0.00%");
      expect(report).toContain("CPU pressure some avg10: 10.00%");
      expect(report).toContain("load 50.00 on 12 cores");
      expect(report).toContain("/sys/fs/cgroup/bench.scope/cpu.pressure");

      const pressureSettles = hostOf([50], [20, 5]);
      expect(await runBench(argv(), execute, out, pressureSettles.host)).toBe(0);
      expect(pressureSettles.calls.sleeps).toBe(1);
      expect(await runBench(argv(), execute, out, hostOf([1], [5, 20]).host)).toBe(2);
      expect((await latest()).hostLoad.end.cpuPressure).toBe(20);
      expect((await latest()).error).toContain("CPU pressure 20.00%");
      expect(
        await runBench(argv("--max-cpu-pressure", "25"), execute, out, hostOf([50], [20]).host),
      ).toBe(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
  it("runs the consumer P,V,P,V and returns 2 on a missing metric or crashed journey", async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "bench-perry-spec-"));
    const launches: string[] = [];
    await writeFile(path.join(temp, "game"), "binary");
    await writeFile(path.join(temp, "game.js"), "bundle");
    await mkdir(path.join(temp, "native"));
    await writeFile(path.join(temp, "native/assets.tnpk"), "assets");
    await writeFile(
      path.join(temp, "scenario.json"),
      JSON.stringify({
        assert: { performance: { minFps: 30, maxFrameMsP95: 33, maxDrawCalls: 128 } },
      }),
    );
    let missing = false;
    let crashed = false;
    const directories: string[] = [];
    const execute = async (command: string, args: string[]) => {
      if (command === "git") return { code: 0, stdout: "head", stderr: "" };
      if (command === process.execPath) {
        expect(args).toContain("--assets");
        await writeFile(path.join(temp, "game.js"), "rebuilt bundle");
        return { code: 0, stdout: "built", stderr: "" };
      }
      if (command === "nice") {
        expect(args.slice(0, 3)).toEqual(["-n", "19", "perf"]);
        return {
          code: 0,
          stdout:
            args[3] === "report"
              ? "  50.00% [.] game\n"
              : await readFile(
                  path.join(import.meta.dirname, "fixtures/perry-profile/perf-script.txt"),
                  "utf8",
                ),
          stderr: "",
        };
      }
      const artifactIndex = args.indexOf("--artifacts");
      const artifacts = args[artifactIndex + 1];
      if (!artifacts) throw new Error("missing artifact argument");
      const arm = path.basename(artifacts).split("-")[0] ?? "";
      directories.push(path.dirname(artifacts));
      launches.push(arm);
      expect(command).toBe("sh");
      expect(args[0]).toMatch(/scripts\/xvfb.sh$/);
      const scenario = JSON.parse(
        await readFile(path.join(path.dirname(artifacts), "scenario.playtest.json"), "utf8"),
      );
      expect(scenario.assert.performance).toEqual({ maxDrawCalls: 128 });
      await mkdir(artifacts, { recursive: true });
      if (artifacts.endsWith("-perf")) {
        await writeFile(path.join(path.dirname(artifacts), `${arm}.data.pid`), "999999999\n");
        await writeFile(path.join(path.dirname(artifacts), `${arm}.data`), "fake perf data");
      }
      const text = missing
        ? "TN_PLAYER_FIRST_PRESENT: runtime perry"
        : markers(arm === "perry" ? 0.3 : 1);
      await writeFile(
        path.join(artifacts, "console.json"),
        JSON.stringify(text.split("\n").map((line) => ({ text: line }))),
      );
      return { code: crashed ? 1 : 0, stdout: "{}", stderr: "" };
    };
    const argv = [
      "--project",
      temp,
      "--scenario",
      "scenario.json",
      "--perry",
      path.join(temp, "game"),
      "--v8-bundle",
      temp,
      "--runs",
      "2",
    ];
    try {
      expect(await runBench(argv, execute, path.join(temp, "artifacts"), idle)).toBe(0);
      expect(launches).toEqual(["perry", "v8", "perry", "v8"]);
      const written = await readFile(path.join(directories.at(-1) ?? "", "report.html"), "utf8");
      expect(written).toContain('<article data-metric="firstFrameMs"');
      expect(written.replace(TAILWIND_CDN, "")).not.toContain("http");
      expect(await readFile(path.join(temp, "artifacts", "index.html"), "utf8")).toBe(written);
      await rm(path.join(temp, "game.js"));
      expect(await runBench([...argv, "--perf"], execute, path.join(temp, "artifacts"), idle)).toBe(
        0,
      );
      const profiled = JSON.parse(
        await readFile(path.join(directories.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(profiled.stacks).toEqual({
        perry: [{ symbol: "game", percent: 50 }],
        v8: [{ symbol: "game", percent: 50 }],
      });
      const profiledDir = directories.at(-1) ?? "";
      expect(await readFile(path.join(profiledDir, "perry-top.txt"), "utf8")).toContain(
        "TS functions inclusive",
      );
      expect(await readFile(path.join(profiledDir, "perry-callers.txt"), "utf8")).toContain(
        "nearest TS frame",
      );
      expect(await readFile(path.join(profiledDir, "perry.data.folded"), "utf8")).toContain("# {");
      expect(await readFile(path.join(profiledDir, "profile.sh"), "utf8")).toContain(
        "TN_PROFILE_CLOCK",
      );
      expect(launches.slice(4)).toEqual(["perry", "v8", "perry", "v8", "perry", "v8"]);
      missing = true;
      expect(await runBench(argv, execute, path.join(temp, "artifacts"), idle)).toBe(2);
      missing = false;
      crashed = true;
      expect(await runBench(argv, execute, path.join(temp, "artifacts"), idle)).toBe(2);
      const failure = JSON.parse(
        await readFile(path.join(directories.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(failure.error).toContain("exit 1");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
