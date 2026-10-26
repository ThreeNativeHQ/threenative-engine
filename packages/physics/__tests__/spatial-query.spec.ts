import * as RAPIER from "@dimforge/rapier3d-compat";
import { beforeAll, describe, expect, it } from "vitest";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { PhysicsDirectSpaceState3D } from "../src/PhysicsDirectSpaceState3D.js";
import { MAX_PHYSICS_QUERY_RESULTS, createWebPhysicsSimulation } from "../src/simulation.js";

beforeAll(async () => {
  await RAPIER.init();
});

function createSimulation() {
  return createWebPhysicsSimulation({
    eventQueue: new RAPIER.EventQueue(true),
    rapier: RAPIER,
    version: RAPIER.version(),
    world: new RAPIER.World({ x: 0, y: 0, z: 0 }),
  });
}

function addBox(
  simulation: ReturnType<typeof createSimulation>,
  position: { readonly x: number; readonly y: number; readonly z: number },
  collisionLayer = 1,
  entity?: string,
): number {
  const shape = CollisionShape3D.box(1, 1, 1).setCollisionGroups((collisionLayer << 16) | 0xffff);
  return simulation.createBody({
    entity,
    mass: 0,
    position,
    rotation: { w: 1, x: 0, y: 0, z: 0 },
    sensor: false,
    shape: shape.descriptor,
    type: "fixed",
  }).body.id;
}

describe("PhysicsDirectSpaceState3D", () => {
  it("returns numeric ray data and honors masks and result bounds", () => {
    const simulation = createSimulation();
    const targetId = addBox(simulation, { x: 4, y: 0, z: 0 }, 1, "player");
    addBox(simulation, { x: 6, y: 0, z: 0 }, 2, "masked");
    for (let index = 0; index < 20; index += 1) addBox(simulation, { x: index, y: 10, z: 0 });
    simulation.step(1 / 60);
    const space = new PhysicsDirectSpaceState3D(simulation);

    const hit = space.intersectRay({
      collisionMask: 1,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 10, y: 0, z: 0 },
    });
    expect(hit?.body.id).toBe(targetId);
    expect(hit?.distance).toBeCloseTo(3.5, 6);
    expect(hit?.normal.x).toBeCloseTo(-1, 6);
    expect(hit?.normal.y).toBeCloseTo(0, 6);
    expect(hit?.normal.z).toBeCloseTo(0, 6);
    expect(hit?.position.x).toBeCloseTo(3.5, 6);
    expect(hit?.entity).toBe("player");

    expect(
      space.intersectRay({
        collisionMask: 1,
        from: { x: 0, y: 20, z: 0 },
        to: { x: 10, y: 20, z: 0 },
      }),
    ).toBeUndefined();
    expect(
      space.intersectRay({
        collisionMask: 1,
        from: { x: 5.5, y: 0, z: 0 },
        to: { x: 7, y: 0, z: 0 },
      }),
    ).toBeUndefined();

    const shapeHits = space.intersectShape({
      collisionMask: 1,
      maxResults: 16,
      position: { x: 0, y: 0, z: 0 },
      shape: CollisionShape3D.sphere(50),
    });
    expect(shapeHits).toHaveLength(16);
    expect(space.intersectPoint({ position: { x: 4, y: 0, z: 0 } })).toHaveLength(1);
    expect(
      space.intersectShape({
        collisionMask: 1,
        position: { x: 100, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(0.5),
      }),
    ).toHaveLength(0);
    expect(
      space.intersectShape({
        collisionMask: 2,
        position: { x: 4, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(0.5),
      }),
    ).toHaveLength(0);
    expect(
      space.intersectPoint({
        collisionMask: 1,
        position: { x: 100, y: 0, z: 0 },
      }),
    ).toHaveLength(0);
    expect(
      space.intersectPoint({
        collisionMask: 2,
        position: { x: 4, y: 0, z: 0 },
      }),
    ).toHaveLength(0);
    simulation.dispose();
  });

  it("accepts a nonzero ray whose f32 norm would underflow", () => {
    const simulation = createSimulation();
    const targetId = addBox(simulation, { x: 0, y: 0, z: 0 });
    simulation.step(1 / 60);
    const space = new PhysicsDirectSpaceState3D(simulation);
    const shortLength = 1e-30;
    const hit = space.intersectRay({
      from: { x: 0, y: 0, z: 0 },
      hitFromInside: true,
      to: { x: shortLength, y: 0, z: 0 },
    });

    expect(shortLength).toBeGreaterThan(0);
    expect(hit?.body.id).toBe(targetId);
    simulation.dispose();
  });

  it("raycasts an attached collider at its new pose immediately after teleport", () => {
    const simulation = createSimulation();
    const bodyId = addBox(simulation, { x: -4, y: 0, z: 0 });
    simulation.step(1 / 60);
    simulation.setBodyTransform(bodyId, { x: 4, y: 0, z: 0 });
    const hit = new PhysicsDirectSpaceState3D(simulation).intersectRay({
      collisionMask: 1,
      from: { x: -10, y: 0, z: 0 },
      to: { x: 10, y: 0, z: 0 },
    });

    expect(hit?.body.id).toBe(bodyId);
    expect(hit?.distance).toBeCloseTo(13.5, 6);
    expect(hit?.position.x).toBeCloseTo(3.5, 6);
    simulation.dispose();
  });

  it("intersects an attached collider at its new point pose immediately after teleport", () => {
    const simulation = createSimulation();
    const bodyId = addBox(simulation, { x: -4, y: 0, z: 0 });
    simulation.step(1 / 60);
    const space = new PhysicsDirectSpaceState3D(simulation);

    expect(
      space.intersectPoint({ collisionMask: 1, position: { x: -4, y: 0, z: 0 } }),
    ).toHaveLength(1);
    simulation.setBodyTransform(bodyId, { x: 4, y: 0, z: 0 });
    expect(
      space.intersectPoint({ collisionMask: 1, position: { x: -4, y: 0, z: 0 } }),
    ).toHaveLength(0);
    const hits = space.intersectPoint({ collisionMask: 1, position: { x: 4, y: 0, z: 0 } });

    expect(hits).toHaveLength(1);
    expect(hits[0]?.body.id).toBe(bodyId);
    simulation.dispose();
  });

  it("queries a body created after the previous step before the next step", () => {
    const simulation = createSimulation();
    addBox(simulation, { x: 0, y: 10, z: 0 });
    simulation.step(1 / 60);
    const bodyId = addBox(simulation, { x: 4, y: 0, z: 0 }, 1, "created");
    const space = new PhysicsDirectSpaceState3D(simulation);

    expect(
      space.intersectPoint({
        collisionMask: 1,
        maxResults: 1,
        position: { x: 4, y: 0, z: 0 },
      }),
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ id: bodyId }),
        entity: "created",
      }),
    ]);
    expect(
      space.intersectShape({
        collisionMask: 1,
        maxResults: 1,
        position: { x: 4, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(0.5),
      }),
    ).toEqual([
      expect.objectContaining({
        body: expect.objectContaining({ id: bodyId }),
        entity: "created",
      }),
    ]);
    const rayHit = space.intersectRay({
      collisionMask: 1,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 10, y: 0, z: 0 },
    });
    expect(rayHit?.body.id).toBe(bodyId);
    expect(rayHit?.entity).toBe("created");
    simulation.dispose();
  });

  it("enforces the safe native-compatible maxResults boundary", () => {
    const simulation = createSimulation();
    const space = new PhysicsDirectSpaceState3D(simulation);
    const shape = CollisionShape3D.sphere(1);
    const oversized = 2 ** 32;

    expect(
      space.intersectShape({
        maxResults: MAX_PHYSICS_QUERY_RESULTS,
        position: { x: 0, y: 0, z: 0 },
        shape,
      }),
    ).toEqual([]);
    expect(
      space.intersectPoint({
        maxResults: MAX_PHYSICS_QUERY_RESULTS,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toEqual([]);
    expect(() =>
      space.intersectShape({
        maxResults: oversized,
        position: { x: 0, y: 0, z: 0 },
        shape,
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      space.intersectPoint({
        maxResults: oversized,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/maxResults/);
    simulation.dispose();
  });

  it("has exactly the three Godot-named query methods and rejects malformed inputs", () => {
    const simulation = createSimulation();
    const space = new PhysicsDirectSpaceState3D(simulation);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(space)).sort()).toEqual([
      "constructor",
      "intersectPoint",
      "intersectRay",
      "intersectShape",
    ]);

    expect(() =>
      space.intersectRay({
        from: { x: 0, y: 0, z: 0 },
        to: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/non-zero length/);
    expect(() =>
      space.intersectRay({
        from: { x: Number.NaN, y: 0, z: 0 },
        to: { x: 1, y: 0, z: 0 },
      }),
    ).toThrow(/finite/);
    expect(() =>
      space.intersectRay({
        collisionMask: 0x1_0000,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 1, y: 0, z: 0 },
      }),
    ).toThrow(/collisionMask/);
    expect(() =>
      space.intersectRay({
        collisionMask: null as never,
        from: { x: 0, y: 0, z: 0 },
        to: { x: 1, y: 0, z: 0 },
      }),
    ).toThrow(/collisionMask/);
    expect(() =>
      space.intersectShape({
        position: { x: 0, y: 0, z: 0 },
        shape: {} as never,
      }),
    ).toThrow(/CollisionShape3D/);
    expect(() =>
      space.intersectShape({
        maxResults: 0,
        position: { x: 0, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(1),
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      space.intersectShape({
        maxResults: null as never,
        position: { x: 0, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(1),
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      space.intersectShape({
        rotation: null as never,
        position: { x: 0, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(1),
      }),
    ).toThrow(/shape rotation/);
    expect(() =>
      space.intersectShape({
        collisionMask: null as never,
        position: { x: 0, y: 0, z: 0 },
        shape: CollisionShape3D.sphere(1),
      }),
    ).toThrow(/collisionMask/);
    expect(() =>
      space.intersectPoint({
        maxResults: 0,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      space.intersectPoint({
        maxResults: null as never,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/maxResults/);
    expect(() =>
      space.intersectPoint({
        collisionMask: null as never,
        position: { x: 0, y: 0, z: 0 },
      }),
    ).toThrow(/collisionMask/);
    simulation.dispose();
  });

  describe("a ray that starts inside a solid", () => {
    const from = { x: 0, y: 0, z: 0 };
    const to = { x: 10, y: 0, z: 0 };

    it("ignores that solid by default and reports the next real hit", () => {
      const simulation = createSimulation();
      addBox(simulation, { x: 0, y: 0, z: 0 });
      const farId = addBox(simulation, { x: 5, y: 0, z: 0 });
      simulation.step(1 / 60);
      const hit = new PhysicsDirectSpaceState3D(simulation).intersectRay({ from, to });

      expect(hit?.body.id).toBe(farId);
      expect(hit?.distance).toBeCloseTo(4.5, 6);
      expect(hit?.normal).toEqual({ x: -1, y: 0, z: 0 });
      simulation.dispose();
    });

    it("reports no hit by default when nothing else is in the way", () => {
      const simulation = createSimulation();
      addBox(simulation, { x: 0, y: 0, z: 0 });
      simulation.step(1 / 60);

      expect(new PhysicsDirectSpaceState3D(simulation).intersectRay({ from, to })).toBeUndefined();
      simulation.dispose();
    });

    it("returns the distance 0 hit with a zero normal when hitFromInside is true", () => {
      const simulation = createSimulation();
      const insideId = addBox(simulation, { x: 0, y: 0, z: 0 });
      simulation.step(1 / 60);
      const hit = new PhysicsDirectSpaceState3D(simulation).intersectRay({
        from,
        hitFromInside: true,
        to,
      });

      expect(hit?.body.id).toBe(insideId);
      expect(hit?.distance).toBe(0);
      expect(hit?.normal).toEqual({ x: 0, y: 0, z: 0 });
      simulation.dispose();
    });

    it("ignores a body teleported around the ray start by default", () => {
      const simulation = createSimulation();
      const movedId = addBox(simulation, { x: -20, y: 0, z: 0 });
      simulation.step(1 / 60);
      simulation.setBodyTransform(movedId, { x: 0, y: 0, z: 0 });
      const space = new PhysicsDirectSpaceState3D(simulation);

      expect(space.intersectRay({ from, to })).toBeUndefined();
      expect(space.intersectRay({ from, hitFromInside: true, to })?.body.id).toBe(movedId);
      simulation.dispose();
    });
  });
});
