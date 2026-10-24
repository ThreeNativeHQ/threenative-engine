import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import type { Group, Vector3 } from "three";
import { type IChestRig, createChest } from "../render/props.js";
import type { GameCtx } from "./Hero.js";

export type ChestContents = "sword" | "key";

/** A chest Wren opens with `interact`. It gives what it holds once, then stays open. */
export class Chest {
  readonly rig: IChestRig;
  readonly mesh: Group;
  opened = false;
  #lid = 0;

  constructor(
    readonly id: string,
    readonly contents: ChestContents,
    at: Vector3,
    yaw: number,
  ) {
    this.rig = createChest();
    this.mesh = this.rig.group;
    this.mesh.position.copy(at);
    this.mesh.rotation.y = yaw;
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    new RigidBody3D({
      physics: ctx.physics,
      position: { x: this.mesh.position.x, y: this.mesh.position.y + 0.4, z: this.mesh.position.z },
      shape: CollisionShape3D.box(0.9, 0.8, 0.9),
      type: "fixed",
    });
  }

  /** Returns what came out, or undefined when it was already open. */
  open(): ChestContents | undefined {
    if (this.opened) return undefined;
    this.opened = true;
    return this.contents;
  }

  update(dt: number): void {
    if (this.opened && this.#lid < 1) this.#lid = Math.min(1, this.#lid + dt * 2.5);
    this.rig.setOpen(this.#lid);
  }

  debug(): Record<string, unknown> {
    return { contents: this.contents, opened: this.opened };
  }
}
