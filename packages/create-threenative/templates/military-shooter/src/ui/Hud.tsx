import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

/** The four ticks of the crosshair sit this many pixels from the middle: the shot cone, drawn. */
function gap(spread: number, fov: number): number {
  const half = window.innerHeight / 2;
  return Math.round((Math.tan((spread * Math.PI) / 180) / Math.tan((fov * Math.PI) / 360)) * half);
}

const TICKS = [
  "left-0 top-1/2 h-px w-2 -translate-y-1/2",
  "right-0 top-1/2 h-px w-2 -translate-y-1/2",
  "left-1/2 top-0 h-2 w-px -translate-x-1/2",
  "bottom-0 left-1/2 h-2 w-px -translate-x-1/2",
] as const;

function Bar({
  label,
  value,
  max,
  tone,
}: { label: string; value: number; max: number; tone: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-14 text-dim">{label}</span>
      <span className="h-2 w-44 bg-panel">
        <span
          className={`block h-2 ${tone}`}
          style={{ width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` }}
        />
      </span>
    </div>
  );
}

export function Hud() {
  const result = useField("phase");
  const shield = useField("shield") ?? 0;
  const health = useField("health") ?? 0;
  const stun = useField("shieldStun") ?? 0;
  const budget = useField("sprintBudget") ?? 0;
  const stance = useField("stance");
  const sprinting = useField("sprinting");
  const aiming = useField("aiming");
  const ammo = useField("ammo") ?? 0;
  const reserve = useField("reserve") ?? 0;
  const reloading = useField("reloading");
  const grenades = useField("grenades") ?? 0;
  const spread = useField("spread") ?? 0;
  const fov = useField("fov") ?? 70;
  const marker = useField("marker");
  const left = useField("enemiesLeft") ?? 0;
  const message = useField("message") ?? "";
  const kills = useField("kills") ?? 0;
  const time = useField("time") ?? 0;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (result === undefined) return null;
  const size = gap(spread, fov);
  return (
    <>
      <div
        id="crosshair"
        className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
        style={{ height: size * 2 + 16, width: size * 2 + 16 }}
      >
        {TICKS.map((tick) => (
          <span key={tick} className={`absolute ${marker === 1 ? "bg-red" : "bg-text"} ${tick}`} />
        ))}
      </div>
      <section
        id="vitals"
        className="pointer-events-none absolute bottom-6 left-6 w-72 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
      >
        <Bar label="shield" max={100} tone={stun > 0 ? "bg-amber" : "bg-cyan"} value={shield} />
        <div className="mt-1" />
        <Bar label="health" max={100} tone="bg-red" value={health} />
        <div className="mt-1" />
        <Bar label="sprint" max={4} tone="bg-text" value={budget} />
        <div className="mt-2 flex justify-between text-dim">
          <span>
            {stance}
            {sprinting === 1 ? " / sprint" : ""}
            {aiming === 1 ? " / sights" : ""}
          </span>
          <span>{left} left</span>
        </div>
      </section>
      <section
        id="weapon"
        className="pointer-events-none absolute bottom-6 right-6 rounded bg-black/70 p-3 text-right text-[10px] uppercase tracking-[0.16em]"
      >
        <div className="text-2xl tabular-nums text-text">
          {reloading === 1 ? "reload" : ammo}
          <span className="ml-2 text-sm text-dim">/ {reserve}</span>
        </div>
        <div className="mt-1 text-dim">grenades {grenades}</div>
      </section>
      {message !== "" && (
        <div
          id="message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      {result !== "playing" && (
        <div
          id="round-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-5 text-center text-xl tracking-[0.4em] ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {result === "won" ? "yard cleared" : "down"}
          <div className="mt-2 text-[10px] tracking-[0.2em] text-dim">
            kills {kills} / {time.toFixed(0)} s / enter to retry
          </div>
        </div>
      )}
    </>
  );
}
