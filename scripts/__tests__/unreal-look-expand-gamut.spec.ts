import { describe, expect, it } from "vitest";
import {
  FILMIC_CURVE,
  expandGamutLinear,
  filmicToneMap,
} from "../unreal-look/scaffold/render/tonemap.js";

// Unreal 5.8.3 L2 frame (sky, no clouds, mean over image rows 20-180) against the harness atmosphere
// at the same sun, both scene-linear sRGB. Before the gamut expansion the harness sky carried 27%
// too much red at the 60 degree sun and 7% at 15 degrees.
const SKY = [
  { sun: 60, unreal: [0.2785, 0.6237, 1.1483], harness: [0.3521, 0.6163, 1.0911] },
  { sun: 15, unreal: [0.2675, 0.4422, 0.6653], harness: [0.2862, 0.4467, 0.6766] },
] as const;

describe("Unreal's gamut expansion in the harness tone curve (PRD-633)", () => {
  it("is on by default, as in a fresh Unreal project", () => {
    expect(FILMIC_CURVE.expandGamut).toBe(1);
  });

  it("leaves greys and dark colour alone", () => {
    for (const v of [0.01, 0.18, 1, 4]) {
      const [r, g, b] = expandGamutLinear([v, v, v]);
      expect(r).toBeCloseTo(v, 3);
      expect(g).toBeCloseTo(v, 3);
      expect(b).toBeCloseTo(v, 3);
    }
    const dark = expandGamutLinear([0.001, 0.002, 0.004]);
    expect(dark[2] / 0.004).toBeCloseTo(1, 1);
  });

  it("brings the harness sky onto the Unreal sky, red first", () => {
    for (const { sun, unreal, harness } of SKY) {
      const raw = harness.map((v, i) => v / (unreal[i] as number));
      const expanded = expandGamutLinear([...harness]).map((v, i) => v / (unreal[i] as number));
      // Red was the worst channel; the expansion cuts its error by more than half.
      expect(Math.abs((expanded[0] as number) - 1)).toBeLessThan(
        Math.abs((raw[0] as number) - 1) / 2,
      );
      for (const ratio of expanded) expect(Math.abs(ratio - 1), `sun ${sun}`).toBeLessThan(0.05);
    }
  });

  it("a gamut of 0 switches it off", () => {
    const sky = [0.3521, 0.6163, 1.0911] as const;
    const off = filmicToneMap(sky, 1, { ...FILMIC_CURVE, expandGamut: 0 });
    const on = filmicToneMap(sky);
    expect(on[0]).toBeLessThan(off[0]);
  });
});
