// What the game says and who the actors are: one place for numbers and words.
import { type IAbilities, type IWeapon, UNARMED } from "./rules/d20.js";
import type { ITree, IWorld } from "./rules/dialogue.js";
import type { IQuestDef } from "./rules/quests.js";
import type { SkillId } from "./rules/skills.js";

/** Class attack bonus by level, level 1 first. reone sums a class table over class levels. */
export const CLASS_ATTACK: readonly number[] = [1, 2, 3, 4, 5, 6];

export interface IStats {
  readonly abilities: IAbilities;
  readonly maxHp: number;
  readonly level: number;
  /** The Speed attribute, 0 to 100, as the Morrowind formula reads it. */
  readonly speed: number;
  readonly weapon: IWeapon;
  readonly skills: Readonly<Record<SkillId, number>>;
}

const blade: IWeapon = { dice: 1, multiplier: 2, name: "blade", sides: 8, threat: 2 };
const staff: IWeapon = { dice: 1, multiplier: 2, name: "staff", sides: 6, threat: 1 };
const axe: IWeapon = { dice: 1, multiplier: 3, name: "axe", sides: 10, threat: 1 };
const cleaver: IWeapon = { dice: 1, multiplier: 2, name: "cleaver", sides: 4, threat: 1 };

export const STATS: Readonly<Record<string, IStats>> = {
  ally: {
    abilities: { cha: 10, dex: 14, str: 12 },
    level: 1,
    maxHp: 26,
    skills: { athletics: 20, melee: 15, persuasion: 5 },
    speed: 55,
    weapon: staff,
  },
  hero: {
    abilities: { cha: 12, dex: 12, str: 14 },
    level: 1,
    maxHp: 36,
    skills: { athletics: 10, melee: 10, persuasion: 5 },
    speed: 50,
    weapon: blade,
  },
  raider: {
    abilities: { cha: 8, dex: 10, str: 12 },
    level: 1,
    maxHp: 14,
    skills: { athletics: 10, melee: 5, persuasion: 0 },
    speed: 50,
    weapon: cleaver,
  },
  elder: {
    abilities: { cha: 14, dex: 10, str: 10 },
    level: 1,
    maxHp: 10,
    skills: { athletics: 10, melee: 0, persuasion: 0 },
    speed: 45,
    weapon: UNARMED,
  },
  sellsword: {
    abilities: { cha: 10, dex: 12, str: 14 },
    level: 1,
    maxHp: 28,
    skills: { athletics: 15, melee: 18, persuasion: 5 },
    speed: 50,
    weapon: blade,
  },
  villager: {
    abilities: { cha: 10, dex: 10, str: 10 },
    level: 1,
    maxHp: 10,
    skills: { athletics: 10, melee: 0, persuasion: 0 },
    speed: 45,
    weapon: staff,
  },
  wanderer: {
    abilities: { cha: 10, dex: 13, str: 13 },
    level: 1,
    maxHp: 24,
    skills: { athletics: 15, melee: 12, persuasion: 5 },
    speed: 50,
    weapon: axe,
  },
};

export const RUIN_QUEST = "ruin";

export const QUESTS: readonly IQuestDef[] = [
  {
    entries: [
      "Oska, the camp elder, asked me to clear the raiders out of the ruin to the north.",
      "The ruin is quiet. I should tell Oska.",
      "Oska thanked me. The camp is safe, and the ruin is ours.",
    ],
    id: RUIN_QUEST,
    title: "Quiet the Ruin",
  },
];

/** The raiders the quest needs down. */
export const RUIN_RAIDERS = 3;
export const REWARD_COINS = 50;

const FAREWELL = { text: "Farewell." } as const;

export const TREES: Readonly<Record<string, ITree>> = {
  elder: {
    start: (world: IWorld) =>
      world.stage(RUIN_QUEST) === 0 ? "offer" : `stage${world.stage(RUIN_QUEST)}`,
    nodes: {
      offer: {
        speaker: "Oska",
        text: "Raiders took the old ruin to the north. They watch our road. Will you clear them out?",
        choices: [
          { text: "I will clear the ruin.", next: "thanks" },
          {
            check: { dc: 12, fail: "refused", label: "Persuasion", pass: "paid" },
            text: "Pay me first.",
            when: (w) => w.stage(RUIN_QUEST) === 0,
          },
          { ...FAREWELL },
        ],
      },
      thanks: {
        speaker: "Oska",
        text: "Good. Three raiders, I count. Fight them together and keep your healer close.",
        enter: [`quest:${RUIN_QUEST}:1`],
        choices: [{ ...FAREWELL }],
      },
      paid: {
        speaker: "Oska",
        text: "You drive a hard bargain. Fifty coins now, and the rest of my thanks when it is done.",
        enter: ["coins:50", `quest:${RUIN_QUEST}:1`],
        choices: [{ ...FAREWELL }],
      },
      refused: {
        speaker: "Oska",
        text: "I pay for work done, not for work promised.",
        choices: [{ text: "Then I will clear the ruin.", next: "thanks" }, { ...FAREWELL }],
      },
      stage1: {
        speaker: "Oska",
        text: "The raiders still hold the ruin. Follow the road north.",
        choices: [{ ...FAREWELL }],
      },
      stage2: {
        speaker: "Oska",
        text: "The ruin is quiet. Is it done?",
        choices: [{ text: "It is done.", next: "reward" }],
      },
      reward: {
        speaker: "Oska",
        text: "Then the road is ours again. Take this, with the thanks of the whole camp.",
        enter: [`coins:${REWARD_COINS}`, `quest:${RUIN_QUEST}:3`],
        choices: [{ ...FAREWELL }],
      },
      stage3: {
        speaker: "Oska",
        text: "The camp sleeps easy now. My thanks.",
        choices: [{ ...FAREWELL }],
      },
    },
  },
  hire: {
    start: () => "hello",
    nodes: {
      hello: {
        speaker: "Hireling",
        text: "I sell my arm by the week. Would you travel with a spare blade?",
        choices: [
          { next: "join", text: "Join us.", when: (w) => !w.partyFull },
          { next: "full", text: "Join us.", when: (w) => w.partyFull },
          { ...FAREWELL },
        ],
      },
      join: {
        speaker: "Hireling",
        text: "Done. Lead on.",
        enter: ["recruit"],
        choices: [{ ...FAREWELL }],
      },
      full: {
        speaker: "Hireling",
        text: "You already travel with three. Come back when there is room.",
        enter: ["refuse"],
        choices: [{ ...FAREWELL }],
      },
    },
  },
};
