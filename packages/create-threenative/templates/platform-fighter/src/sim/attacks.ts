import {
  CHARGE_BONUS,
  CHARGE_FRAMES,
  HITSTUN_DIVISOR,
  KB_BASE,
  KB_CAP,
  KB_DAMAGE_COEF,
  KB_HIT_COEF,
  KB_WEIGHT_FACTOR,
} from "./constants.js";

/** A hitbox in the attacker's space: x ahead of the feet (negative is behind), y up from the feet. */
interface IBox {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

export interface AttackDef {
  readonly id: "jab" | "strong" | "aerial";
  /** The clip this attack plays, from `assets/mannequin-combat.glb`. */
  readonly clip: string;
  /** Frames before the hitbox opens, how long it stays open, and the wind-down after. */
  readonly startup: number;
  readonly active: number;
  readonly recovery: number;
  readonly damage: number;
  /** Launch angle above the horizontal, degrees, away from the attacker. */
  readonly angle: number;
  /** Flat knockback added after scaling, and the growth percent of the scaled part. */
  readonly base: number;
  readonly growth: number;
  readonly box: IBox;
  /** Strong attacks wait on this frame while the button is held. */
  readonly chargeFrame?: number;
}

/**
 * Frame data is this kit's own, tuned to the clips. A jab opens on frame 5; a strong attack on
 * frame 14 with a charge hold at frame 6; an aerial lands with 8 frames of lag.
 */
export const JAB: AttackDef = {
  active: 3,
  angle: 40,
  base: 0,
  box: { x0: 0.3, x1: 1.5, y0: 0.6, y1: 1.6 },
  clip: "Punch_Jab",
  damage: 3,
  growth: 100,
  id: "jab",
  recovery: 11,
  startup: 5,
};

export const STRONG: AttackDef = {
  active: 4,
  angle: 42,
  base: 10,
  box: { x0: 0.3, x1: 2.1, y0: 0.3, y1: 1.8 },
  chargeFrame: 6,
  clip: "Sword_Attack",
  damage: 14,
  growth: 100,
  id: "strong",
  recovery: 26,
  startup: 14,
};

export const AERIAL: AttackDef = {
  active: 6,
  angle: 45,
  base: 0,
  box: { x0: -1, x1: 1, y0: 0.2, y1: 1.9 },
  clip: "Punch_Cross",
  damage: 8,
  growth: 100,
  id: "aerial",
  recovery: 14,
  startup: 6,
};

export const totalFrames = (def: AttackDef): number => def.startup + def.active + def.recovery;

/** A fully charged strong attack hits 40 percent harder. */
export const chargedDamage = (def: AttackDef, charge: number): number =>
  def.damage * (1 + CHARGE_BONUS * Math.min(1, charge / CHARGE_FRAMES));

/**
 * Knockback of one hit, in knockback units. `percent` is the defender's percent after the hit.
 * Card `knockback-formula`: the Brawl-lineage form
 * ((percent / 10 + percent * damage / 20) * 200 / (weight + 100) * 1.4 + 18) * growth / 100 + base,
 * with weight normalised so an average fighter (1) takes the factor 1.
 */
export function knockback(
  percentAfter: number,
  damage: number,
  weight: number,
  def: Pick<AttackDef, "base" | "growth">,
): number {
  const scaled = percentAfter * KB_DAMAGE_COEF + (percentAfter * damage * KB_HIT_COEF);
  const weighted = scaled * (2 / (weight + 1)) * KB_WEIGHT_FACTOR + KB_BASE;
  return Math.min(KB_CAP, (weighted * def.growth) / 100 + def.base);
}

/** Hitstun frames are knockback over 1.875, so a harder hit stuns longer. */
export const hitstunFrames = (kb: number): number => Math.round(kb / HITSTUN_DIVISOR);
