import { type ICtx, attachToBone } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, type Object3D, Vector2, Vector3 } from "three";
import { type HeroPoseName, type IHeroRig, createBlade, createHero } from "../render/hero.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { GameState } from "../state.js";
import type { ITarget, LockOn } from "./LockOn.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** Collision layers. Static level geometry, doors and the push block stay on the default layer 1. */
export const LAYER = { world: 1, hero: 2, foe: 4 } as const;

const DEG = Math.PI / 180;

/**
 * Wren's feel, in metres and seconds, in one table.
 *
 * Run speed, acceleration and turn rate come from the reference game's rules at 1 unit = 2.5 cm and
 * 20 Hz logic: a speed limit of 600 outdoors and 500 indoors reads 3.0 and 2.5 m/s, an approach of
 * 2.0 units/frame² reads 20 m/s², and 2000 binary angle units a frame read 220°/s. Everything else
 * (the sword, the shield, the roll, the hearts) is this kit's own design value.
 * `playtests/move.playtest.json` proves the first three; change one and change its bounds.
 */
export const ADVENTURE_FEEL = {
  runSpeedVale: 3,
  runSpeedHollow: 2.5,
  acceleration: 20,
  turnRate: 220 * DEG,
  /** While locked on, Wren turns to face the target this much faster than she turns to run. */
  lockTurnScale: 3,
  rollSpeed: 5.5,
  rollTime: 0.45,
  hopSpeed: 3.2,
  hopRise: 3.6,
  slashWindup: 0.2,
  slashActive: 0.15,
  slashRecovery: 0.25,
  slashArc: 120 * DEG,
  slashReach: 1.4,
  shieldCone: 100 * DEG,
  /** Start health: 3 hearts, counted in half-hearts. */
  startHalves: 6,
  invulnerableTime: 1,
  hurtTime: 0.35,
  knockback: 4,
  deathTime: 1.2,
  gravity: -20,
  killPlane: -10,
} as const;

/** The capsule's origin is Wren's waist; her feet sit this far below it (half-height + radius). */
const CAPSULE = { halfHeight: 0.55, radius: 0.3 } as const;
export const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;

export type HeroState =
  | "idle"
  | "run"
  | "roll"
  | "hop"
  | "slash"
  | "block"
  | "push"
  | "hurt"
  | "dead";

export interface IHeroInput {
  readonly move: Vector2;
  readonly attack: boolean;
  readonly action: boolean;
  readonly block: boolean;
  readonly target: boolean;
  readonly targetPressed: boolean;
  readonly interact: boolean;
}

const inputScratch = new Vector2();

/** Keyboard, gamepad and the touch buttons, merged into the six verbs Wren reads. */
export function readHeroInput(ctx: GameCtx, touch?: ITouchInput): IHeroInput {
  const move = inputScratch.copy(ctx.input.vector("move"));
  if (touch !== undefined) move.add(touch.move);
  move.clampLength(0, 1);
  return {
    action: ctx.input.justPressed("action") || touch?.pressed.action === true,
    attack: ctx.input.justPressed("attack") || touch?.pressed.attack === true,
    block: ctx.input.pressed("block") || touch?.held.block === true,
    interact: ctx.input.justPressed("interact") || touch?.pressed.interact === true,
    move,
    target: ctx.input.pressed("target") || touch?.held.target === true,
    targetPressed: ctx.input.justPressed("target") || touch?.pressed.target === true,
  };
}

/** The angle from a to b, wrapped to (-π, π]. */
function angleTo(a: number, b: number): number {
  return MathUtils.euclideanModulo(b - a + Math.PI, Math.PI * 2) - Math.PI;
}

export class Hero {
  /** The body object; its origin is Wren's waist, because that is where a capsule is centred. */
  readonly mesh = new Group();
  readonly rig: IHeroRig;
  readonly blade: Object3D;
  readonly tags = ["player"];
  body: CharacterBody3D | undefined;
  state: HeroState = "idle";
  /** Facing yaw: forward is (sin yaw, 0, cos yaw). π faces north (-Z). */
  yaw = Math.PI;
  health: number = ADVENTURE_FEEL.startHalves;
  capacity: number = ADVENTURE_FEEL.startHalves;
  hasSword = false;
  slashes = 0;
  slashHits = 0;
  shieldBlocks = 0;
  hitsTaken = 0;
  topSpeed = 0;
  stopSeconds = 0;
  turnSeconds = 0;
  #timer = 0;
  #invulnerable = 0;
  #speed = 0;
  #stopClock: number | undefined;
  #turnClock: number | undefined;
  #hitThisSlash = new Set<ITarget>();
  #knock = new Vector3();
  /** This step's wish direction on the ground (stick through camera or lock), length up to 1. */
  readonly wish = new Vector3();
  #toTarget = new Vector3();
  /** The distance to the locked target that strafing holds: set on lock and when closing in. */
  lockDistance = 0;

  constructor() {
    this.rig = createHero();
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.add(this.rig.group);
    this.blade = createBlade();
    this.blade.visible = false;
    // A weapon stays in the hand that holds it: the rig's `RightHand` bone carries the blade.
    attachToBone(this.rig.group, "RightHand", this.blade);
  }

  /** Builds the physics body where the hero stands now (after any scenario placement). */
  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.3, minWidth: 0.2 },
      collisionLayer: LAYER.hero,
      collisionMask: LAYER.world | LAYER.foe,
      entity: "player",
      gravity: ADVENTURE_FEEL.gravity,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE.halfHeight, CAPSULE.radius),
      snapToGround: 0.3,
    });
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get forward(): Vector3 {
    return new Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  giveSword(): void {
    this.hasSword = true;
    this.blade.visible = true;
  }

  /**
   * One step of the action machine. `cameraYaw` makes the stick camera-relative while unlocked;
   * locked, the stick is target-relative: up closes in, sideways strafes around the target.
   */
  update(
    ctx: GameCtx,
    dt: number,
    input: IHeroInput,
    lock: LockOn,
    cameraYaw: number,
    indoors: boolean,
    targets: readonly ITarget[],
  ): void {
    const body = this.body;
    if (body === undefined) return;
    this.#timer += dt;
    this.#invulnerable = Math.max(0, this.#invulnerable - dt);
    const feel = ADVENTURE_FEEL;
    const runSpeed = indoors ? feel.runSpeedHollow : feel.runSpeedVale;
    const target = lock.target;
    const stick = input.move.length();

    // Stick to world: camera-relative unlocked; locked, relative to the line to the target.
    if (target !== undefined) {
      this.#toTarget.subVectors(target.mesh.position, this.mesh.position).setY(0);
      const distance = this.#toTarget.length();
      this.#toTarget.normalize();
      if (lock.justAcquired || input.move.y > 0.2) this.lockDistance = distance;
      const tx = this.#toTarget.x;
      const tz = this.#toTarget.z;
      this.wish.set(
        tx * input.move.y - tz * input.move.x,
        0,
        tz * input.move.y + tx * input.move.x,
      );
      // Strafing holds the lock distance: a straight sideways step drifts outward on a circle.
      if (Math.abs(input.move.y) < 0.2 && stick > 0.1) {
        const drift = MathUtils.clamp((distance - this.lockDistance) * 3, -0.6, 0.6);
        this.wish.addScaledVector(this.#toTarget, drift);
      }
    } else {
      const sin = Math.sin(cameraYaw);
      const cos = Math.cos(cameraYaw);
      // Camera forward is (-sin, -cos) on the ground; its right is (cos, -sin).
      this.wish.set(
        cos * input.move.x - sin * input.move.y,
        0,
        -sin * input.move.x - cos * input.move.y,
      );
    }

    const busy =
      this.state === "slash" ||
      this.state === "roll" ||
      this.state === "hop" ||
      this.state === "hurt" ||
      this.state === "dead";
    if (!busy) {
      if (input.attack && this.hasSword) this.#begin("slash");
      else if (input.action && body.grounded) {
        if (target === undefined) this.#begin("roll");
        else {
          this.#begin("hop");
          body.velocity.y = feel.hopRise;
          const away =
            stick > 0.1 ? this.wish.clone().normalize() : this.#toTarget.clone().negate();
          body.velocity.x = away.x * feel.hopSpeed;
          body.velocity.z = away.z * feel.hopSpeed;
        }
      } else if (input.block) this.state = "block";
      else if (this.state === "block") this.state = "idle";
    }

    // Facing: toward the target while locked, toward the stick otherwise.
    const turnRate = feel.turnRate * (target !== undefined ? feel.lockTurnScale : 1);
    const goalYaw =
      target !== undefined
        ? Math.atan2(this.#toTarget.x, this.#toTarget.z)
        : stick > 0.1
          ? Math.atan2(this.wish.x, this.wish.z)
          : this.yaw;
    const canTurn =
      this.state === "idle" ||
      this.state === "run" ||
      this.state === "block" ||
      this.state === "push" ||
      (this.state === "slash" && target !== undefined);
    const gap = angleTo(this.yaw, goalYaw);
    if (canTurn) {
      // The 180° turn clock: armed when the stick asks for a reversal, stopped when she faces it.
      if (target === undefined && Math.abs(gap) > 150 * DEG && this.#turnClock === undefined)
        this.#turnClock = 0;
      this.yaw += MathUtils.clamp(gap, -turnRate * dt, turnRate * dt);
    }
    if (this.#turnClock !== undefined) {
      this.#turnClock += dt;
      if (Math.abs(angleTo(this.yaw, goalYaw)) < 1e-4) {
        this.turnSeconds = this.#turnClock;
        this.#turnClock = undefined;
      }
    }

    // Horizontal velocity per state.
    const vx = body.velocity.x;
    const vz = body.velocity.z;
    let nx = vx;
    let nz = vz;
    const forward = this.forward;
    switch (this.state) {
      case "idle":
      case "run":
      case "push": {
        // She plants and pivots rather than running a wide arc: speed follows how far she still
        // has to turn, so a reversal turns on the spot and a right angle slows through the corner.
        const facing = target === undefined ? Math.max(0, Math.cos(angleTo(this.yaw, goalYaw))) : 1;
        const want = stick > 0.1 ? stick * runSpeed * facing : 0;
        this.#speed = approach(this.#speed, want, feel.acceleration * dt);
        if (target !== undefined) {
          const wish = this.wish.lengthSq() > 1e-4 ? this.wish.clone().normalize() : this.wish;
          nx = approach(vx, wish.x * runSpeed * Math.min(1, stick), feel.acceleration * dt);
          nz = approach(vz, wish.z * runSpeed * Math.min(1, stick), feel.acceleration * dt);
        } else {
          nx = forward.x * this.#speed;
          nz = forward.z * this.#speed;
        }
        if (this.state !== "push") this.state = Math.hypot(nx, nz) > 0.2 ? "run" : "idle";
        break;
      }
      case "block":
      case "slash":
        this.#speed = approach(this.#speed, 0, feel.acceleration * dt);
        nx = approach(vx, 0, feel.acceleration * dt);
        nz = approach(vz, 0, feel.acceleration * dt);
        break;
      case "roll":
        nx = forward.x * feel.rollSpeed;
        nz = forward.z * feel.rollSpeed;
        this.#speed = feel.rollSpeed;
        if (this.#timer >= feel.rollTime) this.#end(runSpeed * 0.6);
        break;
      case "hop":
        if (this.#timer > 0.1 && body.grounded) this.#end(0);
        break;
      case "hurt":
        nx = this.#knock.x * (1 - this.#timer / feel.hurtTime);
        nz = this.#knock.z * (1 - this.#timer / feel.hurtTime);
        if (this.#timer >= feel.hurtTime) this.#end(0);
        break;
      case "dead":
        nx = 0;
        nz = 0;
        break;
    }
    if (this.state !== "hop") {
      body.velocity.x = nx;
      body.velocity.z = nz;
    }

    // The slash: one shape query over the arc on each active frame, each target hit once.
    if (this.state === "slash") {
      const windup = feel.slashWindup;
      const active = windup + feel.slashActive;
      if (this.#timer >= windup && this.#timer < active) this.#strike(ctx, targets);
      if (this.#timer >= active + feel.slashRecovery) this.#end(0);
    }

    body.moveAndSlide(dt);

    // Measured feel, for the HUD-free playtests: top ground speed, release-to-stop time.
    const ground = Math.hypot(body.velocity.x, body.velocity.z);
    if (body.grounded && (this.state === "run" || this.state === "idle"))
      this.topSpeed = Math.max(this.topSpeed, ground);
    if (stick < 0.1 && ground > 0.5 && this.#stopClock === undefined && this.state === "run")
      this.#stopClock = 0;
    if (this.#stopClock !== undefined) {
      this.#stopClock += dt;
      if (ground < 0.05) {
        this.stopSeconds = this.#stopClock;
        this.#stopClock = undefined;
      } else if (stick >= 0.1) this.#stopClock = undefined;
    }

    this.rig.group.rotation.y = this.yaw;
    this.rig.update({
      dt,
      progress: this.#progress(),
      speed: Math.hypot(body.velocity.x, body.velocity.z),
      state: poseOf(this.state),
    });
  }

  /** Puts Wren into the pushing pose this step, or back out of it. */
  setPushing(pushing: boolean): void {
    if (pushing && (this.state === "idle" || this.state === "run")) this.state = "push";
    else if (!pushing && this.state === "push") this.state = "idle";
  }

  /**
   * A hostile's hit. The shield takes it when raised and the attacker is inside the front cone;
   * otherwise it costs `halves` half-hearts. Returns what happened, for the attacker's reaction.
   */
  takeHit(halves: number, from: Vector3): "blocked" | "hit" | "ignored" {
    if (this.state === "dead" || this.state === "roll" || this.#invulnerable > 0) return "ignored";
    const toAttacker = new Vector3().subVectors(from, this.mesh.position).setY(0).normalize();
    const facing = this.forward.dot(toAttacker);
    if (this.state === "block" && facing >= Math.cos(ADVENTURE_FEEL.shieldCone / 2)) {
      this.shieldBlocks += 1;
      return "blocked";
    }
    this.health = Math.max(0, this.health - halves);
    this.hitsTaken += 1;
    this.#invulnerable = ADVENTURE_FEEL.invulnerableTime;
    this.#knock.copy(toAttacker).multiplyScalar(-ADVENTURE_FEEL.knockback);
    this.#begin(this.health <= 0 ? "dead" : "hurt");
    return "hit";
  }

  heal(halves: number): void {
    this.health = Math.min(this.capacity, this.health + halves);
  }

  /** True once the death pose has played: the scene respawns her. */
  get readyToRespawn(): boolean {
    return this.state === "dead" && this.#timer >= ADVENTURE_FEEL.deathTime;
  }

  respawn(at: Vector3, yaw: number): void {
    this.health = this.capacity;
    this.state = "idle";
    this.#speed = 0;
    this.yaw = yaw;
    this.#invulnerable = ADVENTURE_FEEL.invulnerableTime;
    this.teleport(at);
  }

  teleport(at: Vector3): void {
    this.body?.teleport(at);
    this.mesh.position.copy(at);
  }

  /** Blinks while invulnerable. */
  get blinking(): boolean {
    return (
      this.#invulnerable > 0 &&
      Math.floor(this.#invulnerable * 14) % 2 === 0 &&
      this.state !== "dead"
    );
  }

  debug(): Record<string, unknown> {
    return {
      feetY: this.mesh.position.y - FOOT_OFFSET,
      grounded: this.body?.grounded ?? false,
      health: this.health,
      position: this.mesh.position.toArray(),
      state: this.state,
      yawDegrees: Math.round(MathUtils.radToDeg(MathUtils.euclideanModulo(this.yaw, Math.PI * 2))),
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.mesh.removeFromParent();
  }

  #begin(state: HeroState): void {
    this.state = state;
    this.#timer = 0;
    if (state === "slash") {
      this.slashes += 1;
      this.#hitThisSlash.clear();
    }
  }

  #end(speed: number): void {
    this.state = "idle";
    this.#timer = 0;
    this.#speed = speed;
  }

  #progress(): number {
    const feel = ADVENTURE_FEEL;
    if (this.state === "slash")
      return this.#timer / (feel.slashWindup + feel.slashActive + feel.slashRecovery);
    if (this.state === "roll") return this.#timer / feel.rollTime;
    if (this.state === "hurt") return this.#timer / feel.hurtTime;
    if (this.state === "dead") return this.#timer / feel.deathTime;
    return 0;
  }

  #strike(ctx: GameCtx, targets: readonly ITarget[]): void {
    const feel = ADVENTURE_FEEL;
    const hits = ctx.physics.directSpaceState.intersectShape({
      collisionMask: LAYER.foe,
      maxResults: 8,
      position: this.mesh.position,
      shape: CollisionShape3D.sphere(feel.slashReach + 1),
    });
    const forward = this.forward;
    for (const hit of hits) {
      const target = targets.find((candidate) => candidate.bodyId === hit.body.id);
      if (target === undefined || !target.alive || this.#hitThisSlash.has(target)) continue;
      const to = new Vector3().subVectors(target.mesh.position, this.mesh.position).setY(0);
      // The reach is measured to the target's surface, the arc from Wren's facing.
      if (to.length() - target.radius > feel.slashReach) continue;
      if (forward.dot(to.normalize()) < Math.cos(feel.slashArc / 2)) continue;
      this.#hitThisSlash.add(target);
      if (target.hurt(1, this.mesh.position)) this.slashHits += 1;
    }
  }
}

function approach(current: number, target: number, step: number): number {
  const delta = target - current;
  return Math.abs(delta) <= step ? target : current + Math.sign(delta) * step;
}

function poseOf(state: HeroState): HeroPoseName {
  return state === "push" ? "block" : state;
}
