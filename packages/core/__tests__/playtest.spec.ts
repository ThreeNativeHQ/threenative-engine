import {
  type IPlaytestBridgeV1,
  type IPlaytestSampleRequest,
  PLAYTEST_BRIDGE_GLOBAL,
  PLAYTEST_PROTOCOL_LIMITS,
  unknownPlaytestCapabilities,
} from "@threenative/playtest";
import {
  AnimationClip,
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  NumberKeyframeTrack,
  Texture,
  type Vector2,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { AnimationPlayer } from "../src/animation.js";
import { type IGamePluginHooks, defineGame } from "../src/game.js";
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL, playtest } from "../src/playtest.js";
import { type ICtx, Scene } from "../src/scene.js";

function testCanvas(): HTMLCanvasElement {
  const canvas = new EventTarget() as EventTarget & Partial<HTMLCanvasElement>;
  Object.defineProperties(canvas, {
    clientHeight: { configurable: true, value: 180 },
    clientWidth: { configurable: true, value: 320 },
    parentElement: { configurable: true, value: null },
  });
  return canvas as HTMLCanvasElement;
}

function bridge(): IPlaytestBridgeV1 {
  const value = (globalThis as Record<string, unknown>)[PLAYTEST_BRIDGE_GLOBAL];
  if (typeof value !== "object" || value === null)
    throw new Error("Playtest bridge was not installed.");
  return value as IPlaytestBridgeV1;
}

describe("playtest plugin", () => {
  it("observes the group root of a registered entity", async () => {
    const group = new Group();
    group.position.set(1, 2, 3);
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: {
        test: class extends Scene {
          override enter(ctx: ICtx) {
            ctx.entities.add("enemy", { group });
          }
        },
      },
      start: "test",
    });
    await game.start();
    try {
      const snapshot = await bridge().sample({ entities: ["enemy"] });
      expect(snapshot.entities?.find(({ id }) => id === "enemy")?.transform?.position).toEqual([
        1, 2, 3,
      ]);
    } finally {
      game.stop();
    }
  });

  it("should not advertise runtime.physics without a contributing plugin", async () => {
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    await game.start();
    try {
      expect((await bridge().describe()).capabilities).toEqual([
        "camera.observe",
        "entity.bounds",
        "entity.observe",
        "entity.setup",
        "scene.nodes",
        "scene.observe",
        "runtime.fixedStep",
        "runtime.resources",
        "runtime.animation",
        "runtime.state",
        "runtime.performance",
        "runtime.renderChain",
        "runtime.renderOnly",
        "runtime.startup",
        "runtime.contacts",
        "runtime.tags",
        "runtime.transitions",
        "runtime.audio",
        "runtime.world",
        "runtime.pipelineCensus",
        "runtime.geometry",
      ]);
    } finally {
      game.stop();
    }
  });

  it("merges and deduplicates contributed capabilities and observation slices", async () => {
    let receivedLabel: string | undefined;
    const provider: IGamePluginHooks = {
      setup: (_ctx, runtime) =>
        runtime?.observations.contribute({
          capabilities: ["runtime.components", "runtime.components"],
          sample: (request) => {
            receivedLabel = request.label;
            return { exampleSeries: [{ value: 3 }] };
          },
        }),
    };
    const game = defineGame({
      initialState: {},
      plugins: [provider, playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    await game.start();
    try {
      const description = await bridge().describe();
      expect(description.capabilities).toEqual([
        "camera.observe",
        "entity.bounds",
        "entity.observe",
        "entity.setup",
        "scene.nodes",
        "scene.observe",
        "runtime.fixedStep",
        "runtime.resources",
        "runtime.animation",
        "runtime.state",
        "runtime.performance",
        "runtime.renderChain",
        "runtime.renderOnly",
        "runtime.startup",
        "runtime.contacts",
        "runtime.tags",
        "runtime.transitions",
        "runtime.audio",
        "runtime.world",
        "runtime.components",
        "runtime.pipelineCensus",
        "runtime.geometry",
      ]);
      expect(unknownPlaytestCapabilities(description.capabilities)).toEqual([]);
      const request = { label: "after-step" } as IPlaytestSampleRequest & { label: string };
      expect(await bridge().sample(request)).toMatchObject({
        exampleSeries: [{ value: 3 }],
      });
      expect(receivedLabel).toBe("after-step");
    } finally {
      game.stop();
    }
  });

  it("fails closed when contributed observation keys collide", async () => {
    const provider: IGamePluginHooks = {
      setup: (_ctx, runtime) =>
        runtime?.observations.contribute({
          capabilities: [],
          sample: () => ({ gameplay: {} }),
        }),
    };
    const game = defineGame({
      initialState: {},
      plugins: [provider, playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    await game.start();
    try {
      await expect(bridge().sample({})).rejects.toThrow(/TN_PLAYTEST_OBSERVATION_COLLISION/u);
    } finally {
      game.stop();
    }
  });

  it("fails closed when contributed observations are not JSON-safe", async () => {
    const provider: IGamePluginHooks = {
      setup: (_ctx, runtime) =>
        runtime?.observations.contribute({
          capabilities: [],
          sample: () => ({ example: undefined }),
        }),
    };
    const game = defineGame({
      initialState: {},
      plugins: [provider, playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    await game.start();
    try {
      await expect(bridge().sample({})).rejects.toThrow(/must be JSON-safe/u);
    } finally {
      game.stop();
    }
  });

  it("reports loop frame timing and active renderer counts", async () => {
    const canvas = testCanvas();
    const callbacks: Array<(time: number) => void> = [];
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => undefined,
    });
    const game = defineGame({
      initialState: {},
      // A second plugin plays the diagnostics consumer: announcing through
      // enableRuntimeDiagnostics turns collection on without the runner-expected global,
      // which would also put the bridge into hold-until-attached.
      plugins: [
        playtest(),
        {
          setup: (_ctx, runtime) => {
            runtime?.enableRuntimeDiagnostics?.();
            return undefined;
          },
        },
      ],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          info: { render: { calls: 99, drawCalls: 7, triangles: 42 } },
          render: () => undefined,
          setSize: () => undefined,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
        }),
      },
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    try {
      await game.start();
      callbacks.shift()?.(0);
      callbacks.shift()?.(16);
      const series =
        (await bridge().sample({ include: ["runtimeDiagnosticsSeries"] }))
          .runtimeDiagnosticsSeries ?? [];
      // The frame budget is on by default, so each sample also carries its phase split.
      expect(series.every(({ phases }) => phases !== undefined)).toBe(true);
      expect(
        series.map((sample) => ({
          drawCalls: sample.drawCalls,
          frameMs: sample.frameMs,
          triangles: sample.triangles,
        })),
      ).toEqual([{ drawCalls: 7, frameMs: 16, triangles: 42 }]);
    } finally {
      game.stop();
      if (requestFrame === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: requestFrame });
      if (cancelFrame === undefined) Reflect.deleteProperty(globalThis, "cancelAnimationFrame");
      else Object.defineProperty(globalThis, "cancelAnimationFrame", { value: cancelFrame });
    }
  });

  it("observes registry entities and camera.main while advertising supplied channels only", async () => {
    const canvas = testCanvas();
    let drawingBufferReads = 0;
    class TestScene extends Scene<{ score: number }> {
      override enter(ctx: ICtx<{ score: number }>): void {
        const player = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(player);
        const animation = new AnimationPlayer({
          clips: [
            new AnimationClip("once", 1, [new NumberKeyframeTrack(".position[x]", [0, 1], [0, 1])]),
          ],
          root: player,
        });
        animation.play("once", { mode: "once" });
        animation.update(2);
        ctx.entities.add("player", { animation, mesh: player });
      }
    }
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => {
            drawingBufferReads += 1;
            return target.set(320, 180);
          },
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const installed = bridge();
      const description = await installed.describe();
      const snapshot = await installed.sample({ include: ["runtimeDiagnosticsSeries"] });
      const expected = [
        "camera.observe",
        "entity.bounds",
        "entity.observe",
        "entity.setup",
        "scene.nodes",
        "scene.observe",
        "runtime.fixedStep",
        "runtime.resources",
        "runtime.animation",
        "runtime.state",
        "runtime.performance",
        "runtime.renderChain",
        "runtime.renderOnly",
        "runtime.startup",
        "runtime.contacts",
        "runtime.tags",
        "runtime.transitions",
        "runtime.audio",
        "runtime.world",
        "runtime.pipelineCensus",
        "runtime.geometry",
      ];

      expect(description.capabilities).toEqual(expected);
      expect(snapshot.entities?.map(({ id }) => id)).toEqual(["camera.main", "player"]);
      expect(snapshot.entities?.find(({ id }) => id === "camera.main")?.transform).toBeDefined();
      expect(snapshot.gameplay).toEqual({
        animation: {
          player: {
            advancedFrames: 1,
            clip: "once",
            finished: true,
            // The stride convention is measured whether or not it applies, so it crosses the
            // bridge on every clip. This one carries no root translation, so its feet carry no
            // ground — reported as the zero it measured, not as an absent field.
            stride: {
              clipGroundSpeed: 0,
              groundSpeed: 0,
              overridden: false,
              rate: 1,
              synced: false,
            },
          },
        },
        audio: {
          cues: {},
          paused: 0,
          pooled: 0,
          queued: 0,
          recentCues: [],
          unsupported: [],
          voices: 0,
        },
        contacts: [],
        states: {},
        tags: {},
        world: { seed: null },
      });
      // `assets` is the loader's own ledger and is empty for a scene that loads none.
      expect(snapshot.resources).toEqual({
        __threenativeFrameCounts: { updates: 0, renders: 0 },
        GameState: { score: 0 },
        assets: {},
        state: { score: 0 },
      });
      expect(snapshot.runtimeDiagnosticsSeries).toEqual([]);
      expect(drawingBufferReads).toBeGreaterThan(0);
    } finally {
      game.stop();
    }
  });

  it("exposes registry fields as components only when fields exist", async () => {
    const canvas = testCanvas();
    class TestScene extends Scene {
      override enter(ctx: ICtx): void {
        const player = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(player);
        ctx.entities.add("player", { debug: () => ({ health: 2 }), mesh: player });
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const installed = bridge();
      expect((await installed.describe()).capabilities).toContain("runtime.components");
      expect((await installed.sample({})).components).toEqual({ player: { health: 2 } });
    } finally {
      game.stop();
    }
  });

  it("publishes registry tags and drained contacts through gameplay channels", async () => {
    const canvas = testCanvas();
    const body = {};
    const area = {
      drainContacts: () => [{ body, entity: "coin.3", started: true }],
    };
    class TestScene extends Scene {
      override enter(ctx: ICtx): void {
        const fox = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        const coin = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(fox);
        ctx.add(coin);
        ctx.entities.add("fox", { mesh: fox, physics: { rigidBody: body } });
        ctx.entities.add("coin.3", { mesh: coin, physics: { area }, tags: ["coin"] });
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const gameplay = (await bridge().sample({})).gameplay;
      expect(gameplay?.contacts).toEqual([{ entity: "fox", kind: "trigger", with: "coin.3" }]);
      expect(gameplay?.tags).toEqual({ coin: { count: 1 } });
    } finally {
      game.stop();
    }
  });

  it("clears contact history on goto and bounds one oversized contact drain", async () => {
    const canvas = testCanvas();
    const body = {};
    let navigate: ((name: string) => Promise<void>) | undefined;
    class FirstScene extends Scene {
      override enter(ctx: ICtx): void {
        const first = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        const area = {
          drainContacts: () =>
            Array.from({ length: PLAYTEST_PROTOCOL_LIMITS.maxEventsPerDrain + 25 }, (_, index) => ({
              body,
              entity: `coin.${index}`,
              started: true,
            })),
        };
        ctx.add(first);
        ctx.entities.add("first", { mesh: first, physics: { area, rigidBody: body } });
        navigate = ctx.goto;
      }
    }
    class SecondScene extends Scene {
      override enter(ctx: ICtx): void {
        const second = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(second);
        ctx.entities.add("second", { mesh: second });
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: stubRenderer(canvas),
      scenes: { first: FirstScene, second: SecondScene },
      start: "first",
    });

    await game.start();
    try {
      const before = await bridge().sample({});
      expect(before.gameplay?.contacts).toHaveLength(PLAYTEST_PROTOCOL_LIMITS.maxEventsPerDrain);
      expect(before.gameplay?.contacts?.[0]?.with).toBe("coin.25");
      if (navigate === undefined) throw new Error("First scene did not expose ctx.goto.");
      await navigate("second");
      expect((await bridge().sample({})).gameplay?.contacts).toEqual([]);
    } finally {
      game.stop();
    }
  });

  it("advances four ordered update/world-render pairs when asked to render, and suppresses queued automatic draws", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    let failUpdate = false;
    let failRender = false;
    const callbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    class TestScene extends Scene<Record<string, unknown>> {
      override update(): void {
        if (failUpdate) throw new Error("scene update failed");
        events.push("update");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
          render: () => {
            if (failRender) throw new Error("world render failed");
            events.push("world");
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const installed = bridge();
      await installed.advance?.(4, { render: true });
      expect(events).toEqual(Array.from({ length: 4 }, () => ["update", "world"]).flat());
      const sample = await installed.sample({ resources: ["__threenativeFrameCounts"] });
      expect(sample.clock).toEqual({ mode: "fixed-step", tick: 4 });
      expect(sample.resources?.__threenativeFrameCounts).toEqual({ updates: 4, renders: 4 });
      const scheduled = callbacks.length;
      callbacks[0]?.(1_000);
      expect(callbacks).toHaveLength(scheduled);
      expect(events).toHaveLength(8);
      await installed.advance?.(1, { render: false });
      expect(events.at(-1)).toBe("update");
      expect(
        (await installed.sample({ resources: ["__threenativeFrameCounts"] })).resources
          ?.__threenativeFrameCounts,
      ).toEqual({ updates: 5, renders: 4 });
      expect(sample.resources?.__threenativeFrameCounts).toEqual({ updates: 4, renders: 4 });
      game.pause();
      await installed.advance?.(1, { render: true });
      expect((await installed.sample({})).resources?.__threenativeFrameCounts).toEqual({
        updates: 5,
        renders: 5,
      });
      game.resume();
      failUpdate = true;
      await expect(installed.advance?.(1, { render: true })).rejects.toThrow("scene update failed");
      expect((await installed.sample({})).resources?.__threenativeFrameCounts).toEqual({
        updates: 5,
        renders: 5,
      });
      failUpdate = false;
      failRender = true;
      await expect(installed.advance?.(1, { render: true })).rejects.toThrow("world render failed");
      expect((await installed.sample({})).resources?.__threenativeFrameCounts).toEqual({
        updates: 6,
        renders: 5,
      });
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("advances without drawing a world frame unless the caller asks for one", async () => {
    const canvas = testCanvas();
    const events: string[] = [];
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    class TestScene extends Scene<Record<string, unknown>> {
      override update(): void {
        events.push("update");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
          render: () => {
            events.push("world");
          },
          setSize: () => undefined,
        }),
      },
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const installed = bridge();
      const drawn = events.filter((event) => event === "world").length;
      await installed.advance?.(4);
      expect(events.filter((event) => event === "update")).toHaveLength(4);
      expect(events.filter((event) => event === "world")).toHaveLength(drawn);
      await installed.advance?.(2, { render: true });
      expect(events.filter((event) => event === "world")).toHaveLength(drawn + 2);
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("keeps per-tick contacts and transitions without snapshotting entity diagnostics", async () => {
    const canvas = testCanvas();
    const body = {};
    let debugCalls = 0;
    let drained = false;
    let updates = 0;
    const area = {
      drainContacts: () => {
        if (drained) return [];
        drained = true;
        return [{ body, entity: "player", started: true }];
      },
    };
    class TestScene extends Scene<{ score: number }> {
      override enter(ctx: ICtx<{ score: number }>): void {
        ctx.entities.add("player", {
          debug: () => {
            debugCalls += 1;
            return { health: 100 };
          },
          physics: { rigidBody: body },
        });
        ctx.entities.add("trigger", { physics: { area } });
      }

      override update(ctx: ICtx<{ score: number }>): void {
        updates += 1;
        if (updates === 2) ctx.state.set({ score: 1 });
      }
    }
    const game = defineGame({
      initialState: { score: 0 },
      plugins: [playtest()],
      renderer: stubRenderer(canvas),
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      await bridge().advance?.(2);

      expect(debugCalls).toBe(0);
      const sampled = await bridge().sample({});
      expect(debugCalls).toBeGreaterThan(0);
      expect(sampled.gameplay?.contacts).toContainEqual({
        entity: "player",
        kind: "trigger",
        tick: 0,
        with: "player",
      });
      expect(sampled.gameplay?.transitions).toContainEqual({
        from: 0,
        path: "state.score",
        tick: 1,
        to: 1,
      });
    } finally {
      game.stop();
    }
  });

  it("should re-register only the active scene entities after goto", async () => {
    const canvas = testCanvas();
    let navigate: ((name: string) => Promise<void>) | undefined;

    class FirstScene extends Scene {
      override enter(ctx: ICtx): void {
        const first = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(first);
        const body = {};
        const area = { drainContacts: () => [{ body, entity: "old-contact", started: true }] };
        ctx.entities.add("first", { mesh: first, physics: { area, rigidBody: body } });
        navigate = ctx.goto;
      }
    }

    class SecondScene extends Scene {
      override enter(ctx: ICtx): void {
        const second = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(second);
        ctx.entities.add("second", { mesh: second });
      }
    }

    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
          render: () => undefined,
          setSize: () => undefined,
        }),
      },
      scenes: { first: FirstScene, second: SecondScene },
      start: "first",
    });

    await game.start();
    try {
      if (navigate === undefined) throw new Error("First scene did not expose ctx.goto.");
      expect((await bridge().sample({})).gameplay?.contacts).toEqual([
        { entity: "first", kind: "trigger", with: "old-contact" },
      ]);
      await navigate("second");
      const snapshot = await bridge().sample({});
      expect(snapshot.entities?.map(({ id }) => id)).toEqual(["camera.main", "second"]);
      expect(snapshot.gameplay?.contacts).toEqual([]);
    } finally {
      game.stop();
    }
  });

  it("publishes where every asset was served from, addressed by its logical path", async () => {
    // The record a scenario asserts on. It has to survive the bridge's JSON serialisation on
    // every target, and it has to be addressable by a dotted observation path even though the
    // logical path it is keyed by is itself dotted.
    vi.stubGlobal("document", {
      body: { append: () => undefined },
      location: { href: "file:///game.html" },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.endsWith("assets.manifest.json")
          ? Response.json({
              entries: { "native-proof.png": { output: "native-proof.a1b2c3.png" } },
              version: 1,
            })
          : new Response(new Uint8Array([137, 80, 78, 71])),
      ),
    );
    class LoadingScene extends Scene {
      override async load(ctx: ICtx): Promise<void> {
        await ctx.assets.texture("native-proof.png");
      }
    }
    const game = defineGame({
      // The decode is stubbed; the url the manifest named is the thing under test.
      assets: { texture: async () => new Texture() },
      initialState: {},
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { load: LoadingScene },
      start: "load",
    });

    await game.start();
    try {
      const resources = (await bridge().sample({})).resources;
      expect(resources?.assets).toEqual({
        "native-proof": { png: { url: "native-proof.a1b2c3.png", via: "manifest" } },
      });
      // Read the way `assert.resources` does: split the path on dots and walk the value.
      const read = (path: string): unknown =>
        path.split(".").reduce<unknown>((value, part) => {
          if (typeof value !== "object" || value === null) return undefined;
          return (value as Record<string, unknown>)[part];
        }, resources?.assets);
      expect(read("native-proof.png.via")).toBe("manifest");
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("keeps state resource snapshots stable across a scene goto", async () => {
    type ScreenState = { characterName: string; screen: "menu" | "play" };
    class MenuScene extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "menu" };
    }
    class PlayScene extends Scene<ScreenState> {
      static override readonly initialState: ScreenState = { characterName: "", screen: "play" };
    }
    const game = defineGame<ScreenState>({
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { menu: MenuScene, play: PlayScene },
      start: "menu",
    });

    await game.start();
    try {
      const before = await bridge().sample({});
      await game.goto("play", { carry: { characterName: "Axo" } });
      const after = await bridge().sample({});
      expect(before.resources?.state).toEqual({ characterName: "", screen: "menu" });
      expect(after.resources?.state).toEqual({ characterName: "Axo", screen: "play" });
    } finally {
      game.stop();
    }
  });
});

function stubRenderer(canvas: HTMLCanvasElement) {
  return {
    canvas,
    preferWebGPU: false,
    webgl2Factory: () => ({
      dispose: () => undefined,
      domElement: canvas,
      getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
      render: () => undefined,
      setSize: () => undefined,
    }),
  };
}

describe("playtest holdUntilAttached", () => {
  it("applies runner setup before the real start scene enters", async () => {
    const canvas = testCanvas();
    const authoritativeBody = { position: [0, 1.6, 0] as [number, number, number] };
    const events: string[] = [];
    class SetupScene extends Scene {
      override load(ctx: ICtx): void {
        const placeholder = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        placeholder.position.set(0, 1.6, 0);
        ctx.add(placeholder);
        ctx.entities.add("player", placeholder);
        events.push("load");
      }

      override enter(ctx: ICtx): void {
        const placeholder = ctx.entities.get<Mesh>("player");
        if (placeholder === undefined) throw new Error("Player placeholder was not registered.");
        authoritativeBody.position = placeholder.position.toArray() as [number, number, number];
        events.push("enter");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(canvas),
      scenes: { main: SetupScene },
      start: "main",
    });
    const started = game.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(["load"]);
      const installed = bridge();
      if (installed.applySetup === undefined) throw new Error("Setup channel was not installed.");
      const confirmation = await installed.applySetup({
        entities: [{ entity: "player", transform: { position: [7, 2.5, -3] } }],
      });
      // The held wrapper hands the bridge's read-back to the runner (a desktop mailbox needs JSON, not void).
      expect(confirmation).toEqual({ entities: ["player"], resources: [] });
      const description = await installed.describe();
      events.push("describe returned");
      await started;

      expect(authoritativeBody.position).toEqual([7, 2.5, -3]);
      expect(events).toEqual(["load", "enter", "describe returned"]);
      expect(description.capabilities).toContain("runtime.components");
    } finally {
      game.stop();
    }
  });

  it("waits for an async load to register entities before it applies setup", async () => {
    let finishLoad: () => void = () => undefined;
    const loading = new Promise<void>((resolve) => {
      finishLoad = resolve;
    });
    let entered: number[] | undefined;
    class AsyncScene extends Scene {
      override async load(ctx: ICtx): Promise<void> {
        // A texture or model fetch: the runner's setup arrives while this await is pending.
        await loading;
        const placeholder = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(placeholder);
        ctx.entities.add("player", placeholder);
      }

      override enter(ctx: ICtx): void {
        entered = ctx.entities.get<Mesh>("player")?.position.toArray();
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(testCanvas()),
      scenes: { main: AsyncScene },
      start: "main",
    });
    const started = game.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const installed = bridge();
      if (installed.applySetup === undefined) throw new Error("Setup channel was not installed.");
      const applied = installed.applySetup({
        entities: [{ entity: "player", transform: { position: [4, 1, -2] } }],
      });
      finishLoad();
      expect(await applied).toEqual({ entities: ["player"], resources: [] });
      await installed.describe();
      await started;
      expect(entered).toEqual([4, 1, -2]);
    } finally {
      game.stop();
    }
  });

  it("holds a native endpoint run until its no-setup describe handshake", async () => {
    const host = globalThis as Record<string, unknown>;
    const previousEndpoint = host.TN_PLAYTEST_ENDPOINT;
    host.TN_PLAYTEST_ENDPOINT = "native://test-mailbox";
    const events: string[] = [];
    class NativeScene extends Scene {
      override load(): void {
        events.push("load");
      }

      override enter(ctx: ICtx): void {
        ctx.entities.add("native-player", {
          health: 100,
          mesh: new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()),
        });
        events.push("enter");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(testCanvas()),
      scenes: { main: NativeScene },
      start: "main",
    });
    const started = game.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(events).toEqual(["load"]);
      const description = await bridge().describe();
      events.push("describe returned");
      await started;

      expect(events).toEqual(["load", "enter", "describe returned"]);
      expect(description.capabilities).toContain("runtime.components");
    } finally {
      game.stop();
      if (previousEndpoint === undefined) Reflect.deleteProperty(host, "TN_PLAYTEST_ENDPOINT");
      else host.TN_PLAYTEST_ENDPOINT = previousEndpoint;
    }
  });

  it("describes the world of the scene entered after the start scene", async () => {
    // Every `boot` template navigates out of its start scene inside `enter()`, and the scene it
    // lands in owns the entities. When that scene's `load()` awaits an asset, the handshake used to
    // return the moment the *start* scene entered: the registry was empty, so `runtime.components`
    // was never advertised and every scenario needing it failed TN_PLAYTEST_CAPABILITY_MISSING.
    const events: string[] = [];
    let releaseSky: (() => void) | undefined;
    const sky = new Promise<void>((resolve) => {
      releaseSky = resolve;
    });
    class Boot extends Scene {
      override enter(ctx: ICtx): void {
        events.push("boot enter");
        void ctx.goto("race");
      }
    }
    class Race extends Scene {
      override async load(): Promise<void> {
        events.push("race load");
        await sky;
      }

      override enter(ctx: ICtx): void {
        ctx.entities.add("player", {
          health: 100,
          mesh: new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()),
        });
        events.push("race enter");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(testCanvas()),
      scenes: { boot: Boot, race: Race },
      start: "boot",
    });
    const started = game.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const described = bridge().describe();
      await new Promise((resolve) => setTimeout(resolve, 50));
      // The race scene is still loading, so a description taken now has nothing to describe.
      expect(events).toEqual(["boot enter", "race load"]);
      expect(await Promise.race([described, Promise.resolve("pending")])).toBe("pending");

      releaseSky?.();
      const description = await described;
      events.push("describe returned");
      await started;

      expect(events).toEqual(["boot enter", "race load", "race enter", "describe returned"]);
      expect(description.capabilities).toContain("runtime.components");
    } finally {
      game.stop();
    }
  });

  it("collects per-frame render samples for a native endpoint run", async () => {
    // The device and desktop lanes never set the browser's runner-expected global: a native host
    // announces itself through `TN_PLAYTEST_ENDPOINT`, which is why this run carries one and not
    // the other. Collection used to key off the browser half alone, so a `--target desktop` run
    // answered an advertised `runtime.performance` with an empty series and every
    // `assert.performance` on a native target failed as unobserved. Nothing here calls
    // `enableRuntimeDiagnostics`; the announcement is the only switch.
    const host = globalThis as Record<string, unknown>;
    const previousEndpoint = host.TN_PLAYTEST_ENDPOINT;
    host.TN_PLAYTEST_ENDPOINT = "native://test-mailbox";
    const canvas = testCanvas();
    const callbacks: Array<(time: number) => void> = [];
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => undefined,
    });
    const game = defineGame({
      initialState: {},
      // The boot hold is the neighbouring test's subject; this one is about collection, and
      // holding would need a describe handshake to release it.
      plugins: [playtest({ holdUntilAttached: false })],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          info: { render: { calls: 99, drawCalls: 7, triangles: 42 } },
          render: () => undefined,
          setSize: () => undefined,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
        }),
      },
      scenes: { test: class extends Scene {} },
      start: "test",
    });

    try {
      await game.start();
      // Enough frames to leave the first (zero-delta) frame behind: the series is one sample per
      // presented frame with a positive delta, so a single frame proves nothing either way.
      for (let i = 0; i < 6; i++) callbacks.shift()?.(i * 16);
      const series =
        (await bridge().sample({ include: ["runtimeDiagnosticsSeries"] }))
          .runtimeDiagnosticsSeries ?? [];
      // A non-empty series, not `every(...)` on an empty array: a vacuous green here is the
      // defect this test exists for.
      expect(series.length).toBeGreaterThan(0);
      expect(series.every(({ phases }) => phases !== undefined)).toBe(true);
    } finally {
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousEndpoint === undefined) Reflect.deleteProperty(host, "TN_PLAYTEST_ENDPOINT");
      else host.TN_PLAYTEST_ENDPOINT = previousEndpoint;
    }
  });

  it("negotiates an autonomous pose window and restores the fixed clock on teardown", async () => {
    const host = globalThis as Record<string, unknown>;
    const previousEndpoint = host[PLAYTEST_RUNNER_EXPECTED_GLOBAL];
    host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = true;
    const callbacks = new Map<number, (time: number) => void>();
    let handle = 0;
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        callbacks.set(++handle, callback);
        return handle;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: (id: number) => {
        callbacks.delete(id);
      },
    });
    const canvas = testCanvas();
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: false })],
      renderer: stubRenderer(canvas),
      scenes: { test: class extends Scene {} },
      start: "test",
    });
    try {
      await game.start();
      await bridge().advance?.(2);
      const control = bridge() as IPlaytestBridgeV1 & {
        _clockEpoch: number;
        _setClockMode(mode: unknown): { mode: string; tick: number; epoch: number };
      };
      const pump = (time: number): void => {
        const entry = callbacks.entries().next().value;
        expect(entry).toBeDefined();
        if (entry === undefined) return;
        callbacks.delete(entry[0]);
        entry[1](time);
      };
      expect(control._setClockMode("wall-clock")).toEqual({
        mode: "wall-clock",
        tick: 2,
        epoch: 1,
      });
      expect(callbacks.size).toBe(1);
      pump(100_000);
      pump(100_020);
      expect(control._setClockMode("wall-clock")).toEqual({
        mode: "wall-clock",
        tick: 3,
        epoch: 1,
      });
      expect((await bridge().sample({})).clock).toMatchObject({ mode: "wall-clock", tick: 3 });
      expect((await bridge().describe()).capabilities).toContain("runtime.fixedStep");
      expect(await bridge().ready?.()).toMatchObject({ ready: true });
      expect(control._clockEpoch).toBe(1);
      expect(() => control._setClockMode("invalid")).toThrow(/clock mode/iu);
      expect(control._setClockMode("fixed-step")).toEqual({
        mode: "fixed-step",
        tick: 3,
        epoch: 2,
      });
      pump(200_000);
      await bridge().advance?.(2);
      expect((await bridge().sample({})).clock).toMatchObject({ mode: "fixed-step", tick: 5 });
      expect((await bridge().describe()).capabilities).toContain("runtime.fixedStep");
      expect(await bridge().ready?.()).toMatchObject({ ready: true });
      control._setClockMode("wall-clock");
      game.stop();
      expect(control._clockEpoch).toBe(4);
      expect(callbacks.size).toBe(0);
      expect(() => control._setClockMode("wall-clock")).toThrow(/disposed/iu);
    } finally {
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousEndpoint === undefined)
        Reflect.deleteProperty(host, PLAYTEST_RUNNER_EXPECTED_GLOBAL);
      else host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = previousEndpoint;
    }
  });

  it("freezes the live clock for an announced runner, so live frames cannot advance the run", async () => {
    // The runner holds the boot and then pumps live frames through the startup compile wait.
    // Every one of those frames used to run `onUpdate` off wall clock, so a tick-counting
    // scenario began with game time it never asked for: racing's 3-lap outcome needs 47s of a
    // 90s limit and DNFs early when the loaded startup wait spends the rest. The announcement is
    // the switch, and the manual clock stays the only thing that moves the simulation.
    const host = globalThis as Record<string, unknown>;
    const previousEndpoint = host.TN_PLAYTEST_ENDPOINT;
    host.TN_PLAYTEST_ENDPOINT = "native://test-mailbox";
    let updates = 0;
    const dts: number[] = [];
    const canvas = testCanvas();
    const callbacks: Array<(time: number) => void> = [];
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        callbacks.push(callback);
        return callbacks.length;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => undefined,
    });
    class CountingScene extends Scene {
      override update(_ctx: unknown, dt: number): void {
        updates += 1;
        dts.push(dt);
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: false })],
      renderer: {
        canvas,
        preferWebGPU: false,
        webgl2Factory: () => ({
          dispose: () => undefined,
          domElement: canvas,
          info: { render: { calls: 0, drawCalls: 0, triangles: 0 } },
          render: () => undefined,
          setSize: () => undefined,
          getDrawingBufferSize: (target: Vector2) => target.set(320, 180),
        }),
      },
      scenes: { test: CountingScene },
      start: "test",
    });

    try {
      await game.start();
      // Two seconds of live frames: 120 updates if the wall clock still drove the loop. What is
      // left is the frozen clock's fixed settling pass, so the scene still lays out its per-frame
      // state — a game whose camera-parented overlay is placed in `update` reads `NaN` bounds
      // without it — and no real second reaches the simulation.
      for (let i = 0; i < 120; i++) callbacks.shift()?.(i * 16.6667);
      expect(updates).toBe(60);
      expect(new Set(dts)).toEqual(new Set([1 / 60]));

      // The runner's own advance is what moves the simulation from here.
      await bridge().advance?.(3);
      expect(updates).toBe(63);
      for (let i = 120; i < 240; i++) callbacks.shift()?.(i * 16.6667);
      expect(updates).toBe(63);
    } finally {
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousEndpoint === undefined) Reflect.deleteProperty(host, "TN_PLAYTEST_ENDPOINT");
      else host.TN_PLAYTEST_ENDPOINT = previousEndpoint;
    }
  });

  it("runs a live-clock run on the wall clock, and reports that it did", async () => {
    // A production profile *is* a playtest run, so the loop froze and the runner's ticks arrived in
    // bursts of ten. Every frame the host presented between two bursts repeated one standing state,
    // so a browser collection reported ~60 fps for a platformer whose movement was advancing about
    // six times a second — a frame rate for a game that was not playing. The opt-in is one global
    // carrying the protocol's own clock vocabulary, and a run on it has to say so: a rate read off a
    // frozen clock is not a frame rate.
    const host = globalThis as Record<string, unknown>;
    const previousAnnouncement = host[PLAYTEST_RUNNER_EXPECTED_GLOBAL];
    const previousClock = host.__THREENATIVE_PLAYTEST_CLOCK__;
    host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = true;
    // The wire name, written literally because the other end of it is the production profiler's
    // injected instrumentation, not this package: a test importing the constant would follow a
    // rename on both sides at once and prove nothing about the contract between them.
    host.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
    let updates = 0;
    const canvas = testCanvas();
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    let handles = 0;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      // A host pump rather than the test's hand: the claim under test is that wall time moves the
      // loop, and that needs frames arriving on their own the way a presented frame does.
      value: (callback: (time: number) => void) => {
        handles += 1;
        const handle = handles;
        setTimeout(() => callback(performance.now()), 1);
        return handle;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => undefined,
    });
    class CountingScene extends Scene {
      override update(): void {
        updates += 1;
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: false })],
      renderer: stubRenderer(canvas),
      scenes: { test: CountingScene },
      start: "test",
    });

    try {
      await game.start();
      // Let the first frames land before reading the baseline: a frozen clock spends one settling
      // pass there, and counting that as live gameplay would be exactly the mistake.
      await new Promise((resolve) => setTimeout(resolve, 60));
      // 250 ms of the host's own frames is fifteen fixed steps of gameplay. The frozen clock settles
      // once and then simulates nothing at all, which is the number the profile was publishing.
      const settled = updates;
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(updates - settled).toBeGreaterThanOrEqual(10);

      // `advance` is the runner's own tick pump, and on this clock it delivers the wall time those
      // ticks cover instead of stepping the loop: the host kept presenting frames throughout.
      const advanced = await bridge().advance?.(3);
      expect(advanced?.clock.mode).toBe("wall-clock");
      expect(advanced?.ticks ?? 0).toBeGreaterThan(0);
      // Nothing refroze the clock afterwards — a live run's ticks keep arriving from real frames.
      const afterAdvance = updates;
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(updates).toBeGreaterThan(afterAdvance);
      const snapshot = await bridge().sample({});
      expect(snapshot.clock.mode).toBe("wall-clock");
      // Seconds, not just a step count: the runner reads `timeMs` for every mode that is not
      // fixed-step, so a live run reporting only a tick would leave its rates unmeasured.
      expect(typeof snapshot.clock.timeMs).toBe("number");
    } finally {
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousAnnouncement === undefined)
        Reflect.deleteProperty(host, PLAYTEST_RUNNER_EXPECTED_GLOBAL);
      else host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = previousAnnouncement;
      if (previousClock === undefined)
        Reflect.deleteProperty(host, "__THREENATIVE_PLAYTEST_CLOCK__");
      else host.__THREENATIVE_PLAYTEST_CLOCK__ = previousClock;
    }
  });

  it("waits for the host's own tick when a one-tick live advance outruns the frame it names", async () => {
    // A one-tick request names exactly one frame interval, so on a host presenting at 58 mean fps
    // the wait ended microseconds before the next frame and the 2026-09-28 desktop pair failed with
    // "wall-clock advance moved no tick in 1 step(s) of wall time" — refused for the frame it was
    // about to be given. The tick has to come from the pump, and only a pump that has genuinely
    // stopped may end the wait without one.
    const host = globalThis as Record<string, unknown>;
    const previousAnnouncement = host[PLAYTEST_RUNNER_EXPECTED_GLOBAL];
    const previousClock = host.__THREENATIVE_PLAYTEST_CLOCK__;
    host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = true;
    host.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
    let updates = 0;
    let slowUpdates = 0;
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    class CountingScene extends Scene {
      override update(): void {
        updates += 1;
      }
    }
    // A second host with its own frame counter, so a frame it presented is counted on it and not on
    // whichever host happens to share the counter above.
    class SlowCountingScene extends Scene {
      override update(): void {
        slowUpdates += 1;
      }
    }
    // A host whose own pump presents every `gapMs`. 25 ms is a third later than the 16.67 ms one
    // tick names — the host the pair failed on — 60 ms is the cadence the 2026-10-04 auto-exposure
    // CI host measured before run 37183659465 refused its ninth case, and a million is a pump that
    // never presents again. The scene is a parameter so each host is counted on its own counter.
    const lateHost = (gapMs: number, HostScene: typeof CountingScene = CountingScene) => {
      let handles = 0;
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: (callback: (time: number) => void) => {
          handles += 1;
          const handle = handles;
          setTimeout(() => callback(performance.now()), gapMs);
          return handle;
        },
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: () => undefined,
      });
      return defineGame({
        initialState: {},
        plugins: [playtest({ holdUntilAttached: false })],
        renderer: stubRenderer(testCanvas()),
        scenes: { test: HostScene },
        start: "test",
      });
    };
    const game = lateHost(25);
    let slow: ReturnType<typeof lateHost> | undefined;
    let batch: ReturnType<typeof lateHost> | undefined;
    let stopped: ReturnType<typeof lateHost> | undefined;

    try {
      await game.start();
      // Let the pump present before reading the baseline, so the frames the wait is about to miss
      // are frames of a running game and not of a boot.
      await new Promise((resolve) => setTimeout(resolve, 60));
      const before = updates;
      const advanced = await bridge().advance?.(1);
      expect(advanced?.clock.mode).toBe("wall-clock");
      expect(advanced?.ticks ?? 0).toBeGreaterThanOrEqual(1);
      // Host-driven, not stepped here: the tick the report names is one this host's pump ran.
      expect(updates).toBeGreaterThan(before);

      // The same one-tick request on a host presenting at 60 ms, which is the cadence the 2026-10-04
      // CI host measured. The span a tick names is 16.67 ms, so the wait has to outlive one whole
      // frame at that cadence and not just the 25 ms pair's: four half-step slices ended at 50 ms
      // and the bridge read that slow pump as a dead one, failing the run on its ninth case. This
      // host is built after the first one has been measured, because building it is what takes over
      // the cadence of the one pump both share.
      slow = lateHost(60, SlowCountingScene);
      await slow.start();
      // Read the baseline the instant this host's first frame lands rather than after a fixed
      // settle, so the wait below always begins with a whole frame interval left to present the next
      // one. Sleeping instead would start the advance at an arbitrary point of the 60 ms cadence and
      // pass half the time against the four slices this case exists to fail.
      while (slowUpdates === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const beforeSlow = slowUpdates;
      const slowAdvanced = await bridge().advance?.(1);
      expect(slowAdvanced?.clock.mode).toBe("wall-clock");
      expect(slowAdvanced?.ticks ?? 0).toBeGreaterThanOrEqual(1);
      expect(slowUpdates).toBeGreaterThan(beforeSlow);

      // And a batch on a host slower than the room the wait buys past its span. The runner counts a
      // wait in ten-tick pieces, so the 166 ms span of `advance(10)` asked a host presenting every
      // 400 ms for a tick inside 200 ms — the failure Machinefall's map-walk standing scene reported
      // under `--live-clock` at load average 142. A measurement whose subject is a slow machine
      // cannot refuse to measure one.
      batch = lateHost(400);
      await batch.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const batched = await bridge().advance?.(10);
      expect(batched?.clock.mode).toBe("wall-clock");
      expect(batched?.ticks ?? 0).toBeGreaterThanOrEqual(1);

      // The bound is real, so a pump that has stopped is still a failed run rather than a wait: the
      // bridge reports the zero this hands back.
      stopped = lateHost(1e6);
      await stopped.start();
      await expect(bridge().advance?.(1)).rejects.toThrow(/moved no tick in 1 step/u);
    } finally {
      stopped?.stop();
      batch?.stop();
      slow?.stop();
      game.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousAnnouncement === undefined)
        Reflect.deleteProperty(host, PLAYTEST_RUNNER_EXPECTED_GLOBAL);
      else host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = previousAnnouncement;
      if (previousClock === undefined)
        Reflect.deleteProperty(globalThis, "__THREENATIVE_PLAYTEST_CLOCK__");
      else host.__THREENATIVE_PLAYTEST_CLOCK__ = previousClock;
    }
  });

  it("names the clock this loop really runs on, so no request can make a frozen loop report the wall clock", async () => {
    // The browser half of the production profile: `--live-clock` puts the request in an
    // `addInitScript`, ahead of every page script, so it is set before the game's own module
    // evaluates — which is the only moment this decision can be taken for the whole run. Set there,
    // the host's pump drives the loop and `advance` names the ticks that pump really ran. Set later
    // (a page whose own script installs a bridge, a hand-edited index.html the runner never saw),
    // the loop is already frozen, and the honest answer is still `fixed-step`: the same verdict the
    // bridge used to derive for itself, and the only one a rate read off it deserves.
    const host = globalThis as Record<string, unknown>;
    const previousAnnouncement = host[PLAYTEST_RUNNER_EXPECTED_GLOBAL];
    const previousClock = host.__THREENATIVE_PLAYTEST_CLOCK__;
    host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = true;
    let updates = 0;
    class CountingScene extends Scene {
      override update(): void {
        updates += 1;
      }
    }
    // A host whose own pump presents frames, so "the clock ran" is measurable rather than assumed.
    const requestFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    let handles = 0;
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: (time: number) => void) => {
        handles += 1;
        const handle = handles;
        setTimeout(() => callback(performance.now()), 16);
        return handle;
      },
    });
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      value: () => undefined,
    });
    const countingGame = () =>
      defineGame({
        initialState: {},
        plugins: [playtest({ holdUntilAttached: false })],
        renderer: stubRenderer(testCanvas()),
        scenes: { test: CountingScene },
        start: "test",
      });
    const live = countingGame();
    const late = countingGame();

    try {
      // Set before the game starts: the wall clock, and the ticks its pump ran rather than the count
      // asked for.
      host.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
      await live.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const advanced = await bridge().advance?.(1);
      expect(advanced?.clock.mode).toBe("wall-clock");
      expect(advanced?.ticks ?? 0).toBeGreaterThanOrEqual(1);
      live.stop();

      // Set after it: the loop was frozen by the install, so the count is the exact one requested.
      Reflect.deleteProperty(host, "__THREENATIVE_PLAYTEST_CLOCK__");
      await late.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      const frozen = updates;
      host.__THREENATIVE_PLAYTEST_CLOCK__ = "wall-clock";
      const stepped = await bridge().advance?.(1);
      expect(stepped?.clock.mode).toBe("fixed-step");
      expect(stepped?.ticks).toBe(1);
      expect(updates).toBe(frozen + 1);
    } finally {
      late.stop();
      live.stop();
      Object.defineProperty(globalThis, "requestAnimationFrame", {
        configurable: true,
        value: requestFrame,
      });
      Object.defineProperty(globalThis, "cancelAnimationFrame", {
        configurable: true,
        value: cancelFrame,
      });
      if (previousAnnouncement === undefined)
        Reflect.deleteProperty(host, PLAYTEST_RUNNER_EXPECTED_GLOBAL);
      else host[PLAYTEST_RUNNER_EXPECTED_GLOBAL] = previousAnnouncement;
      if (previousClock === undefined)
        Reflect.deleteProperty(globalThis, "__THREENATIVE_PLAYTEST_CLOCK__");
      else host.__THREENATIVE_PLAYTEST_CLOCK__ = previousClock;
    }
  });

  it("fails the held start immediately when setup application fails", async () => {
    let entered = false;
    class FailingSetupScene extends Scene {
      override enter(): void {
        entered = true;
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(testCanvas()),
      scenes: { main: FailingSetupScene },
      start: "main",
    });
    const started = game.start();

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const installed = bridge();
      if (installed.applySetup === undefined) throw new Error("Setup channel was not installed.");
      await expect(
        installed.applySetup({
          entities: [{ entity: "missing", transform: { position: [1, 2, 3] } }],
        }),
      ).rejects.toThrow(/missing/u);
      await expect(started).rejects.toThrow(/missing/u);
      expect(entered).toBe(false);
    } finally {
      game.stop();
    }
  });

  it("does not start the loop until a runner calls describe", async () => {
    const canvas = testCanvas();
    let steps = 0;
    class CountingScene extends Scene<{ score: number }> {
      override update(): void {
        steps += 1;
      }
    }
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 5_000 })],
      renderer: stubRenderer(canvas),
      scenes: { main: CountingScene },
      start: "main",
    });
    const started = game.start();
    let settled = false;
    void started.then(() => {
      settled = true;
    });

    // The bridge is installed, but start() must still be pending: nothing has attached.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);
    expect(steps).toBe(0);

    await bridge().describe();
    await started;
    expect(settled).toBe(true);
    await game.stop();
  });

  it("fails closed when no runner attaches before the timeout", async () => {
    const canvas = testCanvas();
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest({ holdUntilAttached: true, attachTimeoutMs: 40 })],
      renderer: stubRenderer(canvas),
      scenes: { main: class extends Scene<{ score: number }> {} },
      start: "main",
    });
    await expect(game.start()).rejects.toThrow(/TN_PLAYTEST_ATTACH_TIMEOUT/u);
    await game.stop();
  });

  it("rejects a non-positive attach timeout instead of holding forever", async () => {
    const canvas = testCanvas();
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest({ attachTimeoutMs: 0, holdUntilAttached: true })],
      renderer: stubRenderer(canvas),
      scenes: { main: class extends Scene<{ score: number }> {} },
      start: "main",
    });
    await expect(game.start()).rejects.toThrow(/TN_PLAYTEST_ATTACH_TIMEOUT_INVALID/u);
    await game.stop();
  });

  it("answers a geometry capture through the real bridge without disturbing other observations", async () => {
    const canvas = testCanvas();
    class TestScene extends Scene<{ score: number }> {
      override enter(ctx: ICtx<{ score: number }>): void {
        const player = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
        ctx.add(player);
        ctx.entities.add("player", { mesh: player });
      }
    }
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest()],
      renderer: stubRenderer(canvas),
      scenes: { test: TestScene },
      start: "test",
    });

    await game.start();
    try {
      const installed = bridge();
      const description = await installed.describe();
      expect(description.capabilities).toContain("runtime.geometry");

      const withoutCapture = await installed.sample({});
      // Absent means absent: a sample that did not ask for a capture must not carry an empty one.
      expect(Object.hasOwn(withoutCapture, "geometry")).toBe(false);
      expect(withoutCapture.entities?.map(({ id }) => id)).toContain("player");

      const requested = (await installed.sample({
        geometry: { limit: 10, timeoutMs: 40 },
      } as IPlaytestSampleRequest)) as typeof withoutCapture & {
        geometry?: { status?: string; reason?: string };
      };
      // Whether this stub presents a world frame or not, the report contract is the same one the
      // overlay reads, and an unavailable capture names its reason instead of reporting zero.
      expect(requested.geometry).toBeDefined();
      expect(["captured", "unavailable"]).toContain(requested.geometry?.status);
      if (requested.geometry?.status === "unavailable") {
        expect(requested.geometry.reason).toMatch(/TN_GEOMETRY_CAPTURE_/u);
      }
      expect(requested.entities?.map(({ id }) => id)).toContain("player");
    } finally {
      game.stop();
    }
  });

  it("holds counted ticks while a goto is loading, so a restart cannot be outrun (PRD-637)", async () => {
    vi.stubGlobal("requestAnimationFrame", () => 1);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const updates: string[] = [];
    let generation = 0;
    let restartAt = Number.POSITIVE_INFINITY;
    // `load()` settles on a later macrotask, as asset decoding and GPU readback do, so a runner
    // that spends its ticks synchronously finishes them before the new world exists.
    class Play extends Scene<Record<string, unknown>> {
      readonly #id = ++generation;
      #seen = 0;
      override load(): Promise<void> {
        return this.#id === 1
          ? Promise.resolve()
          : new Promise((resolve) => setTimeout(resolve, 20));
      }
      override update(ctx: ICtx<Record<string, unknown>>): void {
        updates.push(`play${this.#id}`);
        this.#seen += 1;
        if (this.#id === 1 && this.#seen === restartAt) void ctx.goto("play");
      }
    }
    const game = defineGame({
      initialState: {},
      plugins: [playtest()],
      renderer: stubRenderer(testCanvas()),
      scenes: { play: Play },
      start: "play",
    });
    await game.start();
    try {
      const installed = bridge();
      restartAt = 3;
      await installed.advance?.(10);
      // Three ticks ran in the old scene. The other seven wait for the new one to enter.
      expect(updates).toEqual([
        "play1",
        "play1",
        "play1",
        ...Array.from({ length: 7 }, () => "play2"),
      ]);
      expect((await installed.sample({})).clock).toEqual({ mode: "fixed-step", tick: 10 });
    } finally {
      game.stop();
      vi.unstubAllGlobals();
    }
  });

  it("does not hold by default", async () => {
    const canvas = testCanvas();
    const game = defineGame<{ score: number }>({
      initialState: { score: 0 },
      plugins: [playtest()],
      renderer: stubRenderer(canvas),
      scenes: { main: class extends Scene<{ score: number }> {} },
      start: "main",
    });
    await game.start();
    await game.stop();
  });
});
