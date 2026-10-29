import type { ICtx } from "@threenative/core";
import { TerrainTiles } from "@threenative/core/world";
import type { IPhysicsContext } from "@threenative/physics";
import type { IStarterWorld } from "@threenative/terrain/starter";
import { Mesh, type Object3D } from "three";

/** Ray-test only terrain triangles actually drawn, excluding hidden LODs and props. */
export function forestStageTerrainTargets(world: Object3D): Mesh[] {
  const terrain = world.children.find((child) => child instanceof TerrainTiles);
  if (!terrain) throw new Error("Forest stage: no streamed terrain to observe.");
  const meshes: Mesh[] = [];
  terrain.traverseVisible((object) => {
    if (object instanceof Mesh) meshes.push(object);
  });
  return meshes;
}

/** The two explicit `?stage=` arms; each is a baked copy of the forest kit under `local-assets/forest-stage/`. */
export const FOREST_STAGE_ARMS = ["before", "after", "wildwood"] as const;
export type ForestStageArm = (typeof FOREST_STAGE_ARMS)[number];

/** What the kit's `addForest` returns: its streamed world, ground, colliders and water. */
export type ForestStageWorld = IStarterWorld & { readonly water?: { dispose(): void } };

interface IForestKit {
  addForest(
    ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
    follow: Object3D,
    url: string,
    whileCurrent: () => boolean,
  ): Promise<ForestStageWorld>;
}

// The kit's own runtime, imported as authored; a missing copy is a missing key, never a fallback.
const STAGED = import.meta.glob<IForestKit>("../../local-assets/forest-stage/*/world.ts");

/** `?stage=` read strictly: absent is no stage, anything but an arm name throws. */
export function forestStageArm(search: string): ForestStageArm | undefined {
  const arm = new URLSearchParams(search).get("stage");
  if (arm === null) return undefined;
  if (!(FOREST_STAGE_ARMS as readonly string[]).includes(arm))
    throw new Error(`Forest stage: ?stage=${arm} is not one of ${FOREST_STAGE_ARMS.join(", ")}.`);
  return arm as ForestStageArm;
}

/**
 * Streams one staged arm through the kit's `addForest`; its world, ground and colliders are the
 * kit's. `whileCurrent` turning false makes the kit dispose what it built instead of attaching it.
 */
export async function addForestStage(
  ctx: ICtx<Record<string, unknown>, IPhysicsContext>,
  follow: Object3D,
  arm: ForestStageArm,
  whileCurrent: () => boolean,
  kits: Record<string, () => Promise<IForestKit>> = STAGED,
): Promise<ForestStageWorld> {
  const load = kits[`../../local-assets/forest-stage/${arm}/world.ts`];
  if (!load)
    throw new Error(
      `Forest stage ${arm}: local-assets/forest-stage/${arm}/world.ts is not staged; copy the kit there and run its bake.mjs.`,
    );
  return (await load()).addForest(
    ctx,
    follow,
    `forest-stage/${arm}/world/world.json`,
    whileCurrent,
  );
}
