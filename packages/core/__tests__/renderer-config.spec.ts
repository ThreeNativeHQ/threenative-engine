import { describe, expect, it } from "vitest";
import {
  resolvePlatformResolutionFloor,
  resolveRendererAlphaAntialiasing,
  resolveRendererAntialias,
  resolveRendererScaleSetting,
} from "../src/renderer-config.js";

describe("resolveRendererAntialias", () => {
  it("selects the Android sampling override inside the engine", () => {
    expect(
      resolveRendererAntialias({ antialias: true, android: { antialias: false } }, true, "android"),
    ).toBe(false);
  });

  it("uses the portable config value off Android, then the direct renderer fallback", () => {
    expect(
      resolveRendererAntialias({ antialias: true, android: { antialias: false } }, false, "ios"),
    ).toBe(true);
    expect(resolveRendererAntialias(undefined, false, "android")).toBe(false);
    expect(resolveRendererAntialias(undefined, undefined, "android")).toBeUndefined();
  });

  it("lets a platform that scales resolution down buy sampling back on that platform", () => {
    // The defect this closes: the Android override block carried `resolutionScale` alone, so a
    // game trading resolution for frame budget could not portably restore quality on the same
    // platform. Both keys resolve on one seam or neither is usable.
    const config = { android: { antialias: true, resolutionScale: 0.44 } };
    expect(resolveRendererScaleSetting(config, undefined, "android").resolutionScale).toBe(0.44);
    expect(resolveRendererAntialias(config, undefined, "android")).toBe(true);
  });
});

describe("resolveRendererAlphaAntialiasing", () => {
  // Alpha antialiasing spends the samples `antialias` buys; it never buys its own. So it resolves
  // on the same seam, with its own Android override, or a phone that bought sampling back could
  // not spend it on the foliage that is the whole reason mobile sampling is worth buying.
  it("selects the Android override inside the engine, and the portable value elsewhere", () => {
    const config = {
      alphaAntialiasing: true,
      android: { alphaAntialiasing: false, antialias: true },
    };
    expect(resolveRendererAlphaAntialiasing(config, undefined, "android")).toBe(false);
    expect(resolveRendererAlphaAntialiasing(config, undefined, "ios")).toBe(true);
  });

  it("falls back to the direct renderer option, then leaves the default to the renderer", () => {
    expect(resolveRendererAlphaAntialiasing(undefined, false, "android")).toBe(false);
    expect(resolveRendererAlphaAntialiasing(undefined, undefined, "linux")).toBeUndefined();
  });
});

describe("resolveRendererScaleSetting", () => {
  it("resolves a pinned number and names it pinned", () => {
    expect(
      resolveRendererScaleSetting({ android: { resolutionScale: 0.32 } }, undefined, "android"),
    ).toEqual({
      resolutionScale: 0.32,
      scaleSource: "pinned",
    });
  });

  it('resolves "auto" to a full-resolution start the scaler walks down from', () => {
    // Phase 1 ships the contract without the loop: "auto" is accepted, reported as auto, and
    // begins where a game with no scale begins today. Nothing moves it yet.
    expect(resolveRendererScaleSetting({ resolutionScale: "auto" }, undefined, "ios")).toEqual({
      resolutionScale: 1,
      scaleSource: "auto",
    });
    expect(
      resolveRendererScaleSetting(
        { resolutionScale: 0.5, android: { resolutionScale: "auto" } },
        undefined,
        "android",
      ),
    ).toEqual({ resolutionScale: 1, scaleSource: "auto" });
  });

  it("reads an unset scale as auto, because the engine can measure the budget itself", () => {
    // The owner rule, in plain words: if the engine can measure a value where it is used, it
    // decides. Unset used to resolve to a pinned 1.0, so a game that asked for nothing got no
    // scaler at all — and on a HiDPI desktop that meant a 4527x2207 drawing buffer at 4x MSAA
    // until the GPU device was lost. Silence is now "auto"; a number is still the pin, and the
    // `renderer.resolutionScale` fallback keeps pinning when it carries one.
    expect(resolveRendererScaleSetting(undefined, undefined, "linux")).toEqual({
      resolutionScale: 1,
      scaleSource: "auto",
    });
    expect(resolveRendererScaleSetting({}, undefined, "android")).toEqual({
      resolutionScale: 1,
      scaleSource: "auto",
    });
    expect(resolveRendererScaleSetting(undefined, 0.6, "linux")).toEqual({
      resolutionScale: 0.6,
      scaleSource: "pinned",
    });
  });

  it("refuses a scale that cannot describe a drawing buffer", () => {
    for (const bad of [0, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        () => resolveRendererScaleSetting({ resolutionScale: bad }, undefined, "linux"),
        `scale ${String(bad)}`,
      ).toThrow(/resolutionScale/u);
    }
    expect(() =>
      resolveRendererScaleSetting(
        { resolutionScale: "adaptive" as unknown as number },
        undefined,
        "linux",
      ),
    ).toThrow(/resolutionScale/u);
  });

  it("names the Android override in its error, so the caller knows which key to fix", () => {
    expect(() =>
      resolveRendererScaleSetting({ android: { resolutionScale: 2 } }, undefined, "android"),
    ).toThrow(/renderer\.android\.resolutionScale/u);
  });
});

describe("resolvePlatformResolutionFloor", () => {
  it("holds a desktop above the mush and leaves the phone ladder whole", () => {
    // A desktop without a temporal reconstruction stage has nothing to turn 0.23 of the pixels
    // back into a picture, so its rungs stop at 0.61 and the frame reports it is out of room.
    // The phones keep every rung: their rungs are what the device arm measured and accepted.
    for (const os of ["linux", "macos", "windows", "unknown"] as const)
      expect(resolvePlatformResolutionFloor(os), os).toBe(0.61);
    expect(resolvePlatformResolutionFloor("android")).toBeUndefined();
    expect(resolvePlatformResolutionFloor("ios")).toBeUndefined();
  });
});
