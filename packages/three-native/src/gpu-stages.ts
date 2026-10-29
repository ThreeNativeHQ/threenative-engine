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
