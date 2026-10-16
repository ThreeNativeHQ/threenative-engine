import type { Heightfield } from "@threenative/core/world";
import { type BufferGeometry, type Matrix4, Quaternion, Vector3 } from "three";

/** Exact drawn-surface height under a world point, or `null` where this sampler cannot answer. */
export type GroundSampler = (x: number, z: number) => number | null;

/**
 * Builds the triangle-plane contact height of a `Heightfield.toGeometry()` mesh under a world point.
 *
 * It reads the drawn float32 positions and the same two-triangle split `toGeometry` emits, so a prop
 * rests on the triangle the eye sees instead of the bilinear height. `null` means outside the grid or
 * a transform this sampler does not model, and the caller keeps its raycast fallback for that.
 */
export function createGroundSampler(
  field: Heightfield,
  geometry: BufferGeometry,
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

  const position = geometry.getAttribute("position");
  const { columns, rows } = field;
  const x0 = position.getX(0);
  const z0 = position.getZ(0);
  const cellWidth = position.getX(1) - x0;
  const cellDepth = position.getZ(columns) - z0;
  if (!(cellWidth > 0) || !(cellDepth > 0)) return () => null;

  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  return (worldX, worldZ) => {
    const x = (worldX - translation.x) / scale.x;
    const z = (worldZ - translation.z) / scale.z;
    const fc = (x - x0) / cellWidth;
    const fr = (z - z0) / cellDepth;
    if (!(fc >= 0 && fr >= 0 && fc <= columns - 1 && fr <= rows - 1)) return null;
    const column = Math.min(columns - 2, Math.floor(fc));
    const row = Math.min(rows - 2, Math.floor(fr));
    const upperLeft = row * columns + column;
    const upperRight = upperLeft + 1;
    const lowerLeft = upperLeft + columns;
    const lowerRight = lowerLeft + 1;
    if (fc - column + (fr - row) <= 1) {
      a.fromBufferAttribute(position, upperLeft);
      b.fromBufferAttribute(position, lowerLeft);
      c.fromBufferAttribute(position, upperRight);
    } else {
      a.fromBufferAttribute(position, upperRight);
      b.fromBufferAttribute(position, lowerLeft);
      c.fromBufferAttribute(position, lowerRight);
    }
    const denominator = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
    if (denominator === 0) return null;
    const wa = ((b.z - c.z) * (x - c.x) + (c.x - b.x) * (z - c.z)) / denominator;
    const wb = ((c.z - a.z) * (x - c.x) + (a.x - c.x) * (z - c.z)) / denominator;
    return (wa * a.y + wb * b.y + (1 - wa - wb) * c.y) * scale.y + translation.y;
  };
}
