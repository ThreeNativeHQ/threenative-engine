import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareArms,
  ledgerLine,
  parseBenchArgs,
  parseLedger,
  parsePerfSelf,
  parsePlayerMetrics,
  reportHtml,
  reportMarkdown,
  runBench,
} from "../bench-perry.js";

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
    });
    for (const argv of [
      [],
      ["--perry"],
      ["--unknown"],
      ["--perry", "x", "--runs", "0"],
      ["--perry", "x", "--runs", "1.5"],
      ["--perry", "x", "--perry", "y"],
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
      "# Overhead Symbol\n  20.00% [.] game\n  5.00% [.] game\n  30.00% [k] present\n",
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
      expect(html).toContain(`<th scope="row">${metric}</th>`);
    expect(html).toContain('<td class="verdict miss">MISS</td>');
    expect(html).toContain("<svg");
    expect(html).toContain("present");
    expect(html).not.toContain("http");
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
      if (command === "perf") return { code: 0, stdout: "  50.00% [.] game\n", stderr: "" };
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
      expect(await runBench(argv, execute, path.join(temp, "artifacts"))).toBe(0);
      expect(launches).toEqual(["perry", "v8", "perry", "v8"]);
      const written = await readFile(path.join(directories.at(-1) ?? "", "report.html"), "utf8");
      expect(written).toContain('<th scope="row">firstFrameMs</th>');
      expect(written).not.toContain("http");
      expect(await readFile(path.join(temp, "artifacts", "index.html"), "utf8")).toBe(written);
      await rm(path.join(temp, "game.js"));
      expect(await runBench([...argv, "--perf"], execute, path.join(temp, "artifacts"))).toBe(0);
      const profiled = JSON.parse(
        await readFile(path.join(directories.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(profiled.stacks).toEqual({
        perry: [{ symbol: "game", percent: 50 }],
        v8: [{ symbol: "game", percent: 50 }],
      });
      expect(launches.slice(4)).toEqual(["perry", "v8", "perry", "v8", "perry", "v8"]);
      missing = true;
      expect(await runBench(argv, execute, path.join(temp, "artifacts"))).toBe(2);
      missing = false;
      crashed = true;
      expect(await runBench(argv, execute, path.join(temp, "artifacts"))).toBe(2);
      const failure = JSON.parse(
        await readFile(path.join(directories.at(-1) ?? "", "result.json"), "utf8"),
      );
      expect(failure.error).toContain("exit 1");
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
