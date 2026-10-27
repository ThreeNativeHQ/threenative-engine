import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import { contrastRatio } from "../src/evaluators/hud-audit.js";
import type { IPlaytestReport } from "../src/report.js";
import { validatePlaytestScenario } from "../src/scenario.js";

type Rgba = [number, number, number, number];
const item = (text: string, color: Rgba = [255, 255, 255, 1], background: Rgba = [10, 10, 12, 1]) => ({
  background,
  color,
  fontSizePx: 14,
  selector: "div.hud",
  text,
});

function evaluate(items: ReturnType<typeof item>[] | undefined, hudAudit: Record<string, unknown> = { minContrast: 3, noDebugText: true }) {
  const scenario = validatePlaytestScenario(
    { assert: { hudAudit }, name: "hud", schemaVersion: 1, steps: [{ kind: "wait", release: true, waitTicks: 10 }], subject: "player" },
    "hud.json",
  );
  const report: IPlaytestReport = {
    diagnostics: [],
    distance: 0,
    entity: "player",
    expectMoved: false,
    frames: 10,
    observations: { console: [], hud: {}, network: [], resources: {}, ...(items === undefined ? {} : { hudAudit: { items } }) },
    trivialityOptOuts: [],
  };
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  return { assertions, codes: diagnostics.map(({ code }) => code) };
}

describe("contrastRatio", () => {
  it("is 21 for black on white, 1 for equal colours, and composites a translucent foreground", () => {
    expect(contrastRatio([0, 0, 0, 1], [255, 255, 255, 1])).toBeCloseTo(21, 1);
    expect(contrastRatio([40, 40, 40, 1], [40, 40, 40, 1])).toBeCloseTo(1, 5);
    expect(contrastRatio([255, 255, 255, 0.5], [0, 0, 0, 1])).toBeLessThan(contrastRatio([255, 255, 255, 1], [0, 0, 0, 1]));
  });
});

describe("hudAudit", () => {
  it("passes a HUD of readable player-facing text", () => {
    const { assertions } = evaluate([item("Room 2 / 3"), item("Defeated 4"), item("Health 82 / 100")]);
    expect(assertions.filter(({ id }) => id.startsWith("hudAudit")).every(({ pass }) => pass)).toBe(true);
    expect(assertions.some(({ id }) => id === "hudAudit.debugText")).toBe(true);
    expect(assertions.some(({ id }) => id === "hudAudit.contrast")).toBe(true);
  });

  it.each(["wall ray blocked", "debug: fps 12", "TODO real copy", "score undefined", "NaN / 100", "[object Object]", "placeholder text"])(
    "fails developer text: %s",
    (text) => {
      const { assertions, codes } = evaluate([item("Room 1 / 3"), item(text)]);
      expect(assertions.find(({ id }) => id === "hudAudit.debugText")?.pass).toBe(false);
      expect(codes).toContain("TN_PLAYTEST_HUD_DEBUG_TEXT");
    },
  );

  it("fails text whose colour is close to its backing colour", () => {
    const { assertions, codes } = evaluate([item("82 / 100", [60, 120, 200, 1], [50, 110, 190, 1])]);
    expect(assertions.find(({ id }) => id === "hudAudit.contrast")?.pass).toBe(false);
    expect(codes).toContain("TN_PLAYTEST_HUD_CONTRAST");
  });

  it("does not judge text drawn straight on the canvas, and says how many it skipped", () => {
    const { assertions } = evaluate([item("Score 3", [255, 255, 255, 1], [0, 0, 0, 0]), item("Room 1", [255, 255, 255, 1], [0, 0, 0, 0.2])]);
    const contrast = assertions.find(({ id }) => id === "hudAudit.contrast");
    expect(contrast?.pass).toBe(true);
    expect((contrast?.details as { unjudged: number }).unjudged).toBe(2);
  });

  it("fails closed when the page reported no text at all or no observation", () => {
    expect(evaluate([]).assertions.find(({ id }) => id.startsWith("hudAudit"))?.pass).toBe(false);
    expect(evaluate(undefined).codes).toContain("TN_PLAYTEST_HUD_AUDIT_UNOBSERVED");
  });

  it("checks only what the scenario asks for", () => {
    const { assertions } = evaluate([item("wall ray blocked")], { minContrast: 3 });
    expect(assertions.some(({ id }) => id === "hudAudit.debugText")).toBe(false);
  });

  it("rejects an empty assertion, noDebugText false and a contrast outside 1..21", () => {
    const bad = (hudAudit: unknown) => () =>
      validatePlaytestScenario({ assert: { hudAudit }, name: "s", schemaVersion: 1, steps: [{ kind: "wait", release: true, waitTicks: 1 }] }, "s.json");
    expect(bad({})).toThrow();
    expect(bad({ noDebugText: false })).toThrow();
    expect(bad({ minContrast: 0.5 })).toThrow();
    expect(bad({ minContrast: 30 })).toThrow();
  });
});
