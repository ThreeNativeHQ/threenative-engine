import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import { type AnimationClip, Box3, Group, type Object3D } from "three";
import { type IFighterConventions, preparePlayerConventions } from "../conventions.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, undefined>;

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

/** The capsule's half-extent, in metres: the mannequin is 1.8 m tall. */
const HALF_EXTENT = 0.9;

/**
 * The body both fighters share: the combat mannequin, its conventions, and the two ways a clip
 * plays. A `loop` is a stance (idle, run, fall) that holds until the simulation changes it. A
 * `play` is one action (a swing, a roll) fitted to the frames the simulation gave it, so the clip
 * ends when the action ends.
 *
 * `requiredClips` fails the load by name if the file does not carry one of them, so a renamed
 * clip is a build failure, not a fighter that stands still.
 */
export abstract class Fighter {
  readonly mesh = new Group();
  readonly character: SkeletalMesh3D;
  /** The rigged root, offset so the soles meet the capsule. Gameplay turns this. */
  readonly figure = new Group();
  readonly conventions: IFighterConventions;
  #remaining = 0;
  #loop = "";
  readonly #clipDuration = new Map<string, number>();
  /** The last one-shot clip, the frames it advanced and the seconds it ran against the seconds its whole clip needs. */
  #oneShot = { clip: "", frames: 0, needed: 0, ran: 0 };

  protected constructor(ctx: GameCtx, model: IMannequin, clips: readonly string[]) {
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: clips,
      strideRoot: this.mesh,
    });
    this.figure.add(this.character.root);
    this.mesh.add(this.figure);
    for (const clip of model.animations) this.#clipDuration.set(clip.name, clip.duration);
    // Measured, not guessed: the figure sinks by the distance from its own origin to its lowest
    // posed point, so an asset authored feet-down and one authored mid-stride both land on the floor.
    const soles = new Box3().setFromObject(this.figure, true).min.y;
    this.figure.position.y = -HALF_EXTENT - 0.01 - soles;
    this.conventions = preparePlayerConventions(this.character.root);
    this.character.root.traverse((object) => {
      object.castShadow = true;
    });
    ctx.add(this.mesh);
  }

  /** What the playtest bridge reads: the last one-shot clip and whether it ran its whole length. */
  get animation(): { advancedFrames: number; current: string; finished: boolean } {
    const { clip, frames, needed, ran } = this.#oneShot;
    return {
      advancedFrames: frames,
      current: clip === "" ? (this.character.current ?? "") : clip,
      finished: clip !== "" && ran >= needed - 1e-6,
    };
  }

  /** True while a one-shot holds the rig. */
  get busy(): boolean {
    return this.#remaining > 0;
  }

  /** Holds a looping stance. Asking for the one already playing changes nothing. */
  loop(clip: string, fade = 0.15): void {
    if (this.#remaining > 0 || clip === this.#loop) return;
    this.#loop = clip;
    this.character.play(clip, { fade, mode: "loop" });
  }

  /**
   * Plays one clip once, sped up or slowed down so its whole length fills `seconds`. `record`
   * marks an action the fighter chose (a swing, a roll); a flinch is a reaction and is not kept.
   */
  play(clip: string, seconds: number, options: { fade?: number; record?: boolean } = {}): void {
    const duration = this.#clipDuration.get(clip) ?? 0;
    this.#remaining = seconds;
    this.#loop = "";
    const speed = duration > 0 ? duration / seconds : 1;
    this.character.play(clip, { fade: options.fade ?? 0.08, mode: "once", speed });
    if (options.record !== false) this.#oneShot = { clip, frames: 0, needed: seconds, ran: 0 };
  }

  /** Advances the rig one step and counts the one-shot's progress. */
  protected advance(dt: number): void {
    if (this.#remaining > 0) {
      this.#oneShot.frames += 1;
      this.#oneShot.ran += Math.min(dt, this.#remaining);
    }
    this.#remaining = Math.max(0, this.#remaining - dt);
    this.character.update(dt);
  }
}
