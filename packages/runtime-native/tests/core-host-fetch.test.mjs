// PRD-784 sweep: `assets.resolve()` answers `tnpk:<path>` on the V8 engine player, and procedural-animals
// reads that URL with fetch, which the player did not have. core-host now serves package Buffer entries.
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const stubs = ["tn", "__tnWallMs", "__tnHeldCodes", "__tnGameSpan", "performance", "__tnAudio", "fetch"];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(stubs.map((key) => [key, globalThis[key]]));
  vi.resetModules();
  globalThis.__tnAudio = { updateAudio() {} };
  globalThis.__tnHeldCodes = () => [];
  globalThis.tn = {
    platform: "desktop", onFrame() {}, onUpdate() {}, log() {},
    loadAsset(kind, path) {
      if (kind !== "buffer" || path !== "animals/wolf.animal") throw new Error(`TN_NATIVE_ASSET_MISSING: ${path}`);
      return { value: new TextEncoder().encode('{"legs":4}').buffer };
    },
  };
});
afterEach(() => {
  for (const key of stubs) {
    if (saved[key] === undefined) delete globalThis[key];
    else globalThis[key] = saved[key];
  }
});

it("serves a package entry by its tnpk: URL", async () => {
  await import("../src/engine/player/core-host.mjs");
  expect(await (await globalThis.fetch("tnpk:animals/wolf.animal")).json()).toEqual({ legs: 4 });
  expect(await (await globalThis.fetch("game#animals/wolf.animal")).text()).toBe('{"legs":4}');
  await expect(globalThis.fetch("tnpk:animals/cat.animal")).rejects.toThrow(/TN_NATIVE_ASSET_MISSING/);
});

it("refuses a network URL by name", async () => {
  await import("../src/engine/player/core-host.mjs");
  await expect(globalThis.fetch("https://example.com/wolf.animal")).rejects.toThrow(/TN_NATIVE_FETCH_NETWORK_UNSUPPORTED/);
});
