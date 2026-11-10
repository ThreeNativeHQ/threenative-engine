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
const { rankOf, scoreOf, verdictOf, verdictStrip } = await import(
  new URL("../stress-dashboard.mjs", import.meta.url).href
);

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
const armLedger = (arms: Record<string, Record<string, number | null>>) =>
  Object.entries(arms).reduce(
    (ledger, [engine, metrics]) =>
      appendRow(
        ledger,
        measureReport(report({ metrics: { ...report().metrics, ...metrics } }), {
          counted: engine !== "unreal",
        }),
        {
          label: engine,
          engine,
          decision: "measure",
        },
      ),
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

  it("anchors the Wasm column on the kept arm, never on an old row or a rejected arm", () => {
    const row = (variant: string, decision: string, gpuP95Ms: number) =>
      [
        measureReport(report({ metrics: { ...report().metrics, gpuP95Ms } })),
        { label: variant, variant, decision },
      ] as const;
    const ledger = [
      row("stress", "measure", 34),
      row("arm=stack&uncapped", "keep", 8),
      row("arm=stack", "keep", 7.5),
      row("arm=candidate", "measure", 7.2),
      row("arm=rejected", "reject", 1),
    ].reduce((acc, [r, o]) => appendRow(acc, r, o), readLedger(ledgerPath()));
    const html = renderHtml(ledger, new Date(0));
    // The kept vsync stack row (#3) wins over the old plain row (#1), the newer candidate (#4) and the rejected arm (#5).
    expect(cellsOf(html, "GPU p95")[0]).toContain("7.5");
    expect(html).toContain("#3 ·");
  });

  it("puts the apples-to-apples plain sun map table before the virtual shadow table", () => {
    const ledger = ["plainShadow&arm=stack", "arm=stack"].reduce(
      (acc, variant) => recordRun(acc, run(), { label: variant, variant, decision: "keep" }),
      readLedger(ledgerPath()),
    );
    const html = renderHtml(ledger, new Date(0));
    expect(html.indexOf("Apples to apples")).toBeGreaterThan(-1);
    expect(html.indexOf("Apples to apples")).toBeLessThan(html.indexOf("Virtual shadow maps"));
  });

  it("anchors the KPI table on ThreeNative's VSM load 1 develop row, not the newest row of any arm", () => {
    const metrics = (fps: number) => ({ metrics: { ...report().metrics, fps } });
    const ledger = [
      { variant: "arm=stack3&uncapped", pass: "uncapped", engine: WASM, fps: 62.7 },
      { variant: "arm=comb2&uncapped", pass: "uncapped", engine: WASM, fps: 68.8 },
      { variant: "plainShadow&arm=stack3&uncapped", pass: "uncapped", engine: WASM, fps: 103 },
      { variant: "plainShadow&load=8&arm=l8", pass: "uncapped", engine: WASM, fps: 9.5 },
      { variant: "load=8&arm=vanilla-l8", pass: "uncapped", engine: "three-vanilla", fps: 7.92 },
    ].reduce(
      (acc, { variant, pass, engine, fps }) =>
        recordRun(
          acc,
          run(
            {
              pass,
              url: `http://127.0.0.1:5740/main.html?stress&${variant}`,
              build: { kind: engine === WASM ? "wasm" : "js", sha256: "4fb0aba5a921", commit: "a" },
            },
            metrics(fps),
          ),
          { label: variant, variant, engine, decision: "measure" },
        ),
      readLedger(ledgerPath()),
    );
    const html = renderHtml(ledger, new Date(0));
    const kpiTable = html.slice(html.indexOf("KPI against goal"), html.indexOf("</details>"));
    expect(kpiTable).toContain("62.7 fps");
    expect(kpiTable).not.toContain("7.92");
    expect(kpiTable).toContain("#1");
  });

  it("scores a row 0 to 100 against the 120 fps goal, and refuses a row with a missing metric", () => {
    const goal = {
      presentedP95Ms: 8.33,
      fps: 120,
      frameP95Ms: 8.33,
      gpuP95Ms: 8.33,
      hitchesPerMin: 0,
    };
    expect(scoreOf(goal)).toBe(100);
    expect(scoreOf({ ...goal, fps: 500, gpuP95Ms: 1 })).toBe(100);
    // Half the speed on every timing, no hitches: 95 points at half, plus all 5 hitch points.
    expect(
      scoreOf({ ...goal, presentedP95Ms: 16.66, fps: 60, frameP95Ms: 16.66, gpuP95Ms: 16.66 }),
    ).toBeCloseTo(52.5);
    expect(scoreOf({ ...goal, hitchesPerMin: 1 })).toBeCloseTo(97.5);
    expect(scoreOf({ ...goal, gpuP95Ms: null })).toBeNull();
  });

  it("answers in one word whether ThreeNative wins against each measured rival", () => {
    const ctx = { loadVoid: 6, shadowOf: (row: { shadow: string }) => row.shadow };
    const row = (engine: string, shadow: string, fps: number, variant: string) => ({
      engine,
      shadow,
      variant,
      pass: "uncapped",
      load: { peak: 1 },
      decision: "measure",
      metrics: { presentedP95Ms: 12, fps, frameP95Ms: 12, gpuP95Ms: 12, hitchesPerMin: 0 },
    });
    const tn = row(WASM, "plain", 100, "plainShadow&arm=develop&uncapped");
    const tnVsm = row(WASM, "virtual", 60, "arm=develop&uncapped");
    const vanilla = (fps: number) => row("three-vanilla", "plain", fps, "arm=v&uncapped");
    const unreal = (fps: number) => row("unreal", "virtual", fps, "tnmatched&uncapped");

    expect(verdictOf([], ctx).status).toBe("none");
    // A rival with no valid run counts as neither a win nor a loss.
    const onlyVanilla = verdictOf([tn, tnVsm, vanilla(50)], ctx);
    expect(onlyVanilla).toMatchObject({ status: "winning", wins: 1, measured: 1, pending: 2 });
    expect(verdictOf([tn, tnVsm, vanilla(110)], ctx).status).toBe("losing");
    expect(verdictOf([tn, tnVsm, vanilla(50), unreal(90)], ctx)).toMatchObject({
      status: "mixed",
      wins: 1,
      measured: 2,
    });
    expect(verdictOf([tn, tnVsm, vanilla(100)], ctx).status).toBe("mixed");
    const strip = verdictStrip(onlyVanilla);
    expect(strip).toContain("WINNING");
    expect(strip).toContain("not measured");
    expect(strip).toContain('data-verdict="winning"');
  });

  it("compares engines on one GPU only: a later laptop row does not stand in for the desktop baseline", () => {
    const ctx = { loadVoid: 6, shadowOf: (row: { shadow: string }) => row.shadow };
    const row = (engine: string, adapter: string, fps: number, variant: string) => ({
      engine,
      adapter,
      shadow: "virtual",
      variant,
      pass: "uncapped",
      load: { peak: 1 },
      decision: "measure",
      metrics: { presentedP95Ms: 12, fps, frameP95Ms: 12, gpuP95Ms: 12, hitchesPerMin: 0 },
    });
    const desktop = row(WASM, "nvidia / turing", 110, "arm=develop&uncapped");
    const unreal = row("unreal", "NVIDIA GeForce RTX 2080", 70, "tnmatched&uncapped");
    const laptop = row(WASM, "intel / gen-12lp", 40, "arm=develop&uncapped");
    // Rows #310-#312 (Iris Xe) against #288 (RTX 2080) read "losing 46 to 56" on 2026-11-10: two machines, not two engines.
    const verdict = verdictOf([desktop, unreal, laptop], ctx);
    expect(verdict.status).toBe("winning");
    expect(verdict.rivals.find((rival: { result: string }) => rival.result === "win")?.mine).toBe(
      Math.round(scoreOf(desktop.metrics) ?? 0),
    );
    // With no rival on its GPU, the laptop row has nothing to beat.
    expect(verdictOf([unreal, laptop], ctx).status).toBe("none");
  });

  it("says WAS WINNING in grey when the rows behind the verdict are old, so old data does not read as now", () => {
    const ctx = { loadVoid: 6, shadowOf: (row: { shadow: string }) => row.shadow };
    const row = (engine: string, fps: number, at: string, commit: string) => ({
      engine,
      at,
      commit,
      shadow: "plain",
      variant: engine === WASM ? "plainShadow&arm=develop&uncapped" : "arm=v&uncapped",
      pass: "uncapped",
      load: { peak: 1 },
      decision: "measure",
      metrics: { presentedP95Ms: 12, fps, frameP95Ms: 12, gpuP95Ms: 12, hitchesPerMin: 0 },
    });
    const rows = [
      row(WASM, 100, "2026-10-31T06:00:00.000Z", "core@0.3.7"),
      row("three-vanilla", 50, "2026-10-31T12:00:00.000Z", "three@0.185.1"),
    ];
    const old = verdictOf(rows, ctx, Date.parse("2026-11-02T02:00:00.000Z"));
    // The oldest compared row sets the age: one fresh rival does not freshen an old baseline.
    expect(old).toMatchObject({ status: "winning", stale: true, ageHours: 44 });
    const strip = verdictStrip(old);
    expect(strip).toContain("WAS WINNING");
    expect(strip).toContain("44 h old");
    expect(strip).not.toContain("#14803f");

    const fresh = verdictOf(rows, ctx, Date.parse("2026-10-31T13:00:00.000Z"));
    expect(fresh).toMatchObject({ stale: false, ageHours: 7 });
    expect(verdictStrip(fresh)).not.toContain("WAS WINNING");
  });

  it("marks a score row measured on a loaded host, so a lower score does not read as a regression", () => {
    const row = (id: number, peak: number) => ({
      ...report(),
      id,
      at: "2026-11-02T04:00:00.000Z",
      commit: "core@0.3.8",
      engine: WASM,
      variant: "plainShadow&arm=head&uncapped",
      pass: "uncapped",
      decision: "measure",
      load: { peak, samples: 10 },
    });
    expect(renderHtml({ iterations: [row(1, 11)] })).toContain("noisy, load 11");
    expect(renderHtml({ iterations: [row(1, 5)] })).not.toContain("noisy, load");
  });

  it("colors a bar green for the winner, yellow for a tie at the top and red for a loser", () => {
    expect(rankOf(10, [10, 5])).toBe("s-win");
    expect(rankOf(5, [10, 5])).toBe("s-lose");
    expect(rankOf(10, [10, 10, 5])).toBe("s-tie");
    expect(rankOf(5, [10, 10, 5])).toBe("s-lose");
    // Nothing to beat is no win.
    expect(rankOf(10, [10])).toBe("s-none");
  });

  it("reads a score gap inside the margin as a tie, for the bar and for the verdict", () => {
    expect(rankOf(56, [56, 54], 2)).toBe("s-tie");
    expect(rankOf(54, [56, 54], 2)).toBe("s-tie");
    expect(rankOf(56, [56, 53], 2)).toBe("s-win");
    expect(rankOf(53, [56, 53], 2)).toBe("s-lose");
  });

  it("shows one score bar per engine at the top of the Overview, and pending for an engine with no valid run", () => {
    const metrics = (fps: number) => ({ metrics: { ...report().metrics, fps } });
    const ledger = [
      { variant: "plainShadow&arm=develop&uncapped", engine: WASM, fps: 100 },
      { variant: "arm=vanilla&uncapped", engine: "three-vanilla", fps: 60 },
      { variant: "arm=develop&uncapped", engine: WASM, fps: 62 },
      { variant: "load=8&arm=l8&uncapped", engine: "three-vanilla", fps: 7.92 },
      { variant: "tnmatched&uncapped", engine: "unreal", fps: 110 },
    ].reduce(
      (acc, { variant, engine, fps }) =>
        recordRun(
          acc,
          run(
            {
              pass: "uncapped",
              build: { kind: engine === WASM ? "wasm" : "js", sha256: "4fb0aba5a921", commit: "a" },
            },
            metrics(fps),
          ),
          { label: variant, variant, engine, decision: "measure" },
        ),
      readLedger(ledgerPath()),
    );
    const html = renderHtml(ledger, new Date(0));
    const panel = html.slice(html.indexOf("Engine score"), html.indexOf("120 fps goal ladder"));
    expect(panel).toContain("Vanilla three.js");
    expect(panel).toContain("Unreal 5.8.3");
    expect(panel).toContain("ThreeNative (Wasm)");
    expect(panel.match(/class="score-fill s-/gu)?.length).toBe(5);
    // Unreal stock has no row: it reads pending, never zero. The load 8 row is not an engine's score.
    expect(panel).toContain("pending");
    expect(panel).not.toContain("7.92");
    // A group with one measured engine names no winner: both groups here have two.
    expect(panel.match(/✅/gu)?.length).toBe(2);
    // Vanilla loses its group on the score bar, and the equal metrics of the pair tie.
    expect(panel).toContain('class="score-fill s-win"');
    expect(panel).toContain('class="score-fill s-lose"');
    expect(panel).toContain('class="score-fill score-part s-tie"');
    expect(panel).toContain('class="score-fill s-none"');
    // The panel comes before the ladder and is on the visible Overview tab.
    expect(html.indexOf("Engine score")).toBeLessThan(html.indexOf("120 fps goal ladder"));
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

  it("records an Unreal run without draw or triangle counts, and ranks it as not comparable", () => {
    const uncounted = { mainDraws: null, mainTrianglesM: null };
    const unreal = run(
      {
        url: "unreal://stress",
        build: { kind: "unreal", sha256: "58210709abcd", commit: "UnrealEngine-5.8.3" },
      },
      { metrics: { ...report().metrics, ...uncounted } },
    );
    // Only Unreal cannot count: an owned-engine row without counts still fails closed.
    expect(() =>
      recordRun(
        readLedger(ledgerPath()),
        run({}, { metrics: { ...report().metrics, ...uncounted } }),
        { label: "x" },
      ),
    ).toThrow(/mainDraws/u);
    const ledger = recordRun(readLedger(ledgerPath()), unreal, { label: "u", engine: "unreal" });
    expect(ledger.iterations[0].metrics).toMatchObject(uncounted);
    // A row that measured no main triangles cannot prove equal work, so it is shown but not ranked.
    const cells = cellsOf(
      renderHtml(
        armLedger({
          [WASM]: { mainTrianglesM: 2.11, gpuP95Ms: 6 },
          unreal: { mainTrianglesM: null, gpuP95Ms: 9 },
        }),
        new Date(0),
      ),
      "GPU p95",
    );
    expect(cells[3]).toContain("not comparable: main triangles not measured");
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

  it("voids a run whose host load rose above 18", () => {
    expect(() =>
      recordRun(readLedger(ledgerPath()), run({ load: [3, 18.1] }), { label: "x" }),
    ).toThrow(/run void: host load 18\.1/u);
    expect(() => recordRun(readLedger(ledgerPath()), run({ load: [] }), { label: "x" })).toThrow(
      /load/u,
    );
    expect(() =>
      recordRun(readLedger(ledgerPath()), run({ load: [3, 18] }), { label: "x" }),
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
    const plain = html.slice(html.indexOf("Apples to apples"), html.indexOf("Virtual shadow maps"));
    const gpu =
      (plain.split("<tr>").find((tr: string) => tr.startsWith("<td>GPU p95</td>")) ?? "").match(
        /<td class="n[^>]*>.*?<\/td>/gu,
      ) ?? [];
    expect(gpu[0]).toContain("12 ms");
    expect(gpu[2]).toContain("✅");
    expect(gpu[2]).not.toContain("⚠️");
  });
});
