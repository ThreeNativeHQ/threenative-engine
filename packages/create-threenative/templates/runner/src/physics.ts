import type { IPhysicsContext } from "@threenative/physics";

/**
 * One bit per thing that can touch another thing.
 *
 * The runner itself is not a body — it is a transform the game moves, carrying an `Area3D` that
 * scans for obstacles. Obstacles are fixed bodies that collide with nothing and are only ever
 * *detected*, which is why they cost a layer and no solver work.
 */
export const OBSTACLE_LAYER = 2;

export type RunnerPhysics = IPhysicsContext;
