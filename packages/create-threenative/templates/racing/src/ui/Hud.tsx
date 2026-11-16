import { useUiState } from "@threenative/ui";
import { GAUGES } from "../gauges.js";
import type { GameState } from "../state.js";

function clock(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}.${String(Math.floor((seconds % 1) * 10))}`;
}

/**
 * The banked score, for a moment after each drift.
 *
 * The clock is the drift's (`DRIFT.popupSeconds`, counted down by the frame's own `dt`), not this
 * component's: a `setTimeout` here aged the popup while the race was paused and outlived its 1.6
 * game seconds under a harness that advances ticks faster than real time. Keyed on
 * `driftsBanked` by the scene, so two identical scores in a row still pop twice.
 */
function driftPopup(state: GameState | undefined): number | undefined {
  if (state === undefined || state.driftPopup <= 0) return undefined;
  return state.driftLast;
}

function Bar({ value, accent }: { value: number; accent: boolean }) {
  return (
    <div className="mt-1 h-[6px] w-[92px] bg-line/60">
      <div
        className={`h-full ${accent ? "bg-accent" : "bg-muted"}`}
        style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%` }}
      />
    </div>
  );
}

export function Hud() {
  const state = useUiState<GameState>();
  const drift = driftPopup(state);
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  // Rendering zeroes instead would put wrong numbers on screen and then correct them.
  if (state === undefined) return null;
  const statusClass =
    state.raceStatus === "WON"
      ? "text-win"
      : state.raceStatus === "DNF"
        ? "text-danger"
        : "text-accent";
  const redline = state.rpm >= 0.9;
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
            <span className="text-[13px] text-muted"> / {state.racers}</span>
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
        {/* Gear and revs: the gear is what the driver thinks in, the bar is what the engine is
            doing, and both are read off the same needle the sound is pitched from. */}
        <div>
          <div className="text-[10px] text-muted">gear</div>
          <div
            className={`mt-1 text-[26px] leading-none ${redline ? "text-danger" : "text-white"}`}
          >
            <span id="gear">{state.gear}</span>
            <span className="text-[11px] text-muted"> / {GAUGES.gears}</span>
          </div>
          <Bar value={state.rpm} accent={redline} />
        </div>
        <div>
          <div className="text-[10px] text-muted">time</div>
          <div className="mt-1 text-[18px] leading-none text-white" id="time">
            {clock(state.elapsed)}
          </div>
        </div>
        {/* The boost pad and the nitro tank share one bar: both are the same thrust, and a driver
            does not care which switch opened it. */}
        <div className={state.nitroActive || state.boostActive ? "text-accent" : "text-muted"}>
          <div className="text-[10px]">nitro</div>
          <div className="mt-1 text-[18px] leading-none" id="boost">
            {state.nitroActive ? "BURNING" : state.boostActive ? "ACTIVE" : "READY"}
          </div>
          <Bar value={state.nitro} accent={state.nitroActive || state.boostActive} />
        </div>
      </div>
      {drift !== undefined && state.raceStatus === "RACING" && (
        <div
          className="absolute left-1/2 top-16 -translate-x-1/2 bg-panel px-5 py-2 text-center"
          id="drift-popup"
        >
          <div className="text-[10px] text-muted">drift</div>
          <div className="mt-1 text-[22px] leading-none text-accent">+{Math.round(drift)}</div>
        </div>
      )}
      {state.raceStatus !== "RACING" && (
        <div
          className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border px-8 py-5 text-center ${state.raceStatus === "WON" ? "border-win/70 bg-panel" : "border-danger/70 bg-panel"}`}
        >
          <div className={`text-[28px] tracking-[0.28em] ${statusClass}`} id="outcome">
            {/* Every lap done behind the rival is a loss, but not a "did not finish": name the place. */}
            {state.raceStatus === "DNF" && state.completedLaps >= state.totalLaps
              ? `P${state.place}`
              : state.raceStatus}
          </div>
          <div className="mt-2 text-[10px] text-muted">press R to restart</div>
        </div>
      )}
    </div>
  );
}
