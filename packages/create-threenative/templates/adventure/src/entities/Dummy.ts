import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import type { Group, Vector3 } from "three";
import { type ICreatureRig, createDummy } from "../render/creatures.js";
import { type GameCtx, LAYER } from "./Hero.js";
import type { ITarget } from "./LockOn.js";

/** A straw practice dummy: lockable, two cuts to topple, never fights back. */
export class Dummy implements ITarget {
  readonly mesh: Group;
  readonly rig: ICreatureRig;
  readonly radius = 0.3;
  readonly tags = ["hostile"];
  health = 2;
  state: "standing" | "dead" = "standing";
  #body: RigidBody3D | undefined;
  #flash = 0;
  #fall = 0;

  constructor(
    readonly id: string,
    at: Vector3,
  ) {
    this.rig = createDummy();
    this.mesh = this.rig.group;
    this.mesh.position.copy(at);
  }

  get alive(): boolean {
    return this.state !== "dead";
  }

  get bodyId(): number | undefined {
    return this.#body?.body.id;
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.#body = new RigidBody3D({
      collisionLayer: LAYER.foe,
      entity: this.id,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.6, this.radius),
      type: "kinematic",
    });
  }

  hurt(): boolean {
    if (!this.alive) return false;
    this.health -= 1;
    this.#flash = 0.3;
    if (this.health <= 0) {
      this.state = "dead";
      this.#body?.dispose();
      this.#body = undefined;
    }
    return true;
  }

  update(dt: number): void {
    this.#flash = Math.max(0, this.#flash - dt);
    if (!this.alive) this.#fall = Math.min(1, this.#fall + dt * 2);
    this.rig.update(dt, this.state, this.#fall, this.#flash);
  }

  debug(): Record<string, unknown> {
    return { health: this.health, state: this.state };
  }
}
