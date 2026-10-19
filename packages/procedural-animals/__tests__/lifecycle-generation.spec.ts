import { type Group, Scene as ThreeScene } from "three";
import { describe, expect, it, vi } from "vitest";
import { Registry } from "../../core/src/entities.js";
import { createAfterPhysicsPhase } from "../../core/src/loop.js";
import type { ICtx } from "../../core/src/scene.js";
import "../../physics/src/web.js";
import { parseAnimalBake } from "@threenative/procedural-animals";
import { createLifecycleGeneration } from "../../../examples/procedural-animals/src/lifecycle-generation.js";
import * as wolfMotionSource from "../../../examples/procedural-animals/src/render/wolf-motion.js";
import { CollisionShape3D } from "../../physics/src/CollisionShape3D.js";
import { RigidBody3D } from "../../physics/src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../../physics/src/plugin.js";
import { bakeWolf } from "../src/build.js";

async function context() {
  const scene = new ThreeScene();
  const phase = createAfterPhysicsPhase();
  const ctx = {
    scene,
    entities: new Registry(),
    add: (object: Group) => scene.add(object),
    afterPhysics: phase.register,
  } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
  const plugin = rapier({ gravity: { x: 0, y: -9.81, z: 0 } });
  await plugin.setup?.(ctx);
  const floor = new RigidBody3D({
    physics: ctx.physics,
    shape: CollisionShape3D.box(40, 0.2, 40),
    position: { x: 0, y: -0.1, z: 0 },
    type: "fixed",
    collisionLayer: 1,
  });
  return {
    ctx,
    phase,
    step: (dt: number) => {
      plugin.update?.(ctx, dt);
      phase.run(dt);
    },
    dispose: () => {
      floor.dispose();
      plugin.dispose?.(ctx);
    },
  };
}

describe("actual wolf lifecycle generation ownership", () => {
  it("creates distinct Rapier actors and observes pause/resume and disposal of pending motion", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const original = bake.pos.slice();
    const run = await context();
    try {
      for (const cycle of [1, 2]) {
        const generation = createLifecycleGeneration(run.ctx, bake, cycle);
        expect(run.ctx.physics.numBodies()).toBe(33);
        expect(Object.keys(run.ctx.entities.snapshot())).toHaveLength(32);
        expect(generation.ownership()).toMatchObject({ actors: 32, callbacks: 1, disposals: 0 });
        generation.update(1 / 60);
        run.step(1 / 60);
        generation.teleportAndPause();
        generation.update(1 / 60);
        run.step(1 / 60);
        expect(generation.ownership().poseChanged).toBe(false);
        generation.resume();
        generation.update(1 / 60);
        run.step(1 / 60);
        expect(generation.ownership().poseChanged).toBe(true);
        generation.dispose();
        await generation.settled();
        expect(run.ctx.physics.numBodies()).toBe(1);
        expect(run.ctx.entities.snapshot()).toEqual({});
        expect(run.ctx.scene.children).toHaveLength(0);
        expect(generation.ownership()).toMatchObject({
          actors: 0,
          attached: 0,
          listeners: 0,
          callbacks: 0,
          pendingActions: 0,
          disposedActions: 32,
          disposals: 96,
        });
        run.step(1 / 60);
        generation.dispose();
        expect(generation.ownership().disposals).toBe(96);
      }
      expect(bake.pos).toEqual(original);
    } finally {
      run.dispose();
    }
  }, 60_000);
  it("releases every generation owner after a teleport disposes one actor", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const run = await context();
    try {
      const generation = createLifecycleGeneration(run.ctx, bake, 1);
      generation.update(1 / 60);
      run.step(1 / 60);
      const space = run.ctx.physics.directSpaceState;
      const intersectRay = space.intersectRay.bind(space);
      let calls = 0;
      const ground = vi
        .spyOn(space, "intersectRay")
        .mockImplementation((request) => (++calls <= 2 ? intersectRay(request) : undefined));
      try {
        let teleportError: unknown;
        try {
          generation.teleportAndPause();
        } catch (error) {
          teleportError = error;
        }
        expect(teleportError).toBeInstanceOf(Error);
        expect(generation.ownership().actors).toBe(31);
      } finally {
        ground.mockRestore();
      }
      expect(() => generation.dispose()).toThrow();
      await generation.settled();
      expect(run.ctx.physics.numBodies()).toBe(1);
      expect(run.ctx.entities.snapshot()).toEqual({});
      expect(run.ctx.scene.children).toHaveLength(0);
      expect(generation.ownership()).toMatchObject({
        actors: 0,
        attached: 0,
        listeners: 0,
        callbacks: 0,
        pendingActions: 0,
        disposedActions: 31,
        disposals: 96,
      });
      run.step(1 / 60);
      generation.dispose();
    } finally {
      run.phase.clear();
      run.dispose();
    }
  }, 60_000);
  it("observes rejected disposal actions and settles their pending count while retaining failure", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const run = await context();
    const actionError = new Error("motion action rejected during disposal");
    const originalMotion = wolfMotionSource.wolfMotion;
    const motion = vi.spyOn(wolfMotionSource, "wolfMotion").mockImplementation((context) =>
      Object.assign(originalMotion(context), {
        play() {
          throw actionError;
        },
      }),
    );
    try {
      const generation = createLifecycleGeneration(run.ctx, bake, 1);
      generation.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(generation.ownership()).toMatchObject({
        actors: 0,
        callbacks: 0,
        pendingActions: 0,
        disposedActions: 0,
        disposals: 96,
      });
      await expect(generation.settled()).rejects.toBe(actionError);
      expect(run.ctx.physics.numBodies()).toBe(1);
      expect(run.ctx.entities.snapshot()).toEqual({});
    } finally {
      motion.mockRestore();
      run.dispose();
    }
  }, 60_000);
  it("rejects a still-dispatched callback after disposal rather than hiding an unsubscribe leak", async () => {
    const bake = parseAnimalBake(await bakeWolf({ seed: 7, tier: "crowd" }));
    const run = await context();
    const original = run.ctx.afterPhysics;
    Object.assign(run.ctx, {
      afterPhysics: (callback: Parameters<typeof original>[0]) => {
        original(callback);
        return () => undefined;
      },
    });
    try {
      const generation = createLifecycleGeneration(run.ctx, bake, 1);
      generation.dispose();
      await generation.settled();
      expect(() => run.phase.run(1 / 60)).toThrow("TN_ANIMAL_LIFECYCLE_STALE_CALLBACK");
    } finally {
      run.phase.clear();
      run.dispose();
    }
  }, 60_000);
});
