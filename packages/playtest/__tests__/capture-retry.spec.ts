import { expect, test } from "vitest";
import { CaptureGuardError } from "../src/capture.js";
import { captureWithRetry, retakeWhileBlank } from "../src/runner/capture-retry.js";

const blank = (): CaptureGuardError => new CaptureGuardError("after.png", "uniform frame");

test("keeps retaking a blank surface until the world is presented", async () => {
  let shots = 0;
  const graces: number[] = [];
  const result = await retakeWhileBlank(
    async () => {
      shots += 1;
      if (shots < 5) throw blank();
      return "world";
    },
    async () => void graces.push(shots),
    10_000,
  );
  expect(result).toBe("world");
  expect(graces).toEqual([0, 1, 2, 3, 4]);
});

test("a surface still blank at the bound fails closed with its last verdict", async () => {
  let clock = 0;
  let shots = 0;
  const failure = retakeWhileBlank(
    async () => {
      shots += 1;
      throw blank();
    },
    async () => {
      clock += 500;
    },
    2_000,
    () => clock,
  );
  await expect(failure).rejects.toBeInstanceOf(CaptureGuardError);
  expect(shots).toBe(4);
});

test("an error that is not a blank verdict is never retried", async () => {
  let shots = 0;
  const failure = retakeWhileBlank(
    async () => {
      shots += 1;
      throw new Error("page closed");
    },
    async () => undefined,
    10_000,
  );
  await expect(failure).rejects.toThrow("page closed");
  expect(shots).toBe(1);
});

test("captureWithRetry shoots once, with no grace, when the first frame is good", async () => {
  const graces: number[] = [];
  const result = await captureWithRetry(async () => "world", async () => void graces.push(1));
  expect(result).toBe("world");
  expect(graces).toEqual([]);
});

test("captureWithRetry retakes a blank first frame and tells the capture it is a retake", async () => {
  const seen: boolean[] = [];
  const result = await captureWithRetry(async (retake) => {
    seen.push(retake);
    if (seen.length < 3) throw blank();
    return "world";
  }, async () => undefined);
  expect(result).toBe("world");
  expect(seen).toEqual([false, true, true]);
});

test("captureWithRetry does not retry an error that is not a blank verdict", async () => {
  let shots = 0;
  await expect(captureWithRetry(async () => {
    shots += 1;
    throw new Error("page.screenshot: closed");
  }, async () => undefined)).rejects.toThrow("page.screenshot: closed");
  expect(shots).toBe(1);
});

test("captureWithRetry fails closed on a surface that stays blank to the bound", async () => {
  const clock = { now: 0 };
  await expect(captureWithRetry(async () => {
    throw blank();
  }, async () => {
    clock.now += 4_000;
  }, 10_000, () => clock.now)).rejects.toBeInstanceOf(CaptureGuardError);
});
