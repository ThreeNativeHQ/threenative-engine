import { Quaternion, Vector3 } from "three";
import { describe, expect, it } from "vitest";
import {
  centroid,
  countInsideCapsule,
  countInsideCapsules,
  maxEdgeStretch,
  maxSegmentStretch,
  segmentDistance,
  toFrame,
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

  it("expresses a point in a translated and rotated frame", () => {
    const yaw = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
    const turned = toFrame(new Vector3(1, 1, 0), new Vector3(0, 1, 0), yaw);
    expect(turned.x).toBeCloseTo(0);
    expect(turned.y).toBeCloseTo(0);
    expect(turned.z).toBeCloseTo(1);
    const moved = toFrame(new Vector3(2, 1, 0), new Vector3(1, 1, 0), new Quaternion());
    expect(moved.x).toBeCloseTo(1);
    expect(moved.y).toBeCloseTo(0);
  });

  it("measures absolute segment stretch, compression included", () => {
    const positions = [0, 0, 0, 1, 0, 0, 0.5, 0, 0];
    expect(maxSegmentStretch(positions, [1, 1])).toBeCloseTo(0.5);
  });

  it("counts each point once across overlapping capsules", () => {
    const points = [0, 0.5, 0.05, 0, 0.5, 0.2, 0, 1.6, 0];
    const capsules = [
      { a: new Vector3(0, 0, 0), b: new Vector3(0, 1, 0), radius: 0.1 },
      { a: new Vector3(0, 0.5, 0), b: new Vector3(0, 0.5, 0), radius: 0.3 },
    ];
    expect(countInsideCapsules(points, capsules)).toBe(2);
    expect(countInsideCapsules(points, capsules, 0.15)).toBe(1);
  });
});
