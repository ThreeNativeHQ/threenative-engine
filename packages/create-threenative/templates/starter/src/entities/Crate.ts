import type { ICtx } from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { type Material, Mesh } from "three";
import { roundedBox } from "../render/shapes.js";
import type { GameState } from "../state.js";

export class Crate {
  readonly mesh: Mesh;
  readonly body: RigidBody3D;

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
  }
}
