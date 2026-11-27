// A regenerating shield over a health bar that does not regenerate.
//
// Reference: halo-combat-evolved-opence (OpenCE). The shield takes a hit first. When the hit is
// larger than the shield, the shield empties and the rest goes to health in the same hit
// (`shield-absorption`, source/objects/damage.c:865). Any hit stops the recharge for a stun time,
// and a hit on a broken shield stuns longer. The recharge then runs per tick (`shield-recharge`).
import { TICKS_PER_SECOND, TickClock, toTicks } from "./ticks.js";

export const SHIELD_MAX = 100;
export const HEALTH_MAX = 100;
/**
 * Seconds without recharge after a hit, and after a hit on an empty shield, then how fast the
 * shield refills. The card says these come from the resistance block, so the numbers are this
 * game-owned: a hit pauses the recharge, a collapse pauses it twice as long, a refill takes 2.5 s.
 */
const HIT_STUN_SECONDS = 2.5;
const BROKEN_STUN_SECONDS = 5;
const RECHARGE_SECONDS = 2.5;

export class Vitals {
  shield = SHIELD_MAX;
  health = HEALTH_MAX;
  /** Ticks left before the shield may recharge. */
  stunTicks = 0;
  readonly #clock = new TickClock();

  get dead(): boolean {
    return this.health <= 0;
  }

  /** Returns what reached the health bar. */
  hurt(amount: number): number {
    const absorbed = Math.min(this.shield, amount);
    this.shield -= absorbed;
    const spill = amount - absorbed;
    this.health = Math.max(0, this.health - spill);
    this.stunTicks = toTicks(this.shield <= 0 ? BROKEN_STUN_SECONDS : HIT_STUN_SECONDS);
    return spill;
  }

  update(dt: number): void {
    if (this.dead) return;
    for (let tick = this.#clock.step(dt); tick > 0; tick -= 1) {
      if (this.stunTicks > 0) this.stunTicks -= 1;
      else
        this.shield = Math.min(
          SHIELD_MAX,
          this.shield + SHIELD_MAX / (RECHARGE_SECONDS * TICKS_PER_SECOND),
        );
    }
  }
}
