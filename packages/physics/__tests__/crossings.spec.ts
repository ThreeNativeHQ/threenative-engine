import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { Object3D } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { PHYSICS_TRANSFORM_STRIDE } from "../src/index.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;
const plugins: Array<ReturnType<typeof rapier>> = [];

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  await RAPIER.init();
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  plugins.push(plugin);
  return { ctx, plugin };
}

afterEach(() => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.({} as PhysicsCtx);
});

function town(ctx: PhysicsCtx, count: number): RigidBody3D[] {
  return Array.from(
    { length: count },
    (_, index) =>
      new RigidBody3D({
        physics: ctx.physics,
        position: { x: index * 3, y: -0.5, z: 0 },
        shape: CollisionShape3D.box(2, 1, 2),
        type: "fixed",
      }),
  );
}

// The shooter measured 2,260 Rapier calls per step, 95% of them reading the pose of its 144 fixed
// wall colliders and clearing their forces: 15 crossings per wall per step for a value that cannot
// change. These rows hold that class at zero.
describe("Rapier crossings per step", () => {
  it("reads a fixed body's pose once, not every step, and clears forces only on dynamic bodies", async () => {
    const { ctx, plugin } = await setup();
    town(ctx, 50);
    const crate = new Object3D();
    crate.position.set(0, 4, 0);
    new RigidBody3D({ object: crate, physics: ctx.physics, shape: CollisionShape3D.box(1, 1, 1) });

    for (let tick = 0; tick < 10; tick += 1) plugin.update?.(ctx, 1 / 60);

    expect(ctx.physics.simulation.crossings).toEqual({ forceResets: 1, transformReads: 1 });
  });

  it("reports the exact pose Rapier holds for every body on every step", async () => {
    const { ctx, plugin } = await setup();
    const walls = town(ctx, 8);
    const crates = [0, 1, 2].map((index) => {
      const object = new Object3D();
      object.position.set(index * 3, 1 + index, 0);
      return new RigidBody3D({
        object,
        physics: ctx.physics,
        shape: CollisionShape3D.box(1, 1, 1),
      });
    });
    const byId = new Map([...walls, ...crates].map((body) => [body.body.id, body] as const));
    const buffer = new Float32Array(PHYSICS_TRANSFORM_STRIDE * 16);
    let slept = 0;

    // Long enough for the crates to land and fall asleep, so the cached path is the one checked.
    for (let tick = 0; tick < 600; tick += 1) {
      plugin.update?.(ctx, 1 / 60);
      const count = ctx.physics.simulation.readVisibleTransforms(buffer);
      for (let index = 0; index < count; index += 1) {
        const offset = index * PHYSICS_TRANSFORM_STRIDE;
        const raw = byId.get(buffer[offset] as number)?.body.raw as RAPIER.RigidBody;
        const t = raw.translation();
        const r = raw.rotation();
        expect([...buffer.slice(offset + 1, offset + 8)]).toEqual([
          ...new Float32Array([t.x, t.y, t.z, r.x, r.y, r.z, r.w]),
        ]);
      }
      if (crates.every((crate) => (crate.body.raw as RAPIER.RigidBody).isSleeping())) slept += 1;
    }

    expect(slept).toBeGreaterThan(0);
    expect(ctx.physics.simulation.crossings?.transformReads).toBe(0);
  });

  it("re-reads a fixed body moved by setBodyTransform and a sleeping body that wakes", async () => {
    const { ctx, plugin } = await setup();
    const wall = new Object3D();
    wall.position.set(20, 0, 0);
    const fixed = new RigidBody3D({
      object: wall,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
      type: "fixed",
    });
    const crate = new Object3D();
    crate.position.set(0, 1, 0);
    town(ctx, 1);
    const body = new RigidBody3D({
      object: crate,
      physics: ctx.physics,
      shape: CollisionShape3D.box(1, 1, 1),
    });
    for (let tick = 0; tick < 600; tick += 1) plugin.update?.(ctx, 1 / 60);
    expect((body.body.raw as RAPIER.RigidBody).isSleeping()).toBe(true);

    ctx.physics.simulation.setBodyTransform(fixed.body.id, { x: 5, y: 6, z: 7 });
    body.applyImpulse({ x: 0, y: 2, z: 0 });
    plugin.update?.(ctx, 1 / 60);

    expect(wall.position.toArray()).toEqual([5, 6, 7]);
    expect(crate.position.y).toBeGreaterThan(0.5);
    expect(ctx.physics.simulation.crossings?.transformReads).toBe(2);
    plugin.update?.(ctx, 1 / 60);
    expect(ctx.physics.simulation.crossings?.transformReads).toBe(1);
  });
});
