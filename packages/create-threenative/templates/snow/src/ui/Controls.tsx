import type { useUiIntent } from "@threenative/ui";
import { type ReactNode, useEffect, useState } from "react";
import type { GameState } from "../state.js";
import { Icon } from "./icons.js";

type Send = ReturnType<typeof useUiIntent>;

interface IRangeProps {
  readonly id: keyof GameState & string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly format: (value: number) => string;
  readonly send: Send;
}

/**
 * A labelled slider. It keeps its own value while dragged — the game's state comes back on a
 * ~100 ms bridge, and a slider bound straight to it would jump under the thumb.
 */
function Range({ id, label, value, min, max, step, format, send }: IRangeProps) {
  const [local, setLocal] = useState(value);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!dragging) setLocal(value);
  }, [dragging, value]);
  const fill = `${((local - min) / (max - min)) * 100}%`;
  return (
    <div className="my-4 first:mt-0 [@media(max-height:800px)]:my-2">
      <label className="flex items-baseline justify-between text-[11px] text-text" htmlFor={id}>
        <span>{label}</span>
        <output className="text-[10px] tabular-nums text-muted" htmlFor={id}>
          {format(local)}
        </output>
      </label>
      <input
        className="snow-range mt-1.5 max-[850px]:h-11"
        data-tn-interactive
        id={id}
        max={max}
        min={min}
        onBlur={() => setDragging(false)}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          setLocal(next);
          send("set", { key: id, value: next });
        }}
        onPointerDown={() => setDragging(true)}
        onPointerUp={() => setDragging(false)}
        step={step}
        style={{ "--fill": fill } as React.CSSProperties}
        type="range"
        value={local}
      />
    </div>
  );
}

function Toggle({
  label,
  pressed,
  onToggle,
}: {
  readonly label: string;
  readonly pressed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <div className="flex min-h-11 items-center justify-between text-[11px] text-text">
      <span id="compaction-label">{label}</span>
      {/* The 44 px button is the hit area; the switch drawn inside it stays small. */}
      <button
        aria-labelledby="compaction-label"
        aria-pressed={pressed}
        className="-mr-2 grid h-11 w-14 place-items-center"
        data-tn-interactive
        onClick={onToggle}
        type="button"
      >
        <span
          className={`relative block h-[22px] w-[38px] rounded-full border transition-colors ${
            pressed ? "border-aqua bg-aqua/80" : "border-line bg-black/20"
          }`}
        >
          <span
            className={`absolute top-[3px] left-0 h-[14px] w-[14px] rounded-full bg-text transition-transform ${
              pressed ? "translate-x-[19px]" : "translate-x-[3px]"
            }`}
          />
        </span>
      </button>
    </div>
  );
}

function ActionButton({
  children,
  grow = false,
  label,
  onClick,
  primary = false,
  pressed,
  title,
}: {
  readonly children: ReactNode;
  /** Take the row's spare width, so a row of buttons spans its panel. */
  readonly grow?: boolean;
  readonly label?: string;
  readonly onClick: () => void;
  readonly primary?: boolean;
  readonly pressed?: boolean;
  readonly title?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`flex min-h-11 items-center justify-center gap-2 rounded-[9px] border px-3 text-[11px] backdrop-blur-md transition hover:brightness-110 ${grow ? "flex-1" : ""} ${
        primary
          ? "border-[rgb(212_251_236/0.7)] bg-aqua/90 text-aqua-ink"
          : "border-line bg-[rgb(20_39_50/0.7)] text-text"
      }`}
      data-tn-interactive
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/** Drop the ball in front of the explorer, or push it away. */
export function BallActions({ send }: { readonly send: Send }) {
  return (
    <div className="grid grid-cols-2 gap-2">
      <ActionButton
        label="Drop the ball in front of you"
        onClick={() => send("drop")}
        title="Drop the ball in front of you (F)"
      >
        <Icon name="drop" />
        <span className="whitespace-nowrap">Drop</span>
      </ActionButton>
      <ActionButton
        label="Push the ball away from you"
        onClick={() => send("kick")}
        title="Push the ball away from you (G)"
      >
        <Icon name="push" />
        <span className="whitespace-nowrap">Push</span>
      </ActionButton>
    </div>
  );
}

/** Weather, snow and session controls: the panel on the left, or the sheet on a phone. */
export function Controls({ state, send }: { readonly state: GameState; readonly send: Send }) {
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  return (
    <div className="flex flex-col gap-3">
      <section
        aria-label="Weather and snow"
        className="rounded-[15px] border border-line bg-panel px-5 pb-2 pt-5 [@media(max-height:800px)]:pt-4 shadow-[0_12px_45px_rgb(13_31_43/0.08)] backdrop-blur-xl"
      >
        <div className="flex items-center justify-between text-[10px] uppercase tracking-[0.2em] text-muted">
          <span>Weather</span>
          <kbd className="rounded border border-line px-1.5 font-sans text-[10px] tracking-normal">
            B
          </kbd>
        </div>
        <fieldset className="m-0 mb-5 mt-3 grid min-w-0 grid-cols-2 border-0 [@media(max-height:800px)]:mb-3 gap-1 rounded-[9px] bg-[rgb(5_18_26/0.37)] p-1">
          <legend className="sr-only">Weather</legend>
          {([false, true] as const).map((blizzard) => (
            <button
              aria-pressed={state.blizzard === blizzard}
              className={`flex min-h-10 items-center justify-center gap-2 rounded-md px-1 text-[11px] transition-colors max-[850px]:min-h-11 ${
                state.blizzard === blizzard ? "bg-aqua text-aqua-ink" : "text-muted hover:text-text"
              }`}
              data-tn-interactive
              key={String(blizzard)}
              onClick={() => {
                if (state.blizzard !== blizzard) send("blizzard");
              }}
              type="button"
            >
              <Icon name={blizzard ? "blizzard" : "snow"} />
              {blizzard ? "Blizzard" : "Soft snowfall"}
            </button>
          ))}
        </fieldset>
        <Range
          format={percent}
          id="snowfall"
          label="Snowfall intensity"
          max={1}
          min={0}
          send={send}
          step={0.01}
          value={state.snowfall}
        />
        <Range
          format={(value) => `${Math.round(value * 100)} cm`}
          id="depth"
          label="Powder depth"
          max={0.55}
          min={0.06}
          send={send}
          step={0.01}
          value={state.depth}
        />
        <Range
          format={(value) => `${value.toFixed(2)} m/s`}
          id="fallSpeed"
          label="Flake fall speed"
          max={1.6}
          min={0.2}
          send={send}
          step={0.05}
          value={state.fallSpeed}
        />
        <details className="group mt-1 border-t border-line pt-1">
          <summary
            className="flex min-h-11 cursor-pointer list-none items-center justify-between text-[11px] text-text"
            data-tn-interactive
          >
            Snow physics
            <span
              aria-hidden="true"
              className="text-[16px] text-muted transition-transform group-open:rotate-45"
            >
              +
            </span>
          </summary>
          <Range
            format={percent}
            id="hardness"
            label="Snow hardness"
            max={0.95}
            min={0.05}
            send={send}
            step={0.01}
            value={state.hardness}
          />
          <Range
            format={(value) => `${value.toFixed(1)} m/s`}
            id="wind"
            label="Base wind"
            max={12}
            min={0}
            send={send}
            step={0.1}
            value={state.wind}
          />
          <Range
            format={(value) => `${value}×`}
            id="recovery"
            label="Deposition time scale"
            max={1200}
            min={0}
            send={send}
            step={30}
            value={state.recovery}
          />
          <Toggle
            label="Show compaction"
            onToggle={() => send("set", { key: "compaction", value: !state.compaction })}
            pressed={state.compaction}
          />
          {state.compaction ? (
            <p className="mt-1 flex items-center gap-3 text-[10px] text-muted" aria-live="polite">
              <span className="flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-sm bg-[#f2783a]" /> packed
              </span>
              <span className="flex items-center gap-1.5">
                <i className="h-2.5 w-2.5 rounded-sm bg-[#3882ab]" /> fresh powder
              </span>
            </p>
          ) : null}
          <p className="mb-3 mt-1 text-[10px] leading-relaxed text-muted">
            Fresh snow fills tracks over time. The time scale speeds up deposition, never walking or
            falling flakes.
          </p>
        </details>
      </section>
      <div className="flex gap-2">
        <ActionButton
          grow
          label={state.autoExplore ? "Turn auto-explore off" : "Turn auto-explore on"}
          onClick={() => send("auto")}
          pressed={state.autoExplore}
          primary={state.autoExplore}
        >
          <Icon className="h-[14px] w-[14px]" name="play" />
          <span className="min-w-[92px] text-left">
            {state.autoExplore ? "Auto-explore on" : "Auto-explore off"}
          </span>
        </ActionButton>
        <ActionButton
          label={state.paused ? "Resume simulation" : "Pause simulation"}
          onClick={() => send(state.paused ? "resume" : "pause")}
          pressed={state.paused}
          title="Pause simulation"
        >
          <Icon name={state.paused ? "play" : "pause"} />
        </ActionButton>
        <ActionButton
          label="Clear all footprints"
          onClick={() => send("reset")}
          title="Clear all footprints (R)"
        >
          <Icon name="reset" />
        </ActionButton>
      </div>
      <div className="min-[851px]:hidden">
        <BallActions send={send} />
      </div>
    </div>
  );
}
