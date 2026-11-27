import { BPM, COUNT_IN_BEATS } from "./chart.js";

const SECONDS_PER_BEAT = 60 / BPM;

/**
 * The beat clock. It counts seconds of frame time (`dt` from the fixed-step loop), never the wall
 * clock and never an audio position, so it stays locked to the picture and a playtest replays it
 * tick for tick. The song starts `COUNT_IN_BEATS` below zero.
 *
 * Reference: parappa-the-rapper-2 `song-clock` (src/main/etc.c:80). The original converts a frame
 * counter to musical units with `frames * 96 * bpm / 3600`; dividing seconds by the beat length
 * is the same conversion at a game-chosen resolution.
 */
export class BeatClock {
  #seconds = 0;

  advance(dt: number): void {
    this.#seconds += dt;
  }

  /** Beats since the first call; negative during the count-in. */
  get beat(): number {
    return this.#seconds / SECONDS_PER_BEAT - COUNT_IN_BEATS;
  }

  /** 1 on the beat, falling to near 0 before the next one. Lights and bobbing both read it. */
  get pulse(): number {
    const phase = this.beat - Math.floor(this.beat);
    return Math.exp(-5 * phase);
  }
}
