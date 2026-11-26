// The quest log: a journal of dated entries, one per stage reached, never repeated.
// No card yet (the reference indexes list no journal): the kit's own small rule.

export interface IQuestDef {
  readonly id: string;
  readonly title: string;
  /** The journal entry written on reaching stage 1, 2, 3 ... Stage 0 is "not started". */
  readonly entries: readonly string[];
}

export interface IQuestView {
  readonly id: string;
  readonly title: string;
  readonly stage: number;
  readonly done: boolean;
  readonly lines: readonly string[];
}

export class QuestLog {
  readonly #defs: readonly IQuestDef[];
  readonly #stages = new Map<string, number>();

  constructor(defs: readonly IQuestDef[]) {
    this.#defs = defs;
  }

  stage(id: string): number {
    return this.#stages.get(id) ?? 0;
  }

  /** Reach a stage. The log only moves forward: a lower or equal stage changes nothing. */
  advance(id: string, stage: number): boolean {
    const def = this.#defs.find((candidate) => candidate.id === id);
    if (def === undefined) throw new Error(`Unknown quest '${id}'.`);
    if (stage <= this.stage(id) || stage > def.entries.length) return false;
    this.#stages.set(id, stage);
    return true;
  }

  /** Quests that were started, with the entries written so far. */
  view(): IQuestView[] {
    return this.#defs
      .filter((def) => this.stage(def.id) > 0)
      .map((def) => ({
        done: this.stage(def.id) >= def.entries.length,
        id: def.id,
        lines: def.entries.slice(0, this.stage(def.id)),
        stage: this.stage(def.id),
        title: def.title,
      }));
  }
}
