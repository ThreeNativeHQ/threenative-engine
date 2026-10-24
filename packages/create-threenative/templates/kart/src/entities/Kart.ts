import { type ICourse, SURFACE_DRAG, type Surface } from "../track/Course.js";

/**
 * The kart's feel: every number the reference decides, in metres, seconds and its own 60 Hz ticks.
 * MK64 has no metre, so the kit keeps its ratios and times and sets one scale, `topSpeed`; every
 * other speed is a ratio of it. Change a value here and the whole field changes with it, the CPUs
 * included, because they drive this same model.
 */
export const KART_FEEL = {
  /** Terminal road speed at full throttle in each class, m/s. Terminal speed is ∝ throttle², and
   * the throttle tops out at 290 / 310 / 320 (`mk64: src/data/kart_attributes.c:65-75`). */
  topSpeed: { "50cc": 24 * (290 / 320) ** 2, "100cc": 24 * (310 / 320) ** 2, "150cc": 24 },
  /** The throttle's top in each class; the throttle is the pedal, not the speed. */
  throttleTop: { "50cc": 290, "100cc": 310, "150cc": 320 },
  /** Throttle gained per tick in each tenth of its top (medium weight, `kart_attributes.c:248`). */
  accel: [2.0, 2.0, 2.0, 1.6, 1.4, 1.2, 1.0, 0.8, 0.6, 0.4],
  /** Throttle lost per tick off the pedal, and braking (`player_controller.c:4688`, `:3563`). */
  coast: 1,
  brake: 3,
  /** Speed follows its target with this lag, in ticks: 6000 / (0.12 · 5800) (`player_controller.c:2413`). */
  lagTicks: 8.62,
  /** Reverse speed with the brake held from a stop, m/s. Kit value. */
  reverse: 4,
  /** Yaw at full lock: `K·s·|s| / (8 + throttle/50)` deg/s, so 94 °/s at the 150cc top
   * (`player_controller.c:4137-4173`), ×1.12 past 85% lock (handling +0.15 on 1.25). */
  steerK: 94 * (8 + 320 / 50),
  steerHardLock: 0.85,
  steerHardGain: 1.12,
  /** Below this speed the steering fades out, so a parked kart does not spin on the spot. Kit guard. */
  steerFadeSpeed: 3,
  /** The velocity's heading follows the kart's at 1/12 per tick, at most 40° behind (`:1300`, `:1348`). */
  slipFollow: 1 / 12,
  slipMax: (40 * Math.PI) / 180,
  /** Drag per degree of slip, drifting and turning (`player_controller.c:2990-3106`), and how fast
   * any drag eases in (5% per tick). */
  driftDrag: 0.004,
  turnDrag: 0.01,
  dragEase: 0.05,
  /** The hop: up 0.35 m in 8 ticks (`kart_attributes.c:401`, `player_controller.c:1192-1241`). */
  hopSpeed: 5.4,
  hopGravity: 41.5,
  /** Gravity off a ramp, m/s². Kit value: an arcade arc, not 9.8. */
  gravity: 30,
  /** A drift starts only above 28% of top speed (20 of 70.7 display km/h, `player_controller.c:4327`). */
  driftMinFraction: 0.28,
  /** Drift yaw, deg/s: stick neutral, extra at full inside, less at full outside (`:4197-4228`). */
  driftYaw: 36,
  driftYawInside: 54,
  driftYawOutside: 21,
  /** Stick past 10/53 against the drift charges the mini-turbo (`player_controller.c:1145-1190`). */
  chargeStick: 10 / 53,
  /** Ticks held against the drift for one stage, the counter kept after a stage, and the stall. */
  chargeTicks: 18,
  chargeKeep: 10,
  chargeStall: 100,
  /** The mini-turbo: 31 ticks at +580/4096 force, eased in at 20% a tick and bled at 1% a tick
   * (`player_controller.c:1123-1140`, `:3094`). */
  miniTurboTicks: 31,
  miniTurbo: 580 / 4096,
  /** The mushroom and the boost pad: 80 ticks at +400/4096, eased in at 50% a tick, then −10% a
   * tick (`effects.c:547`, `player_controller.c:1120`, `:3117`). */
  boostTicks: 80,
  boost: 400 / 4096,
  /** A CPU behind the leader's pace gets +380/4096 force (`player_controller.c:3085`). */
  catchUp: 380 / 4096,
  /** A wall: speed into it reflected ×0.5, throttle −18 a contact tick (`player_controller.c:1952`). */
  wallBounce: 0.5,
  wallThrottle: 18,
  /** Half the kart's width, for the wall line. */
  halfWidth: 0.85,
  /** A banana spin and a shell tumble, in ticks (`effects.c:375-394`, `:197-224`). */
  spinTicks: 90,
  tumbleTicks: 103,
} as const;

export type EngineClass = keyof typeof KART_FEEL.topSpeed;

/** What a kart is told each tick: the player's keys or a CPU's `Driver`. */
export interface IKartInput {
  throttle: boolean;
  brake: boolean;
  /** −1 full left … +1 full right. */
  steer: number;
  /** The hop and drift button, held. */
  drift: boolean;
  /** Pressed this tick: use the held item. */
  item: boolean;
}

export const idleInput = (): IKartInput => ({
  brake: false,
  drift: false,
  item: false,
  steer: 0,
  throttle: false,
});

const DEG = Math.PI / 180;

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * One kart: the throttle, the speed that chases it, the heading and the slip, the hop and the
 * power-slide, the boosts and the hits. Position is world x/z plus a place on the course
 * (`index`, `lateral`), which gives the ground, the surface and the wall. It draws nothing:
 * `render/kart.ts` follows it.
 */
export class Kart {
  readonly feel = KART_FEEL;
  x = 0;
  y = 0;
  z = 0;
  /** Facing: 0 looks down −z, positive turns left (three's Y rotation). */
  yaw = 0;
  /** Where the velocity points; `yaw − velocityYaw` is the slip. */
  velocityYaw = 0;
  /** Signed speed along `velocityYaw`, m/s. */
  speed = 0;
  /** The pedal, 0 to the class's throttle top. */
  throttle = 0;
  vy = 0;
  airborne = false;
  /** Seconds in the air on the current flight. */
  airTime = 0;
  /** Longest flight so far, seconds. */
  longestAir = 0;
  #gravity: number = KART_FEEL.gravity;
  /** The road's own vertical speed under the kart last tick: a lip that drops away faster launches it. */
  #roadVy = 0;
  index = 0;
  lateral = 0;
  surface: Surface = "road";
  drag = 0;
  /** Drift: 0 none, −1 left, +1 right. */
  driftSide = 0;
  /** Mini-turbo stage, 0..3: spark colour white, yellow, orange (`code_80057C60.c:2865`). */
  driftStage = 0;
  #driftCounter = 0;
  #hopHeld = false;
  #hopping = false;
  miniTurboTicks = 0;
  miniTurbo = 0;
  boostTicks = 0;
  boost = 0;
  catchUp = 0;
  /** A CPU behind the pace sets this each tick. */
  catchingUp = false;
  spinTicks = 0;
  tumbleTicks = 0;
  /** Visual spin angle while hit, radians. */
  spinAngle = 0;
  wallHits = 0;
  /** Ticks this kart has been touching a wall this tick (0 or 1), for the effects. */
  onWall = false;
  readonly counts = { drifts: 0, hops: 0, miniTurbos: 0, boosts: 0, spins: 0, tumbles: 0 };
  /** The stage each drift reached when it ended, newest last (kept short). */
  readonly driftStages: number[] = [];
  #topSpeed: number;
  #throttleTop: number;

  constructor(
    readonly course: ICourse,
    readonly engine: EngineClass = "150cc",
  ) {
    this.#topSpeed = KART_FEEL.topSpeed[engine];
    this.#throttleTop = KART_FEEL.throttleTop[engine];
  }

  get topSpeed(): number {
    return this.#topSpeed;
  }

  get grounded(): boolean {
    return !this.airborne;
  }

  get drifting(): boolean {
    return this.driftSide !== 0;
  }

  get hit(): boolean {
    return this.spinTicks > 0 || this.tumbleTicks > 0;
  }

  /** Slip angle in radians: where the nose points against where the kart goes. */
  get slip(): number {
    return wrapAngle(this.yaw - this.velocityYaw);
  }

  /** Puts the kart on the course at sample `index`, `lateral` metres off the line, facing along it. */
  place(index: number, lateral: number): void {
    const course = this.course;
    const at = { x: 0, y: 0, z: 0 };
    const i = course.wrap(index);
    course.pointAt(i, lateral, at);
    this.x = at.x;
    this.y = at.y;
    this.z = at.z;
    this.index = i;
    this.lateral = lateral;
    this.yaw = Math.atan2(-course.tx[i]!, -course.tz[i]!);
    this.velocityYaw = this.yaw;
    this.speed = 0;
    this.throttle = 0;
    this.vy = 0;
    this.airborne = false;
    this.#roadVy = 0;
  }

  /** The mushroom, a boost pad or a rocket start: throttle pinned to top for 80 ticks. */
  startBoost(): void {
    this.boostTicks = KART_FEEL.boostTicks;
    this.counts.boosts += 1;
  }

  /** A banana: a 1.5 s spin. Ends any drift and boost. */
  spinOut(): void {
    if (this.hit) return;
    this.spinTicks = KART_FEEL.spinTicks;
    this.counts.spins += 1;
    this.#endDrift(false);
    this.boostTicks = 0;
    this.miniTurboTicks = 0;
  }

  /** A shell: a 1.7 s tumble that brings the kart to a stop. */
  tumble(): void {
    if (this.hit) return;
    this.tumbleTicks = KART_FEEL.tumbleTicks;
    this.counts.tumbles += 1;
    this.#endDrift(false);
    this.boostTicks = 0;
    this.miniTurboTicks = 0;
    if (!this.airborne) {
      this.vy = 4.5;
      this.airborne = true;
      this.#gravity = KART_FEEL.gravity;
    }
  }

  step(input: IKartInput, dt: number): void {
    const f = KART_FEEL;
    const ticks = dt * 60;
    const top = this.#throttleTop;
    this.onWall = false;

    // Hits: no control, the throttle drains, the kart turns round its own axis.
    let throttle = input.throttle;
    let brake = input.brake;
    let steer = Math.max(-1, Math.min(1, input.steer));
    if (this.spinTicks > 0) {
      this.spinTicks = Math.max(0, this.spinTicks - ticks);
      // 360° at 12°/tick, then 360° at 6°/tick.
      this.spinAngle += (this.spinTicks > 60 ? 12 : 6) * DEG * ticks;
      this.throttle = Math.max(0, this.throttle - f.coast * ticks);
      throttle = false;
      brake = false;
      steer = 0;
    } else if (this.tumbleTicks > 0) {
      this.tumbleTicks = Math.max(0, this.tumbleTicks - ticks);
      this.spinAngle += 7 * DEG * ticks;
      this.throttle = Math.max(0, this.throttle - 5 * ticks);
      throttle = false;
      brake = false;
      steer = 0;
    } else this.spinAngle = 0;

    // The pedal. A boost pins it to the top.
    if (this.boostTicks > 0) this.throttle = top;
    else if (throttle && this.grounded) {
      const tenth = Math.min(9, Math.floor((this.throttle / top) * 10));
      this.throttle = Math.min(top, this.throttle + (f.accel[tenth] ?? 0.4) * ticks);
    } else if (brake) this.throttle = Math.max(0, this.throttle - f.brake * ticks);
    else if (!throttle) this.throttle = Math.max(0, this.throttle - f.coast * ticks);

    // Drag: the surface plus slip, eased in at 5% a tick.
    const slipDeg = Math.abs(this.slip) / DEG;
    let dragTarget = this.grounded ? SURFACE_DRAG[this.surface] : 0;
    if (Math.abs(this.speed) > this.#topSpeed * 0.11)
      dragTarget += slipDeg * (this.drifting ? f.driftDrag : f.turnDrag);
    this.drag += (dragTarget - this.drag) * (1 - (1 - f.dragEase) ** ticks);

    // Boost forces, each eased toward its level and bled off after.
    if (this.boostTicks > 0) {
      this.boostTicks = Math.max(0, this.boostTicks - ticks);
      this.boost += (f.boost - this.boost) * (1 - 0.5 ** ticks);
    } else this.boost *= 0.9 ** ticks;
    if (this.miniTurboTicks > 0) {
      this.miniTurboTicks = Math.max(0, this.miniTurboTicks - ticks);
      this.miniTurbo += (f.miniTurbo - this.miniTurbo) * (1 - 0.8 ** ticks);
    } else this.miniTurbo *= 0.99 ** ticks;
    if (this.catchingUp) this.catchUp += (f.catchUp - this.catchUp) * (1 - 0.5 ** ticks);
    else this.catchUp *= 0.9 ** ticks;

    // Speed chases the throttle's terminal speed: ∝ throttle², less drag, plus the boosts. The
    // mushroom skips the drag (`player_controller.c:3117`). In the air the speed holds.
    if (this.grounded) {
      const resist = this.boostTicks > 0 ? 0 : this.drag;
      let target =
        this.#topSpeed *
        (this.throttle / top) ** 2 *
        Math.max(0, 1 - resist) *
        (1 + this.boost + this.miniTurbo + this.catchUp);
      if (brake && this.throttle === 0 && this.speed < 0.5) target = -f.reverse;
      this.speed += (target - this.speed) * (1 - Math.exp(-ticks / f.lagTicks));
    }

    // Hop and drift. A press while grounded hops; with the stick held and enough speed the hop
    // locks a power-slide to that side, which lasts while the button is held.
    const hopPressed = input.drift && !this.#hopHeld;
    this.#hopHeld = input.drift;
    if (hopPressed && this.grounded && !this.hit) {
      this.vy = f.hopSpeed;
      this.airborne = true;
      this.#hopping = true;
      this.#gravity = f.hopGravity;
      this.counts.hops += 1;
    }
    const fastEnough = this.speed > this.#topSpeed * f.driftMinFraction;
    if (this.#hopping && this.driftSide === 0 && input.drift && Math.abs(steer) > 0.2 && fastEnough) {
      this.driftSide = Math.sign(steer);
      this.driftStage = 0;
      this.#driftCounter = 0;
      this.counts.drifts += 1;
    }
    if (this.drifting) {
      if (!input.drift) this.#endDrift(true);
      else if (!fastEnough && this.grounded) this.#endDrift(false);
    }
    if (this.drifting) this.#charge(steer * this.driftSide, ticks);

    // Steering.
    let yawRate: number;
    if (this.drifting) {
      const inside = steer * this.driftSide;
      yawRate =
        this.driftSide *
        (f.driftYaw +
          f.driftYawInside * Math.max(0, inside) -
          f.driftYawOutside * Math.max(0, -inside));
    } else {
      const hard = Math.abs(steer) >= f.steerHardLock ? f.steerHardGain : 1;
      yawRate = ((f.steerK * steer * Math.abs(steer)) / (8 + this.throttle / 50)) * hard;
      yawRate *= Math.min(1, Math.abs(this.speed) / f.steerFadeSpeed) * Math.sign(this.speed || 1);
    }
    if (this.airborne && !this.#hopping) yawRate *= 0.5;
    // Positive steer is right; three's positive yaw turns left.
    this.yaw = wrapAngle(this.yaw - yawRate * DEG * dt);

    // The velocity's heading follows the nose at 1/12 a tick, at most 40° behind it.
    const lag = wrapAngle(this.yaw - this.velocityYaw);
    let next = this.velocityYaw + lag * (1 - (1 - f.slipFollow) ** ticks);
    const behind = wrapAngle(this.yaw - next);
    if (Math.abs(behind) > f.slipMax) next = this.yaw - Math.sign(behind) * f.slipMax;
    this.velocityYaw = wrapAngle(next);

    // Move on the ground plane.
    this.x += -Math.sin(this.velocityYaw) * this.speed * dt;
    this.z += -Math.cos(this.velocityYaw) * this.speed * dt;
    this.#follow(dt);
  }

  /** The track-space half of the step: where on the course, what surface, the wall and the ground. */
  #follow(dt: number): void {
    const f = KART_FEEL;
    const course = this.course;
    const point = course.track(this.index, this.x, this.z);
    this.index = point.index;
    this.lateral = point.lateral;
    // The wall: push the kart back inside, reflect the speed into it ×0.5, cut the throttle.
    const limit = course.wall[this.index]! - f.halfWidth;
    if (Math.abs(this.lateral) > limit) {
      const side = Math.sign(this.lateral);
      const over = Math.abs(this.lateral) - limit;
      // Right of travel is (−tz, tx).
      const nx = -course.tz[this.index]! * side;
      const nz = course.tx[this.index]! * side;
      this.x -= nx * over;
      this.z -= nz * over;
      this.lateral = side * limit;
      const vx = -Math.sin(this.velocityYaw) * this.speed;
      const vz = -Math.cos(this.velocityYaw) * this.speed;
      const into = vx * nx + vz * nz;
      if (into > 0) {
        const rx = vx - (1 + f.wallBounce) * into * nx;
        const rz = vz - (1 + f.wallBounce) * into * nz;
        this.speed = Math.hypot(rx, rz);
        this.velocityYaw = Math.atan2(-rx, -rz);
        this.throttle = Math.max(0, this.throttle - f.wallThrottle);
        this.wallHits += 1;
      }
      this.onWall = true;
      this.#endDrift(false);
      this.boostTicks = 0;
    }
    this.surface = course.surface(point);

    // Ground: follow the road while it holds the kart; leave it at a lip that drops away faster
    // than gravity would.
    const ground = course.y[this.index]!;
    if (this.airborne) {
      this.vy -= this.#gravity * dt;
      this.y += this.vy * dt;
      this.airTime += dt;
      if (this.y <= ground) {
        this.y = ground;
        this.vy = 0;
        this.airborne = false;
        this.#hopping = false;
        this.#gravity = f.gravity;
        this.#roadVy = 0;
        this.longestAir = Math.max(this.longestAir, this.airTime);
        this.airTime = 0;
      }
      return;
    }
    const ballistic = this.y + this.#roadVy * dt - 0.5 * f.gravity * dt * dt;
    if (ground < ballistic - 0.03 && this.#roadVy > 0.5) {
      this.airborne = true;
      this.#gravity = f.gravity;
      this.vy = this.#roadVy - f.gravity * dt;
      this.y = ballistic;
      this.airTime = 0;
      return;
    }
    this.#roadVy = (ground - this.y) / Math.max(dt, 1e-4);
    this.y = ground;
  }

  /** The mini-turbo charge: hold the stick against the drift, then let it back. */
  #charge(inside: number, ticks: number): void {
    const f = KART_FEEL;
    if (inside <= -f.chargeStick) {
      this.#driftCounter = Math.min(f.chargeStall + 1, this.#driftCounter + ticks);
      // Held too long: the slide stalls and bleeds 4 throttle a tick (`player_controller.c:1148`).
      if (this.#driftCounter >= f.chargeStall)
        this.throttle = Math.max(0, this.throttle - 4 * ticks);
      return;
    }
    if (this.#driftCounter >= f.chargeTicks && this.#driftCounter < f.chargeStall)
      this.driftStage = Math.min(3, this.driftStage + 1);
    if (this.#driftCounter >= f.chargeKeep && this.#driftCounter < f.chargeStall)
      this.#driftCounter = f.chargeKeep;
    else {
      this.#driftCounter = 0;
      this.driftStage = 0;
    }
  }

  /** Ends a drift; a release at stage 2 or more fires the mini-turbo. */
  #endDrift(release: boolean): void {
    if (!this.drifting) return;
    if (release && this.driftStage >= 2) {
      this.miniTurboTicks = KART_FEEL.miniTurboTicks;
      this.counts.miniTurbos += 1;
    }
    this.driftStages.push(this.driftStage);
    if (this.driftStages.length > 8) this.driftStages.shift();
    this.driftSide = 0;
    this.driftStage = 0;
    this.#driftCounter = 0;
  }
}
