import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import { type Group, Object3D, type Vector3 } from "three";
import { createDoor, createGrate } from "../render/props.js";
import type { GameCtx } from "./Hero.js";

/**
 * A passage that is shut until something opens it. A `locked` door spends a small key; a grate is
 * opened by its switch and closes again when the switch is released. Either way the leaf is a
 * kinematic body that slides out of the frame, so what blocks Wren is exactly what she sees.
 */
export class Door {
  readonly mesh: Group;
  body: RigidBody3D | undefined;
  open = false;
  #amount = 0;
  /** The body's transform: the leaf's centre, which slides with the leaf. */
  readonly #proxy = new Object3D();
  readonly #closed: Vector3;
  readonly #travel: number;

  constructor(
    readonly id: string,
    readonly kind: "locked" | "grate",
    at: Vector3,
    /** Yaw of the leaf: 0 spans x, π/2 spans z. */
    yaw: number,
    readonly width: number,
    readonly height: number,
  ) {
    this.mesh = kind === "locked" ? createDoor(width, height, true) : createGrate(width, height);
    this.mesh.position.copy(at);
    this.mesh.rotation.y = yaw;
    this.#closed = at.clone();
    // A grate rises into its lintel; a door sinks into the floor.
    this.#travel = kind === "grate" ? height - 0.1 : -height + 0.05;
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    this.#proxy.position.copy(this.#closed).setY(this.#closed.y + this.height / 2);
    const across = Math.abs(Math.sin(this.mesh.rotation.y)) > 0.5;
    this.body = new RigidBody3D({
      entity: this.id,
      object: this.#proxy,
      physics: ctx.physics,
      shape: CollisionShape3D.box(
        across ? 0.3 : this.width,
        this.height,
        across ? this.width : 0.3,
      ),
      type: "kinematic",
    });
  }

  /** The locked door's rule: it opens only by spending a key. */
  unlock(keys: number): boolean {
    if (this.kind !== "locked" || this.open || keys <= 0) return false;
    this.open = true;
    return true;
  }

  setOpen(open: boolean): void {
    this.open = open;
  }

  update(dt: number): void {
    const goal = this.open ? 1 : 0;
    this.#amount +=
      Math.sign(goal - this.#amount) * Math.min(Math.abs(goal - this.#amount), dt * 1.4);
    this.mesh.position.set(
      this.#closed.x,
      this.#closed.y + this.#travel * this.#amount,
      this.#closed.z,
    );
    this.#proxy.position.copy(this.mesh.position).setY(this.mesh.position.y + this.height / 2);
  }

  debug(): Record<string, unknown> {
    return { open: this.open, travel: Math.round(this.#amount * 100) / 100 };
  }
}
