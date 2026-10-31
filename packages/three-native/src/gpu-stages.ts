/**
 * The GPU stages the owned engine times by name. A post pass the author labels with one reports its
 * time under that name in `info.engine.gpuStages`, beside the frame's whole time in `info.render.timestamp`;
 * a stage that drew no pass is absent. The order is the native stage id counting from 1
 * (`kStageScreenSpaceGi` in post_effects.h), so a new name goes last.
 */
export const GPU_STAGES = ["SSGI"] as const;

export type GpuStage = (typeof GPU_STAGES)[number];

/** The native id of a stage name; fails closed on a name the engine does not time. */
export function gpuStageId(name: unknown): number {
  const index = GPU_STAGES.indexOf(name as GpuStage);
  if (index < 0)
    throw new TypeError(
      `TN_GPU_STAGE: unknown stage ${String(name)}; the engine times ${GPU_STAGES.join(", ")}`,
    );
  return index + 1;
}

/**
 * The stage the shadow passes' summed time reports under. The engine times them without a label
 * (segment 0 of the frame's timing), so the name is fixed here and is the one `@threenative/core`
 * reads as `SHADOW_STAGE`.
 */
export const SHADOW_STAGE = "Shadow";

/** `tnw_web_frame` field of the shadow passes' segment (web_host.cpp). */
export const SHADOW_SEGMENT_FIELD = 19;

/**
 * The renderer's CPU stages by `tnw_web_frame` field (web_host.cpp 66 to 77): running ms of every render, which
 * core turns into per-frame time in `TN_FRAME_BUDGET.stages` (and, with debug on, `counters.engine`).
 *
 * The renderer's own stages come first: the virtual shadow pages and caster bounds, the draw plan and the shadow
 * passes' draw lists (all three nested in the prepare half), the whole prepare half, and the encode half, of which
 * `cpuPostMs` is the post effects' and output pass's share. Then the scene half of the render database (joints, scene
 * walk, shadow sync) and the web host's own: the whole main-view `tnw_web_render`, the queued kernels' flush inside it
 * and the batched queue submit that ends it (PRD-771), then the `tnw_web_poll` that opens it and its tail (surface texture release, frame gate, diagnostics) and the wall time of `Renderer::render` itself (`rendererMs`, which holds the prepare and encode halves) inside the whole `RenderDatabase::render` call (`hostDatabaseMs`), then the render targets' draws (`hostTargetMs`). The order of the names is the order the page reads them.
 */
export const CPU_STAGE_FIELDS = {
  cpuVirtualPagesMs: 66,
  cpuPlanMs: 67,
  cpuShadowBuildMs: 68,
  cpuPrepareMs: 69,
  cpuEncodeMs: 70,
  cpuPostMs: 73,
  cpuSceneMs: 74,
  hostRenderMs: 75,
  hostComputeMs: 76,
  hostSubmitMs: 77,
  hostPollMs: 79,
  hostTailMs: 80,
  rendererMs: 81,
  hostDatabaseMs: 82,
  hostTargetMs: 83,
} as const;

export type CpuStageName = keyof typeof CPU_STAGE_FIELDS;

/** `[name, field]` pairs of {@link CPU_STAGE_FIELDS}, built once so a per-frame read allocates nothing. */
export const CPU_STAGE_ENTRIES: readonly (readonly [CpuStageName, number])[] = Object.entries(
  CPU_STAGE_FIELDS,
) as [CpuStageName, number][];

/**
 * The work counts the host publishes after the stage totals (same array, `tnw_web_frame` 78): transforms moved,
 * shadow casters the virtual atlas judged moving, and bytes the GPU queue took in buffer writes. Running totals.
 */
export const WORK_COUNT_NAMES = ["dirtyTransforms", "castersMoving", "queueWriteBytes"] as const;

export type WorkCountName = (typeof WORK_COUNT_NAMES)[number];
