import { useUiIntent, useUiState } from "@threenative/ui";
import type { GameState } from "../state.js";

/** The seat colours, as in `pawnMaterials` in `render/props.ts`: the HUD is a web view and cannot import it. */
const SEAT = ["#d0532a", "#2a6cf0", "#e8b86a", "#3fae5a"] as const;

const BUTTON =
  "pointer-events-auto rounded border border-line bg-black/75 px-4 py-2 text-xs uppercase tracking-[0.2em] text-text hover:border-amber hover:text-amber";

/** One field of the published state; each read re-renders only when its own value changes. */
function useField<K extends keyof GameState>(key: K): GameState[K] | undefined {
  return useUiState<GameState, GameState[K]>((state) => state[key]);
}

function Scoreboard() {
  const players = useField("players") ?? [];
  const active = useField("active");
  return (
    <section
      id="scoreboard"
      className="pointer-events-none absolute left-6 top-5 w-64 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
    >
      {players.map((player, seat) => (
        <div
          key={player.name}
          className={`flex items-center justify-between py-1 ${seat === active ? "text-text" : "text-dim"}`}
        >
          <span className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5" style={{ background: SEAT[seat] }} />
            {seat === active ? ">" : " "} {player.name}
          </span>
          <span className="tabular-nums">
            {player.coins} coins / {player.stars} star{player.stars === 1 ? "" : "s"}
          </span>
        </div>
      ))}
    </section>
  );
}

function Prompt() {
  const send = useUiIntent();
  const prompt = useField("prompt") ?? "";
  const turnPhase = useField("turnPhase");
  const active = useField("active") ?? 0;
  const miniId = useField("miniId") ?? "";
  const miniGo = useField("miniGo") ?? 0;
  const players = useField("players") ?? [];
  const yes = (label: string) => (
    <button className={BUTTON} data-tn-interactive onClick={() => send("confirm")} type="button">
      {label}
    </button>
  );
  const no = (label: string) => (
    <button className={BUTTON} data-tn-interactive onClick={() => send("decline")} type="button">
      {label}
    </button>
  );
  let body = null;
  if (turnPhase === "roll" && active === 0) body = yes("Roll the die  [space]");
  else if (prompt === "junction")
    body = (
      <>
        {yes("Take the shortcut  [y]")}
        {no("Stay on the ring  [n]")}
      </>
    );
  else if (prompt === "star") {
    body = (
      <>
        {yes("Buy the star: 20 coins  [y]")}
        {no("Not now  [n]")}
      </>
    );
  } else if (miniId === "rope" && turnPhase === "minigame") body = yes("Hop  [space]");
  else if (miniId === "dash" && turnPhase === "minigame")
    body = (
      <span className="text-xs tracking-[0.3em] text-text">
        {miniGo === 1 ? "GO: hold right" : "wait for green"}
      </span>
    );
  else if (turnPhase === "roll" || turnPhase === "walk" || turnPhase === "rolling")
    body = (
      <span className="text-xs uppercase tracking-[0.24em] text-dim">
        {players[active]?.name ?? ""} is on the move
      </span>
    );
  if (body === null) return null;
  return (
    <div
      id="board-prompt"
      className="absolute bottom-10 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded bg-black/70 px-4 py-2"
    >
      {body}
    </div>
  );
}

function Banner() {
  const turn = useField("turn") ?? 1;
  const limit = useField("turnLimit") ?? 10;
  const die = useField("die") ?? 0;
  const steps = useField("stepsLeft") ?? 0;
  const turnPhase = useField("turnPhase");
  const message = useField("message") ?? "";
  const miniId = useField("miniId") ?? "";
  return (
    <>
      <div
        id="turn-banner"
        className="pointer-events-none absolute left-1/2 top-5 -translate-x-1/2 rounded border border-line bg-black/70 px-4 py-1 text-xs uppercase tracking-[0.3em] text-dim"
      >
        turn {turn} / {limit}
      </div>
      {die > 0 && (turnPhase === "rolling" || turnPhase === "walk" || turnPhase === "junction") && (
        <div
          id="die"
          className="pointer-events-none absolute right-8 top-5 grid h-20 w-20 place-items-center rounded border border-amber bg-black/70 text-4xl text-amber"
        >
          {turnPhase === "rolling" ? die : steps}
        </div>
      )}
      {message !== "" && (
        <div
          id="board-message"
          className="pointer-events-none absolute left-1/2 top-16 -translate-x-1/2 rounded bg-black/70 px-4 py-1 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      {turnPhase === "intro" && (
        <div
          id="minigame-card"
          className="pointer-events-none absolute left-1/2 top-1/3 -translate-x-1/2 rounded border border-amber bg-black/80 px-8 py-5 text-center"
        >
          <div className="text-xl uppercase tracking-[0.4em] text-amber">
            {miniId === "dash" ? "dash" : "rope"}
          </div>
          <div className="mt-2 text-[11px] uppercase tracking-[0.2em] text-dim">
            {miniId === "dash"
              ? "Wait for GO, then hold right. Run early and you freeze."
              : "Press space to hop the bar. Last one standing wins."}
          </div>
        </div>
      )}
    </>
  );
}

function Result() {
  const send = useUiIntent();
  const result = useField("phase");
  const ranking = useField("ranking") ?? [];
  const players = useField("players") ?? [];
  if (result === undefined || result === "playing") return null;
  return (
    <div
      id="match-result"
      className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded border bg-black/85 px-8 py-5 text-center ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
    >
      <div className="text-xl uppercase tracking-[0.4em]">
        {result === "won" ? "you win" : "you lose"}
      </div>
      <ol className="mt-3 text-[11px] uppercase tracking-[0.2em] text-dim">
        {ranking.map((seat, place) => (
          <li key={players[seat]?.name ?? place}>
            {place + 1}. {players[seat]?.name} / {players[seat]?.stars} stars /{" "}
            {players[seat]?.coins} coins
          </li>
        ))}
      </ol>
      <button
        className={`${BUTTON} mt-4`}
        data-tn-interactive
        onClick={() => send("restart")}
        type="button"
      >
        Play again [r]
      </button>
    </div>
  );
}

export function Hud() {
  const players = useField("players");
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (players === undefined || players.length === 0) return null;
  return (
    <>
      <Scoreboard />
      <Banner />
      <Prompt />
      <Result />
    </>
  );
}
