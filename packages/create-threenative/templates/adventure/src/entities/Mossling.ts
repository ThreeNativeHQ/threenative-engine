import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { type ICreatureRig, createMossling } from "../render/creatures.js";
import { type GameCtx, type Hero, LAYER } from "./Hero.js";
import type { ITarget } from "./LockOn.js";

/** Set by `@threenative/playtest` on an entity a scenario placed with `frozen: true`. */
const PLAYTEST_FROZEN = "__threenativeFrozen";

const CAPSULE = { halfHeight: 0.12, radius: 0.3 } as const;
const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;

/** The Mossling's numbers, in metres and seconds. Kit design values, not the reference game's. */
export const MOSSLING_FEEL = {
  speed: 2.2,
  aggroRange: 8,
  /** It never strays further than this from its home: its room, or its patch of the clearing. */
  leash: 10,
  attackRange: 1.1,
  strikeReach: 1.5,
  windup: 0.45,
  recover: 0.9,
  health: 2,
  knockback: 3.5,
  /** A wall closer than this along the line to Wren turns the chase into a wall-follow. */
  wallFollowDistance: 1.1,
} as const;

export type MosslingState =
  | "idle"
  | "chase"
  | "home"
  | "windup"
  | "strike"
  | "recover"
  | "hurt"
  | "dead";

/**
 * A hopping chaser. It steers straight at Wren while it can see her, and around a wall when it
 * cannot: a ray from it to her names the wall's normal, and it slides along the wall on the side
 * that is shorter toward her, keeping that side until the ray clears. That is a ray-checked steer,
 * not a path search: navigation (`@threenative/physics/navigation`) is a Recast WASM boundary that
 * Android and iOS refuse, and every kit runs on all four targets.
 */
export class Mossling implements ITarget {
  readonly mesh = new Group();
  readonly rig: ICreatureRig;
  readonly radius = CAPSULE.radius + 0.06;
  readonly tags = ["hostile"];
  readonly home: Vector3;
  body: CharacterBody3D | undefined;
  state: MosslingState = "idle";
  health: number = MOSSLING_FEEL.health;
  /** Metres walked along a wall since the chase began: proof it went around, not through. */
  wallFollowed = 0;
  #timer = 0;
  #flash = 0;
  #side = 0;
  #sideHold = 0;
  #knock = new Vector3();
  #to = new Vector3();
  #from = new Vector3();
  #aim = new Vector3();
  #lastTangent = new Vector3();

  constructor(
    readonly id: string,
    at: Vector3,
  ) {
    this.rig = createMossling();
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.add(this.rig.group);
    this.mesh.position.set(at.x, at.y + FOOT_OFFSET, at.z);
    this.home = this.mesh.position.clone();
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get bodyId(): number | undefined {
    return this.body?.body.id;
  }

  get frozen(): boolean {
    return this.mesh.userData[PLAYTEST_FROZEN] === true;
  }

  /** Builds the body where the Mossling stands now, so a scenario's placement is respected. */
  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.home.copy(this.mesh.position);
    this.body = new CharacterBody3D({
      collisionLayer: LAYER.foe,
      collisionMask: LAYER.world | LAYER.hero | LAYER.foe,
      entity: this.id,
      gravity: -20,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(CAPSULE.halfHeight, CAPSULE.radius),
      snapToGround: 0.3,
    });
  }

  hurt(damage: number, from: Vector3): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    this.#flash = 0.25;
    this.#knock
      .subVectors(this.mesh.position, from)
      .setY(0)
      .normalize()
      .multiplyScalar(MOSSLING_FEEL.knockback);
    this.#set(this.health <= 0 ? "dead" : "hurt");
    return true;
  }

  update(ctx: GameCtx, dt: number, hero: Hero): void {
    const body = this.body;
    if (body === undefined) return;
    const feel = MOSSLING_FEEL;
    this.#timer += dt;
    this.#flash = Math.max(0, this.#flash - dt);
    this.#to.subVectors(hero.mesh.position, this.mesh.position).setY(0);
    const distance = this.#to.length();
    const heroInLeash = hero.mesh.position.distanceTo(this.home) < feel.leash;
    let move = 0;
    switch (this.state) {
      case "idle":
      case "chase":
      case "home":
        if (hero.alive && heroInLeash && distance < feel.aggroRange) {
          this.state = "chase";
          if (distance < feel.attackRange) this.#set("windup");
          else move = feel.speed;
        } else if (this.mesh.position.distanceTo(this.home) > 0.5) {
          this.state = "home";
          this.#to.subVectors(this.home, this.mesh.position).setY(0);
          move = feel.speed * 0.6;
        } else this.state = "idle";
        break;
      case "windup":
        if (this.#timer >= feel.windup) {
          this.#set("strike");
          // The bite lands if Wren is still in reach and in front of it.
          this.#aim.set(
            Math.sin(this.rig.group.rotation.y),
            0,
            Math.cos(this.rig.group.rotation.y),
          );
          if (distance < feel.strikeReach && this.#aim.dot(this.#to.clone().normalize()) > 0.5)
            hero.takeHit(1, this.mesh.position);
        }
        break;
      case "strike":
        if (this.#timer >= 0.15) this.#set("recover");
        break;
      case "recover":
        if (this.#timer >= feel.recover) this.#set("chase");
        break;
      case "hurt":
        if (this.#timer >= 0.3) this.#set("chase");
        break;
      case "dead":
        if (this.#timer > 0.6) {
          body.dispose();
          this.body = undefined;
          this.mesh.visible = false;
        }
        break;
    }

    const steer = move > 0 && !this.frozen ? this.#steer(ctx, distance, dt) : undefined;
    if (this.state === "hurt" && !this.frozen) {
      body.velocity.x = this.#knock.x * (1 - this.#timer / 0.3);
      body.velocity.z = this.#knock.z * (1 - this.#timer / 0.3);
    } else if (steer !== undefined) {
      body.velocity.x = steer.x * move;
      body.velocity.z = steer.z * move;
      this.#face(Math.atan2(steer.x, steer.z), dt);
    } else {
      body.velocity.x = 0;
      body.velocity.z = 0;
      if (this.state !== "dead" && distance > 0.01)
        this.#face(Math.atan2(this.#to.x, this.#to.z), dt);
    }
    body.moveAndSlide(dt);
    this.rig.update(
      dt,
      this.state === "home" ? "chase" : this.state,
      Math.min(1, this.#timer / (this.state === "windup" ? feel.windup : 0.6)),
      this.#flash,
    );
  }

  debug(): Record<string, unknown> {
    return {
      health: this.health,
      position: this.mesh.position.toArray(),
      state: this.state,
      wallFollowed: Math.round(this.wallFollowed * 100) / 100,
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.mesh.removeFromParent();
  }

  #set(state: MosslingState): void {
    this.state = state;
    this.#timer = 0;
  }

  #face(yaw: number, dt: number): void {
    const gap =
      MathUtils.euclideanModulo(yaw - this.rig.group.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
    this.rig.group.rotation.y += gap * Math.min(1, dt * 10);
  }

  /** The direction to walk: straight at the goal, or along the wall the ray found in the way. */
  #steer(ctx: GameCtx, distance: number, dt: number): Vector3 {
    const direction = this.#to.clone().normalize();
    this.#sideHold = Math.max(0, this.#sideHold - dt);
    this.#from.copy(this.mesh.position);
    const goal = this.#from.clone().addScaledVector(direction, distance);
    const hit = ctx.physics.directSpaceState.intersectRay({
      collisionMask: LAYER.world,
      from: this.#from,
      to: goal,
    });
    if (hit === undefined || hit.distance > MOSSLING_FEEL.wallFollowDistance) {
      if (this.#sideHold <= 0) this.#side = 0;
      if (this.#side === 0) return direction;
    }
    const normal =
      hit === undefined ? undefined : new Vector3(hit.normal.x, 0, hit.normal.z).normalize();
    if (normal !== undefined) {
      // Pick the tangent once per wall: the one that leans toward the goal, or the left when square.
      if (this.#side === 0)
        this.#side = normal.x * direction.z - normal.z * direction.x >= 0 ? 1 : -1;
      this.#sideHold = 0.5;
      this.#lastTangent.set(-normal.z * this.#side, 0, normal.x * this.#side);
    }
    this.wallFollowed += MOSSLING_FEEL.speed * dt;
    return this.#lastTangent;
  }
}
