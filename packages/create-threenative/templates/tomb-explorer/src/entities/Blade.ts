import type { Group } from "three";
import { BLADE } from "../level.js";
import { createBlade } from "../render/props.js";
import { toWorld } from "../render/temple.js";
import { BLADE_THICK, bladeLift } from "../sim/blade.js";
import { CLICK, UNIT } from "../tuning.js";
import type { GameCtx } from "./Explorer.js";

/** The deck the blade hangs over, units: the same one `sim/blade.ts` measures from. */
const DECK = 16 * CLICK;

/** The slicing blade as an entity: a mesh that follows the cycle `sim/blade.ts` decides. */
export class Blade {
  readonly mesh: Group;
  readonly #slab;
  #lift = 0;

  constructor(ctx: GameCtx) {
    const { group, slab } = createBlade();
    this.mesh = group;
    this.#slab = slab;
    const [x, , z] = toWorld(BLADE.x, 0, (BLADE.z0 + BLADE.z1) / 2);
    group.position.set(x, 0, z);
    ctx.add(group);
    this.update(0);
  }

  update(tick: number): void {
    this.#lift = bladeLift(tick);
    this.#slab.position.y = (DECK + this.#lift + BLADE_THICK / 2) * UNIT;
  }

  debug(): Record<string, unknown> {
    return { lift: Math.round(this.#lift) };
  }

  dispose(): void {
    this.mesh.removeFromParent();
  }
}
