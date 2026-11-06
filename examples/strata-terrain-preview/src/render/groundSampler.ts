import type { Heightfield } from "@threenative/core/world";
import { type BufferGeometry, type Matrix4, Quaternion, Vector3 } from "three";

/** Exact drawn-surface height under a world point, or `null` where this sampler cannot answer. */
export type GroundSampler = (x: number, z: number) => number | null;

/**
 * Wraps `Heightfield.surfaceAt` in the mesh transform the game draws the field under.
 *
 * The triangle plane itself is core's (`surfaceAt`, pinned against a raycaster on `toGeometry`), so
 * this file only maps a world point into the field's own space and answers `null` where the field
 * has no ground: outside its region, or a transform this sampler does not model.
 */
export function createGroundSampler(
  field: Heightfield,
  _geometry: BufferGeometry,
  matrixWorld: Matrix4,
): GroundSampler {
  const translation = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();
  matrixWorld.decompose(translation, rotation, scale);
  const upright =
    Math.abs(rotation.x) < 1e-6 &&
    Math.abs(rotation.y) < 1e-6 &&
    Math.abs(rotation.z) < 1e-6 &&
    Math.abs(rotation.w - 1) < 1e-6 &&
    scale.x > 0 &&
    scale.x === scale.y &&
    scale.y === scale.z;
  if (!upright) return () => null;
  const { origin, width, depth } = field;
  // A drawn vertex is float32, the field's extent is float64: the mesh's own edge can land a hair
  // outside the ground it was built from. That much is the same ground; further out is not, and
  // the caller keeps its fallback there.
  const slack = 1e-5;
  const area = {
    maxX: origin.x + width / 2,
    maxZ: origin.z + depth / 2,
    minX: origin.x - width / 2,
    minZ: origin.z - depth / 2,
  };
  return (worldX, worldZ) => {
    const x = (worldX - translation.x) / scale.x;
    const z = (worldZ - translation.z) / scale.z;
    if (
      x < area.minX - slack ||
      x > area.maxX + slack ||
      z < area.minZ - slack ||
      z > area.maxZ + slack
    )
      return null;
    const clampedX = Math.min(area.maxX, Math.max(area.minX, x));
    const clampedZ = Math.min(area.maxZ, Math.max(area.minZ, z));
    return field.surfaceAt(clampedX, clampedZ) * scale.y + translation.y;
  };
}
