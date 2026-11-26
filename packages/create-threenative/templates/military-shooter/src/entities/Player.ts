import type { ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, type PerspectiveCamera, Vector3 } from "three";
import { SPAWN } from "../level.js";
import {
  SPRINT_SPEED_SCALE,
  SPRINT_STRAFE_SCALE,
  STANCES,
  type Stance,
  SprintBudget,
  groundMove,
} from "../rules/movement.js";
import { Vitals } from "../rules/vitals.js";
import { RIFLE, ViewKick, shotOffset, spreadDegrees, stepSpread } from "../rules/weapon.js";
import type { GameState } from "../state.js";
import { PLAYER_LAYER, SOLDIER_LAYER, WORLD_LAYER } from "./Soldier.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
const LOOK_SENSITIVITY = 0.0022;
/** Game-owned: pitch stops 85 degrees up and down. */
const PITCH_LIMIT = MathUtils.degToRad(85);
/** How fast the eye settles on a new stance, per second. */
const EYE_RATE = 11;
/** Walking while looking down the sights is slower: game-owned. */
const ADS_SPEED_SCALE = 0.6;
/** The chest is four fifths of the eye height: 1.2 m standing, 0.8 m crouched, 0.2 m prone. */
const CHEST_OF_EYE = 0.8;
const GRENADES = 3;
/** Seconds after a throw before the next one, and before sprint may start again. */
const THROW_SECONDS = 0.8;

export class Player {
  readonly mesh = new Group();
  readonly body: CharacterBody3D;
  readonly vitals = new Vitals();
  readonly sprint = new SprintBudget();
  readonly kick = new ViewKick();
  yaw: number = SPAWN.yaw;
  pitch = 0;
  stance: Stance = "stand";
  /** The eye's height now, eased toward the stance's. */
  eyeHeight: number = STANCES.stand.eye;
  /** 0 at the hip, 1 on the sights. */
  ads = 0;
  spreadPoints = 0;
  spread: number = spreadDegrees(0, STANCES.stand.eye, false);
  ammo: number = RIFLE.magazine;
  reserve: number = RIFLE.reserve;
  /** Seconds left in the reload, 0 when not reloading. */
  reload = 0;
  grenades = GRENADES;
  shots = 0;
  hitsTaken = 0;
  /** Seconds until the next round, and until the next throw. */
  #cooldown = 0;
  #throw = 0;
  readonly #eye = new Vector3();
  readonly #chest = new Vector3();
  readonly #aim = new Vector3();
  readonly #velocity = { x: 0, z: 0 };

  constructor(ctx: GameCtx) {
    this.mesh.name = "player";
    this.mesh.position.set(SPAWN.x, HALF_HEIGHT + RADIUS, SPAWN.z);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER | SOLDIER_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  get dead(): boolean {
    return this.vitals.dead;
  }

  get speed(): number {
    return Math.hypot(this.#velocity.x, this.#velocity.z);
  }

  get eye(): Vector3 {
    return this.#eye.set(this.mesh.position.x, this.eyeHeight, this.mesh.position.z);
  }

  get chest(): Vector3 {
    return this.#chest.set(
      this.mesh.position.x,
      this.eyeHeight * CHEST_OF_EYE,
      this.mesh.position.z,
    );
  }

  get velocity(): { readonly x: number; readonly z: number } {
    return this.#velocity;
  }

  /** Put the player at a world point (a playtest station). */
  place(x: number, z: number, yaw: number): void {
    this.mesh.position.set(x, this.mesh.position.y, z);
    this.body.teleport(this.mesh.position);
    this.yaw = yaw;
    this.pitch = 0;
    this.#velocity.x = 0;
    this.#velocity.z = 0;
  }

  hurt(amount: number): void {
    this.vitals.hurt(amount);
    this.hitsTaken += 1;
  }

  /** Where the view points now, kick included. A shot leaves along it. */
  #viewDirection(out: Vector3): Vector3 {
    const yaw = this.yaw + MathUtils.degToRad(this.kick.yaw);
    const pitch = this.pitch + MathUtils.degToRad(this.kick.pitch);
    return out.set(
      -Math.sin(yaw) * Math.cos(pitch),
      Math.sin(pitch),
      -Math.cos(yaw) * Math.cos(pitch),
    );
  }

  /** The unit direction a throw leaves along. */
  throwDirection(out: Vector3): Vector3 {
    return this.#viewDirection(out);
  }

  update(ctx: GameCtx, dt: number): void {
    const input = ctx.input;
    this.vitals.update(dt);
    if (this.dead) {
      this.body.velocity.set(0, 0, 0);
      this.body.moveAndSlide(dt);
      return;
    }
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.#throw = Math.max(0, this.#throw - dt);
    this.reload = Math.max(0, this.reload - dt);
    if (this.reload === 0 && this.#reloading) this.#finishReload();

    // Look. The framework owns the pointer lock and hands over the pixels moved this tick.
    let turn = 0;
    if (ctx.input.raw.pointer.captured) {
      const look = input.vector("look");
      const scale = LOOK_SENSITIVITY * MathUtils.lerp(1, 0.6, this.ads);
      this.yaw -= look.x * scale;
      this.pitch = MathUtils.clamp(this.pitch - look.y * scale, -PITCH_LIMIT, PITCH_LIMIT);
      turn = MathUtils.radToDeg(Math.hypot(look.x, look.y) * scale) / dt;
    }

    const move = input.vector("move");
    const peak = Math.max(Math.abs(move.x), Math.abs(move.y));
    // The forward axis is the deflection of the forward key alone, so a diagonal still sprints.
    const forward = peak > 0 ? Math.max(0, move.y) / peak : 0;
    const wantsAim = input.pressed("aim");
    const blocked = input.pressed("fire") || wantsAim || this.#reloading || this.#throw > 0;
    if (
      input.pressed("sprint") &&
      forward > 0.8 &&
      !blocked &&
      this.stance !== "stand" &&
      this.sprint.seconds > 1
    )
      this.stance = "stand";
    this.sprint.update(input.pressed("sprint"), forward, blocked || this.stance !== "stand", dt);

    if (!this.sprint.active) {
      if (input.justPressed("crouch")) this.stance = this.stance === "crouch" ? "stand" : "crouch";
      if (input.justPressed("prone")) this.stance = this.stance === "prone" ? "stand" : "prone";
    }
    const stance = STANCES[this.stance];
    this.eyeHeight = MathUtils.damp(this.eyeHeight, stance.eye, EYE_RATE, dt);

    // Movement along the view's yaw.
    const sprinting = this.sprint.active;
    const right = move.x * (sprinting ? SPRINT_STRAFE_SCALE : 1);
    const wishX = -Math.sin(this.yaw) * move.y + Math.cos(this.yaw) * right;
    const wishZ = -Math.cos(this.yaw) * move.y - Math.sin(this.yaw) * right;
    const length = Math.hypot(wishX, wishZ);
    const wishSpeed =
      stance.speed *
      (sprinting ? SPRINT_SPEED_SCALE : 1) *
      (this.ads > 0.5 ? ADS_SPEED_SCALE : 1) *
      Math.min(1, length);
    const velocity = this.#velocity;
    groundMove(
      velocity,
      length > 1e-4 ? wishX / length : 0,
      length > 1e-4 ? wishZ / length : 0,
      wishSpeed,
      stance.accel,
      dt,
    );
    this.body.velocity.set(velocity.x, 0, velocity.z);
    this.body.moveAndSlide(dt);

    // Down the sights: eased over the first-person field-of-view blend, 0.18 s.
    const aiming = wantsAim && !sprinting && !this.#reloading;
    this.ads = MathUtils.clamp(this.ads + (aiming ? dt : -dt) / RIFLE.fovSeconds, 0, 1);
    this.spreadPoints = stepSpread(this.spreadPoints, turn, this.speed, dt);
    this.spread = spreadDegrees(this.spreadPoints, this.eyeHeight, this.ads > 0.5);
    this.kick.recover(dt, this.ads > 0.5 ? RIFLE.centring.ads : RIFLE.centring.hip);
    if (input.justPressed("reload")) this.startReload();
  }

  get #reloading(): boolean {
    return this.reload > 0;
  }

  startReload(): void {
    if (this.#reloading || this.ammo >= RIFLE.magazine || this.reserve <= 0) return;
    this.reload = RIFLE.reloadSeconds;
  }

  #finishReload(): void {
    const taken = Math.min(RIFLE.magazine - this.ammo, this.reserve);
    this.ammo += taken;
    this.reserve -= taken;
  }

  /** The unit direction of the next round if the trigger is down, or undefined when it cannot fire. */
  fire(random: () => number): { origin: Vector3; direction: Vector3 } | undefined {
    if (this.dead || this.#cooldown > 0 || this.#reloading || this.sprint.active) return undefined;
    if (this.ammo <= 0) {
      this.startReload();
      return undefined;
    }
    this.ammo -= 1;
    this.shots += 1;
    this.#cooldown = RIFLE.interval;
    const direction = this.#viewDirection(this.#aim);
    // The offset is in the view's own right and up, perpendicular to the direction.
    const right = new Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const up = new Vector3().crossVectors(right, direction).normalize();
    const offset = shotOffset(this.spread, random);
    direction.addScaledVector(right, offset.right).addScaledVector(up, offset.up).normalize();
    const scale = this.ads > 0.5 ? RIFLE.adsKickScale : 1;
    this.kick.add(RIFLE.kickPitch * scale, (random() * 2 - 1) * RIFLE.kickYaw * scale);
    return { direction: direction.clone(), origin: this.eye.clone() };
  }

  /** True when a grenade may leave the hand, and it counts one. */
  tryThrow(): boolean {
    if (this.dead || this.grenades <= 0 || this.#throw > 0) return false;
    this.grenades -= 1;
    this.#throw = THROW_SECONDS;
    return true;
  }

  get throwing(): boolean {
    return this.#throw > 0;
  }

  /** Place the camera on the solved body, with the kick on the view and the field of view on the blend. */
  syncCamera(camera: PerspectiveCamera): void {
    camera.position.copy(this.eye);
    camera.rotation.set(
      this.pitch + MathUtils.degToRad(this.kick.pitch),
      this.yaw + MathUtils.degToRad(this.kick.yaw),
      0,
      "YXZ",
    );
    const fov = MathUtils.lerp(RIFLE.hipFov, RIFLE.adsFov, this.ads);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
  }

  debug(): Record<string, unknown> {
    return {
      ads: Math.round(this.ads * 1000) / 1000,
      eyeHeight: Math.round(this.eyeHeight * 1000) / 1000,
      health: this.vitals.health,
      position: this.mesh.position.toArray(),
      shield: Math.round(this.vitals.shield * 10) / 10,
      speed: Math.round(this.speed * 1000) / 1000,
      stance: this.stance,
      yaw: this.yaw,
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
