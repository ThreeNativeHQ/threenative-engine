import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { type Material, Vector3 } from "three";
import type { RoomId } from "../level.js";
import {
  Actor,
  type GameCtx,
  HALF_HEIGHT,
  HOSTILE_LAYER,
  type IMannequin,
  PLAYER_LAYER,
  RADIUS,
  WORLD_LAYER,
  headingTo,
} from "./Actor.js";
import type { Survivor } from "./Survivor.js";

const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  grab: "Interact",
  hit: "Hit_Chest",
  down: "Death01",
} as const;

// Awareness (resident-evil-4 `ai-awareness`): a 60-degree half-angle wedge out to 6 m in front,
// bare proximity regardless of facing (3.5 m there; 2.5 m here, the rooms are small), footsteps
// heard at 5 m but only a running survivor makes them, and a gunshot wakes the whole room.
const SIGHT_RANGE = 6;
const SIGHT_HALF_ANGLE = Math.PI / 3;
const NEAR_RANGE = 2.5;
const HEARING_RANGE = 5;
/** Shamble, m/s, with a lurch: speed swings around this on the walk cycle's own rhythm. */
const SHAMBLE = 0.55;
const RISEN_SHAMBLE = 0.75;
const LURCH = 0.45;
/** Turn toward prey, rad/s: slower than a person, so circling a zombie is how you pass it. */
const TURN = 1.8;
/** Centre-to-centre reach of the lunge, and the cone in front it closes in. */
const GRAB_RANGE = 0.95;
const GRAB_HALF_ANGLE = Math.PI / 5;
/** A hold lasts this long unless the survivor struggles; each press takes `STRUGGLE` off it. */
const HOLD = 2.2;
const STRUGGLE = 0.4;
/** The bite lands this far into a hold, so a fast struggle escapes it. */
const BITE_AT = 1;
const BITE = 20;
/** After a hold the next lunge waits 45 frames at 30 Hz (`ai-approach`, the middle band). */
const ATTACK_COOLDOWN = 1.5;
/** A handgun round rocks a zombie back for this long; the walk resumes after. */
const STAGGER = 0.6;
const STAGGER_PUSH = 0.6;
/** Down, then up again: the riser waits this long on the floor, and comes back with half its health. */
const RISE_DELAY = 7;
const RISE_TIME = 1.4;
export const ZOMBIE_HEALTH = 90;

export type ZombieState = "idle" | "shamble" | "grab" | "stagger" | "down" | "rising" | "dead";

export class Zombie extends Actor {
  readonly room: RoomId;
  readonly rises: boolean;
  state: ZombieState = "idle";
  health = ZOMBIE_HEALTH;
  aware = false;
  heardShot = false;
  rose = false;
  bites = 0;
  escapes = 0;
  hitsTaken = 0;
  /** Physics body id while standing; the map in `Play` routes ray hits through it. */
  bodyId = -1;
  #body: CharacterBody3D | undefined;
  #ctx: GameCtx;
  #timer = 0;
  #cooldown = 0;
  #holdLeft = 0;
  #held = 0;
  #bitten = false;
  #phase = 0;
  /** Unit push away from the gun while staggering. */
  #push = new Vector3();
  #eye = new Vector3();
  #prey = new Vector3();
  #forward = new Vector3();

  constructor(
    ctx: GameCtx,
    model: IMannequin,
    material: Material,
    spawn: {
      readonly room: RoomId;
      readonly at: readonly [number, number];
      readonly facing: number;
      readonly rises?: boolean;
    },
  ) {
    super(ctx, model, Object.values(CLIPS), { material });
    this.#ctx = ctx;
    this.room = spawn.room;
    this.rises = spawn.rises === true;
    this.heading = spawn.facing;
    this.mesh.position.set(spawn.at[0], HALF_HEIGHT + RADIUS + 0.02, spawn.at[1]);
    // Every zombie starts out of step with the others, or a room of them sways as one.
    this.#phase = (spawn.at[0] * 7.31 + spawn.at[1] * 3.17) % (Math.PI * 2);
    this.play(CLIPS.idle, { fade: 0 });
    this.#stand();
  }

  get standing(): boolean {
    return this.state !== "down" && this.state !== "dead" && this.state !== "rising";
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  /** A shot was fired in this room. */
  hear(): void {
    if (!this.alive) return;
    this.heardShot = true;
    this.aware = true;
  }

  update(dt: number, survivor: Survivor, survivorRoom: RoomId | undefined): void {
    this.#timer -= dt;
    this.#cooldown = Math.max(0, this.#cooldown - dt);
    this.#phase += dt;
    let speed = 0;
    const sameRoom = survivorRoom === this.room && !survivor.dead;
    switch (this.state) {
      case "idle":
        if (sameRoom && this.#senses(survivor)) this.aware = true;
        if (this.aware && sameRoom) this.state = "shamble";
        this.play(CLIPS.idle, { fade: 0.3 });
        break;
      case "shamble": {
        if (!sameRoom) {
          // Prey that left through a door is gone: the classic zombie never follows.
          this.state = "idle";
          break;
        }
        const to = headingTo(this.mesh.position, survivor.mesh.position);
        const left = this.turnToward(to, TURN, dt);
        const distance = this.mesh.position.distanceTo(survivor.mesh.position);
        if (
          distance <= GRAB_RANGE &&
          Math.abs(left) <= GRAB_HALF_ANGLE &&
          this.#cooldown <= 0 &&
          survivor.grabbable
        ) {
          this.#startGrab(survivor);
          break;
        }
        const base = this.rose ? RISEN_SHAMBLE : SHAMBLE;
        // Never walk into the survivor's capsule: stop at the reach and keep turning.
        speed = distance > GRAB_RANGE * 0.9 ? base * (1 + LURCH * Math.sin(this.#phase * 4.7)) : 0;
        this.play(speed > 0 ? CLIPS.walk : CLIPS.idle, { fade: 0.25 });
        break;
      }
      case "grab":
        this.#hold(dt, survivor);
        break;
      case "stagger":
        speed = STAGGER_PUSH * Math.max(0, this.#timer / STAGGER);
        if (this.#timer <= 0) this.state = this.aware ? "shamble" : "idle";
        break;
      case "down":
        if (this.rises && !this.rose && this.#timer <= 0) {
          this.state = "rising";
          this.#timer = RISE_TIME;
          // A long fade from the floor pose to standing reads as the body hauling itself up.
          this.play(CLIPS.idle, { fade: RISE_TIME });
        }
        break;
      case "rising":
        if (this.#timer <= 0) {
          this.rose = true;
          this.aware = true;
          this.health = Math.round(ZOMBIE_HEALTH / 2);
          this.state = "shamble";
          this.#stand();
        }
        break;
      case "dead":
        break;
    }
    const body = this.#body;
    if (body !== undefined) {
      this.facingVector(this.#forward);
      // A stagger is shoved along the shot, whatever way the body faces; otherwise it walks.
      const push = this.state === "stagger" ? this.#push : this.#forward;
      body.velocity.x = push.x * speed;
      body.velocity.z = push.z * speed;
      body.moveAndSlide(dt);
    }
    this.conventions.applyGrounding(0, dt);
    this.animate(dt);
  }

  #senses(survivor: Survivor): boolean {
    const distance = this.mesh.position.distanceTo(survivor.mesh.position);
    if (distance <= NEAR_RANGE) return true;
    if (distance <= HEARING_RANGE && survivor.running) return true;
    if (distance > SIGHT_RANGE) return false;
    const off = Math.abs(
      angleOff(this.heading, headingTo(this.mesh.position, survivor.mesh.position)),
    );
    if (off > SIGHT_HALF_ANGLE) return false;
    const hit = this.#ctx.physics.directSpaceState.intersectRay({
      collisionMask: WORLD_LAYER,
      from: this.#eye.copy(this.mesh.position).setY(this.mesh.position.y + 0.6),
      to: this.#prey.copy(survivor.mesh.position).setY(survivor.mesh.position.y + 0.6),
    });
    return hit === undefined;
  }

  #startGrab(survivor: Survivor): void {
    this.state = "grab";
    this.#holdLeft = HOLD;
    this.#held = 0;
    this.#bitten = false;
    survivor.grab(this);
    this.play(CLIPS.grab, { fade: 0.08, mode: "once", restart: true });
  }

  #hold(dt: number, survivor: Survivor): void {
    this.#held += dt;
    this.#holdLeft -= dt;
    if (!this.#bitten && this.#held >= BITE_AT && this.#holdLeft > 0) {
      this.#bitten = true;
      this.bites += 1;
      survivor.takeDamage(BITE);
    }
    if (survivor.dead || survivor.state !== "held") {
      this.#endGrab(survivor);
      return;
    }
    if (this.#holdLeft <= 0) {
      if (!this.#bitten) this.escapes += 1;
      this.#endGrab(survivor);
      // Shoved off: the zombie reels back before it comes again.
      this.#pushFrom(survivor);
      this.state = "stagger";
      this.#timer = STAGGER * 1.5;
      this.play(CLIPS.hit, { fade: 0.05, mode: "once", restart: true });
    }
  }

  #endGrab(survivor: Survivor): void {
    survivor.release();
    this.#cooldown = ATTACK_COOLDOWN;
    this.state = this.aware ? "shamble" : "idle";
  }

  /** One struggle press from the survivor this zombie holds. */
  struggle(): void {
    if (this.state === "grab") this.#holdLeft -= STRUGGLE;
  }

  /**
   * A handgun round. Standing, it staggers; at zero it goes down, and the riser's first fall is
   * not the last. A critical (aimed high, close) takes the head and ends it outright.
   */
  takeHit(amount: number, critical: boolean, survivor: Survivor): void {
    if (!this.alive || this.state === "rising") return;
    this.aware = true;
    this.hitsTaken += 1;
    if (this.state === "down") {
      this.health -= amount;
      if (this.health <= 0) this.#die();
      return;
    }
    if (this.state === "grab") this.#endGrab(survivor);
    this.#pushFrom(survivor);
    this.health = critical ? 0 : this.health - amount;
    if (this.health > 0) {
      this.state = "stagger";
      this.#timer = STAGGER;
      this.play(CLIPS.hit, { fade: 0.04, mode: "once", restart: true });
      return;
    }
    this.health = 0;
    this.#fall();
    if (critical || !this.rises || this.rose) this.#die();
    else {
      // The floor is where it waits: give it some health back to finish off with the gun aimed low.
      this.state = "down";
      this.health = 25;
      this.#timer = RISE_DELAY;
    }
  }

  #pushFrom(survivor: Survivor): void {
    this.#push.subVectors(this.mesh.position, survivor.mesh.position).setY(0);
    if (this.#push.lengthSq() < 1e-6) this.facingVector(this.#push).negate();
    this.#push.normalize();
  }

  #fall(): void {
    this.#body?.dispose();
    this.#body = undefined;
    this.bodyId = -1;
    this.play(CLIPS.down, { fade: 0.06, mode: "once" });
  }

  #die(): void {
    if (this.#body !== undefined) this.#fall();
    this.state = "dead";
    this.health = 0;
  }

  #stand(): void {
    if (this.#body !== undefined) return;
    this.#body = new CharacterBody3D({
      collisionLayer: HOSTILE_LAYER,
      collisionMask: WORLD_LAYER | PLAYER_LAYER | HOSTILE_LAYER,
      object: this.mesh,
      physics: this.#ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
    this.bodyId = this.#body.body.id;
  }

  debug(): Record<string, unknown> {
    return {
      action: this.clip,
      animation: this.animation,
      aware: this.aware,
      bites: this.bites,
      escapes: this.escapes,
      health: this.health,
      heardShot: this.heardShot,
      hitsTaken: this.hitsTaken,
      position: this.mesh.position.toArray(),
      rose: this.rose,
      state: this.state,
    };
  }

  dispose(): void {
    this.#body?.dispose();
    this.mesh.removeFromParent();
  }
}

function angleOff(from: number, to: number): number {
  const delta = (((to - from + Math.PI) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return delta - Math.PI;
}
