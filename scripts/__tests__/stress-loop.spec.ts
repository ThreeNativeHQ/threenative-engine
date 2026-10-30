import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDirSync } from "../../test-support/temp-dir.js";

const { GOALS, appendRow, measureReport, renderHtml, readLedger } = await import(
  new URL("../stress-loop.mjs", import.meta.url).href
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

  it("keeps Triangles unranked and flags a count that is off or broken", () => {
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
    expect(triangles[2]).toContain("count basis differs");
    expect(triangles[1]).toContain("counter broken");
    const draws = cellsOf(html, "Main draws");
    expect(draws[1]).toContain("⚠️");
    expect(draws[1]).not.toMatch(/✅|▲/u);
    expect(draws[0]).toContain("✅");
    expect(draws[2]).toContain("❌");
    const close = cellsOf(
      renderHtml(
        armLedger({ [WASM]: { mainTrianglesM: 7.07 }, [VANILLA]: { mainTrianglesM: 7.5 } }),
        new Date(0),
      ),
      "Triangles",
    );
    expect(close[2]).not.toContain("⚠️");
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
