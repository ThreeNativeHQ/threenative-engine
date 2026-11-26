import type { GameState } from "../state.js";
import { useField } from "./useField.js";

const CONDITION = {
  fine: { label: "Fine", tone: "text-green", stroke: "stroke-green", beat: "1.6s" },
  caution: { label: "Caution", tone: "text-amber", stroke: "stroke-amber", beat: "1.1s" },
  danger: { label: "Danger", tone: "text-red", stroke: "stroke-red", beat: "0.7s" },
} as const;

/** The heart trace the classic status screen drew: its colour and its pace are the condition. */
function Ecg({ condition }: { condition: GameState["condition"] }) {
  const look = CONDITION[condition];
  return (
    <svg viewBox="0 0 160 40" className="h-10 w-40" aria-hidden="true">
      <polyline
        points="0,22 30,22 38,22 44,8 50,34 56,22 80,22 110,22 118,22 124,8 130,34 136,22 160,22"
        className={`ecg fill-none ${look.stroke}`}
        // The pace is a runtime value: a worse condition beats faster.
        style={{ animationDuration: look.beat }}
        strokeWidth="2"
      />
    </svg>
  );
}

export function Hud() {
  const condition = useField("condition");
  const room = useField("room");
  const aiming = useField("aiming");
  const magazine = useField("magazine");
  const reserve = useField("reserve");
  const grabbed = useField("grabbed");
  const message = useField("message");
  const prompt = useField("prompt");
  const menu = useField("menu");
  const phase = useField("phase");
  // Nothing to draw before the first snapshot, and nothing over a menu, a door or an end screen.
  if (condition === undefined || menu !== "none" || phase !== "playing") return null;
  const look = CONDITION[condition];
  return (
    <>
      <section
        id="condition"
        className="pointer-events-none absolute right-6 top-5 w-48 rounded bg-black/70 p-3 text-[11px] uppercase tracking-[0.18em]"
      >
        <Ecg condition={condition} />
        <div className={`mt-1 text-lg leading-none ${look.tone}`}>{look.label}</div>
        <div className="mt-2 border-t border-line pt-2 text-text">{room}</div>
      </section>
      {aiming === 1 && (
        <section
          id="ammo"
          className="pointer-events-none absolute bottom-6 right-6 rounded bg-black/70 px-4 py-2 text-right uppercase tracking-[0.16em]"
        >
          <div className="text-[11px] text-text">Handgun</div>
          <div className="text-2xl leading-none text-text">
            {magazine}
            <span className="text-sm text-text"> / {reserve}</span>
          </div>
        </section>
      )}
      {grabbed === 1 && (
        <div className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 rounded bg-black/80 px-5 py-3 text-sm uppercase tracking-[0.3em] text-red">
          Struggle! Press E, A or D
        </div>
      )}
      <section className="pointer-events-none absolute bottom-8 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">
        {message !== undefined && message !== "" && (
          <div id="message" className="rounded bg-black/80 px-5 py-2 text-sm text-text">
            {message}
          </div>
        )}
        {prompt !== undefined && prompt !== "" && (message ?? "") === "" && (
          <div
            id="prompt"
            className="rounded bg-black/70 px-4 py-1 text-xs uppercase tracking-[0.2em] text-text"
          >
            E · {prompt}
          </div>
        )}
      </section>
    </>
  );
}
