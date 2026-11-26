import { useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

const MARK_STYLE = { missed: "bg-red", passed: "bg-cyan", pending: "bg-panel" } as const;

const REASON: Readonly<Record<string, string>> = {
  fast: "Too fast",
  inverted: "Upside down",
  water: "Into the sea",
};

function Gauge({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-6">
      <span className="text-dim">{label}</span>
      <span className="tabular-nums text-text">{value}</span>
    </div>
  );
}

export function Hud() {
  const phase = useField("phase");
  const vehicle = useField("vehicle");
  const time = useField("time") ?? 0;
  const airspeed = useField("airspeed") ?? 0;
  const altitude = useField("altitude") ?? 0;
  const climb = useField("climb") ?? 0;
  const airLift = useField("airLift") ?? 0;
  const stallWarning = useField("stallWarning") ?? 0;
  const windSpeed = useField("windSpeed") ?? 0;
  const fuel = useField("fuel") ?? 1;
  const lowFuel = useField("lowFuel") ?? 0;
  const marks = useField("ringMarks") ?? [];
  const ringsPassed = useField("ringsPassed") ?? 0;
  const padDistance = useField("padDistance") ?? 0;
  const message = useField("message") ?? "";
  const total = useField("total") ?? 0;
  const ringPoints = useField("ringPoints") ?? 0;
  const landPoints = useField("landPoints") ?? 0;
  const bonus = useField("timeBonus") ?? 0;
  const landSink = useField("landSink") ?? 0;
  const landDistance = useField("landDistance") ?? 0;
  const onPad = useField("onPad") ?? 0;
  const reason = useField("crashReason") ?? "";
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (phase === undefined || vehicle === undefined) return null;
  const glider = vehicle === "glider";
  const stalled = stallWarning === 2;
  return (
    <>
      <section
        id="flight-hud"
        className="pointer-events-none absolute left-6 top-5 w-64 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
      >
        <div className="mb-2 text-sm tracking-[0.3em] text-amber">
          {glider ? "hang glider" : "rocket belt"}
        </div>
        <Gauge label="time" value={`${time.toFixed(1)} s`} />
        <Gauge label={glider ? "airspeed" : "speed"} value={`${airspeed.toFixed(1)} m/s`} />
        <Gauge label="height" value={`${altitude.toFixed(0)} m`} />
        <Gauge label="climb" value={`${climb >= 0 ? "+" : ""}${climb.toFixed(1)} m/s`} />
        <Gauge label="pad" value={`${padDistance.toFixed(0)} m`} />
        {glider ? (
          <div
            id="thermal-meter"
            className={`mt-2 border px-2 py-1 text-center ${airLift > 0.5 ? "border-amber text-amber" : "border-line text-dim"}`}
          >
            {airLift > 0.5 ? `thermal +${airLift.toFixed(1)}` : "no lift"}
          </div>
        ) : (
          <div className="mt-2">
            <div className="flex justify-between text-dim">
              <span>fuel</span>
              <span className={lowFuel === 1 ? "text-red" : ""}>{lowFuel === 1 ? "low" : ""}</span>
            </div>
            <div className="mt-1 h-2 w-full bg-panel">
              <div
                className={`h-2 ${lowFuel === 1 ? "bg-red" : "bg-cyan"}`}
                style={{ width: `${Math.round(fuel * 100)}%` }}
              />
            </div>
          </div>
        )}
      </section>
      <section className="pointer-events-none absolute right-6 top-5 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]">
        <div className="text-dim">
          rings {ringsPassed} / {marks.length}
        </div>
        <div id="ring-marks" className="mt-1 flex gap-1">
          {marks.map((mark, index) => (
            <span key={`ring-${index + 1}`} className={`h-2 w-6 ${MARK_STYLE[mark]}`} />
          ))}
        </div>
        <div className="mt-2 text-dim">wind {windSpeed.toFixed(1)} m/s</div>
      </section>
      {stallWarning > 0 && phase === "flying" && (
        <div
          id="stall-warning"
          className={`pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 border bg-black/70 px-6 py-2 text-lg tracking-[0.4em] ${stalled ? "border-red text-red" : "border-amber text-amber"}`}
        >
          {stalled ? "stalled" : "stall"}
        </div>
      )}
      {message !== "" && phase === "flying" && (
        <div
          id="flight-message"
          className="pointer-events-none absolute left-1/2 top-40 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-text"
        >
          {message}
        </div>
      )}
      <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-black/60 px-4 py-2 text-[10px] uppercase tracking-[0.2em] text-dim">
        {glider
          ? "up dive / down pull / left right bank / v rocket belt / r restart"
          : "up lean forward / down back / left right turn / space thrust / shift sink / v glider / r restart"}
      </div>
      {phase !== "flying" && (
        <div
          id="score-card"
          className={`pointer-events-none absolute left-1/2 top-1/2 w-[22rem] -translate-x-1/2 -translate-y-1/2 border bg-black/85 px-8 py-5 text-xs uppercase tracking-[0.2em] ${phase === "landed" ? "border-amber" : "border-red"}`}
        >
          <div
            className={`text-center text-xl tracking-[0.4em] ${phase === "landed" ? "text-amber" : "text-red"}`}
          >
            {phase === "landed" ? "landed" : `crash: ${REASON[reason] ?? reason}`}
          </div>
          <div className="mt-4 space-y-1">
            <Gauge label="time" value={`${time.toFixed(1)} s`} />
            <Gauge label="rings" value={`${ringsPassed} / ${marks.length}  (${ringPoints})`} />
            <Gauge
              label="landing"
              value={
                phase === "landed"
                  ? `${landPoints}  (${onPad === 1 ? `${landDistance.toFixed(0)} m, ${landSink.toFixed(1)} m/s` : "off the pad"})`
                  : "0"
              }
            />
            <Gauge label="time bonus" value={`${bonus}`} />
            <div className="mt-2 border-t border-line pt-2 text-base text-amber">
              <Gauge label="total" value={`${total}`} />
            </div>
          </div>
          <div className="mt-4 text-center text-dim">r try again / v swap craft</div>
        </div>
      )}
    </>
  );
}
