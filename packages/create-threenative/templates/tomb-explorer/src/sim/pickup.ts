// Taking an item (item-pickup card): a box in the item's own frame decides whether she is close
// enough, then she is walked onto the stand point and turned to face it, then the animation runs.
import { RELIC } from "../level.js";
import {
  ANGLE,
  PICKUP_FRONT,
  PICKUP_HALF_HEIGHT,
  PICKUP_HALF_WIDTH,
  PICKUP_MOVE_STEP,
  PICKUP_MOVE_TURN,
  PICKUP_STAND_DISTANCE,
  PICKUP_UPDATES,
} from "../tuning.js";
import { forward, type IBody, type IInput, rightOf } from "./body.js";

/** Her offset from the item, in the item's frame: across it, and out in front of it. */
export function itemFrame(body: IBody): { across: number; front: number } {
  const dx = body.x - RELIC.x;
  const dz = body.z - RELIC.z;
  const face = forward(RELIC.yaw);
  const side = rightOf(RELIC.yaw);
  return { across: dx * side.x + dz * side.z, front: dx * face.x + dz * face.z };
}

/** True when the box test passes. No yaw window: the item does not care which way she faces. */
export function inPickupBox(body: IBody): boolean {
  if (body.relic) return false;
  const { across, front } = itemFrame(body);
  return (
    Math.abs(across) <= PICKUP_HALF_WIDTH &&
    front >= PICKUP_FRONT[0] &&
    front <= PICKUP_FRONT[1] &&
    Math.abs(body.y - RELIC.y) <= PICKUP_HALF_HEIGHT
  );
}

/** The interaction only starts with the action key held and her standing still on the ground. */
export function tryPickup(body: IBody, input: IInput): boolean {
  if (body.state !== "idle" || !input.action || input.up || input.down || input.jump) return false;
  if (!inPickupBox(body)) return false;
  body.state = "pickup";
  body.pickup = "walk";
  body.timer = PICKUP_UPDATES;
  body.speed = 0;
  return true;
}

export function stepPickup(body: IBody): void {
  if (body.pickup === "walk") {
    const face = forward(RELIC.yaw);
    const goalX = RELIC.x + face.x * PICKUP_STAND_DISTANCE;
    const goalZ = RELIC.z + face.z * PICKUP_STAND_DISTANCE;
    const dx = goalX - body.x;
    const dz = goalZ - body.z;
    const gap = Math.hypot(dx, dz);
    if (gap > 0) {
      const move = Math.min(gap, PICKUP_MOVE_STEP);
      body.x += (dx / gap) * move;
      body.z += (dz / gap) * move;
    }
    // Turn toward the item, two degrees an update, the short way round.
    const want = Math.atan2(RELIC.x - body.x, RELIC.z - body.z);
    const diff = Math.atan2(Math.sin(want - body.yaw), Math.cos(want - body.yaw));
    const turn = PICKUP_MOVE_TURN * ANGLE;
    body.yaw += Math.max(-turn, Math.min(turn, diff));
    if (gap < 1 && Math.abs(diff) < turn) body.pickup = "grab";
    return;
  }
  body.timer -= 1;
  // The hand closes on the item halfway through the clip.
  if (body.timer === Math.floor(PICKUP_UPDATES / 2)) {
    body.relic = true;
    body.note = "relic";
  }
  if (body.timer <= 0) {
    body.state = "idle";
    body.pickup = "";
  }
}
