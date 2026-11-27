// The slicing blade across the deck corridor: a timed cycle, so the way past it is a rhythm.
import { BLADE } from "../level.js";
import {
  BLADE_DAMAGE,
  BLADE_INVULNERABLE_UPDATES,
  BODY_HEIGHT,
  BODY_RADIUS,
  CLICK,
} from "../tuning.js";
import type { IBody } from "./body.js";
import { die } from "./death.js";

/** The deck the blade hangs over, units. */
const DECK = 16 * CLICK;
/** One cycle in updates: raised, a quick drop, down, then rising again. Own, tuned by feel. */
const RAISED = 48;
const DROP = 6;
const DOWN = 18;
const RISE = 18;
export const CYCLE = RAISED + DROP + DOWN + RISE;
/** How high the lowest edge hangs when raised, above the deck, and the blade's own height. */
export const BLADE_RAISED = 1500;
export const BLADE_THICK = 300;

/** Height of the blade's lowest edge above the deck at an update count. */
export function bladeLift(tick: number): number {
  const t = ((tick % CYCLE) + CYCLE) % CYCLE;
  if (t < RAISED) return BLADE_RAISED;
  if (t < RAISED + DROP) return BLADE_RAISED * (1 - (t - RAISED) / DROP);
  if (t < RAISED + DROP + DOWN) return 0;
  return BLADE_RAISED * ((t - RAISED - DROP - DOWN) / RISE);
}

/** One hit per invulnerable window. The blade is a wall of metal: its lowest edge meets her head. */
export function stepBlade(body: IBody, tick: number): void {
  if (body.invulnerable > 0) body.invulnerable -= 1;
  if (body.state === "dead" || body.invulnerable > 0) return;
  const inside =
    Math.abs(body.x - BLADE.x) < BLADE.halfWidth + BODY_RADIUS &&
    body.z > BLADE.z0 &&
    body.z < BLADE.z1 &&
    Math.abs(body.y - DECK) < 200;
  if (!inside) return;
  const edge = DECK + bladeLift(tick);
  if (edge >= body.y + BODY_HEIGHT) return;
  body.health = Math.max(0, body.health - BLADE_DAMAGE);
  body.invulnerable = BLADE_INVULNERABLE_UPDATES;
  body.note = "blade";
  if (body.health <= 0) die(body, "blade");
}
