import type { ButtonName } from "./buttons.js";
import { BEATS_PER_PART, type INote } from "./chart.js";

/**
 * Timing grades, borrowed from parappa-the-rapper-2 `beat-cell-window` and `late-answer-pass`.
 *
 * The original divides a beat into 24 cells (src/main/scrctrl.c:2233) and counts a press as a hit
 * when it falls in the same run of its cell mask as the note. Its normal mask, 0x00e79e79
 * (scrctrl.c:136), has runs four cells wide, so a note owns two cells either side. A second pass
 * shifts every note two cells later (scrctrl.c:2307) to forgive a player who answers behind the
 * beat. This game keeps the cell grid, turns the run into the `cool` window and gives the two
 * wider grades a longer late tail by the same two cells.
 */
export const CELLS_PER_BEAT = 24;
const LATE_SHIFT_CELLS = 2;

export type Grade = "cool" | "good" | "bad" | "miss";
export type Timing = "early" | "late" | "on";

/** Cells before and after a note that still earn the grade. Widest last. */
export const WINDOWS: readonly {
  readonly grade: Exclude<Grade, "miss">;
  readonly early: number;
  readonly late: number;
}[] = [
  { grade: "cool", early: 2, late: 2 },
  { grade: "good", early: 4, late: 4 + LATE_SHIFT_CELLS },
  { grade: "bad", early: 6, late: 6 + LATE_SHIFT_CELLS },
];
const BAD = WINDOWS[2] as (typeof WINDOWS)[number];
const COOL = WINDOWS[0] as (typeof WINDOWS)[number];

/**
 * A press more than a quarter beat before the part opens is dropped before grading
 * (scrctrl.c:1841), which is the same reach as the `bad` window: a note on beat 0 can still be
 * answered early and nothing earlier counts.
 */
export const EARLY_GUARD_BEATS = BAD.early / CELLS_PER_BEAT;

/** A press within one cell of its note reads as on the beat; the rest read early or late. */
const ON_CELLS = 1;

/**
 * Points. A matched pair counts `PAIR_WEIGHT` and every press costs one, so extra presses cost
 * at once (scrctrl.c:2619, 2644). A note answered cool counts a whole pair, good and bad count less.
 */
const PAIR_WEIGHT = 2;
const PAIR_VALUE: Readonly<Record<Exclude<Grade, "miss">, number>> = {
  cool: 1,
  good: 0.75,
  bad: 0.5,
};
/** A line must reach half its best score to count as clean (`thresholdDivisor`, scrctrl.c:587). */
const THRESHOLD_DIVISOR = 2;
/** An improvised off-beat press in the top rating scores like a pair, and costs no press. */
const FREESTYLE_POINTS = PAIR_WEIGHT;
/** At most this many improvised presses count per line, so mashing cannot buy a rating. */
export const FREESTYLE_CAP = 4;

export interface IPressResult {
  readonly grade: Grade;
  readonly timing: Timing;
  /** Signed distance to the note in cells; positive is late. */
  readonly cells: number;
  readonly freestyle: boolean;
  /** Beat of the press inside the answer part, for the response bar. */
  readonly beat: number;
}

export interface ILineScore {
  readonly pairs: number;
  readonly presses: number;
  readonly freestyle: number;
  readonly score: number;
  readonly threshold: number;
}

interface INoteState {
  readonly note: INote;
  result: Grade | undefined;
}

const sign = (cells: number): Timing =>
  Math.abs(cells) <= ON_CELLS ? "on" : cells < 0 ? "early" : "late";

/** The grade a press earns at `cells` from a note, or undefined when it is outside every window. */
export function gradeFor(cells: number): Exclude<Grade, "miss"> | undefined {
  for (const window of WINDOWS)
    if (cells >= -window.early && cells <= window.late) return window.grade;
  return undefined;
}

/**
 * Grades one answer part against its notes. A press pairs with the nearest open note of the same
 * button inside the widest window (both the cell and the button must agree, `paired-hit-weight`).
 * A press that pairs with nothing is a stray press; in the top rating a stray press that lands on
 * an off-beat eighth with no note near it is freestyle instead, once the line has a matched note
 * and once per eighth.
 */
export class LineJudge {
  readonly #notes: INoteState[];
  #presses = 0;
  #pairs = 0;
  #freestyle = 0;
  /** Off-beat eighths already paid as freestyle: one bonus per slot, however many buttons hit it. */
  readonly #freestyleSlots = new Set<number>();

  constructor(notes: readonly INote[]) {
    this.#notes = notes.map((note) => ({ note, result: undefined }));
  }

  get total(): number {
    return this.#notes.length;
  }

  /** Per note, in chart order: its grade once settled, undefined while open. */
  get results(): readonly (Grade | undefined)[] {
    return this.#notes.map(({ result }) => result);
  }

  /** `beat` is the position in the answer part, 0 to 4 (a hair below 0 when answering early). */
  press(button: ButtonName, beat: number, freestyleOpen: boolean): IPressResult {
    let best: INoteState | undefined;
    let bestCells = Number.POSITIVE_INFINITY;
    for (const state of this.#notes) {
      if (state.result !== undefined || state.note.button !== button) continue;
      const cells = (beat - state.note.beat) * CELLS_PER_BEAT;
      if (gradeFor(cells) !== undefined && Math.abs(cells) < Math.abs(bestCells)) {
        best = state;
        bestCells = cells;
      }
    }
    if (best !== undefined) {
      const grade = gradeFor(bestCells) as Exclude<Grade, "miss">;
      best.result = grade;
      this.#presses += 1;
      this.#pairs += PAIR_VALUE[grade];
      return { beat, cells: bestCells, freestyle: false, grade, timing: sign(bestCells) };
    }
    const eighth = Math.round(beat * 2) / 2;
    const offBeat = (eighth * 2) % 2 !== 0;
    const cells = (beat - eighth) * CELLS_PER_BEAT;
    // A miss is early or late against the nearest note of the same button, so a press far outside
    // the windows still says which way it went wrong. With no such note it uses the eighth.
    let missCells = cells;
    let nearest = Number.POSITIVE_INFINITY;
    for (const { note } of this.#notes) {
      const away = (beat - note.beat) * CELLS_PER_BEAT;
      if (note.button === button && Math.abs(away) < nearest) {
        nearest = Math.abs(away);
        missCells = away;
      }
    }
    const noteNear = this.#notes.some(
      ({ note }) => Math.abs(beat - note.beat) * CELLS_PER_BEAT <= BAD.early,
    );
    if (
      freestyleOpen &&
      this.#pairs > 0 &&
      offBeat &&
      !this.#freestyleSlots.has(eighth) &&
      !noteNear &&
      Math.abs(cells) <= COOL.early &&
      this.#freestyle < FREESTYLE_CAP
    ) {
      this.#freestyle += 1;
      this.#freestyleSlots.add(eighth);
      return { beat, cells, freestyle: true, grade: "cool", timing: sign(cells) };
    }
    this.#presses += 1;
    return { beat, cells: missCells, freestyle: false, grade: "miss", timing: sign(missCells) };
  }

  /** Settles every note whose latest window has passed and returns the beats of the new misses. */
  closeOverdue(beat: number): number[] {
    const missed: number[] = [];
    for (const state of this.#notes) {
      if (state.result === undefined && beat > state.note.beat + BAD.late / CELLS_PER_BEAT) {
        state.result = "miss";
        missed.push(state.note.beat);
      }
    }
    return missed;
  }

  /** The line's score once every note is settled; open notes count as missed. */
  finish(): ILineScore {
    this.closeOverdue(BEATS_PER_PART + 1);
    const score = PAIR_WEIGHT * this.#pairs - this.#presses + FREESTYLE_POINTS * this.#freestyle;
    return {
      freestyle: this.#freestyle,
      pairs: this.#pairs,
      presses: this.#presses,
      score,
      threshold: this.#notes.length / THRESHOLD_DIVISOR,
    };
  }
}
