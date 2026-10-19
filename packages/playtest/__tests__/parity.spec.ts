import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { makeTempDir } from "../../../test-support/temp-dir.js";

import { evaluateRichPlaytestAssertions } from "../src/assertion-evaluators.js";
import { loadPlaytestScenario, validatePlaytestScenario } from "../src/scenario.js";
import type { IPlaytestReport } from "../src/report.js";

/**
 * PRD-222 Phase 1, ledger row 2: `assert.parity` — two runs, one ratio, one verdict.
 *
 * The negative control the PRD names is the red-first one: two runs from different devices must
 * refuse by name, because "a parity run whose two halves were not taken on the same device … is
 * not a parity run and must be discarded". These tests drive the evaluator through the public
 * evaluation entry with report fixtures, the same shape the deviceMetrics specs use.
 */

function series(fps: number, count = 20, withRenderPhase = true): unknown[] {
  const frameMs = 1_000 / fps;
  return Array.from({ length: count }, () => ({
    ...(withRenderPhase ? { phases: { render: frameMs * 0.6 } } : {}),
    frameMs,
  }));
}

function scenarioWith(parity: unknown): unknown {
  return {
    assert: { parity },
    name: "parity",
    schemaVersion: 1,
    steps: [{ waitTicks: 4 }],
    target: "web",
  };
}

function reportWith(overrides: {
  fps?: number;
  renderPhase?: boolean;
  serial?: string;
  thermallyConfounded?: boolean;
}): IPlaytestReport {
  return {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectAxis: undefined,
    expectMoved: false,
    frames: 300,
    observations: {
      console: [],
      deviceMetrics: {
        available: true,
        errors: [],
        samples: [],
        ...(overrides.serial === undefined ? {} : { serial: overrides.serial }),
        source: "test",
        verdict: {
          endTemperatureC: 30,
          endThermalStatus: 0,
          reasons: [],
          startTemperatureC: 30,
          startThermalStatus: 0,
          temperatureRiseC: 0,
          thermallyConfounded: overrides.thermallyConfounded ?? false,
        },
      },
      performanceSeries: series(overrides.fps ?? 60, 20, overrides.renderPhase ?? true),
      runtimeTrace: { recentRuntimeErrors: [] },
      network: [],
    },
    pass: true,
    trivialityOptOuts: [],
  } as unknown as IPlaytestReport;
}

function hydratedScenario(parity: Record<string, unknown>): ReturnType<typeof validatePlaytestScenario> {
  const reference = {
    fps: 60,
    renderP95: 10,
    serial: "pixel-8",
    thermallyConfounded: false,
  };
  return validatePlaytestScenario(
    scenarioWith({ ...parity, reference: parity.reference ?? reference }),
    "s.playtest.json",
    "/tmp/s.playtest.json",
  );
}

describe("assert.parity at load", () => {
  it("rejects an empty parity assertion at load", () => {
    expect(() => validatePlaytestScenario(scenarioWith({}), "s.playtest.json", "/tmp/s.playtest.json")).toThrow(
      /parity/u,
    );
  });

  it("rejects a parity assertion without a reference report path", () => {
    expect(() =>
      validatePlaytestScenario(scenarioWith({ minFpsRatio: 0.85 }), "s.playtest.json", "/tmp/s.playtest.json"),
    ).toThrow(/referenceReport/u);
  });

  it("rejects a wrong-typed minFpsRatio", () => {
    expect(() =>
      validatePlaytestScenario(
        scenarioWith({ minFpsRatio: "high", referenceReport: "native.json" }),
        "s.playtest.json",
        "/tmp/s.playtest.json",
      ),
    ).toThrow(/minFpsRatio/u);
  });

  it("rejects an unknown key instead of dropping it", () => {
    expect(() =>
      validatePlaytestScenario(
        scenarioWith({ minFpsRatio: 0.85, referenceReport: "native.json", side: "native" }),
        "s.playtest.json",
        "/tmp/s.playtest.json",
      ),
    ).toThrow(/side/u);
  });

  it("accepts the documented shape and requires the reference side", () => {
    const scenario = validatePlaytestScenario(
      scenarioWith({ minFpsRatio: 0.85, referenceReport: "native.json", referenceSide: "native" }),
      "s.playtest.json",
      "/tmp/s.playtest.json",
    );
    expect(scenario.assert?.parity).toMatchObject({
      minFpsRatio: 0.85,
      referenceReport: "native.json",
      referenceSide: "native",
    });
  });
});

describe("assert.parity reference hydration", () => {
  it("extracts fps, serial and the thermal verdict from the saved report at load", async () => {
    const dir = await makeTempDir("parity-reference");
    const reference = {
      observations: {
        deviceMetrics: { errors: [], samples: [], serial: "pixel-8", source: "test", verdict: { thermallyConfounded: false } },
        performanceSeries: series(59.5),
      },
    };
    await writeFile(join(dir, "native.json"), JSON.stringify(reference));
    await writeFile(
      join(dir, "s.playtest.json"),
      JSON.stringify(scenarioWith({ minFpsRatio: 0.85, referenceReport: "native.json", referenceSide: "native" })),
    );
    const scenario = await loadPlaytestScenario(dir, "s.playtest.json");
    expect(scenario.assert?.parity?.reference).toMatchObject({ fps: expect.closeTo(59.5, 1), serial: "pixel-8" });
  });

  it("fails the load when the reference file is unreadable, naming the file", async () => {
    const dir = await makeTempDir("parity-missing");
    await writeFile(
      join(dir, "s.playtest.json"),
      JSON.stringify(scenarioWith({ minFpsRatio: 0.85, referenceReport: "missing.json", referenceSide: "native" })),
    );
    await expect(loadPlaytestScenario(dir, "s.playtest.json")).rejects.toThrow(/missing\.json/u);
  });

  it("fails the load when the reference report carries no measurable series", async () => {
    const dir = await makeTempDir("parity-empty-series");
    await writeFile(join(dir, "native.json"), JSON.stringify({ observations: { performanceSeries: [] } }));
    await writeFile(
      join(dir, "s.playtest.json"),
      JSON.stringify(scenarioWith({ minFpsRatio: 0.85, referenceReport: "native.json", referenceSide: "native" })),
    );
    await expect(loadPlaytestScenario(dir, "s.playtest.json")).rejects.toThrow(/no valid frame-time samples/u);
  });

  it("fails the load instead of dropping a malformed reference sample", async () => {
    const dir = await makeTempDir("parity-malformed-series");
    await writeFile(
      join(dir, "native.json"),
      JSON.stringify({ observations: { performanceSeries: [...series(60, 2), { frameMs: "fast" }] } }),
    );
    await writeFile(
      join(dir, "s.playtest.json"),
      JSON.stringify(scenarioWith({ minFpsRatio: 0.85, referenceReport: "native.json", referenceSide: "native" })),
    );
    await expect(loadPlaytestScenario(dir, "s.playtest.json")).rejects.toThrow(/malformed frame-time sample/u);
  });
});

describe("assert.parity evaluation", () => {
  const assertion = { minFpsRatio: 0.85, referenceReport: "native.json", referenceSide: "native" as const };

  it("refuses two runs from different devices by name — the PRD's negative control", () => {
    const scenario = hydratedScenario({ ...assertion });
    const report = reportWith({ fps: 60, serial: "other-phone" });
    const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    const verdict = assertions.find(({ id }) => id === "parity.sameDevice");
    expect(verdict?.pass).toBe(false);
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_DEVICE_MISMATCH");
    // The ratio is still reported: the verdict withdraws comparability, never the measurement.
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.details).toMatchObject({ ratio: expect.closeTo(1, 5) });
  });

  it("refuses when device identity cannot be proven on either side", () => {
    const scenario = hydratedScenario({ ...assertion, reference: { fps: 60, renderP95: 10, thermallyConfounded: false } });
    const report = reportWith({ fps: 60 });
    const { diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_DEVICE_UNPROVABLE");
  });

  it("refuses a pair either half of which is thermally confounded, still reporting the ratio", () => {
    const scenario = hydratedScenario({
      ...assertion,
      reference: { fps: 60, renderP95: 10, serial: "pixel-8", thermallyConfounded: true },
    });
    const report = reportWith({ fps: 58, serial: "pixel-8" });
    const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_THERMALLY_CONFOUNDED");
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.details).toMatchObject({ ratio: expect.closeTo(60 / 58, 2) });
  });

  it("passes at or above the floor and records the directed native ÷ web ratio", () => {
    const scenario = hydratedScenario({ ...assertion });
    const report = reportWith({ fps: 58, serial: "pixel-8" });
    const { assertions } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.pass).toBe(true);
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.details).toMatchObject({
      ratio: expect.closeTo(60 / 58, 2),
    });
  });

  it("fails below the floor naming the observed ratio", () => {
    // This run is the browser half at 60 fps; the native reference managed 30. native ÷ web = 0.5.
    const scenario = hydratedScenario({ ...assertion, reference: { fps: 30, renderP95: 10, serial: "pixel-8", thermallyConfounded: false } });
    const report = reportWith({ fps: 60, serial: "pixel-8" });
    const { diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_BELOW_FLOOR");
  });

  it("uses the same fps as the minFps path for an even-length series", () => {
    const samples = [10, 20, 10, 20].map((frameMs) => ({ frameMs, phases: { render: frameMs * 0.6 } }));
    const scenario = validatePlaytestScenario(
      {
        assert: {
          parity: { minFpsRatio: 0.99, referenceReport: "native.json", referenceSide: "browser", reference: { fps: 100, renderP95: 10, serial: "pixel-8", thermallyConfounded: false } },
          performance: { minFps: 99 },
        },
        name: "parity",
        schemaVersion: 1,
        steps: [{ waitTicks: 4 }],
        target: "web",
      },
      "s.playtest.json",
      "/tmp/s.playtest.json",
    );
    const report = reportWith({ fps: 60, serial: "pixel-8" });
    (report.observations as { performanceSeries?: unknown }).performanceSeries = samples;
    const { assertions } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(assertions.find(({ id }) => id === "performance.minFps")?.pass).toBe(true);
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.pass).toBe(true);
  });

  it("records a ratio above 1.0 rather than clamping it", () => {
    // This run is the native half at 30 fps; the browser reference managed 15. native ÷ web = 2.
    const scenario = hydratedScenario({ ...assertion, referenceSide: "browser", reference: { fps: 15, renderP95: 10, serial: "pixel-8", thermallyConfounded: false } });
    const report = reportWith({ fps: 30, serial: "pixel-8" });
    const { assertions } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(assertions.find(({ id }) => id === "parity.fpsRatio")?.details).toMatchObject({
      ratio: expect.closeTo(2, 2),
    });
  });

  it("fails closed when this run produced no performance series", () => {
    const scenario = hydratedScenario({ ...assertion });
    const report = reportWith({ serial: "pixel-8" });
    (report.observations as { performanceSeries?: unknown }).performanceSeries = [];
    const { diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_SERIES_MISSING");
  });

  it("fails closed instead of dropping a malformed current-run sample", () => {
    const scenario = hydratedScenario({ ...assertion });
    const report = reportWith({ fps: 60, serial: "pixel-8" });
    report.observations?.performanceSeries?.push({ frameMs: Number.NaN } as never);
    const { diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_SERIES_MALFORMED");
  });

  it("fails closed when either thermal verdict is absent", () => {
    const scenario = hydratedScenario({
      ...assertion,
      reference: { fps: 60, renderP95: 10, serial: "pixel-8" },
    });
    const report = reportWith({ fps: 60, serial: "pixel-8" });
    const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(assertions.find(({ id }) => id === "parity.thermalComparability")?.pass).toBe(false);
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_THERMAL_UNPROVABLE");
  });

  it("binds the optional render-parity floor and fails closed on a missing phase split", () => {
    const scenario = hydratedScenario({ ...assertion, minRenderParity: 0.8 });
    const report = reportWith({ fps: 60, serial: "pixel-8", renderPhase: false });
    const { diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
    expect(diagnostics.map(({ code }) => code)).toContain("TN_PLAYTEST_PARITY_RENDER_UNMEASURED");
  });
});
