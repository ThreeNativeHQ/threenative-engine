import { useUiIntent } from "@threenative/ui";
import { useState } from "react";
import { type BuildingType, type EntityType, TYPES } from "../sim/types.js";
import { useUiStateShown } from "./Hud.js";
import { Icon } from "./icons.js";

/** The construct deck, in AstraCraft's order. */
const STRUCTURES: readonly BuildingType[] = [
  "barracks",
  "factory",
  "relay",
  "turret",
  "refinery",
  "core",
  "starport",
  "bunker",
  "antiair",
];

type ICommand = {
  readonly cost?: EntityType;
  readonly icon: string;
  readonly intent: string;
  /** The bound key in `src/game.ts`, shown in the corner; empty when no key does this. */
  readonly key?: string;
  readonly label: string;
  readonly payload?: string;
  readonly testid: string;
};

/**
 * The command card: COMMAND orders for what is selected, and the CONSTRUCT deck.
 *
 * The panel never decides anything. Each tile names an intent — `order`, `place`, `train` — and
 * the scene decides what it means, which is why the same rules table the pathfinder reads is also
 * the one that prices these tiles: a tile the player cannot afford is dimmed here because
 * `canAfford` is the same arithmetic the simulation charges them with. A structure whose
 * prerequisite is missing stays lit: the scene refuses it with a reason, which says more than a
 * dimmed tile.
 */
export function Commands() {
  const state = useUiStateShown((s) => [
    s.primaryType,
    s.primaryTeam,
    s.primaryBuilt,
    s.mode,
    s.ore,
    s.gas,
    s.selection,
    s.selectionTypes,
  ]);
  const send = useUiIntent();
  // The deck remembers which selection opened it, so a new selection opens on its orders.
  const [deck, setDeck] = useState("");
  const selectionKey = `${state?.primaryType}|${state?.selection}`;
  const construct = deck === selectionKey;
  const setConstruct = (open: boolean) => setDeck(open ? selectionKey : "");
  if (state === undefined) return null;
  const card = state.primaryType === "" ? undefined : TYPES[state.primaryType as EntityType];
  const placing = state.mode.startsWith("build:") ? state.mode.slice(6) : "";
  const base: ICommand[] = [
    { icon: "build", intent: "construct", label: "Construct", testid: "cmd-construct" },
    { icon: "army", intent: "army", key: "F2", label: "All army", testid: "cmd-army" },
  ];
  let commands: ICommand[];
  if (construct)
    commands = STRUCTURES.map((type) => ({
      cost: type,
      icon: type,
      intent: "place",
      label: TYPES[type].name,
      payload: type,
      testid: `build-${type}`,
    }));
  else if (card?.building === true && state.primaryTeam === 0) {
    if (!state.primaryBuilt)
      commands = [
        { icon: "stop", intent: "cancelBuild", label: "Cancel · 75%", testid: "cancel-build" },
        ...base,
      ];
    else
      commands = [
        ...(card.trains ?? []).map((type) => ({
          cost: type,
          icon: type,
          intent: "train",
          label: TYPES[type].name,
          payload: type,
          testid: `train-${type}`,
        })),
        ...(card.trains === undefined
          ? []
          : [
              {
                icon: "rally",
                intent: "order",
                label: "Set rally",
                payload: "rally",
                testid: "order-rally",
              },
            ]),
        ...base,
      ];
  } else {
    commands = [
      {
        icon: "attack",
        intent: "order",
        key: "A",
        label: "Attack",
        payload: "attack",
        testid: "order-attack",
      },
      {
        icon: "move",
        intent: "order",
        key: "M",
        label: "Move",
        payload: "move",
        testid: "order-move",
      },
      { icon: "hold", intent: "hold", key: "H", label: "Hold", testid: "order-hold" },
      { icon: "stop", intent: "stop", key: "X", label: "Stop", testid: "order-stop" },
      ...base,
    ];
    if (state.selectionTypes.includes("ranger"))
      commands.push({
        icon: "garrison",
        intent: "order",
        label: "Garrison",
        payload: "garrison",
        testid: "order-garrison",
      });
    if (state.selectionTypes.includes("worker"))
      commands.push({
        icon: "build",
        intent: "order",
        label: "Repair",
        payload: "repair",
        testid: "order-repair",
      });
    if (commands.length > 6 && commands.length < 9)
      commands.push({ icon: "rally", intent: "retreat", label: "Retreat", testid: "cmd-retreat" });
  }

  return (
    <section className="command-panel panel" data-tn-interactive>
      <div className="command-heading">
        <button
          className={construct ? "" : "active"}
          data-tn-interactive
          data-testid="tab-command"
          onClick={() => setConstruct(false)}
          type="button"
        >
          COMMAND
        </button>
        <button
          className={construct ? "active" : ""}
          data-tn-interactive
          data-testid="tab-construct"
          onClick={() => setConstruct(true)}
          type="button"
        >
          CONSTRUCT
        </button>
      </div>
      <div className={`command-grid ${commands.length > 6 ? "expanded" : ""}`}>
        {commands.slice(0, 9).map((command) => {
          const cost = command.cost === undefined ? undefined : TYPES[command.cost];
          const afford = cost === undefined || (state.ore >= cost.ore && state.gas >= cost.gas);
          const active = command.intent === "place" && placing === command.payload;
          return (
            <button
              aria-label={command.label}
              className={`command ${afford ? "" : "unaffordable"} ${active ? "active" : ""}`}
              data-tn-interactive
              data-testid={command.testid}
              key={command.testid}
              onClick={() =>
                command.intent === "construct"
                  ? setConstruct(true)
                  : send(command.intent, command.payload)
              }
              title={cost === undefined ? command.label : `${cost.name} — ${cost.role}`}
              type="button"
            >
              {command.key === undefined ? null : <kbd>{command.key}</kbd>}
              <Icon name={command.icon} />
              <span>{command.label}</span>
              {cost === undefined ? null : (
                <small>
                  ◆ {cost.ore}
                  {cost.gas > 0 ? <em> ⬡ {cost.gas}</em> : null}
                </small>
              )}
            </button>
          );
        })}
      </div>
      <div className="command-hint" id="command-hint">
        <span className="live-dot" />{" "}
        {placing !== ""
          ? `PLACING ${TYPES[placing as BuildingType].name.toUpperCase()} · CLICK THE GROUND · ESC CANCELS`
          : construct
            ? "SURVEYOR REQUIRED · DO NOT ABANDON THE SITE"
            : "RIGHT-CLICK TO ISSUE AN ORDER"}
      </div>
    </section>
  );
}
