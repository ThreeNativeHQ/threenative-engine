import type { Quaternion } from "three";

/**
 * Checked reads from the bulk step buffers.
 *
 * The plugin moves kinematic input and visible transforms through shared Float32Arrays so the
 * fixed-step crossing stays bulk-shaped and never per-object per-frame. Reading a record used to
 * mean an `Array.from` plus a closure per body per step; these helpers index the buffer directly
 * and throw exactly where the old helper threw — on the first malformed slot, in slot order.
 */

export function bulkTransformValue(values: Readonly<Float32Array>, index: number): number {
  const value = values[index];
  if (value === undefined || !Number.isFinite(value))
    throw new Error("IPhysicsSimulation returned a malformed transform.");
  return value;
}

/**
 * Assigns a solved rotation only when it differs from the object's current one. Three.js
 * `Quaternion.set()` fires its change callback even for identical components, and on the web
 * engine that callback crosses into the native runtime. `Object.is` preserves signed zero, and
 * comparing against the live object still corrects edits made outside physics.
 */
export function setRotationIfChanged(
  quaternion: Quaternion,
  x: number,
  y: number,
  z: number,
  w: number,
): void {
  if (
    Object.is(quaternion.x, x) &&
    Object.is(quaternion.y, y) &&
    Object.is(quaternion.z, z) &&
    Object.is(quaternion.w, w)
  )
    return;
  quaternion.set(x, y, z, w);
}
