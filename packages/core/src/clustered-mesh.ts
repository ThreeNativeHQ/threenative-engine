import {
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Frustum,
  type Material,
  Matrix4,
  Mesh,
  Quaternion,
  Vector3,
} from "three";

/**
 * A mesh that draws only the clusters this camera can resolve.
 *
 * The asset pipeline bakes a cluster DAG into the `.glb` (`TN_virtual_geometry`); the loader returns
 * one of these when it finds one, and an ordinary `Mesh` when it does not. Nothing about how the
 * mesh looks lives here: `geometry`, `material` and every appearance parameter are the game's, and
 * swapping the surface at any time swaps what draws.
 *
 * The rule, and it asks a cluster nothing about its neighbours: **draw a cluster when its own error
 * projects to fewer screen pixels than the threshold, and its parent group's does not.** Each side
 * is projected through the sphere of the group it belongs to, which is what keeps the cut watertight
 * as the camera moves — a group's sphere encloses every child's, so the parent's projected error can
 * never fall below a child's.
 */

/** The baked payload, exactly as `TN_virtual_geometry` stores it. */
export interface IClusterTable {
  /**
   * Per cluster, `[centreX, centreY, centreZ, radius]`, in the mesh's own space.
   *
   * "The mesh's own space" is the one its `POSITION` attribute is in, which is why the asset pass
   * never quantizes a primitive that carries this table: quantization keeps the drawn positions but
   * moves the space out from under them, and every sphere below is tested against a transform.
   */
  readonly bounds: Float32Array;
  /** Per cluster, `[axisX, axisY, axisZ, cutoff]`. Read into a field nothing uses yet. */
  readonly cones: Float32Array;
  /** Per cluster, `[ownError, parentError]`, in the mesh's own units. */
  readonly errors: Float32Array;
  /**
   * Per cluster, `[group, sourceGroup]`, or absent on a table built by hand.
   *
   * `group` is the group that folded this cluster one level up (`NO_GROUP` when nothing above
   * replaces it), and `sourceGroup` is the group whose simplification produced it. Inverting `group`
   * gives the children of every group, which is the descent a view-pruned cut walks.
   */
  readonly groups?: Uint32Array;
  /** Cluster-ordered triangles for every level, indexing the geometry's vertex buffer. */
  readonly indices: Uint32Array;
  /** Per cluster, the sphere `parentError` is projected through. */
  readonly parentSpheres: Float32Array;
  /** Per cluster, `[start, count]` into {@link IClusterTable.indices}. */
  readonly ranges: Uint32Array;
  /** Per cluster, the sphere its own error is projected through. */
  readonly sourceSpheres: Float32Array;
}

/** Written into `clusterGroups` where a cluster has no group on that side. */
export const NO_CLUSTER_GROUP = 0xffffffff;

export interface IClusteredMeshOptions {
  /**
   * Screen-space error a cluster may show, in pixels, before its children are drawn instead.
   *
   * One pixel is the honest default: the point of the technique is that what the camera cannot
   * resolve is never submitted. Raising it trades fidelity for triangles, and the number is the
   * game's to choose.
   */
  readonly errorPixels?: number;
  /**
   * How far the camera must move, in the mesh's own units, before the cut is taken again.
   *
   * Popping is a defect, not a tuning parameter: a camera standing still and breathing must not
   * flip a cluster back and forth. Below this the previous cut is kept, which is always a cut some
   * camera would have chosen and therefore always watertight. Default is a thousandth of the mesh's
   * radius.
   */
  readonly recutDistance?: number;
  /**
   * Whether clusters the camera cannot see are skipped.
   *
   * On by default, because a cluster behind the camera is a cluster nobody can resolve. A mesh that
   * casts shadows keeps the unpruned cut until shadows have a cut of their own, and a game that
   * renders the mesh through a second camera (a mirror, a portal) can turn it off; either way the
   * mesh reports what it did through {@link ClusteredMesh.viewCullReport}.
   */
  readonly viewCull?: boolean;
  /**
   * How far the camera may turn, in radians, before the cut is taken again.
   *
   * A cut pruned by the view is only valid for the view it was taken with, so the frustum it was
   * pruned by is widened by this angle and the cut is kept until the camera turns past it. It is the
   * one constant this technique needs: too small re-cuts on every nudge, too large draws a sliver of
   * clusters that turning would reveal. Default {@link DEFAULT_VIEW_MARGIN}.
   */
  readonly viewMargin?: number;
}

/** A cluster nearer than this to the camera is treated as this far away, rather than dividing by zero. */
const MIN_DISTANCE = 1e-4;

const DEFAULT_ERROR_PIXELS = 1;
const RECUT_FRACTION = 0.001;
/**
 * Radians the camera may turn before a view-pruned cut is taken again.
 *
 * Chosen from the measured re-cut cost on the quarry route: a re-cut copies a cut of a few hundred
 * thousand indices and costs well under a millisecond there, so two degrees buys steadiness a nudge
 * cannot spend and still re-cuts inside a normal look-around. Raising it trades a few clusters of
 * overdraw for fewer re-cuts; the game can set its own.
 */
export const DEFAULT_VIEW_MARGIN = Math.PI / 90;

/**
 * The two things a screen-space error needs from a camera.
 *
 * Structural rather than `PerspectiveCamera`, because a game may hand over its own camera subclass
 * and this asks it for nothing else.
 */
interface IPerspectiveCameraLike extends Camera {
  readonly fov?: number;
  readonly isPerspectiveCamera?: boolean;
}

/**
 * Pixels a one-unit object one unit away covers.
 *
 * Perspective only, and it throws otherwise rather than guessing: an orthographic cut has no
 * distance term at all and silently returning the wrong scale would show as a mesh that never
 * refines.
 */
export function pixelsPerUnit(camera: Camera, viewportHeight: number): number {
  const perspective: IPerspectiveCameraLike = camera;
  if (perspective.isPerspectiveCamera !== true || perspective.fov === undefined)
    throw new Error(
      "ClusteredMesh needs a perspective camera: a screen-space error has no meaning without one.",
    );
  if (!(viewportHeight > 0))
    throw new Error(`ClusteredMesh needs a positive viewport height, got ${viewportHeight}.`);
  return viewportHeight / (2 * Math.tan((perspective.fov * Math.PI) / 360));
}

function projectedError(
  error: number,
  spheres: Float32Array,
  cluster: number,
  camera: Vector3,
  scale: number,
): number {
  const dx = camera.x - (spheres[cluster * 4] as number);
  const dy = camera.y - (spheres[cluster * 4 + 1] as number);
  const dz = camera.z - (spheres[cluster * 4 + 2] as number);
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) - (spheres[cluster * 4 + 3] as number);
  return (error * scale) / Math.max(distance, MIN_DISTANCE);
}

/**
 * The cut, as a list of cluster indices, written into `out`.
 *
 * Pure, and the oracle PRD-283's kernel is graded against: same table, same camera, same threshold,
 * same set — or the kernel is wrong.
 *
 * @returns how many clusters were selected.
 */
export function selectClusterCut(
  table: IClusterTable,
  camera: Vector3,
  scale: number,
  errorPixels: number,
  out: Uint32Array,
): number {
  const clusters = table.ranges.length / 2;
  let selected = 0;
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const own = projectedError(
      table.errors[cluster * 2] as number,
      table.sourceSpheres,
      cluster,
      camera,
      scale,
    );
    if (own > errorPixels) continue;
    const parent = projectedError(
      table.errors[cluster * 2 + 1] as number,
      table.parentSpheres,
      cluster,
      camera,
      scale,
    );
    if (parent <= errorPixels) continue;
    if (selected >= out.length)
      throw new Error(
        `ClusteredMesh selected more than the ${out.length} clusters level 0 holds; the table is inconsistent.`,
      );
    out[selected] = cluster;
    selected += 1;
  }
  return selected;
}

/**
 * The six planes of a camera's view volume, in world space.
 *
 * The camera's own world matrix has to be current for this to mean anything, which is why every
 * caller here walks the camera first. `projectionMatrix` is read as the renderer left it: rebuilding
 * it here would silently disagree with the frame that is about to be drawn.
 */
export function worldFrustum(camera: Camera, into: Frustum, scratch: Matrix4): Frustum {
  return into.setFromProjectionMatrix(
    scratch.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

/**
 * Whether a sphere lies wholly outside the view volume.
 *
 * Every plane has to be crossed for the sphere to be out: a sphere that is behind the near plane is
 * outside it, and one that is merely to the left of the left plane and also past the far plane is
 * still outside. This is the read-only question PRD-600's counters ask — nothing is culled by it.
 */
export function outsideFrustum(frustum: Frustum, center: Vector3, radius: number): boolean {
  for (const plane of frustum.planes) if (plane.distanceToPoint(center) < -radius) return true;
  return false;
}

/** Radius of the sphere that holds every cluster's bounds, in the mesh's own units. */
export function clusterTableRadius(table: IClusterTable): number {
  let radius = 0;
  for (let cluster = 0; cluster * 4 < table.bounds.length; cluster += 1)
    radius = Math.max(radius, table.bounds[cluster * 4 + 3] as number);
  return radius;
}

/**
 * The child lists a view-pruned cut descends by, built once from the bake's `clusterGroups`.
 *
 * A cluster's own error says whether it may draw; whether *its* children must be looked at is a
 * different question, and answering it needs the DAG's edges rather than its errors. The edges are
 * the inverse of `clusterGroups`' first value: every cluster folded into group *g* is one of the
 * clusters *g* simplified, and a cluster's finer clusters are the ones the group that produced it
 * folded.
 */
export interface IClusterHierarchy {
  /** The clusters nothing above replaces — where a cut starts, and the only place it can. */
  readonly roots: Uint32Array;
  /** Per group *g*, its children are `children[starts[g]]` up to `children[starts[g + 1]]`. */
  readonly starts: Uint32Array;
  readonly children: Uint32Array;
  /** Per cluster, `[group, sourceGroup]`, exactly as the bake wrote them. */
  readonly groups: Uint32Array;
}

/**
 * Builds the descent lists, and refuses a table whose edges do not reach every cluster.
 *
 * Fails closed like every other table check here: a DAG whose edges strand a cluster would draw a
 * hole in the mesh the moment the walk used it, and a hole that only appears when a camera turns is
 * the worst kind to find. The bake guarantees the reachability this checks for.
 */
export function clusterHierarchy(table: IClusterTable): IClusterHierarchy {
  const groups = table.groups;
  if (groups === undefined)
    throw new Error(
      "ClusteredMesh needs table.groups to prune its cut by view: re-bake the model with the current asset pipeline.",
    );
  const clusters = table.ranges.length / 2;
  let groupCount = 0;
  let rootCount = 0;
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const group = groups[cluster * 2] as number;
    const source = groups[cluster * 2 + 1] as number;
    if (source !== NO_CLUSTER_GROUP) groupCount = Math.max(groupCount, source + 1);
    if (group === NO_CLUSTER_GROUP) rootCount += 1;
    else groupCount = Math.max(groupCount, group + 1);
  }
  const starts = new Uint32Array(groupCount + 1);
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const group = groups[cluster * 2] as number;
    if (group !== NO_CLUSTER_GROUP) starts[group + 1] = (starts[group + 1] as number) + 1;
  }
  for (let group = 0; group < groupCount; group += 1)
    starts[group + 1] = (starts[group + 1] as number) + (starts[group] as number);
  const children = new Uint32Array(clusters);
  const cursor = starts.slice();
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const group = groups[cluster * 2] as number;
    if (group === NO_CLUSTER_GROUP) continue;
    children[cursor[group] as number] = cluster;
    cursor[group] = (cursor[group] as number) + 1;
  }
  const roots = new Uint32Array(rootCount);
  let written = 0;
  for (let cluster = 0; cluster < clusters; cluster += 1)
    if ((groups[cluster * 2] as number) === NO_CLUSTER_GROUP) {
      roots[written] = cluster;
      written += 1;
    }
  // Every cluster has to be under a root, or a cut taken by the walk would silently miss it.
  const reached = reachableClusters({ children, groups, roots, starts });
  if (reached !== clusters)
    throw new Error(
      `TN_CLUSTER_DAG_UNREACHABLE: the cluster DAG reaches ${reached} of ${clusters} clusters from its ${rootCount} roots; re-bake the model with the current asset pipeline.`,
    );
  return { children, groups, roots, starts };
}

/** How many clusters the roots reach by descending the produced-by edges. */
function reachableClusters(hierarchy: IClusterHierarchy): number {
  const { children, groups, roots, starts } = hierarchy;
  const seen = new Uint8Array(groups.length / 2);
  const stack: number[] = [];
  for (const root of roots) {
    seen[root] = 1;
    stack.push(root);
  }
  let reached = roots.length;
  while (stack.length > 0) {
    const parent = groups[(stack.pop() as number) * 2 + 1] as number;
    if (parent === NO_CLUSTER_GROUP) continue;
    for (let slot = starts[parent] as number; slot < (starts[parent + 1] as number); slot += 1) {
      const child = children[slot] as number;
      if (seen[child] === 1) continue;
      seen[child] = 1;
      reached += 1;
      stack.push(child);
    }
  }
  return reached;
}

/**
 * What a pruned cut is allowed to skip: one sphere against the view.
 *
 * Structural rather than a class, so a spec can hand the walk a plane it decides for itself.
 */
export interface IClusterView {
  /**
   * Whether anything inside this sphere — in the mesh's own units — could still touch the view.
   *
   * Answers `true` for a sphere that only grazes it and for one the walk cannot decide, because a
   * wrong `false` is a hole and a wrong `true` is a few triangles.
   */
  touches(x: number, y: number, z: number, radius: number): boolean;
}

/**
 * One camera's view, widened by the turn the cut stays valid for, and the mesh's own transform.
 *
 * The frustum lives in world space and the sphere comes in the mesh's own units, so the transform
 * is applied here rather than at every call site. A sphere is scaled by the matrix's largest axis
 * scale, the same way three's own frustum cull scales one, and a camera that has moved `d` away
 * from the view it cut by keeps anything within `d` times the margin — which is exactly the set a
 * turn inside the margin can reveal.
 */
export class ClusterView implements IClusterView {
  readonly #frustum = new Frustum();
  readonly #viewMatrix = new Matrix4();
  readonly #eye = new Vector3();
  readonly #center = new Vector3();
  readonly #toWorld = new Matrix4();
  #scale = 1;
  #margin = 0;

  /** Points this view at `camera`, kept valid for a turn of `margin` radians. */
  setFromCamera(camera: Camera, margin: number): void {
    camera.updateWorldMatrix(true, false);
    worldFrustum(camera, this.#frustum, this.#viewMatrix);
    this.#eye.setFromMatrixPosition(camera.matrixWorld);
    // A turn of `m` rotates each plane about the eye, and a plane's normal moves by `2 sin(m / 2)` —
    // the chord, not the sine. So a sphere at distance `d` keeps everything a turn that far can
    // reveal when it is inflated by `d` times this, which is the exact bound rather than a guess.
    this.#margin = 2 * Math.sin(margin / 2);
  }

  /** The transform from the units the spheres are given in to world space. */
  setTransform(matrixWorld: Matrix4): void {
    this.#toWorld.copy(matrixWorld);
    this.#scale = matrixWorld.getMaxScaleOnAxis();
  }

  touches(x: number, y: number, z: number, radius: number): boolean {
    this.#center.set(x, y, z).applyMatrix4(this.#toWorld);
    const slack = this.#margin === 0 ? 0 : this.#center.distanceTo(this.#eye) * this.#margin;
    return !outsideFrustum(this.#frustum, this.#center, radius * this.#scale + slack);
  }
}

/** Index slots the finest possible cut needs: every cluster whose own error is zero. */
function finestIndexCount(table: IClusterTable): number {
  let count = 0;
  for (let cluster = 0; cluster * 2 < table.ranges.length; cluster += 1)
    if ((table.errors[cluster * 2] as number) === 0)
      count += table.ranges[cluster * 2 + 1] as number;
  return count;
}

/**
 * The view-pruned walk, and the scratch it needs to run without allocating.
 *
 * Selects exactly what {@link selectClusterCut} selects, without visiting clusters the view cannot
 * hold: it descends only where the parent test still fails and the sphere that encloses a whole
 * subtree still touches the (widened) frustum, and stops at the cluster it draws. `selectClusterCut`
 * stays the oracle this is graded against. One of these belongs to one table.
 */
export class ClusterWalk {
  readonly #table: IClusterTable;
  readonly #hierarchy: IClusterHierarchy;
  readonly #stack: Uint32Array;
  /** Which cut last descended into each group, so a group shared by siblings is visited once. */
  readonly #stamps: Int32Array;
  #generation = 0;

  constructor(table: IClusterTable, hierarchy: IClusterHierarchy = clusterHierarchy(table)) {
    this.#table = table;
    this.#hierarchy = hierarchy;
    this.#stack = new Uint32Array(table.ranges.length / 2);
    this.#stamps = new Int32Array(hierarchy.starts.length);
  }

  /** The cut, as cluster indices, written into `out`; returns how many were selected. */
  select(
    camera: Vector3,
    scale: number,
    errorPixels: number,
    view: IClusterView,
    out: Uint32Array,
  ): number {
    const { children, groups, roots, starts } = this.#hierarchy;
    const { errors, parentSpheres, sourceSpheres } = this.#table;
    this.#generation += 1;
    const generation = this.#generation;
    let selected = 0;
    let depth = 0;
    for (let root = 0; root < roots.length; root += 1) {
      this.#stack[depth] = roots[root] as number;
      depth += 1;
      while (depth > 0) {
        depth -= 1;
        const cluster = this.#stack[depth] as number;
        const own = projectedError(
          errors[cluster * 2] as number,
          sourceSpheres,
          cluster,
          camera,
          scale,
        );
        if (own <= errorPixels) {
          const parent = projectedError(
            errors[cluster * 2 + 1] as number,
            parentSpheres,
            cluster,
            camera,
            scale,
          );
          if (parent <= errorPixels) continue;
          if (selected >= out.length)
            throw new Error(
              `ClusteredMesh selected more than the ${out.length} clusters level 0 holds; the table is inconsistent.`,
            );
          out[selected] = cluster;
          selected += 1;
          continue;
        }
        // Too coarse to draw at this distance, so the clusters it replaced are the only candidates
        // left — and none of them can be in view if the sphere holding all of them cannot be.
        const source = groups[cluster * 2 + 1] as number;
        if (source === NO_CLUSTER_GROUP) continue;
        if (this.#stamps[source] === generation) continue;
        this.#stamps[source] = generation;
        if (
          !view.touches(
            sourceSpheres[cluster * 4] as number,
            sourceSpheres[cluster * 4 + 1] as number,
            sourceSpheres[cluster * 4 + 2] as number,
            sourceSpheres[cluster * 4 + 3] as number,
          )
        )
          continue;
        for (
          let slot = starts[source] as number;
          slot < (starts[source + 1] as number);
          slot += 1
        ) {
          this.#stack[depth] = children[slot] as number;
          depth += 1;
        }
      }
    }
    return selected;
  }
}

export class ClusteredMesh extends Mesh {
  /** The baked payload. The bake is the only thing that writes it; a copy takes the source's. */
  table!: IClusterTable;
  /** Screen-space error budget in pixels. Writable — it is the game's call. */
  errorPixels: number;
  /** Camera movement, in the mesh's own units, below which the previous cut is kept. */
  recutDistance: number;
  /**
   * Whether the cut skips clusters the camera cannot see. Writable — a mesh drawn through a second
   * camera can turn it off, and {@link ClusteredMesh.viewCullReport} says what happened either way.
   */
  viewCull: boolean;
  /** Camera turn, in radians, the kept cut stays valid for. Writable. */
  viewMargin: number;

  #cut!: Uint32Array;
  #selection!: Uint32Array;
  #walk: ClusterWalk | undefined;
  readonly #view = new ClusterView();
  readonly #cameraLocal = new Vector3();
  readonly #lastCut = new Vector3();
  readonly #rotation = new Quaternion();
  readonly #lastRotation = new Quaternion();
  readonly #frustum = new Frustum();
  readonly #viewMatrix = new Matrix4();
  readonly #sphereCenter = new Vector3();
  #drawnClusters = 0;
  #drawnIndices = 0;
  #drawnClustersOutsideView = 0;
  #drawnTrianglesOutsideView = 0;
  #recutMs = 0;
  #recutBytes = 0;
  #recutCount = 0;
  #hasCut = false;
  #pruned = false;
  #lastScale = 0;
  #lastErrorPixels = 0;

  constructor(
    geometry: BufferGeometry,
    surface: Material | Material[],
    table: IClusterTable,
    options: IClusteredMeshOptions = {},
  ) {
    super(geometry, surface);
    assertTable(table);
    this.errorPixels = options.errorPixels ?? DEFAULT_ERROR_PIXELS;
    this.recutDistance = options.recutDistance ?? radiusOf(table) * RECUT_FRACTION;
    this.viewCull = options.viewCull ?? true;
    this.viewMargin = options.viewMargin ?? DEFAULT_VIEW_MARGIN;
    assertViewMargin(this.viewMargin);
    this.#load(table, geometry);
    // Full detail until something cuts it. Virtual geometry ships on by default, so the mesh a
    // game never touches has to draw exactly what an ordinary `Mesh` would have drawn — a class
    // that starts invisible and waits to be updated would turn the default into a blank screen.
    // `update` only ever takes detail away from here.
    this.#compact(this.#finestCut());
  }

  /** Points this mesh at `table`, and installs its cut on the geometry it is going to draw. */
  #load(table: IClusterTable, geometry: BufferGeometry): void {
    this.table = table;
    this.#cut = new Uint32Array(finestIndexCount(table));
    this.#selection = new Uint32Array(table.ranges.length / 2);
    // No camera has taken a cut of this table yet, so there is nothing outside a view to report.
    this.#drawnClustersOutsideView = 0;
    this.#drawnTrianglesOutsideView = 0;
    this.#recutMs = 0;
    this.#recutBytes = 0;
    this.#recutCount = 0;
    this.#walk = table.groups === undefined ? undefined : new ClusterWalk(table);
    // The geometry draws out of the cut buffer from here on. Its vertex attributes are untouched:
    // every level of the DAG indexes the vertices the mesh already shipped.
    //
    // `BufferAttribute`, never `Uint32BufferAttribute`: the typed subclasses *copy* the array they
    // are given, so the cut this class writes every frame would never reach the GPU and the mesh
    // would draw a buffer of zeros — degenerate triangles, an empty screen, and no error anywhere.
    geometry.setIndex(new BufferAttribute(this.#cut, 1));
  }

  /**
   * A second mesh over the same body, cut for its own place in the scene.
   *
   * three's `Object3D.clone` builds through `new this.constructor()`, and this class's constructor
   * wants a table — so every game that stood a second copy of a cooked model where it wanted a
   * statue died in `assertTable` before drawing anything. The arguments are the source's own,
   * which is what a copy is.
   */
  override clone(recursive = true): this {
    return new ClusteredMesh(withOwnCut(this.geometry), this.material, this.table, {
      errorPixels: this.errorPixels,
      recutDistance: this.recutDistance,
      viewCull: this.viewCull,
      viewMargin: this.viewMargin,
    }).copy(this, recursive) as this;
  }

  /**
   * Becomes a copy of `source`, sharing the bake and the vertices and keeping a cut of its own.
   *
   * `Mesh.copy` shares the geometry outright, which this class cannot let it do: the cut lives in
   * the geometry's index buffer, so two meshes on one geometry would overwrite each other's index
   * every frame and both would draw whichever spoke last. The copy takes the vertex attributes by
   * reference instead — one copy of them on the GPU, because three keys its attributes on the
   * attribute — and the shared table, which is frozen at bake time and cannot go stale.
   */
  override copy(source: this, recursive = true): this {
    super.copy(source, recursive);
    if (!(source instanceof ClusteredMesh)) return this;
    const geometry = withOwnCut(source.geometry);
    this.#load(source.table, geometry);
    this.geometry = geometry;
    this.errorPixels = source.errorPixels;
    this.recutDistance = source.recutDistance;
    this.viewCull = source.viewCull;
    this.viewMargin = source.viewMargin;
    // Nothing this copy has drawn yet, so the next update has to cut it for where it stands.
    this.#hasCut = false;
    this.#compact(this.#finestCut());
    return this;
  }

  /** Every cluster the bake produced from the source triangles — the mesh as authored. */
  #finestCut(): number {
    let selected = 0;
    for (let cluster = 0; cluster * 2 < this.table.ranges.length; cluster += 1)
      if ((this.table.errors[cluster * 2] as number) === 0) {
        this.#selection[selected] = cluster;
        selected += 1;
      }
    return selected;
  }

  /** Clusters in the current cut. */
  get drawnClusters(): number {
    return this.#drawnClusters;
  }

  /** Triangles the current cut submits. */
  get drawnTriangles(): number {
    return this.#drawnIndices / 3;
  }

  /**
   * Triangles in the current cut whose cluster bounds lie wholly outside the view volume.
   *
   * A measurement, not a cull: PRD-600 records this number before and after the walk learns to skip
   * what the view does not hold. It is taken when the cut is taken, so a still camera reads the
   * number its standing cut was made with.
   */
  get drawnTrianglesOutsideView(): number {
    return this.#drawnTrianglesOutsideView;
  }

  /** Clusters in the current cut whose bounds lie wholly outside the view volume. */
  get drawnClustersOutsideView(): number {
    return this.#drawnClustersOutsideView;
  }

  /**
   * Milliseconds the last re-cut took, from choosing the cut to the index buffer being marked for
   * upload.
   *
   * The whole re-cut, because that is the cost a game pays for turning the camera and the number
   * `viewMargin` is chosen against. The bytes below are only the compact's copy, so the throughput
   * this divides out is the pessimistic one.
   */
  get recutMs(): number {
    return this.#recutMs;
  }

  /** Index bytes the last re-cut copied and uploaded. */
  get recutBytes(): number {
    return this.#recutBytes;
  }

  /** Throughput of the last re-cut's copy of the cut, in megabytes per second. */
  get recutMegabytesPerSecond(): number {
    return this.#recutMs > 0 ? this.#recutBytes / 1e3 / this.#recutMs : 0;
  }

  /** How many re-cuts this mesh has taken, so a reader can tell a fresh one from a stale reading. */
  get recutCount(): number {
    return this.#recutCount;
  }

  /**
   * What this mesh does about clusters outside the view, and why.
   *
   * `"on"` when the cut is pruned, and a reason when it is not — a mesh that silently kept drawing
   * what nobody can see would be a performance bug with no symptom, and one that silently dropped
   * what a second camera can see would be a hole with no cause.
   */
  get viewCullReport(): string {
    if (!this.viewCull) return "off (viewCull = false)";
    if (this.castShadow) return "off (castShadow)";
    if (this.#walk === undefined) return "off (no clusterGroups)";
    return "on";
  }

  /**
   * Chooses this frame's cut and compacts it into one index range.
   *
   * Called by the game before it renders, not from `onBeforeRender`: an empty cut has to skip the
   * draw rather than submit a zero-count one, and by the time three calls `onBeforeRender` the draw
   * is already on the list. A mesh this leaves invisible is made visible again by the next call,
   * which is why the call belongs in the frame loop rather than in the renderer.
   *
   * @returns triangles the mesh will draw.
   */
  update(camera: Camera, viewportHeight: number): number {
    const scale = pixelsPerUnit(camera, viewportHeight);
    this.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    this.#cameraLocal.setFromMatrixPosition(camera.matrixWorld);
    this.worldToLocal(this.#cameraLocal);
    camera.getWorldQuaternion(this.#rotation);

    // A cut pruned by the view is only right for the view it was pruned by, so it is kept while the
    // camera stays inside the band and the turn it was widened by.
    const pruned = this.viewCull && !this.castShadow && this.#walk !== undefined;
    const moved = this.#cameraLocal.distanceTo(this.#lastCut);
    const settled =
      this.#hasCut &&
      pruned === this.#pruned &&
      moved <= this.recutDistance &&
      this.#rotation.angleTo(this.#lastRotation) <= this.viewMargin &&
      scale === this.#lastScale &&
      this.errorPixels === this.#lastErrorPixels;
    if (settled) return this.drawnTriangles;

    this.#lastCut.copy(this.#cameraLocal);
    this.#lastRotation.copy(this.#rotation);
    this.#lastScale = scale;
    this.#lastErrorPixels = this.errorPixels;
    this.#pruned = pruned;
    this.#hasCut = true;
    const started = performance.now();
    const walk = this.#walk;
    if (pruned && walk !== undefined) {
      this.#view.setFromCamera(camera, this.viewMargin);
      this.#view.setTransform(this.matrixWorld);
      this.#compact(
        walk.select(this.#cameraLocal, scale, this.errorPixels, this.#view, this.#selection),
      );
    } else {
      this.#compact(
        selectClusterCut(this.table, this.#cameraLocal, scale, this.errorPixels, this.#selection),
      );
    }
    this.#recutMs = performance.now() - started;
    this.#recutBytes = this.#drawnIndices * 4;
    this.#recutCount += 1;
    this.#countOutsideView(camera);
    return this.drawnTriangles;
  }

  /**
   * Records how much of this cut the view volume does not hold.
   *
   * Read-only and taken when a cut is taken, so it costs one sphere test per selected cluster on the
   * re-cut path and nothing at all on a frame the cut settled. The mesh's own scale is folded into
   * the radius the way three folds it into its own cull, so a scaled placement is measured as it
   * draws.
   */
  #countOutsideView(camera: Camera): void {
    const frustum = worldFrustum(camera, this.#frustum, this.#viewMatrix);
    const scale = this.matrixWorld.getMaxScaleOnAxis();
    const world = this.matrixWorld;
    let clusters = 0;
    let indices = 0;
    for (let slot = 0; slot < this.#drawnClusters; slot += 1) {
      const cluster = this.#selection[slot] as number;
      const count = this.table.ranges[cluster * 2 + 1] as number;
      this.#sphereCenter
        .set(
          this.table.bounds[cluster * 4] as number,
          this.table.bounds[cluster * 4 + 1] as number,
          this.table.bounds[cluster * 4 + 2] as number,
        )
        .applyMatrix4(world);
      if (
        !outsideFrustum(
          frustum,
          this.#sphereCenter,
          (this.table.bounds[cluster * 4 + 3] as number) * scale,
        )
      )
        continue;
      clusters += 1;
      indices += count;
    }
    this.#drawnClustersOutsideView = clusters;
    this.#drawnTrianglesOutsideView = indices / 3;
  }

  #compact(selected: number): void {
    let cursor = 0;
    for (let slot = 0; slot < selected; slot += 1) {
      const cluster = this.#selection[slot] as number;
      const start = this.table.ranges[cluster * 2] as number;
      const count = this.table.ranges[cluster * 2 + 1] as number;
      this.#cut.set(this.table.indices.subarray(start, start + count), cursor);
      cursor += count;
    }
    this.#drawnClusters = selected;
    this.#drawnIndices = cursor;
    const index = this.geometry.getIndex();
    if (index !== null && cursor > 0) {
      index.addUpdateRange(0, cursor);
      index.needsUpdate = true;
    }
    this.geometry.setDrawRange(0, cursor);
    // Nothing resolved, so nothing is submitted. A zero-count draw costs a pipeline switch, warns
    // nobody, and is exactly the failure `projection-apply.ts` records for `InstancedMesh`.
    this.visible = cursor > 0;
  }
}

/**
 * The same vertices under a second geometry, so a second mesh can hold a cut of its own.
 *
 * `BufferGeometry.clone()` would do this and would also copy every position, normal and uv — the
 * memory a cooked model exists not to spend twice. Sharing the `BufferAttribute` objects shares
 * their GPU buffers too, because three keys its attribute cache on the attribute, not the geometry.
 */
function withOwnCut(geometry: BufferGeometry): BufferGeometry {
  const shell = new BufferGeometry();
  for (const [name, attribute] of Object.entries(geometry.attributes))
    shell.setAttribute(name, attribute);
  shell.boundingSphere = geometry.boundingSphere;
  shell.boundingBox = geometry.boundingBox;
  shell.groups = [...geometry.groups];
  return shell;
}

function radiusOf(table: IClusterTable): number {
  return clusterTableRadius(table);
}

export function assertViewMargin(margin: number): void {
  // Zero is a legal choice — re-cut on every degree — and a quarter turn or more is a half-sphere
  // kept for nothing; neither is a bug worth throwing over, but NaN and negatives are.
  if (!Number.isFinite(margin) || margin < 0 || margin >= Math.PI / 2)
    throw new Error(
      `ClusteredMesh viewMargin must be a turn in radians below a quarter circle, got ${margin}.`,
    );
}

function assertTable(table: IClusterTable): void {
  const clusters = table.ranges.length / 2;
  if (clusters === 0 || table.ranges.length % 2 !== 0)
    throw new Error(`ClusteredMesh needs at least one cluster, got ${table.ranges.length / 2}.`);
  const widths: [keyof IClusterTable, number][] = [
    ["bounds", 4],
    ["cones", 4],
    ["errors", 2],
    ["parentSpheres", 4],
    ["sourceSpheres", 4],
  ];
  for (const [name, width] of widths) {
    const array = table[name] as Float32Array;
    if (array.length !== clusters * width)
      throw new Error(
        `ClusteredMesh table.${name} holds ${array.length} values for ${clusters} clusters; it needs ${clusters * width}.`,
      );
  }
  if (table.groups !== undefined && table.groups.length !== clusters * 2)
    throw new Error(
      `ClusteredMesh table.groups holds ${table.groups.length} values for ${clusters} clusters; it needs ${clusters * 2}.`,
    );
  for (let cluster = 0; cluster < clusters; cluster += 1) {
    const start = table.ranges[cluster * 2] as number;
    const count = table.ranges[cluster * 2 + 1] as number;
    if (count === 0 || count % 3 !== 0 || start + count > table.indices.length)
      throw new Error(
        `ClusteredMesh cluster ${cluster} names indices ${start}..${start + count}, which the ${table.indices.length}-index buffer does not hold.`,
      );
  }
}

/** The glTF extension the asset pipeline writes the DAG into. */
export const TN_VIRTUAL_GEOMETRY = "TN_virtual_geometry";

interface IVirtualGeometryDef {
  readonly clusterBounds: number;
  readonly clusterCones: number;
  readonly clusterErrors: number;
  readonly clusterGroups: number;
  readonly clusterParentSpheres: number;
  readonly clusterRanges: number;
  readonly clusterSourceSpheres: number;
  readonly indices: number;
}

interface IGltfParserLike {
  readonly associations: Map<object, { meshes?: number; primitives?: number }>;
  getDependency(type: string, index: number): Promise<{ array: ArrayLike<number> }>;
  readonly json: {
    meshes?: { primitives?: { extensions?: Record<string, unknown> }[] }[];
  };
}

function typedFloat(array: ArrayLike<number>): Float32Array {
  return array instanceof Float32Array ? array : Float32Array.from(array);
}

function typedUint(array: ArrayLike<number>): Uint32Array {
  return array instanceof Uint32Array ? array : Uint32Array.from(array);
}

const TABLE_FIELDS: readonly (keyof IVirtualGeometryDef)[] = [
  "clusterBounds",
  "clusterCones",
  "clusterErrors",
  "clusterGroups",
  "clusterParentSpheres",
  "clusterRanges",
  "clusterSourceSpheres",
  "indices",
];

async function readTable(
  parser: IGltfParserLike,
  def: IVirtualGeometryDef,
): Promise<IClusterTable> {
  // Fails closed. A file written by an older bake is missing fields this one needs, and a missing
  // field would otherwise surface as an unreadable crash inside `GLTFLoader` rather than as a
  // sentence naming the asset that needs re-baking.
  const missing = TABLE_FIELDS.filter((field) => typeof def[field] !== "number");
  if (missing.length > 0)
    throw new Error(
      `TN_VIRTUAL_GEOMETRY_INCOMPLETE: the ${TN_VIRTUAL_GEOMETRY} payload is missing ${missing.join(", ")}; re-bake the model with the current asset pipeline.`,
    );
  const accessor = async (index: number): Promise<ArrayLike<number>> =>
    (await parser.getDependency("accessor", index)).array;
  const [bounds, cones, errors, groups, parentSpheres, ranges, sourceSpheres, indices] =
    await Promise.all([
      accessor(def.clusterBounds),
      accessor(def.clusterCones),
      accessor(def.clusterErrors),
      accessor(def.clusterGroups),
      accessor(def.clusterParentSpheres),
      accessor(def.clusterRanges),
      accessor(def.clusterSourceSpheres),
      accessor(def.indices),
    ]);
  return {
    bounds: typedFloat(bounds as Float32Array),
    cones: typedFloat(cones as Float32Array),
    errors: typedFloat(errors as Float32Array),
    groups: typedUint(groups as Uint32Array),
    indices: typedUint(indices as Uint32Array),
    parentSpheres: typedFloat(parentSpheres as Float32Array),
    ranges: typedUint(ranges as Uint32Array),
    sourceSpheres: typedFloat(sourceSpheres as Float32Array),
  };
}

/**
 * `GLTFLoader` plugin that returns a {@link ClusteredMesh} for any primitive carrying the bake.
 *
 * A game that never turned the pipeline pass on never meets this class; a game that did gets the
 * clustered mesh with no code change beyond calling {@link updateClusteredMeshes} once a frame.
 * There is no runtime switch, because a minutes-long bake cannot happen at run time and a second
 * way to say the same thing is a second thing to get wrong.
 */
export class VirtualGeometryPlugin {
  readonly name = TN_VIRTUAL_GEOMETRY;

  constructor(private readonly parser: IGltfParserLike) {}

  async afterRoot(result: { scene?: Mesh }): Promise<void> {
    void result;
    const swaps: { clustered: ClusteredMesh; plain: Mesh }[] = [];
    for (const [object, association] of this.parser.associations) {
      const plain = object as Mesh;
      // Files baked before the bake learned to skip skinned bodies still carry the extension.
      if (plain.isMesh !== true || (plain as { isSkinnedMesh?: boolean }).isSkinnedMesh === true)
        continue;
      const { meshes, primitives } = association;
      if (meshes === undefined || primitives === undefined) continue;
      const def = this.parser.json.meshes?.[meshes]?.primitives?.[primitives]?.extensions?.[
        TN_VIRTUAL_GEOMETRY
      ] as IVirtualGeometryDef | undefined;
      if (def === undefined) continue;
      const clustered = new ClusteredMesh(
        plain.geometry,
        plain.material,
        await readTable(this.parser, def),
      );
      clustered.name = plain.name;
      clustered.position.copy(plain.position);
      clustered.quaternion.copy(plain.quaternion);
      clustered.scale.copy(plain.scale);
      clustered.castShadow = plain.castShadow;
      clustered.receiveShadow = plain.receiveShadow;
      swaps.push({ clustered, plain });
    }
    for (const { clustered, plain } of swaps) {
      const parent = plain.parent;
      if (parent === null) continue;
      parent.add(clustered);
      parent.remove(plain);
      this.parser.associations.set(
        clustered,
        this.parser.associations.get(plain) ?? { meshes: undefined, primitives: undefined },
      );
    }
  }
}

/** What a batch root exposes to the walk. Structural, so this module does not import the batch. */
interface IClusteredBatchRootLike {
  readonly batch: { update(camera: Camera, viewportHeight: number): number };
}

function isBatchRoot(object: object): object is IClusteredBatchRootLike {
  const candidate = (object as Partial<IClusteredBatchRootLike>).batch;
  return typeof (candidate as { update?: unknown } | undefined)?.update === "function";
}

/** The event surface this module subscribes to. Structural, so traverse-only stand-ins keep working. */
interface IGraphNode {
  addEventListener(type: string, listener: (event: never) => void): void;
  removeEventListener(type: string, listener: (event: never) => void): void;
  traverse(callback: (object: object) => void): void;
}

interface IChildGraphEvent {
  readonly child?: unknown;
}

interface ITrackedRoot {
  /** Every clustered mesh and batch root currently under the root. */
  readonly items: Set<object>;
  /** Nodes already carrying this root's listeners. */
  readonly hooked: WeakSet<object>;
  readonly onAdded: (event: IChildGraphEvent) => void;
  readonly onRemoved: (event: IChildGraphEvent) => void;
}

/**
 * Per-root tracking, keyed weakly so a disposed scene drops out on its own: the map holds no
 * strong reference to any root, and a tracking holds none back to its root either.
 */
const trackedRoots = new WeakMap<object, ITrackedRoot>();

function isGraphNode(root: object): root is IGraphNode {
  const candidate = root as Partial<IGraphNode>;
  return (
    typeof candidate.traverse === "function" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

/** Subscribes a subtree that just arrived under a tracked root, collecting what it holds. */
function hookSubtree(tracking: ITrackedRoot, subtree: object): void {
  (subtree as IGraphNode).traverse((node) => {
    if (node instanceof ClusteredMesh || isBatchRoot(node)) tracking.items.add(node);
    if (tracking.hooked.has(node)) return;
    tracking.hooked.add(node);
    const link = node as Partial<IGraphNode>;
    // A traverse-only stand-in nested inside a real graph cannot carry listeners; it also cannot
    // be a clustered mesh or a batch root, both of which extend `Object3D`.
    if (typeof link.addEventListener !== "function") return;
    link.addEventListener("childadded", tracking.onAdded);
    (link as IGraphNode).addEventListener("childremoved", tracking.onRemoved);
  });
}

/** Forgets a subtree that just left a tracked root, detaching its listeners as it goes. */
function unhookSubtree(tracking: ITrackedRoot, subtree: object): void {
  (subtree as IGraphNode).traverse((node) => {
    tracking.items.delete(node);
    if (!tracking.hooked.has(node)) return;
    tracking.hooked.delete(node);
    const link = node as Partial<IGraphNode>;
    if (typeof link.removeEventListener !== "function") return;
    link.removeEventListener("childadded", tracking.onAdded);
    (link as IGraphNode).removeEventListener("childremoved", tracking.onRemoved);
  });
}

function trackRoot(root: IGraphNode): ITrackedRoot {
  const existing = trackedRoots.get(root);
  if (existing !== undefined) return existing;
  const tracking: ITrackedRoot = {
    hooked: new WeakSet(),
    items: new Set(),
    onAdded: (event) => {
      const child: unknown = event.child;
      if (typeof child === "object" && child !== null && isGraphNode(child))
        hookSubtree(tracking, child);
    },
    onRemoved: (event) => {
      const child: unknown = event.child;
      if (
        typeof child === "object" &&
        child !== null &&
        typeof (child as Partial<IGraphNode>).traverse === "function"
      )
        unhookSubtree(tracking, child);
    },
  };
  trackedRoots.set(root, tracking);
  // One census per root, ever: every later arrival and departure reports itself through the
  // `childadded` / `childremoved` events three fires on the direct parent, and `add` removes
  // from the old parent first, so a reparent is a removal followed by an arrival.
  hookSubtree(tracking, root);
  return tracking;
}

function trianglesOf(object: object, camera: Camera, viewportHeight: number): number {
  if (object instanceof ClusteredMesh) return object.update(camera, viewportHeight);
  if (isBatchRoot(object)) return object.batch.update(camera, viewportHeight);
  return 0;
}

/**
 * Takes every clustered mesh and every clustered batch under `root` through this frame's cut.
 *
 * The engine calls this itself, once a frame, before the render — virtual geometry ships on and a
 * game that has to remember to call something has not been given it. The first call censuses the
 * root once and subscribes to its graph events; later calls walk only the clustered meshes and
 * batch roots themselves, so a scene holding neither costs a map lookup.
 *
 * @returns triangles the clustered meshes and batches will submit.
 */
export function updateClusteredMeshes(
  root: { traverse(callback: (object: object) => void): void },
  camera: Camera,
  viewportHeight: number,
): number {
  // A bare traverse-only stand-in has no event surface to subscribe to, so it keeps the old
  // discovery walk. Everything three builds takes the tracked path.
  if (!isGraphNode(root)) {
    let triangles = 0;
    root.traverse((object) => {
      triangles += trianglesOf(object, camera, viewportHeight);
    });
    return triangles;
  }
  let triangles = 0;
  for (const item of trackRoot(root).items) triangles += trianglesOf(item, camera, viewportHeight);
  return triangles;
}
