import { Vector3 } from "three";

/** Shared translation keeps all separate collision spheres away from the wall and each other. */
export function performanceOrigin(index: number, count: number, radius: number): Vector3 {
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= count ||
    ![1, 32].includes(count) ||
    !Number.isFinite(radius) ||
    radius <= 0
  )
    throw new Error("TN_ANIMAL_PERFORMANCE_PATH_INPUT");
  if (count === 1) return new Vector3(0, 0, 1);
  return new Vector3(
    ((index % 8) - 3.5) * radius * 3,
    0,
    (Math.floor(index / 8) - 1.5) * radius * 3 + 1,
  );
}
export function performanceVelocity(
  position: Vector3,
  origin: Vector3,
  elapsed: number,
  radius: number,
  target: Vector3,
): Vector3 {
  if (
    !Number.isFinite(elapsed) ||
    elapsed < 0 ||
    !Number.isFinite(radius) ||
    radius <= 0 ||
    ![position.x, position.z, origin.x, origin.z].every(Number.isFinite)
  )
    throw new Error("TN_ANIMAL_PERFORMANCE_PATH_INPUT");
  const phase = elapsed / radius;
  const orbit = radius * 0.35;
  return target.set(
    0.35 * Math.cos(phase) + (origin.x + orbit * Math.sin(phase) - position.x) * 4,
    0,
    0.35 * Math.sin(phase) + (origin.z + orbit * (1 - Math.cos(phase)) - position.z) * 4,
  );
}
