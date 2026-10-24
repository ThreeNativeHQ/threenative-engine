import { CollisionShape3D, RigidBody3D } from "@threenative/physics";
import { type Group, Vector3 } from "three";
import { createBlock } from "../render/props.js";
import { type GameCtx, type Hero, LAYER } from "./Hero.js";

/** The push: 0.4 s of leaning, then a 1 m slide at 1.2 m/s. Kit design values. */
export const BLOCK_FEEL = { pushTime: 0.4, slideSpeed: 1.2, step: 1 } as const;

/**
 * A 1 m stone block on a 1 m grid. Wren leans on one face for 0.4 s and it slides one cell away
 * from her. One ray from its leading face checks the cell ahead first: a wall, a door or a grate
 * there and it does not move. No engine capability pushes blocks, so this file is the rule.
 */
export class Block {
  readonly mesh: Group;
  body: RigidBody3D | undefined;
  /** Completed one-cell slides. */
  steps = 0;
  /** Pushes refused because the cell ahead was blocked. */
  refused = 0;
  state: "resting" | "pushed" | "sliding" = "resting";
  #lean = 0;
  #axis = new Vector3();
  #from = new Vector3();
  #to = new Vector3();
  #travelled = 0;

  constructor(
    readonly id: string,
    at: Vector3,
    rng: () => number,
  ) {
    this.mesh = createBlock(rng);
    this.mesh.position.copy(at);
  }

  spawn(ctx: GameCtx): void {
    ctx.add(this.mesh);
    // The body's origin is the mesh's: its floor. Half the box sits below it, inside the floor slab.
    this.body = new RigidBody3D({
      entity: this.id,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 2, 1),
      type: "kinematic",
    });
  }

  /** Returns true while Wren is leaning on it this step (for her pushing pose). */
  update(ctx: GameCtx, dt: number, hero: Hero, wish: Vector3): boolean {
    if (this.state === "sliding") {
      const step = Math.min(BLOCK_FEEL.slideSpeed * dt, BLOCK_FEEL.step - this.#travelled);
      this.#travelled += step;
      this.mesh.position.addScaledVector(this.#axis, step);
      if (this.#travelled >= BLOCK_FEEL.step - 1e-6) {
        this.mesh.position.copy(this.#to);
        this.state = "resting";
        this.steps += 1;
      }
      return true;
    }
    const leaning = this.#leaning(hero, wish);
    if (!leaning) {
      this.#lean = 0;
      this.state = "resting";
      return false;
    }
    this.state = "pushed";
    this.#lean += dt;
    if (this.#lean < BLOCK_FEEL.pushTime) return true;
    this.#lean = 0;
    // The cell ahead: a ray from just outside the leading face to the far side of that cell.
    this.#from
      .copy(this.mesh.position)
      .addScaledVector(this.#axis, 0.52)
      .setY(this.mesh.position.y + 0.5);
    const end = this.#from.clone().addScaledVector(this.#axis, BLOCK_FEEL.step - 0.04);
    const hit = ctx.physics.directSpaceState.intersectRay({
      collisionMask: LAYER.world,
      from: this.#from,
      to: end,
    });
    if (hit !== undefined) {
      this.refused += 1;
      return true;
    }
    this.#to.copy(this.mesh.position).addScaledVector(this.#axis, BLOCK_FEEL.step);
    this.#travelled = 0;
    this.state = "sliding";
    return true;
  }

  /** Wren is against one face, pushing straight into it: that face's axis is the push direction. */
  #leaning(hero: Hero, wish: Vector3): boolean {
    if (wish.lengthSq() < 0.25 || !hero.body?.grounded) return false;
    const dx = this.mesh.position.x - hero.mesh.position.x;
    const dz = this.mesh.position.z - hero.mesh.position.z;
    const alongX = Math.abs(dx) > Math.abs(dz);
    const along = alongX ? Math.abs(dx) : Math.abs(dz);
    const across = alongX ? Math.abs(dz) : Math.abs(dx);
    if (along > 0.5 + 0.3 + 0.12 || across > 0.45) return false;
    this.#axis.set(alongX ? Math.sign(dx) : 0, 0, alongX ? 0 : Math.sign(dz));
    return wish.clone().normalize().dot(this.#axis) > 0.8;
  }

  debug(): Record<string, unknown> {
    return {
      position: this.mesh.position.toArray(),
      refused: this.refused,
      state: this.state,
      steps: this.steps,
    };
  }
}
