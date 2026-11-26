import { CollisionShape3D, type IVehicleWheel3D, VehicleBody3D } from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { burn, CAR_SIZE, type ICarVisual, WHEEL_RADIUS, WHEEL_SPOTS, carVisual, crumple } from "../render/car.js";
import { CarDamage, REGIONS, type Region, classify, impactLevels } from "../vehicle/damage.js";
import { BRAKE, Drivetrain } from "../vehicle/drivetrain.js";
import { stepCurvature } from "../vehicle/steering.js";
import { solveAxle } from "../vehicle/tyres.js";
import { CAR_LAYER, type GameCtx, WORLD_LAYER } from "./layers.js";

/**
 * The chassis, in metres and kilograms. `suspensionStiffness` and the dampers are mass-normalised
 * in Rapier (see `packages/physics/AGENTS.md`): the strut sags `g / (4 * stiffness)`, 49 mm here.
 */
export const CHASSIS = {
  mass: 1200,
  suspensionRestLength: 0.3,
  suspensionStiffness: 50,
  dampingCompression: 1.6,
  dampingRelaxation: 2.6,
  maxSuspensionTravel: 0.18,
  /** The physics wheel's grip cap at the static load on tarmac. */
  wheelFrictionSlip: 5,
} as const;

/** Where the chassis origin rides above the road once the struts have settled. */
export const RIDE_HEIGHT = CHASSIS.suspensionRestLength + WHEEL_RADIUS - 9.81 / (4 * CHASSIS.suspensionStiffness);
const WHEELBASE = Math.abs(WHEEL_SPOTS[0][1] - WHEEL_SPOTS[2][1]);
const AXLE_LOAD = (CHASSIS.mass * 9.81) / 2;
const AXLE_MASS = CHASSIS.mass / 2;

export const HANDLING = {
  /** The sideways acceleration full curvature asks for at speed, in m/s². Kit tuning: just past the grip. */
  lateral: 11,
  maxSteer: 0.55,
  minLock: 0.07,
  /** Newtons of sideways demand per m/s of sliding. Kit tuning. */
  slipGain: 3,
  /** Rear grip kept while the handbrake is down. */
  handbrakeGrip: 0.2,
  handbrakeBrake: 6,
} as const;

/** A velocity change under this many m/s in one tick is a bump, not a crash. */
const CRASH_DV = 3;
/** Rank the rivals are scaled by (crush.c:624). Kit tuning. */
export const RIVAL_RANK = 40;

export interface IControl {
  /** Forward pedal 0..1. */
  readonly fwd: number;
  /** Back pedal 0..1. */
  readonly back: number;
  /** +1 full right. The player's key; an AI writes `curvature` directly. */
  readonly steer: number;
  readonly handbrake: boolean;
}

export interface IHit {
  readonly dv: number;
  readonly levels: number;
  readonly region: Region;
}

const _forward = new Vector3();
const _right = new Vector3();

/**
 * One car: a `VehicleBody3D` on ray-cast suspension, a drivetrain, a tyre model and a damage model.
 * The player and every rival drive this same class; there is no second, faked car for the AI.
 */
export class Car {
  readonly body: VehicleBody3D;
  readonly mesh: Group;
  readonly visual: ICarVisual;
  readonly damage = new CarDamage();
  readonly drivetrain = new Drivetrain();
  readonly player: boolean;
  readonly name: string;
  /** Steering as accumulated curvature, -1..1 (+ right). An AI sets it directly. */
  curvature = 0;
  /** The newest crash this tick, read and cleared by the world. */
  hit: IHit | undefined;
  wrecked = false;
  /** Seconds since the wreck, for the burn. */
  burning = 0;
  slipping = { front: false, rear: false };
  tractionScale = 1;
  handbrake = false;
  #lastVelocity = new Vector3();
  #lastYaw = 0;
  #yawRate = 0;
  #lastSpeed = 0;
  #accel = 0;
  #grip = [1, 1, 1, 1];
  #fwd = 0;

  constructor(
    ctx: GameCtx,
    options: { readonly name: string; readonly colour: number; readonly x: number; readonly z: number; readonly yaw: number; readonly player: boolean },
  ) {
    this.name = options.name;
    this.player = options.player;
    this.mesh = new Group();
    this.mesh.position.set(options.x, RIDE_HEIGHT + 0.05, options.z);
    this.mesh.rotation.y = options.yaw;
    this.visual = carVisual(options.colour, RIDE_HEIGHT);
    this.mesh.add(this.visual.root);
    ctx.add(this.mesh);
    for (const wheel of this.visual.wheels) wheel.rotation.order = "YXZ";
    this.#lastYaw = options.yaw;
    this.body = new VehicleBody3D({
      collisionLayer: CAR_LAYER,
      collisionMask: WORLD_LAYER | CAR_LAYER,
      mass: CHASSIS.mass,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(CAR_SIZE.width, 0.5, CAR_SIZE.length),
      wheels: WHEEL_SPOTS.map(
        ([x, z], index): IVehicleWheel3D => ({
          dampingCompression: CHASSIS.dampingCompression,
          dampingRelaxation: CHASSIS.dampingRelaxation,
          maxSuspensionTravel: CHASSIS.maxSuspensionTravel,
          position: { x, y: 0, z },
          suspensionRestLength: CHASSIS.suspensionRestLength,
          suspensionStiffness: CHASSIS.suspensionStiffness,
          useAsSteering: index < 2,
          useAsTraction: index >= 2,
          wheelFrictionSlip: CHASSIS.wheelFrictionSlip,
          wheelRadius: WHEEL_RADIUS,
        }),
      ),
    });
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  /** Signed forward speed in m/s. */
  get speed(): number {
    return this.body.speed;
  }

  get yaw(): number {
    this.forward(_forward);
    return Math.atan2(-_forward.x, -_forward.z);
  }

  forward(out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.mesh.quaternion).setY(0).normalize();
  }

  /** The steering lock at a speed: the wheel angle that asks for `lateral` m/s² of cornering. */
  lockAt(speed: number): number {
    const fast = Math.max(Math.abs(speed), 4);
    return Math.min(HANDLING.maxSteer, Math.max(HANDLING.minLock, (HANDLING.lateral * WHEELBASE) / (fast * fast)));
  }

  /** Teleports the car and clears everything that would carry the old motion over. */
  place(x: number, z: number, yaw: number, speed = 0): void {
    this.body.teleport({ x, y: RIDE_HEIGHT + 0.05, z }, yaw);
    this.curvature = 0;
    this.#lastYaw = yaw;
    this.#yawRate = 0;
    if (speed !== 0) this.body.linearVelocity = { x: -Math.sin(yaw) * speed, y: 0, z: -Math.cos(yaw) * speed };
    this.#lastVelocity.set(-Math.sin(yaw) * speed, 0, -Math.cos(yaw) * speed);
    this.#lastSpeed = speed;
    this.hit = undefined;
    this.drivetrain.gear = speed > 1 ? 1 : 0;
  }

  /** The player's controls: the key builds curvature. */
  control(input: IControl, dt: number): void {
    const speed = this.body.speed;
    const lock = this.lockAt(speed);
    const yawNorm = MathUtils.clamp((-this.#yawRate * WHEELBASE) / Math.max(Math.abs(speed), 4) / Math.tan(lock), -1, 1);
    this.curvature = stepCurvature(this.curvature, input.steer, speed, yawNorm, dt);
    this.drive(input, dt);
  }

  /** Every driver's pedals, tyres and brakes, once `curvature` is set. */
  drive(input: IControl, dt: number): void {
    if (this.wrecked) {
      this.body.engineForce = 0;
      this.body.brake = BRAKE.initial * 0.5;
      return;
    }
    const speed = this.body.speed;
    const v = this.body.linearVelocity;
    this.forward(_forward);
    // right = (cos yaw, 0, -sin yaw) = (-fz, 0, fx) with forward = (-sin yaw, 0, -cos yaw)
    _right.set(-_forward.z, 0, _forward.x);
    const lateralSpeed = v.x * _right.x + v.z * _right.z;
    const angle = this.lockAt(speed) * this.curvature;
    const steerHard = Math.abs(this.curvature) > 0.6;
    const wantsHandbrake = input.handbrake && this.damage.handbrakeWorks;
    this.handbrake = wantsHandbrake;
    if (wantsHandbrake) this.drivetrain.handbrakeToNeutral();

    const out = this.drivetrain.step(
      { back: input.back, fwd: input.fwd, handbrake: wantsHandbrake },
      {
        brakeEfficiency: this.damage.brakeEfficiency,
        engineDamage: this.damage.parts.engine,
        rearSlipping: this.slipping.rear,
        speed,
        steeringHard: steerHard,
      },
      dt,
    );
    // Weight moves rearward when accelerating and forward when braking.
    const transfer = MathUtils.clamp(this.#accel / 9.81, -0.5, 0.5) * 0.25;
    const lateralAccel = (speed * speed * Math.abs(Math.tan(angle))) / WHEELBASE;
    const slipDemand = HANDLING.slipGain * Math.abs(lateralSpeed) * AXLE_MASS;
    const lateralDemand = AXLE_MASS * lateralAccel + slipDemand;
    const rear = solveAxle({
      driveDemand: Math.abs(out.driveForce),
      lateralDemand,
      lateralSpeed,
      load: AXLE_LOAD * (1 + transfer),
      staticLoad: AXLE_LOAD,
    });
    const front = solveAxle({
      driveDemand: 0,
      lateralDemand,
      lateralSpeed,
      load: AXLE_LOAD * (1 - transfer),
      staticLoad: AXLE_LOAD,
    });
    this.slipping = { front: front.slipping, rear: rear.slipping };
    this.tractionScale = rear.driveScale;
    // Surplus is lost: the engine passes on only what the tyre can hold.
    this.body.engineForce = (out.driveForce * rear.driveScale) / 2;
    this.body.brake = Math.max(out.brake, wantsHandbrake ? HANDLING.handbrakeBrake : 0);
    this.body.steering = -angle;
    this.#fwd = input.fwd;
    this.#setGrip(front.grip, rear.grip * (wantsHandbrake ? HANDLING.handbrakeGrip : 1));
  }

  /** Hold still: no engine, a firm brake. Parked rivals sit on this. */
  hold(): void {
    this.body.engineForce = 0;
    this.body.brake = BRAKE.initial + BRAKE.ramp;
    this.body.steering = 0;
    this.curvature = 0;
  }

  #setGrip(front: number, rear: number): void {
    const wanted = [front, front, rear, rear].map((grip, index) => grip * this.damage.wheelGrip(index));
    wanted.forEach((grip, index) => {
      if (Math.abs(grip - (this.#grip[index] as number)) < 0.03) return;
      this.#grip[index] = grip;
      this.body.setWheelFrictionSlip(index, CHASSIS.wheelFrictionSlip * grip);
    });
  }

  /** After the physics step: crash damage from the velocity change, wheel visuals, the burn clock. */
  afterStep(dt: number): void {
    const v = this.body.linearVelocity;
    const dvx = v.x - this.#lastVelocity.x;
    const dvy = v.y - this.#lastVelocity.y;
    const dvz = v.z - this.#lastVelocity.z;
    this.#lastVelocity.set(v.x, v.y, v.z);
    const dv = Math.hypot(dvx, dvy * 0.3, dvz);
    this.#accel = MathUtils.lerp(this.#accel, (this.body.speed - this.#lastSpeed) / Math.max(dt, 1e-3), 0.1);
    this.#lastSpeed = this.body.speed;
    const yaw = this.yaw;
    this.#yawRate = MathUtils.euclideanModulo(yaw - this.#lastYaw + Math.PI, Math.PI * 2) / dt - Math.PI / dt;
    this.#lastYaw = yaw;
    if (dv > CRASH_DV && !this.wrecked) this.#crash(dvx, dvz, dv);
    if (this.wrecked) this.burning += dt;
    for (let index = 0; index < 4; index += 1) {
      const wheel = this.visual.wheels[index] as Group;
      wheel.position.y = -this.body.wheelSuspensionLength(index);
      wheel.rotation.x = -this.body.wheelRotation(index);
      wheel.rotation.z = this.damage.wheelWobble(index) * (index % 2 === 0 ? 1 : -1);
      if (index < 2) wheel.rotation.y = this.body.steering;
    }
    for (const region of REGIONS) crumple(this.visual, region, this.damage.crush[region]);
  }

  #crash(dvx: number, dvz: number, dv: number): void {
    this.forward(_forward);
    _right.set(-_forward.z, 0, _forward.x);
    // The struck side is opposite to the velocity change; local z is positive toward the tail.
    const hitX = -(dvx * _right.x + dvz * _right.z);
    const hitZ = dvx * _forward.x + dvz * _forward.z;
    const region = classify(hitX, hitZ, CAR_SIZE.width / 2, CAR_SIZE.length / 2);
    const levels = this.damage.hit(region, impactLevels(dv, this.player, RIVAL_RANK));
    if (levels > 0) this.hit = { dv, levels, region };
    if (!this.wrecked && this.damage.wrecked) {
      this.wrecked = true;
      burn(this.visual);
    }
  }

  /** A wreck at once: the editor and playtest stations use it. */
  wreck(): void {
    this.damage.parts.engine = 99;
    this.wrecked = true;
    burn(this.visual);
  }

  debug(): Record<string, unknown> {
    const p = this.damage.parts;
    return {
      brakeEfficiency: Math.round(this.damage.brakeEfficiency * 100) / 100,
      crushFront: Math.round(this.damage.crush.front * 100) / 100,
      crushLeft: Math.round(this.damage.crush.left * 100) / 100,
      crushRear: Math.round(this.damage.crush.rear * 100) / 100,
      crushRight: Math.round(this.damage.crush.right * 100) / 100,
      curvature: Math.round(this.curvature * 100) / 100,
      driver: Math.round(p.driver),
      engine: Math.round(p.engine),
      gear: this.drivetrain.gear,
      handbrake: this.handbrake,
      handbrakeWorks: this.damage.handbrakeWorks,
      hits: this.damage.hits,
      kmh: Math.round(Math.abs(this.body.speed) * 3.6),
      moving: Math.abs(this.body.speed) > 3,
      position: this.mesh.position.toArray(),
      power: Math.round(this.damage.power * 100) / 100,
      rpm: Math.round(this.drivetrain.rpm),
      shifts: this.drivetrain.shifts,
      slippingFront: this.slipping.front,
      slippingRear: this.slipping.rear,
      speed: this.body.speed,
      stopped: Math.abs(this.body.speed) < 0.5,
      throttle: this.#fwd,
      tractionScale: Math.round(this.tractionScale * 100) / 100,
      transmission: Math.round(p.transmission),
      trimmed: this.drivetrain.trimmed,
      wheelWorst: Math.round(Math.max(p.wheel0, p.wheel1, p.wheel2, p.wheel3)),
      wrecked: this.wrecked,
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
