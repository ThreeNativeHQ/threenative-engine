import type { ICtx } from "@threenative/core";
import {
  CollisionShape3D,
  type IPhysicsContext,
  type IVehicleWheel3D,
  VehicleBody3D,
} from "@threenative/physics";
import { Box3, Group, MathUtils, type Object3D, Vector3 } from "three";
import { prepareVehicleConventions } from "../conventions.js";
import { vehicle } from "../render/shapes.js";
import type { GameState } from "../state.js";

export type CarCtx = ICtx<GameState, IPhysicsContext>;
export type CarMaterials = Parameters<typeof vehicle>[0];

/**
 * The chassis geometry, in metres, in the chassis's own frame. `VehicleBody3D` reads Godot's
 * `VehicleWheel3D` names; these are its values.
 *
 * The numbers are measured, not guessed. `packages/physics`'s AGENTS.md records the three Rapier
 * facts this file depends on, and the tuning was done against them on the real backend:
 *
 * - `suspensionStiffness` is **mass-normalised** — a frequency squared, so the strut sags about
 *   `gravity / (4 * stiffness)` and Godot's default of 20 bottoms the suspension out. At this
 *   world's `-24 m/s²` and 220 that is 27 mm of the 240 mm strut.
 * - A wheel ray must not hit the chassis it hangs from, or the car rides its own collider.
 * - `speed` is the seam's own signed forward speed, not Rapier's `currentVehicleSpeed()`.
 *
 * Measured on this geometry (620 kg, 17 m/s top speed): 0 → 15.04 m/s in 3.33 s and a settled
 * 17.00 m/s terminal; 15.04 → 0 in 0.65 s over 4.75 m; a full-lock input at 15 m/s settles into a
 * 7.6 m radius corner without spinning; 0 → 11.1 m/s in 2.5 s from rest on full lock, which is the
 * "turns on the spot without spinning" case; an 80 mm kerb lifts the car 8 mm and costs no speed,
 * and a car at 17 m/s stops at a wall without passing through it.
 */
export const CAR = {
  /** Godot's `collision_layer`: another car, the road, the field, the barriers. */
  collisionLayer: 1,
  /** Godot's `collision_mask` — what the chassis and its wheel rays scan. */
  collisionMask: 1 | 2 | 4 | 8,
  /** Godot's `mass`. 620 kg for a 3 m car. */
  mass: 620,
  /** The chassis collider: the car's waist, clear of the road and low enough to ride a kerb. */
  shape: { height: 0.24, length: 2.5, width: 1.05 },
  /**
   * Godot's `suspensionRestLength`. The chassis origin rides one strut above the tarmac, so this is
   * also the car's ride height before sag.
   */
  suspensionRestLength: 0.24,
  /** Mass-normalised, so this is a frequency squared and not newtons per metre. */
  suspensionStiffness: 220,
  dampingCompression: 2.3,
  dampingRelaxation: 4.4,
  maxSuspensionTravel: 0.12,
  /** Above 10 the tyres hold a 7.6 m radius at 15 m/s instead of washing wide. */
  wheelFrictionSlip: 14,
  /** Godot's `up_direction` is implicit: the suspension ray points down the chassis's own -y. */
  gravity: 24,
} as const;

/**
 * The feel. Every number is measured on the physics rather than chosen, and they are shared by
 * both cars on the circuit: the rival drives the same chassis with the same tyres, so it is a
 * driver, not a faster class of car.
 *
 * `topSpeed` is **reached, not clamped**. The engine force falls linearly to zero there, which is
 * a torque curve rather than a speed limit: the tyres, the suspension and the barriers all still
 * decide what happens, and a car that hits a wall at 17 m/s stops at the wall.
 */
export const FEEL = {
  /** Newton's per driven wheel at zero speed. Two rear wheels, so this is half the push. */
  engineForce: 3400,
  /** Godot's `brake`: a braking impulse on every wheel, not a force. */
  brake: 60,
  /** Where the torque curve reaches zero, in m/s. */
  topSpeed: 17,
  /** The boost lifts the curve's zero point, so a boost genuinely raises the top speed. */
  boostTopSpeed: 23,
  /** And lifts the force behind it, so it arrives sooner as well as going further. */
  boostForce: 1.9,
  /** Holding back above this brakes; at or below it, reverse engages. */
  reverseEnterSpeed: 0.5,
  /** Reverse's own top speed, so it cannot run away down the straight. */
  reverseTopSpeed: 8,
  /** Godot's `steering` in radians at full lock, on the spot. */
  maxSteer: 0.5,
  /**
   * The lateral acceleration the steering curve aims for, in m/s². Lock falls as `1 / speed²`
   * because that is what holds a constant radius, so the tyres set the limit instead of the input:
   * 30 gives a 7.6 m corner at 15 m/s, and this circuit's corners are 7 m of road.
   */
  lateral: 30,
  /** Degrees the visible body leans at the lateral limit, and dives under braking. */
  leanRoll: 5,
  leanPitch: 3,
} as const;

/** The chassis wheelbase in metres, read off the same sculpt the wheels come from. */
export const WHEELBASE = 1.835;

/** Where the four wheels are named in `shapes.ts`. The order is the physics wheel order. */
export const WHEEL_NAMES = [
  "wheel-front-left",
  "wheel-front-right",
  "wheel-rear-left",
  "wheel-rear-right",
] as const;

/** Strut sag for this world: `gravity / (4 * stiffness)`, which is what mass-normalised means. */
export const SAG = CAR.gravity / (4 * CAR.suspensionStiffness);

/**
 * The visual's own origin sits on its authored ground line, and the physics puts the wheel
 * contacts one strut *below* the chassis origin. Offsetting the body by the settled strut is what
 * stops the car from being drawn a full strut height in the air (or under the road).
 */
export const RIDE = CAR.suspensionRestLength - SAG;

/**
 * The one place the two yaw conventions meet.
 *
 * A heading here is always measured the way a map is: `atan2(z, x)` of the direction the car's
 * nose points. three's `rotation.y` turns **+x toward -z**, and Rapier's `teleport` yaw is that same
 * +y rotation, so a heading has to be negated on the way in. Getting this wrong points the car 2θ
 * away from where the caller asked — which reads as "the rival spawns facing the wrong way and the
 * pursuit controller steers it into the tyre wall".
 */
export function noseRotation(yaw: number): number {
  return -yaw;
}

const DEG = Math.PI / 180;

/** How fast the measured load follows the tyres, per second: about a 0.17 s time constant. */
const LOAD_SMOOTHING = 6;
const _box = new Box3();
const _size = new Vector3();
const _point = new Vector3();

function requireNamed(visual: Group, name: string): Object3D {
  const found = visual.getObjectByName(name);
  if (found === undefined) throw new Error(`CarBody: the car sculpt has no '${name}' group.`);
  return found;
}

/**
 * One wheel's physics description, read off its own mesh.
 *
 * The position comes from the mesh rather than a second copy of the numbers, and the radius is
 * measured from the mesh's own bounds — so reshaping the car in `shapes.ts` moves the suspension
 * with it, and the physics can never end up describing a wheel the scene does not draw.
 */
function describeWheel(
  visual: Group,
  name: string,
  scale: number,
): { readonly position: { x: number; y: number; z: number }; readonly wheelRadius: number } {
  const mesh = requireNamed(visual, name);
  visual.updateWorldMatrix(true, true);
  _box.setFromObject(mesh, true);
  if (_box.isEmpty()) throw new Error(`CarBody: '${name}' has no geometry to measure.`);
  // `worldToLocal` divides out the visual's uniform scale; the chassis frame is that times it.
  const local = visual.worldToLocal(_box.getCenter(_point)).multiplyScalar(scale);
  // The lathe runs about the wheel's z axis, so half the y extent of its world bounds is its
  // radius, already in chassis metres.
  return {
    position: { x: local.x, y: local.y, z: local.z },
    wheelRadius: _box.getSize(_size).y / 2,
  };
}

/**
 * A `VehicleBody3D` and the sculpted car it carries.
 *
 * Both cars on this circuit are one of these, so the player's and the rival's handling are the
 * same code: there is no second, worse car hiding in `Rival.ts`.
 */
export class CarBody {
  /** The chassis `VehicleBody3D` drives. Its transform is written back every physics step. */
  readonly body: VehicleBody3D;
  /** The chassis root: the object the physics writes its solved transform onto. */
  readonly mesh: Group;
  /** The sculpted car inside it, scaled to metres and offset by `RIDE`. */
  readonly chassis: Group;
  /** The leanable shell inside `chassis`, named `body` by `shapes.ts`. */
  readonly lean: Object3D;
  /** The four wheel groups, in the same order as `body.wheels`. */
  readonly wheels: readonly Object3D[];
  /** The retained `normaliseToMetres` factor, which the playtest asserts is below one. */
  readonly normaliseFactor: number;
  /** The chassis nose in world space: what the car is *pointing* at, off its own quaternion. */
  readonly forward = new Vector3(1, 0, 0);
  /** Where it is actually *going*, measured from its velocity. `Lap` reads this, not `forward`. */
  readonly travelDirection = new Vector3(1, 0, 0);
  /** Lateral acceleration in m/s², positive to the driver's right. */
  lateralLoad = 0;
  /** Forward acceleration in m/s²: positive under power, negative under braking. */
  longLoad = 0;
  /** Bumped by every `teleport`, so a chase camera can cut instead of flying after the car. */
  teleports = 0;
  #velocity = new Vector3();
  #last = new Vector3();
  #right = new Vector3();
  #delta = new Vector3();

  constructor(
    ctx: CarCtx,
    options: { readonly materials: CarMaterials; readonly spawn: Vector3; readonly yaw: number },
  ) {
    this.mesh = new Group();
    this.mesh.position.set(options.spawn.x, options.spawn.y, options.spawn.z);
    // `yaw` is a heading (`atan2(z, x)` of where the nose points); `noseRotation` converts it to the
    // +y rotation three and Rapier both use.
    this.mesh.rotation.y = noseRotation(options.yaw);
    this.mesh.castShadow = true;
    const chassis = vehicle(options.materials);
    this.normaliseFactor = prepareVehicleConventions(chassis);
    chassis.position.y = -RIDE;
    this.mesh.add(chassis);
    ctx.add(this.mesh);
    this.chassis = chassis;
    this.wheels = WHEEL_NAMES.map((name) => requireNamed(chassis, name));
    this.lean = requireNamed(chassis, "body");
    this.body = new VehicleBody3D({
      collisionLayer: CAR.collisionLayer,
      collisionMask: CAR.collisionMask,
      // The car's nose is its local +x, which is the direction `shapes.ts` lofted the hull along.
      forwardAxis: "x",
      mass: CAR.mass,
      object: this.mesh,
      physics: ctx.physics,
      shape: CollisionShape3D.box(CAR.shape.length, CAR.shape.height, CAR.shape.width),
      wheels: this.wheels.map((wheel, index): IVehicleWheel3D => {
        const measured = describeWheel(chassis, WHEEL_NAMES[index] as string, this.normaliseFactor);
        return {
          dampingCompression: CAR.dampingCompression,
          dampingRelaxation: CAR.dampingRelaxation,
          maxSuspensionTravel: CAR.maxSuspensionTravel,
          position: measured.position,
          suspensionRestLength: CAR.suspensionRestLength,
          suspensionStiffness: CAR.suspensionStiffness,
          useAsSteering: index < 2,
          useAsTraction: index >= 2,
          wheelFrictionSlip: CAR.wheelFrictionSlip,
          wheelRadius: measured.wheelRadius,
        };
      }),
    });
  }

  /** Godot's signed forward speed: positive while accelerating forward. */
  get speed(): number {
    return this.body.speed;
  }

  get speedMagnitude(): number {
    return Math.abs(this.body.speed);
  }

  get position(): Vector3 {
    return this.mesh.position;
  }

  /** The steering angle in radians this car last wrote, which is what the front wheels draw. */
  get steerAngle(): number {
    return this.body.steering;
  }

  /**
   * The steering lock at a speed: full lock on the spot, falling as `1 / speed²` because that is
   * the angle which holds a radius. A fixed lock asks for 8 g at 17 m/s and the car washes
   * straight on. This is the input curve; the tyres still set the limit.
   */
  lockAt(speed: number): number {
    const fast = Math.max(Math.abs(speed), 3);
    return Math.min(FEEL.maxSteer, (FEEL.lateral * WHEELBASE) / (fast * fast));
  }

  /**
   * Reads the solved chassis: the nose off its own quaternion, the travel direction and the load
   * off its own velocity, divided by the frame it was measured over.
   */
  measure(dt: number): void {
    this.forward.set(1, 0, 0).applyQuaternion(this.mesh.quaternion);
    this.#right.set(0, 0, 1).applyQuaternion(this.mesh.quaternion);
    const velocity = this.body.linearVelocity;
    this.#velocity.set(velocity.x, 0, velocity.z);
    // The measured direction of travel. Below half a metre per second a velocity has no direction
    // worth trusting, and a gate crossing in that state is a stationary car, not a reversal.
    if (this.#velocity.lengthSq() > 0.25) this.travelDirection.copy(this.#velocity).normalize();
    else this.travelDirection.copy(this.forward);
    this.#delta.copy(this.#velocity).sub(this.#last);
    this.#last.copy(this.#velocity);
    const perSecond = dt > 0 ? 1 / dt : 60;
    // One tick's velocity change is the tyres' impulse for that tick, and the ray-cast vehicle's
    // friction alternates from tick to tick: measured, the raw reading swung the full ±30 m/s² in
    // one tick mid-corner, which flipped the lean ±5° and the camera bank ±3° every tick — the
    // shake. The load a driver feels is the average over a few ticks, so it is low-passed here.
    // A barrier hit is hundreds of m/s² for one tick; past the tyres' limit the lean is already
    // full, so the reading is clamped there before it is averaged.
    const lateral = MathUtils.clamp(
      this.#delta.dot(this.#right) * perSecond,
      -FEEL.lateral,
      FEEL.lateral,
    );
    const long = MathUtils.clamp(
      this.#delta.dot(this.forward) * perSecond,
      -FEEL.lateral,
      FEEL.lateral,
    );
    this.lateralLoad = MathUtils.damp(this.lateralLoad, lateral, LOAD_SMOOTHING, dt);
    this.longLoad = MathUtils.damp(this.longLoad, long, LOAD_SMOOTHING, dt);
  }

  /**
   * The suspension's own state, after the step: the wheels spin and steer, and the body leans on
   * the load the tyres are carrying.
   *
   * The lean is drawn from a **measurement** — the change in the chassis' own velocity this frame —
   * because Rapier's ray-cast vehicle applies its suspension and friction impulses without a
   * moment about the roll axis, so the solved chassis stays level at 1.2 g (measured: 0.8° of roll
   * across the struts at 1.2 g lateral) and there is no real body roll to read. Roll and dive are
   * functions of lateral and forward load; this is that function, with the car's own load as input.
   */
  settleVisuals(): void {
    for (const [index, wheel] of this.wheels.entries()) {
      // Rolling forward turns the wheel about its own -z and Rapier's rotation runs the other way,
      // so the sign is inverted here; the front pair also takes the steer angle it was given.
      wheel.rotation.z = -this.body.wheelRotation(index);
      if (index < 2) wheel.rotation.y = this.body.steering;
    }
    this.lean.rotation.z =
      MathUtils.clamp(this.lateralLoad / FEEL.lateral, -1, 1) * FEEL.leanRoll * DEG;
    this.lean.rotation.x =
      MathUtils.clamp(this.longLoad / FEEL.lateral, -1, 1) * FEEL.leanPitch * DEG;
  }

  /** Godot's `VehicleBody3D.teleport`: move the chassis and face the heading `yaw`. */
  teleport(position: Pick<Vector3, "x" | "y" | "z">, yaw: number): void {
    this.body.teleport(position, noseRotation(yaw));
    this.teleports += 1;
    this.#last.set(0, 0, 0);
    this.lateralLoad = 0;
    this.longLoad = 0;
    this.measure(1 / 60);
  }

  dispose(): void {
    this.body.dispose();
    this.mesh.removeFromParent();
  }
}
