import { BoxGeometry, Mesh, type Object3D, Vector2, Vector3 } from "three";
import { pistolMaterial, playerMaterial } from "../render/materials.js";
import type { Car } from "./Car.js";
import { type IMannequin, Humanoid } from "./Humanoid.js";
import { CAR_LAYER, type GameCtx, PED_LAYER, PLAYER_LAYER, WORLD_LAYER } from "./layers.js";

/**
 * On-foot feel. Speeds are GTA-like: a jog by default, a sprint on a stamina budget. The stamina
 * numbers are the San Andreas player's (MCP card grand-theft-auto-san-andreas-reversed/
 * sprint-energy-budget): it drains 50 units a second, bottoms out 150 below empty, and refills at
 * half the drain rate. The speed chases its target at a bounded rate instead of jumping
 * (…/onfoot-move-blend-ratio: 0.07 blend units per 20 ms step, about 7.4 m/s² here).
 */
export const ON_FOOT = {
  run: 4.2,
  sprint: 6.8,
  /** Moving while aiming is a strafe at walking pace. */
  aimWalk: 1.6,
  accel: 14,
  staminaMax: 150,
  staminaFloor: -150,
  staminaDrain: 50,
  staminaRefill: 25,
} as const;

/** Combat. A pistol magazine of 12 and 0.6 s between punches; damage in health points. */
export const COMBAT = {
  punchDamage: 10,
  punchReach: 1.3,
  punchCone: Math.cos((70 * Math.PI) / 180),
  /** Ticks from the button to the fist landing, at 60 Hz: the jab's own contact frame. */
  punchContact: 9,
  punchHold: 0.55,
  pistolDamage: 25,
  pistolRange: 40,
  pistolInterval: 0.32,
  clip: 12,
  reloadTime: 1.2,
  startAmmo: 48,
  /** Lock-on reach and half-angle around the camera's forward. */
  lockRange: 25,
  lockCone: Math.cos((55 * Math.PI) / 180),
} as const;

export type PlayerMode = "foot" | "entering" | "driving" | "exiting" | "dead";
export type Weapon = "fist" | "pistol";

/** Anything the player can lock on to or hit: a pedestrian or an officer. */
export interface ITarget {
  readonly position: Vector3;
  readonly alive: boolean;
  readonly inWorld: boolean;
  readonly cop: boolean;
}

export interface IPlayerInput {
  readonly move: Vector2;
  readonly sprint: boolean;
  readonly aim: boolean;
  readonly fire: boolean;
  readonly firePressed: boolean;
  readonly weaponPressed: boolean;
}

const _forward = new Vector3();
const _right = new Vector3();
const _wish = new Vector3();
const _to = new Vector3();

export class Player extends Humanoid {
  readonly tags = ["player"];
  mode: PlayerMode = "foot";
  car: Car | undefined;
  weapon: Weapon = "fist";
  ammo: number = COMBAT.startAmmo;
  clip: number = COMBAT.clip;
  stamina: number = ON_FOOT.staminaMax;
  /** The locked target while aiming, or undefined. */
  target: ITarget | undefined;
  /** Seconds left in the get-in or get-out beat. */
  transition = 0;
  shots = 0;
  punches = 0;
  #speed = 0;
  #cooldown = 0;
  #reload = 0;
  #punchTimer = -1;
  #combo = 0;
  #sincePunch = 0;
  #exhausted = false;
  #wasAiming = false;
  readonly pistol: Object3D;

  constructor(ctx: GameCtx, model: IMannequin, at: Vector3) {
    const pistol = new Mesh(new BoxGeometry(0.05, 0.12, 0.22), pistolMaterial);
    pistol.position.set(0, 0.02, 0.06);
    super(ctx, model, {
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER | CAR_LAYER | PED_LAYER,
      health: 100,
      material: playerMaterial,
      position: at,
      weapon: pistol,
      // Cars collide with the player capsule; the player walks into people instead of through them.
    });
    this.pistol = pistol;
    pistol.visible = false;
  }

  /** While driving, the bridge and the camera follow the car: it is what the player is. */
  override get mesh(): Object3D {
    return this.mode === "driving" && this.car !== undefined ? this.car.mesh : super.mesh;
  }

  /** Where the player is, in or out of a car. */
  get where(): Vector3 {
    // In a car (driving, or dead at the wheel) the player is where the car is.
    return this.car !== undefined && !this.inWorld ? this.car.position : this.position;
  }

  /** True while the pistol is up: what draws the lock-on reticle and makes peds flee. */
  get aiming(): boolean {
    return this.#wasAiming;
  }

  get reloading(): boolean {
    return this.#reload > 0;
  }

  /**
   * One on-foot tick. `cameraYaw` turns the stick into the camera's frame; `targets` are what the
   * lock-on picks from. Returns what the player did this tick, for the scene to resolve.
   */
  updateOnFoot(
    dt: number,
    input: IPlayerInput,
    cameraYaw: number,
    targets: readonly ITarget[],
  ): { punchLanded: boolean; shot: boolean } {
    let punchLanded = false;
    let shot = false;
    if (input.weaponPressed && (this.weapon === "pistol" || this.ammo > 0)) {
      this.weapon = this.weapon === "fist" ? "pistol" : "fist";
      this.#punchTimer = -1;
    }
    this.pistol.visible = this.weapon === "pistol";
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    if (this.#reload > 0) {
      this.#reload -= dt;
      if (this.#reload <= 0) this.clip = Math.min(COMBAT.clip, this.ammo);
    }

    // Stamina: drain while sprinting and moving, refill otherwise; at the floor the sprint stops
    // until the reserve climbs back above empty.
    const moving = input.move.lengthSq() > 0.01;
    const wantsSprint = input.sprint && moving && !input.aim;
    if (this.stamina <= ON_FOOT.staminaFloor) this.#exhausted = true;
    if (this.#exhausted && this.stamina > 0) this.#exhausted = false;
    const sprinting = wantsSprint && !this.#exhausted;
    this.stamina = sprinting
      ? Math.max(ON_FOOT.staminaFloor, this.stamina - ON_FOOT.staminaDrain * dt)
      : Math.min(ON_FOOT.staminaMax, this.stamina + ON_FOOT.staminaRefill * dt);

    // The stick in the camera's frame: forward is where the camera looks.
    _forward.set(-Math.sin(cameraYaw), 0, -Math.cos(cameraYaw));
    _right.set(Math.cos(cameraYaw), 0, -Math.sin(cameraYaw));
    _wish.copy(_forward).multiplyScalar(input.move.y).addScaledVector(_right, input.move.x);
    const amount = Math.min(1, _wish.length());
    if (amount > 0) _wish.divideScalar(Math.max(amount, 1e-6));

    // Lock-on: hold aim with the pistol out to pick the nearest live target ahead.
    const aiming = input.aim && this.weapon === "pistol";
    if (
      aiming &&
      (this.target === undefined || !this.#valid(this.target) || !targets.includes(this.target))
    )
      this.target = this.#pick(targets, _forward);
    if (!aiming) this.target = undefined;
    this.#wasAiming = aiming;

    const top = aiming ? ON_FOOT.aimWalk : sprinting ? ON_FOOT.sprint : ON_FOOT.run;
    const goal = this.busy && this.action !== "shoot" ? 0 : top * amount;
    this.#speed += Math.max(-ON_FOOT.accel * dt, Math.min(ON_FOOT.accel * dt, goal - this.#speed));
    this.move(dt, _wish.x * this.#speed, _wish.z * this.#speed);

    let heading: number | undefined;
    if (this.target !== undefined) {
      _to.copy(this.target.position).sub(this.position);
      this.face(Math.atan2(_to.x, _to.z));
    } else if (aiming) this.face(cameraYaw + Math.PI);
    else if (amount > 0.05) heading = Math.atan2(_wish.x, _wish.z);

    // Fire: a punch combo bare-handed, a pistol round with the gun out.
    if (this.weapon === "fist") {
      // A second jab more than a second after the first starts the combo over.
      if (this.#sincePunch > 1) this.#combo = 0;
      this.#sincePunch += dt;
      if (input.firePressed && !this.busy) {
        this.#sincePunch = 0;
        this.play(this.#combo % 2 === 0 ? "punch" : "punch2", {
          fit: true,
          hold: COMBAT.punchHold,
        });
        this.#combo += 1;
        this.#punchTimer = COMBAT.punchContact / 60;
        this.punches += 1;
      }
    } else if (input.fire && this.#cooldown === 0 && this.#reload <= 0) {
      if (this.clip > 0) {
        this.clip -= 1;
        this.ammo -= 1;
        this.#cooldown = COMBAT.pistolInterval;
        this.play("shoot", { fade: 0.04, hold: 0.2 });
        this.shots += 1;
        shot = true;
        if (this.clip === 0 && this.ammo > 0) this.#startReload();
      } else if (this.ammo > 0) this.#startReload();
    }
    if (this.#punchTimer >= 0) {
      this.#punchTimer -= dt;
      if (this.#punchTimer < 0) punchLanded = true;
    }
    this.animateRig(dt, heading, this.groundSpeed(), aiming);
    return { punchLanded, shot };
  }

  /** The tick while inside a car, or getting in or out: the rig keeps advancing. */
  updateIdle(dt: number): void {
    // In a car beat: no punch lands later and no aim or lock-on carries over.
    this.#punchTimer = -1;
    this.#wasAiming = false;
    this.target = undefined;
    this.transition = Math.max(0, this.transition - dt);
    this.animateStill(dt);
  }

  takeDamage(amount: number): boolean {
    if (!this.alive || !(amount > 0)) return false;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) {
      if (!this.busy && this.mode === "foot") this.play("hit", { fade: 0.04, hold: 0.25 });
      return false;
    }
    this.mode = "dead";
    this.target = undefined;
    if (this.inWorld) this.play("death", { fade: 0.05, hold: Number.POSITIVE_INFINITY });
    return true;
  }

  /** Back on foot at `at`, with full health: the hospital, the police station, a restart. */
  respawn(at: Vector3, keepWeapons: boolean): void {
    this.car = undefined;
    this.mode = "foot";
    this.health = 100;
    this.stamina = ON_FOOT.staminaMax;
    this.target = undefined;
    this.transition = 0;
    this.#speed = 0;
    this.#reload = 0;
    this.#punchTimer = -1;
    this.#combo = 0;
    this.#cooldown = 0;
    if (!keepWeapons) {
      this.weapon = "fist";
      this.ammo = 0;
      this.clip = 0;
    }
    this.enterWorld(at);
    this.release();
  }

  #startReload(): void {
    this.#reload = COMBAT.reloadTime;
    this.play("reload", { fit: true, hold: COMBAT.reloadTime });
  }

  #valid(target: ITarget): boolean {
    return (
      target.alive &&
      target.inWorld &&
      target.position.distanceTo(this.position) <= COMBAT.lockRange
    );
  }

  #pick(targets: readonly ITarget[], forward: Vector3): ITarget | undefined {
    let best: ITarget | undefined;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const target of targets) {
      if (!this.#valid(target)) continue;
      _to.copy(target.position).sub(this.position).setY(0);
      const distance = _to.length();
      if (distance < 0.01) continue;
      const along = _to.dot(forward) / distance;
      if (along < COMBAT.lockCone) continue;
      // Nearest wins, with officers first at equal distance: they are the ones shooting back.
      const score = distance * (1.5 - along) * (target.cop ? 0.8 : 1);
      if (score < bestScore) {
        bestScore = score;
        best = target;
      }
    }
    return best;
  }

  /** The point a shot starts from: chest height, a little ahead (MCP card …re3/weapon-fire-offset). */
  muzzle(out: Vector3): Vector3 {
    this.facing(out);
    return out
      .multiplyScalar(0.4)
      .add(this.position)
      .setY(this.position.y + 0.6);
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      ammo: this.ammo,
      clip: this.clip,
      health: this.health,
      mode: this.mode,
      normaliseFactor: this.conventions.normaliseFactor,
      groundClearance: this.conventions.groundSnap.clearance,
      position: this.where.toArray(),
      punches: this.punches,
      shots: this.shots,
      speed: this.mode === "driving" ? Math.abs(this.car?.speed ?? 0) : this.groundSpeed(),
      stamina: Math.round(this.stamina),
      targetLocked: this.target !== undefined,
      weapon: this.weapon,
      weaponBone: this.conventions.attachedBone,
    };
  }
}
