import type { ICtx } from "@threenative/core";
import { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { PhysicsInterpolation } from "../../core/src/interpolation.js";
import "../src/index.js";
import { CharacterBody3D } from "../src/CharacterBody3D.js";
import { CollisionShape3D } from "../src/CollisionShape3D.js";
import { RigidBody3D } from "../src/RigidBody3D.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

describe("physics interpolation registration", () => {
  it.each(["character", "rigid"])(
    "tracks %s by default, resets teleports, and respects its override",
    async (kind) => {
      const interpolation = new PhysicsInterpolation();
      const reset = vi.fn((object: Object3D) => interpolation.reset(object));
      const ctx = {
        interpolate: (object: Object3D) => interpolation.track(object),
        resetInterpolation: reset,
        physics: undefined,
      } as unknown as ICtx<Record<string, unknown>, IPhysicsContext>;
      const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
      await plugin.setup?.(ctx);
      try {
        const object = new Object3D();
        const options = { object, physics: ctx.physics, shape: CollisionShape3D.sphere(0.25) };
        const body = kind === "character" ? new CharacterBody3D(options) : new RigidBody3D(options);
        interpolation.beginTick();
        object.position.x = 2;
        interpolation.endTick();
        interpolation.render(0.5, () => expect(object.position.x).toBe(1));
        body.interpolate = false;
        interpolation.render(0.5, () => expect(object.position.x).toBe(2));
        body.interpolate = true;
        interpolation.beginTick();
        object.position.x = 4;
        interpolation.endTick();
        interpolation.render(0.5, () => expect(object.position.x).toBe(3));
        interpolation.beginTick();
        if (body instanceof CharacterBody3D) body.teleport({ x: 100, y: 0, z: 0 });
        else body.position = { x: 100, y: 0, z: 0 };
        interpolation.endTick();
        expect(reset).toHaveBeenCalledWith(object);
        interpolation.render(0.5, () => expect(object.position.x).toBe(100));
        body.dispose();
        expect(() => {
          body.interpolate = false;
        }).toThrow(/dispose/);
        interpolation.beginTick();
        object.position.x = 102;
        interpolation.endTick();
        interpolation.render(0.5, () => expect(object.position.x).toBe(102));
      } finally {
        plugin.dispose?.(ctx);
      }
    },
  );
});
