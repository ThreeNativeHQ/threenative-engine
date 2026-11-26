// Airborne: gravity, steering, wall deflection, the mid-air ledge grab, landing and fall damage.
import { cellCeiling, cellFloor, ceilingAt, floorAt, SOLID, waterAt } from "../level.js";
import {
  BODY_HEIGHT,
  BODY_RADIUS,
  CLIMB_UPDATES,
  DAMAGE_LENGTH,
  DAMAGE_START_SPEED,
  GRAB_CONE,
  GRAB_DISTANCE,
  GRAB_WINDOW,
  GRAVITY,
  HANG_OFFSET,
  HANG_REACH,
  HEAD_CLEARANCE,
  HEALTH_POOL,
  JUMP_TURN_CAP,
  MIN_FLOOR_DROP,
  MIN_HANG_DROP,
  PULL_UP_HEADROOM,
  SECTOR,
  SWIM_DEPTH,
  TERMINAL_GROWTH,
  TERMINAL_SPEED,
} from "../tuning.js";
import {
  addTurn,
  cardinal,
  cellOf,
  forward,
  type IBody,
  type IInput,
  nearestCardinal,
} from "./body.js";
import { die } from "./death.js";
import { enterWater } from "./swim.js";

/** Leave the ground: rise at `rise`, travel at `speed` along the facing (negative is backwards). */
export function launch(body: IBody, rise: number, speed: number): void {
  body.state = "jump";
  body.vy = -rise;
  body.speed = speed;
  body.note = "launch";
}

/** Walk or run off an edge: no rise, the speed carries. */
export function fall(body: IBody): void {
  body.state = "fall";
  body.vy = 0;
}

/**
 * Landing damage (fall-damage card): free up to `DAMAGE_START_SPEED`, then a quadratic fraction of
 * the whole health pool over the next `DAMAGE_LENGTH` units of speed, and fatal beyond that.
 */
export function landingDamage(speed: number): number {
  const excess = speed - DAMAGE_START_SPEED;
  if (excess <= 0) return 0;
  if (excess > DAMAGE_LENGTH) return Number.POSITIVE_INFINITY;
  return HEALTH_POOL * (excess / DAMAGE_LENGTH) ** 2;
}

/** A body in the air is stopped by a floor above its feet or a ceiling under its head. */
function blocked(x: number, z: number, feet: number): boolean {
  return floorAt(x, z) > feet || ceilingAt(x, z) < feet + BODY_HEIGHT;
}

export function stepAir(body: IBody, input: IInput): void {
  addTurn(body, input.left, input.right, JUMP_TURN_CAP);
  body.vy += body.vy < TERMINAL_SPEED ? GRAVITY : TERMINAL_GROWTH;
  if (input.action && tryGrab(body)) return;

  // Horizontal travel, one axis at a time so a wall deflects her instead of sticking her.
  const heading = forward(body.yaw);
  const dx = heading.x * body.speed;
  const dz = heading.z * body.speed;
  if (dx !== 0) {
    if (blocked(body.x + dx + Math.sign(dx) * BODY_RADIUS, body.z, body.y)) body.speed = 0;
    else body.x += dx;
  }
  if (dz !== 0) {
    if (blocked(body.x, body.z + dz + Math.sign(dz) * BODY_RADIUS, body.y)) body.speed = 0;
    else body.z += dz;
  }

  const next = body.y - body.vy;
  const floor = floorAt(body.x, body.z);
  const plane = waterAt(body.x, body.z);
  if (plane !== undefined && plane - floor > SWIM_DEPTH && next <= plane) {
    enterWater(body, true);
    return;
  }
  if (body.vy >= 0 && next <= floor) {
    land(body, floor, plane !== undefined && plane > floor);
    return;
  }
  const ceiling = ceilingAt(body.x, body.z);
  if (body.vy < 0 && next + BODY_HEIGHT >= ceiling) {
    // A bumped head stops the rise (card: ceiling bump).
    body.y = ceiling - BODY_HEIGHT;
    body.vy = 0;
    return;
  }
  body.y = next;
}

function land(body: IBody, floor: number, wading: boolean): void {
  const damage = wading ? 0 : landingDamage(body.vy);
  body.y = floor;
  body.note = "land";
  body.state = "idle";
  body.speed = 0;
  body.landingSpeed = body.vy;
  body.fallDamage = Number.isFinite(damage) ? Math.round(damage) : HEALTH_POOL;
  body.vy = 0;
  if (damage > 0) {
    body.health = Math.max(0, body.health - damage);
    body.note = "land-hard";
    if (body.health <= 0) die(body, "fall");
  }
}

/**
 * Offer a ledge (ledge-grab card). The facing must lie within the cone of a cardinal, the floor
 * under her must be well below, the ceiling clear of her head, and the ledge top in reach of her
 * hands. A tall drop under the ledge makes a hang. A short one makes a vault straight onto it.
 */
export function tryGrab(body: IBody): boolean {
  const { dir, off } = nearestCardinal(body.yaw);
  if (off > GRAB_CONE) return false;
  const here = floorAt(body.x, body.z);
  if (body.y - here < MIN_FLOOR_DROP) return false;
  if (ceilingAt(body.x, body.z) - (body.y + BODY_HEIGHT) < HEAD_CLEARANCE) return false;

  const along = cardinal(dir);
  const cx = cellOf(body.x);
  const cz = cellOf(body.z);
  const frontX = cx + Math.round(along.x);
  const frontZ = cz + Math.round(along.z);
  // Distance from her centre to the cell boundary she faces.
  const boundary =
    along.x !== 0
      ? (along.x > 0 ? cx + 1 : cx) * SECTOR
      : along.z > 0
        ? (cz + 1) * SECTOR
        : cz * SECTOR;
  const distance = along.x !== 0 ? (boundary - body.x) * along.x : (boundary - body.z) * along.z;
  if (distance > GRAB_DISTANCE) return false;
  const top = cellFloor(frontX, frontZ);
  if (top >= SOLID) return false;
  const reach = top - body.y;
  if (reach < GRAB_WINDOW[0] || reach > GRAB_WINDOW[1]) return false;

  const drop = top - here;
  const hang = drop >= MIN_HANG_DROP;
  if (!hang && cellCeiling(frontX, frontZ) - top < PULL_UP_HEADROOM) return false;
  // Snap onto the wall face, facing it, hands on the edge.
  if (along.x !== 0) body.x = boundary - along.x * HANG_OFFSET;
  else body.z = boundary - along.z * HANG_OFFSET;
  body.yaw = (dir * Math.PI) / 2;
  body.y = hang ? top - HANG_REACH : Math.max(here, top - HANG_REACH);
  body.speed = 0;
  body.vy = 0;
  body.turn = 0;
  body.hang = { dir, top, fromX: body.x, fromZ: body.z, fromY: body.y };
  body.state = hang ? "hang" : "climb";
  body.timer = CLIMB_UPDATES;
  body.note = hang ? "grab" : "vault";
  return true;
}
