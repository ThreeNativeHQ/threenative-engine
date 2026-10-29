import { describe, expect, it } from "vitest";

import { perfWarnings } from "../src/evaluators/perf-warnings.js";
import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";

const projection = (report: Record<string, unknown>) => `TN_RENDER_PROJECTION:${JSON.stringify(report)}`;
const WARNING = 'TN_SCENE_WARNING:{"window":3,"gpuShare":0.1,"dominantTerm":"drawCalls"}';

describe("perf warnings read off the console", () => {
  it("flags every TN_SCENE_WARNING line with its text", () => {
    expect(perfWarnings(["ready", `[info] ${WARNING}`])).toEqual([WARNING]);
  });

  it("flags a TN_BRIDGE_WARNING line, a property read again and again in one frame", () => {
    const bridge = 'TN_BRIDGE_WARNING:{"window":2,"top":[{"name":"get DirectionalLight.intensity","caller":"validateControls"}]}';
    expect(perfWarnings([`[warning] ${bridge}`])).toEqual([bridge]);
  });

  it("flags a hot callback, including an unreadable warning, while ranked debug reports remain diagnostic", () => {
    const hot = 'TN_HOT_CALL:{"system":"scene.update","share":0.8}';
    const malformed = "TN_HOT_CALL:{unreadable";
    expect(perfWarnings([
      'TN_DEBUG_REPORT:{"window":1,"offenders":[{"name":"sceneUpdateMs","share":0.8}]}',
      `[warning] ${hot}`,
      malformed,
    ])).toEqual([hot, malformed]);
  });

  it("flags a projection decline and prints its cause and hint", () => {
    const line = projection({ projecting: false, reasonCode: "notWorthwhile", sourceRenderables: 40, cause: { code: "uniqueGeometry", hint: "share one geometry", meshes: 3 } });
    const [found] = perfWarnings([line]);
    expect(found).toContain("notWorthwhile");
    expect(found).toContain("[cause uniqueGeometry: share one geometry]");
  });

  it("passes a projecting scene, the game's renderer.projection: false opt-out and the below-the-floor verdict", () => {
    expect(perfWarnings([
      projection({ projecting: true, reasonCode: "projected", sourceRenderables: 40 }),
      projection({ projecting: false, reasonCode: "disabled", sourceRenderables: 40 }),
      projection({ projecting: false, reasonCode: "belowMeshFloor", sourceRenderables: 0 }),
      projection({ projecting: false, reasonCode: "belowMeshFloor", sourceRenderables: 85 }),
    ])).toEqual([]);
  });

  it("flags a render hook that blocks projection, and an unreadable projection line", () => {
    expect(perfWarnings([projection({ projecting: false, reasonCode: "renderHook", sourceRenderables: 3 })])).toHaveLength(1);
    expect(perfWarnings(['TN_RENDER_PROJECTION:{"projecting":fal'])[0]).toContain("unreadable");
  });
});

describe("a run with a perf warning does not pass", () => {
  function run(lines: string[], diagnostics: unknown = { runtimeReady: false }) {
    const scenario = validatePlaytestScenario(
      { assert: { diagnostics }, name: "warn", schemaVersion: 1, steps: [{ release: true, waitFrames: 2 }] },
      "warn.json",
    );
    const report: IPlaytestReport = {
      diagnostics: [],
      distance: 0,
      entity: "",
      expectMoved: false,
      frames: 2,
      observations: { console: lines.map((text) => ({ text, type: "info" })), hud: {}, network: [], resources: {} },
      trivialityOptOuts: [],
    };
    const { assertions, diagnostics: found } = evaluateRichPlaytestAssertions({ report, scenario });
    return { codes: found.map(({ code }) => code), row: assertions.find(({ id }) => id === "diagnostics") };
  }

  it("fails the diagnostics row with the marker text", () => {
    const { codes, row } = run([WARNING]);
    expect(row?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_PERF_WARNING");
    expect((row?.details as { perfWarnings: string[] }).perfWarnings).toEqual([WARNING]);
  });

  it("fails a declined projection even when console errors are opted out", () => {
    const decline = projection({ projecting: false, reasonCode: "notWorthwhile", sourceRenderables: 40 });
    const { codes } = run([decline], { consoleErrorsOptOutReason: "fixture", noConsoleErrors: false });
    expect(codes).toContain("TN_PLAYTEST_PERF_WARNING");
  });

  it("passes a clean console", () => {
    expect(run(["hello"]).row?.pass).toBe(true);
  });

  it("fails a hot callback even with console errors opted out, but passes an informational debug report", () => {
    expect(run(['TN_HOT_CALL:{"share":0.8}'], { consoleErrorsOptOutReason: "fixture", noConsoleErrors: false }).codes)
      .toContain("TN_PLAYTEST_PERF_WARNING");
    expect(run(['TN_DEBUG_REPORT:{"window":1,"findings":[]}']).row?.pass).toBe(true);
  });
});
