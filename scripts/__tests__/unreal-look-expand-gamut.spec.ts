import { describe, expect, it } from "vitest";
import {
  FILMIC_CURVE,
  expandGamutLinear,
  filmicToneMap,
} from "../unreal-look/scaffold/render/tonemap.js";

// Unreal 5.8.3 L1 frames (fixed exposure, Box_Red): the scene-linear EXR pixel and the 8-bit PNG pixel of the
// same texel (tools/unreal-reference/captures/unreal/L1, sun60 exterior). A fresh Unreal frame shows no gamut
// expansion: a per-pixel fit of the amount over 354 L1 and L2 samples gave 0 (PRD-632 box result).
const RED_BOX = [
  { linear: [3.578, 0.116, 0.274], png: [255, 168, 164] },
  { linear: [1.526, 0.105, 0.142], png: [250, 120, 114] },
] as const;
const srgb8 = (v: number): number =>
  255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

describe("Unreal's gamut expansion in the harness tone curve (PRD-632)", () => {
  it("is off by default, because a fresh Unreal frame carries none", () => {
    expect(FILMIC_CURVE.expandGamut).toBe(0);
  });

  it("maps a saturated red box to the Unreal pixel within 6 levels", () => {
    for (const { linear, png } of RED_BOX) {
      const out = filmicToneMap([...linear]).map(srgb8);
      for (const [c, level] of out.entries())
        expect(Math.abs(level - (png[c] as number))).toBeLessThan(6);
    }
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

  it("a gamut of 1 is the named override and pulls red toward the wide gamut", () => {
    const sky = [0.3521, 0.6163, 1.0911] as const;
    const off = filmicToneMap(sky, 1, { ...FILMIC_CURVE, expandGamut: 0 });
    const on = filmicToneMap(sky, 1, { ...FILMIC_CURVE, expandGamut: 1 });
    expect(on[0]).toBeLessThan(off[0]);
  });
});
