import type { IQuestView } from "./rules/quests.js";

export type GamePhase = "playing" | "won" | "lost";

/** One party member as the HUD draws it. */
export type MemberView = {
  readonly id: string;
  readonly name: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly leader: boolean;
  readonly down: boolean;
  /** The queued actions, front first: "attack:raider.1", "heal:hero". */
  readonly queue: readonly string[];
};

export type SkillView = {
  readonly id: string;
  readonly label: string;
  readonly level: number;
  readonly need: number;
  readonly progress: number;
};

export type DialogueView = {
  readonly speaker: string;
  readonly text: string;
  readonly choices: readonly { readonly text: string; readonly check: string }[];
};

export type GameState = {
  /** Set from the UI's pause and resume intents, and read back by the menu. */
  paused: boolean;
  /** True once the UI layer has rendered and published its interactive rectangles. */
  uiReady: boolean;
  phase: GamePhase;
  leader: string;
  party: MemberView[];
  /** 1 while combat rounds are running or ran in the last eight seconds. */
  inCombat: number;
  /** Seconds into the leader's current round, 0 to 3; 0 when it has none. */
  roundTime: number;
  target: string;
  targetName: string;
  targetHp: number;
  targetDefense: number;
  /** The leader's attack bonus, as the HUD shows it beside the target's defense. */
  attackBonus: number;
  /** The last attack resolved by the leader: its die, outcome and damage. */
  lastRoll: number;
  lastOutcome: "" | "miss" | "hit" | "critical";
  lastDamage: number;
  /** "hit" or "miss" when the roll was a natural 20 or 1, otherwise "". */
  lastAutomatic: "" | "hit" | "miss";
  /** Dice words, newest last. */
  log: string[];
  skills: SkillView[];
  /** Metres per second the leader runs at, from Speed and Athletics. */
  runSpeed: number;
  dialogue: DialogueView | undefined;
  /** The last skill check: "Persuasion 12 + 1 vs 12". */
  lastCheck: string;
  lastCheckPassed: number;
  quests: IQuestView[];
  /** 1 while the journal panel is open. */
  journalOpen: number;
  kills: number;
  coins: number;
  medpacks: number;
  /** "overhead" or "dialogue": which shot the camera holds. */
  shot: "overhead" | "dialogue";
  prompt: string;
  message: string;
  playerX: number;
  playerZ: number;
  missionTime: number;
};
