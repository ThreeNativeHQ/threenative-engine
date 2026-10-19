import {
  AnimationClip,
  Bone,
  Group,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
} from "three";
export function compositionRig() {
  const root = new Group();
  const hips = new Bone();
  hips.name = "Hips";
  root.add(hips);
  const leg = new Bone();
  leg.name = "Leg";
  hips.add(leg);
  const upper = new Bone();
  upper.name = "Upper";
  hips.add(upper);
  const hand = new Bone();
  hand.name = "Hand";
  upper.add(hand);
  const track = (name: string, end: number) =>
    new VectorKeyframeTrack(name, [0, 1], [0, 0, 0, end, 0, 0]);
  const walk = new AnimationClip("walk", 1, [track("Leg.position", 1), track("Upper.position", 2)]);
  const run = new AnimationClip("run", 2, [
    new VectorKeyframeTrack("Leg.position", [0, 2], [0, 0, 0, 4, 0, 0]),
    new VectorKeyframeTrack("Upper.position", [0, 2], [0, 0, 0, 6, 0, 0]),
  ]);
  const reload = new AnimationClip("reload", 1, [
    track("Leg.position", 100),
    track("Upper.position", 10),
  ]);
  const q = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.4);
  const recoil = new AnimationClip("recoil", 1, [
    new QuaternionKeyframeTrack("Hand.quaternion", [0, 1], [0, 0, 0, 1, ...q.toArray()]),
  ]);
  const reference = new AnimationClip("reference", 1, [
    new QuaternionKeyframeTrack("Hand.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
  ]);
  return { root, hips, leg, upper, hand, clips: [walk, run, reload, recoil, reference] as const };
}
