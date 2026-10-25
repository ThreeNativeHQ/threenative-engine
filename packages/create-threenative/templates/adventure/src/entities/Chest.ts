import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import type { Group, Vector3 } from "three";
import { type IChestRig, createChest } from "../render/props.js";
import type { GameCtx } from "./Hero.js";

export type ChestContents = "sword" | "key";

/**
 * A chest Wren opens with `interact`. It gives what it holds once; once the lid is up it waits a
 * moment and sinks into the floor, so an emptied chest never clutters a room or a fight.
 */
export class Chest {
  readonly rig: IChestRig;
  readonly mesh: Group;
  opened = false;
  #lid = 0;
  #gone = 0;
  #body: RigidBody3D | undefined;
  #floor = 0;

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
    this.#floor = this.mesh.position.y;
    this.#body = new RigidBody3D({
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
    if (this.#lid < 1 || !this.mesh.visible) return;
    // 1.5 s open, then 0.8 s sinking; then the chest and its collider are gone.
    this.#gone += dt;
    const sink = Math.min(1, Math.max(0, (this.#gone - 1.5) / 0.8));
    this.mesh.position.y = this.#floor - sink * 1.2;
    if (sink >= 1) {
      this.mesh.visible = false;
      this.#body?.dispose();
      this.#body = undefined;
    }
  }

  debug(): Record<string, unknown> {
    return { contents: this.contents, opened: this.opened };
  }
}
