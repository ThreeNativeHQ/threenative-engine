import { useUiIntent, useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/**
 * The menu, and the one thing a UI has to do differently from a plain web app: say which of its
 * elements the player can touch.
 *
 * `data-tn-interactive` is that mark. The native input host publishes those rectangles and decides,
 * on pointer-down, whether a touch belongs to the UI or to the game underneath. Everything without
 * the mark is scenery, and a touch on it reaches the game — which is what lets a HUD cover the
 * screen without swallowing the controls.
 *
 * `pointer-events` is still worth setting for the web target's own hit-testing; it is not what
 * makes a touch fall through on a phone, and marking a button with it instead is the one mistake
 * this comment exists to prevent.
 */
export function Menu() {
  const send = useUiIntent();
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  const paused = state.paused;

  return (
    <div className="pointer-events-none absolute bottom-6 left-6 flex items-center gap-3 border border-line bg-panel/75 px-4 py-3 text-[11px] uppercase tracking-[0.14em] text-dim">
      {/* The buttons lead the row so their positions are anchored to the panel's left edge, not to
          the width the instruction text happens to render at on a given platform. The round-9
          native HUD input proof pressed a fraction computed from this layout, and that fraction
          landed on `restart` on Windows and `pause` on macOS because the text width differed. */}
      <button
        aria-pressed={paused}
        className="pointer-events-auto border border-line px-2 py-1 text-text hover:border-lume"
        data-tn-interactive
        onClick={() => send(paused ? "resume" : "pause")}
        type="button"
      >
        {paused ? "resume" : "pause"}
      </button>
      <button
        className="pointer-events-auto border border-line px-2 py-1 text-text hover:border-lume"
        data-tn-interactive
        onClick={() => send("restart")}
        type="button"
      >
        restart
      </button>
      <span>WASD / arrows to move · shift to run · space to jump the gap · reach the flag</span>
    </div>
  );
}
