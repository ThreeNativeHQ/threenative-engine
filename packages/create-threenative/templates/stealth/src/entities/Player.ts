import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { MathUtils, Vector2, Vector3 } from "three";
import type { AlertDirector } from "../ai/phase.js";
import { KNOCK_NOISE, type NoiseBus, RUN_NOISE, angleBetween } from "../ai/perception.js";
import { dress, playerMaterial } from "../render/props.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { Stance } from "../state.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";
import {
  GUARD_LAYER,
  type Guard,
  HOLD_TIME,
  PLAYER_LAYER,
  PUMPS_TO_KNOCK_OUT,
  WORLD_LAYER,
} from "./Guard.js";

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  crouchIdle: "Crouch_Idle_Loop",
  crouchWalk: "Crouch_Fwd_Loop",
  death: "Death01",
  hit: "Hit_Chest",
  idle: "Idle_Loop",
  knock: "Interact",
  pickup: "PickUp_Table",
  pump: "Punch_Cross",
  run: "Jog_Fwd_Loop",
  walk: "Walk_Loop",
} as const;

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
/** Walking is silent; running is twice as fast and loud; crouching is slow and small. */
export const WALK_SPEED = 2;
export const RUN_SPEED = 4.6;
export const CROUCH_SPEED = 1.1;
const WALL_SLIDE_SPEED = 1.4;
const DRAG_SPEED = 1.2;
/** Seconds between running footsteps; each one is a `RUN_NOISE` metre noise. */
const STEP_INTERVAL = 0.32;
/**
 * Pushing into a wall this long presses the back to it. Reference: metal-gear-solid-1
 * `turn-before-run` — the wall-press switch counts down 3 frames (0.1 s at 30 Hz).
 */
const WALL_PRESS_DELAY = 0.1;
/** How far ahead of the capsule a wall still counts as "against" it, metres. */
const WALL_REACH = 0.3;
/** Grab reach and the arc behind a guard it works from (more than 110 degrees off its facing). */
export const GRAB_REACH = 1.3;
const BEHIND_ANGLE = (110 * Math.PI) / 180;
/** Reach for a pickup or the door, metres. Reference: metal-gear-solid-1 `item-pickup`, 500 units scaled 2.5x. */
export const PICKUP_REACH = 1.25;
/** A choked guard is held this far in front of the player. */
const HOLD_DISTANCE = 0.65;

export class Player extends Fighter {
  readonly body: CharacterBody3D;
  readonly maxHealth = 100;
  health = 100;
  dead = false;
  stance: Stance = "stand";
  running = false;
  /** The wall the back is pressed to: its outward normal on the floor plane. */
  readonly wallNormal = new Vector2();
  /** -1, 0 or 1: which way along the wall the player last slid, for the camera's corner peek. */
  peek = 0;
  /** The guard in the choke hold, and the pumps given so far. */
  held: Guard | undefined;
  pumps = 0;
  dragging: Guard | undefined;
  knocks = 0;
  takedowns = 0;
  /** The noise this tick made, metres; 0 when silent. The HUD draws it as a ring. */
  noise = 0;
  #holdTimer = 0;
  #stepTimer = 0;
  #pressTimer = 0;
  #crouched = false;
  readonly #from = new Vector3();
  readonly #to = new Vector3();
  readonly #move = new Vector2();

  constructor(ctx: GameCtx, model: IMannequin, spawn: Vector3) {
    super(ctx, model, CLIPS, { halfExtent: HALF_HEIGHT + RADIUS });
    dress(this.character.root, playerMaterial);
    this.mesh.position.copy(spawn);
    this.body = new CharacterBody3D({
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER | GUARD_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
  }

  update(
    ctx: GameCtx,
    dt: number,
    guards: readonly Guard[],
    director: AlertDirector,
    noises: NoiseBus,
    touch?: ITouchInput,
  ): void {
    this.noise = 0;
    if (this.dead) {
      this.animateStill(dt);
      return;
    }
    const move = this.#move.copy(ctx.input.vector("move"));
    if (touch !== undefined) {
      move.x += touch.move.x;
      move.y += touch.move.y;
      move.clampLength(0, 1);
    }
    if (ctx.input.justPressed("crouch")) this.#crouched = !this.#crouched;

    if (this.held !== undefined) {
      this.#choke(ctx, dt, director);
      return;
    }
    if (ctx.input.justPressed("cqc")) this.#tryGrab(guards);
    if (this.held !== undefined) {
      this.animateRig(dt, undefined, 0);
      return;
    }

    // Drag: hold interact beside a body. Release to drop it.
    if (ctx.input.pressed("interact")) {
      if (this.dragging === undefined) this.dragging = this.#bodyWithin(guards, PICKUP_REACH + 0.2);
    } else this.dragging = undefined;
    if (this.dragging !== undefined && this.dragging.state !== "down") this.dragging = undefined;

    this.running =
      ctx.input.pressed("run") &&
      !this.#crouched &&
      this.dragging === undefined &&
      move.lengthSq() > 0.01;
    this.#updateWallPress(ctx, dt, move);
    if (this.stance !== "wall") this.stance = this.#crouched ? "crouch" : "stand";

    let speed = this.running ? RUN_SPEED : this.#crouched ? CROUCH_SPEED : WALK_SPEED;
    if (this.dragging !== undefined) speed = DRAG_SPEED;
    if (this.stance === "wall") {
      // Slide along the wall: keep only the part of the stick that runs along it.
      const tangentX = -this.wallNormal.y;
      const tangentZ = this.wallNormal.x;
      const along = move.x * tangentX + -move.y * tangentZ;
      this.peek = Math.abs(along) > 0.2 ? Math.sign(along) : this.peek;
      this.body.velocity.set(
        tangentX * along * WALL_SLIDE_SPEED,
        0,
        tangentZ * along * WALL_SLIDE_SPEED,
      );
      if (ctx.input.justPressed("knock")) this.#knock(noises);
    } else {
      this.peek = 0;
      this.body.velocity.set(move.x * speed, 0, -move.y * speed);
    }
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);

    if (this.running) {
      this.#stepTimer -= dt;
      if (this.#stepTimer <= 0) {
        this.#stepTimer = STEP_INTERVAL;
        this.noise = RUN_NOISE;
        noises.post({
          x: this.mesh.position.x,
          z: this.mesh.position.z,
          radius: RUN_NOISE,
          source: "footstep",
        });
      }
    } else this.#stepTimer = 0;

    if (this.dragging !== undefined) {
      // The player walks backwards facing the body, so the body lies a metre in front of the
      // facing — behind the direction of travel.
      const yaw = this.figure.rotation.y;
      this.dragging.place(
        this.mesh.position.x + Math.sin(yaw) * 1.1,
        this.mesh.position.z + Math.cos(yaw) * 1.1,
        yaw + Math.PI,
      );
    }

    this.walkAction = this.running ? "run" : this.#crouched ? "crouchWalk" : "walk";
    this.idleAction = this.#crouched ? "crouchIdle" : "idle";
    const planar = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    if (this.stance === "wall" && planar < 0.05) {
      // Back to the wall: face out of it.
      this.figure.rotation.y = Math.atan2(this.wallNormal.x, this.wallNormal.y);
      this.animateRig(dt, undefined, 0);
    } else {
      const heading =
        this.dragging !== undefined
          ? Math.atan2(-this.body.velocity.x, -this.body.velocity.z) // walk backwards, pulling
          : Math.atan2(this.body.velocity.x, this.body.velocity.z);
      this.animateRig(dt, this.busy ? undefined : heading, planar);
    }
  }

  takeDamage(amount: number): void {
    if (this.dead) return;
    this.health = Math.max(0, this.health - amount);
    if (this.held !== undefined) this.#release();
    if (this.health > 0) {
      if (!this.busy) this.play("hit", { fade: 0.04, hold: 0.25 });
      return;
    }
    this.dead = true;
    this.dragging = undefined;
    this.play("death", { fade: 0.05, hold: Number.POSITIVE_INFINITY });
  }

  /** The guard a grab would take right now, or undefined: close, conscious, unaware, and its back turned. */
  grabTarget(guards: readonly Guard[]): Guard | undefined {
    for (const guard of guards) {
      if (!guard.conscious || guard.state === "alert") continue;
      const dx = this.mesh.position.x - guard.mesh.position.x;
      const dz = this.mesh.position.z - guard.mesh.position.z;
      if (Math.hypot(dx, dz) > GRAB_REACH) continue;
      if (Math.abs(angleBetween(Math.atan2(dx, dz), guard.yaw)) < BEHIND_ANGLE) continue;
      return guard;
    }
    return undefined;
  }

  #bodyWithin(guards: readonly Guard[], reach: number): Guard | undefined {
    for (const guard of guards) {
      if (guard.state !== "down") continue;
      if (this.mesh.position.distanceTo(guard.mesh.position) <= reach) return guard;
    }
    return undefined;
  }

  /** True while a downed guard lies within drag reach: what the HUD prompt reads. */
  canDrag(guards: readonly Guard[]): boolean {
    return (
      this.dragging === undefined && this.#bodyWithin(guards, PICKUP_REACH + 0.2) !== undefined
    );
  }

  #tryGrab(guards: readonly Guard[]): void {
    const target = this.grabTarget(guards);
    if (target === undefined) return;
    this.held = target;
    this.pumps = 0;
    this.#holdTimer = HOLD_TIME;
    this.#crouched = false;
    this.stance = "stand";
    target.grab();
    this.figure.rotation.y = Math.atan2(
      target.mesh.position.x - this.mesh.position.x,
      target.mesh.position.z - this.mesh.position.z,
    );
    this.#pinHeld();
  }

  /**
   * The choke: the guard is pinned in front, every press is a pump that refreshes the hold, and a
   * hold left alone for `HOLD_TIME` lets the guard break free — with the player in its face.
   */
  #choke(ctx: GameCtx, dt: number, director: AlertDirector): void {
    const held = this.held;
    if (held === undefined) return;
    this.body.velocity.set(0, 0, 0);
    this.body.moveAndSlide(dt);
    this.#holdTimer -= dt;
    if (ctx.input.justPressed("cqc")) {
      this.pumps += 1;
      this.#holdTimer = HOLD_TIME;
      this.play("pump", { fade: 0.05, hold: 0.3 });
      if (this.pumps >= PUMPS_TO_KNOCK_OUT) {
        held.knockOut();
        this.takedowns += 1;
        this.#release();
        this.animateRig(dt, undefined, 0);
        return;
      }
    }
    if (this.#holdTimer <= 0) {
      held.breakFree(director, this.mesh.position.x, this.mesh.position.z);
      this.#release();
    } else this.#pinHeld();
    this.animateRig(dt, undefined, 0);
  }

  #pinHeld(): void {
    const held = this.held;
    if (held === undefined) return;
    const yaw = this.figure.rotation.y;
    held.place(
      this.mesh.position.x + Math.sin(yaw) * HOLD_DISTANCE,
      this.mesh.position.z + Math.cos(yaw) * HOLD_DISTANCE,
      yaw,
    );
  }

  #release(): void {
    this.held = undefined;
    this.pumps = 0;
    this.#holdTimer = 0;
  }

  /**
   * Back to the wall when the stick has pushed into one for `WALL_PRESS_DELAY`; off it as soon as
   * the stick pulls away. Never while running, crouched or dragging — those keep their own stance.
   */
  #updateWallPress(ctx: GameCtx, dt: number, move: Vector2): void {
    if (this.stance === "wall") {
      const away = move.x * this.wallNormal.x + -move.y * this.wallNormal.y;
      if (away > 0.4 || this.#crouched || this.running || this.dragging !== undefined) {
        this.stance = this.#crouched ? "crouch" : "stand";
      }
      return;
    }
    if (this.running || this.#crouched || this.dragging !== undefined || move.lengthSq() < 0.25) {
      this.#pressTimer = 0;
      return;
    }
    const length = Math.hypot(move.x, move.y);
    this.#from.copy(this.mesh.position);
    this.#from.y = 1.2;
    this.#to.set(
      this.#from.x + (move.x / length) * (RADIUS + WALL_REACH),
      1.2,
      this.#from.z - (move.y / length) * (RADIUS + WALL_REACH),
    );
    const hit = ctx.physics.directSpaceState.intersectRay({
      collisionMask: WORLD_LAYER,
      from: this.#from,
      to: this.#to,
    });
    // Only a near-vertical face is a wall: the top of a crate is not.
    if (hit === undefined || Math.abs(hit.normal.y) > 0.3) {
      this.#pressTimer = 0;
      return;
    }
    this.#pressTimer += dt;
    if (this.#pressTimer < WALL_PRESS_DELAY) return;
    this.#pressTimer = 0;
    this.stance = "wall";
    this.wallNormal.set(hit.normal.x, hit.normal.z).normalize();
  }

  /** A knuckle on the wall: a noise the nearest guards walk over to check. */
  #knock(noises: NoiseBus): void {
    this.knocks += 1;
    this.noise = KNOCK_NOISE;
    noises.post({
      x: this.mesh.position.x - this.wallNormal.x * 0.4,
      z: this.mesh.position.z - this.wallNormal.y * 0.4,
      radius: KNOCK_NOISE,
      source: "knock",
    });
    this.play("knock", { fade: 0.08, hold: 0.45 });
  }

  /** Bend down for the keycard. */
  pickUp(): void {
    this.play("pickup", { fade: 0.08, hold: 0.6, fit: true });
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      animation: this.animation,
      dragging: this.dragging?.id ?? "",
      groundClearance: this.conventions.groundSnap.clearance,
      health: this.health,
      held: this.held?.id ?? "",
      knocks: this.knocks,
      normaliseFactor: this.conventions.normaliseFactor,
      peek: this.peek,
      position: this.mesh.position.toArray(),
      pumps: this.pumps,
      running: this.running,
      stance: this.stance,
      takedowns: this.takedowns,
      yaw: Math.round(MathUtils.euclideanModulo(this.figure.rotation.y, Math.PI * 2) * 1000) / 1000,
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
