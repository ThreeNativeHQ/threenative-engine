import { useUiIntent, useUiState } from "@threenative/ui";
import { type BuildingType, type EntityType, TYPES } from "../sim/types.js";
import type { GameState } from "../state.js";

/** Every structure the rules table knows how to place, in the table's own order. */
const STRUCTURES = (Object.keys(TYPES) as EntityType[]).filter(
  (type) => TYPES[type].building === true,
) as BuildingType[];

/**
 * The command panel: orders for what is selected, and the build menu.
 *
 * The panel never decides anything. Each button names an intent — `order`, `place`, `train` — and
 * the scene decides what it means, which is why the same rules table the pathfinder reads is also
 * the one that prices these buttons: a structure the player cannot afford is greyed out here
 * because `canAfford` is the same arithmetic the simulation charges them with.
 */
export function Commands() {
  const state = useUiState<GameState>();
  const send = useUiIntent();
  if (state === undefined) return null;
  const card = state.primaryType === "" ? undefined : TYPES[state.primaryType as EntityType];
  const producer = card?.building === true ? (state.primaryType as EntityType) : undefined;
  const placing = state.mode.startsWith("build:") ? state.mode.slice(6) : "";

  return (
    <section className="pointer-events-none absolute right-4 bottom-14 flex max-w-80 flex-col gap-2">
      {producer === undefined ? null : (
        <div className="flex flex-wrap justify-end gap-1">
          {(card?.trains ?? []).map((type) => {
            const cost = TYPES[type];
            const afford = state.ore >= cost.ore && state.gas >= cost.gas;
            return (
              <Button
                afford={afford}
                key={type}
                label={cost.name}
                onClick={() => send("train", type)}
                testid={`train-${type}`}
              />
            );
          })}
        </div>
      )}
      <div className="flex flex-wrap justify-end gap-1">
        {state.selection === 0 ? null : (
          <>
            <Button
              label="attack-move"
              onClick={() => send("order", "attack")}
              testid="order-attack"
            />
            <Button label="move" onClick={() => send("order", "move")} testid="order-move" />
            <Button
              label="garrison"
              onClick={() => send("order", "garrison")}
              testid="order-garrison"
            />
            <Button label="repair" onClick={() => send("order", "repair")} testid="order-repair" />
            <Button label="retreat" onClick={() => send("retreat")} testid="order-retreat" />
          </>
        )}
        <Button label="all army" onClick={() => send("army")} testid="order-army" />
        <Button label="base" onClick={() => send("base")} testid="order-base" />
      </div>
      <div className="flex flex-wrap justify-end gap-1">
        {STRUCTURES.map((type) => {
          const cost = TYPES[type];
          // Greying an unaffordable structure is the same arithmetic the simulation charges with.
          // A structure whose prerequisite is missing is left enabled: the scene refuses it with a
          // reason, which is more useful than a button that silently does nothing.
          const afford = state.ore >= cost.ore && state.gas >= cost.gas;
          return (
            <Button
              afford={afford}
              key={type}
              label={cost.name}
              onClick={() => send("place", type)}
              testid={`build-${type}`}
              active={placing === type}
              title={`${cost.name} — ${cost.ore} ore${cost.gas > 0 ? `, ${cost.gas} gas` : ""}`}
            />
          );
        })}
      </div>
      <p
        className="bg-black/80 text-right text-[10px] uppercase tracking-[0.14em] text-dim"
        id="command-hint"
      >
        {placing === ""
          ? "drag to select · right-click to order · wheel to zoom"
          : `placing ${TYPES[placing as BuildingType].name} — click the ground, esc to cancel`}
      </p>
    </section>
  );
}

function Button({
  active = false,
  afford = true,
  label,
  onClick,
  testid,
  title,
}: {
  readonly active?: boolean;
  readonly afford?: boolean;
  readonly label: string;
  readonly onClick: () => void;
  readonly testid: string;
  readonly title?: string;
}) {
  return (
    <button
      // The panel is `pointer-events-none` so its empty space hands the click to the battlefield
      // underneath, which is what a strategy game needs: the only pixels that take a gesture are
      // the buttons. A button inside a `none` island is inert until it opts back in, so this
      // class is load-bearing rather than decoration — without it every order in this panel is
      // dead to a mouse and only the keyboard can issue one.
      className={`pointer-events-auto border px-2 py-1 text-[10px] uppercase tracking-[0.12em] ${
        active ? "border-lume bg-lume/20 text-lume" : "border-line bg-black/80 text-text"
      } ${afford ? "" : "text-dim/60 line-through"}`}
      data-tn-interactive
      data-testid={testid}
      onClick={onClick}
      title={title}
      type="button"
    >
      {label}
    </button>
  );
}
