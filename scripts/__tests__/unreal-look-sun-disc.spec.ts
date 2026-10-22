import { describe, expect, it } from "vitest";
import { unrealSunDiscScale } from "../unreal-look/scaffold/render/shadowTier.js";

// The harness sun direction, as Reference.ts sets it from `sun=<elevation>,<azimuth>`.
const sun = (elevationDeg: number, azimuthDeg: number) => {
  const el = (elevationDeg * Math.PI) / 180;
  const az = (azimuthDeg * Math.PI) / 180;
  return { x: Math.sin(az) * Math.cos(el) };
};

describe("unrealSunDiscScale (PRD-634, Unreal's un-normalised sun disc)", () => {
  it("is the sine of the angle between the sun and Unreal's X axis", () => {
    expect(unrealSunDiscScale(sun(15, 90))).toBeCloseTo(Math.sin((15 * Math.PI) / 180), 6);
    expect(unrealSunDiscScale(sun(90, 0))).toBeCloseTo(1, 6);
    expect(unrealSunDiscScale(sun(60, 0))).toBeCloseTo(1, 6);
  });

  it("gives the reference poses (azimuth 25) most of the nominal disc", () => {
    expect(unrealSunDiscScale(sun(15, 25))).toBeCloseTo(0.9128, 3);
    expect(unrealSunDiscScale(sun(4, 25))).toBeCloseTo(0.9068, 3);
  });

  it("stays a real number on the X axis itself", () => {
    expect(unrealSunDiscScale({ x: 1 + 1e-9 })).toBe(0);
  });
});
