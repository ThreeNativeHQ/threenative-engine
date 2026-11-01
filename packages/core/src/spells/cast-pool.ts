/**
 * A spell is not an effect: it is a timeline. Charge, release, travel, impact and linger drive
 * several systems in turn, and the sequence is the same every cast, so the engine owns the clock
 * and the spell only answers "what does this phase look like".
 *
 * This is the upstream Ultra Elements `cast.js` phase machine, with the arena removed: a cast
 * never asks where the floor is. It integrates a projectile ballistically, hands the spell every
 * frame to steer, and retires each record back into a fixed pool. Nothing is allocated per cast,
 * so a game that casts on every frame at 60 Hz allocates nothing at all.
 */

import { Vector3 } from "three";

/** The beats of a spell, in order. `release` is instantaneous and never observed by a game. */
export type CastPhase = "charge" | "travel" | "impact" | "linger" | "done";

/**
 * How a spell reaches its target.
 * - `projectile` integrates a velocity through `travel`, and lands on the target or on `groundAt`.
 * - `beam` holds at the target while `held`, then lands.
 * - `strike`, `area` and `self` skip travel and land on `release`.
 */
export type CastShape = "projectile" | "beam" | "strike" | "area" | "self";

const PHASES: readonly CastPhase[] = ["charge", "travel", "impact", "linger", "done"];

export interface ICastTiming {
  /** Seconds of wind-up. Defaults to 0.5. */
  readonly charge?: number;
  /** Longest seconds of travel before the spell lands anyway. Defaults to 4. */
  readonly travel?: number;
  /** Seconds the impact reads on screen. Defaults to 0.2. */
  readonly impact?: number;
  /** Seconds the aftermath stays. Defaults to 2. */
  readonly linger?: number;
}

/** One cast's worth of reusable state. The spell owns what goes in `data`. */
export interface ICast {
  /** Pool slot, stable for the pool's lifetime: a spell may key per-slot state by it. */
  readonly index: number;
  spell: ISpell;
  shape: CastShape;
  phase: CastPhase;
  /** Seconds inside the current phase, reset on every `enter`. */
  t: number;
  /** Seconds since the cast started. The pool recycles the largest `age` when it is full. */
  age: number;
  seed: number;
  /** Where the spell was released from. */
  readonly from: Vector3;
  /** The target the game asked for. */
  readonly to: Vector3;
  /** Current world position: `from` while charging, integrated through travel. */
  readonly pos: Vector3;
  readonly vel: Vector3;
  /** Unit vector `from` -> `to`. */
  readonly dir: Vector3;
  /** A held beam stays in `travel` until the game releases it. */
  held: boolean;
  /** Metres travelled. A spell may read it, the pool only accumulates it. */
  travelled: number;
  readonly durations: {
    charge: number;
    impact: number;
    linger: number;
    travel: number;
  };
  /** Spell-owned per-slot scratch, preallocated with the record and reset by the spell at charge. */
  readonly data: Record<string, unknown>;
}

/**
 * A spell as the pool sees it. Every factory on `@threenative/core/spells` returns one of these:
 * it is the only shape the pool drives, and the spell reads the world through `SpellWorld`.
 */
export interface ISpell {
  /** The factory name without its `create` prefix, lowercase: `fireball`. */
  readonly name: string;
  /** How the spell reaches its target. Defaults to `projectile`. */
  readonly shape?: CastShape;
  /** Per-spell beat lengths. Missing beats take the pool defaults. */
  readonly timing?: ICastTiming;
  /** Metres per second for a projectile. Defaults to 15. */
  readonly speed?: number;
  /** Metres of collision radius at impact. Defaults to 0.3. */
  readonly radius?: number;
  /** Called on each beat change, including `done`. */
  readonly phase?: (cast: ICast, phase: CastPhase) => void;
  /**
   * Called once per frame while the cast is alive. Returns true when the spell wants to land now,
   * which lets a homing spell or a beam decide the moment instead of the pool.
   */
  readonly update?: (cast: ICast, dt: number) => boolean | undefined;
}

export interface ICastOptions {
  /** World point to travel from. Defaults to the world's `focus`. */
  readonly from?: Vector3;
  /** Hold a beam open past its sustain time. Defaults to false. */
  readonly held?: boolean;
  /** Override the generated seed, so a replay reproduces the same scatter. */
  readonly seed?: number;
  /** Override `spell.shape`, for a spell that carries several forms. */
  readonly shape?: CastShape;
}

/** What a pool needs from the world: the floor, and how many records to keep. */
export interface ICastEnvironment {
  /** Floor height under a point, so a projectile lands on a hill and not at y = 0. */
  readonly groundAt?: (x: number, z: number) => number;
  /** Records in the pool. Defaults to 16. */
  readonly castSlots?: number;
}

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
};

/** Deterministic 32-bit hash, so a seed alone reproduces a scatter without touching `Math.random`. */
const mixSeed = (seed: number, salt: number): number => {
  let x = (seed ^ (salt * 0x9e3779b1)) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x21f0aaad);
  x = Math.imul(x ^ (x >>> 15), 0x735a2d97);
  return (x ^ (x >>> 15)) >>> 0;
};

/** The spell a retired record reports, so `spell` is never undefined and never a cast. */
const IDLE_SPELL: ISpell = { name: "idle", shape: "self" };

function emptyRecord(index: number): ICast {
  return {
    age: 0,
    data: {},
    dir: new Vector3(),
    durations: { charge: 0.5, impact: 0.2, linger: 2, travel: 4 },
    from: new Vector3(),
    held: false,
    index,
    phase: "done",
    pos: new Vector3(),
    seed: 0,
    shape: "projectile",
    spell: IDLE_SPELL,
    t: 0,
    to: new Vector3(),
    travelled: 0,
    vel: new Vector3(),
  };
}

const scratch = new Vector3();

/**
 * Drive spell timelines from a fixed pool of records.
 *
 * The pool is full at capacity and never grows: a full pool recycles the record that has been alive
 * longest, which is the cast the player has already stopped watching. Every record keeps its
 * identity across casts, so a spell's per-slot state and any pooled mesh it binds stay warm.
 */
export class CastPool {
  /** Every slot, alive or not. Read `phase !== "done"` for the live ones. */
  readonly casts: readonly ICast[];
  readonly #groundAt: ((x: number, z: number) => number) | undefined;
  /** The newest live cast, or undefined. */
  #last: ICast | undefined;
  #seed = 0;

  constructor(world: ICastEnvironment = {}) {
    const capacity = world.castSlots ?? 16;
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 256)
      throw new RangeError("CastPool capacity must be an integer in 1..256");
    this.#groundAt = world.groundAt;
    this.casts = Array.from({ length: capacity }, (_, index) => emptyRecord(index));
  }

  /** The newest live cast. What a HUD reads for the phase strip. */
  get active(): ICast | undefined {
    return this.#last?.phase === "done" ? undefined : this.#last;
  }

  get count(): number {
    let live = 0;
    for (const cast of this.casts) live += cast.phase === "done" ? 0 : 1;
    return live;
  }

  /** Start a spell. Returns the record, which the caller may read but the pool advances. */
  cast(spell: ISpell, to: Vector3, options: ICastOptions = {}): ICast {
    finite(to.x, "to.x");
    finite(to.y, "to.y");
    finite(to.z, "to.z");
    let record = this.casts.find((candidate) => candidate.phase === "done");
    if (record === undefined) {
      record = this.casts.reduce((oldest, candidate) =>
        candidate.age > oldest.age ? candidate : oldest,
      );
      this.#enter(record, "done");
    }
    const from = options.from ?? record.from;
    const durations = record.durations;
    const timing = spell.timing ?? {};
    durations.charge = finite(timing.charge ?? 0.5, "timing.charge");
    durations.travel = finite(timing.travel ?? 4, "timing.travel");
    durations.impact = finite(timing.impact ?? 0.2, "timing.impact");
    durations.linger = finite(timing.linger ?? 2, "timing.linger");
    record.spell = spell;
    record.shape = options.shape ?? spell.shape ?? "projectile";
    record.held = options.held ?? false;
    record.t = 0;
    record.age = 0;
    record.travelled = 0;
    record.seed = options.seed ?? mixSeed(++this.#seed, 0x51ed);
    record.from.copy(from);
    record.to.copy(to);
    record.pos.copy(from);
    record.dir.subVectors(to, from);
    if (record.dir.lengthSq() > 0) record.dir.normalize();
    else record.dir.set(0, 0, 1);
    record.vel.set(0, 0, 0);
    this.#enter(record, "charge");
    this.#last = record;
    return record;
  }

  /** End every held beam. A game calls this when the button comes up. */
  releaseHeld(): void {
    for (const cast of this.casts) cast.held = false;
  }

  /** Retire every live cast without running linger. */
  clear(): void {
    for (const cast of this.casts) if (cast.phase !== "done") this.#enter(cast, "done");
  }

  /**
   * Advance every live cast. A projectile lands on the target, on the world's floor, or when its
   * travel time runs out, whichever comes first.
   */
  update(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0)
      throw new RangeError("CastPool.update delta must be finite and non-negative");
    for (const cast of this.casts) {
      if (cast.phase === "done") continue;
      cast.t += dt;
      cast.age += dt;
      if (!this.#advanceBeat(cast, dt)) continue;
      if (cast.spell.update?.(cast, dt) === true) this.#enter(cast, "impact");
    }
  }

  /** Advance one record's beat. False when the cast retired, so no spell update runs on it. */
  #advanceBeat(cast: ICast, dt: number): boolean {
    if (cast.phase === "charge") this.#advanceCharge(cast);
    else if (cast.phase === "travel") this.#advanceTravel(cast, dt);
    else if (cast.phase === "impact") {
      if (cast.t >= cast.durations.impact) this.#enter(cast, "linger");
    } else if (cast.t >= cast.durations.linger) {
      this.#enter(cast, "done");
      return false;
    }
    return cast.phase !== "done";
  }

  #advanceCharge(cast: ICast): void {
    cast.pos.copy(cast.from);
    if (cast.t < cast.durations.charge) return;
    const spell = cast.spell;
    if (cast.shape === "projectile") {
      cast.vel.copy(cast.dir).multiplyScalar(finite(spell.speed ?? 15, `${spell.name}.speed`));
      this.#enter(cast, "travel");
    } else if (cast.shape === "beam") this.#enter(cast, "travel");
    else {
      if (cast.shape !== "self") cast.pos.copy(cast.to);
      this.#enter(cast, "impact");
    }
  }

  #advanceTravel(cast: ICast, dt: number): void {
    const spell = cast.spell;
    if (cast.shape !== "projectile") {
      if (!cast.held && cast.t >= cast.durations.travel) this.#enter(cast, "impact");
      return;
    }
    // A spell that defines `update` owns its own integration (a homing ball, a lobbed arc), and the
    // pool only notices when it says it landed. That has to be decided before the default step so
    // a spell is never integrated twice in one frame.
    if (spell.update !== undefined) return;
    cast.pos.addScaledVector(cast.vel, dt);
    cast.travelled += cast.vel.length() * dt;
    const radius = finite(spell.radius ?? 0.3, `${spell.name}.radius`);
    const past = scratch.subVectors(cast.to, cast.pos).dot(cast.dir) <= 0;
    const groundAt = this.#groundAt;
    const buried =
      groundAt !== undefined &&
      cast.travelled > 1 &&
      cast.pos.y < groundAt(cast.pos.x, cast.pos.z) + radius;
    // A ball that has passed its target lands on it, however late the frame notices. Only a spell
    // that never reached the target spends its whole travel time and stops where it is.
    if (past) {
      cast.pos.copy(cast.to);
      this.#enter(cast, "impact");
      return;
    }
    if (buried || cast.t >= cast.durations.travel) this.#enter(cast, "impact");
  }

  #enter(cast: ICast, phase: CastPhase): void {
    if (!PHASES.includes(phase)) throw new RangeError(`unknown cast phase ${phase}`);
    cast.phase = phase;
    cast.t = 0;
    cast.spell.phase?.(cast, phase);
  }
}
