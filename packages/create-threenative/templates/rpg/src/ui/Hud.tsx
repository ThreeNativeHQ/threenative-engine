import { CombatLog, PartyPanel, RoundBar, TargetPanel } from "./Panels.js";
import { Dialogue, Journal } from "./Talk.js";
import { useField } from "./useField.js";

/** The leader's skills, speed and purse: the numbers that rise as the game goes on. */
function SkillsPanel() {
  const skills = useField("skills") ?? [];
  const coins = useField("coins") ?? 0;
  const medpacks = useField("medpacks") ?? 0;
  const runSpeed = useField("runSpeed") ?? 0;
  return (
    <section
      id="skills-panel"
      className="pointer-events-none absolute right-6 top-5 w-60 rounded bg-black/70 p-3 text-[10px] uppercase tracking-[0.16em]"
    >
      {skills.map((skill) => (
        <div key={skill.id} className="mb-1">
          <div className="flex justify-between text-dim">
            <span>{skill.label}</span>
            <span className="tabular-nums text-text">{skill.level}</span>
          </div>
          <div className="h-1 w-full bg-panel">
            <div
              className="h-1 bg-amber"
              style={{ width: `${Math.round(skill.progress * 100)}%` }}
            />
          </div>
        </div>
      ))}
      <div className="mt-2 flex justify-between text-dim">
        <span>run {runSpeed.toFixed(2)} m/s</span>
        <span>
          coins {coins} / medpacks {medpacks}
        </span>
      </div>
    </section>
  );
}

export function Hud() {
  const result = useField("phase");
  const prompt = useField("prompt") ?? "";
  const message = useField("message") ?? "";
  const kills = useField("kills") ?? 0;
  const time = useField("missionTime") ?? 0;
  // Nothing to draw until the game publishes its first snapshot, a few milliseconds in.
  if (result === undefined) return null;
  return (
    <>
      <PartyPanel />
      <SkillsPanel />
      <RoundBar />
      <TargetPanel />
      <CombatLog />
      <Journal />
      <Dialogue />
      {prompt !== "" && (
        <div
          id="rpg-prompt"
          className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded bg-black/70 px-4 py-2 text-xs uppercase tracking-[0.24em] text-text"
        >
          {prompt}
        </div>
      )}
      {message !== "" && (
        <div
          id="rpg-message"
          className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 text-sm uppercase tracking-[0.3em] text-amber"
        >
          {message}
        </div>
      )}
      {result !== "playing" && (
        <div
          id="quest-result"
          className={`pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 border bg-black/80 px-8 py-5 text-center text-xl tracking-[0.4em] ${result === "won" ? "border-amber text-amber" : "border-red text-red"}`}
        >
          {result === "won" ? "quest complete" : "the party has fallen"}
          <div className="mt-2 text-[10px] tracking-[0.2em] text-dim">
            raiders {kills} / {time.toFixed(0)} s
          </div>
        </div>
      )}
    </>
  );
}
