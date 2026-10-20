import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";
import { filmicToneMap as oldToneMap } from "../templates/starter/src/render/tonemap.js";

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
const { BLUE_CORRECTION_AP1, BLUE_CORRECTION_INVERSE_AP1, FILMIC_CURVE, filmicToneMap } =
  (await import(
    /* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
  )) as typeof import("../../../scripts/unreal-look/scaffold/render/tonemap.js");

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
    for (const [a, b] of [
      [BLUE_CORRECTION_AP1, BLUE_CORRECTION_INVERSE_AP1],
      [BLUE_CORRECTION_INVERSE_AP1, BLUE_CORRECTION_AP1],
    ]) {
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < 3; col++) {
          const value =
            a[row * 3] * b[col] + a[row * 3 + 1] * b[col + 3] + a[row * 3 + 2] * b[col + 6];
          expect(Math.abs(value - Number(row === col))).toBeLessThan(1e-6);
        }
      }
    }
  });

  it("reproduces the original curve exactly at amount zero", () => {
    const samples: RGB[] = [
      [0, 0, 0],
      [0.18, 0.18, 0.18],
      [0.05, 0.1, 2],
      [4, 0.2, 0.01],
      [-1, 0.2, 10],
      [100, 100, 100],
    ];
    for (const rgb of samples) {
      for (const exposure of [0, 0.5, 1, 4]) {
        expect(filmicToneMap(rgb, exposure, { ...FILMIC_CURVE, blueCorrection: 0 })).toEqual(
          oldToneMap(rgb, exposure),
        );
      }
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
