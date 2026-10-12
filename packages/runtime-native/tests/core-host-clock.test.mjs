import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stubs = ["tn", "__tnWallMs", "__tnHeldCodes", "__tnGameSpan", "performance", "__tnAudio"];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(stubs.map((key) => [key, globalThis[key]]));
  vi.resetModules();
  globalThis.__tnAudio = { updateAudio() {} };
  globalThis.__tnHeldCodes = () => [];
  globalThis.__tnGameSpan = undefined;
  globalThis.tn = { platform: "desktop", onFrame() {}, onUpdate: (callback) => { globalThis.__tick = callback; }, log() {} };
});
afterEach(() => {
  for (const key of stubs) {
    if (saved[key] === undefined) delete globalThis[key];
    else globalThis[key] = saved[key];
  }
});

it("performance.now is the host's real clock, advancing inside one frame with no tick", async () => {
  let wall = 100;
  globalThis.__tnWallMs = () => {
    wall += 2.5;
    return wall;
  };
  await import("../src/engine/player/core-host.mjs");
  const before = globalThis.performance.now();
  expect(globalThis.performance.now()).toBeGreaterThan(before);
});

it("timers keep fixed-step time while performance.now follows the wall", async () => {
  globalThis.__tnWallMs = () => 5_000;
  await import("../src/engine/player/core-host.mjs");
  const fired = vi.fn();
  globalThis.setTimeout(fired, 20);
  globalThis.__tick(0.01);
  expect(fired).not.toHaveBeenCalled();
  globalThis.__tick(0.011);
  expect(fired).toHaveBeenCalledTimes(1);
});

it("falls back to the fixed-step clock when the host has no wall clock", async () => {
  delete globalThis.__tnWallMs;
  await import("../src/engine/player/core-host.mjs");
  globalThis.__tick(0.016);
  expect(globalThis.performance.now()).toBeCloseTo(16);
});
