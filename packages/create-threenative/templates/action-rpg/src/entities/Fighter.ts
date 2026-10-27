import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import type { IPhysicsContext } from "@threenative/physics";
import { type AnimationClip, Box3, Group, MathUtils, type Object3D, type Vector3 } from "three";
import { type IActionRpgConventions, preparePlayerConventions } from "../conventions.js";
import type { GameState } from "../state.js";

export type GameCtx = ICtx<GameState, IPhysicsContext>;

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

export interface IFighterOptions {
  /** The capsule's half-extent, in metres. The figure's soles land one centimetre below it. */
  readonly halfExtent: number;
  /** Multiplies the whole figure, the capsule and the collider together — this is the boss read. */
  readonly scale?: number;
  /** A small mesh the right hand holds. Omitted for a bare-handed fighter. */
  readonly weapon?: Object3D;
  /** The face the rig starts in. The model faces +Z; the level runs along -X to +X. */
  readonly facing?: number;
}

/**
 * The body every fighter in this game shares: the combat mannequin, its conventions, its facing,
 * and the one rule that decides which clip plays.
 *
 * The clips are named by the action, not by the file — `attack`, `idle`, `death` — and each
 * fighter maps those onto the clip names that suit it, so a hero who swings a sword and a raider
 * who throws a punch are the same code with two different tables. `requiredClips` fails the load
 * by name if the file does not carry one of them, so a renamed clip is a build failure, not a
 * figure that stands still.
 */
export abstract class Fighter {
  readonly mesh = new Group();
  readonly character: SkeletalMesh3D;
  /** The rigged root, offset so the soles meet the capsule. Gameplay animates and aims this. */
  readonly figure = new Group();
  readonly conventions: IActionRpgConventions;
  #action = "";
  #actionRemaining = 0;
  readonly #clipDuration = new Map<string, number>();

  protected constructor(
    ctx: GameCtx,
    model: IMannequin,
    protected readonly clips: Readonly<Record<string, string>>,
    options: IFighterOptions,
  ) {
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: Object.values(clips),
      strideRoot: this.mesh,
    });
    this.figure.add(this.character.root);
    this.figure.scale.setScalar(options.scale ?? 1);
    this.figure.rotation.y = options.facing ?? Math.PI;
    this.mesh.add(this.figure);
    for (const clip of model.animations) this.#clipDuration.set(clip.name, clip.duration);
    // Measured, not guessed: the figure sinks by the distance from its own origin to its lowest
    // posed point, so an asset authored feet-down and one authored mid-stride both land on the
    // floor. Measured before the body is placed, while the mesh is still at the origin.
    const soles = new Box3().setFromObject(this.figure, true).min.y;
    this.figure.position.y = -options.halfExtent - 0.01 - soles;
    this.conventions = preparePlayerConventions(this.character.root, options.weapon);
    this.character.root.traverse((object) => {
      object.castShadow = true;
    });
    this.play("idle", { fade: 0 });
    ctx.add(this.mesh);
  }

  /** The one clip currently playing, by the clip name in the file. */
  get action(): string {
    return this.#action;
  }

  /**
   * Start a clip. `hold` is how long a one-shot keeps the fighter out of its locomotion loop; the
   * caller that owns the state machine decides when the action ends, not the clip. `fit` speeds
   * the clip up so the whole clip plays inside `hold`.
   */
  play(
    action: string,
    options: { readonly fade?: number; readonly fit?: boolean; readonly hold?: number } = {},
  ): void {
    const clip = this.clips[action];
    if (clip === undefined) throw new Error(`Unknown fighter action '${action}'.`);
    this.#action = action;
    this.#actionRemaining = options.hold ?? 0;
    const duration = this.#clipDuration.get(clip) ?? 0;
    const speed =
      options.fit === true && this.#actionRemaining > 0 && duration > 0
        ? duration / this.#actionRemaining
        : undefined;
    this.character.play(clip, {
      fade: options.fade ?? 0.15,
      mode: "once",
      ...(speed === undefined ? {} : { speed }),
    });
  }

  /** True while a one-shot is still holding; locomotion waits for it. */
  get busy(): boolean {
    return this.#actionRemaining > 0;
  }

  /**
   * Turn toward a heading, play the locomotion clip the body is really doing, and advance the rig.
   *
   * `speed` is horizontal ground speed in m/s, so the clip is chosen from the body rather than
   * from the stick, and `AnimationPlayer`'s stride sync re-times it to the ground actually covered.
   */
  protected animateRig(dt: number, heading: number | undefined, speed: number): void {
    this.#actionRemaining = Math.max(0, this.#actionRemaining - dt);
    if (heading !== undefined && speed > 0.05) {
      const turn = MathUtils.euclideanModulo(
        heading - this.figure.rotation.y + Math.PI,
        Math.PI * 2,
      );
      this.figure.rotation.y += (turn - Math.PI) * Math.min(1, dt * 12);
    }
    if (this.#actionRemaining === 0) this.play(speed > 0.05 ? "walk" : "idle", { fade: 0.2 });
    this.character.update(dt);
  }

  /**
   * Keep a corpse's rig advancing. A dead body has no locomotion to pick from, and a rig whose
   * `update` is never called freezes mid-clip with its bones half-dragged toward the next pose.
   */
  protected animateStill(dt: number): void {
    this.character.update(dt);
  }

  /** The unit vector the figure faces, written into a scratch vector. */
  facingVector(out: Vector3): void {
    out.set(Math.sin(this.figure.rotation.y), 0, Math.cos(this.figure.rotation.y));
  }
}
