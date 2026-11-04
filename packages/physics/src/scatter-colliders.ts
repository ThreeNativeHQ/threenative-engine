import { type BufferGeometry, Matrix3, type Matrix4, Vector3 } from "three";
import { CollisionShape3D } from "./CollisionShape3D.js";
import { RigidBody3D } from "./RigidBody3D.js";
import type { IPhysicsContext } from "./plugin.js";

/** How one scattered instance collides. "auto" measures its geometry; the rest force a shape. */
export type ScatterCollision = "auto" | "hull" | "trunk" | "none";

export interface IScatterColliderInstance {
  /** The solid part (stone, bark; not leaves or grass), local to the instance, base at the bottom. */
  readonly geometry: BufferGeometry;
  /** The instance's world transform. */
  readonly matrix: Matrix4;
  /** Named override of the measured shape. Default "auto". */
  readonly collision?: ScatterCollision;
}

export interface IScatterCollidersOptions {
  readonly physics: IPhysicsContext;
  readonly instances: Iterable<IScatterColliderInstance>;
  /** The point bodies stream around, read on every update: usually the player. */
  readonly follow: { readonly position: { readonly x: number; readonly z: number } };
  /** Horizontal metres around `follow` that hold bodies. Default 40. */
  readonly radius?: number;
  readonly collisionLayer?: number;
  readonly collisionMask?: number;
}

export interface IScatterCollidersStats {
  readonly instances: number;
  readonly hulls: number;
  readonly trunks: number;
  readonly skipped: number;
  readonly resident: number;
}

interface IProfile {
  readonly minY: number;
  readonly height: number;
  /** Widest horizontal distance from the local origin. */
  readonly reach: number;
  /** The base band's centre (y = minY) and radius: the trunk a walker meets under the branches. */
  readonly base: Vector3;
  readonly radius: number;
  /** The base is narrow for the height: a trunk, not a rock. */
  readonly slender: boolean;
  readonly hull: { readonly corners: readonly Vector3[]; readonly indices: Uint32Array };
}

/** A walker steps over anything lower; a stem thinner than this bends. */
const MIN_HEIGHT = 0.25;
const MIN_TRUNK_RADIUS = 0.05;
/** The trunk is measured in the bottom tenth of the height, under the lowest branch wood. */
const TRUNK_BAND = 0.1;
/** Licensed spruce bark measures 0.02-0.04 of its height there; every rock measures 0.29 or more. */
const SLENDER = 0.15;
const NONE = 0;
const HULL = 1;
const TRUNK = 2;

// The 18-DOP: three axes and twelve edge diagonals (UE 5.8.3: Engine/Source/Editor/UnrealEd/Private/GeomFitUtils.h:58).
const KDOP18 = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
  [0, 1, 1],
  [0, 1, -1],
  [1, 0, 1],
  [1, 0, -1],
  [1, 1, 0],
  [1, -1, 0],
].flatMap(([x = 0, y = 0, z = 0]) => {
  const direction = new Vector3(x, y, z).normalize();
  return [direction, direction.clone().negate()];
});

/** Corners where three of the farthest planes meet inside all the others, deduplicated. */
function kdopCorners(extent: readonly number[], eps: number): Vector3[] {
  const corners: Vector3[] = [];
  const [bc, ca, ab] = [new Vector3(), new Vector3(), new Vector3()];
  KDOP18.forEach((a, i) => {
    KDOP18.forEach((b, j) => {
      KDOP18.forEach((c, k) => {
        if (j <= i || k <= j) return;
        const det = a.dot(bc.crossVectors(b, c));
        if (Math.abs(det) < 1e-6) return;
        ca.crossVectors(c, a);
        ab.crossVectors(a, b);
        const corner = bc
          .clone()
          .multiplyScalar(extent[i] as number)
          .addScaledVector(ca, extent[j] as number)
          .addScaledVector(ab, extent[k] as number)
          .divideScalar(det);
        const outside = KDOP18.some((d, plane) => d.dot(corner) > (extent[plane] as number) + eps);
        if (!outside && !corners.some((seen) => seen.distanceTo(corner) < eps))
          corners.push(corner);
      });
    });
  });
  return corners;
}

/**
 * The k-DOP that bounds the points, as a closed triangle surface: each plane's corners fanned in
 * outward winding. Unreal's auto collision for an imported mesh (UE 5.8.3:
 * Engine/Source/Editor/UnrealEd/Private/Fbx/FbxStaticMeshImport.cpp:2436-2443, fitted by
 * Engine/Source/Runtime/GeometryCore/Public/CompGeom/FitKDOP3.h:36). A trimesh rather than a convex
 * hull because the native backend builds trimeshes and no convex hulls.
 */
function kdopSurface(points: readonly Vector3[], size: number): IProfile["hull"] {
  const extent = KDOP18.map((direction) =>
    points.reduce((max, point) => Math.max(max, direction.dot(point)), Number.NEGATIVE_INFINITY),
  );
  const eps = 1e-3 * size;
  const corners = kdopCorners(extent, eps);
  const indices: number[] = [];
  const [centre, u, v, offset] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
  KDOP18.forEach((normal, plane) => {
    const face = corners.flatMap((corner, index) =>
      Math.abs(normal.dot(corner) - (extent[plane] as number)) <= eps ? [index] : [],
    );
    if (face.length < 3) return;
    centre.set(0, 0, 0);
    for (const index of face) centre.add(corners[index] as Vector3);
    centre.divideScalar(face.length);
    u.crossVectors(normal, Math.abs(normal.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0));
    v.crossVectors(normal, u);
    const angle = (index: number) => {
      offset.subVectors(corners[index] as Vector3, centre);
      return Math.atan2(offset.dot(v), offset.dot(u));
    };
    face.sort((left, right) => angle(left) - angle(right));
    for (let index = 1; index + 1 < face.length; index++)
      indices.push(face[0] as number, face[index] as number, face[index + 1] as number);
  });
  return { corners, indices: new Uint32Array(indices) };
}

const profiles = new WeakMap<BufferGeometry, IProfile>();

function profileOf(geometry: BufferGeometry): IProfile {
  const cached = profiles.get(geometry);
  if (cached !== undefined) return cached;
  const position = geometry.getAttribute("position");
  if (position === undefined || position.count < 4)
    throw new Error("ScatterColliders requires geometry with at least four vertex positions.");
  const points = Array.from({ length: position.count }, (_, index) =>
    new Vector3().fromBufferAttribute(position, index),
  );
  let [minY, maxY, reach, size] = [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1e-6];
  for (const point of points) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
    reach = Math.max(reach, Math.hypot(point.x, point.z));
    size = Math.max(size, Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
  }
  const height = maxY - minY;
  const band = points.filter((point) => point.y <= minY + TRUNK_BAND * height);
  const median = (axis: "x" | "z") =>
    band.map((point) => point[axis]).sort((a, b) => a - b)[band.length >> 1] ?? 0;
  const base = new Vector3(median("x"), minY, median("z"));
  const spread = band
    .map((point) => Math.hypot(point.x - base.x, point.z - base.z))
    .sort((a, b) => a - b);
  // The 90th percentile: a low twig in the band must not widen the trunk.
  const radius = spread[Math.floor(spread.length * 0.9)] ?? 0;
  const profile: IProfile = {
    minY,
    height,
    reach,
    base,
    radius,
    slender: radius <= SLENDER * height,
    hull: kdopSurface(points, size),
  };
  profiles.set(geometry, profile);
  return profile;
}

const column = new Vector3();
/** The instance's vertical scale and its widest horizontal scale. */
function scales(matrix: Matrix4): { up: number; across: number } {
  const x = column.setFromMatrixColumn(matrix, 0).length();
  const z = column.setFromMatrixColumn(matrix, 2).length();
  return { up: column.setFromMatrixColumn(matrix, 1).length(), across: Math.max(x, z) };
}

function classify(instance: IScatterColliderInstance): number {
  const collision = instance.collision ?? "auto";
  if (collision === "none") return NONE;
  if (collision === "hull") return HULL;
  if (collision === "trunk") return TRUNK;
  if (collision !== "auto")
    throw new Error(`ScatterColliders collision '${String(collision)}' is unknown.`);
  const profile = profileOf(instance.geometry);
  const { up, across } = scales(instance.matrix);
  if (profile.height * up < MIN_HEIGHT) return NONE;
  if (!profile.slender) return HULL;
  return profile.radius * across < MIN_TRUNK_RADIUS ? NONE : TRUNK;
}

/**
 * Fixed bodies for scattered props (rocks, trunks), created near a followed point and released
 * past it, so 100k placements cost one cheap scan per few metres walked and only the nearby
 * bodies live in the physics world. Unreal gives each foliage instance a body from its mesh's
 * simple collision (UE 5.8.3: Engine/Source/Runtime/Engine/Private/InstancedStaticMesh.cpp:2847,
 * :2875) and World Partition streams them with the cell; here the follow radius is the cell.
 *
 * Shapes are measured, never authored: a slender base becomes a capsule around the trunk (the
 * crown and branch wood stay passable), anything else becomes the 18-DOP hull Unreal generates on
 * import, and pieces under knee height or thinner than a stem get no body. `collision` on an
 * instance overrides the measurement by name.
 */
export class ScatterColliders {
  readonly #physics: IPhysicsContext;
  readonly #follow: IScatterCollidersOptions["follow"];
  readonly #radius: number;
  readonly #layer: number | undefined;
  readonly #mask: number | undefined;
  readonly #instances: {
    instance: IScatterColliderInstance;
    kind: number;
    x: number;
    z: number;
    reach: number;
  }[] = [];
  readonly #resident = new Map<number, RigidBody3D>();
  readonly #counts = { hulls: 0, trunks: 0, skipped: 0 };
  #lastX = Number.NaN;
  #lastZ = Number.NaN;
  #disposed = false;

  constructor(options: IScatterCollidersOptions) {
    if (options?.physics === undefined)
      throw new Error("ScatterColliders requires a physics context.");
    const radius = options.radius ?? 40;
    if (!Number.isFinite(radius) || radius <= 0)
      throw new Error(
        `ScatterColliders radius must be a positive finite number, received ${String(radius)}.`,
      );
    this.#physics = options.physics;
    this.#follow = options.follow;
    this.#radius = radius;
    this.#layer = options.collisionLayer;
    this.#mask = options.collisionMask;
    for (const instance of options.instances) {
      const kind = classify(instance);
      if (kind === NONE) {
        this.#counts.skipped++;
        continue;
      }
      const x = instance.matrix.elements[12] as number;
      const z = instance.matrix.elements[14] as number;
      if (!Number.isFinite(x) || !Number.isFinite(z))
        throw new Error(
          `ScatterColliders instance ${this.#instances.length} has a non-finite position.`,
        );
      const reach = profileOf(instance.geometry).reach * scales(instance.matrix).across;
      this.#instances.push({ instance, kind, x, z, reach });
      if (kind === HULL) this.#counts.hulls++;
      else this.#counts.trunks++;
    }
    console.info(`TN_SCATTER_COLLIDERS:${JSON.stringify({ ...this.#counts, radius })}`);
  }

  /** Create the bodies the follow point nears and release the ones it left. Cheap to call per frame. */
  update(): void {
    if (this.#disposed) return;
    const { x, z } = this.#follow.position;
    // ponytail: a linear scan per refresh (20k placements in well under a millisecond); a grid when a world passes ~1M.
    if (Math.hypot(x - this.#lastX, z - this.#lastZ) < this.#radius / 4) return;
    this.#lastX = x;
    this.#lastZ = z;
    this.#instances.forEach((entry, index) => {
      const gap = Math.hypot(entry.x - x, entry.z - z) - entry.reach;
      const body = this.#resident.get(index);
      if (gap <= this.#radius) {
        if (body === undefined) this.#resident.set(index, this.#create(entry.instance, entry.kind));
      } else if (body !== undefined && gap > this.#radius * 1.25) {
        body.dispose();
        this.#resident.delete(index);
      }
    });
  }

  #create(instance: IScatterColliderInstance, kind: number): RigidBody3D {
    const profile = profileOf(instance.geometry);
    const origin = new Vector3().setFromMatrixPosition(instance.matrix);
    const linear = new Matrix3().setFromMatrix4(instance.matrix);
    const common = {
      physics: this.#physics,
      type: "fixed" as const,
      collisionLayer: this.#layer,
      collisionMask: this.#mask,
    };
    if (kind === TRUNK) {
      // ponytail: the capsule stands upright; a tilted trunk keeps its base and leans out of it.
      const { up, across } = scales(instance.matrix);
      const height = profile.height * up;
      const radius = profile.radius * across;
      const base = profile.base.clone().applyMatrix3(linear).add(origin);
      return new RigidBody3D({
        ...common,
        position: { x: base.x, y: base.y + height / 2, z: base.z },
        shape: CollisionShape3D.capsule(Math.max(0, height / 2 - radius), radius),
      });
    }
    const vertices = new Float32Array(profile.hull.corners.length * 3);
    profile.hull.corners.forEach((corner, index) => {
      corner
        .clone()
        .applyMatrix3(linear)
        .toArray(vertices, index * 3);
    });
    return new RigidBody3D({
      ...common,
      position: origin,
      shape: CollisionShape3D.trimesh(vertices, profile.hull.indices),
    });
  }

  stats(): IScatterCollidersStats {
    return { instances: this.#instances.length, ...this.#counts, resident: this.#resident.size };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const body of this.#resident.values()) body.dispose();
    this.#resident.clear();
  }
}
