// The pilot rig: the one construction in this kit that needs `@threenative/core`, so it lives
// beside `conventions.ts` rather than under `src/render/`, whose sources stay portable.
import { SkeletalMesh3D } from "@threenative/core";
import type { AnimationClip, Object3D } from "three";
import { preparePilot } from "./conventions.js";

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

export interface IPilot {
  /** The rig, scaled to metres and ready to be placed in a craft. */
  readonly root: Object3D;
  readonly update: (dt: number) => void;
}

/** The mannequin on a looping clip, scaled to a 1.8 m person. */
export function createPilot(model: IMannequin, clip: string): IPilot {
  const character = new SkeletalMesh3D({
    clips: model.animations,
    requiredClips: [clip],
    source: model.scene,
  });
  preparePilot(character.root);
  character.root.traverse((object) => {
    object.castShadow = true;
  });
  character.play(clip, { fade: 0, mode: "loop" });
  return { root: character.root, update: (dt) => character.update(dt) };
}
