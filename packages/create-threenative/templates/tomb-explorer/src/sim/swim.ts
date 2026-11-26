// Water: when she swims, how she moves on and under the surface, the dive, and the shelf that
// puts her back on her feet (water-and-air and swim-dive cards).
import { ceilingAt, floorAt, waterAt } from "../level.js";
import {
  ANGLE,
  DIVE_DELAY,
  DIVE_PITCH,
  DIVE_START_SPEED,
  SHELF_DEPTH,
  SURFACE_PARK,
  SURFACE_SPEED_CAP,
  SWIM_COAST,
  SWIM_GAIN,
  SWIM_HALF_HEIGHT,
  SWIM_MOVE_DIVISOR,
  SWIM_PITCH_RATE,
  SWIM_TURN_CAP,
  TREAD_FRACTION,
  UNDERWATER_SPEED_CAP,
} from "../tuning.js";
import { addTurn, forward, type IBody, type IInput } from "./body.js";

/**
 * She goes under: the swim state replaces the ground or the air. From the air the fall speed turns
 * into a downward plunge that the coast then bleeds off. `y` becomes the body centre.
 */
export function enterWater(body: IBody, fromAir: boolean): void {
  const floor = floorAt(body.x, body.z);
  body.y = fromAir ? body.y : Math.max(body.y, floor) + SWIM_HALF_HEIGHT;
  body.pitch = fromAir ? -Math.PI / 2 : 0;
  body.swimSpeed = fromAir ? Math.min(body.vy, UNDERWATER_SPEED_CAP) : 0;
  body.vy = 0;
  body.speed = 0;
  body.state = "swim";
  body.note = "splash";
}

/** The body fits at a centre height: floor under it, ceiling over it. */
function clear(x: number, y: number, z: number): boolean {
  return floorAt(x, z) <= y - SWIM_HALF_HEIGHT && ceilingAt(x, z) >= y + SWIM_HALF_HEIGHT;
}

/** Shallow water under two steps deep is stood on, not swum in (swim.c:233). */
function shelf(body: IBody): boolean {
  const plane = waterAt(body.x, body.z);
  const floor = floorAt(body.x, body.z);
  if (plane === undefined || plane - floor >= SHELF_DEPTH) return false;
  body.y = floor;
  body.state = "idle";
  body.speed = 0;
  body.swimSpeed = 0;
  body.pitch = 0;
  body.note = "wade";
  return true;
}

/** Move along a heading: one axis at a time, so a wall deflects her instead of stopping her dead. */
function travel(body: IBody, dx: number, dy: number, dz: number): void {
  if (dx !== 0 && clear(body.x + dx + Math.sign(dx) * 100, body.y, body.z)) body.x += dx;
  if (dz !== 0 && clear(body.x, body.y, body.z + dz + Math.sign(dz) * 100)) body.z += dz;
  if (dy !== 0 && clear(body.x, body.y + dy, body.z)) body.y += dy;
}

export function stepSwim(body: IBody, input: IInput): void {
  addTurn(body, input.left, input.right, SWIM_TURN_CAP);
  if (shelf(body)) return;
  const plane = waterAt(body.x, body.z);
  if (plane === undefined) {
    // Out of the water sideways (a wall's lip): put her on whatever is under her.
    body.state = "fall";
    body.vy = 0;
    return;
  }
  if (body.state === "surface") surface(body, input, plane);
  else under(body, input, plane);
}

function under(body: IBody, input: IInput, plane: number): void {
  // Forward pitches the nose down, back pitches it up, as the reference does underwater.
  const rate = SWIM_PITCH_RATE * ANGLE;
  if (input.up) body.pitch = Math.max(body.pitch - rate, (-85 * Math.PI) / 180);
  if (input.down) body.pitch = Math.min(body.pitch + rate, (85 * Math.PI) / 180);
  body.swimSpeed = input.jump
    ? Math.min(body.swimSpeed + SWIM_GAIN, UNDERWATER_SPEED_CAP)
    : Math.max(body.swimSpeed - SWIM_COAST, 0);
  body.state = input.jump
    ? "swim"
    : body.swimSpeed >= UNDERWATER_SPEED_CAP * TREAD_FRACTION
      ? "glide"
      : "tread";
  const step = body.swimSpeed / SWIM_MOVE_DIVISOR;
  const heading = forward(body.yaw);
  travel(
    body,
    heading.x * Math.cos(body.pitch) * step,
    Math.sin(body.pitch) * step,
    heading.z * Math.cos(body.pitch) * step,
  );
  // Rising through the plane with clear air above puts her on the surface.
  if (body.y >= plane - SURFACE_PARK && ceilingAt(body.x, body.z) >= plane + SWIM_HALF_HEIGHT) {
    body.state = "surface";
    body.y = plane - SURFACE_PARK;
    body.pitch = 0;
    body.swimSpeed = 0;
    body.dive = 0;
    body.note = "surface";
  }
}

function surface(body: IBody, input: IInput, plane: number): void {
  body.y = plane - SURFACE_PARK;
  body.swimSpeed = input.up
    ? Math.min(body.swimSpeed + SWIM_GAIN, SURFACE_SPEED_CAP)
    : Math.max(body.swimSpeed - SWIM_COAST, 0);
  const step = body.swimSpeed / SWIM_MOVE_DIVISOR;
  const heading = forward(body.yaw);
  travel(body, heading.x * step, 0, heading.z * step);
  // Holding jump for a beat dives at 45 degrees (swim-dive card: diveDelay, diveStartSpeed).
  body.dive = input.jump ? body.dive + 1 : 0;
  if (body.dive >= DIVE_DELAY) {
    body.state = "swim";
    body.pitch = DIVE_PITCH;
    body.swimSpeed = DIVE_START_SPEED;
    body.dive = 0;
    body.note = "dive";
  }
}
