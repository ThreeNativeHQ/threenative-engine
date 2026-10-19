import { BufferAttribute, BufferGeometry, type Camera, type Material, Mesh, Vector3 } from "three";

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
  /** Per cluster, `[centreX, centreY, centreZ, radius]`. Culling reads it; PRD-283 will. */
  readonly bounds: Float32Array;
  /** Per cluster, `[axisX, axisY, axisZ, cutoff]`. */
  readonly cones: Float32Array;
  /** Per cluster, `[ownError, parentError]`, in the mesh's own units. */
  readonly errors: Float32Array;
  /** Cluster-ordered triangles for every level, indexing the geometry's vertex buffer. */
  readonly indices: Uint32Array;
  /** Per cluster, the sphere `parentError` is projected through. */
  readonly parentSpheres: Float32Array;
  /** Per cluster, `[start, count]` into {@link IClusterTable.indices}. */
  readonly ranges: Uint32Array;
  /** Per cluster, the sphere its own error is projected through. */
  readonly sourceSpheres: Float32Array;
}

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
}

/** A cluster nearer than this to the camera is treated as this far away, rather than dividing by zero. */
const MIN_DISTANCE = 1e-4;

const DEFAULT_ERROR_PIXELS = 1;
const RECUT_FRACTION = 0.001;

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

/** Index slots the finest possible cut needs: every cluster whose own error is zero. */
function finestIndexCount(table: IClusterTable): number {
  let count = 0;
  for (let cluster = 0; cluster * 2 < table.ranges.length; cluster += 1)
    if ((table.errors[cluster * 2] as number) === 0)
      count += table.ranges[cluster * 2 + 1] as number;
  return count;
}

export class ClusteredMesh extends Mesh {
  /** The baked payload. The bake is the only thing that writes it; a copy takes the source's. */
  table!: IClusterTable;
  /** Screen-space error budget in pixels. Writable — it is the game's call. */
  errorPixels: number;
  /** Camera movement, in the mesh's own units, below which the previous cut is kept. */
  recutDistance: number;

  #cut!: Uint32Array;
  #selection!: Uint32Array;
  readonly #cameraLocal = new Vector3();
  readonly #lastCut = new Vector3();
  #drawnClusters = 0;
  #drawnIndices = 0;
  #hasCut = false;
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

    const moved = this.#cameraLocal.distanceTo(this.#lastCut);
    const settled =
      this.#hasCut &&
      moved <= this.recutDistance &&
      scale === this.#lastScale &&
      this.errorPixels === this.#lastErrorPixels;
    if (settled) return this.drawnTriangles;

    this.#lastCut.copy(this.#cameraLocal);
    this.#lastScale = scale;
    this.#lastErrorPixels = this.errorPixels;
    this.#hasCut = true;
    this.#compact(
      selectClusterCut(this.table, this.#cameraLocal, scale, this.errorPixels, this.#selection),
    );
    return this.drawnTriangles;
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
  let radius = 0;
  for (let cluster = 0; cluster * 4 < table.bounds.length; cluster += 1)
    radius = Math.max(radius, table.bounds[cluster * 4 + 3] as number);
  return radius;
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
  const [bounds, cones, errors, parentSpheres, ranges, sourceSpheres, indices] = await Promise.all([
    accessor(def.clusterBounds),
    accessor(def.clusterCones),
    accessor(def.clusterErrors),
    accessor(def.clusterParentSpheres),
    accessor(def.clusterRanges),
    accessor(def.clusterSourceSpheres),
    accessor(def.indices),
  ]);
  return {
    bounds: typedFloat(bounds as Float32Array),
    cones: typedFloat(cones as Float32Array),
    errors: typedFloat(errors as Float32Array),
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
