import { test, expect } from "vitest";
import type { Page } from "playwright";

import { validateStep } from "../src/scenario/schema-validate.js";
import { installScriptedGamepad } from "../src/runner/browserSession.js";
import { runStep, setPlaytestGamepad } from "../src/runner/steps.js";

test("a gamepad step injects the standard pad a scenario scripts, and release centres it", async () => {
  const injected: unknown[] = [];
  const page = {
    evaluate: async (_fn: unknown, state: unknown) => {
      injected.push(state);
    },
    keyboard: { down: async () => undefined, up: async () => undefined },
    mouse: { move: async () => undefined },
  } as unknown as Page;

  await runStep(
    page,
    undefined,
    { gamepad: { axes: [1, 0], buttons: [0] }, kind: "input", release: true } as never,
    { height: 360, width: 640 },
    undefined,
    [],
    { heldKeys: new Set(), pointerButtons: 0, pointers: new Map() },
    undefined,
    true,
  );

  expect(injected.filter((value) => typeof value === "object" && value !== null)).toEqual([
    { axes: [1, 0], buttons: [0] },
    { axes: [], buttons: [] },
  ]);
});

test("a gamepad step validates only the standard's own axes and buttons", () => {
  const validate = (gamepad: unknown) =>
    validateStep({ gamepad, kind: "input", waitTicks: 1 }, "gamepad.playtest.json", 0);

  expect(validate({ axes: [1, 0], buttons: [0, 7] }).gamepad).toEqual({ axes: [1, 0], buttons: [0, 7] });
  expect(() => validate({ axes: [0, 0, 0, 0, 0] })).toThrow(/gamepad must define axes/);
  expect(() => validate({ axes: [2] })).toThrow(/gamepad must define axes/);
  expect(() => validate({ buttons: [16] })).toThrow(/gamepad must define axes/);
  expect(() => validate({ buttons: [1, 1] })).toThrow(/gamepad must define axes/);
  expect(() => validate({ trigger: [0] })).toThrow(/unknown key/i);
  expect(() => validate({})).toThrow(/gamepad must define axes/);
});

test("the injected pad is what the page's getGamepads returns, and the browser's own when unset", async () => {
  const scripts: Array<() => void> = [];
  const page = {
    addInitScript: async (fn: () => void) => {
      scripts.push(fn);
    },
  } as unknown as Page;

  // Running the runner's own init script against a fake navigator is what proves the game sees the
  // pad through the API it ships with, rather than through a hook only the runner knows about.
  const navigatorHost = { getGamepads: () => [{ id: "browser-pad" }] } as {
    getGamepads: () => Array<Record<string, unknown>>;
  };
  const saved = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigatorHost });
  (globalThis as { __tnPlaytestGamepad?: unknown }).__tnPlaytestGamepad = undefined;
  try {
    await installScriptedGamepad(page);
    scripts[0]?.();
    expect(navigatorHost.getGamepads()).toEqual([{ id: "browser-pad" }]);

    (globalThis as { __tnPlaytestGamepad?: unknown }).__tnPlaytestGamepad = {
      axes: [1, 0],
      buttons: [0],
    };
    const [pad] = navigatorHost.getGamepads() as Array<{
      axes: number[];
      buttons: Array<{ pressed: boolean }>;
      mapping: string;
    }>;
    expect(pad?.mapping).toBe("standard");
    expect(pad?.axes).toEqual([1, 0, 0, 0]);
    expect(pad?.buttons).toHaveLength(16);
    expect(pad?.buttons[0]?.pressed).toBe(true);
    expect(pad?.buttons[1]?.pressed).toBe(false);
  } finally {
    // `navigator` is an accessor some Node versions own and others inherit, so never assign it:
    // delete the own property this test defined, which reveals whatever the host had underneath.
    if (saved === undefined) Reflect.deleteProperty(globalThis, "navigator");
    else Object.defineProperty(globalThis, "navigator", saved);
    (globalThis as { __tnPlaytestGamepad?: unknown }).__tnPlaytestGamepad = undefined;
  }
});

test("setPlaytestGamepad hands the pad to the page as plain data", async () => {
  const calls: unknown[] = [];
  await setPlaytestGamepad(
    { evaluate: async (_fn: unknown, state: unknown) => void calls.push(state) } as unknown as Page,
    { buttons: [7] },
  );
  expect(calls).toEqual([{ buttons: [7] }]);
});
