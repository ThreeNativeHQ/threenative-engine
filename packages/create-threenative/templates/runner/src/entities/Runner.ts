import { type ICtx, SkeletalMesh3D } from "@threenative/core";
import { Area3D, CollisionShape3D } from "@threenative/physics";
import { type AnimationClip, Group, MathUtils, type Object3D } from "three";
import { type IRunnerConventions, prepareRunnerConventions } from "../conventions.js";
import { OBSTACLE_LAYER, type RunnerPhysics } from "../physics.js";
import type { ITouchInput } from "../render/touch-controls.js";
import type { GameState } from "../state.js";
import { LANE_X } from "../track.js";

type GameCtx = ICtx<GameState, RunnerPhysics>;

const LANE_BLEND = 12;
/**
 * Take-off speed, m/s: a 1.9 m apex, so the hitbox clears a 1.5 m block for 0.44 s (4.8 m at the
 * 11 m/s start speed). At 7.2 m/s the apex was 1.36 m and every jump over a block was a crash.
 */
export const JUMP_SPEED = 8.5;
export const GRAVITY = -19;
/** The runner's collision box, metres; its centre rides `lift` above the feet. */
export const HITBOX = { depth: 0.7, height: 1.3, lift: 0.7, width: 0.7 } as const;
/** Within this many metres of an obstacle's centre and still alive: a near miss. */
const NEAR_MISS = 1.5;

/** The clips `assets/mannequin.glb` ships, by the name this file plays them under. */
const CLIPS = {
  jog: "Jog_Fwd_Loop",
  jumpStart: "Jump_Start",
  jumpLoop: "Jump_Loop",
  jumpLand: "Jump_Land",
} as const;

export interface IRunnerModel {
  readonly scene: Object3D;
  readonly animations: readonly AnimationClip[];
}

/**
 * The player.
 *
 * Not a rigid body: a runner's feel is a lane snap and a fixed jump arc, and handing either to a
 * solver makes both worse. What *is* physics is the collision — the runner carries an `Area3D`
 * that scans the obstacle layer, so a hit is an overlap the engine reports rather than a distance
 * check this file would have to keep in sync with the obstacle geometry.
 *
 * The figure is `assets/mannequin.glb`, the same CC0 mannequin the `minimal` arena opens on.
 * Swap in any rigged glTF with the same clip roles by editing `CLIPS`; `requiredClips` fails the
 * load, by name, if one is missing.
 */
export class Runner {
  readonly mesh: Group;
  readonly character: SkeletalMesh3D;
  readonly tags = ["player", "runner"];
  readonly hitbox: Area3D;
  #conventions: IRunnerConventions;
  #lane = 1;
  #height = 0;
  #vertical = 0;
  #crashed = false;
  #nearMisses = 0;

  constructor(ctx: GameCtx, model: IRunnerModel) {
    this.mesh = new Group();
    this.mesh.name = "player";
    this.character = new SkeletalMesh3D({
      source: model.scene,
      clips: model.animations,
      requiredClips: Object.values(CLIPS),
      strideRoot: this.mesh,
    });
    const figure = this.character.root;
    figure.traverse((object) => {
      object.castShadow = true;
    });
    // The model faces +Z; the track runs toward -Z, so turn the figure to face down it.
    figure.rotation.y = Math.PI;
    this.mesh.add(figure);
    this.#conventions = prepareRunnerConventions(figure);
    this.character.play(CLIPS.jog);
    ctx.add(this.mesh);
    this.hitbox = new Area3D({
      collisionLayer: 0,
      collisionMask: OBSTACLE_LAYER,
      entity: "runner-hitbox",
      physics: ctx.physics,
      position: { x: 0, y: HITBOX.lift, z: 0 },
      shape: CollisionShape3D.box(HITBOX.width, HITBOX.height, HITBOX.depth),
    });
    this.hitbox.on("bodyEntered", () => {
      this.#crashed = true;
    });
  }

  get lane(): number {
    return this.#lane;
  }

  get crashed(): boolean {
    return this.#crashed;
  }

  get airborne(): boolean {
    return this.#height > 0.01;
  }

  get nearMisses(): number {
    return this.#nearMisses;
  }

  /** Counts one near miss. The scene owns *what* counts as near; this owns the tally. */
  recordNearMiss(): void {
    this.#nearMisses += 1;
  }

  update(ctx: GameCtx, dt: number, distance: number, touch?: ITouchInput): void {
    if (this.#crashed) return;
    const move = ctx.input.vector("move");
    // The stick is a lane *change*, not an axis: holding right must move one lane, not slide
    // continuously across three. `#steering` is that edge, and it is why a held thumb behaves
    // like a tapped key.
    const steer = move.x + (touch?.move.x ?? 0);
    if (touch?.leftPressed === true) this.#lane -= 1;
    if (touch?.rightPressed === true) this.#lane += 1;
    if (Math.abs(steer) > 0.6 && !this.#steering) {
      this.#lane += steer > 0 ? 1 : -1;
      this.#steering = true;
    }
    if (Math.abs(steer) <= 0.4) this.#steering = false;
    this.#lane = MathUtils.clamp(this.#lane, 0, LANE_X.length - 1);

    const stickJump = (touch?.move.y ?? 0) > 0.65;
    const jumped = (ctx.input.justPressed("jump") || stickJump) && !this.airborne;
    if (jumped) this.#vertical = JUMP_SPEED;
    const wasAirborne = this.airborne;
    this.#height = Math.max(0, this.#height + this.#vertical * dt);
    this.#vertical = this.#height > 0 ? this.#vertical + GRAVITY * dt : 0;
    this.#animate(jumped, wasAirborne);

    const targetX = LANE_X[this.#lane] ?? 0;
    const blend = Math.min(1, Math.max(0, dt) * LANE_BLEND);
    this.mesh.position.x += (targetX - this.mesh.position.x) * blend;
    this.mesh.position.y = this.#height;
    this.mesh.position.z = -distance;
    this.mesh.rotation.z = (targetX - this.mesh.position.x) * 0.35;
    this.#conventions.applyGrounding(this.#height, dt);
    this.character.update(dt);
    this.hitbox.setPosition({
      x: this.mesh.position.x,
      y: this.#height + HITBOX.lift,
      z: this.mesh.position.z,
    });
  }

  /** Picks a clip from what the runner is doing: run, take off, hang, land, run again. */
  #animate(jumped: boolean, wasAirborne: boolean): void {
    if (jumped) this.character.play(CLIPS.jumpStart, { fade: 0.08, mode: "once" });
    else if (this.airborne && this.character.finished)
      this.character.play(CLIPS.jumpLoop, { fade: 0.15 });
    else if (wasAirborne && !this.airborne)
      this.character.play(CLIPS.jumpLand, { fade: 0.06, mode: "once" });
    else if (!this.airborne && this.character.finished)
      this.character.play(CLIPS.jog, { fade: 0.2 });
  }

  /** True when the runner is beside, rather than on top of, an obstacle at `x` on this stretch. */
  isNearMiss(obstacleX: number): boolean {
    const gap = Math.abs(obstacleX - this.mesh.position.x);
    return gap > 0.85 && gap < NEAR_MISS;
  }

  debug(): Record<string, unknown> {
    return {
      airborne: this.airborne,
      crashed: this.#crashed,
      groundClearance: this.#conventions.groundSnap.clearance,
      lane: this.#lane,
      nearMisses: this.#nearMisses,
      normaliseFactor: this.#conventions.normaliseFactor,
      position: this.mesh.position.toArray(),
    };
  }

  dispose(): void {
    this.hitbox.dispose();
    this.mesh.removeFromParent();
  }

  #steering = false;
}
