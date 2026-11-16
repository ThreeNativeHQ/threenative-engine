import { CAR, type CarBody, FEEL } from "./CarBody.js";

/**
 * The handbrake drift, and the drift score.
 *
 * The handbrake drops the rear pair's grip cap (`wheelFrictionSlip`), so the tail steps out on
 * the real tyre model rather than on a scripted yaw. While the car is sideways the rear keeps a
 * reduced grip: steering into the slide holds it, a neutral wheel lets it bleed off, and
 * counter-steer catches it (NASCAR 98's `lateral-slide` rule). Past {@link DRIFT.governStart} the
 * rear grips harder the further round the car is, so a held drift settles at an angle instead of
 * spinning. When the slide ends, the grip comes back over {@link GRIP_RETURN_SECONDS}.
 *
 * The car also lets go **without the handbrake**: full lock held at speed is more than the rear
 * tyres can hold, so past {@link DRIFT.looseSpeed} the rear grip drops to {@link DRIFT.looseGrip}
 * and the same drift takes over. A sharp corner taken flat out steps the tail out; a wide one,
 * taken on part lock, does not.
 *
 * Detection and score follow VDrift (`src/game.cpp:2595-2637`, `src/timer.h:158,212`): an angle
 * with a wide hysteresis band, a spin past a right angle voids the chain, and a banked drift
 * scores its distance plus a peak speed and a peak angle bonus. The angle is the rear axle's
 * slip, not the chassis's: on this car's steering lock a tight turn on full grip already points
 * the nose 15° off its velocity, and that is not a drift.
 */
export const DRIFT = {
  /** The rear grip cap while the handbrake kicks the tail out. 14 is full grip. */
  handbrakeGrip: 0.5,
  /** While sideways: steering into the slide, a neutral wheel, and counter-steer. */
  holdGrip: 0.35,
  recoverGrip: 2.6,
  catchGrip: 4.5,
  /** The rear grips harder across this band of slip, in radians, up to `governGrip`. */
  governStart: 0.5,
  governEnd: 0.9,
  governGrip: 3,
  /** The driver's steering lock in a slide, as a share of the lock on full grip. */
  lockScale: 0.35,
  /**
   * Newtons along the nose while sliding on the throttle. Rapier scales a sliding wheel's drive
   * by the same factor as its side grip, so a car that is sideways has almost no engine: measured,
   * 14 → 8 m/s in one second of drift. This is the push a spinning rear tyre still gives.
   */
  thrust: 4200,
  /** Where that push reaches zero, as a share of the car's top speed. */
  thrustTopShare: 0.92,
  /** How much of the slip angle the front wheels take as opposite lock, and the most they turn. */
  counterSteer: 1,
  maxCounter: 0.85,
  /**
   * Natural oversteer: the stick share, the speed share of `FEEL.topSpeed`, the ticks it is held.
   * The move vector is normalised, so a keyboard's full right with the throttle held reads 0.707:
   * a 0.9 threshold meant a keyboard driver could never reach it.
   */
  looseLock: 0.65,
  looseSpeed: 0.62,
  looseTicks: 10,
  /** The rear grip cap once the tail lets go by itself. */
  looseGrip: 0.6,
  /** The least ticks one press of the handbrake kicks for. */
  kickTicks: 9,
  /** The brake impulse while the handbrake kicks: enough to load the nose, not to stop the car. */
  handbrake: 8,
  /** Below this the handbrake is only a brake, in m/s. VDrift's 10 m/s, scaled to a 17 m/s car. */
  minSpeed: 6,
  /** VDrift's thresholds, radians of slip. */
  enterAngle: 0.2,
  exitAngle: 0.1,
  /** Past a right angle the slide is a spin, and it scores nothing. */
  spinAngle: Math.PI / 2,
  /** VDrift's bank bonus weights, and the distance a drift must cover to be banked. */
  speedBonus: 0.5,
  angleBonus: 40,
  bankThreshold: 5,
  /**
   * How long a banked score stays on screen, in **game** seconds. It was wall clock in the HUD, which
   * meant a pause ate the popup and a harness that advances ticks faster than real time outlived it;
   * the clock lives here so it stops when the race does.
   */
  popupSeconds: 1.6,
} as const;

const GRIP_RETURN_SECONDS = 0.3;
/** How long the rear grip takes to fall to a lower target. The rise is deliberately slower than
 *  the fall — grip comes back over 0.3 s — but neither may happen in one tick: the tyre's side grip
 *  is a bristle model, and a target that flips between 0.35 and 4.5 as the steering crosses centre
 *  sawtoothed the car through a held slide. */
const GRIP_FALL_SECONDS = 0.05;
const REAR = [2, 3] as const;

export class Drift {
  /** Whether the car is in a scored drift this tick. */
  drifting = false;
  /** The rear slip in radians: + in a right-hand slide. */
  angle = 0;
  /** The running score of the drift in progress, before it is banked. */
  chain = 0;
  /** Everything banked this race. */
  score = 0;
  /** The last drift that was banked, for the HUD popup. 0 until one is. */
  lastBanked = 0;
  /** Seconds the last banked score still shows, counted in game time so a pause freezes it. */
  popup = 0;
  banked = 0;
  spins = 0;
  /** The rear grip cap written this tick. */
  grip: number = CAR.wheelFrictionSlip;
  /** 0 on full grip, 1 once the rear is loose: how far the steering is into its slide mode. */
  get slide(): number {
    // Not while the tail is only letting go: slide steering cuts the lock, and cut before the
    // rear has stepped out it turned the car less, which held the tail in.
    if (this.loose) return 0;
    const span = CAR.wheelFrictionSlip - DRIFT.catchGrip;
    return Math.min(1, Math.max(0, (CAR.wheelFrictionSlip - this.grip) / span));
  }

  /** The lowest rear grip written, so a scenario can prove the handbrake reached the tyres. */
  lowestGrip: number = CAR.wheelFrictionSlip;
  /** The largest slip seen in a scored drift. */
  peakSlip = 0;
  #peakSpeed = 0;
  #peakAngle = 0;
  #teleports = 0;
  #kickTicks = 0;
  #lockTicks = 0;
  /** Whether the tail let go by itself this tick, with no handbrake. */
  loose = false;

  /**
   * Whether the handbrake kicks the tail out this tick, rather than only braking: at speed, with
   * the wheel turned or the car already sideways.
   */
  kicks(car: CarBody, handbrake: boolean, steer: number): boolean {
    const asked =
      handbrake && car.groundSpeed > DRIFT.minSpeed && (Math.abs(steer) > 0.2 || this.drifting);
    // A tap is a kick: a 60 ms press is shorter than the tail takes to step out, so it is held on.
    if (asked) this.#kickTicks = DRIFT.kickTicks;
    else if (this.#kickTicks > 0) this.#kickTicks -= 1;
    return (
      asked || (this.#kickTicks > 0 && car.groundSpeed > DRIFT.minSpeed && Math.abs(steer) > 0.2)
    );
  }

  /** One tick, after `car.measure`. `steer` is the wheel, + to the right. */
  update(car: CarBody, kick: boolean, steer: number, dt: number): void {
    // A tick's subtraction leaves float noise (~1e-16). Snap it: the popup has to end at exactly
    // zero, or `quantize` publishes a live popup one tick longer than it should.
    const left = this.popup - dt;
    this.popup = left > 1e-6 ? left : 0;
    // A rescue or the autopilot's rejoin teleports the car: that is not a drift, and not a spin.
    if (car.teleports !== this.#teleports) {
      this.#teleports = car.teleports;
      this.reset(car);
    }
    const speed = car.groundSpeed;
    this.angle = car.rearSlip;
    const slip = Math.abs(this.angle);
    const onRoad = car.body.wheelContact(2) || car.body.wheelContact(3);

    if (!this.drifting) {
      if (onRoad && speed > DRIFT.minSpeed && slip > DRIFT.enterAngle && slip < DRIFT.spinAngle) {
        this.drifting = true;
        this.chain = 0;
        this.#peakSpeed = 0;
        this.#peakAngle = 0;
      }
    } else if (slip >= DRIFT.spinAngle) {
      this.drifting = false;
      this.chain = 0;
      this.spins += 1;
    } else if (slip < DRIFT.exitAngle || speed < DRIFT.minSpeed * 0.5 || !onRoad) {
      this.#bank();
    } else {
      this.chain += speed * dt;
      this.#peakSpeed = Math.max(this.#peakSpeed, speed);
      this.#peakAngle = Math.max(this.#peakAngle, slip);
      this.peakSlip = Math.max(this.peakSlip, slip);
    }

    const pushing =
      !kick &&
      onRoad &&
      Math.abs(steer) >= DRIFT.looseLock &&
      speed > DRIFT.looseSpeed * FEEL.topSpeed;
    this.#lockTicks = pushing ? this.#lockTicks + 1 : 0;
    this.loose = !this.drifting && this.#lockTicks >= DRIFT.looseTicks;

    let wanted: number = CAR.wheelFrictionSlip;
    if (this.loose) wanted = DRIFT.looseGrip;
    else if (kick || this.drifting) {
      const into = steer * Math.sign(this.angle);
      wanted = kick
        ? DRIFT.handbrakeGrip
        : into > 0.2
          ? DRIFT.holdGrip
          : into < -0.2
            ? DRIFT.catchGrip
            : DRIFT.recoverGrip;
      const govern = Math.min(
        1,
        Math.max(0, (slip - DRIFT.governStart) / (DRIFT.governEnd - DRIFT.governStart)),
      );
      wanted = Math.max(wanted, wanted + (DRIFT.governGrip - wanted) * govern);
    }
    // Both directions ease, over the fall and the return time: a grip that changes in one tick is a
    // step input to a bristle tyre, and the slide it produces reads as a snap rather than a slide.
    const rise = ((CAR.wheelFrictionSlip - DRIFT.handbrakeGrip) * dt) / GRIP_RETURN_SECONDS;
    const fall = ((CAR.wheelFrictionSlip - DRIFT.handbrakeGrip) * dt) / GRIP_FALL_SECONDS;
    const next =
      wanted < this.grip ? Math.max(wanted, this.grip - fall) : Math.min(wanted, this.grip + rise);
    if (next !== this.grip) {
      this.grip = next;
      this.lowestGrip = Math.min(this.lowestGrip, next);
      for (const wheel of REAR) car.body.setWheelFrictionSlip(wheel, next);
    }
  }

  /** Ends any drift without banking it, and restores the grip. */
  reset(car: CarBody): void {
    this.drifting = false;
    this.chain = 0;
    this.angle = 0;
    this.loose = false;
    this.#lockTicks = 0;
    if (this.grip !== CAR.wheelFrictionSlip) {
      this.grip = CAR.wheelFrictionSlip;
      for (const wheel of REAR) car.body.setWheelFrictionSlip(wheel, this.grip);
    }
  }

  #bank(): void {
    this.drifting = false;
    const total =
      this.chain +
      DRIFT.speedBonus * this.#peakSpeed +
      (DRIFT.angleBonus * this.#peakAngle) / Math.PI;
    if (this.chain > DRIFT.bankThreshold) {
      this.score += total;
      this.lastBanked = total;
      this.banked += 1;
      this.popup = DRIFT.popupSeconds;
    }
    this.chain = 0;
  }
}
