import { MAIN } from "../level.js";
import { AERIAL, type AttackDef, JAB, STRONG, totalFrames } from "./attacks.js";
import {
  AIR_MAX_SPEED,
  CHARGE_FRAMES,
  DOUBLE_JUMP,
  DOWN_FLICK,
  FULL_HOP,
  GROUND_FRICTION,
  JUMP_SQUAT,
  ROLL_DISTANCE,
  ROLL_FRAMES,
  ROLL_INTANGIBLE_FRAMES,
  ROLL_INTANGIBLE_START,
  ROLL_MOVE_END,
  SHIELD_BREAK_HEALTH,
  SHIELD_BREAK_STUN,
  SHIELD_DECAY_EVERY,
  SHIELD_HEAL_EVERY,
  SHIELD_MAX,
  SHIELD_RELEASE,
  SHORT_HOP,
  SLIDE_FRICTION,
  STEP,
  STOCKS,
} from "./constants.js";
import { getupStep, ledgeStep, tryLedge } from "./ledge.js";
import {
  DEAD_ZONE,
  type IWorld,
  airMove,
  downFlick,
  edge,
  groundMove,
  setMode,
} from "./motion.js";
import type { FighterId, IFighter, Pad } from "./types.js";

export function createFighter(id: FighterId, x: number, y: number, weight = 1): IFighter {
  return {
    attack: undefined,
    dropThrough: 0,
    facing: id === "p1" ? 1 : -1,
    fastFalling: false,
    floor: MAIN,
    hitlag: 0,
    hitstun: 0,
    hitstunTotal: 0,
    id,
    invuln: 0,
    jumps: 1,
    kx: 0,
    ky: 0,
    ledge: 0,
    ledgeCooldown: 0,
    mode: "free",
    peakY: y,
    percent: 0,
    prev: { attack: false, dodge: false, jump: false, shield: false, strong: false, x: 0, y: 0 },
    shield: SHIELD_MAX,
    shieldRelease: 0,
    shieldStun: 0,
    shortHop: false,
    stocks: STOCKS,
    timer: 0,
    vx: 0,
    vy: 0,
    weight,
    x,
    y,
  };
}

export function breakShield(f: IFighter, world: IWorld): void {
  f.shield = SHIELD_BREAK_HEALTH;
  f.shieldStun = 0;
  f.floor = undefined;
  f.vy = 9;
  f.vx = 0;
  setMode(f, "stun");
  world.emit({ entity: f.id, name: "shield-break" });
}

export function startAttack(f: IFighter, def: AttackDef): void {
  f.attack = {
    charge: 0,
    def,
    frame: 0,
    hit: new Set<FighterId>(),
    live: false,
    phase: "startup",
    waiting: def.chargeFrame !== undefined,
  };
  setMode(f, "attack");
}

function startDodge(f: IFighter, pad: Pad, world: IWorld): void {
  if (Math.abs(pad.x) > DEAD_ZONE) f.facing = pad.x > 0 ? 1 : -1;
  setMode(f, "dodge");
  world.emit({ entity: f.id, name: "dodge" });
}

function freeGround(f: IFighter, pad: Pad, world: IWorld): void {
  if (Math.abs(pad.x) > DEAD_ZONE) f.facing = pad.x > 0 ? 1 : -1;
  if (edge(f, pad, "dodge")) return startDodge(f, pad, world);
  if (pad.shield) {
    f.shieldRelease = 0;
    f.shieldStun = 0;
    return setMode(f, "shield");
  }
  if (edge(f, pad, "strong")) return startAttack(f, STRONG);
  if (edge(f, pad, "attack")) return startAttack(f, JAB);
  if (edge(f, pad, "jump")) {
    f.shortHop = false;
    return setMode(f, "squat");
  }
  if (f.floor !== MAIN && pad.y <= DOWN_FLICK) {
    f.floor = undefined;
    f.dropThrough = 14;
    f.vy = -1;
    return;
  }
  groundMove(f, pad);
}

function freeAir(f: IFighter, pad: Pad, world: IWorld): void {
  if (Math.abs(pad.x) > 0.3) f.facing = pad.x > 0 ? 1 : -1;
  if (edge(f, pad, "jump") && f.jumps > 0) {
    f.jumps -= 1;
    f.vy = DOUBLE_JUMP;
    f.fastFalling = false;
    f.vx = Math.abs(pad.x) > 0.3 ? pad.x * AIR_MAX_SPEED : f.vx * 0.5;
    f.peakY = f.y;
    world.emit({ entity: f.id, name: "double-jump" });
  }
  if (edge(f, pad, "attack") || edge(f, pad, "strong")) {
    startAttack(f, AERIAL);
    return airMove(f, pad);
  }
  if (downFlick(f, pad) && f.vy < 0 && !f.fastFalling) {
    f.fastFalling = true;
    world.emit({ entity: f.id, name: "fast-fall" });
  }
  airMove(f, pad);
  if (f.floor === undefined) tryLedge(f, pad, world);
}

function attackStep(f: IFighter, pad: Pad, world: IWorld): void {
  const run = f.attack;
  if (run === undefined) return setMode(f, "free");
  const { def } = run;
  const index = run.frame;
  if (def.chargeFrame === index && run.waiting) {
    if (pad.strong && run.charge < CHARGE_FRAMES) {
      // Held on the charge frame: the swing waits and the damage grows.
      run.charge += 1;
      run.phase = "charge";
      run.live = false;
      groundMove(f, undefined);
      return;
    }
    run.waiting = false;
  }
  run.phase = index < def.startup ? "startup" : index < def.startup + def.active ? "active" : "recovery";
  run.live = run.phase === "active";
  if (index === def.startup) world.emit({ entity: f.id, name: "strike", attack: def.id });
  run.frame = index + 1;
  if (f.floor === undefined) airMove(f, def.id === "aerial" ? pad : undefined);
  else groundMove(f, undefined, GROUND_FRICTION);
  if (run.frame >= totalFrames(def)) {
    f.attack = undefined;
    setMode(f, "free");
  }
}

function squatStep(f: IFighter, pad: Pad, world: IWorld): void {
  if (!pad.jump) f.shortHop = true;
  groundMove(f, undefined);
  if (f.timer + 1 < JUMP_SQUAT) return;
  f.floor = undefined;
  f.y += 0.01;
  f.vy = f.shortHop ? SHORT_HOP : FULL_HOP;
  f.peakY = f.y;
  setMode(f, "free");
  world.emit({ entity: f.id, name: f.shortHop ? "short-hop" : "full-hop" });
}

function dodgeStep(f: IFighter): void {
  const index = f.timer;
  if (index === ROLL_INTANGIBLE_START) f.invuln = ROLL_INTANGIBLE_FRAMES;
  const moving = index >= ROLL_INTANGIBLE_START && index < ROLL_MOVE_END;
  f.vx = moving ? (f.facing * ROLL_DISTANCE) / ((ROLL_MOVE_END - ROLL_INTANGIBLE_START) * STEP) : 0;
  const floor = f.floor;
  f.x += f.vx * STEP;
  if (floor !== undefined && (f.x < floor.x0 || f.x > floor.x1)) {
    f.floor = undefined;
    f.vx = 0;
    setMode(f, "free");
  } else if (index + 1 >= ROLL_FRAMES) setMode(f, "free");
}

function shieldStep(f: IFighter, pad: Pad, world: IWorld): void {
  if (edge(f, pad, "dodge")) return startDodge(f, pad, world);
  if (edge(f, pad, "jump")) {
    f.shortHop = false;
    return setMode(f, "squat");
  }
  if (f.shieldRelease > 0) {
    f.shieldRelease -= 1;
    groundMove(f, undefined);
    if (f.shieldRelease === 0) setMode(f, "free");
    return;
  }
  if (f.shieldStun > 0) f.shieldStun -= 1;
  else if (!pad.shield) f.shieldRelease = SHIELD_RELEASE;
  if (world.frame % SHIELD_DECAY_EVERY === 0) f.shield -= 1;
  if (f.shield <= 0) return breakShield(f, world);
  groundMove(f, undefined);
}

function hitstunStep(f: IFighter): void {
  f.hitstun -= 1;
  if (f.floor !== undefined) groundMove(f, undefined, SLIDE_FRICTION);
  else airMove(f, undefined);
  if (f.hitstun <= 0) {
    f.vx += f.kx;
    f.vy += f.ky;
    f.kx = f.ky = 0;
    setMode(f, "free");
  }
}

function stunStep(f: IFighter): void {
  if (f.floor !== undefined) groundMove(f, undefined);
  else airMove(f, undefined);
  if (f.timer + 1 >= SHIELD_BREAK_STUN) setMode(f, "free");
}

/** Advances one fighter by one frame of the pad. Hitlag freezes it entirely. */
export function stepFighter(f: IFighter, pad: Pad, world: IWorld): void {
  if (f.mode === "dead") return;
  if (f.hitlag > 0) {
    f.hitlag -= 1;
    f.prev = { ...pad };
    return;
  }
  if (f.invuln > 0) f.invuln -= 1;
  if (f.ledgeCooldown > 0) f.ledgeCooldown -= 1;
  if (f.dropThrough > 0) f.dropThrough -= 1;
  if (f.mode !== "shield" && f.shield < SHIELD_MAX && world.frame % SHIELD_HEAL_EVERY === 0)
    f.shield += 1;
  const before = f.mode;
  switch (f.mode) {
    case "free":
      if (f.floor === undefined) freeAir(f, pad, world);
      else freeGround(f, pad, world);
      break;
    case "squat":
      squatStep(f, pad, world);
      break;
    case "attack":
      attackStep(f, pad, world);
      break;
    case "dodge":
      dodgeStep(f);
      break;
    case "shield":
      shieldStep(f, pad, world);
      break;
    case "hitstun":
      hitstunStep(f);
      break;
    case "stun":
      stunStep(f);
      break;
    case "ledge":
      ledgeStep(f, pad, world);
      break;
    case "getup":
      getupStep(f);
      break;
  }
  if (f.mode === before) f.timer += 1;
  else f.timer = 0;
  f.prev = { ...pad };
}
