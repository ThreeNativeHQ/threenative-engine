import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

export function Hud() {
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  const statusClass =
    state.status === "won" ? "text-win" : state.status === "lost" ? "text-danger" : "text-accent";
  return (
    <div className="pointer-events-none absolute inset-0 p-6 text-[11px] uppercase tracking-[0.16em] text-text">
      <div className="flex items-start justify-between gap-4">
        {/* A panel, not loose type. The sailing kit puts the frame two thirds sky and a bright
            specular path across the water, and a HUD written straight onto that is unreadable for
            exactly as long as the wind is up. */}
        <div className="rounded bg-black/70 px-4 py-3">
          <div className="text-[10px] text-muted">passage / bluewater run</div>
          <div className="mt-2 flex items-baseline gap-5 text-[18px] text-white">
            <span>
              buoys <b id="buoys-rounded">{state.buoysRounded}</b>/4
            </span>
            <span className={statusClass} id="sailing-status">
              {state.status}
            </span>
          </div>
        </div>
        <div className="flex items-start gap-4">
          <div className="rounded bg-black/70 px-4 py-3 text-right">
            <div className="text-[10px] text-muted">next mark</div>
            <div className="mt-2 flex items-center justify-end gap-3">
              {/* The arrow the course is steered by. Without it the fourth mark is a hundred
                  metres away behind a headland and the player is guessing. `markBearing` is
                  already relative to the bow, so this is a plain rotation with no compass maths
                  in the view. */}
              <span
                className="inline-block text-[20px] leading-none text-accent"
                id="mark-bearing"
                style={{ rotate: `${state.markBearing}rad` }}
              >
                ↑
              </span>
              <span className="text-[22px] text-white" id="mark-distance">
                {Math.round(state.markDistance)}
                <span className="text-[11px] text-muted">m</span>
              </span>
            </div>
          </div>
          <div className="rounded bg-black/70 px-4 py-3 text-right">
            <div className="text-[10px] text-muted">wind</div>
            <div className="mt-2 text-[22px] text-white" id="wind">
              {Math.round(state.wind * 100)}%
            </div>
          </div>
        </div>
      </div>
      <div className="absolute bottom-6 left-6 flex items-end gap-6">
        <div className="rounded bg-black/70 px-4 py-3">
          <div className="text-[10px] text-muted">waterline</div>
          <div className="mt-1 text-[26px] leading-none text-white" id="submerged-fraction">
            {Math.round(state.submergedFraction * 100)}
            <span className="text-[11px] text-muted">%</span>
          </div>
        </div>
        <div className="rounded bg-black/70 px-4 py-3">
          <div className="text-[10px] text-muted">speed</div>
          <div className="mt-1 text-[18px] leading-none text-white" id="speed">
            {(state.speed * 1.944).toFixed(1)}
            <span className="text-[11px] text-muted">kn</span>
          </div>
        </div>
        <div className="rounded bg-black/70 px-4 py-3">
          <div className="text-[10px] text-muted">elapsed</div>
          <div className="mt-1 text-[18px] leading-none text-white" id="elapsed">
            {state.elapsed.toFixed(1)}s
          </div>
        </div>
      </div>
      {state.status === "sailing" ? null : (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border border-accent/70 bg-panel/80 px-8 py-5 text-center">
          <div className={`text-[28px] tracking-[0.28em] ${statusClass}`} id="outcome">
            {state.status === "won"
              ? "course complete"
              : state.wind <= 0
                ? "out of wind"
                : "capsized"}
          </div>
          <div className="mt-2 text-[10px] text-muted">press R to restart</div>
        </div>
      )}
    </div>
  );
}
