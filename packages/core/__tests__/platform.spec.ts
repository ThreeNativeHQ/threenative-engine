import { describe, expect, it, vi } from "vitest";
import {
  detectPlatform,
  getPlatform,
  hostGestureTarget,
  isMobile,
  isNative,
  isTouchscreenAvailable,
  isWeb,
} from "../src/platform.js";

function nativeSource(
  os: "android" | "ios" | "linux" | "macos" | "windows" | "unknown",
  formFactor: "mobile" | "desktop" | "unknown",
  maxTouchPoints: number,
) {
  return {
    native: { platform: { formFactor, maxTouchPoints, os, runtime: "native" } },
  };
}

describe("platform detection", () => {
  it.each([
    [
      "web desktop",
      {
        navigator: {
          maxTouchPoints: 0,
          platform: "Win32",
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          userAgentData: { mobile: false, platform: "Windows" },
        },
      },
      { formFactor: "desktop", maxTouchPoints: 0, os: "windows", runtime: "web" },
    ],
    [
      "Android web",
      {
        navigator: {
          maxTouchPoints: 5,
          platform: "Linux armv8l",
          userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
          userAgentData: { mobile: true, platform: "Android" },
        },
      },
      { formFactor: "mobile", maxTouchPoints: 5, os: "android", runtime: "web" },
    ],
    [
      "iPad web",
      {
        navigator: {
          maxTouchPoints: 5,
          platform: "iPad",
          userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)",
        },
      },
      { formFactor: "mobile", maxTouchPoints: 5, os: "ios", runtime: "web" },
    ],
    [
      "touch laptop",
      {
        navigator: {
          maxTouchPoints: 10,
          platform: "Win32",
          userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          userAgentData: { mobile: false, platform: "Windows" },
        },
      },
      { formFactor: "desktop", maxTouchPoints: 10, os: "windows", runtime: "web" },
    ],
    [
      "Android native",
      nativeSource("android", "mobile", 5),
      { formFactor: "mobile", maxTouchPoints: 5, os: "android", runtime: "native" },
    ],
    [
      "iOS native",
      nativeSource("ios", "mobile", 5),
      { formFactor: "mobile", maxTouchPoints: 5, os: "ios", runtime: "native" },
    ],
    [
      "macOS native",
      nativeSource("macos", "desktop", 0),
      { formFactor: "desktop", maxTouchPoints: 0, os: "macos", runtime: "native" },
    ],
    [
      "absent navigator",
      { navigator: undefined },
      { formFactor: "unknown", maxTouchPoints: 0, os: "unknown", runtime: "web" },
    ],
    [
      "conflicting browser evidence",
      {
        navigator: {
          maxTouchPoints: 5,
          platform: "Linux x86_64",
          userAgent: "Mozilla/5.0 (Linux; Android 14)",
          userAgentData: { mobile: false, platform: "Windows" },
        },
      },
      { formFactor: "unknown", maxTouchPoints: 5, os: "unknown", runtime: "web" },
    ],
  ] as const)("should classify %s from guarded host facts", (_name, source, expected) => {
    expect(detectPlatform(source)).toEqual(expected);
  });

  it("should prefer the native marker over the compatibility DOM", () => {
    const result = detectPlatform({
      document: {},
      ...nativeSource("ios", "mobile", 5),
    });

    expect(result).toMatchObject({ os: "ios", runtime: "native" });
  });

  it("should reject malformed native facts instead of impersonating a browser", () => {
    expect(() =>
      detectPlatform({
        native: {
          platform: { formFactor: "mobile", maxTouchPoints: -1, os: "android", runtime: "native" },
        },
      }),
    ).toThrow("TN_NATIVE_PLATFORM_INVALID");
  });

  it("should keep every helper on the frozen process snapshot", () => {
    const platform = getPlatform();

    expect(Object.isFrozen(platform)).toBe(true);
    expect(isWeb()).toBe(platform.runtime === "web");
    expect(isNative()).toBe(platform.runtime === "native");
    expect(isMobile()).toBe(platform.formFactor === "mobile");
    expect(isTouchscreenAvailable()).toBe(platform.maxTouchPoints > 0);
    expect(isWeb()).not.toBe(isNative());
  });
});

describe("platform detection in a worker (PRD-752)", () => {
  it("reads the page's navigator the worker host copied, not the worker's own", () => {
    // A WorkerNavigator has no maxTouchPoints, so a phone running the worker page read as
    // touchless and the starter never built its touch controls.
    vi.stubGlobal("navigator", { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux)" });
    vi.stubGlobal("__tnPageNavigator", {
      maxTouchPoints: 5,
      platform: "Linux armv8l",
      userAgent: "Mozilla/5.0 (Linux; Android 14)",
      userAgentData: { mobile: true, platform: "Android" },
    });
    try {
      expect(detectPlatform()).toEqual({
        formFactor: "mobile",
        maxTouchPoints: 5,
        os: "android",
        runtime: "web",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("host gesture target (PRD-752)", () => {
  it("is the page window, else the input target a worker host installed", () => {
    // AudioBus waits for a gesture before it plays. A worker has no window, so without the
    // platform's input target every cue would stay queued.
    const inputTarget = new EventTarget();
    const view = new EventTarget();
    vi.stubGlobal("__tnGamePlatform", { inputTarget });
    try {
      vi.stubGlobal("window", undefined);
      expect(hostGestureTarget()).toBe(inputTarget);
      vi.stubGlobal("window", view);
      expect(hostGestureTarget()).toBe(view);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
