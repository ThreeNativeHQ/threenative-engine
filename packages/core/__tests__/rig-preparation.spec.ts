import { Matrix4 } from "three";
import { describe, expect, it } from "vitest";
import { uniformYawScale } from "../src/rig-preparation.js";

describe("uniformYawScale", () => {
  it("returns the scale for a uniform, yaw-only, untilted matrix", () => {
    const yaw = new Matrix4().makeRotationY(Math.PI / 6);
    const matrix = new Matrix4().makeScale(2, 2, 2).multiply(yaw);
    expect(uniformYawScale(matrix)).toBeCloseTo(2, 6);
  });

  it("gives undefined for a non-uniform or pitched matrix", () => {
    const nonUniform = new Matrix4().makeScale(1, 1.2, 1);
    expect(uniformYawScale(nonUniform)).toBeUndefined();

    const pitched = new Matrix4().makeRotationX(Math.PI / 5);
    expect(uniformYawScale(pitched)).toBeUndefined();

    const rolled = new Matrix4().makeRotationZ(Math.PI / 5);
    expect(uniformYawScale(rolled)).toBeUndefined();

    const mirrored = new Matrix4().makeScale(-1, 1, 1);
    expect(uniformYawScale(mirrored)).toBeUndefined();
  });
});
