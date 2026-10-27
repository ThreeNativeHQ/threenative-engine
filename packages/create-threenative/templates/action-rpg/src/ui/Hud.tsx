import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  const room = state.room;
  const phase = state.phase;
  const enemies = state.enemiesDefeated;
  return (
    <section
      id="run-hud"
      className="pointer-events-none absolute left-6 top-5 w-72 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
    >
      <div className="text-dim">grid dungeon / action rpg</div>
      <div className="mt-2 text-3xl leading-none text-amber">room {room} / 3</div>
      <div className="mt-2 border-t border-line pt-2 text-dim">defeated {enemies}</div>
      {phase !== "playing" && (
        <div
          className={`mt-4 border px-3 py-2 text-center text-sm tracking-[0.28em] ${phase === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {phase === "won" ? "boss defeated" : "run failed"}
        </div>
      )}
    </section>
  );
}
