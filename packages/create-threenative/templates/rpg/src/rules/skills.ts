// Skills that rise with use. Reference for what a skill is worth: openmw card `walk-run-speed`
// (npc.cpp:1378 and :1392): speed follows a percentage of the Speed attribute, and the run
// multiplier grows by one percent of the Athletics skill. The rule that a skill rises when it is
// used has no card yet: the kit's own table below, kept in one place.

export type SkillId = "melee" | "athletics" | "persuasion";

export interface ISkill {
  level: number;
  /** Use points collected toward the next level. */
  progress: number;
}

export type Skills = Record<SkillId, ISkill>;

export const SKILL_LABEL: Readonly<Record<SkillId, string>> = {
  athletics: "Athletics",
  melee: "Melee",
  persuasion: "Persuasion",
};

/** Use points a skill earns. Melee: a swing counts 1 and a hit 1 more. Athletics: per metre run. */
export const SKILL_GAIN = { athleticsPerMetre: 0.5, meleeHit: 1, meleeSwing: 1, persuadeFail: 1, persuadeWin: 2 } as const;

/** Points needed for the next level: slower as the skill climbs. */
export function pointsToRise(level: number): number {
  return 3 + Math.floor(level / 5);
}

export const SKILL_CAP = 100;

export function newSkills(start: Readonly<Record<SkillId, number>>): Skills {
  return {
    athletics: { level: start.athletics, progress: 0 },
    melee: { level: start.melee, progress: 0 },
    persuasion: { level: start.persuasion, progress: 0 },
  };
}

/** Add use points. Returns true when the skill rose a level. */
export function useSkill(skills: Skills, id: SkillId, points: number): boolean {
  const skill = skills[id];
  if (skill.level >= SKILL_CAP) return false;
  skill.progress += points;
  if (skill.progress < pointsToRise(skill.level)) return false;
  skill.progress -= pointsToRise(skill.level);
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
