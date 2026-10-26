import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";

import { evaluateRichPlaytestAssertions } from "../src/index.js";
import type { IPlaytestReport } from "../src/report.js";
import { screenshotObservations } from "../src/runner/steps.js";
import { validatePlaytestScenario } from "../src/scenario.js";

const SIZE = 128;

/** Seeded flat-shaded rectangles with hard edges: what an in-focus low-poly frame is to a Laplacian. */
function frame(blurRadius: number): Buffer {
  let state = 9;
  const random = (limit: number): number => {
    state = (state * 1103515245 + 12345) >>> 0;
    return (state >>> 8) % limit;
  };
  const noise = new Array<number>(SIZE * SIZE).fill(128);
  for (let rect = 0; rect < 40; rect += 1) {
    const [x, y, w, h, value] = [random(SIZE), random(SIZE), 4 + random(36), 4 + random(36), random(256)];
    for (let row = y; row < Math.min(SIZE, y + h); row += 1) noise.fill(value, row * SIZE + x, row * SIZE + Math.min(SIZE, x + w));
  }
  const blurred = noise.map((_, index) => {
    const x = index % SIZE;
    const y = Math.floor(index / SIZE);
    let sum = 0;
    let count = 0;
    for (let dy = -blurRadius; dy <= blurRadius; dy += 1) {
      for (let dx = -blurRadius; dx <= blurRadius; dx += 1) {
        const sx = Math.min(SIZE - 1, Math.max(0, x + dx));
        const sy = Math.min(SIZE - 1, Math.max(0, y + dy));
        sum += noise[sy * SIZE + sx]!;
        count += 1;
      }
    }
    return sum / count;
  });
  const png = new PNG({ height: SIZE, width: SIZE });
  blurred.forEach((value, index) => {
    png.data.set([value, value, value, 255], index * 4);
  });
  return PNG.sync.write(png);
}

const raw = (region: Record<string, unknown>) => ({
  assert: { visual: [{ region }] },
  name: "sharpness",
  schemaVersion: 1,
  steps: [{ release: true, waitFrames: 2 }],
});
const REGION = { height: SIZE, minSharpness: 0.3, width: SIZE, x: 0, y: 0 };

function evaluate(png: Buffer) {
  const scenario = validatePlaytestScenario(raw(REGION), "sharpness.json");
  const visual = screenshotObservations(undefined, png, scenario);
  const report: IPlaytestReport = {
    diagnostics: [],
    distance: 0,
    entity: "",
    expectMoved: false,
    frames: 2,
    observations: { console: [], hud: {}, network: [], resources: {}, visual },
    trivialityOptOuts: [],
  };
  const { assertions, diagnostics } = evaluateRichPlaytestAssertions({ report, scenario });
  return { codes: diagnostics.map(({ code }) => code), result: assertions.find(({ id }) => id === "visual.0.region.sharpness") };
}

describe("visual region sharpness", () => {
  it("passes a detailed frame", () => {
    const { codes, result } = evaluate(frame(0));
    expect(result?.pass).toBe(true);
    expect(codes).not.toContain("TN_PLAYTEST_REGION_BLURRED");
  });

  it("fails the same frame smeared by a 3x3 box blur", () => {
    const { codes, result } = evaluate(frame(1));
    expect(result?.pass).toBe(false);
    expect((result?.details as { observed: number }).observed).toBeLessThan(0.3);
    expect(codes).toContain("TN_PLAYTEST_REGION_BLURRED");
  });

  it.each([
    [{ ...REGION, minSharpness: 0 }, /minSharpness/u],
    [{ ...REGION, minSharpness: "sharp" }, /minSharpness/u],
    [{ element: { id: "hud" }, minSharpness: 10 }, /minSharpness/u],
  ])("throws at load on %o", (region, message) => {
    expect(() => validatePlaytestScenario(raw(region), "sharpness.json")).toThrow(message);
  });
});
