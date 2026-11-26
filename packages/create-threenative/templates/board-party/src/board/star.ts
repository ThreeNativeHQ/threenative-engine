// The moving star. Candidate spaces and their priorities sit in two parallel columns, and the shuffle
// permutes both together. The live candidate is typed `star` and every visited one `used`, so the board
// shows one live star and a trail without a second data structure, and the mark inherits the space's
// position for free. Reference: mario-party-1 `star-space-rotation`
// (src/overlays/ovl_36_DKsJungleAdventure/2418D0.c:39-112).
import type { Stream } from "../rng.js";
import { STAR_CANDIDATES } from "./layout.js";
import type { ISpace } from "./layout.js";

/** Passes in one shuffle. mario-party-1 src/overlays/ovl_36_DKsJungleAdventure/2418D0.c:39. */
const SHUFFLE_PASSES = 30;

export class StarRotation {
  readonly ids: number[] = STAR_CANDIDATES.map((c) => c.id);
  readonly priority: number[] = STAR_CANDIDATES.map((c) => c.priority);
  live = 0;
  /** True once the rotation has run past its last candidate and reshuffled. */
  cycled = false;
  readonly #spaces: ISpace[];
  readonly #rng: Stream;

  constructor(spaces: ISpace[], rng: Stream) {
    this.#spaces = spaces;
    this.#rng = rng;
    this.#shuffle();
    this.#mark();
  }

  /** The space that holds the live star. */
  get space(): number {
    return this.ids[this.live] as number;
  }

  /** Move the star on after a sale. The wrap reshuffles, and never hands out one space twice in a row. */
  advance(): void {
    const before = this.space;
    this.live += 1;
    if (this.live >= this.ids.length) {
      this.live = 0;
      this.cycled = true;
      this.#shuffle();
      if (this.space === before) this.#swap(0, this.ids.length - 1);
    }
    this.#mark();
  }

  /**
   * Draw two slots a pass and skip the pass when they match or when the priority comparison fails:
   * the back slot swaps forward only when it is at least as high, so high priority drifts to the front.
   * That reading of the card's "priority comparison" is ours: the card names the bias, not the operator.
   */
  #shuffle(): void {
    const count = this.ids.length;
    for (let pass = 0; pass < SHUFFLE_PASSES; pass += 1) {
      const a = this.#rng.int(count);
      const b = this.#rng.int(count);
      if (a === b) continue;
      const front = Math.min(a, b);
      const back = Math.max(a, b);
      if ((this.priority[back] as number) < (this.priority[front] as number)) continue;
      this.#swap(front, back);
    }
  }

  #swap(a: number, b: number): void {
    [this.ids[a], this.ids[b]] = [this.ids[b] as number, this.ids[a] as number];
    [this.priority[a], this.priority[b]] = [this.priority[b] as number, this.priority[a] as number];
  }

  #mark(): void {
    for (const [index, id] of this.ids.entries()) {
      const space = this.#spaces[id] as ISpace;
      space.type = index === this.live ? "star" : index < this.live ? "used" : space.base;
    }
  }
}
