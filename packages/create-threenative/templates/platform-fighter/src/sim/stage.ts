import { MAIN, PLATFORMS } from "../level.js";
import { HALF_WIDTH, HEIGHT, STEP } from "./constants.js";
import type { IFighter } from "./types.js";

/** A surface a fighter can stand on. */
export type Floor = { readonly x0: number; readonly x1: number; readonly y: number };

const EPSILON = 1e-4;
/** A fighter pressed this far into the top face of the block still counts as beside it, not under it. */
const TOP_FORGIVENESS = 0.25;

/**
 * Moves a fighter through the air for one frame and collides it with the stage.
 *
 * The main block is solid on every face: you land on its top, and bonk on its sides and underside.
 * The three platforms are walkable from above only. Returns the floor the fighter landed on.
 */
export function moveInAir(f: IFighter, ignorePlatforms: boolean): Floor | undefined {
  const previousY = f.y;
  const vy = f.vy + f.ky;
  f.x += (f.vx + f.kx) * STEP;
  f.y += vy * STEP;
  if (
    vy <= 0 &&
    previousY >= MAIN.y - EPSILON &&
    f.y <= MAIN.y &&
    f.x >= MAIN.x0 &&
    f.x <= MAIN.x1
  ) {
    f.y = MAIN.y;
    return MAIN;
  }
  const inside =
    f.x + HALF_WIDTH > MAIN.x0 &&
    f.x - HALF_WIDTH < MAIN.x1 &&
    f.y < MAIN.y &&
    f.y + HEIGHT > MAIN.bottom;
  if (inside) {
    const pushLeft = f.x + HALF_WIDTH - MAIN.x0;
    const pushRight = MAIN.x1 - (f.x - HALF_WIDTH);
    const pushDown = f.y + HEIGHT - MAIN.bottom;
    const pushUp = MAIN.y - f.y;
    const least = Math.min(
      pushLeft,
      pushRight,
      pushDown,
      pushUp <= TOP_FORGIVENESS ? pushUp : Number.POSITIVE_INFINITY,
    );
    if (least === pushUp) {
      f.y = MAIN.y;
      return MAIN;
    }
    if (least === pushDown) {
      f.y -= pushDown;
      f.vy = Math.min(f.vy, 0);
      f.ky = Math.min(f.ky, 0);
    } else {
      f.x += least === pushLeft ? -pushLeft : pushRight;
      f.vx = 0;
      f.kx = 0;
    }
  }
  if (ignorePlatforms || vy > 0) return undefined;
  for (const platform of PLATFORMS) {
    if (
      previousY >= platform.y - EPSILON &&
      f.y <= platform.y &&
      f.x >= platform.x0 &&
      f.x <= platform.x1
    ) {
      f.y = platform.y;
      return platform;
    }
  }
  return undefined;
}
