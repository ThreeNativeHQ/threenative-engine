import { describe, expect, it } from "vitest";
import {
  linearFrame,
  measureBlueProfile,
  measureCausalReveal,
  measureSequence,
} from "../temporal-aa-quality.js";

const image = (width: number, height: number, colour: (x: number, y: number) => number[]) => ({
  width,
  height,
  data: Uint8Array.from(
    Array.from({ length: width * height }, (_, i) => [
      ...colour(i % width, Math.floor(i / width)),
      255,
    ]).flat(),
  ),
});

describe("temporal sequence measurements", () => {
  it("reports signed column coverage without clamping dark deficits or changing RGB integration", () => {
    const frame = {
      width: 4,
      height: 2,
      rgb: Float64Array.from([
        0, 0, 0.5, 0, 0, 0.25, 0, 0, 0.75, 0, 0, 0, 0, 0, 0.5, 0, 0, 0.5, 0, 0, 1, 0, 0, 0,
      ]),
    };
    expect(measureBlueProfile(frame, { x: 1, y: 0, width: 2, height: 2 }, 0.5)).toEqual({
      columnMeans: [0.375, 0.875],
      backgroundBlue: 0.5,
      integratedContrast: 0.25,
    });
    expect(() => measureBlueProfile(frame, { x: 3, y: 0, width: 2, height: 2 }, 0.5)).toThrow(
      /bounds/,
    );
    expect(() => measureBlueProfile(frame, { x: 0, y: 0, width: 0, height: 2 }, 0.5)).toThrow(
      /bounds/,
    );
  });
  it("integrates the supersampled reference in linear light rather than averaging encoded sRGB", () => {
    const result = linearFrame(
      image(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255])),
      1,
      1,
    );
    expect([...result.rgb]).toEqual([0.5, 0.5, 0.5]);
  });

  it("rejects incompatible raster dimensions and incomplete sequences", () => {
    expect(() =>
      linearFrame(
        image(3, 2, () => [0, 0, 0]),
        2,
        2,
      ),
    ).toThrow(/integer/);
    expect(() => measureSequence([], [], 2)).toThrow(/sequence/);
  });

  const reference = Array.from({ length: 6 }, (_, frame) =>
    linearFrame(
      image(24, 16, (x, y) => {
        if (x >= 3 && x < 13 && y >= 3 && y < 13) return frame < 3 ? [255, 0, 0] : [0, 0, 255];
        return x < 17 + (frame % 2) ? [0, 0, 0] : [255, 255, 255];
      }),
      24,
      16,
    ),
  );

  it("subtracts true scene movement: an exact moving reference has zero residual instability", () => {
    const result = measureSequence(reference, reference, 3);
    expect(result.edgeError).toBe(0);
    expect(result.residualInstability).toBe(0);
    expect(result.reveal.map((frame) => frame.staleFraction)).toEqual([0, 0, 0]);
    expect(result.revealedPixels).toBeGreaterThan(0);
  });

  it("detects frozen history on newly revealed pixels and distinguishes it from a correct frame", () => {
    const frozen = reference.map((frame, index) =>
      index < 3 ? frame : (reference[2] as typeof frame),
    );
    const result = measureSequence(reference, frozen, 3);
    expect(result.reveal.every((frame) => frame.staleFraction > 0.99)).toBe(true);
    expect(result.reveal.every((frame) => frame.meanAbsoluteError > 0.6)).toBe(true);
  });

  it("detects neighbourhood overshoot without mistaking display quantization for ringing", () => {
    expect(measureSequence(reference, reference, 3).neighbourhoodOvershootFraction).toBe(0);
    const quantized = reference.map((frame) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (value) => Math.min(1, value + 0.004)),
    }));
    expect(measureSequence(reference, quantized, 3).neighbourhoodOvershootFraction).toBe(0);
    const halo = reference.map((frame) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (value) => Math.min(1, value + 0.1)),
    }));
    expect(measureSequence(reference, halo, 3).neighbourhoodOvershootFraction).toBeGreaterThan(0.5);
  });

  it("detects alternating edge errors even when their signed mean cancels", () => {
    const bad = reference.map((frame, index) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (value) => value + (index % 2 ? 0.1 : -0.1)),
    }));
    const result = measureSequence(reference, bad, 3);
    expect(result.edgeError).toBeCloseTo(0.1);
    expect(result.residualInstability).toBeCloseTo(0.2);
  });

  it("separates neutral brightness errors from causal red history in matched open controls", () => {
    const open = reference.map((frame) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (_, i) => [0.2, 0.3, 0.5][i % 3] ?? 0),
    }));
    for (const delta of [-0.1, 0.1]) {
      const neutral = open.map((frame) => ({
        ...frame,
        rgb: Float64Array.from(frame.rgb, (value) => value + delta),
      }));
      const result = measureCausalReveal(reference, neutral, open, 3);
      expect(result).toHaveLength(3);
      expect(result.every((frame) => frame.redTintFraction === 0)).toBe(true);
      expect(result.every((frame) => frame.meanAbsoluteDifference > 0.09)).toBe(true);
    }
    const redHistory = open.map((frame) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (value, i) => value * 0.75 + (i % 3 === 0 ? 0.25 : 0)),
    }));
    const result = measureCausalReveal(reference, redHistory, open, 3);
    expect(result).toHaveLength(3);
    expect(result.every((frame) => frame.redTintFraction === 1)).toBe(true);
    for (const frame of result) expect(frame.meanRedHistoryWeight).toBeCloseTo(0.25);
  });

  it("retains the original projection-score ambiguity while the causal control rejects dark-blue undercoverage as red history", () => {
    const dark = reference.map((frame) => ({
      ...frame,
      rgb: Float64Array.from(frame.rgb, (value) => value * 0.25),
    }));
    expect(
      measureSequence(reference, dark, 3).reveal.every((frame) => frame.staleFraction === 1),
    ).toBe(true);
    expect(
      measureCausalReveal(reference, dark, reference, 3).every(
        (frame) => frame.redTintFraction === 0,
      ),
    ).toBe(true);
  });
});
