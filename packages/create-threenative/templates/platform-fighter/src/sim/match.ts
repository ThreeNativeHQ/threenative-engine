import { BLAST, MAIN, PLATFORMS, SPAWN } from "../level.js";
import { type AttackDef, chargedDamage, hitstunFrames, knockback } from "./attacks.js";
import {
  CPU_WEIGHT,
  HALF_WIDTH,
  HEAVY_HITSTUN,
  HEIGHT,
  LAUNCH_PER_KB,
  RESPAWN_DELAY,
  RESPAWN_INVULN,
  SHIELD_MAX,
  SHIELD_PUSH_PER_STUN,
  SHIELD_RADIUS,
  hitlagFrames,
  shieldScale,
  shieldStunFrames,
} from "./constants.js";
import { breakShield, createFighter, stepFighter } from "./fighter.js";
import { releaseLedge } from "./ledge.js";
import { type IWorld, setMode } from "./motion.js";
import type { FighterId, IFighter, Pad, Side, SimEvent } from "./types.js";

/** The result of the latest hit, kept so the HUD and the playtests can read what the formula did. */
export interface ILastHit {
  victim: FighterId | "";
  damage: number;
  knockback: number;
  hitstun: number;
  /** Frames the victim really spent in hitstun, written when it recovers. */
  measuredHitstun: number;
  weight: number;
  percentAfter: number;
}

export interface IStats {
  hits: number;
  blocks: number;
  shieldBreaks: number;
  ledgeGrabs: number;
  getups: number;
  dodges: number;
  doubleJumps: number;
  fastFalls: number;
  kos: number;
}

const newStats = (): IStats => ({
  blocks: 0,
  doubleJumps: 0,
  dodges: 0,
  fastFalls: 0,
  getups: 0,
  hits: 0,
  kos: 0,
  ledgeGrabs: 0,
  shieldBreaks: 0,
});

const COUNTED: Readonly<Record<string, keyof IStats>> = {
  dodge: "dodges",
  "double-jump": "doubleJumps",
  "fast-fall": "fastFalls",
  getup: "getups",
  "ledge-grab": "ledgeGrabs",
  "shield-break": "shieldBreaks",
};

const OTHER: Readonly<Record<FighterId, FighterId>> = { cpu: "p1", p1: "cpu" };

/** True when two boxes overlap. */
const overlaps = (
  a: { x0: number; x1: number; y0: number; y1: number },
  b: { x0: number; x1: number; y0: number; y1: number },
): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

export function hurtbox(f: IFighter): { x0: number; x1: number; y0: number; y1: number } {
  return { x0: f.x - HALF_WIDTH, x1: f.x + HALF_WIDTH, y0: f.y, y1: f.y + HEIGHT };
}

export function hitbox(
  f: IFighter,
  def: AttackDef,
): { x0: number; x1: number; y0: number; y1: number } {
  const { box } = def;
  const x0 = f.facing === 1 ? f.x + box.x0 : f.x - box.x1;
  const x1 = f.facing === 1 ? f.x + box.x1 : f.x - box.x0;
  return { x0, x1, y0: f.y + box.y0, y1: f.y + box.y1 };
}

/** Shield bubble radius in metres: it shrinks with the shield's health. */
export const shieldRadius = (f: IFighter): number => SHIELD_RADIUS * shieldScale(f.shield);

function hitsShield(f: IFighter, box: { x0: number; x1: number; y0: number; y1: number }): boolean {
  const cx = Math.min(Math.max(f.x, box.x0), box.x1);
  const cy = Math.min(Math.max(f.y + HEIGHT / 2, box.y0), box.y1);
  return Math.hypot(cx - f.x, cy - (f.y + HEIGHT / 2)) <= shieldRadius(f);
}

/**
 * Two fighters, one stage, 60 Hz frames. `step` takes one pad per fighter and advances everything:
 * movement, hits, blast zones, respawns and the end of the match.
 */
export class Match {
  readonly fighters: Record<FighterId, IFighter> = {
    cpu: createFighter("cpu", SPAWN.cpu.x, SPAWN.cpu.y, CPU_WEIGHT),
    p1: createFighter("p1", SPAWN.p1.x, SPAWN.p1.y, 1),
  };
  readonly stats: Record<FighterId, IStats> = { cpu: newStats(), p1: newStats() };
  readonly last: ILastHit = {
    damage: 0,
    hitstun: 0,
    knockback: 0,
    measuredHitstun: 0,
    percentAfter: 0,
    victim: "",
    weight: 0,
  };
  /** Events of the latest step, for the playtest bridge. */
  readonly events: SimEvent[] = [];
  winner: FighterId | undefined;
  /** Frames since the match began (hitlag included), the clock the HUD shows. */
  frame = 0;
  readonly #world: IWorld = {
    emit: (event) => this.#emit(event),
    frame: 0,
    ledgeOwner: new Map<Side, FighterId>(),
  };
  /** Frames until each KO'd fighter returns. */
  readonly #respawn: Record<FighterId, number> = { cpu: 0, p1: 0 };

  #emit(event: SimEvent): void {
    this.events.push(event);
    const key = COUNTED[event.name];
    if (key !== undefined) this.stats[event.entity as FighterId][key] += 1;
  }

  step(pads: Record<FighterId, Pad>): void {
    this.events.length = 0;
    this.frame += 1;
    this.#world.frame = this.frame;
    const running = this.winner === undefined;
    for (const id of ["p1", "cpu"] as const) {
      const f = this.fighters[id];
      const wasHitstun = f.mode === "hitstun";
      const hitstunFramesBefore = f.timer + 1;
      if (f.mode === "dead") this.#waitToRespawn(f);
      else if (running) stepFighter(f, pads[id], this.#world);
      if (wasHitstun && f.mode !== "hitstun") this.last.measuredHitstun = hitstunFramesBefore;
    }
    if (!running) return;
    for (const id of ["p1", "cpu"] as const)
      this.#resolveHits(this.fighters[id], this.fighters[OTHER[id]]);
    for (const id of ["p1", "cpu"] as const) this.#checkBlastZone(this.fighters[id]);
  }

  #resolveHits(attacker: IFighter, victim: IFighter): void {
    const run = attacker.attack;
    if (attacker.mode !== "attack" || run === undefined || !run.live || run.hit.has(victim.id))
      return;
    if (victim.mode === "dead" || victim.invuln > 0) return;
    const box = hitbox(attacker, run.def);
    const shielded = victim.mode === "shield" && victim.shieldRelease === 0;
    if (shielded && hitsShield(victim, box)) {
      run.hit.add(victim.id);
      this.#block(attacker, victim, run.def, chargedDamage(run.def, run.charge));
    } else if (overlaps(box, hurtbox(victim))) {
      run.hit.add(victim.id);
      this.#hit(attacker, victim, run.def, chargedDamage(run.def, run.charge));
    }
  }

  /** Direction a victim is pushed: away from the attacker. */
  #away(attacker: IFighter, victim: IFighter): Side {
    return Math.abs(victim.x - attacker.x) > 0.15
      ? victim.x > attacker.x
        ? 1
        : -1
      : attacker.facing;
  }

  #hit(attacker: IFighter, victim: IFighter, def: AttackDef, damage: number): void {
    victim.percent += damage;
    const kb = knockback(victim.percent, damage, victim.weight, def);
    const stun = hitstunFrames(kb);
    const lag = hitlagFrames(damage);
    attacker.hitlag = lag;
    victim.hitlag = lag;
    if (victim.ledge !== 0) releaseLedge(victim, this.#world);
    victim.attack = undefined;
    victim.fastFalling = false;
    victim.facing = -this.#away(attacker, victim) as Side;
    victim.hitstun = stun;
    victim.hitstunTotal = stun;
    setMode(victim, "hitstun");
    const direction = this.#away(attacker, victim);
    const angle = (def.angle * Math.PI) / 180;
    const speed = kb * LAUNCH_PER_KB;
    victim.kx = Math.cos(angle) * speed * direction;
    victim.ky = Math.sin(angle) * speed;
    // A light hit on the ground slides; a heavy one lifts the fighter off the floor.
    if (victim.floor !== undefined && stun <= HEAVY_HITSTUN) {
      victim.vx = victim.kx;
      victim.kx = victim.ky = 0;
    } else if (victim.floor !== undefined) {
      victim.floor = undefined;
      victim.y += 0.02;
    }
    Object.assign(this.last, {
      damage,
      hitstun: stun,
      knockback: kb,
      percentAfter: victim.percent,
      victim: victim.id,
      weight: victim.weight,
    });
    this.stats[attacker.id].hits += 1;
    this.#emit({ attack: def.id, entity: attacker.id, name: "hit", victim: victim.id });
  }

  #block(attacker: IFighter, victim: IFighter, def: AttackDef, damage: number): void {
    const lag = hitlagFrames(damage);
    attacker.hitlag = lag;
    victim.hitlag = lag;
    victim.shield -= damage;
    const stun = shieldStunFrames(damage);
    victim.shieldStun = stun;
    victim.vx = this.#away(attacker, victim) * stun * SHIELD_PUSH_PER_STUN;
    this.stats[victim.id].blocks += 1;
    this.#emit({ attack: def.id, entity: victim.id, name: "block", from: attacker.id });
    if (victim.shield <= 0) breakShield(victim, this.#world);
  }

  #checkBlastZone(f: IFighter): void {
    if (f.mode === "dead") return;
    if (f.x >= BLAST.left && f.x <= BLAST.right && f.y >= BLAST.bottom && f.y <= BLAST.top) return;
    releaseLedge(f, this.#world);
    f.stocks -= 1;
    f.mode = "dead";
    f.timer = 0;
    f.attack = undefined;
    this.#respawn[f.id] = RESPAWN_DELAY;
    this.stats[f.id].kos += 1;
    this.#emit({ entity: f.id, name: "ko", stocks: f.stocks });
    if (f.stocks <= 0) this.winner = OTHER[f.id];
  }

  #waitToRespawn(f: IFighter): void {
    if (f.stocks <= 0) return;
    this.#respawn[f.id] -= 1;
    if (this.#respawn[f.id] > 0) return;
    Object.assign(f, createFighter(f.id, SPAWN[f.id].x, SPAWN.respawnHeight, f.weight), {
      invuln: RESPAWN_INVULN,
      floor: undefined,
      shield: SHIELD_MAX,
      stocks: f.stocks,
    });
    this.#emit({ entity: f.id, name: "respawn", stocks: f.stocks });
  }

  /** Test and restart helpers: put a fighter somewhere on the floor, at rest. */
  place(id: FighterId, x: number, y: number, facing: Side): void {
    const f = this.fighters[id];
    releaseLedge(f, this.#world);
    f.x = x;
    f.y = y;
    f.vx = f.vy = f.kx = f.ky = 0;
    f.facing = facing;
    f.attack = undefined;
    f.floor = [MAIN, ...PLATFORMS].find((floor) => floor.y === y && x >= floor.x0 && x <= floor.x1);
    f.jumps = 1;
    f.fastFalling = false;
    f.hitlag = 0;
    f.invuln = 0;
    setMode(f, "free");
  }
}
