import type { ButtonName } from "./rhythm/buttons.js";
import type { Grade, Timing } from "./rhythm/judge.js";
import type { Level } from "./rhythm/rating.js";
import type { IMark, Outcome, Part } from "./rhythm/session.js";

export type GamePhase = Outcome;

/** A prompt on the beat bar: a button on a beat of the four-beat part. */
export type NoteView = { readonly beat: number; readonly button: ButtonName };

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  /** "count-in", "teacher" (the call), "player" (your answer) or "result". */
  part: Part;
  bpm: number;
  /** Beats since the first call; negative during the count-in. Floored to a thousandth. */
  songBeat: number;
  /** Whole beats of the song so far (floor of `songBeat`). */
  beatCount: number;
  /** 1 on the beat, falling toward 0. The stage lights and the bobbing read the same value. */
  pulse: number;
  /** Zero-based line being played, and how many the song has. */
  lineIndex: number;
  lineCount: number;
  /** Beat inside the eight-beat line: 0 to 4 is the call, 4 to 8 is the answer. */
  lineBeat: number;
  /** This line's prompts, and how many of them the teacher has already called. */
  notes: readonly NoteView[];
  called: number;
  /** The answer bar: every press and miss of this line. */
  marks: readonly IMark[];
  /** Notes of this line answered so far. */
  matched: number;
  lastGrade: Grade | "none";
  lastTiming: Timing | "none";
  /** Signed distance of the last press from its note in cells (a 24th of a beat). */
  lastCells: number;
  cool: number;
  good: number;
  bad: number;
  miss: number;
  presses: number;
  /** Rating rung, 0 best; and the band it falls in. */
  rung: number;
  level: Level;
  /** 1 while the rating is cool: extra off-beat presses score. */
  freestyleOpen: number;
  /** Improvised presses that scored, over the whole song. */
  freestyle: number;
  linesJudged: number;
  /** The last judged line's score and the score that line needed. */
  lineScore: number;
  lineThreshold: number;
  /** A short message the HUD shows for a moment, such as "Freestyle". */
  message: string;
};
