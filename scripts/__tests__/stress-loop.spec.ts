import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const {
  GOALS,
  appendRow,
  checkedRun,
  measureReport,
  recordRun,
  renderHtml,
  readLedger,
  writeLedger,
} = await import(new URL("../stress-loop.mjs", import.meta.url).href);

const report = (overrides: Record<string, unknown> = {}) => ({
  schema: "stress-lab-report/1",
  commit: "9f05a39",
  preset: "real",
  layers: ["rain", "ripples"],
  adapter: "nvidia / turing",
  viewport: "1280x720",
  seconds: 30,
  windows: 4,
  metrics: {
    presentedP50Ms: 8.3,
    presentedP95Ms: 15.1,
    fps: 118,
    gpuP50Ms: 4.2,
    gpuP95Ms: 9.8,
    renderP50Ms: 2.1,
    updateP50Ms: 1.2,
    frameP50Ms: 6.4,
    frameP95Ms: 11.2,
    mainDraws: 210,
    shadowDraws: 40,
    mainTrianglesM: 1.8,
    hitchesPerMin: 0.5,
    longTasks: 2,
    loadMs: 850,
    bridgeCrossingsP50: 1390,
    hostCallsP50: 2100,
    gpuUploadKbP50: 96,
    jsAllocKbP50: null,
  },
  counts: { rain: 12_000 },
  ...overrides,
});

const ledgerPath = () => path.join(makeTempDirSync("stress-loop"), "ledger.json");

/** A ledger with one measured row per engine, each with its own metric values. */
const armLedger = (arms: Record<string, Record<string, number>>) =>
  Object.entries(arms).reduce(
    (ledger, [engine, metrics]) =>
      appendRow(ledger, measureReport(report({ metrics: { ...report().metrics, ...metrics } })), {
        label: engine,
        engine,
        decision: "measure",
      }),
    readLedger(ledgerPath()),
  );

/** The cells of one comparison row, one per engine in table order. */
const cellsOf = (html: string, metric: string) => {
  const table = html.slice(html.indexOf("Engine comparison"), html.indexOf("<h2>Iterations"));
  const row = table.split("<tr>").find((tr) => tr.startsWith(`<td>${metric}</td>`)) ?? "";
  return row.match(/<td class="n[^>]*>.*?<\/td>/gu) ?? [];
};

const WASM = "threenative-wasm";
const THREEJS = "threenative-threejs";
const VANILLA = "three-vanilla";

describe("stress-loop", () => {
  it("records the first row as the baseline and the second as keep", () => {
    const file = ledgerPath();
    const first = appendRow(readLedger(file), measureReport(report()), { label: "first run" });
    expect(first.iterations[0].decision).toBe("baseline");
    writeFileSync(file, JSON.stringify(first));
    const second = appendRow(readLedger(file), measureReport(report({ preset: "max" })), {
      label: "second run",
    });
    expect(
      second.iterations.map((row: { id: number; decision: string }) => [row.id, row.decision]),
    ).toEqual([
      [1, "baseline"],
      [2, "keep"],
    ]);
    expect(second.iterations[1].preset).toBe("max");
  });

  it("fails closed on a missing metric, never a zero", () => {
    const { presentedP95Ms: _, ...rest } = report().metrics;
    expect(() => measureReport(report({ metrics: rest }))).toThrow(/presentedP95Ms/u);
    expect(() => measureReport(report({ seconds: 0 }))).toThrow(/seconds/u);
    const { bridgeCrossingsP50: _crossings, ...noCrossings } = report().metrics as Record<
      string,
      unknown
    >;
    expect(() => measureReport(report({ metrics: noCrossings }))).toThrow(/bridgeCrossingsP50/u);
    expect(() =>
      measureReport(report({ metrics: { ...report().metrics, gpuP95Ms: undefined } })),
    ).toThrow(/gpuP95Ms/u);
  });

  it("renders goal cards, charts and the history with escaped text", () => {
    const file = ledgerPath();
    const one = appendRow(readLedger(file), measureReport(report()), {
      label: 'stress "max" & <real>',
    });
    const two = appendRow(one, measureReport(report({ preset: "max" })), {
      label: "second run",
      decision: "reject",
    });
    writeFileSync(file, JSON.stringify(two));
    const html = renderHtml(readLedger(file), new Date(0));
    expect(html).toContain("Stress lab");
    for (const goal of GOALS as { label: string }[]) expect(html).toContain(goal.label);
    expect(html).toContain("JS↔Wasm crossings");
    expect(html).toContain(`http-equiv="refresh"`);
    expect(html).toContain("1390 /frame");
    expect(html).toContain("stress &quot;max&quot; &amp; &lt;real&gt;");
    expect(html).toContain("<svg");
    expect(html).toContain("#2");
  });

  it("records the engine arm and compares every metric across engines", () => {
    const wasm = appendRow(readLedger(ledgerPath()), measureReport(report()), { label: "wasm" });
    expect(wasm.iterations[0].engine).toBe("threenative-wasm");
    const both = appendRow(wasm, measureReport(report({ adapter: "unreal rtx" })), {
      label: "unreal arm",
      decision: "measure",
      engine: "unreal",
    });
    expect(both.iterations[1]).toMatchObject({ engine: "unreal", decision: "measure" });
    expect(() => appendRow(wasm, measureReport(report()), { label: "x", engine: "godot" })).toThrow(
      /engine must be one of/,
    );
    const html = renderHtml(both, new Date(0));
    expect(html).toContain("Engine comparison");
    for (const name of [
      "ThreeNative (Wasm)",
      "ThreeNative (three.js engine)",
      "Vanilla three.js",
      "Unreal 5.8.3",
    ])
      expect(html).toContain(name);
    for (const label of [
      "Update p50",
      "CPU frame p50",
      "Presented p50",
      "Shadow draws",
      "Triangles",
      "Long tasks",
      "Load",
    ])
      expect(html).toContain(label);
    expect(html).toContain("unreal rtx");
    expect(html).toContain("850 ms");
  });

  it("compares only plain ?stress rows, so a variant run does not replace an engine's column", () => {
    const plain = appendRow(
      readLedger(ledgerPath()),
      measureReport(report({ adapter: "plain gpu" })),
      {
        label: "stress",
      },
    );
    const both = appendRow(plain, measureReport(report({ adapter: "variant gpu" })), {
      label: "plainShadow",
      decision: "measure",
      variant: "plainShadow",
    });
    expect(both.iterations[0].variant).toBe("stress");
    expect(both.iterations[1].variant).toBe("plainShadow");
    const html = renderHtml(both, new Date(0));
    const table = html.slice(html.indexOf("Engine comparison"), html.indexOf("<h2>Iterations"));
    expect(table).toContain("plain gpu");
    expect(table).not.toContain("variant gpu");
    expect(html).toContain("plainShadow");
  });

  it("marks the highest FPS best and the lowest worst, and marks nothing for one arm", () => {
    const html = renderHtml(
      armLedger({
        [WASM]: { fps: 45.39 },
        [THREEJS]: { fps: 31.9 },
        [VANILLA]: { fps: 41.86 },
      }),
      new Date(0),
    );
    const fps = cellsOf(html, "FPS");
    expect(fps).toHaveLength(4);
    expect(fps[0]).toContain("✅");
    expect(fps[1]).toContain("❌");
    expect(fps[2]).not.toMatch(/✅|❌/u);
    expect(fps[3]).toContain('class="n dim"');
    expect(fps[3]).toContain("pending");
    const lone = cellsOf(renderHtml(armLedger({ [WASM]: { fps: 45.39 } }), new Date(0)), "FPS");
    expect(lone.join("")).not.toMatch(/✅|❌/u);
  });

  it("marks the lowest cell best on a lower-better row", () => {
    const html = renderHtml(
      armLedger({
        [WASM]: { gpuP95Ms: 34.21 },
        [THREEJS]: { gpuP95Ms: 14.42 },
        [VANILLA]: { gpuP95Ms: 3.09 },
      }),
      new Date(0),
    );
    const gpu = cellsOf(html, "GPU p95");
    expect(gpu[2]).toContain("✅");
    expect(gpu[0]).toContain("❌");
    expect(gpu[1]).not.toMatch(/✅|❌/u);
  });

  it("marks no best or worst when the arms differ by less than rounding", () => {
    const html = renderHtml(
      armLedger({
        [WASM]: { presentedP95Ms: 33.36 },
        [THREEJS]: { presentedP95Ms: 33.5 },
        [VANILLA]: { presentedP95Ms: 33.4 },
      }),
      new Date(0),
    );
    const cells = cellsOf(html, "Presented p95");
    expect(cells.join("")).not.toMatch(/✅|❌/u);
    expect(cells[1]).toContain("same");
  });

  it("shows each cell's difference against the Wasm arm, with an arrow by better or worse", () => {
    const html = renderHtml(
      armLedger({
        [WASM]: { fps: 45.39, gpuP95Ms: 34.21 },
        [THREEJS]: { fps: 31.9, gpuP95Ms: 14.42 },
        [VANILLA]: { fps: 41.86, gpuP95Ms: 3.09 },
      }),
      new Date(0),
    );
    const gpu = cellsOf(html, "GPU p95");
    expect(gpu[2]).toContain("▲ 11× lower");
    expect(gpu[1]).toContain("▲ 2.4× lower");
    const fps = cellsOf(html, "FPS");
    expect(fps[1]).toContain("▼ 30% lower");
    expect(fps[2]).toContain("▼ 8% lower");
    expect(gpu[0]).not.toMatch(/▲|▼/u);
  });

  it("keeps Triangles unranked and shows an arm with other triangles as not comparable", () => {
    const html = renderHtml(
      armLedger({
        [WASM]: { mainTrianglesM: 7.07, mainDraws: 60 },
        [THREEJS]: { mainTrianglesM: 0, mainDraws: 1 },
        [VANILLA]: { mainTrianglesM: 2.11, mainDraws: 1391 },
      }),
      new Date(0),
    );
    const triangles = cellsOf(html, "Triangles");
    expect(triangles.join("")).not.toMatch(/✅|❌/u);
    expect(triangles[2]).toContain("⚠️");
    expect(triangles[2]).toContain("not comparable: main triangles 2.11 M against 7.07 M");
    expect(triangles[1]).toContain("counter broken");
    // No arm is comparable to the Wasm arm, so no draws cell is ranked.
    expect(cellsOf(html, "Main draws").join("")).not.toMatch(/✅|❌|▲|▼/u);
    const close = cellsOf(
      renderHtml(
        armLedger({ [WASM]: { mainTrianglesM: 7.07 }, [VANILLA]: { mainTrianglesM: 7.15 } }),
        new Date(0),
      ),
      "Triangles",
    );
    expect(close[2]).not.toContain("⚠️");
  });

  it("compares speed only between rows whose main and shadow triangles are within 2%", () => {
    const tri = (main: number, shadow: number | null) => ({
      mainTrianglesM: main,
      shadowTrianglesM: shadow,
      gpuP95Ms: 10,
    });
    const gpu = (vanilla: ReturnType<typeof tri>) =>
      cellsOf(
        renderHtml(
          armLedger({ [WASM]: { ...tri(2.11, 2.06), gpuP95Ms: 6 }, [VANILLA]: vanilla }),
          new Date(0),
        ),
        "GPU p95",
      );
    // Same main, shadow 38% lower: not comparable, with the reason.
    const apart = gpu(tri(2.11, 1.28));
    expect(apart[2]).toContain("not comparable: shadow triangles 1.28 M against 2.06 M");
    expect(apart.join("")).not.toMatch(/✅|❌|▲|▼/u);
    // Within 2% on both: ranked.
    const near = gpu(tri(2.12, 2.07));
    expect(near[2]).not.toContain("not comparable");
    expect(near[0]).toContain("✅");
  });

  it("defines the comparison colors for the light and the dark theme", () => {
    const html = renderHtml({ schemaVersion: 1, iterations: [] }, new Date(0));
    expect(html).toMatch(/:root\{[^}]*--ok-bg:/u);
    expect(html).toMatch(/prefers-color-scheme:dark[^\n]*--ok-bg:/u);
  });

  it("renders an empty ledger as pending", () => {
    expect(renderHtml({ schemaVersion: 1, iterations: [] }, new Date(0))).toContain("pending");
  });
});

/** A fair-window run as `stress:loop fair` writes it. */
const run = (
  overrides: Record<string, unknown> = {},
  reportOverrides: Record<string, unknown> = {},
) => ({
  url: "http://127.0.0.1:5740/main.html?stress",
  dpr: 1,
  pass: "vsync",
  adapterInfo: "nvidia / turing",
  build: { kind: "wasm", sha256: "4fb0aba5a921", commit: "0974fd3b8" },
  load: [2.1, 3.4, 3.9],
  report: report(reportOverrides),
  ...overrides,
});

describe("stress-loop record (PRD-770)", () => {
  it("refuses a bare report, a missing build identity and a Wasm arm that loaded no wasm", () => {
    expect(() => recordRun(readLedger(ledgerPath()), report(), { label: "x" })).toThrow(
      /fair-window run/u,
    );
    expect(() =>
      recordRun(readLedger(ledgerPath()), run({ build: { kind: "wasm", commit: "0974fd3b8" } }), {
        label: "x",
      }),
    ).toThrow(/build\.sha256/u);
    expect(() =>
      recordRun(
        readLedger(ledgerPath()),
        run({ build: { kind: "wasm", sha256: "4fb0aba5a921" } }),
        { label: "x" },
      ),
    ).toThrow(/build\.commit/u);
    expect(() =>
      recordRun(
        readLedger(ledgerPath()),
        run({ build: { kind: "js", sha256: "4fb0aba5a921", commit: "a" } }),
        {
          label: "x",
        },
      ),
    ).toThrow(/build\.kind/u);
    const ok = recordRun(readLedger(ledgerPath()), run(), { label: "ok" });
    expect(ok.iterations[0]).toMatchObject({
      build: { sha256: "4fb0aba5a921" },
      shadow: "virtual",
      pass: "vsync",
      load: { peak: 3.9 },
    });
  });

  it("writes the ledger in the shape biome keeps, so the lint gate stays green", () => {
    const file = ledgerPath();
    const ledger = recordRun(readLedger(file), run(), { label: "format check" });
    writeLedger(file, ledger);
    const written = readFileSync(file, "utf8");
    // `layers` is a short array: biome keeps it on one line, JSON.stringify would not.
    expect(written).toContain('"layers": ["rain", "ripples"]');
    const biome = path.resolve(import.meta.dirname, "../../node_modules/.bin/biome");
    const formatted = execFileSync(
      biome,
      ["format", "--stdin-file-path=docs/stress-loop/ledger.json"],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        encoding: "utf8",
        input: written,
      },
    );
    expect(formatted).toBe(written);
  });

  it("takes the adapter from the browser when the report's is blank, and refuses a run with none", () => {
    const blank = { adapter: " / " };
    const row = recordRun(readLedger(ledgerPath()), run({}, blank), { label: "x" });
    expect(row.iterations[0].adapter).toBe("nvidia / turing");
    expect(() => checkedRun(run({ adapterInfo: "" }, blank), "threenative-wasm")).toThrow(
      /adapter/u,
    );
  });

  it("voids a run whose host load rose above 6", () => {
    expect(() =>
      recordRun(readLedger(ledgerPath()), run({ load: [3, 6.1] }), { label: "x" }),
    ).toThrow(/run void: host load 6\.1/u);
    expect(() => recordRun(readLedger(ledgerPath()), run({ load: [] }), { label: "x" })).toThrow(
      /load/u,
    );
    expect(() =>
      recordRun(readLedger(ledgerPath()), run({ load: [3, 6] }), { label: "x" }),
    ).not.toThrow();
  });

  it("marks an arm with other counts or another shadow mode with a warning and ranks it nowhere", () => {
    const fair = (
      engine: string,
      variant: string,
      metrics: Record<string, number>,
      counts?: object,
    ) => [engine, variant, metrics, counts] as const;
    const rows = [
      fair(WASM, "stress", { gpuP95Ms: 30 }),
      fair(THREEJS, "stress", { gpuP95Ms: 20 }, { trees: 10 }),
      fair(VANILLA, "stress", { gpuP95Ms: 3 }),
    ].reduce(
      (ledger, [engine, variant, metrics, counts]) =>
        recordRun(
          ledger,
          run(
            {
              build: { kind: engine === WASM ? "wasm" : "js", sha256: "4fb0aba5a921", commit: "a" },
            },
            { metrics: { ...report().metrics, ...metrics }, ...(counts ? { counts } : {}) },
          ),
          { label: engine, engine, variant, decision: "measure" },
        ),
      readLedger(ledgerPath()),
    );
    const gpu = cellsOf(renderHtml(rows, new Date(0)), "GPU p95").slice(0, 3);
    // three.js engine: other counts. Vanilla: a plain sun map against virtual shadow maps.
    expect(gpu[1]).toContain("counts differ");
    expect(gpu[2]).toContain("shadow mode plain against virtual");
    for (const cell of [gpu[1], gpu[2]]) expect(cell).toContain("⚠️");
    expect(gpu.join("")).not.toMatch(/✅|❌|▲|▼/u);
  });

  it("compares vanilla to the plainShadow Wasm row in a second, like-for-like table", () => {
    const entry = (ledger: unknown, engine: string, variant: string, gpuP95Ms: number) =>
      recordRun(
        ledger,
        run(
          { build: { kind: engine === WASM ? "wasm" : "js", sha256: "4fb0aba5a921", commit: "a" } },
          { metrics: { ...report().metrics, gpuP95Ms } },
        ),
        { label: engine, engine, variant, decision: "measure" },
      );
    let ledger = readLedger(ledgerPath());
    ledger = entry(ledger, WASM, "stress", 30);
    ledger = entry(ledger, WASM, "plainShadow", 12);
    ledger = entry(ledger, VANILLA, "stress", 3);
    const html = renderHtml(ledger, new Date(0));
    const plain = html.slice(html.indexOf("Plain sun map"), html.indexOf("<h2>Iterations"));
    const gpu =
      (plain.split("<tr>").find((tr) => tr.startsWith("<td>GPU p95</td>")) ?? "").match(
        /<td class="n[^>]*>.*?<\/td>/gu,
      ) ?? [];
    expect(gpu[0]).toContain("12 ms");
    expect(gpu[2]).toContain("✅");
    expect(gpu[2]).not.toContain("⚠️");
  });
});
