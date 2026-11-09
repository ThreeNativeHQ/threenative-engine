import {
  BoxGeometry,
  CylinderGeometry,
  IcosahedronGeometry,
  Matrix4,
  Quaternion,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { baseRingGap, footprintGap, staticLowestY } from "../src/world.js";

function bruteLowest(geometry: IcosahedronGeometry, matrix: Matrix4): number {
  const position = geometry.getAttribute("position");
  const point = new Vector3();
  let lowest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < position.count; i++)
    lowest = Math.min(lowest, point.fromBufferAttribute(position, i).applyMatrix4(matrix).y);
  return lowest;
}

describe("static prop pose", () => {
  it("staticLowestY equals a full vertex scan, upright and tilted", () => {
    const geometry = new IcosahedronGeometry(1.5, 3);
    for (const [axis, angle] of [
      [new Vector3(0, 1, 0), 0.7],
      [new Vector3(1, 0, 0.4).normalize(), 0.5],
      [new Vector3(0, 0, 1), 2.6],
    ] as const) {
      const matrix = new Matrix4().compose(
        new Vector3(3, 7, -2),
        new Quaternion().setFromAxisAngle(axis, angle),
        new Vector3(1.2, 0.8, 1.2),
      );
      expect(staticLowestY(geometry, matrix)).toBeCloseTo(bruteLowest(geometry, matrix), 5);
    }
  });

  it("footprintGap measures the downhill side of a flat base on a slope", () => {
    // A 2 m box whose base rests at y = 1 (the uphill corner's ground), on ground y = 0.5 x.
    const box = new BoxGeometry(2, 2, 2).translate(0, 1, 0);
    const matrix = new Matrix4().makeTranslation(0, 0.5, 0);
    const gap = footprintGap(box, matrix, (x) => 0.5 * x);
    // The downhill corners sit at x = -1, where the ground is -0.5: 1 m of air.
    expect(gap).toBeCloseTo(1, 6);
    expect(footprintGap(box, matrix, (x) => 0.5 * x, 0.08)).toBeCloseTo(1.08, 6);
    expect(() => footprintGap(box, matrix, () => null)).toThrow("TN_STATIC_POSE_GROUND");
  });

  it("baseRingGap reads the rim, not a buried stem", () => {
    // A wide disc lifted 2 m above flat ground: every sector's rim hangs 2 m up.
    const disc = new CylinderGeometry(5, 5, 0.5, 48).translate(0, 2.25, 0);
    const ring = baseRingGap(disc, new Matrix4(), () => 0);
    expect(ring.samples).toBe(16);
    expect(ring.gap).toBeCloseTo(2, 6);
    expect(() => baseRingGap(disc, new Matrix4(), () => 0, { rim: 2 })).toThrow(
      "TN_STATIC_POSE_INVALID",
    );
  });
});
