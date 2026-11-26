import { useUiState } from "@threenative/ui";
import type { ISummary } from "../farm/Farm.js";
import type { GameState } from "../state.js";

const TITLE: Readonly<Record<ISummary["cause"], string>> = {
  exhausted: "you collapsed",
  late: "you fainted",
  sleep: "good night",
};

/**
 * The night screen: what the bin paid, what a faint cost and the new purse. E closes it and the
 * next morning starts.
 */
export function Summary() {
  const summary = useUiState<GameState, ISummary | null>((state) => state.summary);
  if (summary === null || summary === undefined) return null;
  return (
    <div
      id="farm-summary"
      className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/80"
    >
      <div className="w-96 rounded border border-amber bg-void/95 p-6 text-center uppercase tracking-[0.2em]">
        <div className="text-xl text-amber">{TITLE[summary.cause]}</div>
        <div className="mt-1 text-[11px] text-dim">{summary.date} ended</div>
        <div className="mt-5 text-left text-xs text-text">
          {summary.lines.length === 0 && <div className="text-dim">nothing was shipped</div>}
          {summary.lines.map((line) => (
            <div key={line.id} className="flex justify-between">
              <span>
                {line.label} x{line.count}
              </span>
              <span className="tabular-nums">{line.value} G</span>
            </div>
          ))}
          <div className="mt-2 flex justify-between border-t border-line pt-2 text-leaf">
            <span>shipped</span>
            <span id="summary-earned" className="tabular-nums">
              +{summary.earned} G
            </span>
          </div>
          {summary.penalty > 0 && (
            <div className="flex justify-between text-red">
              <span>faint fee</span>
              <span id="summary-penalty" className="tabular-nums">
                -{summary.penalty} G
              </span>
            </div>
          )}
          <div className="flex justify-between text-amber">
            <span>purse</span>
            <span className="tabular-nums">{summary.money} G</span>
          </div>
        </div>
        {summary.gift !== "" && (
          <div id="summary-gift" className="mt-4 text-xs text-leaf">
            The stall left you a {summary.gift} seed.
          </div>
        )}
        <div className="mt-5 text-[11px] text-dim">next: {summary.nextDate}</div>
        <div className="mt-3 text-xs text-text">E wake up</div>
      </div>
    </div>
  );
}
