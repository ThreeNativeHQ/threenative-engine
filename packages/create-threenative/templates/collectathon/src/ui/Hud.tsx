import { useUiState } from "@threenative/ui";
import { type GameState, HUD_PILL } from "../state.js";

/** The health meter: eight wedges of one ring, each a slice of the pie. */
function Meter({ wedges }: { wedges: number }) {
  const slices = Array.from({ length: 8 }, (_, i) => {
    const a0 = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const a1 = ((i + 1) / 8) * Math.PI * 2 - Math.PI / 2 - 0.08;
    const point = (a: number, r: number) => `${20 + Math.cos(a) * r} ${20 + Math.sin(a) * r}`;
    return (
      <path
        d={`M ${point(a0, 7)} L ${point(a0, 18)} A 18 18 0 0 1 ${point(a1, 18)} L ${point(a1, 7)} A 7 7 0 0 0 ${point(a0, 7)} Z`}
        fill={i < wedges ? "var(--color-lume)" : "var(--color-line)"}
        key={a0.toFixed(3)}
      />
    );
  });
  return (
    <svg aria-label={`${wedges} of 8 wedges`} className="h-9 w-9" role="img" viewBox="0 0 40 40">
      {slices}
    </svg>
  );
}

/**
 * The one HUD, the same file on every target. It reads published state and nothing else; the
 * bridge flushes about every 100 ms, so the hero's per-frame feel is never read from here.
 */
export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the loading cover lifts: the HUD is page UI the cover cannot hide.
  if (state?.loaded !== true) return null;
  return (
    <div className="pointer-events-none absolute inset-0 p-4 text-sm font-bold text-text">
      {/* Compact and unblurred, so a gem behind the panel still shows through it; it fades while a
          Sunseed sits under it (`Play.ts` measures that against the same `HUD_PILL` box). */}
      <div
        className={`absolute flex items-center gap-3 whitespace-nowrap rounded-2xl border border-line bg-panel/25 px-3 transition-opacity duration-200 ${state.hudFaded ? "opacity-20" : "opacity-100"}`}
        style={HUD_PILL}
      >
        <Meter wedges={state.wedges} />
        <span>
          coins{" "}
          <b id="coins" className="text-lume">
            {state.coins}
          </b>
        </span>
        <span>
          red gems{" "}
          <b id="gems" className="text-lume">
            {state.gems}/{state.gemTotal}
          </b>
        </span>
        <span>
          sunseeds{" "}
          <b id="seeds" className="text-lume">
            {state.seeds}/{state.seedTotal}
          </b>
        </span>
      </div>
      {state.toast !== "" ? (
        <div className="absolute left-1/2 top-16 -translate-x-1/2 rounded-full border-2 border-line bg-panel/40 px-4 py-1 text-base font-bold text-lume backdrop-blur-sm">
          {state.toast}
        </div>
      ) : null}
    </div>
  );
}
