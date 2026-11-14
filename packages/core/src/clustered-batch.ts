import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Euler,
  Frustum,
  InstancedMesh,
  type Material,
  Matrix4,
  Object3D,
  Quaternion,
  Vector3,
} from "three";
import {
  ClusterView,
  DEFAULT_VIEW_MARGIN,
  type IClusterTable,
  assertViewMargin,
  clusterTableRadius,
  outsideFrustum,
  pixelsPerUnit,
  selectClusterCut,
  worldFrustum,
} from "./clustered-mesh.js";

/**
 * Many copies of one clustered body, each drawn at the detail its own distance earns.
 *
 * `InstancedBatch` collapses repeated props into one draw; this does the same for a body that
 * carries a cluster DAG, and adds the part `InstancedBatch` cannot do — a copy twelve metres away
 * and a copy two hundred metres away do not draw the same triangles.
 *
 * **Why instances are bucketed rather than cut one by one.** One indexed draw has one index range,
 * and multi-draw indirect is not portably available on this stack, so *n* different cuts would mean
 * *n* draws and *n* index buffers — on four hundred boulders that is a gigabyte of index data to
 * save vertex work. Instead the copies are grouped by distance, one cut is taken per occupied
 * group, and each group draws as one instanced draw. Every group's cut is a real cut of the DAG and
 * therefore watertight; the group is cut at the distance of its *nearest* member, so no copy is ever
 * drawn coarser than its own distance allows — only finer, by at most the width of one group.
 *
 * Geometry, surface and every transform are the game's, exactly as with `InstancedBatch`.
 */

/** One copy's transform, in the units the geometry was authored in. */
export interface IClusteredPlacement {
  readonly position: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number] | number;
}

export interface IClusteredBatchOptions {
  /**
   * How far the camera must move, as a fraction of its distance to the nearest copy, before the
   * cut is taken again. Default 1%.
   *
   * The engine cuts every batch every frame, so this is the difference between a walk that costs a
   * few hundred cluster tests and one that costs half a million. A camera that has not moved
   * meaningfully keeps the previous cut, which is always a cut some camera would have chosen and
   * therefore always watertight.
   */
  readonly recutFraction?: number;
  /**
   * Ratio between one distance group and the next, above 1.
   *
   * Narrower groups follow each copy's own distance more closely and cost one more draw each.
   * 1.25 is the default: about a dozen groups across a scene that spans a few hundred metres.
   */
  readonly distanceRatio?: number;
  /** Screen-space error budget in pixels, as {@link ClusteredMesh}. Default 1. */
  readonly errorPixels?: number;
  /**
   * Whether copies the camera cannot see are skipped.
   *
   * On by default. A batch that casts shadows keeps every copy regardless — a copy out of the main
   * view can still cast into it — until shadows have a cut of their own. The batch reports what it
   * did through {@link ClusteredBatch.viewCullReport}.
   */
  readonly viewCull?: boolean;
  /** How far the camera may turn, in radians, before the bands are taken again. Default two degrees. */
  readonly viewMargin?: number;
  /** The shape every copy draws, carrying the baked cluster table. */
  readonly geometry: BufferGeometry;
  /** The surface every copy draws with, supplied by the game and used by reference. */
  readonly material: Material;
  /** The bake, exactly as `TN_virtual_geometry` stores it. */
  readonly table: IClusterTable;
}

export interface IClusteredBatchBuildOptions {
  readonly castShadow?: boolean;
  readonly name?: string;
  readonly parent: Object3D;
  readonly receiveShadow?: boolean;
}

/**
 * Updates a distance group may stand empty before its index buffer goes back to the driver.
 *
 * Long enough that the renderer cannot still be holding the buffer in a submitted command, short
 * enough that a walk across the scene does not accumulate every group it ever passed through. A
 * quarry route that kept them all ran the GPU out of memory: `vkAllocateMemory failed with
 * VK_ERROR_OUT_OF_DEVICE_MEMORY`.
 */
const RECLAIM_AFTER_EMPTY_UPDATES = 4;

/**
 * Distance groups that may be built in one update.
 *
 * Building a group means cutting it and uploading its index buffer, and the first frames of a route
 * populate every group a walk will ever use. Doing that at once cost the quarry a 649.6 ms
 * `render.p95` on the native host — one visible stall in a game that never asked for any of this.
 * Four per update converges a walking camera without a visible stall; copies whose own group is
 * not built yet draw with the nearest built one, which is a real cut of
 * the same DAG and therefore watertight; they refine within a few frames.
 */
const GROUPS_BUILT_PER_UPDATE = 4;

const DEFAULT_DISTANCE_RATIO = 1.25;
const DEFAULT_RECUT_FRACTION = 0.01;
const DEFAULT_ERROR_PIXELS = 1;
/** A copy nearer than this is treated as this far away, rather than taking log of zero. */
const MIN_DISTANCE = 1e-3;
/** A copy the view does not hold: it joins no band, anchors no cut, and submits nothing. */
const CULLED = -2147483648;

interface IPlaced {
  readonly matrix: Matrix4;
  readonly inverse: Matrix4;
  readonly position: Vector3;
  readonly scale: number;
}

interface IGroup {
  readonly copies: number[];
  cut: Uint32Array;
  /** Consecutive updates with no copy in this group. */
  empty: number;
  mesh: InstancedMesh | null;
}

/**
 * The node a batch attaches to the scene.
 *
 * A subclass rather than a plain `Object3D` so the engine's per-frame walk can find the batch the
 * same way it finds a `ClusteredMesh` — virtual geometry ships on, and a game that has to remember
 * to call something has not been given it.
 */
export class ClusteredBatchRoot extends Object3D {
  constructor(readonly batch: ClusteredBatch) {
    super();
  }

  /**
   * A copy that is still being cut.
   *
   * three builds one through `new this.constructor()`, which left the copy's `batch` undefined
   * and quietly stopped cutting it — a frozen cut that still drew. Sharing the batch is what
   * keeps a copy alive: the batch owns the bands and their index buffers, so the copy draws the
   * same cut as the root it was copied from, which is the same thing `Mesh.copy` does with
   * geometry and `VirtualGeometryPlugin` does with a baked table.
   */
  override clone(recursive = true): this {
    return new ClusteredBatchRoot(this.batch).copy(this, recursive) as this;
  }
}

function placementMatrix(placement: IClusteredPlacement): Matrix4 {
  const scale = placement.scale ?? 1;
  const scaleVector =
    typeof scale === "number" ? new Vector3(scale, scale, scale) : new Vector3(...scale);
  const rotation = placement.rotation ?? [0, 0, 0];
  return new Matrix4().compose(
    new Vector3(...placement.position),
    new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2])),
    scaleVector,
  );
}

export class ClusteredBatch {
  readonly #options: IClusteredBatchOptions;
  readonly #placed: IPlaced[] = [];
  readonly #groups = new Map<number, IGroup>();
  readonly #selection: Uint32Array;
  /** The distance band each copy actually belongs to this update, before any borrowing. */
  #wantedKey: Int32Array;
  readonly #cameraWorld = new Vector3();
  readonly #cameraLocal = new Vector3();
  readonly #lastCut = new Vector3();
  readonly #rotation = new Quaternion();
  readonly #lastRotation = new Quaternion();
  readonly #view = new ClusterView();
  #hasCut = false;
  #lastScale = 0;
  /** The projection the bands were chosen by: an aspect or zoom change keeps the pixel scale. */
  readonly #lastProjection = new Matrix4();
  #culled = false;
  readonly #distanceRatio: number;
  /** Radians the camera may turn before the bands are taken again. */
  readonly viewMargin: number;
  /**
   * Whether copies the camera cannot see are skipped. Writable; the batch reports what it did
   * through {@link ClusteredBatch.viewCullReport}.
   */
  viewCull: boolean;
  /** Bands this camera wants that are not built yet; while any remain the cut cannot settle. */
  #pending = 0;
  #root: Object3D | null = null;
  #built: IClusteredBatchBuildOptions | null = null;
  #drawnTriangles = 0;
  readonly #meshRadius: number;
  readonly #frustum = new Frustum();
  readonly #viewMatrix = new Matrix4();
  /** The band each copy was drawn in this update, or `CULLED` when it was not drawn at all. */
  #bandKey: Int32Array;
  #drawnCopiesOutsideView = 0;
  #drawnTrianglesOutsideView = 0;

  constructor(options: IClusteredBatchOptions) {
    this.#options = options;
    this.#distanceRatio = options.distanceRatio ?? DEFAULT_DISTANCE_RATIO;
    if (!(this.#distanceRatio > 1))
      throw new Error(
        `ClusteredBatch distanceRatio must be above one, got ${this.#distanceRatio}.`,
      );
    this.viewCull = options.viewCull ?? true;
    this.viewMargin = options.viewMargin ?? DEFAULT_VIEW_MARGIN;
    assertViewMargin(this.viewMargin);
    this.#selection = new Uint32Array(options.table.ranges.length / 2);
    this.#wantedKey = new Int32Array(0);
    this.#bandKey = new Int32Array(0);
    this.#meshRadius = clusterTableRadius(options.table);
  }

  /** How many copies are placed. */
  get count(): number {
    return this.#placed.length;
  }

  /** Draws this batch will submit — one per occupied distance group. */
  get drawCalls(): number {
    let calls = 0;
    for (const group of this.#groups.values()) if (group.mesh?.visible === true) calls += 1;
    return calls;
  }

  /** Triangles the current cut submits, over every copy. */
  get drawnTriangles(): number {
    return this.#drawnTriangles;
  }

  /**
   * Copies the current cut submits whose own bounding sphere lies wholly outside the view volume.
   *
   * A measurement, not a cull: see {@link ClusteredMesh.drawnTrianglesOutsideView}.
   */
  get drawnCopiesOutsideView(): number {
    return this.#drawnCopiesOutsideView;
  }

  /** Triangles those copies submit: their own band's cut, times how many copies are outside. */
  get drawnTrianglesOutsideView(): number {
    return this.#drawnTrianglesOutsideView;
  }

  /**
   * What this batch does about copies outside the view, and why.
   *
   * `"on"` when copies the camera cannot see are skipped, and a reason when they are not — a batch
   * that silently kept drawing a whole copy behind the camera would be a cost with no symptom, and
   * one that silently dropped what a shadow camera can see would be a missing shadow with no cause.
   */
  get viewCullReport(): string {
    if (!this.viewCull) return "off (viewCull = false)";
    if (this.#built?.castShadow === true) return "off (castShadow)";
    return "on";
  }

  /** Adds one copy. Returns its index, so the game can move it later. */
  place(placement: IClusteredPlacement): number {
    if (this.#built !== null)
      throw new Error("ClusteredBatch.place cannot run after build; place every copy first.");
    const matrix = placementMatrix(placement);
    const scaleVector = new Vector3().setFromMatrixScale(matrix);
    this.#placed.push({
      inverse: matrix.clone().invert(),
      matrix,
      position: new Vector3().setFromMatrixPosition(matrix),
      scale: Math.max(scaleVector.x, scaleVector.y, scaleVector.z),
    });
    return this.#placed.length - 1;
  }

  /** Attaches the batch to the scene. Nothing draws until {@link ClusteredBatch.update} runs. */
  build(options: IClusteredBatchBuildOptions): Object3D {
    if (this.#placed.length === 0)
      throw new Error("ClusteredBatch.build needs at least one placed copy.");
    const root = new ClusteredBatchRoot(this);
    root.name = options.name ?? "";
    options.parent.add(root);
    this.#root = root;
    this.#built = options;
    return root;
  }

  /**
   * Chooses this frame's cut for every distance group.
   *
   * @returns triangles the batch will submit.
   */
  update(camera: Camera, viewportHeight: number): number {
    const root = this.#root;
    if (root === null) throw new Error("ClusteredBatch.update needs build() first.");
    const scale = pixelsPerUnit(camera, viewportHeight);
    camera.updateWorldMatrix(true, false);
    this.#cameraWorld.setFromMatrixPosition(camera.matrixWorld);
    camera.getWorldQuaternion(this.#rotation);

    // A culled batch is a batch whose bands were chosen for a view, so the turn it was widened by is
    // part of what makes the previous cut still right. `castShadow` keeps every copy: one outside
    // the main view can still be cast into it.
    const culled = this.viewCull && this.#built?.castShadow !== true;
    if (culled) {
      this.#view.setFromCamera(camera, this.viewMargin);
      // Copies are placed in the batch root's space; a parent that moves the batch moves them too.
      root.updateWorldMatrix(true, false);
      this.#view.setTransform(root.matrixWorld);
    }

    // Everything below walks every cluster of every occupied band. Skip it outright when the camera
    // has not moved or turned enough to change a cut, and when every band this camera needs is
    // already built.
    let nearestCopy = Number.POSITIVE_INFINITY;
    for (const placed of this.#placed)
      nearestCopy = Math.min(nearestCopy, this.#cameraWorld.distanceTo(placed.position));
    const settled =
      this.#hasCut &&
      culled === this.#culled &&
      scale === this.#lastScale &&
      camera.projectionMatrix.equals(this.#lastProjection) &&
      this.#pending === 0 &&
      this.#rotation.angleTo(this.#lastRotation) <= this.viewMargin &&
      this.#cameraWorld.distanceTo(this.#lastCut) <=
        Math.max(nearestCopy, MIN_DISTANCE) *
          (this.#options.recutFraction ?? DEFAULT_RECUT_FRACTION);
    if (settled) return this.#drawnTriangles;
    this.#lastCut.copy(this.#cameraWorld);
    this.#lastRotation.copy(this.#rotation);
    this.#lastScale = scale;
    this.#lastProjection.copy(camera.projectionMatrix);
    this.#culled = culled;
    this.#hasCut = true;

    if (this.#wantedKey.length !== this.#placed.length) {
      this.#wantedKey = new Int32Array(this.#placed.length);
      this.#bandKey = new Int32Array(this.#placed.length);
    }
    for (const group of this.#groups.values()) group.copies.length = 0;

    // Which band each copy belongs to, before any borrowing.
    const wantedKeys = new Set<number>();
    for (let copy = 0; copy < this.#placed.length; copy += 1) {
      const placed = this.#placed[copy] as IPlaced;
      // A copy no camera can see joins no band, anchors no cut and submits nothing. Its own bounding
      // sphere is the test, the same sphere three would cull it by.
      if (
        culled &&
        !this.#view.touches(
          placed.position.x,
          placed.position.y,
          placed.position.z,
          this.#meshRadius * placed.scale,
        )
      ) {
        this.#wantedKey[copy] = CULLED;
        continue;
      }
      const distance = Math.max(this.#cameraWorld.distanceTo(placed.position), MIN_DISTANCE);
      // Grouped on distance measured in the body's own units, so two copies at different scales
      // that cover the same screen area land in the same group.
      const wanted = Math.floor(Math.log(distance / placed.scale) / Math.log(this.#distanceRatio));
      this.#wantedKey[copy] = wanted;
      wantedKeys.add(wanted);
    }

    // A band nobody has built yet costs a cut and an index upload. Grant a couple per update, in
    // order, so a scene arrives over a few frames instead of in one stall. The first update always
    // gets one, or nothing would have anywhere to borrow from.
    const open = new Set<number>();
    for (const key of wantedKeys) if (this.#groups.get(key)?.mesh != null) open.add(key);
    let grants = GROUPS_BUILT_PER_UPDATE;
    this.#pending = 0;
    for (const key of [...wantedKeys].sort((a, b) => a - b)) {
      if (open.has(key)) continue;
      if (grants <= 0 && open.size > 0) {
        this.#pending += 1;
        continue;
      }
      open.add(key);
      grants -= 1;
    }

    for (let copy = 0; copy < this.#placed.length; copy += 1) {
      const wanted = this.#wantedKey[copy] as number;
      if (wanted === CULLED) {
        this.#bandKey[copy] = CULLED;
        continue;
      }
      const key = open.has(wanted) ? wanted : this.#nearestOpenKey(wanted, open);
      this.#bandKey[copy] = key;
      let group = this.#groups.get(key);
      if (group === undefined) {
        group = { copies: [], cut: new Uint32Array(0), empty: 0, mesh: null };
        this.#groups.set(key, group);
      }
      group.copies.push(copy);
    }

    this.#drawnTriangles = 0;
    for (const [key, group] of this.#groups) {
      this.#drawGroup(group, root, scale, key);
      if (group.empty >= RECLAIM_AFTER_EMPTY_UPDATES) {
        this.#reclaim(group, root);
        this.#groups.delete(key);
      }
    }
    this.#countOutsideView(camera);
    return this.#drawnTriangles;
  }

  /**
   * Records how many copies of this batch, and how many of their triangles, lie wholly out of view.
   *
   * A copy is tested on its own bounding sphere — the body's radius at the copy's scale — which is
   * the sphere three itself would cull it by. Read-only, and taken only on a frame that re-cut.
   */
  #countOutsideView(camera: Camera): void {
    const frustum = worldFrustum(camera, this.#frustum, this.#viewMatrix);
    let copies = 0;
    let triangles = 0;
    for (let copy = 0; copy < this.#placed.length; copy += 1) {
      if ((this.#bandKey[copy] as number) === CULLED) continue;
      const placed = this.#placed[copy] as IPlaced;
      if (!outsideFrustum(frustum, placed.position, this.#meshRadius * placed.scale)) continue;
      copies += 1;
      const group = this.#groups.get(this.#bandKey[copy] as number);
      const mesh = group?.mesh;
      if (mesh?.visible === true) triangles += mesh.geometry.drawRange.count / 3;
    }
    this.#drawnCopiesOutsideView = copies;
    this.#drawnTrianglesOutsideView = triangles;
  }

  /**
   * Gives one group's index buffer back.
   *
   * The vertex attributes are deleted from the geometry *before* it is disposed, because they are
   * the batch's own and every other group is still drawing from them: disposing a geometry that
   * still holds them destroys the position buffer the whole batch shares, which WebGPU reports as
   * `[Buffer (unlabeled)] used in submit while destroyed`.
   */
  /** The open band closest to `wanted`, or `wanted` itself when none is open. */
  #nearestOpenKey(wanted: number, open: ReadonlySet<number>): number {
    let best = wanted;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const key of open) {
      const distance = Math.abs(key - wanted);
      if (distance < bestDistance) {
        best = key;
        bestDistance = distance;
      }
    }
    return best;
  }

  #reclaim(group: IGroup, root: Object3D): void {
    const mesh = group.mesh;
    if (mesh === null) return;
    root.remove(mesh);
    for (const name of Object.keys(mesh.geometry.attributes)) mesh.geometry.deleteAttribute(name);
    mesh.geometry.dispose();
    mesh.dispose();
    group.mesh = null;
    group.cut = new Uint32Array(0);
  }

  #drawGroup(group: IGroup, root: Object3D, scale: number, key: number): void {
    if (group.copies.length === 0) {
      group.empty += 1;
      if (group.mesh !== null) group.mesh.visible = false;
      return;
    }
    group.empty = 0;
    // Cut at the nearest member's distance: never coarser than any copy in the group allows.
    //
    // Copies borrowed from a band that is not built yet are excluded from the choice: they are
    // passing through, and letting one anchor the group would size its buffer for a distance the
    // band never owns — which grows the buffer, and every growth strands a GPU index buffer.
    let nearest = group.copies[0] as number;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let sawNative = false;
    for (const copy of group.copies) {
      const native = this.#wantedKey[copy] === key;
      if (sawNative && !native) continue;
      const placed = this.#placed[copy] as IPlaced;
      const distance = this.#cameraWorld.distanceTo(placed.position) / placed.scale;
      if (native && !sawNative) {
        sawNative = true;
        nearest = copy;
        nearestDistance = distance;
        continue;
      }
      if (distance < nearestDistance) {
        nearest = copy;
        nearestDistance = distance;
      }
    }
    const anchor = this.#placed[nearest] as IPlaced;
    this.#cameraLocal.copy(this.#cameraWorld).applyMatrix4(anchor.inverse);
    // Sized once, from the finest cut this band can ever need — see `#capacityFor`.
    if (group.cut.length === 0)
      group.cut = new Uint32Array(this.#capacityFor(group, anchor, nearestDistance, scale));

    const selected = selectClusterCut(
      this.#options.table,
      this.#cameraLocal,
      scale,
      this.#options.errorPixels ?? DEFAULT_ERROR_PIXELS,
      this.#selection,
    );
    // Every band's cut is taken unpruned, on purpose. One cut serves every copy in the band, and
    // those copies face the camera from different directions: pruning it by the view would drop the
    // clusters the copies either side of the band are looking at. What a band does not hold is
    // culled per copy, above.
    let indices = 0;
    for (let slot = 0; slot < selected; slot += 1)
      indices += this.#options.table.ranges[(this.#selection[slot] as number) * 2 + 1] as number;
    // Growing is the last resort and should not happen: three frees a geometry's index buffer only
    // when the geometry is disposed, so every replacement leaks one. The quarry's route leaked 74 of
    // them every 120 frames and ran an 8 GB card out of memory.
    if (group.cut.length < indices) group.cut = new Uint32Array(Math.ceil(indices * 1.5));
    let cursor = 0;
    for (let slot = 0; slot < selected; slot += 1) {
      const cluster = this.#selection[slot] as number;
      const start = this.#options.table.ranges[cluster * 2] as number;
      const count = this.#options.table.ranges[cluster * 2 + 1] as number;
      group.cut.set(this.#options.table.indices.subarray(start, start + count), cursor);
      cursor += count;
    }

    const mesh = this.#meshFor(group, root);
    mesh.count = group.copies.length;
    for (let slot = 0; slot < group.copies.length; slot += 1)
      mesh.setMatrixAt(slot, (this.#placed[group.copies[slot] as number] as IPlaced).matrix);
    mesh.instanceMatrix.needsUpdate = true;
    const index = mesh.geometry.getIndex();
    if (index !== null && cursor > 0) {
      index.addUpdateRange(0, cursor);
      index.needsUpdate = true;
    }
    mesh.geometry.setDrawRange(0, cursor);
    // Nothing resolved for this group, so nothing is submitted for it.
    mesh.visible = cursor > 0;
    this.#drawnTriangles += (cursor / 3) * group.copies.length;
  }

  /**
   * Index slots the finest cut this distance band can ever need.
   *
   * A band spans `[d, d * distanceRatio)`, and the cut only gets coarser as the camera falls back
   * through it, so the cut taken at the band's near edge bounds every cut the band will ever take.
   * Half again as much on top covers the part that is not distance — two cameras the same distance
   * away in different directions do not select quite the same clusters.
   *
   * This is sized once because replacing a geometry's index attribute leaks its GPU buffer: three
   * releases `geometry.index` only when the geometry itself is disposed.
   */
  #capacityFor(group: IGroup, anchor: IPlaced, nearestDistance: number, scale: number): number {
    const nearEdge =
      this.#distanceRatio ** Math.floor(Math.log(nearestDistance) / Math.log(this.#distanceRatio));
    const direction = this.#cameraLocal.clone().normalize();
    const probe = direction.multiplyScalar(Math.max(nearEdge, MIN_DISTANCE));
    const selected = selectClusterCut(
      this.#options.table,
      probe,
      scale,
      this.#options.errorPixels ?? DEFAULT_ERROR_PIXELS,
      this.#selection,
    );
    let indices = 0;
    for (let slot = 0; slot < selected; slot += 1)
      indices += this.#options.table.ranges[(this.#selection[slot] as number) * 2 + 1] as number;
    void group;
    void anchor;
    return Math.max(3, Math.ceil(indices * 1.5));
  }

  /**
   * The group's mesh, created once and never disposed.
   *
   * A group's geometry shares the batch's vertex attributes *by reference* — only the index range
   * differs between groups, and cloning would copy every position per group, which is the memory
   * this design exists to avoid. That sharing is also why the geometry is never disposed:
   * `BufferGeometry.dispose()` releases the attributes it holds, so freeing one group's geometry
   * destroys the position buffer every other group is still drawing from. WebGPU said exactly that
   * on the quarry's first virtual run — `[Buffer (unlabeled)] used in submit while destroyed`,
   * hundreds of times a second. When a group outgrows its cut only the index attribute is replaced,
   * and doubling bounds how often that happens.
   */
  #meshFor(group: IGroup, root: Object3D): InstancedMesh {
    const existing = group.mesh;
    if (existing !== null) {
      if ((existing.geometry.getIndex()?.array as Uint32Array) !== group.cut)
        existing.geometry.setIndex(new BufferAttribute(group.cut, 1));
      return existing;
    }
    const geometry = new BufferGeometry();
    for (const [name, attribute] of Object.entries(this.#options.geometry.attributes))
      geometry.setAttribute(name, attribute);
    geometry.boundingSphere = this.#options.geometry.boundingSphere;
    geometry.boundingBox = this.#options.geometry.boundingBox;
    // `BufferAttribute`, never `Uint32BufferAttribute`: the typed subclasses copy the array, which
    // both hides every cut from the GPU and makes the identity check above replace the index every
    // frame — three frees a geometry's index only on dispose, so that leaked one buffer a frame.
    geometry.setIndex(new BufferAttribute(group.cut, 1));
    const mesh = new InstancedMesh(geometry, this.#options.material, this.#placed.length);
    const built = this.#built as IClusteredBatchBuildOptions;
    mesh.castShadow = built.castShadow ?? false;
    mesh.receiveShadow = built.receiveShadow ?? false;
    mesh.frustumCulled = false;
    mesh.name = `${built.name ?? ""}-group`;
    root.add(mesh);
    group.mesh = mesh;
    return mesh;
  }
}
