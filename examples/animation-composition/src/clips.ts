import {
  AnimationClip,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from "three";

const axis = new Vector3();
const rotation = new Quaternion();
const identity = [0, 0, 0, 1];
const names = ["LeftLeg", "RightLeg", "Spine", "Head", "Arm", "Forearm", "RightHand"];

function turn(name: string, duration: number, values: readonly number[], direction: "x" | "z") {
  axis.set(direction === "x" ? 1 : 0, 0, direction === "z" ? 1 : 0);
  return new QuaternionKeyframeTrack(
    `${name}.quaternion`,
    values.map((_, i) => (i * duration) / (values.length - 1)),
    values.flatMap((value) => rotation.setFromAxisAngle(axis, value).toArray()),
  );
}

function locomotion(name: string, duration: number, x: number, z: number): AnimationClip {
  return new AnimationClip(name, -1, [
    new VectorKeyframeTrack("Hips.position", [0, duration], [0, 0, 0, x, 0, z]),
    new QuaternionKeyframeTrack("Hips.quaternion", [0, duration], [...identity, ...identity]),
    ...names.map((bone) =>
      turn(
        bone,
        duration,
        bone === "LeftLeg"
          ? [0, 0.4, 0, -0.4, 0]
          : bone === "RightLeg"
            ? [0, -0.4, 0, 0.4, 0]
            : [0, 0, 0, 0, 0],
        "x",
      ),
    ),
  ]);
}

/** Authored metres/timing stay in the game. Every cloned rig reads these immutable clips. */
export const compositionClips = [
  locomotion("walk", 1, 0, 2),
  locomotion("run", 0.6, 0, 4),
  locomotion("strafe", 1.2, 2, 0),
  new AnimationClip("reload", 1, [
    turn("Spine", 1, [0, 0.25, 0], "x"),
    turn("Arm", 1, [0, 0.8, 0], "z"),
  ]),
  new AnimationClip("recoil", 0.5, [turn("RightHand", 0.5, [0, 0.12, 0], "z")]),
  new AnimationClip("reference", 1, [
    new QuaternionKeyframeTrack("RightHand.quaternion", [0, 1], [...identity, ...identity]),
  ]),
] as const;

export const compositionLayers = [
  {
    name: "reload",
    clip: "reload",
    mode: "override",
    once: true,
    mask: { bones: ["Spine"], descendants: true },
  },
  {
    name: "recoil",
    clip: "recoil",
    mode: "additive",
    mask: { bones: ["RightHand"] },
    reference: { clip: compositionClips[5], time: 0 },
  },
] as const;

export const compositionSamples = ["walk", "run", "strafe"] as const;
export function sourceClipBytes(): string {
  return JSON.stringify(compositionClips.map((clip) => clip.toJSON()));
}
