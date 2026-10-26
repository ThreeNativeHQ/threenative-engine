import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 10))}`;
}

export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  const statusClass =
    state.raceStatus === "WON"
      ? "text-win"
      : state.raceStatus === "DNF"
        ? "text-danger"
        : "text-accent";
  return (
    <div className="pointer-events-none absolute inset-0 p-6 text-[11px] uppercase tracking-[0.16em] text-text">
      <div className="flex items-start justify-between">
        <div className="-m-3 bg-panel p-3">
          <div className="text-[10px] text-muted">circuit / northern loop</div>
          <div className="mt-2 flex items-baseline gap-5 text-[18px] text-white">
            <span>
              lap <b id="lap">{Math.min(state.totalLaps, state.completedLaps + 1)}</b>/
              <b>{state.totalLaps}</b>
            </span>
            <span className={statusClass} id="race-status">
              {state.raceStatus}
            </span>
          </div>
        </div>
        <div className="-m-3 bg-panel p-3 text-right">
          <div className="text-[10px] text-muted">position</div>
          <div className="mt-2 text-[22px] text-white" id="position">
            P{state.place}
          </div>
        </div>
      </div>
      <div className="absolute bottom-6 left-6 -m-3 flex items-end gap-8 bg-panel p-3">
        <div>
          <div className="text-[10px] text-muted">speed</div>
          <div className="mt-1 text-[26px] leading-none text-white">
            <span id="speed">{Math.round(state.speed * 3.6)}</span>
            <span className="text-[11px] text-muted"> km/h</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-muted">time</div>
          <div className="mt-1 text-[18px] leading-none text-white" id="time">
            {clock(state.elapsed)}
          </div>
        </div>
        <div className={state.boostActive ? "text-accent" : "text-muted"}>
          <div className="text-[10px]">boost</div>
          <div className="mt-1 text-[18px] leading-none" id="boost">
            {state.boostActive ? "ACTIVE" : "READY"}
          </div>
        </div>
      </div>
      {state.raceStatus !== "RACING" && (
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border px-8 py-5 text-center ${state.raceStatus === "WON" ? "border-win/70 bg-panel" : "border-danger/70 bg-panel"}`}
        >
          <div className={`text-[28px] tracking-[0.28em] ${statusClass}`}>{state.raceStatus}</div>
          <div className="mt-2 text-[10px] text-muted">press R to restart</div>
        </div>
      )}
    </div>
  );
}
