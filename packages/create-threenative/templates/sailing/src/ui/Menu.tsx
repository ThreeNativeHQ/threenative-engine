import { useUiIntent, useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Menu() {
  const send = useUiIntent();
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  return (
    <div className="pointer-events-none absolute bottom-6 right-6 flex items-center gap-3 border border-line bg-panel/75 px-4 py-3 text-[10px] uppercase tracking-[0.14em] text-muted">
      <span>WASD / arrows steer and trim</span>
      <button
        aria-pressed={state.paused}
        className="pointer-events-auto border border-line px-2 py-1 text-text hover:border-accent"
        data-tn-interactive
        onClick={() => send(state.paused ? "resume" : "pause")}
        type="button"
      >
        {state.paused ? "resume" : "pause"}
      </button>
      <button
        className="pointer-events-auto border border-line px-2 py-1 text-text hover:border-accent"
        data-tn-interactive
        onClick={() => send("restart")}
        type="button"
      >
        restart
      </button>
    </div>
  );
}
