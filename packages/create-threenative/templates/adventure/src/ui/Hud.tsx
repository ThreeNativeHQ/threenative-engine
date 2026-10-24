import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

const HEART = "M10 17 L2.6 9.6 A4.2 4.2 0 0 1 10 4.4 A4.2 4.2 0 0 1 17.4 9.6 Z";

/** One heart: full, half or empty, drawn as an SVG so it is the same on every target. */
function Heart({ fill }: { fill: number }) {
  return (
    <svg aria-hidden="true" className="h-6 w-6" viewBox="0 0 20 20">
      <path d={HEART} fill="var(--color-line)" />
      {fill > 0 ? (
        <path
          d={HEART}
          fill="var(--color-heart)"
          style={fill < 1 ? { clipPath: "inset(0 50% 0 0)" } : undefined}
        />
      ) : null}
    </svg>
  );
}

/**
 * The one HUD, the same file on every target. It reads published state and nothing else; the
 * bridge flushes about every 100 ms, so Wren's per-frame feel is never read from here.
 */
export function Hud() {
  const state = useUiState<GameState>();
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (state === undefined) return null;
  // Heart n is full when n hearts are left, half when n - 0.5 are.
  const hearts = Array.from({ length: state.capacity }, (_, i) => i + 1).map((n) => {
    const left = state.hearts - n + 1;
    return <Heart fill={left >= 1 ? 1 : left >= 0.5 ? 0.5 : 0} key={`heart-${n}`} />;
  });
  return (
    <div className="pointer-events-none absolute inset-0 p-6 text-sm font-bold text-text">
      <div className="flex w-fit items-center gap-4 rounded-2xl border-2 border-line bg-panel/40 px-4 py-2 backdrop-blur-sm">
        <span
          aria-label={`${state.hearts} of ${state.capacity} hearts`}
          className="flex gap-0.5"
          id="hearts"
          role="img"
        >
          {hearts}
        </span>
        <span>
          keys{" "}
          <b id="keys" className="text-lume">
            {state.keys}
          </b>
        </span>
        {state.sword ? (
          <span className="text-lume">Ember Blade</span>
        ) : (
          <span className="text-text/70">slash needs the Ember Blade: open the chest (E)</span>
        )}
      </div>
      {state.prompt !== "" ? (
        <div className="absolute bottom-20 left-1/2 -translate-x-1/2 rounded-full border-2 border-line bg-panel/50 px-4 py-1 text-base text-text backdrop-blur-sm">
          E · {state.prompt}
        </div>
      ) : null}
      {state.toast !== "" ? (
        // Top left under the hearts, clear of the fight the camera frames in the middle.
        <div className="absolute left-6 top-20 max-w-sm rounded-2xl border-2 border-line bg-panel/40 px-4 py-1 text-base font-bold text-lume backdrop-blur-sm">
          {state.toast}
        </div>
      ) : null}
    </div>
  );
}
