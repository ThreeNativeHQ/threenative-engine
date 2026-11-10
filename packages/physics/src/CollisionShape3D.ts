import { isStreamedGeometry } from "@threenative/core";
import type { Mesh } from "three";
import { interactionGroups } from "./collision.js";
import {
  type IPhysicsShapeDescriptor,
  type PhysicsShapeKind,
  physicsSimulationBackend,
} from "./simulation.js";

export type CollisionShapeKind = PhysicsShapeKind;

/** A backend-specific escape hatch: Rapier on web, opaque on native. */
export interface ICollisionShapeHandle {
  readonly raw: unknown;
}

/** The storage an attribute reads its components from, when it has some of its own. */
interface IAttributeStorage {
  readonly array: ArrayLike<number>;
  readonly count: number;
  readonly itemSize: number;
  readonly normalized: boolean;
  readonly isInterleavedBufferAttribute?: boolean;
}

/**
 * The attribute's own array when its components sit contiguously in it, unnormalised.
 *
 * `getX`/`getY`/`getZ` are three reads per vertex where the array already is the vertex list, and
 * on the owned engine each is a call into the wrapper: extracting a 188 416-triangle band one
 * getter at a time cost 79.6-110.6 ms of a scene enter (strata preview, 2026-11-07). Interleaved
 * and normalised attributes keep the getter path, because their stored numbers are not what a
 * position is; the numbers a collider gets are the same for every kind of attribute.
 */
function attributeStorage(
  attribute: IAttributeStorage,
  itemSize: number,
): ArrayLike<number> | undefined {
  if (attribute.isInterleavedBufferAttribute === true) return undefined;
  if (attribute.normalized || attribute.itemSize !== itemSize) return undefined;
  // An array longer than the attribute's own items is a view over somebody else's data (a shared
  // buffer, a strided layout): only a list that is exactly the items may be read positionally.
  return attribute.array.length === attribute.count * itemSize ? attribute.array : undefined;
}

function geometryVertices(mesh: Mesh): Float32Array {
  const position = mesh.geometry.getAttribute("position");
  if (position === undefined)
    throw new Error("CollisionShape3D.fromMesh requires vertex positions.");
  const vertices = new Float32Array(position.count * 3);
  const storage = attributeStorage(position, 3);
  if (storage === undefined)
    for (let index = 0; index < position.count; index++) {
      vertices[index * 3] = position.getX(index);
      vertices[index * 3 + 1] = position.getY(index);
      vertices[index * 3 + 2] = position.getZ(index);
    }
  else vertices.set(storage);
  const { x, y, z } = mesh.scale;
  if (x === 1 && y === 1 && z === 1) return vertices;
  for (let index = 0; index < vertices.length; index += 3) {
    vertices[index] = (vertices[index] as number) * x;
    vertices[index + 1] = (vertices[index + 1] as number) * y;
    vertices[index + 2] = (vertices[index + 2] as number) * z;
  }
  return vertices;
}

function geometryIndices(mesh: Mesh): Uint32Array {
  const index = mesh.geometry.getIndex();
  if (index !== null) {
    const storage = attributeStorage(index, 1);
    return storage === undefined
      ? Uint32Array.from({ length: index.count }, (_, offset) => index.getX(offset))
      : Uint32Array.from(storage);
  }
  const count = mesh.geometry.getAttribute("position")?.count ?? 0;
  if (count === 0 || count % 3 !== 0)
    throw new Error("CollisionShape3D.fromMesh requires triangle indices.");
  return Uint32Array.from({ length: count }, (_, offset) => offset);
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`CollisionShape3D.${label} requires a positive finite value.`);
  return value;
}

function applyRaw(raw: unknown, method: string, ...args: unknown[]): void {
  if (typeof raw !== "object" || raw === null || !(method in raw)) return;
  const operation = (raw as Record<string, unknown>)[method];
  if (typeof operation === "function") operation.apply(raw, args);
}

export class CollisionShape3D {
  readonly #descriptor: IPhysicsShapeDescriptor;
  #backendRaw: unknown;

  private constructor(descriptor: IPhysicsShapeDescriptor) {
    this.#descriptor = descriptor;
  }

  /** Backend-neutral data consumed by the selected IPhysicsSimulation adapter. */
  get descriptor(): IPhysicsShapeDescriptor {
    return this.#descriptor;
  }

  /** Backend-specific escape hatch: Rapier's descriptor on web, or an opaque native handle. */
  get raw(): unknown {
    if (this.#backendRaw === undefined) {
      try {
        const createShape = physicsSimulationBackend().createShape;
        if (createShape !== undefined) this.#backendRaw = createShape(this.#descriptor);
      } catch {
        // Registration will fail closed if the selected backend cannot represent this shape.
      }
    }
    return this.#backendRaw ?? this.#descriptor;
  }

  /** Internal seam: the backend binds its own descriptor when the body is created. */
  bindRaw(raw: unknown): void {
    this.#backendRaw = raw;
    applyRaw(
      raw,
      "setCollisionGroups",
      interactionGroups(this.#descriptor.collisionLayer, this.#descriptor.collisionMask),
    );
    applyRaw(raw, "setSensor", this.#descriptor.sensor);
  }

  static box(width: number, height: number, depth: number): CollisionShape3D {
    return new CollisionShape3D({
      collisionLayer: 1,
      collisionMask: 0xffff,
      kind: "box",
      sensor: false,
      x: finitePositive(width, "box") / 2,
      y: finitePositive(height, "box") / 2,
      z: finitePositive(depth, "box") / 2,
    });
  }

  static sphere(radius: number): CollisionShape3D {
    return new CollisionShape3D({
      collisionLayer: 1,
      collisionMask: 0xffff,
      kind: "sphere",
      sensor: false,
      x: finitePositive(radius, "sphere"),
      y: 0,
      z: 0,
    });
  }

  /**
   * A capsule of total height `2 * (halfHeight + radius)`, **centred on the body's origin** like
   * every other shape here — `halfHeight` is the straight section's half-length, measured from
   * that centre, and the hemispherical cap adds `radius` beyond it.
   *
   * So the body origin sits at the character's waist, not at its feet. A visual rig modelled
   * standing on its own origin, parented straight onto the body object, therefore floats exactly
   * `halfHeight + radius` above every surface it lands on. Offset the rig down by that amount:
   *
   * ```ts
   * const shape = CollisionShape3D.capsule(0.26, 0.28);
   * rig.position.y = -(0.26 + 0.28); // feet reach the capsule's bottom cap
   * ```
   */
  static capsule(halfHeight: number, radius: number): CollisionShape3D {
    if (!Number.isFinite(halfHeight) || halfHeight < 0)
      throw new Error("CollisionShape3D.capsule requires a finite non-negative halfHeight.");
    return new CollisionShape3D({
      collisionLayer: 1,
      collisionMask: 0xffff,
      kind: "capsule",
      sensor: false,
      x: halfHeight,
      y: finitePositive(radius, "capsule"),
      z: 0,
    });
  }

  static heightfield(
    rows: number,
    columns: number,
    heights: Float32Array,
    scale: { x: number; y: number; z: number },
  ): CollisionShape3D {
    if (!Number.isInteger(rows) || rows < 2)
      throw new Error("CollisionShape3D.heightfield requires at least 2 rows.");
    if (!Number.isInteger(columns) || columns < 2)
      throw new Error("CollisionShape3D.heightfield requires at least 2 columns.");
    if (heights.length !== rows * columns)
      throw new Error(
        `CollisionShape3D.heightfield expected ${rows * columns} heights, received ${heights.length}.`,
      );
    return new CollisionShape3D({
      collisionLayer: 1,
      collisionMask: 0xffff,
      kind: "heightfield",
      sensor: false,
      x: 0,
      y: 0,
      z: 0,
      rows,
      columns,
      heights,
      shape: { ncols: columns - 1, nrows: rows - 1, scale },
      scale,
    });
  }

  /** Godot's ConcavePolygonShape3D: x, y, z vertex triples in body-local metres and triangle indices. */
  static trimesh(vertices: Float32Array, indices: Uint32Array): CollisionShape3D {
    if (
      vertices.length < 9 ||
      vertices.length % 3 !== 0 ||
      indices.length < 3 ||
      indices.length % 3 !== 0
    )
      throw new Error("CollisionShape3D.trimesh requires vertex triples and triangle indices.");
    return new CollisionShape3D({
      collisionLayer: 1,
      collisionMask: 0xffff,
      kind: "trimesh",
      sensor: false,
      x: 0,
      y: 0,
      z: 0,
      vertices,
      indices,
    });
  }

  static fromMesh(mesh: Mesh, kind?: CollisionShapeKind): CollisionShape3D {
    const geometry = mesh.geometry;
    // PRD-860: a streamed model resolves with its coarse companion, and a copied vertex set stays
    // coarse after the full file lands. Say so by name; the collider still builds.
    if ((kind === "trimesh" || kind === "convexHull") && isStreamedGeometry(geometry))
      console.warn(
        `TN_COLLIDER_COARSE: CollisionShape3D.fromMesh(${JSON.stringify(mesh.name)}, "${kind}") copies the streamed coarse model's vertices; load it with ctx.assets.model(path, { whole: true }) to collide with the full one.`,
      );
    const inferred =
      kind ??
      (geometry.type.toLowerCase().includes("sphere")
        ? "sphere"
        : geometry.type.toLowerCase().includes("capsule")
          ? "capsule"
          : "box");
    if (inferred === "trimesh")
      return new CollisionShape3D({
        collisionLayer: 1,
        collisionMask: 0xffff,
        kind: inferred,
        sensor: false,
        x: 0,
        y: 0,
        z: 0,
        vertices: geometryVertices(mesh),
        indices: geometryIndices(mesh),
      });
    if (inferred === "convexHull")
      return new CollisionShape3D({
        collisionLayer: 1,
        collisionMask: 0xffff,
        kind: inferred,
        sensor: false,
        x: 0,
        y: 0,
        z: 0,
        vertices: geometryVertices(mesh),
      });
    if (inferred === "heightfield")
      throw new Error("CollisionShape3D.fromMesh cannot infer a heightfield.");

    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (bounds === null) throw new Error("CollisionShape3D.fromMesh requires a bounding box.");
    const width = (bounds.max.x - bounds.min.x) * Math.abs(mesh.scale.x);
    const height = (bounds.max.y - bounds.min.y) * Math.abs(mesh.scale.y);
    const depth = (bounds.max.z - bounds.min.z) * Math.abs(mesh.scale.z);
    // A primitive is centred on the body, i.e. on the mesh origin. Geometry whose bounds are not
    // centred there (translated or merged in place) would get a collider displaced from what is
    // drawn — silently, which is how a figure ends up standing on air. Fail closed by name.
    // The comparison is in metres, so each centre component is scaled by its own axis: the
    // dimensions above already are, and an unscaled centre accepted a 0.1 m displacement under a
    // scale of 100 while rejecting a physically centred 1 µm offset under a scale of 1e-6.
    const offset = Math.max(
      (Math.abs(bounds.max.x + bounds.min.x) / 2) * Math.abs(mesh.scale.x),
      (Math.abs(bounds.max.y + bounds.min.y) / 2) * Math.abs(mesh.scale.y),
      (Math.abs(bounds.max.z + bounds.min.z) / 2) * Math.abs(mesh.scale.z),
    );
    if (offset > 1e-4 + 1e-3 * Math.max(width, height, depth))
      throw new Error(
        `TN_COLLISION_SHAPE_OFF_CENTRE: '${mesh.name || "mesh"}' has geometry centred ${offset.toFixed(3)} from its origin, so a ${inferred} collider would sit away from what is drawn. Call geometry.center() and move the mesh instead, pass "trimesh", or build level colliders with buildStaticColliders.`,
      );
    if (inferred === "sphere") {
      geometry.computeBoundingSphere();
      const radius =
        (geometry.boundingSphere?.radius ?? Math.max(width, height, depth) / 2) *
        Math.max(Math.abs(mesh.scale.x), Math.abs(mesh.scale.y), Math.abs(mesh.scale.z));
      return CollisionShape3D.sphere(radius);
    }
    if (inferred === "capsule") {
      const radius = Math.min(width, depth) / 2;
      return CollisionShape3D.capsule(Math.max(0, height / 2 - radius), radius);
    }
    return CollisionShape3D.box(width, height, depth);
  }

  setCollisionGroups(groups: number): this {
    const layer = groups >>> 16;
    const mask = groups & 0xffff;
    interactionGroups(layer, mask);
    this.#descriptor.collisionLayer = layer;
    this.#descriptor.collisionMask = mask;
    applyRaw(this.#backendRaw, "setCollisionGroups", groups);
    return this;
  }

  setSensor(sensor: boolean): this {
    this.#descriptor.sensor = sensor;
    applyRaw(this.#backendRaw, "setSensor", sensor);
    return this;
  }
}
