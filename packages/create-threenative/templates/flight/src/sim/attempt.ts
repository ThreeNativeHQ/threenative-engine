// One attempt at the course: a craft in the air, the rings, the touchdown and the score.
// Everything the HUD and the playtests read comes from here, and nothing here draws.
import { type IBeltInput, RocketBelt } from "./belt.js";
import { Glider, STALL_WARNING } from "./glider.js";
import {
  BELT_LIMITS,
  GLIDER_LIMITS,
  type ILimits,
  RingTracker,
  type Touchdown,
  judgeTouchdown,
  timeBonus,
} from "./scoring.js";
import {
  BELT_START,
  COURSES,
  type IVec3,
  LAUNCH,
  THERMALS,
  type Vehicle,
  airAt,
  groundHeight,
  thermalLift,
} from "./world.js";

export type Phase = "flying" | "landed" | "crashed";

/** The glider's body hangs this far under its sail's centre: the pilot's feet and the control bar. */
const GLIDER_DROP = 1.6;
/** A launch 8 m over the hill's crest, trimmed at 18 m/s through the air. */
const LAUNCH_HEIGHT = 8;
const TRIM_SPEED = 18;

export interface IControls {
  /** Stick: +1 is up/forward on the keys. The glider reads it as nose down, the belt as a lean forward. */
  readonly pitch: number;
  /** +1 banks or turns right. */
  readonly roll: number;
  /** Belt only: +1 opens the lever, -1 closes it. */
  readonly climb: number;
}

export class Attempt {
  readonly glider: Glider | undefined;
  readonly belt: RocketBelt | undefined;
  readonly rings: RingTracker;
  readonly limits: ILimits;
  phase: Phase = "flying";
  time = 0;
  /** Times the wing stalled this attempt. */
  stalls = 0;
  /** Seconds the air under the craft was rising. */
  thermalTime = 0;
  touchdown: Touchdown | undefined;
  readonly air: IVec3 = { x: 0, y: 0, z: 0 };

  constructor(readonly vehicle: Vehicle) {
    this.rings = new RingTracker(COURSES[vehicle]);
    this.limits = vehicle === "glider" ? GLIDER_LIMITS : BELT_LIMITS;
    if (vehicle === "glider") {
      const y = groundHeight(LAUNCH.x, LAUNCH.z) + GLIDER_DROP + LAUNCH_HEIGHT;
      this.glider = new Glider(
        LAUNCH.x,
        y,
        LAUNCH.z,
        LAUNCH.heading,
        TRIM_SPEED,
        airAt(LAUNCH.x, y, LAUNCH.z, 0),
      );
    } else {
      this.belt = new RocketBelt(
        BELT_START.x,
        groundHeight(BELT_START.x, BELT_START.z),
        BELT_START.z,
        BELT_START.heading,
      );
    }
  }

  get craft(): { readonly pos: IVec3; readonly vel: IVec3 } {
    return (this.glider ?? this.belt) as { readonly pos: IVec3; readonly vel: IVec3 };
  }

  get heading(): number {
    return this.glider?.heading ?? this.belt?.yaw ?? 0;
  }

  /** Metres from the body's lowest point to the ground below it. */
  get clearance(): number {
    const { pos } = this.craft;
    return pos.y - (this.glider === undefined ? 0 : GLIDER_DROP) - groundHeight(pos.x, pos.z);
  }

  /** Vertical speed of the air at the craft, m/s: positive inside a thermal. */
  get lift(): number {
    const { pos } = this.craft;
    return THERMALS.reduce((sum, thermal) => sum + thermalLift(thermal, pos.x, pos.y, pos.z), 0);
  }

  /** The attempt's points so far: rings and bonuses, then the touchdown once there is one. */
  get total(): number {
    const landing = this.touchdown;
    const base = this.rings.passed * 100 + this.rings.bonus;
    if (landing === undefined || landing.crashed) return base;
    return base + landing.points + (landing.onPad ? timeBonus(this.time, this.limits) : 0);
  }

  /** Put the glider back in trim at a point, heading and speed (a playtest station). */
  placeGlider(pos: IVec3, heading: number, bank = 0): void {
    if (this.glider === undefined) return;
    const speed = TRIM_SPEED;
    const air = airAt(pos.x, pos.y, pos.z, this.time);
    this.glider.pos.x = pos.x;
    this.glider.pos.y = pos.y;
    this.glider.pos.z = pos.z;
    this.glider.heading = heading;
    this.glider.bank = bank;
    this.glider.stalled = false;
    this.glider.vel.x = Math.sin(heading) * speed + air.x;
    this.glider.vel.y = -speed / 9 + air.y;
    this.glider.vel.z = Math.cos(heading) * speed + air.z;
  }

  /** Put the belt at a point with its engine idling in the air (a playtest station). */
  placeBelt(pos: IVec3, heading: number, fuel = 1): void {
    if (this.belt === undefined) return;
    this.belt.pos.x = pos.x;
    this.belt.pos.y = pos.y;
    this.belt.pos.z = pos.z;
    this.belt.fuel = fuel;
    this.belt.yaw = heading;
    this.belt.vel.x = this.belt.vel.y = this.belt.vel.z = 0;
    this.belt.grounded = false;
    this.belt.lever = 0.56;
  }

  step(dt: number, controls: IControls): void {
    if (this.phase !== "flying") return;
    this.time += dt;
    const { pos } = this.craft;
    const before = { x: pos.x, y: pos.y, z: pos.z };
    airAt(pos.x, pos.y, pos.z, this.time, this.air);
    if (this.air.y > 0.5) this.thermalTime += dt;
    if (this.glider !== undefined) {
      const wasStalled = this.glider.stalled;
      this.glider.step(
        dt,
        { pitch: -controls.pitch, roll: controls.roll },
        this.air,
        this.clearance,
      );
      if (this.glider.stalled && !wasStalled) this.stalls += 1;
    } else if (this.belt !== undefined) {
      const input: IBeltInput = {
        climb: controls.climb,
        lean: controls.pitch,
        turn: controls.roll,
      };
      this.belt.step(dt, input, this.air, groundHeight(pos.x, pos.z));
    }
    this.rings.step(before, pos);
    this.checkGround();
  }

  /** The stall warning shows under 8 m/s, high enough off the ground, when not yet stalled. */
  get stallWarning(): 0 | 1 | 2 {
    const glider = this.glider;
    if (glider === undefined || this.phase !== "flying") return 0;
    if (glider.stalled) return 2;
    return glider.airspeed < STALL_WARNING && this.clearance > 4 ? 1 : 0;
  }

  private checkGround(): void {
    if (this.belt?.grounded === true) return;
    if (this.clearance > (this.belt === undefined ? 0.2 : 0.05)) return;
    const { pos, vel } = this.craft;
    const ground = groundHeight(pos.x, pos.z);
    // The ground's normal from its slope, so a wall of hill is hit and a flat is landed on.
    const sx = (groundHeight(pos.x + 1, pos.z) - groundHeight(pos.x - 1, pos.z)) / 2;
    const sz = (groundHeight(pos.x, pos.z + 1) - groundHeight(pos.x, pos.z - 1)) / 2;
    const length = Math.hypot(sx, 1, sz);
    const closing = -(-sx * vel.x + vel.y - sz * vel.z) / length;
    const speed = Math.hypot(vel.x, vel.z);
    const upsideDown = this.glider !== undefined && Math.cos(this.glider.bank) < -0.2;
    this.touchdown = judgeTouchdown(pos, { closing, speed }, upsideDown, ground, this.limits);
    this.phase = this.touchdown.crashed ? "crashed" : "landed";
    this.rings.close();
    pos.y = ground + (this.glider === undefined ? 0 : GLIDER_DROP);
    vel.x = vel.y = vel.z = 0;
  }
}
