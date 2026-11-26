import { MAIN } from "../level.js";
import {
  DOUBLE_JUMP,
  DOWN_FLICK,
  GETUP_FRAMES,
  HALF_WIDTH,
  LEDGE_COOLDOWN,
  LEDGE_HANG_Y,
  LEDGE_HIGH_DAMAGE_PERCENT,
  LEDGE_HOLD_HIGH_DAMAGE,
  LEDGE_HOLD_LOW_DAMAGE,
  LEDGE_INVULN,
  LEDGE_LOCK,
} from "./constants.js";
import { type IWorld, edge, land, setMode } from "./motion.js";
import type { IFighter, Pad } from "./types.js";

/** Feet may grab a ledge from this far below the top to just under it, and this far out. */
const REACH_DEPTH = 3;
const REACH_OUT = 1.2;
/** Feet within this of the top are standing height, not hanging height. */
const REACH_TOP = 0.6;
/** Holding down refuses a grab. */
const REFUSE = -0.6;

export function releaseLedge(f: IFighter, world: IWorld): void {
  if (f.ledge !== 0) world.ledgeOwner.delete(f.ledge);
  f.ledge = 0;
}

/** Grabs a free ledge when a falling fighter is beside it. Card `ledge-hold` for the timers. */
export function tryLedge(f: IFighter, pad: Pad, world: IWorld): void {
  if (f.ledgeCooldown > 0 || pad.y <= REFUSE || f.vy > 0.5) return;
  if (f.y > MAIN.y - REACH_TOP || f.y < MAIN.y - REACH_DEPTH) return;
  for (const side of [-1, 1] as const) {
    const edgeX = side === 1 ? MAIN.x1 : MAIN.x0;
    const outside = (f.x - edgeX) * side;
    if (outside < -0.1 || outside > REACH_OUT || world.ledgeOwner.has(side)) continue;
    world.ledgeOwner.set(side, f.id);
    f.ledge = side;
    f.x = edgeX + side * (HALF_WIDTH + 0.02);
    f.y = MAIN.y + LEDGE_HANG_Y;
    f.vx = f.vy = f.kx = f.ky = 0;
    f.facing = side === 1 ? -1 : 1;
    f.invuln = Math.max(f.invuln, LEDGE_INVULN);
    f.jumps = 1;
    f.fastFalling = false;
    setMode(f, "ledge");
    world.emit({ entity: f.id, name: "ledge-grab" });
    return;
  }
}

export function ledgeStep(f: IFighter, pad: Pad, world: IWorld): void {
  const side = f.ledge;
  if (side === 0) {
    setMode(f, "free");
    return;
  }
  const hold =
    f.percent >= LEDGE_HIGH_DAMAGE_PERCENT ? LEDGE_HOLD_HIGH_DAMAGE : LEDGE_HOLD_LOW_DAMAGE;
  const drop = (): void => {
    releaseLedge(f, world);
    f.ledgeCooldown = LEDGE_COOLDOWN;
    f.floor = undefined;
    setMode(f, "free");
  };
  if (f.timer >= hold) {
    drop();
    return;
  }
  if (f.timer < LEDGE_LOCK) return;
  const inward = -side;
  if (edge(f, pad, "jump")) {
    drop();
    f.vy = DOUBLE_JUMP;
    f.vx = inward * 2;
    f.peakY = f.y;
    world.emit({ entity: f.id, name: "ledge-jump" });
  } else if (pad.x * inward > 0.5 || pad.y > 0.6) {
    // The climb keeps `ledge` so `getupStep` knows which corner it starts from; the ledge itself is free.
    world.ledgeOwner.delete(side);
    setMode(f, "getup");
    world.emit({ entity: f.id, name: "getup" });
  } else if (pad.y <= DOWN_FLICK || pad.x * side > 0.5) drop();
}

/** Climbs from the hang to the top: up first, then in, intangible all the way. */
export function getupStep(f: IFighter): void {
  const side = f.ledge;
  const edgeX = side === 1 ? MAIN.x1 : MAIN.x0;
  const progress = Math.min(1, (f.timer + 1) / GETUP_FRAMES);
  const rise = Math.min(1, progress * 1.8);
  const slide = Math.max(0, (progress - 0.45) / 0.55);
  f.x = edgeX + side * (HALF_WIDTH + 0.02) - side * (HALF_WIDTH + 0.85) * slide;
  f.y = MAIN.y + LEDGE_HANG_Y * (1 - rise);
  f.invuln = Math.max(f.invuln, 2);
  if (f.timer + 1 >= GETUP_FRAMES) {
    f.ledge = 0;
    f.invuln = Math.max(f.invuln, 6);
    f.facing = side === 1 ? -1 : 1;
    land(f, MAIN);
    setMode(f, "free");
  }
}
