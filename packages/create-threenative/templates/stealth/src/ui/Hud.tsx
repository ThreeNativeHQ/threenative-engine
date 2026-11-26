import { useUiState } from "@threenative/ui";
import type { AlertPhase, GameState } from "../state.js";
import { Radar } from "./Radar.js";

const PHASE_LABEL: Readonly<Record<AlertPhase, string>> = {
  alert: "alert",
  caution: "caution",
  evasion: "evasion",
  infiltration: "infiltration",
};

const PHASE_STYLE: Readonly<Record<AlertPhase, string>> = {
  alert: "border-red text-red",
  caution: "border-amber text-amber",
  evasion: "border-amber text-amber",
  infiltration: "border-line text-dim",
};

export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (state === undefined) return null;
  const phase = state.alertPhase;
  const life = Math.max(0, Math.min(100, state.health));
  return (
    <>
      <section
        id="stealth-hud"
        className="pointer-events-none absolute left-6 top-5 w-72 text-[10px] uppercase tracking-[0.16em]"
      >
        <div
          id="alert-phase"
          className={`inline-block border bg-black/70 px-3 py-1 text-sm tracking-[0.3em] ${PHASE_STYLE[phase]}`}
        >
          {PHASE_LABEL[phase]}
          {state.phaseTimer > 0 && <span className="ml-3 tabular-nums">{state.phaseTimer.toFixed(1)}</span>}
        </div>
        <div className="mt-3 rounded bg-black/70 p-3">
          <div className="flex justify-between text-dim">
            <span>life</span>
            <span>{state.stance === "wall" ? "wall" : state.stance}{state.running === 1 ? " / run" : ""}</span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div
              className={`h-2 ${life > 30 ? "bg-cyan" : "bg-red"}`}
              style={{ width: `${life}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-dim">
            <span>keycard {state.keycard === 1 ? "yes" : "no"}</span>
            <span>takedowns {state.takedowns}</span>
          </div>
          <div className="mt-1 text-dim">
            suspicion
            <span className="ml-2 inline-block h-1.5 w-24 bg-panel align-middle">
              <span
                className="block h-1.5 bg-amber"
                style={{ width: `${Math.round(state.suspicion * 100)}%` }}
              />
            </span>
          </div>
        </div>
      </section>
      <Radar />
      {state.prompt !== "" && (
        <div
          id="stealth-prompt"
          className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-text"
        >
          {state.prompt}
        </div>
      )}
      {state.message !== "" && (
        <div
          id="stealth-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {state.message}
        </div>
      )}
      {state.phase !== "playing" && (
        <div
          id="mission-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-5 text-center text-xl tracking-[0.4em] ${state.phase === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {state.phase === "won" ? "mission complete" : "mission failed"}
          <div className="mt-2 text-[10px] tracking-[0.2em] text-dim">
            alerts {state.alerts} / takedowns {state.takedowns} / {state.missionTime.toFixed(0)} s
          </div>
        </div>
      )}
    </>
  );
}
