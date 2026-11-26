import { MAIN } from "../level.js";
import type { IFighter, Pad } from "./types.js";
import { neutralPad } from "./types.js";

/** What the CPU remembers between frames. */
export interface ICpuMemory {
  /** Frames until it may start another action. */
  cooldown: number;
  /** Frames it still holds its shield up. */
  shieldFor: number;
  /** Swings it has seen. It shields three of every five, so a test can count on the first. */
  reads: number;
  /** Frames it still holds the strong attack button, charging. */
  chargeFor: number;
  /** The match frame at which it starts to play. Before that it stands still. */
  wakeAt: number;
  /** True for a punching bag: it never acts. The playtests use it. */
  dummy: boolean;
}

export const newCpuMemory = (wakeAt: number): ICpuMemory => ({
  chargeFor: 0,
  cooldown: 0,
  dummy: false,
  reads: 0,
  shieldFor: 0,
  wakeAt,
});

/** Close enough to swing a jab, and how far it will chase before it runs in. */
const STRIKE_RANGE = 1.7;
/** Shields when the foe's swing is this close. */
const GUARD_RANGE = 2.6;
/** Stays this far from the edge while chasing, so it never runs off the stage by itself. */
const EDGE_MARGIN = 0.6;
/** Feet this far under the stage top means the double jump is the last way back. */
const LAST_JUMP_DEPTH = -1.2;

const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

/** One frame of a CPU opponent: approach, strike, shield, and get back to the stage. */
export function cpuPad(
  me: IFighter,
  foe: IFighter,
  memory: ICpuMemory,
  random: () => number,
  frame: number,
): Pad {
  const pad = neutralPad();
  if (memory.dummy || frame < memory.wakeAt || me.mode === "dead") return pad;
  if (memory.cooldown > 0) memory.cooldown -= 1;
  const press = (key: "attack" | "jump"): void => {
    pad[key] = !me.prev[key];
  };

  if (me.mode === "ledge") {
    // Hang a moment, then climb.
    pad.x = me.timer > 24 ? -me.ledge : 0;
    return pad;
  }
  const offStage = me.floor === undefined && (Math.abs(me.x) > MAIN.x1 - 0.2 || me.y < -0.5);
  if (offStage) {
    pad.x = -sign(me.x);
    if (me.jumps > 0 && me.vy < 0 && me.y < LAST_JUMP_DEPTH) press("jump");
    return pad;
  }
  if (me.mode !== "free" && me.mode !== "shield") return pad;
  if (foe.mode === "dead") return pad;

  const dx = foe.x - me.x;
  const dy = foe.y - me.y;
  const near = Math.abs(dx);

  if (memory.shieldFor > 0) {
    memory.shieldFor -= 1;
    pad.shield = true;
    if (memory.shieldFor === 0) memory.cooldown = 30;
    return pad;
  }
  if (memory.chargeFor > 0) {
    memory.chargeFor -= 1;
    pad.strong = true;
    if (memory.chargeFor === 0) memory.cooldown = 40;
    return pad;
  }
  const foeSwings =
    foe.mode === "attack" && foe.attack !== undefined && foe.attack.phase !== "recovery";
  if (foeSwings && near < GUARD_RANGE && me.floor !== undefined && memory.cooldown === 0) {
    memory.reads += 1;
    if ((memory.reads - 1) % 5 < 3) memory.shieldFor = 18 + Math.floor(random() * 20);
    else memory.cooldown = 20;
    return pad;
  }
  if (near > STRIKE_RANGE) {
    const goesOffEdge =
      Math.abs(me.x + sign(dx) * 0.4) > MAIN.x1 - EDGE_MARGIN && sign(dx) === sign(me.x);
    // Chase on the floor; wait at the edge when the foe is hanging off it.
    pad.x = goesOffEdge && me.floor !== undefined ? 0 : sign(dx);
    if (dy > 2 && near < 3) press("jump");
    return pad;
  }
  pad.x = sign(dx) * 0.2;
  if (memory.cooldown === 0 && Math.abs(dy) < 1.6) {
    if (random() < 0.6) {
      press("attack");
      memory.cooldown = 28;
    } else {
      pad.strong = true;
      memory.chargeFor = 4 + Math.floor(random() * 30);
    }
  }
  return pad;
}
