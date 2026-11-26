import { useUiState } from "@threenative/ui";
import { AIR_SUPPLY, HEALTH_POOL } from "../tuning.js";
import type { GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

const DEATH: Readonly<Record<string, string>> = {
  blade: "sliced by the blade",
  drown: "out of air",
  fall: "a fall too far",
};

export function Hud() {
  const health = useField("health") ?? 0;
  const air = useField("air") ?? AIR_SUPPLY;
  const mode = useField("mode");
  const relic = useField("relic");
  const prompt = useField("prompt") ?? "";
  const message = useField("message") ?? "";
  const result = useField("phase");
  const cause = useField("cause") ?? "";
  const time = useField("time") ?? 0;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (mode === undefined || result === undefined) return null;
  const life = Math.max(0, Math.min(100, (health / HEALTH_POOL) * 100));
  const breath = Math.max(0, Math.min(100, (air / AIR_SUPPLY) * 100));
  return (
    <>
      <section
        id="climb-hud"
        className="pointer-events-none absolute left-6 top-5 w-72 text-[10px] uppercase tracking-[0.16em]"
      >
        <div className="rounded bg-black/70 p-3">
          <div className="flex justify-between text-dim">
            <span>health</span>
            <span>{mode}</span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div
              className={`h-2 ${life > 30 ? "bg-cyan" : "bg-red"}`}
              style={{ width: `${life}%` }}
            />
          </div>
          {breath < 100 && (
            <>
              <div className="mt-2 text-dim">air</div>
              <div className="mt-1 h-2 w-full bg-panel">
                <div className="h-2 bg-amber" style={{ width: `${breath}%` }} />
              </div>
            </>
          )}
          <div className="mt-2 flex justify-between text-dim">
            <span>relic {relic === 1 ? "yes" : "no"}</span>
            <span>{time.toFixed(0)} s</span>
          </div>
        </div>
      </section>
      {prompt !== "" && (
        <div
          id="climb-prompt"
          className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-text"
        >
          {prompt}
        </div>
      )}
      {message !== "" && (
        <div
          id="climb-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      {result !== "playing" && (
        <div
          id="run-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-5 text-center text-xl tracking-[0.4em] ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {result === "won" ? "relic secured" : "you died"}
          <div className="mt-2 text-[10px] tracking-[0.2em] text-dim">
            {result === "won" ? `${time.toFixed(0)} s` : (DEATH[cause] ?? "")}
          </div>
        </div>
      )}
    </>
  );
}
