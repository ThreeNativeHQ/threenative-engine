import {
  Box3,
  type BufferGeometry,
  InstancedBufferAttribute,
  type InstancedMesh,
  type Material,
  Sphere,
  Vector3,
} from "three";
import type { InstancedBatch } from "./instanced-batch.js";
import { currentWriteEpoch, pooledMesh } from "./render/mesh-pool.js";

/**
 * Records a retired batch's instance buffer is shrunk to; see `SharedBatch.park`.
 *
 * A released batch holds no records, so what keeping it is buying is the uuid three built a node for,
 * and the buffer is the whole of what that retention costs. At the batch's own ring capacity the
 * walk's back-traffic costs more than the byte budget holds, so the budget evicts the very keys a
 * walk is about to return to and the walk re-mints a mesh for each of them. Parked, a key costs
 * `PARKED_SHARED_CAPACITY` records; `rebind` puts the capacity back before anything is written.
 */
const PARKED_SHARED_CAPACITY = 1;

/**
 * One asset part at one distance level, drawn for every resident cell by a single InstancedMesh.
 *
 * Each cell owns a block of the instance buffer, admitted as the count it needs and freed as one,
 * so the draw object count is per asset part and level rather than per cell: a 25-cell ring of a
 * 218-asset world was ~5,000 meshes and 20+ ms of CPU a frame in three's per-object render path.
 *
 * A shared batch packs its live instances at the front of the instance buffer, so `mesh.count` is
 * the live total. It used to be `(the highest used segment + 1) * segmentSize`, which drew every
 * zero-matrix slot of a partly filled segment and of every freed segment below the top one — tens of
 * thousands of slots per pass — and each empty slot still ran the vertex shader over the whole mesh
 * in the main pass and in every shadow pass. A block is now sized to its own cell's batch instead of
 * to the asset's largest cell, and a freed or shortened block is compacted into the lowest hole, so
 * the drawn range holds nothing but live records. The handles are opaque: `allocate` only hands one
 * back to `write` and `clear`.
 *
 * A **main** batch is `clustered`, and that changes the packing: its blocks are laid out grouped by
 * the world-grid square they sit in, the same square the caster clusters are keyed by, and
 * {@link SharedBatch.cullFrom} narrows `mesh.count` to the squares the main camera's frustum covers.
 * Three's whole-mesh frustum test cannot do this on its own — the bounds are the whole ring, so the
 * test always passes and every instance behind or beside the camera is vertex-shaded. See
 * {@link WorldCells.#cullMainPass} for which camera is allowed to decide.
 */
/**
 * A `SharedBatch`'s mesh plus the one field it publishes for a shadow level's size gate: the largest
 * instance scale any live record carries. Duck-typed rather than augmented into `three`, the same as
 * `isInstancedMesh` — `render/virtual-shadow.ts` reads it back off the mesh.
 */
export interface ICasterScaleMesh extends InstancedMesh {
  casterInstanceScale: number;
  /**
   * Whether the main pass will draw the records behind this caster half this frame; see
   * {@link SharedBatch.setMainAdmitted}. Read by `VirtualShadowNode`'s probe beside the other two
   * flags this class writes on a mesh.
   */
  mainAdmitted?: boolean;
}

/** One world-grid square's records in a clustered batch: how many of them there are. */
type ISquareSizes = Map<string, number>;

/**
 * The one buffer a clustered regroup permutes through.
 *
 * A regroup is a permutation of `[0, drawn)`, and there is no in-place order for one: putting the
 * visible squares at the front necessarily writes over squares that have not been copied out yet. A
 * snapshot is the honest way to do it — read every block into here, then write the new layout back —
 * and one buffer is enough for the whole world, because a regroup never nests and the largest
 * main batch is the only bound on it. Module-level like the upload epoch, because there is one world
 * drawing at a time.
 */
let regroupScratch = new Float32Array(0);

/** A scratch with room for `floats`, kept between regroups so a walk allocates it once. */
function scratchFor(floats: number): Float32Array {
  if (regroupScratch.length < floats) regroupScratch = new Float32Array(floats * 2);
  return regroupScratch;
}

/** Records a square's blocks hold, which is its share of the batch. */
function sizeOf(square: { blocks: Array<[number, number, number, string]> }): number {
  let size = 0;
  for (const block of square.blocks) size += block[2];
  return size;
}

export function sameSquares(next: Set<string>, was: Set<string> | undefined): boolean {
  if (was === undefined || was.size !== next.size) return false;
  for (const cluster of next) if (!was.has(cluster)) return false;
  return true;
}

export class SharedBatch {
  mesh: ICasterScaleMesh;
  /** The pass this batch draws in; see `#dressMesh`. Only `main` is clustered. */
  readonly role: "cluster" | "key" | "main" | "wide";
  /**
   * Set by `WorldCells` from the asset's own bounds: a wide caster of ground cover goes on the
   * finest level's small-caster layer rather than the wide one. Written after construction because
   * `#segmentIn` re-dresses a grown mesh with nothing but the batch to hand, and a flag the batch
   * carries is the one thing that survives that.
   */
  smallCaster = false;
  /**
   * Set when the GPU scene owns this batch's draw, with the key it was minted under. See
   * `WorldCells#dressGpu`.
   *
   * It is a field rather than a name test because a dressed batch's `mesh.instanceMatrix` is the
   * scene's shared compaction buffer, and everything below writes records into that attribute: a
   * dressed batch keeps its bookkeeping and skips every byte of it, which is the whole of what the
   * `gpu` guards in `write`, `clear`, `#settle`, `#touched` and `#publish` are.
   */
  gpu:
    | {
        readonly asset: string;
        readonly level: number;
        readonly part: number;
        readonly key: string;
      }
    | undefined;
  /**
   * The instance count a GPU-dressed mesh is submitted with: its key's region capacity, written by
   * `WorldCells#dressGpu`.
   *
   * A dressed mesh's own records are not what it draws — the dispatch appends survivors into the
   * scene's shared buffer and the indirect record decides how many — so `#drawn` is not its count.
   * Three skips the indirect draw entirely before the GPU ever reads the record when an
   * `InstancedMesh.count` is zero (`RenderObject.getDrawParameters`), so the region's capacity is the
   * submission bound: the record's own count draws what the GPU selected, and this only admits the
   * submission. `0` until the mesh is dressed.
   */
  gpuCount = 0;
  /**
   * How many of this batch's live records the GPU scene holds a placement for, carried beside the
   * buffer and the segments so admission is one comparison per caster half a frame. Incremented by
   * `WorldCells#placeSources` and decremented by `#clearSegment`, where the asset's own `#gpuResident`
   * count already moves; see {@link WorldCells.#publishCasterAdmission}.
   */
  gpuPlaced = 0;
  /**
   * Whether this batch's mesh is parented under one of the world's main record shards. Set by
   * `WorldCells#bundleIn` and cleared by `#bundleOut`.
   *
   * It is a field rather than `mesh.parent` because a bundled mesh's `visible` is never written
   * again: three fixes a bundle's render list when it records it, and the replay never re-reads
   * visibility — so the two places that hide an empty batch have to know, and a mesh that has just
   * been detached from the group by a retire has still been in the last recorded one.
   */
  bundled = false;
  /**
   * Last checked eligibility of this mesh. CPU draws revalidate bounded material graph snapshots
   * and live object hooks each frame, so deep mutations can return the mesh to the per-object path.
   */
  bundlable = false;
  bundleMaterialRevision = -1;
  /**
   * The instance count the world's last record of this mesh was cut at. A record freezes the draw's
   * instance count, so a CPU-path batch's moving window is one re-record when this moves; a dressed
   * batch submits its key's region capacity, which only the dress changes and which re-records there.
   */
  bundledCount = -1;
  /**
   * The same descriptor, recorded whether or not the GPU scene is on, which is the whole of what
   * lets a mesh minted before the scene came up be dressed after it: `gpu` says the mesh draws from
   * the scene's buffers, `main` says which key it would draw. A prewarm that mints a whole ring on a
   * loading screen mints it with the scene off, and the first frame with a renderer turns it on.
   */
  main:
    | {
        readonly asset: string;
        readonly level: number;
        readonly part: number;
        readonly key: string;
      }
    | undefined;
  readonly #clustered: boolean;
  readonly #segmentSize: number;
  /** Block handle -> the block's first instance record. */
  readonly #start = new Map<number, number>();
  /** Block handle -> live records in it; the reserved count until `write` reports the real one. */
  readonly #size = new Map<number, number>();
  /** Block handle -> the world-grid square it sits in; only a clustered batch records it. */
  readonly #blockCluster = new Map<number, string>();
  /** World-grid square -> its records in the buffer, so the window can be summed. See `#regroup`. */
  readonly #squareSizes: ISquareSizes = new Map();
  /** The squares the last cull kept, how many records of the batch they are, and whether that is current. */
  #visible: Set<string> | undefined;
  /** The `visibleEpoch` this batch last laid itself out at; see {@link SharedBatch.cullFrom}. */
  #packedEpoch = -1;
  /** Reused across culls, so a repack allocates no set. */
  #scratch: Set<string> = new Set();
  #window = 0;
  #narrowed = false;
  /**
   * A prewarmed batch whose first draw is still owed, so it is visible at count 0 until that draw
   * counts. The draw is the whole of the prewarm; see {@link #publish}.
   */
  #awaitingPrewarm = false;
  /**
   * Whether the main pass will draw this batch's records this frame; a main batch is always
   * admitted, so this only ever says something about a caster half. See
   * {@link WorldCells.#publishCasterAdmission}.
   */
  #mainAdmitted = true;
  /** Free record ranges `[from, to)`, sorted, disjoint and never adjacent. */
  #free: Array<[number, number]> = [];
  #handles = 0;
  /** One past the last live record: the range the whole buffer holds. A clustered batch draws `#window`. */
  #drawn = 0;
  /** Block handle -> the AABB of the records it holds, and the union of those is the mesh's bounds. */
  readonly #boxes = new Map<number, Box3>();
  /** Block handle -> the largest instance scale in it; the union is published on the mesh. */
  readonly #scales = new Map<number, number>();
  /** Carried out of the last `#boxOf` pass, which already reads every record's basis. */
  #maxScale = 0;
  #localGeometry: BufferGeometry | undefined;
  readonly #localCenter = new Vector3();
  readonly #localHalf = new Vector3();
  readonly #union = new Box3();
  readonly #point = new Vector3();
  /** This batch's own pending upload span, and the `update` it was opened in. See `#touched`. */
  #pendingLow = 0;
  #pendingHigh = 0;
  #pendingEpoch = -1;

  constructor(
    geometry: BufferGeometry,
    material: Material,
    segmentSize: number,
    segments: number,
    name: string,
    bounds: Box3,
    role: "cluster" | "key" | "main" | "wide",
  ) {
    this.role = role;
    this.#clustered = role === "main";
    this.#segmentSize = Math.max(1, segmentSize);
    this.#bounds = bounds;
    this.mesh = SharedBatch.#meshFor(
      geometry,
      material,
      this.#segmentSize * segments,
      name,
      bounds,
    );
    this.#free = [[0, this.mesh.instanceMatrix.count]];
    this.#ceiling = this.mesh.instanceMatrix.count;
    this.#rebound();
  }

  /** This batch's own record ceiling; see {@link liveCeiling}. */
  #ceiling = 0;

  /** The package extent, the conservative fallback when a part's own box cannot be read. */
  readonly #bounds: Box3;

  /**
   * Takes a pooled mesh with room for `capacity`, so a shared batch that outgrows its buffer keeps
   * the uuid — and the node three built for it — instead of getting a new one. Every field a pooled
   * mesh carries stale is written here, and the two shadow flags are set false because `grow` copies
   * them off the mesh it replaces and the world sets them per level.
   */
  static #meshFor(
    geometry: BufferGeometry,
    material: Material,
    capacity: number,
    name: string,
    bounds: Box3,
  ): ICasterScaleMesh {
    const mesh = pooledMesh(geometry, material, capacity) as ICasterScaleMesh;
    mesh.name = name;
    mesh.boundingBox = bounds.clone();
    mesh.boundingSphere = bounds.getBoundingSphere(mesh.boundingSphere ?? new Sphere());
    mesh.count = 0;
    mesh.visible = false;
    // Cullable, because the bounds are now this batch's own. Every camera three draws this mesh
    // with — the main one and each virtual-shadow level's — asks first, which is what stops a 48 m
    // shadow level from submitting every shared batch in the world.
    mesh.frustumCulled = true;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    (mesh.instanceMatrix.array as Float32Array).fill(0);
    mesh.instanceMatrix.needsUpdate = true;
    // A pooled mesh arrives carrying the last user's scale; nothing lives here yet.
    mesh.casterInstanceScale = 0;
    // Nor the last user's bundle membership: a mesh is only bundled while `WorldCells#bundleIn` says
    // so, and the shadow node reads this marker to keep its texel gate off a bundled mesh.
    mesh.userData.tnBundled = false;
    // Nor the last caster's admission: a main batch is always admitted, and this mesh is not one.
    mesh.mainAdmitted = true;
    return mesh;
  }

  /** Point an empty batch at the parts a reload brought; see {@link rebind}. */
  rebind(geometry: BufferGeometry, material: Material): this {
    this.mesh.geometry = geometry;
    this.mesh.material = material;
    this.#localGeometry = undefined;
    // A new surface is the one thing a rebind can bring that a mesh swap cannot, so what can be
    // recorded has to be asked again: the answer cached for the old material is not this one's.
    this.bundlable = false;
    if (this.#parked > 1) this.#resize(this.#parked);
    this.#rebound();
    return this;
  }

  /** The capacity this batch had when it was parked; see {@link park}. */
  #parked = 0;

  /**
   * Give up the instance buffer of a batch that holds no records, keeping the mesh.
   *
   * This is what makes a retained set affordable. Unparked, a walk's back-traffic costs a ring-sized
   * buffer per key, so `RETIRED_SHARED_BYTES` could hold only the last few dozen keys of a world with
   * hundreds of them, `#sharedFor` then found nothing to hand back, and the walk minted a second
   * mesh for every key it returned to. Parked, the same keys cost `PARKED_SHARED_CAPACITY` records
   * each and `rebind` gives the buffer back before the first record is written into it.
   */
  park(): this {
    // The batch's own ceiling, never its mesh's `count`: a dressed batch's `instanceMatrix` is the
    // GPU scene's shared compaction buffer, so its count is the whole world's, and parking by it
    // turned one key's capacity into the whole buffer — `rebind` then resized every later batch
    // against the world and the shared buffer regrew until the device refused it.
    this.#parked = this.#ceiling;
    // `gpu` too, not only a capacity over one: a dressed batch's `instanceMatrix` is the GPU scene's
    // shared compaction buffer whatever its logical ceiling is, so a batch parked at a ceiling of one
    // that skipped this resized nothing and left the retired mesh holding the whole world's records.
    if (this.gpu !== undefined || this.#parked > PARKED_SHARED_CAPACITY)
      this.#resize(PARKED_SHARED_CAPACITY);
    return this;
  }

  /**
   * Swap in an instance buffer of `capacity` records, and with it the free range and the drawn count
   * the buffer is the record of. The mesh is off the world and holds no records when this runs, so
   * `#start`, `#size` and `#boxes` are already empty and the one free range is the whole buffer.
   */
  #resize(capacity: number): void {
    const mesh = this.mesh;
    mesh.instanceMatrix = new InstancedBufferAttribute(new Float32Array(capacity * 16), 16);
    this.#ceiling = capacity;
    this.#publish(0);
    this.#free = [[0, capacity]];
    this.#drawn = 0;
  }

  /**
   * The mesh's own extent, the union of the blocks' boxes, written on every add and remove. A union
   * over at most one box per resident cell is a few dozen comparisons, against a per-draw saving of
   * every batch the camera does not overlap. `#compact` moves records between slots but never between
   * blocks, so a block's box survives a compaction untouched.
   */
  #rebound(): void {
    const box = this.#union;
    let live = false;
    for (const one of this.#boxes.values()) {
      if (live === false) {
        box.copy(one);
        live = true;
      } else box.union(one);
    }
    if (live === false) box.copy(this.#bounds);
    (this.mesh.boundingBox as Box3).copy(box);
    this.mesh.boundingSphere = this.mesh.boundingSphere ?? new Sphere();
    box.getBoundingSphere(this.mesh.boundingSphere);
    // The size a per-instance shadow gate reads, published next to the mesh rather than asked for
    // again per level: the cluster's own sphere is ~24 m of grid square, so gating on it dropped
    // nothing, while a fern is 0.3 m and every fern cluster clears every coarse level.
    this.mesh.casterInstanceScale = live === false ? 0 : Math.max(...this.#scales.values());
  }

  /**
   * The AABB of records `[from, from + count)` of the instance buffer, read from the bytes just
   * written rather than from the batch that wrote them, so it is the same numbers the GPU gets. The
   * half-extents are `|basis| * half`, which is the box a rotated or stretched instance of the part
   * actually covers — a translate-only box would let a scaled trunk through the shadow cull.
   */
  #boxOf(from: number, count: number): Box3 {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const geometry = this.mesh.geometry;
    if (this.#localGeometry !== geometry) {
      this.#localGeometry = geometry;
      if (geometry?.boundingBox === null || geometry?.boundingBox === undefined)
        geometry?.computeBoundingBox?.();
      const local = geometry?.boundingBox;
      // No readable local box means no readable instances either; the package extent is the answer
      // that cannot be wrong, and it is what these meshes carried before the blocks were sized.
      if (local === undefined || local === null || local.isEmpty()) return this.#bounds;
      this.#localCenter.copy(local.getCenter(this.#point));
      this.#localHalf.copy(local.getSize(this.#point)).multiplyScalar(0.5);
    }
    const cx = this.#localCenter.x;
    const cy = this.#localCenter.y;
    const cz = this.#localCenter.z;
    const hx = this.#localHalf.x;
    const hy = this.#localHalf.y;
    const hz = this.#localHalf.z;
    const out = new Box3();
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let scale = 0;
    for (let index = from; index < from + count; index += 1) {
      const at = index * 16;
      const m0 = array[at] as number;
      const m1 = array[at + 1] as number;
      const m2 = array[at + 2] as number;
      const m4 = array[at + 4] as number;
      const m5 = array[at + 5] as number;
      const m6 = array[at + 6] as number;
      const m8 = array[at + 8] as number;
      const m9 = array[at + 9] as number;
      const m10 = array[at + 10] as number;
      const px = m0 * cx + m4 * cy + m8 * cz + (array[at + 12] as number);
      const py = m1 * cx + m5 * cy + m9 * cz + (array[at + 13] as number);
      const pz = m2 * cx + m6 * cy + m10 * cz + (array[at + 14] as number);
      const ex = Math.abs(m0) * hx + Math.abs(m4) * hy + Math.abs(m8) * hz;
      const ey = Math.abs(m1) * hx + Math.abs(m5) * hy + Math.abs(m9) * hz;
      const ez = Math.abs(m2) * hx + Math.abs(m6) * hy + Math.abs(m10) * hz;
      if (px - ex < minX) minX = px - ex;
      if (py - ey < minY) minY = py - ey;
      if (pz - ez < minZ) minZ = pz - ez;
      if (px + ex > maxX) maxX = px + ex;
      if (py + ey > maxY) maxY = py + ey;
      if (pz + ez > maxZ) maxZ = pz + ez;
      // The largest column of the instance basis: the scale a fern or a trunk is drawn at.
      const basis = Math.max(
        Math.hypot(m0, m1, m2),
        Math.hypot(m4, m5, m6),
        Math.hypot(m8, m9, m10),
      );
      if (basis > scale) scale = basis;
    }
    this.#maxScale = scale;
    out.min.set(minX, minY, minZ);
    out.max.set(maxX, maxY, maxZ);
    return out;
  }

  /** A handle for `count` free records, or `undefined` when the buffer has none and must grow. */
  allocate(count: number, cluster?: string): number | undefined {
    const at = this.#take(count);
    if (at < 0) return undefined;
    const handle = this.#handles;
    this.#handles += 1;
    this.#start.set(handle, at);
    this.#size.set(handle, count);
    // Only a clustered batch groups, so only it pays for the lookup. The square is the caller's
    // cell's, and a cell's placements never move, so a record is only ever grouped when the cell
    // holding it is admitted or evicted.
    if (this.#clustered && cluster !== undefined) this.#blockCluster.set(handle, cluster);
    return handle;
  }

  /**
   * Doubles the buffer in a new mesh (same data), returning the one it replaces for the pool.
   *
   * The replacement comes from the pool, and what it replaces is offered back to it, so the pair
   * costs one new uuid between them instead of one each. This used to push the old mesh onto an
   * unbounded `retired` array that nothing ever read and nothing ever freed.
   */
  grow(): InstancedMesh | undefined {
    const old = this.mesh;
    if (this.gpu !== undefined) {
      // A dressed batch's records are the GPU scene's, held in a buffer this batch must not copy,
      // zero or regroup: its own share is the logical ceiling the next `#dressGpu` sizes the scene's
      // region from, so growth is that number and nothing else. The live mesh is kept and nothing is
      // returned: `#segmentIn` dresses, attaches and parks only a real replacement, and the next
      // `#dressGpu` grows the region from this ceiling before the draw.
      const was = this.#ceiling;
      this.#ceiling = was * 2;
      this.#hole(was, this.#ceiling);
      return undefined;
    }
    const mesh = SharedBatch.#meshFor(
      old.geometry,
      old.material as Material,
      old.instanceMatrix.count * 2,
      old.name,
      this.#bounds,
    );
    (mesh.instanceMatrix.array as Float32Array).set(old.instanceMatrix.array as Float32Array);
    mesh.castShadow = old.castShadow;
    mesh.receiveShadow = old.receiveShadow;
    this.mesh = mesh;
    this.#ceiling = mesh.instanceMatrix.count;
    this.#settle();
    // The whole drawn range, because this is a different buffer. `#meshFor` left the new
    // attribute's range list empty, and an empty list is how three is told "upload everything" — so
    // before the coalescing below, this was the whole buffer by default and the records copied out
    // of the old array reached the GPU. A narrow range here would leave the new buffer's first
    // records as the zeros it was created with.
    this.#touched(0, this.#drawn);
    this.#rebound();
    return old;
  }

  /**
   * Swap in the object this batch draws with, and hand back the one it replaces.
   *
   * Every reference the batch holds is `this.mesh` read at the moment it is needed, so the swap is
   * the field. What does not follow the field is what the batch derives rather than stores — the
   * bounds, the instance scale, the count and the visibility published on the object, and the two
   * containers a fresh object starts out without them in. Those are republished here from the
   * batch's own records, so a replacement draws exactly what the object it replaced drew.
   */
  replaceMesh(next: ICasterScaleMesh): ICasterScaleMesh {
    const old = this.mesh;
    this.mesh = next;
    this.mesh.boundingBox = this.mesh.boundingBox ?? new Box3();
    this.mesh.boundingSphere = this.mesh.boundingSphere ?? new Sphere();
    (next as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = this.#awaitingPrewarm;
    next.mainAdmitted = this.#mainAdmitted;
    this.#rebound();
    this.#publish(this.#drawn);
    return old;
  }

  write(segment: number, batch: InstancedBatch): void {
    const start = this.#start.get(segment);
    const reserved = this.#size.get(segment);
    if (start === undefined || reserved === undefined) return;
    if (this.gpu !== undefined) {
      // The records themselves are the GPU scene's, written by its dispatch from the source buffer;
      // what the coarse per-cell gate and the counters need is the per-square count and the total.
      const cluster = this.#blockCluster.get(segment) ?? "";
      this.#size.set(segment, batch.count);
      this.#squareSizes.set(cluster, (this.#squareSizes.get(cluster) ?? 0) + batch.count);
      this.#drawn += batch.count;
      this.#publish(this.#drawn);
      return;
    }
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const written = batch.writeMatrices(array, start);
    array.fill(0, (start + written) * 16, (start + reserved) * 16);
    if (written < reserved) this.#hole(start + written, start + reserved);
    this.#size.set(segment, written);
    // The block's extent, read from the records where they are now, because `#compact` is about to
    // move them. The box is keyed by handle, so the move cannot falsify it.
    if (written > 0) {
      this.#boxes.set(segment, this.#boxOf(start, written));
      this.#scales.set(segment, this.#maxScale);
    } else {
      this.#boxes.delete(segment);
      this.#scales.delete(segment);
    }
    this.#settle();
    this.#touched(start, written);
    this.#rebound();
  }

  clear(segment: number): void {
    const start = this.#start.get(segment);
    if (start === undefined) return;
    const size = this.#size.get(segment) ?? 0;
    if (this.gpu !== undefined) {
      // The mirrored half of `write`: the coarse gate and the live total follow the records that left,
      // and no byte of the shared buffer is touched, because none of them were ever in it.
      const cluster = this.#blockCluster.get(segment) ?? "";
      this.#squareSizes.set(cluster, Math.max(0, (this.#squareSizes.get(cluster) ?? 0) - size));
      this.#drawn -= size;
    }
    this.#start.delete(segment);
    this.#size.delete(segment);
    this.#blockCluster.delete(segment);
    if (this.gpu !== undefined) {
      // The block's range goes back to the free list, exactly as the CPU path's does below. Without
      // this the GPU path's free list only ever shrank: a walk that streamed cells in and out
      // exhausted it, `allocate` failed, `grow` doubled the batch's ceiling, and the scene's region
      // — and with it the shared buffer — regrew for records that had already left.
      this.#hole(start, start + size);
      this.#publish(this.#drawn);
      return;
    }
    (this.mesh.instanceMatrix.array as Float32Array).fill(0, start * 16, (start + size) * 16);
    this.#hole(start, start + size);
    this.#settle();
    // The drawn range, not nothing. `#compact` closed the hole by moving the topmost block down
    // into it, so the bytes below `#drawn` changed and an empty range list is read by three as
    // "upload the whole buffer" — a ring-sized write to zero a block that is no longer drawn.
    this.#touched(0, this.#drawn);
    this.#boxes.delete(segment);
    this.#scales.delete(segment);
    this.#rebound();
  }

  /** The first free range with room for `count` records, taken out of the list; -1 when there is none. */
  #take(count: number): number {
    for (let index = 0; index < this.#free.length; index += 1) {
      const range = this.#free[index] as [number, number];
      const size = range[1] - range[0];
      if (size < count) continue;
      if (size === count) this.#free.splice(index, 1);
      else this.#free[index] = [range[0] + count, range[1]];
      return range[0];
    }
    return -1;
  }

  /** Records `[from, to)` back as free, merged with every range it touches. */
  #hole(from: number, to: number): void {
    if (to <= from) return;
    const free = this.#free;
    free.push([from, to]);
    free.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const range of free) {
      const last = merged[merged.length - 1];
      if (last !== undefined && range[0] <= last[1]) {
        if (range[1] > last[1]) last[1] = range[1];
        continue;
      }
      merged.push(range);
    }
    this.#free = merged;
  }

  /**
   * Closes every hole below the drawn range, so `mesh.count` is the live total: the topmost block
   * moves into the lowest hole, or, when it does not fit, everything above the hole shifts down over
   * it. Whatever sits past the topmost block is free again, so one cell's room serves the next cell
   * instead of a `grow`, and the free list is left as the single tail range `[drawn, capacity)`.
   */
  #compact(): void {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    for (;;) {
      let drawn = 0;
      let top = -1;
      let topFrom = 0;
      for (const [handle, start] of this.#start) {
        const end = start + (this.#size.get(handle) ?? 0);
        if (end <= drawn) continue;
        drawn = end;
        top = handle;
        topFrom = start;
      }
      this.#drawn = drawn;
      const lowest = this.#free[0];
      if (top < 0 || lowest === undefined || lowest[0] >= drawn) break;
      const [holeStart, holeEnd] = lowest;
      const size = this.#size.get(top) ?? 0;
      if (size <= holeEnd - holeStart) {
        array.copyWithin(holeStart * 16, topFrom * 16, drawn * 16);
        this.#start.set(top, holeStart);
        if (holeEnd - holeStart > size) this.#free[0] = [holeStart + size, holeEnd];
        else this.#free.shift();
        this.#hole(topFrom, drawn);
        this.#drawn = holeStart + size;
        this.#touched(holeStart, size);
      } else {
        const shift = holeEnd - holeStart;
        array.copyWithin(holeStart * 16, holeEnd * 16, drawn * 16);
        this.#free.shift();
        for (const [handle, start] of this.#start) {
          if (start >= holeEnd) this.#start.set(handle, start - shift);
        }
        for (const range of this.#free) {
          if (range[0] >= holeEnd) {
            range[0] -= shift;
            range[1] -= shift;
          }
        }
        this.#drawn = drawn - shift;
        this.#touched(holeStart, this.#drawn - holeStart);
      }
    }
    const capacity = this.mesh.instanceMatrix.count;
    const free: Array<[number, number]> = [];
    for (const [from, to] of this.#free) {
      if (from < this.#drawn) free.push([from, to > this.#drawn ? this.#drawn : to]);
    }
    if (this.#drawn < capacity) free.push([this.#drawn, capacity]);
    this.#free = free;
  }

  /**
   * Close the holes a write, a clear or a grow left, the way this batch's role needs.
   *
   * A caster batch compacts: one square holds the key's records, so the lowest hole is where the
   * topmost block belongs. A main batch regroups instead, because compaction would carry a block
   * away from the square it belongs to and the frustum test reads the squares.
   */
  #settle(): void {
    // A dressed batch's layout is the dispatch's: its `instanceMatrix` is the scene's shared buffer,
    // so a compact or regroup here would read that buffer's count as this batch's capacity and
    // shuffle the whole world's records. `write` and `clear` bypass this already; `grow` does too.
    if (this.gpu !== undefined) return;
    if (this.#clustered) {
      this.#regroup();
      // Records moved, so `mesh.count` is the live total again and the window has to be re-narrowed
      // by the next draw — with no copy, because the regroup just put the squares in place.
      this.#narrowed = false;
    } else this.#compact();
  }

  /**
   * Lay every live block out again, grouped by its world-grid square, `visible`'s squares first.
   *
   * A regroup is a permutation of `[0, drawn)` and there is no in-place order for one: writing the
   * visible squares to the front necessarily lands on squares whose records have not been read out
   * yet, in either direction. So every block is copied into {@link regroupScratch} and the new order
   * is copied back — two passes over the drawn range, and only when a square entered or left the
   * window, which on a settled camera is not once a frame.
   *
   * Squares keep their relative order within each half, so a residency change regroups in place and
   * a cull that found the same set writes nothing. What each square holds is recorded here, because
   * that is the only per-key data the window needs: the squares' world volumes belong to the grid,
   * not to a key, and are derived once a frame for all of them. See {@link WorldCells.#cullMainPass}.
   *
   * Only the records that actually moved are handed to the upload, and on a walk that is usually the
   * tail or nothing at all: the squares that stayed in the half they were in keep their offsets
   * exactly, so a square crossing the boundary between the two halves moves the records from there
   * to the boundary and leaves `[0, boundary)` byte-identical. Uploading `[0, drawn)` instead — which
   * is what this did — re-sent a whole key's records to the GPU on every frame the window moved,
   * which on a walking camera is most frames, and on the largest key in a 2 km walk measured
   * **37 draws over 7 ms each**. An identity reorder now costs no bytes at all, and the rest costs
   * the span that moved; `#touched` still widens a span over half the drawn range, so the ranges
   * stay few and large rather than many and small.
   */
  #regroup(visible = this.#visible): void {
    const array = this.mesh.instanceMatrix.array as Float32Array;
    const squares = this.#squares();
    let total = 0;
    for (const square of squares) total += sizeOf(square);
    const scratch = scratchFor(total * 16);
    // The visible squares first. `filter` is stable, so both halves keep the order the buffer had
    // them in and a residency change lays out exactly what the last one did.
    const front = squares.filter((one) => visible?.has(one.cluster) ?? true);
    const back = squares.filter((one) => !(visible?.has(one.cluster) ?? true));
    let written = 0;
    // Where the layout departed from the one the GPU holds: the first record written somewhere other
    // than where it was read from, and the last one after it. `-1` until something moves, so an
    // identity reorder touches nothing.
    let movedFrom = -1;
    let movedTo = 0;
    this.#squareSizes.clear();
    for (const square of [...front, ...back]) {
      const union = new Box3();
      for (const [handle, start, count] of square.blocks) {
        scratch.set(array.subarray(start * 16, (start + count) * 16), written * 16);
        // Read before it is overwritten: a block written back to its own offset is a record the GPU
        // already holds, and is the whole difference between a repack that costs nothing and one
        // that re-uploads the key.
        if (this.#start.get(handle) !== written) {
          if (movedFrom < 0) movedFrom = written;
          movedTo = written + count;
        }
        this.#start.set(handle, written);
        const box = this.#boxes.get(handle);
        // A fresh `Box3` is already empty, so the first block's box is the square's and every block
        // after it unions into it.
        if (box !== undefined) union.union(box);
        written += count;
      }
      this.#squareSizes.set(square.cluster, sizeOf(square));
    }
    array.set(scratch.subarray(0, written * 16));
    this.#drawn = written;
    const capacity = this.mesh.instanceMatrix.count;
    this.#free = written < capacity ? [[written, capacity]] : [];
    this.#window = this.#windowOf(visible);
    // After `#drawn`, because `#touched` measures the span it may widen against the drawn range, and
    // before the caller's own `#touched`, which the epoch unions with it rather than replacing it.
    if (movedFrom >= 0) this.#touched(movedFrom, movedTo - movedFrom);
  }

  /**
   * The live blocks, in buffer order and gathered into the squares they belong to.
   *
   * Buffer order is what "the squares keep their relative order" means, and it is not the order of
   * `#start`, which is keyed by handle rather than by position. A square's blocks are only adjacent
   * because the last regroup made them so — a cell admitted after that lands anywhere in the free
   * tail — so the squares are gathered here and written out by {@link #regroup}, and it is these
   * two orders that a residency change has to preserve.
   */
  #squares(): Array<{ cluster: string; blocks: Array<[number, number, number, string]> }> {
    const blocks: Array<[number, number, number, string]> = [];
    for (const [handle, start] of this.#start) {
      const size = this.#size.get(handle) ?? 0;
      if (size > 0) blocks.push([handle, start, size, this.#blockCluster.get(handle) ?? ""]);
    }
    blocks.sort((a, b) => a[1] - b[1]);
    const squares: Array<{ cluster: string; blocks: typeof blocks }> = [];
    const squareOf = new Map<string, number>();
    for (const block of blocks) {
      const cluster = block[3] as string;
      const index = squareOf.get(cluster);
      if (index === undefined) {
        squareOf.set(cluster, squares.length);
        squares.push({ cluster, blocks: [block] });
        continue;
      }
      (squares[index] as { blocks: typeof blocks }).blocks.push(block);
    }
    return squares;
  }

  /** Records of the squares in `visible`, the count a clustered batch's `mesh.count` draws. */
  #windowOf(visible: Set<string> | undefined): number {
    if (visible === undefined) return this.#drawn;
    let window = 0;
    for (const [cluster, size] of this.#squareSizes) if (visible.has(cluster)) window += size;
    return window;
  }

  /**
   * Narrow the draw window to the visibility cells `visible` names, rewriting the instance buffer
   * when this batch's own share of that set changed. `settled` when nothing had to be looked at,
   * `narrowed` when the count was re-widened, `repacked` when records were copied.
   *
   * `visible` and `epoch` are the frame's answer, derived once for the whole main pass by
   * {@link WorldCells.#cullMainPass}: one frustum, one set of visible visibility cells, and an epoch
   * that only moves when that set did. A batch whose records have not moved since it last packed at
   * that epoch answers `false` from two integer comparisons — no frustum, no set, no copy — which is
   * the whole of a settled frame across the ~230 meshes of a 2 km walk. Before that it was every
   * batch rebuilding a frustum from the same camera, allocating a set and re-testing its own per-key
   * volumes: ~4 ms a frame of `compute` for an answer that had not changed.
   *
   * Three's whole-mesh test cannot do this at all: the mesh's bounds are every resident cell's, so on
   * a 640 m ring the test always passes and every instance behind or beside the camera is
   * vertex-shaded — which on a tree-heavy 2 km map is most of a 65 M-triangle main pass, and the
   * whole cost of it is vertex work that half resolution does not touch.
   *
   * The cells are the main cull's own and the volumes are per placement (see
   * {@link WorldCells.#cullMainPass}), which is what this narrowness is spent on: a cell's XZ is
   * one world cell rather than a 128 m caster square, and its Y is the height its own placements
   * reach rather than the whole map's terrain range.
   *
   * A draw that finds the same cells it found last time touches nothing at all: no copy, no
   * `needsUpdate`, and therefore no attribute version — which is what a settled static draw watches
   * to know it still has to scan.
   */
  cullFrom(visible: ReadonlySet<string>, epoch: number): "settled" | "narrowed" | "repacked" {
    if (!this.#clustered) return "settled";
    // A batch holding no square draws nothing whatever the camera found, so it is published empty
    // and takes no set and no scan — a prewarmed batch sits in exactly this state.
    if (this.#squareSizes.size === 0) {
      this.#publish(0);
      return "settled";
    }
    // Settled: the frame's set is the one this window was laid out at and no record joined or left
    // since. O(1), and no allocation of any kind.
    if (this.#narrowed && this.#packedEpoch === epoch) return "settled";
    const next = this.#scratch;
    next.clear();
    for (const square of this.#squareSizes.keys()) if (visible.has(square)) next.add(square);
    // The same squares as the buffer holds: a residency change or a square elsewhere entering and
    // leaving the view. The layout is already right, so the window only has to be re-narrowed — a
    // residency change left `mesh.count` at the live total, and `#settle`'s regroup put the squares
    // in the window's order with no copy.
    if (sameSquares(next, this.#visible)) {
      this.#publish(this.#window);
      this.#narrowed = true;
      this.#packedEpoch = epoch;
      return "narrowed";
    }
    this.#regroup(next);
    // The reorder hands its own upload, over the records that actually moved — a window that moved
    // a square across the half boundary and left every record where it was costs nothing here, which
    // is the walking camera's common case. See `#regroup`.
    // The layout now belongs to the other set, so the two trade places and the next cull reuses the
    // one this batch is no longer holding.
    const was = this.#visible;
    this.#visible = next;
    this.#scratch = was ?? new Set();
    this.#scratch.clear();
    // `#publish` is what hides a window the camera narrowed to nothing, and what shows it again when
    // the camera turns back.
    this.#publish(this.#window);
    this.#narrowed = true;
    this.#packedEpoch = epoch;
    return "repacked";
  }

  /** Live records this batch holds, whether the camera is drawing them or not. */
  get live(): number {
    return this.#drawn;
  }

  /**
   * The record ceiling of this batch's *own* buffer, which is what a key's GPU region is sized from:
   * the same ring-sized ceiling the CPU path stops growing at. Held rather than read, because a
   * dressed batch's `mesh.instanceMatrix` is the GPU scene's shared buffer and its count is that
   * buffer's, not this key's.
   */
  get liveCeiling(): number {
    return this.#ceiling;
  }

  /** Records `mesh.count` draws: every live one, until a cull narrows the window. */
  get drawn(): number {
    return this.#clustered ? this.#window : this.#drawn;
  }

  /**
   * One coalesced upload per mesh, not one per moved, written or zeroed record range. Three's WebGPU
   * backend turns each entry of `updateRanges` into its own `GPUQueue.writeBuffer`, so the
   * per-range bookkeeping here was the walk's largest CPU cost: thousands of sub-1 KB vertex writes
   * per frame, over a second of a short walk spent on the queue. The dirty span is accumulated here
   * across every write, compact and clear of one update, so a frame that touches a mesh from
   * several directions still issues one writeBuffer. A span over half the drawn range becomes the
   * whole drawn range, which is never more bytes than the two halves it replaced.
   */
  #touched(from: number, count: number): void {
    // A dressed batch's records were never in this attribute, so there is nothing to upload and
    // nothing to put back in charge of culling: the dispatch decided what it drew.
    if (this.gpu !== undefined) return;
    const matrix = this.mesh.instanceMatrix;
    // A record is 16 array elements, and that is the unit `updateRanges` is in: three reads them
    // as element offsets into `array`, not as bytes.
    const drawn = this.#drawn * 16;
    const low0 = from * 16;
    const high0 = (from + count) * 16;
    // The pending span is ours, and it lasts one update. Three's WebGPU path uploads through the
    // interleaved buffer it derives from `instanceMatrix.array` and only that buffer's ranges are
    // cleared after the write, so the ranges on `instanceMatrix` are never consumed: they were
    // unioned in here forever, and after one wide write every later write re-uploaded the whole
    // drawn range. The epoch moves once per `update()`, and the render at the end of an update is
    // what consumes the span, so a fresh epoch is a fresh span.
    let low = low0;
    let high = high0;
    const epoch = currentWriteEpoch();
    if (this.#pendingEpoch === epoch) {
      if (this.#pendingLow < low) low = this.#pendingLow;
      if (this.#pendingHigh > high) high = this.#pendingHigh;
    }
    if (low > 0 && (high - low) * 2 > drawn) {
      low = 0;
      high = drawn;
    }
    this.#pendingLow = low;
    this.#pendingHigh = high;
    this.#pendingEpoch = epoch;
    matrix.clearUpdateRanges();
    if (high > low) matrix.addUpdateRange(low, high - low);
    matrix.needsUpdate = true;
    this.#publish(this.#drawn);
    // Records are real, so the bounds are the ones `#rebound` just wrote and the mesh goes back to
    // being culled.
    this.mesh.frustumCulled = true;
  }

  /**
   * The one place `mesh.count` is written, so a batch that would draw nothing is not submitted.
   *
   * In three r185's WebGPU path an `InstancedMesh` with `count === 0` still runs the whole per-draw
   * JS chain — nodes, bindings, pipeline, attributes — and only the backend's `getDrawParameters`
   * finally answers null. A walk census measured 322 of 871 main batch meshes and 437 of 1,574
   * caster meshes at count 0, so every empty batch was ~17 µs of CPU a frame for nothing drawn.
   * `visible` is the one flag three reads before any of that, so a batch with nothing to draw is
   * hidden here and shown again by the first write that gives it a record: a placement add, a
   * rebind of a retained batch, a residency change, or the main cull's window opening again.
   *
   * The exception is a batch still owed its prewarm draw, which stays visible *because* it is empty:
   * that one draw is what builds the node and the pipeline the loading screen exists to pay for,
   * and hiding it would hand the build to the first walk frame that wants the key. It hides as soon
   * as the draw is counted — see {@link prewarmDrew} — so this costs one zero-count draw per
   * prewarmed batch over the whole load, which is the cost the prewarm is for.
   */
  #publish(count: number): void {
    // A shadow key is submitted every render of a map that covers it: its own records are the
    // dispatch's, so an empty-looking key is one this map draws nothing of, not one to hide.
    if (this.role === "key") {
      this.mesh.count = this.gpuCount;
      this.mesh.visible = true;
      return;
    }
    // A dressed batch's instances are the GPU scene's, and its own `count` says nothing about how
    // many the dispatch kept — a zero there makes three skip the indirect draw before the GPU reads
    // the record at all. So the mesh is submitted at its region's capacity and the record decides
    // what draws; the per-asset coarse gate in `#cullMainPass` runs after this every frame and is
    // what shows it. Until then the prewarm draw is the one reason to stay visible *because* it is
    // empty: that submission is what builds the node and the pipeline.
    if (this.gpu !== undefined) {
      this.mesh.count = this.gpuCount;
      if (this.bundled === false) this.mesh.visible = this.#awaitingPrewarm;
      return;
    }
    this.mesh.count = count;
    this.mesh.visible = count > 0 || this.#awaitingPrewarm;
  }

  /**
   * The GPU-driven main pass's coarse gate, asked per key and answered per asset: whether any of
   * this batch's CPU grid squares is in `visible`, or it still owes the draw that builds its node.
   *
   * It is deliberately *not* the draw decision. A key's squares are the level the CPU picked from the
   * follow point when it built them, and the dispatch re-picks the level from the camera every frame
   * — so a key holding no cell can be the one the dispatch draws, and hiding on its own empty answer
   * is how a tree disappeared on approach. The caller unions this across every level and part of the
   * asset and hands the asset's answer back; see `WorldCells#cullMainPass` and `applyGpuVisible`.
   */
  seenIn(visible: ReadonlySet<string>): boolean {
    if (this.#awaitingPrewarm) return true;
    for (const square of this.#squareSizes.keys()) if (visible.has(square)) return true;
    return false;
  }

  /**
   * Apply the asset's conservative visibility answer to this dressed mesh, and publish the count a
   * draw and the census read. A bundled mesh is shown by its recorded bundle and never asked.
   */
  applyGpuVisible(shown: boolean): void {
    // The region's capacity, not this batch's own records: an empty-looking key — one the CPU built
    // at another level — must still submit its indirect draw, and the record inside it draws nothing
    // when the dispatch selected none. See `gpuCount`.
    this.mesh.count = this.gpuCount;
    this.mesh.visible = shown;
  }

  /**
   * Owe this batch its prewarm draw, and show it: empty, unsubmitted work is not what a prewarm
   * wants, one submission is.
   *
   * The flag on the mesh is what `VirtualShadowNode`'s `#probe` reads: a caster is drawn by a level,
   * and a level picks one of the two caster layers, so a level that finds an owed caster renders
   * both — otherwise the half it did not pick would leave its prewarm casters unbuilt for the whole
   * walk. Engine bookkeeping on the mesh, beside the `casterInstanceScale` the probe already reads.
   */
  awaitPrewarmDraw(): void {
    this.#awaitingPrewarm = true;
    (this.mesh as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = true;
    this.#publish(this.drawn);
  }

  /**
   * Publish this batch's admission for the frame, on the mesh beside the other two flags the shadow
   * probe reads off it. A `main` batch has nothing to say — it is the truth the caster halves are
   * measured against — and writes its own mesh, which is on layer 0 and no level ever draws.
   */
  setMainAdmitted(admitted: boolean): void {
    if (this.role === "main" || this.#mainAdmitted === admitted) return;
    this.#mainAdmitted = admitted;
    this.mesh.mainAdmitted = admitted;
  }

  /**
   * The owed draw is counted, or it can never come, so the batch follows the count again and hides
   * if no placement ever gave it a record. Only `visible` is written: the count three is submitting
   * this frame is the right one, and `#publish` would replace it with a window no cull has run for.
   */
  prewarmDrew(): void {
    this.#awaitingPrewarm = false;
    (this.mesh as { casterPrewarmOwed?: boolean }).casterPrewarmOwed = false;
    // A bundled mesh is in a render list three fixed when it recorded the bundle, and the replay
    // never re-reads visibility — so hiding it here would not save this frame's draw and would lose
    // the mesh from every record after the next structural change. See `bundled`.
    if (this.bundled === true) return;
    this.mesh.visible = this.mesh.count > 0;
  }
}
