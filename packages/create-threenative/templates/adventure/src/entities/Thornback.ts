import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import { Euler, Group, MathUtils, Vector3 } from "three";
import { type ICreatureRig, createThornback } from "../render/creatures.js";
import { type GameCtx, type Hero, LAYER } from "./Hero.js";
import type { ITarget } from "./LockOn.js";

/** Set by `@threenative/playtest` on an entity a scenario placed with `frozen: true`. */
const PLAYTEST_FROZEN = "__threenativeFrozen";

const CAPSULE = { halfHeight: 0.05, radius: 0.5 } as const;
const FOOT_OFFSET = CAPSULE.halfHeight + CAPSULE.radius;

/** The Thornback's numbers, in metres and seconds. Kit design values. */
export const THORNBACK_FEEL = {
  aggroRange: 7,
  leash: 10,
  speed: 1.3,
  /** Radians per second: slow enough that Wren can get round behind it. */
  turnRate: 1.4,
  lungeRange: 2.6,
  /** It rears its plate and the thorns stand out: the tell before the lunge. */
  telegraph: 0.75,
  lungeSpeed: 6.5,
  lungeTime: 0.4,
  /** Standing still after a lunge, its rump sac glowing: the time to get behind it. */
  recover: 1.4,
  health: 2,
  hitRange: 1.3,
  /** The plate's full angle: a cut from inside it clanks off. */
  plateCone: 140,
  knockback: 3,
} as const;

export type ThornbackState =
  | "idle"
  | "stalk"
  | "home"
  | "telegraph"
  | "lunge"
  | "recover"
  | "hurt"
  | "dead";

/**
 * A shelled crawler that shows Wren its thorned plate. It turns slowly, so she gets round it; a
 * cut into the plate clanks off and only a cut from the side or behind lands. It stalks her,
 * rears, lunges, and then stands still a moment: the opening.
 */
export class Thornback implements ITarget {
  readonly mesh = new Group();
  readonly rig: ICreatureRig;
  readonly radius = CAPSULE.radius + 0.1;
  readonly tags = ["hostile"];
  body: CharacterBody3D | undefined;
  state: ThornbackState = "idle";
  health: number = THORNBACK_FEEL.health;
  telegraphs = 0;
  lunges = 0;
  /** Cuts the plate turned. */
  clanks = 0;
  #home = new Vector3();
  #timer = 0;
  #flash = 0;
  #landed = false;
  #knock = new Vector3();
  #to = new Vector3();
  #facing = new Vector3();

  constructor(
    readonly id: string,
    at: Vector3,
    yaw = 0,
  ) {
    this.rig = createThornback();
    this.rig.group.position.y = -FOOT_OFFSET;
    this.mesh.add(this.rig.group);
    this.mesh.position.set(at.x, at.y + FOOT_OFFSET, at.z);
    this.mesh.rotation.y = yaw;
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get bodyId(): number | undefined {
    return this.body?.body.id;
  }

  get yaw(): number {
    return this.rig.group.rotation.y;
  }

  /** Builds the body where it stands now, turned the way a scenario (or the level) turned it. */
  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.rig.group.rotation.y = new Euler().setFromQuaternion(this.mesh.quaternion, "YXZ").y;
    this.mesh.rotation.set(0, 0, 0);
    this.#home.copy(this.mesh.position);
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
    this.#facing.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const toAttacker = new Vector3().subVectors(from, this.mesh.position).setY(0).normalize();
    this.#flash = 0.12;
    if (this.#facing.dot(toAttacker) > Math.cos(MathUtils.degToRad(THORNBACK_FEEL.plateCone / 2))) {
      this.clanks += 1;
      return false;
    }
    this.health -= damage;
    this.#flash = 0.25;
    this.#knock.copy(toAttacker).negate().multiplyScalar(THORNBACK_FEEL.knockback);
    this.#set(this.health <= 0 ? "dead" : "hurt");
    return true;
  }

  update(dt: number, hero: Hero): void {
    const body = this.body;
    if (body === undefined) return;
    const feel = THORNBACK_FEEL;
    this.#timer += dt;
    this.#flash = Math.max(0, this.#flash - dt);
    this.#to.subVectors(hero.mesh.position, this.mesh.position).setY(0);
    const distance = this.#to.length();
    const hunting =
      hero.alive &&
      this.mesh.userData[PLAYTEST_FROZEN] !== true &&
      hero.mesh.position.distanceTo(this.#home) < feel.leash;
    this.#facing.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
    const facingHero = distance > 0.01 ? this.#facing.dot(this.#to.clone().normalize()) : 1;
    let speed = 0;
    let turn: number | undefined;
    switch (this.state) {
      case "idle":
      case "stalk":
      case "home":
        if (hunting && distance < feel.aggroRange) {
          this.state = "stalk";
          turn = feel.turnRate;
          speed = feel.speed * Math.max(0, facingHero);
          if (distance < feel.lungeRange && facingHero > 0.9) {
            this.telegraphs += 1;
            this.#set("telegraph");
          }
        } else if (this.mesh.position.distanceTo(this.#home) > 0.5) {
          this.state = "home";
          this.#to.subVectors(this.#home, this.mesh.position).setY(0);
          turn = feel.turnRate;
          speed = feel.speed;
        } else this.state = "idle";
        break;
      case "telegraph":
        turn = feel.turnRate * 0.5;
        if (this.#timer > feel.telegraph) {
          this.lunges += 1;
          this.#landed = false;
          this.#set("lunge");
        }
        break;
      case "lunge":
        speed = feel.lungeSpeed;
        if (!this.#landed && distance < feel.hitRange && facingHero > 0.5) {
          this.#landed = true;
          hero.takeHit(1, this.mesh.position);
        }
        if (this.#timer > feel.lungeTime) this.#set("recover");
        break;
      case "recover":
        if (this.#timer > feel.recover) this.#set("stalk");
        break;
      case "hurt":
        if (this.#timer > 0.35) this.#set("recover");
        break;
      case "dead":
        if (this.#timer > 0.9) {
          body.dispose();
          this.body = undefined;
          this.mesh.visible = false;
          return;
        }
        break;
    }
    if (turn !== undefined && this.#to.lengthSq() > 1e-4) {
      const gap =
        MathUtils.euclideanModulo(
          Math.atan2(this.#to.x, this.#to.z) - this.yaw + Math.PI,
          Math.PI * 2,
        ) - Math.PI;
      this.rig.group.rotation.y += MathUtils.clamp(gap, -turn * dt, turn * dt);
    }
    if (this.state === "hurt") {
      body.velocity.x = this.#knock.x * (1 - this.#timer / 0.35);
      body.velocity.z = this.#knock.z * (1 - this.#timer / 0.35);
    } else {
      body.velocity.x = Math.sin(this.yaw) * speed;
      body.velocity.z = Math.cos(this.yaw) * speed;
    }
    body.moveAndSlide(dt);
    const span = this.state === "telegraph" ? feel.telegraph : this.state === "hurt" ? 0.35 : 0.9;
    this.rig.update(
      dt,
      this.state === "home" ? "stalk" : this.state,
      Math.min(1, this.#timer / span),
      this.#flash,
    );
  }

  debug(): Record<string, unknown> {
    return {
      clanks: this.clanks,
      health: this.health,
      lunges: this.lunges,
      position: this.mesh.position.toArray(),
      state: this.state,
      telegraphs: this.telegraphs,
    };
  }

  dispose(): void {
    this.body?.dispose();
    this.mesh.removeFromParent();
  }

  #set(state: ThornbackState): void {
    this.state = state;
    this.#timer = 0;
  }
}
