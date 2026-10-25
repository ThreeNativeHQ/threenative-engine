import {
  BatchedMesh,
  type BufferGeometry,
  type Color,
  InstancedMesh,
  LOD,
  type Light,
  Line,
  LineLoop,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  type Object3D,
  type PointLight,
  Points,
  Scene,
  SkinnedMesh,
  type SpotLight,
  Sprite,
  type SpriteMaterial,
} from "three";

import type { IGeometryOwnership } from "./geometry-capture.js";
import { MIN_BATCH_MEMBERS, isLight } from "./projection-plan.js";
import type {
  IProjectionBatchGroup,
  IProjectionExactEntry,
  IProjectionMaterialGroup,
  IProjectionProjectPlan,
  IProjectionUniformGroup,
} from "./projection-plan.js";
import { SkinnedBatch, isSimilarityTransform } from "./projection-skinned.js";
import { baseColorOf, uniformUnchanged } from "./projection-uniform.js";
import { observeAnimationRates } from "./render-camera-cull.js";
import {
  disposeBatchedMeshVelocity,
  ensureBatchedMeshVelocity,
  isBatchedMeshVelocityPatched,
  setBatchedMeshMatrixWithVelocity,
  setBatchedMeshPreviousMatrix,
} from "./render/batched-velocity.js";
import type { ProjectionExactReason, ProjectionMaterialChecks } from "./renderProjection.js";

/**
 * The apply-and-restore seam of the render projection (P2-3).
 *
 * Everything here mutates: batches are created and disposed, instance slots are handed out and
 * recycled, stand-ins are built and dropped, lights are mirrored, and every source that left the
 * authored scene is retired. The decision of what to do arrived as an immutable plan from
 * `projection-plan.ts`; this module owns all of the state that doing it requires, and all of the
 * restoration paths that undo it. Restoration is not optional bookkeeping — a slot that is not
 * collapsed, a proxy that is not removed, or a light that outlives its source each draw something
 * the game did not author.
 */

/** A transform with no volume. Every triangle drawn through it is degenerate and discarded. */
const ZERO_MATRIX = /* @__PURE__ */ new Matrix4().multiplyScalar(0);

/**
 * The material a uniform batch draws with: the group's representative with its base colour removed.
 *
 * `Color.setHex` converts sRGB into the working colour space as it decodes, so the components on the
 * material are already linear. The instance colours are read from the same place and the node
 * material multiplies the two, so leaving the shared colour at the identity leaves the drawn colour
 * as the source colour, bit for bit, rather than a colour converted twice. Nothing here chooses a
 * colour: it takes the game's own and removes the one value the draw now carries per instance.
 */
function whiteClone(source: Material): Material {
  const clone = source.clone() as Material & { color?: Color };
  clone.color?.setRGB(1, 1, 1);
  return clone;
}

/**
 * Headroom on every batch, so the common case of a game adding a few more props does not rebuild
 * one. A batch that overflows anyway is rebuilt at its new size rather than dropping the object.
 */
const BATCH_GROWTH = 1.5;
const BATCH_MIN_SLOTS = 16;

/**
 * WebGPU's guaranteed minimum `maxStorageBufferBindingSize`. A skinned palette never binds more,
 * so no device is asked for a limit it may not grant; rigs past it keep their own draw.
 */
const PALETTE_BINDING_BYTES = 134_217_728;

/**
 * PRD-238 measurement (2026-08-28, tn-web on NVIDIA/Turing, 3 paired runs, frames 226–899): the
 * 4,096-member rung with 75% outside the frustum reported 4,097 → 1,025 scene draw submissions
 * (culling off → on; the harness excludes one presentation draw) and render.p50 1.60 → 1.10 ms
 * (median of the three p50s, −0.50 ms). Keep culling enabled; the verification record is
 * `docs/verification/runtime-perf-state.md` under PRD-238.
 */
const PER_OBJECT_FRUSTUM_CULLED = true;
const SORT_BATCH_OBJECTS = false;

/**
 * How many uniform-batch members the drift sweep may examine in one frame (PRD-462).
 *
 * The check is what makes the colour lane's per-frame sync ten times the shared lane's: one
 * `Object.values` and one compare per member per frame, measured at 1,126 ns a member, which is
 * 4.61 ms of a 4,096-material frame's 7.5 ms reconcile. Most of those frames are proving that
 * nothing moved, and a game that animates a material's roughness does so on a handful of frames,
 * not on all of them. So the sweep visits this many member positions a frame and carries its
 * cursor across frames: every material is proved within `ceil(members / this)` frames, and the
 * worst case at L4@4,096 is 8 — reported as `materialCheckStaleFrames`, never assumed.
 *
 * 512 is measured, not round: it takes the check from 4.61 ms to ~0.58 ms a frame, which puts
 * L4@4,096's reconcile (3.5 ms) clearly under Godot's 5.95 ms for the same rung, and a smaller
 * budget buys nothing a game can see while lengthening the staleness every frame pays for.
 */
const MATERIAL_CHECKS_PER_FRAME = 512;

interface IBatch {
  readonly mesh: InstancedMesh;
  readonly group: IProjectionBatchGroup;
  /** The group's geometry: one member's, drawn for every member whose geometry has equal bytes. */
  geometry: BufferGeometry;
  readonly material: Material;
  /**
   * True when the members' materials differ only in base colour: `material` is then a clone this
   * mirror owns, and the colour each member draws with lives in the batch's instance colours.
   */
  readonly uniform: boolean;
  /** Source object per instance slot, so a released slot can be reused rather than leaked. */
  readonly instances: Map<Object3D, number>;
  readonly free: number[];
  /** Slots handed out so far, which is also where the next unused one begins. */
  used: number;
  capacity: number;
  /** Whether an instance matrix was written this frame, so the upload is flagged once per batch. */
  dirty: boolean;
  /** Whether an instance colour was written this frame, flagged once per batch for the same reason. */
  colorsDirty: boolean;
}

/**
 * The material-keyed batch: many distinct geometries packed under one material.
 *
 * Unlike `IBatch` this owns copies of vertex data — that is what lets it fold geometries the
 * instanced lane cannot — and so it carries the obligations a copy brings: budgets sized from the
 * whole group before anything is built, a rebuild whenever the group's geometry set changes
 * (`builtRevision` against the group's), and the scan's stream watch demoting any geometry whose
 * versions move after admission. Slots are instance ids exactly as on the instanced lane: hidden
 * rather than deleted when released, so the free list recycles them without touching the batch.
 */
interface IBatched {
  readonly mesh: BatchedMesh;
  readonly group: IProjectionMaterialGroup;
  readonly material: Material;
  /** Source geometry to its packed sub-geometry id. */
  readonly geometries: Map<BufferGeometry, number>;
  /** Source object per instance slot, so a released slot can be reused rather than leaked. */
  readonly instances: Map<Object3D, number>;
  readonly free: number[];
  /** Instance ids handed out so far, which is also where the next unused one begins. */
  used: number;
  capacity: number;
  builtRevision: number;
}

/** What the mirror last knew about a source, so an unchanged source costs a compare and no work. */
interface ISourceState {
  readonly matrixWorld: Matrix4;
  visible: boolean;
  geometry: BufferGeometry | undefined;
  material: Material | Material[] | undefined;
  /** The batch this source is an instance of, so a lane change releases the old slot directly. */
  batch: IBatch | IBatched | SkinnedBatch;
  /**
   * The instance colour last written for this source, as three components. `NaN` on a fresh slot so
   * the first write always happens — a colour that is genuinely `NaN` is not a colour three draws.
   */
  red: number;
  green: number;
  blue: number;
}

function exactObject(entry: IProjectionExactEntry): Object3D {
  if (entry.object === undefined)
    throw new Error("Projection exact entry was cleared before apply.");
  return entry.object;
}

/**
 * A stand-in of the same class as its source, with none of its children.
 *
 * Constructed through the source's own constructor so an unusual `Mesh` subclass keeps whatever
 * its class does at draw time, rather than being flattened into a plain `Mesh` that merely looks
 * like it.
 */
function shallowProxy(object: Object3D): Object3D {
  const source = object as Mesh & {
    isInstancedMesh?: boolean;
    isSkinnedMesh?: boolean;
    isSprite?: boolean;
    isPoints?: boolean;
    isLine?: boolean;
    isLineSegments?: boolean;
    isLineLoop?: boolean;
    isLOD?: boolean;
    count?: number;
  };
  // Constructed by class, not by calling the source's constructor with no arguments.
  //
  // Calling it with none does not fail loudly, which is the problem. `new InstancedMesh()` builds
  // happily with `count` undefined and a zero-length instance buffer — a stand-in that is an
  // `InstancedMesh` by every type check and draws nothing. Nothing throws, nothing warns, and the
  // instances are simply gone: the same shape of defect as the merge that dropped two of three
  // instances, arrived at by a different route. What actually keeps them is
  // `copySpecializedState` below; naming each class here is what makes the stand-in the right size
  // to begin with rather than relying on that repair.
  if (source.isInstancedMesh === true) {
    return new InstancedMesh(source.geometry, source.material as Material, source.count ?? 1);
  }
  if (source.isSkinnedMesh === true) return new SkinnedMesh(source.geometry, source.material);
  if (source.isSprite === true) return new Sprite(source.material as SpriteMaterial);
  if (source.isPoints === true) return new Points(source.geometry, source.material);
  // `LineSegments` and `LineLoop` both set `isLine`, so the flag alone would flatten either into
  // a plain `Line` and draw its separate segments joined end to end.
  if (source.isLineSegments === true) return new LineSegments(source.geometry, source.material);
  if (source.isLineLoop === true) return new LineLoop(source.geometry, source.material);
  if (source.isLine === true) return new Line(source.geometry, source.material);
  if (source.isLOD === true) return new LOD();
  return new Mesh(source.geometry, source.material);
}

/**
 * Copies the state that makes a specialized mesh the thing it is.
 *
 * Shared by reference wherever three.js allows it, so the game animating a skeleton or writing an
 * instance matrix drives what actually draws rather than a copy that stopped tracking it.
 */
function copySpecializedState(source: Object3D, target: Object3D): void {
  const from = source as SkinnedMesh & InstancedMesh & Mesh;
  const to = target as SkinnedMesh & InstancedMesh & Mesh;
  if ((from as { isInstancedMesh?: boolean }).isInstancedMesh === true) {
    to.count = from.count;
    to.instanceMatrix = from.instanceMatrix;
    to.instanceColor = from.instanceColor;
  }
  if ((from as { isSkinnedMesh?: boolean }).isSkinnedMesh === true) {
    // The game's own skeleton, so the bones it animates are the bones that deform this draw.
    to.skeleton = from.skeleton;
    to.bindMatrix = from.bindMatrix;
    to.bindMatrixInverse = from.bindMatrixInverse;
    to.bindMode = from.bindMode;
  }
  // Shared, not copied: a game writing `influences[0] = t` every frame writes into this array.
  to.morphTargetInfluences = from.morphTargetInfluences;
  to.morphTargetDictionary = from.morphTargetDictionary;
}

/**
 * The mirror itself: the private scene the renderer is handed while the projection holds, plus
 * every batch, slot table, stand-in and mirrored light behind it.
 *
 * Constructed and driven only by `SceneRenderProjection`, which keeps the public API, the report
 * assembly and the deoptimization verdict; everything that touches renderer-owned state lives
 * here, so the mutation boundary is one class and restoration has exactly one owner.
 */
export class ProjectionMirror {
  /** Handed to the renderer whenever the projection is faithful. Never shown to the game. */
  readonly scene = new Scene();
  readonly #batches = new Map<IProjectionBatchGroup, IBatch>();
  readonly #materialBatches = new Map<IProjectionMaterialGroup, IBatched>();
  readonly #skinnedBatches = new Map<IProjectionBatchGroup, SkinnedBatch>();
  readonly #state = new Map<Object3D, ISourceState>();
  /** Exact-lane stand-ins, keyed by the source they mirror. */
  readonly #proxies = new Map<Object3D, Object3D>();
  readonly #lightProxies = new Map<Light, Light>();
  /**
   * Each source light's own `shadow.autoUpdate`, captured the frame the mirror took that light's
   * map offline.
   *
   * While the mirror is what draws, the authored scene is not rendered, so the authored light's
   * shadow map is never sampled: three builds a render's lighting from the scene it is handed,
   * which holds the clone, not the source. The clone carries its own `LightShadow` and keeps
   * updating; the source's map is dead work. Three reads `shadow.autoUpdate` per light in
   * `ShadowNode.updateBefore`, so switching the source's off drops that map without touching the
   * shadow camera, map size, bias or flags. The exact authored value comes back in `releaseAll`.
   */
  readonly #lightShadowAutoUpdate = new Map<Light, boolean>();
  readonly #exact = new Map<ProjectionExactReason, number>();
  readonly #exactLane: IProjectionExactEntry[] = [];
  readonly #extraExactPool: IProjectionExactEntry[] = [];
  readonly #lightMembership = new WeakMap<Light, number>();
  #lightGeneration = 0;
  #exactLaneCount = 0;
  #extraExactCount = 0;
  #projectedObjects = 0;
  #compileMs = 0;
  #velocityEnabled: boolean;
  /** Set when a member left a uniform group because its material drifted; read once per frame. */
  #reclassified = false;
  readonly #materialChecks: ProjectionMaterialChecks;
  /** Where the drift sweep resumes: the group and the member offset within it. Persists frames. */
  #sweepGroup = 0;
  #sweepMember = 0;
  /** Uniform members the plan holds, which is what the sweep walks and the bound divides. */
  #sweepTotal = 0;
  /**
   * Materials already proved in the sweep in progress, so a material several members share is
   * compared once per sweep rather than once per member. Bounded by the budget and cleared on
   * every wrap, which is what makes the sweep's own cost a fixed number rather than a scene's.
   */
  readonly #swept = new Set<Material>();
  /** Materials this frame's sweep found drifted; every member holding one leaves its group. */
  readonly #drifted = new Set<Material>();

  constructor(velocityEnabled = false, materialChecks: ProjectionMaterialChecks = "spread") {
    this.#velocityEnabled = velocityEnabled;
    this.#materialChecks = materialChecks;
  }

  /** Rebuilds the private mirror when a temporal chain turns per-object history on or off. */
  setVelocityEnabled(enabled: boolean): boolean {
    if (this.#velocityEnabled === enabled) return false;
    this.releaseAll();
    this.#velocityEnabled = enabled;
    return true;
  }

  get projectedObjects(): number {
    return this.#projectedObjects;
  }

  get batchCount(): number {
    return this.#batches.size + this.#materialBatches.size + this.#skinnedBatches.size;
  }

  /** Batches on the skinned lane — rigs sharing a geometry and material drawn from one palette. */
  get skinnedBatchCount(): number {
    return this.#skinnedBatches.size;
  }

  /** Batches on the instanced lane — one shared geometry instance folded into an `InstancedMesh`. */
  get instancedBatchCount(): number {
    return this.#batches.size;
  }

  /** Batches on the material lane — differing geometries packed into one `BatchedMesh` per material. */
  get materialBatchCount(): number {
    return this.#materialBatches.size;
  }

  get proxyCount(): number {
    return this.#proxies.size;
  }

  get exactCounts(): ReadonlyMap<ProjectionExactReason, number> {
    return this.#exact;
  }

  get compileMs(): number {
    return this.#compileMs;
  }

  /**
   * True when this frame's apply found a member whose material no longer matched the draw it was an
   * instance of. The frame is still correct — that member is now drawn exactly — but the
   * classification that put it there is stale, so the caller re-derives it before the next frame
   * draws. Read once per frame, after `apply`.
   */
  get reclassified(): boolean {
    return this.#reclassified;
  }

  /** Which per-frame material check this mirror runs, for the report and the verdict line. */
  get materialChecks(): ProjectionMaterialChecks {
    return this.#materialChecks;
  }

  /** The per-frame ceiling on drift checks, or 0 when every material is proved every frame. */
  get materialChecksPerFrame(): number {
    return this.#materialChecks === "spread" ? MATERIAL_CHECKS_PER_FRAME : 0;
  }

  /**
   * The worst frames a material edit can sit unproved for: one full sweep of the uniform members
   * at the per-frame budget. 0 in `everyFrame` mode, where every material is proved every frame.
   */
  get materialCheckStaleFrames(): number {
    if (this.#materialChecks === "everyFrame") return 0;
    return Math.ceil(this.#sweepTotal / MATERIAL_CHECKS_PER_FRAME);
  }

  /**
   * Proves a bounded slice of the uniform members' materials, resuming where the last frame stopped.
   *
   * The check itself is unchanged — `uniformUnchanged`, whole own-value list, component reads and
   * `defines` walk. What is bounded is how many members pay for it this frame, and a member whose
   * material is proved drifted is marked here so the loop below ejects every member holding it, in
   * this same frame, exactly as an eager per-member check would have.
   *
   * Deduplicated per sweep rather than per member: a material sixty-four cubes share is one fact,
   * and comparing it sixty-four times a sweep is the cost this exists to remove. The cursor walks
   * member *positions* and wraps, so a scene that grew or shrank mid-sweep still proves every
   * member it currently holds within `ceil(members / budget)` frames.
   */
  #sweepDrift(plan: IProjectionProjectPlan): void {
    this.#drifted.clear();
    let total = 0;
    for (let index = 0; index < plan.batchGroupCount; index += 1) {
      const group = plan.batchGroups[index] as IProjectionBatchGroup;
      if ((group as Partial<IProjectionUniformGroup>).uniform === true) total += group.memberCount;
    }
    this.#sweepTotal = total;
    let group = this.#sweepGroup;
    let member = this.#sweepMember;
    // A plan that shrank under the cursor leaves it past the end, which is the same thing as a
    // finished sweep: start the next one from the top.
    if (group >= plan.batchGroupCount) {
      group = 0;
      member = 0;
      this.#swept.clear();
    }
    let budget = MATERIAL_CHECKS_PER_FRAME;
    while (budget > 0 && group < plan.batchGroupCount) {
      const candidate = plan.batchGroups[group] as IProjectionBatchGroup;
      if ((candidate as Partial<IProjectionUniformGroup>).uniform !== true) {
        group += 1;
        member = 0;
        continue;
      }
      if (member >= candidate.memberCount) {
        group += 1;
        member = 0;
        continue;
      }
      const mesh = candidate.members[member] as Mesh;
      const material = mesh.material as Material;
      if (!this.#swept.has(material)) {
        this.#swept.add(material);
        if (!uniformUnchanged(material)) this.#drifted.add(material);
      }
      member += 1;
      budget -= 1;
    }
    // Step past any group the last visited member exhausted, so a sweep that ends exactly on a
    // slice boundary leaves the cursor on the next member rather than on a spent group — otherwise
    // the next frame spends itself walking off the end and every material waits one frame longer
    // than the bound the report states.
    while (group < plan.batchGroupCount) {
      const candidate = plan.batchGroups[group] as IProjectionBatchGroup;
      if (
        (candidate as Partial<IProjectionUniformGroup>).uniform === true &&
        member < candidate.memberCount
      )
        break;
      group += 1;
      member = 0;
    }
    if (group < plan.batchGroupCount) {
      this.#sweepGroup = group;
      this.#sweepMember = member;
      return;
    }
    // Off the end: the sweep covered every member, and the next one starts from the top with a
    // fresh dedupe set rather than re-proving what this sweep just proved.
    this.#swept.clear();
    this.#sweepGroup = 0;
    this.#sweepMember = 0;
  }

  /** Rebuilds exact-lane tallies and scratch from the scan without copying the entry objects. */
  prepare(exactLane: readonly IProjectionExactEntry[], exactLaneCount: number): void {
    this.#exact.clear();
    this.#exactLaneCount = exactLaneCount;
    this.#extraExactCount = 0;
    for (let index = 0; index < exactLaneCount; index += 1) {
      const entry = exactLane[index] as IProjectionExactEntry;
      this.#exactLane[index] = entry;
      const count = this.#exact.get(entry.reason) ?? 0;
      this.#exact.set(entry.reason, count + 1);
    }
  }

  /**
   * Builds what a project plan describes and brings the mirror in line with the authored scene.
   *
   * Returns the unsupported-light reason when the scene's lights cannot be mirrored honestly —
   * the caller then declines the whole frame. A batch that will not take an object gives up that
   * object, not the scene: dropping several thousand batched props because one of them was
   * awkward would be the fail-open rule applied at exactly the wrong granularity.
   *
   * `retireSources` is the sweep for objects that have left the scene, and a caller that has
   * *proved* the scene's membership is unchanged — the projection's structure proof does exactly
   * that — passes `false` and skips a per-instance walk that cannot find anything. Everything else
   * here still runs: slots, stand-ins and lights are written every frame whatever the sweep does.
   */
  apply(plan: IProjectionProjectPlan, retireSources = true): string | undefined {
    const lightFailure = this.#syncLights(plan.lights, plan.lightCount);
    if (lightFailure !== undefined) {
      this.releaseAll();
      return lightFailure;
    }
    // Groups below the floor join the objects that were never eligible. They keep their own draw,
    // which is what they had. The scratch entries are pooled because this is a per-frame path.
    this.#extraExactCount = 0;
    for (let index = 0; index < plan.belowFloorCount; index += 1) {
      const mesh = plan.belowFloor[index] as Mesh;
      this.#release(mesh);
      this.#appendExact(mesh, "tooFewToBatch");
    }
    // A batch that will not take an object gives up that object, not the scene. Dropping several
    // thousand batched props because one of them was awkward would be the fail-open rule applied
    // at exactly the wrong granularity.
    this.#projectedObjects = 0;
    this.#reclassified = false;
    // Before the member loops, because the loops read what it found: a member whose material this
    // frame's slice proved drifted leaves the group here rather than at the next sweep's turn.
    if (this.#materialChecks === "spread") this.#sweepDrift(plan);
    for (let index = 0; index < plan.batchGroupCount; index += 1) {
      const group = plan.batchGroups[index] as IProjectionBatchGroup;
      const batch = this.#ensureBatch(group);
      for (let member = 0; member < group.memberCount; member += 1) {
        const mesh = group.members[member] as Mesh;
        const refused =
          batch === undefined ? "unsupportedGeometry" : this.#syncBatched(batch, mesh);
        if (refused === undefined) {
          this.#projectedObjects += 1;
          continue;
        }
        // Each refusal names its own cause and every refused mesh keeps a draw of its own: a batch
        // that will not take an object gives up that object, not the scene, and a member whose
        // material drifted out of its group is drawn exactly until the classification catches up.
        this.#release(mesh);
        this.#appendExact(mesh, refused);
      }
      if (batch !== undefined) this.#flushBatch(batch);
    }
    this.#applyMaterialGroups(plan);
    this.#applySkinnedGroups(plan);
    for (let index = 0; index < this.#exactLaneCount; index += 1) {
      const entry = this.#exactLane[index] as IProjectionExactEntry;
      const object = exactObject(entry);
      // An object can change lane while staying in the scene — a material turning transparent, a
      // `renderOrder` being set, a plain mesh swapped for a skinned one. Its batch instance has to
      // go as it acquires a proxy, or the frame draws it twice: once batched and once exactly.
      this.#release(object);
      this.#syncProxy(object);
    }
    if (retireSources) this.#retire(plan.seen, plan.lights, plan.lightCount);
    // After retirement, so a slot freed this frame uploads collapsed rather than one frame late.
    for (const batch of this.#skinnedBatches.values()) batch.end();
    this.#clearExactScratch();
    return undefined;
  }

  /**
   * Applies the plan's skinned groups: one palette draw per group, each rig a slot re-posed from
   * its own skeleton every frame.
   *
   * The world transform is folded into the palette, which is exact only for a similarity
   * transform, so a rig scaled unevenly or mirrored keeps its own draw with that reason named.
   */
  #applySkinnedGroups(plan: IProjectionProjectPlan): void {
    for (let index = 0; index < plan.skinnedGroupCount; index += 1) {
      const group = plan.skinnedGroups[index] as IProjectionBatchGroup;
      const batch = this.#ensureSkinned(group);
      batch?.begin();
      for (let member = 0; member < group.memberCount; member += 1) {
        const rig = group.members[member] as SkinnedMesh;
        const refused = batch === undefined ? "unsupportedGeometry" : this.#syncSkinned(batch, rig);
        if (refused === undefined) {
          this.#projectedObjects += 1;
          continue;
        }
        this.#release(rig);
        this.#appendExact(rig, refused);
      }
    }
  }

  /** Poses one rig in its palette slot, or names why it keeps a draw of its own. */
  #syncSkinned(batch: SkinnedBatch, rig: SkinnedMesh): ProjectionExactReason | undefined {
    if (!isSimilarityTransform(rig.matrixWorld.elements)) {
      return rig.matrixWorld.determinant() <= 0 ? "negativeScale" : "nonUniformScale";
    }
    const slot = this.#claimSkinned(batch, rig);
    if (slot === undefined) return "batchOverflow";
    const state = this.#state.get(rig) as ISourceState;
    const visible = this.#visibleInWorld(rig);
    if (!visible) batch.hide(slot);
    else {
      // A rig coming back into view has collapsed history; it starts from its own pose.
      if (!state.visible) batch.restart(slot);
      batch.write(slot, rig);
    }
    state.visible = visible;
    state.matrixWorld.copy(rig.matrixWorld);
    state.material = rig.material;
    return undefined;
  }

  #claimSkinned(batch: SkinnedBatch, rig: SkinnedMesh): number | undefined {
    const previous = this.#state.get(rig);
    if (previous !== undefined && previous.batch !== batch) this.#release(rig);
    this.#releaseProxy(rig);
    const known = batch.instances.has(rig);
    const slot = batch.claim(rig);
    if (slot === undefined) return undefined;
    if (!known) {
      this.#state.set(rig, {
        matrixWorld: new Matrix4(),
        visible: true,
        geometry: rig.geometry,
        material: rig.material,
        batch,
        red: Number.NaN,
        green: Number.NaN,
        blue: Number.NaN,
      });
    }
    return slot;
  }

  /** The palette draw for one skinned group, rebuilt at a larger size when the group outgrows it. */
  #ensureSkinned(group: IProjectionBatchGroup): SkinnedBatch | undefined {
    const existing = this.#skinnedBatches.get(group);
    if (existing !== undefined && existing.capacity >= group.memberCount) return existing;
    const startedAt = globalThis.performance?.now() ?? 0;
    const first = group.members[0] as SkinnedMesh;
    const rigBytes = first.skeleton.bones.length * 64;
    const capacity = Math.min(
      Math.max(BATCH_MIN_SLOTS, Math.ceil(group.memberCount * BATCH_GROWTH)),
      Math.floor(PALETTE_BINDING_BYTES / rigBytes),
    );
    if (existing !== undefined) {
      if (existing.capacity >= capacity) return existing;
      this.#disposeSkinned(existing);
    }
    let batch: SkinnedBatch;
    try {
      batch = new SkinnedBatch({ first, capacity, velocity: this.#velocityEnabled });
    } catch {
      return undefined;
    }
    this.#skinnedBatches.set(group, batch);
    this.scene.add(batch.mesh);
    this.#compileMs += (globalThis.performance?.now() ?? 0) - startedAt;
    return batch;
  }

  #disposeSkinned(batch: SkinnedBatch): void {
    for (const object of batch.instances.keys()) this.#state.delete(object);
    batch.dispose();
    for (const [group, candidate] of this.#skinnedBatches) {
      if (candidate === batch) this.#skinnedBatches.delete(group);
    }
  }

  #appendExact(object: Object3D, reason: ProjectionExactReason): void {
    const index = this.#extraExactCount;
    this.#extraExactCount += 1;
    let entry = this.#extraExactPool[index];
    if (entry === undefined) {
      entry = { object, reason };
      this.#extraExactPool.push(entry);
    } else {
      entry.object = object;
      entry.reason = reason;
    }
    this.#exactLane[this.#exactLaneCount] = entry;
    this.#exactLaneCount += 1;
    const count = this.#exact.get(reason) ?? 0;
    this.#exact.set(reason, count + 1);
  }

  /**
   * Applies the plan's material-keyed groups: one `BatchedMesh` per group, its members as packed
   * instances.
   *
   * `BatchedMesh.setMatrixAt` does not support negatively scaled matrices — a mirrored source
   * would draw inside-out under front-face culling. The scan reads no world matrices by design,
   * so the gate lives here where they are fresh. Counting viable members before building keeps
   * the invariant that a projected frame never hands the renderer more draw candidates than the
   * authored scene has: a group that cannot fill a batch never builds one.
   */
  #applyMaterialGroups(plan: IProjectionProjectPlan): void {
    for (let index = 0; index < plan.materialGroupCount; index += 1) {
      const group = plan.materialGroups[index] as IProjectionMaterialGroup;
      if (this.#velocityEnabled && !isBatchedMeshVelocityPatched()) {
        for (let member = 0; member < group.memberCount; member += 1) {
          const mesh = group.members[member] as Mesh;
          this.#release(mesh);
          this.#appendExact(mesh, "batchVelocityPatchMissing");
        }
        continue;
      }
      let viableCount = 0;
      for (let member = 0; member < group.memberCount; member += 1) {
        if ((group.members[member] as Mesh).matrixWorld.determinant() > 0) viableCount += 1;
      }
      const attempted = viableCount >= MIN_BATCH_MEMBERS;
      const batch = attempted ? this.#ensureBatched(group) : undefined;
      for (let member = 0; member < group.memberCount; member += 1) {
        const mesh = group.members[member] as Mesh;
        const mirrored = mesh.matrixWorld.determinant() <= 0;
        if (batch !== undefined && !mirrored && this.#syncBatchedMaterial(batch, mesh)) {
          this.#projectedObjects += 1;
          continue;
        }
        // The same report discipline as the instanced loop: each refusal names its own cause,
        // and every refused mesh keeps a draw of its own.
        const reason = mirrored
          ? "negativeScale"
          : !attempted
            ? "tooFewToBatch"
            : batch === undefined
              ? "unsupportedGeometry"
              : "batchOverflow";
        this.#release(mesh);
        this.#appendExact(mesh, reason);
      }
    }
  }

  /**
   * Who owns each object this mirror hands the renderer, built on demand for a diagnostic.
   *
   * The mirror is what the renderer sees, so a per-object cost report reading the authored scene
   * would attribute the frame to objects that were never submitted. Keyed by the rendered object:
   * an exact stand-in names its one source, a batch names every source it folded. Nothing is
   * retained — the map is the caller's, and building it costs one pass over the live entries.
   */
  describeOwnership(): Map<Object3D, IGeometryOwnership> {
    const ownership = new Map<Object3D, IGeometryOwnership>();
    for (const [source, proxy] of this.#proxies) {
      ownership.set(proxy, { kind: "exact", sources: [source] });
    }
    for (const batch of this.#batches.values()) {
      ownership.set(batch.mesh, {
        kind: "instancedBatch",
        sources: [...batch.instances.keys()],
      });
    }
    for (const batch of this.#materialBatches.values()) {
      ownership.set(batch.mesh, {
        kind: "materialBatch",
        sources: [...batch.instances.keys()],
      });
    }
    for (const batch of this.#skinnedBatches.values()) {
      ownership.set(batch.mesh, {
        kind: "instancedBatch",
        sources: [...batch.instances.keys()],
      });
    }
    return ownership;
  }

  /** Drops sources that have left the authored scene, so nothing draws what the game removed. */
  #retire(
    seen: { has(object: Object3D): boolean },
    lights: readonly (Light | undefined)[],
    lightCount: number,
  ): void {
    this.#retireBatches(seen);
    this.#retireMaterialBatches(seen);
    this.#retireSkinnedBatches(seen);
    this.#retireProxies(seen);
    this.#retireLights(lights, lightCount);
  }

  #retireBatches(seen: { has(object: Object3D): boolean }): void {
    for (const batch of this.#batches.values()) {
      for (const object of batch.instances.keys()) {
        if (seen.has(object)) continue;
        const slot = batch.instances.get(object) as number;
        // Collapsed and returned to the free list rather than removed: an `InstancedMesh` has a
        // fixed slot count, and recycling is what lets a level stream objects in and out without
        // rebuilding its draws each time.
        if (slot >= 0) {
          batch.mesh.setMatrixAt(slot, ZERO_MATRIX);
          batch.mesh.instanceMatrix.needsUpdate = true;
        }
        batch.instances.delete(object);
        if (slot >= 0) batch.free.push(slot);
        this.#state.delete(object);
      }
      if (batch.instances.size === 0) this.#disposeBatch(batch);
    }
  }

  /** Retires material-keyed batches on the same hidden-not-deleted free-list discipline. */
  #retireMaterialBatches(seen: { has(object: Object3D): boolean }): void {
    for (const batch of this.#materialBatches.values()) {
      for (const object of batch.instances.keys()) {
        if (seen.has(object)) continue;
        const slot = batch.instances.get(object) as number;
        batch.mesh.setVisibleAt(slot, false);
        batch.instances.delete(object);
        batch.free.push(slot);
        this.#state.delete(object);
      }
      if (batch.instances.size === 0) this.#disposeBatched(batch);
    }
  }

  #retireSkinnedBatches(seen: { has(object: Object3D): boolean }): void {
    for (const batch of this.#skinnedBatches.values()) {
      for (const object of batch.instances.keys()) {
        if (seen.has(object)) continue;
        batch.release(object);
        this.#state.delete(object);
      }
      if (batch.instances.size === 0) this.#disposeSkinned(batch);
    }
  }

  #retireProxies(seen: { has(object: Object3D): boolean }): void {
    for (const object of this.#proxies.keys()) {
      if (seen.has(object)) continue;
      const proxy = this.#proxies.get(object) as Object3D;
      this.scene.remove(proxy);
      this.#proxies.delete(object);
      this.#state.delete(object);
    }
  }

  #retireLights(lights: readonly (Light | undefined)[], lightCount: number): void {
    this.#lightGeneration += 1;
    for (let index = 0; index < lightCount; index += 1) {
      const light = lights[index] as Light;
      this.#lightMembership.set(light, this.#lightGeneration);
    }
    for (const light of this.#lightProxies.keys()) {
      if (this.#lightMembership.get(light) === this.#lightGeneration) continue;
      const proxy = this.#lightProxies.get(light) as Light;
      this.scene.remove(proxy);
      this.#lightProxies.delete(light);
      // A light that leaves the mirror gets its shadow update back now, so a light that returns
      // later is cloned from a source that still updates rather than from the offline state.
      this.#restoreLightShadow(light);
    }
  }

  /** Puts a source light's own shadow-update state back and forgets it. */
  #restoreLightShadow(light: Light): void {
    const original = this.#lightShadowAutoUpdate.get(light);
    if (original === undefined) return;
    this.#lightShadowAutoUpdate.delete(light);
    const shadow = (light as Light & { shadow?: { autoUpdate: boolean } }).shadow;
    if (shadow !== undefined) shadow.autoUpdate = original;
  }

  /**
   * Mirrors the scene's lights.
   *
   * A light cannot be in two graphs at once and moving the game's own light into the mirror would
   * be exactly the destructive rewrite this class exists to stop, so each is cloned once and then
   * kept in step. Only what a game changes at runtime is synchronized; a light form this does not
   * recognize returns false and the whole frame goes to the authored scene, because a scene lit
   * differently from the way the game lit it is a wrong picture, not a slow one.
   */
  #syncLights(lights: readonly (Light | undefined)[], lightCount: number): string | undefined {
    for (let index = 0; index < lightCount; index += 1) {
      const light = lights[index] as Light;
      let proxy = this.#lightProxies.get(light);
      if (proxy === undefined) {
        const cloned = light.clone() as Light & { target?: Object3D };
        if (!isLight(cloned)) return `a ${light.type} could not be mirrored`;
        // A spot or directional light aims at a target object that lives in the game's graph. The
        // clone's own target is a fresh object at the origin, so the mirror would light a
        // different direction; pointing the clone at the authored target keeps the aim.
        const target = (light as Light & { target?: Object3D }).target;
        if (target !== undefined) cloned.target = target;
        cloned.matrixAutoUpdate = false;
        proxy = cloned;
        this.#lightProxies.set(light, cloned);
        this.scene.add(cloned);
      }
      // The local matrix, for the same reason the mesh proxies use it: the renderer recomposes
      // every child's `matrixWorld` from its local matrix, so a light written the other way lights
      // the scene from the origin regardless of where the game put it.
      proxy.matrix.copy(light.matrixWorld);
      proxy.visible = light.visible;
      proxy.intensity = light.intensity;
      (proxy.color as Color | undefined)?.copy(light.color as Color);
      proxy.castShadow = light.castShadow;
      proxy.layers.mask = light.layers.mask;
      // Cone and falloff are runtime surface too: a flashlight zoom or a muzzle-flash decay
      // changes these per frame, and frozen first-frame values would render the scene lit
      // differently than the game lit it.
      if ((light as { isSpotLight?: boolean }).isSpotLight === true) {
        const spot = light as SpotLight;
        const spotProxy = proxy as SpotLight;
        spotProxy.angle = spot.angle;
        spotProxy.penumbra = spot.penumbra;
        spotProxy.distance = spot.distance;
        spotProxy.decay = spot.decay;
        spotProxy.power = spot.power;
      }
      if ((light as { isPointLight?: boolean }).isPointLight === true) {
        const point = light as PointLight;
        const pointProxy = proxy as PointLight;
        pointProxy.distance = point.distance;
        pointProxy.decay = point.decay;
        pointProxy.power = point.power;
      }
      // The clone above copied `autoUpdate` before it was switched off, so the drawn light keeps
      // its shadow. Only the source — whose map nothing samples this frame — is taken offline.
      const shadow = (light as Light & { shadow?: { autoUpdate: boolean } }).shadow;
      if (
        shadow !== undefined &&
        shadow.autoUpdate === true &&
        !this.#lightShadowAutoUpdate.has(light)
      ) {
        this.#lightShadowAutoUpdate.set(light, shadow.autoUpdate);
        shadow.autoUpdate = false;
      }
    }
    return undefined;
  }
  /**
   * Puts an eligible mesh in a batch and keeps it there, in step with its source.
   *
   * The mirror holds the game's own geometry and material by reference, never a copy, so a game
   * that recolours a material recolours every draw sharing it and a game that streams into a
   * geometry changes what draws without the mirror being told anything at all. Nothing here
   * decides how anything looks; it decides only which draw a thing is part of.
   *
   * This is where "the game may change anything at any time" is paid for. Each supported property
   * is compared against what was last pushed and written in place when it differs — a moved object
   * is a matrix write, a hidden one a collapsed matrix. Nothing rebuilds, which is what makes
   * reconciling every frame affordable instead of guessing once at startup and being wrong for the
   * rest of the session.
   *
   * A uniform batch is the one draw that cannot hold the game's material, because it stands for
   * many of them. So the colour is the only value it writes per member, and every *other* value its
   * shared clone was built from is proved unchanged first: a member that drifted leaves the group
   * rather than draw with a roughness, a map or an alpha that is not its own. That is a
   * reclassification rather than a fallback, so the caller is told and the next frame re-derives it.
   *
   * Which frame proves it is the mode's business, not the ejection's. `everyFrame` compares here
   * for every member; `spread` compares a bounded slice of the members in `#sweepDrift` and reads
   * its answer here, so a drifted material costs every member holding it the same frame it was
   * found in, and costs a settled frame nothing.
   */
  #syncBatched(target: IBatch, mesh: Mesh): ProjectionExactReason | undefined {
    const material = mesh.material as Material;
    const geometry = mesh.geometry;
    let state = this.#state.get(mesh);

    // Read before the group comparison below, because a member whose material no longer matches
    // the group is leaving whichever batch it holds: the one it is in would draw it with a
    // roughness, a map or an alpha that is not its own.
    if (
      target.uniform &&
      state !== undefined &&
      (this.#materialChecks === "everyFrame"
        ? !uniformUnchanged(material)
        : this.#drifted.size > 0 && this.#drifted.has(material))
    ) {
      this.#reclassified = true;
      this.#release(mesh);
      return "materialChanged";
    }
    // A geometry, material or flag change moves the object to a different batch entirely, so the
    // old slot is released and it re-enters as if it were new. The group identity covers the
    // shadow flags and layer mask, which change nothing about where an object is but everything
    // about which draw it may share. The release takes the state with it, and the slot is gone
    // with it, so the allocation below is what refills both.
    if (state !== undefined && state.batch !== target) {
      this.#release(mesh);
      state = undefined;
    }
    // A mesh that was on the exact lane last frame and is batchable now must not keep its
    // stand-in, or it draws twice. A scene with no stand-ins is the common case, and this is a map
    // probe per object per frame, so the empty check comes before it.
    if (this.#proxies.size > 0) this.#releaseProxy(mesh);

    let slot = target.instances.get(mesh);
    if (slot === undefined) {
      slot = target.free.pop();
      if (slot === undefined) {
        if (target.used >= target.capacity) return "batchOverflow";
        slot = target.used;
        target.used += 1;
      }
      target.instances.set(mesh, slot);
      // Deliberately unequal to anything real, so the first reconcile below writes the matrix
      // and the visibility rather than assuming the new slot already carries them.
      state = {
        matrixWorld: new Matrix4().multiplyScalar(0),
        visible: !mesh.visible,
        geometry,
        material,
        batch: target,
        red: Number.NaN,
        green: Number.NaN,
        blue: Number.NaN,
      };
      this.#state.set(mesh, state);
    }
    const current = state as ISourceState;
    // Ancestor visibility, not the object's own flag: a prop under a hidden group does not draw,
    // and a batch has no hierarchy to inherit that from.
    const visible = this.#visibleInWorld(mesh);
    // three's `equals` is the element-wise compare, and a host keeping matrices outside the script
    // engine runs it in place instead of copying 32 numbers in.
    if (visible !== current.visible || !current.matrixWorld.equals(mesh.matrixWorld)) {
      current.matrixWorld.copy(mesh.matrixWorld);
      current.visible = visible;
      // An `InstancedMesh` has no per-instance visibility flag, so a hidden object is given a
      // collapsed transform. Every one of its triangles then has zero area and is discarded before
      // rasterisation — the same trick the pass this replaces used, and the only one available
      // that does not disturb the other instances.
      target.mesh.setMatrixAt(slot, visible ? mesh.matrixWorld : ZERO_MATRIX);
      // One flag per batch rather than one per object, applied by the caller: the buffer is
      // uploaded once whatever wrote into it, and a version bump per object is a setter call per
      // object for the same single upload.
      target.dirty = true;
    }
    if (target.uniform) {
      // The only per-member value a uniform draw carries, and the only one a game may move without
      // leaving the group: three floats against what this slot last carried. The shared clone's
      // colour is white, so what three's node material draws is the source colour exactly.
      const color = baseColorOf(material) as Color;
      if (current.red !== color.r || current.green !== color.g || current.blue !== color.b) {
        target.mesh.setColorAt(slot, color);
        current.red = color.r;
        current.green = color.g;
        current.blue = color.b;
        target.colorsDirty = true;
      }
    }
    current.geometry = geometry;
    current.material = material;
    current.batch = target;
    return undefined;
  }

  /** Whether the game currently wants this object drawn, ancestors included. */
  #visibleInWorld(object: Object3D): boolean {
    // A host whose parents cost a call and an allocation each answers for the whole chain.
    const host = (object as { __tnVisibleInWorld?: () => boolean }).__tnVisibleInWorld;
    if (typeof host === "function") return host.call(object);
    for (let node: Object3D | null = object; node !== null; node = node.parent) {
      if (!node.visible) return false;
    }
    return true;
  }

  /**
   * Ends a batch's frame: one upload flag and one draw count for every slot written into it.
   *
   * Both were per object before, and both are per buffer: `needsUpdate` is a version bump the
   * renderer reads once, whatever wrote into the array behind it, and `count` is the number of slots
   * the batch has handed out — which only the last object of the loop could state correctly anyway.
   */
  #flushBatch(batch: IBatch): void {
    batch.mesh.count = batch.used;
    if (batch.dirty) {
      batch.dirty = false;
      batch.mesh.instanceMatrix.needsUpdate = true;
    }
    if (!batch.colorsDirty) return;
    batch.colorsDirty = false;
    (batch.mesh.instanceColor as { needsUpdate: boolean }).needsUpdate = true;
  }

  /**
   * The batch for one (geometry, material, flags) group, sized to hold it.
   *
   * `InstancedMesh` rather than `BatchedMesh`, and the difference is measured rather than
   * stylistic. Three's WebGPU backend has no multi-draw path: it walks a `BatchedMesh` and issues
   * one `drawIndexed` per sub-draw, so a thousand batched objects still cost a thousand draw
   * commands. An `InstancedMesh` is one draw command for the whole group. It also references the
   * game's geometry rather than copying it into a private buffer, so a game streaming into its own
   * attribute needs no re-upload here at all — the batch is already looking at the same array.
   *
   * The price is that a group must share one geometry, where a `BatchedMesh` can hold several. A
   * level of mixed props therefore gets one draw per distinct prop kind instead of one per
   * material, which on the workloads measured is still the overwhelming majority of the reduction.
   */
  #ensureBatch(group: IProjectionBatchGroup): IBatch | undefined {
    const existing = this.#batches.get(group);
    // The member it drew from left the group or the scene; any member that stayed draws the same bytes.
    if (existing !== undefined && existing.geometry !== group.geometry) {
      existing.geometry = group.geometry;
      existing.mesh.geometry = group.geometry;
    }
    if (existing !== undefined && existing.capacity >= group.memberCount) return existing;
    const capacity = Math.max(BATCH_MIN_SLOTS, Math.ceil(group.memberCount * BATCH_GROWTH));
    const first = group.members[0] as Mesh;
    if (existing !== undefined) this.#disposeBatch(existing);
    return this.#createBatch(group, first, capacity);
  }

  #createBatch(group: IProjectionBatchGroup, first: Mesh, capacity: number): IBatch | undefined {
    const startedAt = globalThis.performance?.now() ?? 0;
    const uniform = (group as Partial<IProjectionUniformGroup>).uniform === true;
    // A uniform group stands for many materials, so it cannot draw any of them: it draws a clone the
    // mirror owns, identical to the group's representative except that its base colour is white and
    // each instance carries its own. A clone rather than the representative because the
    // representative is the game's, and a recolour of it must not reach the shared draw — and
    // because the game's instance is still what 64 cubes hold, and one draw may not have 64 owners.
    const material = uniform
      ? whiteClone(first.material as Material)
      : (first.material as Material);
    let mesh: InstancedMesh;
    try {
      mesh = new InstancedMesh(group.geometry, material, capacity);
    } catch {
      return undefined;
    }
    // Every slot starts collapsed. A slot that is allocated but not yet written would otherwise
    // draw the geometry at the origin for one frame — a prop flashing at world zero on the frame
    // the batch grows.
    for (let slot = 0; slot < capacity; slot += 1) mesh.setMatrixAt(slot, ZERO_MATRIX);
    mesh.instanceMatrix.needsUpdate = true;
    // Allocates the buffer three fills with the identity, so only the slots a member actually claims
    // are ever written. Seeded from the clone's own colour, which is that identity: this is three's
    // allocation path, not a private buffer the renderer would not know to bind.
    if (uniform) mesh.setColorAt(0, (material as Material & { color: Color }).color);
    // The batch spans wherever its instances are, so a bounding test on the whole thing can only
    // ever answer "visible" and is pure cost.
    mesh.frustumCulled = false;
    // Carried from the sources rather than defaulted. The batch is one object to the renderer, so
    // these are the batch's, and every mesh in it agreed on them — that is what the group means.
    mesh.castShadow = first.castShadow;
    mesh.receiveShadow = first.receiveShadow;
    mesh.layers.mask = first.layers.mask;
    const batch: IBatch = {
      mesh,
      group,
      geometry: group.geometry,
      material,
      uniform,
      instances: new Map(),
      free: [],
      used: 0,
      capacity,
      dirty: false,
      colorsDirty: false,
    };
    this.#batches.set(group, batch);
    this.scene.add(mesh);
    this.#compileMs += (globalThis.performance?.now() ?? 0) - startedAt;
    return batch;
  }

  /**
   * The batch for one material group, rebuilt whenever the group's geometry set or size outgrows it.
   *
   * `BatchedMesh` rather than a second instancing pass, and that is the whole point of the lane:
   * it holds *many geometries* under *one material*, which is what a town of unique buildings over
   * shared surfaces needs and what an `InstancedMesh` cannot hold. On three's WebGPU backend the
   * batch is walked as one render object — one pipeline and bind-group setup, one sort entry, no
   * per-source matrix pass — with a `drawIndexed` per packed sub-geometry inside it. The draw-count
   * win is counted from the scene the renderer walks, which is what `resultDrawCandidates` has
   * always measured.
   *
   * Unlike the instanced lane, the packed copies are obligations: budgets are summed from every
   * distinct geometry before construction so nothing overflows mid-build, and the scan's stream
   * watch demotes any geometry whose versions move — so a copy never outlives the data it was made
   * from by even one frame.
   */
  #ensureBatched(group: IProjectionMaterialGroup): IBatched | undefined {
    const startedAt = globalThis.performance?.now() ?? 0;
    const existing = this.#materialBatches.get(group);
    if (
      existing !== undefined &&
      existing.builtRevision === group.revision &&
      existing.capacity >= group.memberCount
    ) {
      return existing;
    }
    if (existing !== undefined) this.#disposeBatched(existing);
    const capacity = Math.max(BATCH_MIN_SLOTS, Math.ceil(group.memberCount * BATCH_GROWTH));
    // Sized from the whole group before anything is built; an overflow throw mid-build would
    // otherwise leave a half-packed batch to dispose around.
    let vertexBudget = 0;
    let indexBudget = 0;
    for (const geometry of group.geometries.keys()) {
      const position = geometry.getAttribute("position");
      const vertices = position === undefined ? 0 : position.count;
      vertexBudget += vertices;
      const index = geometry.getIndex();
      indexBudget += index === null ? vertices : index.count;
    }
    const reference = group.members[0] as Mesh;
    const indexed = reference.geometry.getIndex() !== null;
    let mesh: BatchedMesh;
    try {
      mesh = new BatchedMesh(
        capacity,
        Math.ceil(vertexBudget * BATCH_GROWTH),
        indexed ? Math.ceil(indexBudget * BATCH_GROWTH) : 0,
        group.material,
      );
    } catch {
      return undefined;
    }
    // A source with frustumCulled=false may have shader-displaced vertices outside its authored
    // bounds. Keep that member in a batch that never applies BatchedMesh's bound-based culling;
    // the planner makes the flag uniform for every member in this batch.
    mesh.perObjectFrustumCulled = PER_OBJECT_FRUSTUM_CULLED && group.frustumCulled;
    mesh.sortObjects = SORT_BATCH_OBJECTS;
    mesh.frustumCulled = false;
    if (this.#velocityEnabled) {
      ensureBatchedMeshVelocity(mesh);
    }
    // Carried from the sources, exactly as the instanced lane carries them: every member agreed,
    // because the flags are part of what keyed the group.
    mesh.castShadow = reference.castShadow;
    mesh.receiveShadow = reference.receiveShadow;
    mesh.layers.mask = reference.layers.mask;
    const batch: IBatched = {
      mesh,
      group,
      material: group.material,
      geometries: new Map(),
      instances: new Map(),
      free: [],
      used: 0,
      capacity,
      builtRevision: group.revision,
    };
    try {
      for (const geometry of group.geometries.keys()) {
        batch.geometries.set(geometry, mesh.addGeometry(geometry));
      }
    } catch {
      mesh.dispose();
      return undefined;
    }
    this.#materialBatches.set(group, batch);
    this.scene.add(mesh);
    this.#compileMs += (globalThis.performance?.now() ?? 0) - startedAt;
    return batch;
  }

  /**
   * Puts an eligible mesh into its material-keyed batch and keeps it there, in step with its
   * source. Slot bookkeeping is the instanced lane's exactly — allocate once, then per-frame
   * matrix and visibility compares — with `setVisibleAt` doing natively what a collapsed matrix
   * does on the other lane.
   */
  #syncBatchedMaterial(target: IBatched, mesh: Mesh): boolean {
    const previous = this.#state.get(mesh);
    if (previous !== undefined && previous.batch !== target) this.#release(mesh);
    this.#releaseProxy(mesh);

    let slot = target.instances.get(mesh);
    const newSlot = slot === undefined;
    if (slot === undefined) {
      if (target.used >= target.capacity) return false;
      const geometryId = target.geometries.get(mesh.geometry);
      // A geometry that joined the group after this batch was built cannot be packed into it
      // here; the revision bump routes the whole group through a rebuild next frame.
      if (geometryId === undefined) return false;
      try {
        slot = target.mesh.addInstance(geometryId);
      } catch {
        return false;
      }
      target.used += 1;
      target.instances.set(mesh, slot);
      this.#state.set(mesh, {
        // Deliberately unequal to anything real, so the first reconcile below writes the matrix
        // and the visibility rather than assuming the new slot already carries them.
        matrixWorld: new Matrix4().multiplyScalar(0),
        visible: !mesh.visible,
        geometry: mesh.geometry,
        material: mesh.material,
        batch: target,
        red: Number.NaN,
        green: Number.NaN,
        blue: Number.NaN,
      });
    }

    const state = this.#state.get(mesh) as ISourceState;
    const visible = this.#visibleInWorld(mesh);
    const matrixChanged = !state.matrixWorld.equals(mesh.matrixWorld);
    if (visible !== state.visible || matrixChanged) {
      if (this.#velocityEnabled) {
        const previousMatrix =
          newSlot || (!state.visible && visible) ? mesh.matrixWorld : state.matrixWorld;
        setBatchedMeshMatrixWithVelocity(target.mesh, slot, mesh.matrixWorld, previousMatrix);
      } else target.mesh.setMatrixAt(slot, mesh.matrixWorld);
      state.matrixWorld.copy(mesh.matrixWorld);
      state.visible = visible;
      target.mesh.setVisibleAt(slot, visible);
    } else if (this.#velocityEnabled) {
      const previousMatrix =
        newSlot || (!state.visible && visible) ? mesh.matrixWorld : state.matrixWorld;
      setBatchedMeshPreviousMatrix(target.mesh, slot, previousMatrix);
    }
    state.geometry = mesh.geometry;
    state.material = mesh.material;
    state.batch = target;
    return true;
  }

  /** Removes a batch from the mirror and releases the buffers it owns. */
  #disposeBatch(batch: IBatch): void {
    this.scene.remove(batch.mesh);
    // The instance matrices are the batch's own; the geometry and material are the game's and are
    // deliberately left alone — unless this is a uniform draw, where the material is the mirror's
    // own clone and nobody else's.
    batch.mesh.dispose();
    if (batch.uniform) batch.material.dispose();
    for (const object of batch.instances.keys()) this.#state.delete(object);
    this.#batches.delete(batch.group);
  }

  /**
   * Removes a material-keyed batch from the mirror.
   *
   * `BatchedMesh.dispose()` releases the packed vertex/index copies and the instance textures the
   * batch owns; the source geometries were only read from, never adopted, and stay the game's.
   */
  #disposeBatched(batch: IBatched): void {
    this.scene.remove(batch.mesh);
    if (this.#velocityEnabled) disposeBatchedMeshVelocity(batch.mesh);
    batch.mesh.dispose();
    for (const object of batch.instances.keys()) this.#state.delete(object);
    this.#materialBatches.delete(batch.group);
  }

  /**
   * Keeps an exact-lane stand-in in step with its source.
   *
   * The proxy shares the source's geometry and material by reference — it is the same buffer and
   * the same material instance, so a game recolouring the original recolours what draws — and
   * carries the composed world matrix rather than a hierarchy, because the hierarchy above it is
   * in the authored scene where it belongs.
   */
  #syncProxy(object: Object3D): void {
    let proxy = this.#proxies.get(object);
    let fresh = false;
    if (proxy === undefined) {
      // `Object3D.prototype.clone` would deep-copy children the mirror does not want; a shallow
      // stand-in of the same class is what an exact draw needs.
      proxy = shallowProxy(object);
      proxy.matrixAutoUpdate = false;
      this.#proxies.set(object, proxy);
      fresh = true;
      observeAnimationRates(proxy, new Map([[object, 0]]));
      // An `LOD` picks one of its levels by distance every frame, and it does that on itself. Its
      // levels therefore have to hang off the stand-in, or nothing selects one and the mirror
      // draws whichever rung happened to be visible when it was built.
      this.#buildLevels(object, proxy);
    }
    const source = object as Mesh;
    const target = proxy as Mesh;
    target.geometry = source.geometry;
    target.material = source.material;
    copySpecializedState(object, proxy);
    // Written into the *local* matrix, not `matrixWorld`, and this is not a detail.
    //
    // The renderer calls `updateMatrixWorld()` on whatever scene it is handed. A `Scene` composes
    // its own matrix every frame, which sets `matrixWorldNeedsUpdate`, which forces every child to
    // recompute `matrixWorld` from its local matrix — so anything written straight into
    // `matrixWorld` is overwritten before a single triangle is drawn, and every proxy in the mirror
    // renders at the world origin. Writing the local matrix instead survives that recomputation,
    // because the mirror's root is an identity transform and `identity × matrix` is the world
    // matrix the source had.
    target.matrix.copy(object.matrixWorld);
    target.visible = this.#visibleInWorld(object);
    target.renderOrder = object.renderOrder;
    target.castShadow = object.castShadow;
    target.receiveShadow = object.receiveShadow;
    target.frustumCulled = object.frustumCulled;
    target.layers.mask = object.layers.mask;
    // Added only once it is fully populated, never before.
    //
    // A `SkinnedMesh` built by its constructor has no `skeleton` until one is assigned, and
    // three.js reads `skeleton.bones.length` while it compiles the shader for that object. A
    // stand-in that is visible to the renderer for even one frame between construction and
    // assignment throws there, per frame, for as long as the material stays uncompiled — which is
    // a torrent of console errors and no drawn character.
    if (fresh) this.scene.add(proxy);
  }

  /**
   * Releases one source's instance without disturbing the rest of its batch.
   *
   * The batch is retained on the source state rather than found by searching every batch. Searching
   * is what makes a lane change cost the number of batches in the scene, and lane changes happen
   * per object per frame.
   */
  #release(object: Object3D): void {
    const state = this.#state.get(object);
    const batch = state === undefined ? undefined : state.batch;
    if (batch instanceof SkinnedBatch) {
      batch.release(object);
      this.#state.delete(object);
      return;
    }
    const slot = batch?.instances.get(object);
    if (batch !== undefined && slot !== undefined) {
      // Hidden or collapsed before the slot is handed back, so a freed slot draws nothing until
      // something else claims it. Reusing slots rather than rebuilding the batch is what keeps a
      // level that streams objects in and out from rebuilding its draws every time it does.
      if ((batch as IBatch).mesh.isInstancedMesh === true) {
        if (slot >= 0) {
          (batch as IBatch).mesh.setMatrixAt(slot, ZERO_MATRIX);
          (batch as IBatch).mesh.instanceMatrix.needsUpdate = true;
        }
      } else {
        (batch as IBatched).mesh.setVisibleAt(slot, false);
      }
      batch.instances.delete(object);
      if (slot >= 0) batch.free.push(slot);
    }
    this.#state.delete(object);
  }

  /**
   * Gives an `LOD` stand-in the same levels, at the same distances, as the source.
   *
   * `LOD.update()` runs on the container and toggles its children by camera distance, so the
   * levels must be children of the stand-in for any of that to happen. Each level draws the
   * source's own geometry and material; only the container is new.
   */
  #buildLevels(object: Object3D, proxy: Object3D): void {
    if ((object as { isLOD?: boolean }).isLOD !== true) return;
    const source = object as LOD;
    const target = proxy as LOD;
    for (const level of source.levels) {
      const mesh = shallowProxy(level.object);
      copySpecializedState(level.object, mesh);
      mesh.matrix.copy(level.object.matrix);
      mesh.matrixAutoUpdate = false;
      target.addLevel(mesh, level.distance, level.hysteresis);
    }
  }

  /** Drops an exact-lane stand-in, for a source that no longer needs one. */
  #releaseProxy(object: Object3D): void {
    const proxy = this.#proxies.get(object);
    if (proxy === undefined) return;
    this.scene.remove(proxy);
    this.#proxies.delete(object);
  }

  #clearExactScratch(): void {
    for (let index = 0; index < this.#exactLaneCount; index += 1) {
      const entry = this.#exactLane[index] as IProjectionExactEntry;
      entry.object = undefined;
    }
    for (let index = 0; index < this.#extraExactPool.length; index += 1) {
      const entry = this.#extraExactPool[index] as IProjectionExactEntry;
      entry.object = undefined;
    }
    this.#exactLaneCount = 0;
    this.#extraExactCount = 0;
  }

  /** Tears the mirror down, leaving the authored scene untouched, as it has been throughout. */
  releaseAll(): void {
    for (const batch of this.#batches.values()) {
      this.scene.remove(batch.mesh);
      batch.mesh.dispose();
      if (batch.uniform) batch.material.dispose();
    }
    this.#batches.clear();
    for (const batch of this.#materialBatches.values()) {
      this.scene.remove(batch.mesh);
      if (this.#velocityEnabled) disposeBatchedMeshVelocity(batch.mesh);
      batch.mesh.dispose();
    }
    this.#materialBatches.clear();
    for (const batch of this.#skinnedBatches.values()) batch.dispose();
    this.#skinnedBatches.clear();
    for (const proxy of this.#proxies.values()) this.scene.remove(proxy);
    this.#proxies.clear();
    for (const proxy of this.#lightProxies.values()) this.scene.remove(proxy);
    this.#lightProxies.clear();
    for (const light of this.#lightShadowAutoUpdate.keys()) this.#restoreLightShadow(light);
    this.#state.clear();
    this.#exact.clear();
    this.#clearExactScratch();
    this.#projectedObjects = 0;
  }

  /**
   * What the mirror currently holds for one source object, or `undefined` if it holds nothing.
   *
   * Bounded diagnostics, for the load test and the unit tests: it answers "is this object being
   * drawn, on which lane, and with what transform and visibility" without exposing the batches or
   * the reconciliation state. Games never call this — there is no optimizer API in generated
   * source, and this class is not part of the package's public surface — but a benchmark that
   * cannot ask what the renderer was given can only report intent, and intent is not evidence.
   */
  inspect(
    object: Object3D,
  ): { lane: "batched" | "exact"; matrixWorld: Matrix4; visible: boolean } | undefined {
    const proxy = this.#proxies.get(object);
    if (proxy !== undefined) {
      return {
        lane: "exact",
        matrixWorld: new Matrix4().copy(proxy.matrix),
        visible: proxy.visible,
      };
    }
    const state = this.#state.get(object);
    if (state === undefined) return undefined;
    const batch = state.batch;
    const slot = batch?.instances.get(object);
    if (batch === undefined || slot === undefined) return undefined;
    const matrixWorld = new Matrix4();
    // Both lanes answer the same way; which primitive backs the batch is not the caller's business.
    if (batch instanceof SkinnedBatch) {
      matrixWorld.copy(state.matrixWorld);
    } else if ((batch as IBatch).mesh.isInstancedMesh === true && slot < 0) {
      matrixWorld.copy(state.matrixWorld);
    } else {
      batch.mesh.getMatrixAt(slot, matrixWorld);
    }
    return { lane: "batched", matrixWorld, visible: state.visible };
  }

  /** True when some batch in the mirror draws with this exact material instance. */
  drawsWith(material: Material): boolean {
    for (const batch of this.#batches.values()) {
      if (batch.material === material) return true;
    }
    for (const batch of this.#materialBatches.values()) {
      if (batch.material === material) return true;
    }
    for (const batch of this.#skinnedBatches.values()) {
      if (batch.sourceMaterial === material) return true;
    }
    for (const proxy of this.#proxies.values()) {
      if ((proxy as Mesh).material === material) return true;
    }
    return false;
  }
}
