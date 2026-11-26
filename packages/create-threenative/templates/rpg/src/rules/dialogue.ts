// A conversation tree with skill checks. No card yet (the reference indexes list no dialogue):
// the kit's own rule. A check rolls a d20, adds the skill and ability bonus, and meets a target.
import type { Die } from "./d20.js";

export interface ICheck {
  /** Shown to the player: "Persuasion 12". */
  readonly label: string;
  readonly dc: number;
  readonly pass: string;
  readonly fail: string;
}

export interface IChoice {
  readonly text: string;
  /** The node the choice leads to; absent when `check` decides it. */
  readonly next?: string;
  readonly check?: ICheck;
  /** Hidden unless this holds for the world. */
  readonly when?: (world: IWorld) => boolean;
}

export interface INode {
  readonly speaker: string;
  readonly text: string;
  /** Named effects the game applies when the node is reached: "quest:ruin:1", "recruit", "coins:50". */
  readonly enter?: readonly string[];
  readonly choices: readonly IChoice[];
}

export interface ITree {
  readonly start: (world: IWorld) => string;
  readonly nodes: Readonly<Record<string, INode>>;
}

export interface IWorld {
  stage(quest: string): number;
  readonly partyFull: boolean;
}

export interface ICheckResult {
  readonly label: string;
  readonly roll: number;
  readonly bonus: number;
  readonly dc: number;
  readonly passed: boolean;
}

export interface IChoiceView {
  readonly text: string;
  readonly check: string;
}

export class Conversation {
  #tree: ITree | undefined;
  #node = "";
  /** The last skill check, kept so the HUD can show the roll. */
  lastCheck: ICheckResult | undefined;

  get open(): boolean {
    return this.#tree !== undefined;
  }

  start(tree: ITree, world: IWorld): void {
    this.#tree = tree;
    this.#node = tree.start(world);
    this.lastCheck = undefined;
  }

  close(): void {
    this.#tree = undefined;
    this.#node = "";
  }

  node(): INode | undefined {
    return this.#tree?.nodes[this.#node];
  }

  /** The choices the player sees now, with their check labels. */
  choices(world: IWorld): readonly IChoice[] {
    return this.node()?.choices.filter((choice) => choice.when?.(world) !== false) ?? [];
  }

  view(world: IWorld): IChoiceView[] {
    return this.choices(world).map((choice) => ({
      check: choice.check === undefined ? "" : `${choice.check.label} DC ${choice.check.dc}`,
      text: choice.text,
    }));
  }

  /**
   * Take choice `index` (0 based). `bonus` is the skill and ability bonus of the speaker. Returns
   * the effects of the node reached, the check rolled and whether the conversation ended.
   */
  choose(
    index: number,
    world: IWorld,
    die: Die,
    bonus: number,
  ): { effects: readonly string[]; check: ICheckResult | undefined; ended: boolean } | undefined {
    const choice = this.choices(world)[index];
    const tree = this.#tree;
    if (choice === undefined || tree === undefined) return undefined;
    let next = choice.next;
    let check: ICheckResult | undefined;
    if (choice.check !== undefined) {
      const roll = die(20);
      const passed = roll + bonus >= choice.check.dc;
      check = { bonus, dc: choice.check.dc, label: choice.check.label, passed, roll };
      this.lastCheck = check;
      next = passed ? choice.check.pass : choice.check.fail;
    }
    const reached = next === undefined ? undefined : tree.nodes[next];
    if (next === undefined || reached === undefined) {
      this.close();
      return { check, effects: [], ended: true };
    }
    this.#node = next;
    return { check, effects: reached.enter ?? [], ended: false };
  }
}
