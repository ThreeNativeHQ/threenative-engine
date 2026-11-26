import type { AttackDef } from "./attacks.js";

export type FighterId = "p1" | "cpu";
export type Side = -1 | 1;

/** What a fighter is doing. `free` is standing, running or falling with full control. */
export type Mode =
  | "free"
  | "squat"
  | "attack"
  | "hitstun"
  | "shield"
  | "dodge"
  | "ledge"
  | "getup"
  | "stun"
  | "dead";

export type Phase = "charge" | "startup" | "active" | "recovery";

/** One frame of intent from a keyboard or the CPU. The stick is -1..1 and `y` is positive up. */
export interface Pad {
  x: number;
  y: number;
  jump: boolean;
  attack: boolean;
  strong: boolean;
  shield: boolean;
  dodge: boolean;
}

export const neutralPad = (): Pad => ({
  attack: false,
  dodge: false,
  jump: false,
  shield: false,
  strong: false,
  x: 0,
  y: 0,
});

export interface IAttackRun {
  readonly def: AttackDef;
  frame: number;
  /** Frames the strong attack has been held; scales its damage. */
  charge: number;
  /** True until the charge frame passes: the swing may still wait there while the button is down. */
  waiting: boolean;
  /** What the frame just stepped was, and whether its hitbox is open. */
  phase: Phase;
  live: boolean;
  /** Fighters this swing already hit: one swing hits a fighter once. */
  readonly hit: Set<FighterId>;
}

export interface IFighter {
  readonly id: FighterId;
  /** 1 is average. Heavier fighters fly less far. */
  weight: number;
  /** Feet position, metres. */
  x: number;
  y: number;
  /** Own velocity and knockback velocity, metres per second. Knockback decays on its own. */
  vx: number;
  vy: number;
  kx: number;
  ky: number;
  facing: Side;
  /** The surface under the feet, or undefined in the air. */
  floor: { readonly x0: number; readonly x1: number; readonly y: number } | undefined;
  mode: Mode;
  /** Frames spent in the current mode. */
  timer: number;
  percent: number;
  stocks: number;
  /** Air jumps left. Landing and a ledge grab refill it. */
  jumps: number;
  fastFalling: boolean;
  /** Frames of intangibility left: a roll, a get-up, a fresh respawn. */
  invuln: number;
  hitlag: number;
  hitstun: number;
  hitstunTotal: number;
  /** Shield health, 0..SHIELD_MAX. */
  shield: number;
  /** Frames of shieldstun left after a block, and frames since the shield button went up. */
  shieldStun: number;
  shieldRelease: number;
  attack: IAttackRun | undefined;
  /** Which ledge is held: -1 left, 1 right, 0 none. */
  ledge: -1 | 0 | 1;
  ledgeCooldown: number;
  /** Frames left in which platforms are ignored after a drop. */
  dropThrough: number;
  /** The jump button went up during the knee bend. */
  shortHop: boolean;
  /** Highest feet height since the fighter left the floor, for the playtests. */
  peakY: number;
  prev: Pad;
}

export type SimEvent = {
  readonly [key: string]: string | number;
  readonly entity: string;
  readonly name: string;
};
