import type { ICtx } from "@threenative/core";
import { CharacterBody3D, CollisionShape3D, type IPhysicsContext } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { wardenFigure } from "../render/warden.js";
import type { GameState } from "../state.js";
import { WARDEN_MASK } from "./Crate.js";

type GameCtx = ICtx<GameState, IPhysicsContext>;

const MOVE_SPEED = 4.5;
/** Capsule: total height 2 * (halfHeight + radius) = 1.12 m, centred on the body origin. */
const CAPSULE_HALF_HEIGHT = 0.28;
const CAPSULE_RADIUS = 0.28;
/** How far the solver has to fall short of the asked-for step before it counts as blocked. */
const BLOCKED_FRACTION = 0.45;

export const WARDEN_SPAWN = { x: -4.2, y: 0.62, z: 2.35 } as const;

/**
 * The controlled character: a capsule that pushes, and a figure that leans the way it is pushing.
 *
 * `pushesDynamicBodies` is the whole point of this class. Its default is `false`, which matches
 * Rapier — a character walks into a crate and the crate does not move, which on screen reads as a
 * broken collider rather than as a default someone chose.
 */
export class Warden {
  readonly mesh: Group;
  readonly body: CharacterBody3D;
  #figure: Group;
  #odometer = 0;
  #blockedTicks = 0;
  #previous = new Vector3();
  #hasPrevious = false;
  #asked = 0;
  #facing = 0;

  constructor(ctx: GameCtx) {
    this.mesh = new Group();
    this.mesh.name = "warden";
    this.#figure = wardenFigure();
    // The capsule is centred on the body origin, so a figure modelled standing on y = 0 floats
    // exactly halfHeight + radius above every floor it lands on unless it is offset back down.
    this.#figure.position.y = -(CAPSULE_HALF_HEIGHT + CAPSULE_RADIUS);
    this.mesh.add(this.#figure);
    this.mesh.position.set(WARDEN_SPAWN.x, WARDEN_SPAWN.y, WARDEN_SPAWN.z);
    ctx.add(this.mesh);
    this.body = new CharacterBody3D({
      autostep: { includeDynamicBodies: false, maxHeight: 0.32, minWidth: 0.2 },
      collisionMask: WARDEN_MASK,
      // Named, or the runtime contact log records this body as an anonymous id and a `contacts`
      // assertion has nothing to match on. The registry name (`ctx.entities.add("player", ...)`)
      // is a different namespace and does not reach the physics observation.
      entity: "player",
      object: this.mesh,
      physics: ctx.physics,
      pushesDynamicBodies: true,
      shape: CollisionShape3D.capsule(CAPSULE_HALF_HEIGHT, CAPSULE_RADIUS),
    });
  }

  /**
   * One fixed step. `move` is the intent in world XZ, already clamped to unit length; the replay
   * check hands the same scripted vector in that the keyboard would have produced.
   */
  update(dt: number, move: { readonly x: number; readonly z: number }): void {
    // Both measurements below read LAST tick's ask against LAST tick's delivery, and they have to.
    //
    // `moveAndSlide` queues motion for the bulk step; `mesh.position` still holds the previous
    // transform until the solver writes it, some time after this function returns. Comparing the
    // ask with `mesh.position` inside the same call therefore always measures zero delivered
    // motion, and "the warden was blocked" becomes "the warden pressed a key" — measured, it
    // counted 400 blocked ticks in a 400-tick run in which the warden crossed six metres.
    if (this.#hasPrevious) {
      const delivered = Math.hypot(
        this.mesh.position.x - this.#previous.x,
        this.mesh.position.z - this.#previous.z,
      );
      this.#odometer += this.mesh.position.distanceTo(this.#previous);
      if (this.#asked > 0.004 && delivered < this.#asked * BLOCKED_FRACTION)
        this.#blockedTicks += 1;
    }
    this.#previous.copy(this.mesh.position);
    this.body.velocity.x = move.x * MOVE_SPEED;
    this.body.velocity.z = move.z * MOVE_SPEED;
    this.#asked = Math.hypot(this.body.velocity.x, this.body.velocity.z) * dt;
    this.body.moveAndSlide(dt);
    this.#hasPrevious = true;
    if (move.x !== 0 || move.z !== 0) {
      const target = Math.atan2(move.x, move.z);
      // Shortest-arc turn, framerate independent, so the figure faces the shove rather than
      // snapping between the four arrow directions.
      const delta = Math.atan2(Math.sin(target - this.#facing), Math.cos(target - this.#facing));
      this.#facing = MathUtils.damp(this.#facing, this.#facing + delta, 1 / 0.06, dt);
      this.#figure.rotation.y = this.#facing;
    }
    // Lean into the push. Purely cosmetic, and it is most of what makes the shove read.
    const lean = Math.min(0.28, Math.hypot(move.x, move.z) * 0.28);
    this.#figure.rotation.x = MathUtils.damp(this.#figure.rotation.x, lean, 1 / 0.09, dt);
  }

  teleport(position: { readonly x: number; readonly y: number; readonly z: number }): void {
    // Velocity survives a teleport, and `velocity.y` is the component this class never writes —
    // gravity accumulates into it every step. Two replay passes that start from different
    // vertical speeds resolve their first contacts differently, and the run that is supposed to
    // prove determinism reports 0.28 m of drift. Reset the whole vector, not the two axes the
    // caller happens to set.
    this.body.velocity.set(0, 0, 0);
    this.body.teleport(position);
    this.mesh.position.set(position.x, position.y, position.z);
    this.#previous.copy(this.mesh.position);
    this.#hasPrevious = false;
    this.#asked = 0;
  }

  get fallSpeed(): number {
    return this.body.velocity.y;
  }

  get grounded(): boolean {
    return this.body.grounded;
  }

  get blockedTicks(): number {
    return this.#blockedTicks;
  }

  get odometer(): number {
    return this.#odometer;
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
