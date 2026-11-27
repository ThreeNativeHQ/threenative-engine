import { keyed, useField } from "./useField.js";

/** The conversation: the speaker's line and the numbered choices, with each skill check named. */
export function Dialogue() {
  const dialogue = useField("dialogue");
  const check = useField("lastCheck") ?? "";
  const passed = useField("lastCheckPassed") ?? 0;
  if (dialogue === undefined || dialogue === null) return null;
  return (
    <section
      id="dialogue"
      className="pointer-events-none absolute bottom-24 left-1/2 w-[34rem] -translate-x-1/2 rounded border border-line bg-black/80 p-4 text-xs tracking-[0.06em]"
    >
      <div className="text-[10px] uppercase tracking-[0.3em] text-amber">{dialogue.speaker}</div>
      <p className="mt-2 text-text">{dialogue.text}</p>
      {check !== "" && (
        <div
          className={`mt-2 text-[10px] uppercase tracking-[0.16em] ${passed === 1 ? "text-cyan" : "text-red"}`}
        >
          {passed === 1 ? "passed" : "failed"}: {check}
        </div>
      )}
      <ol className="mt-3 space-y-1">
        {dialogue.choices.map((choice, index) => (
          <li key={choice.text} className="text-dim">
            <span className="text-cyan">{index + 1}.</span> {choice.text}
            {choice.check !== "" && <span className="ml-2 text-amber">[{choice.check}]</span>}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The journal: every started quest with the entries written so far. Toggled with J. */
export function Journal() {
  const open = useField("journalOpen") ?? 0;
  const quests = useField("quests") ?? [];
  if (open === 0) return null;
  return (
    <section
      id="journal"
      className="pointer-events-none absolute right-6 top-40 w-80 rounded border border-line bg-black/85 p-4 text-[11px] tracking-[0.04em]"
    >
      <div className="text-[10px] uppercase tracking-[0.3em] text-amber">journal</div>
      {quests.length === 0 && (
        <p className="mt-2 text-dim">No quests yet. Talk to the camp elder.</p>
      )}
      {quests.map((quest) => (
        <div key={quest.id} className="mt-2">
          <div className={quest.done ? "text-cyan" : "text-text"}>
            {quest.title}
            {quest.done ? " (done)" : ""}
          </div>
          {keyed(quest.lines).map((entry) => (
            <p key={entry.key} className="mt-1 text-dim">
              {entry.line}
            </p>
          ))}
        </div>
      ))}
    </section>
  );
}
