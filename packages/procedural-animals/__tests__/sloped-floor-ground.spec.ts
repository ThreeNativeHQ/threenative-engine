import "../../physics/src/web.js";
import { BoxGeometry, Mesh, MeshStandardMaterial, SphereGeometry } from "three";
import { describe, expect, it } from "vitest";
import { slopedFloorGround } from "../../../examples/procedural-animals/src/render/course.js";
import type { ICtx } from "../../core/src/scene.js";
import { CollisionShape3D } from "../../physics/src/CollisionShape3D.js";
import { RigidBody3D } from "../../physics/src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../../physics/src/plugin.js";

describe("sloped floor ground sampling", () => {
  it("matches the level-mask Rapier ray while avoiding repeated full casts", async () => {
    const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
    const ctx = { physics: undefined } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
    await plugin.setup?.(ctx);
    const floor = new Mesh(
      new BoxGeometry(40, 0.5, 40),
      new MeshStandardMaterial({ roughness: 1 }),
    );
    floor.position.set(0, -0.25, -2);
    floor.rotation.z = Math.atan(0.1);
    const body = new RigidBody3D({
      object: floor,
      physics: ctx.physics,
      shape: CollisionShape3D.fromMesh(floor),
      type: "fixed",
      collisionLayer: 1,
      collisionMask: 0xffff,
    });
    let fallbackCalls = 0;
    const groundRay = (x: number, z: number) => {
      fallbackCalls += 1;
      const hit = ctx.physics.directSpaceState.intersectRay({
        from: { x, y: 50, z },
        to: { x, y: -50, z },
        collisionMask: 1,
      });
      if (!hit) throw new Error("missing ground");
      return hit.position.y;
    };
    const ground = slopedFloorGround(floor, groundRay);
    try {
      for (const [x, z] of [
        [0, -2],
        [-5, 0],
        [8, 6],
        [-12, -8],
      ] as const) {
        const analytic = ground(x, z);
        const referenceCalls = fallbackCalls;
        expect(() => {
          const hit = ctx.physics.directSpaceState.intersectRay({
            from: { x, y: 50, z },
            to: { x, y: -50, z },
            collisionMask: 1,
          });
          if (!hit) throw new Error("missing ground");
          expect(analytic).toBeCloseTo(hit.position.y, 5);
        }).not.toThrow();
        expect(fallbackCalls).toBe(referenceCalls);
      }
      expect(fallbackCalls).toBe(0);

      let outsideCalls = 0;
      const outsideFallback = (x: number, z: number) => {
        outsideCalls += 1;
        return groundRay(x, z);
      };
      const guarded = slopedFloorGround(floor, outsideFallback);
      expect(() => guarded(30, 30)).toThrow("missing ground");
      expect(outsideCalls).toBe(1);

      let invalidCalls = 0;
      const invalidFallback = (x: number, z: number) => {
        invalidCalls += 1;
        throw new Error(`fallback ${x},${z}`);
      };
      const guardedInvalid = slopedFloorGround(floor, invalidFallback);
      expect(() => guardedInvalid(Number.NaN, 0)).toThrow("fallback");
      expect(invalidCalls).toBe(1);
      expect(() => guardedInvalid(0, Number.POSITIVE_INFINITY)).toThrow("fallback");
      expect(invalidCalls).toBe(2);

      const sphere = new Mesh(new SphereGeometry(1), new MeshStandardMaterial());
      const sphereFallback = (x: number, z: number) => x + z;
      expect(slopedFloorGround(sphere, sphereFallback)).toBe(sphereFallback);

      const vertical = new Mesh(
        new BoxGeometry(40, 0.5, 40),
        new MeshStandardMaterial({ roughness: 1 }),
      );
      vertical.rotation.x = Math.PI / 2;
      let verticalCalls = 0;
      const verticalFallback = (x: number, z: number) => {
        verticalCalls += 1;
        return 3;
      };
      expect(slopedFloorGround(vertical, verticalFallback)(0, 0)).toBe(3);
      expect(verticalCalls).toBe(1);

      const upsideDown = new Mesh(
        new BoxGeometry(40, 0.5, 40),
        new MeshStandardMaterial({ roughness: 1 }),
      );
      upsideDown.rotation.x = Math.PI;
      let invertedCalls = 0;
      const invertedFallback = (x: number, z: number) => {
        invertedCalls += 1;
        return 4;
      };
      expect(slopedFloorGround(upsideDown, invertedFallback)(0, 0)).toBe(4);
      expect(invertedCalls).toBe(1);
    } finally {
      body.dispose();
      plugin.dispose?.(ctx);
    }
  });
});
