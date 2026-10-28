import { describe, expect, it } from "vitest";
import { detachedMotionAt } from "../src/client/detached-motion.js";

describe("Pose Lab detached motion", () => {
  it("falls to the floor and stops translating after impact", () => {
    const release = detachedMotionAt(0, 1, 2);
    const impact = detachedMotionAt(2, 1, 2);
    const settled = detachedMotionAt(4, 1, 2);

    expect(release).toEqual({ elapsed: 0, landed: false, x: 0, y: 0, z: 0 });
    expect(impact.y).toBe(-1);
    expect(impact.landed).toBe(true);
    expect(settled.y).toBe(-1);
    expect(settled.x).toBe(impact.x);
    expect(settled.z).toBe(impact.z);
  });

  it("scales the preview motion to the host model", () => {
    expect(detachedMotionAt(0.25, 100, 100).x).toBeCloseTo(8.75);
    expect(detachedMotionAt(0.25, 1, 1).x).toBeLessThan(0.09);
  });
});
