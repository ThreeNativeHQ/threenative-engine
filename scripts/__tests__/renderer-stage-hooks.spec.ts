import { describe, expect, it } from "vitest";
import {
  EXPECTED_THREE_VERSION,
  installRendererStageHooks,
  rendererStageReportSchema,
  validateRendererStageReport,
} from "../render-profile/renderer-stage-hooks.js";

type FakeMethod = (...args: unknown[]) => unknown;

function fakeClock(values: readonly number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function makeRenderer(overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const renderer = {
    _bindings: {
      updateForRender() {
        calls.push("bindings");
      },
    },
    _geometries: {
      updateForRender() {
        calls.push("geometries");
      },
    },
    _nodes: {
      getForRender() {
        calls.push("nodes.getForRender");
        return {};
      },
      updateAfter() {
        calls.push("nodes.updateAfter");
      },
      updateBefore() {
        calls.push("nodes.updateBefore");
      },
      updateForRender() {
        calls.push("nodes.updateForRender");
      },
    },
    _objects: {
      createRenderObject() {
        calls.push("objects.createRenderObject");
        return {};
      },
      get() {
        calls.push("objects.get");
        return {};
      },
    },
    _pipelines: {
      getForRender() {
        calls.push("pipelines");
        return {};
      },
    },
    _projectObject() {
      calls.push("project");
    },
    _renderObjectDirect() {
      calls.push("direct");
    },
    _renderObjects() {
      calls.push("objects");
    },
    _renderScene(_scene?: unknown, _camera?: unknown, useFrameBufferTarget = true) {
      calls.push(`scene:${String(useFrameBufferTarget)}`);
    },
    _renderLists: {
      get() {
        return {
          sort() {
            calls.push("sort");
          },
        };
      },
    },
    backend: {
      beginRender() {
        calls.push("beginRender");
      },
      draw() {
        calls.push("draw");
      },
      finishRender() {
        calls.push("finishRender");
      },
    },
    info: {
      compute: { frameCalls: 0 },
      render: { calls: 99, drawCalls: 17, frameCalls: 1, triangles: 51 },
    },
    ...overrides,
  };
  return { calls, renderer };
}

describe("renderer stage hooks", () => {
  it("rejects anything except the exact pinned Three.js version", () => {
    const { renderer } = makeRenderer();

    expect(() =>
      installRendererStageHooks(renderer, { clock: fakeClock([]), threeVersion: "0.185.0" }),
    ).toThrow(/three@0\.187\.0/);
    expect(() =>
      installRendererStageHooks(renderer, {
        clock: fakeClock([]),
        threeVersion: EXPECTED_THREE_VERSION,
      }),
    ).not.toThrow();
  });

  it("rejects missing or wrong private methods before installing partial hooks", () => {
    const original = () => undefined;
    const { renderer } = makeRenderer({ _renderScene: undefined, _renderObjects: original });

    expect(() =>
      installRendererStageHooks(renderer, {
        clock: fakeClock([]),
        threeVersion: EXPECTED_THREE_VERSION,
      }),
    ).toThrow(/_renderScene/);
    expect(renderer._renderObjects).toBe(original);
  });

  it("records wrapper call counts and inclusive timing", () => {
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 5, 10, 18]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    (renderer._projectObject as FakeMethod)();
    (renderer._renderObjects as FakeMethod)();
    const report = hooks.snapshot({ measuredFrameCount: 2 });

    expect(report.measuredFrameCount).toBe(2);
    expect(report.stages["renderer.projectObject"]?.calls).toBe(1);
    expect(report.stages["renderer.projectObject"]?.callsPerMeasuredFrame).toBe(0.5);
    expect(report.stages["renderer.projectObject"]?.inclusiveMs).toBe(5);
    expect(report.stages["renderer.projectObject"]?.inclusiveMsPerMeasuredFrame).toBe(2.5);
    expect(report.stages["renderer.renderObjects"]?.inclusiveMs).toBe(8);
    expect(report.stages["renderer.renderObjects"]?.timing).toBe("inclusive");
  });

  it("reports the slowest single call, so one call doing a pass cannot read as a per-call cost", () => {
    // Measured in three 0.185.1: `nodes.updateBefore` averages ~5.7 µs over ~394 calls a frame,
    // and one of those calls renders the shadow map at 3,600 µs. A report carrying only the
    // total makes that look like an expensive per-draw stage, which is a wrong conclusion this
    // repository's performance record had to retract. Three cheap calls and one slow one:
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1, 1, 2, 2, 3, 3, 103]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    for (let index = 0; index < 4; index += 1) (renderer._projectObject as FakeMethod)();
    const stage = hooks.snapshot({ measuredFrameCount: 1 }).stages["renderer.projectObject"];

    expect(stage?.calls).toBe(4);
    expect(stage?.inclusiveMs).toBe(103);
    // The mean says 25.75 ms a call; the truth is three calls of 1 ms and one of 100.
    expect(stage?.maxMs).toBe(100);
    expect((stage as { inclusiveMs: number; calls: number }).inclusiveMs / 4).toBeCloseTo(25.75);
  });

  it("refuses a report whose stages omit the slowest-call field", () => {
    // Built from a real snapshot and then stripped, so the test cannot pass by tripping some
    // earlier schema rule instead of the one it is about.
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1]),
      threeVersion: EXPECTED_THREE_VERSION,
    });
    (renderer._projectObject as FakeMethod)();
    const report = hooks.snapshot({ measuredFrameCount: 1 });
    expect(() => validateRendererStageReport(report)).not.toThrow();

    const stripped = {
      ...report,
      stages: Object.fromEntries(
        Object.entries(report.stages).map(([name, value]) => {
          const { maxMs: _dropped, ...rest } = value as { maxMs: number };
          return [name, rest];
        }),
      ),
    };
    expect(() => validateRendererStageReport(stripped)).toThrow(/maxMs/u);
  });

  it("rejects a version-1 report, because its stages cannot carry a slowest call", () => {
    // The bump exists so the two shapes are distinguishable. A version-1 report has no `maxMs`,
    // which reads as a stage whose calls are uniform — the assumption that turned a shadow-map
    // render into a per-draw cost. Accepting it silently would defeat the point of adding the
    // field at all.
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1]),
      threeVersion: EXPECTED_THREE_VERSION,
    });
    (renderer._projectObject as FakeMethod)();
    const report = hooks.snapshot({ measuredFrameCount: 1 });

    expect(report.version).toBe(2);
    expect(() => validateRendererStageReport({ ...report, version: 1 })).toThrow(
      /version must be 2/u,
    );
  });

  it("can reset after warmup so snapshots describe only measured frames", () => {
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 10, 20, 24]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    (renderer._renderScene as FakeMethod)();
    hooks.reset();
    (renderer._renderScene as FakeMethod)();
    const report = hooks.snapshot({ measuredFrameCount: 1 });

    expect(report.measuredFrameCount).toBe(1);
    expect(report.frame.topLevelRenderSceneCalls).toBe(1);
    expect(report.stages["renderer.renderScene"]?.calls).toBe(1);
    expect(report.stages["renderer.renderScene"]?.inclusiveMs).toBe(4);
  });

  it("times promise-returning wrapped methods through async settlement", async () => {
    const { renderer } = makeRenderer({
      async _renderObjects() {
        return "done";
      },
    });
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 9]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    await expect((renderer._renderObjects as FakeMethod)()).resolves.toBe("done");
    const report = hooks.snapshot();

    expect(report.stages["renderer.renderObjects"]?.calls).toBe(1);
    expect(report.stages["renderer.renderObjects"]?.inclusiveMs).toBe(9);
  });

  it("tracks nested render scenes without inflating top-level frame accounting", () => {
    const { renderer } = makeRenderer();
    const original = renderer._renderScene;
    renderer._renderScene = function nested(
      scene?: unknown,
      camera?: unknown,
      useFrameBufferTarget = true,
    ) {
      original.call(this, scene, camera, useFrameBufferTarget);
      if (useFrameBufferTarget) (this as typeof renderer)._renderScene(scene, camera, false);
    };
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 10, 2, 5]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    (renderer._renderScene as FakeMethod)("scene", "camera", true);
    const report = hooks.snapshot();

    expect(report.frame.topLevelRenderSceneCalls).toBe(1);
    expect(report.frame.nestedRenderSceneCalls).toBe(1);
    expect(report.frame.outputTransformRenderSceneCalls).toBe(1);
    expect(report.stages["renderer.renderScene"]?.calls).toBe(2);
    expect(report.overlap.some((item) => item.parent === "renderer.renderScene")).toBe(true);
  });

  it("restores original identities after dispose and after wrapped errors", () => {
    const boom = new Error("boom");
    const { renderer } = makeRenderer({
      _renderObjects() {
        throw boom;
      },
    });
    const originals = {
      beginRender: renderer.backend.beginRender,
      renderObjects: renderer._renderObjects,
      renderScene: renderer._renderScene,
    };
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    expect(() => (renderer._renderObjects as FakeMethod)()).toThrow(boom);
    hooks.dispose();

    expect(renderer._renderObjects).toBe(originals.renderObjects);
    expect(renderer._renderScene).toBe(originals.renderScene);
    expect(renderer.backend.beginRender).toBe(originals.beginRender);
  });

  it("restores lazily wrapped render-list sort identities on dispose", () => {
    const calls: string[] = [];
    const renderList = {
      sort() {
        calls.push("sort");
      },
    };
    const sortOriginal = renderList.sort;
    const { renderer } = makeRenderer({
      _renderLists: {
        get() {
          return renderList;
        },
      },
    });
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1, 2, 3]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    const returned = renderer._renderLists.get();
    expect(returned.sort).not.toBe(sortOriginal);
    returned.sort();
    hooks.dispose();

    expect(renderList.sort).toBe(sortOriginal);
    renderList.sort();
    expect(calls).toEqual(["sort", "sort"]);
  });

  it("safe mode drops per-object traversal hooks while retaining bounded frame/pass attribution", () => {
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 1, 2, 3]),
      mode: "safe",
      threeVersion: EXPECTED_THREE_VERSION,
    });

    (renderer._renderScene as FakeMethod)();
    (renderer._projectObject as FakeMethod)();
    (renderer._renderObjects as FakeMethod)();
    const report = hooks.snapshot({ measuredFrameCount: 1 });

    expect(report.reachableStages).toContain("renderer.renderScene");
    expect(report.reachableStages).toContain("renderer.renderObjects");
    expect(report.reachableStages).not.toContain("renderer.projectObject");
    expect(report.missingStages).toContain(
      "renderer.projectObject (dropped in safe mode to bound overhead)",
    );
  });

  it("reports drawCalls from render.drawCalls and rejects render.calls as a draw source", () => {
    const { renderer } = makeRenderer({
      info: {
        compute: { frameCalls: 2 },
        render: { calls: 99, drawCalls: 1_001, frameCalls: 1, triangles: 12 },
      },
    });
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    const report = hooks.snapshot();

    expect(report.counters.drawCalls).toBe(1_001);
    expect(report.counters.renderCalls).toBe(99);
    expect(report.counters.drawCounterSource).toBe("info.render.drawCalls");
  });

  it("rejects missing drawCalls instead of misusing render.calls", () => {
    const { renderer } = makeRenderer({
      info: { compute: { frameCalls: 0 }, render: { calls: 4_001, frameCalls: 1, triangles: 12 } },
    });
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([]),
      threeVersion: EXPECTED_THREE_VERSION,
    });

    expect(() => hooks.snapshot()).toThrow(/drawCalls/);
  });

  it("validates overlap metadata and rejects summed overlapping attribution", () => {
    const { renderer } = makeRenderer();
    const hooks = installRendererStageHooks(renderer, {
      clock: fakeClock([0, 10, 1, 4]),
      threeVersion: EXPECTED_THREE_VERSION,
    });
    (renderer._renderScene as FakeMethod)();
    (renderer._renderObjects as FakeMethod)();
    const report = hooks.snapshot();

    expect(rendererStageReportSchema.version).toBe(2);
    expect(validateRendererStageReport(report)).toEqual(report);
    expect(() =>
      validateRendererStageReport({
        ...report,
        attribution: { mode: "summed-inclusive", totalMs: 13 },
      }),
    ).toThrow(/overlap|inclusive/i);
  });
});
