import { describe, expect, it } from "vitest";
import { UnrealBloomNode } from "../../packages/core/src/look/unreal-bloom.js";
import { fitBloom, gaussianInner, stockSigmas, unrealStages } from "../unreal-look/bloom-fit.js";

describe("bloom fit", () => {
  it("recovers the weights of a target built from the stock mips themselves", () => {
    const sigmas = stockSigmas();
    const target = sigmas.map((sigma, i) => ({ sigma, weight: [0.1, 0, 0.3, 0.05, 0.2][i] ?? 0 }));
    const fit = fitBloom(sigmas, target);
    expect(fit.residual).toBeLessThan(1e-3);
    expect(fit.weights.map((w) => Number(w.toFixed(3)))).toEqual([0.1, 0, 0.3, 0.05, 0.2]);
  });

  it("cannot place a Gaussian finer than the finest stock mip", () => {
    const fit = fitBloom(stockSigmas(), [{ sigma: 1, weight: 1 }]);
    expect(fit.residual).toBeGreaterThan(0.9);
  });

  it("scores a weighting that cannot be negative as no better than leaving the bloom out", () => {
    const fit = fitBloom([10], [{ sigma: 10, weight: -1 }]);
    expect(fit.weights).toEqual([0]);
    expect(fit.residual).toBeCloseTo(1, 6);
  });

  it("measures the Gaussian overlap in closed form", () => {
    expect(gaussianInner(1, 1)).toBeCloseTo(1 / (4 * Math.PI), 12);
  });

  it("fails closed on an empty target", () => {
    expect(() => fitBloom(stockSigmas(), [])).toThrow(/BLOOM_FIT_EMPTY/u);
  });

  // The decision this script supports: stock BloomNode cannot reach Unreal's bloom, so the template ships its own node.
  it("finds that no weighting of the five stock mips reaches Unreal's bloom at 720p or 1080p", () => {
    for (const width of [1280, 1920]) {
      const fit = fitBloom(stockSigmas(), unrealStages(width));
      expect(fit.residual).toBeGreaterThan(0.5);
    }
  });

  it("uses the same stage radii as the shipped node", () => {
    for (const [width, height] of [
      [1280, 720],
      [1920, 1080],
    ] as const) {
      const sigmas = UnrealBloomNode.schedule(width, height)
        .map((stage) => (stage.radius / Math.sqrt(2 * 16.7)) * 2 ** stage.level)
        .sort((a, b) => a - b);
      expect(
        unrealStages(width)
          .map((g) => g.sigma)
          .sort((a, b) => a - b),
      ).toEqual(sigmas);
    }
  });
});
