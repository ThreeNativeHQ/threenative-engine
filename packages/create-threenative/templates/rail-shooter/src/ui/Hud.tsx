import { ResultCard } from "./ResultCard.js";
import { useField } from "./useField.js";

function Bar({ id, label, value, max, tone }: { id: string; label: string; value: number; max: number; tone: string }) {
  const share = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="mt-2" id={id}>
      <div className="flex justify-between text-dim">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(share)}</span>
      </div>
      <div className="mt-1 h-2 w-full bg-panel">
        <div className={`h-2 ${tone}`} style={{ width: `${share}%` }} />
      </div>
    </div>
  );
}

export function Hud() {
  const phase = useField("phase");
  const shield = useField("shield") ?? 0;
  const shieldMax = useField("shieldMax") ?? 1;
  const gauge = useField("gauge") ?? 0;
  const gaugeMax = useField("gaugeMax") ?? 1;
  const locked = useField("gaugeLocked") === 1;
  const mode = useField("mode");
  const speed = useField("speed") ?? 0;
  const score = useField("score") ?? 0;
  const kills = useField("kills") ?? 0;
  const total = useField("killsTotal") ?? 0;
  const charge = useField("charge") ?? 0;
  const mark = useField("locked") ?? "";
  const bossPhase = useField("bossPhase") ?? 0;
  const bossHp = useField("bossHp") ?? 1;
  const bossPods = useField("bossPods") ?? 0;
  const message = useField("message") ?? "";
  const progress = (useField("railS") ?? 0) / Math.max(1, useField("railLength") ?? 1);
  if (phase === undefined) return null;
  return (
    <>
      <section
        id="ship-hud"
        className="pointer-events-none absolute left-6 top-5 w-72 bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em] text-text"
      >
        <Bar id="shield-bar" label="shield" value={shield} max={shieldMax} tone={shield / shieldMax > 0.3 ? "bg-cyan" : "bg-red"} />
        <Bar id="gauge-bar" label={locked ? "cooling" : mode === "brake" ? "brake" : "boost"} value={gauge} max={gaugeMax} tone={locked ? "bg-red" : "bg-amber"} />
        <div className="mt-2 flex justify-between text-dim">
          <span>speed</span>
          <span className="tabular-nums">{Math.round(speed)} m/s</span>
        </div>
        <div className="mt-1 h-1 w-full bg-panel">
          <div className="h-1 bg-line" style={{ width: `${Math.round(Math.min(1, progress) * 100)}%` }} />
        </div>
      </section>
      <section
        id="score-hud"
        className="pointer-events-none absolute right-6 top-5 bg-black/70 p-3 text-right text-[10px] uppercase tracking-[0.16em] text-text"
      >
        <div className="text-lg tabular-nums tracking-[0.2em]">{score}</div>
        <div className="mt-1 text-dim">
          enemies {kills} / {total}
        </div>
        {(charge > 0.05 || mark !== "") && (
          <div className="mt-2 text-amber">{mark !== "" ? "lock" : `charge ${Math.round(charge * 100)}`}</div>
        )}
      </section>
      {bossPhase > 0 && (
        <div id="boss-hud" className="pointer-events-none absolute left-1/2 top-5 w-80 -translate-x-1/2 bg-black/70 p-3 text-[10px] uppercase tracking-[0.2em] text-text">
          <div className="flex justify-between">
            <span>warden</span>
            <span className="text-dim">{bossPods > 0 ? `pods ${bossPods}` : bossPhase === 3 ? "raging" : "core open"}</span>
          </div>
          <div className="mt-1 h-2 w-full bg-panel">
            <div className="h-2 bg-red" style={{ width: `${Math.round(bossHp * 100)}%` }} />
          </div>
        </div>
      )}
      {message !== "" && (
        <div
          id="ship-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 bg-black/60 px-4 py-1 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      <div
        id="controls-hint"
        className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/60 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-dim"
      >
        arrows steer / space fire, hold to charge / shift boost / x brake / q e bank, tap twice to roll
      </div>
      <ResultCard />
    </>
  );
}
