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
  if (item === "burr")
    return (
      <g>
        <path
          d="M30.0 25.7 L39.4 27.0 l-1.9 1.7 M28.9 28.1 L34.8 32.8 l-2.5 0.5 M27.8 29.1 L33.8 37.8 l-2.6 -0.2 M25.2 30.0 L25.4 38.0 l-2.0 -1.6 M23.6 29.8 L21.0 39.2 l-1.5 -2.2 M21.1 28.2 L15.6 32.7 l0.0 -2.6 M20.2 26.4 L10.4 29.4 l1.0 -2.4 M20.0 24.6 L11.7 23.8 l1.8 -1.8 M21.1 21.9 L13.9 16.1 l2.5 -0.5 M22.3 20.8 L18.1 14.2 l2.6 0.3 M24.2 20.1 L22.6 9.6 l2.2 1.3 M27.0 20.4 L30.5 12.6 l1.1 2.3 M28.6 21.6 L35.6 15.0 l0.2 2.6 M29.9 23.8 L37.0 22.1 l-1.2 2.3"
          fill="none"
          stroke="#f2df92"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.4"
        />
        <circle cx="25" cy="25" fill="#8a5a2b" r="9.5" />
        <circle cx="22" cy="22" fill="#a8743c" r="4" />
      </g>
    );
  if (item === "acorn")
    return (
      <g>
        <ellipse cx="25" cy="29" fill="#c98a43" rx="11" ry="13" />
        <path d="M11 22 C 11 10, 39 10, 39 22 Z" fill="#5b3a1c" />
        <rect fill="#5b3a1c" height="7" rx="2" width="4" x="23" y="6" />
      </g>
    );
  if (item === "nitro")
    return (
      <g>
        <rect fill="#2b6fd8" height="32" rx="5" width="20" x="15" y="10" />
        <rect fill="#d8dde6" height="5" rx="2" width="12" x="19" y="6" />
        <path d="M27 15 L20 27 L25 27 L22 37 L31 23 L26 23 Z" fill="#ffd23a" />
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
  // Nothing to draw until the loading cover lifts: the HUD is page UI the cover cannot hide.
  if (state?.loaded !== true) return null;
  const countdown =
    state.countdown === 4
      ? "READY"
      : state.countdown > 0
        ? String(state.countdown)
        : state.countdown === 0
          ? "GO!"
          : "";
  return (
    <div className="pointer-events-none absolute inset-0 select-none font-black text-text drop-shadow-[0_2px_0_rgba(0,0,0,0.55)]">
      <div className="absolute left-5 top-4 text-2xl italic tracking-wide rounded-lg bg-panel/60 px-3 py-1">
        LAP <span className="text-4xl text-lume">{state.lap}</span>/{state.laps}
      </div>
      <div className="absolute right-5 top-4 text-right rounded-lg bg-panel/60 px-3 py-1">
        <div className="text-xs tracking-widest text-dim">TIME</div>
        <div className="text-2xl tabular-nums">{clock(state.time)}</div>
        {state.lapTimes.map((t, i) => (
          <div className="text-xs tabular-nums text-dim" key={`${i}-${t.toFixed(2)}`}>
            LAP {i + 1} {clock(t)}
          </div>
        ))}
      </div>
      <div className="absolute left-1/2 top-3 -translate-x-1/2 rounded-xl border-4 border-line bg-panel/35">
        <svg
          aria-label={state.item === "" ? "no item" : state.item}
          className="h-14 w-14"
          role="img"
          viewBox="0 0 50 50"
        >
          <ItemIcon item={state.item} />
        </svg>
        {/* The key that uses the item in hand: without it a held item looked like it did nothing.
            A touch screen has its own item pad, so only a fine pointer shows the keys. */}
        {state.item !== "" && state.item !== "rolling" ? (
          <div className="hidden pb-1 text-center text-xs text-dim pointer-fine:block">E / X</div>
        ) : null}
      </div>
      {/* A dark halo keeps the place legible over the kart's flames and sparks. The corner panels sit
          on the kit's panel colour: bare orange on the bright sky read at 1.45:1. */}
      <div className="absolute bottom-4 left-5 italic leading-none drop-shadow-[0_0_3px_rgba(0,0,0,0.85)] rounded-lg bg-panel/60 px-3 py-1">
        <span className="text-7xl text-lume">{state.place}</span>
        <span className="text-3xl">{ordinal(state.place)}</span>
      </div>
      <div className="absolute bottom-5 right-5 text-right italic rounded-lg bg-panel/60 px-3 py-1">
        <span className="text-3xl tabular-nums">{state.speed}</span>
        <span className="text-sm"> km/h</span>
        {state.driftStage > 0 ? (
          <div
            className={`text-sm ${state.driftStage === 1 ? "text-text" : state.driftStage === 2 ? "text-warn" : "text-heart"}`}
          >
            {"●".repeat(state.driftStage)} TURBO
          </div>
        ) : null}
      </div>
      {state.mapPath !== "" ? (
        <svg
          aria-label="course map"
          className="absolute right-4 top-28 h-40 w-40 opacity-90"
          role="img"
          viewBox="0 0 100 100"
        >
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
        <div className="absolute left-1/2 top-1/3 -translate-x-1/2 text-9xl italic text-lume">
          {countdown}
        </div>
      ) : null}
      {state.wrongWay ? (
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 rounded-full bg-heart/80 px-6 py-2 text-3xl">
          WRONG WAY
        </div>
      ) : null}
      {state.toast !== "" && countdown === "" ? (
        <div className="absolute left-1/2 top-24 -translate-x-1/2 text-3xl italic text-lume">
          {state.toast}
        </div>
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
          <div className="mt-2 text-center text-xs text-dim">press R to race again</div>
        </div>
      ) : null}
    </div>
  );
}
