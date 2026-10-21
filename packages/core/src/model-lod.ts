import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  type Camera,
  Group,
  Matrix4,
  type Mesh,
  Object3D,
  Sphere,
  Vector3,
} from "three";
import { pixelsPerUnit } from "./clustered-mesh.js";

/**
 * Engine-owned detail selection for automatic discrete LOD (`TN_discrete_lod`).
 *
 * The asset pipeline bakes a chain of index-only levels into the `.glb`; this module decides which
 * one a camera may see, from the level's measured geometric error projected into pixels. It is the
 * one selection authority for a discrete chain: nothing here is appearance, and nothing here
 * touches a material — it swaps between geometries the pipeline already wrote.
 *
 * Projection is done from the camera's own matrices, so perspective and orthographic cameras, zoom,
 * the actual drawing-buffer height and a non-uniformly scaled parent all read correctly. The depth
 * used is a conservative nearest view-space depth of the object's bounding sphere, not the distance
 * to its origin, and a camera at or inside the near plane selects the finest level.
 */

/** A camera shape this selection needs: the projection terms `three` exposes structurally. */
interface ILodCameraLike extends Camera {
  readonly isOrthographicCamera?: boolean;
  readonly top?: number;
  readonly bottom?: number;
  readonly zoom?: number;
  readonly near?: number;
}

export interface ILodView {
  readonly camera: Camera;
  /** Drawing-buffer height in actual raster pixels; a CSS height is the wrong number. */
  readonly viewportHeight: number;
  /**
   * Conservative nearest view-space depth of the object's bounding sphere, in world units. A caller
   * that has not measured the bounds passes the distance to the origin, which is never closer and
   * therefore never over-refines.
   */
  readonly depth: number;
  /**
   * True when the camera is at or inside the object's near plane, where a projected error has no
   * meaning. The finest level is selected instead of dividing by ~zero.
   */
  readonly degenerate: boolean;
  /**
   * A view that must not drop below the finest level regardless of budget. Recorded as data so a
   * pass-local caller can prove it honoured the rule.
   */
  readonly finest?: boolean;
}

/**
 * Pixels a one-world-unit error at `depth` covers, for this camera and viewport.
 *
 * Perspective divides the projected scale by the depth; orthographic has no depth term and uses the
 * frustum height instead. A non-positive depth or an unprojectable camera throws rather than
 * returning a plausible-looking wrong scale.
 */
export function lodPixelScale(camera: Camera, viewportHeight: number, depth: number): number {
  const like: ILodCameraLike = camera;
  if (!(viewportHeight > 0))
    throw new Error(`AutoLOD needs a positive viewport height, got ${String(viewportHeight)}.`);
  const zoom = like.zoom ?? 1;
  if (like.isOrthographicCamera === true) {
    const height = (like.top ?? 1) - (like.bottom ?? -1);
    if (!(height > 0))
      throw new Error("AutoLOD needs an orthographic frustum with a positive height.");
    return (viewportHeight * zoom) / height;
  }
  if (!(depth > 0)) return Number.POSITIVE_INFINITY;
  return (pixelsPerUnit(camera, viewportHeight) * zoom) / depth;
}

/** The projected geometric error of `worldError` at `depth`, in pixels. */
export function projectedLodError(
  worldError: number,
  camera: Camera,
  viewportHeight: number,
  depth: number,
): number {
  if (worldError <= 0) return 0;
  return worldError * lodPixelScale(camera, viewportHeight, depth);
}

/**
 * The adaptive LOD bias both selection paths share: one multiplier on the camera distance, `>= 1`.
 *
 * `WorldCells`' control loop owns it (see its `adaptiveLod` option) and rewrites it once it has a
 * fresh main-pass GPU reading; `setLodBias` is the only writer. The CPU selection here reads it
 * through {@link biasedLodDistance}, and the GPU scene mirrors it as a uniform, so a placement at
 * one distance crosses the same switch wherever the level is decided. `1` is exactly as authored.
 */
// Unsplit package entries must share the control loop's bias, just like the chain registry.
const LOD_BIAS_KEY = Symbol.for("threenative.lodBias");
const lodBiasHost = globalThis as Record<symbol, unknown>;
const lodBiasState = (lodBiasHost[LOD_BIAS_KEY] as { value: number } | undefined) ?? { value: 1 };
lodBiasHost[LOD_BIAS_KEY] = lodBiasState;

/** The multiplier every LOD selection path scales camera distance by. */
export function lodBias(): number {
  return lodBiasState.value;
}

/**
 * Sets the adaptive LOD bias, clamped to `>= 1`. A bias below 1 would refine past what the chain
 * authored, so it is refused rather than applied; a non-finite value is no reading and resets to 1.
 */
export function setLodBias(bias: number): void {
  lodBiasState.value = Number.isFinite(bias) && bias >= 1 ? bias : 1;
}

/**
 * The camera distance an LOD switch is compared against: the measured distance times
 * {@link lodBias}. Scaling up crosses every authored switch earlier and never later, so a bias can
 * only coarsen selection, never refine it below the level the chain would show unaided.
 */
export function biasedLodDistance(distance: number): number {
  return distance * lodBiasState.value;
}

const nearest = new Vector3();

/**
 * The conservative nearest view-space depth of a world-space bounding sphere.
 *
 * The distance along the view axis to the sphere's centre minus its radius is the closest the
 * surface can be, which is what a screen-space error must divide by: an error near the camera must
 * not be projected as if it sat at the centre. A camera inside the sphere reports `degenerate`.
 */
export function conservativeViewDepth(
  camera: Camera,
  center: Vector3,
  radius: number,
  nearPlane: number,
): { readonly depth: number; readonly degenerate: boolean } {
  nearest.copy(center).applyMatrix4(camera.matrixWorldInverse);
  const depth = -nearest.z - Math.max(0, radius);
  return { depth, degenerate: depth <= nearPlane };
}

/** The world-space bounding sphere of a cached local sphere under a node's world matrix. */
export function worldSphere(
  local: Sphere,
  object: Object3D,
  out: Sphere = new Sphere().copy(local), // the engine's Sphere binds no clone
  matrix: Matrix4 = object.matrixWorld,
): Sphere {
  out.center.copy(local.center).applyMatrix4(matrix);
  const scale = matrix.getMaxScaleOnAxis();
  out.radius = local.radius * scale;
  return out;
}

/**
 * The coarsest level whose projected error fits the budget in every supplied view, then stabilized
 * against the current level.
 *
 * Refines immediately: a selected level over budget is replaced by the finest one that fits. Coarsens
 * only when the candidate is comfortably inside `(1 - hysteresis) * budget`, which stops a camera
 * breathing across a boundary from flipping levels. `levels[0]` is LOD0 and must carry error 0.
 */
export function selectLodLevel(
  absoluteErrors: readonly number[],
  current: number,
  budgetPixels: number,
  hysteresis: number,
  views: readonly ILodView[],
): number {
  if (absoluteErrors.length === 0) return 0;
  const last = absoluteErrors.length - 1;
  if (!(budgetPixels > 0) || views.length === 0) return 0;
  const clampedCurrent = Math.min(Math.max(Math.trunc(current), 0), last);

  let target = 0;
  outer: for (let index = last; index >= 1; index -= 1) {
    const error = absoluteErrors[index] as number;
    for (const view of views) {
      if (view.degenerate || view.finest === true) continue outer;
      if (projectedLodError(error, view.camera, view.viewportHeight, view.depth) > budgetPixels) {
        continue outer;
      }
    }
    target = index;
    break;
  }

  if (target <= clampedCurrent) return target;

  // Coarsening: reject it unless the candidate is under the hysteresis-adjusted budget in every view.
  const threshold = (1 - hysteresis) * budgetPixels;
  for (const view of views) {
    if (view.degenerate || view.finest === true) return clampedCurrent;
    const error = absoluteErrors[target] as number;
    if (projectedLodError(error, view.camera, view.viewportHeight, view.depth) >= threshold)
      return clampedCurrent;
  }
  return target;
}

/** The glTF extension the asset pipeline writes the discrete chain into. */
export const TN_DISCRETE_LOD = "TN_discrete_lod";

/** Bumped with the written layout; a reader refuses a version it does not understand. */
export const DISCRETE_LOD_SCHEMA_VERSION = 1;

/** Default screen-space error budget, in pixels, when no resolved policy reaches the loader. */
export const DISCRETE_LOD_DEFAULT_ERROR_PIXELS = 1;
/** Default coarsen hysteresis when no resolved policy reaches the loader. */
export const DISCRETE_LOD_DEFAULT_HYSTERESIS = 0.15;

interface IDiscreteLodDef {
  readonly absoluteErrors?: unknown;
  readonly counts?: unknown;
  readonly errors?: unknown;
  readonly indices?: unknown;
  readonly lod0Triangles?: unknown;
  readonly schemaVersion?: unknown;
}

interface IParserLike {
  readonly associations: Map<object, { meshes?: number; nodes?: number; primitives?: number }>;
  getDependency(type: string, index: number): Promise<unknown>;
  readonly json: {
    animations?: { channels?: { target?: { node?: number } }[] }[];
    extensions?: Record<string, unknown>;
    meshes?: { name?: string; primitives?: { extensions?: Record<string, unknown> }[] }[];
  };
}

interface IPendingLevels {
  readonly absoluteErrors: number[];
  readonly indices: Uint32Array[];
  readonly lod0Triangles: number;
}

function numberArray(value: unknown, label: string): number[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "number"))
    throw new Error(`${label} must be an array of numbers.`);
  return value as number[];
}

/**
 * Reads and validates one primitive's chain. Fails closed: an unreadable payload is a defect in the
 * file, and the caller keeps LOD0 and reports it rather than drawing a mangled mesh.
 */
async function readPendingLevels(
  parser: IParserLike,
  def: IDiscreteLodDef,
): Promise<IPendingLevels> {
  if (def.schemaVersion !== DISCRETE_LOD_SCHEMA_VERSION)
    throw new Error(
      `schema version ${String(def.schemaVersion)} is not ${String(DISCRETE_LOD_SCHEMA_VERSION)}.`,
    );
  const indices = numberArray(def.indices, "indices");
  const counts = numberArray(def.counts, "counts");
  const errors = numberArray(def.errors, "errors");
  const absoluteErrors = numberArray(def.absoluteErrors, "absoluteErrors");
  if (
    indices.length !== counts.length ||
    counts.length !== errors.length ||
    counts.length !== absoluteErrors.length
  )
    throw new Error("the level arrays are not parallel.");
  if (typeof def.lod0Triangles !== "number" || !(def.lod0Triangles > 0))
    throw new Error("lod0Triangles must be a positive number.");
  const resolved: Uint32Array[] = [];
  for (const index of indices) {
    const accessor = (await parser.getDependency("accessor", index)) as {
      array: ArrayLike<number>;
    };
    const array = accessor.array;
    resolved.push(array instanceof Uint32Array ? array : Uint32Array.from(array));
  }
  let previous = def.lod0Triangles;
  let previousError = -1;
  for (let level = 0; level < resolved.length; level += 1) {
    const triangles = Math.floor((resolved[level] as Uint32Array).length / 3);
    const error = errors[level] as number;
    if (triangles <= 0 || triangles >= previous)
      throw new Error(`level ${String(level)} is not a reduction.`);
    if (!Number.isFinite(error) || error < previousError)
      throw new Error(`level ${String(level)} has non-monotonic error.`);
    previous = triangles;
    previousError = error;
  }
  return { absoluteErrors, indices: resolved, lod0Triangles: def.lod0Triangles };
}

/**
 * One baked chain: LOD0 is the mesh's own geometry, then one derived geometry per level sharing the
 * same vertex attributes and differing only in index.
 *
 * A chain belongs to the geometry, not to the mesh, because `Object3D.clone()` — which is how a game
 * reuses an imported model, and what `SkeletonUtils.clone` does for a rig — copies the mesh but
 * *shares* its geometry. Keying selection to mesh identity would silently drop every clone to LOD0
 * forever; recovering the chain from the geometry the clone carries is what makes a clone behave
 * like the source.
 */
export interface ILodChain {
  readonly levels: BufferGeometry[];
  readonly errors: readonly number[];
  readonly base: BufferGeometry;
  /** Local-space bounds of the base, shared by every mesh over the chain; the mesh matrix is not. */
  readonly sphere: Sphere;
}

/** Triangles one level of a chain submits. */
function drawTriangles(geometry: BufferGeometry): number {
  const drawn = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  return Math.floor(drawn / 3);
}

/**
 * One mesh's selection state. Every clone shares the source's chain, so this — and only this — holds
 * the level a particular copy currently shows: two copies at different distances must not fight.
 */
class ModelLod {
  readonly #mesh: Mesh;
  readonly #chain: ILodChain;
  readonly #policy: IAppliedLod;
  readonly #rung: JoinedRung | undefined;
  /** Only the authority drives selection and activation; every other member merely reports hidden. */
  readonly #authority: boolean;
  #current = 0;
  /** The join container, resolved once from the rung and the instance graph. */
  #container: Object3D | null = null;
  #containerResolved = false;

  constructor(
    mesh: Mesh,
    chain: ILodChain,
    policy: IAppliedLod,
    rung?: JoinedRung,
    authority = false,
  ) {
    this.#mesh = mesh;
    this.#chain = chain;
    this.#policy = policy;
    this.#rung = rung;
    this.#authority = authority;
  }

  get index(): number {
    return this.#current;
  }

  /** The full-detail geometry the chain was built against. */
  get base(): BufferGeometry {
    return this.#chain.base;
  }

  get triangles(): number {
    // With a joined rung active, the authored primitives draw nothing and the proxy draws the
    // collapse: the authority reports the rung's triangles, every hidden sibling reports zero.
    const rung = this.#rung;
    if (rung?.isHidden(this.#mesh)) return this.#authority ? rung.triangles : 0;
    return drawTriangles(this.#chain.levels[this.#current] as BufferGeometry);
  }

  update(camera: Camera, viewportHeight: number): void {
    const rung = this.#rung;
    if (rung !== undefined && this.#authority) {
      this.#updateJoined(rung, camera, viewportHeight);
      return;
    }
    const world = worldSphere(this.#chain.sphere, this.#mesh, undefined, this.#mesh.matrixWorld);
    const { depth, degenerate } = conservativeViewDepth(
      camera,
      world.center,
      world.radius,
      (camera as ILodCameraLike).near ?? 0,
    );
    const view: ILodView = {
      camera,
      degenerate,
      depth: biasedLodDistance(depth),
      viewportHeight,
    };
    const index = selectLodLevel(
      this.#chain.errors,
      this.#current,
      this.#policy.maxPixelError /
        Math.max(this.#mesh.matrixWorld.getMaxScaleOnAxis(), Number.EPSILON),
      this.#policy.hysteresis,
      [view],
    );
    if (index === this.#current) return;
    this.#current = index;
    this.#mesh.geometry = this.#chain.levels[index] as BufferGeometry;
  }

  /**
   * The join selection. The rung replaces every member, so its bounds set the depth and the
   * instance's container supplies the world transform the rung geometry was baked against.
   */
  #updateJoined(rung: JoinedRung, camera: Camera, viewportHeight: number): void {
    if (!this.#containerResolved) {
      this.#container = rung.findContainer(this.#mesh);
      this.#containerResolved = true;
    }
    const container = this.#container;
    if (container === null) return;
    const world = worldSphere(rung.sphere, container, undefined, container.matrixWorld);
    const { depth, degenerate } = conservativeViewDepth(
      camera,
      world.center,
      world.radius,
      (camera as ILodCameraLike).near ?? 0,
    );
    const errors = [...this.#chain.errors, rung.error];
    const joinedIndex = this.#chain.errors.length;
    const view: ILodView = {
      camera,
      degenerate,
      depth: biasedLodDistance(depth),
      viewportHeight,
    };
    const index = selectLodLevel(
      errors,
      this.#current,
      this.#policy.maxPixelError /
        Math.max(container.matrixWorld.getMaxScaleOnAxis(), Number.EPSILON),
      this.#policy.hysteresis,
      [view],
    );
    if (index === joinedIndex) {
      if (rung.activate(container)) {
        this.#current = index;
        return;
      }
      // The rung was refused at runtime (a member moved since load, or the graph no longer carries
      // every member): show the authored geometry rather than a proxy over stale transforms.
      this.#current = 0;
      this.#mesh.geometry = this.#chain.levels[0] as BufferGeometry;
      return;
    }
    rung.deactivate(container);
    if (index !== this.#current) {
      this.#current = index;
      this.#mesh.geometry = this.#chain.levels[index] as BufferGeometry;
    }
  }

  /** Reverses an active joined rung when the mesh is removed from the graph. */
  release(): void {
    if (this.#rung !== undefined && this.#authority && this.#container !== null)
      this.#rung.deactivate(this.#container);
  }
}

/** Resolved runtime policy the loader stamps onto a controller, from the manifest. */
export interface IModelLodPolicy {
  readonly hysteresis: number;
  readonly maxPixelError: number;
}

interface IAppliedLod {
  readonly hysteresis: number;
  readonly maxPixelError: number;
}

/**
 * The joined far rung as the artifact records it (`TN_discrete_lod.joined`, PRD-377 §4.4).
 *
 * `error` is the absolute local-space error of the merged, reduced far geometry: the coarsest step
 * the one selection authority may pick, after every discrete level. `mesh` names the detached far
 * mesh, `sources` are the authored `"mesh#primitive"` primitives it collapsed, and `draws` is the
 * one-per-material count it draws as.
 */
interface IJoinedRungDef {
  readonly draws: number;
  readonly error: number;
  readonly mesh: string;
  readonly primitives: number;
  readonly sources: readonly string[];
  readonly triangles: number;
}

/**
 * Proxy objects this module inserts to represent a joined rung. They carry the joined geometry but
 * no authored node identity, so picking must not answer with them: `isLodJoinProxy` is how the
 * framework picker keeps returning the authored primitives whether or not the camera joined them.
 */
// The root and /world entry points bundle this module separately, just like CHAINS_KEY below.
// Visibility handoffs must reach the rung selected by the other entry in the same realm.
const JOIN_STATE_KEY = Symbol.for("threenative.discreteLodJoinState");
const joinHost = globalThis as Record<symbol, unknown>;
const joinState = (joinHost[JOIN_STATE_KEY] ?? {
  proxies: new WeakSet<object>(),
  owners: new WeakMap<Mesh, Object3D>(),
}) as { proxies: WeakSet<object>; owners: WeakMap<Mesh, Object3D> };
joinHost[JOIN_STATE_KEY] = joinState;
const joinedProxies = joinState.proxies;
const joinedOwners = joinState.owners;

/** Internal layer ownership handoff: a joined rung represents the same source render passes. */
export function setModelLodLayers(mesh: Mesh, mask: number): void {
  mesh.layers.mask = mask;
  joinedOwners.get(mesh)?.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh === true) node.layers.mask = mask;
  });
}

/** True when `object` was inserted by the runtime as a joined-rung proxy, not authored in the file. */
export function isLodJoinProxy(object: object): boolean {
  return joinedProxies.has(object);
}

/** A primitive a joined rung can never represent: the bake refuses these, and the runtime re-checks. */
function isDeforming(mesh: Mesh): boolean {
  return (
    (mesh as Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh === true ||
    Object.keys(mesh.geometry.morphAttributes).length > 0
  );
}

/**
 * True when the mesh, or any ancestor strictly below `container`, is animation-targeted.
 *
 * The container itself is allowed to move: a rung baked in container space rides rigidly with it, so
 * animating the model root does not invalidate the join. Only a member that moves independently —
 * directly, or through an ancestor between it and the container — does.
 */
function isAnimatedInContainer(
  mesh: Mesh,
  container: Object3D,
  animated: WeakSet<object>,
): boolean {
  let current: Object3D | null = mesh;
  while (current !== null && current !== container) {
    if (animated.has(current)) return true;
    current = current.parent;
  }
  return false;
}

/** The composed local transform of `node` relative to `container`, without touching world matrices. */
function relativeLocalMatrix(node: Object3D, container: Object3D): Matrix4 {
  const matrix = new Matrix4();
  let current: Object3D | null = node;
  while (current !== null && current !== container) {
    current.updateMatrix();
    matrix.premultiply(current.matrix);
    current = current.parent;
  }
  return matrix;
}

/** True when `node` is `ancestor` or sits below it. */
function isWithin(node: Object3D, ancestor: Object3D): boolean {
  let current: Object3D | null = node;
  while (current !== null) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

/** The nearest common ancestor of every member, or `null` when they share no graph. */
function lowestCommonAncestor(members: readonly Object3D[]): Object3D | null {
  if (members.length === 0) return null;
  let ancestor: Object3D | null = (members[0] as Object3D).parent;
  while (ancestor !== null) {
    if (members.every((member) => isWithin(member, ancestor as Object3D))) return ancestor;
    ancestor = ancestor.parent;
  }
  return null;
}

/** Narrows the artifact's joined-rung record, failing closed on a malformed one. */
function isJoinedRungDef(value: unknown): value is IJoinedRungDef {
  if (typeof value !== "object" || value === null) return false;
  const def = value as Partial<IJoinedRungDef>;
  return (
    typeof def.draws === "number" &&
    Number.isFinite(def.draws) &&
    typeof def.error === "number" &&
    Number.isFinite(def.error) &&
    typeof def.mesh === "string" &&
    typeof def.primitives === "number" &&
    typeof def.triangles === "number" &&
    Array.isArray(def.sources) &&
    def.sources.every((source) => typeof source === "string")
  );
}

interface IJoinActivation {
  readonly proxy: Object3D;
  readonly restored: readonly { readonly mesh: Mesh; readonly visible: boolean }[];
}

/**
 * One mesh's joined far rung: many authored primitives collapsed to one object, one draw per
 * material — whether those primitives were within one mesh or across sibling meshes under a shared
 * container.
 *
 * Selecting it is a draw-topology change, not a geometry pointer swap. The authored primitives stay
 * in the graph — same identities, transforms, render order and picking — and are hidden while one
 * proxy object is added under their shared container as a unit. Reverting removes the proxy and
 * restores each primitive's authored visibility exactly. Per-container state lives here, so two
 * instances of the same model at different distances never fight and a `clone()` gets its own.
 */
class JoinedRung {
  readonly name: string;
  readonly draws: number;
  readonly primitives: number;
  readonly triangles: number;
  readonly error: number;
  readonly sphere: Sphere;
  readonly #prototype: Object3D;
  readonly #geometries: Set<BufferGeometry>;
  readonly #memberCount: number;
  readonly #activations = new WeakMap<Object3D, IJoinActivation>();
  /** The authored local transform of every source member, for the runtime-moved-sibling guard. */
  readonly #baselines = new WeakMap<object, Matrix4>();
  /** Members currently hidden by an activation, so a sibling knows it submits no draw this frame. */
  readonly #hidden = new WeakSet<object>();

  constructor(options: {
    readonly def: IJoinedRungDef;
    readonly geometries: ReadonlySet<BufferGeometry>;
    readonly memberCount: number;
    readonly prototype: Object3D;
    readonly sphere: Sphere;
  }) {
    this.name = options.def.mesh;
    this.draws = options.def.draws;
    this.primitives = options.def.primitives;
    this.triangles = options.def.triangles;
    this.error = options.def.error;
    this.#prototype = options.prototype;
    this.#geometries = new Set(options.geometries);
    this.#memberCount = options.memberCount;
    this.sphere = options.sphere;
  }

  /** True when a mesh is one of the members hidden by an active activation of this rung. */
  isHidden(mesh: Mesh): boolean {
    return this.#hidden.has(mesh);
  }

  /**
   * The nearest ancestor whose subtree contains every member of this rung — the container the rung
   * was baked against. Geometry identity, not node identity, so a clone resolves its own container.
   */
  findContainer(mesh: Mesh): Object3D | null {
    let ancestor: Object3D | null = mesh.parent;
    while (ancestor !== null) {
      let found = 0;
      ancestor.traverse((node) => {
        const candidate = node as Partial<Mesh>;
        if (
          candidate.isMesh === true &&
          candidate.geometry !== undefined &&
          this.#geometries.has(candidate.geometry)
        )
          found += 1;
      });
      if (found >= this.#memberCount) return ancestor;
      ancestor = ancestor.parent;
    }
    return null;
  }

  /** Snapshots each source member's authored local transform at load, before any game script runs. */
  captureBaselines(container: Object3D, members: readonly Mesh[]): void {
    for (const member of members)
      this.#baselines.set(member, relativeLocalMatrix(member, container));
  }

  activate(container: Object3D): boolean {
    const members: Mesh[] = [];
    container.traverse((node) => {
      const mesh = node as Mesh;
      if (mesh.isMesh === true && this.#geometries.has(mesh.geometry)) members.push(mesh);
    });
    if (members.length < this.#memberCount) return false;
    const first = members[0];
    if (first === undefined) return false;
    // A joined draw cannot represent different per-member render-pass ownership.
    if (
      members.some(
        (member) =>
          member.layers.mask !== first.layers.mask ||
          member.castShadow !== first.castShadow ||
          member.receiveShadow !== first.receiveShadow,
      )
    ) {
      this.deactivate(container);
      return false;
    }
    // The honest risk of joining siblings: their relative transforms are baked into the rung, so a
    // node a script moves independently must be refused. A source member with a baseline that no
    // longer matches its authored local transform is exactly that. (A clone is baselined on its
    // first activation, so movement before that first selection is the one case this cannot see.)
    for (const member of members) {
      const current = relativeLocalMatrix(member, container);
      const baseline = this.#baselines.get(member);
      if (baseline === undefined) this.#baselines.set(member, current);
      else if (!baseline.equals(current)) {
        console.error(
          `TN_DISCRETE_LOD_JOIN_INVALID: '${this.name}' cannot be shown as one unit; a source node moved after load.`,
        );
        if (this.#activations.has(container)) this.deactivate(container);
        return false;
      }
    }
    if (this.#activations.has(container)) return true;
    const proxy = this.#prototype.clone(true);
    proxy.name = `${this.name}__instance`;
    proxy.visible = true;
    proxy.traverse((node) => {
      joinedProxies.add(node);
      // A stock `Raycaster` ignores `visible`; a no-op raycast keeps the authored primitives the
      // only picking surface even for a game that runs `intersectObjects` on the scene directly.
      if ((node as Partial<Mesh>).isMesh === true) {
        node.raycast = () => undefined;
        node.layers.mask = first.layers.mask;
        node.castShadow = first.castShadow;
        node.receiveShadow = first.receiveShadow;
      }
    });
    const restored: { mesh: Mesh; visible: boolean }[] = [];
    for (const member of members) restored.push({ mesh: member, visible: member.visible });
    for (const { mesh } of restored) {
      mesh.visible = false;
      this.#hidden.add(mesh);
      joinedOwners.set(mesh, proxy);
    }
    container.add(proxy);
    this.#activations.set(container, { proxy, restored });
    // The LOD path's diagnostic: the selection fact and the draw collapse it bought, once per join.
    console.info(
      `TN_DISCRETE_LOD_JOINED ${this.name}: ${String(this.primitives)} primitive(s) collapsed to ${String(this.draws)} draw(s)`,
    );
    return true;
  }

  deactivate(container: Object3D): boolean {
    const activation = this.#activations.get(container);
    if (activation === undefined) return false;
    for (const { mesh, visible } of activation.restored) {
      mesh.visible = visible;
      this.#hidden.delete(mesh);
      joinedOwners.delete(mesh);
    }
    activation.proxy.removeFromParent();
    this.#activations.delete(container);
    return true;
  }
}

/** A chain and its policy, registered against every level geometry so a clone can find it. */
interface IRegisteredChain {
  readonly chain: ILodChain;
  readonly policy: IAppliedLod;
  /** Present on every member of a joined rung, so a clone resolves to the same rung. */
  readonly joined?: JoinedRung;
  /** True on the one member that drives selection and activation for the rung. */
  readonly authority?: boolean;
}

/**
 * Every chain currently registered, keyed weakly by each of its level geometries.
 *
 * Keyed by geometry, never by mesh, so a `clone()` — a new mesh over the shared geometry — resolves
 * to the source's chain instead of vanishing. Weak on the key, so a chain whose last live geometry
 * is dropped leaves with it: the value holds its own level geometries, and an ephemeron keeps that
 * self-reference from pinning them.
 *
 * One map per realm, not per module copy: the package builds each entry without code splitting,
 * so `@threenative/core` (whose asset loader registers) and `@threenative/core/world` (whose
 * `WorldCells` reads) each carry this module. A module-local map left WorldCells finding no chain.
 */
const CHAINS_KEY = Symbol.for("threenative.discreteLodChains");
const chainsHost = globalThis as Record<symbol, unknown>;
const carriedChains = chainsHost[CHAINS_KEY] as
  | WeakMap<BufferGeometry, IRegisteredChain>
  | undefined;
const chains: WeakMap<BufferGeometry, IRegisteredChain> = carriedChains ?? new WeakMap();
chainsHost[CHAINS_KEY] = chains;

/**
 * Geometry preparation commonly clones and bakes a model transform before instancing. Keep the
 * existing index-only ladder over those copied attributes; never simplify the shape a second time.
 * Hooks belong only to chain geometries, never to Three's prototype. Error scales conservatively
 * by the matrix's largest axis, including non-uniform transforms.
 */
const cloneHooks = new WeakSet<BufferGeometry>();
function preserveChainClones(registered: IRegisteredChain): void {
  for (const source of registered.chain.levels) {
    if (cloneHooks.has(source)) continue;
    cloneHooks.add(source);
    const clone = source.clone.bind(source);
    source.clone = (): BufferGeometry => {
      const copy = clone();
      const current = chains.get(source) ?? registered;
      const chain = current.chain;
      const sourceIndex = chain.levels.indexOf(source);
      const levels = chain.levels.map((level, index) => {
        const geometry = index === sourceIndex ? copy : new BufferGeometry();
        if (geometry !== copy) {
          for (const [name, attribute] of Object.entries(copy.attributes))
            geometry.setAttribute(name, attribute);
          geometry.setIndex(level.index?.clone() ?? null);
          geometry.boundingSphere = copy.boundingSphere;
          geometry.boundingBox = copy.boundingBox;
        }
        return geometry;
      });
      const copied: IRegisteredChain = {
        chain: {
          base: levels[0] as BufferGeometry,
          errors: [...chain.errors],
          levels,
          sphere: chain.sphere.clone(),
        },
        policy: current.policy,
      };
      for (const geometry of levels) chains.set(geometry, copied);
      preserveChainClones(copied);
      const apply = copy.applyMatrix4.bind(copy);
      copy.applyMatrix4 = (matrix: Matrix4): BufferGeometry => {
        apply(matrix);
        const errors = copied.chain.errors as number[];
        const scale = matrix.getMaxScaleOnAxis();
        for (let index = 1; index < errors.length; index += 1)
          errors[index] = (errors[index] as number) * scale;
        copied.chain.sphere.applyMatrix4(matrix);
        return copy;
      };
      return copy;
    };
  }
}

/** Internal frame-tracker contract also used by InstancedBatch's partitioned draws. */
export interface IModelLodController {
  readonly base: BufferGeometry;
  readonly triangles: number;
  update(camera: Camera, viewportHeight: number): void;
  release(): void;
}

const controllers = new WeakMap<Mesh, IModelLodController>();

/** Register selection with the existing frame tracker rather than a second scene walk. */
export function registerModelLodController(mesh: Mesh, controller: IModelLodController): void {
  controllers.get(mesh)?.release();
  controllers.set(mesh, controller);
}

/** True when `object` is a mesh whose geometry carries a registered chain (a clone, or the source). */
function isChained(object: object): boolean {
  const mesh = object as Partial<Mesh>;
  const geometry = mesh.geometry;
  return mesh.isMesh === true && geometry !== undefined && chains.has(geometry);
}

/**
 * The mesh's selection state, or `undefined` when its geometry carries no chain.
 *
 * A clone the loader never saw is adopted here, on its first frame, from the geometry it shares with
 * the source; every later frame finds the entry already made. The entry lives in a `WeakMap`, so a
 * dropped clone is not retained, and adopts at most once, so a clone cannot double-register.
 */
function controllerFor(mesh: Mesh): IModelLodController | undefined {
  const existing = controllers.get(mesh);
  if (existing !== undefined) return existing;
  // A plain instanced draw cannot use the one-object selector. Its batch owns partitioning.
  if ((mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh === true) return undefined;
  const registered = chains.get(mesh.geometry);
  if (registered === undefined) return undefined;
  const controller = new ModelLod(
    mesh,
    registered.chain,
    registered.policy,
    registered.joined,
    registered.authority === true,
  );
  controllers.set(mesh, controller);
  return controller;
}

/**
 * `GLTFLoader` plugin that reads `TN_discrete_lod` and, once the base geometry is final, builds the
 * derived index-only geometries and registers one controller per primitive.
 *
 * Reading and building are separate on purpose: `widenQuantizedPositions` runs after the loader
 * returns and replaces the base position attribute, so derived geometries must be built *after* it
 * to share the widened attributes rather than pin the quantized ones.
 */
export class DiscreteLodPlugin {
  readonly name = TN_DISCRETE_LOD;
  readonly #failClosed: boolean;
  #parser: IParserLike | undefined;
  readonly #pending = new Map<Mesh, IPendingLevels>();
  readonly #rungs: { readonly def: IJoinedRungDef; readonly prototype: Object3D }[] = [];
  /** A temporary holder for far-mesh prototypes, so widening reaches their joined geometry. */
  #holder: Group | undefined;

  /**
   * `failClosed` rejects the load with the same named error the log line carries, for a loader that
   * has no other way to tell a game its chain was dropped (the Wasm engine's, PRD-617).
   */
  constructor(options: { readonly failClosed?: boolean } = {}) {
    this.#failClosed = options.failClosed === true;
  }

  setParser(parser: IParserLike): void {
    this.#parser = parser;
  }

  #invalid(message: string): void {
    if (this.#failClosed) throw new Error(message);
    console.error(message);
  }

  async afterRoot(result: { scene?: Object3D }): Promise<void> {
    const parser = this.#parser;
    if (parser === undefined) return;
    for (const [object, association] of parser.associations) {
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) continue;
      const { meshes, primitives } = association;
      if (meshes === undefined || primitives === undefined) continue;
      const def = parser.json.meshes?.[meshes]?.primitives?.[primitives]?.extensions?.[
        TN_DISCRETE_LOD
      ] as IDiscreteLodDef | undefined;
      if (def === undefined) continue;
      try {
        this.#pending.set(mesh, await readPendingLevels(parser, def));
      } catch (error) {
        // LOD0 is intact and is what a game must still get; the file is the defect, not the game.
        this.#invalid(
          `TN_DISCRETE_LOD_INVALID: '${mesh.name || "unnamed"}' keeps full detail: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const metadata = parser.json.extensions?.[TN_DISCRETE_LOD] as { joined?: unknown } | undefined;
    const joined = metadata?.joined;
    if (!Array.isArray(joined) || joined.length === 0) return;
    for (const value of joined) {
      if (!isJoinedRungDef(value)) {
        this.#invalid(
          "TN_DISCRETE_LOD_JOIN_INVALID: a joined rung record is malformed; its primitives keep full detail.",
        );
        continue;
      }
      const farIndex = (parser.json.meshes ?? []).findIndex((mesh) => mesh.name === value.mesh);
      if (farIndex < 0) {
        this.#invalid(
          `TN_DISCRETE_LOD_JOIN_INVALID: '${value.mesh}' is not one of the file's meshes; its primitives keep full detail.`,
        );
        continue;
      }
      try {
        const prototype = (await parser.getDependency("mesh", farIndex)) as unknown;
        if (!(prototype instanceof Object3D))
          throw new Error("the far mesh dependency is not an Object3D.");
        // Held under the loaded root until `attach` removes the holder, so `widenQuantizedPositions`
        // reaches the joined geometry exactly as it reaches the authored primitives.
        if (result.scene !== undefined) {
          if (this.#holder === undefined) {
            this.#holder = new Group();
            this.#holder.name = "TN_LOD_JOIN_HOLDER";
            result.scene.add(this.#holder);
          }
          this.#holder.add(prototype);
        }
        this.#rungs.push({ def: value, prototype });
      } catch (error) {
        console.error(
          `TN_DISCRETE_LOD_JOIN_INVALID: '${value.mesh}' could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.#rungs.length === 0 && this.#holder !== undefined) {
      this.#holder.removeFromParent();
      this.#holder = undefined;
    }
  }

  /** Builds the derived geometries against the mesh's final (widened) attributes and registers. */
  attach(_root: Object3D, policy: IModelLodPolicy | undefined): number {
    const applied: IAppliedLod = {
      hysteresis: policy?.hysteresis ?? DISCRETE_LOD_DEFAULT_HYSTERESIS,
      maxPixelError: policy?.maxPixelError ?? DISCRETE_LOD_DEFAULT_ERROR_PIXELS,
    };
    // Detach the prototypes before anything else: they are loaded far meshes, never scene content.
    for (const { prototype } of this.#rungs) prototype.removeFromParent();
    if (this.#holder !== undefined) {
      this.#holder.removeFromParent();
      this.#holder = undefined;
    }
    let appliedCount = 0;
    for (const [mesh, pending] of this.#pending) {
      const base = mesh.geometry;
      const baseTriangles = base.index?.count ?? base.getAttribute("position")?.count ?? 0;
      if (Math.floor(baseTriangles / 3) !== pending.lod0Triangles) {
        // The file's LOD0 no longer matches the payload that was baked against it; keep full detail.
        this.#invalid(
          `TN_DISCRETE_LOD_INVALID: '${mesh.name || "unnamed"}' keeps full detail: LOD0 triangles do not match the baked chain.`,
        );
        continue;
      }
      const levels: BufferGeometry[] = [base];
      // Same vertex positions, so the same bounds; computed here and shared, not cloned, so a chain
      // holds one bounds object and a game that pads the base's bounds after load — a
      // vertex-displacement material's, say — reaches every level instead of leaving a coarser one
      // culled against the bounds that were true at bake time.
      base.computeBoundingSphere();
      base.computeBoundingBox();
      for (const indices of pending.indices) {
        const geometry = new BufferGeometry();
        for (const [name, attribute] of Object.entries(base.attributes)) {
          geometry.setAttribute(name, attribute);
        }
        geometry.setIndex(new BufferAttribute(indices, 1));
        if (base.boundingSphere !== null && base.boundingSphere !== undefined)
          geometry.boundingSphere = base.boundingSphere;
        if (base.boundingBox !== null && base.boundingBox !== undefined)
          geometry.boundingBox = base.boundingBox;
        levels.push(geometry);
      }
      const sphere = new Sphere();
      if (base.boundingSphere !== null && base.boundingSphere !== undefined)
        sphere.copy(base.boundingSphere);
      const registered: IRegisteredChain = {
        chain: { base, errors: [0, ...pending.absoluteErrors], levels, sphere },
        policy: applied,
      };
      // Every level, not just the base: a clone made after a selection already swapped the source to
      // a coarser level carries that derived geometry, and must still resolve to this chain.
      for (const geometry of levels) chains.set(geometry, registered);
      preserveChainClones(registered);
      controllers.set(mesh, new ModelLod(mesh, registered.chain, applied));
      appliedCount += 1;
    }
    this.#registerJoinedRungs(applied);
    return appliedCount;
  }

  /**
   * Resolves each loaded joined rung to its authored primitives and registers it on every member's
   * chain, marking one as the authority. A clone shares those geometries, so it adopts the same rung
   * with its own authority; the rung's per-container state keeps two instances independent.
   *
   * Refusal is the honest default: a rung whose sources are not all present, share no container, or
   * are skinned, morphed or animated is dropped rather than half-joined. The bake already made that
   * call; the runtime re-checks because the loaded graph, not the bake, is what it hides.
   */
  #registerJoinedRungs(applied: IAppliedLod): void {
    const parser = this.#parser;
    if (parser === undefined || this.#rungs.length === 0) return;
    const byKey = new Map<string, Mesh>();
    const animated = new WeakSet<object>();
    const targeted = new Set<number>();
    for (const animation of parser.json.animations ?? []) {
      for (const channel of animation.channels ?? []) {
        if (typeof channel.target?.node === "number") targeted.add(channel.target.node);
      }
    }
    for (const [object, association] of parser.associations) {
      if (targeted.size > 0 && association.nodes !== undefined && targeted.has(association.nodes))
        animated.add(object);
      const mesh = object as Mesh;
      if (mesh.isMesh !== true) continue;
      const { meshes, primitives } = association;
      if (meshes === undefined || primitives === undefined) continue;
      const name = parser.json.meshes?.[meshes]?.name ?? "";
      byKey.set(`${name}#${String(primitives)}`, mesh);
    }

    for (const { def, prototype } of this.#rungs) {
      const members: Mesh[] = [];
      let missing = false;
      for (const source of def.sources) {
        const mesh = byKey.get(source);
        if (mesh === undefined) {
          missing = true;
          break;
        }
        members.push(mesh);
      }
      const container = lowestCommonAncestor(members);
      const refused =
        missing ||
        members.length < 2 ||
        container === null ||
        members.some(
          (member) => isDeforming(member) || isAnimatedInContainer(member, container, animated),
        );
      if (refused) {
        console.error(
          `TN_DISCRETE_LOD_JOIN_INVALID: '${def.mesh}' cannot be shown as one unit at runtime; its primitives keep full detail.`,
        );
        continue;
      }
      // Every member needs a chain so the frame tracker manages it, even one the discrete pass
      // skipped: a join-only cook (maxLevels 1) writes no per-primitive chain at all.
      const geometries = new Set<BufferGeometry>();
      for (const member of members) {
        let registered = chains.get(member.geometry);
        if (registered === undefined) {
          member.geometry.computeBoundingSphere();
          const sphere = new Sphere();
          if (
            member.geometry.boundingSphere !== null &&
            member.geometry.boundingSphere !== undefined
          )
            sphere.copy(member.geometry.boundingSphere);
          registered = {
            chain: { base: member.geometry, errors: [0], levels: [member.geometry], sphere },
            policy: applied,
          };
          chains.set(member.geometry, registered);
        }
        for (const geometry of registered.chain.levels) geometries.add(geometry);
      }
      const box = new Box3().setFromObject(prototype);
      const sphere = new Sphere();
      box.getBoundingSphere(sphere);
      const rung = new JoinedRung({
        def,
        geometries,
        memberCount: members.length,
        prototype,
        sphere,
      });
      rung.captureBaselines(container, members);
      const authority = members[0] as Mesh;
      for (const member of members) {
        const registered = chains.get(member.geometry);
        if (registered === undefined) continue;
        const withJoined: IRegisteredChain = {
          authority: member === authority,
          chain: registered.chain,
          joined: rung,
          policy: registered.policy,
        };
        // Every level, not just the base: a clone made after a selection already swapped a member to
        // a coarser level carries that derived geometry, and must still resolve to this rung.
        for (const geometry of registered.chain.levels) chains.set(geometry, withJoined);
        // Members that were already managed (a discrete chain) were built before the rung was known;
        // rebuild them with the rung and the authority mark.
        controllers.set(
          member,
          new ModelLod(member, registered.chain, applied, rung, member === authority),
        );
      }
    }
  }
}

/** The LOD0 geometry of a mesh under a discrete chain, or the mesh's own geometry otherwise. */
export function baseGeometryOf(mesh: Mesh): BufferGeometry {
  const controller = controllers.get(mesh);
  if (controller !== undefined) return controller.base;
  return chains.get(mesh.geometry)?.chain.base ?? mesh.geometry;
}

/**
 * The chain registered against `geometry`, or `undefined` when the geometry carries none.
 *
 * For a caller that draws one geometry many times. A `ModelLod` swaps one mesh's geometry, so an
 * instanced batch — which cannot swap a geometry per instance — derives levels of its own from these
 * numbers and crosses between them by distance instead. Selection stays here: this reads the chain
 * out and hands it over, and the caller does the arithmetic {@link projectedLodError} documents, with
 * a screen-space error budget of its own — a batch's placements are all at different distances, so
 * the budget the loader registered the chain with, which is calibrated for the one mesh it drives,
 * is not the one that applies. Any level of a chain answers, since a clone may be carrying a derived
 * geometry.
 */
export function lodChainOf(geometry: BufferGeometry): ILodChain | undefined {
  return chains.get(geometry)?.chain;
}

// --- Per-frame update, mirroring `updateClusteredMeshes` ----------------------------------------

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
  readonly items: Set<Mesh>;
  readonly hooked: WeakSet<object>;
  readonly onAdded: (event: IChildGraphEvent) => void;
  readonly onRemoved: (event: IChildGraphEvent) => void;
}

const trackedRoots = new WeakMap<object, ITrackedRoot>();

function isGraphNode(root: object): root is IGraphNode {
  const candidate = root as Partial<IGraphNode>;
  return (
    typeof candidate.traverse === "function" &&
    typeof candidate.addEventListener === "function" &&
    typeof candidate.removeEventListener === "function"
  );
}

function hookSubtree(tracking: ITrackedRoot, subtree: object): void {
  (subtree as IGraphNode).traverse((node) => {
    if (controllers.has(node as Mesh) || isChained(node)) tracking.items.add(node as Mesh);
    if (tracking.hooked.has(node)) return;
    tracking.hooked.add(node);
    const link = node as Partial<IGraphNode>;
    if (typeof link.addEventListener !== "function") return;
    link.addEventListener("childadded", tracking.onAdded);
    (link as IGraphNode).addEventListener("childremoved", tracking.onRemoved);
  });
}

function unhookSubtree(tracking: ITrackedRoot, subtree: object): void {
  // Releasing a controller can remove a joined sibling. Snapshot before releasing so Three's
  // traversal never indexes a children array that the release just shortened.
  const nodes: object[] = [];
  (subtree as IGraphNode).traverse((node) => nodes.push(node));
  for (const node of nodes) {
    tracking.items.delete(node as Mesh);
    // A removed mesh must not leave a joined proxy behind in a container that stays in the scene.
    controllers.get(node as Mesh)?.release();
    if (!tracking.hooked.has(node)) continue;
    tracking.hooked.delete(node);
    const link = node as Partial<IGraphNode>;
    if (typeof link.removeEventListener !== "function") continue;
    link.removeEventListener("childadded", tracking.onAdded);
    (link as IGraphNode).removeEventListener("childremoved", tracking.onRemoved);
  }
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
  hookSubtree(tracking, root);
  return tracking;
}

/**
 * Takes every discrete-LOD mesh under `root` through this frame's selection.
 *
 * The engine calls this itself, once a frame, after matrices are synced and before the render.
 * Multi-view callers that need the finest level across passes use {@link selectLodLevel} directly;
 * this entry point selects for the one camera it is handed — which is the main view, and is at
 * least as fine as a shadow pass of lower resolution needs.
 *
 * @returns triangles the managed meshes will submit this frame.
 */
export function updateModelLods(
  root: { traverse(callback: (object: object) => void): void },
  camera: Camera,
  viewportHeight: number,
): number {
  camera.updateMatrixWorld();
  if (!isGraphNode(root)) {
    const entries: IModelLodController[] = [];
    root.traverse((object) => {
      const entry = controllerFor(object as Mesh);
      if (entry !== undefined) entries.push(entry);
    });
    for (const entry of entries) entry.update(camera, viewportHeight);
    // Summed after every selection, so a joined rung activated by the authority is reflected in
    // its hidden siblings' counts whatever order the traversal visited them in.
    let triangles = 0;
    for (const entry of entries) triangles += entry.triangles;
    return triangles;
  }
  const tracking = trackRoot(root);
  for (const mesh of tracking.items) {
    const entry = controllerFor(mesh);
    if (entry === undefined) {
      tracking.items.delete(mesh);
      continue;
    }
    entry.update(camera, viewportHeight);
  }
  let triangles = 0;
  for (const mesh of tracking.items) triangles += controllers.get(mesh)?.triangles ?? 0;
  return triangles;
}
