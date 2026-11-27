import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, type Object3D, Vector3 } from "three";
import type { Post } from "../level.js";
import { RIFLE_HOLD, createRifle, createTracer, dress, soldierMaterial } from "../render/props.js";
import { BURST_GAP_SECONDS, BURST_SECONDS, MISS_CONE, soldierAccuracy } from "../rules/accuracy.js";
import type { Stance } from "../rules/movement.js";
import { TickClock, toTicks } from "../rules/ticks.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

export const WORLD_LAYER = 1;
export const PLAYER_LAYER = 2;
export const SOLDIER_LAYER = 4;

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  down: "Death01",
  hit: "Hit_Chest",
  idle: "Rifle_Idle",
  shoot: "Rifle_Shoot",
  walk: "Rifle_Walk",
} as const;

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
/** The body is a cylinder this tall, and the top 0.3 m is the head. */
const BODY_HEIGHT = 1.8;
const HEAD_FROM = 1.5;
const EYE_HEIGHT = 1.55;
const MUZZLE_HEIGHT = 1.35;
export const SOLDIER_HEALTH = 100;
/** A soldier sees this far, and this wide a cone around where it faces, until a hit makes it look round. */
const SIGHT_RANGE = 45;
const SIGHT_HALF_ANGLE = (75 * Math.PI) / 180;
/** Seconds a soldier that took a hit looks all round for the shooter. */
const ALERT_SECONDS = 4;
const TURN_RATE = 5;
/** A soldier needs this long on a clear sight line before its first round: a beat to react. */
const REACTION_SECONDS = 0.6;
/** Within this angle of the target the soldier fires. */
const AIM_TOLERANCE = 0.12;
/** One round every four ticks while the trigger is down: 7.5 a second. */
const ROUND_TICKS = 4;
const ROUND_DAMAGE = 8;
const TRACER_TIME = 0.07;
const MAX_SHOT = 60;

export interface ITarget {
  readonly eye: Vector3;
  readonly chest: Vector3;
  readonly stance: Stance;
  readonly velocity: { readonly x: number; readonly z: number };
}

export interface ISoldierHooks {
  /** Distance to the first wall or cover on the line, or undefined when nothing stands in between. */
  readonly worldHit: (from: Vector3, to: Vector3) => number | undefined;
  readonly hitPlayer: (damage: number) => void;
  /** A round was aimed with this chance to hit. */
  readonly aimed: (accuracy: number) => void;
  readonly random: () => number;
}

export type SoldierState = "hold" | "burst" | "gap" | "dead";

export class Soldier extends Fighter {
  readonly id: string;
  readonly tags = ["soldier", "hostile"];
  state: SoldierState = "hold";
  health = SOLDIER_HEALTH;
  /** What the last round aimed with: the chance to hit, 0..1. */
  accuracy = 0;
  /** Rounds fired, rounds that struck the player, and rounds a wall or cover stopped. */
  shots = 0;
  hits = 0;
  blocked = 0;
  #ticks = 0;
  #roundTicks = 0;
  #alert = 0;
  #sightSeconds = 0;
  readonly #clock = new TickClock();
  readonly #tracer = createTracer();
  #tracerTimer = 0;
  readonly #rifle: Object3D;
  #heldClip = "";
  #body: CharacterBody3D | undefined;
  readonly #hooks: ISoldierHooks;
  readonly #from = new Vector3();
  readonly #to = new Vector3();
  readonly #muzzle = new Vector3();

  constructor(ctx: GameCtx, model: IMannequin, post: Post, hooks: ISoldierHooks) {
    const rifle = createRifle();
    super(ctx, model, CLIPS, { halfExtent: HALF_HEIGHT + RADIUS, weapon: rifle });
    this.#rifle = rifle;
    this.id = post.id;
    this.#hooks = hooks;
    dress(this.character.root, soldierMaterial);
    this.mesh.position.set(post.x, HALF_HEIGHT + RADIUS, post.z);
    this.#body = new CharacterBody3D({
      collisionLayer: SOLDIER_LAYER,
      collisionMask: WORLD_LAYER | PLAYER_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
    ctx.add(this.#tracer.line);
  }

  get yaw(): number {
    return this.figure.rotation.y;
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  /**
   * Where a round from `origin` along `direction` meets this soldier: the distance and whether it
   * struck the head, or undefined for a miss. A vertical cylinder, which is what a standing body is.
   */
  hitTest(
    origin: Vector3,
    direction: Vector3,
    reach: number,
  ): { distance: number; head: boolean } | undefined {
    if (!this.alive) return undefined;
    const ox = origin.x - this.mesh.position.x;
    const oz = origin.z - this.mesh.position.z;
    const a = direction.x * direction.x + direction.z * direction.z;
    if (a < 1e-9) return undefined;
    const b = ox * direction.x + oz * direction.z;
    const c = ox * ox + oz * oz - RADIUS * RADIUS;
    const discriminant = b * b - a * c;
    if (discriminant < 0) return undefined;
    const distance = (-b - Math.sqrt(discriminant)) / a;
    if (distance < 0 || distance > reach) return undefined;
    const y = origin.y + direction.y * distance;
    if (y < 0 || y > BODY_HEIGHT) return undefined;
    return { distance, head: y >= HEAD_FROM };
  }

  /** The player's round landed. Returns true when it killed. */
  damage(amount: number): boolean {
    if (!this.alive) return false;
    this.health = Math.max(0, this.health - amount);
    this.#alert = ALERT_SECONDS;
    if (this.health > 0) {
      this.play("hit", { fade: 0.04, hold: 0.25 });
      return false;
    }
    this.state = "dead";
    this.#body?.dispose();
    this.#body = undefined;
    this.#tracerTimer = 0;
    this.play("down", { fade: 0.1, hold: Number.POSITIVE_INFINITY });
    return true;
  }

  /** Forget what it was tracking: the player was moved, so its reaction beat starts again. */
  loseTarget(): void {
    if (this.state !== "dead") this.state = "hold";
    this.#sightSeconds = 0;
    this.#ticks = 0;
  }

  /** Round over: stand where it is, tracer off. */
  rest(dt: number): void {
    this.#tracerTimer = 0;
    this.#present(dt);
  }

  update(ctx: GameCtx, dt: number, target: ITarget, ceasefire: boolean): void {
    if (this.state === "dead") {
      this.#present(dt);
      return;
    }
    this.#alert = Math.max(0, this.#alert - dt);
    this.#from.set(this.mesh.position.x, EYE_HEIGHT, this.mesh.position.z);
    const dx = target.eye.x - this.mesh.position.x;
    const dz = target.eye.z - this.mesh.position.z;
    const heading = Math.atan2(dx, dz);
    const inCone =
      this.#alert > 0 ||
      Math.abs(MathUtils.euclideanModulo(heading - this.yaw + Math.PI, Math.PI * 2) - Math.PI) <
        SIGHT_HALF_ANGLE;
    const sees =
      !ceasefire &&
      inCone &&
      Math.hypot(dx, dz) <= SIGHT_RANGE &&
      this.#hooks.worldHit(this.#from, target.eye) === undefined;
    this.#sightSeconds = sees ? this.#sightSeconds + dt : 0;
    // Turn toward what it sees, and back to its own front when it sees nothing.
    const wanted = sees ? heading : 0;
    const turn = MathUtils.euclideanModulo(wanted - this.yaw + Math.PI, Math.PI * 2) - Math.PI;
    this.figure.rotation.y += turn * Math.min(1, dt * TURN_RATE);
    const aimed = Math.abs(turn) <= AIM_TOLERANCE;

    for (let tick = this.#clock.step(dt); tick > 0; tick -= 1)
      this.#tick(ctx, sees && aimed && this.#sightSeconds >= REACTION_SECONDS, target);
    this.#present(dt);
  }

  #tick(ctx: GameCtx, canFire: boolean, target: ITarget): void {
    if (this.state === "hold") {
      if (!canFire || !ctx.startup.compileSettled) return;
      this.state = "burst";
      this.#ticks = toTicks(this.#range(BURST_SECONDS));
      this.#roundTicks = 0;
    }
    if (this.state === "burst") {
      if (!canFire || this.#ticks <= 0) {
        this.state = "gap";
        this.#ticks = toTicks(this.#range(BURST_GAP_SECONDS));
        return;
      }
      this.#ticks -= 1;
      if (this.#roundTicks > 0) this.#roundTicks -= 1;
      else {
        this.#roundTicks = ROUND_TICKS - 1;
        this.#fire(target);
      }
      return;
    }
    if (this.state === "gap") {
      this.#ticks -= 1;
      if (this.#ticks <= 0) this.state = "hold";
    }
  }

  #range(range: { readonly min: number; readonly max: number }): number {
    return range.min + (range.max - range.min) * this.#hooks.random();
  }

  /**
   * One round. A line to the chest that a wall or cover cuts is stopped there, whatever the
   * soldier's aim. A clear line then rolls the accuracy: a hit lands, a miss passes inside the cone.
   */
  #fire(target: ITarget): void {
    this.shots += 1;
    this.play("shoot", { fade: 0.05, hold: 0.12 });
    const yaw = this.yaw;
    this.#muzzle.set(
      this.mesh.position.x + Math.sin(yaw) * 0.6,
      MUZZLE_HEIGHT,
      this.mesh.position.z + Math.cos(yaw) * 0.6,
    );
    const toChest = this.#to.copy(target.chest).sub(this.#muzzle);
    const distance = toChest.length();
    toChest.normalize();
    const cover = this.#hooks.worldHit(this.#muzzle, target.chest);
    this.#tracerTimer = TRACER_TIME;
    if (cover !== undefined) {
      this.blocked += 1;
      this.#streak(toChest, cover);
      return;
    }
    const closing = target.velocity.x * toChest.x + target.velocity.z * toChest.z;
    this.accuracy = soldierAccuracy(distance, target.stance, closing);
    this.#hooks.aimed(this.accuracy);
    if (this.#hooks.random() < this.accuracy) {
      this.hits += 1;
      this.#hooks.hitPlayer(ROUND_DAMAGE);
      this.#streak(toChest, distance);
      return;
    }
    // A miss: the same line, turned aside by an angle inside the error cone.
    const angle =
      ((MISS_CONE.min + (MISS_CONE.max - MISS_CONE.min) * this.#hooks.random()) * Math.PI) / 180;
    const side = this.#hooks.random() < 0.5 ? -1 : 1;
    const c = Math.cos(angle * side);
    const s = Math.sin(angle * side);
    const missed = new Vector3(
      toChest.x * c - toChest.z * s,
      toChest.y,
      toChest.x * s + toChest.z * c,
    );
    this.#streak(missed, MAX_SHOT);
  }

  /** Draw a round's streak from the muzzle along `direction`, as far as the first wall. */
  #streak(direction: Vector3, reach: number): void {
    const end = this.#to
      .copy(direction)
      .multiplyScalar(Math.min(reach, MAX_SHOT))
      .add(this.#muzzle);
    const wall = this.#hooks.worldHit(this.#muzzle, end);
    if (wall !== undefined) end.copy(direction).multiplyScalar(wall).add(this.#muzzle);
    this.#tracer.aim(this.#muzzle.x, this.#muzzle.y, this.#muzzle.z, end.x, end.y, end.z);
  }

  #present(dt: number): void {
    this.#tracerTimer = Math.max(0, this.#tracerTimer - dt);
    this.#tracer.line.visible = this.#tracerTimer > 0;
    if (this.state === "dead") this.animateStill(dt);
    else {
      this.#body?.velocity.set(0, 0, 0);
      this.#body?.moveAndSlide(dt);
      this.animateRig(dt, undefined, 0);
    }
    const clip = this.character.current ?? "";
    if (clip !== this.#heldClip) {
      this.#heldClip = clip;
      const hold = RIFLE_HOLD[clip];
      if (hold !== undefined)
        this.#rifle.rotation.set(
          MathUtils.degToRad(hold[0]),
          MathUtils.degToRad(hold[1]),
          MathUtils.degToRad(hold[2]),
        );
    }
  }

  debug(): Record<string, unknown> {
    return {
      accuracy: Math.round(this.accuracy * 1000) / 1000,
      action: this.action,
      animation: this.animation,
      blocked: this.blocked,
      health: this.health,
      hits: this.hits,
      position: this.mesh.position.toArray(),
      shots: this.shots,
      state: this.state,
      yaw: Math.round(MathUtils.euclideanModulo(this.yaw, Math.PI * 2) * 1000) / 1000,
    };
  }

  dispose(): void {
    this.#body?.dispose();
    this.mesh.removeFromParent();
  }
}
