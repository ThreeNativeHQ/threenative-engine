import { type IPlaytestBridgeV1, PLAYTEST_BRIDGE_GLOBAL } from "@threenative/playtest";
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IResolvedAsset } from "../src/assets.js";
import { createAssetLoader } from "../src/assets.js";
import { defineGame } from "../src/game.js";
import { GEOMETRY_ASSET_KEY } from "../src/geometry-capture.js";
import { playtest } from "../src/playtest.js";
import { Scene } from "../src/scene.js";
import type { ICtx } from "../src/scene.js";
import { measureStartupOffscreenBytes } from "../src/startup-offscreen-bytes.js";

/** A camera at the origin looking down -z, the way a spawn camera frames the world ahead. */
function spawnCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 1000);
  camera.updateMatrixWorld(true);
  return camera;
}

/** A stamped model root with one mesh, placed at `z`, the way `ctx.assets.model` hands one back. */
function placed(path: string, z: number): Group {
  const root = new Group();
  root.userData[GEOMETRY_ASSET_KEY] = path;
  const mesh = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
  root.add(mesh);
  root.position.set(0, 0, z);
  root.updateMatrixWorld(true);
  return root;
}

function resolvedModels(sizes: Record<string, number>): Map<string, IResolvedAsset> {
  return new Map(
    Object.entries(sizes).map(([path, bytes]) => [
      path,
      { bytes, kind: "model", url: `/${path}`, via: "manifest" } satisfies IResolvedAsset,
    ]),
  );
}

describe("measureStartupOffscreenBytes", () => {
  it("should split awaited models into what the camera shows and what it does not", () => {
    const scene = new Group();
    scene.add(placed("near.glb", -10));
    scene.add(placed("behind.glb", 50));
    const hiddenRoot = placed("hidden.glb", -10);
    hiddenRoot.visible = false;
    scene.add(hiddenRoot);
    scene.updateMatrixWorld(true);

    const report = measureStartupOffscreenBytes(
      resolvedModels({
        "near.glb": 1_000,
        "behind.glb": 90_000,
        "hidden.glb": 5_000,
        "unplaced.glb": 40_000,
      }),
      scene,
      spawnCamera(),
    );

    expect(report.visibleBytes).toBe(1_000);
    expect(report.offscreenBytes).toBe(135_000);
    expect(report.awaitedBytes).toBe(136_000);
    expect(report.top).toEqual([
      { bytes: 90_000, path: "behind.glb", reason: "outside-view" },
      { bytes: 40_000, path: "unplaced.glb", reason: "not-placed" },
      { bytes: 5_000, path: "hidden.glb", reason: "hidden" },
    ]);
    expect(report.warn).toBe(true);
    expect(report.fix).toContain("WorldCells");
    expect(report.fix).toContain("prefetch");
  });

  it("should stay quiet when everything awaited is in view", () => {
    const scene = new Group();
    scene.add(placed("near.glb", -10));
    scene.add(placed("far.glb", -40));
    scene.updateMatrixWorld(true);

    const report = measureStartupOffscreenBytes(
      resolvedModels({ "near.glb": 1_000, "far.glb": 2_000 }),
      scene,
      spawnCamera(),
    );

    expect(report.offscreenBytes).toBe(0);
    expect(report.visibleBytes).toBe(3_000);
    expect(report.top).toEqual([]);
    expect(report.warn).toBe(false);
  });

  it("should inform without warning when off-screen bytes are the minority", () => {
    const scene = new Group();
    scene.add(placed("near.glb", -10));
    scene.add(placed("prop.glb", 50));
    scene.updateMatrixWorld(true);

    const report = measureStartupOffscreenBytes(
      resolvedModels({ "near.glb": 80_000, "prop.glb": 4_000 }),
      scene,
      spawnCamera(),
    );

    expect(report.offscreenBytes).toBe(4_000);
    expect(report.warn).toBe(false);
  });

  it("should keep the provenance of an instanced batch built from a model's geometry", () => {
    const scene = new Group();
    const source = placed("tree.glb", 50);
    const geometry = (source.children[0] as Mesh).geometry;
    geometry.userData[GEOMETRY_ASSET_KEY] = "tree.glb";
    // The root never enters the scene; the batch shares the geometry and shows in front.
    const batch = new InstancedMesh(geometry, new MeshBasicMaterial(), 1);
    batch.position.set(0, 0, -10);
    scene.add(batch);
    scene.updateMatrixWorld(true);

    const report = measureStartupOffscreenBytes(
      resolvedModels({ "tree.glb": 70_000 }),
      scene,
      spawnCamera(),
    );

    expect(report.visibleBytes).toBe(70_000);
    expect(report.offscreenBytes).toBe(0);
  });

  it("should count textures and unsized files without calling them off-screen", () => {
    const resolved = new Map<string, IResolvedAsset>([
      ["sky.png", { bytes: 9_000, kind: "texture", url: "/sky.png", via: "manifest" }],
      ["rock.glb", { kind: "model", url: "/rock.glb", via: "source" }],
    ]);

    const report = measureStartupOffscreenBytes(resolved, new Group(), spawnCamera());

    expect(report.awaitedBytes).toBe(9_000);
    expect(report.unattributedBytes).toBe(9_000);
    expect(report.unsizedFiles).toBe(1);
    expect(report.offscreenBytes).toBe(0);
  });
});

describe("loader provenance for the off-screen measurement", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("should record kind and manifest bytes once a load settles, and stamp mesh geometry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              entries: {
                "tree.glb": { output: "tree.a1.glb", kind: "model", bytes: 70_000, passes: [] },
              },
            }),
          ),
      ),
    );
    const assets = createAssetLoader({
      basePath: "/assets",
      model: async () => placed("", 0),
    });

    const root = await assets.model<Group>("tree.glb");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(assets.resolved.get("tree.glb")).toMatchObject({ bytes: 70_000, kind: "model" });
    expect((root.children[0] as Mesh).geometry.userData[GEOMETRY_ASSET_KEY]).toBe("tree.glb");
  });

  it("should record the shared images a model load downloads beside its own file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              entries: {
                "tree.glb": {
                  output: "tree.a1.glb",
                  kind: "model",
                  bytes: 70_000,
                  passes: [],
                  sharedImages: [{ output: "bark.b2.ktx2", bytes: 900_000 }],
                },
              },
            }),
          ),
      ),
    );
    const assets = createAssetLoader({ basePath: "/assets", model: async () => placed("", 0) });

    await assets.model<Group>("tree.glb");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(assets.resolved.get("tree.glb")?.files).toEqual([
      { bytes: 70_000, url: "/assets/tree.a1.glb" },
      { bytes: 900_000, url: "/assets/bark.b2.ktx2" },
    ]);
  });

  it("should count a shared image once, as visible when a model in view uses it", () => {
    const scene = new Group();
    scene.add(placed("near.glb", -10));
    scene.add(placed("behind.glb", 50));
    scene.updateMatrixWorld(true);
    const shared = { bytes: 50_000, url: "/bark.ktx2" };
    const resolved = new Map<string, IResolvedAsset>([
      [
        "near.glb",
        {
          bytes: 1_000,
          files: [{ bytes: 1_000, url: "/near.glb" }, shared],
          kind: "model",
          url: "/near.glb",
          via: "manifest",
        },
      ],
      [
        "behind.glb",
        {
          bytes: 2_000,
          files: [
            { bytes: 2_000, url: "/behind.glb" },
            shared,
            { bytes: 30_000, url: "/leaf.ktx2" },
          ],
          kind: "model",
          url: "/behind.glb",
          via: "manifest",
        },
      ],
    ]);

    const report = measureStartupOffscreenBytes(resolved, scene, spawnCamera());

    expect(report.awaitedBytes).toBe(83_000);
    expect(report.visibleBytes).toBe(51_000);
    expect(report.offscreenBytes).toBe(32_000);
    expect(report.top).toEqual([{ bytes: 32_000, path: "behind.glb", reason: "outside-view" }]);
  });
});

describe("the reveal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** Boot a game whose start scene awaits a near and a far model, then pump frames to the reveal. */
  async function reveal(farBytes: number, farZ: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: 1,
              entries: {
                "near.glb": { output: "near.glb", kind: "model", bytes: 1_000, passes: [] },
                "far.glb": { output: "far.glb", kind: "model", bytes: farBytes, passes: [] },
              },
            }),
          ),
      ),
    );
    const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
    Object.defineProperties(canvas, {
      clientHeight: { configurable: true, value: 90 },
      clientWidth: { configurable: true, value: 160 },
      parentElement: { configurable: true, value: null },
    });
    let captured: ICtx | undefined;
    class Awaiting extends Scene {
      static override readonly initialState = {};
      override async load(ctx: ICtx): Promise<void> {
        captured = ctx;
        const near = await ctx.assets.model<Group>("near.glb");
        const far = await ctx.assets.model<Group>("far.glb");
        near.position.set(0, 0, -10);
        far.position.set(0, 0, farZ);
        ctx.scene.add(near, far);
      }
    }
    let frame: ((time: number) => void) | undefined;
    const requestFrame = globalThis.requestAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        frame = callback;
        return 1;
      },
    });
    const game = defineGame({
      assets: {
        basePath: "/assets",
        model: async () => placed("", 0),
      },
      renderer: {
        canvas: canvas as never,
        preferWebGPU: false,
        webgl2Factory: () =>
          ({
            dispose: () => undefined,
            domElement: canvas,
            getDrawingBufferSize: (target: { set(x: number, y: number): unknown }) =>
              target.set(160, 90),
            render: () => undefined,
            setSize: () => undefined,
          }) as never,
      },
      plugins: [playtest()],
      scenes: { awaiting: Awaiting },
      start: "awaiting",
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await game.start();
      if (frame === undefined) throw new Error("Game did not start its loop.");
      for (
        let index = 1;
        index <= 12 && captured?.startup.timeline.readyMs === undefined;
        index += 1
      ) {
        frame(index * 16.7);
        await Promise.resolve();
      }
      await captured?.startup.whenReady();
      const bridge = (globalThis as Record<string, unknown>)[
        PLAYTEST_BRIDGE_GLOBAL
      ] as IPlaytestBridgeV1;
      const published = (await bridge.ready()).startup?.offscreenBytes;
      return { ctx: captured, log, published, warn };
    } finally {
      await game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
    }
  }

  const markerCalls = (spy: { mock: { calls: unknown[][] } }): string[] =>
    spy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("TN_STARTUP_OFFSCREEN_BYTES:"));

  it("should warn once with the large out-of-view file named", async () => {
    const { published, warn } = await reveal(500_000, 80);

    const lines = markerCalls(warn);
    expect(lines).toHaveLength(1);
    const report = JSON.parse(lines[0]?.slice("TN_STARTUP_OFFSCREEN_BYTES:".length) ?? "{}");
    expect(report.top[0]).toMatchObject({
      bytes: 500_000,
      path: "far.glb",
      reason: "outside-view",
    });
    expect(report.visibleBytes).toBe(1_000);
    // The playtest bridge publishes the same measurement, so a scenario can gate on it.
    expect(published).toEqual(report);
  });

  it("should print nothing when the clean variant awaits only what the camera sees", async () => {
    const { log, published, warn } = await reveal(500_000, -20);

    // Quiet on the console, but the bridge still reports a measurement of zero off-screen bytes.
    expect(published).toMatchObject({ offscreenBytes: 0, visibleBytes: 501_000, warn: false });
    expect(markerCalls(warn)).toEqual([]);
    expect(markerCalls(log)).toEqual([]);
  });
});
