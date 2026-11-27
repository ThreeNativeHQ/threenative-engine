// Steering as accumulated curvature (reference card carmageddon/steering-curvature).
// The driver does not command an angle. A held key moves a curvature c in [-1, 1] toward the
// car's limit, and the limit is reached more slowly the faster the car goes.

/** Flat correction when the input opposes the turn: 0.01 per 0.04 s tick (car.c:1878). */
const COUNTER_RATE = 0.01 / 0.04;
/** Entry rate numerator and speed offset: 0.05 / (5 + speed) per tick (car.c:1880). */
const ENTRY_NUMERATOR = 0.05;
const ENTRY_OFFSET = 5;
const TICK = 0.04;
/** Kit tuning: the card's units are game units, this kit's speeds are metres per second. */
const RATE_GAIN = 8;

/** Curvature per second the input builds at `speed` (m/s). */
export function steerRate(opposing: boolean, speed: number): number {
  if (opposing) return COUNTER_RATE * RATE_GAIN;
  return (ENTRY_NUMERATOR / (ENTRY_OFFSET + Math.abs(speed)) / TICK) * RATE_GAIN;
}

/**
 * One tick of steering. `input` is -1..1 (+ right). With no input, self-centring applies the
 * smaller of two corrections: follow the yaw the car already carries (`yawNorm`, so a slide
 * keeps its counter-steer), or cancel the curvature. It never crosses zero (car.c:2048-2075).
 */
export function stepCurvature(
  c: number,
  input: number,
  speed: number,
  yawNorm: number,
  dt: number,
): number {
  if (input !== 0) {
    const opposing = Math.sign(input) !== Math.sign(c) && c !== 0;
    const next = c + Math.sign(input) * steerRate(opposing, speed) * dt * Math.abs(input);
    return Math.max(-1, Math.min(1, next));
  }
  const toYaw = yawNorm - c;
  const toZero = -c;
  const delta = Math.abs(toYaw) < Math.abs(toZero) ? toYaw : toZero;
  const step = Math.max(
    -COUNTER_RATE * RATE_GAIN * dt,
    Math.min(COUNTER_RATE * RATE_GAIN * dt, delta),
  );
  const next = c + step;
  return Math.sign(next) === Math.sign(c) || next === 0 ? next : 0;
}
