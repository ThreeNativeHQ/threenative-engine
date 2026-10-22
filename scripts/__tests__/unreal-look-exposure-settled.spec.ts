import type { Page } from "@playwright/test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EXPOSURE_NEAR_STOPS,
  EXPOSURE_STEADY_STOPS,
  type IExposureObservation,
  awaitExposureSettled,
  exposureAtRest,
  exposureSettled,
  metersExposure,
  notSettledMessage,
  parseExposure,
} from "../unreal-look/exposureSettled.js";

const reading = (atMs: number, fields: Record<string, unknown>) => ({
  atMs,
  text: `TN_AUTO_EXPOSURE:${JSON.stringify({ applied: true, ...fields })}`,
});
/** The page's report. `settled` is the page's own flag, which allows 0.25 stops: it says true at every distance used here. */
const at = (atMs: number, exposureStops: number, targetStops = -1.2333984375) =>
  reading(atMs, { exposureStops, measured: true, settled: true, targetStops });
/** Where sun60 spheres stops for good: 0.0088 stops short of the target, because a frame's step rounds to nothing in half float. */
const rest = (atMs: number) => at(atMs, -1.224609375);
const closing = (atMs: number, exposureStops = -0.9) => at(atMs, exposureStops);
const invalid = (atMs: number) =>
  reading(atMs, { measured: false, reason: "Error: Exposure readback is invalid" });
const seen = (exposureStops: number, targetStops: number): IExposureObservation => ({
  applied: true,
  exposureStops,
  measured: true,
  targetStops,
});
const series = (target: number, ...stops: number[]) => stops.map((s) => seen(s, target));

describe("an L9 frame is taken only once the auto exposure has come to rest on the new view", () => {
  it("needs three readings after the pose, so one reading of the old view cannot pass", () => {
    expect(exposureSettled([], 0)).toBe(false);
    expect(exposureSettled([rest(10), rest(20)], 0)).toBe(false);
    expect(exposureSettled([rest(10), rest(20), rest(30)], 0)).toBe(true);
  });

  it("ignores readings from before the pose", () => {
    expect(exposureSettled([rest(10), rest(20), rest(30)], 25)).toBe(false);
    expect(exposureSettled([rest(10), rest(20), rest(30), rest(40), rest(50)], 25)).toBe(true);
  });

  it("fails while the exposure still moves, even after many quiet readings before it", () => {
    expect(exposureSettled([rest(10), rest(20), rest(30), closing(40, -1.1), rest(50)], 0)).toBe(
      false,
    );
  });

  // Two runs of the foliage cell stopped 0.1045 and 0.1494 stops short of the target and still moved: the frames differed
  // by one display level everywhere (p50 +0.53%, sky region +3.4%). The page's own `settled` flag said true in both.
  it("fails on the readings of the two foliage runs that differed, whatever the page's settled flag says", () => {
    const target = -1.169921875;
    const run = (...stops: number[]) => stops.map((s, i) => at(10 * (i + 1), s, target));
    expect(exposureSettled(run(-0.896484375, -1.0068359375, -1.0654296875), 0)).toBe(false);
    expect(exposureSettled(run(-0.8388671875, -0.97119140625, -1.0205078125), 0)).toBe(false);
  });

  it("fails when a reading is invalid: an unmeasured frame has not adapted", () => {
    expect(exposureSettled([rest(10), invalid(20), rest(30)], 0)).toBe(false);
    expect(exposureSettled([invalid(10), invalid(20), invalid(30)], 0)).toBe(false);
  });

  it("fails on a line it cannot parse, never passes it", () => {
    expect(exposureSettled([rest(10), rest(20), { atMs: 30, text: "TN_AUTO_EXPOSURE:{" }], 0)).toBe(
      false,
    );
  });

  it("holds the capture until the readings come to rest, and fails closed when they never do", async () => {
    const readings = [closing(10)];
    const page = {
      waitForTimeout: async () => {
        readings.push(rest(20 + readings.length));
      },
    };
    await awaitExposureSettled(page as unknown as Page, readings, 0, 1000);
    expect(exposureSettled(readings, 0)).toBe(true);
    const stuck = { waitForTimeout: () => new Promise((resolve) => setTimeout(resolve, 5)) };
    await expect(
      awaitExposureSettled(stuck as unknown as Page, [closing(10)], 0, 20),
    ).rejects.toThrow("TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED");
  });

  it("does not wait for an exposure that is switched off", async () => {
    const stuck = { waitForTimeout: () => Promise.reject(new Error("waited")) };
    const off = reading(10, { applied: false, measured: true, settled: false });
    const waitedMs = await awaitExposureSettled(stuck as unknown as Page, [off], 0, 20);
    expect(waitedMs).toBeLessThan(50);
  });

  it("names the last readings when it refuses, so the log shows why", () => {
    const message = notSettledMessage([rest(10), closing(20), invalid(30)], 0, 60_000);
    expect(message).toContain("TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED");
    expect(message).toContain("60 s");
    expect(message).toContain('"exposureStops":-0.9');
    expect(message).toContain("Exposure readback is invalid");
  });
});

describe("the exposure is at rest when it stops moving, not when it reaches its target", () => {
  it("reads the observations the page prints and ignores every other message", () => {
    expect(
      parseExposure(
        `TN_AUTO_EXPOSURE:${JSON.stringify({ applied: true, exposureStops: -1, measured: true, targetStops: -1.5 })}`,
      ),
    ).toEqual(seen(-1, -1.5));
    expect(parseExposure("TN_GI_CACHE baked")).toBeUndefined();
    expect(parseExposure("TN_AUTO_EXPOSURE:{not json")).toBeUndefined();
  });

  // The adapted value is half float: a frame's step toward the target rounds to nothing a little short of it and the
  // exposure stays there. These are the values the page printed for the owner set; the target was 0.006 to 0.009 stops away.
  it("is at rest where the adaptation stops short of its target", () => {
    expect(exposureAtRest(series(-1.2333984375, -1.224609375, -1.224609375, -1.224609375))).toBe(
      true,
    );
    expect(exposureAtRest(series(2.80078125, 2.794921875, 2.794921875, 2.794921875))).toBe(true);
    expect(exposureAtRest(series(0.047943115234375, 0.047943115234375, 0.047943115234375))).toBe(
      true,
    );
  });

  it("is not at rest while the exposure still closes on its target", () => {
    expect(exposureAtRest(series(-1.169921875, -0.896484375, -1.0068359375, -1.0654296875))).toBe(
      false,
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
