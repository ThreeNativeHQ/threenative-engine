import { SkeletalMesh3D } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import {
  type AnimationClip,
  Box3,
  Group,
  type Material,
  MathUtils,
  type Object3D,
  Vector3,
} from "three";
import { type IOpenWorldConventions, preparePlayerConventions } from "../conventions.js";
import type { GameCtx } from "./layers.js";

/** What `ctx.assets.model("mannequin-combat.glb")` hands back. */
export interface IMannequin {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

/** Every clip a person in this city plays, by the role this file names it under. */
export const CLIPS = {
  idle: "Idle_Loop",
  walk: "Walk_Loop",
  run: "Jog_Fwd_Loop",
  sprint: "Sprint_Loop",
  punch: "Punch_Jab",
  punch2: "Punch_Cross",
  aim: "Pistol_Idle_Loop",
  shoot: "Pistol_Shoot",
  reload: "Pistol_Reload",
  hit: "Hit_Chest",
  death: "Death01",
  interact: "Interact",
} as const;
export type Action = keyof typeof CLIPS;
type Loop = "idle" | "walk" | "run" | "sprint" | "aim";

/** Capsule for a 1.8 m figure: 0.6 m half-height plus a 0.3 m radius at each end. */
export const HALF_HEIGHT = 0.6;
export const RADIUS = 0.3;
/** Body centre above the soles. */
export const CENTRE = HALF_HEIGHT + RADIUS;
/** Where a body is parked while it is not in the world (inside a car, or fallen). */
const PARKED_Y = -40;

/** Ground speeds in m/s that switch the locomotion clip. */
const WALK_BELOW = 2.4;
const RUN_BELOW = 5.2;

const _world = new Vector3();

/**
 * The body every person in the city shares: the combat mannequin, its conventions, its facing and
 * the one rule that picks a clip. The player, a pedestrian and an officer differ only in what drives
 * them and the material they wear.
 *
 * Two objects, because a person can leave the physics without leaving the scene: `root` is what
 * the capsule moves, `visual` is what you see. A fallen pedestrian or a player who got into a car
 * parks the capsule out of the world and leaves the visual where it was (or hides it).
 */
export abstract class Humanoid {
  readonly root = new Group();
  readonly visual = new Group();
  readonly figure = new Group();
  readonly character: SkeletalMesh3D;
  readonly body: CharacterBody3D;
  readonly conventions: IOpenWorldConventions;
  health: number;
  #action: Action = "idle";
  #remaining = 0;
  #attached = true;
  readonly #durations = new Map<string, number>();
  #oneShot = { clip: "", frames: 0, needed: 0, ran: 0 };

  protected constructor(
    ctx: GameCtx,
    model: IMannequin,
    options: {
      readonly position: Vector3;
      readonly material?: Material;
      readonly weapon?: Object3D;
      readonly health: number;
      readonly collisionLayer: number;
      readonly collisionMask: number;
    },
  ) {
    this.health = options.health;
    this.character = new SkeletalMesh3D({
      clips: model.animations,
      requiredClips: Object.values(CLIPS),
      source: model.scene,
      strideRoot: this.root,
    });
    this.figure.add(this.character.root);
    this.figure.rotation.y = Math.PI;
    this.visual.add(this.figure);
    this.root.add(this.visual);
    for (const clip of model.animations) this.#durations.set(clip.name, clip.duration);
    this.conventions = preparePlayerConventions(this.character.root, options.weapon);
    // Measured, not guessed: the figure sinks by its own lowest posed point, so the soles meet the
    // bottom of the capsule whatever the rig's origin.
    const soles = new Box3().setFromObject(this.figure, true).min.y;
    this.figure.position.y = -CENTRE - 0.01 - soles;
    const material = options.material;
    this.character.root.traverse((object) => {
      object.castShadow = true;
      const mesh = object as { isSkinnedMesh?: boolean; material?: unknown };
      if (material !== undefined && mesh.isSkinnedMesh === true) mesh.material = material;
    });
    this.root.position.set(
      options.position.x,
      options.position.y + CENTRE + 0.05,
      options.position.z,
    );
    this.character.play(CLIPS.idle);
    ctx.add(this.root);
    this.body = new CharacterBody3D({
      autostep: { maxHeight: 0.4, minWidth: 0.2 },
      collisionLayer: options.collisionLayer,
      collisionMask: options.collisionMask,
      object: this.root,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
      snapToGround: 0.3,
    });
  }

  /** The object the playtest bridge and the camera read: the visual wherever it stands. */
  get mesh(): Object3D {
    return this.#attached ? this.root : this.visual;
  }

  get alive(): boolean {
    return this.health > 0;
  }

  /** World position of what you see. */
  get position(): Vector3 {
    return this.#attached ? this.root.position : this.visual.position;
  }

  get inWorld(): boolean {
    return this.#attached;
  }

  get action(): Action {
    return this.#action;
  }

  /** True while a one-shot (a punch, a shot, a flinch, a fall) still holds the rig. */
  get busy(): boolean {
    return this.#remaining > 0;
  }

  /** What `assert.animation[]` reads: the last one-shot and whether it ran its whole clip. */
  get animation(): { advancedFrames: number; current: string; finished: boolean } {
    const { clip, frames, needed, ran } = this.#oneShot;
    return {
      advancedFrames: frames,
      current: clip === "" ? (this.character.current ?? "") : clip,
      finished: clip !== "" && ran >= needed - 1e-6,
    };
  }

  /** The direction the figure faces, on the ground plane. */
  facing(out: Vector3): Vector3 {
    return out.set(Math.sin(this.figure.rotation.y), 0, Math.cos(this.figure.rotation.y));
  }

  /** Face a heading at once (aiming and arrests snap; walking eases in `animateRig`). */
  face(heading: number): void {
    this.figure.rotation.y = heading;
  }

  /**
   * Start a one-shot. `hold` keeps locomotion off it; `fit` plays the whole clip inside `hold`; an
   * infinite hold is a pose kept until `release` (a body on the ground).
   */
  play(
    action: Action,
    options: { readonly fade?: number; readonly hold?: number; readonly fit?: boolean } = {},
  ): void {
    const clip = CLIPS[action];
    this.#action = action;
    this.#remaining = options.hold ?? 0;
    const duration = this.#durations.get(clip) ?? 0;
    const speed =
      options.fit === true &&
      Number.isFinite(this.#remaining) &&
      this.#remaining > 0 &&
      duration > 0
        ? duration / this.#remaining
        : undefined;
    this.character.play(clip, {
      fade: options.fade ?? 0.12,
      mode: "once",
      ...(speed === undefined ? {} : { speed }),
    });
    if (this.#remaining > 0 && action !== "hit")
      this.#oneShot = { clip, frames: 0, needed: duration / (speed ?? 1), ran: 0 };
  }

  /** End a held pose, so locomotion picks the next clip (getting up, respawning). */
  release(): void {
    this.#remaining = 0;
  }

  /**
   * Turn toward `heading`, then loop the locomotion clip the body is really doing. `speed` is the
   * measured ground speed, so stride sync re-times the legs to the ground actually covered.
   * `aiming` holds the pistol stance instead of the idle.
   */
  protected animateRig(
    dt: number,
    heading: number | undefined,
    speed: number,
    aiming = false,
    turnRate = 12,
  ): void {
    if (this.#remaining > 0 && this.#action !== "hit" && Number.isFinite(this.#remaining)) {
      this.#oneShot.frames += 1;
      this.#oneShot.ran += Math.min(dt, this.#remaining);
    }
    this.#remaining = Math.max(0, this.#remaining - dt);
    if (heading !== undefined) {
      const turn = MathUtils.euclideanModulo(
        heading - this.figure.rotation.y + Math.PI,
        Math.PI * 2,
      );
      this.figure.rotation.y += (turn - Math.PI) * Math.min(1, dt * turnRate);
    }
    if (this.#remaining === 0) {
      const next: Loop =
        speed < 0.05
          ? aiming
            ? "aim"
            : "idle"
          : speed < WALK_BELOW
            ? "walk"
            : speed < RUN_BELOW
              ? "run"
              : "sprint";
      if (this.#action !== next) {
        this.#action = next;
        this.character.play(CLIPS[next], { fade: 0.2 });
      }
    }
    this.character.update(dt);
  }

  /** Keep a still body's rig advancing, so a held pose settles instead of freezing mid-blend. */
  protected animateStill(dt: number): void {
    this.#remaining = Math.max(0, this.#remaining - (Number.isFinite(this.#remaining) ? dt : 0));
    this.character.update(dt);
  }

  /** Planar speed of the last move, in m/s. */
  groundSpeed(): number {
    return this.#attached ? Math.hypot(this.body.velocity.x, this.body.velocity.z) : 0;
  }

  /** Move with gravity toward a planar velocity; `moveAndSlide` keeps the body out of walls. */
  protected move(dt: number, vx: number, vz: number): void {
    this.body.velocity.x = vx;
    this.body.velocity.z = vz;
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
  }

  /**
   * Take the capsule out of the world. The visual stays where it stood (`hide` for a player who
   * climbed into a car), so a fallen body keeps lying on the street without blocking traffic.
   */
  leaveWorld(hide: boolean): void {
    if (!this.#attached) return;
    this.visual.getWorldPosition(_world);
    const scene = this.root.parent;
    this.#attached = false;
    if (scene !== null) scene.add(this.visual);
    this.visual.position.copy(_world);
    this.visual.visible = !hide;
    this.body.velocity.set(0, 0, 0);
    this.body.teleport({ x: this.root.position.x, y: PARKED_Y, z: this.root.position.z });
  }

  /** Put the capsule back at `at` (feet on the ground there) with the visual inside it. */
  enterWorld(at: Vector3): void {
    this.body.velocity.set(0, 0, 0);
    this.body.teleport({ x: at.x, y: at.y + CENTRE + 0.05, z: at.z });
    this.root.add(this.visual);
    this.visual.position.set(0, 0, 0);
    this.visual.visible = true;
    this.#attached = true;
  }

  dispose(): void {
    this.body.dispose();
    this.root.removeFromParent();
    this.visual.removeFromParent();
  }
}
