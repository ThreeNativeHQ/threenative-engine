import { useUiState } from "@threenative/ui";
import type { FighterState, GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

const MAX_STOCKS = 3;
const SHIELD_FULL = 55;

/** White at 0 percent, deep red by 150: the damage a fighter has taken, readable at a glance. */
function percentColor(percent: number): string {
  const heat = Math.min(1, percent / 150);
  return `hsl(${Math.round(20 - 20 * heat)} ${Math.round(10 + 80 * heat)}% ${Math.round(92 - 38 * heat)}%)`;
}

function Plate({
  id,
  name,
  fighter,
  tone,
}: { id: string; name: string; fighter: FighterState; tone: string }) {
  const stocks = Math.max(0, fighter.stocks);
  const shield = Math.max(0, Math.min(1, fighter.shield / SHIELD_FULL));
  return (
    <section id={id} className={`w-60 rounded border-t-4 bg-black/70 px-4 py-2 ${tone}`}>
      <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.24em] text-dim">
        <span>{name}</span>
        <span className="flex gap-1">
          {Array.from({ length: MAX_STOCKS }, (_, stock) => (
            <span
              key={`${id}-stock-${stock + 1}`}
              className={`inline-block h-2.5 w-2.5 rounded-full ${stock < stocks ? "bg-text" : "bg-panel"}`}
            />
          ))}
        </span>
      </div>
      <div
        id={`${id}-percent`}
        className="text-5xl font-bold tabular-nums leading-tight"
        style={{ color: percentColor(fighter.percent) }}
      >
        {Math.floor(fighter.percent)}
        <span className="ml-0.5 text-xl">%</span>
      </div>
      <div className="mt-1 h-1.5 w-full bg-panel">
        <div
          className={`h-1.5 ${fighter.mode === "stun" ? "bg-red" : "bg-cyan"}`}
          style={{ width: `${Math.round(shield * 100)}%` }}
        />
      </div>
    </section>
  );
}

export function Hud() {
  const p1 = useField("p1");
  const cpu = useField("cpu");
  const result = useField("phase");
  const message = useField("message") ?? "";
  const time = useField("time") ?? 0;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (p1 === undefined || cpu === undefined || result === undefined) return null;
  return (
    <>
      <div className="pointer-events-none absolute bottom-6 left-1/2 flex -translate-x-1/2 gap-6">
        <Plate fighter={p1} id="p1-plate" name="you" tone="border-cyan" />
        <Plate fighter={cpu} id="cpu-plate" name="cpu" tone="border-red" />
      </div>
      <div className="pointer-events-none absolute left-6 top-5 text-[10px] uppercase tracking-[0.2em] text-dim">
        {time.toFixed(0)} s
      </div>
      <div className="pointer-events-none absolute right-6 top-5 text-right text-[10px] uppercase leading-5 tracking-[0.2em] text-dim">
        A D move · W jump · S fall · J attack
        <br />K strong (hold) · L shield · Shift roll · R restart
      </div>
      {message !== "" && result === "playing" && (
        <div
          id="fight-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-3xl uppercase tracking-[0.4em] text-amber"
        >
          {message}
        </div>
      )}
      {result !== "playing" && (
        <div
          id="match-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-10 py-6 text-center text-3xl tracking-[0.4em] ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {result === "won" ? "you win" : "you lose"}
          <div className="mt-3 text-[11px] tracking-[0.2em] text-dim">
            kos {cpu.kos} / falls {p1.kos} / {time.toFixed(0)} s / press r for a rematch
          </div>
        </div>
      )}
    </>
  );
}
