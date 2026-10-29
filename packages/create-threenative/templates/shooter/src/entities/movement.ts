// First-person ground movement and stair smoothing, with no engine import, so a spec can drive it.
//
// The algorithms are borrowed, not the code:
// - Ground friction then acceleration, from Quake III Arena's player movement
//   (id-Software/Quake-III-Arena@dbe4ddb, code/game/bg_pmove.c:34-44 for the constants,
//   :172-226 `PM_Friction`, :240-262 `PM_Accelerate`). A body that is set to full speed on the
//   tick a key goes down, and to zero on the tick it comes up, reads as a robot on rails.
// - The eye's climb over stair steps, after the Source SDK (ValveSoftware/source-sdk-2013@be57e3d,
//   src/game/shared/baseplayer_shared.cpp:1446-1500 `SmoothViewOnStairs`). The character body
//   steps up 0.3 m in a few ticks and then stops, and an eye welded to it climbs in jolts.

/** Reach full speed in about a tenth of a second (Q3 `pm_accelerate` 10). */
export const GROUND_ACCELERATE = 10;
/** Exponential slow-down per second once the keys come up (Q3 `pm_friction` 6). */
export const GROUND_FRICTION = 6;
/**
 * Below this speed friction stops the body at a constant rate instead of a decaying one, so it
 * comes to rest instead of creeping. Q3 uses 100 of its 320 run speed; this is that share of the
 * 5.6 m/s walk.
 */
export const GROUND_STOP_SPEED = 1.75;
/**
 * Seconds the eye takes to catch up with a stair step. Source climbs at a fixed 150 in/s, and on
 * these 0.3 m steps that rate catches up inside each step, so the view still climbed in stops and
 * starts (measured: 0 to 3.8 m/s every step). A critically damped spring at this time climbs a
 * walked flight at 1.2-2.0 m/s and a sprinted one at 2.4-2.8 m/s, never stopping between steps.
 */
export const STAIR_VIEW_SMOOTH_TIME = 0.15;
/** Source keeps the view within one step (18 in, 0.457 m) of the body; matches the autostep. */
export const STAIR_VIEW_MAX_GAP = 0.457;

/** One tick of ground movement. `wishX`/`wishZ` is a unit direction, or zero for no input. */
export function groundMove(
  velocity: { x: number; z: number },
  wishX: number,
  wishZ: number,
  wishSpeed: number,
  dt: number,
): void {
  const speed = Math.hypot(velocity.x, velocity.z);
  if (speed < 0.02) {
    velocity.x = 0;
    velocity.z = 0;
  } else {
    const drop = Math.max(speed, GROUND_STOP_SPEED) * GROUND_FRICTION * dt;
    const scale = Math.max(0, speed - drop) / speed;
    velocity.x *= scale;
    velocity.z *= scale;
  }
  if (wishSpeed <= 0) return;
  const add = wishSpeed - (velocity.x * wishX + velocity.z * wishZ);
  if (add <= 0) return;
  const accel = Math.min(GROUND_ACCELERATE * dt * wishSpeed, add);
  velocity.x += accel * wishX;
  velocity.z += accel * wishZ;
}

/** The body height the eye shows, and how fast it is moving. */
export interface IStairView {
  y: number;
  velocity: number;
}

/**
 * Advance the eye's body height one tick. On the ground it follows the body through a critically
 * damped spring (the closed form in Game Programming Gems 4, "Critically Damped Ease-In/Ease-Out
 * Smoothing"), never past it and never more than one step behind; off the ground (a fall, a
 * teleport) it is the body height.
 */
export function stairView(
  view: IStairView | undefined,
  bodyY: number,
  grounded: boolean,
  dt: number,
): IStairView {
  if (view === undefined) return { y: bodyY, velocity: 0 };
  if (!grounded) {
    view.y = bodyY;
    view.velocity = 0;
    return view;
  }
  const omega = 2 / STAIR_VIEW_SMOOTH_TIME;
  const x = omega * dt;
  const decay = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = view.y - bodyY;
  const pull = (view.velocity + omega * change) * dt;
  view.velocity = (view.velocity - omega * pull) * decay;
  view.y = bodyY + (change + pull) * decay;
  // A spring that crossed the body would bob the eye above it: stop on the body instead.
  if (change < 0 === view.y > bodyY) {
    view.y = bodyY;
    view.velocity = 0;
  }
  view.y = Math.min(bodyY + STAIR_VIEW_MAX_GAP, Math.max(bodyY - STAIR_VIEW_MAX_GAP, view.y));
  return view;
}
