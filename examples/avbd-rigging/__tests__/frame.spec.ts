import { describe, expect, it } from "vitest";
import { fromSolverPoint, toSolverPoint, toSolverRotation } from "../src/physics/frame.js";
import { rotate, vec3 } from "../src/physics/vendor/avbd3d/ref/math.js";

describe("explicit pinned solver coordinate bridge", () => {
  it("round-trips metre-scale authored points and gravity", () => {
    for (const p of [
      [0, 0, 0],
      [-2, 7, 0.5],
      [100, -20, 9],
    ] as [number, number, number][])
      expect(fromSolverPoint(toSolverPoint(p))).toEqual(p);
    expect(toSolverPoint([0, -9.81, 0])).toEqual([0, -0, -9.81]);
  });
  it("turns local sail normal into the pinned xy wind plane without changing its geometry", () => {
    const q = toSolverRotation([0, 0, 0, 1]);
    const normal = rotate(vec3(), q, [0, 0, 1]);
    expect(normal[0]).toBe(0);
    expect(normal[1]).toBeCloseTo(-1, 12);
    expect(normal[2]).toBeCloseTo(0, 12);
    expect(fromSolverPoint([0, -1, 0])).toEqual([0, 0, 1]);
  });
});
