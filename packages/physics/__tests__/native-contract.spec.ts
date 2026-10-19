import * as RAPIER from "@dimforge/rapier3d-compat";
import { BufferAttribute, BufferGeometry, Mesh, Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { Area3D } from "../src/Area3D.js";
import { CharacterBody3D } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { PhysicsDirectSpaceState3D } from "../src/PhysicsDirectSpaceState3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import * as webEntry from "../src/index.js";
import {
  type INativeShapeDescriptor,
  type INativeSimulation,
  createNativePhysicsSimulation,
} from "../src/native/host.js";
import {
  Area3D as NativeArea3D,
  CharacterBody3D as NativeCharacterBody3D,
  CollisionShape3D as NativeCollisionShape3D,
  PhysicsDirectSpaceState3D as NativePhysicsDirectSpaceState3D,
  RigidBody3D as NativeRigidBody3D,
} from "../src/native/index.js";
import * as nativeEntry from "../src/native/index.js";
import type { IPhysicsContext } from "../src/plugin.js";
import type { IPhysicsVehicleWheelOptions } from "../src/simulation.js";
import {
  MAX_PHYSICS_QUERY_RESULTS,
  PHYSICS_SLEEP_STATE_STRIDE,
  PHYSICS_TRANSFORM_STRIDE,
  createWebPhysicsSimulation,
} from "../src/simulation.js";

function bodyOptions(type: "dynamic" | "fixed" | "kinematic" = "dynamic") {
  return {
    mass: type === "dynamic" ? 1 : 0,
    position: { x: 0, y: 0, z: 0 },
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    sensor: false,
    shape: CollisionShape3D.sphere(0.5).descriptor,
    type,
  };
}

describe("native physics contract", () => {
  it("keeps web and native runtime entry-point exports in parity", () => {
    expect(Object.keys(nativeEntry).sort()).toEqual(Object.keys(webEntry).sort());
  });

  it("exports one shared class for every public node", () => {
    expect(NativeArea3D).toBe(Area3D);
    expect(NativeCharacterBody3D).toBe(CharacterBody3D);
    expect(NativeCollisionShape3D).toBe(CollisionShape3D);
    expect(NativeRigidBody3D).toBe(RigidBody3D);
    expect(NativePhysicsDirectSpaceState3D).toBe(PhysicsDirectSpaceState3D);
  });

  it("reads ground body and normal through the existing bulk character-state call", () => {
    let nextId = 0;
    const readCharacterStates = vi.fn((buffer: Float32Array) => {
      buffer.set([0, 1, 1, 0, 0.8, 0.6]);
      return 1;
    });
    const raw = {
      configureCharacter: vi.fn(),
      createBody: vi.fn(() => nextId++),
      dispose: vi.fn(),
      drainCollisionEvents: vi.fn(() => 0),
      intersectPoint: vi.fn(() => []),
      intersectRay: vi.fn(() => null),
      intersectShape: vi.fn(() => []),
      readAreaIntersections: vi.fn(() => 0),
      readBodySleepStates: vi.fn(() => 0),
      readCharacterStates,
      readVisibleTransforms: vi.fn(() => 0),
      removeBody: vi.fn(),
      step: vi.fn(),
    } as unknown as INativeSimulation;
    const simulation = createNativePhysicsSimulation(raw, "0.30.0");
    const character = simulation.createBody({ ...bodyOptions("fixed"), type: "character" });
    const floor = simulation.createBody(bodyOptions("fixed"));
    simulation.configureCharacter(character.body.id, {
      maxSlopeClimbAngle: Math.PI / 4,
      offset: 0.01,
      oneWayLayers: 0,
    });
    simulation.step(1 / 60);

    const state = simulation.readCharacterState?.(character.body.id);
    expect(state).toEqual(
      expect.objectContaining({
        groundBody: floor.body,
        groundCollider: floor.body.id,
        grounded: true,
      }),
    );
    expect(state?.groundNormal?.x).toBe(0);
    expect(state?.groundNormal?.y).toBeCloseTo(0.8, 6);
    expect(state?.groundNormal?.z).toBeCloseTo(0.6, 6);
    expect(readCharacterStates).toHaveBeenCalledOnce();
  });

  it("rejects the old three-float native character-state row", () => {
    let nextId = 0;
    const raw = {
      configureCharacter: vi.fn(),
      createBody: vi.fn(() => nextId++),
      dispose: vi.fn(),
      drainCollisionEvents: vi.fn(() => 0),
      intersectPoint: vi.fn(() => []),
      intersectRay: vi.fn(() => null),
      intersectShape: vi.fn(() => []),
      readAreaIntersections: vi.fn(() => 0),
      readBodySleepStates: vi.fn(() => 0),
      readCharacterStates: vi.fn((buffer: Float32Array) => {
        buffer.set([0, 1, -1]);
        return 1;
      }),
      readVisibleTransforms: vi.fn(() => 0),
      removeBody: vi.fn(),
      step: vi.fn(),
    } as unknown as INativeSimulation;
    const simulation = createNativePhysicsSimulation(raw, "old-runtime");
    const character = simulation.createBody({ ...bodyOptions("fixed"), type: "character" });
    simulation.configureCharacter(character.body.id, {
      maxSlopeClimbAngle: Math.PI / 4,
      offset: 0.01,
      oneWayLayers: 0,
    });
    simulation.step(1 / 60);

    expect(() => simulation.readCharacterState?.(character.body.id)).toThrow(
      /malformed six-float character state/,
    );
  });

  it("rejects native shapes outside the ABI before calling the host", () => {
    const createBody = vi.fn(() => {
      throw new Error("unsupported shapes must not reach the native host");
    });
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );

    expect(() =>
      native.createBody({
        mass: 0,
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        sensor: false,
        shape: {
          collisionLayer: 1,
          collisionMask: 0xffff,
          kind: "convexHull",
          sensor: false,
          vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
          x: 0,
          y: 0,
          z: 0,
        },
        type: "fixed",
      }),
    ).toThrow(/TN_NATIVE_PHYSICS_SHAPE_UNSUPPORTED.*convexHull/);
    expect(createBody).not.toHaveBeenCalled();
  });

  it("hands a heightfield to the native host as its own column-major samples", () => {
    const createBody = vi.fn((_options: { shape: INativeShapeDescriptor }) => 3);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    const heights = new Float32Array([0, 1, 2, 3, 4, 5]);
    native.createBody({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.heightfield(2, 3, heights, { x: 4, y: 2, z: 6 }).descriptor,
      type: "fixed",
    });
    const shape = createBody.mock.calls[0]?.[0].shape;
    // The same buffer, grid and extent the web backend passes Rapier, so both build one surface.
    expect(shape).toMatchObject({ columns: 3, kind: "heightfield", rows: 2 });
    expect(shape?.heights).toBe(heights);
    expect(shape?.scale).toEqual({ x: 4, y: 2, z: 6 });
    expect(() =>
      native.createBody({
        mass: 0,
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        sensor: false,
        shape: {
          ...CollisionShape3D.heightfield(2, 3, heights, { x: 4, y: 2, z: 6 }).descriptor,
          heights: new Float32Array(5),
        },
        type: "fixed",
      }),
    ).toThrow(/TN_NATIVE_PHYSICS_SHAPE_INVALID/);
  });

  it("reads native contacts and refreshes a collider shape, failing closed on an old runtime", () => {
    const readContacts = vi.fn(() => 2);
    const setColliderShape = vi.fn();
    const createBody = vi.fn(() => 0);
    const native = createNativePhysicsSimulation(
      { createBody, readContacts, setColliderShape } as unknown as INativeSimulation,
      "0.30.0",
    );
    const surface = native.createBody({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.heightfield(2, 2, new Float32Array(4), { x: 1, y: 1, z: 1 })
        .descriptor,
      type: "fixed",
    });
    const ids = new Uint32Array([4]);
    const buffer = new Float32Array(16);
    expect(native.readContacts?.(surface.collider, ids, buffer)).toBe(2);
    expect(readContacts).toHaveBeenCalledWith(0, ids, buffer);
    native.setColliderShape?.(
      surface.collider,
      CollisionShape3D.heightfield(2, 2, new Float32Array(4), { x: 1, y: 1, z: 1 }).descriptor,
    );
    expect(setColliderShape.mock.calls[0]?.[1]).toMatchObject({ kind: "heightfield" });
    expect(() =>
      native.setColliderShape?.(surface.collider, CollisionShape3D.sphere(1).descriptor),
    ).toThrow(/TN_NATIVE_PHYSICS_SHAPE_UNSUPPORTED/);
    expect(() => native.readContacts?.({ id: 99, raw: undefined }, ids, buffer)).toThrow(
      /not a live collider/,
    );

    const old = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    const oldSurface = old.createBody({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.sphere(1).descriptor,
      type: "fixed",
    });
    expect(() => old.readContacts?.(oldSurface.collider, ids, buffer)).toThrow(
      /TN_NATIVE_PHYSICS_CONTACTS_MISSING/,
    );
  });

  it("hands a trimesh body's vertices and indices to the native host", () => {
    const createBody = vi.fn(() => 7);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
    );
    geometry.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));

    native.createBody({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.fromMesh(new Mesh(geometry), "trimesh").descriptor,
      type: "fixed",
    });

    expect(createBody).toHaveBeenCalledWith(
      expect.objectContaining({
        shape: expect.objectContaining({
          indices: expect.any(Uint32Array),
          kind: "trimesh",
          vertices: expect.any(Float32Array),
        }),
      }),
    );
  });

  it("rejects a non-finite or negative mass before calling the host, like the web seam", () => {
    const createBody = vi.fn(() => 0);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );

    for (const mass of [Number.NaN, Number.POSITIVE_INFINITY, -5]) {
      expect(() =>
        native.createBody({
          mass,
          position: { x: 0, y: 0, z: 0 },
          rotation: { w: 1, x: 0, y: 0, z: 0 },
          sensor: false,
          shape: CollisionShape3D.sphere(0.5).descriptor,
          type: "dynamic",
        }),
      ).toThrow(/mass must be a finite non-negative number/);
    }
    expect(createBody).not.toHaveBeenCalled();
  });

  it("forwards continuous collision and its effective default to the native host", () => {
    let nextId = 0;
    const createBody = vi.fn(() => nextId++);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );

    native.createBody({ ...bodyOptions(), continuousCollision: false });
    native.createBody(bodyOptions());
    native.createBody({ ...bodyOptions("fixed"), continuousCollision: true });
    native.createBody({ ...bodyOptions("kinematic"), continuousCollision: true });

    expect(createBody).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ continuousCollision: false }),
    );
    expect(createBody).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ continuousCollision: true }),
    );
    expect(createBody).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ type: "fixed", continuousCollision: false }),
    );
    expect(createBody).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({ type: "kinematic", continuousCollision: false }),
    );
  });

  it("fails closed when syncFromPhysics hits a backend without readBodyTransform", () => {
    // Both shipped backends read transforms. The guard exists for any other simulation reaching
    // these nodes, so prove it against one that genuinely lacks the capability rather than
    // against an adapter that has it.
    const simulation = {
      configureCharacter: vi.fn(),
      createBody: vi.fn(() => ({
        body: { entity: undefined, id: 0 },
        collider: { id: 0 },
        controller: { id: 0 },
        rawShape: undefined,
      })),
      removeBody: vi.fn(),
    } as unknown as IPhysicsContext["simulation"];
    const physics = {
      add: () => {},
      addArea: () => {},
      remove: () => {},
      removeArea: () => {},
      simulation,
    } as unknown as IPhysicsContext;

    const crate = new Object3D();
    crate.position.set(1, 2, 3);
    const body = new RigidBody3D({ object: crate, physics, shape: CollisionShape3D.sphere(0.5) });
    expect(() => body.syncFromPhysics()).toThrow(/TN_PHYSICS_READ_TRANSFORM_MISSING/);
    expect(crate.position.x).toBe(1);

    const character = new CharacterBody3D({
      object: new Object3D(),
      physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
    });
    expect(() => character.syncFromPhysics()).toThrow(/TN_PHYSICS_READ_TRANSFORM_MISSING/);
  });

  it("reads one body transform on the native seam like the web seam", () => {
    // The seam only had the bulk render read, so `syncFromPhysics()` — a public method with no
    // caller inside the framework — threw on native and worked on web. That is the web-only
    // split the framework exists to prevent.
    let nextId = 0;
    const placed = new Map<number, readonly number[]>();
    const raw = {
      configureCharacter: vi.fn(),
      createBody: vi.fn(() => {
        const id = nextId;
        nextId += 1;
        placed.set(id, [id + 1, id + 2, id + 3, 0, 0, 0, 1]);
        return id;
      }),
      dispose: vi.fn(),
      drainCollisionEvents: vi.fn(() => 0),
      intersectPoint: vi.fn(() => []),
      intersectRay: vi.fn(() => null),
      intersectShape: vi.fn(() => []),
      readAreaIntersections: vi.fn(() => 0),
      readCharacterStates: vi.fn(() => 0),
      readVisibleTransforms: vi.fn((buffer: Float32Array) => {
        let index = 0;
        for (const [id, row] of placed) {
          const offset = index * PHYSICS_TRANSFORM_STRIDE;
          buffer[offset] = id;
          for (let scalar = 0; scalar < row.length; scalar += 1)
            buffer[offset + 1 + scalar] = row[scalar] as number;
          index += 1;
        }
        return index;
      }),
      removeBody: vi.fn(),
      step: vi.fn(),
    } as unknown as INativeSimulation;
    const simulation = createNativePhysicsSimulation(raw, "0.30.0");
    const physics = {
      add: () => {},
      addArea: () => {},
      remove: () => {},
      removeArea: () => {},
      simulation,
    } as unknown as IPhysicsContext;

    const first = new Object3D();
    const second = new Object3D();
    new RigidBody3D({ object: first, physics, shape: CollisionShape3D.sphere(0.5) });
    const secondBody = new RigidBody3D({
      object: second,
      physics,
      shape: CollisionShape3D.sphere(0.5),
    });

    expect(simulation.readBodyTransform?.(0)).toEqual({
      position: { x: 1, y: 2, z: 3 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
    });
    expect(simulation.readBodyTransform?.(1)?.position).toEqual({ x: 2, y: 3, z: 4 });
    expect(simulation.readBodyTransform?.(99)).toBeUndefined();

    secondBody.syncFromPhysics();
    expect(second.position.toArray()).toEqual([2, 3, 4]);

    // One bulk read per step, not one per body.
    const reads = (raw.readVisibleTransforms as unknown as { mock: { calls: unknown[] } }).mock
      .calls.length;
    simulation.readBodyTransform?.(0);
    expect(
      (raw.readVisibleTransforms as unknown as { mock: { calls: unknown[] } }).mock.calls.length,
    ).toBe(reads);

    simulation.dispose();
    expect(() => simulation.readBodyTransform?.(0)).toThrow(/disposed/);
  });

  it("requires matching sensor metadata on both adapters and keeps native raw values opaque", async () => {
    const createBody = vi.fn().mockReturnValueOnce(7).mockReturnValueOnce(8);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    const sensorShape = CollisionShape3D.capsule(0.35, 0.3).setSensor(true);
    const solidShape = CollisionShape3D.box(1, 1, 1);
    const options = (sensor: boolean, shape: CollisionShape3D) => ({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor,
      shape: shape.descriptor,
      type: "fixed" as const,
    });

    expect(() => native.createBody(options(false, sensorShape))).toThrow(
      /TN_PHYSICS_SENSOR_CONFLICT/,
    );
    expect(() => native.createBody(options(true, solidShape))).toThrow(
      /TN_PHYSICS_SENSOR_CONFLICT/,
    );
    expect(createBody).not.toHaveBeenCalled();

    native.createBody(options(false, solidShape));
    const sensorRegistration = native.createBody(options(true, sensorShape));

    expect(createBody).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sensor: false, shape: solidShape.descriptor }),
    );
    expect(createBody).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ sensor: true, shape: sensorShape.descriptor }),
    );
    expect(sensorRegistration.rawShape).not.toBe(sensorShape.descriptor);
    expect(sensorRegistration.rawShape).toEqual(
      expect.objectContaining({ backend: "native", kind: "capsule" }),
    );
    sensorShape.bindRaw(sensorRegistration.rawShape);
    expect(sensorShape.raw).toBe(sensorRegistration.rawShape);
    expect(sensorShape.raw).toEqual(
      expect.objectContaining({ backend: "native", kind: "capsule" }),
    );

    await RAPIER.init();
    const web = createWebPhysicsSimulation({
      eventQueue: new RAPIER.EventQueue(true),
      rapier: RAPIER,
      version: RAPIER.version(),
      world: new RAPIER.World({ x: 0, y: -9.81, z: 0 }),
    });
    expect(() => web.createBody(options(false, sensorShape))).toThrow(/TN_PHYSICS_SENSOR_CONFLICT/);
    expect(() => web.createBody(options(true, solidShape))).toThrow(/TN_PHYSICS_SENSOR_CONFLICT/);
    web.dispose();
  });

  it("passes a sensor shape through the shared rigid-body node", () => {
    const createBody = vi.fn().mockReturnValue(9);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    new RigidBody3D({
      object: new Object3D(),
      shape: CollisionShape3D.box(1, 1, 1).setSensor(true),
      world: native,
    });

    expect(createBody).toHaveBeenCalledWith(expect.objectContaining({ sensor: true }));
  });

  it("passes a sensor shape through the shared character node", () => {
    const createBody = vi.fn().mockReturnValue(10);
    const configureCharacter = vi.fn();
    const native = createNativePhysicsSimulation(
      { configureCharacter, createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    new CharacterBody3D({
      object: new Object3D(),
      shape: CollisionShape3D.box(1, 1, 1).setSensor(true),
      world: native,
    });

    expect(createBody).toHaveBeenCalledWith(expect.objectContaining({ sensor: true }));
    expect(configureCharacter).toHaveBeenCalledOnce();
  });

  it("reads native sleep state through one fixed-width bulk call and fails closed", () => {
    let nextId = 0;
    const readBodySleepStates = vi.fn((buffer: Float32Array) => {
      buffer.set([0, 1, 1, 0]);
      return 2;
    });
    const removeBody = vi.fn();
    const dispose = vi.fn();
    const native = createNativePhysicsSimulation(
      {
        createBody: () => nextId++,
        dispose,
        readBodySleepStates,
        removeBody,
      } as unknown as INativeSimulation,
      "0.30.0",
    );
    native.createBody(bodyOptions());
    native.createBody(bodyOptions());

    expect(() => native.readBodySleepStates(new Float32Array(3))).toThrow(
      /sleep state buffer is too small/i,
    );
    expect(readBodySleepStates).not.toHaveBeenCalled();

    const states = new Float32Array(2 * PHYSICS_SLEEP_STATE_STRIDE);
    expect(native.readBodySleepStates(states)).toBe(2);
    expect([...states]).toEqual([0, 1, 1, 0]);
    expect(readBodySleepStates).toHaveBeenCalledOnce();

    native.removeBody(0);
    readBodySleepStates.mockImplementationOnce((buffer) => {
      buffer.set([1, 0]);
      return 1;
    });
    const remaining = new Float32Array(PHYSICS_SLEEP_STATE_STRIDE);
    expect(native.readBodySleepStates(remaining)).toBe(1);
    expect([...remaining]).toEqual([1, 0]);
    expect(removeBody).toHaveBeenCalledWith(0);

    native.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => native.readBodySleepStates(new Float32Array(0))).toThrow(/disposed/i);
    expect(readBodySleepStates).toHaveBeenCalledTimes(2);
  });

  it("reports Rapier sleep state truthfully and excludes removed bodies", async () => {
    await RAPIER.init();
    const web = createWebPhysicsSimulation({
      eventQueue: new RAPIER.EventQueue(true),
      rapier: RAPIER,
      version: RAPIER.version(),
      world: new RAPIER.World({ x: 0, y: 0, z: 0 }),
    });
    const sleeping = web.createBody(bodyOptions());
    web.createBody(bodyOptions());
    (sleeping.body.raw as RAPIER.RigidBody).sleep();

    expect(() => web.readBodySleepStates(new Float32Array(3))).toThrow(
      /sleep state buffer is too small/i,
    );
    const states = new Float32Array(2 * PHYSICS_SLEEP_STATE_STRIDE);
    expect(web.readBodySleepStates(states)).toBe(2);
    expect([...states]).toEqual([0, 1, 1, 0]);

    web.removeBody(0);
    const remaining = new Float32Array(PHYSICS_SLEEP_STATE_STRIDE);
    expect(web.readBodySleepStates(remaining)).toBe(1);
    expect([...remaining]).toEqual([1, 0]);

    web.dispose();
    expect(() => web.readBodySleepStates(new Float32Array(0))).toThrow(/disposed/i);
  });

  it("rejects oversized maxResults before reaching native allocations", () => {
    const intersectShape = vi.fn(() => []);
    const intersectPoint = vi.fn(() => []);
    const native = createNativePhysicsSimulation(
      { intersectPoint, intersectShape } as unknown as INativeSimulation,
      "0.30.0",
    );
    const shape = CollisionShape3D.sphere(1).descriptor;
    const oversized = 2 ** 32;

    expect(
      native.intersectShape({
        collisionMask: 1,
        maxResults: MAX_PHYSICS_QUERY_RESULTS,
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        shape,
      }),
    ).toEqual([]);
    expect(
      native.intersectPoint({
        collisionMask: 1,
        maxResults: MAX_PHYSICS_QUERY_RESULTS,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual([]);
    expect(() =>
      native.intersectShape({
        collisionMask: 1,
        maxResults: oversized,
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        shape,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      native.intersectPoint({
        collisionMask: 1,
        maxResults: oversized,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/maxResults/);
    expect(intersectShape).toHaveBeenCalledTimes(1);
    expect(intersectPoint).toHaveBeenCalledTimes(1);
  });

  it("maps native query records through the shared simulation boundary", () => {
    const raw = {
      createBody: vi.fn().mockReturnValue(0),
      intersectPoint: vi.fn().mockReturnValue([{ bodyId: 0, position: { x: 1, y: 2, z: 3 } }]),
      intersectRay: vi.fn().mockReturnValue({
        bodyId: 0,
        distance: 3.5,
        normal: { x: -1, y: 0, z: 0 },
        position: { x: 3.5, y: 0, z: 0 },
      }),
      intersectShape: vi.fn().mockReturnValue([{ bodyId: 0, position: { x: 1, y: 2, z: 3 } }]),
    };
    const native = createNativePhysicsSimulation(raw as unknown as INativeSimulation, "0.30.0");
    const shape = CollisionShape3D.sphere(1);
    const registration = native.createBody({
      entity: "player",
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: shape.descriptor,
      type: "fixed",
    });

    expect(
      native.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 10, y: 0, z: 0 },
      }),
    ).toEqual(
      expect.objectContaining({
        body: expect.objectContaining({ entity: "player", id: registration.body.id }),
        distance: 3.5,
        normal: { x: -1, y: 0, z: 0 },
        position: { x: 3.5, y: 0, z: 0 },
      }),
    );
    expect(
      native.intersectShape({
        collisionMask: 1,
        maxResults: 16,
        position: { x: 0, y: 0, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        shape: shape.descriptor,
      })[0]?.entity,
    ).toBe("player");
    expect(
      native.intersectPoint({
        collisionMask: 1,
        maxResults: 16,
        position: { x: 0, y: 0, z: 0 },
      })[0]?.body.id,
    ).toBe(0);
  });

  it("keeps the old-runtime actuation guard removal-sensitive", () => {
    const native = createNativePhysicsSimulation({} as unknown as INativeSimulation, "0.30.0");
    const vector = { x: 1, y: 0, z: 0 };

    expect(() => native.applyBodyImpulse(0, vector)).toThrow(/TN_NATIVE_PHYSICS_ACTUATION_MISSING/);
    expect(() => native.applyBodyForce(0, vector)).toThrow(/TN_NATIVE_PHYSICS_ACTUATION_MISSING/);
    expect(() => native.applyBodyForceAtPoint(0, vector, vector)).toThrow(
      /TN_NATIVE_PHYSICS_ACTUATION_MISSING/,
    );
    expect(() => native.setBodyLinearVelocity(0, vector)).toThrow(
      /TN_NATIVE_PHYSICS_ACTUATION_MISSING/,
    );
    expect(() => native.readBodyLinearVelocity(0)).toThrow(/TN_NATIVE_PHYSICS_ACTUATION_MISSING/);
  });

  it("forwards native actuation and refuses malformed or disposed calls", () => {
    const applyBodyImpulse = vi.fn();
    const applyBodyForce = vi.fn();
    const applyBodyForceAtPoint = vi.fn();
    const setBodyLinearVelocity = vi.fn();
    const readBodyLinearVelocity = vi.fn(() => ({ x: 4, y: 0, z: 0 }));
    const dispose = vi.fn();
    const native = createNativePhysicsSimulation(
      {
        applyBodyForce,
        applyBodyForceAtPoint,
        applyBodyImpulse,
        dispose,
        readBodyLinearVelocity,
        setBodyLinearVelocity,
      } as unknown as INativeSimulation,
      "0.30.0",
    );

    native.applyBodyImpulse(7, { x: 1, y: 2, z: 3 });
    native.applyBodyForce(7, { x: 4, y: 5, z: 6 });
    native.applyBodyForceAtPoint(7, { x: 10, y: 11, z: 12 }, { x: 13, y: 14, z: 15 });
    native.setBodyLinearVelocity(7, { x: 7, y: 8, z: 9 });

    expect(applyBodyImpulse).toHaveBeenCalledWith(7, { x: 1, y: 2, z: 3 });
    expect(applyBodyForce).toHaveBeenCalledWith(7, { x: 4, y: 5, z: 6 });
    expect(applyBodyForceAtPoint).toHaveBeenCalledWith(
      7,
      { x: 10, y: 11, z: 12 },
      { x: 13, y: 14, z: 15 },
    );
    expect(setBodyLinearVelocity).toHaveBeenCalledWith(7, { x: 7, y: 8, z: 9 });
    expect(native.readBodyLinearVelocity(7)).toEqual({ x: 4, y: 0, z: 0 });

    expect(() => native.applyBodyImpulse(7, { x: Number.NaN, y: 0, z: 0 })).toThrow(
      /TN_PHYSICS_NON_FINITE/,
    );
    expect(applyBodyImpulse).toHaveBeenCalledTimes(1);

    native.dispose();
    expect(dispose).toHaveBeenCalledOnce();
    expect(() => native.applyBodyForce(7, { x: 1, y: 0, z: 0 })).toThrow(/disposed/i);
    expect(() => native.readBodyLinearVelocity(7)).toThrow(/disposed/i);
  });

  it("rejects non-finite or zero-length body placement at both seams before the backend", async () => {
    // Impulse, force, and velocity already reject non-finite values at this seam;
    // createBody did not, so a NaN spawn position reached Rapier and surfaced
    // frames later as a body that silently vanished. A zero-length quaternion on
    // a kinematic input normalizes to NaN inside Rapier for the same reason.
    await RAPIER.init();
    const web = createWebPhysicsSimulation({
      eventQueue: new RAPIER.EventQueue(true),
      rapier: RAPIER,
      version: RAPIER.version(),
      world: new RAPIER.World({ x: 0, y: -9.81, z: 0 }),
    });
    expect(() =>
      web.createBody({ ...bodyOptions(), position: { x: Number.NaN, y: 0, z: 0 } }),
    ).toThrow(/TN_PHYSICS_NON_FINITE.*position/u);
    expect(() =>
      web.createBody({ ...bodyOptions(), rotation: { w: 0, x: 0, y: 0, z: 0 } }),
    ).toThrow(/TN_PHYSICS_INVALID.*rotation/u);
    web.dispose();

    const createBody = vi.fn(() => 1);
    const native = createNativePhysicsSimulation(
      { createBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    expect(() =>
      native.createBody({
        ...bodyOptions(),
        position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
      }),
    ).toThrow(/TN_PHYSICS_NON_FINITE.*position/u);
    expect(() =>
      native.createBody({ ...bodyOptions(), rotation: { w: 0, x: 0, y: 0, z: 0 } }),
    ).toThrow(/TN_PHYSICS_INVALID.*rotation/u);
    expect(createBody).not.toHaveBeenCalled();
  });

  it("refuses body creation and removal on a disposed native adapter like the web adapter", () => {
    // Every other native-adapter entry point guards with requireLive(); createBody
    // and removeBody let calls through after dispose(), so teardown ordering that
    // the web backend rejects with a clean throw reached the native host past its
    // lifetime instead — one bug, two platforms, two different outcomes.
    const createBody = vi.fn(() => 1);
    const removeBody = vi.fn();
    const native = createNativePhysicsSimulation(
      { createBody, dispose: vi.fn(), removeBody } as unknown as INativeSimulation,
      "0.30.0",
    );
    native.dispose();

    expect(() => native.createBody(bodyOptions())).toThrow(/disposed/i);
    expect(() => native.removeBody(1)).toThrow(/disposed/i);
    expect(createBody).not.toHaveBeenCalled();
    expect(removeBody).not.toHaveBeenCalled();
  });

  const frontLeft: IPhysicsVehicleWheelOptions = {
    dampingCompression: 2.3,
    dampingRelaxation: 4.4,
    maxSuspensionTravel: 0.3,
    position: { x: -0.8, y: -0.15, z: -1.2 },
    suspensionRestLength: 0.3,
    suspensionStiffness: 100,
    useAsSteering: true,
    useAsTraction: false,
    wheelFrictionSlip: 10.5,
    wheelRadius: 0.34,
  };

  const vehicleWheels = [frontLeft];

  const vehicleOptions = {
    axle: { x: 1, y: 0, z: 0 },
    bodyId: 0,
    forwardAxis: 2 as const,
    wheels: vehicleWheels,
  };

  it("hands a vehicle's wheels to the native host as one flat record per wheel", () => {
    let nextId = 0;
    const createVehicle = vi.fn((_options: { wheels: Float32Array }) => 3);
    const native = createNativePhysicsSimulation(
      { createBody: () => nextId++, createVehicle } as unknown as INativeSimulation,
      "0.30.0",
    );
    native.createBody(bodyOptions());
    native.createBody(bodyOptions());

    expect(native.createVehicle?.(vehicleOptions)).toBe(3);
    const options = createVehicle.mock.calls[0]?.[0];
    // The ABI is f32 on the wire, so the record is exactly the source numbers rounded once.
    expect([...(options?.wheels ?? [])]).toEqual(
      [-0.8, -0.15, -1.2, 0.34, 0.3, 100, 2.3, 4.4, 10.5, 0.3, 1, 0].map(Math.fround),
    );

    // Rapier's own default travel is sent when the game leaves it unset, so "absent" cannot
    // drift into a different strut length on the native build.
    native.createVehicle?.({
      ...vehicleOptions,
      bodyId: 1,
      wheels: [{ ...frontLeft, maxSuspensionTravel: undefined }],
    });
    const defaulted = createVehicle.mock.calls[1]?.[0]?.wheels;
    expect(defaulted?.[9]).toBe(5);
  });

  it("refuses a vehicle the native backend cannot drive, by name", () => {
    const createVehicle = vi.fn(() => 0);
    const native = createNativePhysicsSimulation(
      { createBody: () => 0, createVehicle } as unknown as INativeSimulation,
      "0.30.0",
    );
    native.createBody(bodyOptions("fixed"));

    expect(() => native.createVehicle?.({ ...vehicleOptions, bodyId: 9 })).toThrow(
      /TN_PHYSICS_UNKNOWN_BODY/,
    );
    expect(() => native.createVehicle?.({ ...vehicleOptions, bodyId: 0 })).toThrow(
      /TN_PHYSICS_NOT_DYNAMIC/,
    );
    expect(() => native.createVehicle?.({ ...vehicleOptions, wheels: [] })).toThrow(
      /TN_VEHICLE_INVALID: a vehicle needs at least one wheel/,
    );
    expect(() => native.createVehicle?.({ ...vehicleOptions, forwardAxis: 1 as never })).toThrow(
      /TN_VEHICLE_INVALID: forwardAxis/,
    );
    // The old-runtime guard stays: a host built before vehicles must say so, not drive nothing.
    const old = createNativePhysicsSimulation(
      { createBody: () => 0 } as unknown as INativeSimulation,
      "old-runtime",
    );
    old.createBody(bodyOptions());
    expect(() => old.createVehicle?.(vehicleOptions)).toThrow(/TN_NATIVE_PHYSICS_VEHICLE_MISSING/);
    expect(() => old.setVehicleInput?.(0, { brake: 0, engineForce: 0, steering: 0 })).toThrow(
      /TN_NATIVE_PHYSICS_VEHICLE_MISSING/,
    );
    expect(() => old.resetVehicle?.(0, { x: 0, y: 0, z: 0 }, 0)).toThrow(
      /TN_NATIVE_PHYSICS_VEHICLE_MISSING/,
    );
  });

  it("reads one vehicle state through the shared stride and drops it with the chassis", () => {
    const readVehicleState = vi.fn((_id: number, output: Float32Array) => {
      // Speed, then one three-float record per wheel: contact, suspension length, rotation.
      output.set([12.5, 1, 0.2769, 0.5]);
      return output.length;
    });
    const setVehicleInput = vi.fn();
    const resetVehicle = vi.fn();
    const native = createNativePhysicsSimulation(
      {
        createBody: () => 0,
        createVehicle: () => 4,
        readVehicleState,
        removeBody: vi.fn(),
        resetVehicle,
        setVehicleInput,
      } as unknown as INativeSimulation,
      "0.30.0",
    );
    native.createBody(bodyOptions());
    const id = native.createVehicle?.(vehicleOptions) as number;

    native.setVehicleInput?.(id, { brake: 60, engineForce: 4000, steering: 0.5 });
    expect(setVehicleInput).toHaveBeenCalledWith(id, {
      brake: 60,
      engineForce: 4000,
      steering: 0.5,
    });
    const state = native.readVehicleState?.(id);
    expect(state?.speed).toBe(12.5);
    expect([...(state?.wheels ?? [])]).toEqual([1, 0.2769, 0.5].map(Math.fround));
    expect(() =>
      native.setVehicleInput?.(id, { brake: Number.NaN, engineForce: 0, steering: 0 }),
    ).toThrow(/TN_PHYSICS_NON_FINITE/);
    expect(() => native.readVehicleState?.(9)).toThrow(/TN_VEHICLE_UNKNOWN/);
    expect(() => native.resetVehicle?.(9, { x: 0, y: 0, z: 0 }, 0)).toThrow(/TN_VEHICLE_UNKNOWN/);

    native.resetVehicle?.(id, { x: 1, y: 2, z: 3 }, Math.PI);
    expect(resetVehicle).toHaveBeenCalledWith(id, { x: 1, y: 2, z: 3 }, Math.PI);

    // The chassis owns the wheels: a removed car is a car that is gone.
    native.removeBody(0);
    expect(() => native.readVehicleState?.(id)).toThrow(/TN_VEHICLE_UNKNOWN/);
  });

  // The record is sized from the wheel count, so anything other than all of it is a broken read.
  // A one-wheel write into a four-wheel record used to pass and hand the game three stale wheels.
  it("refuses a vehicle state that does not fill the wheel record", () => {
    const withCount = (count: number, written = 4) =>
      createNativePhysicsSimulation(
        {
          createBody: () => 0,
          createVehicle: () => 4,
          readVehicleState: (_id: number, output: Float32Array) => {
            output.fill(0, 0, Math.min(written, output.length));
            return count;
          },
        } as unknown as INativeSimulation,
        "0.30.0",
      );

    const fourWheeler = (count: number) => {
      const native = withCount(count);
      native.createBody(bodyOptions());
      const id = native.createVehicle?.({
        ...vehicleOptions,
        wheels: [frontLeft, frontLeft, frontLeft, frontLeft],
      }) as number;
      return { native, id };
    };

    for (const count of [1, 2, 3, 5, 12]) {
      const { native, id } = fourWheeler(count);
      expect(() => native.readVehicleState?.(id)).toThrow(/TN_VEHICLE_STATE_SHORT/);
    }

    // The guard has to be "exactly the record", not "at least the record" and not "at most it":
    // one float over means the ABI grew a field, and accepting it would read this car's wheels
    // out of a record shaped for a different vehicle.
    for (const count of [14, 26]) {
      const { native, id } = fourWheeler(count);
      expect(() => native.readVehicleState?.(id)).toThrow(/TN_VEHICLE_STATE_SHORT/);
    }

    // 13 is the one honest answer for four wheels: one speed float plus three per wheel.
    const exact = fourWheeler(13);
    expect(() => exact.native.readVehicleState?.(exact.id)).not.toThrow();

    // -1 is the runtime's own "unknown vehicle or short buffer", which stays TN_VEHICLE_UNKNOWN.
    const gone = withCount(-1);
    gone.createBody(bodyOptions());
    const goneId = gone.createVehicle?.(vehicleOptions) as number;
    expect(() => gone.readVehicleState?.(goneId)).toThrow(/TN_VEHICLE_UNKNOWN/);
  });

  it("returns decoded hit for native numeric ray query and rejects invalid codes", () => {
    const rayOutputMock = (bodyId: number, status = 1, dist = 5) => {
      return vi.fn((_query: unknown, out: Float32Array) => {
        out[0] = bodyId;
        out[1] = 1;
        out[2] = 2;
        out[3] = 3; // pos
        out[4] = 0;
        out[5] = 1;
        out[6] = 0; // normal
        out[7] = dist; // dist
        return status;
      });
    };

    // Status 1 with valid body id -> decoded hit returned
    const rawSuccess = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: rayOutputMock(0, 1, 4.5),
    };
    const nativeSuccess = createNativePhysicsSimulation(
      rawSuccess as unknown as INativeSimulation,
      "0.30.0",
    );
    nativeSuccess.createBody({ ...bodyOptions(), entity: "target" });
    const hit = nativeSuccess.intersectRay({
      collisionMask: 1,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 0, y: 10, z: 0 },
    });
    expect(hit).toBeDefined();
    expect(hit?.distance).toBe(4.5);
    expect(hit?.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(hit?.position).toEqual({ x: 1, y: 2, z: 3 });
    expect(hit?.body.entity).toBe("target");

    // Status 0 -> miss (returns undefined)
    const rawMiss = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: vi.fn().mockReturnValue(0),
    };
    const nativeMiss = createNativePhysicsSimulation(
      rawMiss as unknown as INativeSimulation,
      "0.30.0",
    );
    expect(
      nativeMiss.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 10, z: 0 },
      }),
    ).toBeUndefined();

    // Status 2 -> TN_NATIVE_PHYSICS_INVALID: ray query returned an invalid status
    const rawInvalidStatus = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: vi.fn().mockReturnValue(2),
    };
    const nativeInvalidStatus = createNativePhysicsSimulation(
      rawInvalidStatus as unknown as INativeSimulation,
      "0.30.0",
    );
    expect(() =>
      nativeInvalidStatus.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 10, z: 0 },
      }),
    ).toThrow(/TN_NATIVE_PHYSICS_INVALID: ray query returned an invalid status/);

    // Invalid bodyId (< 0 or NaN) in output -> TN_NATIVE_PHYSICS_INVALID: ray output is malformed
    const rawBadBody = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: rayOutputMock(-1, 1),
    };
    const nativeBadBody = createNativePhysicsSimulation(
      rawBadBody as unknown as INativeSimulation,
      "0.30.0",
    );
    expect(() =>
      nativeBadBody.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 10, z: 0 },
      }),
    ).toThrow(/TN_NATIVE_PHYSICS_INVALID: ray output is malformed/);

    // Negative distance in output -> TN_NATIVE_PHYSICS_INVALID: ray output distance is invalid
    const rawBadDist = {
      createBody: vi.fn().mockReturnValue(0),
      intersectRay: rayOutputMock(0, 1, -1),
    };
    const nativeBadDist = createNativePhysicsSimulation(
      rawBadDist as unknown as INativeSimulation,
      "0.30.0",
    );
    nativeBadDist.createBody(bodyOptions());
    expect(() =>
      nativeBadDist.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 10, z: 0 },
      }),
    ).toThrow(/TN_NATIVE_PHYSICS_INVALID: ray output distance is invalid/);
  });
});
