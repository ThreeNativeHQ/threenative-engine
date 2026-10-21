import { expect, test } from "vitest";
import { CaptureGuardError } from "../src/capture.js";
import { retakeWhileBlank } from "../src/runner/capture-retry.js";

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
