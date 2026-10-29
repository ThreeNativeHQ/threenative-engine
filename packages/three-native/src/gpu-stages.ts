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
 * The renderer's CPU stages by `tnw_web_frame` field (web_host.cpp 66 to 70): running ms of every render, which
 * core turns into per-frame time in `TN_FRAME_BUDGET.counters.engine`. The virtual shadow pages and caster bounds,
 * the draw plan, the shadow passes' draw lists, the whole prepare half, and the encode half.
 */
export const CPU_STAGE_FIELDS = {
  cpuVirtualPagesMs: 66,
  cpuPlanMs: 67,
  cpuShadowBuildMs: 68,
  cpuPrepareMs: 69,
  cpuEncodeMs: 70,
} as const;
