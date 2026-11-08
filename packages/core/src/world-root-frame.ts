import { type Camera, Matrix4, type Vector3 } from "three";

/**
 * The world's own records and the camera are in two different frames, and this is where they meet.
 *
 * `WorldCells` is an `Object3D`, and every placement, cell volume, terrain tile and GPU record under
 * it is written in the package's own coordinates — the root's local frame. A camera is in world
 * space. A game may move the root (`world.position.y = -11.45` sinks the whole ring), so a per-frame
 * read that compares the two has to be taken in the root's frame: clip space from a local point is
 * `projection × view × root`, and a world point read locally is the camera's world position through
 * the root's inverse world matrix.
 *
 * The unmoved root is the common case, and it is free: its `matrixWorld` is the identity, so the
 * multiply and the inverse are skipped and the numbers are exactly the ones they always were, with
 * no scratch vector or matrix allocated either way.
 */

/** The root's inverse world matrix, reused per read. */
const _inverse = new Matrix4();

/** Whether `matrix` is exactly the identity, so a local-frame read is the read it always was. */
function isIdentity(matrix: Matrix4): boolean {
  const elements = matrix.elements;
  for (let at = 0; at < 16; at += 1) if (elements[at] !== (at % 5 === 0 ? 1 : 0)) return false;
  return true;
}

/** `projection × view × root` into `out`: clip space, from a point in the root's local frame. */
export function localClip(out: Matrix4, camera: Camera, root: Matrix4 | undefined): Matrix4 {
  out.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  if (root === undefined || isIdentity(root)) return out;
  return out.multiply(root);
}

/** `point`, in world space, read in the root's local frame — in place, so a frame allocates nothing. */
export function localPoint(point: Vector3, root: Matrix4 | undefined): Vector3 {
  if (root === undefined || isIdentity(root)) return point;
  return point.applyMatrix4(_inverse.copy(root).invert());
}
