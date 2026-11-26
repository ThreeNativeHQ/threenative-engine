import { useUiState } from "@threenative/ui";
import { CROPS } from "../farm/crops.js";
import { HOTBAR, STAMINA_MAX, WATER_MAX } from "../farm/tools.js";
import type { GameState } from "../state.js";
import { Summary } from "./Summary.js";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

const TIER_BAR = ["bg-leaf", "bg-leaf", "bg-amber", "bg-red"] as const;
const TARGET_LABEL: Readonly<Record<string, string>> = {
  dead: "withered crop",
  growing: "growing",
  none: "",
  plain: "grass",
  ripe: "ripe",
  rock: "rock",
  seedling: "seedling",
  tilled: "dry soil",
  watered: "wet soil",
  weed: "weeds",
};

export function Hud() {
  const clock = useField("clock");
  const season = useField("season") ?? "";
  const day = useField("day") ?? 1;
  const weekday = useField("weekday") ?? "";
  const year = useField("year") ?? 1;
  const money = useField("money") ?? 0;
  const stamina = useField("stamina") ?? 0;
  const tier = useField("tier") ?? 0;
  const water = useField("water") ?? 0;
  const slot = useField("slot") ?? 0;
  const seeds = useField("seeds");
  const carrying = useField("carrying") ?? "";
  const binCount = useField("binCount") ?? 0;
  const binValue = useField("binValue") ?? 0;
  const prompt = useField("prompt") ?? "";
  const message = useField("message") ?? "";
  const targetKind = useField("targetKind") ?? "none";
  const phase = useField("phase");
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (clock === undefined || seeds === undefined || phase === undefined) return null;
  return (
    <>
      <section
        id="farm-hud"
        className="pointer-events-none absolute left-6 top-5 w-64 text-[11px] uppercase tracking-[0.14em]"
      >
        <div className="rounded bg-black/65 p-3">
          <div className="flex items-baseline justify-between">
            <span id="farm-clock" className="text-2xl tabular-nums text-amber">
              {clock}
            </span>
            <span className="text-dim">year {year}</span>
          </div>
          <div id="farm-date" className="mt-1 text-text">
            {season} {day} / {weekday}
          </div>
          <div id="farm-money" className="mt-2 flex justify-between text-amber">
            <span>gold</span>
            <span className="tabular-nums">{money} G</span>
          </div>
          <div className="mt-2 flex justify-between text-dim">
            <span>stamina</span>
            <span className="tabular-nums">{stamina}</span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div
              id="farm-stamina"
              className={`h-2 ${TIER_BAR[tier] ?? "bg-red"}`}
              style={{ width: `${(stamina / STAMINA_MAX) * 100}%` }}
            />
          </div>
          <div className="mt-2 flex justify-between text-dim">
            <span>water</span>
            <span className="tabular-nums">
              {water}/{WATER_MAX}
            </span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div className="h-2 bg-water" style={{ width: `${(water / WATER_MAX) * 100}%` }} />
          </div>
          <div className="mt-2 flex justify-between text-dim">
            <span>bin</span>
            <span className="tabular-nums">
              {binCount} / {binValue} G
            </span>
          </div>
          {targetKind !== "none" && (
            <div className="mt-2 text-dim">
              tile <span className="text-text">{TARGET_LABEL[targetKind] ?? targetKind}</span>
            </div>
          )}
          {carrying !== "" && <div className="mt-1 text-leaf">carrying {carrying}</div>}
        </div>
      </section>
      {message !== "" && (
        <div
          id="farm-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 rounded bg-black/60 px-4 py-2 text-sm uppercase tracking-[0.24em] text-amber"
        >
          {message}
        </div>
      )}
      {prompt !== "" && (
        <div
          id="farm-prompt"
          className="pointer-events-none absolute bottom-24 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-text"
        >
          {prompt}
        </div>
      )}
      <div
        id="farm-hotbar"
        className="pointer-events-none absolute bottom-5 left-1/2 flex -translate-x-1/2 gap-1.5"
      >
        {HOTBAR.map((entry, index) => {
          const crop = entry.kind === "seed" ? entry.crop : undefined;
          return (
            <div
              key={entry.label}
              className={`flex h-14 w-[4.5rem] flex-col items-center justify-center rounded border text-[10px] uppercase tracking-[0.1em] ${
                index === slot ? "border-amber bg-black/80 text-amber" : "border-line bg-black/55 text-dim"
              }`}
            >
              <span className="text-xs">{index + 1}</span>
              <span>{crop === undefined ? entry.label : CROPS[crop].label}</span>
              {crop !== undefined && <span className="text-text">x{seeds[crop]}</span>}
            </div>
          );
        })}
      </div>
      {phase === "summary" && <Summary />}
    </>
  );
}
