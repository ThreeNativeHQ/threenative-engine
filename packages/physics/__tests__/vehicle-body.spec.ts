import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { Group, type Object3D, Quaternion, Vector3 } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IVehicleWheel3D, VehicleBody3D } from "../src/VehicleBody3D.js";
import { createNativePhysicsSimulation } from "../src/native/host.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

const DT = 1 / 60;
const plugins: Array<ReturnType<typeof rapier>> = [];

type FrameCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

async function setup() {
  await RAPIER.init();
  const plugin = rapier();
  const frameCtx = { physics: undefined } as unknown as FrameCtx;
  await plugin.setup?.(frameCtx);
  plugins.push(plugin);
  return { ctx: frameCtx.physics as IPhysicsContext, frameCtx, plugin };
}

function step(plugin: ReturnType<typeof rapier>, frameCtx: FrameCtx, frames: number): void {
  for (let frame = 0; frame < frames; frame += 1) plugin.update?.(frameCtx, DT);
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as FrameCtx);
});

const TRACK = 0.8;
const WHEEL_BASE = 1.2;
const REST = 0.3;
const RADIUS = 0.34;
/** Chassis-local height of every wheel mount. */
const MOUNT = -0.15;
/**
 * Chassis centre height above the floor with the suspension at rest length: the strut is
 * `suspensionRestLength` long, so the mount rides a wheel radius above the wheel centre.
 */
const RIDE = REST + RADIUS - MOUNT;

function wheel(front: boolean, left: boolean): IVehicleWheel3D {
  return {
    dampingCompression: 2.3,
    dampingRelaxation: 4.4,
    maxSuspensionTravel: 0.3,
    position: { x: left ? -TRACK : TRACK, y: MOUNT, z: front ? -WHEEL_BASE : WHEEL_BASE },
    suspensionRestLength: REST,
    // Mass-normalised stiffness: sag is about 9.81 / (4 * 100) = 0.025 m of the 0.3 m strut.
    suspensionStiffness: 100,
    useAsSteering: front,
    useAsTraction: !front,
    wheelFrictionSlip: 10.5,
    wheelRadius: RADIUS,
  };
}

const FRONT_LEFT = wheel(true, true);
const FRONT_RIGHT = wheel(true, false);
const REAR_LEFT = wheel(false, true);
const REAR_RIGHT = wheel(false, false);
const WHEELS = [FRONT_LEFT, FRONT_RIGHT, REAR_LEFT, REAR_RIGHT];

function floor(ctx: IPhysicsContext, half: number): RigidBody3D {
  return new RigidBody3D({
    physics: ctx,
    position: { x: 0, y: -0.25, z: 0 },
    shape: CollisionShape3D.box(half * 2, 0.5, half * 2),
    type: "fixed",
  });
}

function car(ctx: IPhysicsContext, x: number, y: number, z: number): VehicleBody3D {
  const object = new Group();
  object.position.set(x, y, z);
  return new VehicleBody3D({
    mass: 900,
    object,
    physics: ctx,
    shape: CollisionShape3D.box(1.6, 0.5, 3.6),
    wheels: WHEELS,
  });
}

/** The chassis heading as yaw in radians, read off the object's own quaternion. */
function yawOf(object: Object3D): number {
  const forward = new Vector3(0, 0, -1).applyQuaternion(object.quaternion);
  return Math.atan2(forward.x, -forward.z);
}

describe("VehicleBody3D", () => {
  it("settles on its suspension with every wheel loaded and compressed below rest length", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 200);
    const vehicle = car(ctx, 0, RIDE + 0.05, 0);

    step(plugin, frameCtx, 300);

    expect([0, 1, 2, 3].map((index) => vehicle.wheelContact(index))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    for (const [index] of WHEELS.entries()) {
      const length = vehicle.wheelSuspensionLength(index);
      expect(length).toBeGreaterThan(0);
      expect(length).toBeLessThan(REST);
    }
    // Carried by the springs, not resting on its own collider, and parked.
    expect(vehicle.object.position.y - 0.25).toBeGreaterThan(0.4);
    expect(Math.abs(vehicle.speed)).toBeLessThan(0.01);
    expect(Math.hypot(vehicle.object.position.x, vehicle.object.position.z)).toBeLessThan(0.5);
  });

  it("accelerates on engine force and turns on steering", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 400);
    const vehicle = car(ctx, 0, RIDE, 0);

    vehicle.engineForce = 4000;
    step(plugin, frameCtx, 180);

    expect(vehicle.speed).toBeGreaterThan(5);
    // The default forwardAxis is -z, so a positive engine force drives towards -z.
    expect(vehicle.object.position.z).toBeLessThan(-5);

    const yawBefore = yawOf(vehicle.object);
    vehicle.steering = 0.5;
    step(plugin, frameCtx, 60);

    expect(Math.abs(yawOf(vehicle.object) - yawBefore)).toBeGreaterThan(0.1);
  });

  it("brakes to rest inside three seconds", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 400);
    const vehicle = car(ctx, 0, RIDE, 0);

    vehicle.engineForce = 4000;
    step(plugin, frameCtx, 120);
    const speedAtBrake = Math.abs(vehicle.speed);
    vehicle.engineForce = 0;
    vehicle.brake = 60;

    let brakingSeconds = 0;
    while (Math.abs(vehicle.speed) > 0.2 && brakingSeconds < 3) {
      step(plugin, frameCtx, 1);
      brakingSeconds += DT;
    }

    expect(speedAtBrake).toBeGreaterThan(5);
    expect(brakingSeconds).toBeLessThan(3);
    expect(Math.abs(vehicle.speed)).toBeLessThan(0.2);
  });

  it("pitches onto a ten degree ramp instead of staying pinned level", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    // A slab rotated ten degrees about x, its top face passing through the origin.
    const ramp = new Group();
    ramp.position.set(0, -0.5, 0);
    ramp.quaternion.setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 18);
    new RigidBody3D({
      object: ramp,
      physics: ctx,
      shape: CollisionShape3D.box(400, 1, 400),
      type: "fixed",
    });
    const vehicle = car(ctx, 0, RIDE + 0.2, 0);
    // A car on a slope rolls downhill with nothing to hold it, exactly as a real one does.
    vehicle.brake = 60;

    step(plugin, frameCtx, 300);

    const up = new Vector3(0, 1, 0).applyQuaternion(vehicle.object.quaternion);
    expect(Math.abs(up.z)).toBeGreaterThan(0.05);
    expect(vehicle.wheelContact(0)).toBe(true);
    // Still on the ramp rather than sliding off it.
    expect(vehicle.object.position.y).toBeGreaterThan(0.2);
    expect(Math.abs(vehicle.object.position.z)).toBeLessThan(2);
  });

  it("stops at a wall rather than driving through it", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 200);
    const wallZ = -30;
    new RigidBody3D({
      physics: ctx,
      position: { x: 0, y: 2, z: wallZ },
      shape: CollisionShape3D.box(60, 4, 0.5),
      type: "fixed",
    });
    const vehicle = car(ctx, 0, RIDE, 0);
    vehicle.engineForce = 4000;

    let closest = 0;
    for (let frame = 0; frame < 300; frame += 1) {
      step(plugin, frameCtx, 1);
      closest = Math.min(closest, vehicle.object.position.z);
    }

    // The wall is 0.5 m thick, so its near face is at -29.75 and its far face at -30.25. The nose
    // reaches the wall and the chassis never crosses it.
    expect(closest).toBeLessThan(-29.75 + 1.8 + 0.5);
    expect(closest).toBeGreaterThan(-30.25);
    expect(Math.abs(vehicle.speed)).toBeLessThan(1);
  });

  it("respawns on teleport and drives the other way afterwards", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 200);
    const vehicle = car(ctx, 0, RIDE, 0);

    vehicle.teleport({ x: 10, y: RIDE, z: 40 }, Math.PI);
    step(plugin, frameCtx, 10);

    expect(vehicle.object.position.x).toBeCloseTo(10, 3);
    expect(vehicle.object.position.z).toBeCloseTo(40, 3);
    expect(Math.abs(yawOf(vehicle.object))).toBeCloseTo(Math.PI, 1);
    expect(vehicle.speed).toBeLessThan(0.5);

    // Facing the other way, a positive engine force is now +z.
    vehicle.engineForce = 4000;
    step(plugin, frameCtx, 120);

    expect(vehicle.object.position.z).toBeGreaterThan(41);
    expect(vehicle.speed).toBeGreaterThan(5);
  });

  it("rejects a car that cannot stand or roll, by name", async () => {
    const { ctx } = await setup();
    const shape = CollisionShape3D.box(1.6, 0.5, 3.6);

    expect(
      () => new VehicleBody3D({ object: new Group(), physics: ctx, shape, wheels: [] }),
    ).toThrow(/TN_VEHICLE_INVALID: a vehicle needs at least one wheel/);
    expect(
      () =>
        new VehicleBody3D({
          object: new Group(),
          physics: ctx,
          shape,
          wheels: [{ ...FRONT_LEFT, wheelRadius: -0.34 }],
        }),
    ).toThrow(/TN_VEHICLE_INVALID: wheel 0 wheelRadius must be a finite positive number/);
    expect(
      () =>
        new VehicleBody3D({
          object: new Group(),
          physics: ctx,
          shape,
          wheels: [{ ...FRONT_LEFT, suspensionRestLength: 0 }],
        }),
    ).toThrow(/TN_VEHICLE_INVALID: wheel 0 suspensionRestLength/);
    expect(
      () =>
        new VehicleBody3D({
          forwardAxis: "sideways" as "-z",
          object: new Group(),
          physics: ctx,
          shape,
          wheels: WHEELS,
        }),
    ).toThrow(/TN_VEHICLE_INVALID: forwardAxis 'sideways'/);
    expect(() => {
      car(ctx, 0, RIDE, 0).engineForce = Number.NaN;
    }).toThrow(/TN_VEHICLE_INVALID: engineForce must be a finite number/);
    expect(() => {
      car(ctx, 0, RIDE, 0).brake = Number.POSITIVE_INFINITY;
    }).toThrow(/TN_VEHICLE_INVALID: brake must be a finite number/);
  });

  it("slides its tail when the rear grip drops, and holds the line on full grip", async () => {
    // The handbrake: a turn at speed on full grip follows the nose; the same turn with the rear
    // pair's grip cap cut lets the tail step out, so the heading leads the velocity.
    async function slipAfterTurn(rearGrip: number): Promise<number> {
      const { ctx, frameCtx, plugin } = await setup();
      floor(ctx, 400);
      const vehicle = car(ctx, 0, RIDE, 0);
      vehicle.engineForce = 4000;
      step(plugin, frameCtx, 150);
      vehicle.setWheelFrictionSlip(2, rearGrip);
      vehicle.setWheelFrictionSlip(3, rearGrip);
      vehicle.steering = 0.4;
      step(plugin, frameCtx, 30);
      const v = vehicle.linearVelocity;
      const heading = new Vector3(0, 0, -1).applyQuaternion(vehicle.object.quaternion);
      return Math.acos(
        Math.min(
          1,
          (heading.x * v.x + heading.z * v.z) /
            Math.hypot(v.x, v.z) /
            Math.hypot(heading.x, heading.z),
        ),
      );
    }

    const grip = await slipAfterTurn(10.5);
    const slide = await slipAfterTurn(0.6);

    expect(slide).toBeGreaterThan(0.2);
    expect(slide).toBeGreaterThan(grip * 2);
  });

  it("names a bad wheel index or grip, and reports the grip it holds", async () => {
    const { ctx } = await setup();
    floor(ctx, 20);
    const vehicle = car(ctx, 0, RIDE, 0);

    expect(vehicle.wheelFrictionSlip(2)).toBe(10.5);
    vehicle.setWheelFrictionSlip(2, 1.5);
    expect(vehicle.wheelFrictionSlip(2)).toBe(1.5);
    expect(() => vehicle.setWheelFrictionSlip(4, 1)).toThrow(/TN_VEHICLE_INVALID/);
    expect(() => vehicle.setWheelFrictionSlip(0, Number.NaN)).toThrow(/TN_PHYSICS_NON_FINITE/);
    expect(() => vehicle.setWheelFrictionSlip(0, -1)).toThrow(/TN_PHYSICS_NON_FINITE/);
  });

  it("refuses to build on a backend with no vehicle controller", () => {
    // The node asks for the four vehicle members before it builds anything, so a backend that
    // cannot drive a car says so by name instead of leaving a motionless chassis behind. Both
    // shipped backends answer now; this is the guard for any simulation that does not.
    const backend = { createBody: () => 0, step: () => {} } as never;

    expect(
      () =>
        new VehicleBody3D({
          object: new Group(),
          shape: CollisionShape3D.box(1.6, 0.5, 3.6),
          wheels: WHEELS,
          world: backend,
        }),
    ).toThrow(/TN_VEHICLE_NATIVE_UNAVAILABLE/);
  });

  it("drives a car through the native adapter seam", () => {
    const frictions: Array<[number, number]> = [];
    // The native adapter is the same shared node, so it must build a vehicle rather than throw;
    // the adapter's own guards are in native-contract.spec.ts.
    const native = createNativePhysicsSimulation(
      {
        createBody: () => 0,
        createVehicle: () => 0,
        readVehicleState: (_id: number, output: Float32Array) => {
          output.fill(0);
          return output.length;
        },
        resetVehicle: () => {},
        setVehicleInput: () => {},
        setVehicleWheelFriction: (_id: number, wheel: number, grip: number) => {
          frictions.push([wheel, grip]);
        },
      } as never,
      "0.30.0",
    );

    const vehicle = new VehicleBody3D({
      mass: 900,
      object: new Group(),
      shape: CollisionShape3D.box(1.6, 0.5, 3.6),
      wheels: WHEELS,
      world: native,
    });
    vehicle.engineForce = 4000;
    vehicle.brake = 60;
    vehicle.steering = 0.25;
    vehicle.setWheelFrictionSlip(3, 2);
    expect(vehicle.engineForce).toBe(4000);
    expect(frictions).toEqual([[3, 2]]);
    expect(() => vehicle.setWheelFrictionSlip(9, 2)).toThrow(/TN_VEHICLE_INVALID/);
  });

  it("drops the vehicle with its body and stops answering after dispose", async () => {
    const { ctx, frameCtx, plugin } = await setup();
    floor(ctx, 200);
    const vehicle = car(ctx, 0, RIDE, 0);
    step(plugin, frameCtx, 60);
    const parked = {
      position: vehicle.object.position.clone(),
      quaternion: new Quaternion().copy(vehicle.object.quaternion),
    };

    vehicle.dispose();
    step(plugin, frameCtx, 60);

    expect(vehicle.object.position.distanceTo(parked.position)).toBe(0);
    expect(vehicle.object.quaternion.equals(parked.quaternion)).toBe(true);
    expect(() => vehicle.speed).toThrow(/cannot be used after dispose/);
    expect(() => vehicle.teleport({ x: 0, y: RIDE, z: 0 }, 0)).toThrow(
      /cannot be used after dispose/,
    );
    expect(() => vehicle.wheelContact(0)).toThrow(/cannot be used after dispose/);
    expect(() => vehicle.brake).toThrow(/cannot be used after dispose/);
  });
});
