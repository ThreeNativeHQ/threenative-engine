import type {
  BufferAttribute,
  BufferGeometry,
  InterleavedBufferAttribute,
  Light,
  Material,
  Mesh,
  Object3D,
  Scene,
  SkinnedMesh,
} from "three";

import { isEngineRenderHook } from "./engine-render-hook.js";
import { skinnedMaterialBlocked } from "./projection-skinned.js";
import { uniformSignatureOf } from "./projection-uniform.js";
import type { ProjectionExactReason, ProjectionReasonCode } from "./renderProjection.js";

/**
 * The scan-and-plan seam of the render projection (P2-3).
 *
 * Reading the authored scene and deciding what the mirror should do does not touch the mirror or
 * allocate a buffer. The scan owns one caller-provided workspace: active counts are reset and
 * source slots are overwritten in place, while each backing array keeps its high-water length. The
 * seen index advances by generation, and the returned plan is consumed before the next scan. Keeping
 * the decision here means the kill-switch ratio, the mesh floor and the exact-lane classification
 * are testable without a mirror at all.
 */

/**
 * Fewer members than this and a group is not worth batching.
 *
 * An instanced draw of one object is one draw, exactly like the object was, except it also costs a
 * private buffer, a slot table and a per-frame matrix compare. A game whose meshes each carry their
 * own geometry — which is most games that build geometry procedurally, and every game that has
 * already merged its own scene — produces nothing but one-member groups, so batching it converts a
 * cheap scene into an expensive one that draws the same number of times.
 *
 * The same floor applies to a material-keyed batch: folding four distinct geometries under one
 * material saves three draws but costs a packed copy of all of them, and below that the copies
 * cost more than the draws they replace.
 */
export const MIN_BATCH_MEMBERS = 4;

/**
 * The projection must be meaningfully better than doing nothing, or it does nothing.
 *
 * This is the rule that was missing, and its absence is the whole of the defect it was added for: a
 * real game that had already merged its own scene from 1,698 meshes to 254 was re-expanded into
 * 1,251 single-member instanced draws — the same draw count as the authored scene, plus a rebuild
 * of every batch on the frame that discovered them. The frame never finished and the screen stayed
 * black. Nothing in the design forbade it, because nothing compared the result against the input.
 *
 * Now everything is predicted from the grouping before a single buffer is allocated, and a
 * projection that cannot beat this ratio is abandoned before it costs anything.
 */
const WORTHWHILE_DRAW_RATIO = 0.75;

/**
 * How many rigid meshes one skinned rig counts as against the mesh floor, which is priced in rigid
 * draws. Measured 2026-09-25 on tn-web, NVIDIA Turing, shadows on, 300 frames per arm
 * (`scripts/engine-load-test/skinned-crowd.ts`): 512 shadow-casting boxes cost 0.8 ms of CPU a
 * frame and 512 rigs of 32 bones 20.8 ms, so a rig submits about 26 rigid draws' worth. The scenes
 * this admits below the rigid floor were measured faster, not merely equal: 4 rigs beside 100 props
 * went 6.2 -> 3.85 ms a frame and 8 rigs beside 150 props 9.7 -> 6.85 ms (medians of 4 pairs). A
 * scene whose props cannot batch is still declined by the draw-ratio rule above.
 */
const SKINNED_FLOOR_WEIGHT = 26;

function isMesh(object: Object3D): object is Mesh {
  return (object as Mesh).isMesh === true;
}

export function isLight(object: Object3D): object is Light {
  return (object as Light).isLight === true;
}

/** True when the object draws something, whether or not this class can batch it. */
export function isRenderable(object: Object3D): boolean {
  const candidate = object as Mesh & { isSprite?: boolean; isPoints?: boolean; isLine?: boolean };
  return (
    candidate.isMesh === true ||
    candidate.isSprite === true ||
    candidate.isPoints === true ||
    candidate.isLine === true
  );
}

type ProjectionCandidate = Mesh & {
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
  isSkinnedMesh?: boolean;
  isSprite?: boolean;
  isPoints?: boolean;
  isLine?: boolean;
  isLOD?: boolean;
  customDepthMaterial?: unknown;
  customDistanceMaterial?: unknown;
};

function specializedLaneReason(
  object: Object3D,
  candidate: ProjectionCandidate,
  checkLodAncestors: boolean,
): ProjectionExactReason | undefined {
  if (candidate.isSprite === true) return "sprite";
  if (candidate.isPoints === true || candidate.isLine === true) return "points";
  if (candidate.isInstancedMesh === true || candidate.isBatchedMesh === true) return "instanced";
  if (candidate.isSkinnedMesh === true) return "skinned";
  if (Array.isArray(candidate.material)) return "multiMaterial";
  if (candidate.customDepthMaterial != null || candidate.customDistanceMaterial != null) {
    return "customDepthMaterial";
  }
  if (checkLodAncestors) {
    for (let node: Object3D | null = object; node !== null; node = node.parent) {
      if ((node as { isLOD?: boolean }).isLOD === true) return "lod";
    }
  }
  return undefined;
}

export function hasMorphAttributes(geometry: BufferGeometry): boolean {
  const targets = geometry.morphAttributes as Record<string, readonly unknown[] | undefined>;
  for (const name in targets) {
    // Three's holder is `{}` until a morph target is added. The native engine's holder always names
    // `position` and `normal`, as empty arrays, so a key alone is not a target: count the targets.
    if (Object.hasOwn(targets, name) && (targets[name]?.length ?? 0) > 0) return true;
  }
  return false;
}

/**
 * True when the material already moves its own vertices: `positionNode`, the shadow path's
 * `castShadowPositionNode`, or a `displacementMap`. Read through `Reflect` because a plain
 * `MeshStandardMaterial` has none of them, and they are read as plain properties rather than through
 * `Reflect` because the structure proof asks this of every material in the scene on every frame:
 * `Reflect.get` is a runtime call on a key the engine cannot fold, and the direct read is a load it
 * can.
 */
export function displacesVertices(material: Material): boolean {
  const candidate = material as {
    positionNode?: unknown;
    castShadowPositionNode?: unknown;
    displacementMap?: unknown;
  };
  return (
    candidate.positionNode != null ||
    candidate.castShadowPositionNode != null ||
    candidate.displacementMap != null
  );
}

function geometryLaneReason(geometry: BufferGeometry): ProjectionExactReason | undefined {
  if (geometry.getAttribute("position") === undefined) return "unsupportedGeometry";
  // A GPU-driven field's draw count lives in an indirect buffer a compute pass writes, and a batch
  // draws with the count the CPU last believed. Nothing else about the mesh says so — it is an
  // ordinary `Mesh` with an ordinary material — so without this the field is folded in and its
  // survivor count is discarded while the report claims a clean projection. It keeps its own draw.
  if ((geometry as { indirect?: unknown }).indirect != null) return "indirect";
  if (hasMorphAttributes(geometry)) return "morph";
  const range = geometry.drawRange;
  if (range !== undefined && (range.start !== 0 || Number.isFinite(range.count))) {
    return "drawRange";
  }
  return undefined;
}

/**
 * Why a skinned mesh cannot join a skinned batch, or `undefined` when it can.
 *
 * The same semantics a batched draw cannot carry as on the other lanes, plus the ones the palette
 * shader cannot: a material that already moves its own vertices, and a geometry without the four
 * weighted bone influences and the normal the palette deforms.
 */
function skinnedLaneReason(object: Object3D): ProjectionExactReason | undefined {
  const candidate = object as ProjectionCandidate & SkinnedMesh;
  if (Array.isArray(candidate.material)) return "multiMaterial";
  if (candidate.customDepthMaterial != null || candidate.customDistanceMaterial != null) {
    return "customDepthMaterial";
  }
  const geometry = candidate.geometry;
  if (geometry === undefined) return "unsupportedGeometry";
  const geometryReason = geometryLaneReason(geometry);
  if (geometryReason !== undefined) return geometryReason;
  if ((object.renderOrder ?? 0) !== 0) return "renderOrder";
  const material = candidate.material as Material | undefined;
  if (material === undefined) return "unsupportedGeometry";
  if (material.transparent === true) return "transparent";
  if (
    skinnedMaterialBlocked(material) ||
    candidate.skeleton === undefined ||
    candidate.skeleton.bones.length === 0 ||
    geometry.getAttribute("normal")?.itemSize !== 3 ||
    geometry.getAttribute("skinIndex")?.itemSize !== 4 ||
    geometry.getAttribute("skinWeight")?.itemSize !== 4
  ) {
    return "skinned";
  }
  return undefined;
}

/**
 * Why a renderable cannot join a batch, or `undefined` when it can.
 *
 * Every entry is a semantic a batched draw provably does not carry. They are named individually
 * because a report saying "12 objects were not batched" is not evidence, and §4.3 requires the
 * ineligible set to be enumerated before a low draw count means anything.
 */
export function exactLaneReason(object: Object3D): ProjectionExactReason | undefined {
  return laneReasonOf(object, object as ProjectionCandidate, true);
}

/**
 * The scan-internal lane classification.
 *
 * Identical to `exactLaneReason` minus the LOD ancestor walk, which the scan can skip: the walk
 * classifies each `LOD` on arrival and never descends into one, so no object visited during a
 * scan can have an LOD ancestor, and checking for one is a full parent-chain read per renderable
 * per frame that can never fire.
 */
function walkLaneReason(object: Object3D): ProjectionExactReason | undefined {
  return laneReasonOf(object, object as ProjectionCandidate, false);
}

function laneReasonOf(
  object: Object3D,
  candidate: ProjectionCandidate,
  checkLodAncestors: boolean,
): ProjectionExactReason | undefined {
  const specialized = specializedLaneReason(object, candidate, checkLodAncestors);
  if (specialized !== undefined) return specialized;
  const geometry = candidate.geometry;
  if (geometry === undefined) return "unsupportedGeometry";
  const geometryReason = geometryLaneReason(geometry);
  if (geometryReason !== undefined) return geometryReason;
  // A batch is one draw, so it has one place in the transparency sort. Objects that asked for a
  // specific place keep their own draw and their own place in it.
  if ((object.renderOrder ?? 0) !== 0) return "renderOrder";
  const material = candidate.material as Material | undefined;
  if (material === undefined) return "unsupportedGeometry";
  if (material.transparent === true) return "transparent";
  // A batch is one object with one model matrix, so a displacement written against the object's own
  // is wrong there, or lost. The mesh keeps its own draw and its own matrix; the skinned lane
  // refuses these materials for the same reason (`skinnedMaterialBlocked`).
  if (displacesVertices(material)) return "vertexDisplaced";
  return undefined;
}

/**
 * True when the object carries a render callback of its own.
 *
 * Three.js hands `onBeforeRender` the object it is about to draw. A proxy would hand it the proxy,
 * and a batch would not call it at all, so a game that hooks a draw gets its own object back or the
 * frame is not projected. There is no third option that is honest, and this is rare enough that
 * whole-scene fallback is the right price.
 *
 * The engine's own borrows are the exception (PRD-458): `WorldCells` marks each prewarm hook as
 * bookkeeping, and a marked callback claims no object, so folding it away loses nothing. A streamed
 * world carries hundreds of them and unmarking them silently disabled the projection on exactly the
 * scenes it exists for.
 */
export function hasRenderHook(object: Object3D): boolean {
  return (
    (Object.hasOwn(object, "onBeforeRender") && !isEngineRenderHook(object.onBeforeRender)) ||
    (Object.hasOwn(object, "onAfterRender") && !isEngineRenderHook(object.onAfterRender))
  );
}

/** Why a source cannot share a batch, or the whole classification for one frame. */
export interface IProjectionExactEntry {
  object: Object3D | undefined;
  reason: ProjectionExactReason;
}

export interface IProjectionSeen {
  has(object: Object3D): boolean;
}

interface IProjectionSeenWorkspace extends IProjectionSeen {
  add(object: Object3D): void;
  begin(): void;
}

class ProjectionSeen implements IProjectionSeenWorkspace {
  #generation = 0;
  #generations = new WeakMap<Object3D, number>();

  begin(): void {
    this.#generation += 1;
  }

  add(object: Object3D): void {
    this.#generations.set(object, this.#generation);
  }

  has(object: Object3D): boolean {
    return this.#generations.get(object) === this.#generation;
  }
}

/**
 * A reusable identity group for one (geometry, material, flags) combination.
 */
export interface IProjectionBatchGroup {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly frustumCulled: boolean;
  readonly layersMask: number;
  /** High-water member storage; only the first `memberCount` slots belong to the current scan. */
  readonly members: Array<Mesh | undefined>;
  memberCount: number;
  activeScan: number;
}

/**
 * An instanced group whose members' materials are interchangeable except for their base colour.
 *
 * Keyed on (geometry, material signature, flags) rather than material identity, so a scene of
 * per-object material clones that differ only in albedo — the shape a game gets by cloning a
 * material per prop — collapses to one draw. The draw cannot use the game's material instances,
 * because there is one draw and many materials: it carries a clone the mirror owns with the colour
 * removed, and each instance carries its source material's colour. `material` stays the group's
 * representative, which is what every member was equal to.
 */
export interface IProjectionUniformGroup extends IProjectionBatchGroup {
  readonly uniform: true;
}

/**
 * A reusable group of meshes that share a material but not a geometry.
 *
 * This is the second grouping the instanced lane cannot express: a `BatchedMesh` holds many
 * distinct geometries under one material, which is the shape of a real town — hundreds of unique
 * buildings over a handful of surface types. Members are meshes whose own (geometry, material,
 * flags) group fell below the member floor, so a mesh that can still instance-batch keeps doing
 * so and never reaches here.
 *
 * Keyed on (material identity, batch flags, attribute signature). The flags include the source
 * frustum-culling choice: a forced-visible mesh cannot share a per-object-culled batch, because
 * three's packed bounds do not know about shader displacement. The signature — attribute names
 * with item sizes, plus index presence — is what three's `BatchedMesh._validateGeometry` refuses
 * to mix, so geometries that disagree about their attribute sets can never land in one batch.
 * It is keyed on material *identity*, never on material value: a plain property write does not
 * bump `material.version`, so a value key could not be invalidated cheaply and siblings would
 * silently draw with a stale representative.
 */
export interface IProjectionMaterialGroup {
  readonly material: Material;
  readonly castShadow: boolean;
  readonly receiveShadow: boolean;
  readonly frustumCulled: boolean;
  readonly layersMask: number;
  /** High-water member storage; only the first `memberCount` slots belong to the current scan. */
  readonly members: Array<Mesh | undefined>;
  memberCount: number;
  activeScan: number;
  /**
   * Each distinct geometry with the attribute-version sum it was last seen carrying. A geometry
   * whose sum moves after admission is game-owned live data — its copies inside a packed batch
   * would silently go stale — so it is demoted out of the lane rather than re-copied.
   */
  readonly geometries: Map<BufferGeometry, { sum: number; scan: number }>;
  /** Bumped whenever the distinct-geometry set changes, so a built batch knows to rebuild. */
  revision: number;
}

/** All scan-owned storage. It never escapes the synchronous reconcile that owns it. */
export interface IProjectionScanWorkspace {
  readonly seen: IProjectionSeenWorkspace;
  readonly eligible: Array<Mesh | undefined>;
  eligibleCount: number;
  /** Skinned meshes the palette lane can draw, grouped separately from the rigid lanes. */
  readonly skinned: Array<SkinnedMesh | undefined>;
  skinnedCount: number;
  readonly skinnedGroupsByGeometry: WeakMap<
    BufferGeometry,
    WeakMap<Material, Map<number, IProjectionBatchGroup>>
  >;
  readonly activeSkinnedGroups: Array<IProjectionBatchGroup | undefined>;
  activeSkinnedGroupCount: number;
  readonly skinnedGroups: Array<IProjectionBatchGroup | undefined>;
  skinnedGroupCount: number;
  readonly exactLane: IProjectionExactEntry[];
  readonly exactEntryPool: IProjectionExactEntry[];
  exactLaneCount: number;
  readonly lights: Array<Light | undefined>;
  lightCount: number;
  readonly batchGroups: Array<IProjectionBatchGroup | undefined>;
  batchGroupCount: number;
  readonly materialGroups: Array<IProjectionMaterialGroup | undefined>;
  materialGroupCount: number;
  readonly activeMaterialGroups: Array<IProjectionMaterialGroup | undefined>;
  activeMaterialGroupCount: number;
  readonly belowFloor: Array<Mesh | undefined>;
  belowFloorCount: number;
  readonly activeGroups: Array<IProjectionBatchGroup | undefined>;
  activeGroupCount: number;
  readonly walkStack: Array<Object3D | undefined>;
  walkStackCount: number;
  readonly groupsByGeometry: WeakMap<
    BufferGeometry,
    WeakMap<Material, Map<number, IProjectionBatchGroup>>
  >;
  /**
   * Uniform groups, by geometry, then by the material signature, then by the batching flags — a
   * signature is a value, so the geometry key has to be the weak one for the index not to outlive
   * the geometry it describes.
   */
  readonly uniformGroups: WeakMap<
    BufferGeometry,
    Map<string, Map<number, IProjectionUniformGroup>>
  >;
  readonly activeUniformGroups: Array<IProjectionUniformGroup | undefined>;
  activeUniformGroupCount: number;
  /** The uniform group each mesh was filed under, so nothing files it a second time this scan. */
  readonly uniformOf: WeakMap<Mesh, IProjectionUniformGroup>;
  readonly groupsByMaterial: WeakMap<Material, Map<number, Map<string, IProjectionMaterialGroup>>>;
  /** Attribute signature per geometry, computed once and interned so group lookup stays pointer-cheap. */
  readonly geometrySignatures: WeakMap<BufferGeometry, string>;
  /**
   * Members claimed by a material group that made the batching floor this scan, stamped with the
   * scan that claimed them. Their below-floor geometry groups must not also file them onto the
   * exact lane — a mesh released into a batch and into a proxy in the same frame draws twice.
   */
  readonly materialClaims: WeakMap<Object3D, number>;
  /**
   * Geometries caught changing after admission to a material group. Their vertex data is
   * game-owned live — the instanced lane references it, a packed copy cannot — so they are barred
   * from the material lane for good and their meshes fall back to instance-or-exact.
   */
  readonly streamedGeometries: WeakSet<BufferGeometry>;
  scanNumber: number;
}

/** Gives the frame back to the authored scene, naming why. */
export interface IProjectionDeclinePlan {
  readonly action: "decline";
  readonly reasonCode: ProjectionReasonCode;
  readonly reason: string;
}

/** Everything the apply seam needs to build and maintain this frame's mirror. */
export interface IProjectionProjectPlan {
  readonly action: "project";
  /** Groups worth batching, sized before anything is built. */
  readonly batchGroups: readonly (IProjectionBatchGroup | undefined)[];
  readonly batchGroupCount: number;
  /** Material-keyed groups worth batching across differing geometries, sized before anything is built. */
  readonly materialGroups: readonly (IProjectionMaterialGroup | undefined)[];
  readonly materialGroupCount: number;
  /** Skinned groups worth one palette draw each; their members share geometry, material and rig size. */
  readonly skinnedGroups: readonly (IProjectionBatchGroup | undefined)[];
  readonly skinnedGroupCount: number;
  /** Group members below the batching floor: released from batches, drawn on the exact lane. */
  readonly belowFloor: readonly (Mesh | undefined)[];
  readonly belowFloorCount: number;
  /** Objects keeping a draw of their own, with the reason each one did. */
  readonly exactLane: readonly IProjectionExactEntry[];
  readonly exactLaneCount: number;
  /** The scene's lights, to be mirrored rather than moved out of the game's graph. */
  readonly lights: readonly (Light | undefined)[];
  readonly lightCount: number;
  /** Every object the walk saw, for the retirement sweep against sources that left the scene. */
  readonly seen: IProjectionSeen;
}

export type IProjectionPlan = IProjectionDeclinePlan | IProjectionProjectPlan;

export interface IProjectionScanResult {
  /** Exact-lane entries from the walk alone, before batching decisions add more. */
  readonly exactLane: readonly IProjectionExactEntry[];
  readonly exactLaneCount: number;
  /** Decline without touching the mirror, or build what the plan describes. */
  readonly plan: IProjectionPlan;
  /** Renderables the authored scene holds — what an unoptimized frame would walk and draw. */
  readonly renderables: number;
  readonly seen: IProjectionSeen;
}

export function createProjectionScanWorkspace(): IProjectionScanWorkspace {
  return {
    seen: new ProjectionSeen(),
    eligible: [],
    eligibleCount: 0,
    skinned: [],
    skinnedCount: 0,
    skinnedGroupsByGeometry: new WeakMap(),
    activeSkinnedGroups: [],
    activeSkinnedGroupCount: 0,
    skinnedGroups: [],
    skinnedGroupCount: 0,
    exactLane: [],
    exactEntryPool: [],
    exactLaneCount: 0,
    lights: [],
    lightCount: 0,
    batchGroups: [],
    batchGroupCount: 0,
    materialGroups: [],
    materialGroupCount: 0,
    activeMaterialGroups: [],
    activeMaterialGroupCount: 0,
    belowFloor: [],
    belowFloorCount: 0,
    activeGroups: [],
    activeGroupCount: 0,
    walkStack: [],
    walkStackCount: 0,
    groupsByGeometry: new WeakMap(),
    uniformGroups: new WeakMap(),
    activeUniformGroups: [],
    activeUniformGroupCount: 0,
    uniformOf: new WeakMap(),
    groupsByMaterial: new WeakMap(),
    geometrySignatures: new WeakMap(),
    materialClaims: new WeakMap(),
    streamedGeometries: new WeakSet(),
    scanNumber: 0,
  };
}

/**
 * Releases source references from the reusable scan storage after its plan is consumed.
 *
 * The arrays and identity maps stay reusable at their high-water lengths, but their members are
 * borrowed from the authored scene. Clearing active slots without truncating them avoids backing
 * store churn; keeping those members in an inactive group or pooled exact entry would make a
 * streamed scene retain every mesh it had ever contained.
 */
/**
 * Releases one active material group's members and stale geometry baselines.
 *
 * A geometry that no longer has a member this scan has stopped participating; its baseline is
 * dropped so the watch does not sum versions forever for data nothing draws. The entry is
 * re-established with a fresh baseline if the geometry comes back, which is correct — the batch
 * is built from whatever the vertex data carries at that point.
 */
function releaseActiveMaterialGroup(
  workspace: IProjectionScanWorkspace,
  group: IProjectionMaterialGroup,
): void {
  for (let member = 0; member < group.memberCount; member += 1) {
    group.members[member] = undefined;
  }
  group.memberCount = 0;
  for (const [geometry, record] of group.geometries) {
    if (record.scan !== workspace.scanNumber) group.geometries.delete(geometry);
  }
}

/** The skinned lane's share of `releaseProjectionScanWorkspace`. */
function releaseSkinnedScan(workspace: IProjectionScanWorkspace): void {
  for (let index = 0; index < workspace.skinnedCount; index += 1) {
    workspace.skinned[index] = undefined;
  }
  for (let index = 0; index < workspace.activeSkinnedGroupCount; index += 1) {
    const group = workspace.activeSkinnedGroups[index] as IProjectionBatchGroup;
    for (let member = 0; member < group.memberCount; member += 1) {
      group.members[member] = undefined;
    }
    group.memberCount = 0;
    workspace.activeSkinnedGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.skinnedGroupCount; index += 1) {
    workspace.skinnedGroups[index] = undefined;
  }
  workspace.skinnedCount = 0;
  workspace.activeSkinnedGroupCount = 0;
  workspace.skinnedGroupCount = 0;
}

export function releaseProjectionScanWorkspace(workspace: IProjectionScanWorkspace): void {
  for (let index = 0; index < workspace.exactEntryPool.length; index += 1) {
    const entry = workspace.exactEntryPool[index] as IProjectionExactEntry;
    entry.object = undefined;
  }
  for (let index = 0; index < workspace.activeGroupCount; index += 1) {
    const group = workspace.activeGroups[index] as IProjectionBatchGroup;
    for (let member = 0; member < group.memberCount; member += 1) {
      group.members[member] = undefined;
    }
    group.memberCount = 0;
    workspace.activeGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.activeUniformGroupCount; index += 1) {
    const group = workspace.activeUniformGroups[index] as IProjectionUniformGroup;
    for (let member = 0; member < group.memberCount; member += 1) {
      group.members[member] = undefined;
    }
    group.memberCount = 0;
    workspace.activeUniformGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.activeMaterialGroupCount; index += 1) {
    releaseActiveMaterialGroup(
      workspace,
      workspace.activeMaterialGroups[index] as IProjectionMaterialGroup,
    );
    workspace.activeMaterialGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.eligibleCount; index += 1) {
    workspace.eligible[index] = undefined;
  }
  releaseSkinnedScan(workspace);
  for (let index = 0; index < workspace.exactLaneCount; index += 1) {
    const entry = workspace.exactLane[index] as IProjectionExactEntry;
    entry.object = undefined;
  }
  for (let index = 0; index < workspace.lightCount; index += 1) {
    workspace.lights[index] = undefined;
  }
  for (let index = 0; index < workspace.batchGroupCount; index += 1) {
    workspace.batchGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.materialGroupCount; index += 1) {
    workspace.materialGroups[index] = undefined;
  }
  for (let index = 0; index < workspace.belowFloorCount; index += 1) {
    workspace.belowFloor[index] = undefined;
  }
  for (let index = 0; index < workspace.walkStackCount; index += 1) {
    workspace.walkStack[index] = undefined;
  }
  workspace.eligibleCount = 0;
  workspace.exactLaneCount = 0;
  workspace.lightCount = 0;
  workspace.batchGroupCount = 0;
  workspace.materialGroupCount = 0;
  workspace.activeMaterialGroupCount = 0;
  workspace.belowFloorCount = 0;
  workspace.activeGroupCount = 0;
  workspace.activeUniformGroupCount = 0;
  workspace.walkStackCount = 0;
}

function addExactEntry(
  workspace: IProjectionScanWorkspace,
  object: Object3D,
  reason: ProjectionExactReason,
): void {
  const index = workspace.exactLaneCount;
  let entry = workspace.exactEntryPool[index];
  if (entry === undefined) {
    entry = { object, reason };
    workspace.exactEntryPool.push(entry);
  } else {
    entry.object = object;
    entry.reason = reason;
  }
  workspace.exactLane[index] = entry;
  workspace.exactLaneCount += 1;
}

function batchFlagsOf(mesh: Mesh): number {
  return (
    (mesh.layers.mask >>> 0) * 8 +
    (mesh.castShadow ? 4 : 0) +
    (mesh.receiveShadow ? 2 : 0) +
    (mesh.frustumCulled ? 1 : 0)
  );
}

function addToBatchGroup(
  workspace: IProjectionScanWorkspace,
  mesh: Mesh,
  scanNumber: number,
): void {
  const byFlags = flagGroupsOf(workspace.groupsByGeometry, mesh);
  const flags = batchFlagsOf(mesh);
  const group = activeGroupOf(byFlags, flags, mesh, scanNumber);
  if (group.memberCount === 0) {
    workspace.activeGroups[workspace.activeGroupCount] = group;
    workspace.activeGroupCount += 1;
  }
  group.members[group.memberCount] = mesh;
  group.memberCount += 1;
}

/**
 * Files a skinned mesh under (geometry, material, flags, bone count). The bone count is part of
 * the key because it is the palette stride: rigs of different sizes cannot share one shader.
 */
function addToSkinnedGroup(
  workspace: IProjectionScanWorkspace,
  mesh: SkinnedMesh,
  scanNumber: number,
): void {
  const byFlags = flagGroupsOf(workspace.skinnedGroupsByGeometry, mesh);
  // Bone counts stay far below 2^16, so the composite key stays an exact integer.
  const key = batchFlagsOf(mesh) * 65536 + mesh.skeleton.bones.length;
  const group = activeGroupOf(byFlags, key, mesh, scanNumber);
  if (group.memberCount === 0) {
    workspace.activeSkinnedGroups[workspace.activeSkinnedGroupCount] = group;
    workspace.activeSkinnedGroupCount += 1;
  }
  group.members[group.memberCount] = mesh;
  group.memberCount += 1;
}

function flagGroupsOf(
  index: WeakMap<BufferGeometry, WeakMap<Material, Map<number, IProjectionBatchGroup>>>,
  mesh: Mesh,
): Map<number, IProjectionBatchGroup> {
  const geometry = mesh.geometry;
  const material = mesh.material as Material;
  let byMaterial = index.get(geometry);
  if (byMaterial === undefined) {
    byMaterial = new WeakMap();
    index.set(geometry, byMaterial);
  }
  let byFlags = byMaterial.get(material);
  if (byFlags === undefined) {
    byFlags = new Map();
    byMaterial.set(material, byFlags);
  }
  return byFlags;
}

/** The group for `key`, emptied on its first sighting this scan. */
function activeGroupOf(
  byFlags: Map<number, IProjectionBatchGroup>,
  key: number,
  mesh: Mesh,
  scanNumber: number,
): IProjectionBatchGroup {
  const geometry = mesh.geometry;
  const material = mesh.material as Material;
  let group = byFlags.get(key);
  if (group === undefined) {
    group = {
      geometry,
      material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      frustumCulled: mesh.frustumCulled,
      layersMask: mesh.layers.mask,
      members: [],
      memberCount: 0,
      activeScan: 0,
    };
    byFlags.set(key, group);
  }
  if (group.activeScan !== scanNumber) {
    group.activeScan = scanNumber;
    group.memberCount = 0;
  }
  return group;
}

/**
 * What three's `BatchedMesh._validateGeometry` refuses to mix, as one interned string.
 *
 * Index presence plus every attribute name with its item size and normalization. Cached per
 * geometry, so a steady frame pays one WeakMap lookup; only a geometry's first sighting builds
 * the string. Two geometries that disagree here cannot share a packed batch, so the signature is
 * part of the material-group key rather than a check applied after grouping.
 */
function geometrySignatureOf(
  workspace: IProjectionScanWorkspace,
  geometry: BufferGeometry,
): string {
  const cached = workspace.geometrySignatures.get(geometry);
  if (cached !== undefined) return cached;
  const names = Object.keys(geometry.attributes).sort();
  let signature = geometry.getIndex() === null ? "n" : "i";
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index] as string;
    const attribute = geometry.getAttribute(name);
    if (attribute === undefined) continue;
    signature += ` ${name}:${attribute.itemSize}:${attribute.normalized ? 1 : 0}`;
  }
  workspace.geometrySignatures.set(geometry, signature);
  return signature;
}

/** Versions only ever increase, so an attribute's version is a usable change signal. */
function attributeVersionOf(attribute: BufferAttribute | InterleavedBufferAttribute): number {
  // An interleaved attribute's version lives on the shared buffer it slices into.
  if ("isInterleavedBufferAttribute" in attribute) return attribute.data.version;
  return attribute.version;
}

/**
 * Sums every attribute version, plus the index's, into one number.
 *
 * Versions only ever increase, so the sum does too: any single `needsUpdate` write moves it. This
 * is how the lane learns that a game streams into vertex data it had admitted — the one thing a
 * packed copy cannot follow that the instanced lane's shared reference can.
 */
export function geometryVersionSum(geometry: BufferGeometry): number {
  let sum = 0;
  for (const name in geometry.attributes) {
    if (!Object.hasOwn(geometry.attributes, name)) continue;
    const attribute = geometry.getAttribute(name);
    if (attribute !== undefined) sum += attributeVersionOf(attribute);
  }
  const index = geometry.getIndex();
  return index === null ? sum : sum + attributeVersionOf(index);
}

/**
 * Files a mesh under (geometry, material signature, flags) for a draw that carries the colour
 * per instance.
 *
 * The signature is the material's own readable properties minus its colour, so a mesh whose
 * material is ineligible — transparent, vertex-coloured, a node graph, an unknown class — simply
 * has no signature and never reaches this lane. A material that shares an instance with a twin is
 * still better served by the identity lane, so this runs over the groups that fell below its floor.
 */
function addToUniformGroup(
  workspace: IProjectionScanWorkspace,
  mesh: Mesh,
  scanNumber: number,
): void {
  const geometry = mesh.geometry;
  const material = mesh.material as Material;
  const signature = uniformSignatureOf(material);
  if (signature === undefined) return;
  const flags = batchFlagsOf(mesh);
  let bySignature = workspace.uniformGroups.get(geometry);
  if (bySignature === undefined) {
    bySignature = new Map();
    workspace.uniformGroups.set(geometry, bySignature);
  }
  let byFlags = bySignature.get(signature);
  if (byFlags === undefined) {
    byFlags = new Map();
    bySignature.set(signature, byFlags);
  }
  let group = byFlags.get(flags);
  if (group === undefined) {
    group = {
      geometry,
      material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      frustumCulled: mesh.frustumCulled,
      layersMask: mesh.layers.mask,
      members: [],
      memberCount: 0,
      activeScan: 0,
      uniform: true,
    };
    byFlags.set(flags, group);
  }
  if (group.activeScan !== scanNumber) {
    group.activeScan = scanNumber;
    group.memberCount = 0;
    workspace.activeUniformGroups[workspace.activeUniformGroupCount] = group;
    workspace.activeUniformGroupCount += 1;
  }
  group.members[group.memberCount] = mesh;
  group.memberCount += 1;
  workspace.uniformOf.set(mesh, group);
}

/** Whether a mesh was claimed by a uniform group that made the member floor this scan. */
function uniformClaimed(workspace: IProjectionScanWorkspace, mesh: Mesh): boolean {
  const group = workspace.uniformOf.get(mesh);
  return group !== undefined && group.memberCount >= MIN_BATCH_MEMBERS;
}

function addToMaterialGroup(
  workspace: IProjectionScanWorkspace,
  mesh: Mesh,
  scanNumber: number,
): void {
  const geometry = mesh.geometry;
  // Barred for good: this geometry was caught changing under a built batch once already, and a
  // packed copy would go stale again. The instanced lane still references it live when it has
  // twins; alone it draws on the exact lane.
  if (workspace.streamedGeometries.has(geometry)) return;
  const material = mesh.material as Material;
  const flags = batchFlagsOf(mesh);
  const signature = geometrySignatureOf(workspace, geometry);
  let byFlags = workspace.groupsByMaterial.get(material);
  if (byFlags === undefined) {
    byFlags = new Map();
    workspace.groupsByMaterial.set(material, byFlags);
  }
  let bySignature = byFlags.get(flags);
  if (bySignature === undefined) {
    bySignature = new Map();
    byFlags.set(flags, bySignature);
  }
  let group = bySignature.get(signature);
  if (group === undefined) {
    group = {
      material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      frustumCulled: mesh.frustumCulled,
      layersMask: mesh.layers.mask,
      members: [],
      memberCount: 0,
      activeScan: 0,
      geometries: new Map(),
      revision: 0,
    };
    bySignature.set(signature, group);
  }
  if (group.activeScan !== scanNumber) {
    group.activeScan = scanNumber;
    group.memberCount = 0;
    workspace.activeMaterialGroups[workspace.activeMaterialGroupCount] = group;
    workspace.activeMaterialGroupCount += 1;
  }
  const record = group.geometries.get(geometry);
  if (record === undefined) {
    group.geometries.set(geometry, { sum: geometryVersionSum(geometry), scan: scanNumber });
    group.revision += 1;
  } else {
    record.scan = scanNumber;
  }
  group.members[group.memberCount] = mesh;
  group.memberCount += 1;
}

/**
 * Compacts one geometry's members out of a material group.
 *
 * They are not pushed anywhere: every member here came from a below-floor geometry group and is
 * still listed in it, so the below-floor sweep hands them to the exact lane exactly once. What
 * this removes them from is the batch they can no longer honestly join.
 */
function evictGeometryMembers(group: IProjectionMaterialGroup, geometry: BufferGeometry): void {
  let writeIndex = 0;
  for (let readIndex = 0; readIndex < group.memberCount; readIndex += 1) {
    const member = group.members[readIndex] as Mesh;
    if (member.geometry === geometry) continue;
    group.members[writeIndex] = member;
    writeIndex += 1;
  }
  for (let slot = writeIndex; slot < group.memberCount; slot += 1) {
    group.members[slot] = undefined;
  }
  group.memberCount = writeIndex;
}

/**
 * Watches the vertex data of everything admitted to a material group.
 *
 * Runs after routing, on the same frame the data would be copied: a version-sum move demotes the
 * geometry before this frame's plan is built, so no frame ever renders from a stale copy — the
 * meshes fall to the exact lane with their live references instead. Steady frames compare sums
 * and touch nothing.
 */
function watchMaterialGroupGeometries(workspace: IProjectionScanWorkspace): void {
  for (let index = 0; index < workspace.activeMaterialGroupCount; index += 1) {
    const group = workspace.activeMaterialGroups[index] as IProjectionMaterialGroup;
    for (const [geometry, record] of group.geometries) {
      const sum = geometryVersionSum(geometry);
      if (sum === record.sum) continue;
      workspace.streamedGeometries.add(geometry);
      group.geometries.delete(geometry);
      group.revision += 1;
      evictGeometryMembers(group, geometry);
    }
  }
}

interface IProjectionWalkState {
  renderables: number;
  blocked?: { code: ProjectionReasonCode; reason: string };
}

function visitProjectionObject(
  object: Object3D,
  workspace: IProjectionScanWorkspace,
  state: IProjectionWalkState,
): void {
  // A hook is handed the object being drawn, and neither a batch nor a proxy can hand back the
  // game's own object. The frame goes to the authored scene instead.
  if (state.blocked === undefined && hasRenderHook(object)) {
    state.blocked = {
      code: "renderHook",
      reason: "an object carries its own onBeforeRender/onAfterRender",
    };
  }
  if (isLight(object)) {
    workspace.lights[workspace.lightCount] = object;
    workspace.lightCount += 1;
    return;
  }
  // A BatchedMesh carries private geometry ids, visibility and matrix textures for its sub-draws.
  // The mirror can create its own BatchedMesh for material groups, but it cannot reconstruct an
  // authored one through the shallow exact proxy without losing those live tables. Keep the
  // authored object as the renderer input until a faithful mirror seam exists; otherwise criterion
  // 2 would pass a unit-level tracker test while the projected frame draws the wrong sub-draws.
  if (
    state.blocked === undefined &&
    (object as { isBatchedMesh?: boolean }).isBatchedMesh === true
  ) {
    state.blocked = {
      code: "unsupportedObject",
      reason: "an authored BatchedMesh has private per-sub-draw state the mirror cannot reproduce",
    };
  }
  if ((object as { isLOD?: boolean }).isLOD === true) {
    state.renderables += 1;
    workspace.seen.add(object);
    addExactEntry(workspace, object, "lod");
    return;
  }
  if (!isRenderable(object)) return;
  state.renderables += 1;
  workspace.seen.add(object);
  if ((object as SkinnedMesh).isSkinnedMesh === true) {
    const skinnedReason = skinnedLaneReason(object);
    if (skinnedReason === undefined) {
      workspace.skinned[workspace.skinnedCount] = object as SkinnedMesh;
      workspace.skinnedCount += 1;
    } else addExactEntry(workspace, object, skinnedReason);
    return;
  }
  const reason = walkLaneReason(object);
  if (reason === undefined && isMesh(object)) {
    workspace.eligible[workspace.eligibleCount] = object;
    workspace.eligibleCount += 1;
  } else addExactEntry(workspace, object, reason ?? "unsupportedGeometry");
}

function walkProjection(source: Scene, workspace: IProjectionScanWorkspace): IProjectionWalkState {
  const state: IProjectionWalkState = { renderables: 0 };
  const roots = source.children;
  for (let index = roots.length - 1; index >= 0; index -= 1) {
    workspace.walkStack[workspace.walkStackCount] = roots[index] as Object3D;
    workspace.walkStackCount += 1;
  }
  while (workspace.walkStackCount > 0) {
    workspace.walkStackCount -= 1;
    const object = workspace.walkStack[workspace.walkStackCount] as Object3D;
    workspace.walkStack[workspace.walkStackCount] = undefined;
    visitProjectionObject(object, workspace, state);
    if (isLight(object) || (object as { isLOD?: boolean }).isLOD === true) continue;
    const children = object.children;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      workspace.walkStack[workspace.walkStackCount] = children[index] as Object3D;
      workspace.walkStackCount += 1;
    }
  }
  return state;
}

function groupEligibleMeshes(workspace: IProjectionScanWorkspace, scanNumber: number): void {
  for (let index = 0; index < workspace.eligibleCount; index += 1) {
    addToBatchGroup(workspace, workspace.eligible[index] as Mesh, scanNumber);
  }
  for (let index = 0; index < workspace.skinnedCount; index += 1) {
    addToSkinnedGroup(workspace, workspace.skinned[index] as SkinnedMesh, scanNumber);
  }
  // Meshes whose own (geometry, material, flags) group is too small to instance-batch are exactly
  // the population a material-keyed batch exists for — distinct geometries over a shared surface. A
  // mesh whose geometry group made the floor never reaches here; instancing stays its lane, and it
  // references its geometry live rather than through a packed copy.
  //
  // The uniform pass runs first, because it is the only one of the two that can collapse these
  // meshes into a *single* draw: a packed batch is still one sub-draw per member on WebGPU, while a
  // per-instance colour over one shared geometry is one draw however many members it holds. A mesh
  // whose uniform group made the floor is claimed by it and never filed here.
  for (let index = 0; index < workspace.activeGroupCount; index += 1) {
    const group = workspace.activeGroups[index] as IProjectionBatchGroup;
    if (group.memberCount >= MIN_BATCH_MEMBERS) continue;
    for (let member = 0; member < group.memberCount; member += 1) {
      addToUniformGroup(workspace, group.members[member] as Mesh, scanNumber);
    }
  }
  for (let index = 0; index < workspace.activeGroupCount; index += 1) {
    const group = workspace.activeGroups[index] as IProjectionBatchGroup;
    if (group.memberCount >= MIN_BATCH_MEMBERS) continue;
    for (let member = 0; member < group.memberCount; member += 1) {
      const mesh = group.members[member] as Mesh;
      if (uniformClaimed(workspace, mesh)) continue;
      addToMaterialGroup(workspace, mesh, scanNumber);
    }
  }
  watchMaterialGroupGeometries(workspace);
}

/**
 * A skinned group is one draw per pass however many rigs it holds; below the floor each rig keeps
 * its own, exactly as it had. Groups that make the floor are claimed into the plan here.
 */
function predictSkinnedDraws(workspace: IProjectionScanWorkspace): number {
  let draws = 0;
  for (let index = 0; index < workspace.activeSkinnedGroupCount; index += 1) {
    const group = workspace.activeSkinnedGroups[index] as IProjectionBatchGroup;
    if (group.memberCount < MIN_BATCH_MEMBERS) {
      draws += group.memberCount;
      continue;
    }
    workspace.skinnedGroups[workspace.skinnedGroupCount] = group;
    workspace.skinnedGroupCount += 1;
    draws += 1;
  }
  return draws;
}

function predictDraws(workspace: IProjectionScanWorkspace): number {
  let predictedDraws = workspace.exactLaneCount;
  // A uniform group is one instanced draw however many members it holds, which is the whole reason
  // it exists: unlike the packed lane below, its members do not become one sub-draw each. Claimed
  // here so the same source cannot be drawn twice — once as an instance and once on the exact lane.
  for (let index = 0; index < workspace.activeUniformGroupCount; index += 1) {
    const group = workspace.activeUniformGroups[index] as IProjectionUniformGroup;
    if (group.memberCount < MIN_BATCH_MEMBERS) continue;
    workspace.batchGroups[workspace.batchGroupCount] = group;
    workspace.batchGroupCount += 1;
    predictedDraws += 1;
  }
  // A BatchedMesh still executes one multidraw sub-draw per visible member on WebGPU, so charge
  // every material-group member rather than pretending the packed object is one draw. The group
  // still earns admission when the aggregate plan beats the authored candidate count: it removes
  // renderer objects and gives the backend per-member frustum culling. Claiming the members here
  // keeps them out of the below-floor exact lane, so the same source cannot be drawn twice.
  for (let index = 0; index < workspace.activeMaterialGroupCount; index += 1) {
    const group = workspace.activeMaterialGroups[index] as IProjectionMaterialGroup;
    if (group.memberCount < MIN_BATCH_MEMBERS) continue;
    workspace.materialGroups[workspace.materialGroupCount] = group;
    workspace.materialGroupCount += 1;
    for (let member = 0; member < group.memberCount; member += 1) {
      workspace.materialClaims.set(group.members[member] as Mesh, workspace.scanNumber);
    }
    predictedDraws += group.memberCount;
  }
  predictedDraws += predictSkinnedDraws(workspace);
  for (let index = 0; index < workspace.activeGroupCount; index += 1) {
    const group = workspace.activeGroups[index] as IProjectionBatchGroup;
    if (group.memberCount < MIN_BATCH_MEMBERS) {
      for (let member = 0; member < group.memberCount; member += 1) {
        const mesh = group.members[member] as Mesh;
        if (
          workspace.materialClaims.get(mesh) !== workspace.scanNumber &&
          !uniformClaimed(workspace, mesh)
        )
          predictedDraws += 1;
      }
    } else {
      workspace.batchGroups[workspace.batchGroupCount] = group;
      workspace.batchGroupCount += 1;
      predictedDraws += 1;
    }
  }
  return predictedDraws;
}

function collectBelowFloor(workspace: IProjectionScanWorkspace): void {
  for (let index = 0; index < workspace.activeSkinnedGroupCount; index += 1) {
    const group = workspace.activeSkinnedGroups[index] as IProjectionBatchGroup;
    if (group.memberCount >= MIN_BATCH_MEMBERS) continue;
    for (let member = 0; member < group.memberCount; member += 1) {
      workspace.belowFloor[workspace.belowFloorCount] = group.members[member] as Mesh;
      workspace.belowFloorCount += 1;
    }
  }
  for (let index = 0; index < workspace.activeGroupCount; index += 1) {
    const group = workspace.activeGroups[index] as IProjectionBatchGroup;
    if (group.memberCount >= MIN_BATCH_MEMBERS) continue;
    for (let member = 0; member < group.memberCount; member += 1) {
      const mesh = group.members[member] as Mesh;
      // Claimed by a batched material or uniform group this scan: it is already an instance inside
      // a batch, not below the floor. Everything else here — including members evicted from a
      // material group by the stream watch, whose geometry groups are always below the floor — keeps
      // its own draw. A material group needs no sweep of its own: every one of its members came from
      // a below-floor geometry group, so this loop already reaches each of them exactly once.
      if (workspace.materialClaims.get(mesh) === workspace.scanNumber) continue;
      if (uniformClaimed(workspace, mesh)) continue;
      workspace.belowFloor[workspace.belowFloorCount] = mesh;
      workspace.belowFloorCount += 1;
    }
  }
}

/**
 * Walks the authored scene once and decides what this frame's projection will do.
 *
 * One traversal does all of it: classification, dirty detection and removal. Walking it twice
 * would double the only cost that scales with the scene. An explicit walk rather than
 * `Object3D.traverse`, because some subtrees must be mirrored whole and not descended into — an
 * `LOD` chooses one level per frame on itself, so its levels belong to its stand-in.
 */
export function scanProjection(
  source: Scene,
  minMeshes: number,
  workspace: IProjectionScanWorkspace,
): IProjectionScanResult {
  releaseProjectionScanWorkspace(workspace);
  workspace.seen.begin();
  workspace.scanNumber += 1;
  const state = walkProjection(source, workspace);

  if (state.blocked !== undefined) {
    return {
      exactLane: workspace.exactLane,
      exactLaneCount: workspace.exactLaneCount,
      plan: {
        action: "decline",
        reasonCode: state.blocked.code,
        reason: state.blocked.reason,
      },
      renderables: state.renderables,
      seen: workspace.seen,
    };
  }
  if (workspace.eligibleCount + workspace.skinnedCount * SKINNED_FLOOR_WEIGHT < minMeshes) {
    return {
      exactLane: workspace.exactLane,
      exactLaneCount: workspace.exactLaneCount,
      plan: {
        action: "decline",
        reasonCode: "belowMeshFloor",
        reason: `fewer than ${minMeshes} batchable meshes; the mirror would cost more than it saves`,
      },
      renderables: state.renderables,
      seen: workspace.seen,
    };
  }

  groupEligibleMeshes(workspace, workspace.scanNumber);
  const predictedDraws = predictDraws(workspace);
  if (predictedDraws > state.renderables * WORTHWHILE_DRAW_RATIO) {
    return {
      exactLane: workspace.exactLane,
      exactLaneCount: workspace.exactLaneCount,
      plan: {
        action: "decline",
        reasonCode: "notWorthwhile",
        reason: `projecting would draw ${predictedDraws} of ${state.renderables} candidates, which is not worth its own cost`,
      },
      renderables: state.renderables,
      seen: workspace.seen,
    };
  }

  collectBelowFloor(workspace);
  return {
    exactLane: workspace.exactLane,
    exactLaneCount: workspace.exactLaneCount,
    plan: {
      action: "project",
      batchGroups: workspace.batchGroups,
      batchGroupCount: workspace.batchGroupCount,
      materialGroups: workspace.materialGroups,
      materialGroupCount: workspace.materialGroupCount,
      skinnedGroups: workspace.skinnedGroups,
      skinnedGroupCount: workspace.skinnedGroupCount,
      belowFloor: workspace.belowFloor,
      belowFloorCount: workspace.belowFloorCount,
      exactLane: workspace.exactLane,
      exactLaneCount: workspace.exactLaneCount,
      lights: workspace.lights,
      lightCount: workspace.lightCount,
      seen: workspace.seen,
    },
    renderables: state.renderables,
    seen: workspace.seen,
  };
}
