import * as RAPIER from "@dimforge/rapier3d-compat";
import type { ICtx } from "@threenative/core";
import { CylinderGeometry, IcosahedronGeometry, Matrix4, Quaternion, Vector3 } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { beforeAll, describe, expect, it } from "vitest";
import "../src/index.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";
import { ScatterColliders } from "../src/scatter-colliders.js";

type PhysicsCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

beforeAll(async () => {
  await RAPIER.init();
});

async function setup(): Promise<{ ctx: PhysicsCtx; plugin: ReturnType<typeof rapier> }> {
  const plugin = rapier({ gravity: { x: 0, y: 0, z: 0 } });
  const ctx = { physics: undefined } as unknown as PhysicsCtx;
  await plugin.setup?.(ctx);
  return { ctx, plugin };
}

/** A unit rock whose base sits on its origin, like a scattered prop. */
function rock(): IcosahedronGeometry {
  const geometry = new IcosahedronGeometry(1, 1);
  geometry.translate(0, 1, 0);
  return geometry;
}

/** A 10 m bark mesh: a 0.3 m trunk plus 3 m branch wood at 4 m, like the licensed spruce. */
function bark(): ReturnType<typeof mergeGeometries> {
  const trunk = new CylinderGeometry(0.3, 0.3, 10, 8).translate(0, 5, 0);
  const branches = new CylinderGeometry(3, 3, 0.2, 8).translate(0, 4, 0);
  return mergeGeometries([trunk, branches]);
}

function at(x: number, z: number, scale = 1): Matrix4 {
  return new Matrix4().compose(
    new Vector3(x, 0, z),
    new Quaternion(),
    new Vector3(scale, scale, scale),
  );
}

function hits(ctx: PhysicsCtx, x: number, y: number, z: number): boolean {
  return (
    ctx.physics.directSpaceState.intersectRay({
      from: { x: x - 6, y, z },
      to: { x: x + 6, y, z },
    }) !== undefined
  );
}

describe("ScatterColliders", () => {
  it("should block a rock and a trunk near the follow point and release them far away", async () => {
    const { ctx, plugin } = await setup();
    const follow = { position: new Vector3(0, 0, 0) };
    const colliders = new ScatterColliders({
      physics: ctx.physics,
      follow,
      radius: 30,
      instances: [
        { geometry: rock(), matrix: at(10, 0, 2) },
        { geometry: bark(), matrix: at(0, 10) },
      ],
    });
    colliders.update();
    plugin.update?.(ctx, 1 / 60);

    expect(colliders.stats()).toMatchObject({ hulls: 1, trunks: 1, resident: 2, skipped: 0 });
    expect(hits(ctx, 10, 2, 0)).toBe(true);
    // The 18-DOP hugs the 2 m rock: half a metre past its side is open.
    expect(
      ctx.physics.directSpaceState.intersectRay({
        from: { x: 4, y: 2, z: 2.5 },
        to: { x: 16, y: 2, z: 2.5 },
      }),
    ).toBeUndefined();
    // The trunk blocks, the branch wood 2 m out does not: a capsule, not a hull of the crown.
    expect(hits(ctx, 0, 1, 10)).toBe(true);
    expect(
      ctx.physics.directSpaceState.intersectRay({
        from: { x: 2, y: 4.5, z: 4 },
        to: { x: 2, y: 4.5, z: 16 },
      }),
    ).toBeUndefined();

    follow.position.set(500, 0, 0);
    colliders.update();
    plugin.update?.(ctx, 1 / 60);
    expect(colliders.stats().resident).toBe(0);
    expect(hits(ctx, 10, 2, 0)).toBe(false);

    follow.position.set(0, 0, 0);
    colliders.update();
    plugin.update?.(ctx, 1 / 60);
    expect(hits(ctx, 10, 2, 0)).toBe(true);
    colliders.dispose();
    expect(ctx.physics.numBodies()).toBe(0);
    plugin.dispose?.(ctx);
  });

  it("should skip ankle-high pieces and honour the named override", async () => {
    const { ctx, plugin } = await setup();
    const colliders = new ScatterColliders({
      physics: ctx.physics,
      follow: { position: { x: 0, z: 0 } },
      instances: [
        { geometry: rock(), matrix: at(1, 0, 0.05) },
        { geometry: rock(), matrix: at(5, 0), collision: "none" },
        { geometry: bark(), matrix: at(-5, 0), collision: "hull" },
      ],
    });
    colliders.update();
    plugin.update?.(ctx, 1 / 60);

    expect(colliders.stats()).toMatchObject({ hulls: 1, trunks: 0, skipped: 2, resident: 1 });
    expect(hits(ctx, 5, 1, 0)).toBe(false);
    colliders.dispose();
    plugin.dispose?.(ctx);
  });

  it("should keep thousands of far placements out of the physics world", async () => {
    const { ctx, plugin } = await setup();
    const geometry = rock();
    const instances = Array.from({ length: 20_000 }, (_, index) => ({
      geometry,
      matrix: at((index % 200) * 10 - 1000, Math.floor(index / 200) * 10 - 500),
    }));
    const colliders = new ScatterColliders({
      physics: ctx.physics,
      follow: { position: { x: 0, z: 0 } },
      radius: 40,
      instances,
    });
    colliders.update();

    // About pi * 41^2 / 100 placements stand inside the ring; the other 19,950 cost nothing.
    expect(colliders.stats().resident).toBeGreaterThan(40);
    expect(colliders.stats().resident).toBeLessThan(70);
    expect(ctx.physics.numBodies()).toBe(colliders.stats().resident);
    colliders.dispose();
    plugin.dispose?.(ctx);
  });
});
