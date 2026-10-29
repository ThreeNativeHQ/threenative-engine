import { Area3D, CollisionShape3D } from "@threenative/physics";
import type { Vector3 } from "three";
import { createSwitchPlate } from "../render/props.js";
import type { Block } from "./Block.js";
import type { GameCtx } from "./Hero.js";

/**
 * A floor switch: an `Area3D` over one grid cell. It is pressed while the push block's body rests
 * inside it, and `onChange` tells the grate. Wren standing on it does nothing: only stone is heavy
 * enough, which is the puzzle.
 */
export class Switch {
  readonly plate = createSwitchPlate();
  pressed = false;
  #area: Area3D | undefined;
  #inside = false;

  constructor(
    readonly at: Vector3,
    readonly block: Block,
    readonly onChange: (pressed: boolean) => void,
  ) {
    this.plate.group.position.copy(at);
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.plate.group);
    // A small box at the cell's centre: the block covers it only once it has finished its slide.
    this.#area = new Area3D({
      physics: ctx.physics,
      position: { x: this.at.x, y: this.at.y + 0.3, z: this.at.z },
      shape: CollisionShape3D.box(0.3, 0.4, 0.3),
    });
    this.#area.on("bodyEntered", (body) => {
      if (body === this.block.body) this.#inside = true;
    });
    this.#area.on("bodyExited", (body) => {
      if (body === this.block.body) this.#inside = false;
    });
  }

  update(): void {
    const pressed = this.#inside && this.block.state !== "sliding";
    if (pressed === this.pressed) return;
    this.pressed = pressed;
    this.plate.setPressed(pressed);
    this.onChange(pressed);
  }
}
