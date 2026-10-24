import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { type ICreatureRig, createWarden } from "../render/creatures.js";
import { type GameCtx, type Hero, LAYER } from "./Hero.js";
import type { ITarget } from "./LockOn.js";

const CAPSULE = { halfHeight: 0.55, radius: 0.75 } as const;
const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;

/** The Warden's numbers, in metres and seconds. Kit design values. */
export const WARDEN_FEEL = {
  health: 3,
  /** It wakes when Wren is this close. */
  wakeRange: 13,
  /** Rearing back before the charge: the tell. */
  windup: 1.1,
  chargeSpeed: 8,
  /** The longest charge, in case it never meets a wall. */
  chargeTime: 3,
  /** Dazed after it meets a wall: the only time a cut lands. */
  stunTime: 3,
  recover: 0.8,
  /** A charge that meets Wren costs a full heart unless the shield takes it. */
  hitHalves: 2,
} as const;

export type WardenState = "dormant" | "windup" | "charge" | "stunned" | "recover" | "dead";

/**
 * The Stone Warden. It rears, then charges in a straight line at where Wren stood. A charge that
 * meets a wall stuns it, and only a stunned Warden takes damage: a cut while it is standing clanks
 * off. Each cut that lands ends the stun. Three stuns, each answered with a cut, defeat it.
 */
export class Warden implements ITarget {
  readonly mesh = new Group();
  readonly rig: ICreatureRig;
  readonly radius = CAPSULE.radius;
  readonly height = 3;
  readonly tags = ["hostile", "boss"];
  body: CharacterBody3D | undefined;
  state: WardenState = "dormant";
  health: number = WARDEN_FEEL.health;
  stuns = 0;
  clanks = 0;
  #timer = 0;
  #flash = 0;
  #heading = new Vector3();
  #last = new Vector3();

  constructor(
    readonly id: string,
    at: Vector3,
  ) {
    this.rig = createWarden();
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.add(this.rig.group);
    this.mesh.position.set(at.x, at.y + FOOT_OFFSET, at.z);
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get bodyId(): number | undefined {
    return this.body?.body.id;
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      collisionLayer: LAYER.foe,
      collisionMask: LAYER.world | LAYER.foe,
      entity: this.id,
      gravity: -20,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE.halfHeight, CAPSULE.radius),
    });
  }

  hurt(damage: number): boolean {
    if (!this.alive) return false;
    if (this.state !== "stunned") {
      this.clanks += 1;
      this.#flash = 0.1;
      return false;
    }
    this.health -= damage;
    this.#flash = 0.3;
    this.#set(this.health <= 0 ? "dead" : "recover");
    return true;
  }

  update(dt: number, hero: Hero): void {
    const body = this.body;
    if (body === undefined) return;
    const feel = WARDEN_FEEL;
    this.#timer += dt;
    this.#flash = Math.max(0, this.#flash - dt);
    const to = new Vector3().subVectors(hero.mesh.position, this.mesh.position).setY(0);
    let speed = 0;
    switch (this.state) {
      case "dormant":
        if (hero.alive && to.length() < feel.wakeRange) this.#set("windup");
        break;
      case "windup":
        this.#face(Math.atan2(to.x, to.z), dt * 0.6);
        if (this.#timer >= feel.windup) {
          this.#heading.copy(to).normalize();
          this.#face(Math.atan2(to.x, to.z), 1);
          this.#last.copy(this.mesh.position);
          this.#set("charge");
        }
        break;
      case "charge": {
        speed = feel.chargeSpeed;
        // Met a wall: it covered under a third of what it asked for in the last step.
        const moved = this.#last.distanceTo(this.mesh.position);
        this.#last.copy(this.mesh.position);
        if (this.#timer > 0.15 && moved < feel.chargeSpeed * dt * 0.3) {
          this.stuns += 1;
          this.#set("stunned");
          speed = 0;
        } else if (this.#timer >= feel.chargeTime) this.#set("recover");
        if (
          to.length() < this.radius + 0.6 &&
          hero.takeHit(feel.hitHalves, this.mesh.position) === "blocked"
        ) {
          // The shield turns the charge aside, but only a wall dazes it.
          this.#set("recover");
        }
        break;
      }
      case "stunned":
        if (this.#timer >= feel.stunTime) this.#set("recover");
        break;
      case "recover":
        if (this.#timer >= feel.recover) this.#set(hero.alive ? "windup" : "dormant");
        break;
      case "dead":
        if (this.#timer > 1.4) {
          body.dispose();
          this.body = undefined;
          this.mesh.visible = false;
        }
        break;
    }
    body.velocity.x = this.#heading.x * speed;
    body.velocity.z = this.#heading.z * speed;
    body.moveAndSlide(dt);
    this.rig.update(
      dt,
      this.state,
      Math.min(1, this.#timer / (this.state === "windup" ? feel.windup : 1.4)),
      this.#flash,
    );
  }

  debug(): Record<string, unknown> {
    return {
      clanks: this.clanks,
      health: this.health,
      position: this.mesh.position.toArray(),
      state: this.state,
      stuns: this.stuns,
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.mesh.removeFromParent();
  }

  #set(state: WardenState): void {
    this.state = state;
    this.#timer = 0;
  }

  #face(yaw: number, amount: number): void {
    const gap =
      MathUtils.euclideanModulo(yaw - this.rig.group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    this.rig.group.rotation.y += gap * Math.min(1, amount * 8);
  }
}
