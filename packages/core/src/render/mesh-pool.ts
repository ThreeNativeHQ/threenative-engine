import { type BufferGeometry, InstancedMesh, type Material } from "three";
import { batchRecords } from "../world-cell-records.js";

/**
 * A pool of parked `InstancedMesh`es, keyed by the parts they draw.
 *
 * Three's WebGPU renderer keys its render-object/node cache by `object.uuid`, so every new
 * InstancedMesh costs a full NodeBuilder shader build in the main pass and in every shadow pass — a
 * streamed world minting one per cell pays it over and over. A pool hit is not a copy: it is the
 * same object, so the node three built for it is still there. What the pool cannot do is invent a
 * first draw, so the mints that stay mints are counted by the caller, not hidden.
 *
 * The smallest capacity a pooled buffer is minted at, so a parked mesh can serve a smaller caller.
 */
export const MESH_POOL_MIN_CAPACITY = 64;
/** Parked meshes per (geometry, material) pair; past it the surplus is released, not hoarded. */
export const MESH_POOL_MAX_PER_PAIR = 8;
/** Parked meshes across every pair, so a walk's back-traffic cannot grow without bound. */
export const MESH_POOL_MAX_HELD = 512;

/** geometry -> material -> parked meshes, biggest last. */
const meshPool = new Map<BufferGeometry, Map<Material, InstancedMesh[]>>();
let meshPoolHeld = 0;

/** Capacity a new buffer is minted with: a power of two, so a parked one fits the next cell that asks. */
export function pooledCapacity(capacity: number): number {
  return Math.max(MESH_POOL_MIN_CAPACITY, 2 ** Math.ceil(Math.log2(Math.max(1, capacity))));
}

/**
 * A mesh drawing `geometry` with `material` that has room for `capacity` instances, from the pool
 * when it has one and freshly minted when it does not.
 *
 * The buffer is always at least a power of two of `MESH_POOL_MIN_CAPACITY` wide: a buffer grown to
 * exactly the count that needed it can only ever serve that count again, whereas a rounded one is
 * the size the next, larger consumer of the same part will ask for.
 */
export function pooledMesh(
  geometry: BufferGeometry,
  material: Material,
  capacity: number,
): InstancedMesh {
  const wanted = pooledCapacity(capacity);
  const forMaterial = meshPool.get(geometry)?.get(material);
  if (forMaterial !== undefined) {
    for (let index = forMaterial.length - 1; index >= 0; index -= 1) {
      const mesh = forMaterial[index] as InstancedMesh;
      if (mesh.instanceMatrix.count < wanted) continue;
      forMaterial.splice(index, 1);
      meshPoolHeld -= 1;
      return mesh;
    }
  }
  return new InstancedMesh(geometry, material, wanted);
}

/** A mesh that cannot be parked is detached and given up, never just dropped. */
function releasePooled(mesh: InstancedMesh): void {
  mesh.removeFromParent();
  mesh.dispose();
}

/**
 * Offer a mesh no batch draws any more to the pool. `false` means the pool is full and the caller must
 * let the mesh go; it is never disposed here, because a parked mesh is only a buffer and a uuid, and
 * the geometry and material it points at belong to the refcount path that made it.
 */
export function parkMesh(mesh: InstancedMesh): boolean {
  if (meshPoolHeld >= MESH_POOL_MAX_HELD) {
    // Both refusals give the mesh up, and "up" includes letting go of it. Returning `false` with
    // the mesh still parented would leave the old mesh drawing the old records (ghosts) with
    // nothing to clean it up; leaving it detached would leak a buffer, since `InstancedMesh
    // .dispose` frees its own buffer and leaves the geometry and material it shares with every
    // other instance of the part alone.
    releasePooled(mesh);
    return false;
  }
  mesh.removeFromParent();
  mesh.count = 0;
  mesh.visible = false;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  batchRecords.fill(mesh.instanceMatrix, 0, mesh.instanceMatrix.count * 16);
  batchRecords.upload(mesh.instanceMatrix, 0, 0);
  let forGeometry = meshPool.get(mesh.geometry);
  if (forGeometry === undefined) {
    forGeometry = new Map();
    meshPool.set(mesh.geometry, forGeometry);
  }
  let forMaterial = forGeometry.get(mesh.material as Material);
  if (forMaterial === undefined) {
    forMaterial = [];
    forGeometry.set(mesh.material as Material, forMaterial);
  }
  if (forMaterial.length >= MESH_POOL_MAX_PER_PAIR) {
    releasePooled(mesh);
    return false;
  }
  forMaterial.push(mesh);
  meshPoolHeld += 1;
  return true;
}

/**
 * Every parked mesh drawn with one geometry and material, freed. The asset that owns them released
 * them, so no pool may keep them; the pool's held count and its per-pair entry go with them, because
 * a mesh that is gone is not capacity.
 */
export function dropPooledFor(geometry: BufferGeometry, material: Material): void {
  const forGeometry = meshPool.get(geometry);
  if (forGeometry === undefined) return;
  const forMaterial = forGeometry.get(material);
  if (forMaterial === undefined) return;
  for (const mesh of forMaterial) {
    releasePooled(mesh);
    meshPoolHeld -= 1;
  }
  forGeometry.delete(material);
}

/** The pool's meshes, disposed; what a world never gives back, `dispose` takes. */
export function drainMeshPool(): void {
  for (const forGeometry of meshPool.values())
    for (const forMaterial of forGeometry.values()) for (const mesh of forMaterial) mesh.dispose();
  meshPool.clear();
  meshPoolHeld = 0;
}
