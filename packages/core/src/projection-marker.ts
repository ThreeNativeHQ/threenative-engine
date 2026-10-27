import type { IMatrixWorldReport } from "./matrix-world.js";
import type { IRenderCameraCullReport } from "./render-camera-cull.js";
import type {
  IRenderProjectionReport,
  ProjectionExactReason,
  ProjectionWindowReport,
} from "./renderProjection.js";

/**
 * The per-window projection line.
 *
 * `TN_RENDER_PROJECTION` announces the verdict once, when it is first reached — the right shape
 * for "did the optimizer engage", and the wrong one for "what is it still leaving on the table
 * while the game runs". This marker is emitted on every frame-budget window instead, so a run
 * produces a series rather than a single sentence, and it carries the one thing the projection
 * cannot know on its own: how many draws the renderer was actually handed.
 */
export const PROJECTION_MARKER = "TN_PROJECTION";

export interface IProjectionWindowJson {
  /**
   * Draw calls the renderer counted, or absent when nothing measured them.
   *
   * **Not comparable to `drawsPlanned` one-for-one.** The plan counts colour-pass draws; this
   * counts every pass the renderer made, so a scene whose light casts shadows walks its objects
   * twice and reads about double. Measured on the shooter template: 52 planned, 116 actual, on a
   * frame where the projection had declined and folded nothing at all.
   */
  readonly drawsActual?: number;
  /** One per batch plus one per exact-lane object; the plan, which WebGPU need not honour. */
  readonly drawsPlanned: number;
  readonly exact: Partial<Record<ProjectionExactReason, number>>;
  readonly exactObjects: number;
  /** Who batched the frame: the host renderer, or core's JS mirror. */
  readonly path?: IRenderProjectionReport["path"];
  readonly projecting: boolean;
  readonly reason?: string;
  readonly reasonCode: string;
  readonly sourceRenderables: number;
  /**
   * What the projection spent reconciling, straight from the report.
   *
   * `lastReconcileMs` is this window's last frame — the per-frame attribution term the perf loop
   * reads. `reconcileMs` is the run's running total and `maxReconcileMs` its worst frame. Carried
   * per window rather than once, because reconcile is paid per frame, not at startup.
   */
  readonly timings?: IRenderProjectionReport["timings"];
  /**
   * The projected-size gate's own count for this window.
   *
   * Present whenever the engine ran the gate, whether it is enabled or the game declined it — a
   * silent cull is one nobody can tell is working. `culled` is what the render camera could not
   * resolve and the frame did not submit; a game that marked objects with `alwaysRender` reads its
   * overrides in `exemptMarked`.
   */
  readonly cull?: {
    readonly enabled: boolean;
    readonly cameraResolved: boolean;
    readonly thresholdPixels: number;
    readonly considered: number;
    readonly culled: number;
    readonly exemptCameraAttached: number;
    readonly exemptMarked: number;
    readonly exemptShadowCasters: number;
    readonly exemptWithoutBounds: number;
    readonly exemptDynamicBounds: number;
    readonly exemptFrustumCulled: number;
  };
  /**
   * The world-matrix walk's own count for this window.
   *
   * `mode` is the resolved `renderer.matrixWorld` and `visited` is the nodes the engine walked on
   * the last world-render frame, summed over the authored scene and any projection mirror. Present
   * whenever the engine ran the walk — turning the default off with `"all"` does not turn its
   * measurement off, and the two numbers side by side are the cost the convention removed.
   */
  readonly matrixWorld?: {
    readonly mode: string;
    readonly visited: number;
  };
  readonly window: number;
}

/**
 * Orders the exact lane by how many draws each reason costs.
 *
 * This is the whole point of the marker: the next thing worth folding is whichever reason is at
 * the top of this list in a game that is actually slow, and picking it any other way is picking it
 * by intuition — which has been wrong twice here.
 */
export function rankExactReasons(
  exact: Partial<Record<ProjectionExactReason, number>>,
): { count: number; reason: string }[] {
  return Object.entries(exact)
    .filter(([, count]) => typeof count === "number" && count > 0)
    .map(([reason, count]) => ({ count: count as number, reason }))
    .sort((left, right) => right.count - left.count || (left.reason < right.reason ? -1 : 1));
}

/**
 * Builds the line. Emitted on a declined frame too, with its reason code — a decline is the most
 * useful line in the log, and suppressing it is how "it did nothing" gets read as "it had nothing
 * to do".
 */
export function formatProjectionWindow(
  report: ProjectionWindowReport,
  window: number,
  drawsActual: number | undefined,
  cull?: IRenderCameraCullReport,
  matrixWorld?: IMatrixWorldReport,
): string {
  const payload: IProjectionWindowJson = {
    ...(drawsActual === undefined ? {} : { drawsActual }),
    ...(cull === undefined
      ? {}
      : {
          cull: {
            enabled: cull.enabled,
            cameraResolved: cull.cameraResolved,
            thresholdPixels: cull.thresholdPixels,
            considered: cull.considered,
            culled: cull.culled,
            exemptCameraAttached: cull.exemptCameraAttached,
            exemptMarked: cull.exemptMarked,
            exemptShadowCasters: cull.exemptShadowCasters,
            exemptWithoutBounds: cull.exemptWithoutBounds,
            exemptDynamicBounds: cull.exemptDynamicBounds,
            exemptFrustumCulled: cull.exemptFrustumCulled,
          },
        }),
    drawsPlanned: report.drawsPlanned,
    exact: report.exact,
    exactObjects: report.exactObjects,
    ...(matrixWorld === undefined
      ? {}
      : { matrixWorld: { mode: matrixWorld.mode, visited: matrixWorld.visited } }),
    path: report.path,
    projecting: report.projecting,
    ...(report.reason === undefined ? {} : { reason: report.reason }),
    reasonCode: report.reasonCode,
    sourceRenderables: report.sourceRenderables,
    timings: report.timings,
    window,
  };
  return `${PROJECTION_MARKER}:${JSON.stringify(payload)}`;
}
