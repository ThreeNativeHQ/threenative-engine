import { describe, expect, it } from "vitest";

import { validatePlaytestScenario } from "../src/scenario.js";

const scenario = (explore: Record<string, unknown>) => ({
  assert: { diagnostics: { noConsoleErrors: true } },
  name: "explore",
  schemaVersion: 1,
  steps: [{ kind: "explore", ...explore }],
});

const valid = { actions: ["Space", "KeyJ"], move: ["KeyW", "KeyA", "KeyS", "KeyD"], seed: 7, ticks: 600 };

describe("explore step", () => {
  it("expands into seeded input steps that cover the ticks exactly", () => {
    const { steps } = validatePlaytestScenario(scenario({ ...valid, label: "explored" }), "explore.json");
    expect(steps.length).toBeGreaterThan(5);
    expect(steps.every(({ kind }) => kind === "input")).toBe(true);
    expect(steps.reduce((total, { holdTicks }) => total + (holdTicks ?? 0), 0)).toBe(600);
    expect(steps.at(-1)?.label).toBe("explored");
    const pressed = new Set(steps.flatMap(({ press }) => (Array.isArray(press) ? press : [press])));
    expect([...pressed].every((key) => [...valid.move, ...valid.actions].includes(key as string))).toBe(true);
    expect(pressed.has("Space") || pressed.has("KeyJ")).toBe(true);
  });

  it("replays the same run for the same seed and a different one for another", () => {
    const run = (seed: number) => validatePlaytestScenario(scenario({ ...valid, pointer: true, seed }), "explore.json").steps;
    expect(run(7)).toEqual(run(7));
    expect(run(8)).not.toEqual(run(7));
    expect(run(7).every(({ pointerPosition }) => pointerPosition !== undefined)).toBe(true);
  });

  it.each([
    [{ seed: undefined }, /seed/u],
    [{ seed: 1.5 }, /seed/u],
    [{ ticks: 0 }, /ticks/u],
    [{ move: [] }, /move/u],
    [{ move: ["KeyW", "KeyW"] }, /move/u],
    [{ actions: "Space" }, /actions/u],
    [{ pointer: "yes" }, /pointer/u],
    [{ press: "KeyW" }, /press/u],
  ])("throws at load on %o", (override, message) => {
    expect(() => validatePlaytestScenario(scenario({ ...valid, ...override }), "explore.json")).toThrow(message);
  });
});
