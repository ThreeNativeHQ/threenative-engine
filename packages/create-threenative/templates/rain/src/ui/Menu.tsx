import type { CSSProperties, ReactNode } from "react";
import { useEffect, useRef } from "react";
import type { GameState, WeatherKey } from "../state.js";

export interface IMenuProps {
  readonly state: GameState;
  readonly send: (intent: string, payload?: unknown) => void;
  readonly say: (text: string) => void;
  /** Photosensitivity mode: safe on also takes automatic lightning down with it, as the study does. */
  readonly setSafeMode: (on: boolean) => void;
  readonly toggleAutoLightning: () => void;
  readonly panelOpen: boolean;
  readonly setPanelOpen: (open: boolean) => void;
}

interface ISwitchProps {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onToggle: () => void;
}

interface ISliderControlProps {
  readonly channel: WeatherKey;
  readonly id: string;
  readonly label: string;
  /** The slider's own upper bound in hundredths. Exposure reaches 1.8, the rest stop at 1. */
  readonly max?: number;
  readonly readout: ReactNode;
}

const QUALITY_LABELS: readonly { readonly value: GameState["quality"]; readonly label: string }[] =
  [
    { value: "performance", label: "Performance" },
    { value: "balanced", label: "Balanced" },
    { value: "high", label: "High" },
    { value: "ultra", label: "Ultra" },
  ];

function Switch({ checked, id, label, onToggle }: ISwitchProps) {
  return (
    <div className="switch-row">
      <span>{label}</span>
      <button
        aria-checked={checked}
        aria-label={label}
        className="switch"
        data-tn-interactive
        id={id}
        onClick={onToggle}
        role="switch"
        type="button"
      />
    </div>
  );
}

/**
 * The frosted weather panel and the help dialog — every control that writes the atmosphere, plus
 * the accessibility switches the study asks a reader to check before the first storm.
 */
export function Menu({
  panelOpen,
  say,
  send,
  setPanelOpen,
  setSafeMode,
  state,
  toggleAutoLightning,
}: IMenuProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const helpRef = useRef<HTMLButtonElement>(null);
  // The study drops the lit preset as soon as a slider is dragged, because the target is then no
  // longer the preset's. The game keeps naming the last preset, so the UI owns the distinction.
  const customTarget = useRef(false);
  const target = state.target;

  // A real `<dialog>` in the top layer: focus is trapped, Escape is the platform's own, and the
  // backdrop click lands on the dialog element itself. State still decides whether it is open.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    if (state.helpOpen && !dialog.open) {
      dialog.showModal();
      return;
    }
    if (!state.helpOpen && dialog.open) {
      dialog.close();
      helpRef.current?.focus();
    }
  }, [state.helpOpen]);

  const weather = (channel: WeatherKey, value: number) => {
    customTarget.current = true;
    send("setWeather", { [channel]: value });
  };

  const choosePreset = (name: "drizzle" | "storm" | "supercell") => {
    customTarget.current = false;
    send("setPreset", name);
    say(`${name.toUpperCase()} · transitioning the atmosphere`);
    setPanelOpen(false);
  };

  const control = ({ channel, id, label, max = 100, readout }: ISliderControlProps) => (
    <div className="control">
      <div className="control-line">
        <label htmlFor={id}>{label}</label>
        {readout}
      </div>
      {/* Mirrored: the value is the target the simulation is easing towards, so the control can
          never show a number the game is not actually heading for. `--fill` paints the mint part
          of the track. */}
      <input
        aria-label={label}
        data-tn-interactive
        id={id}
        max={max}
        min={0}
        onChange={(event) => weather(channel, Number(event.target.value) / 100)}
        style={
          { "--fill": `${Math.min(100, (target[channel] * 100) / max) * 100}%` } as CSSProperties
        }
        type="range"
        value={Math.round(target[channel] * 100)}
      />
    </div>
  );

  return (
    <>
      <aside
        aria-hidden={state.uiHidden}
        aria-label="Weather controls"
        className={`panel${panelOpen ? " mobile-open" : ""}${state.uiHidden ? " hidden" : ""}`}
      >
        <div className="panel-header">
          <div className="weather-glyph">
            <svg aria-hidden="true" viewBox="0 0 36 36">
              <path d="M9 21a7 7 0 1 1 1-14 10 10 0 0 1 18 5 5 5 0 0 1 0 10M12 25l-2 4m9-4-2 4m9-4-2 4" />
            </svg>
          </div>
          <div className="eyebrow">WEATHER SYSTEM</div>
          <h2 className="panel-title">Inside the storm.</h2>
          <div className="panel-sub">Shape the atmosphere. Feel it change.</div>
        </div>

        <div aria-label="Weather presets" className="presets">
          {(["drizzle", "storm", "supercell"] as const).map((name) => (
            <button
              aria-pressed={state.preset === name && !customTarget.current}
              className={state.preset === name && !customTarget.current ? "active" : undefined}
              data-tn-interactive
              id={`preset-${name}`}
              key={name}
              onClick={() => choosePreset(name)}
              type="button"
            >
              {name.toUpperCase()}
            </button>
          ))}
        </div>

        <div className="sliders">
          {control({
            channel: "rain",
            id: "rain",
            label: "Precipitation",
            readout: (
              <output className="readout" id="rainValue">
                {Math.round(target.rain * 48)} <span>mm/h</span>
              </output>
            ),
          })}
          {control({
            channel: "cloud",
            id: "cloud",
            label: "Cloud cover",
            readout: (
              <output className="readout" id="cloudValue">
                {Math.round(target.cloud * 100)} <span>%</span>
              </output>
            ),
          })}
          {control({
            channel: "wind",
            id: "wind",
            label: "Wind speed",
            readout: (
              <output className="readout" id="windValue">
                {Math.round(target.wind * 72)} <span>km/h</span>
              </output>
            ),
          })}
          {control({
            channel: "fog",
            id: "fog",
            label: "Atmospheric haze",
            readout: (
              <output className="readout" id="fogValue">
                {Math.round(target.fog * 100)} <span>%</span>
              </output>
            ),
          })}
        </div>
        <div className="divider" />

        <Switch
          checked={state.autoLightning}
          id="autoLightning"
          label="Automatic lightning"
          onToggle={toggleAutoLightning}
        />
        <Switch
          checked={state.cinematic}
          id="cinematic"
          label="Cinematic camera"
          onToggle={() => send("setCinematic", !state.cinematic)}
        />

        <button
          className="strike-button"
          data-tn-interactive
          id="strike"
          disabled={state.safe}
          onClick={() => send("strike")}
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 12 18">
            <path d="M7 1 1 10h5l-1 7 6-10H6z" />
          </svg>
          <span className="button-label">Trigger lightning</span>
          <kbd>L</kbd>
        </button>

        <details className="advanced">
          <summary>RENDERING &amp; ACCESSIBILITY</summary>
          <Switch
            checked={state.safe}
            id="safe"
            label="Disable lightning flashes"
            onToggle={() => setSafeMode(!state.safe)}
          />
          <Switch
            checked={state.droplets}
            id="lens"
            label="Rain on the lens"
            onToggle={() => send("setDroplets", !state.droplets)}
          />
          {control({
            channel: "exposure",
            id: "exposure",
            label: "Exposure",
            max: 180,
            readout: <output id="exposureValue">{target.exposure.toFixed(2)}</output>,
          })}
          {control({
            channel: "wet",
            id: "wet",
            label: "Surface wetness",
            readout: <output id="wetValue">{Math.round(target.wet * 100)}%</output>,
          })}
          {/* The scene publishes the rain geometry's own `instanceCount`, so this is the draw the
              renderer was handed this frame rather than the budget it would come from. */}
          <div className="engine" id="engine">
            {state.dropCount} rain drops in the air
          </div>
        </details>

        <div className="render-footer">
          <span className="quality-label">RENDER QUALITY</span>
          <select
            aria-label="Render quality"
            data-tn-interactive
            id="quality"
            onChange={(event) => send("setQuality", event.target.value)}
            value={state.quality}
          >
            {QUALITY_LABELS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </aside>

      {/*
       * The backdrop click is a mouse convenience. The keyboard way out is Escape, which the
       * native dialog reports through `onCancel` above, so this needs no key handler of its own.
       */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape is the keyboard way out. */}
      <dialog
        aria-labelledby="helpTitle"
        className="modal"
        onCancel={(event) => {
          event.preventDefault();
          send("closeHelp");
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) send("closeHelp");
        }}
        ref={dialogRef}
      >
        <div className="modal-content">
          <button
            aria-label="Close help"
            className="icon-btn close"
            data-tn-interactive
            onClick={() => send("closeHelp")}
            type="button"
          >
            ×
          </button>
          <div className="eyebrow" style={{ marginBottom: "14px" }}>
            EXPLORE THE ATMOSPHERE
          </div>
          <h2 id="helpTitle">A moment in the storm.</h2>
          <p>
            Drag the scene to look around. Move along the road or rise above the coast. Every
            surface, cloud and sound is generated in real time.
          </p>
          <div className="help-grid">
            <span>
              <kbd>W A S D</kbd> Move
            </span>
            <span>
              <kbd>Q E</kbd> Altitude
            </span>
            <span>
              <kbd>SHIFT</kbd> Move faster
            </span>
            <span>
              <kbd>R</kbd> Reset view
            </span>
            <span>
              <kbd>L</kbd> Lightning
            </span>
            <span>
              <kbd>SPACE</kbd> Pause
            </span>
            <span>
              <kbd>H</kbd> Hide interface
            </span>
            <span>
              <kbd>P</kbd> Save image
            </span>
            <span>
              <kbd>F</kbd> Fullscreen
            </span>
            <span>
              <kbd>X</kbd> Disable flashes
            </span>
            <span>
              <kbd>M</kbd> Sound on / mute
            </span>
          </div>
          <p className="warning">
            Photosensitivity: lightning creates bright, repeated flashes. Press X to disable all
            flashes. Reduced-motion preferences disable automatic lightning by default.
          </p>
          <p>
            Weather readings are simulation controls, not a live forecast. The landscape is
            procedural, with no scanned assets.
          </p>
        </div>
      </dialog>
    </>
  );
}
