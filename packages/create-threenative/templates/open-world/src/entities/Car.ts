import {
  CollisionShape3D,
  type IVehicleWheel3D,
  VehicleBody3D,
} from "@threenative/physics";
import { Group, MathUtils, Vector3 } from "three";
import { CAR_SIZE, type ICarVisual, WHEEL_RADIUS, WHEEL_SPOTS, carVisual } from "../render/car.js";
import { burntPaint } from "../render/materials.js";
import { CAR_LAYER, type GameCtx, PED_LAYER, PLAYER_LAYER, WORLD_LAYER } from "./layers.js";

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
  wheelFrictionSlip: 6,
} as const;

/** Where the chassis origin rides above the road once the struts have settled. */
export const RIDE_HEIGHT =
  CHASSIS.suspensionRestLength + WHEEL_RADIUS - 9.81 / (4 * CHASSIS.suspensionStiffness);

/**
 * The handling. GTA cars are quicker to turn and quicker to slide than a racing car: a light lock
 * curve, soft rear grip, and a handbrake that drops the rear tyres to a fifth of their grip.
 */
export const HANDLING = {
  /** Newtons per driven (rear) wheel at zero speed. */
  engineForce: 3000,
  /** Where the torque curve reaches zero, in m/s (about 115 km/h). */
  topSpeed: 32,
  torqueFade: 0.35,
  reverseTopSpeed: 8,
  /** Godot's `brake`: an impulse on every wheel. */
  brake: 70,
  /** Below this forward speed, holding back reverses instead of braking. */
  reverseEnterSpeed: 0.6,
  maxSteer: 0.6,
  /** The lateral acceleration the lock curve aims for, in m/s². */
  lateral: 14,
  /**
   * Seconds the raw steering takes to chase the stick: a first-order lag of five steps at 50 Hz
   * (MCP card grand-theft-auto-san-andreas-reversed/vehicle-steering-ramp).
   */
  steerLag: 0.1,
  handbrakeGrip: 0.2,
  handbrakeBrake: 8,
} as const;

/** Body damage. A hit loses `(Δv - DAMAGE_FREE) * DAMAGE_PER_MS` health; 1000 is a new car. */
const DAMAGE_FREE = 3;
const DAMAGE_PER_MS = 40;
export const CAR_HEALTH = 1000;
/** Seconds a wrecked car burns before it explodes. */
const BURN = 4;

const WHEELBASE = Math.abs(WHEEL_SPOTS[0][1] - WHEEL_SPOTS[2][1]);

export type CarRole = "parked" | "traffic" | "police" | "player" | "mission";

const _forward = new Vector3();

/**
 * One car: a `VehicleBody3D` on ray-cast suspension and the block car it carries. The player, the
 * traffic and the police all drive this same class through {@link Car.drive}; there is no second,
 * faked car for the AI.
 */
export class Car {
  readonly body: VehicleBody3D;
  readonly mesh: Group;
  readonly visual: ICarVisual;
  readonly id: number;
  role: CarRole;
  /** An AI driver sits inside: entering this car is a carjack. */
  occupied: boolean;
  health = CAR_HEALTH;
  wrecked = false;
  exploded = false;
  burning = 0;
  /** The largest one-tick velocity change since the last read, in m/s. Play reads it for crashes. */
  lastImpact = 0;
  #rawSteer = 0;
  #lastVelocity = new Vector3();
  #handbrake = false;

  constructor(
    ctx: GameCtx,
    options: {
      readonly id: number;
      readonly colour: number;
      readonly position: Vector3;
      readonly yaw: number;
      readonly role: CarRole;
      readonly occupied: boolean;
    },
  ) {
    this.id = options.id;
    this.role = options.role;
    this.occupied = options.occupied;
    this.mesh = new Group();
    this.mesh.position.set(options.position.x, RIDE_HEIGHT + 0.05, options.position.z);
    this.mesh.rotation.y = options.yaw;
    this.visual = carVisual(options.colour, RIDE_HEIGHT, options.role === "police");
    this.mesh.add(this.visual.root);
    ctx.add(this.mesh);
    for (const wheel of this.visual.wheels) wheel.rotation.order = "YXZ";
    this.body = new VehicleBody3D({
      collisionLayer: CAR_LAYER,
      collisionMask: WORLD_LAYER | CAR_LAYER | PLAYER_LAYER | PED_LAYER,
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

  /** The car's heading as a three `rotation.y`: forward is `(-sin yaw, 0, -cos yaw)`. */
  get yaw(): number {
    this.forward(_forward);
    return Math.atan2(-_forward.x, -_forward.z);
  }

  forward(out: Vector3): Vector3 {
    return out.set(0, 0, -1).applyQuaternion(this.mesh.quaternion).setY(0).normalize();
  }

  /** The steering lock at a speed: full on the spot, falling as `1 / v²` to hold a radius. */
  lockAt(speed: number): number {
    const fast = Math.max(Math.abs(speed), 4);
    return Math.min(HANDLING.maxSteer, (HANDLING.lateral * WHEELBASE) / (fast * fast));
  }

  /**
   * Every driver's controls. `pedal` is accelerate minus brake in [-1, 1]; `steer` is +1 for full
   * right. Holding back while rolling forward brakes, and only reverses once the car has nearly
   * stopped (MCP card grand-theft-auto-san-andreas-reversed/vehicle-pedal-arbitration).
   */
  drive(pedal: number, steer: number, handbrake: boolean, dt: number): void {
    if (this.wrecked) {
      this.body.engineForce = 0;
      this.body.brake = HANDLING.brake * 0.3;
      return;
    }
    const speed = this.body.speed;
    let engine = 0;
    let brake = 0;
    if (pedal > 0) {
      if (speed < -HANDLING.reverseEnterSpeed) brake = HANDLING.brake * pedal;
      else engine = HANDLING.engineForce * pedal * torque(speed, HANDLING.topSpeed);
    } else if (pedal < 0) {
      if (speed > HANDLING.reverseEnterSpeed) brake = HANDLING.brake * -pedal;
      else engine = HANDLING.engineForce * pedal * torque(-speed, HANDLING.reverseTopSpeed);
    }
    if (handbrake) {
      engine = 0;
      brake = Math.max(brake, HANDLING.handbrakeBrake);
    }
    if (handbrake !== this.#handbrake) {
      this.#handbrake = handbrake;
      const grip = CHASSIS.wheelFrictionSlip * (handbrake ? HANDLING.handbrakeGrip : 1);
      this.body.setWheelFrictionSlip(2, grip);
      this.body.setWheelFrictionSlip(3, grip);
    }
    this.#rawSteer = MathUtils.damp(this.#rawSteer, MathUtils.clamp(steer, -1, 1), 1 / HANDLING.steerLag, dt);
    // The card squares the raw value with its sign kept: half a stick is a quarter of the lock.
    // Rapier steers left for a positive angle, so "right" is negative.
    this.body.engineForce = engine;
    this.body.brake = brake;
    this.body.steering = -this.lockAt(speed) * this.#rawSteer * Math.abs(this.#rawSteer);
  }

  /** Hold still: no engine, a firm brake. Parked cars and stopped AI sit on this. */
  hold(): void {
    this.body.engineForce = 0;
    this.body.brake = HANDLING.brake * 0.5;
    this.body.steering = 0;
  }

  /** After the physics step: damage from the velocity change, wheel visuals, the burn clock. */
  afterStep(dt: number): void {
    const v = this.body.linearVelocity;
    const dvx = v.x - this.#lastVelocity.x;
    const dvy = v.y - this.#lastVelocity.y;
    const dvz = v.z - this.#lastVelocity.z;
    this.#lastVelocity.set(v.x, v.y, v.z);
    const impact = Math.hypot(dvx, dvy * 0.3, dvz);
    this.lastImpact = Math.max(this.lastImpact, impact);
    if (impact > DAMAGE_FREE) this.damage((impact - DAMAGE_FREE) * DAMAGE_PER_MS);
    if (this.wrecked && !this.exploded) this.burning += dt;
    for (let index = 0; index < 4; index += 1) {
      const wheel = this.visual.wheels[index] as Group;
      wheel.position.y = -this.body.wheelSuspensionLength(index);
      wheel.rotation.x = -this.body.wheelRotation(index);
      if (index < 2) wheel.rotation.y = this.body.steering;
    }
  }

  /** True on the tick a burning wreck reaches its fuse. */
  get readyToExplode(): boolean {
    return this.wrecked && !this.exploded && this.burning >= BURN;
  }

  damage(amount: number): void {
    if (this.wrecked || !(amount > 0)) return;
    this.health = Math.max(0, this.health - amount);
    if (this.health > 0) return;
    this.wrecked = true;
    this.visual.root.traverse((object) => {
      const mesh = object as { isMesh?: boolean; name: string; material?: unknown };
      if (mesh.isMesh === true && mesh.name === "body") mesh.material = burntPaint;
    });
  }

  /** The respray: full health, a new paint, the burn put out. */
  repair(colour: number): void {
    this.health = CAR_HEALTH;
    this.wrecked = false;
    this.burning = 0;
    this.visual.paint.color.setHex(colour);
    this.visual.root.traverse((object) => {
      const mesh = object as { isMesh?: boolean; name: string; material?: unknown };
      if (mesh.isMesh === true && mesh.name === "body") mesh.material = this.visual.paint;
    });
  }

  debug(): Record<string, unknown> {
    return {
      health: Math.round(this.health),
      occupied: this.occupied,
      position: this.mesh.position.toArray(),
      role: this.role,
      speed: this.body.speed,
      steering: this.body.steering,
      wrecked: this.wrecked,
    };
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}

/** The engine force share at `speed` for a curve that reaches zero at `top`. */
function torque(speed: number, top: number): number {
  return MathUtils.clamp((top - speed) / (top * HANDLING.torqueFade), 0, 1);
}
