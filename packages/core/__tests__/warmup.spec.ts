import { describe, expect, test, vi } from "vitest";

import { StartupReadiness } from "../src/startup-readiness.js";
import {
  type IWarmUpProgress,
  warmUpComputeNodes,
  warmUpScene,
  warmUpSceneWithCompletion,
} from "../src/warmup.js";

/**
 * The launch this exists to fix: a Pixel 8 spent 24.5 seconds across 107 pipeline compiles inside
 * one frame, because nothing compiled the scene until the first `render()` drew it. For that whole
 * span the loop presented nothing, so the loading screen froze and the game read as hung.
 *
 * What these assert is therefore not "compiling happened" — it happened before too, all at once.
 * It is that the work is **cut into slices with a yield between them**, because the yield is the
 * only reason a frame reaches the screen while the compiling runs.
 */

interface IFakeObject {
  children: IFakeObject[];
  material?: object;
  name: string;
  /** Set on the fakes that stand in for a pipeline variant sharing another object's material. */
  isSkinnedMesh?: boolean;
  /** Set on the fakes that stand in for a shadow-casting light. */
  isLight?: boolean;
  castShadow?: boolean;
  /** three's `Object3D.frustumCulled` / `visible`, which the warm render toggles and restores. */
  frustumCulled?: boolean;
  visible?: boolean;
}

const mesh = (name: string): IFakeObject => ({ children: [], material: {}, name });
const group = (name: string, children: IFakeObject[]): IFakeObject => ({ children, name });

const sceneOf = (count: number): IFakeObject =>
  group(
    "scene",
    Array.from({ length: count }, (_unused, index) => mesh(`mesh-${index}`)),
  );

// The renderer and camera are structural: nothing here needs a GPU, a canvas or a real three.js
// scene, which is what keeps this in the default node-environment gate.
const fakeRenderer = () => {
  const compiled: string[] = [];
  return {
    compiled,
    compileAsync: (object: unknown) => {
      compiled.push((object as IFakeObject).name);
      return Promise.resolve();
    },
  };
};

// Most of these exercise the sliced, per-object granularity, so `run` selects it. The default is
// `"scene"` -- one whole-scene compile -- and has its own tests at the bottom.
// biome-ignore lint/suspicious/noExplicitAny: the fakes above stand in for three.js structurally.
const run = (renderer: any, scene: any, options: any = {}) =>
  warmUpScene(renderer, scene, {} as never, { granularity: "object", ...options });

describe("scene warm-up", () => {
  test("keeps the original timed-out compile observable to a launch gate", async () => {
    let resolveCompile: () => void = () => undefined;
    let compileCalls = 0;
    const renderer = {
      compileAsync: () => {
        compileCalls += 1;
        return new Promise<void>((resolve) => {
          resolveCompile = resolve;
        });
      },
    };
    const resultPromise = warmUpSceneWithCompletion(renderer, sceneOf(1) as never, {} as never, {
      budgetMs: 10,
      compileTimeoutMs: 5,
      granularity: "scene",
      yieldFrame: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
    });
    const result = await resultPromise;

    expect(result.report.timedOut).toBe(true);
    expect(compileCalls).toBe(1);
    const readiness = new StartupReadiness({
      afterHolds: () => result.completion,
      settled: () => true,
      stableFrames: 1,
    });
    const ready = readiness.whenReady();
    readiness.hold("streamed-world", Promise.resolve());
    readiness.start();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    readiness.observe(1);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(readiness.ready).toBe(false);

    resolveCompile();
    await result.completion;
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    readiness.observe(1);
    readiness.observe(1);
    await ready;
    expect(readiness.ready).toBe(true);
    expect(compileCalls).toBe(1);
  }, 10_000);

  test("preserves a timed-out compile rejection for the held startup gate", async () => {
    let rejectCompile: (error: Error) => void = () => undefined;
    let compileCalls = 0;
    const failure = new Error("pipeline creation failed");
    const result = await warmUpSceneWithCompletion(
      {
        compileAsync: () => {
          compileCalls += 1;
          return new Promise<void>((_resolve, reject) => {
            rejectCompile = reject;
          });
        },
      },
      sceneOf(1) as never,
      {} as never,
      {
        budgetMs: 10,
        compileTimeoutMs: 5,
        granularity: "scene",
        yieldFrame: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      },
    );

    expect(result.report.timedOut).toBe(true);
    const readiness = new StartupReadiness({
      afterHolds: () => result.completion,
      settled: () => true,
      stableFrames: 1,
    });
    const ready = readiness.whenReady();
    readiness.hold("streamed-world", Promise.resolve());
    readiness.start();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    readiness.observe(1);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    const rejected = expect(ready).rejects.toBe(failure);
    rejectCompile(failure);
    await rejected;
    expect(readiness.ready).toBe(false);
    expect(compileCalls).toBe(1);
  }, 10_000);

  test("should compile every renderable and yield a frame between slices", async () => {
    const renderer = fakeRenderer();
    const yields = vi.fn(() => Promise.resolve());
    const progress: IWarmUpProgress[] = [];

    const report = await run(renderer, sceneOf(10), {
      sliceSize: 4,
      yieldFrame: yields,
      onProgress: (entry: IWarmUpProgress) => progress.push(entry),
    });

    expect(report.compiled).toBe(10);
    expect(renderer.compiled).toHaveLength(10);
    // Ten objects in slices of four is three slices: 4, 8, 10.
    expect(report.slices).toBe(3);
    expect(progress.map((entry) => entry.done)).toEqual([4, 8, 10]);
    expect(progress.every((entry) => entry.total === 10)).toBe(true);
    // Two yields, not three: the final slice does not yield, because the caller renders next and
    // one more empty frame would only add to the launch.
    expect(yields).toHaveBeenCalledTimes(2);
  });

  test("should present a frame while compiling, which is the whole point", async () => {
    // The regression this guards is the one that shipped: all the compiling inside one frame. If
    // the yield is removed, a 200-object scene warms up without ever handing the loop a frame and
    // the loading screen freezes exactly as it did on the phone.
    const renderer = fakeRenderer();
    const yields = vi.fn(() => Promise.resolve());
    await run(renderer, sceneOf(200), { sliceSize: 24, yieldFrame: yields });
    expect(yields.mock.calls.length).toBeGreaterThan(1);
  });

  test("should yield while waiting for a native compile to settle", async () => {
    let settle: (() => void) | undefined;
    const renderer = {
      compileAsync: () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    };
    const yields = vi.fn(async () => {
      settle?.();
    });

    const report = await warmUpScene(renderer, sceneOf(1) as never, {} as never, {
      budgetMs: 100,
      compileTimeoutMs: 50,
      yieldFrame: yields,
    });

    expect(yields).toHaveBeenCalled();
    expect(report).toMatchObject({ compiled: 1, abandoned: 0, timedOut: false });
  });

  test("should reuse a completed warm-up on the next launch", async () => {
    const storage = new Map<string, string>();
    const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
        setItem: (key: string, value: string) => storage.set(key, value),
      },
    });
    try {
      const firstRenderer = fakeRenderer();
      const first = await warmUpScene(firstRenderer, sceneOf(2) as never, {} as never, {
        cache: { key: "bayview-scene-v1" },
      });
      const secondRenderer = fakeRenderer();
      const second = await warmUpScene(secondRenderer, sceneOf(2) as never, {} as never, {
        cache: { key: "bayview-scene-v1" },
      });

      expect(first.cache).toBe("stored");
      expect(second.cache).toBe("hit");
      expect(second.compiled).toBe(0);
      expect(secondRenderer.compiled).toEqual([]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "localStorage");
      else Object.defineProperty(globalThis, "localStorage", previous);
    }
  });

  test("should skip objects that carry no material", async () => {
    // Compiling a Group walks its whole subtree again, which turns one linear pass into a
    // quadratic one on a deep scene — the opposite of the fix.
    const renderer = fakeRenderer();
    const scene = group("scene", [group("props", [mesh("crate")]), mesh("floor")]);
    const report = await run(renderer, scene, { yieldFrame: () => Promise.resolve() });
    expect(report.compiled).toBe(2);
    expect(renderer.compiled.sort()).toEqual(["crate", "floor"]);
  });

  test("should report an empty scene as done rather than skipped", async () => {
    const renderer = fakeRenderer();
    const progress: IWarmUpProgress[] = [];
    const report = await run(renderer, group("scene", []), {
      onProgress: (entry: IWarmUpProgress) => progress.push(entry),
    });
    expect(report).toMatchObject({ compiled: 0, slices: 0, unsupported: false });
    expect(progress).toEqual([{ done: 0, total: 0 }]);
  });

  test("should report a renderer that cannot warm up, not silently skip it", async () => {
    // "The warm-up found nothing to do" and "this renderer has no compileAsync" produce the same
    // zero, and only one of them explains a launch that still stalls.
    const report = await run({}, sceneOf(5));
    expect(report.unsupported).toBe(true);
    expect(report.compiled).toBe(0);
  });

  test("should attempt every renderable, even when values share a material", async () => {
    // Material identity is not Three's pipeline identity. Every renderable must reach the real
    // renderer so state-only variants, multi-material geometry and late pass work cannot be
    // silently dropped by a guessed key.
    const renderer = fakeRenderer();
    const shared = {};
    const scene = group("scene", [
      { children: [], material: shared, name: "wall-a" },
      { children: [], material: shared, name: "wall-b" },
      { children: [], material: shared, name: "wall-c" },
      mesh("water"),
    ]);
    const report = await run(renderer, scene, { yieldFrame: () => Promise.resolve() });
    expect(report.compiled).toBe(4);
    expect(report.candidates).toBe(4);
    expect(report.attempted).toBe(4);
    expect(renderer.compiled).toEqual(["wall-a", "wall-b", "wall-c", "water"]);
  });

  test("should report actual pipeline census deltas separately from candidates", async () => {
    let snapshot = {
      version: 1 as const,
      complete: true,
      overflowed: false,
      unsupported: false,
      limit: 512,
      clock: { originMs: 0, source: "performance" as const },
      build: { identity: "test" },
      adapter: { identity: "test-gpu", thermal: "cool" },
      backend: { kind: "webgpu" as const, identity: "test-backend" },
      counts: {
        lookups: 2,
        creations: 3,
        failures: 0,
        pending: 0,
        uniquePrograms: 2,
        uniquePipelines: 2,
        recordedEvents: 3,
        droppedEvents: 0,
      },
      events: [],
      incompleteReasons: [],
    };
    const renderer = {
      ...fakeRenderer(),
      pipelineCensus: () => snapshot,
      compileAsync: (object: unknown) => {
        snapshot = {
          ...snapshot,
          complete: false,
          counts: {
            ...snapshot.counts,
            creations: 5,
            failures: 1,
            pending: 1,
            uniquePrograms: 3,
            uniquePipelines: 4,
          },
        };
        return Promise.resolve();
      },
    };
    const report = await run(renderer, sceneOf(2), { yieldFrame: () => Promise.resolve() });
    expect(report).toMatchObject({
      candidates: 2,
      attempted: 2,
      observed: {
        created: 2,
        failed: 1,
        pending: 1,
        uniquePrograms: 1,
        uniquePipelines: 2,
        status: "incomplete",
      },
    });
  });

  test("should not call abandoned work complete when the census itself is complete", async () => {
    const snapshot = {
      version: 1 as const,
      complete: true,
      overflowed: false,
      unsupported: false,
      limit: 512,
      clock: { originMs: 0, source: "performance" as const },
      build: { identity: "test" },
      adapter: { identity: "test-gpu", thermal: "cool" },
      backend: { kind: "webgpu" as const, identity: "test-backend" },
      counts: {
        lookups: 1,
        creations: 1,
        failures: 0,
        pending: 0,
        uniquePrograms: 1,
        uniquePipelines: 1,
        recordedEvents: 1,
        droppedEvents: 0,
      },
      events: [],
      incompleteReasons: [],
    };
    const report = await run(
      {
        pipelineCensus: () => snapshot,
        compileAsync: () => Promise.reject(new Error("compile failed")),
      },
      sceneOf(1),
      { yieldFrame: () => Promise.resolve() },
    );

    expect(report.abandoned).toBe(1);
    expect(report.observed.status).toBe("incomplete");
  });

  test("should treat a skinned object sharing a material as its own pipeline", async () => {
    // Keying on the material alone would skip the skinned variant, which is a real pipeline and a
    // real compile — and it would reappear as a stall inside the first frame that drew a soldier.
    const renderer = fakeRenderer();
    const shared = {};
    const scene = group("scene", [
      { children: [], material: shared, name: "statue" },
      { children: [], material: shared, name: "soldier", isSkinnedMesh: true },
    ]);
    const report = await run(renderer, scene, { yieldFrame: () => Promise.resolve() });
    expect(report.compiled).toBe(2);
    expect(renderer.compiled).toEqual(["statue", "soldier"]);
  });

  test("should neither deadlock nor register a frame callback of its own", async () => {
    // Two regressions in one assertion, both of which happened.
    //
    // Awaiting requestAnimationFrame deadlocks: boot is what schedules frames, so a host whose
    // rAF only queues the callback -- the playtest harness drains it after start() resolves --
    // leaves the warm-up waiting for a frame that cannot run until it stops waiting. Two suite
    // tests hung for their full timeout.
    //
    // Racing rAF against a timer fixes the hang but registers a frame callback that is not the
    // loop's, reordering the frame sequence a harness observes. It turned a 16 ms frame into a
    // 32 ms one in the performance suite.
    const renderer = fakeRenderer();
    const queued: Array<() => void> = [];
    const previous = Reflect.get(globalThis, "requestAnimationFrame");
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      value: (callback: () => void) => queued.push(callback),
    });
    try {
      // No yieldFrame override: this must survive the real one.
      const report = await run(renderer, sceneOf(3), { sliceSize: 1 });
      expect(report.compiled).toBe(3);
      expect(queued).toEqual([]);
    } finally {
      if (previous === undefined) Reflect.deleteProperty(globalThis, "requestAnimationFrame");
      else Object.defineProperty(globalThis, "requestAnimationFrame", { value: previous });
    }
  }, 10_000);

  test("should abandon a compile that never resolves instead of hanging the launch", async () => {
    // This is the bug the bounded version exists for, and it shipped once. On a Pixel 8 a
    // compileAsync never came back, so boot awaited it forever: the loop stayed held, the
    // simulation never advanced (substeps mean 0 across 300 frames) and the game sat on its
    // loading screen with no error logged anywhere. A slow launch is a disappointment; a launch
    // that never finishes is a bug.
    const compiled: string[] = [];
    const renderer = {
      compileAsync: (object: unknown) => {
        const name = (object as IFakeObject).name;
        compiled.push(name);
        // The second pipeline hangs. Everything after it must still be warmed.
        return name === "mesh-1" ? new Promise<void>(() => undefined) : Promise.resolve();
      },
    };
    const report = await run(renderer, sceneOf(3), {
      compileTimeoutMs: 20,
      yieldFrame: () => Promise.resolve(),
    });
    expect(compiled).toEqual(["mesh-0", "mesh-1", "mesh-2"]);
    expect(report.compiled).toBe(2);
    expect(report.abandoned).toBe(1);
    expect(report.timedOut).toBe(false);
  }, 10_000);

  test("should stop at its budget rather than make the launch worse", async () => {
    const renderer = {
      compileAsync: () => new Promise<void>((resolve) => setTimeout(resolve, 15)),
    };
    const report = await run(renderer, sceneOf(50), {
      budgetMs: 60,
      compileTimeoutMs: 1000,
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.timedOut).toBe(true);
    expect(report.abandoned).toBeGreaterThan(0);
    expect(report.compiled + report.abandoned).toBe(50);
  }, 10_000);

  test("should treat a rejected compile as a pipeline it could not build, not a failure", async () => {
    // The frame that needs the pipeline will try again and fail there, where the error belongs.
    const renderer = {
      compileAsync: (object: unknown) =>
        (object as IFakeObject).name === "mesh-0"
          ? Promise.reject(new Error("backend said no"))
          : Promise.resolve(),
    };
    const report = await run(renderer, sceneOf(2), { yieldFrame: () => Promise.resolve() });
    expect(report.compiled).toBe(1);
    expect(report.abandoned).toBe(1);
  });

  test("should fail closed on a timeout that cannot bound anything", async () => {
    const renderer = fakeRenderer();
    for (const options of [{ compileTimeoutMs: 0 }, { budgetMs: -1 }, { budgetMs: Number.NaN }]) {
      await expect(run(renderer, sceneOf(2), options)).rejects.toThrow(
        /TN_WARMUP_TIMEOUT_INVALID/u,
      );
    }
  });

  test("should fail closed on an empty persistent cache key", async () => {
    const renderer = fakeRenderer();
    await expect(
      warmUpScene(renderer, sceneOf(1) as never, {} as never, { cache: { key: "  " } }),
    ).rejects.toThrow(/TN_WARMUP_CACHE_INVALID/u);
  });

  test("should fail closed on a slice size that cannot terminate", async () => {
    const renderer = fakeRenderer();
    for (const sliceSize of [0, -1, 2.5]) {
      await expect(run(renderer, sceneOf(4), { sliceSize })).rejects.toThrow(
        /TN_WARMUP_SLICE_INVALID/u,
      );
    }
  });

  test("should compile the whole scene in one call by default", async () => {
    // Measured on a Pixel 8: one whole-scene call builds all 107 of this game's pipelines in
    // 8.1 s, while the per-object walk managed 6 in 15 s before its budget ran out. The default
    // may not be the mechanism that turns an 8-second launch into a 15-second one.
    const calls: unknown[] = [];
    const renderer = {
      compileAsync: (object: unknown) => {
        calls.push(object);
        return Promise.resolve();
      },
    };
    const scene = sceneOf(200);
    const report = await warmUpScene(renderer as never, scene as never, {} as never);
    expect(calls).toEqual([scene]);
    // One call, but the report still says how much it covered: an 11-second whole-scene compile
    // is a number a game can act on only next to the pipeline count it built.
    expect(report).toMatchObject({
      abandoned: 0,
      compiled: 1,
      pipelines: 200,
      slices: 1,
      timedOut: false,
    });
  });

  test("should abandon a whole-scene compile that never returns", async () => {
    const renderer = { compileAsync: () => new Promise<void>(() => undefined) };
    const report = await warmUpScene(renderer as never, sceneOf(2) as never, {} as never, {
      budgetMs: 30,
    });
    expect(report).toMatchObject({ compiled: 0, abandoned: 1, timedOut: true });
  }, 10_000);

  test("should render every pass once so shadow pipelines exist before the first frame", async () => {
    // compileAsync builds only the main-pass pipelines. The shadow map's depth variants are built
    // synchronously on first use, mid-game — 44-107 pipelines after "ready" on a native Midway
    // launch, with freezes up to 615 ms. One render here builds them behind the startup cover.
    const rendered: unknown[] = [];
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: (scene: unknown) => {
        rendered.push(scene);
      },
      raw: { shadowMap: { enabled: true, autoUpdate: true, needsUpdate: false } },
    };
    const sun = { children: [], isLight: true, castShadow: true, name: "sun" };
    const scene = group("scene", [mesh("ground"), sun]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(rendered).toEqual([scene]);
    expect(report.passes).toEqual(["main", "shadow"]);
    expect(report.passPipelines).toBe(0);
  });

  test("should not finish until the GPU has executed the hidden render", async () => {
    // `render()` only submits. A driver compiles a pipeline the first time the GPU executes it, so
    // a warm-up that returned here handed that compile to the first frame the player sees: 150 ms
    // for the sailing template's post chain, in the p95 of every measurement that followed.
    let executed: (() => void) | undefined;
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => undefined,
      raw: {
        backend: {
          device: {
            queue: {
              onSubmittedWorkDone: () =>
                new Promise<void>((resolve) => {
                  executed = resolve;
                }),
            },
          },
        },
        shadowMap: { enabled: true },
      },
    };
    const scene = group("scene", [
      mesh("ground"),
      { children: [], isLight: true, castShadow: true, name: "sun" },
    ]);
    let done = false;
    const warming = warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    }).then((report) => {
      done = true;
      return report;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(done).toBe(false);
    executed?.();
    expect(await warming).toMatchObject({ passes: ["main", "shadow"], timedOut: false });
  });

  test("should stop waiting for the GPU when the budget runs out", async () => {
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => undefined,
      raw: {
        backend: {
          device: { queue: { onSubmittedWorkDone: () => new Promise<void>(() => undefined) } },
        },
        shadowMap: { enabled: true },
      },
    };
    const scene = group("scene", [
      mesh("ground"),
      { children: [], isLight: true, castShadow: true, name: "sun" },
    ]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      budgetMs: 60,
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.passes).toEqual(["main", "shadow"]);
  }, 10_000);

  test("should name a reflection pass when a material carries a reflector node", async () => {
    const reflectorNode = { isNode: true, _reflectorBaseNode: {}, getChildren: () => [] };
    const material = {
      isNodeMaterial: true,
      colorNode: { isNode: true, getChildren: () => [reflectorNode] },
    };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => undefined,
      raw: { shadowMap: { enabled: true } },
    };
    const scene = group("scene", [{ children: [], material, name: "water" }]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.passes).toEqual(["main", "reflection"]);
  });

  test("should not render passes when renderPasses is false", async () => {
    const render = vi.fn();
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render,
      raw: { shadowMap: { enabled: true } },
    };
    const scene = group("scene", [
      mesh("ground"),
      { children: [], isLight: true, castShadow: true, name: "sun" },
    ]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      renderPasses: false,
      yieldFrame: () => Promise.resolve(),
    });
    expect(render).not.toHaveBeenCalled();
    expect(report.passes).toEqual([]);
    expect(report.passPipelines).toBe(0);
  });

  test("should submit an off-screen caster by turning frustum culling off for the warm render", async () => {
    // Frustum culling is on by default, so a mesh outside the startup camera's view is never
    // submitted to the shadow or reflection pass and its pipelines stay unbuilt. Midway's mid-flight
    // compiles are exactly those off-screen objects. One render with culling off submits them.
    let during: boolean | undefined;
    const far = {
      children: [],
      material: {},
      name: "far-carrier",
      frustumCulled: true,
      visible: true,
    };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => {
        during = far.frustumCulled;
      },
      raw: { shadowMap: { enabled: true } },
    };
    const scene = group("scene", [
      far,
      { children: [], isLight: true, castShadow: true, name: "sun" },
    ]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(during).toBe(false);
    expect(report.cullingForced).toBeGreaterThanOrEqual(1);
    // Restored exactly, so the game's own culling is untouched.
    expect(far.frustumCulled).toBe(true);
  });

  test("should render a hidden mesh only with includeHidden, then restore it exactly", async () => {
    const build = () => {
      const hiddenMesh = {
        children: [],
        material: {},
        name: "hidden-lod",
        frustumCulled: true,
        visible: false,
      };
      // A hidden ancestor: three never draws its subtree whatever the child says, so the ancestor
      // itself has to be forced visible for the child to be submitted.
      const hiddenGroup = {
        children: [mesh("inside")],
        name: "hidden-group",
        frustumCulled: true,
        visible: false,
      };
      const renderer = {
        compileAsync: () => Promise.resolve(),
        render: vi.fn(),
        raw: { shadowMap: { enabled: true } },
      };
      const scene = group("scene", [
        hiddenMesh,
        hiddenGroup,
        { children: [], isLight: true, castShadow: true, name: "sun" },
      ]);
      return { hiddenMesh, hiddenGroup, renderer, scene };
    };

    const off = build();
    let meshVisibleOff: boolean | undefined;
    let groupVisibleOff: boolean | undefined;
    off.renderer.render.mockImplementation(() => {
      meshVisibleOff = off.hiddenMesh.visible;
      groupVisibleOff = off.hiddenGroup.visible;
    });
    const reportOff = await warmUpScene(off.renderer as never, off.scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(meshVisibleOff).toBe(false);
    expect(groupVisibleOff).toBe(false);
    expect(reportOff.visibilityForced).toBe(0);
    expect(off.hiddenMesh.visible).toBe(false);
    expect(off.hiddenGroup.visible).toBe(false);
    expect(off.hiddenMesh.frustumCulled).toBe(true);

    const on = build();
    let meshVisibleOn: boolean | undefined;
    let groupVisibleOn: boolean | undefined;
    on.renderer.render.mockImplementation(() => {
      meshVisibleOn = on.hiddenMesh.visible;
      groupVisibleOn = on.hiddenGroup.visible;
    });
    const reportOn = await warmUpScene(on.renderer as never, on.scene as never, {} as never, {
      includeHidden: true,
      yieldFrame: () => Promise.resolve(),
    });
    expect(meshVisibleOn).toBe(true);
    expect(groupVisibleOn).toBe(true);
    expect(reportOn.visibilityForced).toBeGreaterThanOrEqual(2);
    // Every original value is back exactly, on the object and on its hidden ancestor.
    expect(on.hiddenMesh.visible).toBe(false);
    expect(on.hiddenGroup.visible).toBe(false);
    expect(on.hiddenMesh.frustumCulled).toBe(true);
    expect(on.hiddenGroup.frustumCulled).toBe(true);
  });

  test("should restore every renderer and scene state the pass render touched", async () => {
    let during: { autoClear: unknown; needsUpdate: unknown; visible: unknown } | undefined;
    const raw = {
      autoClear: true,
      shadowMap: { enabled: true, autoUpdate: false, needsUpdate: false },
    };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => {
        during = {
          autoClear: raw.autoClear,
          needsUpdate: raw.shadowMap.needsUpdate,
          visible: scene.visible,
        };
      },
      raw,
    };
    const scene = {
      children: [mesh("ground"), { children: [], isLight: true, castShadow: true, name: "sun" }],
      material: undefined,
      name: "scene",
      visible: false,
    };
    await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    // Forced on for the render so a game that draws its shadows once still builds them...
    expect(during).toEqual({ autoClear: false, needsUpdate: true, visible: true });
    // ...and every one of them is back exactly as the game left it.
    expect(raw.autoClear).toBe(true);
    expect(raw.shadowMap.needsUpdate).toBe(false);
    expect(scene.visible).toBe(false);
  });

  test("should not expand a shared diamond DAG exponentially while reporting the same passes", async () => {
    let calls = 0;
    const leaf: { isNode: boolean; getChildren: () => unknown[] } = {
      isNode: true,
      getChildren: () => {
        calls += 1;
        return [];
      },
    };
    let root: unknown = leaf;
    const depth = 12;
    for (let index = 0; index < depth; index += 1) {
      const next: unknown = root;
      const level: { isNode: boolean; getChildren: () => unknown[] } = {
        isNode: true,
        getChildren: () => {
          calls += 1;
          return [next, next];
        },
      };
      root = level;
    }
    const material = { isNodeMaterial: true, a: root, b: root };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: vi.fn(),
      raw: { shadowMap: { enabled: false } },
    };
    const scene = group("scene", [{ children: [], material, name: "water" }]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.passes).toEqual(["main"]);
    expect(renderer.render).not.toHaveBeenCalled();
    expect(calls).toBeLessThan(50);
  });

  test("should retain reflection when a shared node is first reached deep past the cutoff", async () => {
    const reflectorNode = { isNode: true, _reflectorBaseNode: {}, getChildren: () => [] };
    const chain = (length: number, leaf: unknown): unknown => {
      let next: unknown = leaf;
      for (let index = 0; index < length; index += 1) {
        const current: unknown = next;
        const level = {
          isNode: true,
          getChildren: () => [current],
        };
        next = level;
      }
      return next;
    };
    const tail = chain(4, reflectorNode);
    const shared = { isNode: true, getChildren: () => [tail] };
    const deepRoot = chain(60, shared);
    const material = { isNodeMaterial: true, deep: deepRoot, shallow: shared };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => undefined,
      raw: { shadowMap: { enabled: false } },
    };
    const scene = group("scene", [{ children: [], material, name: "water" }]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.passes).toEqual(["main", "reflection"]);
  });

  test("should discover a reflector added between two warm-ups", async () => {
    const reflectorNode = { isNode: true, _reflectorBaseNode: {}, getChildren: () => [] };
    const children: unknown[] = [];
    const plain = { isNode: true, getChildren: () => children };
    const material = { isNodeMaterial: true, colorNode: plain };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: () => undefined,
      raw: { shadowMap: { enabled: false } },
    };
    const scene = group("scene", [{ children: [], material, name: "water" }]);
    const first = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(first.passes).toEqual(["main"]);
    children.push(reflectorNode);
    const second = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(second.passes).toEqual(["main", "reflection"]);
  });

  test("should terminate on a node cycle without a reflector", async () => {
    const cyclic: { isNode: boolean; getChildren: () => unknown[] } = {
      isNode: true,
      getChildren: () => [cyclic],
    };
    const material = { isNodeMaterial: true, colorNode: cyclic };
    const renderer = {
      compileAsync: () => Promise.resolve(),
      render: vi.fn(),
      raw: { shadowMap: { enabled: false } },
    };
    const scene = group("scene", [{ children: [], material, name: "water" }]);
    const report = await warmUpScene(renderer as never, scene as never, {} as never, {
      yieldFrame: () => Promise.resolve(),
    });
    expect(report.passes).toEqual(["main"]);
    expect(renderer.render).not.toHaveBeenCalled();
  });
});

describe("warm-up absolute budget", () => {
  test.each(["scene", "object", "compute"] as const)(
    "%s compilation counts a synchronous prefix against its existing budget",
    async (kind) => {
      let clock = 0;
      const clockSpy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => clock);
      try {
        const compile = () => {
          clock += 20;
          return Promise.resolve();
        };
        const report =
          kind === "compute"
            ? await warmUpComputeNodes({ computeAsync: compile }, [{}, {}, {}], { budgetMs: 10 })
            : await warmUpScene({ compileAsync: compile }, sceneOf(3) as never, {} as never, {
                budgetMs: 10,
                granularity: kind,
              });
        expect(report.compiled).toBe(0);
        expect(report.abandoned).toBe(kind === "scene" ? 1 : 3);
        expect(report.timedOut).toBe(true);
        if ("candidates" in report) {
          expect(report).toMatchObject({ candidates: 3, attempted: 1 });
        }
      } finally {
        clockSpy.mockRestore();
      }
    },
  );

  test.each(["scene", "object"] as const)(
    "%s compilation does not grant a fresh wait after an expired synchronous prefix",
    async (granularity) => {
      let clock = 0;
      let yields = 0;
      const clockSpy = vi.spyOn(globalThis.performance, "now").mockImplementation(() => clock);
      try {
        const report = await warmUpScene(
          {
            compileAsync: () => {
              clock += 20;
              return new Promise<void>(() => undefined);
            },
          },
          sceneOf(3) as never,
          {} as never,
          {
            budgetMs: 10,
            granularity,
            yieldFrame: async () => {
              yields += 1;
              clock += 20;
            },
          },
        );
        expect(report.compiled).toBe(0);
        expect(report.abandoned).toBe(granularity === "scene" ? 1 : 3);
        expect(report.timedOut).toBe(true);
        expect(yields).toBe(0);
        expect(report.elapsedMs).toBe(20);
      } finally {
        clockSpy.mockRestore();
      }
    },
  );
});

describe("compute warm-up dispatch", () => {
  test.each([false, true])(
    "WebGPU warm-up uses zero kernel invocations (raw wrapper: %s)",
    async (wrapped) => {
      const node = {};
      const computeAsync = vi.fn(async () => undefined);
      const receiver = { backend: { isWebGPUBackend: true }, computeAsync };
      const report = await warmUpComputeNodes(wrapped ? { raw: receiver } : receiver, [node]);
      expect(report.compiled).toBe(1);
      expect(computeAsync).toHaveBeenCalledExactlyOnceWith(node, 0);
      expect(computeAsync.mock.contexts[0]).toBe(receiver);
    },
  );

  test.each([undefined, { isWebGLBackend: true }])(
    "other compute seams retain their existing call (%j)",
    async (backend) => {
      const node = {};
      const computeAsync = vi.fn(async () => undefined);
      const receiver = { backend, computeAsync };
      const report = await warmUpComputeNodes(receiver, [node]);
      expect(report.compiled).toBe(1);
      expect(computeAsync).toHaveBeenCalledExactlyOnceWith(node);
    },
  );
});
