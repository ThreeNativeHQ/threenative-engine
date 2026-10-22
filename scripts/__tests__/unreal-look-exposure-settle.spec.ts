import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_TOLERANCE_STOPS,
  type IExposureObservation,
  exposureSettled,
  metersExposure,
  parseExposure,
  waitForExposure,
} from "../unreal-look/exposure-settle.js";

const line = (o: object) => `TN_AUTO_EXPOSURE:${JSON.stringify(o)}`;
const seen = (exposureStops: number, targetStops: number): IExposureObservation => ({
  applied: true,
  exposureStops,
  measured: true,
  targetStops,
});

describe("the capture waits for auto exposure to land before it takes a frame (PRD-631 noise floor)", () => {
  it("reads the observations the page prints and ignores every other message", () => {
    expect(
      parseExposure(line({ applied: true, exposureStops: -1, measured: true, targetStops: -1.5 })),
    ).toEqual(seen(-1, -1.5));
    expect(parseExposure("TN_GI_CACHE baked")).toBeUndefined();
    expect(parseExposure("TN_AUTO_EXPOSURE:{not json")).toBeUndefined();
  });

  // Two runs of the foliage cell stopped 0.1045 and 0.1494 stops short of the target: the frames differed by one display
  // level everywhere. The page's own `settled` flag allows 0.25 stops, so only the distance to the target decides.
  it("is not settled while the exposure is a tenth of a stop from its target", () => {
    expect(exposureSettled(seen(-1.0654296875, -1.169921875))).toBe(false);
    expect(exposureSettled(seen(-1.0205078125, -1.169921875))).toBe(false);
    expect(exposureSettled(seen(-1.224609375, -1.2333984375))).toBe(false);
  });

  it("is settled once the exposure sits on its target", () => {
    expect(exposureSettled(seen(0.047943115234375, 0.047943115234375))).toBe(true);
    expect(exposureSettled(seen(1, 1 + EXPOSURE_TOLERANCE_STOPS / 2))).toBe(true);
    expect(exposureSettled(seen(1, 1 + 2 * EXPOSURE_TOLERANCE_STOPS))).toBe(false);
  });

  it("is not settled without a measurement or without the stage applied", () => {
    expect(exposureSettled({ applied: true, measured: false })).toBe(false);
    expect(exposureSettled({ ...seen(0, 0), applied: false })).toBe(false);
    expect(exposureSettled({ applied: true, exposureStops: 0, measured: true })).toBe(false);
    expect(exposureSettled(undefined)).toBe(false);
  });

  /** A page whose exposure closes on the target a little more at every poll, the way the adapt pass does. */
  function page(errors: readonly number[]) {
    const observations: IExposureObservation[] = [];
    let next = 0;
    const waits: number[] = [];
    return {
      observations: () => observations,
      wait: async (ms: number) => {
        waits.push(ms);
        const error = errors[Math.min(next++, errors.length - 1)];
        if (error !== undefined) observations.push(seen(-1 - error, -1));
      },
      waits,
    };
  }

  it("keeps waiting while the exposure closes, then returns the settled observation", async () => {
    const source = page([0.1, 0.05, 0.02, 0.01, 0.004, 0.0015, 0.0008, 0.0004]);
    const last = await waitForExposure(source);
    expect(Math.abs((last.exposureStops ?? 0) - (last.targetStops ?? 1))).toBeLessThanOrEqual(
      EXPOSURE_TOLERANCE_STOPS,
    );
    expect(source.waits.length).toBe(7);
  });

  it("needs two settled observations in a row", async () => {
    const source = page([0.0005, 0.1, 0.0005, 0.0004]);
    await waitForExposure(source);
    expect(source.waits.length).toBe(4);
  });

  it("fails when the exposure never lands", async () => {
    await expect(waitForExposure(page([0.1]), { timeoutMs: 2_000 })).rejects.toThrow(
      /TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: 0\.1000 stops from the target/,
    );
  });

  describe("which runs meter their exposure", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("L9 does", () => {
      expect(metersExposure({ layer: "L9" })).toBe(true);
    });

    it("the lower layers, the ID layer and the baseline arm do not", () => {
      for (const layer of ["L1", "L6", "L7", "ID"]) expect(metersExposure({ layer })).toBe(false);
      expect(metersExposure({ baseline: true, layer: "L9" })).toBe(false);
    });

    it("a frame-budget run, an autoexposure ablation and the env switch turn it off", () => {
      expect(metersExposure({ layer: "L9", measureSeconds: 10 })).toBe(false);
      expect(metersExposure({ layer: "L9", switches: "&off=ssgi,autoexposure" })).toBe(false);
      expect(metersExposure({ layer: "L9", switches: "&off=ssgi" })).toBe(true);
      vi.stubEnv("TN_UNREAL_LOOK_NO_AUTO_EXPOSURE", "1");
      expect(metersExposure({ layer: "L9" })).toBe(false);
    });
  });

  it("fails when the page reports no exposure at all", async () => {
    await expect(waitForExposure(page([]), { timeoutMs: 2_000 })).rejects.toThrow(
      /TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: no TN_AUTO_EXPOSURE observation/,
    );
  });
});
