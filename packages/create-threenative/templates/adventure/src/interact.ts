import { Area3D, CollisionShape3D, type PhysicsBody3D } from "@threenative/physics";
import type { Vector3 } from "three";
import type { GameCtx } from "./entities/Hero.js";

/** One thing `interact` can use: where it is, what the prompt says now, and what using it does. */
export interface IInteractable {
  readonly at: Vector3;
  /** The prompt text, or undefined when there is nothing to do here (an opened chest). */
  label(): string | undefined;
  use(): void;
}

/**
 * The one prompt picker. Each interactable gets an `Area3D` of `reach` metres; while Wren's body
 * is inside one or more, the nearest with a label is the prompt, and `interact` runs it. No engine
 * capability names an interaction, so the rule lives here and every chest, sign and door uses it.
 */
export class Interactions {
  readonly #inside = new Set<IInteractable>();
  readonly #all: IInteractable[] = [];

  constructor(
    readonly ctx: GameCtx,
    readonly hero: () => PhysicsBody3D | undefined,
  ) {}

  add(item: IInteractable, reach = 1.5): void {
    this.#all.push(item);
    const area = new Area3D({
      physics: this.ctx.physics,
      position: { x: item.at.x, y: item.at.y + 0.8, z: item.at.z },
      shape: CollisionShape3D.box(reach * 2, 1.6, reach * 2),
    });
    area.on("bodyEntered", (body) => {
      if (body === this.hero()) this.#inside.add(item);
    });
    area.on("bodyExited", (body) => {
      if (body === this.hero()) this.#inside.delete(item);
    });
  }

  /** The prompt in reach, nearest first. */
  current(from: Vector3): IInteractable | undefined {
    let best: IInteractable | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const item of this.#inside) {
      if (item.label() === undefined) continue;
      const distance = item.at.distanceToSquared(from);
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }
    return best;
  }

  /** Runs the current prompt when `pressed`; returns the prompt text for the HUD. */
  update(from: Vector3, pressed: boolean): string {
    const item = this.current(from);
    if (item !== undefined && pressed) item.use();
    return item?.label() ?? "";
  }
}
