import type { ButtonName } from "./buttons.js";

/**
 * The song, as data. One line is eight beats: the teacher calls for four, then the player answers
 * for four. Change a line here and the beat bar, the teacher and the judge follow it.
 *
 * Notes sit on beat positions inside the four-beat part. Keep two notes at least half a beat
 * apart: the grading windows in `judge.ts` reach a quarter beat either side of a note.
 */
export interface INote {
  /** Beats from the start of the part, 0 up to but not including 4. */
  readonly beat: number;
  readonly button: ButtonName;
}

/** A fixed tempo: the frame clock drives it, so it never drifts against the picture. */
export const BPM = 120;
export const BEATS_PER_PART = 4;
export const BEATS_PER_LINE = BEATS_PER_PART * 2;
/** Silent beats before the first call, so the player hears the tempo before the teacher starts. */
export const COUNT_IN_BEATS = 4;

const n = (beat: number, button: ButtonName): INote => ({ beat, button });

/**
 * Lines 1 to 3 hold only whole beats, which keeps every off-beat free for the freestyle in the top
 * rating. Lines 4 to 8 add off-beat notes and more buttons.
 */
export const LINES: readonly (readonly INote[])[] = [
  [n(0, "left"), n(1, "right"), n(2, "up"), n(3, "down")],
  [n(0, "z"), n(1, "z"), n(2, "x"), n(3, "x")],
  [n(0, "left"), n(1, "up"), n(2, "right"), n(3, "down")],
  [n(0, "z"), n(0.5, "x"), n(1.5, "z"), n(2, "left"), n(3, "right")],
  [n(0, "up"), n(1, "up"), n(1.5, "down"), n(2.5, "z"), n(3, "x")],
  [n(0, "left"), n(0.5, "left"), n(1, "right"), n(2, "x"), n(2.5, "z"), n(3, "up")],
  [n(0, "down"), n(1, "z"), n(1.5, "x"), n(2, "up"), n(3, "left"), n(3.5, "right")],
  [n(0, "z"), n(0.5, "z"), n(1, "x"), n(1.5, "x"), n(2, "left"), n(3, "right"), n(3.5, "up")],
];
