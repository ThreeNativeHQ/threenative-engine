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

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

export function Hud() {
  const phase = useField("alertPhase");
  const phaseTimer = useField("phaseTimer") ?? 0;
  const health = useField("health") ?? 0;
  const stance = useField("stance");
  const running = useField("running");
  const keycard = useField("keycard");
  const takedowns = useField("takedowns") ?? 0;
  const suspicion = useField("suspicion") ?? 0;
  const prompt = useField("prompt") ?? "";
  const message = useField("message") ?? "";
  const result = useField("phase");
  const alerts = useField("alerts") ?? 0;
  const missionTime = useField("missionTime") ?? 0;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (phase === undefined || result === undefined) return null;
  const life = Math.max(0, Math.min(100, health));
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
          {phaseTimer > 0 && <span className="ml-3 tabular-nums">{phaseTimer.toFixed(1)}</span>}
        </div>
        <div className="mt-3 rounded bg-black/70 p-3">
          <div className="flex justify-between text-dim">
            <span>life</span>
            <span>
              {stance}
              {running === 1 ? " / run" : ""}
            </span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div
              className={`h-2 ${life > 30 ? "bg-cyan" : "bg-red"}`}
              style={{ width: `${life}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-dim">
            <span>keycard {keycard === 1 ? "yes" : "no"}</span>
            <span>takedowns {takedowns}</span>
          </div>
          <div className="mt-1 text-dim">
            suspicion
            <span className="ml-2 inline-block h-1.5 w-24 bg-panel align-middle">
              <span
                className="block h-1.5 bg-amber"
                style={{ width: `${Math.round(suspicion * 100)}%` }}
              />
            </span>
          </div>
        </div>
      </section>
      <Radar />
      {prompt !== "" && (
        <div
          id="stealth-prompt"
          className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-text"
        >
          {prompt}
        </div>
      )}
      {message !== "" && (
        <div
          id="stealth-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      {result !== "playing" && (
        <div
          id="mission-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-5 text-center text-xl tracking-[0.4em] ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {result === "won" ? "mission complete" : "mission failed"}
          <div className="mt-2 text-[10px] tracking-[0.2em] text-dim">
            alerts {alerts} / takedowns {takedowns} / {missionTime.toFixed(0)} s
          </div>
        </div>
      )}
    </>
  );
}
