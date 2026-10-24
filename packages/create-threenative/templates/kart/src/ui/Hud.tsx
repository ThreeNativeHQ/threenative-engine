import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

const ordinal = (place: number) =>
  place === 1 ? "st" : place === 2 ? "nd" : place === 3 ? "rd" : "th";

/** Race time as m'ss"cc, the way a kart racer shows it. */
function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const c = Math.floor((seconds * 100) % 100);
  return `${m}'${String(s).padStart(2, "0")}"${String(c).padStart(2, "0")}`;
}

/** The item in hand, drawn in SVG: no image files. */
function ItemIcon({ item }: { item: string }) {
  if (item === "banana")
    return (
      <path
        d="M14 34 C 18 18, 30 10, 38 12 C 32 16, 24 26, 22 38 Z"
        fill="#f2d132"
        stroke="#5a3c1a"
        strokeWidth="2"
      />
    );
  if (item === "shell")
    return (
      <g>
        <ellipse cx="25" cy="30" fill="#2fae3c" rx="15" ry="11" stroke="#f4f0e0" strokeWidth="4" />
        <circle cx="25" cy="26" fill="#f4f0e0" r="4" />
      </g>
    );
  if (item === "mushroom")
    return (
      <g>
        <rect fill="#f6ead2" height="14" rx="4" width="14" x="18" y="26" />
        <path d="M8 28 C 8 12, 42 12, 42 28 Z" fill="#e23a2e" />
        <circle cx="25" cy="18" fill="#ffffff" r="4" />
        <circle cx="14" cy="24" fill="#ffffff" r="3" />
        <circle cx="36" cy="24" fill="#ffffff" r="3" />
      </g>
    );
  if (item === "rolling")
    return (
      <text fill="#ffe14a" fontSize="26" fontWeight="900" textAnchor="middle" x="25" y="34">
        ?
      </text>
    );
  return null;
}

/**
 * The one HUD, the same file on every target. It reads published state and nothing else; the
 * bridge flushes about every 100 ms, so the kart's per-frame feel is never read from here.
 */
export function Hud() {
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  const countdown =
    state.countdown === 4 ? "READY" : state.countdown > 0 ? String(state.countdown) : state.countdown === 0 ? "GO!" : "";
  return (
    <div className="pointer-events-none absolute inset-0 select-none font-black text-text drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]">
      <div className="absolute left-5 top-4 text-2xl italic tracking-wide">
        LAP <span className="text-4xl text-lume">{state.lap}</span>/{state.laps}
      </div>
      <div className="absolute right-5 top-4 text-right">
        <div className="text-xs tracking-widest text-dim">TIME</div>
        <div className="text-2xl tabular-nums">{clock(state.time)}</div>
        {state.lapTimes.map((t, i) => (
          <div className="text-xs tabular-nums text-dim" key={`${i}-${t.toFixed(2)}`}>
            LAP {i + 1} {clock(t)}
          </div>
        ))}
      </div>
      <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-xl border-4 border-line bg-panel/35">
        <svg aria-label={state.item === "" ? "no item" : state.item} className="h-14 w-14" role="img" viewBox="0 0 50 50">
          <ItemIcon item={state.item} />
        </svg>
      </div>
      <div className="absolute bottom-4 left-5 italic leading-none">
        <span className="text-7xl text-lume">{state.place}</span>
        <span className="text-3xl">{ordinal(state.place)}</span>
      </div>
      <div className="absolute bottom-5 right-5 text-right italic">
        <span className="text-3xl tabular-nums">{state.speed}</span>
        <span className="text-sm"> km/h</span>
        {state.driftStage > 0 ? (
          <div className={`text-sm ${state.driftStage === 1 ? "text-text" : state.driftStage === 2 ? "text-warn" : "text-heart"}`}>
            {"●".repeat(state.driftStage)} TURBO
          </div>
        ) : null}
      </div>
      {state.mapPath !== "" ? (
        <svg aria-label="course map" className="absolute right-4 top-28 h-40 w-40 opacity-90" role="img" viewBox="0 0 100 100">
          <path d={state.mapPath} fill="none" stroke="#00000066" strokeWidth="6" />
          <path d={state.mapPath} fill="none" stroke="#fff4dc" strokeWidth="3" />
          {state.mapDots.map((dot) => (
            <circle
              cx={dot.x}
              cy={dot.y}
              fill={dot.colour}
              key={dot.colour}
              r={dot.player ? 4.5 : 3}
              stroke={dot.player ? "#ffffff" : "#00000088"}
              strokeWidth={dot.player ? 1.5 : 1}
            />
          ))}
        </svg>
      ) : null}
      {countdown !== "" ? (
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 text-8xl italic text-lume">{countdown}</div>
      ) : null}
      {state.wrongWay ? (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-heart/80 px-6 py-2 text-3xl">
          WRONG WAY
        </div>
      ) : null}
      {state.toast !== "" && countdown === "" ? (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 text-3xl italic text-lume">{state.toast}</div>
      ) : null}
      {state.results.length > 0 ? (
        <div className="absolute left-1/2 top-1/2 w-72 -translate-x-1/2 -translate-y-1/2 rounded-2xl border-2 border-line bg-panel/70 p-4 text-base backdrop-blur-sm">
          <div className="mb-2 text-center text-2xl italic text-lume">RESULTS</div>
          {state.results.map((r) => (
            <div className={`flex justify-between ${r.player ? "text-lume" : ""}`} key={r.name}>
              <span>
                {r.place}. {r.name}
              </span>
              <span className="tabular-nums">{r.time > 0 ? clock(r.time) : "--"}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
