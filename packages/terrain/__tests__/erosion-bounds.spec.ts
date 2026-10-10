import { describe, expect, it, vi } from "vitest";
import { hydraulic, thermal } from "../src/core/erosion.js";

// Count every seeded draw, so a test can measure the actual droplet work instead of trusting a
// completion-only assertion that an uncapped default would also satisfy.
const drawn = vi.hoisted(() => ({ count: 0 }));

vi.mock("../src/core/math.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/math.js")>();
  return {
    ...actual,
    random: (seed: number) => {
      const rnd = actual.random(seed);
      return () => {
        drawn.count += 1;
        return rnd();
      };
    },
  };
});

describe("erosion grid and parameter bounds validation", () => {
  it("thermal erosion rejects n < 2, fractional or non-finite grid resolution", () => {
    const h = new Float32Array(4);
    expect(() => thermal(new Float32Array(1), 1, 10)).toThrow(RangeError);
    expect(() => thermal(h, -1, 10)).toThrow(RangeError);
    expect(() => thermal(h, 2.5, 10)).toThrow(RangeError);
    expect(() => thermal(h, Number.NaN, 10)).toThrow(RangeError);
    expect(() => thermal(h, Number.POSITIVE_INFINITY, 10)).toThrow(RangeError);
  });

  it("thermal erosion rejects out-of-bound, fractional or non-finite iterations", () => {
    const h4 = new Float32Array(4);
    expect(() => thermal(h4, 2, 10, { iterations: -1 })).toThrow(RangeError);
    expect(() => thermal(h4, 2, 10, { iterations: 201 })).toThrow(RangeError);
    expect(() => thermal(h4, 2, 10, { iterations: 1.5 })).toThrow(RangeError);
    expect(() => thermal(h4, 2, 10, { iterations: Number.NaN })).toThrow(RangeError);
    expect(() => thermal(h4, 2, 10, { iterations: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("thermal erosion preserves no-op zero and boundary 200 iterations", () => {
    const h4 = new Float32Array([1, 2, 3, 4]);
    const zero = thermal(h4, 2, 10, { iterations: 0 });
    expect(zero).toEqual(h4);
    expect(() => thermal(h4, 2, 10, { iterations: 200 })).not.toThrow();
  });

  it("hydraulic erosion rejects n < 2, fractional or non-finite grid resolution", () => {
    const h = new Float32Array(4);
    expect(() => hydraulic(new Float32Array(1), 1, 10)).toThrow(RangeError);
    expect(() => hydraulic(h, -1, 10)).toThrow(RangeError);
    expect(() => hydraulic(h, 2.5, 10)).toThrow(RangeError);
    expect(() => hydraulic(h, Number.NaN, 10)).toThrow(RangeError);
    expect(() => hydraulic(h, Number.POSITIVE_INFINITY, 10)).toThrow(RangeError);
  });

  it("hydraulic erosion rejects out-of-bound, fractional or non-finite droplets and steps", () => {
    const h4 = new Float32Array(4);
    expect(() => hydraulic(h4, 2, 10, { droplets: -1 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { droplets: 1.5 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { droplets: Number.NaN })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { droplets: Number.POSITIVE_INFINITY })).toThrow(RangeError);

    expect(() => hydraulic(h4, 2, 10, { maxSteps: 0 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { maxSteps: 129 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { maxSteps: 1.5 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { maxSteps: Number.NaN })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { maxSteps: Number.POSITIVE_INFINITY })).toThrow(RangeError);
  });

  it("hydraulic erosion supports no-op zero droplets and boundary 128 maxSteps", () => {
    const h4 = new Float32Array([1, 2, 3, 4]);
    const zero = hydraulic(h4, 2, 10, { droplets: 0 });
    expect(zero).toEqual(h4);
    expect(() => hydraulic(h4, 2, 10, { droplets: 1, maxSteps: 128 })).not.toThrow();
  });

  it("hydraulic erosion accepts large supported grid defaults (513 and 1025)", () => {
    const flat513 = new Float32Array(513 * 513);
    expect(() => hydraulic(flat513, 513, 512, { maxSteps: 1 })).not.toThrow();

    const flat1025 = new Float32Array(1025 * 1025);
    expect(() => hydraulic(flat1025, 1025, 512, { maxSteps: 1 })).not.toThrow();
  });

  it("rejects an explicit droplet count above the recipe limit, accepts the limit itself", () => {
    const h4 = new Float32Array(4);
    expect(() => hydraulic(h4, 2, 10, { droplets: 200_001 })).toThrow(RangeError);
    expect(() => hydraulic(h4, 2, 10, { droplets: 200_000, maxSteps: 1 })).not.toThrow();
    expect(() => hydraulic(h4, 2, 10, { droplets: Number.MAX_SAFE_INTEGER + 1 })).toThrow(
      RangeError,
    );
  });

  it("bounds the automatic droplet default with an exact work count on an oversized grid", () => {
    // The default is one droplet per cell, capped at the largest supported grid (1025 x 1025).
    // An uncapped n*n default would run one droplet per cell of the 2048² field, about four times
    // the capped work; counting seeded draws compares the two, so removing the cap turns this red.
    drawn.count = 0;
    hydraulic(new Float32Array(1025 * 1025), 1025, 512, { maxSteps: 1 });
    const capped = drawn.count;
    drawn.count = 0;
    hydraulic(new Float32Array(2048 * 2048), 2048, 512, { maxSteps: 1 });
    expect(drawn.count).toBe(capped);
    expect(capped).toBe(3 * 1025 * 1025);
  });
});
