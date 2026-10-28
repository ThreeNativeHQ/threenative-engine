import type { AnchorInfo, TransformValue } from "./scene.js";

// Re-exported for the ops modules, which deal in the same transform a keyframe stores.
export type { AnchorInfo, TransformValue };

export type AttachmentMode = "attached" | "detached";
export interface PoseKeyframe {
  readonly time: number;
  readonly transform: TransformValue;
}
export interface AnimationPose {
  readonly attachment: AttachmentMode;
  readonly keyframes: readonly PoseKeyframe[];
}
export interface RecipeV3 {
  readonly anchor: AnchorInfo;
  readonly animations: Record<string, AnimationPose>;
  readonly attached: string;
  readonly default?: AnimationPose;
  readonly host: string;
  readonly version: 3;
}

interface RecipeV2 {
  readonly anchor: AnchorInfo;
  readonly animations: Record<string, PoseKeyframe>;
  readonly attached: string;
  readonly default?: PoseKeyframe;
  readonly host: string;
  readonly version: 2;
}

const asTrack = (sample: PoseKeyframe): AnimationPose => ({
  attachment: "attached",
  keyframes: [sample],
});

/** Preserve every v2 calibration while upgrading it to a one-keyframe v3 track. */
export function migrateRecipe(value: RecipeV2 | RecipeV3): RecipeV3 | undefined {
  if (value.version === 3) return value;
  if (value.version !== 2) return undefined;
  return {
    anchor: value.anchor,
    animations: Object.fromEntries(
      Object.entries(value.animations).map(([name, sample]) => [name, asTrack(sample)]),
    ),
    attached: value.attached,
    ...(value.default === undefined ? {} : { default: asTrack(value.default) }),
    host: value.host,
    version: 3,
  };
}

const mix = (a: number, b: number, alpha: number): number => a + (b - a) * alpha;
const mixAngle = (a: number, b: number, alpha: number): number => {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * alpha;
};

export function poseAt(track: AnimationPose | undefined, time: number): TransformValue | undefined {
  const frames = [...(track?.keyframes ?? [])].sort((a, b) => a.time - b.time);
  const first = frames[0];
  if (first === undefined) return undefined;
  const last = frames.at(-1) ?? first;
  if (time <= first.time) return first.transform;
  if (time >= last.time) return last.transform;
  const right = frames.find((frame) => frame.time >= time) ?? last;
  const left = frames[Math.max(0, frames.indexOf(right) - 1)] ?? first;
  const alpha = (time - left.time) / Math.max(1e-6, right.time - left.time);
  return {
    position: left.transform.position.map((value, index) =>
      mix(value, right.transform.position[index] ?? value, alpha),
    ) as [number, number, number],
    rotation: left.transform.rotation.map((value, index) =>
      mixAngle(value, right.transform.rotation[index] ?? value, alpha),
    ) as [number, number, number],
    scale: left.transform.scale.map((value, index) =>
      mix(value, right.transform.scale[index] ?? value, alpha),
    ) as [number, number, number],
  };
}

export function upsertKeyframe(
  track: AnimationPose | undefined,
  frame: PoseKeyframe,
): AnimationPose {
  const keyframes = [...(track?.keyframes ?? [])].filter(
    (candidate) => Math.abs(candidate.time - frame.time) > 0.0005,
  );
  keyframes.push(frame);
  keyframes.sort((a, b) => a.time - b.time);
  return { attachment: track?.attachment ?? "attached", keyframes };
}
