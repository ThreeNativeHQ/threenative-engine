import { describe, expect, it } from "vitest";
import { QualificationClock } from "../../../examples/procedural-animals/src/qualification-clock.js";
describe("portable qualification capture clock", () => {
  it("holds the real wall milestone throughout the observed four-second capture delay", () => {
    const clock = new QualificationClock();
    clock.advance(2, true, false, false);
    clock.advance(3.9833, true, false, false);
    expect(clock.elapsed).toBe(2);
    expect(clock.held).toBe(true);
  });
  it("requires an explicit advance for every original capture milestone", () => {
    const clock = new QualificationClock();
    for (const time of [2, 4.5, 11, 24.5]) {
      clock.advance(100, true, false, false);
      expect(clock.elapsed).toBe(time);
      expect(clock.held).toBe(true);
      clock.advance(0.01, true, true, false);
    }
    expect(clock.elapsed).toBe(24.5);
  });
  it("keeps posture on screen until the explicit outside action", () => {
    const clock = new QualificationClock();
    for (let i = 0; i < 3; i++) {
      clock.advance(100, true, false, false);
      clock.advance(0.01, true, true, false);
    }
    clock.advance(100, true, false, false);
    clock.advance(3.7167, true, false, false);
    expect(clock.outside).toBe(false);
    expect(clock.elapsed).toBe(24.5);
    clock.advance(0.01, true, false, true);
    expect(clock.outside).toBe(true);
  });
  it("rejects invalid delivery and premature outside actions; startup cannot advance time", () => {
    const clock = new QualificationClock();
    clock.advance(100, false, true, false);
    expect(clock.elapsed).toBe(0);
    expect(() => clock.advance(Number.NaN, true, false, false)).toThrow(/TN_ANIMAL/);
    expect(() => clock.advance(1, true, false, true)).toThrow(/TN_ANIMAL/);
  });
});
