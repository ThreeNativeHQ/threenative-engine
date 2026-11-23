import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  centroid,
  countInsideCapsule,
  maxEdgeStretch,
  segmentDistance,
  trailAngleDegrees,
} from "../src/probe.js";

describe("probe math", () => {
  it("measures the largest edge stretch", () => {
    const positions = [0, 0, 0, 1.5, 0, 0, 0, 1, 0, 1.5, 1, 0];
    const springs = [0, 1, 2, 3];
    const restLengths = [1, 1];
    expect(maxEdgeStretch(positions, springs, restLengths)).toBeCloseTo(0.5);
  });

  it("finds the centroid of selected vertices", () => {
    const positions = [0, 0, 0, 1.5, 0, 0, 0, 1, 0, 1.5, 1, 0];
    const center = centroid(positions, [0, 2]);
    expect(center.x).toBeCloseTo(0);
    expect(center.y).toBeCloseTo(0.5);
    expect(center.z).toBeCloseTo(0);
  });

  it("measures trail against world down", () => {
    const top = new Vector3(0, 1, 0);
    expect(trailAngleDegrees(top, new Vector3(0, 0, 0))).toBeCloseTo(0);
    expect(trailAngleDegrees(top, new Vector3(1, 1, 0))).toBeCloseTo(90);
    expect(trailAngleDegrees(top, new Vector3(1, 0, 0))).toBeCloseTo(45);
  });

  it("counts points inside a capsule", () => {
    const points = [0, 0.5, 0.05, 0, 0.5, 0.2, 0, 1.05, 0, 0, -0.2, 0];
    expect(countInsideCapsule(points, new Vector3(0, 0, 0), new Vector3(0, 1, 0), 0.1)).toBe(2);
  });

  it("measures distance to a segment", () => {
    expect(
      segmentDistance(new Vector3(0, 0.5, 0.2), new Vector3(0, 0, 0), new Vector3(0, 1, 0)),
    ).toBeCloseTo(0.2);
  });
});
