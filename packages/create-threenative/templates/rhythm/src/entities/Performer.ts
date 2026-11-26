import type { MeshStandardMaterial } from "three";
import type { ButtonName } from "../rhythm/buttons.js";
import type { Grade } from "../rhythm/judge.js";
import type { Level } from "../rhythm/rating.js";
import { dress } from "../render/props.js";
import { type GameCtx, Fighter, type IMannequin } from "./Fighter.js";

/** Clip names in `mannequin-combat.glb`, by what the performer does with them. */
const CLIPS = {
  idle: "Idle_Loop",
  // `Fighter` asks for a locomotion pair; a performer never walks, so both are the idle pose.
  walk: "Idle_Loop",
  proud: "Spell_Simple_Idle_Loop",
  slump: "Crouch_Idle_Loop",
  // One move per button. The same moves serve the teacher's call and the player's answer.
  left: "Punch_Jab",
  right: "Punch_Cross",
  up: "Jump_Start",
  down: "PickUp_Table",
  z: "Spell_Simple_Shoot",
  x: "Sword_Attack",
  // Reactions to a bad press, and the fall that ends a failed stage.
  stumble: "Hit_Chest",
  flinch: "Hit_Head",
  fall: "Death01",
} as const;

/** Seconds a move holds the rig: a beat at 120 BPM, so the clip is fitted to land before the next one. */
const MOVE_HOLD = 0.45;
/** The metre that puts the soles on the stage: capsule half height plus the one centimetre `Fighter` leaves. */
const HOME_Y = 0.91;
/** How far each button throws the dancer, in metres (x, z), and how fast the throw settles. */
const STEP: Readonly<Record<ButtonName, readonly [number, number]>> = {
  left: [-0.5, 0],
  right: [0.5, 0],
  up: [0, -0.35],
  down: [0, 0.35],
  z: [0.2, 0],
  x: [-0.2, 0],
};
const SETTLE_RATE = 5;
/** The dip on the beat, in metres. */
const BOB = 0.06;

export interface IPerformerOptions {
  /** Stage position on the floor line, metres. */
  readonly x: number;
  /** Yaw of the figure; 0 faces the camera. */
  readonly facing: number;
  readonly material: MeshStandardMaterial;
}

/**
 * One performer on the stage: the combat mannequin in its own colour, a move per button, a pose
 * that follows the rating, and a bob that rides the beat. The teacher and the player are two
 * instances of this class.
 */
export class Performer extends Fighter {
  readonly tags = ["performer"];
  readonly #home: number;
  #dx = 0;
  #dz = 0;
  #bob = 0;
  #fallen = false;

  constructor(ctx: GameCtx, mannequin: IMannequin, options: IPerformerOptions) {
    super(ctx, mannequin, CLIPS, { facing: options.facing, halfExtent: 0.9 });
    dress(this.character.root, options.material);
    this.#home = options.x;
    this.mesh.position.set(options.x, HOME_Y, 0);
  }

  /** Throw the dancer a step toward the button and play its move. */
  perform(button: ButtonName): void {
    if (this.#fallen) return;
    this.#dx += STEP[button][0];
    this.#dz += STEP[button][1];
    this.play(button, { fit: true, hold: MOVE_HOLD });
  }

  /** The player's body answers the grade of a press: a cool or good press dances the button, a bad one stumbles. */
  react(button: ButtonName, grade: Grade): void {
    if (this.#fallen) return;
    if (grade === "bad") this.play("stumble", { hold: MOVE_HOLD });
    else if (grade === "miss") this.play("flinch", { hold: MOVE_HOLD });
    else this.perform(button);
  }

  /** The resting pose follows the rating: proud at the top, upright in the middle, slumped below. */
  setMood(level: Level): void {
    this.idleAction = level === "cool" ? "proud" : level === "good" ? "idle" : "slump";
  }

  fall(): void {
    this.#fallen = true;
    this.play("fall", { hold: 99 });
  }

  /** Advance one tick: settle the dance step, dip on the beat, then run the rig. */
  update(dt: number, pulse: number): void {
    this.#dx *= Math.exp(-SETTLE_RATE * dt);
    this.#dz *= Math.exp(-SETTLE_RATE * dt);
    this.#bob = BOB * pulse;
    this.mesh.position.set(this.#home + this.#dx, HOME_Y - this.#bob, this.#dz);
    this.animateRig(dt, undefined, 0);
  }

  /** What a playtest reads: the move last played and the dip on the beat. */
  debug(): Record<string, unknown> {
    return { bob: Math.round(this.#bob * 1000) / 1000, fallen: this.#fallen, move: this.action, x: Math.round(this.mesh.position.x * 100) / 100 };
  }
}
