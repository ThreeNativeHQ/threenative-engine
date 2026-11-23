import { afterEach, describe, expect, it, vi } from "vitest";
import { InputMap } from "../src/input.js";

/**
 * PRD-906 Phase 2. Godot's `Input.vibrate_handheld` and `Input.start_joy_vibration`, written on the
 * web APIs the native host already shims: `navigator.vibrate` for the phone, a pad's
 * `vibrationActuator.playEffect("dual-rumble")` for rumble. A device with no motor says so once.
 */

function input(): InputMap {
  return new InputMap({}, new EventTarget(), new EventTarget(), () => [], "allow");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("haptics", () => {
  it("reports TN_HAPTICS_UNSUPPORTED once for every unsupported cause", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // No navigator API at all: no phone motor, no pad actuator.
    vi.stubGlobal("navigator", {});
    const pads = input();
    expect(pads.vibrateHandheld(30)).toBe(false);
    expect(pads.startJoyVibration(0.4, 0.6, 30)).toBe(false);
    // An actuator that refuses the effect is the same missing motor, and not a second report.
    vi.stubGlobal("navigator", {
      getGamepads: () => [{ vibrationActuator: { playEffect: () => "not-supported" } }],
    });
    expect(input().startJoyVibration(0.4, 0.6, 30)).toBe(false);

    const reported = warn.mock.calls.filter(([line]) =>
      String(line).startsWith("TN_HAPTICS_UNSUPPORTED"),
    );
    expect(reported).toHaveLength(1);
  });

  it("shakes the phone through navigator.vibrate", () => {
    const vibrate = vi.fn(() => true);
    vi.stubGlobal("navigator", { vibrate });

    expect(input().vibrateHandheld(120)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith(120);
    // A browser's vibrate throws "Illegal invocation" unless it runs on its navigator.
    expect(vibrate.mock.contexts[0]).toBe(globalThis.navigator);
  });

  it("returns false when the device refuses the vibration", () => {
    vi.stubGlobal("navigator", { vibrate: vi.fn(() => false) });
    expect(input().vibrateHandheld(400)).toBe(false);
  });

  it("rumbles the named pad through its actuator", () => {
    const first = vi.fn(() => "complete");
    const second = vi.fn(() => "complete");
    vi.stubGlobal("navigator", {
      getGamepads: () => [
        { vibrationActuator: { playEffect: first } },
        { vibrationActuator: { playEffect: second } },
      ],
    });
    const pads = input();

    expect(pads.startJoyVibration(0.25, 0.75, 200)).toBe(true);
    expect(first).toHaveBeenCalledWith("dual-rumble", {
      duration: 200,
      strongMagnitude: 0.75,
      weakMagnitude: 0.25,
    });

    expect(pads.startJoyVibration(0.1, 0.2, 50, 1)).toBe(true);
    expect(second).toHaveBeenCalledWith("dual-rumble", {
      duration: 50,
      strongMagnitude: 0.2,
      weakMagnitude: 0.1,
    });
  });

  it("handles a promise result without an unhandled rejection", async () => {
    const playEffect = vi.fn(() => Promise.reject(new Error("no motor")));
    vi.stubGlobal("navigator", {
      getGamepads: () => [{ vibrationActuator: { playEffect } }],
    });

    expect(input().startJoyVibration(0.5, 0.5, 100)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("refuses a duration that is not a finite, non-negative number", () => {
    vi.stubGlobal("navigator", { getGamepads: () => [], vibrate: () => true });
    const pads = input();

    expect(() => pads.vibrateHandheld(-1)).toThrow(/^TN_HAPTICS_INVALID/);
    expect(() => pads.vibrateHandheld(Number.NaN)).toThrow(/^TN_HAPTICS_INVALID/);
    expect(() => pads.startJoyVibration(0.2, 0.4, Number.POSITIVE_INFINITY)).toThrow(
      /^TN_HAPTICS_INVALID/,
    );
  });
});
