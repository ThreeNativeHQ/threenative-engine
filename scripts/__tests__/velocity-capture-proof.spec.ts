import { readFileSync } from "node:fs";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import {
  measureMovingColourFootprint,
  summarizeCoveredVelocity,
  summarizeVelocityPixels,
} from "../../examples/abyss-framework/src/render/velocityReadback.js";
import { assertVelocityCaptureDiagnostics } from "../velocity-capture-proof.js";

describe("real velocity capture proof", () => {
  it("measures separate static and moving halves from rendered RGBA pixels", () => {
    const data = new Float32Array(4 * 2 * 4);
    data[2 * 4] = 0.05;
    data[6 * 4 + 1] = -0.025;
    expect(summarizeVelocityPixels(data, 4, 2)).toEqual({
      staticMax: 0,
      stationaryMax: 0,
      movingMax: 0.05000000074505806,
      movingPixels: 2,
    });
  });
  it("rejects missing, nonfinite and wrongly shaped GPU readbacks", () => {
    expect(() => summarizeVelocityPixels(new Float32Array(), 4, 2)).toThrow(/RGBA/);
    expect(() => summarizeVelocityPixels(new Float32Array(32).fill(Number.NaN), 4, 2)).toThrow(
      /finite/,
    );
    expect(() => summarizeVelocityPixels(new Float32Array(32), 0, 2)).toThrow(/dimensions/);
  });
  it("does not mistake a static scene for moving output", () => {
    expect(summarizeVelocityPixels(new Float32Array(32), 4, 2)).toEqual({
      staticMax: 0,
      stationaryMax: 0,
      movingMax: 0,
      movingPixels: 0,
    });
  });
  it("measures the current colour footprint from actual moving-half pixels", () => {
    const pixels = new Float32Array(4 * 2 * 4);
    for (const pixel of [0, 2, 3]) {
      pixels[pixel * 4] = 0.01;
      pixels[pixel * 4 + 2] = 0.3;
    }
    expect(measureMovingColourFootprint(pixels, 4, 2)).toEqual({ pixels: 2, centroidX: 3 });
    expect(() => measureMovingColourFootprint(new Float32Array(32), 4, 2)).toThrow(/footprint/);
    expect(() => measureMovingColourFootprint(new Float32Array(32).fill(Number.NaN), 4, 2)).toThrow(
      /finite/,
    );
  });

  it("detects velocity on the static wall outside the moving geometry's bounds", () => {
    const data = new Float32Array(4 * 2 * 4);
    data[2 * 4] = 0.05;
    data[3 * 4] = 0.025;
    const measured = summarizeVelocityPixels(data, 4, 2, { left: 2, right: 3, top: 0, bottom: 2 });
    expect(measured.staticMax).toBe(0);
    expect(measured.stationaryMax).toBeCloseTo(0.025);
  });

  it("checks each moving colour pixel and the exposed wall inside its bounding rectangle", () => {
    const colour = new Float32Array(4 * 2 * 4);
    const velocity = new Float32Array(colour.length);
    const coverage = new Float32Array(colour.length);
    for (const pixel of [2, 6]) {
      colour[pixel * 4 + 2] = 0.3;
      coverage[pixel * 4] = 1;
      velocity[pixel * 4] = 0.05;
    }
    const clean = summarizeCoveredVelocity(velocity, colour, 4, 2, 0.05, coverage);
    expect(clean.footprintPixels).toBe(2);
    expect(clean.outsideFootprintMax).toBe(0);
    expect(clean.footprintMaxErrorPixels).toBeLessThan(1e-6);
    // Pixel 3 is wall inside the former conservative right-half rectangle.
    velocity[3 * 4] = 0.025;
    expect(
      summarizeCoveredVelocity(velocity, colour, 4, 2, 0.05, coverage).outsideFootprintMax,
    ).toBeCloseTo(0.025);
  });

  it("rejects a wrong edge velocity even when a centre sample would be correct", () => {
    const colour = new Float32Array(4 * 2 * 4);
    const velocity = new Float32Array(colour.length);
    const coverage = new Float32Array(colour.length);
    for (const pixel of [2, 3, 6]) {
      colour[pixel * 4 + 2] = 0.3;
      coverage[pixel * 4] = 1;
      velocity[pixel * 4] = 0.05;
    }
    velocity[3 * 4] = -0.05;
    expect(
      summarizeCoveredVelocity(velocity, colour, 4, 2, 0.05, coverage).footprintMaxErrorPixels,
    ).toBeCloseTo(0.2);
  });

  it("includes actual captured dark sphere pixels independently of their shading", () => {
    const colour = new Float32Array(4 * 2 * 4);
    const velocity = new Float32Array(colour.length);
    const coverage = new Float32Array(colour.length);
    const captured = PNG.sync.read(
      readFileSync(
        new URL("../../docs/verification/prd269/skinned-37006604512.png", import.meta.url),
      ),
    );
    const offset = (325 * captured.width + 344) * 4;
    const rgba = captured.data.subarray(offset, offset + 4);
    expect(Array.from(rgba)).toEqual([14, 46, 81, 255]);
    // The stored actual screenshot, converted from sRGB to linear.
    const linear = (value: number) => ((value / 255 + 0.055) / 1.055) ** 2.4;
    colour.set([...Array.from(rgba.subarray(0, 3), linear), 1], 2 * 4);
    // Independent fixture lighting probe at normal (0,-.9,.43589).
    colour.set([0.00366, 0.02233, 0.06924, 1], 3 * 4);
    for (const pixel of [2, 3]) {
      coverage[pixel * 4] = 1;
      velocity[pixel * 4] = -0.13333334;
    }
    const measured = summarizeCoveredVelocity(velocity, colour, 4, 2, -0.13333334, coverage);
    expect(measured.footprintPixels).toBe(2);
    expect(measured.darkFootprintPixels).toBe(2);
    expect(measured.outsideFootprintMax).toBe(0);
    expect(measured.footprintMaxErrorPixels).toBeLessThan(1e-6);
  });

  it("fails closed on missing masks and non-finite colour, velocity or expected motion", () => {
    const colour = new Float32Array(4 * 2 * 4);
    const velocity = new Float32Array(colour.length);
    const coverage = new Float32Array(colour.length);
    expect(() => summarizeCoveredVelocity(velocity, colour, 4, 2, 0, coverage)).toThrow(
      /footprint/,
    );
    colour[2 * 4 + 2] = 0.3;
    coverage[2 * 4] = 1;
    expect(() => summarizeCoveredVelocity(velocity, colour.subarray(4), 4, 2, 0, coverage)).toThrow(
      /RGBA/,
    );
    expect(() => summarizeCoveredVelocity(velocity, colour, 4, 2, Number.NaN, coverage)).toThrow(
      /finite/,
    );
    colour[1] = Number.NaN;
    expect(() => summarizeCoveredVelocity(velocity, colour, 4, 2, 0, coverage)).toThrow(/finite/);
    colour[1] = 0;
    velocity[0] = Number.NaN;
    expect(() => summarizeCoveredVelocity(velocity, colour, 4, 2, 0, coverage)).toThrow(/finite/);
  });

  it("rejects missing, fractional and non-finite coverage attachment values", () => {
    const pixels = new Float32Array(32);
    const coverage = new Float32Array(32);
    expect(() => summarizeCoveredVelocity(pixels, pixels, 4, 2, 0, coverage.subarray(4))).toThrow(
      /RGBA/,
    );
    coverage[8] = 0.5;
    expect(() => summarizeCoveredVelocity(pixels, pixels, 4, 2, 0, coverage)).toThrow(/binary/);
    coverage[8] = Number.NaN;
    expect(() => summarizeCoveredVelocity(pixels, pixels, 4, 2, 0, coverage)).toThrow(/finite/);
  });

  it("rejects device loss even when the software runner downgraded it", () => {
    expect(() =>
      assertVelocityCaptureDiagnostics(
        [{ code: "TN_PLAYTEST_SOFTWARE_DEVICE_LOST", severity: "warning", message: "lost" }],
        false,
      ),
    ).toThrow(/DEVICE_LOST/);
  });
  it("allows only the expected mutation assertion error", () => {
    expect(() =>
      assertVelocityCaptureDiagnostics(
        [
          {
            code: "TN_PLAYTEST_RESOURCE_ASSERTION_FAILED",
            severity: "error",
            message: "no motion",
          },
        ],
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertVelocityCaptureDiagnostics(
        [{ code: "TN_PLAYTEST_CONSOLE_ERROR", severity: "error", message: "compile" }],
        true,
      ),
    ).toThrow(/CONSOLE_ERROR/);
  });
});
