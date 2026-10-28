import { Quaternion, Vector3 } from "three";

/** Every edit a caller can ask for, as data. The op log stores exactly this, so a replay runs the
 * same program the first run did. */
export type ClipEdit =
  | { readonly kind: "trim"; readonly end: number; readonly start: number }
  | { readonly kind: "retime"; readonly speed: number }
  | { readonly kind: "loop-point"; readonly time: number }
  | { readonly kind: "resample"; readonly fps: number }
  | { readonly kind: "mirror" }
  | {
      readonly kind: "foot-lock";
      /** In metres: how far below its lowest point a foot still counts as planted. */
      readonly contact: number;
      readonly feet: readonly string[];
    };

export const CLIP_EDIT_KINDS = Object.freeze([
  "trim",
  "retime",
  "loop-point",
  "resample",
  "mirror",
  "foot-lock",
] as const);

const word = (value: string): string | undefined => {
  const lower = value.toLowerCase();
  if (lower === "left") return value === "LEFT" ? "RIGHT" : "Right";
  if (lower === "right") return value === "RIGHT" ? "LEFT" : "Left";
  return undefined;
};

/** `mixamorigLeftHand` → `mixamorigRightHand`, `Bip01 L Thigh` → `Bip01 R Thigh`. Undefined when the
 * bone has no side, which is what a mirror leaves alone. */
export function mirroredBone(name: string): string | undefined {
  const words = name.replace(/left|right/giu, (match) => word(match) ?? match);
  if (words !== name) return words;
  const tokens = name.replace(
    /(^|[._\s-])([lrLR])(?=$|[._\s-]|\d)/gu,
    (_match: string, prefix: string, side: string) =>
      `${prefix}${side === "L" ? "R" : side === "R" ? "L" : side === "l" ? "r" : "l"}`,
  );
  return tokens === name ? undefined : tokens;
}

/** The keys a channel keeps after a time edit, and where each came from. A key exactly on a
 * boundary stays, so trimming at a keyframe keeps the pose the author put there. */
export function keepFrames(
  times: readonly number[],
  keep: (time: number) => number | undefined,
): { readonly source: number[]; readonly times: number[] } {
  const source: number[] = [];
  const kept: number[] = [];
  times.forEach((time, index) => {
    const moved = keep(time);
    if (moved === undefined) return;
    source.push(index);
    kept.push(moved);
  });
  return { source, times: kept };
}

/** A world displacement expressed in a bone's parent frame, which is the space its translation
 * channel is written in. */
export function localDelta(
  delta: readonly number[],
  parentRotation: readonly number[],
): [number, number, number] {
  const rotated = new Vector3(delta[0] ?? 0, delta[1] ?? 0, delta[2] ?? 0).applyQuaternion(
    new Quaternion(
      parentRotation[0] ?? 0,
      parentRotation[1] ?? 0,
      parentRotation[2] ?? 0,
      parentRotation[3] ?? 1,
    ).invert(),
  );
  return [rotated.x, rotated.y, rotated.z];
}
