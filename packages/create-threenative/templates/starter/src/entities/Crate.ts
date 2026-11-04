import type { ICtx } from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { type Material, Mesh, Vector3 } from "three";
import { contactShadow } from "../render/contactShadow.js";
import { roundedBox } from "../render/shapes.js";
import type { GameState } from "../state.js";

export class Crate {
  readonly mesh: Mesh;
  readonly body: RigidBody3D;
  readonly #shadow = contactShadow(2.2, 0.9);

  constructor(
    ctx: ICtx<GameState, IPhysicsContext>,
    x: number,
    y: number,
    z: number,
    material: Material,
  ) {
    this.mesh = new Mesh(roundedBox(1, 1, 1), material);
    this.mesh.position.set(x, y, z);
    this.mesh.castShadow = true;
    ctx.add(this.mesh);
    // The blob lies on whatever is under the crate and fades as the crate leaves it, so it reads as
    // contact at rest and as height in the air. The ray starts at the crate's centre, so the crate's own solid is skipped.
    ctx.add(this.#shadow.object);
    const from = new Vector3();
    const to = new Vector3();
    ctx.beforeRender(() => {
      const { x, y, z } = this.mesh.position;
      from.set(x, y, z);
      to.set(x, y - 6, z);
      const gap = ctx.physics.directSpaceState.intersectRay({ from, to })?.distance;
      this.#shadow.object.visible = gap !== undefined;
      if (gap === undefined) return;
      this.#shadow.object.position.set(x, y - gap + 0.03, z);
      this.#shadow.fade(Math.max(0, 1 - (gap - 0.5) / 1.5));
    });
    this.body = new RigidBody3D({
      mass: 8,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(this.mesh),
    });
  }

  debug(): { position: number[] } {
    return { position: this.mesh.position.toArray() };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
    this.#shadow.object.removeFromParent();
  }
}
