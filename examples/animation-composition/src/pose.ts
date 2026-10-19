import type { AnimationComposer, GroundSnap } from "@threenative/core";
import { type Quaternion, Vector3 } from "three";
import { CCDIKSolver } from "three/addons/animation/CCDIKSolver.js";
import type { cloneCharacter } from "./render/character.js";

/** Existing Three CCD solves after the authored pose, on the same rendered skeleton. */
export class CompositionPose {
  readonly #authored: Quaternion[];
  readonly #ik: CCDIKSolver;
  readonly #worldHand = new Vector3();
  readonly #worldTarget = new Vector3();
  readonly #baseTransforms: { bone: number; position: Vector3; scale: Vector3 }[];
  lowerError = Number.POSITIVE_INFINITY;
  zeroError: number | null = null;
  ikError = Number.POSITIVE_INFINITY;
  poseBeforeIK = false;
  reloadWeight = 0;
  recoilWeight = 0;
  layersRemoved = false;

  constructor(
    readonly rig: ReturnType<typeof cloneCharacter>,
    readonly animation: AnimationComposer,
    readonly ground: GroundSnap,
  ) {
    if (rig.bones.length !== 9) throw new Error("Composition proof rig is incomplete.");
    this.#authored = rig.bones.map((bone) => bone.quaternion.clone());
    // These three game-authored base tracks stay at identity; position/scale have no animated track.
    this.#baseTransforms = [3, 5, 7].map((bone) => ({
      bone,
      position: (rig.bones[bone] as NonNullable<(typeof rig.bones)[number]>).position.clone(),
      scale: (rig.bones[bone] as NonNullable<(typeof rig.bones)[number]>).scale.clone(),
    }));
    this.#ik = new CCDIKSolver(rig.skin, [
      { target: 8, effector: 7, links: [{ index: 6 }, { index: 5 }], iteration: 12 },
    ]);
  }

  restore(): void {
    // Remove the preceding solve by restoring the preceding authored pose, never bind-pose reset.
    for (const [i, bone] of this.rig.bones.entries())
      bone.quaternion.copy(this.#authored[i] as Quaternion);
  }

  apply(): void {
    const [hips, leg, , spine, , , , hand, target] = this.rig.bones;
    if (
      hips === undefined ||
      leg === undefined ||
      spine === undefined ||
      hand === undefined ||
      target === undefined
    )
      throw new Error("Composition proof rig is incomplete.");
    this.poseBeforeIK = Math.abs(hips.position.x) + Math.abs(hips.position.z) < 1e-5;
    for (const [i, bone] of this.rig.bones.entries())
      (this.#authored[i] as Quaternion).copy(bone.quaternion);
    const phase = this.animation.phase;
    const angle =
      phase <= 0.25 ? 1.6 * phase : phase <= 0.75 ? 0.8 - 1.6 * phase : 1.6 * phase - 1.6;
    this.lowerError = Math.max(
      Math.abs(leg.quaternion.x - Math.sin(angle / 2)),
      Math.abs(leg.quaternion.w - Math.cos(angle / 2)),
      Math.abs(leg.quaternion.y),
      Math.abs(leg.quaternion.z),
    );
    this.zeroError = null;
    if (this.reloadWeight === 0 && this.recoilWeight === 0) {
      this.zeroError = 0;
      for (const base of this.#baseTransforms) {
        const bone = this.rig.bones[base.bone];
        if (bone === undefined) throw new Error("Composition proof rig is incomplete.");
        this.zeroError = Math.max(
          this.zeroError,
          Math.abs(bone.quaternion.x),
          Math.abs(bone.quaternion.y),
          Math.abs(bone.quaternion.z),
          Math.abs(bone.quaternion.w - 1),
          Math.abs(bone.position.x - base.position.x),
          Math.abs(bone.position.y - base.position.y),
          Math.abs(bone.position.z - base.position.z),
          Math.abs(bone.scale.x - base.scale.x),
          Math.abs(bone.scale.y - base.scale.y),
          Math.abs(bone.scale.z - base.scale.z),
        );
      }
    }
    this.layersRemoved = this.zeroError !== null && this.zeroError <= 1e-5;
    this.rig.root.updateWorldMatrix(true, true);
    this.#ik.update();
    this.ikError = hand
      .getWorldPosition(this.#worldHand)
      .distanceTo(target.getWorldPosition(this.#worldTarget));
    this.ground.apply(this.rig.root, -0.05, 1 / 60);
  }
}
