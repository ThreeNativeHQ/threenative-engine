import { Vector2 } from "three";

/**
 * Where the on-screen controls sit. Pure geometry: no Three.js objects, no scene, so a test can
 * check the maths without a renderer.
 */

export const MOVE_RADIUS = 72;
export const BUTTON_RADIUS = 58;
const EDGE = 36;

export interface ITouchPointer {
  readonly position: Vector2;
}

export interface ITouchViewport {
  readonly height: number;
  readonly width: number;
}

export type TouchButton = "accel" | "drift" | "item";
type TouchControlName = TouchButton | "move";

/** Accelerate under the thumb's rest, drift beside it, the item above them: the thumb holds
 * accelerate and rolls onto drift without letting go. */
const BUTTON_SLOTS: Record<TouchButton, readonly [number, number]> = {
  accel: [0, 0],
  drift: [1, 0],
  item: [0.5, 1],
};

export function touchControlPoint(size: ITouchViewport, name: TouchControlName): Vector2 {
  if (name === "move") return new Vector2(MOVE_RADIUS + EDGE, size.height - MOVE_RADIUS - EDGE);
  const [column, row] = BUTTON_SLOTS[name];
  const step = BUTTON_RADIUS * 2 + 16;
  return new Vector2(
    size.width - BUTTON_RADIUS - EDGE - column * step,
    size.height - BUTTON_RADIUS - EDGE - row * step,
  );
}

export interface ITouchInput {
  readonly accelHeld: boolean;
  readonly driftHeld: boolean;
  readonly itemPressed: boolean;
  /** x steers; y below −0.5 brakes. */
  readonly move: Vector2;
}
