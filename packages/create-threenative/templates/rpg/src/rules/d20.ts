// The d20 rules. Pure functions: no scene, no physics, so one table of numbers owns the maths.
// Reference: star-wars-knights-of-the-old-republic-reone (reone), cards `attack-roll`,
// `defense-from-abilities` and `damage-dice`. Borrowed: algorithms and default constants only.

/** One die: a whole number from 1 to `sides`. The game hands in a seeded or a rigged source. */
export type Die = (sides: number) => number;

/** An ability score nobody assigned. Card `defense-from-abilities`, attributes.cpp:26. */
export const DEFAULT_ABILITY = 8;
/** Defense is ten plus the Dexterity modifier. attributes.cpp:30. */
export const BASE_DEFENSE = 10;
/** A placeable (door, post, crate) has no Dexterity: flat defense. Card `attack-roll`, combat.cpp:235. */
export const OBJECT_DEFENSE = 10;
/** Die faces of the attack roll. combat.cpp:239. */
export const ATTACK_DIE = 20;
/** A rolled total never drops under one, so a hit always registers. combat.cpp:397. */
export const MINIMUM_DAMAGE = 1;
/** Critical multiplier when the weapon names none. combat.cpp:336. */
export const DEFAULT_CRITICAL_MULTIPLIER = 2;

export interface IAbilities {
  readonly str: number;
  readonly dex: number;
  readonly cha: number;
}

export interface IWeapon {
  readonly name: string;
  /** Dice rolled per hit. 0 means a flat one point, like an unarmed strike. */
  readonly dice: number;
  readonly sides: number;
  /** A roll above `20 - threat` is a critical threat: 2 means 19 and 20. */
  readonly threat: number;
  readonly multiplier: number;
}

/** Unarmed: flat 1 damage (creature.cpp:650) and a threat of 1, so only a 20 threatens (combat.cpp:253). */
export const UNARMED: IWeapon = {
  dice: 0,
  multiplier: DEFAULT_CRITICAL_MULTIPLIER,
  name: "fists",
  sides: 0,
  threat: 1,
};

/** Half the distance from 10, cut toward zero: 8 gives -1, 9 gives 0. attributes.cpp:40. */
export function abilityModifier(score: number = DEFAULT_ABILITY): number {
  return Math.trunc((score - 10) / 2) + 0;
}

export function defenseOf(abilities: IAbilities): number {
  return BASE_DEFENSE + abilityModifier(abilities.dex);
}

export type Outcome = "miss" | "hit" | "critical";

export interface IAttackResult {
  readonly roll: number;
  readonly bonus: number;
  readonly defense: number;
  readonly outcome: Outcome;
  /** "hit" for a natural 20 and "miss" for a natural 1; undefined when roll plus bonus decided it. */
  readonly automatic: "hit" | "miss" | undefined;
  /** The roll fell inside the weapon's threat window. */
  readonly threat: boolean;
  /** The confirming roll, 0 when none was needed. */
  readonly confirm: number;
  readonly damage: number;
}

/**
 * One attack. Order of dice, which a rigged source depends on: the attack die, then the confirming
 * die when the hit threatens, then each damage die.
 */
export function resolveAttack(
  die: Die,
  attackBonus: number,
  defense: number,
  weapon: IWeapon,
  damageModifier: number,
): IAttackResult {
  const roll = die(ATTACK_DIE);
  const automatic: "hit" | "miss" | undefined =
    roll === ATTACK_DIE ? "hit" : roll === 1 ? "miss" : undefined;
  const hits = automatic === "hit" || (automatic === undefined && roll + attackBonus >= defense);
  const base = { automatic, bonus: attackBonus, defense, roll };
  if (!hits) return { ...base, confirm: 0, damage: 0, outcome: "miss", threat: false };
  const threat = roll > ATTACK_DIE - weapon.threat;
  // The confirming roll is a second die plus the same bonus against the same defense.
  const confirm = threat ? die(ATTACK_DIE) : 0;
  const critical = threat && confirm + attackBonus >= defense;
  let total = damageModifier;
  for (let index = 0; index < weapon.dice; index += 1) total += die(weapon.sides);
  if (weapon.dice === 0) total += MINIMUM_DAMAGE;
  total = Math.max(MINIMUM_DAMAGE, total);
  return {
    ...base,
    confirm,
    damage: critical ? total * weapon.multiplier : total,
    outcome: critical ? "critical" : "hit",
    threat,
  };
}
