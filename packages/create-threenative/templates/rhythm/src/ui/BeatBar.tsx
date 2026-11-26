import { BUTTONS } from "../rhythm/buttons.js";
import type { Grade } from "../rhythm/judge.js";
import { useField } from "./useField.js";

const GLYPH = Object.fromEntries(BUTTONS.map(({ name, glyph }) => [name, glyph]));
const MARK_COLOUR: Readonly<Record<Grade, string>> = {
  cool: "bg-amber",
  good: "bg-cyan",
  bad: "bg-red",
  miss: "bg-dim",
};

/** Where a beat sits on a track, in percent: a margin either side keeps a chip on the first beat clear of the label. */
const at = (beat: number): string => `${5 + (beat / 4) * 90}%`;

/** A track of four beats: tick marks on each beat and whatever the row puts on it, left to right. */
function Track({
  id,
  label,
  active,
  head,
  children,
}: { id: string; label: string; active: boolean; head: number; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span
        className={`w-20 text-right text-[11px] tracking-[0.2em] ${active ? "text-text" : "text-dim"}`}
      >
        {label}
      </span>
      <div
        id={id}
        className={`relative h-11 flex-1 border ${active ? "border-text" : "border-line"} bg-black/60`}
      >
        {[0, 1, 2, 3].map((beat) => (
          <span
            key={beat}
            className="absolute top-0 h-full w-px bg-line"
            style={{ left: at(beat) }}
          />
        ))}
        {children}
        {active && (
          <span
            className="absolute top-0 h-full w-0.5 bg-text"
            style={{ left: at(Math.max(0, Math.min(4, head))) }}
          />
        )}
      </div>
    </div>
  );
}

/**
 * The beat bar: one row for the teacher's call and one for your answer, four beats wide. The
 * playhead runs along the row that is live, the teacher's prompts light as they are called, and
 * each press lands on your row as a chip in its grade's colour.
 */
export function BeatBar() {
  const part = useField("part") ?? "count-in";
  const lineBeat = useField("lineBeat") ?? 0;
  const notes = useField("notes") ?? [];
  const called = useField("called") ?? 0;
  const marks = useField("marks") ?? [];
  const songBeat = useField("songBeat") ?? 0;
  return (
    <section
      id="beat-bar"
      className="pointer-events-none absolute bottom-14 left-1/2 w-[760px] -translate-x-1/2 space-y-2 rounded bg-black/55 p-3"
    >
      <Track id="call-track" label="TEACHER" active={part === "teacher"} head={lineBeat}>
        {notes.map((note, index) => (
          <span
            key={`${note.beat}-${note.button}`}
            className={`absolute top-1 flex h-9 w-9 -translate-x-1/2 items-center justify-center text-lg font-bold ${index < called ? "bg-amber text-black" : "bg-panel text-dim"}`}
            style={{ left: at(note.beat) }}
          >
            {GLYPH[note.button]}
          </span>
        ))}
      </Track>
      <Track id="answer-track" label="YOU" active={part === "player"} head={lineBeat - 4}>
        {notes.map((note) => (
          <span
            key={`${note.beat}-${note.button}`}
            className="absolute top-1 flex h-9 w-9 -translate-x-1/2 items-center justify-center border border-dashed border-line text-lg font-bold text-dim"
            style={{ left: at(note.beat) }}
          >
            {GLYPH[note.button]}
          </span>
        ))}
        {marks.map((mark) => (
          <span
            key={mark.id}
            className={`absolute bottom-0 h-3 w-3 -translate-x-1/2 ${mark.freestyle ? "bg-text" : MARK_COLOUR[mark.grade]}`}
            style={{ left: at(Math.max(0, mark.beat)) }}
          />
        ))}
      </Track>
      {part === "count-in" && (
        <div id="count-in" className="text-center text-3xl font-bold tracking-[0.4em] text-text">
          {Math.max(1, Math.ceil(-songBeat))}
        </div>
      )}
    </section>
  );
}
