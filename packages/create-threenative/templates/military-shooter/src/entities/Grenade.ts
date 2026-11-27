import { Vector3 } from "three";
import { UNIT } from "../rules/movement.js";
import { createGrenade } from "../render/props.js";

/**
 * A grenade in flight: thrown fast and a little upward, bounced by walls and floor, blown after a fuse.
 *
 * Reference: quake `grenade-ballistics` (qw-qc/weapons.qc). It leaves at 600 units per second with 200 up
 * (:678), burns a 2.5 s fuse (:701) and does 120 at the centre (:625). Gravity, the bounce, the
 * blast radius and the fall-off are game-owned.
 */
export const THROW_SPEED = 600 * UNIT;
export const THROW_LIFT = 200 * UNIT;
export const FUSE_SECONDS = 2.5;
export const BLAST_DAMAGE = 120;
/** Metres. Damage falls off in a straight line to zero at this distance. */
export const BLAST_RADIUS = 5;
const GRAVITY = 9.8;
const RESTITUTION = 0.45;
/** What a bounce keeps of the speed along the surface. */
const SLIDE_KEEP = 0.7;
const RADIUS = 0.06;

export interface IWorldCast {
  (from: Vector3, to: Vector3): { readonly point: Vector3; readonly normal: Vector3 } | undefined;
}

export class Grenade {
  readonly mesh = createGrenade();
  readonly position = new Vector3();
  readonly velocity = new Vector3();
  fuse = FUSE_SECONDS;
  readonly #next = new Vector3();

  constructor(
    origin: Vector3,
    direction: Vector3,
    carried: { readonly x: number; readonly z: number },
  ) {
    this.position.copy(origin);
    this.velocity
      .copy(direction)
      .multiplyScalar(THROW_SPEED)
      .add(new Vector3(carried.x, THROW_LIFT, carried.z));
    this.mesh.position.copy(origin);
  }

  /** Advance one step. True when the fuse ran out. */
  step(dt: number, cast: IWorldCast): boolean {
    this.fuse = Math.max(0, this.fuse - dt);
    this.velocity.y -= GRAVITY * dt;
    this.#next.copy(this.position).addScaledVector(this.velocity, dt);
    const hit = cast(this.position, this.#next);
    if (hit !== undefined) {
      const along = this.velocity.dot(hit.normal);
      // Reflect the part into the surface, keep most of the part along it.
      this.velocity.addScaledVector(hit.normal, -along * (1 + RESTITUTION));
      const slide = this.velocity
        .clone()
        .addScaledVector(hit.normal, -this.velocity.dot(hit.normal));
      this.velocity.addScaledVector(slide, SLIDE_KEEP - 1);
      this.position.copy(hit.point).addScaledVector(hit.normal, RADIUS);
    } else this.position.copy(this.#next);
    this.mesh.position.copy(this.position);
    this.mesh.rotation.x += dt * 9;
    return this.fuse === 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}

/** Damage at `distance` from the blast, 0 outside the radius. */
export function blastDamage(distance: number): number {
  return Math.max(0, BLAST_DAMAGE * (1 - distance / BLAST_RADIUS));
}
