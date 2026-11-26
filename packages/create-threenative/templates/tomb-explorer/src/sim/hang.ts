// Hanging from a ledge: shimmy along it, pull up onto it, let go. The ledge is re-tested at every
// step, so a corner or an end stops her (climb-shimmy card).
import { SOLID, ceilingAt, floorAt } from "../level.js";
import {
  BODY_RADIUS,
  CLIMB_DEPTH,
  CLIMB_UPDATES,
  HANG_OFFSET,
  PULL_UP_HEADROOM,
  SECTOR,
  SHIMMY_SPEED,
  SLOPE_TOLERANCE,
} from "../tuning.js";
import { fall } from "./air.js";
import { type IBody, type IInput, cardinal, cellOf, rightOf } from "./body.js";

export function stepHang(body: IBody, input: IInput): void {
  const hang = body.hang;
  if (hang === undefined) {
    fall(body);
    return;
  }
  // Letting go of the action key drops her.
  if (!input.action) {
    body.hang = undefined;
    body.note = "let-go";
    fall(body);
    return;
  }
  const along = cardinal(hang.dir);
  const front = (x: number, z: number): { x: number; z: number } => ({
    x: x + along.x * (HANG_OFFSET + 60),
    z: z + along.z * (HANG_OFFSET + 60),
  });

  if (input.up) {
    const at = front(body.x, body.z);
    if (ceilingAt(at.x, at.z) - hang.top < PULL_UP_HEADROOM) {
      body.note = "no-room";
      body.state = "hang";
      return;
    }
    body.state = "climb";
    body.timer = CLIMB_UPDATES;
    hang.fromX = body.x;
    hang.fromZ = body.z;
    hang.fromY = body.y;
    return;
  }

  const sideways = input.right === input.left ? 0 : input.right ? 1 : -1;
  body.state = "hang";
  if (sideways === 0) return;
  const right = rightOf(body.yaw);
  const nx = body.x + right.x * sideways * SHIMMY_SPEED;
  const nz = body.z + right.z * sideways * SHIMMY_SPEED;
  const ahead = front(nx, nz);
  const lead = {
    x: nx + right.x * sideways * BODY_RADIUS,
    z: nz + right.z * sideways * BODY_RADIUS,
  };
  const ahead2 = front(lead.x, lead.z);
  const top = floorAt(ahead.x, ahead.z);
  const top2 = floorAt(ahead2.x, ahead2.z);
  // The ledge must continue under both hands and her side must be free air.
  const holds =
    top < SOLID &&
    top2 < SOLID &&
    Math.abs(top - hang.top) <= SLOPE_TOLERANCE &&
    Math.abs(top2 - hang.top) <= SLOPE_TOLERANCE &&
    floorAt(lead.x, lead.z) <= body.y;
  if (!holds) return;
  body.x = nx;
  body.z = nz;
  body.state = "shimmy";
}

/** The pull-up and the vault: blend from where she started to standing on the ledge. */
export function stepClimb(body: IBody): void {
  const hang = body.hang;
  if (hang === undefined) {
    fall(body);
    return;
  }
  body.timer -= 1;
  const t = 1 - Math.max(0, body.timer) / CLIMB_UPDATES;
  const along = cardinal(hang.dir);
  // The end is on the far side of the wall face, `CLIMB_DEPTH` onto the ledge.
  const face =
    along.x !== 0
      ? (along.x > 0 ? cellOf(hang.fromX) + 1 : cellOf(hang.fromX)) * SECTOR
      : (along.z > 0 ? cellOf(hang.fromZ) + 1 : cellOf(hang.fromZ)) * SECTOR;
  const endX = along.x !== 0 ? face + along.x * CLIMB_DEPTH : hang.fromX;
  const endZ = along.z !== 0 ? face + along.z * CLIMB_DEPTH : hang.fromZ;
  // Up first (the first 60 percent), then over.
  const up = Math.min(1, t / 0.6);
  const over = Math.max(0, (t - 0.6) / 0.4);
  body.y = hang.fromY + (hang.top - hang.fromY) * up;
  body.x = hang.fromX + (endX - hang.fromX) * over;
  body.z = hang.fromZ + (endZ - hang.fromZ) * over;
  if (body.timer > 0) return;
  body.y = hang.top;
  body.x = endX;
  body.z = endZ;
  body.hang = undefined;
  body.state = "idle";
  body.speed = 0;
  body.note = "climbed";
}
