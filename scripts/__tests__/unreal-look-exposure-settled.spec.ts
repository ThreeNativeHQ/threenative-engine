import type { Page } from "@playwright/test";
import { describe, expect, it } from "vitest";
import {
  awaitExposureSettled,
  exposureSettled,
  notSettledMessage,
} from "../unreal-look/exposureSettled.js";

const reading = (atMs: number, fields: Record<string, unknown>) => ({
  atMs,
  text: `TN_AUTO_EXPOSURE:${JSON.stringify({ applied: true, ...fields })}`,
});
const settled = (atMs: number) => reading(atMs, { measured: true, settled: true });
const adapting = (atMs: number) => reading(atMs, { measured: true, settled: false });
const invalid = (atMs: number) =>
  reading(atMs, { measured: false, reason: "Error: Exposure readback is invalid" });

describe("an L9 frame is taken only once the auto exposure has landed on the new view", () => {
  it("needs three readings after the pose, so one reading of the old view cannot pass", () => {
    expect(exposureSettled([], 0)).toBe(false);
    expect(exposureSettled([settled(10), settled(20)], 0)).toBe(false);
    expect(exposureSettled([settled(10), settled(20), settled(30)], 0)).toBe(true);
  });

  it("ignores readings from before the pose", () => {
    expect(exposureSettled([settled(10), settled(20), settled(30)], 25)).toBe(false);
    expect(
      exposureSettled([settled(10), settled(20), settled(30), settled(40), settled(50)], 25),
    ).toBe(true);
  });

  it("fails while the exposure still moves, even after many settled readings before it", () => {
    expect(
      exposureSettled([settled(10), settled(20), settled(30), adapting(40), settled(50)], 0),
    ).toBe(false);
  });

  it("fails when a reading is invalid: an unmeasured frame has not adapted", () => {
    expect(exposureSettled([settled(10), invalid(20), settled(30)], 0)).toBe(false);
    expect(exposureSettled([invalid(10), invalid(20), invalid(30)], 0)).toBe(false);
  });

  it("fails on a line it cannot parse, never passes it", () => {
    expect(
      exposureSettled([settled(10), settled(20), { atMs: 30, text: "TN_AUTO_EXPOSURE:{" }], 0),
    ).toBe(false);
  });

  it("holds the capture until the readings land, and fails closed when they never do", async () => {
    const readings = [adapting(10)];
    const page = {
      waitForTimeout: async () => {
        readings.push(settled(20 + readings.length));
      },
    };
    await awaitExposureSettled(page as unknown as Page, readings, 0, 1000);
    expect(exposureSettled(readings, 0)).toBe(true);
    const stuck = { waitForTimeout: () => new Promise((resolve) => setTimeout(resolve, 5)) };
    await expect(
      awaitExposureSettled(stuck as unknown as Page, [adapting(10)], 0, 20),
    ).rejects.toThrow("TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED");
  });

  it("does not wait for an exposure that is switched off", async () => {
    const stuck = { waitForTimeout: () => Promise.reject(new Error("waited")) };
    const off = reading(10, { measured: true, settled: false, applied: false });
    const waitedMs = await awaitExposureSettled(stuck as unknown as Page, [off], 0, 20);
    expect(waitedMs).toBeLessThan(50);
  });

  it("names the last readings when it refuses, so the log shows why", () => {
    const message = notSettledMessage([settled(10), adapting(20), invalid(30)], 0, 60_000);
    expect(message).toContain("TN_UNREAL_LOOK_EXPOSURE_NOT_SETTLED");
    expect(message).toContain("60 s");
    expect(message).toContain('"settled":false');
    expect(message).toContain("Exposure readback is invalid");
  });
});
