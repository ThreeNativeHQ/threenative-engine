import { useUiIntent, useUiState } from "@threenative/ui";
import { type CSSProperties, type ReactNode, useRef, useState } from "react";
import { STARTS } from "../sim/terrain.js";
import { type EntityType, TYPES } from "../sim/types.js";
import type { GameState } from "../state.js";
import { Icon, TrooperPortrait } from "./icons.js";

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
 * The published snapshot, renewed only when what a panel shows changed. Every publish is a fresh
 * copy and the game publishes each frame, so a panel reading the whole state re-rendered 20 times a
 * second standing still (the 20 Hz sim clock) and 50 while panning (the camera fields it never
 * shows). `shown` lists the values the panel draws, already rounded the way it draws them.
 */
export function useUiStateShown(shown: (state: GameState) => unknown): GameState | undefined {
  const last = useRef<{ key: string; state: GameState } | undefined>(undefined);
  return useUiState<GameState, GameState>((state) => {
    const key = JSON.stringify(shown(state));
    if (last.current?.key !== key) last.current = { key, state };
    return last.current.state;
  });
}

/**
 * Everything around the battlefield except the three bottom panels: the top bar, the objective
 * and rival panels, the toast and order banner, the quick bar, the footer, the rubber band and the
 * end screen. Each piece reads its own slice, so a resource tick repaints the top bar only.
 *
 * The unit's *name*, role and cost are not published by the game — they come out of the same rules
 * table the pathfinder reads, so a rebalance cannot leave this HUD quoting last season's numbers.
 */
export function Hud() {
  return (
    <>
      <TopBar />
      <Mission />
      <Rivals />
      <Toast />
      <ModeBanner />
      <QuickBar />
      <div className="statusbar">
        <span>
          <span className="live-dot" /> ASTRA EXPEDITIONARY CORPS
        </span>
        <span>
          DRAG SELECT <i>·</i> RIGHT-CLICK ORDER <i>·</i> ARROWS / EDGE PAN <i>·</i> SCROLL ZOOM
        </span>
        <span>{"THREENATIVE // LIVE"}</span>
      </div>
      <DragBox />
      <Result />
    </>
  );
}

function TopBar() {
  const state = useUiStateShown((s) => [
    s.ore,
    s.gas,
    s.supplyUsed,
    s.supplyCap,
    Math.floor(s.simTime / 20),
    s.paused,
  ]);
  const send = useUiIntent();
  const [help, setHelp] = useState(false);
  // Nothing to draw until the game publishes its first snapshot. Rendering zeros instead would put
  // a wrong supply figure on screen and then correct it.
  if (state === undefined) return null;
  const closeHelp = () => {
    setHelp(false);
    send("resume");
  };
  return (
    <>
      <header className="topbar" data-tn-interactive>
        <div className="brand">
          <svg aria-hidden="true" viewBox="0 0 40 40">
            <path
              d="M20 3 37 34H28L20 18 12 34H3Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            />
            <path d="M14 29H26M20 4V12" stroke="currentColor" strokeWidth="2" />
          </svg>
          <div>
            <strong>
              ASTRA<span>CRAFT</span>
            </strong>
            <small>AIRBORNE FRONT · 3.0</small>
          </div>
        </div>
        <div className="top-location">
          <span className="live-dot" /> KEPLER–09 <i>/</i> 3-WAY SKIRMISH{" "}
          <span className="clock" id="clock">
            {clock(state.simTime / 20)}
          </span>
        </div>
        <div className="resources">
          <Resource className="mineral" icon="ore" id="ore" label="MINERALS">
            {state.ore.toLocaleString()}
          </Resource>
          <Resource className="vespene" icon="gas" id="gas" label="GAS">
            {state.gas.toLocaleString()}
          </Resource>
          <Resource
            className={`supply ${state.supplyUsed >= state.supplyCap ? "blocked" : ""}`}
            icon="supply"
            id="supply"
            label="SUPPLY"
          >
            {state.supplyUsed} <em>/ {state.supplyCap}</em>
          </Resource>
        </div>
        <div className="top-actions">
          <button
            aria-label="Open the field manual"
            className="tiny-button"
            data-tn-interactive
            data-testid="help"
            onClick={() => {
              setHelp(true);
              send("pause");
            }}
            title="Field manual"
            type="button"
          >
            ?
          </button>
          <button
            aria-label={state.paused ? "Resume game" : "Pause game"}
            className={`tiny-button ${state.paused ? "active" : ""}`}
            data-tn-interactive
            data-testid="pause-toggle"
            onClick={() => send(state.paused ? "resume" : "pause")}
            title={state.paused ? "Resume" : "Pause"}
            type="button"
          >
            {state.paused ? "▷" : "Ⅱ"}
          </button>
        </div>
      </header>
      {help ? (
        <div className="modal-backdrop" data-tn-interactive>
          <section className="modal panel">
            <div className="eyebrow">{"ASTRA EXPEDITIONARY CORPS // FIELD MANUAL"}</div>
            <h2>Welcome, commander.</h2>
            <p>
              Build an economy, raise a strike force and destroy both rival{" "}
              <strong>command networks</strong>: orange Dominion and purple Eclipse. They also fight
              each other.
            </p>
            <div className="manual-grid">
              <div>
                <h3>COMMAND YOUR FORCES</h3>
                <p>
                  <kbd>Left drag</kbd> Select units
                  <br />
                  <kbd>Shift</kbd> Add to selection
                  <br />
                  <kbd>Right click</kbd> Move, attack, harvest, repair
                  <br />
                  <kbd>A</kbd> Attack-move · <kbd>M</kbd> Move
                  <br />
                  <kbd>H</kbd> Hold · <kbd>X</kbd> Stop
                  <br />
                  <kbd>F2</kbd> Select all combat units
                </p>
              </div>
              <div>
                <h3>BUILD YOUR FRONTIER</h3>
                <p>
                  <kbd>Construct</kbd> Pick a structure, then click the ground
                  <br />
                  <kbd>Esc</kbd> Cancel a pending order
                  <br />
                  <kbd>Arrows</kbd> Pan · <kbd>Scroll</kbd> Zoom
                  <br />
                  <kbd>Space</kbd> Return to your base
                </p>
              </div>
            </div>
            <div className="modal-buttons">
              <button className="primary" data-tn-interactive onClick={closeHelp} type="button">
                RESUME OPERATION <span>→</span>
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

function Resource({
  children,
  className,
  icon,
  id,
  label,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly icon: string;
  readonly id: string;
  readonly label: string;
}) {
  return (
    <div className={`resource ${className}`}>
      <Icon name={icon} />
      <div>
        <b id={id}>{children}</b>
        <small>{label}</small>
      </div>
    </div>
  );
}

function Mission() {
  const state = useUiStateShown((s) => [s.skyport, s.airWing >= 2, s.defeated]);
  if (state === undefined) return null;
  return (
    <section className="mission">
      <div className="eyebrow">
        <span>03</span> OPERATION: AIRBORNE FRONT
      </div>
      <h1>Own the ground. Rule the sky.</h1>
      <p>Eliminate both rival command networks.</p>
      <Objective done={state.skyport}>Construct a Skyport</Objective>
      <Objective done={state.airWing >= 2}>Field a wing of 2 aircraft</Objective>
      <div className={`objective final ${state.defeated === 2 ? "complete" : ""}`}>
        <span className="objective-box" />
        <span id="cores-progress">Commanders defeated: {state.defeated} / 2</span>
      </div>
      <div className="mission-coordinates">
        SHATTERED REACH <span>224 × 224 M</span>
      </div>
    </section>
  );
}

function Objective({ children, done }: { readonly children: string; readonly done: boolean }) {
  return (
    <div className={`objective ${done ? "complete" : ""}`}>
      <span className="objective-box" />
      {children}
    </div>
  );
}

const RIVALS = [
  { css: STARTS[1]?.css ?? "#ff9568", name: "DOMINION", tag: "ARMORED LEGION" },
  { css: STARTS[2]?.css ?? "#bb95ff", name: "ECLIPSE", tag: "STRIKE COLLECTIVE" },
];

function Rivals() {
  const state = useUiStateShown((s) => [s.rivals, s.kills]);
  if (state === undefined) return null;
  return (
    <aside className="threat">
      <div className="eyebrow">
        <span className="enemy-dot" /> RIVAL COMMANDERS
      </div>
      {RIVALS.map((rival, index) => (
        <div
          className="commander"
          key={rival.name}
          style={{ "--faction": rival.css } as CSSProperties}
        >
          <span>
            <i /> {rival.name} <small>{rival.tag}</small>
          </span>
          <b>{state.rivals[index] ?? "NO CONTACT"}</b>
        </div>
      ))}
      <div className="threat-meta">
        <span>THREE-WAY WAR</span>
        <span id="kills">{state.kills} ELIMINATED</span>
      </div>
    </aside>
  );
}

/** The last report, faded out by CSS after four seconds; `key` restarts the fade for a new one. */
function Toast() {
  const state = useUiStateShown((s) => s.notice);
  if (state === undefined || state.notice === "") return null;
  return (
    <output className="toast show" key={state.notice}>
      {state.notice}
    </output>
  );
}

const MODE_LABELS: Record<string, string> = {
  attack: "ATTACK-MOVE · CLICK THE BATTLEFIELD",
  garrison: "GARRISON · CLICK A FRIENDLY BUNKER · VANGUARDS ONLY",
  move: "MOVE ORDER · CLICK TO CONFIRM",
  rally: "SET RALLY POINT · CLICK TO CONFIRM",
  repair: "REPAIR · CLICK A DAMAGED FRIENDLY STRUCTURE",
};

function ModeBanner() {
  const state = useUiStateShown((s) => s.mode);
  if (state === undefined || state.mode === "") return null;
  const building = state.mode.startsWith("build:")
    ? TYPES[state.mode.slice(6) as EntityType]
    : undefined;
  const label =
    building === undefined
      ? (MODE_LABELS[state.mode] ?? "ISSUE AN ORDER")
      : `BUILD ${building.name.toUpperCase()} · SURVEYOR MUST REMAIN ON SITE`;
  return <div className="mode-banner">{label} · ESC TO CANCEL</div>;
}

function QuickBar() {
  const state = useUiStateShown((s) => [s.speed, s.idleWorkers, s.groups]);
  const send = useUiIntent();
  if (state === undefined) return null;
  return (
    <div className="quickbar">
      <button
        data-action="army"
        data-tn-interactive
        data-testid="order-army"
        onClick={() => send("army")}
        title="Select your combat army [F2]"
        type="button"
      >
        <Icon name="army" />
        <span>ALL ARMY</span>
        <kbd>F2</kbd>
      </button>
      <button
        data-tn-interactive
        data-testid="order-base"
        onClick={() => send("base")}
        title="Center on the Command Core [Space]"
        type="button"
      >
        <Icon name="core" />
        <span>BASE</span>
        <kbd>SPACE</kbd>
      </button>
      <button
        data-tn-interactive
        data-testid="speed"
        onClick={() => send("speed")}
        title="Cycle game speed"
        type="button"
      >
        {state.speed}×
      </button>
      <button
        data-tn-interactive
        data-testid="idle"
        onClick={() => send("idle")}
        title="Select idle Surveyors"
        type="button"
      >
        IDLE <span id="idle-count">{state.idleWorkers}</span>
      </button>
      <button
        data-action="retreat"
        data-tn-interactive
        data-testid="order-retreat"
        onClick={() => send("retreat")}
        title="Retreat the selection to base"
        type="button"
      >
        RETREAT
      </button>
      <div className="groups">
        {state.groups.map((count, index) => {
          const group = index + 1;
          return (
            <button
              className={count > 0 ? "assigned" : ""}
              data-tn-interactive
              data-testid={`group-${group}`}
              // biome-ignore lint/suspicious/noArrayIndexKey: the five slots are fixed positions.
              key={index}
              onClick={(event) =>
                send("group", event.ctrlKey || event.shiftKey ? `set:${group}` : String(group))
              }
              title={`Group ${group} · click to recall, Ctrl + click to assign`}
              type="button"
            >
              {group}
              {count > 0 ? <span>{count}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Highest-priority order across the selection first: what a commander would want named. */
const STATUS: ReadonlyArray<readonly [string, string]> = [
  ["attack", "ENGAGING HOSTILE"],
  ["construct", "FABRICATING"],
  ["repair", "REPAIRING"],
  ["heal", "RESTORING ALLY"],
  ["garrison", "ENTERING BUNKER"],
  ["gather", "HARVESTING"],
  ["attackMove", "ADVANCING"],
  ["move", "RELOCATING"],
  ["hold", "HOLDING POSITION"],
];

/** The selection card: what is selected, how healthy it is, what it does, and its roster. */
export function Selection() {
  const state = useUiStateShown((s) => [
    s.selection,
    s.selectionTypes,
    s.primaryType,
    s.primaryTeam,
    s.primaryBuilt,
    Math.round(s.primaryProgress * 100),
    s.groupHp,
    s.groupMaxHp,
    s.airborne,
    s.roster,
    s.queue,
    s.selectionOrder,
  ]);
  const send = useUiIntent();
  if (state === undefined) return null;
  const card = state.primaryType === "" ? undefined : TYPES[state.primaryType as EntityType];
  const count = state.selection;
  const queue = state.queue
    .map(readQueueItem)
    .filter((item): item is { progress: number; type: EntityType } => item !== undefined);
  const orders = state.selectionOrder.split(",");
  const status =
    card === undefined
      ? "SYSTEM ONLINE"
      : !state.primaryBuilt
        ? state.primaryProgress > 0
          ? `WELDING ${Math.floor(state.primaryProgress * 100)}%`
          : "SURVEYOR EN ROUTE"
        : queue.length > 0
          ? "PRODUCTION ACTIVE"
          : (STATUS.find(([kind]) => orders.includes(kind))?.[1] ?? "COMBAT READY");
  const caption =
    card !== undefined && state.primaryTeam > 0
      ? "HOSTILE INTELLIGENCE"
      : card?.building === true
        ? "BASE OPERATIONS"
        : count > 1
          ? "STRIKE GROUP"
          : "UNIT TELEMETRY";
  const name =
    count > 1 && state.selectionTypes.length > 1
      ? "Combined arms"
      : (card?.name ?? "Awaiting orders");
  const code =
    card === undefined
      ? "AWAITING ORDERS"
      : `${(state.primaryTeam > 0 ? (STARTS[state.primaryTeam]?.name ?? "") : card.name).toUpperCase()} // ${
          card.building === true ? "BASE" : card.air === true ? "AIR" : "GROUND"
        }`;
  const role =
    count > 1
      ? `${count} units · ${state.airborne} airborne / ${count - state.airborne} ground`
      : (card?.role ?? "Select a unit or structure to begin.");
  const health = state.groupMaxHp > 0 ? (state.groupHp / state.groupMaxHp) * 100 : 0;

  return (
    <section className="selection-panel panel" data-tn-interactive>
      <div className="panel-label">
        <span>{caption}</span>
        <span id="selection-count">
          {count > 0 ? `${String(count).padStart(2, "0")} SELECTED` : "NO SELECTION"}
        </span>
      </div>
      <div className="selection-content">
        <div className="portrait">
          <div className="portrait-grid" />
          {state.primaryType === "ranger" ? (
            <TrooperPortrait />
          ) : (
            <Icon className="portrait-art schematic" name={state.primaryType || "core"} />
          )}
          <div className="portrait-code">{code}</div>
          <div className="portrait-led" />
        </div>
        <div className="unit-info">
          <div className="unit-heading">
            <div>
              <h2 id="unit-name">{name}</h2>
              <p id="unit-role">{role}</p>
            </div>
            <span className="unit-rank">ⅠⅠⅠ</span>
          </div>
          <div className="health-track">
            <span style={{ width: `${health}%` }} />
          </div>
          <div className="health-meta">
            <span data-value={state.groupHp} id="health">
              {state.groupMaxHp > 0 ? `${state.groupHp} / ${state.groupMaxHp}` : "—"}
            </span>
            <span id="unit-status">{status}</span>
          </div>
          <div className="unit-stats">
            {card === undefined ? null : (
              <>
                <span>
                  <Icon name={card.heal ? "medic" : "attack"} />
                  <b>{card.heal ?? card.damage ?? "—"}</b> {card.heal ? "HP / SEC" : "DAMAGE"}
                </span>
                <span>
                  <Icon name="supply" />
                  <b>{card.healRange ?? card.range ?? "—"}</b> RANGE
                </span>
                <span>
                  <Icon name={card.air === true ? "fighter" : "move"} />
                  <b>{card.speed ?? "—"}</b> {card.air === true ? "FLIGHT" : "SPEED"}
                </span>
              </>
            )}
          </div>
          <div className="unit-roster">
            {state.roster.map((entry) => {
              const [id = "", type = "", tenths = "0"] = entry.split(":");
              return (
                <button
                  className="roster-unit"
                  data-tn-interactive
                  key={id}
                  onClick={() => send("select", id)}
                  title={TYPES[type as EntityType]?.name}
                  type="button"
                >
                  <Icon name={type} />
                  <i style={{ width: `${Number(tenths) * 10}%` }} />
                </button>
              );
            })}
            {count > 16 ? <span className="roster-more">+{count - 16}</span> : null}
          </div>
          {queue.length === 0 ? null : (
            <div className="production">
              <span>IN PRODUCTION</span>
              {queue.map((item, index) => (
                <button
                  data-tn-interactive
                  // biome-ignore lint/suspicious/noArrayIndexKey: a queue slot is its position.
                  key={`${item.type}-${index}`}
                  onClick={() => send("cancelTrain", item.type)}
                  title={`Cancel ${TYPES[item.type].name}; full refund`}
                  type="button"
                >
                  <Icon name={item.type} />
                  <i style={{ width: `${item.progress * 100}%` }} />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <p className="sr-only" id="selection-live">
        {`${count} selected, orders ${state.selectionOrder}`}
      </p>
    </section>
  );
}

/**
 * The rubber band and the count it stands for.
 *
 * AstraCraft paints the band's badge with `#drag-box:after { content: attr(data-count) }` and the
 * `data-count` attribute is what puts text in it: set nothing and the padded, bordered `:after`
 * still renders as an empty little square hanging over the corner of the band. So the badge is
 * part of the element's contract, never an ornament bolted on with CSS.
 */
function DragBox() {
  const state = useUiStateShown((s) => (s.dragBox === null ? null : [s.dragBox, s.dragCount]));
  if (state?.dragBox == null) return null;
  const [left, top, width, height] = state.dragBox;
  return (
    <div
      data-count={`${state.dragCount} UNITS`}
      id="drag-box"
      style={{ height: `${height}px`, left: `${left}px`, top: `${top}px`, width: `${width}px` }}
    />
  );
}

/** The match result is the screen, not a tag in the corner. */
function Result() {
  const state = useUiStateShown((s) =>
    s.result === "" ? "" : [s.result, s.kills, s.gathered, Math.floor(s.simTime / 20)],
  );
  const send = useUiIntent();
  if (state === undefined || state.result === "") return null;
  const win = state.result === "victory";
  return (
    <div className="modal-backdrop" data-tn-interactive>
      <section className="modal panel">
        <div className="eyebrow">{win ? "FRONTIER SECURED" : "COMMAND SIGNAL LOST"}</div>
        <h2 id="result">{win ? "Victory, commander." : "The frontier has fallen."}</h2>
        <p>
          {win
            ? "Both rival command networks have fallen. Shattered Reach is yours."
            : "Your Command Core has been destroyed. Regroup and redeploy."}
        </p>
        <div className="end-stats">
          <div>
            <b>{clock(state.simTime / 20)}</b>
            <span>MISSION TIME</span>
          </div>
          <div>
            <b>{state.kills}</b>
            <span>ELIMINATED</span>
          </div>
          <div>
            <b>{state.gathered}</b>
            <span>HARVESTED</span>
          </div>
        </div>
        <button
          className="primary"
          data-tn-interactive
          data-testid="restart"
          onClick={() => send("restart")}
          type="button"
        >
          DEPLOY AGAIN →
        </button>
      </section>
    </div>
  );
}
