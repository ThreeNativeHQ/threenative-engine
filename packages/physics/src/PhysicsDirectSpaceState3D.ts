import { CollisionShape3D } from "./CollisionShape3D.js";
import type { IPhysicsBodyHandle } from "./handles.js";
import type {
  IPhysicsPointQuery,
  IPhysicsQueryHit,
  IPhysicsRayHit,
  IPhysicsRayQuery,
  IPhysicsShapeQuery,
  IPhysicsSimulation,
  IPhysicsVector3,
} from "./simulation.js";
import {
  requirePhysicsPointQuery,
  requirePhysicsRayQuery,
  requirePhysicsShapeQuery,
} from "./simulation.js";

export type PhysicsQueryVector3 = IPhysicsVector3;

export interface IIntersectRayOptions {
  readonly from: PhysicsQueryVector3;
  readonly to: PhysicsQueryVector3;
  readonly collisionMask?: number;
  /**
   * Godot `PhysicsRayQueryParameters3D.hit_from_inside`, default false: a ray whose origin is
   * inside a solid ignores that solid. True returns it as a distance 0 hit with a zero normal.
   */
  readonly hitFromInside?: boolean;
}

export interface IIntersectShapeOptions {
  readonly shape: CollisionShape3D;
  readonly position: PhysicsQueryVector3;
  readonly rotation?: {
    readonly x: number;
    readonly y: number;
    readonly z: number;
    readonly w: number;
  };
  readonly collisionMask?: number;
  readonly maxResults?: number;
}

export interface IIntersectPointOptions {
  readonly position: PhysicsQueryVector3;
  readonly collisionMask?: number;
  readonly maxResults?: number;
}

export interface IRayHit extends IPhysicsRayHit {
  readonly body: IPhysicsBodyHandle;
}

export type IShapeHit = IPhysicsQueryHit;
export type IPointHit = IPhysicsQueryHit;

function rayQuery(options: IIntersectRayOptions): IPhysicsRayQuery {
  return requirePhysicsRayQuery({
    collisionMask: options.collisionMask === undefined ? 0xffff : options.collisionMask,
    from: options.from,
    hitFromInside: options.hitFromInside,
    to: options.to,
  });
}

function shapeQuery(options: IIntersectShapeOptions): IPhysicsShapeQuery {
  if (!(options.shape instanceof CollisionShape3D))
    throw new Error("PhysicsDirectSpaceState3D.intersectShape requires a CollisionShape3D.");
  return requirePhysicsShapeQuery({
    collisionMask: options.collisionMask === undefined ? 0xffff : options.collisionMask,
    maxResults: options.maxResults === undefined ? 16 : options.maxResults,
    position: options.position,
    rotation: options.rotation === undefined ? { w: 1, x: 0, y: 0, z: 0 } : options.rotation,
    shape: options.shape.descriptor,
  });
}

function pointQuery(options: IIntersectPointOptions): IPhysicsPointQuery {
  return requirePhysicsPointQuery({
    collisionMask: options.collisionMask === undefined ? 0xffff : options.collisionMask,
    maxResults: options.maxResults === undefined ? 16 : options.maxResults,
    position: options.position,
  });
}

/** Godot-shaped point-in-time queries over the selected physics simulation. */
export class PhysicsDirectSpaceState3D {
  readonly #simulation: IPhysicsSimulation;

  constructor(simulation: IPhysicsSimulation) {
    this.#simulation = simulation;
  }

  intersectRay(options: IIntersectRayOptions): IRayHit | undefined {
    return this.#simulation.intersectRay(rayQuery(options));
  }

  intersectShape(options: IIntersectShapeOptions): readonly IShapeHit[] {
    return this.#simulation.intersectShape(shapeQuery(options));
  }

  intersectPoint(options: IIntersectPointOptions): readonly IPointHit[] {
    return this.#simulation.intersectPoint(pointQuery(options));
  }
}
