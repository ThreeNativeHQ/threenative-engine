import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_NEAR_STOPS,
  EXPOSURE_STEADY_STOPS,
  type IExposureObservation,
  exposureAtRest,
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
const series = (target: number, ...stops: number[]) => stops.map((s) => seen(s, target));

describe("the capture waits for auto exposure to come to rest before it takes a frame (PRD-631 noise floor)", () => {
  it("reads the observations the page prints and ignores every other message", () => {
    expect(
      parseExposure(line({ applied: true, exposureStops: -1, measured: true, targetStops: -1.5 })),
    ).toEqual(seen(-1, -1.5));
    expect(parseExposure("TN_GI_CACHE baked")).toBeUndefined();
    expect(parseExposure("TN_AUTO_EXPOSURE:{not json")).toBeUndefined();
  });

  // Two runs of the foliage cell stopped 0.1045 and 0.1494 stops short of the target and still moved: the frames differed
  // by one display level everywhere. The page's own `settled` flag allows 0.25 stops, so only the movement decides.
  it("is not at rest while the exposure still closes on its target", () => {
    expect(exposureAtRest(series(-1.169921875, -0.896484375, -1.0068359375, -1.0654296875))).toBe(
      false,
    );
    expect(exposureAtRest(series(-1.169921875, -0.8388671875, -0.97119140625, -1.0205078125))).toBe(
      false,
    );
  });

  // The adapted value is half float: a frame's step rounds to nothing a little short of the target, and the exposure stays
  // there. These are the values the page printed for the owner set; the target was 0.006 to 0.009 stops away.
  it("is at rest where the adaptation stops short of its target", () => {
    expect(exposureAtRest(series(-1.2333984375, -1.224609375, -1.224609375, -1.224609375))).toBe(
      true,
    );
    expect(exposureAtRest(series(2.80078125, 2.794921875, 2.794921875, 2.794921875))).toBe(true);
    expect(exposureAtRest(series(0.047943115234375, 0.047943115234375, 0.047943115234375))).toBe(
      true,
    );
  });

  it("allows a move of one half-float step between reports, not more", () => {
    expect(exposureAtRest(series(1, 1, 1 + EXPOSURE_STEADY_STOPS / 2, 1))).toBe(true);
    expect(exposureAtRest(series(1, 1, 1 + 2 * EXPOSURE_STEADY_STOPS, 1))).toBe(false);
  });

  it("is not at rest when it stopped far from the target: a stuck meter, not a landed exposure", () => {
    expect(exposureAtRest(series(1 + EXPOSURE_NEAR_STOPS / 2, 1, 1, 1))).toBe(true);
    expect(exposureAtRest(series(1 + 2 * EXPOSURE_NEAR_STOPS, 1, 1, 1))).toBe(false);
  });

  it("is not at rest without a measurement, without the stage applied or without any report", () => {
    expect(exposureAtRest([{ applied: true, measured: false }, seen(0, 0), seen(0, 0)])).toBe(
      false,
    );
    expect(exposureAtRest([{ ...seen(0, 0), applied: false }, seen(0, 0), seen(0, 0)])).toBe(false);
    expect(exposureAtRest([{ applied: true, exposureStops: 0, measured: true }, seen(0, 0)])).toBe(
      false,
    );
    expect(exposureAtRest([])).toBe(false);
  });

  /** A page that prints one more report at every poll, the way the frame loop does every half second. */
  function page(stops: (index: number) => number | undefined, target = -1) {
    const observations: IExposureObservation[] = [];
    const waits: number[] = [];
    return {
      observations: () => observations,
      wait: async (ms: number) => {
        waits.push(ms);
        const value = stops(observations.length);
        if (value !== undefined) observations.push(seen(value, target));
      },
      waits,
    };
  }

  it("keeps waiting while the exposure closes, then returns the last report once three sit still", async () => {
    const closing = [-0.2, -0.5, -0.8, -0.95, -1.05, -1.08, -1.09];
    const source = page((i) => closing[Math.min(i, closing.length - 1)], -1.1);
    const last = await waitForExposure(source);
    expect(last.exposureStops).toBe(-1.09);
    // Nine reports: the last three (indexes 6 to 8) are the first window that does not move.
    expect(source.waits.length).toBe(9);
  });

  it("does not take two quiet reports for rest", async () => {
    const steps = [-1, -1, -1.2, -1.2, -1.2];
    const source = page((i) => steps[Math.min(i, steps.length - 1)], -1.25);
    await waitForExposure(source);
    expect(source.waits.length).toBe(5);
  });

  it("fails closed when the exposure never comes to rest, naming the last reports", async () => {
    await expect(
      waitForExposure(
        page((i) => -0.1 * (i + 1)),
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(
      /TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: not at rest within 2000 ms.*-0\.6000\/-1\.0000, -0\.7000\/-1\.0000, -0\.8000\/-1\.0000/,
    );
  });

  it("fails closed when the exposure rests far from the target", async () => {
    await expect(
      waitForExposure(
        page(() => -0.2),
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(
      /TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: not at rest within 2000 ms.*-0\.2000\/-1\.0000/,
    );
  });

  it("fails when the page reports no exposure at all", async () => {
    await expect(
      waitForExposure(
        page(() => undefined),
        { timeoutMs: 2_000 },
      ),
    ).rejects.toThrow(/TN_UNREAL_LOOK_EXPOSURE_UNSETTLED: no TN_AUTO_EXPOSURE observation/);
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
});
