import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/**
 * The HUD. Plain Tailwind, plain DOM, and the same file on every target.
 *
 * `useUiState` reads the game's *published* state, which moves at about 10 Hz rather than at the
 * frame rate, and is undefined until the game publishes its first snapshot — so nothing is drawn
 * until there is something true to draw.
 */
export function Hud() {
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  const won = state.status === "won";
  const replaying = state.replayPhase === "first" || state.replayPhase === "second";

  return (
    <>
      {/* What a player needs: their progress (the goal is the menu's line). The vault's physics telemetry (bodies,
          blocked ticks, seal contacts, replay drift) stays in the published state for scenarios. */}
      <div className="pointer-events-none absolute left-6 top-6 w-56 select-none">
        <div className="text-[10px] uppercase tracking-[0.22em] text-dim">warden vault</div>

        <dl className="mt-4 space-y-1 text-[11px] uppercase tracking-[0.12em]">
          <Row label="crates shoved" value={state.pushedCrates} />
          {state.replayPhase === "done" ? (
            <Row label="replay" tone="lume" value={state.replayMatch ? "matched" : "drifted"} />
          ) : null}
        </dl>
      </div>

      <div className="pointer-events-none absolute bottom-6 left-6 select-none text-[10px] uppercase leading-relaxed tracking-[0.14em] text-dim">
        <div>arrows or wasd — shove the crates</div>
        <div>v — run the vault twice and compare</div>
        <div>r — reset the vault</div>
      </div>

      {replaying ? (
        <div className="pointer-events-none absolute inset-x-0 top-8 flex justify-center">
          <output className="border border-line bg-panel/80 px-4 py-2 text-[11px] uppercase tracking-[0.2em] text-lume">
            determinism check — pass {state.replayPhase === "first" ? "1" : "2"} of 2
          </output>
        </div>
      ) : null}

      {won ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 flex flex-col items-center gap-2">
          <output className="text-5xl uppercase tracking-[0.2em] text-lume">seal broken</output>
          <div className="text-[11px] uppercase tracking-[0.14em] text-dim">
            reached by {state.sealedBy === "warden" ? "the warden" : "a shoved crate"} — press r to
            reset
          </div>
        </div>
      ) : null}
    </>
  );
}

function Row({
  label,
  tone,
  value,
}: {
  label: string;
  tone?: "lume";
  value: number | string;
}) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className={`tabular-nums ${tone === "lume" ? "text-lume" : "text-text"}`}>{value}</dd>
    </div>
  );
}
