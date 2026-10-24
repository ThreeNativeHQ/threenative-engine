import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { BoxGeometry, Mesh } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CharacterBody3D } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";
import { createWebPhysicsSimulation } from "../src/simulation.js";

const worlds: RAPIER.World[] = [];
const plugins: Array<ReturnType<typeof rapier>> = [];

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

function world(): RAPIER.World {
  const instance = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  worlds.push(instance);
  return instance;
}

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

afterEach(() => {
  for (const plugin of plugins.splice(0))
    plugin.dispose?.({} as ICtx<Record<string, unknown>, IPhysicsContext>);
  for (const instance of worlds.splice(0)) instance.free();
});

describe("explicit body mass", () => {
  it("should be the body's total mass, not an addition to the collider's", async () => {
    await RAPIER.init();
    const instance = world();
    const simulation = createWebPhysicsSimulation({
      eventQueue: new RAPIER.EventQueue(true),
      rapier: RAPIER,
      version: RAPIER.version(),
      world: instance,
    });
    const created = simulation.createBody({
      mass: 2,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.box(1, 1, 1).descriptor,
      type: "dynamic",
    });
    const raw = created.body.raw as RAPIER.RigidBody;

    expect(raw.mass()).toBeCloseTo(2, 5);
    raw.applyImpulse({ x: 2, y: 0, z: 0 }, true);
    instance.step();
    expect(raw.linvel().x).toBeCloseTo(1, 4);
  });

  it("should keep automatic collider mass when the mass is zero", async () => {
    await RAPIER.init();
    const instance = world();
    const simulation = createWebPhysicsSimulation({
      eventQueue: new RAPIER.EventQueue(true),
      rapier: RAPIER,
      version: RAPIER.version(),
      world: instance,
    });
    const created = simulation.createBody({
      mass: 0,
      position: { x: 0, y: 0, z: 0 },
      rotation: { w: 1, x: 0, y: 0, z: 0 },
      sensor: false,
      shape: CollisionShape3D.sphere(1).descriptor,
      type: "dynamic",
    });

    expect((created.body.raw as RAPIER.RigidBody).mass()).toBeCloseTo((4 / 3) * Math.PI, 2);
  });
});

describe("RigidBody3D", () => {
  it("should move the mesh downward when the body falls", async () => {
    await RAPIER.init();
    const instance = world();
    const mesh = new Mesh(new BoxGeometry(1, 1, 1));
    mesh.position.y = 5;
    const body = new RigidBody3D({
      object: mesh,
      shape: CollisionShape3D.fromMesh(mesh),
      world: instance,
    });

    for (let step = 0; step < 60; step++) {
      instance.step();
      body.syncFromPhysics();
    }

    const drop = 5 - mesh.position.y;
    expect(drop).toBeGreaterThan(4.5);
    expect(drop).toBeLessThan(5.2);
  });

  it("should rest on a fixed floor rather than pass through", async () => {
    await RAPIER.init();
    const instance = world();
    const floorMesh = new Mesh(new BoxGeometry(4, 0.2, 4));
    const floor = new RigidBody3D({
      object: floorMesh,
      shape: CollisionShape3D.fromMesh(floorMesh),
      type: "fixed",
      world: instance,
    });
    const crateMesh = new Mesh(new BoxGeometry(4, 4, 4));
    crateMesh.position.y = 8;
    const crate = new RigidBody3D({
      object: crateMesh,
      shape: CollisionShape3D.fromMesh(crateMesh),
      world: instance,
    });

    for (let step = 0; step < 300; step++) {
      instance.step();
      crate.syncFromPhysics();
    }

    expect(crateMesh.position.y).toBeCloseTo(2.1, 1);
    floor.dispose();
    crate.dispose();
  });

  it("should place a fixed collider from position and stop a character", async () => {
    const { ctx, plugin } = await setup();
    const wall = new RigidBody3D({
      physics: ctx.physics,
      position: { x: 2, y: 0.5, z: 0 },
      shape: CollisionShape3D.box(1, 1, 1),
      type: "fixed",
    });
    const characterMesh = new Mesh(new BoxGeometry(0.6, 1, 0.6));
    characterMesh.position.set(0, 0.5, 0);
    const character = new CharacterBody3D({
      physics: ctx.physics,
      shape: CollisionShape3D.capsule(0.2, 0.3),
      object: characterMesh,
      gravity: 0,
    });

    for (let step = 0; step < 120; step += 1) {
      character.move({ x: 2 / 60, y: 0, z: 0 });
      plugin.update?.(ctx, 1 / 60);
    }

    expect(wall.object).toBeUndefined();
    expect((wall.body.raw as RAPIER.RigidBody).translation()).toEqual({ x: 2, y: 0.5, z: 0 });
    expect(characterMesh.position.x).toBeGreaterThan(0.9);
    expect(characterMesh.position.x).toBeLessThan(1.6);
    character.dispose();
    wall.dispose();
  });

  it("should throw when both or neither placement source is supplied", async () => {
    await RAPIER.init();
    const instance = world();
    const object = new Mesh(new BoxGeometry(1, 1, 1));

    expect(
      () =>
        new RigidBody3D({
          object,
          position: { x: 1, y: 2, z: 3 },
          shape: CollisionShape3D.box(1, 1, 1),
          type: "fixed",
          world: instance,
        }),
    ).toThrow(/either object or position/);
    expect(
      () =>
        new RigidBody3D({
          shape: CollisionShape3D.box(1, 1, 1),
          type: "fixed",
          world: instance,
        }),
    ).toThrow(/requires either object or position/);
  });

  it("should reject an invisible non-fixed body", async () => {
    await RAPIER.init();
    const instance = world();

    expect(
      () =>
        new RigidBody3D({
          position: { x: 1, y: 2, z: 3 },
          shape: CollisionShape3D.box(1, 1, 1),
          world: instance,
        }),
    ).toThrow("position-only bodies must be fixed");
  });
});
