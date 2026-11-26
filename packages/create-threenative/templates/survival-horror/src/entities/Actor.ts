import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import {
  type AnimationClip,
  Box3,
  Group,
  type Material,
  MathUtils,
  type Object3D,
  type Vector3,
} from "three";
import { type IKitConventions, prepareConventions } from "../conventions.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

export const WORLD_LAYER = 1;
export const PLAYER_LAYER = 2;
export const HOSTILE_LAYER = 4;

/** Capsule for a 1.8 m figure: 0.6 m half-height plus a 0.3 m radius at each end. */
export const HALF_HEIGHT = 0.6;
export const RADIUS = 0.3;

interface IPlay {
  readonly fade?: number;
  readonly mode?: "loop" | "once";
  /** Start the clip again even if it is the one already playing. */
  readonly restart?: boolean;
  readonly speed?: number;
}

/**
 * The body every figure in the wing shares: the combat mannequin on a capsule, one clip at a time,
 * and a heading turned at a rate. Classic survival horror is built on exactly that — a character
 * whose facing is a number that turns at a fixed speed — so the heading lives here, not in the rig.
 */
export abstract class Actor {
  readonly mesh = new Group();
  readonly figure = new Group();
  readonly character: SkeletalMesh3D;
  readonly conventions: IKitConventions;
  /** Radians; the model faces +z at 0, so the facing vector is (sin, 0, cos). */
  heading = 0;
  #clip = "";
  #mode: "loop" | "once" = "loop";
  readonly #durations = new Map<string, number>();
  /** The last one-shot clip, what the playtest bridge reads as `animation`. */
  #oneShot = { clip: "", frames: 0, needed: 0, ran: 0 };

  protected constructor(
    ctx: GameCtx,
    model: IMannequin,
    clips: readonly string[],
    options: { readonly material?: Material; readonly weapon?: Object3D },
  ) {
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: [...clips],
      strideRoot: this.mesh,
    });
    for (const clip of model.animations) this.#durations.set(clip.name, clip.duration);
    this.figure.add(this.character.root);
    this.mesh.add(this.figure);
    if (options.material !== undefined) {
      const material = options.material;
      this.character.root.traverse((object) => {
        const mesh = object as { isMesh?: boolean; material?: unknown };
        if (mesh.isMesh === true) mesh.material = material;
      });
    }
    this.conventions = prepareConventions(this.character.root, options.weapon);
    // Measured, not guessed: the soles land one centimetre under the capsule bottom.
    const soles = new Box3().setFromObject(this.figure, true).min.y;
    this.figure.position.y = -(HALF_HEIGHT + RADIUS) - 0.01 - soles;
    this.character.root.traverse((object) => {
      object.castShadow = true;
    });
    ctx.add(this.mesh);
  }

  /** The clip playing now, by its name in the file. */
  get clip(): string {
    return this.#clip;
  }

  get animation(): { advancedFrames: number; current: string; finished: boolean } {
    const { clip, frames, needed, ran } = this.#oneShot;
    return {
      advancedFrames: frames,
      current: clip === "" ? this.#clip : clip,
      finished: clip !== "" && ran >= needed - 1e-6,
    };
  }

  /** Seconds a clip lasts at its authored rate. */
  duration(clip: string): number {
    return this.#durations.get(clip) ?? 0;
  }

  /**
   * Switch clip only when it changes: re-playing a finished `"once"` clip restarts it, so a held
   * pose (an aim, a corpse) must not be asked for again every frame.
   */
  play(clip: string, options: IPlay = {}): void {
    const mode = options.mode ?? "loop";
    if (clip === this.#clip && mode === this.#mode && options.restart !== true) return;
    this.#clip = clip;
    this.#mode = mode;
    this.character.play(clip, {
      fade: options.fade ?? 0.18,
      mode,
      ...(options.speed === undefined ? {} : { speed: options.speed }),
    });
    if (mode === "once")
      this.#oneShot = {
        clip,
        frames: 0,
        needed: this.duration(clip) / (options.speed ?? 1),
        ran: 0,
      };
  }

  /** Turns the heading toward `target` by at most `rate` radians a second; returns what is left. */
  turnToward(target: number, rate: number, dt: number): number {
    const delta = MathUtils.euclideanModulo(target - this.heading + Math.PI, Math.PI * 2) - Math.PI;
    const step = Math.sign(delta) * Math.min(Math.abs(delta), rate * dt);
    this.heading = wrap(this.heading + step);
    return delta - step;
  }

  facingVector(out: Vector3): Vector3 {
    return out.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /** Advance the rig and pose the figure on the heading. Call once per frame, last. */
  protected animate(dt: number): void {
    this.figure.rotation.y = this.heading;
    if (this.#oneShot.clip === this.#clip && this.#mode === "once") {
      this.#oneShot.frames += 1;
      this.#oneShot.ran += dt;
    }
    this.character.update(dt);
  }
}

export function wrap(angle: number): number {
  return MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI;
}

/** Heading of the direction from `from` to `to` on the floor plane. */
export function headingTo(from: Vector3, to: Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}
