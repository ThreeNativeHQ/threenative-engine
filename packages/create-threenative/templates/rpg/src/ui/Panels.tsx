import { useField, keyed } from "./useField.js";

const ROUND = 3;

/** The party: one card per member with its hit points and the actions queued for it. */
export function PartyPanel() {
  const party = useField("party") ?? [];
  return (
    <section
      id="party-panel"
      className="pointer-events-none absolute left-6 top-5 w-64 space-y-2 text-[10px] uppercase tracking-[0.16em]"
    >
      {party.map((member) => (
        <div
          key={member.id}
          className={`rounded border bg-black/70 p-2 ${member.leader ? "border-cyan" : "border-line"} ${member.down ? "opacity-50" : ""}`}
        >
          <div className="flex justify-between">
            <span className={member.leader ? "text-cyan" : "text-text"}>
              {member.leader ? "> " : ""}
              {member.name}
            </span>
            <span className="tabular-nums text-dim">
              {member.hp}/{member.maxHp}
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full bg-panel">
            <div
              className={`h-1.5 ${member.hp / member.maxHp > 0.3 ? "bg-cyan" : "bg-red"}`}
              style={{ width: `${Math.round((member.hp / member.maxHp) * 100)}%` }}
            />
          </div>
          <div className="mt-1 min-h-3 text-amber">
            {member.down ? "down" : member.queue.join("  >  ")}
          </div>
        </div>
      ))}
    </section>
  );
}

/** The round clock, shown while the leader is in a round, and the combat flag. */
export function RoundBar() {
  const inCombat = useField("inCombat") ?? 0;
  const roundTime = useField("roundTime") ?? 0;
  if (inCombat === 0) return null;
  return (
    <div
      id="round-bar"
      className="pointer-events-none absolute left-1/2 top-5 w-72 -translate-x-1/2 border border-red bg-black/70 px-3 py-1 text-center text-[10px] uppercase tracking-[0.3em] text-red"
    >
      combat
      <div className="mt-1 h-1.5 w-full bg-panel">
        <div
          className="h-1.5 bg-red"
          style={{ width: `${Math.round((roundTime / ROUND) * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** The target's name, hit points and defense, beside the leader's attack bonus. */
export function TargetPanel() {
  const name = useField("targetName") ?? "";
  const hp = useField("targetHp") ?? 0;
  const defense = useField("targetDefense") ?? 0;
  const bonus = useField("attackBonus") ?? 0;
  const roll = useField("lastRoll") ?? 0;
  const outcome = useField("lastOutcome") ?? "";
  if (name === "") return null;
  return (
    <section
      id="target-panel"
      className="pointer-events-none absolute right-6 top-40 w-60 rounded border border-red bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
    >
      <div className="text-red">{name}</div>
      <div className="mt-1 flex justify-between text-dim">
        <span>{hp > 0 ? `hp ${hp}` : "no hp"}</span>
        <span>defense {defense}</span>
      </div>
      <div className="mt-1 flex justify-between text-dim">
        <span>your attack +{bonus}</span>
        <span className={outcome === "miss" ? "text-dim" : "text-amber"}>
          {outcome === "" ? "" : `d20 ${roll} ${outcome}`}
        </span>
      </div>
    </section>
  );
}

/** The dice words: every attack and check, newest last. */
export function CombatLog() {
  const log = useField("log") ?? [];
  if (log.length === 0) return null;
  return (
    <section
      id="combat-log"
      className="pointer-events-none absolute bottom-6 left-6 w-[28rem] rounded bg-black/70 p-3 text-[10px] tracking-[0.08em] text-dim"
    >
      {keyed(log).map((entry) => (
        <div key={entry.key}>{entry.line}</div>
      ))}
    </section>
  );
}
