import type { ICtx } from "@threenative/core";
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from "three";
import { afterEach, describe, expect, it } from "vitest";
import "../src/index.js";
import { NavigationAgent3D } from "../src/navigation/NavigationAgent3D.js";
import { NavigationRegion3D, recast } from "../src/navigation/index.js";
import type { IPhysicsContext } from "../src/plugin.js";
import { rapier } from "../src/plugin.js";

type TestCtx = ICtx<Record<string, unknown>, IPhysicsContext>;

const plugins: Array<ReturnType<typeof rapier> | ReturnType<typeof recast>> = [];

function levelMeshes(): Mesh[] {
  // Dimensions are owned by templates/platformer/src/scenes/Level.ts.
  const platforms: readonly [number, number, number][] = [
    [18, 0, 7],
    [10, 14, 7],
    [8, 25, 7],
    [6, 0, 5],
  ];
  const meshes = platforms.map(([width, x, depth], index) => {
    const mesh = new Mesh(new BoxGeometry(width, 0.4, depth), new MeshBasicMaterial());
    mesh.position.set(x, index === 3 ? 2.4 : -0.2, 0);
    return mesh;
  });
  const blocker = new Mesh(new BoxGeometry(0.6, 1.6, 5.2), new MeshBasicMaterial());
  blocker.position.set(3.4, 0.8, 0);
  meshes.push(blocker);
  return meshes;
}

async function setup(): Promise<{ ctx: TestCtx; navigationPlugin: ReturnType<typeof recast> }> {
  const physicsPlugin = rapier({ gravity: { x: 0, y: -26, z: 0 } });
  const navigationPlugin = recast();
  const ctx = { physics: undefined } as unknown as TestCtx;
  await physicsPlugin.setup?.(ctx);
  await navigationPlugin.setup?.(ctx);
  plugins.push(physicsPlugin, navigationPlugin);
  return { ctx, navigationPlugin };
}

function navigation(ctx: TestCtx): NonNullable<IPhysicsContext["navigation"]> {
  const value = ctx.physics.navigation;
  if (value === undefined) throw new Error("Test setup did not install navigation.");
  return value;
}

afterEach(() => {
  for (const plugin of plugins.splice(0).reverse()) plugin.dispose?.({} as TestCtx);
});

describe("NavigationRegion3D", () => {
  it("should bake a walkable navmesh from the platformer level geometry", async () => {
    const { ctx } = await setup();
    const region = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const closest = navigation(ctx).query.findClosestPoint({ x: 0, y: 0.75, z: 0 });

    expect(region.navigationMesh.getMaxTiles()).toBeGreaterThan(0);
    expect(closest.success).toBe(true);
    expect(Math.hypot(closest.point.x, closest.point.z)).toBeLessThan(0.3);
    expect(Math.abs(closest.point.y)).toBeLessThan(0.3);
  });

  it("should report the third platform unreachable across the x 19...21 gap", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const path = navigation(ctx).query.computePath(
      { x: 0, y: 0.75, z: 0 },
      { x: 25, y: 0.75, z: 0 },
    );
    const final = path.path.at(-1);

    expect(path.success && final !== undefined && Math.abs(final.x - 25) <= 2).toBe(false);
  });

  it("should keep the one-way platform at y 2.6 as a separate walkable layer", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const closest = navigation(ctx).query.findClosestPoint({ x: 0, y: 2.6, z: 0 });

    expect(closest.success).toBe(true);
    expect(closest.point.y).toBeGreaterThan(2);
    expect(Math.abs(closest.point.y - 2.6)).toBeLessThan(0.3);
  });

  it("should dispose two regions without double-destroying a superseded mesh", async () => {
    const { ctx } = await setup();
    const first = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const second = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });

    // Either order must hold: baking the second region frees the first region's mesh only if
    // no live region still owns it, and each dispose destroys what it alone still references.
    expect(() => {
      second.dispose();
      first.dispose();
    }).not.toThrow();

    const again = await setup();
    const one = new NavigationRegion3D({
      meshes: levelMeshes(),
      navigation: navigation(again.ctx),
    });
    const two = new NavigationRegion3D({
      meshes: levelMeshes(),
      navigation: navigation(again.ctx),
    });
    expect(() => {
      one.dispose();
      two.dispose();
    }).not.toThrow();
  });

  it("should keep the active region's agents when a superseded region is disposed", async () => {
    const { ctx } = await setup();
    const first = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const second = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object: new Object3D(),
    });
    expect(navigation(ctx).agents.size).toBe(1);

    first.dispose();
    expect(navigation(ctx).agents.size).toBe(1);
    expect(() => agent.setTargetPosition(new Vector3(-6, 0.75, 0))).not.toThrow();

    second.dispose();
    expect(navigation(ctx).agents.size).toBe(0);
  });

  it("should throw when the bake fails", async () => {
    const { ctx } = await setup();

    expect(() => new NavigationRegion3D({ meshes: [], navigation: navigation(ctx) })).toThrow(
      /requires at least one triangle|could not bake/,
    );
    expect(
      () =>
        new NavigationRegion3D({
          cellSize: Number.NaN,
          meshes: levelMeshes(),
          navigation: navigation(ctx),
        }),
    ).toThrow(/cellSize must be finite/);
  });
});
