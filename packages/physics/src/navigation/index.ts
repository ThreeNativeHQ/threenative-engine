import type { ICtx, IGamePluginHooks } from "@threenative/core";
import { type Crowd, NavMesh, NavMeshQuery, init } from "recast-navigation";
import type { IPhysicsContext } from "../plugin.js";
import type { NavigationAgent3D } from "./NavigationAgent3D.js";
import type { NavigationObstacle3D } from "./NavigationObstacle3D.js";
import type { NavigationRegion3D } from "./NavigationRegion3D.js";

export interface INavigationContext {
  navMesh: NavMesh;
  query: NavMeshQuery;
  readonly regions: Set<NavigationRegion3D>;
  readonly agents: Set<NavigationAgent3D>;
  readonly obstacles: Set<NavigationObstacle3D>;
  crowd?: Crowd;
}

export type NavigationPlugin = IGamePluginHooks<Record<string, unknown>, IPhysicsContext>;

let initialized: Promise<void> | undefined;

function initialize(): Promise<void> {
  initialized ??= init();
  return initialized;
}

function emptyNavigation(): { readonly navMesh: NavMesh; readonly query: NavMeshQuery } {
  const navMesh = new NavMesh();
  const query = new NavMeshQuery(navMesh, { maxNodes: 4096 });
  query.defaultQueryHalfExtents = { x: 2, y: 4, z: 2 };
  return { navMesh, query };
}

function disposeNavigation(navigation: INavigationContext): void {
  for (const obstacle of [...navigation.obstacles]) obstacle.dispose();
  for (const agent of [...navigation.agents]) agent.dispose();
  for (const region of [...navigation.regions]) region.dispose();
  navigation.crowd?.destroy();
  navigation.crowd = undefined;
  navigation.query.destroy();
  navigation.navMesh.destroy();
  navigation.regions.clear();
  navigation.agents.clear();
  navigation.obstacles.clear();
}

/**
 * Install navmesh pathfinding and crowd avoidance.
 * @situation enemy walks around a wall
 * @situation NPC patrols a level and chases a player
 * @constraint requires rapier() earlier in the plugins array
 * @example const game = defineGame({ plugins: [rapier(), recast()] });
 * @requires npm i @threenative/physics
 */
export function recast(): NavigationPlugin {
  let navigation: INavigationContext | undefined;
  return {
    setup: async (ctx: ICtx<Record<string, unknown>, IPhysicsContext>) => {
      await initialize();
      if (ctx.physics === undefined)
        throw new Error("recast() requires rapier() earlier in the plugins array.");
      const empty = emptyNavigation();
      navigation = {
        agents: new Set(),
        navMesh: empty.navMesh,
        obstacles: new Set(),
        query: empty.query,
        regions: new Set(),
      };
      ctx.physics.navigation = navigation;
      return undefined;
    },
    update: (ctx, dt) => {
      const active = navigation ?? ctx.physics?.navigation;
      if (active === undefined) return;
      for (const obstacle of active.obstacles) obstacle.syncCrowd();
      for (const agent of active.agents) agent.syncCrowd();
      active.crowd?.update(dt);
      for (const agent of active.agents) agent.advance();
    },
    sceneExit: () => {
      if (navigation !== undefined) {
        for (const obstacle of [...navigation.obstacles]) obstacle.dispose();
        for (const agent of [...navigation.agents]) agent.dispose();
        for (const region of [...navigation.regions]) region.dispose();
      }
    },
    dispose: (ctx) => {
      if (navigation !== undefined) disposeNavigation(navigation);
      if (ctx.physics !== undefined) ctx.physics.navigation = undefined;
      navigation = undefined;
    },
  };
}

/**
 * Move an agent along a baked navmesh toward a target.
 * @situation enemy walks around a wall
 * @situation enemy patrols a level and chases the player
 * @situation enemy walks around a patrol path and chases the player when it sees them
 * @situation enemy patrols and chases while avoiding obstacles
 * @situation enemy chases the player with line of sight and obstacle avoidance
 * @situation NPC walks to a destination
 * @situation move crew around a ship deck
 * @alias close engagement range
 * @constraint import NavigationAgent3D from exactly `@threenative/physics/navigation`; `@threenative/physics` is not a valid import for this symbol; use this capability instead of hand-written A*; requires recast() after rapier(), plus a baked NavigationRegion3D
 * @example import { NavigationAgent3D } from "@threenative/physics/navigation";
 * import { Vector3 } from "three";
 * const agent = new NavigationAgent3D({ navigation, object });
 * agent.setTargetPosition(player.position);
 * const reusableTarget = new Vector3();
 * const next = agent.getNextPathPosition(reusableTarget);
 * @requires npm i @threenative/physics
 */
export { NavigationAgent3D } from "./NavigationAgent3D.js";
export type {
  INavigationAgent3DOptions,
  NavigationAgentEvent,
  NavigationAgentHandler,
} from "./NavigationAgent3D.js";
/**
 * Add a non-moving crowd obstacle to a navmesh.
 * @situation keep navigation agents away from a blocking prop
 * @situation make a stationary character affect crowd avoidance
 * @constraint create it after recast() and dispose it with the scene
 * @example const obstacle = new NavigationObstacle3D({ navigation, object });
 * @requires npm i @threenative/physics
 */
export { NavigationObstacle3D } from "./NavigationObstacle3D.js";
export type { INavigationObstacle3DOptions } from "./NavigationObstacle3D.js";
/**
 * Bake walkable Three.js geometry into a navigation region.
 * @situation let enemies walk around level geometry
 * @situation create the baked navmesh required by NavigationAgent3D
 * @constraint bake before creating agents or obstacles
 * @example const region = new NavigationRegion3D({ navigation, meshes: [floor] });
 * @requires npm i @threenative/physics
 */
export { NavigationRegion3D } from "./NavigationRegion3D.js";
export type { INavigationRegion3DOptions } from "./NavigationRegion3D.js";
