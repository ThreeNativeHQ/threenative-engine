import { useUiIntent, useUiState } from "@threenative/ui";
import { type EntityType, TYPES } from "../sim/types.js";
import type { GameState } from "../state.js";

/** Read a `"<type>:<progress 0..1>"` pair back apart. */
function readQueueItem(entry: string): { progress: number; type: EntityType } | undefined {
  const at = entry.lastIndexOf(":");
  if (at < 1) return undefined;
  const type = entry.slice(0, at) as EntityType;
  const progress = Number(entry.slice(at + 1));
  return TYPES[type] === undefined || !Number.isFinite(progress) ? undefined : { progress, type };
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(whole / 60)).padStart(2, "0")}:${String(whole % 60).padStart(2, "0")}`;
}

/**
 * The top bar and the selection panel: what is banked, what is selected, what it is doing.
 *
 * Plain Tailwind, plain DOM, and the same file on every target. The unit's *name*, role and cost
 * are not published by the game — they come out of the same rules table the pathfinder reads, so a
 * rebalance cannot leave this panel quoting last season's numbers.
 */
export function Hud() {
  const state = useUiState<GameState>();
  const send = useUiIntent();
  // Nothing to draw until the game publishes its first snapshot. Rendering zeros instead would put
  // a wrong supply figure on screen and then correct it.
  if (state === undefined) return null;
  const card = state.primaryType === "" ? undefined : TYPES[state.primaryType as EntityType];
  const queue = state.queue
    .map(readQueueItem)
    .filter((item): item is { progress: number; type: EntityType } => item !== undefined);
  const supplyBlocked = state.supplyUsed >= state.supplyCap;

  return (
    <>
      <header className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-4 p-4">
        <div className="flex items-center gap-5 bg-black/80 px-4 py-2 text-lume">
          <Stat label="ore" value={state.ore.toLocaleString()} id="ore" />
          <Stat label="gas" value={state.gas.toLocaleString()} id="gas" />
          <Stat
            label="supply"
            value={`${state.supplyUsed} / ${state.supplyCap}`}
            id="supply"
            warn={supplyBlocked}
          />
          <Stat label="clock" value={clock(state.simTime / 20)} id="clock" />
        </div>
        {state.notice === "" ? null : (
          <output className="max-w-sm bg-black/80 px-3 py-2 text-xs uppercase tracking-[0.14em] text-warn">
            {state.notice}
          </output>
        )}
      </header>

      <section className="pointer-events-none absolute bottom-4 left-4 w-72 bg-black/80 p-3">
        <div className="flex items-baseline justify-between text-[10px] uppercase tracking-[0.14em] text-dim">
          <span>{state.selection === 0 ? "no selection" : "strike group"}</span>
          <span id="selection-count">{state.selection} selected</span>
        </div>
        <h2 className="mt-1 text-xl leading-none text-text">{card?.name ?? "Awaiting orders"}</h2>
        <p className="mt-1 text-xs text-dim">{card?.role ?? "Select a unit or a structure."}</p>
        <div className="relative mt-2 h-1.5 overflow-hidden border border-line bg-ink">
          <i
            className="absolute inset-y-0 left-0 bg-lume"
            style={{
              width: `${state.primaryMaxHp > 0 ? (state.primaryHp / state.primaryMaxHp) * 100 : 0}%`,
            }}
          />
        </div>
        <div className="mt-1 flex justify-between text-[10px] uppercase tracking-[0.14em] text-dim">
          <span data-value={state.primaryHp} id="health">
            {state.primaryHp} / {state.primaryMaxHp}
          </span>
          <span id="selection-position">
            {state.selectionX.toFixed(0)} · {state.selectionZ.toFixed(0)}
          </span>
        </div>
        {state.primaryType === "" || state.primaryBuilt ? null : (
          <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-lume">
            site {Math.round(state.primaryProgress * 100)}%
          </p>
        )}
        {queue.length === 0 ? null : (
          <ul className="mt-2 flex flex-wrap gap-1">
            {queue.map((item, index) => (
              <li
                className="relative h-6 w-12 overflow-hidden border border-line bg-ink text-[9px] uppercase tracking-[0.1em] text-text"
                key={`${item.type}-${index}`}
              >
                <i
                  className="absolute inset-y-0 left-0 bg-panel"
                  style={{ width: `${item.progress * 100}%` }}
                />
                <span className="relative">{TYPES[item.type].name}</span>
              </li>
            ))}
          </ul>
        )}
        {state.selectionOrder === "" ? null : (
          <p className="mt-2 text-[10px] uppercase tracking-[0.14em] text-dim" id="selection-order">
            {state.selectionOrder}
          </p>
        )}
      </section>

      {state.dragBox === null ? null : (
        <div
          className="pointer-events-none absolute border border-lume/80 bg-lume/10"
          style={{
            left: `${state.dragBox[0]}px`,
            top: `${state.dragBox[1]}px`,
            width: `${state.dragBox[2]}px`,
            height: `${state.dragBox[3]}px`,
          }}
        />
      )}
      <p className="sr-only" id="selection-live">
        {`${state.selection} selected, orders ${state.selectionOrder}`}
      </p>
      <div className="pointer-events-none absolute right-4 bottom-4 flex flex-col items-end gap-1">
        {state.result === "" ? null : (
          <span className="bg-black/80 px-3 py-1 text-xs uppercase tracking-[0.2em] text-warn">
            {state.result}
          </span>
        )}
        <button
          className="pointer-events-auto border border-line bg-black/80 px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-text"
          data-tn-interactive
          data-testid="pause-toggle"
          onClick={() => send(state.paused ? "resume" : "pause")}
          type="button"
        >
          {state.paused ? "resume" : "pause"}
        </button>
      </div>
    </>
  );
}

function Stat({
  id,
  label,
  value,
  warn = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly warn?: boolean;
}) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-[0.18em] text-dim">{label}</div>
      <div
        className={`text-lg leading-none tabular-nums ${warn ? "text-warn" : "text-text"}`}
        id={id}
      >
        {value}
      </div>
    </div>
  );
}
