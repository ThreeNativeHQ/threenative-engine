import { InstancedMesh, Matrix4, Mesh, Object3D, Quaternion, Vector3 } from "three";
import { CollisionShape3D } from "./CollisionShape3D.js";
import { RigidBody3D } from "./RigidBody3D.js";
import type { IPhysicsContext } from "./plugin.js";

const DEFAULT_REACHABLE_CEILING = 4.5;

export type StaticColliderPredicate = (object: Object3D) => boolean;

export interface IStaticColliderContext {
  readonly physics: IPhysicsContext;
}

export interface IBuildStaticCollidersOptions {
  /** Game-owned filter for decorative or otherwise non-colliding meshes. */
  readonly predicate?: StaticColliderPredicate;
  /** Alias for predicate when the call site wants the intent to read explicitly. */
  readonly shouldCollide?: StaticColliderPredicate;
  /** Meshes whose lowest point is at or above this height are outside the reachable world. */
  readonly reachableCeiling?: number;
  /** Collision layer occupied by the generated fixed bodies. */
  readonly collisionLayer?: number;
  /** Collision mask scanned by the generated fixed bodies. */
  readonly collisionMask?: number;
}

type StaticColliderFilter = StaticColliderPredicate | IBuildStaticCollidersOptions;

const scratchInstance = new Matrix4();
const scratchWorld = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchRotation = new Quaternion();

function optionsFor(filter: StaticColliderFilter | undefined): IBuildStaticCollidersOptions {
  return typeof filter === "function" ? { predicate: filter } : (filter ?? {});
}

function validateCeiling(value: number): number {
  if (!Number.isFinite(value))
    throw new Error(
      `buildStaticColliders reachableCeiling must be finite, received ${String(value)}.`,
    );
  return value;
}

function selectPredicate(options: IBuildStaticCollidersOptions): StaticColliderPredicate {
  const predicate = options.predicate ?? options.shouldCollide ?? (() => true);
  return (object) => {
    const selected = predicate(object);
    if (typeof selected !== "boolean")
      throw new Error(`buildStaticColliders predicate must return a boolean for '${object.name}'.`);
    return selected;
  };
}

function configureCarrier(carrier: Mesh, transform: Matrix4, scale: Vector3): void {
  transform.decompose(scratchPosition, scratchRotation, scale);
  carrier.position.copy(scratchPosition);
  carrier.quaternion.copy(scratchRotation);
  carrier.scale.copy(scale);
  carrier.updateMatrixWorld(true);
}

/**
 * Whether the carrier's lowest world-space vertex sits below the ceiling: the exact answer
 * `Box3.setFromObject(carrier, true)` gives, read from the Y row of the world matrix alone.
 * The Box3 walk calls getVertexPosition and applyMatrix4 per vertex, about 35 ms per arena at load.
 */
function isReachable(carrier: Mesh, ceiling: number): boolean {
  const position = carrier.geometry.getAttribute("position");
  if (position === undefined || position.count === 0) return false;
  const e = carrier.matrixWorld.elements;
  const [m1, m5, m9, m13] = [e[1] ?? 0, e[5] ?? 0, e[9] ?? 0, e[13] ?? 0];
  for (let i = 0; i < position.count; i++)
    if (m1 * position.getX(i) + m5 * position.getY(i) + m9 * position.getZ(i) + m13 < ceiling)
      return true;
  return false;
}

function addCollider(
  context: IStaticColliderContext,
  source: Mesh,
  transform: Matrix4,
  options: IBuildStaticCollidersOptions,
): RigidBody3D | undefined {
  const carrier = new Mesh(source.geometry);
  const shapeSource = new Mesh(source.geometry);
  configureCarrier(carrier, transform, scratchScale);
  shapeSource.scale.copy(scratchScale);
  if (!isReachable(carrier, options.reachableCeiling ?? DEFAULT_REACHABLE_CEILING))
    return undefined;

  return new RigidBody3D({
    collisionLayer: options.collisionLayer,
    collisionMask: options.collisionMask,
    object: carrier,
    physics: context.physics,
    shape: CollisionShape3D.fromMesh(shapeSource, "trimesh"),
    type: "fixed",
  });
}

/**
 * Turn selected meshes under an authored scene root into fixed trimesh bodies.
 *
 * The root and predicate belong to the game; this helper owns the reusable walk, reachability
 * cull, exact pierced-mesh shape and world-space instance carrier. It returns every generated
 * body so the game can dispose or inspect the cold-path registrations, and throws when the filter
 * produces no colliders rather than letting a level silently become non-solid.
 */
export function buildStaticColliders(
  context: IStaticColliderContext,
  root: Object3D,
  filter?: StaticColliderFilter,
): readonly RigidBody3D[] {
  if (context?.physics === undefined)
    throw new Error("buildStaticColliders requires a physics context.");
  if (!(root instanceof Object3D))
    throw new Error("buildStaticColliders requires an Object3D root.");

  const options = optionsFor(filter);
  const ceiling = validateCeiling(options.reachableCeiling ?? DEFAULT_REACHABLE_CEILING);
  const predicate = selectPredicate(options);
  const bodies: RigidBody3D[] = [];
  root.updateMatrixWorld(true);

  try {
    root.traverse((object) => {
      if (!predicate(object) || !(object instanceof Mesh)) return;
      if (object instanceof InstancedMesh) {
        for (let index = 0; index < object.count; index += 1) {
          object.getMatrixAt(index, scratchInstance);
          scratchWorld.multiplyMatrices(object.matrixWorld, scratchInstance);
          const body = addCollider(context, object, scratchWorld, {
            ...options,
            reachableCeiling: ceiling,
          });
          if (body !== undefined) bodies.push(body);
        }
        return;
      }
      const body = addCollider(context, object, object.matrixWorld, {
        ...options,
        reachableCeiling: ceiling,
      });
      if (body !== undefined) bodies.push(body);
    });
  } catch (error) {
    for (const body of bodies) body.dispose();
    throw error;
  }

  console.info(`TN_STATIC_COLLIDERS:${JSON.stringify({ count: bodies.length })}`);
  if (bodies.length === 0)
    throw new Error("buildStaticColliders produced zero colliders; check the scene and predicate.");
  return bodies;
}
