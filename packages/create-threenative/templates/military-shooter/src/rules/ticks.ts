// A fixed 30 Hz tick, the way the shield and the soldiers' burst timers count time.
//
// Reference: halo-combat-evolved-opence (OpenCE) `tick-clock`. Real time goes into an accumulator,
// whole ticks come out, and the leftover carries over.

/** 30 ticks per second (source/cseries/cseries.h:34). */
export const TICKS_PER_SECOND = 30;
/** A single update runs at most 7 ticks, and drops the rest of the time (source/game/game_time.c:434). */
const MAX_TICKS_PER_UPDATE = 7;

/** Seconds to whole ticks by truncation: 0.3 s is 9 ticks (source/ai/actor_combat.c:614). */
export function toTicks(seconds: number): number {
  return Math.trunc(seconds * TICKS_PER_SECOND);
}

export class TickClock {
  #left = 0;

  /** The whole ticks to run for `dt` seconds. */
  step(dt: number): number {
    this.#left += dt * TICKS_PER_SECOND;
    const ticks = Math.floor(this.#left);
    if (ticks > MAX_TICKS_PER_UPDATE) {
      this.#left = 0;
      return MAX_TICKS_PER_UPDATE;
    }
    this.#left -= ticks;
    return ticks;
  }
}
