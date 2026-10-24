import type { ICourse } from "../track/Course.js";
import { type IKartInput, type Kart, idleInput } from "./Kart.js";

/**
 * A CPU driver: it aims at a point on its lane some way ahead (MK64 targets 6 to 20 path points
 * ahead with a lane offset, `mk64: src/cpu_vehicles_camera_path/path_utils.inc.c:346`, `:597`),
 * lifts in a tight corner, and obeys the rubber band the race sets: `catchingUp` when it trails
 * the player, `coasting` when it leads by too much (`cpu_vehicles_camera_path.c:955`). It writes
 * the same `IKartInput` the keyboard does, so a CPU is the player's kart with a different hand.
 * The player's autopilot is one of these too.
 */
export class Driver {
  readonly input: IKartInput = idleInput();
  /** Set by the race each tick from the rubber band. */
  coasting = false;
  /** Where on the road this driver keeps, metres right of the line; drifts slowly. */
  lane: number;
  #laneTarget: number;
  #laneClock = 0;
  #stuck = 0;
  #reversing = 0;
  /** Seconds into a power-slide, or -1 when not sliding. */
  #slide = -1;
  readonly #at = { x: 0, y: 0, z: 0 };

  constructor(
    readonly kart: Kart,
    lane: number,
    /** Metres of look-ahead per m/s of speed; a little different per driver, so the pack spreads. */
    readonly reach = 0.55,
  ) {
    this.lane = lane;
    this.#laneTarget = lane;
  }

  /** Changes lane, for a pass or to dodge; the driver eases across. */
  steerToLane(lane: number): void {
    this.#laneTarget = Math.max(-5, Math.min(5, lane));
  }

  update(dt: number, random: () => number): IKartInput {
    const kart = this.kart;
    const course: ICourse = kart.course;
    const input = this.input;
    this.#laneClock -= dt;
    if (this.#laneClock <= 0) {
      this.#laneClock = 3 + random() * 4;
      this.#laneTarget = Math.max(-4.5, Math.min(4.5, this.lane + (random() - 0.5) * 3));
    }
    this.lane += (this.#laneTarget - this.lane) * Math.min(1, dt * 0.8);

    const ahead = Math.round(6 + Math.abs(kart.speed) * this.reach);
    course.pointAt(kart.index + ahead, this.lane, this.#at);
    const want = Math.atan2(-(this.#at.x - kart.x), -(this.#at.z - kart.z));
    const error = Math.atan2(Math.sin(want - kart.yaw), Math.cos(want - kart.yaw));
    // Three's yaw turns left when positive; the kart's steer turns right when positive.
    input.steer = Math.max(-1, Math.min(1, -error * 2.6));
    // Lift for a corner the kart cannot take: a big heading error at speed.
    const corner = Math.abs(error) > 0.55 && kart.speed > kart.topSpeed * 0.6;
    // A coasting kart slows to half speed, never to a stop: a leader the band holds still blocks
    // the grid behind it (kit guard).
    input.throttle = !corner && (!this.coasting || kart.speed < kart.topSpeed * 0.5);
    input.brake = false;
    input.drift = false;
    input.item = false;
    this.#powerSlide(dt);

    // Stuck against a wall or nose-in after a hit: back off and turn round.
    if (this.#reversing > 0) {
      this.#reversing -= dt;
      input.throttle = false;
      input.brake = true;
      input.steer = -input.steer;
      return input;
    }
    this.#stuck = kart.speed < 1.5 && !kart.hit && input.throttle ? this.#stuck + dt : 0;
    if (this.#stuck > 1.2) {
      this.#stuck = 0;
      this.#reversing = 0.8;
    }
    return input;
  }

  /**
   * Power-slides a long bend as a player does: hop in with the stick toward the bend, push the
   * stick out and back every 0.7 s to charge the sparks, and let go as the road straightens, so a
   * slide that reached stage 2 fires the mini-turbo. The wiggle's outward half is 0.35 s, past
   * `KART_FEEL.chargeTicks` (18 ticks) and short of `chargeStall`.
   */
  #powerSlide(dt: number): void {
    const kart = this.kart;
    const input = this.input;
    const bend = Math.abs(this.#bend(kart.index));
    if (this.#slide < 0) {
      const fast = kart.speed > kart.topSpeed * 0.7 && !this.coasting;
      if (bend > 0.6 && fast && kart.grounded && !kart.hit) this.#slide = 0;
      else return;
    }
    this.#slide += dt;
    const engaged = kart.drifting || this.#slide < 0.3;
    const straight = this.#slide > 0.5 && (bend < 0.25 || this.#slide > 2.5);
    if (!engaged || straight || kart.hit) {
      this.#slide = -1;
      return;
    }
    input.drift = true;
    // The outward half only while the kart is on the asphalt's middle, so a slide never runs wide
    // onto the grass.
    const wiggle = kart.drifting && this.#slide % 0.7 < 0.35 && Math.abs(kart.lateral) < 3.5;
    if (wiggle) input.steer = -kart.driftSide * 0.35;
  }

  /** How far the road turns between 8 m and 30 m ahead, in radians. */
  #bend(index: number): number {
    const course = this.kart.course;
    const a = (index + 8) % course.count;
    const b = (index + 30) % course.count;
    const turn =
      Math.atan2(-(course.tx[b] ?? 0), -(course.tz[b] ?? 0)) -
      Math.atan2(-(course.tx[a] ?? 0), -(course.tz[a] ?? 0));
    return Math.atan2(Math.sin(turn), Math.cos(turn));
  }
}
