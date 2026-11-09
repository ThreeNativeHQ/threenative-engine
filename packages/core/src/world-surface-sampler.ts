import { type Matrix4, Quaternion, Vector3 } from "three";
import type { Heightfield } from "./world-heightfield.js";

/** The drawn surface's height under a world point, or `null` where the sampler cannot answer. */
export type SurfaceSampler = (x: number, z: number) => number | null;

/**
 * `Heightfield.surfaceAt` under the transform the game draws the field's mesh with, so a prop or a
 * player stands on the triangles the eye sees rather than on the bilinear field between them.
 * Answers `null` outside the field and for a transform it does not model (any rotation, or an
 * unequal scale), so the caller keeps its own fallback there.
 *
 * @situation stand props or a player on the drawn terrain triangles under a moved or scaled mesh
 * @situation props float or sink where the terrain mesh is drawn under a transform
 * @constraint the mesh is `field.toGeometry()` drawn upright under a uniform scale; read `matrixWorld` after it settles
 * @example const ground = surfaceSampler(field, mesh.matrixWorld); const y = ground(x, z) ?? fallback;
 */
export function surfaceSampler(field: Heightfield, matrixWorld: Matrix4): SurfaceSampler {
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
  // A drawn vertex is float32 and the field's extent float64: the mesh's own edge can land a hair
  // outside the ground it was built from. That much is the same ground; further out is not.
  const slack = 1e-5;
  const minX = origin.x - width / 2;
  const maxX = origin.x + width / 2;
  const minZ = origin.z - depth / 2;
  const maxZ = origin.z + depth / 2;
  return (worldX, worldZ) => {
    const x = (worldX - translation.x) / scale.x;
    const z = (worldZ - translation.z) / scale.z;
    if (x < minX - slack || x > maxX + slack || z < minZ - slack || z > maxZ + slack) return null;
    const clampedX = Math.min(maxX, Math.max(minX, x));
    const clampedZ = Math.min(maxZ, Math.max(minZ, z));
    return field.surfaceAt(clampedX, clampedZ) * scale.y + translation.y;
  };
}
