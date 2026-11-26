import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

const STAR_SLOTS = [1, 2, 3, 4, 5] as const;
const SHADOW = "drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]";

/** `$00001200`: the eight-digit purse the genre counts in. */
function purse(money: number): string {
  return `$${Math.max(0, Math.floor(money)).toString().padStart(8, "0")}`;
}

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

export function Hud() {
  const state = {
    ammo: useField("ammo") ?? 0,
    banner: useField("banner") ?? "",
    carHealth: useField("carHealth") ?? 0,
    clip: useField("clip") ?? 0,
    health: useField("health") ?? 0,
    job: useField("job"),
    jobTime: useField("jobTime") ?? 0,
    mode: useField("mode"),
    money: useField("money"),
    phase: useField("phase"),
    prompt: useField("prompt") ?? "",
    speedKmh: useField("speedKmh") ?? 0,
    stars: useField("stars") ?? 0,
    starsFlashing: useField("starsFlashing") ?? false,
    weapon: useField("weapon"),
  };
  const aiming = useField("aiming") ?? false;
  const locked = useField("locked") ?? false;
  const reticleX = useField("reticleX") ?? -1;
  const reticleY = useField("reticleY") ?? -1;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (state.money === undefined) return null;
  const driving = state.mode === "driving";
  const banner =
    state.phase === "wasted"
      ? "text-red"
      : state.phase === "busted"
        ? "text-[#6f9bff]"
        : "text-[#f5cf52]";
  return (
    <>
      <section
        id="status"
        className="pointer-events-none absolute right-6 top-5 flex flex-col items-end gap-1 text-right font-mono"
      >
        <div
          className="flex gap-1 rounded bg-black/75 px-2 py-1 text-2xl leading-none"
          aria-label={`wanted level ${state.stars} of 5`}
        >
          {STAR_SLOTS.map((slot) => (
            <span
              key={slot}
              className={
                slot <= state.stars
                  ? `text-[#f5cf52] ${SHADOW} ${state.starsFlashing ? "animate-pulse" : ""}`
                  : "text-dim"
              }
            >
              ★
            </span>
          ))}
        </div>
        <div className={`text-3xl font-bold leading-none text-[#7ee08a] ${SHADOW}`}>
          {purse(state.money)}
        </div>
        <div className="mt-1 rounded bg-black/60 px-2 py-1 text-sm uppercase tracking-[0.14em] text-text">
          {state.weapon === "pistol" ? `pistol ${state.clip} / ${state.ammo - state.clip}` : "fist"}
        </div>
        <div className="flex items-center gap-2 rounded bg-black/60 px-2 py-1 text-sm text-text">
          <span>health</span>
          <span className="h-2 w-24 overflow-hidden rounded bg-white/20">
            <span
              className="block h-full bg-red"
              style={{ width: `${Math.max(0, Math.min(100, state.health))}%` }}
            />
          </span>
        </div>
        {driving && (
          <div className="rounded bg-black/60 px-2 py-1 text-sm text-text">
            {state.speedKmh} km/h · car {state.carHealth}%
          </div>
        )}
        {(state.job === "pickup" || state.job === "deliver") && (
          <div className="mt-2 rounded bg-black/70 px-3 py-1 text-lg font-bold text-[#f5cf52]">
            {state.job === "pickup" ? "get the yellow car" : "deliver it to the lot"} ·{" "}
            {state.jobTime}s
          </div>
        )}
      </section>
      {aiming && reticleX >= 0 && (
        // Locked on: a red ring on the target. Free aim: a small white ring where the shot goes.
        <div
          className={
            locked
              ? "pointer-events-none absolute size-10 -translate-x-1/2 -translate-y-1/2 rounded-full border-4 border-red shadow-[0_0_4px_rgba(0,0,0,0.9)]"
              : "pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow-[0_0_3px_rgba(0,0,0,0.9)]"
          }
          style={{ left: `${reticleX}%`, top: `${reticleY}%` }}
        />
      )}
      {state.prompt !== "" && (
        <div className="pointer-events-none absolute bottom-10 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 font-mono text-base text-text">
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
        </div>
      )}
    </>
  );
}
