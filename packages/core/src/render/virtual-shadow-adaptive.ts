/**
 * What a level's own measured render cost buys, as a wider refresh trail and a raised caster gate.
 *
 * A level render is a whole scene draw, so the engine cannot know what one is worth until it has
 * paid for it. These are the constants of that trade and the two decisions taken from it; the node
 * owns the measurement, the per-level state and the marker lines.
 */

/** How much a level's texel gate steps up per over-budget render. */
const GATE_SCALE_RISE = 1.5;
/** The most a level's texel gate may scale up, so a big building is never in reach. */
const GATE_SCALE_CAP = 8;
/** How much the gate steps back toward 1 once the render is comfortably under budget. */
const GATE_SCALE_DECAY = 0.5;
/** Below this share of the affordable budget a level's gate decays; between, it holds. */
const GATE_DECAY_SHARE = 0.5;
/**
 * How much of a level's last two render costs the smoothed cost keeps, `(0, 1]`. Half and half, so a
 * first draw with a cold pipeline is not the level's price for the rest of the session.
 */
export const COST_SMOOTHING = 0.5;
/**
 * A level's first measured renders are thrown away before its cost is trusted. The first draw of a
 * map compiles its shaders and uploads its textures, so it reads tens of milliseconds however cheap
 * the level is; seeding the smoothed cost with that warm-up would widen the trail or raise the gate
 * for a level that is not actually expensive. Two renders is enough for the pipeline to be warm.
 */
export const COST_WARMUP_RENDERS = 2;

/**
 * The trail a level may step by, from what its own last render cost: the configured step, widened in
 * proportion to how far the cost overshoots the affordable share, and capped by the margin the
 * window's guard leaves, so the camera stays inside the region this level serves and everything it
 * serves stays inside the map.
 */
export function trailStep(
  base: number,
  costMs: number,
  affordableMs: number,
  margin: number,
): number {
  return Math.min(base * Math.max(1, costMs / affordableMs), margin);
}

/**
 * The scale a level's texel gate takes after one over-budget render: up past the cap on a render
 * that costs more than the frame can afford, back toward 1 once it is comfortably under half of it,
 * and unchanged between the two — that band is the hysteresis, so a level on the budget does not
 * oscillate.
 */
export function nextGateScale(scale: number, costMs: number, affordableMs: number): number {
  if (costMs > affordableMs) return Math.min(GATE_SCALE_CAP, scale * GATE_SCALE_RISE);
  if (costMs < affordableMs * GATE_DECAY_SHARE) return Math.max(1, scale * GATE_SCALE_DECAY);
  return scale;
}
