import { describe, expect, it } from "vitest";
import {
  ev100FromCamera,
  ev100FromExposure,
  ev100FromLuminance,
  exposureFromEv100,
} from "../src/render/exposure-units.js";

describe("exposure units", () => {
  it("round-trips EV100 and the renderer multiplier", () => {
    for (const ev of [-10, -1, 0, 1, 9.9, 15, 20]) {
      expect(ev100FromExposure(exposureFromEv100(ev))).toBeCloseTo(ev, 12);
    }
  });

  it("converts the defaults as stated", () => {
    // EV100 0 saturates at 1.2 cd/m²; each stop halves the multiplier.
    expect(exposureFromEv100(0)).toBeCloseTo(1 / 1.2, 12);
    expect(exposureFromEv100(1) / exposureFromEv100(0)).toBeCloseTo(0.5, 12);
    // Unreal's physical-camera defaults: f/4, 1/60 s, ISO 100.
    expect(ev100FromCamera(4, 1 / 60, 100)).toBeCloseTo(Math.log2(960), 12);
    expect(ev100FromCamera(4, 1 / 60, 200)).toBeCloseTo(Math.log2(960) - 1, 12);
    // A meter calibrated with K = 12.5 reads 12.5 cd/m² as EV100 = log2(100) at ISO 100.
    expect(ev100FromLuminance(12.5)).toBeCloseTo(Math.log2(100), 12);
  });

  it("refuses values that have no exposure", () => {
    expect(() => exposureFromEv100(Number.NaN)).toThrow(RangeError);
    expect(() => ev100FromExposure(0)).toThrow(RangeError);
    expect(() => ev100FromCamera(0, 1 / 60, 100)).toThrow(/aperture/);
    expect(() => ev100FromLuminance(-1)).toThrow(RangeError);
  });
});
