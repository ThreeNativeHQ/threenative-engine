import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { type ICreatureRig, createFlicker } from "../render/creatures.js";
import { type GameCtx, type Hero, LAYER } from "./Hero.js";
import type { ITarget } from "./LockOn.js";

/** Set by `@threenative/playtest` on an entity a scenario placed with `frozen: true`. */
const PLAYTEST_FROZEN = "__threenativeFrozen";

/** The Flicker's numbers, in metres and seconds. Kit design values. */
export const FLICKER_FEEL = {
  aggroRange: 7,
  leash: 12,
  /** Its body's height over the floor while it hovers and circles. */
  hover: 1.9,
  orbitRadius: 3.6,
  /** Radians per second round Wren. */
  orbitSpeed: 1.3,
  circleTime: 2.2,
  /** Wings spread, eyes red, hold: the tell before the swoop. */
  telegraph: 0.6,
  swoopSpeed: 8,
  swoopTime: 0.9,
  /** Its body's height at the bottom of the dive: Wren's chest. */
  swoopLow: 0.9,
  climbTime: 0.8,
  /** A swoop the shield turns stuns it this long, low enough to cut. */
  dazed: 1,
  health: 2,
  hitRange: 0.8,
} as const;

export type FlickerState = "idle" | "circle" | "telegraph" | "swoop" | "climb" | "hurt" | "dead";

/**
 * A bat that circles Wren out of reach, then telegraphs and swoops through where she stood. The
 * swoop costs a half-heart unless the shield turns it, which knocks it down dazed. It flies: its
 * body has no gravity, and it steers by setting the velocity that carries it to this step's goal.
 */
export class Flicker implements ITarget {
  readonly mesh = new Group();
  readonly rig: ICreatureRig;
  readonly radius = 0.36;
  readonly tags = ["hostile"];
  body: CharacterBody3D | undefined;
  state: FlickerState = "idle";
  health: number = FLICKER_FEEL.health;
  telegraphs = 0;
  swoops = 0;
  /** Swoops that cost Wren a half-heart, and swoops her shield turned. */
  struck = 0;
  bounced = 0;
  #home = new Vector3();
  #floor = 0;
  #timer = 0;
  #flash = 0;
  #angle = 0;
  #landed = false;
  #heading = new Vector3();
  #goal = new Vector3();
  #to = new Vector3();

  constructor(
    readonly id: string,
    at: Vector3,
  ) {
    this.rig = createFlicker();
    this.mesh.add(this.rig.group);
    this.mesh.position.set(at.x, at.y + FLICKER_FEEL.hover, at.z);
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get bodyId(): number | undefined {
    return this.body?.body.id;
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.mesh.rotation.set(0, 0, 0);
    this.#home.copy(this.mesh.position);
    this.#floor = this.mesh.position.y - FLICKER_FEEL.hover;
    this.body = new CharacterBody3D({
      collisionLayer: LAYER.foe,
      collisionMask: LAYER.world,
      entity: this.id,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.sphere(0.3),
    });
  }

  hurt(damage: number, from: Vector3): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    this.#flash = 0.25;
    this.#heading.subVectors(this.mesh.position, from).setY(0).normalize();
    this.#set(this.health <= 0 ? "dead" : "hurt");
    return true;
  }

  update(dt: number, hero: Hero): void {
    const body = this.body;
    if (body === undefined) return;
    const feel = FLICKER_FEEL;
    this.#timer += dt;
    this.#flash = Math.max(0, this.#flash - dt);
    const at = this.mesh.position;
    const heroAt = hero.mesh.position;
    this.#to.subVectors(heroAt, at).setY(0);
    const distance = this.#to.length();
    const hunting =
      hero.alive &&
      this.mesh.userData[PLAYTEST_FROZEN] !== true &&
      heroAt.distanceTo(this.#home) < feel.leash;
    const high = this.#floor + feel.hover;
    this.#goal.copy(this.#home);
    switch (this.state) {
      case "idle":
        if (hunting && distance < feel.aggroRange) {
          this.#angle = Math.atan2(at.x - heroAt.x, at.z - heroAt.z);
          this.#set("circle");
        }
        break;
      case "circle":
      case "climb":
        if (!hunting) {
          this.#set("idle");
          break;
        }
        this.#angle += feel.orbitSpeed * dt;
        this.#goal.set(
          heroAt.x + Math.sin(this.#angle) * feel.orbitRadius,
          high,
          heroAt.z + Math.cos(this.#angle) * feel.orbitRadius,
        );
        if (this.state === "climb" ? this.#timer > feel.climbTime : this.#timer > feel.circleTime) {
          this.telegraphs += 1;
          this.#set("telegraph");
        }
        break;
      case "telegraph":
        this.#goal.set(at.x, high + 0.3, at.z);
        if (this.#timer > feel.telegraph) {
          this.#heading.copy(this.#to).normalize();
          this.#landed = false;
          this.swoops += 1;
          this.#set("swoop");
        }
        break;
      case "swoop": {
        // Straight through where Wren stood, dropping to her chest at the middle of the dive.
        const u = this.#timer / feel.swoopTime;
        this.#goal
          .copy(at)
          .addScaledVector(this.#heading, feel.swoopSpeed * dt)
          .setY(this.#floor + MathUtils.lerp(feel.swoopLow, feel.hover, (2 * u - 1) ** 2));
        if (!this.#landed && distance < feel.hitRange && Math.abs(at.y - heroAt.y) < 0.9) {
          this.#landed = true;
          if (hero.takeHit(1, at) === "blocked") {
            this.bounced += 1;
            this.#heading.negate();
            this.#set("hurt");
            this.#timer = 0.4 - feel.dazed;
            break;
          }
          this.struck += 1;
        }
        if (u >= 1) {
          this.#angle = Math.atan2(at.x - heroAt.x, at.z - heroAt.z);
          this.#set("climb");
        }
        break;
      }
      case "hurt":
        // Knocked back and down; it spins, then climbs back to the circle.
        this.#goal.copy(at).addScaledVector(this.#heading, 2 * dt);
        this.#goal.y = this.#floor + feel.swoopLow;
        if (this.#timer > 0.4) {
          this.#angle = Math.atan2(at.x - heroAt.x, at.z - heroAt.z);
          this.#set("climb");
        }
        break;
      case "dead":
        this.#goal.set(at.x, this.#floor, at.z);
        if (this.#timer > 0.8) {
          body.dispose();
          this.body = undefined;
          this.mesh.visible = false;
          return;
        }
        break;
    }
    // Fly to this step's goal: the swoop at its own speed, everything else eased.
    const rate = this.state === "swoop" || this.state === "hurt" ? 1 / dt : 3;
    body.velocity.set(
      (this.#goal.x - at.x) * rate,
      (this.#goal.y - at.y) * (this.state === "swoop" ? 1 / dt : 3),
      (this.#goal.z - at.z) * rate,
    );
    body.moveAndSlide(dt);
    if (distance > 0.01 && this.state !== "dead") {
      const yaw =
        this.state === "swoop"
          ? Math.atan2(this.#heading.x, this.#heading.z)
          : Math.atan2(this.#to.x, this.#to.z);
      const gap =
        MathUtils.euclideanModulo(yaw - this.rig.group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
      this.rig.group.rotation.y += gap * Math.min(1, dt * 8);
    }
    const span = this.state === "telegraph" ? feel.telegraph : this.state === "hurt" ? 0.4 : 0.8;
    this.rig.update(dt, this.state, Math.min(1, Math.max(0, this.#timer) / span), this.#flash);
  }

  debug(): Record<string, unknown> {
    return {
      bounced: this.bounced,
      health: this.health,
      position: this.mesh.position.toArray(),
      state: this.state,
      struck: this.struck,
      swoops: this.swoops,
      telegraphs: this.telegraphs,
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.mesh.removeFromParent();
  }

  #set(state: FlickerState): void {
    this.state = state;
    this.#timer = 0;
  }
}
