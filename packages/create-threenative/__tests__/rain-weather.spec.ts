import { describe, expect, it } from "vitest";
import {
  PRESETS,
  type Weather,
  easeWeather,
  flashAt,
  intentPatch,
  preset,
  thunderDelay,
} from "../templates/rain/src/state.js";

const storm = (): Weather => preset("storm");

describe("rain weather intents", () => {
  it("routes every UI toggle to the state field it names", () => {
    const fields = [
      ["setAudioEnabled", "audioEnabled"],
      ["setAutoLightning", "autoLightning"],
      ["setCinematic", "cinematic"],
      ["setDroplets", "droplets"],
      ["setFrozen", "frozen"],
      ["setMuted", "muted"],
    ] as const;
    for (const [intent, field] of fields) {
      expect(intentPatch(intent, true, storm())).toEqual({ [field]: true });
      expect(intentPatch(intent, false, storm())).toEqual({ [field]: false });
    }
  });

  it("takes automatic lightning down with photosensitivity mode, at the one door", () => {
    expect(intentPatch("setSafe", true, storm())).toEqual({ autoLightning: false, safe: true });
    expect(intentPatch("setSafe", false, storm())).toEqual({ safe: false });
  });

  it("rejects a toggle that is not a boolean", () => {
    expect(() => intentPatch("setSafe", "true", storm())).toThrow();
    for (const name of ["toString", "__proto__", "constructor"]) {
      expect(() => intentPatch(name, true, storm())).toThrow();
    }
  });

  it("accepts only own preset names, not inherited keys", () => {
    expect(intentPatch("setPreset", "drizzle", storm())).toEqual({
      preset: "drizzle",
      target: { ...PRESETS.drizzle },
    });
    for (const name of ["toString", "__proto__", "constructor", "STORM", ""]) {
      expect(() => intentPatch("setPreset", name, storm())).toThrow();
    }
  });

  it("clamps valid weather channels onto the current target", () => {
    const target = intentPatch("setWeather", { rain: 4, exposure: -1, cloud: 0.5 }, storm()).target;
    expect(target?.rain).toBe(1);
    expect(target?.exposure).toBe(0.3);
    expect(target?.cloud).toBe(0.5);
    expect(target?.wind).toBe(PRESETS.storm.wind);
  });

  it("rejects a malformed weather payload whole, leaving nothing half-applied", () => {
    const base = storm();
    for (const payload of [
      { rain: null },
      { rain: true },
      { rain: "0.5" },
      { rain: Number.NaN },
      { rain: Number.POSITIVE_INFINITY },
      { rain: 0.5, cloud: undefined },
      { rainfall: 0.5 },
    ]) {
      expect(() => intentPatch("setWeather", payload, base)).toThrow();
    }
    // The base the caller passed is untouched, so a rejected drag moves nothing.
    expect(base).toEqual(PRESETS.storm);
  });

  it("publishes the requests the scene consumes", () => {
    expect(intentPatch("strike", undefined, storm())).toEqual({ strikeRequested: true });
    expect(intentPatch("resetCamera", undefined, storm())).toEqual({
      cameraReset: true,
      cinematic: false,
    });
    expect(intentPatch("pause", undefined, storm())).toEqual({ paused: true });
    expect(intentPatch("resume", undefined, storm())).toEqual({ paused: false });
    expect(intentPatch("step", 0.5, storm())).toEqual({ stepRequest: 0.5 });
    expect(intentPatch("step", 600, storm())).toEqual({ stepRequest: 60 });
    expect(intentPatch("step", -1, storm())).toEqual({ stepRequest: 0 });
    expect(() => intentPatch("step", "0.5", storm())).toThrow();
    expect(() => intentPatch("step", Number.NaN, storm())).toThrow();
    expect(() => intentPatch("setWeather", "storm", storm())).toThrow();
    expect(() => intentPatch("teleport", true, storm())).toThrow();
  });
});

describe("rain weather maths", () => {
  it("eases towards the target without overshooting it", () => {
    const from = preset("drizzle");
    const to = preset("supercell");
    const eased = easeWeather(from, to, 1 / 60);
    expect(eased.rain).toBeGreaterThan(from.rain);
    expect(eased.rain).toBeLessThan(to.rain);
  });

  it("flashes hard right after a strike and not a second later", () => {
    expect(flashAt(0.1)).toBeGreaterThan(0.5);
    expect(flashAt(0.21)).toBeGreaterThan(flashAt(0.6));
    expect(flashAt(2)).toBe(0);
    expect(flashAt(-1)).toBe(0);
  });

  it("delays thunder by the distance the strike crossed", () => {
    expect(thunderDelay(343)).toBeCloseTo(1, 10);
    expect(thunderDelay(-5)).toBe(0);
    expect(thunderDelay(Number.NaN)).toBe(0);
  });
});
