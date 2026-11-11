import { Matrix4, Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { Heightfield, surfaceSampler } from "../src/world.js";

const field = Heightfield.fromSampler({
  columns: 9,
  depth: 16,
  origin: { x: 0, z: 0 },
  rows: 9,
  sampleHeight: (x: number, z: number) => x * 0.5 + z * z * 0.1,
  width: 16,
});

describe("surfaceSampler", () => {
  it("answers the drawn surface under a moved, uniformly scaled mesh", () => {
    const matrix = new Matrix4().compose(
      new Vector3(100, 5, -40),
      new Quaternion(),
      new Vector3(2, 2, 2),
    );
    const ground = surfaceSampler(field, matrix);
    expect(ground(100 + 2 * 3, -40 + 2 * 1.5)).toBeCloseTo(field.surfaceAt(3, 1.5) * 2 + 5, 6);
    // Outside the field there is no ground to answer for.
    expect(ground(100 + 2 * 9, -40)).toBeNull();
  });

  it("declines a rotated or unevenly scaled mesh", () => {
    const turned = new Matrix4().makeRotationY(0.3);
    expect(surfaceSampler(field, turned)(0, 0)).toBeNull();
    const stretched = new Matrix4().makeScale(1, 2, 1);
    expect(surfaceSampler(field, stretched)(0, 0)).toBeNull();
  });
});
