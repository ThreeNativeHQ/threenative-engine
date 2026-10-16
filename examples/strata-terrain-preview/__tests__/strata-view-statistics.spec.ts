import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { medianOfGrowingSamples } from "../src/viewStatistics.js";

afterEach(() => vi.restoreAllMocks());

it("does not sort unchanged frame windows again between reports", () => {
  const samples = [40, 10, 20];
  const sort = vi.spyOn(Array.prototype, "sort");
  const readings = Array.from({ length: 120 }, () => medianOfGrowingSamples(samples));
  const sortsBeforeAppend = sort.mock.calls.length;
  samples.push(50);
  const afterAppend = medianOfGrowingSamples(samples);
  const repeated = medianOfGrowingSamples(samples);
  const totalSorts = sort.mock.calls.length;
  sort.mockRestore();

  expect(readings).toEqual(Array(120).fill(20));
  expect(sortsBeforeAppend).toBe(1);
  expect(afterAppend).toBe(40);
  expect(repeated).toBe(40);
  expect(totalSorts).toBe(2);
  expect(samples).toEqual([40, 10, 20, 50]);
});

it("preserves the upper-middle result and treats replacement arrays independently", () => {
  expect(medianOfGrowingSamples([])).toBe(0);
  expect(medianOfGrowingSamples([9])).toBe(9);
  expect(medianOfGrowingSamples([30, 10])).toBe(30);
  expect(medianOfGrowingSamples([10, 30, 20])).toBe(20);
  expect(medianOfGrowingSamples([60, 50, 40])).toBe(50);
  expect(medianOfGrowingSamples([0, 0, 8, 1])).toBe(1);
});

it("keeps an unmeasured view below the positive measurement floor", () => {
  expect(medianOfGrowingSamples([])).toBeLessThan(0.01);
  expect(medianOfGrowingSamples([30, 10, 20])).toBe(20);
});

it("waits for three kept windows at every measured view instead of fixed ticks", () => {
  const scenario = JSON.parse(
    readFileSync(new URL("../playtests/terrain.playtest.json", import.meta.url), "utf8"),
  );
  const measuredHolds = scenario.steps.filter(
    (step: { kind?: string; label: string; waitForResource?: { path: string } }) =>
      (step.kind === "wait" || step.waitForResource?.path === "currentViewWindows") &&
      step.label !== "ocean",
  );
  expect(measuredHolds.length).toBe(21);
  for (const step of measuredHolds) {
    expect(step.waitForResource).toEqual({ id: "GameState", path: "currentViewWindows", gte: 3 });
    expect(step.timeoutMs).toBe(120000);
    expect(step.waitTicks).toBeUndefined();
  }
});
