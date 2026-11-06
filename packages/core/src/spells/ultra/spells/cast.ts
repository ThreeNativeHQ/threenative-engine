// Ported from Ultra Elements src/spells/cast.js @698b720 (MIT, Copyright (c) 2026 Humpalumps). JavaScript copied verbatim; GLSL transliterated to TSL.
import { Vector3 } from "three";
import { ARENA, arenaSDFJS as arenaSDF } from "../vfx/common.js";

// Cast pool + phase clock (PLAN 2.4). One record per live cast; spells keep per-cast state in
// c.data (reused, so they reset it in phase 'charge'). Phases:
//   charge -> release (instant) -> travel (projectile flight / beam sustain) -> impact -> linger -> done
// shape decides travel: projectile integrates until it hits the arena or reaches the target,
// beam sustains while held (or timing.sustain), strike/area/self skip it. A spell may override
// shape per form with formShapes: { 'Form name': 'strike' }.
const MAX_CASTS = 16;
const _d = new Vector3();

export type Phase = "charge" | "release" | "travel" | "impact" | "linger" | "done";

// what a spell's create(fx) returns (upstream: `s.inst`)
export interface ISpellInstance {
  phase?(c: ICast, name: Phase): void;
  update?(c: ICast, dt: number): void;
  travel?(c: ICast, dt: number): boolean;
  onParam?(k: string): void;
}

// a spell module (upstream: one default export per src/spells/<element>.js)
export interface ISpell {
  id: string;
  name: string;
  shape?: string;
  forms?: string[];
  formShapes?: Record<string, string>;
  radius?: number;
  speed?: number;
  lob?: number;
  params?: Record<string, number | string>;
  timing?: { charge?: number; impact?: number; linger?: number; sustain?: number };
  inst?: ISpellInstance;
}

export interface ICast {
  index: number;
  alive: boolean;
  spell: ISpell | null;
  inst: ISpellInstance | null;
  form: string;
  shape: string;
  phase: Phase;
  t: number;
  age: number;
  seed: number;
  from: Vector3;
  to: Vector3;
  pos: Vector3;
  vel: Vector3;
  dir: Vector3;
  held: boolean;
  travelled: number;
  target: number;
  data: Record<string, unknown>;
  durations: { charge: number; travel: number; impact: number; linger: number };
}

function record(i: number): ICast {
  return {
    index: i,
    alive: false,
    spell: null,
    inst: null,
    form: "",
    shape: "projectile",
    phase: "done",
    t: 0,
    age: 0,
    seed: 0,
    from: new Vector3(),
    to: new Vector3(),
    pos: new Vector3(),
    vel: new Vector3(),
    dir: new Vector3(),
    held: false,
    travelled: 0,
    target: -1,
    data: {},
    durations: { charge: 0, travel: 0, impact: 0, linger: 0 },
  };
}

export class Casts {
  fx: { rand(): number };
  list: ICast[];
  last: ICast | null;

  constructor(fx: { rand(): number }) {
    this.fx = fx;
    this.list = Array.from({ length: MAX_CASTS }, (_, i) => record(i));
    this.last = null;
  }

  // spell: module from SPELLS (with .inst set at load). to: world point. target: dummy index or -1.
  cast(
    spell: ISpell,
    to: Vector3,
    {
      form = spell.forms?.[0] ?? "",
      from = ARENA.focus,
      target = -1,
      held = false,
      seed,
    }: { form?: string; from?: Vector3; target?: number; held?: boolean; seed?: number } = {},
  ): ICast {
    let c = this.list.find((x) => !x.alive);
    if (!c) {
      // pool full: recycle the oldest
      c = this.list.reduce((a, b) => (b.age > a.age ? b : a));
      this.enter(c, "done");
    }
    Object.assign(c, {
      alive: true,
      spell,
      inst: spell.inst,
      form,
      shape: spell.formShapes?.[form] ?? spell.shape ?? "projectile",
      t: 0,
      age: 0,
      held,
      travelled: 0,
      target,
    });
    c.seed = seed ?? Math.floor(this.fx.rand() * 1e6);
    c.from.copy(from);
    c.to.copy(to);
    c.pos.copy(from);
    c.dir.subVectors(to, from).normalize();
    c.vel.set(0, 0, 0);
    const T = spell.timing ?? {};
    c.durations.charge = T.charge ?? 0.5;
    c.durations.travel = T.sustain ?? 4;
    c.durations.impact = T.impact ?? 0.2;
    c.durations.linger = T.linger ?? 2;
    this.enter(c, "charge");
    this.last = c;
    return c;
  }

  enter(c: ICast, phase: Phase): void {
    c.phase = phase;
    c.t = 0;
    c.inst?.phase?.(c, phase);
    if (phase === "done") c.alive = false;
  }

  releaseHeld(): void {
    for (const c of this.list) c.held = false;
  }
  clear(): void {
    for (const c of this.list) if (c.alive) this.enter(c, "done");
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upstream Ultra Elements code, copied verbatim
  update(dt: number): void {
    for (const c of this.list) {
      if (!c.alive) continue;
      c.t += dt;
      c.age += dt;
      const s = c.spell as ISpell;
      const d = c.durations;
      const inst = c.inst as ISpellInstance;
      if (c.phase === "charge") {
        c.pos.copy(c.from);
        if (c.t >= d.charge) {
          this.enter(c, "release");
          const shape = c.shape;
          if (shape === "projectile") {
            c.vel
              .copy(c.dir)
              .multiplyScalar((s.params?.speed as number | undefined) ?? s.speed ?? 15);
            if (s.lob) c.vel.y += s.lob; // lobbed: initial upward speed, gravity below
            this.enter(c, "travel");
          } else if (shape === "beam") this.enter(c, "travel");
          else {
            if (shape !== "self") c.pos.copy(c.to);
            this.enter(c, "impact");
          }
        }
      } else if (c.phase === "travel") {
        if (c.shape === "projectile") {
          // the spell may steer (homing) by editing c.vel in its update; integrate here
          if (inst.travel) {
            if (inst.travel(c, dt)) {
              this.enter(c, "impact");
              continue;
            }
          } else {
            if (s.lob) c.vel.y -= 9.81 * dt;
            c.pos.addScaledVector(c.vel, dt);
            c.travelled += c.vel.length() * dt;
            const r = s.radius ?? 0.3;
            const hit =
              (c.travelled > 1 && arenaSDF(c.pos) < r) ||
              (!s.lob && _d.subVectors(c.to, c.pos).dot(c.dir) <= 0) ||
              c.t > d.travel;
            if (hit) {
              if (!s.lob && c.t <= d.travel && _d.subVectors(c.to, c.pos).dot(c.dir) <= 0)
                c.pos.copy(c.to);
              this.enter(c, "impact");
              continue;
            }
          }
        } else if (!c.held && c.t >= (s.timing?.sustain ?? 0)) {
          this.enter(c, "impact");
          continue;
        }
      } else if (c.phase === "impact") {
        if (c.t >= d.impact) this.enter(c, "linger");
      } else if (c.phase === "linger") {
        if (c.t >= d.linger) {
          this.enter(c, "done");
          continue;
        }
      }
      if (c.alive) inst.update?.(c, dt);
    }
  }

  // for the HUD phase strip: the newest live cast
  active(): ICast | null {
    return this.last?.alive ? this.last : null;
  }
  count(): number {
    let n = 0;
    for (const c of this.list) n += c.alive ? 1 : 0;
    return n;
  }
}
