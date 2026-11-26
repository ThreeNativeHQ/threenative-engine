// Engine torque, automatic gearbox and brake ramp (reference cards carmageddon/engine-torque,
// gearbox-shifting, brake-and-handbrake).

export const ENGINE = {
  /** Engine braking: rpm squared over 1e8 minus a small baseline (car.c:1004). */
  brakeDivisor: 100_000_000,
  brakeBaseline: 0.2,
  /** Throttle demand for a digital key (car.c:1011). */
  digitalThrottle: 1.2,
  /** Throttle demand trimmed while traction control is working in a low gear (car.c:1007). */
  tractionTrim: 0.7,
  /** Power is lost at 1% per damage level past ten (car.c:1015-1016). */
  damageFreeLevels: 10,
  damagePowerDivisor: 100,
  /** Rev limiter. Kit tuning. */
  redline: 7500,
  idle: 900,
  /** Newtons at the wheels per torque unit per gear ratio. Kit tuning. */
  newtonsPerTorque: 2500,
} as const;

export const GEARBOX = {
  /** A gear engages once the free-revving engine passes 1000 with the throttle held (car.c:2722). */
  engageRpm: 1000,
  /** Upshift needs target and actual above 6000 with the rear wheels gripping (car.c:2746). */
  upRpm: 6000,
  /** Downshift when the target drops below 3000 (car.c:2749). */
  downRpm: 3000,
  /** Back to neutral when both are under 200 with no throttle (car.c:2752). */
  neutralRpm: 200,
  /** Braking in first or second, rolling slower than one unit, flips into reverse (car.c:2731). */
  reverseCeiling: 2,
  reverseSpeed: 1,
  /** Ratios replace the card's bare gear number; the force still divides by the gear (car.c:1030). */
  ratios: [2.6, 1.8, 1.35, 1.05, 0.85],
  reverseRatio: 2.6,
  /** Metres per second per rpm per unit of ratio. Kit tuning: first gear tops out near 10 m/s. */
  speedPerRev: 0.0046,
  /** A fresh change stays locked a moment (car.c:2735). */
  holdSeconds: 0.45,
  /** The engine follows the road with a small lag, the elastic feel of the card. */
  revLag: 0.1,
} as const;

export const BRAKE = {
  /** The pedal jumps to the initial force, then climbs to initial plus ramp (car.c:2392). Kit tuning. */
  initial: 28,
  ramp: 70,
  rampSeconds: 0.6,
  /** Damage past one fifth of the scale fades the axle's share to nothing at full (car.c:2394-2395). */
  graceDivisor: 5,
  span: 4,
  /** The handbrake stops working once a rear brake takes 60 levels (constants.h:920). */
  handbrakeFailure: 60,
} as const;

export interface IDriveInput {
  /** Forward pedal 0..1. */
  readonly fwd: number;
  /** Back pedal 0..1: brake going forward, throttle in reverse. */
  readonly back: number;
  readonly handbrake: boolean;
}

export interface IDriveWorld {
  /** Signed forward speed, m/s. */
  readonly speed: number;
  readonly rearSlipping: boolean;
  /** Steering is near the limit: with traction control active the throttle is trimmed. */
  readonly steeringHard: boolean;
  /** Engine damage, 0..99. */
  readonly engineDamage: number;
  /** Average brake efficiency 0..1 from the damage model. */
  readonly brakeEfficiency: number;
}

export interface IDriveOutput {
  /** Total drive force at the wheels in newtons, signed (negative drives backward). */
  readonly driveForce: number;
  /** Brake force in the physics body's own units. */
  readonly brake: number;
  readonly throttle: number;
}

export class Drivetrain {
  rpm: number = ENGINE.idle;
  /** 0 neutral, 1..5 forward, -1 reverse. */
  gear = 0;
  shifts = 0;
  /** True when the last step trimmed the throttle for traction (car.c:1007). */
  trimmed = false;
  #held = 0;
  #brakeTime = 0;

  get ratio(): number {
    if (this.gear < 0) return GEARBOX.reverseRatio;
    return this.gear === 0 ? 0 : (GEARBOX.ratios[this.gear - 1] as number);
  }

  /** The rpm the road would turn the engine at in this gear (car.c:2735). */
  targetRpm(speed: number): number {
    return this.gear === 0 ? 0 : (Math.abs(speed) * this.ratio) / GEARBOX.speedPerRev;
  }

  step(input: IDriveInput, world: IDriveWorld, dt: number): IDriveOutput {
    const { speed } = world;
    // Pedals: in reverse the back pedal drives and the forward pedal brakes.
    const reverse = this.gear < 0;
    const throttleKey = reverse ? input.back : input.fwd;
    const brakeKey = reverse ? input.fwd : input.back;
    this.#flip(brakeKey, throttleKey, speed);

    const target = this.targetRpm(speed);
    this.#held = Math.max(0, this.#held - dt);
    if (this.gear === 0) {
      // Free revving: the engine climbs with the throttle and falls without it.
      const goal = throttleKey > 0 ? ENGINE.redline * 0.5 : ENGINE.idle;
      this.rpm += (goal - this.rpm) * Math.min(1, dt * 3);
      if (throttleKey > 0 && this.rpm > GEARBOX.engageRpm && !input.handbrake) this.#shift(reverse ? -1 : 1);
    } else {
      this.rpm += (Math.max(ENGINE.idle, target) - this.rpm) * Math.min(1, dt / GEARBOX.revLag);
      this.#autoShift(target, throttleKey, world.rearSlipping);
    }

    const demandBase = ENGINE.digitalThrottle * throttleKey;
    this.trimmed = world.rearSlipping && world.steeringHard && Math.abs(this.gear) <= 2 && demandBase > ENGINE.tractionTrim;
    const demand = this.trimmed ? ENGINE.tractionTrim : demandBase;
    const power = 1 - Math.max(0, world.engineDamage - ENGINE.damageFreeLevels) / ENGINE.damagePowerDivisor;
    const loss = Math.max(0, (this.rpm * this.rpm) / ENGINE.brakeDivisor - ENGINE.brakeBaseline);
    const limiter = this.rpm > ENGINE.redline ? 0 : 1;
    // Engine braking is a loss that never exceeds what the throttle gives when it is held.
    const torque = demand * power * limiter - loss * (this.gear === 0 ? 0 : 1);
    const sign = this.gear < 0 ? -1 : 1;
    const driveForce = this.gear === 0 ? 0 : sign * torque * this.ratio * ENGINE.newtonsPerTorque;

    // Brake force jumps to the initial value and climbs to the cap while the pedal is held.
    this.#brakeTime = brakeKey > 0 ? this.#brakeTime + dt : 0;
    const climb = Math.min(1, this.#brakeTime / BRAKE.rampSeconds);
    let brake = brakeKey > 0 ? (BRAKE.initial + BRAKE.ramp * climb) * brakeKey * world.brakeEfficiency : 0;
    // A stopped car holding the back pedal is about to reverse, not brake.
    if (brakeKey > 0 && Math.abs(speed) < GEARBOX.reverseSpeed) brake = 0;
    return { brake, driveForce, throttle: throttleKey };
  }

  /** Braking in first or second while nearly stopped flips the gear's sign (car.c:2731). */
  #flip(brakeKey: number, throttleKey: number, speed: number): void {
    if (brakeKey > 0 && Math.abs(this.gear) <= GEARBOX.reverseCeiling && Math.abs(speed) < GEARBOX.reverseSpeed && throttleKey === 0 && this.gear >= 0) {
      this.gear = -1;
      this.#held = GEARBOX.holdSeconds;
      this.shifts += 1;
    } else if (this.gear < 0 && brakeKey > 0 && Math.abs(speed) < GEARBOX.reverseSpeed && throttleKey === 0) {
      this.gear = 0;
    }
  }

  #shift(gear: number): void {
    this.gear = gear;
    this.#held = GEARBOX.holdSeconds;
    this.shifts += 1;
  }

  #autoShift(target: number, throttle: number, rearSlipping: boolean): void {
    if (this.#held > 0) return;
    if (this.gear > 0 && this.gear < GEARBOX.ratios.length && target > GEARBOX.upRpm && this.rpm > GEARBOX.upRpm && !rearSlipping) {
      this.#shift(this.gear + 1);
    } else if (this.gear > 1 && target < GEARBOX.downRpm) {
      this.#shift(this.gear - 1);
    } else if (target < GEARBOX.neutralRpm && this.rpm < GEARBOX.neutralRpm + ENGINE.idle && throttle === 0 && this.gear > 0 && target === 0) {
      this.gear = 0;
    }
  }

  /** The handbrake takes the whole retardation, applies it to the rear, and drops to neutral (car.c:2420). */
  handbrakeToNeutral(): void {
    if (this.gear !== 0) this.gear = 0;
  }
}
