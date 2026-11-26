import type { Die } from "./d20.js";

/**
 * The game's dice. Plays from the seeded generator, so a run repeats. Under a playtest runner an
 * owner's next rolls can be rigged, so a scenario proves one rule (a natural 20, a miss by one)
 * without waiting for the right number to come up.
 */
export class Dice {
  readonly #rigs = new Map<string, number[]>();
  readonly #random: () => number;

  constructor(random: () => number) {
    this.#random = random;
  }

  /** Queue exact results for one owner. Each is used once, in order, then the seeded source resumes. */
  rig(owner: string, values: readonly number[]): void {
    this.#rigs.set(owner, [...values]);
  }

  /** A die for one owner: rigged results first, then the seeded source. */
  for(owner: string): Die {
    return (sides) => {
      const rigged = this.#rigs.get(owner)?.shift();
      if (rigged !== undefined) return Math.max(1, Math.min(sides, rigged));
      return 1 + Math.floor(this.#random() * sides);
    };
  }
}
