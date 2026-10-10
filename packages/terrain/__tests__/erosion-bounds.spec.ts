import { describe, expect, it } from "vitest";
import { hydraulic, thermal } from "../src/core/erosion.js";

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
});
