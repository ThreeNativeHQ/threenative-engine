import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

// The overlay has no node_modules; bundle its real dependencies from this package.
const require = createRequire(import.meta.url);
const bundled = buildSync({
  entryPoints: [
    new URL("../../../scripts/unreal-look/scaffold/render/tonemap.ts", import.meta.url).pathname,
  ],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  alias: {
    three: require.resolve("three"),
    "three/tsl": require.resolve("three/tsl"),
    "three/webgpu": require.resolve("three/webgpu"),
  },
});
// The overlay imports `three`, which does not resolve from `scripts/` under this package's
// typecheck, so the spec names the slice of its surface it uses.
interface IOverlayTonemap {
  BLUE_CORRECTION_AP1: readonly number[];
  BLUE_CORRECTION_INVERSE_AP1: readonly number[];
  FILMIC_CURVE: Readonly<Record<string, number>>;
  filmicToneMap(
    rgb: readonly [number, number, number],
    exposure?: number,
    curve?: Readonly<Record<string, number>>,
  ): [number, number, number];
}
const { BLUE_CORRECTION_AP1, BLUE_CORRECTION_INVERSE_AP1, FILMIC_CURVE, filmicToneMap } =
  (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0]?.text ?? "").toString("base64")}`
  )) as IOverlayTonemap;

type RGB = readonly [number, number, number];

// Opponent-plane hue in linear sRGB, in radians; neutral grey has no defined hue.
const hue = ([r, g, b]: RGB): number => Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b);
const hueDistance = (a: number, b: number): number =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

describe("filmic blue correction", () => {
  it("preserves neutral grey within 1e-4", () => {
    for (const amount of [0, 0.6, 1]) {
      for (const grey of [0, 0.01, 0.18, 1, 10]) {
        const rgb = filmicToneMap([grey, grey, grey], 1, {
          ...FILMIC_CURVE,
          blueCorrection: amount,
        });
        expect(Math.max(...rgb) - Math.min(...rgb)).toBeLessThan(1e-4);
      }
    }
  });

  it("multiplies the full forward and inverse matrices to identity within 1e-6", () => {
    const pairs: [readonly number[], readonly number[]][] = [
      [BLUE_CORRECTION_AP1, BLUE_CORRECTION_INVERSE_AP1],
      [BLUE_CORRECTION_INVERSE_AP1, BLUE_CORRECTION_AP1],
    ];
    for (const [a, b] of pairs) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const at = (m: readonly number[], i: number) => m[i] ?? Number.NaN;
          const value =
            at(a, row * 3) * at(b, col) +
            at(a, row * 3 + 1) * at(b, col + 3) +
            at(a, row * 3 + 2) * at(b, col + 6);
          expect(Math.abs(value - Number(row === col))).toBeLessThan(1e-6);
        }
      }
    }
  });

  // The template's curve before blue correction, gamut expansion, glow and red modifier, sampled from its committed JS
  // reference (create-threenative template-assets/tonemap.ts, 2026-10-19), which templates no longer ship.
  it("reproduces the original curve exactly at amount zero", () => {
    const golden: [RGB, number, RGB][] = [
      [[0, 0, 0], 0, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[0, 0, 0], 0.5, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[0, 0, 0], 1, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[0, 0, 0], 4, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [
        [0.18, 0.18, 0.18],
        0,
        [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17],
      ],
      [[0.18, 0.18, 0.18], 0.5, [0.06436295532334203, 0.06436295533931564, 0.06436295532780827]],
      [[0.18, 0.18, 0.18], 1, [0.17999999998818922, 0.18000000002667968, 0.17999999999895114]],
      [[0.18, 0.18, 0.18], 4, [0.6343760069341132, 0.6343760069804, 0.6343760069470551]],
      [[0.05, 0.1, 2], 0, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[0.05, 0.1, 2], 0.5, [0.01785377942269306, 0.03053872572413366, 0.7285769563101647]],
      [[0.05, 0.1, 2], 1, [0.13045391093003428, 0.09874668725827795, 0.8888986074440806]],
      [[0.05, 0.1, 2], 4, [0.6174112663967206, 0.5099209416850439, 1]],
      [[4, 0.2, 0.01], 0, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[4, 0.2, 0.01], 0.5, [1, 0.21393273733340168, 0.029354409682996796]],
      [[4, 0.2, 0.01], 1, [1, 0.47175353962203864, 0.10840211379269117]],
      [[4, 0.2, 0.01], 4, [1, 0.8443435320614302, 0.5540066663531966]],
      [[-1, 0.2, 10], 0, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[-1, 0.2, 10], 0.5, [0.3345860181139731, 0.14607725490802323, 1]],
      [[-1, 0.2, 10], 1, [0.6119666888236183, 0.3573313108173949, 1]],
      [[-1, 0.2, 10], 4, [0.9107478109456297, 0.7815295834819882, 1]],
      [[100, 100, 100], 0, [4.279741339410783e-17, 4.279741339410783e-17, 4.279741339410782e-17]],
      [[100, 100, 100], 0.5, [1, 1, 1]],
      [[100, 100, 100], 1, [1, 1, 1]],
      [[100, 100, 100], 4, [1, 1, 1]],
    ];
    for (const [rgb, exposure, expected] of golden) {
      const actual = filmicToneMap(rgb, exposure, {
        ...FILMIC_CURVE,
        blueCorrection: 0,
        expandGamut: 0,
        glow: 0,
        redModifier: 0,
      });
      actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i] ?? Number.NaN, 12));
    }
  });

  // Unreal's blue correction exists to stop bright blues drifting toward purple (magenta, hue
  // -PI/3 on this wheel). Without it the curve pulls this blue toward magenta; with it, it must not.
  it("stops bright saturated blue drifting toward purple at amount 0.6", () => {
    const input: RGB = [0.05, 0.1, 2];
    const magenta = -Math.PI / 3;
    const toMagenta = (rgb: RGB) => hueDistance(hue(rgb), magenta);
    const uncorrected = filmicToneMap(input, 1, { ...FILMIC_CURVE, blueCorrection: 0 });
    const corrected = filmicToneMap(input);
    expect(toMagenta(uncorrected)).toBeLessThan(toMagenta(input));
    expect(toMagenta(corrected)).toBeGreaterThanOrEqual(toMagenta(input));
  });
});
