import { useField } from "./useField.js";

/** The black of a door opening, and the two ends of a run. */
export function Screens() {
  const menu = useField("menu");
  const phase = useField("phase");
  const time = useField("time") ?? 0;
  const saveCount = useField("saveCount") ?? 0;
  const shots = useField("shots") ?? 0;
  const hasSave = useField("hasSave") ?? false;
  const message = useField("message") ?? "";
  if (phase === undefined) return null;
  if (phase === "playing")
    return menu === "door" ? (
      // Fades down, holds while the survivor is moved, fades up: the length of `DOOR_TIME`.
      <div
        id="door-fade"
        className="door-fade absolute inset-0 flex items-end justify-center bg-black pb-16"
      >
        {message !== "" && <p className="text-sm text-text">{message}</p>}
      </div>
    ) : null;
  const won = phase === "won";
  return (
    <section
      id={won ? "escaped" : "you-died"}
      className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-black/85"
    >
      <h1 className={`text-5xl uppercase tracking-[0.4em] ${won ? "text-text" : "text-red"}`}>
        {won ? "Escaped" : "You died"}
      </h1>
      {won && (
        <p className="text-sm uppercase tracking-[0.2em] text-text">
          {Math.floor(time / 60)}m {Math.floor(time % 60)}s · saves {saveCount} · shots {shots}
        </p>
      )}
      <p className="text-xs uppercase tracking-[0.2em] text-text">
        {won
          ? "Enter · new game"
          : hasSave
            ? "Enter · continue from your last save · N · new game"
            : "Enter · try again"}
      </p>
    </section>
  );
}
