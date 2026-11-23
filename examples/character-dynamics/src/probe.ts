/**
 * Pure measurement math for the character-dynamics scene (PRD-910).
 * No scene objects: callers pass plain arrays and world-space vectors.
 */
import { type Quaternion, Vector3 } from "three";

/** A world-space capsule a probe counts against; `a === b` is a sphere. */
export interface IProbeCapsule {
  a: Vector3;
  b: Vector3;
  radius: number;
}

/** Largest edge stretch, as a fraction of rest length; never below zero. */
export function maxEdgeStretch(
  positions: ArrayLike<number>,
  springs: ArrayLike<number>,
  restLengths: ArrayLike<number>,
): number {
  let stretch = 0;
  for (let s = 0; s < springs.length; s += 2) {
    const i = springs[s] as number;
    const j = springs[s + 1] as number;
    const length = Math.hypot(
      (positions[i * 3] as number) - (positions[j * 3] as number),
      (positions[i * 3 + 1] as number) - (positions[j * 3 + 1] as number),
      (positions[i * 3 + 2] as number) - (positions[j * 3 + 2] as number),
    );
    stretch = Math.max(stretch, length / (restLengths[s / 2] as number) - 1);
  }
  return stretch;
}

/** Mean position of the vertices listed in `indices`. */
export function centroid(positions: ArrayLike<number>, indices: ArrayLike<number>): Vector3 {
  const center = new Vector3();
  for (let k = 0; k < indices.length; k++) {
    const v = indices[k] as number;
    center.x += positions[v * 3] as number;
    center.y += positions[v * 3 + 1] as number;
    center.z += positions[v * 3 + 2] as number;
  }
  return center.divideScalar(indices.length);
}

/** Angle between top->hem and world down, degrees. */
export function trailAngleDegrees(topWorld: Vector3, hemWorld: Vector3): number {
  const drop = hemWorld.clone().sub(topWorld).normalize();
  return (Math.acos(Math.min(1, Math.max(-1, -drop.y))) * 180) / Math.PI;
}

/** Distance from p to segment ab; a zero-length segment (a === b) is a point. */
export function segmentDistance(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const lengthSq = ab.lengthSq();
  if (lengthSq < 1e-12) return p.distanceTo(a);
  const t = Math.min(1, Math.max(0, p.clone().sub(a).dot(ab) / lengthSq));
  return p.distanceTo(a.clone().addScaledVector(ab, t));
}

/** `point` in the frame at `origin` with `orientation`, same units as `point`. */
export function toFrame(point: Vector3, origin: Vector3, orientation: Quaternion): Vector3 {
  return point.clone().sub(origin).applyQuaternion(orientation.clone().invert());
}

/** Largest |segment length / rest length - 1| between consecutive points; never below zero. */
export function maxSegmentStretch(
  positions: ArrayLike<number>,
  restLengths: ArrayLike<number>,
): number {
  let stretch = 0;
  for (let i = 0; i < restLengths.length; i++) {
    const length = Math.hypot(
      (positions[i * 3] as number) - (positions[(i + 1) * 3] as number),
      (positions[i * 3 + 1] as number) - (positions[(i + 1) * 3 + 1] as number),
      (positions[i * 3 + 2] as number) - (positions[(i + 1) * 3 + 2] as number),
    );
    stretch = Math.max(stretch, Math.abs(length / (restLengths[i] as number) - 1));
  }
  return stretch;
}

/** Number of points closer than `radius` to segment ab. */
export function countInsideCapsule(
  worldPositions: ArrayLike<number>,
  a: Vector3,
  b: Vector3,
  radius: number,
): number {
  let inside = 0;
  const p = new Vector3();
  for (let v = 0; v < worldPositions.length / 3; v++) {
    p.set(
      worldPositions[v * 3] as number,
      worldPositions[v * 3 + 1] as number,
      worldPositions[v * 3 + 2] as number,
    );
    if (segmentDistance(p, a, b) < radius) inside++;
  }
  return inside;
}

/**
 * Number of points closer than `radius - shrink` to any capsule, each point counted once.
 * `a === b` is a sphere.
 */
export function countInsideCapsules(
  worldPositions: ArrayLike<number>,
  capsules: readonly IProbeCapsule[],
  shrink = 0,
): number {
  let inside = 0;
  const p = new Vector3();
  for (let v = 0; v < worldPositions.length / 3; v++) {
    p.set(
      worldPositions[v * 3] as number,
      worldPositions[v * 3 + 1] as number,
      worldPositions[v * 3 + 2] as number,
    );
    for (const capsule of capsules) {
      if (segmentDistance(p, capsule.a, capsule.b) < capsule.radius - shrink) {
        inside++;
        break;
      }
    }
  }
  return inside;
}
