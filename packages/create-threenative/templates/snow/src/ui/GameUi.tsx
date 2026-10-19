import { UiLayer, useUiIntent, useUiState } from "@threenative/ui";
import { useEffect, useState } from "react";
import { type GameState, PROBE_COLUMNS } from "../state.js";
import { BallActions, Controls } from "./Controls.js";
import { Icon, Mark } from "./icons.js";

const VIEW_LABELS: Record<GameState["view"], string> = {
  follow: "Follow view",
  overhead: "Overhead view",
  surface: "Surface view",
};

function IconButton({
  icon,
  label,
  onClick,
  pressed,
  className = "",
}: {
  readonly icon: Parameters<typeof Icon>[0]["name"];
  readonly label: string;
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly className?: string;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={pressed}
      className={`grid h-11 w-11 place-items-center rounded-full border backdrop-blur-md transition hover:brightness-110 ${
        pressed ? "border-aqua text-aqua" : "border-[rgb(233_247_252/0.22)] text-text"
      } bg-[rgb(21_41_54/0.37)] ${className}`}
      data-tn-interactive
      onClick={onClick}
      title={label}
      type="button"
    >
      <Icon name={icon} />
    </button>
  );
}

/** The last footprint's floor, drawn as a small depth map: darker blue is deeper. */
function Probe({ values }: { readonly values: readonly number[] }) {
  const rows = Math.max(1, Math.ceil(values.length / PROBE_COLUMNS));
  return (
    <svg
      aria-label="Depth map of the last footprint"
      className="h-[113px] w-[89px] shrink-0 overflow-hidden rounded-[7px] border border-[#d5e2e955] bg-[#cbdce6]"
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${PROBE_COLUMNS} ${rows}`}
    >
      <defs>
        {/* The grid is coarse; a slight blur reads as a pressed surface rather than pixels. */}
        <filter id="probe-soften">
          <feGaussianBlur stdDeviation="0.22" />
        </filter>
      </defs>
      <g filter="url(#probe-soften)">
        {values.map((value, index) => {
          const shade = Math.max(0, Math.min(1, value / 0.18));
          const bank = Math.max(0, Math.min(1, -value / 0.045));
          const r = Math.round(214 - shade * 109 + bank * 33);
          const g = Math.round(230 - shade * 92 + bank * 21);
          const b = Math.round(240 - shade * 64 + bank * 15);
          return (
            <rect
              fill={`rgb(${r} ${g} ${b})`}
              height={1.02}
              // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid whose cells never reorder.
              key={index}
              width={1.02}
              x={index % PROBE_COLUMNS}
              y={Math.floor(index / PROBE_COLUMNS)}
            />
          );
        })}
      </g>
    </svg>
  );
}

function Metric({
  label,
  value,
  unit,
}: { readonly label: string; readonly value: string; readonly unit?: string }) {
  return (
    <div>
      <div className="mb-1 text-[9px] uppercase tracking-[0.14em] text-[#9cb7c4]">{label}</div>
      <div className="text-[22px] font-[450] leading-none tracking-tight tabular-nums">
        {value}
        {unit === undefined ? null : (
          <em className="ml-1 text-[10px] not-italic text-[#99b8c6]">{unit}</em>
        )}
      </div>
    </div>
  );
}

function Help({ onClose }: { readonly onClose: () => void }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [onClose]);
  return (
    <div className="pointer-events-auto fixed inset-0 z-30 grid place-items-center bg-[#05182677] p-4 backdrop-blur-sm">
      <dialog
        aria-labelledby="help-title"
        aria-modal="true"
        className="static m-0 w-[420px] max-w-full rounded-[15px] border border-[#647f8e] bg-[#172f3d] p-7 text-[#dbe9ed] shadow-[0_35px_90px_#04121daa]"
        open
      >
        <h2 className="m-0 mb-2 text-[23px] font-[450]" id="help-title">
          Leave a little trace.
        </h2>
        <p className="text-[12px] leading-relaxed text-[#a9c0cd]">
          Walk the glade, push the ball through the powder, or switch on the blizzard and watch the
          tracks fill.
        </p>
        <table className="my-5 w-full border-collapse text-[12px]">
          <tbody>
            {[
              ["Walk / run", "WASD or arrows / Shift"],
              ["Orbit / zoom", "Drag / scroll"],
              ["Drop / push the ball", "F / G"],
              ["Blizzard / camera", "B / C"],
              ["Auto-explore / compaction", "P / V"],
              ["Clear footprints / sound", "R / M"],
            ].map(([action, keys]) => (
              <tr className="border-b border-white/10" key={action}>
                <td className="py-2">{action}</td>
                <td className="py-2 text-right text-[#b5dbd5]">{keys}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-[11px] leading-relaxed text-[#a9c0cd]">
          The snow is a deformable heightfield with approximate compaction and deposition, not a
          granular solver.
        </p>
        <button
          className="mt-2 min-h-11 w-full rounded-[7px] bg-aqua text-[12px] text-aqua-ink"
          data-tn-interactive
          // biome-ignore lint/a11y/noAutofocus: a modal moves focus to its one action.
          autoFocus
          onClick={onClose}
          type="button"
        >
          Back to the snow
        </button>
      </dialog>
    </div>
  );
}

function Toast({ state }: { readonly state: GameState }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (state.toastId === 0) return;
    setShown(true);
    const timer = setTimeout(() => setShown(false), 2800);
    return () => clearTimeout(timer);
  }, [state.toastId]);
  return (
    <output
      aria-live="polite"
      className={`fixed bottom-[100px] left-1/2 z-20 max-w-[85vw] -translate-x-1/2 rounded-[9px] border border-line bg-[rgb(16_35_46/0.88)] px-4 py-3 text-center text-[12px] backdrop-blur-lg transition-opacity max-[850px]:bottom-[250px] ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      {state.toast}
    </output>
  );
}

function Hud() {
  const state = useUiState<GameState>();
  const send = useUiIntent();
  const [menuOpen, setMenuOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  if (state === undefined) return null;
  const weatherWords = state.blizzard ? "Incoming gusts · spindrift" : "Light air · dry powder";
  return (
    <div className="pointer-events-none absolute inset-0 select-none text-text">
      {/* Vignette and storm veil: atmosphere only, never in the way of a click. */}
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(5_20_31/0.24),transparent_42%),linear-gradient(0deg,rgb(9_24_35/0.46),transparent_18%,transparent_80%,rgb(7_22_32/0.18))]" />
      {/* A soft scrim under the header and readouts keeps small light text legible over snow. */}
      <div className="absolute inset-x-0 top-0 h-[210px] bg-[linear-gradient(180deg,rgb(10_26_36/0.42),transparent)]" />
      <div
        className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgb(224_239_246/0.23))]"
        style={{ opacity: state.storm * 0.8 }}
      />

      <header className="absolute left-5 right-5 top-5 flex items-center justify-between gap-3 min-[851px]:left-[34px] min-[851px]:right-[34px] min-[851px]:top-[25px]">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[11px] border border-[rgb(238_246_250/0.55)] bg-[rgb(28_50_61/0.16)]">
            <Mark />
          </div>
          <div className="min-w-0">
            <div className="truncate text-[15px] font-semibold tracking-[0.26em]">SNOW GLADE</div>
            <div className="mt-1 truncate text-[9px] tracking-[0.2em] opacity-80">
              DEFORMABLE SNOW STUDY
            </div>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <div className="mr-1 hidden items-center gap-2 rounded-full border border-[rgb(222_242_249/0.25)] bg-[rgb(20_39_51/0.24)] px-4 py-2.5 text-[10px] tracking-[0.13em] backdrop-blur-md min-[560px]:flex">
            <span
              className={`h-[5px] w-[5px] rounded-full ${state.paused ? "bg-[#c4c6c0]" : "bg-aqua shadow-[0_0_9px_rgb(159_226_204/0.5)]"}`}
            />
            <span>{state.paused ? "SIMULATION PAUSED" : "LIVE SIMULATION"}</span>
          </div>
          <IconButton
            icon={state.muted ? "muted" : "sound"}
            label={state.muted ? "Turn sound on" : "Turn sound off"}
            onClick={() => send("mute")}
            pressed={!state.muted}
          />
          <IconButton
            className="max-[850px]:hidden"
            icon="help"
            label="Controls and notes"
            onClick={() => setHelpOpen(true)}
          />
          <IconButton
            className="min-[851px]:hidden"
            icon={menuOpen ? "close" : "menu"}
            label={menuOpen ? "Close settings" : "Open settings"}
            onClick={() => setMenuOpen(!menuOpen)}
            pressed={menuOpen}
          />
        </div>
      </header>

      {/* Left column: title, then the controls. On a phone the controls live behind the menu. */}
      <section className="absolute bottom-[98px] left-[34px] top-[120px] w-[285px] [@media(max-height:800px)]:top-[92px] [@media(max-height:800px)]:bottom-[84px] overflow-y-auto [scrollbar-width:none] max-[1100px]:w-[264px] max-[850px]:left-4 max-[850px]:right-4 max-[850px]:top-[84px] max-[850px]:w-auto max-[850px]:bottom-[88px]">
        <div
          className={`mb-6 [text-shadow:0_1px_10px_rgb(16_40_54/0.35)] max-[850px]:mb-3 [@media(max-height:800px)]:mb-5 ${menuOpen ? "max-[850px]:hidden" : ""}`}
        >
          <div className="text-[9px] font-medium tracking-[0.28em] text-[#dfedf2]">
            A STUDY IN WINTER
          </div>
          <h1 className="mb-3 mt-3 text-[46px] font-[450] leading-[1.04] tracking-[-0.05em] max-[1100px]:text-[40px] max-[850px]:text-[32px] [@media(max-height:800px)]:mb-0 [@media(max-height:800px)]:mt-2 [@media(max-height:800px)]:text-[30px]">
            Snow,
            <br className="[@media(max-height:800px)]:hidden" />{" "}
            <span className="font-light text-[#e2eef1]">in motion.</span>
          </h1>
          <p className="m-0 max-w-[250px] text-[12px] leading-[1.7] opacity-90 max-[850px]:hidden [@media(max-height:800px)]:hidden">
            Fresh powder. Every step remembered. A ball that carves its own track.
          </p>
        </div>
        <div className={`pointer-events-auto ${menuOpen ? "" : "max-[850px]:hidden"}`}>
          <Controls send={send} state={state} />
          <p className="mt-3 text-[10px] tracking-[0.05em] text-[#e2ecf0] opacity-90 [text-shadow:0_1px_5px_#264452] max-[850px]:hidden">
            Take over at any time with WASD.
          </p>
        </div>
      </section>

      <div
        className={`absolute right-[34px] top-[103px] text-right [text-shadow:0_1px_3px_rgb(10_30_40/0.55),0_0_12px_rgb(16_40_54/0.35)] max-[850px]:right-4 max-[850px]:top-[84px] ${menuOpen ? "max-[850px]:hidden" : ""}`}
      >
        <div className="text-[28px] font-light leading-none tabular-nums">
          {state.windNow.toFixed(1)}
          <small className="ml-0.5 text-[10px] opacity-80">m/s</small>
        </div>
        <div className="mt-2 text-[9px] font-medium tracking-[0.2em]">WIND AT SNOWFIELD</div>
        <div className="mt-1.5 text-[9px] font-medium uppercase tracking-[0.18em] opacity-90">
          {weatherWords}
        </div>
      </div>

      <aside
        aria-label="Snow readouts"
        className="pointer-events-auto absolute bottom-[115px] right-[31px] w-[236px] rounded-[15px] border border-line bg-panel p-4 backdrop-blur-xl max-[1100px]:w-[216px] max-[850px]:hidden"
      >
        <div className="mb-3 flex items-center justify-between text-[9px] tracking-[0.2em] text-[#c2d6e0]">
          <span>LAST FOOTFALL</span>
          <i className="h-[5px] w-[5px] rounded-full bg-aqua" />
        </div>
        <div className="flex items-center gap-4">
          <Probe values={state.probe} />
          <div className="flex flex-col gap-3">
            <Metric label="Boot sink" unit="cm" value={(state.lastSink * 100).toFixed(1)} />
            <Metric label="Contacts" value={state.contacts.toLocaleString("en-US")} />
          </div>
        </div>
        <div className="mt-3 flex justify-between border-t border-line pt-3 text-[10px] text-[#9ebac8]">
          <span>Ground speed</span>
          <span className="tabular-nums text-[#d0e7e7]">{state.speed.toFixed(2)} m/s</span>
        </div>
        <div className="mt-4 flex items-center justify-between border-t border-line pt-3 text-[9px] tracking-[0.2em] text-[#c2d6e0]">
          <span>BALL</span>
          <span className="text-[10px] tracking-normal tabular-nums text-[#d0e7e7]">
            {(state.ballSink * 100).toFixed(1)} cm · {Math.round(state.ballLoad)} N
          </span>
        </div>
        <div className="mt-3">
          <BallActions send={send} />
        </div>
      </aside>

      <footer className="absolute bottom-[26px] left-[34px] right-[34px] flex items-center justify-between gap-4 max-[850px]:bottom-4 max-[850px]:left-4 max-[850px]:right-4">
        <div className="min-w-[200px] text-[9px] tracking-[0.2em] text-[#e0ecf1] opacity-80 [text-shadow:0_1px_5px_#264452] max-[1100px]:invisible max-[850px]:hidden">
          THREENATIVE <span className="text-[#b9d8de]">/</span> SNOW STUDY
        </div>
        <div className="flex items-center gap-4 rounded-full border border-[rgb(210_233_244/0.18)] bg-[rgb(17_35_46/0.59)] px-[18px] py-[11px] text-[11px] text-[#d8e5eb] backdrop-blur-xl max-[850px]:hidden">
          {[
            ["W A S D", "Walk"],
            ["SHIFT", "Run"],
            ["F / G", "Ball"],
            ["B", "Blizzard"],
            ["DRAG", "Orbit"],
          ].map(([key, action]) => (
            <span className="flex items-center gap-1.5 whitespace-nowrap" key={action}>
              <kbd className="rounded border border-[rgb(206_232_244/0.35)] px-1 py-0.5 font-sans text-[9px] text-[#e6f1f5]">
                {key}
              </kbd>
              {action}
            </span>
          ))}
        </div>
        <div className="flex min-w-[150px] justify-end max-[850px]:w-full">
          <button
            className="pointer-events-auto flex min-h-11 items-center gap-2 rounded-[9px] border border-line bg-[rgb(20_39_50/0.75)] px-3.5 text-[11px] backdrop-blur-md transition hover:brightness-110"
            data-tn-interactive
            onClick={() => send("view")}
            title="Cycle camera view (C)"
            type="button"
          >
            <Icon name="camera" />
            {VIEW_LABELS[state.view]}
          </button>
        </div>
      </footer>

      <Toast state={state} />
      {helpOpen ? <Help onClose={() => setHelpOpen(false)} /> : null}
    </div>
  );
}

export function GameUi() {
  return (
    <UiLayer>
      <Hud />
    </UiLayer>
  );
}
