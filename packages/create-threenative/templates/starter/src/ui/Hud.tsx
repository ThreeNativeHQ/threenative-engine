import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/**
 * The HUD. Plain Tailwind, plain SVG, plain DOM — and the same file on every target.
 *
 * There is no second renderer to keep in step: on web this mounts beside the canvas, and on a
 * phone or a desktop the same bundle renders in the platform's own web view over the game surface.
 * Style it however you like; nothing here is a vocabulary the framework has to understand.
 *
 * `useUiState` reads the game's *published* state, published once per rendered game frame by default,
 * and is undefined until the game publishes its first snapshot.
 */
export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in. Rendering
  // zeroes instead would put a wrong score on screen and then correct it.
  if (state === undefined) return null;
  const position = state.progress;
  const won = state.status === "won";

  return (
    <>
      <div className="pointer-events-none absolute left-6 top-6 -m-3 box-content w-32 rounded bg-panel p-3">
        <div className="text-[10px] uppercase tracking-[0.14em] text-dim">score</div>
        <div className="text-4xl leading-none tabular-nums text-lume">{state.score}</div>
        <div className="mt-3 flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-dim">
          lives
          {[0, 1, 2].map((slot) => (
            <i
              className={`h-2 w-2 border border-line ${slot < state.lives ? "bg-lume" : "bg-panel"}`}
              key={slot}
            />
          ))}
        </div>
        <div className="mt-3 w-24">
          <div className="flex justify-between gap-2 text-[10px] uppercase tracking-[0.14em] text-dim">
            <span>position</span>
            <b className="font-normal tabular-nums text-text">{Math.round(position)}</b>
          </div>
          <div className="relative mt-1 h-1 overflow-hidden border border-line bg-panel">
            <i className="absolute inset-y-0 left-0 bg-lume" style={{ width: `${position}%` }} />
          </div>
        </div>
      </div>
      {state.status === "playing" ? null : (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-2">
          <output
            className={`text-5xl uppercase tracking-[0.2em] ${won ? "text-lume" : "text-text"}`}
          >
            {won ? "flag reached" : "out of lives"}
          </output>
          <div className="text-[11px] uppercase tracking-[0.14em] text-dim">
            press r to run it again
          </div>
        </div>
      )}
    </>
  );
}
