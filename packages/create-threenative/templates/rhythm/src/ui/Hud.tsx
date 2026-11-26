import { BUTTONS } from "../rhythm/buttons.js";
import { LADDER_SIZE } from "../rhythm/rating.js";
import { BeatBar } from "./BeatBar.js";
import { useField } from "./useField.js";

const LEVEL_STYLE = { cool: "text-amber", good: "text-text", bad: "text-red", awful: "text-red", end: "text-red" } as const;
const GRADE_STYLE = { cool: "text-amber", good: "text-text", bad: "text-red", miss: "text-dim", none: "text-dim" } as const;
const BANDS = [
  { name: "cool", rungs: 2 },
  { name: "good", rungs: 3 },
  { name: "bad", rungs: 2 },
  { name: "awful", rungs: 1 },
] as const;

/** The rating meter: the ladder from COOL at the top to AWFUL, with a marker on the current rung. */
function Meter() {
  const rung = useField("rung") ?? 0;
  const level = useField("level") ?? "good";
  let index = 0;
  return (
    <section id="rating-meter" className="pointer-events-none absolute left-6 top-24 w-44 rounded bg-black/70 p-3 text-[11px] tracking-[0.2em]">
      <div className="text-dim">RATING</div>
      <div className={`mt-1 text-2xl font-bold ${LEVEL_STYLE[level]}`}>{level.toUpperCase()}</div>
      <div className="mt-3 space-y-1">
        {BANDS.map((band) => {
          const rows = Array.from({ length: band.rungs }, (_, step) => index + step);
          index += band.rungs;
          return (
            <div key={band.name} className="flex items-center gap-2">
              <span className={`w-12 ${LEVEL_STYLE[band.name]}`}>{band.name.toUpperCase()}</span>
              <div className="flex flex-1 gap-1">
                {rows.map((row) => (
                  <span key={row} className={`h-3 flex-1 ${row === rung ? "bg-text" : "bg-panel"}`} />
                ))}
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-2 text-dim">
        {rung + 1} / {LADDER_SIZE}
      </div>
    </section>
  );
}

/** Everything the player sees that is not the stage: rating, beat bar, the last grade, the tallies and the result. */
export function Hud() {
  const phase = useField("phase");
  const line = useField("lineIndex") ?? 0;
  const lines = useField("lineCount") ?? 0;
  const lastGrade = useField("lastGrade") ?? "none";
  const lastTiming = useField("lastTiming") ?? "none";
  const cool = useField("cool") ?? 0;
  const good = useField("good") ?? 0;
  const bad = useField("bad") ?? 0;
  const miss = useField("miss") ?? 0;
  const freestyle = useField("freestyle") ?? 0;
  const freestyleOpen = useField("freestyleOpen") ?? 0;
  const message = useField("message") ?? "";
  const part = useField("part") ?? "count-in";
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (phase === undefined) return null;
  return (
    <>
      <section id="song-hud" className="pointer-events-none absolute left-6 top-5 rounded bg-black/70 px-3 py-2 text-[11px] tracking-[0.2em]">
        LINE {Math.min(line + 1, lines)} / {lines}
        <span className="ml-4 text-dim">{part === "teacher" ? "LISTEN" : part === "player" ? "YOUR TURN" : part === "count-in" ? "GET READY" : ""}</span>
      </section>
      <Meter />
      <section id="grade-hud" className="pointer-events-none absolute right-6 top-5 w-56 rounded bg-black/70 p-3 text-[11px] tracking-[0.2em]">
        <div className={`text-3xl font-bold ${GRADE_STYLE[lastGrade]}`}>{lastGrade === "none" ? "-" : lastGrade.toUpperCase()}</div>
        <div className="h-4 text-dim">{lastTiming === "early" || lastTiming === "late" ? lastTiming.toUpperCase() : lastGrade === "none" ? "" : "ON THE BEAT"}</div>
        <div className="mt-2 flex justify-between text-dim">
          <span>COOL {cool}</span>
          <span>GOOD {good}</span>
          <span>BAD {bad}</span>
          <span>MISS {miss}</span>
        </div>
        {freestyleOpen === 1 && <div className="mt-2 text-amber">FREESTYLE: ADD PRESSES ON THE OFF-BEAT</div>}
        {freestyle > 0 && <div className="text-text">FREESTYLE {freestyle}</div>}
      </section>
      <BeatBar />
      {message !== "" && (
        <div id="song-message" className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-xl font-bold tracking-[0.3em] text-amber">
          {message.toUpperCase()}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-5 left-1/2 -translate-x-1/2 rounded bg-black/55 px-4 py-1 text-[11px] tracking-[0.2em] text-dim">
        {BUTTONS.map(({ hint }) => hint).join("   ")}   |   R RESTART
      </div>
      {phase !== "playing" && (
        <div
          id="stage-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/85 px-10 py-6 text-center ${phase === "cleared" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          <div className="text-3xl font-bold tracking-[0.4em]">{phase === "cleared" ? "STAGE CLEAR" : "STAGE FAILED"}</div>
          <div className="mt-3 text-[11px] tracking-[0.2em] text-text">
            COOL {cool} / GOOD {good} / BAD {bad} / MISS {miss} / FREESTYLE {freestyle}
          </div>
          <div className="mt-2 text-[11px] tracking-[0.2em] text-dim">PRESS R TO TRY AGAIN</div>
        </div>
      )}
    </>
  );
}
