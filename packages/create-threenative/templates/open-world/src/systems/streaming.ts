// The city streams by block, the way a classic open world streams its map: the blocks near the
// player are built in full (grid towers, landmarks, shadows, colliders) and freed again once
// the player is far enough away. `buildSkyline` below stands in for every block that is
// not built, so the horizon never empties. Building is charged to a frame budget, so driving across
// the city never stalls a frame on the blocks it brings in.
import { InstancedBatch, markStatic, mergeByMaterial } from "@threenative/core";
import { AdmissionBudget } from "@threenative/core/world";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D } from "@threenative/physics";
import { BoxGeometry, Group, Mesh, type Vector3 } from "three";
import { BLOCKS, DOWNTOWN, type IBlock, KERB, ROADS } from "../city/layout.js";
import { WORLD_LAYER } from "../entities/layers.js";
import { buildBlock } from "../render/city.js";
import { skylineMaterial } from "../render/materials.js";

/**
 * Metres from the player to a block's centre. A block is built inside `load` and freed past
 * `keep`; the gap stops a block on the edge being built and freed on alternate frames.
 * `POPULATION_RANGE` in `World.ts` stays inside `load`, so every car and pedestrian stands on
 * built ground. `budgetMs` is what one frame may spend building blocks.
 */
export const STREAMING = { load: 110, keep: 135, budgetMs: 2 } as const;

interface IResident {
  readonly root: Group;
  readonly bodies: readonly RigidBody3D[];
}

function reach(target: IBlock, at: Vector3): number {
  return Math.hypot(target.center.x - at.x, target.center.z - at.z);
}

function disposeMeshes(root: Group): void {
  root.traverse((node) => {
    if (node instanceof Mesh) node.geometry.dispose();
  });
}

export class CityStreamer {
  /** Every built block hangs here; add it to the scene once. */
  readonly root = new Group();
  readonly #resident = new Map<IBlock, IResident>();
  readonly #physics: IPhysicsContext;

  constructor(physics: IPhysicsContext) {
    this.#physics = physics;
    this.root.name = "city-blocks";
  }

  /**
   * Free every block past `keep`, then build the blocks inside `load`, nearest first, until the
   * frame's budget is spent; the rest wait for the next frame. Pass `Infinity` to build them all
   * now: the first frame has to stand on built ground.
   */
  update(at: Vector3, budgetMs: number = STREAMING.budgetMs): void {
    for (const [target, built] of this.#resident)
      if (reach(target, at) > STREAMING.keep) this.#free(target, built);
    const wanted = BLOCKS.filter(
      (target) => !this.#resident.has(target) && reach(target, at) <= STREAMING.load,
    ).sort((a, b) => reach(a, at) - reach(b, at));
    const budget = new AdmissionBudget(budgetMs, () => performance.now());
    for (const target of wanted) if (!budget.admit(() => this.#build(target))) break;
  }

  #build(target: IBlock): void {
    const { root, solids } = buildBlock(target);
    const bodies = solids.map(
      (solid) =>
        new RigidBody3D({
          collisionLayer: WORLD_LAYER,
          physics: this.#physics,
          position: solid.center,
          shape: CollisionShape3D.box(solid.size.x, solid.size.y, solid.size.z),
          type: "fixed",
        }),
    );
    const merged = mergeByMaterial(root, { label: root.name });
    for (const mesh of merged) {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
    }
    disposeMeshes(root);
    root.clear();
    root.add(...merged);
    this.root.add(root);
    markStatic(root);
    this.#resident.set(target, { bodies, root });
  }

  #free(target: IBlock, built: IResident): void {
    for (const body of built.bodies) body.dispose();
    built.root.removeFromParent();
    disposeMeshes(built.root);
    this.#resident.delete(target);
  }

  #built(i: number, j: number): boolean {
    for (const target of this.#resident.keys()) if (target.i === i && target.j === j) return true;
    return false;
  }

  debug(): Record<string, unknown> {
    let bodies = 0;
    for (const built of this.#resident.values()) bodies += built.bodies.length;
    return {
      bodies,
      /** The plaza, where the player starts. */
      downtown: this.#built(DOWNTOWN + 1, DOWNTOWN + 1),
      /** The south-east corner block, 270 m from the plaza. */
      farCorner: this.#built(ROADS - 2, ROADS - 2),
      resident: this.#resident.size,
    };
  }
}

/**
 * The far field: every block's solids as one instanced box draw with no grid, no colliders and no
 * shadow. Each box sits 5 cm inside the solid it stands for, so a streamed block's own faces hide
 * it wherever that block is built, and it shows only where the block is not.
 */
export function buildSkyline(): Mesh | undefined {
  const batch = new InstancedBatch({
    geometry: new BoxGeometry(1, 1, 1),
    material: skylineMaterial,
  });
  for (const target of BLOCKS) {
    const { root, solids } = buildBlock(target);
    // The slabs are already drawn with the city; the skyline needs only what stands on them.
    for (const solid of solids.filter((candidate) => candidate.size.y > KERB))
      batch.place({
        position: [solid.center.x, solid.center.y, solid.center.z],
        scale: [solid.size.x - 0.1, solid.size.y - 0.1, solid.size.z - 0.1],
      });
    root.traverse((node) => {
      if (node instanceof Mesh) node.geometry.dispose();
    });
  }
  return batch.build({ name: "skyline" });
}
