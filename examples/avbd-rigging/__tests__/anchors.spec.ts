import { ComputeDrivenRegistry, type ICtx, createRandom } from "@threenative/core";
import { CollisionShape3D, type IPhysicsContext, RigidBody3D, rapier } from "@threenative/physics";
import { Group, Object3D } from "three";
import { expect, it, vi } from "vitest";
import { toSolverPoint } from "../src/physics/frame.js";
import { fixture } from "./adapter-fixture.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

it("leaves the seeded real Rapier trace identical and uploads accepted anchor transforms one way", async () => {
  const traces: number[][] = [];
  for (const enabled of [false, true]) {
    const plugin = rapier({ deterministicRestart: true });
    const ctx = { physics: undefined } as unknown as PhysicsCtx;
    await plugin.setup?.(ctx);
    const random = createRandom(446);
    const mast = new Object3D();
    mast.position.set(0, 4, 0);
    new RigidBody3D({
      object: mast,
      physics: ctx.physics,
      shape: CollisionShape3D.box(0.1, 1, 0.1),
      type: "kinematic",
    });
    new RigidBody3D({
      position: { x: 0, y: -0.5, z: 0 },
      physics: ctx.physics,
      shape: CollisionShape3D.box(20, 1, 20),
      type: "fixed",
    });
    const bodies = Array.from({ length: 6 }, (_, index) => {
      const object = new Object3D();
      object.position.set(random() - 0.5, 1 + index * 1.1, random() - 0.5);
      new RigidBody3D({
        object,
        physics: ctx.physics,
        shape: CollisionShape3D.box(0.8, 0.8, 0.8),
        mass: 1,
      });
      return object;
    });
    const f = fixture(undefined, {
      readbackEveryTicks: 0,
      snapshot: (model) => ({
        anchors: model.anchors.map((anchor) => [
          anchor.position[0] + mast.position.x,
          anchor.position[1],
          anchor.position[2],
        ]),
        proxies: [],
      }),
    });
    const scene = new Group();
    const registry = new ComputeDrivenRegistry();
    if (enabled) {
      await f.rigging.prepare(f.renderer);
      scene.add(f.rigging);
      registry.add(f.rigging, f.renderer);
    }
    const trace: number[] = [];
    try {
      for (let tick = 0; tick < 240; tick++) {
        mast.position.x = Math.min(tick, 120) / 240;
        plugin.update?.(ctx, 1 / 60);
        const accepted = mast.position.x;
        const authoritative = bodies.flatMap((body) => [
          ...body.position.toArray(),
          ...body.quaternion.toArray(),
        ]);
        registry.process(f.renderer);
        expect(
          bodies.flatMap((body) => [...body.position.toArray(), ...body.quaternion.toArray()]),
        ).toEqual(authoritative);
        if (enabled) {
          const first = f.rigging.model.anchors[0];
          if (first === undefined) throw new Error("test anchor missing");
          const lastUploads = vi
            .mocked(f.solver.setWorldAnchor)
            .mock.calls.slice(-f.rigging.model.anchors.length);
          expect(lastUploads[0]).toEqual([
            first.slot,
            toSolverPoint([first.position[0] + accepted, first.position[1], first.position[2]]),
          ]);
        }
        trace.push(...authoritative);
      }
      expect(f.solver.step).toHaveBeenCalledTimes(enabled ? 240 : 0);
      expect(trace.every(Number.isFinite)).toBe(true);
      expect(trace[1]).not.toBe(trace.at(-41));
      traces.push(trace);
    } finally {
      registry.clear();
      f.rigging.detach();
      await f.rigging.whenReleased();
      plugin.dispose?.(ctx);
    }
  }
  expect(traces[1]).toEqual(traces[0]);
});
