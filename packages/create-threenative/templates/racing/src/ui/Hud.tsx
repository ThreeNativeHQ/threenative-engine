import { useUiState } from "@threenative/ui";
import { CIRCUIT } from "../track/circuit.js";
import type { GameState } from "../state.js";

/**
 * The race HUD, authored from the owner's reference frame: position and the live field down the
 * top left, the lap/timer/best panel top right, the circuit minimap bottom left, and the tach with
 * speed, gear and the segmented nitro bar bottom right.
 *
 * Everything is a reading of `GameState`: the standings come from the scene's own ranking (the same
 * order the race is decided on), the minimap from the one circuit every other system reads, and the
 * dial from the gauges the engine sound is pitched from. No second source of truth.
 */

const RIVAL_NAMES = ["Carter", "Vega", "Ruiz", "Monroe", "Blake"] as const;

function racerName(id: string): string {
  if (id === "player") return "Player";
  if (id === "rival") return RIVAL_NAMES[0];
  const index = Number.parseInt(id.slice("rival-".length), 10) - 1;
  return RIVAL_NAMES[index] ?? id;
}

/** The race clock and the lap readouts, three decimals as the reference's timer. */
function raceClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const whole = Math.floor(seconds % 60);
  const millis = Math.floor((seconds % 1) * 1000);
  return `${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

function lapClock(seconds: number): string {
  return seconds > 0 ? raceClock(seconds) : "--:--.---";
}

/** A field row's gap to the player: + ahead, − behind, in the reference's m:ss.t form. */
function gapClock(seconds: number): string {
  const sign = seconds < 0 ? "-" : "+";
  const abs = Math.abs(seconds);
  return `${sign}${Math.floor(abs / 60)}:${String(Math.floor(abs % 60)).padStart(2, "0")}.${Math.floor((abs % 1) * 10)}`;
}

function StandingBoard({ state }: { state: GameState }) {
  const player = state.rankings.find((row) => row.id === "player");
  const playerProgress = player?.routeProgress ?? state.trackProgress;
  const referenceSpeed = Math.max(state.speed, 1);
  return (
    <ol className="mt-2 w-[196px] text-[13px] leading-[19px]">
      {state.rankings.map((row) => {
        const isPlayer = row.id === "player";
        const gap = (row.routeProgress - playerProgress) / referenceSpeed;
        return (
          <li
            key={row.id}
            className={`flex items-center gap-2 px-2 py-[1px] normal-case ${
              isPlayer
                ? "border-l-2 border-cyan bg-cyan/15 font-bold text-cyan"
                : "border-l-2 border-transparent bg-black/45 text-white/90"
            }`}
          >
            <span className="w-4 text-right tabular-nums text-white/55">{row.place}</span>
            <span className="flex-1">{racerName(row.id)}</span>
            <span
              className={`tabular-nums ${isPlayer ? "text-cyan" : gap > 0 ? "text-white/80" : "text-white/55"}`}
            >
              {isPlayer ? "—" : gapClock(gap)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/* The minimap is the circuit itself, fitted to the dial once: one polyline for the route, the
   player and the field projected onto the same geometry the car is ranked on. */
const MINIMAP_SIZE = 200;
const MINIMAP_ORIGIN = MINIMAP_SIZE / 2;
const MINIMAP_RADIUS = 92;
const MINIMAP = (() => {
  const sample = CIRCUIT.createSample();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const points: Array<[number, number]> = [];
  const steps = 120;
  for (let index = 0; index < steps; index += 1) {
    CIRCUIT.at((index / steps) * CIRCUIT.totalLength, sample);
    const { x, z } = sample.point;
    points.push([x, z]);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minZ = Math.min(minZ, z);
    maxZ = Math.max(maxZ, z);
  }
  const centreX = (minX + maxX) / 2;
  const centreZ = (minZ + maxZ) / 2;
  const scale = Math.min(
    (MINIMAP_RADIUS * 2) / (maxX - minX),
    (MINIMAP_RADIUS * 2) / (maxZ - minZ),
  );
  const path = points
    .map(([x, z], index) => {
      const px = MINIMAP_ORIGIN + (x - centreX) * scale;
      const pz = MINIMAP_ORIGIN + (z - centreZ) * scale;
      return `${index === 0 ? "M" : "L"}${px.toFixed(1)} ${pz.toFixed(1)}`;
    })
    .join(" ");
  return { centreX, centreZ, path: `${path} Z`, scale };
})();
const minimapSample = CIRCUIT.createSample();

function mapAt(progress: number): { x: number; y: number; heading: number } {
  CIRCUIT.at(progress, minimapSample);
  return {
    x: MINIMAP_ORIGIN + (minimapSample.point.x - MINIMAP.centreX) * MINIMAP.scale,
    y: MINIMAP_ORIGIN + (minimapSample.point.z - MINIMAP.centreZ) * MINIMAP.scale,
    heading: (Math.atan2(minimapSample.tangent.x, -minimapSample.tangent.z) * 180) / Math.PI,
  };
}

function Minimap({ state }: { state: GameState }) {
  const player = state.rankings.find((row) => row.id === "player");
  const playerAt = mapAt(player?.routeProgress ?? state.trackProgress);
  return (
    <svg
      viewBox="0 0 200 200"
      className="h-[168px] w-[168px] drop-shadow-[0_2px_10px_rgb(0_0_0/0.65)]"
    >
      <circle
        cx="100"
        cy="100"
        r="96"
        fill="rgb(3 9 14 / 0.78)"
        stroke="rgb(56 215 231 / 0.45)"
        strokeWidth="1.5"
      />
      <path
        d={MINIMAP.path}
        fill="none"
        stroke="#f4c524"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {state.rankings
        .filter((row) => row.id !== "player")
        .map((row) => {
          const at = mapAt(row.routeProgress);
          return (
            <circle
              key={row.id}
              cx={at.x}
              cy={at.y}
              r="3.2"
              fill="#f6e7b0"
              stroke="#0a1117"
              strokeWidth="1"
            />
          );
        })}
      <g
        transform={`translate(${playerAt.x.toFixed(1)} ${playerAt.y.toFixed(1)}) rotate(${playerAt.heading.toFixed(1)})`}
      >
        <path
          d="M0 -7.5 L5.2 6.2 L0 3.2 L-5.2 6.2 Z"
          fill="#38d7e7"
          stroke="#04222a"
          strokeWidth="1"
        />
      </g>
      <text
        x="100"
        y="17"
        textAnchor="middle"
        fill="rgb(255 255 255 / 0.92)"
        fontSize="12"
        fontWeight="700"
      >
        N
      </text>
    </svg>
  );
}

function LapPanel({ state }: { state: GameState }) {
  const lap = Math.min(state.totalLaps, state.completedLaps + 1);
  return (
    <div className="min-w-[196px] bg-black/45 px-4 py-3 text-right">
      <div className="flex items-baseline justify-end gap-2">
        <span className="text-[12px] font-bold tracking-[0.22em] text-white/80">lap</span>
        <span id="lap" className="text-[34px] font-black leading-none text-white">
          {lap}
        </span>
        <span className="text-[17px] font-bold text-white/55">/ {state.totalLaps}</span>
      </div>
      <div id="time" className="mt-1 text-[30px] font-black leading-none tabular-nums text-white">
        {raceClock(state.elapsed)}
      </div>
      <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-[1px] border-t border-cyan/30 pt-2 text-[13px] leading-[17px]">
        <span className="font-bold tracking-[0.16em] text-cyan">best</span>
        <span className="tabular-nums text-white/85">{lapClock(state.bestLap)}</span>
        <span className="font-bold tracking-[0.16em] text-white">lap</span>
        <span className="tabular-nums text-white/85">{lapClock(state.lastLap)}</span>
      </div>
    </div>
  );
}

/* The dial: 0..9 around 270°, a red 7–9 band, and the needle from the gauges' needle. */
const DIAL_START = 135;
const DIAL_SWEEP = 270;
const DIAL_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

function dialAngle(value: number): number {
  return DIAL_START + (Math.min(9, Math.max(0, value)) / 9) * DIAL_SWEEP;
}

function polar(angle: number, radius: number): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [100 + Math.cos(radians) * radius, 100 + Math.sin(radians) * radius];
}

function dialArc(from: number, to: number, radius: number): string {
  const [startX, startY] = polar(dialAngle(from), radius);
  const [endX, endY] = polar(dialAngle(to), radius);
  const large = dialAngle(to) - dialAngle(from) > 180 ? 1 : 0;
  return `M ${startX.toFixed(2)} ${startY.toFixed(2)} A ${radius} ${radius} 0 ${large} 1 ${endX.toFixed(2)} ${endY.toFixed(2)}`;
}

function Tach({ state }: { state: GameState }) {
  const needle = dialAngle(state.rpm * 9);
  const [needleX, needleY] = polar(needle, 66);
  const redline = state.rpm >= 7 / 9;
  return (
    <div className="relative h-[204px] w-[204px]">
      <svg
        viewBox="0 0 200 200"
        className="absolute inset-0 drop-shadow-[0_2px_12px_rgb(0_0_0/0.7)]"
      >
        <circle
          cx="100"
          cy="100"
          r="96"
          fill="rgb(3 9 14 / 0.72)"
          stroke="rgb(255 255 255 / 0.14)"
          strokeWidth="1.5"
        />
        <path
          d={dialArc(0, 9, 88)}
          fill="none"
          stroke="#38d7e7"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <path
          d={dialArc(7, 9, 88)}
          fill="none"
          stroke="#ff4d4d"
          strokeWidth="4.4"
          strokeLinecap="round"
        />
        {DIAL_VALUES.map((value) => {
          const angle = dialAngle(value);
          const [outerX, outerY] = polar(angle, 82);
          const [innerX, innerY] = polar(angle, 74);
          const [labelX, labelY] = polar(angle, 64);
          return (
            <g key={value}>
              <line
                x1={outerX}
                y1={outerY}
                x2={innerX}
                y2={innerY}
                stroke={value >= 7 ? "#ff4d4d" : "rgb(255 255 255 / 0.7)"}
                strokeWidth={value >= 7 ? 2 : 1.4}
              />
              <text
                x={labelX}
                y={labelY + 3.5}
                textAnchor="middle"
                fill={value >= 7 ? "#ff6a6a" : "rgb(255 255 255 / 0.8)"}
                fontSize="11"
                fontWeight="700"
              >
                {value}
              </text>
            </g>
          );
        })}
        <line
          x1="100"
          y1="100"
          x2={needleX}
          y2={needleY}
          stroke={redline ? "#ff5252" : "#f4f7f8"}
          strokeWidth="3.4"
          strokeLinecap="round"
        />
        <circle
          cx="100"
          cy="100"
          r="5"
          fill="#0a1117"
          stroke="rgb(255 255 255 / 0.8)"
          strokeWidth="1.4"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center pt-3">
        <div id="speed" className="text-[52px] font-black leading-none tabular-nums text-white">
          {Math.round(state.speed * 3.6)}
        </div>
        <div className="text-[10px] font-bold tracking-[0.2em] text-white/55">km/h</div>
        <div className="mt-2 min-w-[42px] border border-white/35 px-2 py-[1px] text-center">
          <span id="gear" className="text-[24px] font-black leading-none text-white">
            {state.gear}
          </span>
        </div>
      </div>
    </div>
  );
}

const NITRO_SEGMENTS = 12;

function Nitro({ state }: { state: GameState }) {
  const active = state.nitroActive || state.boostActive;
  const filled = Math.round(Math.min(1, Math.max(0, state.nitro)) * NITRO_SEGMENTS);
  const label = state.nitroActive ? "BURNING" : state.boostActive ? "ACTIVE" : "READY";
  return (
    <div className="flex w-[224px] flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg viewBox="0 0 12 20" className="h-[18px] w-[11px]" aria-hidden="true">
            <path
              d="M4 1h4v4l2 3v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8l2-3V1Z"
              fill="none"
              stroke="#38d7e7"
              strokeWidth="1.4"
            />
            <path d="M2 12h8" stroke="#38d7e7" strokeWidth="1.4" />
          </svg>
          <span className="text-[12px] font-bold tracking-[0.22em] text-cyan">nitro</span>
        </div>
        <span
          id="boost"
          className={`text-[9px] font-bold tracking-[0.2em] ${active ? "text-cyan" : "text-white/45"}`}
        >
          {label}
        </span>
      </div>
      <div className="flex h-[10px] gap-[3px]">
        {Array.from({ length: NITRO_SEGMENTS }, (_, index) => (
          <span
            key={index}
            className={`h-full flex-1 -skew-x-12 ${
              index < filled ? (active ? "bg-cyan" : "bg-cyan/80") : "bg-white/12"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

function driftPopup(state: GameState | undefined): number | undefined {
  if (state === undefined || state.driftPopup <= 0) return undefined;
  return state.driftLast;
}

export function Hud() {
  const state = useUiState<GameState>();
  if (state === undefined) return null;
  const drift = driftPopup(state);
  const statusClass =
    state.raceStatus === "WON"
      ? "text-win"
      : state.raceStatus === "DNF"
        ? "text-danger"
        : "text-accent";
  return (
    <div className="pointer-events-none absolute inset-0 select-none overflow-hidden font-racing uppercase italic">
      <div className="absolute left-5 top-4">
        <div className="text-[10px] font-bold tracking-[0.3em] text-white/45">northern loop</div>
        <div id="position" className="mt-1 flex items-baseline text-accent">
          <span className="text-[58px] font-black leading-none">{state.place}</span>
          <span className="ml-1 text-[26px] font-bold leading-none text-white/55">
            /{state.racers}
          </span>
        </div>
        <div
          className={`mt-1 text-[11px] font-bold tracking-[0.28em] ${statusClass}`}
          id="race-status"
        >
          {state.raceStatus}
        </div>
        <StandingBoard state={state} />
      </div>
      <div className="absolute right-5 top-4">
        <LapPanel state={state} />
      </div>
      <div className="absolute bottom-5 left-5">
        <Minimap state={state} />
      </div>
      <div className="absolute bottom-5 right-5 flex items-end gap-4">
        <Nitro state={state} />
        <Tach state={state} />
      </div>
      {drift !== undefined && state.raceStatus === "RACING" && (
        <div
          className="absolute left-1/2 top-6 -translate-x-1/2 border-l-2 border-cyan bg-black/55 px-5 py-1.5 text-center"
          id="drift-popup"
        >
          <div className="text-[10px] font-bold tracking-[0.3em] text-cyan">drift</div>
          <div className="text-[26px] font-black leading-none text-accent">
            +{Math.round(drift)}
          </div>
        </div>
      )}
      {state.raceStatus !== "RACING" && (
        <div className="absolute inset-0 grid place-items-center">
          <div
            className={`border bg-black/70 px-10 py-6 text-center ${
              state.raceStatus === "WON" ? "border-win/60" : "border-danger/60"
            }`}
          >
            <div className={`text-[42px] font-black tracking-[0.14em] ${statusClass}`} id="outcome">
              {state.raceStatus === "DNF" && state.completedLaps >= state.totalLaps
                ? `P${state.place}`
                : state.raceStatus}
            </div>
            <div className="mt-2 text-[11px] font-bold tracking-[0.26em] text-white/60">
              press r to restart
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
