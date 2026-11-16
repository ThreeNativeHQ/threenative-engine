import { MathUtils } from "three";

/**
 * The nitro tank: 0 to 1, burned while the nitro button is held, refilled by driving and faster
 * by drifting.
 *
 * The rules follow Need for Speed: Most Wanted (`EngineRacer.cpp:926-976`): nitro engages only
 * at speed and stays on down to half that speed, the tank drains over a discharge time, a
 * disengage delay runs before the refill starts, and the refill time blends between a slow and a
 * fast value across a speed band.
 */
export const NITRO = {
  /** Seconds a full tank burns. */
  dischargeSeconds: 2.6,
  /** Engages at or above this, in m/s (NFS's 10 mph); stays engaged down to half of it. */
  engageSpeed: 4.5,
  /** Seconds after release before the tank starts to refill. */
  disengageDelay: 1,
  /** Seconds a passive refill takes at the low and the high end of the speed band, in m/s. */
  refillSlowSeconds: 40,
  refillFastSeconds: 18,
  refillBand: [6, 17] as const,
  /** Tank per second while the car is in a scored drift: about four seconds of drift fill it. */
  driftRefillPerSecond: 0.25,
} as const;

export class Nitro {
  /** The tank, 0 to 1. A race starts with it full. */
  tank = 1;
  engaged = false;
  /** How many times nitro engaged, which is what the HUD and the boost scenario count. */
  uses = 0;
  /**
   * Tank the **drift** path added this race, and the tank the passive path added.
   *
   * Two counters rather than one, because "a drifting car refills faster" is a claim about a
   * rate difference, and a single tank reading cannot separate the two paths that fill it.
   */
  driftGain = 0;
  refillGain = 0;
  #delay = 0;

  update(held: boolean, speed: number, drifting: boolean, dt: number): void {
    const canStay = speed >= NITRO.engageSpeed * 0.5;
    const canStart = speed >= NITRO.engageSpeed && this.tank > 0.05;
    const next = held && this.tank > 0 && (this.engaged ? canStay : canStart);
    if (next && !this.engaged) this.uses += 1;
    this.engaged = next;
    if (this.engaged) {
      this.tank = Math.max(0, this.tank - dt / NITRO.dischargeSeconds);
      this.#delay = NITRO.disengageDelay;
      return;
    }
    if (drifting) {
      const gained = Math.min(1 - this.tank, NITRO.driftRefillPerSecond * dt);
      this.tank += gained;
      this.driftGain += gained;
    }
    if (this.#delay > 0) {
      this.#delay = Math.max(0, this.#delay - dt);
      return;
    }
    const [low, high] = NITRO.refillBand;
    const blend = MathUtils.clamp((speed - low) / (high - low), 0, 1);
    const seconds = MathUtils.lerp(NITRO.refillSlowSeconds, NITRO.refillFastSeconds, blend);
    const gained = Math.min(1 - this.tank, dt / seconds);
    this.tank += gained;
    this.refillGain += gained;
  }
}
