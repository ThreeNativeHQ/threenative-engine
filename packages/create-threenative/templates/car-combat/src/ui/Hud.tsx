import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

const SHADOW = "drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

/** Damage 0..99 to a colour: grey while new, amber while worn, red at the edge of a wreck. */
function wear(level: number): string {
  if (level >= 70) return "bg-red";
  if (level >= 30) return "bg-amber";
  return "bg-text/60";
}

function Bar({ label, level }: { label: string; level: number }) {
  return (
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider">
      <span className="w-20 text-dim">{label}</span>
      <span className="h-1.5 w-20 overflow-hidden rounded bg-white/20">
        <span
          className={`block h-full ${wear(level)}`}
          style={{ width: `${Math.min(100, level)}%` }}
        />
      </span>
    </div>
  );
}

/** The car from above: each body panel shows how crumpled it is. */
function Panel({ crush, className }: { crush: number; className: string }) {
  return <span className={`absolute rounded-sm ${className} ${wear(crush)}`} />;
}

const GEARS: Record<number, string> = { [-1]: "R", 0: "N" };

export function Hud() {
  const timeLeft = useField("timeLeft");
  const state = {
    banner: useField("banner") ?? "",
    bonusFlash: useField("bonusFlash") ?? 0,
    bonusTotal: useField("bonusTotal") ?? 0,
    brakes: useField("brakes") ?? 0,
    crushFront: useField("crushFront") ?? 0,
    crushLeft: useField("crushLeft") ?? 0,
    crushRear: useField("crushRear") ?? 0,
    crushRight: useField("crushRight") ?? 0,
    engine: useField("engine") ?? 0,
    gear: useField("gear") ?? 0,
    gates: useField("gates") ?? 1,
    gatesPassed: useField("gatesPassed") ?? 0,
    health: useField("health") ?? 100,
    lap: useField("lap") ?? 1,
    laps: useField("laps") ?? 1,
    nextGate: useField("nextGate") ?? 1,
    phase: useField("phase"),
    prompt: useField("prompt") ?? "",
    redline: useField("redline") ?? 7500,
    rivalsTotal: useField("rivalsTotal") ?? 0,
    rivalsWrecked: useField("rivalsWrecked") ?? 0,
    rpm: useField("rpm") ?? 0,
    slipping: useField("slipping") ?? false,
    speedKmh: useField("speedKmh") ?? 0,
    traction: useField("traction") ?? 100,
    transmission: useField("transmission") ?? 0,
    wheels: useField("wheels") ?? 0,
  };
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (timeLeft === undefined) return null;
  const urgent = timeLeft <= 10 && state.phase === "playing";
  const banner = state.phase === "lost" ? "text-red" : "text-[#f5cf52]";
  return (
    <>
      <section
        id="clock"
        className="pointer-events-none absolute left-6 top-5 flex flex-col gap-1 font-mono"
      >
        <div
          className={`text-5xl font-black leading-none ${urgent ? "animate-pulse text-red" : "text-text"} ${SHADOW}`}
        >
          {timeLeft}
          <span className="ml-1 text-xl text-dim">s</span>
          {state.bonusFlash > 0 && <span className="ml-3 text-2xl text-[#7ee08a]">+20</span>}
        </div>
        <div className="rounded bg-black/60 px-2 py-1 text-sm uppercase tracking-[0.14em] text-text">
          lap {state.lap} / {state.laps} · gate {state.gatesPassed} · next {state.nextGate}
        </div>
        <div className="rounded bg-black/60 px-2 py-1 text-sm uppercase tracking-[0.14em] text-text">
          rivals wrecked {state.rivalsWrecked} / {state.rivalsTotal}
        </div>
      </section>
      <section
        id="gauges"
        className="pointer-events-none absolute right-6 top-5 flex flex-col items-end gap-1 font-mono"
      >
        <div className={`text-5xl font-black leading-none text-text ${SHADOW}`}>
          {state.speedKmh}
          <span className="ml-1 text-xl text-dim">km/h</span>
        </div>
        <div className="flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-sm text-text">
          <span className="w-4 text-center text-lg font-bold">
            {GEARS[state.gear] ?? state.gear}
          </span>
          <span className="h-2 w-28 overflow-hidden rounded bg-white/20">
            <span
              className={`block h-full ${state.rpm > state.redline * 0.85 ? "bg-red" : "bg-amber"}`}
              style={{ width: `${Math.min(100, (state.rpm / state.redline) * 100)}%` }}
            />
          </span>
        </div>
        <div
          className={`rounded px-2 py-1 text-xs uppercase tracking-[0.14em] ${state.slipping ? "bg-amber text-black" : "bg-black/60 text-dim"}`}
        >
          grip {state.traction}%{state.slipping ? " · sliding" : ""}
        </div>
      </section>
      <section
        id="damage"
        className="pointer-events-none absolute bottom-6 left-6 flex gap-4 rounded bg-black/60 p-3 font-mono"
      >
        <div className="relative h-24 w-14" aria-label="body panels">
          <Panel crush={state.crushFront} className="left-0 top-0 h-7 w-14" />
          <Panel crush={state.crushLeft} className="left-0 top-8 h-8 w-4" />
          <Panel crush={state.crushRight} className="right-0 top-8 h-8 w-4" />
          <Panel crush={state.crushRear} className="bottom-0 left-0 h-7 w-14" />
          <span className="absolute left-5 top-8 h-8 w-4 rounded-sm bg-white/10" />
        </div>
        <div className="flex flex-col gap-1">
          <Bar label="engine" level={state.engine} />
          <Bar label="gearbox" level={state.transmission} />
          <Bar label="wheels" level={state.wheels} />
          <Bar label="brakes" level={state.brakes} />
        </div>
      </section>
      {state.prompt !== "" && (
        <div className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 font-mono text-base uppercase tracking-[0.14em] text-text">
          {state.prompt}
        </div>
      )}
      {state.banner !== "" && (
        <div className="pointer-events-none absolute inset-x-0 top-[38%] text-center font-mono">
          <span
            className={`inline-block px-6 py-2 text-5xl font-black uppercase tracking-[0.2em] drop-shadow-[0_2px_6px_rgba(0,0,0,0.95)] ${banner}`}
          >
            {state.banner}
          </span>
          <div className="mt-2 text-sm uppercase tracking-[0.2em] text-text">
            press R to restart
          </div>
        </div>
      )}
    </>
  );
}
