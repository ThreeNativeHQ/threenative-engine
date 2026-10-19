/** Proper rotation about +x: ThreeNative y-up to the pinned donor's z-up wind/force frame. */
export function toSolverPoint(point: readonly [number, number, number]): [number, number, number] {
  return [point[0], -point[2], point[1]];
}
export function fromSolverPoint(
  point: readonly [number, number, number],
): [number, number, number] {
  return [point[0], point[2], -point[1]];
}
export function toSolverRotation(rotation: readonly number[]): [number, number, number, number] {
  const [x, y, z, w] = rotation;
  if (
    x === undefined ||
    y === undefined ||
    z === undefined ||
    w === undefined ||
    rotation.length !== 4
  )
    throw new Error("TN_AVBD_FRAME: quaternion requires four components.");
  const s = Math.SQRT1_2;
  return [(x + w) * s, (y - z) * s, (z + y) * s, (w - x) * s];
}
