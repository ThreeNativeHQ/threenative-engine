import type { ButtonName } from "./buttons.js";
import { BEATS_PER_LINE, BEATS_PER_PART, type INote, LINES } from "./chart.js";
import { BeatClock } from "./clock.js";
import type { Grade, Timing } from "./judge.js";
import { EARLY_GUARD_BEATS, type ILineScore, type IPressResult, LineJudge } from "./judge.js";
import { LADDER_SIZE, START_RUNG, clears, levelOf, nextRung } from "./rating.js";

export type Part = "count-in" | "teacher" | "player" | "result";
export type Outcome = "playing" | "cleared" | "failed";

/** One answer on the response bar: where it landed in the part and how it was graded. */
export interface IMark {
  /** Position in the line's mark list: a stable key for the response bar. */
  readonly id: number;
  readonly beat: number;
  readonly grade: Grade;
  readonly timing: Timing;
  readonly freestyle: boolean;
}

export type SessionEvent =
  | { readonly kind: "call"; readonly button: ButtonName }
  /** `result` is undefined for a press that is not graded: a dance step during the call or the result. */
  | {
      readonly kind: "press";
      readonly button: ButtonName;
      readonly result: IPressResult | undefined;
    }
  | { readonly kind: "miss"; readonly beat: number }
  | {
      readonly kind: "line";
      readonly line: number;
      readonly score: ILineScore;
      readonly before: number;
      readonly after: number;
    }
  | { readonly kind: "end"; readonly outcome: "cleared" | "failed" };

export interface ICounts {
  cool: number;
  good: number;
  bad: number;
  miss: number;
  presses: number;
  /** Improvised presses that scored in the top rating, over the whole song. */
  freestyle: number;
}

/**
 * One run of the song: the beat clock, the line being judged, the rating and the tallies. It owns
 * no graphics and no input device; `Play` feeds it presses and reads its events, so the same rules
 * run in a playtest and on a stage.
 */
export class Session {
  readonly clock = new BeatClock();
  readonly counts: ICounts = { bad: 0, cool: 0, freestyle: 0, good: 0, miss: 0, presses: 0 };
  line = 0;
  rung = START_RUNG;
  outcome: Outcome = "playing";
  linesJudged = 0;
  lastScore: ILineScore | undefined;
  marks: IMark[] = [];
  /** True when the lists changed since `Play` last copied them into the game state. */
  listsDirty = true;
  #judge = new LineJudge(LINES[0] as readonly INote[]);
  #cue = 0;

  get notes(): readonly INote[] {
    return LINES[Math.min(this.line, LINES.length - 1)] as readonly INote[];
  }

  /** Beat inside the current line, negative during the count-in. */
  get lineBeat(): number {
    return this.clock.beat - this.line * BEATS_PER_LINE;
  }

  get part(): Part {
    if (this.outcome !== "playing") return "result";
    if (this.clock.beat < 0) return "count-in";
    return this.lineBeat < BEATS_PER_PART ? "teacher" : "player";
  }

  get level() {
    return levelOf(this.rung);
  }

  /** Notes the teacher has already called in this line. */
  get called(): number {
    return this.part === "teacher" || this.part === "player" ? this.#cue : 0;
  }

  /** Notes of this line the player has answered (any grade but a miss). */
  get matched(): number {
    return this.#judge.results.filter((grade) => grade !== undefined && grade !== "miss").length;
  }

  update(dt: number, pressed: readonly ButtonName[]): SessionEvent[] {
    const events: SessionEvent[] = [];
    this.clock.advance(dt);
    if (this.outcome === "playing") {
      while (this.outcome === "playing" && this.clock.beat >= (this.line + 1) * BEATS_PER_LINE)
        this.#finishLine(events);
    }
    if (this.outcome === "playing" && this.part !== "count-in") {
      const local = this.lineBeat;
      const notes = this.notes;
      while (
        this.#cue < notes.length &&
        local >= (notes[this.#cue] as INote).beat &&
        local < BEATS_PER_PART
      ) {
        events.push({ button: (notes[this.#cue] as INote).button, kind: "call" });
        this.#cue += 1;
      }
      for (const beat of this.#judge.closeOverdue(local - BEATS_PER_PART)) this.#miss(beat, events);
    }
    for (const button of pressed) this.#press(button, events);
    return events;
  }

  #press(button: ButtonName, events: SessionEvent[]): void {
    const answer = this.lineBeat - BEATS_PER_PART;
    if (this.outcome !== "playing" || this.part === "count-in" || answer < -EARLY_GUARD_BEATS) {
      events.push({ button, kind: "press", result: undefined });
      return;
    }
    const result = this.#judge.press(button, answer, this.level === "cool");
    if (result.freestyle) this.counts.freestyle += 1;
    else {
      this.counts.presses += 1;
      this.counts[result.grade] += 1;
    }
    this.marks.push({
      beat: result.beat,
      id: this.marks.length,
      freestyle: result.freestyle,
      grade: result.grade,
      timing: result.timing,
    });
    this.listsDirty = true;
    events.push({ button, kind: "press", result });
  }

  #miss(beat: number, events: SessionEvent[]): void {
    this.counts.miss += 1;
    this.marks.push({
      beat,
      freestyle: false,
      grade: "miss",
      id: this.marks.length,
      timing: "late",
    });
    this.listsDirty = true;
    events.push({ beat, kind: "miss" });
  }

  #finishLine(events: SessionEvent[]): void {
    // Every note still open is a miss; count and report them before the score is read.
    for (const beat of this.#judge.closeOverdue(BEATS_PER_PART + 1)) this.#miss(beat, events);
    const score = this.#judge.finish();
    const before = this.rung;
    this.rung = nextRung(before, score.score, score.threshold);
    this.lastScore = score;
    this.linesJudged += 1;
    events.push({ after: this.rung, before, kind: "line", line: this.line, score });
    this.line += 1;
    if (levelOf(this.rung) === "end" || this.rung >= LADDER_SIZE - 1) this.#end("failed", events);
    else if (this.line >= LINES.length) this.#end(clears(this.rung) ? "cleared" : "failed", events);
    else {
      this.#judge = new LineJudge(LINES[this.line] as readonly INote[]);
      this.#cue = 0;
      this.marks = [];
      this.listsDirty = true;
    }
  }

  #end(outcome: "cleared" | "failed", events: SessionEvent[]): void {
    this.outcome = outcome;
    events.push({ kind: "end", outcome });
  }
}
