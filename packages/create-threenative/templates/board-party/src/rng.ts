// One seeded 32-bit stream feeds every draw in the match: junction answers, the live star, the die and
// the minigames. Because there is one stream, a change in how many draws one system takes shifts every
// later draw, and a recorded run replays the same. The card pins the step and the output byte.
// Reference: mario-party-1 `random-stream` (src/engine/ovlman.c:35-36).

/** Multiplier and increment of the step, 32-bit wrap. mario-party-1 src/engine/ovlman.c:35. */
const MULTIPLIER = 0x41c64e6d;
const INCREMENT = 0x3039;
/** The draw is bits 16 to 23 of the new state. mario-party-1 src/engine/ovlman.c:36. */
const OUTPUT_SHIFT = 16;
/** The percent helper maps one byte onto 0 to 99. mario-party-1 src/4D770.c:146 (percent span 99). */
const PERCENT_SPAN = 100;

export class Stream {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** One byte, 0 to 255. */
  next(): number {
    this.#state = (Math.imul(this.#state, MULTIPLIER) + INCREMENT) >>> 0;
    return (this.#state >>> OUTPUT_SHIFT) & 0xff;
  }

  /** A whole number from 0 to `count - 1`. */
  int(count: number): number {
    return this.next() % count;
  }

  /** 0 to 99: a weight is literally the chance of the intended answer. */
  percent(): number {
    return Math.floor((this.next() * PERCENT_SPAN) / 256);
  }

  /**
   * A die from 1 to `sides` that never repeats `previous`. A draw equal to the last one loops and
   * spends one more draw instead of reseeding, so the rest of the session is disturbed by one step.
   * mario-party-1 `random-stream` (a reroll equal to the previous roll loops on the generator).
   */
  die(sides: number, previous: number): number {
    let value = 1 + this.int(sides);
    while (value === previous) value = 1 + this.int(sides);
    return value;
  }
}
