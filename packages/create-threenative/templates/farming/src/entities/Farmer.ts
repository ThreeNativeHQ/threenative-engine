import { CharacterBody3D, CollisionShape3D } from "@threenative/physics";
import type { Vector2, Vector3 } from "three";
import { type IToolRack, createCarried, createToolRack, dress, farmerMaterial } from "../render/props.js";
import { PLAYER_LAYER, WORLD_LAYER } from "../level.js";
import { Fighter, type GameCtx, type IMannequin } from "./Fighter.js";

/** The clips `assets/mannequin-combat.glb` ships, by the work this file plays them under. */
const CLIPS = {
  /** A hoe or a hammer: the sword's overhead chop. */
  chop: "Sword_Attack",
  faint: "Death01",
  idle: "Idle_Loop",
  /** The can and the shop: the generic hand gesture. */
  interact: "Interact",
  /** The sickle: a quick stab. */
  jab: "Punch_Jab",
  /** Seeds, a harvest and the bin: bend to the ground. */
  pick: "PickUp_Table",
  /** Walking while spent. */
  tired: "Walk_Loop",
  walk: "Jog_Fwd_Loop",
} as const;

export type WorkAction = "chop" | "interact" | "jab" | "pick";

const HALF_HEIGHT = 0.6;
const RADIUS = 0.3;
/** The capsule's centre height: the figure's soles meet the ground one centimetre below it. */
export const CENTRE_HEIGHT = HALF_HEIGHT + RADIUS;
/** The farmer works the tile 1.3 m ahead of its centre along the facing axis. */
export const REACH = 1.3;
/** Seconds a swing lasts. The tool's effect lands halfway through. */
export const SWING_TIME: Readonly<Record<WorkAction, number>> = {
  chop: 0.7,
  interact: 0.6,
  jab: 0.45,
  pick: 0.7,
};

export class Farmer extends Fighter {
  readonly body: CharacterBody3D;
  readonly rack: IToolRack;
  readonly carriedCrop = createCarried();
  /** The axis the farmer faces for picking a tile: one of the four compass unit vectors. */
  readonly facing = { x: 0, z: -1 };
  /** Planar speed this tick, metres a second. */
  speed = 0;
  fainted = false;
  #strike: { left: number; run: () => void } | undefined;

  constructor(ctx: GameCtx, model: IMannequin, spawn: Vector3) {
    const rack = createToolRack();
    super(ctx, model, CLIPS, { halfExtent: CENTRE_HEIGHT, weapon: rack.holder });
    this.rack = rack;
    dress(this.character.root, farmerMaterial);
    this.mesh.position.copy(spawn);
    this.carriedCrop.root.position.y = 1.28;
    this.mesh.add(this.carriedCrop.root);
    this.body = new CharacterBody3D({
      collisionLayer: PLAYER_LAYER,
      collisionMask: WORLD_LAYER,
      gravity: 0,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(HALF_HEIGHT, RADIUS),
    });
    this.face();
  }

  /** The point the farmer works: `REACH` metres ahead along the facing axis. */
  target(out: { x: number; z: number }): { x: number; z: number } {
    out.x = this.mesh.position.x + this.facing.x * REACH;
    out.z = this.mesh.position.z + this.facing.z * REACH;
    return out;
  }

  /** Turn the figure to the facing axis. */
  face(): void {
    this.figure.rotation.y = Math.atan2(this.facing.x, this.facing.z);
  }

  /**
   * Start a piece of work. The clip plays whole inside `SWING_TIME`; `run` fires halfway, when the
   * tool meets the ground.
   */
  work(action: WorkAction, run: () => void): void {
    const hold = SWING_TIME[action];
    this.face();
    this.play(action, { fade: 0.08, fit: true, hold });
    this.#strike = { left: hold / 2, run };
  }

  /** The farmer collapses and stays down until `wake`. */
  faint(): void {
    this.fainted = true;
    this.#strike = undefined;
    this.body.velocity.set(0, 0, 0);
    this.play("faint", { fade: 0.05, hold: Number.POSITIVE_INFINITY });
  }

  /** Stand up at `spawn`, facing the field. */
  wake(spawn: Vector3): void {
    this.fainted = false;
    this.mesh.position.copy(spawn);
    this.body.teleport(this.mesh.position);
    this.facing.x = 0;
    this.facing.z = -1;
    this.face();
    this.play("idle", { fade: 0 });
  }

  /**
   * Walk and animate. `move` is the stick (+y is up the screen, north), `maxSpeed` the tier's
   * pace. A swing locks the feet.
   */
  update(dt: number, move: Vector2, maxSpeed: number): void {
    if (this.fainted) {
      this.speed = 0;
      this.animateStill(dt);
      return;
    }
    if (this.#strike !== undefined) {
      this.#strike.left -= dt;
      if (this.#strike.left <= 0) {
        const { run } = this.#strike;
        this.#strike = undefined;
        run();
      }
    }
    const walking = !this.busy && move.lengthSq() > 0.01;
    if (walking) {
      const length = Math.min(1, move.length());
      this.body.velocity.set((move.x / move.length()) * maxSpeed * length, 0, (-move.y / move.length()) * maxSpeed * length);
      if (Math.abs(move.x) > Math.abs(move.y)) {
        this.facing.x = Math.sign(move.x);
        this.facing.z = 0;
      } else {
        this.facing.x = 0;
        this.facing.z = -Math.sign(move.y);
      }
    } else this.body.velocity.set(0, 0, 0);
    this.body.moveAndSlide(dt);
    this.conventions.applyGrounding(0, dt);
    this.speed = Math.hypot(this.body.velocity.x, this.body.velocity.z);
    this.walkAction = maxSpeed < 2.5 ? "tired" : "walk";
    this.animateRig(dt, walking ? Math.atan2(this.body.velocity.x, this.body.velocity.z) : undefined, this.speed);
  }

  /** Stand still while the night screen shows. */
  freeze(dt: number): void {
    this.speed = 0;
    this.body.velocity.set(0, 0, 0);
    if (this.fainted) this.animateStill(dt);
    else this.animateRig(dt, undefined, 0);
  }
}
