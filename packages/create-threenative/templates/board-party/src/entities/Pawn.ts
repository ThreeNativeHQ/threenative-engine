// One seat's pawn: the combat mannequin on a material swap. It owns the figure and the clip choice, and
// nothing about the rules: the match says where the pawn is, and `pose` says what it is doing.
import { MathUtils, type MeshStandardMaterial } from "three";
import type { Pose } from "../minigames/minigame.js";
import { dress, pawnMaterials } from "../render/props.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

/** The clips `assets/mannequin-combat.glb` ships, by the action this file plays them under. */
const CLIPS = {
  cheer: "Spell_Simple_Shoot",
  down: "Death01",
  hit: "Hit_Chest",
  hop: "Jump_Loop",
  idle: "Idle_Loop",
  roll: "Interact",
  run: "Sprint_Loop",
  walk: "Walk_Loop",
} as const;

/** The body is a 1.8 m figure; its centre sits this high above the surface it stands on. */
export const PAWN_HALF = 0.9;

export class Pawn extends Fighter {
  #down = false;

  constructor(ctx: GameCtx, model: IMannequin, seat: number) {
    super(ctx, model, CLIPS, { halfExtent: PAWN_HALF });
    dress(this.character.root, pawnMaterials[seat] as MeshStandardMaterial);
  }

  /** Turn toward a yaw by the short way. */
  face(yaw: number, dt: number): void {
    const turn = MathUtils.euclideanModulo(yaw - this.figure.rotation.y + Math.PI, Math.PI * 2);
    this.figure.rotation.y += (turn - Math.PI) * Math.min(1, dt * 10);
  }

  /** A one-shot gesture that holds the locomotion loop off for `hold` seconds. */
  gesture(action: "cheer" | "roll" | "hit", hold: number): void {
    this.play(action, { fit: true, hold });
  }

  /** Advance the rig for one tick in the pose the rules put this pawn in. */
  update(dt: number, pose: Pose | "walk"): void {
    if (pose === "down") {
      if (!this.#down) this.play("down", { hold: 1e6 });
      this.#down = true;
      this.animateStill(dt);
      return;
    }
    if (this.#down) {
      this.#down = false;
      this.play("idle", { fade: 0 });
    }
    this.walkAction = pose === "run" ? "run" : "walk";
    if (pose === "jump") {
      if (this.action !== "hop") this.play("hop", { hold: 0.7 });
      this.animateRig(dt, undefined, 0);
      return;
    }
    if (pose === "cheer") {
      if (this.action !== "cheer") this.play("cheer", { hold: 1.4 });
      this.animateRig(dt, undefined, 0);
      return;
    }
    this.animateRig(dt, undefined, pose === "idle" ? 0 : pose === "run" ? 5 : 2);
  }

  debug(): Record<string, unknown> {
    return {
      action: this.action,
      position: this.mesh.position.toArray(),
      yaw: Math.round(this.figure.rotation.y * 1000) / 1000,
    };
  }
}
