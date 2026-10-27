import type { Vector3 } from "three";
import type { TownCollider } from "./town.js";

/**
 * Whether a sight line is blocked, answered from the world's collision boxes.
 *
 * ## Why not a raycast
 *
 * This started as `ctx.raycastAll` against every solid mesh in the town, run once per soldier per
 * frame. Measured across five soldiers it cost 15.4 ms of a 16.3 ms frame — the whole mid-round
 * hitch, in one call. A raycast has to walk a scene graph, update world matrices, build or consult
 * an acceleration structure per geometry, collect every hit and sort them, and it does all of that
 * to answer a question with one bit in it.
 *
 * The town already publishes exactly what a sight line cares about: `TownCollider`, the axis-
 * aligned boxes that stop the player walking through walls. A segment against an AABB is the slab
 * test — six divides and a few comparisons, no allocation, no traversal — and it stops at the
 * first box that blocks. A couple of hundred boxes come out in microseconds.
 *
 * ## Why this is also more correct
 *
 * The raycast tested render meshes, so a soldier's line of sight could be broken by a handrail, an
 * awning, or a plate of thin dressing that a player can plainly see through, and the old code
 * carried a `userData` special case to unpick one of those. Sight is now blocked by precisely what
 * blocks movement: if you cannot walk through it, you cannot see through it. That is one rule with
 * no exceptions list, and it is the rule the level was built around.
 *
 * Purely decorative geometry no longer occludes. That is the intended trade: a soldier who spots
 * you through a railing is a fair fight, and one who loses you behind a drainpipe is a bug report.
 */

/** A hair off each end, so a body standing flush against a wall does not occlude itself. */
const END_EPSILON = 0.05;

export class BoxOccluders {
  readonly #boxes: readonly TownCollider[];
  #tests = 0;

  constructor(boxes: readonly TownCollider[]) {
    this.#boxes = boxes;
  }

  /** Sight-line tests answered since construction; the dev overlay reads it. */
  get tests(): number {
    return this.#tests;
  }

  get boxes(): number {
    return this.#boxes.length;
  }

  /**
   * True when nothing solid stands between `from` and `to`.
   *
   * With `into`, every crossed box is appended to it and the walk does not stop at the first
   * one: the caller needs the whole set to narrow its exact test to the pieces standing there.
   * A crossed box is conservative — the deck colliders span the open air beneath a walkway —
   * so it is a candidate list, not the answer.
   */
  clear(from: Vector3, to: Vector3, into?: TownCollider[]): boolean {
    this.#tests += 1;
    into?.splice(0, into.length);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const length = Math.hypot(dx, dy, dz);
    if (length < 1e-4) return true;
    const near = END_EPSILON;
    const far = length - END_EPSILON;
    if (far <= near) return true;
    // Unit direction, and its reciprocal once per call rather than once per box.
    const ux = dx / length;
    const uy = dy / length;
    const uz = dz / length;
    const ix = ux === 0 ? Number.POSITIVE_INFINITY : 1 / ux;
    const iy = uy === 0 ? Number.POSITIVE_INFINITY : 1 / uy;
    const iz = uz === 0 ? Number.POSITIVE_INFINITY : 1 / uz;

    for (const box of this.#boxes) {
      const { min, max } = box;
      // Slab test, one axis at a time. `tEnter` is how far along the ray the box starts,
      // `tExit` how far along it ends; they cross over when the ray misses.
      let tEnter = near;
      let tExit = far;

      let t1 = ((min[0] as number) - from.x) * ix;
      let t2 = ((max[0] as number) - from.x) * ix;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) continue;

      t1 = ((min[1] as number) - from.y) * iy;
      t2 = ((max[1] as number) - from.y) * iy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) continue;

      t1 = ((min[2] as number) - from.z) * iz;
      t2 = ((max[2] as number) - from.z) * iz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) continue;

      // The segment enters this box before it ends: something solid is in the way.
      if (into === undefined) return false;
      into.push(box);
    }
    return into === undefined || into.length === 0;
  }

  debug(): { boxes: number; tests: number } {
    return { boxes: this.#boxes.length, tests: this.#tests };
  }
}
