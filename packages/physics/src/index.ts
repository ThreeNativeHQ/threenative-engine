import "./web.js";

/**
 * Detect overlaps without turning the body into a moving collider.
 * @situation detect when an enemy enters a trigger area
 * @situation react to a player entering a zone
 * @alias pick up item
 * @constraint add the area to the physics context before stepping the world
 * @deprecatedOption Constructor option `world` is deprecated; pass an IPhysicsContext as `physics` instead. Area3D itself is not deprecated.
 * @example const goal = new Area3D({ physics: ctx.physics, shape: CollisionShape3D.sphere(1.2), position: { x: 0, y: 0.5, z: -8 } });
 * @requires npm i @threenative/physics
 */
export { Area3D } from "./Area3D.js";
/**
 * Move a character body with collision-aware sliding.
 * @situation move an enemy or player through a level
 * @situation keep a character from walking through walls
 * @alias raised platform gap hazard restart
 * @alias enemy targets cooldown reload win condition
 * @alias platformer double jump
 * @alias first person
 * @alias run jump coins goal
 * @constraint use moveAndSlide inside the physics update
 * @deprecatedOption Constructor option `world` is deprecated; pass an IPhysicsContext as `physics` instead. CharacterBody3D itself is not deprecated.
 * @example const body = new CharacterBody3D({ object: hero, physics: ctx.physics, shape: CollisionShape3D.capsule(0.5, 0.35) });
 * @requires npm i @threenative/physics
 */
export { CharacterBody3D } from "./CharacterBody3D.js";
/**
 * Give a physics body a Three.js collision shape.
 * @situation add a capsule or box collider to a character
 * @situation configure the shape used by a rigid body
 * @alias passes through body
 * @alias arena walls pickups
 * @constraint create shapes through the owning physics context
 * @example const shape = CollisionShape3D.capsule(0.5, 0.35);
 * @requires npm i @threenative/physics
 */
export { CollisionShape3D } from "./CollisionShape3D.js";
export type { ICollisionShapeHandle } from "./CollisionShape3D.js";
/**
 * Float a rigid body on a game-owned height source with fixed-step force ordering.
 * @situation float a boat on waves
 * @situation keep a hull above a moving water surface
 * @constraint supply hull points, density, drag, and the height source
 * @override buoyancy disables force application while submergedFraction remains measured
 * @example new Buoyancy3D({ body, surface: field, hullPoints, density: 1_000, drag: 4 });
 * @requires npm i @threenative/physics
 */
export { Buoyancy3D } from "./Buoyancy3D.js";
export type {
  BuoyancyPointPosition,
  IBuoyancy3DOptions,
  IBuoyancyHullPoint,
  IBuoyancySurface,
  IBuoyancySurfaceSample,
} from "./Buoyancy3D.js";
/**
 * Connect two physics bodies with a Godot-style joint.
 * @situation constrain a rigid body to another body
 * @situation build a hinge or pin mechanism
 * @situation swing a pendulum, wrecking ball, or hinged door on a joint
 * @constraint both bodies must belong to the same physics context
 * @deprecatedOption Constructor option `world` is deprecated; pass an IPhysicsContext as `physics` instead. Joint3D itself is not deprecated.
 * @example const hinge = Joint3D.hinge({ physics: ctx.physics, bodyA: beam, bodyB: bob, anchorA: { x: 0, y: 0, z: 0 }, anchorB: { x: 0, y: 2.4, z: 0 }, axis: { x: 1, y: 0, z: 0 } });
 * @requires npm i @threenative/physics
 */
export { Joint3D } from "./Joint3D.js";
export type {
  IFixedJoint3DOptions,
  IHingeJoint3DOptions,
  IJoint3DOptions,
  IPinJoint3DOptions,
  PhysicsJointBody,
} from "./Joint3D.js";
/**
 * Query the physics world without creating a body.
 * @situation raycast for visibility or aiming
 * @situation find bodies inside a shape or point query
 * @alias hitscan camera
 * @constraint query results are bounded by the configured result limit
 * @example const space = new PhysicsDirectSpaceState3D(context);
 * @requires npm i @threenative/physics
 */
export { PhysicsDirectSpaceState3D } from "./PhysicsDirectSpaceState3D.js";
/**
 * Build fixed trimesh bodies from the meshes a game authored in a scene root.
 * @situation make the level I built stop the player
 * @situation turn a cathedral or map scene into static collision
 * @constraint supply the game-owned predicate for decorative meshes; the helper throws when it selects nothing
 * @constraint generated bodies use trimesh geometry and world-space instance transforms
 * @example const colliders = buildStaticColliders(ctx, level, { predicate: (object) => object.name.startsWith("wall") });
 * @requires npm i @threenative/physics
 */
export { buildStaticColliders } from "./static-colliders.js";
export type {
  IBuildStaticCollidersOptions,
  IStaticColliderContext,
  StaticColliderPredicate,
} from "./static-colliders.js";
/**
 * Feed existing rigid-body boxes into `SoftBody3D` without inventing a second collider API.
 * @situation stop a cloth flag, cape, or curtain at an existing physics wall
 * @situation collide SoftBody3D with fixed box bodies
 * @constraint every body must use CollisionShape3D.box and retain its Three.js object transform
 * @constraint rotated boxes become conservative cloth-local axis-aligned bounds
 * @example const cloth = new SoftBody3D(mesh, { ...options, collision: softBodyCollision(wall) });
 * @requires npm i @threenative/physics
 */
export { softBodyCollision } from "./softbody-collision.js";
// Capability metadata for the snow binding lives on its declarations in snow.ts.
export { attachSnowPhysics, boxFootprint, capsuleFootprint } from "./snow.js";
export type {
  ISnowPhysicsBinding,
  ISnowPhysicsObservation,
  ISnowPhysicsOptions,
} from "./snow.js";
export type {
  IIntersectPointOptions,
  IIntersectRayOptions,
  IIntersectShapeOptions,
  IPointHit,
  IRayHit,
  IShapeHit,
  PhysicsQueryVector3,
} from "./PhysicsDirectSpaceState3D.js";
export type {
  IPhysicsBodyHandle,
  IPhysicsColliderHandle,
  IPhysicsHandle,
  IPhysicsWorldHandle,
} from "./handles.js";
/**
 * Encode collision layers and masks for Rapier groups.
 * @situation make an enemy collide with the world but not pickups
 * @situation configure which physics layers interact
 * @example const groups = interactionGroups(1, 3);
 * @requires npm i @threenative/physics
 */
export { interactionGroups } from "./collision.js";
/**
 * Simulate a dynamic or static rigid body.
 * @situation give a crate or prop physical motion
 * @situation create a body that collides with a character
 * @situation fire physical cannonballs that collide with ships or scenery
 * @situation fire a cannonball projectile with cannon smoke particles
 * @situation a bullet passes through a wall
 * @constraint register rapier() in the game plugin list before using bodies
 * @override continuousCollision: false opts one body out while body.continuousCollision still reports the effective setting
 * @deprecatedOption Constructor option `world` is deprecated; pass an IPhysicsContext as `physics` instead. RigidBody3D itself is not deprecated.
 * @example const crate = new RigidBody3D({ object, physics: ctx.physics, shape: CollisionShape3D.box(1, 1, 1), mass: 8 });
 * @requires npm i @threenative/physics
 */
export { RigidBody3D } from "./RigidBody3D.js";
export type { IRigidBody3DOptions, RigidBodyType } from "./RigidBody3D.js";
/**
 * Install the Rapier physics plugin and simulation backend.
 * @situation add physics to a portable game
 * @situation provide the context used by character and rigid bodies
 * @constraint place rapier() before recast() in the plugin list
 * @example const game = defineGame({ plugins: [rapier()] });
 * @requires npm i @threenative/physics
 */
export { rapier } from "./plugin.js";
export type { PhysicsBody3D, IPhysicsContext } from "./plugin.js";
export {
  MAX_PHYSICS_QUERY_RESULTS,
  PHYSICS_COLLISION_EVENT_STRIDE,
  PHYSICS_TRANSFORM_STRIDE,
  PHYSICS_VEHICLE_WHEEL_STRIDE,
} from "./simulation.js";
export type {
  IPhysicsBodyCreateOptions,
  IPhysicsCharacterOptions,
  IPhysicsInputSnapshot,
  IPhysicsJointCreateOptions,
  IPhysicsJointLimit,
  IPhysicsRuntimeSimulation,
  IPhysicsShapeDescriptor,
  PhysicsShapeKind,
  IPhysicsSimulation,
  IPhysicsPointQuery,
  IPhysicsQueryHit,
  IPhysicsRayHit,
  IPhysicsRayQuery,
  IPhysicsRotation,
  IPhysicsShapeQuery,
  IPhysicsVector3,
  IPhysicsVehicleCreateOptions,
  IPhysicsVehicleInput,
  IPhysicsVehicleState,
  PhysicsJointKind,
} from "./simulation.js";
/**
 * Drive a car on ray-cast suspension instead of faking speed and heading.
 * @situation drive a car, truck or bike around a track
 * @situation make a vehicle roll over kerbs, brake into a corner or stop at a wall
 * @alias racing car racing kart drift vehicle go-kart
 * @alias suspension wheel traction tyre grip
 * @alias accelerator pedal handbrake steering wheel
 * @alias rescue respawn flip back on track
 * @constraint write engineForce, brake and steering every physics update; a car with no input does not move
 * @constraint suspensionStiffness is a frequency squared, not newtons per metre; 100 is a road car and 20 bottoms out
 * @override a wheel ray never hits the chassis it hangs from, and it honours the chassis collision mask
 * @override continuousCollision is on for the chassis, so a fast car cannot tunnel through a wall
 * @example const car = new VehicleBody3D({ object: chassis, physics: ctx.physics, shape: CollisionShape3D.box(1.6, 0.5, 3.6), mass: 900, wheels: [{ position: { x: 0.8, y: -0.15, z: -1.2 }, wheelRadius: 0.34, suspensionRestLength: 0.3, suspensionStiffness: 100, dampingCompression: 2.3, dampingRelaxation: 4.4, wheelFrictionSlip: 10.5, maxSuspensionTravel: 0.3, useAsSteering: true, useAsTraction: false }] });
 * @requires npm i @threenative/physics
 */
export { VehicleBody3D } from "./VehicleBody3D.js";
export type {
  IVehicleBody3DOptions,
  IVehicleWheel3D,
  VehicleForwardAxis,
} from "./VehicleBody3D.js";
