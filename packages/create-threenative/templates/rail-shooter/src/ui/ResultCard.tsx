import { useField } from "./useField.js";

/** The score card after the boss falls, or the wreck screen after the shield runs out. */
export function ResultCard() {
  const phase = useField("phase");
  const score = useField("score") ?? 0;
  const kills = useField("kills") ?? 0;
  const total = useField("killsTotal") ?? 0;
  const shots = useField("shots") ?? 0;
  const hits = useField("hits") ?? 0;
  const homingShots = useField("homingShots") ?? 0;
  const shieldMax = useField("shieldMax") ?? 1;
  const shield = useField("shield") ?? 0;
  const time = useField("missionTime") ?? 0;
  if (phase === undefined || phase === "playing") return null;
  const won = phase === "won";
  const fired = shots + homingShots;
  const accuracy = fired === 0 ? 0 : Math.min(100, Math.round((hits / fired) * 100));
  return (
    <div
      id="result-card"
      className={`pointer-events-none absolute left-1/2 top-1/2 w-96 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-6 text-center uppercase ${won ? "border-cyan text-text" : "border-red text-text"}`}
    >
      <div className={`text-xl tracking-[0.4em] ${won ? "text-cyan" : "text-red"}`}>
        {won ? "mission complete" : "ship destroyed"}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-y-1 text-left text-[11px] tracking-[0.18em] text-dim">
        <dt>score</dt>
        <dd className="text-right text-text tabular-nums">{score}</dd>
        <dt>enemies</dt>
        <dd className="text-right text-text tabular-nums">
          {kills} / {total}
        </dd>
        <dt>hit rate</dt>
        <dd className="text-right text-text tabular-nums">{accuracy}%</dd>
        {won && (
          <>
            <dt>shield left</dt>
            <dd className="text-right text-text tabular-nums">
              {Math.round((shield / shieldMax) * 100)}%
            </dd>
          </>
        )}
        <dt>time</dt>
        <dd className="text-right text-text tabular-nums">{time.toFixed(0)} s</dd>
      </dl>
      <div className="mt-4 text-[10px] tracking-[0.3em] text-amber">R restart</div>
    </div>
  );
}
