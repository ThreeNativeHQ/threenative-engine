import { AttachedBindMode, Box3, type Object3D, Quaternion, Vector3 } from "three";
import type { Mesh, SkinnedMesh } from "three";

/**
 * Brings every attached-mode skinned mesh under `root` to the bind state the renderer would give it.
 *
 * `SkinnedMesh` refreshes `bindMatrixInverse` in `updateMatrixWorld` — the renderer's call — and not
 * in `updateWorldMatrix`, which is what a measurement makes. After a figure moves between a render
 * and a measurement, three places the skin at the figure's old transform: measured that way, a
 * finger bone of the shipped mannequin got a 3.8 m envelope sphere and GroundSnap held the figure
 * 0.66 m above its floor. Re-deriving it here is exactly what `updateMatrixWorld` does.
 */
function syncSkinBindings(root: Object3D): void {
  root.traverse((object) => {
    const skinned = object as Partial<SkinnedMesh>;
    if (skinned.isSkinnedMesh === true && skinned.bindMode === AttachedBindMode)
      skinned.bindMatrixInverse?.copy(object.matrixWorld).invert();
  });
}

export type ThreePoseVector = readonly [number, number, number];
export type ThreePoseQuaternion = readonly [number, number, number, number];

export interface IThreePoseBounds {
  readonly min: ThreePoseVector;
  readonly max: ThreePoseVector;
  readonly size: ThreePoseVector;
}

/** JSON-safe world-space measurements for one Three.js object and its visual bounds. */
export interface IThreePoseMeasurement {
  readonly name: string;
  readonly type: string;
  readonly position: ThreePoseVector;
  readonly quaternion: ThreePoseQuaternion;
  readonly scale: ThreePoseVector;
  readonly axes: {
    readonly x: ThreePoseVector;
    readonly y: ThreePoseVector;
    readonly z: ThreePoseVector;
  };
  readonly bounds: IThreePoseBounds | null;
}

export interface IMeasureThreePoseOptions {
  /**
   * Objects whose geometry forms the reported bounds. Defaults to `object`.
   * This path is precise; it walks every vertex. Do not call it in a frame loop — see
   * `posedBounds`.
   */
  readonly bounds?: readonly Object3D[] | false;
}

function vector(value: Vector3): ThreePoseVector {
  return [value.x, value.y, value.z];
}

/**
 * Measure an Object3D in world space for attachment and animation diagnostics.
 *
 * Passing explicit `bounds` lets a probe measure a body without an attached weapon or
 * invisible hitbox. The result is JSON-safe so it can cross the browser playtest bridge.
 */
export function measureThreePose(
  object: Object3D,
  options: IMeasureThreePoseOptions = {},
): IThreePoseMeasurement {
  if (options.bounds !== undefined && options.bounds !== false && options.bounds.length === 0) {
    throw new Error("measureThreePose bounds must contain at least one Object3D.");
  }

  // A socket/bone probe needs its ancestors current, not every descendant bone. Avoiding that
  // subtree walk matters when a registered entity reports several joints each debug sample.
  object.updateWorldMatrix(true, options.bounds !== false);
  if (options.bounds !== false)
    for (const bounded of options.bounds ?? [object]) syncSkinBindings(bounded);
  const worldPosition = object.getWorldPosition(new Vector3());
  const worldQuaternion = object.getWorldQuaternion(new Quaternion());
  const worldScale = object.getWorldScale(new Vector3());
  const x = new Vector3(1, 0, 0).applyQuaternion(worldQuaternion).normalize();
  const y = new Vector3(0, 1, 0).applyQuaternion(worldQuaternion).normalize();
  const z = new Vector3(0, 0, 1).applyQuaternion(worldQuaternion).normalize();

  let measuredBounds: IThreePoseBounds | null = null;
  if (options.bounds !== false) {
    const bounds = new Box3();
    for (const bounded of options.bounds ?? [object]) bounds.expandByObject(bounded, true);
    if (bounds.isEmpty()) {
      throw new Error(
        `measureThreePose could not measure bounds for '${object.name || object.type}'. Pass { bounds: false } for a geometry-free attachment point.`,
      );
    }
    const size = bounds.getSize(new Vector3());
    measuredBounds = { min: vector(bounds.min), max: vector(bounds.max), size: vector(size) };
  }

  return {
    name: object.name,
    type: object.type,
    position: vector(worldPosition),
    quaternion: [worldQuaternion.x, worldQuaternion.y, worldQuaternion.z, worldQuaternion.w],
    scale: vector(worldScale),
    axes: { x: vector(x), y: vector(y), z: vector(z) },
    bounds: measuredBounds,
  };
}

interface IBoneSphere {
  readonly bone: Object3D;
  readonly radius: number;
}

interface IStaticSphere {
  readonly object: Object3D;
  readonly radius: number;
}

interface IPosedBoundsResult {
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly size: [number, number, number];
}

interface IPosedBoundsEnvelope {
  readonly meshes: readonly Object3D[];
  readonly selection: "default" | "explicit";
  readonly bones: readonly IBoneSphere[];
  readonly statics: readonly IStaticSphere[];
  biasY: number;
  readonly raw: IRawBounds;
  readonly result: IPosedBoundsResult;
}

interface IRawBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const posedBoundsCache = new WeakMap<Object3D, IPosedBoundsEnvelope[]>();

function asMesh(object: Object3D): Mesh | undefined {
  return (object as Mesh).isMesh === true ? (object as Mesh) : undefined;
}

function asSkinnedMesh(mesh: Mesh): SkinnedMesh | undefined {
  const skinned = mesh as SkinnedMesh;
  return skinned.isSkinnedMesh === true && skinned.skeleton !== undefined ? skinned : undefined;
}

function collectMeshes(root: Object3D): Object3D[] {
  const meshes: Object3D[] = [];
  root.traverse((object) => {
    if (asMesh(object) !== undefined) meshes.push(object);
  });
  return meshes;
}

function sameMeshes(left: readonly Object3D[], right: readonly Object3D[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function staticSphereRadius(mesh: Mesh): number | undefined {
  const geometry = mesh.geometry;
  if (geometry.boundingSphere === null) geometry.computeBoundingSphere();
  const sphere = geometry.boundingSphere;
  if (sphere === null || !Number.isFinite(sphere.radius)) return undefined;

  const elements = mesh.matrixWorld.elements;
  const centre = sphere.center;
  const worldCentreX =
    elements[0] * centre.x + elements[4] * centre.y + elements[8] * centre.z + elements[12];
  const worldCentreY =
    elements[1] * centre.x + elements[5] * centre.y + elements[9] * centre.z + elements[13];
  const worldCentreZ =
    elements[2] * centre.x + elements[6] * centre.y + elements[10] * centre.z + elements[14];
  const worldRadius =
    sphere.radius *
    Math.max(
      Math.hypot(elements[0], elements[1], elements[2]),
      Math.hypot(elements[4], elements[5], elements[6]),
      Math.hypot(elements[8], elements[9], elements[10]),
    );
  const offset = Math.hypot(
    worldCentreX - elements[12],
    worldCentreY - elements[13],
    worldCentreZ - elements[14],
  );
  return worldRadius + offset;
}

function preciseMinimumY(meshes: readonly Object3D[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  const bounds = new Box3();
  for (const object of meshes) {
    const mesh = asMesh(object);
    const position = mesh?.geometry.getAttribute("position");
    if (
      mesh &&
      position &&
      asSkinnedMesh(mesh) === undefined &&
      !(mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh &&
      mesh.children.length === 0 &&
      (mesh.geometry.morphAttributes.position?.length ?? 0) === 0
    ) {
      // Calibration needs only the exact lowest world Y. Avoid transforming every vertex
      // in X/Z and updating six box extrema for every copy of the same static geometry.
      const e = mesh.matrixWorld.elements;
      if (e[1] === 0 && e[9] === 0) {
        if (mesh.geometry.boundingBox === null) mesh.geometry.computeBoundingBox();
        const box = mesh.geometry.boundingBox;
        if (box) minimum = Math.min(minimum, (e[5] < 0 ? box.max.y : box.min.y) * e[5] + e[13]);
      } else {
        for (let i = 0; i < position.count; i++)
          minimum = Math.min(
            minimum,
            position.getX(i) * e[1] + position.getY(i) * e[5] + position.getZ(i) * e[9] + e[13],
          );
      }
    } else {
      bounds.makeEmpty().expandByObject(object, true);
      minimum = Math.min(minimum, bounds.min.y);
    }
  }
  if (!Number.isFinite(minimum))
    throw new Error("posedBounds could not measure any mesh geometry.");
  return minimum;
}

function rawBounds(envelope: IPosedBoundsEnvelope, target: IRawBounds): void {
  target.minX = Number.POSITIVE_INFINITY;
  target.minY = Number.POSITIVE_INFINITY;
  target.minZ = Number.POSITIVE_INFINITY;
  target.maxX = Number.NEGATIVE_INFINITY;
  target.maxY = Number.NEGATIVE_INFINITY;
  target.maxZ = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < envelope.bones.length; index += 1) {
    const sphere = envelope.bones[index];
    if (sphere === undefined) continue;
    const elements = sphere.bone.matrixWorld.elements;
    const x = elements[12];
    const y = elements[13];
    const z = elements[14];
    const radius = sphere.radius;
    target.minX = Math.min(target.minX, x - radius);
    target.minY = Math.min(target.minY, y - radius);
    target.minZ = Math.min(target.minZ, z - radius);
    target.maxX = Math.max(target.maxX, x + radius);
    target.maxY = Math.max(target.maxY, y + radius);
    target.maxZ = Math.max(target.maxZ, z + radius);
  }

  for (let index = 0; index < envelope.statics.length; index += 1) {
    const sphere = envelope.statics[index];
    if (sphere === undefined) continue;
    const elements = sphere.object.matrixWorld.elements;
    const x = elements[12];
    const y = elements[13];
    const z = elements[14];
    const radius = sphere.radius;
    target.minX = Math.min(target.minX, x - radius);
    target.minY = Math.min(target.minY, y - radius);
    target.minZ = Math.min(target.minZ, z - radius);
    target.maxX = Math.max(target.maxX, x + radius);
    target.maxY = Math.max(target.maxY, y + radius);
    target.maxZ = Math.max(target.maxZ, z + radius);
  }
}

function createEnvelope(
  root: Object3D,
  meshes: readonly Object3D[],
  selection: IPosedBoundsEnvelope["selection"],
): IPosedBoundsEnvelope {
  root.updateWorldMatrix(true, true);
  syncSkinBindings(root);
  for (const mesh of meshes) syncSkinBindings(mesh);
  const radii = new Map<Object3D, number>();
  const statics: IStaticSphere[] = [];
  const vertex = new Vector3();

  for (const object of meshes) {
    const mesh = asMesh(object);
    if (mesh === undefined) continue;
    if (!addSkinnedMesh(mesh, radii, vertex)) {
      const radius = staticSphereRadius(mesh);
      if (radius !== undefined) statics.push({ object, radius });
    }
  }

  const bones: IBoneSphere[] = [];
  for (const [bone, radius] of radii) bones.push({ bone, radius });
  const result: IPosedBoundsResult = {
    min: [0, 0, 0],
    max: [0, 0, 0],
    size: [0, 0, 0],
  };
  const raw: IRawBounds = {
    minX: 0,
    minY: 0,
    minZ: 0,
    maxX: 0,
    maxY: 0,
    maxZ: 0,
  };
  const envelope: IPosedBoundsEnvelope = {
    meshes,
    selection,
    bones,
    statics,
    biasY: 0,
    raw,
    result,
  };
  rawBounds(envelope, raw);
  const minimumY = preciseMinimumY(meshes);
  envelope.biasY = minimumY - raw.minY;
  return envelope;
}

function addSkinnedMesh(mesh: Mesh, radii: Map<Object3D, number>, vertex: Vector3): boolean {
  const skinned = asSkinnedMesh(mesh);
  const position = mesh.geometry.getAttribute("position");
  const skinIndex = mesh.geometry.getAttribute("skinIndex");
  const skinWeight = mesh.geometry.getAttribute("skinWeight");
  if (
    skinned === undefined ||
    position === undefined ||
    skinIndex === undefined ||
    skinWeight === undefined
  ) {
    return false;
  }

  skinned.skeleton.update();
  for (let index = 0; index < position.count; index += 1) {
    skinned.getVertexPosition(index, vertex);
    vertex.applyMatrix4(mesh.matrixWorld);
    const dominant = dominantSkinIndex(skinIndex, skinWeight, index);
    const bone = skinned.skeleton.bones[dominant];
    if (bone === undefined) continue;
    const elements = bone.matrixWorld.elements;
    const radius = Math.hypot(
      vertex.x - elements[12],
      vertex.y - elements[13],
      vertex.z - elements[14],
    );
    if (radius > (radii.get(bone) ?? 0)) radii.set(bone, radius);
  }
  return true;
}

function dominantSkinIndex(
  indices: ReturnType<Mesh["geometry"]["getAttribute"]>,
  weights: ReturnType<Mesh["geometry"]["getAttribute"]>,
  vertex: number,
): number {
  let dominant = indices.getX(vertex);
  let bestWeight = weights.getX(vertex);
  const secondWeight = weights.getY(vertex);
  if (secondWeight > bestWeight) {
    bestWeight = secondWeight;
    dominant = indices.getY(vertex);
  }
  const thirdWeight = weights.getZ(vertex);
  if (thirdWeight > bestWeight) {
    bestWeight = thirdWeight;
    dominant = indices.getZ(vertex);
  }
  if (weights.getW(vertex) > bestWeight) dominant = indices.getW(vertex);
  return dominant;
}

function getEnvelope(
  root: Object3D,
  requestedMeshes: readonly Object3D[] | undefined,
): IPosedBoundsEnvelope {
  if (requestedMeshes !== undefined && requestedMeshes.length === 0) {
    throw new Error("posedBounds meshes must contain at least one Object3D.");
  }

  const selection = requestedMeshes === undefined ? "default" : "explicit";
  const cached = posedBoundsCache.get(root);
  if (cached !== undefined) {
    for (const envelope of cached) {
      if (envelope.selection !== selection) continue;
      if (selection === "default") return envelope;
      if (requestedMeshes !== undefined && sameMeshes(envelope.meshes, requestedMeshes)) {
        return envelope;
      }
    }
  }

  const meshes = requestedMeshes === undefined ? collectMeshes(root) : [...requestedMeshes];
  if (meshes.length === 0) throw new Error("posedBounds could not find any mesh geometry.");
  const envelope = createEnvelope(root, meshes, selection);
  if (cached === undefined) posedBoundsCache.set(root, [envelope]);
  else cached.push(envelope);
  return envelope;
}

/**
 * Cheap world-space bounds for a posed model.
 *
 * The first call pays the precise vertex walk to build a conservative skin envelope. Later calls
 * read one world-matrix translation per contributing bone and allocate nothing. The returned
 * object is cached for the root and updated in place; copy it if it must outlive the next call.
 */
export function posedBounds(root: Object3D, meshes?: readonly Object3D[]): IThreePoseBounds {
  const envelope = getEnvelope(root, meshes);
  root.updateWorldMatrix(true, true);
  rawBounds(envelope, envelope.raw);
  const raw = envelope.raw;
  const min = envelope.result.min;
  const max = envelope.result.max;
  const size = envelope.result.size;
  min[0] = raw.minX;
  min[1] = raw.minY + envelope.biasY;
  min[2] = raw.minZ;
  max[0] = raw.maxX;
  max[1] = raw.maxY + envelope.biasY;
  max[2] = raw.maxZ;
  size[0] = max[0] - min[0];
  size[1] = max[1] - min[1];
  size[2] = max[2] - min[2];
  return envelope.result;
}
