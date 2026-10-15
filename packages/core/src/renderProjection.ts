import type { Camera, Material, Matrix4, Object3D, Scene } from "three";

import type { IGeometryOwnership } from "./geometry-capture.js";
import type { MatrixWorldPass } from "./matrix-world.js";
import { ProjectionMirror } from "./projection-apply.js";
import {
  type IProjectionProjectPlan,
  createProjectionScanWorkspace,
  isRenderable,
  releaseProjectionScanWorkspace,
  scanProjection,
} from "./projection-plan.js";
import { ProjectionStability } from "./projection-stability.js";
import { VelocityTracker } from "./render/velocity.js";

/**
 * An optimizer that the game never has to know about.
 *
 * The pass this replaces reached its draw count by consuming the scene: it merged what it judged
 * static into one buffer and lifted the sources out of the graph. That is only correct while the
 * judgement holds, and the judgement is a guess made from eight frames about arbitrary JavaScript
 * that has not run yet. When it was wrong the game did not get a slow frame, it got a wrong one —
 * a mesh that stopped moving, a hidden prop that drew anyway, two of three instances gone — and
 * the pass still reported success.
 *
 * So the ownership is inverted here. **Correct rendering is unconditional; optimization is
 * opportunistic.** The game's scene stays exactly as the game authored it — same objects, same
 * parents, same names, same traversal, same `raycast` results — and the renderer is handed a
 * private mirror of it instead. Eligible meshes reach that mirror as instances of an
 * `InstancedMesh`, so thousands of them cost one draw each group; everything else reaches it as an
 * exact proxy. When the mirror cannot reproduce something faithfully, the mirror is abandoned for
 * that frame and the authored scene is rendered directly. That fallback is a correct slow path, not
 * an error, and nothing about it is configurable.
 *
 * `InstancedMesh` is stock `three`, and using it rather than a bespoke merge is the point:
 * per-object matrices and instance reuse are things it already does, and it points at the game's
 * own geometry rather than copying it. Reconciling a moved object is a matrix write, not a rebuild,
 * which is what makes "the game may change anything at any time" affordable rather than
 * aspirational.
 *
 * Since P2-3 the class composes two seams instead of owning every concern itself: the pure scan
 * and plan (`projection-plan.ts`) decides what a frame will do, and the mirror
 * (`projection-apply.ts`) applies it and owns every mutation and restoration path. This file keeps
 * the public API, the reconciliation loop, the report assembly and the deoptimization verdict.
 */

/** Why the projection gave a frame back to the authored scene, or declined an object. */
export type ProjectionReasonCode =
  | "projected"
  | "belowMeshFloor"
  | "renderHook"
  | "unsupportedLight"
  | "unsupportedObject"
  | "notWorthwhile"
  | "disabled";

export type ProjectionExactReason =
  | "instanced"
  | "skinned"
  | "morph"
  | "multiMaterial"
  | "drawRange"
  | "indirect"
  | "customDepthMaterial"
  | "lod"
  | "sprite"
  | "points"
  | "transparent"
  | "vertexDisplaced"
  | "renderOrder"
  | "tooFewToBatch"
  | "batchOverflow"
  | "batchVelocityPatchMissing"
  | "materialChanged"
  | "negativeScale"
  | "nonUniformScale"
  | "unsupportedGeometry";

/**
 * How often a uniform-batch member's material is proved still matching its group's shared draw.
 *
 * - `"spread"` — the default. A bounded slice of the members a frame, resuming where the last frame
 *   stopped, so a frame proves `materialChecksPerFrame` materials rather than all of them. A
 *   non-colour edit is still caught and the member still leaves the group; it is caught up to
 *   `materialCheckStaleFrames` frames later, which the report states. A colour edit is never
 *   involved: the per-instance colour write is O(1) per member and always exact.
 * - `"everyFrame"` — every material, every frame, for a game that would rather pay the per-frame
 *   cost than accept the bound. This is the check as it shipped before the sweep existed.
 */
export type ProjectionMaterialChecks = "spread" | "everyFrame";

export interface IRenderProjectionReport {
  readonly schemaVersion: 1;
  /** True while the renderer is being handed the mirror rather than the authored scene. */
  readonly projecting: boolean;
  readonly reasonCode: ProjectionReasonCode;
  readonly reason?: string;
  /** Renderables the authored scene holds — what an unoptimized frame would walk and draw. */
  readonly sourceRenderables: number;
  /**
   * Objects the renderer will actually walk, counted from the scene it is handed rather than from
   * what this class believes it built. A count taken from intent rather than from the renderer's
   * input is how an optimizer reports a win it did not deliver.
   */
  readonly resultDrawCandidates: number;
  /** Sources folded into batched draws, and the number of draws they became. */
  readonly projectedObjects: number;
  readonly batches: number;
  /** The batch split by lane, so a report reader can tell which grouping did the folding. */
  readonly instancedBatches: number;
  readonly materialBatches: number;
  /** Palette draws on the skinned lane: rigs sharing geometry and material, one draw per pass. */
  readonly skinnedBatches: number;
  /** Sources that kept a draw of their own, with the reason each one did. */
  readonly exactObjects: number;
  readonly exact: Partial<Record<ProjectionExactReason, number>>;
  /**
   * What the plan believes this frame costs: one draw per batch plus one per exact-lane object.
   *
   * **A plan, not a measurement.** On WebGPU a `BatchedMesh` is one render object that issues one
   * `drawIndexed` per visible member, so a batch is not reliably one draw and this number can be
   * optimistic. The measured count comes from the renderer and is reported beside this one; a
   * divergence between them is a finding, not a rounding error.
   */
  readonly drawsPlanned: number;
  /**
   * The colour lane's per-frame material proof: which mode, what it costs a frame, and the worst
   * staleness it accepts.
   *
   * `materialChecks` is the mode in force, `materialChecksPerFrame` the ceiling on checks a frame
   * (`0` in `everyFrame`, which is not bounded because it is not spread), and
   * `materialCheckStaleFrames` the frames a non-colour material edit can sit unproved for — `0`
   * under `everyFrame`, so the number is never read as a bound that does not exist.
   * `materialChecksOverridden` says the author chose a mode other than the default.
   */
  readonly materialChecks: ProjectionMaterialChecks;
  readonly materialChecksPerFrame: number;
  readonly materialCheckStaleFrames: number;
  readonly materialChecksOverridden: boolean;
  readonly timings: {
    readonly compileMs: number;
    readonly reconcileMs: number;
    readonly lastReconcileMs: number;
    readonly maxReconcileMs: number;
  };
}

export interface IRenderProjectionOptions {
  /**
   * Below this many eligible meshes the mirror costs more to maintain than the draws it saves, so
   * the authored scene is rendered directly and nothing is built.
   */
  readonly minMeshes?: number;
  /**
   * The game's `renderer.projection` value, verbatim: `false` declines the projection, and an
   * object names the material check on top of accepting it. `undefined` and `true` are the shipping
   * behaviour, the projection runs.
   *
   * `materialChecks` defaults to `"spread"` — a bounded slice of the batched materials proved per
   * frame, with the staleness it accepts reported — and `"everyFrame"` restores the per-member,
   * per-frame proof exactly as it shipped. Any other value throws at construction rather than being
   * coerced to a default, because a silently ignored mode is a measurement nobody can trust.
   *
   * A declined projection builds no mirror and runs no eligibility scan — the authored scene is
   * handed to the renderer every frame — so declining costs nothing rather than being re-judged
   * each frame. The verdict is reported as `disabled`, not as one of the measured declines.
   */
  readonly projection?: boolean | { readonly materialChecks?: ProjectionMaterialChecks };
  /** Retains drawn-object history for temporal stages, independently of projection opt-out. */
  readonly velocity?: boolean | (() => boolean);
  /**
   * The engine's world-matrix walk, when the frame owns one. The authored scene is refreshed here
   * rather than by three's renderer, because the renderer is handed the mirror: without this the
   * authored scene would never be walked and every proxy would be one frame stale.
   */
  readonly matrixWorld?: MatrixWorldPass;
  readonly onReport?: (report: IRenderProjectionReport) => void;
}

export { exactLaneReason } from "./projection-plan.js";

/**
 * How many settled-declined frames pass between classification re-walks.
 *
 * Growth past the mesh floor is noticed within this window; a scene that never changes pays one
 * walk per window instead of one per frame. Sub-second at frame rate, and invisible — the
 * alternative state it delays is "the optimizer has not engaged yet", not a wrong frame.
 */
const DECLINE_RESCAN_FRAMES = 60;

export class SceneRenderProjection {
  readonly #source: Scene;
  readonly #minMeshes: number;
  readonly #enabled: boolean;
  readonly #materialChecks: ProjectionMaterialChecks;
  readonly #onReport: ((report: IRenderProjectionReport) => void) | undefined;
  /** Absent when the game opted out: an opted-out projection never builds one. */
  readonly #mirror: ProjectionMirror | undefined;
  readonly #velocity: boolean | (() => boolean);
  readonly #matrixWorld: MatrixWorldPass | undefined;
  readonly #velocityTracker = new VelocityTracker();
  readonly #scanWorkspace = createProjectionScanWorkspace();
  /**
   * What the last projecting scan classified, kept so a frame that can prove the structure unchanged
   * can skip re-deriving it, and the proof itself.
   *
   * The plan points into the scan workspace, which is only rewritten by the next scan — and a scan
   * only runs when the proof has failed, so a retained plan is never read after the arrays behind
   * it move. Any decline, release or velocity change drops it: the mirror it described is gone.
   */
  readonly #stability = new ProjectionStability();
  #retainedPlan: IProjectionProjectPlan | undefined;
  #deoptimized = true;
  #reasonCode: ProjectionReasonCode = "belowMeshFloor";
  #reason: string | undefined;
  #sourceRenderables = 0;
  #reconcileMs = 0;
  #lastReconcileMs = 0;
  #maxReconcileMs = 0;
  #reported = false;
  #lastAnnounced: ProjectionReasonCode | undefined;
  #framesSinceDeclineScan = DECLINE_RESCAN_FRAMES;
  #velocityActive: boolean;

  constructor(source: Scene, options: IRenderProjectionOptions = {}) {
    const minMeshes = options.minMeshes ?? 200;
    if (!Number.isInteger(minMeshes) || minMeshes < 1)
      throw new Error("SceneRenderProjection.minMeshes must be a positive integer.");
    this.#source = source;
    this.#minMeshes = minMeshes;
    this.#enabled = options.projection !== false;
    this.#materialChecks = resolveMaterialChecks(
      typeof options.projection === "object" ? options.projection.materialChecks : undefined,
    );
    this.#velocity = options.velocity ?? false;
    this.#velocityActive = resolveVelocityEnabled(this.#velocity);
    this.#matrixWorld = options.matrixWorld;
    this.#mirror = this.#enabled
      ? new ProjectionMirror(this.#velocityActive, this.#materialChecks)
      : undefined;
    this.#onReport = options.onReport;
  }

  /** True while the renderer is being handed the authored scene rather than the mirror. */
  get deoptimized(): boolean {
    return this.#deoptimized;
  }

  /**
   * The scene to draw this frame — the mirror when it is faithful, the authored scene when it is
   * not. Callers render whatever this returns and never branch on which one it was.
   */
  /**
   * Who owns each object the renderer is handed, for a per-object diagnostic. Empty when the
   * mirror is off or deoptimized — the authored scene is then what rendered, and every object
   * already is its own source. Built on demand and retained by nobody.
   */
  describeOwnership(): ReadonlyMap<Object3D, IGeometryOwnership> {
    if (this.#deoptimized || this.#mirror === undefined) return new Map();
    return this.#mirror.describeOwnership();
  }

  get root(): Scene {
    if (this.#deoptimized || this.#mirror === undefined) return this.#source;
    return this.#mirror.scene;
  }

  /**
   * Brings the mirror up to date with the authored scene, and must run before the frame draws.
   *
   * Everything the mirror asserts about a source is re-derived here rather than remembered from
   * startup: where it is, whether it is visible, what geometry and material it has, and whether it
   * is still in the scene at all. A source that did not change costs a compare.
   *
   * What is re-derived *every* frame is the maintenance — the matrix, the visibility, the batch
   * slot, the stand-in, the mirrored light. What may be re-derived only when it changed is the
   * classification, because it is a pure function of the scene's structure and reads no world
   * matrix: a scene where every transform animates would otherwise re-decide an unchangeable answer
   * per frame. `ProjectionStability` holds what the last scan read and compares it, so the skip
   * happens only when nothing it reads has moved, and only the scan, the plan's re-derivation and
   * the retirement sweep are skipped — a wrong comparison costs one scan, never a wrong frame.
   *
   * A settled decline costs almost nothing: the classification walk re-runs on a bounded cadence
   * rather than every frame, and the whole-scene matrix pass does not run at all — the frames the
   * authored scene draws are exactly the frames three's renderer refreshes its world matrices
   * anyway. The pass stays mandatory on any frame this class projects, because then the authored
   * scene is not what renders and nothing else refreshes it.
   */
  reconcile(): void {
    const velocityEnabled = resolveVelocityEnabled(this.#velocity);
    if (this.#velocityActive !== velocityEnabled) {
      this.#velocityTracker.clear();
      this.#velocityActive = velocityEnabled;
    }
    if (!this.#enabled) {
      // Temporal history belongs to the authored draw even when its optimization is declined.
      // No mirror or eligibility scan runs; without a temporal consumer no history work runs.
      if (velocityEnabled) this.#velocityTracker.update(this.#source);
      this.#deoptimize("disabled", "the game set renderer.projection to false");
      this.#publish();
      return;
    }
    const mirror = this.#mirror;
    if (mirror === undefined) return;
    const startedAt = globalThis.performance?.now() ?? 0;
    if (mirror.setVelocityEnabled(velocityEnabled)) {
      this.#deoptimized = true;
      this.#framesSinceDeclineScan = DECLINE_RESCAN_FRAMES;
      this.#forgetPlan();
    }
    // Re-read every frame, not once at construction: a game that swaps its sky or turns fog on
    // mid-level would otherwise keep the look it happened to have when the mirror was built.
    const mirrorScene = mirror.scene;
    mirrorScene.background = this.#source.background;
    mirrorScene.environment = this.#source.environment;
    mirrorScene.fog = this.#source.fog;
    mirrorScene.backgroundBlurriness = this.#source.backgroundBlurriness;
    mirrorScene.backgroundIntensity = this.#source.backgroundIntensity;
    mirrorScene.environmentIntensity = this.#source.environmentIntensity;
    mirrorScene.overrideMaterial = this.#source.overrideMaterial;
    // A fresh `Scene` defaults both rotations to zero, so a game that turns its sky or its
    // environment lighting had that yaw snap back to zero the moment the mirror drew it — a
    // whole-image change with no frame where the game did anything. Copy value and order, into the
    // mirror's own Euler, so the source the game still mutates is never aliased.
    mirrorScene.backgroundRotation.copy(this.#source.backgroundRotation);
    mirrorScene.environmentRotation.copy(this.#source.environmentRotation);

    // A settled decline re-judges on a cadence, not per frame: most agent-built scenes sit below
    // the floor forever, and re-walking one every frame bought nothing. The counter starts at the
    // interval so the first reconcile always scans, and a deoptimization resets it.
    if (this.#deoptimized) {
      this.#framesSinceDeclineScan += 1;
      if (this.#framesSinceDeclineScan < DECLINE_RESCAN_FRAMES) {
        if (velocityEnabled) this.#velocityTracker.update(this.#source);
        return;
      }
    }

    // Scan and decide without touching the mirror; then either build the plan or decline whole.
    // The scan reads no world matrices, so it runs before the forced pass and the pass only runs
    // when its result is actually needed.
    let plan: IProjectionProjectPlan | undefined;
    let exactLane: IProjectionProjectPlan["exactLane"] = [];
    let exactLaneCount = 0;
    // Only a proven-unchanged structure can skip the retirement sweep: it walks every instance the
    // mirror holds to find the ones that left, and nothing left if the membership is the same.
    let retireSources = true;
    const retained = this.#deoptimized ? undefined : this.#retainedPlan;
    if (retained !== undefined && this.#stability.holds(this.#source)) {
      // Every input the classification reads is the value the last scan read, so this frame's plan
      // is the one already built. The apply below still runs in full: this skips the *decision*,
      // never the maintenance, which is why an object that moved, hid or was reparented since is
      // still written into the mirror this frame.
      plan = retained;
      const exact = this.#stability.exactLane();
      exactLane = exact.entries;
      exactLaneCount = exact.count;
      retireSources = false;
      this.#refreshMatrices();
    } else {
      // The scan releases its own workspace on entry, which is also what releases the previous
      // plan's members: this frame's plan is what the apply below consumes, and a retained one is
      // what the next frame re-uses, so releasing it here would empty the arrays it points into.
      // What that costs is one frame of reach on the objects the last scan saw — which the mirror
      // holds anyway while they are in the scene, and which the next scan drops either way.
      const scan = scanProjection(this.#source, this.#minMeshes, this.#scanWorkspace);
      this.#sourceRenderables = scan.renderables;
      this.#framesSinceDeclineScan = 0;
      if (scan.plan.action === "decline") {
        this.#forgetPlan();
        mirror.releaseAll();
        this.#deoptimize(scan.plan.reasonCode, scan.plan.reason);
        // A scene with nothing in it yet is still loading, and walking it costs nothing: look
        // again next frame rather than drawing the first second of the level unprojected.
        if (scan.renderables === 0) this.#framesSinceDeclineScan = DECLINE_RESCAN_FRAMES;
      } else {
        this.#refreshMatrices();
        this.#stability.record(this.#source, scan);
        this.#retainedPlan = scan.plan;
        plan = scan.plan;
        exactLane = scan.exactLane;
        exactLaneCount = scan.exactLaneCount;
      }
    }

    if (plan !== undefined) {
      mirror.prepare(exactLane, exactLaneCount);
      const lightFailure = mirror.apply(plan, retireSources);
      if (lightFailure !== undefined) {
        this.#deoptimize("unsupportedLight", lightFailure);
        this.#forgetPlan();
      } else {
        // A member whose material stopped matching the group it was an instance of is drawn exactly
        // this frame, and the classification that put it there is now stale: nothing structural
        // changed, so the structure proof would happily re-use it. Dropping the retained plan is
        // what makes the next frame re-derive the grouping from the materials as they now stand.
        if (mirror.reclassified) this.#forgetPlan();
        this.#deoptimized = false;
        this.#reasonCode = "projected";
        this.#reason = undefined;
      }
    }

    if (velocityEnabled)
      this.#velocityTracker.update(this.#deoptimized ? this.#source : mirror.scene);
    else this.#velocityTracker.clear();

    const elapsed = (globalThis.performance?.now() ?? 0) - startedAt;
    this.#reconcileMs += elapsed;
    this.#lastReconcileMs = elapsed;
    this.#maxReconcileMs = Math.max(this.#maxReconcileMs, elapsed);
    this.#publish();
  }

  /** Commits the rendered transform snapshot after the colour and velocity passes consume it. */
  commit(): void {
    if (!this.#velocityActive) return;
    this.#velocityTracker.commit(this.root);
  }

  /**
   * The renderer is handed the mirror, so the authored scene's world matrices are refreshed here.
   *
   * With the engine's walk installed that is the visible-only pass, which mirrors three for every
   * visible node and defers a hidden subtree until it shows; without it, honouring
   * `matrixWorldAutoUpdate` and Three's own `matrixWorldNeedsUpdate` propagation is the contract
   * every Three renderer uses. A game that turns the flag off has promised to update the scene
   * itself, and a subtree marked `matrixWorldAutoUpdate = false` under a still parent is skipped
   * instead of walked.
   */
  #refreshMatrices(): void {
    if (this.#matrixWorld !== undefined) {
      this.#matrixWorld.apply(this.#source);
    } else if (this.#source.matrixWorldAutoUpdate === true) {
      this.#source.updateMatrixWorld();
    }
  }

  /** Drops the retained plan, for any frame the mirror it described no longer holds. */
  #forgetPlan(): void {
    this.#retainedPlan = undefined;
    this.#stability.clear();
  }

  #publish(): void {
    // Re-announced when the verdict changes. A scene that projects at startup and gives up ten
    // minutes later has changed the thing worth knowing, and reporting only the first frame hides
    // exactly the transition a player would notice.
    if (this.#lastAnnounced !== this.#reasonCode) {
      this.#lastAnnounced = this.#reasonCode;
      this.#reported = false;
    }
    if (this.#reported) return;
    if (this.#onReport === undefined) {
      // Reported by default, exactly as the pass this replaced did, and for the reason that pass
      // did it: an optimizer that decides silently is one nobody can debug. The frame rate is
      // simply bad, or the screen is simply black, and the reason never leaves the process. A game
      // that had already merged its own scene was re-expanded into a thousand single-member draws
      // and stalled on its loading screen; the first person to know was the person holding the
      // phone, which is the wrong person.
      this.#reported = true;
      const r = this.report;
      console.info(
        `TN_RENDER_PROJECTION:${JSON.stringify({
          projecting: r.projecting,
          reasonCode: r.reasonCode,
          ...(r.reason === undefined ? {} : { reason: r.reason }),
          sourceRenderables: r.sourceRenderables,
          resultDrawCandidates: r.resultDrawCandidates,
          batches: r.batches,
          instancedBatches: r.instancedBatches,
          materialBatches: r.materialBatches,
          skinnedBatches: r.skinnedBatches,
          projectedObjects: r.projectedObjects,
          exactObjects: r.exactObjects,
          exact: r.exact,
          // The colour lane's per-frame material proof, named with the bound it accepts: a spread
          // check is a trade, and a trade nobody can read off the line is an invisible one.
          materialChecks: r.materialChecks,
          materialChecksPerFrame: r.materialChecksPerFrame,
          materialCheckStaleFrames: r.materialCheckStaleFrames,
          ...(r.materialChecksOverridden ? { materialChecksOverridden: true } : {}),
        })}`,
      );
      return;
    }
    // Reported once the verdict is first reached, so a game waiting on startup is not woken by a
    // frame counter. Deoptimization after that is visible through `report`, which is live.
    this.#reported = true;
    this.#onReport(this.report);
  }

  get report(): IRenderProjectionReport {
    const exact: Partial<Record<ProjectionExactReason, number>> = {};
    for (const [reason, count] of this.#mirror?.exactCounts ?? []) exact[reason] = count;
    let resultDrawCandidates = 0;
    // Counted from the scene the renderer is actually handed. Anything else is this class marking
    // its own homework.
    this.root.traverse((object) => {
      if (isRenderable(object)) resultDrawCandidates += 1;
    });
    const batches = this.#deoptimized ? 0 : (this.#mirror?.batchCount ?? 0);
    const exactObjects = this.#deoptimized ? 0 : (this.#mirror?.proxyCount ?? 0);
    return {
      schemaVersion: 1,
      projecting: !this.#deoptimized,
      reasonCode: this.#reasonCode,
      ...(this.#reason === undefined ? {} : { reason: this.#reason }),
      sourceRenderables: this.#sourceRenderables,
      resultDrawCandidates,
      projectedObjects: this.#deoptimized ? 0 : (this.#mirror?.projectedObjects ?? 0),
      batches,
      instancedBatches: this.#deoptimized ? 0 : (this.#mirror?.instancedBatchCount ?? 0),
      materialBatches: this.#deoptimized ? 0 : (this.#mirror?.materialBatchCount ?? 0),
      skinnedBatches: this.#deoptimized ? 0 : (this.#mirror?.skinnedBatchCount ?? 0),
      exactObjects,
      // A declined frame renders the authored scene, so its plan is one draw per authored
      // renderable — the number the projection is trying to beat, not zero.
      drawsPlanned: this.#deoptimized ? this.#sourceRenderables : batches + exactObjects,
      // Stated whether or not anything projected: the mode is a frame's cost, and a scene that
      // declined still has no uniform members to spread the check over.
      materialChecks: this.#materialChecks,
      materialChecksPerFrame: this.#mirror?.materialChecksPerFrame ?? 0,
      materialCheckStaleFrames: this.#mirror?.materialCheckStaleFrames ?? 0,
      materialChecksOverridden: this.#materialChecks !== "spread",
      exact,
      timings: {
        compileMs: this.#mirror?.compileMs ?? 0,
        reconcileMs: this.#reconcileMs,
        lastReconcileMs: this.#lastReconcileMs,
        maxReconcileMs: this.#maxReconcileMs,
      },
    };
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
    return this.#mirror?.inspect(object);
  }

  /** True when some batch in the mirror draws with this exact material instance. */
  drawsWith(material: Material): boolean {
    return this.#mirror?.drawsWith(material) ?? false;
  }

  /** Hands this frame back to the authored scene, naming why. */
  #deoptimize(reasonCode: ProjectionReasonCode, reason: string): void {
    this.#deoptimized = true;
    this.#reasonCode = reasonCode;
    this.#reason = reason;
  }

  /**
   * Releases everything the mirror owns.
   *
   * Only the batches are disposed. Every geometry and material in here came from the game and is
   * still the game's — disposing those would take a scene change down with it.
   */
  dispose(): void {
    this.#mirror?.releaseAll();
    this.#velocityTracker.clear();
    this.#forgetPlan();
    releaseProjectionScanWorkspace(this.#scanWorkspace);
    this.#deoptimized = true;
    this.#reasonCode = "belowMeshFloor";
    this.#reason = "the projection was disposed";
    this.#reported = false;
    this.#framesSinceDeclineScan = DECLINE_RESCAN_FRAMES;
  }
}

export type ProjectionCamera = Camera;

function resolveVelocityEnabled(value: boolean | (() => boolean)): boolean {
  const enabled = typeof value === "function" ? value() : value;
  if (typeof enabled !== "boolean")
    throw new Error(
      `SceneRenderProjection.velocity must resolve to a boolean, received ${String(enabled)}.`,
    );
  return enabled;
}

/**
 * Fail closed on a mode that is not one of the two: a game that wrote `"everyframe"` or
 * `"sometimes"` gets a named throw at construction rather than a default nobody asked for.
 */
function resolveMaterialChecks(
  value: ProjectionMaterialChecks | undefined,
): ProjectionMaterialChecks {
  if (value === undefined) return "spread";
  if (value !== "spread" && value !== "everyFrame")
    throw new Error(
      `SceneRenderProjection.materialChecks must be "spread" or "everyFrame", received ${JSON.stringify(value)}.`,
    );
  return value;
}
