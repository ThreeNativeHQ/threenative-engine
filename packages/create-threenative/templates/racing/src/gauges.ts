import { MathUtils } from "three";
import { FEEL } from "./entities/CarBody.js";

/**
 * The rev counter's rules, transcribed from Need for Speed: Most Wanted (`EngineRacer.cpp:606-907`).
 *
 * Display only — nothing here touches the car — but a rev counter that steps is the loudest tell
 * that a driving game's numbers are decoration. Two rules make it read as an engine: the needle
 * falls at a **capped rate** with no load, and every update is a blend of 55% of the new reading
 * with 45% of the last, so a gear change sweeps instead of snapping.
 */
export const GAUGES = {
  /** Gears in the box. One band each, so a gear covers `topSpeed / gears` from rest. */
  gears: 6,
  /** The needle at a standstill, as a share of the gear's band. */
  idle: 0.09,
  /** Where an upshift happens, and — coming back down — where a downshift happens. */
  upshift: 0.94,
  downshift: 0.42,
  /** The most the needle may fall in a second, as a share of a gear's band. */
  fallPerSecond: 1.4,
  /** NFS's own blend: 55% of the new reading, 45% of the last. */
  newShare: 0.55,
} as const;

/** The speed one gear covers, in m/s: `[low, high]`, gear 1 from rest. */
export function gearBand(
  gear: number,
  top: number = FEEL.topSpeed,
  gears: number = GAUGES.gears,
): [number, number] {
  const span = top / gears;
  return [(gear - 1) * span, gear * span];
}

/** What a speed reads on the needle in a given gear, 0 to 1 of that gear's band. */
export function rpmIn(
  speed: number,
  gear: number,
  top: number = FEEL.topSpeed,
  gears: number = GAUGES.gears,
): number {
  // Indexed reads, not a destructure: this runs every frame, and destructuring a tuple allocates
  // an array iterator (`template-runtime-cost.spec.ts` holds the scene to zero per frame).
  const band = gearBand(gear, top, gears);
  const low = band[0];
  return MathUtils.clamp((speed - low) / (band[1] - low), 0, 1);
}

/**
 * The needle and the gear, one tick at a time.
 *
 * The gear is chosen from the **reading**, never from the needle: a gear decides the needle's band,
 * so a needle deciding the gear is a feedback loop that hunts on a steady speed.
 */
export class Gauges {
  gear = 1;
  /** The needle, 0 to 1 of the current gear's band. */
  rpm: number = GAUGES.idle;

  /** `speed` is signed, so reverse reads as idle in first gear rather than as a negative band. */
  update(speed: number, dt: number): void {
    const ground = Math.max(0, speed);
    // One gear per tick at most: a rescue teleport can jump the speed by 30 m/s, and climbing six
    // gears in one tick is a needle that flickers through the whole box.
    if (rpmIn(ground, this.gear) > GAUGES.upshift && this.gear < GAUGES.gears) this.gear += 1;
    else if (rpmIn(ground, this.gear) < GAUGES.downshift && this.gear > 1) this.gear -= 1;
    const reading = Math.max(GAUGES.idle, rpmIn(ground, this.gear));
    // The cap is on the fall only: a shift up drops the reading, and the needle follows it over a
    // few ticks. A reading that rises is followed at once, which is what a blip of throttle does.
    const capped = Math.max(reading, this.rpm - GAUGES.fallPerSecond * dt);
    this.rpm = GAUGES.newShare * capped + (1 - GAUGES.newShare) * this.rpm;
  }
}
