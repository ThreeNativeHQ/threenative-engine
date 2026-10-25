import { describe, expect, it } from "vitest";
import { localExposureSizes } from "../src/look/local-exposure.js";

describe("local exposure pass sizes", () => {
  it("blurs the luminance at a sixteenth of the view, as Unreal's downsample chain mip 4 does", () => {
    const sizes = localExposureSizes(1920, 1080);
    expect(sizes.half).toEqual([960, 540]);
    expect(sizes.blur).toEqual([120, 68]);
    expect(sizes.cells).toEqual([15, 9]);
    // A 50% kernel is a quarter of the width as a radius: 30 of the 120 texels.
    expect(sizes.blurRadius).toBe(30);
  });

  it("caps the radius at the 31 taps the unrolled loop holds and keeps one texel on a tiny buffer", () => {
    expect(localExposureSizes(3840, 2160).blurRadius).toBe(31);
    const tiny = localExposureSizes(1, 1);
    expect(tiny.blur).toEqual([1, 1]);
    expect(tiny.blurRadius).toBeGreaterThan(0);
  });

  // 2560x1440 on an RTX 2080: one fragment per grid texel looping over its whole 64x64 cell cost 1.3 ms of GPU.
  // 1920x1080 on Iris Xe: one row-sum texel per bin read the cell row's 64 logs once for each of the 32 bins,
  // 17.7M taps and 1.25 ms of GPU. Four logs a texel and two bins a texel read each log 16 times, 2.2M taps.
  it("sums the bilateral grid by rows first, two bins of one half resolution cell row per texel", () => {
    const sizes = localExposureSizes(2560, 1440);
    expect(sizes.cells).toEqual([20, 12]);
    expect(sizes.rows).toEqual([20 * 16, 12 * 64]);
    expect(sizes.grid).toEqual([20 * 32, 12]);
  });

  it("packs four neighbouring half resolution logs of a row into each log texel", () => {
    expect(localExposureSizes(1920, 1080).log).toEqual([240, 540]);
    // A half width that is not a multiple of four keeps its last logs in a partly used texel.
    expect(localExposureSizes(1922, 1080).log).toEqual([241, 540]);
  });
});
