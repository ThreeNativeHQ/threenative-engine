export interface DetachedMotion {
  readonly elapsed: number;
  readonly landed: boolean;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Deterministic floor-drop preview for detached props. Distances scale with the
 * host model so the lab remains useful for GLBs authored in metres or centimetres.
 */
export function detachedMotionAt(
  elapsed: number,
  floorClearance: number,
  hostHeight: number,
): DetachedMotion {
  const safeElapsed = Math.max(0, elapsed);
  const safeHeight = Math.max(hostHeight, 1e-6);
  const gravity = safeHeight * 3;
  const upwardVelocity = safeHeight * 0.08;
  const impactTime =
    (upwardVelocity +
      Math.sqrt(upwardVelocity * upwardVelocity + 2 * gravity * Math.max(0, floorClearance))) /
    gravity;
  const movingTime = Math.min(safeElapsed, impactTime);
  return {
    elapsed: movingTime,
    landed: safeElapsed >= impactTime,
    x: safeHeight * 0.35 * movingTime,
    y: Math.max(
      -Math.max(0, floorClearance),
      upwardVelocity * safeElapsed - 0.5 * gravity * safeElapsed * safeElapsed,
    ),
    z: safeHeight * 0.06 * movingTime,
  };
}
