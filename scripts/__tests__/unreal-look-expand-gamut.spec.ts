import { describe, expect, it } from "vitest";
import {
  EXPAND_AP1,
  FILMIC_CURVE,
  expandAmount,
  expandGamutLinear,
  filmicToneMap,
  redModifierWeight,
} from "../unreal-look/scaffold/render/tonemap.js";

// Unreal 5.8.3 L1 frames (fixed exposure, Box_Red): the scene-linear EXR pixel and the 8-bit PNG pixel of the
// same texel (tools/unreal-reference/captures/unreal/L1, sun60 exterior). Unreal takes the EXR after its Expand
// Gamut step (PostProcessCombineLUTs.usf runs the expansion before the no-tone-curve output), so the curve maps
// an EXR pixel to the PNG pixel with the expansion off. The earlier fit of the amount on these pairs found 0 for
// that reason, and it turned the default off; the expansion belongs on the scene colour the engine draws.
const RED_BOX = [
  { linear: [3.578, 0.116, 0.274], png: [255, 168, 164] },
  { linear: [1.526, 0.105, 0.142], png: [250, 120, 114] },
] as const;
const srgb8 = (v: number): number =>
  255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
const showsAs = (linear: readonly [number, number, number], expandGamut: number) =>
  filmicToneMap([...linear], 1, { ...FILMIC_CURVE, expandGamut }).map(srgb8);

// The colorimetry of the expansion matrix, derived from the published chromaticities (CIE xy).
type Matrix = number[][];
type Chromaticity = readonly [number, number];
const times = (a: Matrix, b: Matrix): Matrix =>
  a.map((row) => [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * (b[k]?.[j] ?? 0), 0)));
function inverse(m: Matrix): Matrix {
  const [[a = 0, b = 0, c = 0], [d = 0, e = 0, f = 0], [g = 0, h = 0, i = 0]] = m as [
    number[],
    number[],
    number[],
  ];
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}
const xyz = ([x, y]: Chromaticity): number[] => [x / y, 1, (1 - x - y) / y];
/** RGB -> XYZ of three primaries and a white point. */
function rgbToXyz(red: Chromaticity, green: Chromaticity, blue: Chromaticity, white: Chromaticity) {
  const [r, g, b] = [red, green, blue].map(xyz) as [number[], number[], number[]];
  const primaries = [0, 1, 2].map((i) => [r[i] ?? 0, g[i] ?? 0, b[i] ?? 0]);
  const weights = times(
    inverse(primaries),
    xyz(white).map((v) => [v]),
  );
  return primaries.map((row) => row.map((v, j) => v * (weights[j]?.[0] ?? 0)));
}
/** Bradford chromatic adaptation between two white points. */
function adapt(from: Chromaticity, to: Chromaticity): Matrix {
  const bradford = [
    [0.8951, 0.2664, -0.1614],
    [-0.7502, 1.7135, 0.0367],
    [0.0389, -0.0685, 1.0296],
  ];
  const source = times(
    bradford,
    xyz(from).map((v) => [v]),
  );
  const target = times(
    bradford,
    xyz(to).map((v) => [v]),
  );
  const scale = [0, 1, 2].map((i) =>
    [0, 1, 2].map((j) => (i === j ? (target[i]?.[0] ?? 0) / (source[i]?.[0] ?? 1) : 0)),
  );
  return times(inverse(bradford), times(scale, bradford));
}

describe("Unreal's gamut expansion in the harness tone curve (PRD-632)", () => {
  it("is on by default, as in a fresh Unreal project (Scene.cpp:437)", () => {
    expect(FILMIC_CURVE.expandGamut).toBe(1);
  });

  it("expands with the sRGB gamut re-expressed in the wide primaries, AP1 to AP1", () => {
    const d65: Chromaticity = [0.3127, 0.329];
    const d60: Chromaticity = [0.32168, 0.33767];
    const srgb = rgbToXyz([0.64, 0.33], [0.3, 0.6], [0.15, 0.06], d65);
    const ap1 = rgbToXyz([0.713, 0.293], [0.165, 0.83], [0.128, 0.044], d60);
    const wide = rgbToXyz([0.6965, 0.3065], [0.245, 0.718], [0.1302, 0.0456], d65);
    // AP1 -> sRGB (D60 to D65), then the sRGB numbers read as wide-gamut numbers and carried into AP1.
    const ap1ToSrgb = times(inverse(srgb), times(adapt(d60, d65), ap1));
    const expected = times(times(inverse(ap1), wide), ap1ToSrgb);
    EXPAND_AP1.forEach((value, index) =>
      expect(value, `element ${index}`).toBeCloseTo(
        expected[Math.floor(index / 3)]?.[index % 3] ?? Number.NaN,
        6,
      ),
    );
  });

  it("blends by (1 - 2^(-4 d)) x (1 - 2^(-4 gamut luma^2)): none for grey, black or gamut 0", () => {
    expect(expandAmount(0, 2, 1)).toBe(0);
    expect(expandAmount(0.5, 0, 1)).toBe(0);
    expect(expandAmount(0.5, 1, 0)).toBe(0);
    expect(expandAmount(0.5, 1, 1)).toBeCloseTo(0.75 * 0.9375, 10);
    expect(expandAmount(0.25, 0.5, 1)).toBeCloseTo(0.25, 10);
    expect(expandAmount(0.5, 1, 0.5)).toBeCloseTo(0.75 * 0.75, 10);
  });

  it("expands before the blue correction and the curve", () => {
    const sky = [0.3521, 0.6163, 1.0911] as const;
    const early = filmicToneMap([...sky]);
    const late = filmicToneMap(expandGamutLinear([...sky]), 1, { ...FILMIC_CURVE, expandGamut: 0 });
    early.forEach((v, c) => expect(v).toBeCloseTo(late[c] ?? Number.NaN, 9));
  });

  it("maps a saturated red box of an Unreal EXR to the Unreal pixel within 6 levels, expansion off", () => {
    for (const { linear, png } of RED_BOX)
      for (const [c, level] of showsAs(linear, 0).entries())
        expect(Math.abs(level - (png[c] as number))).toBeLessThan(6);
  });

  it("expands an Unreal EXR a second time and misses the pixel: the EXR is already expanded", () => {
    const worst = Math.max(
      ...RED_BOX.flatMap(({ linear, png }) =>
        showsAs(linear, 1).map((level, c) => Math.abs(level - (png[c] as number))),
      ),
    );
    expect(worst).toBeGreaterThan(6);
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

  it("pulls the red of a bright clear sky down toward the wide gamut", () => {
    const sky = [0.3521, 0.6163, 1.0911] as const;
    expect(showsAs(sky, 1)[0] as number).toBeLessThan(showsAs(sky, 0)[0] as number);
  });

  it("maps the Unreal red box within 1.1 levels with the red modifier and 3 to 5 levels off without it", () => {
    const worst = (curve: object) =>
      Math.max(
        ...RED_BOX.flatMap(({ linear, png }) =>
          filmicToneMap([...linear], 1, { ...FILMIC_CURVE, expandGamut: 0, ...curve })
            .map(srgb8)
            .map((level, c) => Math.abs(level - (png[c] as number))),
        ),
      );
    expect(worst({})).toBeLessThan(1.1);
    expect(worst({ glow: 0, redModifier: 0 })).toBeGreaterThan(4.5);
  });
});

describe("the ACES red modifier and glow in the harness tone curve (PRD-632)", () => {
  it("are on by default, as in Unreal's film tone map", () => {
    expect(FILMIC_CURVE.glow).toBe(1);
    expect(FILMIC_CURVE.redModifier).toBe(1);
  });

  it("weights the red modifier by smoothstep(1 - |2 hue / 135 deg|) squared", () => {
    const rad = (degrees: number) => (degrees * Math.PI) / 180;
    expect(redModifierWeight(0)).toBe(1);
    expect(redModifierWeight(rad(33.75))).toBeCloseTo(0.25, 10);
    expect(redModifierWeight(rad(-33.75))).toBeCloseTo(0.25, 10);
    expect(redModifierWeight(rad(67.5))).toBe(0);
    expect(redModifierWeight(rad(120))).toBe(0);
  });

  it("leaves a grey alone and a green or blue untouched by the red modifier", () => {
    const off = { ...FILMIC_CURVE, glow: 0, redModifier: 0 };
    filmicToneMap([0.2, 0.2, 0.2]).forEach((v, c) =>
      expect(v).toBeCloseTo(filmicToneMap([0.2, 0.2, 0.2], 1, off)[c] ?? Number.NaN, 9),
    );
    const green = filmicToneMap([0.05, 0.8, 0.1], 1, { ...FILMIC_CURVE, glow: 0 });
    const greenOff = filmicToneMap([0.05, 0.8, 0.1], 1, off);
    green.forEach((v, c) => expect(v).toBeCloseTo(greenOff[c] ?? Number.NaN, 9));
  });

  it("pulls the red of a saturated red down and lifts a dark saturated colour", () => {
    const off = { ...FILMIC_CURVE, glow: 0, redModifier: 0 };
    expect(filmicToneMap([0.4, 0.05, 0.05])[0] as number).toBeLessThan(
      filmicToneMap([0.4, 0.05, 0.05], 1, off)[0] as number,
    );
    const dark = filmicToneMap([0.02, 0.003, 0.003], 1, { ...FILMIC_CURVE, redModifier: 0 });
    const darkOff = filmicToneMap([0.02, 0.003, 0.003], 1, off);
    expect(dark[0] as number).toBeGreaterThan(darkOff[0] as number);
  });
});
