import { type Group, MathUtils, type Object3D, Vector3 } from "three";
import { hopperModel, thornbackModel, walkerModel } from "../render/props.js";

/**
 * The key `@threenative/playtest` sets on an entity a scenario placed with `frozen: true`. Written
 * here rather than imported: the marker belongs to the test harness, and game code importing a
 * devDependency stops building for a native target. Honouring it keeps a stomp reproducible.
 */
const PLAYTEST_FROZEN = "__threenativeFrozen";

/**
 * The three walkers. A bumblet waddles after the hero; a hopper crouches (its telegraph), then
 * hops at the hero; a thornback rears and bristles (its telegraph), then charges in a straight line.
 * Bumblets and hoppers can be stomped; a thornback's spikes hurt a stomp, so only a ground pound or
 * a dive beats it.
 */
export type WalkerKind = "bumblet" | "hopper" | "thornback";

const WALKER = {
  /** Wander speed around home, and chase speed toward a hero inside `sight`. */
  wanderSpeed: 1.2,
  chaseSpeed: 2.6,
  sight: 6,
  /** How far from home it will chase before it gives up and goes back. */
  leash: 7,
  /** Its body, for touches: a cylinder this wide and tall from its feet. */
  radius: 0.65,
  height: 1.2,
  /** Hopper: seconds resting, crouching (the telegraph) and in the air; a hop's reach and height. */
  hop: { rest: 0.5, crouch: 0.45, air: 0.6, reach: 2.6, height: 1.3 },
  /** Thornback: seconds rearing (the telegraph), charging and resting; charge speed in m/s. */
  charge: { rear: 0.7, run: 0.9, rest: 1.2, speed: 5.5 },
} as const;

const MODELS = { bumblet: walkerModel, hopper: hopperModel, thornback: thornbackModel } as const;

/**
 * A walker: it wanders a circle round its home and goes for the hero inside its sight.
 * Kinematic scenery that can be hit, not a physics body: a touch costs one distance test.
 */
export class Walker {
  readonly mesh: Group;
  readonly tags = ["walker"];
  /** Whether a stomp defeats it; a thornback's spikes hurt the stomper instead. */
  readonly stompable: boolean;
  alive = true;
  /** Telegraphs shown (a crouch or a rear) and the attacks that followed (hops or charges). */
  telegraphs = 0;
  attacks = 0;
  readonly #home = new Vector3();
  readonly #from = new Vector3();
  readonly #to = new Vector3();
  readonly #spikes: Object3D | undefined;
  #squash = 0;
  #phase: number;
  /** Height above the ground it keeps: 0 on the lawn, a tier's height when it lives on a drum. */
  #lift = 0;
  #state: "move" | "telegraph" | "attack" | "rest" = "rest";
  #timer = 0;

  constructor(
    readonly kind: WalkerKind,
    at: readonly [number, number, number],
    phase: number,
    /** The terrain's height at (x, z), so it walks over hills instead of through them. */
    readonly ground: (x: number, z: number) => number = () => 0,
  ) {
    this.mesh = MODELS[kind]();
    this.mesh.position.set(at[0], at[1], at[2]);
    this.stompable = kind !== "thornback";
    this.#spikes = this.mesh.getObjectByName("spikes");
    this.#phase = phase;
    this.settle();
  }

  static readonly radius = WALKER.radius;
  static readonly height = WALKER.height;

  /**
   * Takes the current position as home, lifted onto the ground if a scenario placed it under a
   * hill: call once after a scenario may have placed it.
   */
  settle(): void {
    const p = this.mesh.position;
    p.y = Math.max(p.y, this.ground(p.x, p.z));
    this.#home.copy(p);
    this.#lift = p.y - this.ground(p.x, p.z);
  }

  /** Where its feet go at (x, z): the ground plus the lift it was placed with. */
  #floor(x: number, z: number): number {
    return this.ground(x, z) + this.#lift;
  }

  update(dt: number, time: number, hero: Vector3): void {
    if (!this.alive) {
      // Flattened, then gone: the squash is the hit's feedback before the count moves.
      this.#squash += dt;
      this.mesh.scale.set(
        1 + this.#squash * 1.5,
        Math.max(0.05, 1 - this.#squash * 3),
        1 + this.#squash * 1.5,
      );
      if (this.#squash > 0.4) this.mesh.removeFromParent();
      return;
    }
    if (this.mesh.userData[PLAYTEST_FROZEN] === true) return;
    const p = this.mesh.position;
    const toHero = Math.hypot(hero.x - p.x, hero.z - p.z);
    const fromHome = Math.hypot(p.x - this.#home.x, p.z - this.#home.z);
    const chasing =
      toHero < WALKER.sight && fromHome < WALKER.leash && Math.abs(hero.y - p.y) < 2.5;
    // Where it heads: the hero when chasing, else a point circling home.
    if (chasing) this.#to.set(hero.x, this.#home.y, hero.z);
    else {
      this.#phase += dt * 0.35;
      this.#to.set(
        this.#home.x + Math.cos(this.#phase) * 2.5,
        this.#home.y,
        this.#home.z + Math.sin(this.#phase) * 2.5,
      );
    }
    this.#timer += dt;
    if (this.kind === "hopper") this.#hop();
    else if (this.kind === "thornback") this.#charge(dt, time, chasing);
    else {
      this.#walk(dt, chasing ? WALKER.chaseSpeed : WALKER.wanderSpeed);
      const waddle = Math.sin(time * 9 + this.#phase);
      this.mesh.rotation.z = waddle * 0.08;
      p.y = this.#floor(p.x, p.z) + Math.abs(waddle) * 0.05;
    }
  }

  /** Moves toward `#to` at `speed` and turns to face the way it goes. */
  #walk(dt: number, speed: number): void {
    const p = this.mesh.position;
    const dx = this.#to.x - p.x;
    const dz = this.#to.z - p.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.05) return;
    const step = Math.min(d, speed * dt);
    p.x += (dx / d) * step;
    p.z += (dz / d) * step;
    this.#face(dx, dz, dt * 8);
  }

  #face(dx: number, dz: number, rate: number): void {
    const yaw = Math.atan2(-dx, -dz);
    this.mesh.rotation.y +=
      (MathUtils.euclideanModulo(yaw - this.mesh.rotation.y + Math.PI, Math.PI * 2) - Math.PI) *
      Math.min(1, rate);
  }

  /** Rest, crouch (the telegraph), then one ballistic hop of up to `hop.reach` toward `#to`. */
  #hop(): void {
    const { rest, crouch, air, reach, height } = WALKER.hop;
    const p = this.mesh.position;
    const k = this.#timer;
    if (this.#state !== "telegraph" && this.#state !== "attack" && k > rest) {
      [this.#state, this.#timer] = ["telegraph", 0];
      this.telegraphs += 1;
    } else if (this.#state === "telegraph") {
      const sink = Math.min(1, k / crouch);
      this.mesh.scale.set(1 + sink * 0.25, 1 - sink * 0.35, 1 + sink * 0.25);
      this.#face(this.#to.x - p.x, this.#to.z - p.z, 0.3);
      if (k > crouch) {
        this.#from.copy(p);
        const dx = this.#to.x - p.x;
        const dz = this.#to.z - p.z;
        const d = Math.hypot(dx, dz);
        const s = d > reach ? reach / d : 1;
        this.#to.set(p.x + dx * s, 0, p.z + dz * s);
        this.#to.y = this.#floor(this.#to.x, this.#to.z);
        [this.#state, this.#timer] = ["attack", 0];
        this.attacks += 1;
      }
    } else if (this.#state === "attack") {
      const t = Math.min(1, k / air);
      p.lerpVectors(this.#from, this.#to, t);
      p.y = this.#from.y + (this.#to.y - this.#from.y) * t + Math.sin(t * Math.PI) * height;
      this.mesh.scale.set(0.9, 1.15, 0.9);
      if (t >= 1) {
        [this.#state, this.#timer] = ["rest", 0];
        this.mesh.scale.set(1, 1, 1);
      }
    }
  }

  /** Wander, then on sight rear and bristle (the telegraph) and charge the way it faced. */
  #charge(dt: number, time: number, chasing: boolean): void {
    const { rear, run, rest, speed } = WALKER.charge;
    const p = this.mesh.position;
    const k = this.#timer;
    let bristle = 1;
    this.mesh.rotation.x = 0;
    this.mesh.rotation.z = 0;
    if (this.#state === "telegraph") {
      bristle = 1 + Math.min(1, k / rear) * 0.45;
      this.mesh.rotation.x = 0.22;
      this.mesh.rotation.z = Math.sin(time * 45) * 0.08;
      this.#face(this.#to.x - p.x, this.#to.z - p.z, dt * 10);
      if (k > rear) {
        // Locks the line it charges along: a sidestep during the rear dodges it.
        const yaw = this.mesh.rotation.y;
        this.#from.set(-Math.sin(yaw), 0, -Math.cos(yaw));
        [this.#state, this.#timer] = ["attack", 0];
        this.attacks += 1;
      }
    } else if (this.#state === "attack") {
      bristle = 1.45;
      const fromHome = Math.hypot(p.x - this.#home.x, p.z - this.#home.z);
      if (k > run || fromHome > WALKER.leash + 2) [this.#state, this.#timer] = ["rest", 0];
      else p.addScaledVector(this.#from, speed * dt);
    } else if (this.#state === "rest") {
      if (k > rest) [this.#state, this.#timer] = ["move", 0];
    } else if (chasing) {
      [this.#state, this.#timer] = ["telegraph", 0];
      this.telegraphs += 1;
    } else {
      this.#walk(dt, 0.9);
      this.mesh.rotation.z = Math.sin(time * 6 + this.#phase) * 0.05;
    }
    p.y = this.#floor(p.x, p.z);
    this.#spikes?.scale.setScalar(bristle);
  }

  kill(): void {
    this.alive = false;
    this.#squash = 0;
  }

  debug(): Record<string, unknown> {
    return {
      alive: this.alive,
      attacks: this.attacks,
      kind: this.kind,
      position: this.mesh.position.toArray(),
      telegraphs: this.telegraphs,
    };
  }
}
