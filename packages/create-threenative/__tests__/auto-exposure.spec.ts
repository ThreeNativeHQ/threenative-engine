import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  exposureReductionSizes,
  exposureSettings,
  validateExposureSettings,
} from "../template-assets/exposure.js";
import {
  histogramCases,
  referenceClippedMean,
} from "./fixtures/auto-exposure/histogramReference.js";
import { exposurePixels } from "./fixtures/auto-exposure/native-contract.js";

describe("authored exposure controls", () => {
  it("is opt-in and supplies validated asymmetric game-authored rates", () => {
    expect(exposureSettings.enabled).toBe(false);
    expect(exposureSettings.rateDown).toBeGreaterThan(exposureSettings.rateUp);
    expect(() => validateExposureSettings(exposureSettings)).not.toThrow();
  });
  it.each([
    { key: 0 },
    { key: undefined },
    { rateUp: -1 },
    { rateDown: Number.NaN },
    { snapLo: -1 },
    { snapHi: 0 },
    { snapGain: 2 },
    { minStops: 20 },
    { maxStops: Number.POSITIVE_INFINITY },
    { maxStops: 130 },
    { settleStops: -1 },
    { reportInterval: 0 },
    { maxDelta: 0 },
    { initialExposure: 0 },
    { enabled: "yes" },
    { lowPercent: -1 },
    { highPercent: 101 },
    { lowPercent: 60, highPercent: 60 },
    { lowPercent: 90, highPercent: 10 },
    { lowPercent: undefined },
  ])("rejects malformed policy %j", (bad) => {
    expect(() => validateExposureSettings({ ...exposureSettings, ...bad } as never)).toThrow(
      /exposure/i,
    );
  });
});

describe("clipped histogram reference", () => {
  const byName = (name: string) => {
    const found = histogramCases.find((item) => item.name === name);
    if (found === undefined) throw new Error(`missing case ${name}`);
    return referenceClippedMean(found.bins, found.lowPercent, found.highPercent);
  };
  it("keeps one bin's mean and ignores both tails", () => {
    expect(byName("one-bin")).toEqual({ logMean: -3, kept: 4 });
    expect(byName("bright-tail-clipped").logMean).toBeCloseTo(-4, 12);
    expect(byName("dark-tail-clipped").logMean).toBeCloseTo(-1, 12);
  });
  it("averages a uniform spread symmetrically and keeps everything with no clip", () => {
    expect(byName("uniform-spread").logMean).toBeCloseTo(-0.125, 12);
    expect(byName("no-clip").kept).toBe(8);
  });
  it("keeps no weight for an empty histogram or low == high", () => {
    expect(byName("empty").kept).toBe(0);
    expect(byName("low-equals-high").kept).toBe(0);
  });
  it("splits a bin at the percentile mark", () => {
    // 34 weight: drop 6.8 from the first bin (7), keep 0.2 of it, all of 11 and 13, then 3 of 3 up to 27.2.
    const { kept } = byName("clip-splits-bins");
    expect(kept).toBeCloseTo(27.2 - 6.8, 12);
  });
  it("stays inside the authored default clip", () => {
    expect(exposureSettings.lowPercent).toBe(10);
    expect(exposureSettings.highPercent).toBe(90);
  });
  it("meters the odd native fixture against the clipped reference", () => {
    const { pixels, expectedLuminance } = exposurePixels(65, 33);
    const bins = Array.from({ length: 3 }, () => ({ weight: 0, logSum: 0 }));
    for (let y = 0; y < 33; y++) {
      for (let x = 0; x < 65; x++) {
        const log = Math.log2(pixels[(y * 65 + x) * 4] ?? Number.NaN);
        const bin = bins[log];
        if (bin === undefined) throw new Error("Unexpected native fixture luminance");
        const weight = 1 + (y + 0.5) / 33;
        bin.weight += weight;
        bin.logSum += weight * log;
      }
    }
    // The tails begin at x=64/y=32, on 16x16 reduction boundaries; no block mixes values.
    const { logMean, kept } = referenceClippedMean(
      bins,
      exposureSettings.lowPercent,
      exposureSettings.highPercent,
    );
    expect(kept).toBeCloseTo(65 * 33 * 1.5 * 0.8, 10);
    expect(logMean).toBeCloseTo(1, 12);
    expect(expectedLuminance).toBeCloseTo(2 ** logMean, 12);
    expect(Math.log2(exposureSettings.key / expectedLuminance)).toBeCloseTo(-3.473931188, 8);
  });
});

describe("meter reduction topology", () => {
  it("reduces odd and skinny buffers without discarding partial edge blocks", () => {
    expect(exposureReductionSizes(17, 5)).toEqual([
      [5, 2],
      [2, 1],
      [1, 1],
    ]);
    expect(exposureReductionSizes(1, 1025)).toEqual([
      [1, 257],
      [1, 65],
      [1, 17],
      [1, 5],
      [1, 2],
      [1, 1],
    ]);
    expect(exposureReductionSizes(1, 1)).toEqual([[1, 1]]);
    expect(exposureReductionSizes(1920, 1080).at(-1)).toEqual([1, 1]);
  });
  it.each([
    [0, 1],
    [1, -1],
    [1.5, 2],
    [Number.NaN, 1],
    [1, Number.POSITIVE_INFINITY],
  ])("rejects an invalid buffer %s x %s", (width, height) => {
    expect(() => exposureReductionSizes(width, height)).toThrow(/drawing buffer/i);
  });
});

describe("framework exposure ownership boundary", () => {
  it("keeps exposure policy, metric and adaptation out of core package source", () => {
    const root = path.resolve("packages/core/src");
    const files = readdirSync(root, { recursive: true, encoding: "utf8" }).filter((file) =>
      /\.tsx?$/u.test(file),
    );
    expect(files.length).toBeGreaterThan(0);
    const appearance =
      /AutoExposureNode|exposureSettings|exposureMeter|exposureLuminance|\bsnap(?:Gain|Lo|Hi)\b/u;
    for (const file of files) {
      expect(file).not.toMatch(/auto[-_]?exposure/i);
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toMatch(appearance);
    }
    const authored = readFileSync(
      "packages/create-threenative/template-assets/exposure.ts",
      "utf8",
    );
    expect(authored).toMatch(/export const exposureSettings/);
    expect(authored).toMatch(/export function exposureMeter/);
    expect(authored).not.toContain("@threenative/");
  });
});
