// What the match needs from a minigame: four contestants, one rule, a winner. A minigame owns no
// meshes. It moves four plain points, and the scene dresses them in the four mannequins.

/** The centre of the arena, away from the board so the shadow map and the camera each see one stage. */
export const ARENA = { x: 0, z: -20 } as const;

export type Pose = "idle" | "run" | "jump" | "down" | "cheer";

export interface IContestant {
  x: number;
  z: number;
  /** Height above the floor, metres: a hop in the rope game. */
  y: number;
  yaw: number;
  pose: Pose;
}

/** The seat 0 contestant is the human. The other three are CPU. */
export interface IMiniInput {
  /** The confirm key went down this tick. */
  readonly jump: boolean;
  /** The move axis, +1 right. */
  readonly run: number;
}

export interface IMinigame {
  readonly id: "dash" | "rope";
  readonly title: string;
  /** One line the intro card shows. */
  readonly rule: string;
  readonly contestants: IContestant[];
  /** Seconds since the minigame started. */
  time: number;
  done: boolean;
  /** The seat that won, or -1 while the game runs. */
  winner: number;
  update(dt: number, input: IMiniInput): void;
}

/** Coins the winner takes. No card pins it: a design choice, sized to a few landings. */
export const MINIGAME_PRIZE = 10;
