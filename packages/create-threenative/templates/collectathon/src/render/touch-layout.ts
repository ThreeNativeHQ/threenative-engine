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

export type TouchButton = "attack" | "crouch" | "jump";
type TouchControlName = TouchButton | "move";

/** Jump nearest the thumb's rest, attack beside it, crouch above them: one thumb rolls across all three. */
const BUTTON_SLOTS: Record<TouchButton, readonly [number, number]> = {
  attack: [1, 0],
  crouch: [0.5, 1],
  jump: [0, 0],
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
  readonly attackPressed: boolean;
  readonly crouchHeld: boolean;
  readonly crouchPressed: boolean;
  readonly jumpHeld: boolean;
  readonly jumpPressed: boolean;
  readonly move: Vector2;
}
