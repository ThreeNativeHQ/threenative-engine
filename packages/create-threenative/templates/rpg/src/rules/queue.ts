// An action queue. Reference: reone card `action-queue` (object.cpp, action/*.cpp).
// Each object owns one. Only the front action runs, so a long queue advances one action at a time.

/** Walk-up distance every interaction shares: talk, use, search. object.cpp:34. Metres here. */
export const INTERACTION_DISTANCE = 2;
/** A plain move order completes inside this radius. movetopoint.cpp:29. */
export const ARRIVAL_RADIUS = 1;
/** Queued actions a player can stack. The kit's rule: a longer queue hides what will happen. */
export const QUEUE_LIMIT = 4;

export type Action =
  | { readonly kind: "move"; readonly x: number; readonly z: number }
  | { readonly kind: "attack"; readonly target: string; started: boolean }
  | { readonly kind: "follow" }
  | { readonly kind: "talk"; readonly npc: string }
  | { readonly kind: "heal"; readonly target: string };

export class ActionQueue {
  readonly #items: Action[] = [];

  get length(): number {
    return this.#items.length;
  }

  get front(): Action | undefined {
    return this.#items[0];
  }

  /** The queue as short words for the HUD and the playtest: "attack:raider.1". */
  get labels(): string[] {
    return this.#items.map((action) => {
      if (action.kind === "attack") return `attack:${action.target}`;
      if (action.kind === "talk") return `talk:${action.npc}`;
      if (action.kind === "heal") return `heal:${action.target}`;
      return action.kind;
    });
  }

  push(action: Action): boolean {
    if (this.#items.length >= QUEUE_LIMIT) return false;
    this.#items.push(action);
    return true;
  }

  clear(): void {
    this.#items.length = 0;
  }

  /** Drop every action that names this actor, such as attacks on a target that just fell. */
  drop(id: string): void {
    for (let index = this.#items.length - 1; index >= 0; index -= 1) {
      const action = this.#items[index];
      if (
        action !== undefined &&
        ((action.kind === "attack" && action.target === id) ||
          (action.kind === "talk" && action.npc === id) ||
          (action.kind === "heal" && action.target === id))
      )
        this.#items.splice(index, 1);
    }
  }

  /** Run the front action once; `step` returns true when it is done and the action leaves. */
  update(step: (action: Action) => boolean): void {
    const front = this.#items[0];
    if (front !== undefined && step(front)) this.#items.shift();
  }
}
