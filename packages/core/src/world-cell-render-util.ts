import { BufferGeometry, InstancedMesh, type Material, type Mesh, type Object3D } from "three";
import {
  composeSilencedByFreeze,
  isStatic,
  markStatic,
  worldSilencedByFreeze,
} from "./static-transform.js";
import type { SharedBatch } from "./world-cell-batches.js";
import { clusterOf } from "./world-cell-data.js";

/**
 * The pieces of world-cell rendering that hold no world: the constants the cull, the shadow claims
 * and the bundles all read, and the small mesh and hash helpers every one of them calls.
 *
 * Nothing here reads a cell, a batch or a scene, so any of the modules PRD-798 split `CellRender`
 * into can use it without a host of its own.
 */

/**
 * Instance-matrix bytes a world keeps in released shared batches, oldest dropped first. A batch is
 * sized to its asset's largest cell times the resident cells, so on a 2 km package one runs 80 kB
 * median and 0.9 MB worst, and every key in the world at once is 26 MB. The budget holds the walk's
 * own back-traffic — a batch leaves when the last cell holding its asset leaves, and is wanted
 * again a few hundred metres back — and lets the rest go, so a session that crosses the whole map
 * does not carry the whole map.
 */
export const RETIRED_SHARED_BYTES = 8_000_000;

/**
 * How far past the frustum a world-grid square is kept inside the main pass's draw window, in metres.
 *
 * The window is decided once per draw, from the camera that draw uses, and a square that has just
 * left the frustum is dropped from it — so a square at the frustum's edge would be drawn in one
 * frame and not the next, and a tree on that edge pops in at the edge of the screen. Growing each
 * square's box by this margin keeps a band of it in the window while it is still off screen, so a
 * tree crosses into view already there.
 *
 * An eighth of the default 64 m square is deliberately small. It has to exceed what a camera
 * travels between two draws — 8 m a frame is 480 m/s at 60 fps, so no playable camera reaches it —
 * and nothing more, because every metre of it is a metre of geometry the vertex stage still shades.
 */
export const MAIN_CULL_PAD_METRES = 8;
/**
 * Fade band, as a share of each gate, for an undithered LOD switch: 1 mm at a 10 m gate and 15 mm at
 * 150 m, so every pixel of a placement takes the same level. Nonzero, so the mask never divides zero
 * by zero exactly at the gate.
 */
export const UNDITHERED_LOD_WIDTH = 1e-4;

const slotFree = new WeakSet<Material>();
/**
 * Refuse a part material whose node graph reads `instanceIndex`. WorldCells repacks instance slots on
 * every refilter, main-pass cull and LOD switch, so a value hashed from the slot moves to another
 * placement as the viewer walks: Strata's wind phase snapped each crown's top about every 0.7 s.
 * ponytail: walks the material's `*Node` slots as built; an index read hidden inside an unbuilt `Fn`
 * body is not seen until a builder runs it.
 */
export function assertSlotFree(material: Material, assetId: string): void {
  if (slotFree.has(material)) return;
  const seen = new Set<object>();
  const reads = (value: unknown): boolean => {
    if (typeof value !== "object" || value === null || seen.has(value)) return false;
    seen.add(value);
    const node = value as { isNode?: boolean; isIndexNode?: boolean; scope?: string };
    if (node.isIndexNode === true && node.scope === "instance") return true;
    for (const child of Object.values(value))
      if (
        Array.isArray(child)
          ? child.some(reads)
          : (child as { isNode?: boolean } | null)?.isNode === true && reads(child)
      )
        return true;
    return false;
  };
  for (const [key, value] of Object.entries(material))
    if (
      key.endsWith("Node") &&
      (value as { isNode?: boolean } | null)?.isNode === true &&
      reads(value)
    )
      throw new Error(
        `WorldCells asset "${assetId}" material "${material.name}" reads instanceIndex in ${key}. WorldCells repacks instance slots as the viewer moves, so a per-instance value from the slot jumps between placements; use instanceRandom() from @threenative/core/world.`,
      );
  slotFree.add(material);
}

/**
 * Side of the main cull's own visibility cell, in metres, when it divides the package's `cellSize`.
 *
 * This is the finest grid the main pass can cull on, and it is not a free parameter: a shared
 * batch's block is one *world* cell's records and placements never move, so a world cell cannot be
 * spread across two cells of a finer grid without giving every world cell its own block — one more
 * main mesh per key, which is the cost this whole cull exists to avoid. So a package whose
 * `cellSize` is not a whole multiple of 32 m falls back to its own `cellSize`, which is the square
 * its placements are already cut on, and the rule below is the whole of it.
 *
 * A visibility cell is a sub-square of the shadow caster's world-grid square, and it is deliberately
 * finer than that square: `clusterSize` is sized for how many meshes a shadow level submits, while
 * this is sized for how little geometry the vertex stage is handed. It is also the one volume the
 * cull tests, so everything in it — a 64 m cell's XZ and the Y its own placements and asset bounds
 * reach — is what a draw of that cell costs. See {@link WorldCells.#cullMainPass}.
 */

export const MAIN_CULL_SQUARE_METRES = 32;

/**
 * How often `TN_WORLD_MAIN_CULL` is printed. Five seconds is a line a playtest capture can hold and
 * a walk long enough to see the window move; every frame is a wall of text over the marker it would
 * report on.
 */
export const MAIN_CULL_MARKER_MS = 5e3;

/** Separate shadow regions one tell carries per kind before the last one absorbs the rest. */
export const SHADOW_REGION_CAP = 64;

/**
 * The name half a shadow key is minted under: `asset:level:part@gpu`, beside the main key it twins
 * rather than in place of it, so both meshes exist — one for the main pass's compaction buffer and
 * one for the shadow twin's, which is the whole difference between them.
 */
export const GPU_KEY_SUFFIX = "@gpu";

/**
 * How many groups the main record is split into. A record walks every draw in its group, so a mint
 * on a streaming walk costs the draws of every shard it touches: Machinefall's ~200 recorded main
 * draws re-recorded as one group put ~290 traversed draws in a frame. Eight shards still read 145,
 * because one asset mints several keys (levels, parts) at once and they land in two or three shards;
 * thirty-two keep a frame that touches several to a few dozen draws. A replay is one
 * `executeBundles` per group, so a shard costs far less than the draws it stops re-walking.
 */
const MAIN_BUNDLE_SHARDS = 32;

/** The shard a key lands in, from its name (FNV-1a), so a key keeps its group for its whole life. */
export function mainShard(key: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % MAIN_BUNDLE_SHARDS;
}

/** Every mesh a prepared chunk draws through the main pass, in traversal order. */
export function chunkDraws(chunk: Object3D): Mesh[] {
  const draws: Mesh[] = [];
  chunk.traverse((node) => {
    const mesh = node as Mesh;
    if (mesh.isMesh === true && node.layers.isEnabled(0)) draws.push(mesh);
  });
  return draws;
}

/**
 * A geometry that draws `source`'s shape through an indirect record: its own object, so the record is
 * this mesh's, over the same attributes and index, so no vertex buffer is copied.
 */
export function indirectView(
  source: BufferGeometry,
  args: Parameters<BufferGeometry["setIndirect"]>[0],
  offset: number,
): BufferGeometry {
  const view = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes))
    view.setAttribute(name, attribute);
  view.setIndex(source.index);
  view.morphAttributes = source.morphAttributes;
  view.morphTargetsRelative = source.morphTargetsRelative;
  for (const group of source.groups) view.addGroup(group.start, group.count, group.materialIndex);
  view.boundingBox = source.boundingBox;
  view.boundingSphere = source.boundingSphere;
  view.setIndirect(args, offset);
  return view;
}

/** The materials `redressMaterial` gave a mesh, disposed when the mesh is or when it is re-dressed. */
const redressed = new WeakMap<InstancedMesh, readonly Material[]>();

/**
 * A new object drawing `geometry`, carrying everything `old` carried.
 *
 * Three builds an `InstancedMesh`'s instancing node when the object is first compiled, from the
 * `instanceMatrix` it holds then, and keeps that node for the object's whole life — so a mesh the
 * prewarm already compiled is not pointed at the GPU scene's storage buffer by writing a field onto
 * it. Measured on machinefall: 3,724 indirect draws submitted in 2 s, over indirect records and
 * drawn matrices that were correct at draw time, and a dressed forest that drew nothing at all,
 * until every dressed mesh was a fresh object. A fresh object costs a uuid and a node build, which
 * is what the prewarm paid for a mesh that was about to be replaced anyway; see `#dressGpu`.
 */
export function freshMeshFor(
  old: InstancedMesh,
  geometry: BufferGeometry,
  count: number,
): InstancedMesh {
  const next = new InstancedMesh(geometry, old.material, count);
  next.name = old.name;
  next.layers.mask = old.layers.mask;
  next.castShadow = old.castShadow;
  next.receiveShadow = old.receiveShadow;
  next.renderOrder = old.renderOrder;
  next.userData = old.userData;
  next.position.copy(old.position);
  next.quaternion.copy(old.quaternion);
  next.scale.copy(old.scale);
  next.matrix.copy(old.matrix);
  next.matrixWorld.copy(old.matrixWorld);
  // The authored flags, not the freeze's: a copied `matrixWorldAutoUpdate = false` reads to the new
  // freeze as a game-owned world matrix, and a seated world drew every dressed tree at the package's
  // absolute height.
  next.matrixAutoUpdate = old.matrixAutoUpdate || composeSilencedByFreeze(old);
  next.matrixWorldAutoUpdate = old.matrixWorldAutoUpdate || worldSilencedByFreeze(old);
  // A dressed batch is frozen, and the freeze is keyed by the object: a replacement that did not
  // re-arm it would compose its own world matrix every walk forever.
  if (isStatic(old)) markStatic(next);
  return next;
}

/**
 * Give a mesh a material of its own, so the node three builds for it is its own rather than a shared
 * one's, and dispose those materials with the mesh. The clones share every texture; only the
 * material objects are new. See `#dressGpu`.
 */
/**
 * The world-grid square the follow point is in, as the `@x,z` half of a cluster key: the square a
 * cell's caster cluster is named for, and the one a prewarm mints first.
 */
export function followCluster(
  follow: { readonly position: { x: number; z: number } },
  minX: number,
  minZ: number,
  cellSize: number,
  cellsPerCluster: number,
): string {
  return clusterOf(
    Math.floor((follow.position.x - minX) / cellSize),
    Math.floor((follow.position.z - minZ) / cellSize),
    cellsPerCluster,
  );
}

/** What a released batch costs to keep: its instance buffer, which is all of it. */
export function heldBytes(shared: SharedBatch): number {
  return (shared.mesh.instanceMatrix.array as Float32Array).byteLength;
}

export function redressMaterial(mesh: InstancedMesh): void {
  for (const material of redressed.get(mesh) ?? []) material.dispose();
  const clones: Material[] = [];
  for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
    clones.push(material.clone());
  mesh.material = Array.isArray(mesh.material) ? clones : (clones[0] as Material);
  if (!redressed.has(mesh))
    mesh.addEventListener("dispose", () => {
      for (const material of redressed.get(mesh) ?? []) material.dispose();
      redressed.delete(mesh);
    });
  redressed.set(mesh, clones);
}
