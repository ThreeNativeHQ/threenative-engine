// Skills that rise with use. Reference: the Morrowind card `skill-use-gain-and-levelup` (OpenMW).
// A use adds credit to a progress meter. Credit is divided by the requirement `(level + 1) * role
// factor`, times 0.8 when the skill belongs to the class specialization. At 1 the skill rises by 1
// and the meter resets. Uses: one per successful hit for a weapon skill, one per full second of
// running for Athletics, one per speech attempt (the blank record default of 1.0).
// Not carried over: attributes, level progress and the level-up screen.
// Run speed follows card `walk-run-speed` (npc.cpp:1378 and :1392).

export type SkillId = "melee" | "athletics" | "persuasion";

export interface ISkill {
  level: number;
  /** The progress meter, 0 to 1. */
  progress: number;
}

export type Skills = Record<SkillId, ISkill>;

export const SKILL_LABEL: Readonly<Record<SkillId, string>> = {
  athletics: "Athletics",
  melee: "Melee",
  persuasion: "Persuasion",
};

/** Credit one use is worth: the blank skill record default. loadskil.cpp:130. */
export const USE_CREDIT = 1;
/** Requirement factors: major 0.75, minor 1.0 (defaultgmsts.cpp:1762, :1772). Specialization 0.8 (:1811). */
const ROLE_FACTOR: Readonly<Record<SkillId, number>> = {
  athletics: 0.75,
  melee: 0.75,
  persuasion: 1,
};
const SPECIALIZED: Readonly<Record<SkillId, boolean>> = {
  athletics: true,
  melee: true,
  persuasion: false,
};
const SPECIALIZATION_FACTOR = 0.8;
/** A skill at 100 ignores positive gain. playerskillhandlers.lua:72. */
export const SKILL_CAP = 100;

/** Uses needed for the next level. */
export function usesToRise(id: SkillId, level: number): number {
  return (level + 1) * ROLE_FACTOR[id] * (SPECIALIZED[id] ? SPECIALIZATION_FACTOR : 1);
}

export function newSkills(start: Readonly<Record<SkillId, number>>): Skills {
  return {
    athletics: { level: start.athletics, progress: 0 },
    melee: { level: start.melee, progress: 0 },
    persuasion: { level: start.persuasion, progress: 0 },
  };
}

/** Credit uses. Returns true when the skill rose a level. */
export function useSkill(skills: Skills, id: SkillId, uses = USE_CREDIT): boolean {
  const skill = skills[id];
  if (skill.level >= SKILL_CAP) return false;
  skill.progress += uses / usesToRise(id, skill.level);
  // The small slack absorbs float error: six sixths must make one.
  if (skill.progress < 1 - 1e-9) return false;
  skill.progress = 0;
  skill.level += 1;
  return true;
}

/** Attack bonus from Melee: one per ten skill points. The kit's rule. */
export function meleeBonus(skills: Skills): number {
  return Math.floor(skills.melee.level / 10);
}

/** Persuasion bonus on a skill check: one per ten skill points. The kit's rule. */
export function persuasionBonus(skills: Skills): number {
  return Math.floor(skills.persuasion.level / 10);
}

/** Walk speed at the Speed attribute's percentage between two endpoints, metres per second. npc.cpp:1378. */
export const WALK_LOW = 1.6;
export const WALK_HIGH = 3;
/** Run multiplier before the skill, and the weight of each Athletics point (0.01, npc.cpp:1392). */
export const RUN_BASE = 1.75;
export const ATHLETICS_BONUS = 4;

export function walkSpeed(speed: number): number {
  return WALK_LOW + 0.01 * speed * (WALK_HIGH - WALK_LOW);
}

export function runSpeed(speed: number, athletics: number): number {
  return walkSpeed(speed) * (RUN_BASE + 0.01 * athletics * ATHLETICS_BONUS);
}
