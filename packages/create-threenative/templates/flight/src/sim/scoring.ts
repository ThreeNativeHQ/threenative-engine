// The attempt's scoring: rings in order, then the landing.
//
// Borrowed algorithms and constants, pilotwings-64-n64decomp:
//   `ring-gates`: a ring counts only when the craft is inside its opening and crosses from the back
//     face to the front face; the chain is ordered (`rings.c:252`).
//   `landing-gate`: a touchdown scores only when the craft is slow and low over the pad
//     (`pads.c:134`, `hang_glider2.c:408`: 1.5 speed, 0.2 clearance).
import { type IRing, type IVec3, PAD, SEA_LEVEL } from "./world.js";

export type RingMark = "pending" | "passed" | "missed";

export const POINTS_PER_RING = 100;
/** A pass this close to the centre earns the bonus, as a share of the opening's radius. */
export const CENTRE_SHARE = 0.35;
export const CENTRE_BONUS = 50;
/** A touchdown softer than this sink rate earns full points. Reference: `hang_glider2.c:408`. */
export const SOFT_SINK = 1.5;

export interface ILimits {
  /** Sink rate above which a touchdown is a crash, m/s. */
  readonly sink: number;
  /** Ground speed above which a touchdown is a crash, m/s. */
  readonly speed: number;
  /** Seconds that earn no time bonus. */
  readonly parTime: number;
}

export const GLIDER_LIMITS: ILimits = { parTime: 90, sink: 5.5, speed: 28 };
export const BELT_LIMITS: ILimits = { parTime: 60, sink: 5, speed: 9 };

export type Touchdown = {
  readonly crashed: boolean;
  /** "fast", "inverted", "water" or "" for a safe landing. */
  readonly reason: string;
  readonly onPad: boolean;
  /** Metres from the pad's centre. */
  readonly distance: number;
  /** Metres per second down at the moment of touchdown. */
  readonly sink: number;
  readonly points: number;
};

/** What a touchdown is worth: distance from the centre and sink rate, 50 points each; a crash is none. */
export function judgeTouchdown(
  at: IVec3,
  /** Metres per second into the ground along its normal, and along the ground. */
  impact: { readonly closing: number; readonly speed: number },
  upsideDown: boolean,
  groundY: number,
  limits: ILimits,
): Touchdown {
  const distance = Math.hypot(at.x - PAD.x, at.z - PAD.z);
  const sink = Math.max(0, impact.closing);
  const { speed } = impact;
  const onPad = distance <= PAD.radius;
  const reason = upsideDown
    ? "inverted"
    : groundY < SEA_LEVEL + 0.2
      ? "water"
      : sink > limits.sink || speed > limits.speed
        ? "fast"
        : "";
  if (reason !== "") return { crashed: true, distance, onPad, points: 0, reason, sink };
  const near = Math.round(50 * (1 - Math.min(1, distance / PAD.radius)));
  const soft = Math.round(
    50 * (1 - Math.min(1, Math.max(0, (sink - SOFT_SINK) / (limits.sink - SOFT_SINK)))),
  );
  return { crashed: false, distance, onPad, points: onPad ? near + soft : 0, reason, sink };
}

export function timeBonus(seconds: number, limits: ILimits): number {
  return Math.max(0, Math.round(limits.parTime - seconds));
}

/** Walks the rings in order and marks each passed or missed. */
export class RingTracker {
  readonly marks: RingMark[];
  /** Points from the centre bonus. */
  bonus = 0;
  /** The ring the pilot must fly through next. */
  active = 0;
  /** Set on the tick a ring is marked: its index and the mark. */
  readonly events: Array<{ index: number; mark: RingMark }> = [];

  constructor(readonly rings: readonly IRing[]) {
    this.marks = rings.map(() => "pending");
  }

  get passed(): number {
    return this.marks.filter((mark) => mark === "passed").length;
  }

  get done(): boolean {
    return this.active >= this.rings.length;
  }

  /** Test the move from `from` to `to` against the rings that are still open. */
  step(from: IVec3, to: IVec3): void {
    for (let index = this.active; index < this.rings.length; index += 1) {
      const ring = this.rings[index];
      if (ring === undefined) continue;
      const nx = Math.sin(ring.yaw);
      const nz = Math.cos(ring.yaw);
      const before = (from.x - ring.x) * nx + (from.z - ring.z) * nz;
      const after = (to.x - ring.x) * nx + (to.z - ring.z) * nz;
      if (!(before < 0 && after >= 0)) continue;
      const share = before / (before - after);
      const dx = from.x + (to.x - from.x) * share - ring.x;
      const dy = from.y + (to.y - from.y) * share - ring.y;
      const dz = from.z + (to.z - from.z) * share - ring.z;
      const offset = Math.hypot(dx, dy, dz);
      if (offset <= ring.radius) {
        // Flying through a later ring leaves every open ring before it missed.
        while (this.active < index) this.mark(this.active, "missed");
        if (offset <= ring.radius * CENTRE_SHARE) this.bonus += CENTRE_BONUS;
        this.mark(index, "passed");
        return;
      }
      // Crossing the open ring's plane outside its opening misses it.
      if (index === this.active) {
        this.mark(index, "missed");
        return;
      }
    }
  }

  /** The attempt ended: every ring still open is missed. */
  close(): void {
    while (this.active < this.rings.length) this.mark(this.active, "missed");
  }

  private mark(index: number, mark: RingMark): void {
    this.marks[index] = mark;
    this.events.push({ index, mark });
    this.active = Math.max(this.active, index + 1);
  }
}
