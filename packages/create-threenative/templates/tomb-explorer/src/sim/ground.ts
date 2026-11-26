// On her feet: the turn ramp, the three gaits, steps, edges, and the two ways a jump starts.
import { floorAt, SOLID, waterAt } from "../level.js";
import {
  BACK_SPEED,
  BODY_RADIUS,
  COMPRESS_UPDATES,
  DIRECTION_PROBE,
  GROUND_ACCEL,
  JUMP_RISE,
  RUN_JUMP_SPEED,
  RUN_SPEED,
  RUN_TURN_CAP,
  STAND_JUMP_SPEED,
  STEP,
  SWIM_DEPTH,
  WALK_SPEED,
  WALK_TURN_CAP,
} from "../tuning.js";
import { addTurn, forward, type IBody, type IInput, passable } from "./body.js";
import { fall, launch } from "./air.js";
import { enterWater } from "./swim.js";

/** Three probe points across her width: a wall catches her whichever edge meets it first. */
function clearAt(x: number, z: number, feet: number, alongX: boolean, safe: boolean): boolean {
  for (const side of [-BODY_RADIUS, 0, BODY_RADIUS]) {
    const px = alongX ? x : x + side;
    const pz = alongX ? z + side : z;
    if (!passable(px, pz, feet, STEP)) return false;
  }
  // The walk key never steps off an edge: the floor ahead may not drop away by more than a step.
  return !safe || floorAt(x, z) >= feet - STEP;
}

export function stepGround(body: IBody, input: IInput): void {
  const running = input.up && !input.walk;
  addTurn(body, input.left, input.right, running ? RUN_TURN_CAP : WALK_TURN_CAP);

  if (input.jumpEdge) {
    // A running press launches at once. A standing press compresses first (jump card, jump.c:20).
    if (running && body.speed >= WALK_SPEED) {
      launch(body, JUMP_RISE, RUN_JUMP_SPEED);
      return;
    }
    body.state = "compress";
    body.timer = COMPRESS_UPDATES;
    body.speed = 0;
    return;
  }

  const target = input.up ? (input.walk ? WALK_SPEED : RUN_SPEED) : input.down ? -BACK_SPEED : 0;
  body.speed += Math.max(-GROUND_ACCEL, Math.min(GROUND_ACCEL, target - body.speed));
  moveGround(body, input.walk);
  body.state =
    target === 0 && Math.abs(body.speed) < 1
      ? "idle"
      : target < 0
        ? "back"
        : input.walk
          ? "walk"
          : "run";
  settle(body);
}

/** Move along the facing, one axis at a time, so a wall slides her instead of stopping her dead. */
export function moveGround(body: IBody, safe: boolean): void {
  const heading = forward(body.yaw);
  const dx = heading.x * body.speed;
  const dz = heading.z * body.speed;
  if (dx !== 0) {
    const edge = body.x + dx + Math.sign(dx) * BODY_RADIUS;
    if (clearAt(edge, body.z, body.y, true, safe)) body.x += dx;
  }
  if (dz !== 0) {
    const edge = body.z + dz + Math.sign(dz) * BODY_RADIUS;
    if (clearAt(body.x, edge, body.y, false, safe)) body.z += dz;
  }
}

/** Stand on whatever is under her; walk off an edge into a fall; wade into deep water and swim. */
export function settle(body: IBody): void {
  const floor = floorAt(body.x, body.z);
  if (floor >= SOLID) return;
  if (floor < body.y - STEP) {
    fall(body);
    return;
  }
  body.y = floor;
  const plane = waterAt(body.x, body.z);
  if (plane !== undefined && plane - floor > SWIM_DEPTH && plane - body.y >= STEP)
    enterWater(body, false);
}

/**
 * The compression before a standing jump. She picks the direction from what is held, then probes
 * the floor one step that way: a wall there turns the jump straight up, so she cannot jump into it
 * (jump card: directionProbeDistance 256, stepUpAllowance 384).
 */
export function stepCompress(body: IBody, input: IInput): void {
  body.timer -= 1;
  if (body.timer > 0) return;
  let speed = input.up ? STAND_JUMP_SPEED : input.down ? -STAND_JUMP_SPEED : 0;
  const heading = forward(body.yaw);
  const ahead = Math.sign(speed) * DIRECTION_PROBE;
  if (
    speed !== 0 &&
    floorAt(body.x + heading.x * ahead, body.z + heading.z * ahead) - body.y > STEP
  )
    speed = 0;
  launch(body, JUMP_RISE, speed);
}
