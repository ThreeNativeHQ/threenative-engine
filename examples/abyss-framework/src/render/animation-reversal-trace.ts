import { SkeletalMesh3D } from "@threenative/core";
import { type AnimationClip, Bone, type Object3D } from "three";

export const REVERSAL_CLIPS = ["Idle_Loop", "Walk_Loop", "Jog_Fwd_Loop"] as const;
const REQUESTS = new Map<number, readonly number[]>([
  [1, [1]],
  [13, [2]],
  [25, [0]],
  [37, [2]],
  [49, [1]],
  [61, [0]],
  [73, [1, 2, 0]],
]);

/** Game-owned test trace, shared by the actual GLB CPU check and the rendered fixture. */
export function createReversalTrace(model: {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}) {
  const player = new SkeletalMesh3D({
    source: model.scene,
    clips: model.animations,
    requiredClips: REVERSAL_CLIPS,
    strideSync: false,
  });
  const bones: Bone[] = [];
  player.root.traverse((object) => {
    if (object instanceof Bone) bones.push(object);
  });
  if (bones.length === 0) throw new Error("Mannequin capture requires actual animated bones.");
  const actions = REVERSAL_CLIPS.map((name) => player.mixer.clipAction(player.clip(name)));
  player.play(REVERSAL_CLIPS[0]);
  player.update(0.2);
  let tick = 0;
  let reversals = 0;
  let returningRequests = 0;
  let maxWeightError = 0;
  let maxPoseJumpMetres = 0;
  let maxPoseJumpRadians = 0;
  let maxPhaseJump = 0;
  // glTF float32 quaternions can be slightly off unit length. Normalize diagnostic copies
  // so angleTo(q, q) does not report a fictitious pose jump; never change the played bones.
  const initial = bones.map((bone) => bone.quaternion.clone().normalize());
  let maxAnimatedRadians = 0;
  const observation = () => ({
    tick,
    reversals,
    returningRequests,
    bones: bones.length,
    current: player.current,
    weights: actions.map((action) => action.getEffectiveWeight()),
    phases: actions.map((action) => action.time / action.getClip().duration),
    activeActions: player.mixer.stats.actions.inUse,
    maxWeightError,
    maxPoseJumpMetres,
    maxPoseJumpRadians,
    maxPhaseJump,
    maxAnimatedRadians,
  });
  return {
    player,
    observation,
    step() {
      tick += 1;
      player.update(1 / 60);
      // Apply the current weights before sampling; this isolates request-time continuity
      // from authored gait movement and from the existing mixer's weight-update ordering.
      player.update(0);
      for (const index of REQUESTS.get(tick) ?? []) {
        const action = actions[index];
        const name = REVERSAL_CLIPS[index];
        if (action === undefined || name === undefined) throw new Error("Invalid reversal trace.");
        const live = action.isScheduled() && action.getEffectiveWeight() > 0;
        const time = action.time;
        const pose = bones.map((bone) => ({
          p: bone.position.clone(),
          q: bone.quaternion.clone().normalize(),
        }));
        player.play(name, { fade: 0.4 });
        if (live) {
          returningRequests += 1;
          maxPhaseJump = Math.max(maxPhaseJump, Math.abs(action.time - time));
        }
        player.update(0);
        for (const [boneIndex, bone] of bones.entries()) {
          const before = pose[boneIndex];
          if (before === undefined) throw new Error("Bone pose sample is missing.");
          maxPoseJumpMetres = Math.max(maxPoseJumpMetres, bone.position.distanceTo(before.p));
          maxPoseJumpRadians = Math.max(
            maxPoseJumpRadians,
            bone.quaternion.clone().normalize().angleTo(before.q),
          );
        }
        reversals += 1;
      }
      const weights = actions.map((action) => action.getEffectiveWeight());
      if (weights.some((weight) => !Number.isFinite(weight) || weight < 0))
        throw new Error("Animation reversal produced an invalid weight.");
      maxWeightError = Math.max(maxWeightError, Math.abs(weights.reduce((a, b) => a + b, 0) - 1));
      for (const [index, bone] of bones.entries()) {
        const before = initial[index];
        if (before !== undefined)
          maxAnimatedRadians = Math.max(
            maxAnimatedRadians,
            bone.quaternion.clone().normalize().angleTo(before),
          );
      }
    },
  };
}
