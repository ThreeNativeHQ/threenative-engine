import type { ICtx } from "@threenative/core";
import { Raw } from "recast-navigation";
import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../src/index.js";
import { NavigationAgent3D } from "../src/navigation/NavigationAgent3D.js";
import { NavigationRegion3D } from "../src/navigation/NavigationRegion3D.js";
import { recast } from "../src/navigation/index.js";
import { type IPhysicsContext, rapier } from "../src/plugin.js";

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

describe("NavigationAgent3D", () => {
  it("should route around a blocker instead of through it", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
    });
    agent.setTargetPosition(new Vector3(0, 0.75, 0));
    const path = navigation(ctx).query.computePath(
      { x: 7.5, y: 0.75, z: 0 },
      { x: 0, y: 0.75, z: 0 },
    );
    const pathLength = path.path.slice(1).reduce((total, point, index) => {
      const previous = path.path[index];
      return previous === undefined
        ? total
        : total + Math.hypot(point.x - previous.x, point.y - previous.y, point.z - previous.z);
    }, 0);

    expect(path.success).toBe(true);
    expect(pathLength).toBeGreaterThanOrEqual(9);
    expect(path.path.some((point) => Math.abs(point.z) > 2.5)).toBe(true);
    expect(agent.getFinalPosition().x).toBeCloseTo(0, 1);
  });

  it("should report the far platform unreachable and the near one reachable", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(0, 0.75, 0);
    const agent = new NavigationAgent3D({
      navigation: navigation(ctx),
      object,
    });

    expect(agent.isTargetReachable(new Vector3(25, 0.75, 0))).toBe(false);
    expect(agent.isTargetReachable(new Vector3(-6, 0.75, 0))).toBe(true);
    expect(agent.isTargetReachable(new Vector3(100, 0.75, 0))).toBe(false);
    expect(agent.isTargetReachable(new Vector3(0, 5, 0))).toBe(false);
  });

  it("should fail closed when the baked region is disabled or absent", async () => {
    const { ctx } = await setup();
    expect(
      () =>
        new NavigationAgent3D({
          avoidanceEnabled: false,
          navigation: navigation(ctx),
          object: new Object3D(),
        }),
    ).toThrow(/baked navigation region/);

    const region = new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    region.enabled = false;
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object: new Object3D(),
    });
    expect(agent.isTargetReachable(new Vector3(-6, 0.75, 0))).toBe(false);
    region.enabled = true;
    expect(agent.isTargetReachable(new Vector3(-6, 0.75, 0))).toBe(true);
  });

  it("should keep an agent on the one-way platform layer", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(-2, 2.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
    });

    agent.setTargetPosition(new Vector3(2, 2.75, 0));

    expect(agent.isTargetReachable()).toBe(true);
    expect(agent.getNextPathPosition().y).toBeGreaterThan(2);
    expect(agent.getFinalPosition().y).toBeGreaterThan(2);
  });

  it("should advance the path cursor during the recast update", async () => {
    const { ctx, navigationPlugin } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
    });
    agent.setTargetPosition(new Vector3(0, 0.75, 0));
    expect(agent.getNextPathPosition().distanceTo(object.position)).toBeLessThan(0.01);

    navigationPlugin.update?.(ctx, 1 / 60);

    expect(Math.abs(agent.getNextPathPosition().z)).toBeGreaterThan(2.5);
  });

  it("fills a supplied next-position target", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
    });
    agent.setTargetPosition(new Vector3(0, 0.75, 0));
    const target = new Vector3();

    expect(agent.getNextPathPosition(target)).toBe(target);
  });

  it("rejects non-finite target components", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object: new Object3D(),
    });

    expect(() => agent.setTargetPosition({ x: Number.NaN, y: 0, z: 0 })).toThrow(
      /target position must be finite/,
    );
    expect(() => agent.setTargetPosition({ x: 0, y: Number.POSITIVE_INFINITY, z: 0 })).toThrow(
      /target position must be finite/,
    );
    expect(() => agent.setTargetPosition({ x: 0, y: 0, z: Number.NEGATIVE_INFINITY })).toThrow(
      /target position must be finite/,
    );
  });

  it("should throw when getNextPathPosition is called before a target is set", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object: new Object3D(),
    });

    expect(() => agent.getNextPathPosition()).toThrow(/requires a target/);
  });

  it("does not retain raw query records after construction validation fails", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const constructors = [
      vi.spyOn(Raw, "UnsignedIntRef"),
      vi.spyOn(Raw, "Vec3"),
      vi.spyOn(Raw, "BoolRef"),
    ];
    const destroySpy = vi.spyOn(Raw, "destroy");
    try {
      expect(
        () =>
          new NavigationAgent3D({
            navigation: navigation(ctx),
            object: new Object3D(),
            radius: 0,
          }),
      ).toThrow(/radius must be finite and positive/);

      const allocatedRecords = constructors.reduce((total, recordSpy) => {
        return total + recordSpy.mock.calls.length;
      }, 0);
      expect(destroySpy).toHaveBeenCalledTimes(allocatedRecords);
    } finally {
      destroySpy.mockRestore();
      for (const recordSpy of constructors) recordSpy.mockRestore();
    }
  });
});

describe("NavigationAgent3D hot-path cost", () => {
  it("computes the path once per retarget", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
    });
    const spy = vi.spyOn(navigation(ctx).query, "computePath");
    try {
      agent.setTargetPosition(new Vector3(0, 0.75, 0));
      expect(spy).toHaveBeenCalledTimes(1);
      // The stored path and reachability are unchanged by who computed them.
      expect(agent.getFinalPosition().x).toBeCloseTo(0, 1);
      expect(agent.isNavigationFinished()).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("crowd sync leaves a stationary agent alone and still localizes a moved one", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      navigation: navigation(ctx),
      object,
    });
    const crowdAgent = agent.crowdAgent;
    if (crowdAgent === undefined) throw new Error("Test setup produced no crowd agent.");
    agent.setTargetPosition(new Vector3(0, 0.75, 0));
    const teleportSpy = vi.spyOn(Raw.CrowdUtils, "agentTeleport");
    const requestTargetSpy = vi.spyOn(crowdAgent.crowd.raw, "requestMoveTarget");
    try {
      agent.syncCrowd();
      const initialTeleports = teleportSpy.mock.calls.length;
      expect(initialTeleports).toBeGreaterThan(0);

      // Stationary frames: gameplay did not move the object, so re-localising it every frame
      // was a fixed WASM tax per agent regardless of motion.
      for (let frame = 0; frame < 10; frame += 1) agent.syncCrowd();
      expect(teleportSpy.mock.calls.length).toBe(initialTeleports);

      // A moved object must still re-localise.
      object.position.x += 0.5;
      agent.syncCrowd();
      expect(teleportSpy.mock.calls.length).toBeGreaterThan(initialTeleports);
      expect(requestTargetSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(requestTargetSpy.mock.calls[0]?.[2]).toBe(requestTargetSpy.mock.calls[1]?.[2]);
    } finally {
      teleportSpy.mockRestore();
      requestTargetSpy.mockRestore();
    }
  });

  it("reuses crowd movement arrays and nearest-poly records after warmup", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      navigation: navigation(ctx),
      object,
    });
    const crowdAgent = agent.crowdAgent;
    if (crowdAgent === undefined) throw new Error("Test setup produced no crowd agent.");
    const crowdQuery = crowdAgent.crowd.navMeshQuery;
    const findNearestPolySpy = vi.spyOn(crowdQuery.raw, "findNearestPoly");
    const requestMoveTargetSpy = vi.spyOn(crowdAgent.crowd.raw, "requestMoveTarget");
    const teleportSpy = vi.spyOn(Raw.CrowdUtils, "agentTeleport");
    try {
      agent.setTargetPosition(new Vector3(0, 0.75, 0));

      // The first moved frame warms the reusable records; later frames must retain every
      // array and query-record identity passed through the Recast crowd boundary.
      agent.syncCrowd();
      object.position.x += 0.25;
      agent.syncCrowd();
      object.position.x += 0.25;
      agent.syncCrowd();

      const nearestCalls = findNearestPolySpy.mock.calls;
      const nearestPrevious = nearestCalls.at(-2);
      const nearestCurrent = nearestCalls.at(-1);
      if (nearestPrevious === undefined || nearestCurrent === undefined)
        throw new Error("Expected repeated crowd target queries.");
      expect(nearestCurrent[0]).toBe(nearestPrevious[0]);
      expect(nearestCurrent[1]).toBe(nearestPrevious[1]);
      expect(nearestCurrent[3]).toBe(nearestPrevious[3]);
      expect(nearestCurrent[4]).toBe(nearestPrevious[4]);
      expect(nearestCurrent[5]).toBe(nearestPrevious[5]);

      const requestCalls = requestMoveTargetSpy.mock.calls;
      const requestPrevious = requestCalls.at(-2);
      const requestCurrent = requestCalls.at(-1);
      if (requestPrevious === undefined || requestCurrent === undefined)
        throw new Error("Expected repeated crowd target requests.");
      expect(requestCurrent[2]).toBe(requestPrevious[2]);

      const teleportCalls = teleportSpy.mock.calls;
      const teleportPrevious = teleportCalls.at(-2);
      const teleportCurrent = teleportCalls.at(-1);
      if (teleportPrevious === undefined || teleportCurrent === undefined)
        throw new Error("Expected repeated crowd teleports.");
      expect(teleportCurrent[2]).toBe(teleportPrevious[2]);
      expect(teleportCurrent[3]).toBe(teleportPrevious[3]);
    } finally {
      findNearestPolySpy.mockRestore();
      requestMoveTargetSpy.mockRestore();
      teleportSpy.mockRestore();
    }
  });

  it("reuses target validation storage across repeated avoidance retargets", async () => {
    const { ctx } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({ navigation: navigation(ctx), object });
    const crowdAgent = agent.crowdAgent;
    if (crowdAgent === undefined) throw new Error("Test setup produced no crowd agent.");
    const target = new Vector3(0, 0.75, 0);
    const next = new Vector3();
    const everySpy = vi.spyOn(Array.prototype, "every");
    const getNvelSpy = vi.spyOn(crowdAgent.raw, "get_nvel");
    try {
      const everyCallsBeforeRetargets = everySpy.mock.calls.length;
      for (let iteration = 0; iteration < 5; iteration += 1) {
        target.x = iteration % 2 === 0 ? 0 : 0.25;
        agent.setTargetPosition(target);
        expect(agent.getNextPathPosition(next)).toBe(next);
      }

      expect(everySpy.mock.calls.length).toBe(everyCallsBeforeRetargets);
      expect(getNvelSpy).toHaveBeenCalledTimes(15);
    } finally {
      getNvelSpy.mockRestore();
      everySpy.mockRestore();
    }
  });

  it("walks a wall detour to completion and targetReached fires once", async () => {
    const { ctx, navigationPlugin } = await setup();
    new NavigationRegion3D({ meshes: levelMeshes(), navigation: navigation(ctx) });
    const object = new Object3D();
    object.position.set(7.5, 0.75, 0);
    const agent = new NavigationAgent3D({
      avoidanceEnabled: false,
      navigation: navigation(ctx),
      object,
      pathDesiredDistance: 0.8,
      targetDesiredDistance: 0.8,
    });
    const target = new Vector3(0, 0.75, 0);
    let targetReachedCount = 0;
    agent.on("targetReached", () => {
      targetReachedCount += 1;
    });
    agent.setTargetPosition(target);

    const nextPos = new Vector3();
    let detourObserved = false;
    for (let step = 0; step < 300 && !agent.isNavigationFinished(); step += 1) {
      agent.getNextPathPosition(nextPos);
      if (Math.abs(object.position.z) > 1.5) {
        detourObserved = true;
      }
      const stepDir = new Vector3().subVectors(nextPos, object.position);
      if (stepDir.lengthSq() > 0.0001) {
        stepDir.setLength(Math.min(0.2, stepDir.length()));
        object.position.add(stepDir);
      }
      navigationPlugin.update?.(ctx, 1 / 60);
    }

    expect(detourObserved).toBe(true);
    expect(agent.isNavigationFinished()).toBe(true);
    expect(object.position.distanceTo(target)).toBeLessThanOrEqual(0.8);
    expect(targetReachedCount).toBe(1);

    // Additional updates after completion must not fire targetReached again
    navigationPlugin.update?.(ctx, 1 / 60);
    agent.advance();
    expect(targetReachedCount).toBe(1);
    agent.dispose();
  });
});
