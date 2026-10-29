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
    expect(html).toContain("1390 /frame");
    expect(html).toContain("stress &quot;max&quot; &amp; &lt;real&gt;");
    expect(html).toContain("<svg");
    expect(html).toContain("#2");
  });

  it("renders an empty ledger as pending", () => {
    expect(renderHtml({ schemaVersion: 1, iterations: [] }, new Date(0))).toContain("pending");
  });
});
