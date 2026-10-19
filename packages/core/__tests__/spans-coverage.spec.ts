import type { Object3D } from "three";
import { describe, expect, it } from "vitest";
import { FrameBudget } from "../src/frame-budget.js";
import { FixedStepLoop } from "../src/loop.js";
import { FrameCounters } from "../src/profiling/FrameCounters.js";
import { SPANS, SpanRecorder, setSpanRecorder, spanRecorder } from "../src/profiling/Spans.js";
import { installSpanProbes } from "../src/profiling/span-probes.js";

/**
 * A stand-in shaped like three's WebGPU renderer, down to the calls the probes attach to.
 *
 * It is not a mock of the probes: it is a renderer that builds a list, sorts it, draws it, and
 * renders a nested shadow pass from inside the main one, exactly as three does. Every millisecond
 * it spends comes from a scripted clock, so the residual the recorder computes is arithmetic the
 * test can state in advance instead of a wall-clock reading nobody can reproduce.
 */
/** Three's render list is a class, so its `sort` lives on a prototype — and so does the fake's. */
class FakeRenderList {
  constructor(private readonly renderer: FakeRenderer) {}
  sort(): void {
    this.renderer.spend(SORT_MS);
  }
}

class FakeRenderer {
  clock = 0;
  readonly list = new FakeRenderList(this);
  #depth = 0;

  spend(ms: number): void {
    this.clock += ms;
  }

  render(scene: unknown, camera: unknown): void {
    this.#depth += 1;
    const nested = this.#depth === 1;
    this.spend(PASS_SETUP_MS);
    this._projectObject(scene, camera, 0, this.list, null);
    this.list.sort();
    for (let draw = 0; draw < DRAWS_PER_PASS; draw += 1) this._renderObjectDirect();
    if (nested) {
      // Three renders the shadow map from inside the main render, renaming the scene as it goes.
      this.render({ name: "Shadow Map [ sun ]" }, camera);
    }
    this.#depth -= 1;
  }

  _projectObject(
    _scene: unknown,
    _camera: unknown,
    depth: number,
    _list: unknown,
    _clip: unknown,
  ): void {
    // Recursive, like three's: only the outermost call may open a span.
    if (depth < PROJECT_DEPTH) {
      this.spend(PROJECT_MS / PROJECT_DEPTH);
      this._projectObject(_scene, _camera, depth + 1, _list, _clip);
    }
  }

  _renderObjectDirect(): void {
    this.spend(DRAW_MS);
  }
}

const PASS_SETUP_MS = 0.2;
const PROJECT_MS = 1.5;
const PROJECT_DEPTH = 3;
const SORT_MS = 0.4;
const DRAW_MS = 0.01;
const DRAWS_PER_PASS = 100;

/** One pass costs setup + list build + sort + its draws; the frame renders two of them. */
const PASS_MS = PASS_SETUP_MS + PROJECT_MS + SORT_MS + DRAW_MS * DRAWS_PER_PASS;

describe("span coverage on a scripted render", () => {
  it("attributes the render phase to at least 97%, with the leftover computed not assumed", () => {
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    const renderer = new FakeRenderer();
    // The probes read the clock through `spanNow`; point it at the scripted one so the tree's
    // arithmetic is exact.
    const realNow = globalThis.performance.now.bind(globalThis.performance);
    globalThis.performance.now = () => renderer.clock;
    const uninstall = installSpanProbes(renderer, sceneRoot());
    try {
      const before = renderer.clock;
      renderer.render({ name: "World" }, {});
      const renderPhaseMs = renderer.clock - before;
      recorder.endFrame(renderPhaseMs);

      const window = recorder.window();
      expect(window).toBeDefined();
      // Two passes: the main camera and the shadow map three renders from inside it.
      expect(window?.renderMs).toBeCloseTo(PASS_MS * 2, 2);
      expect(window?.spans.mainPass?.p50).toBeCloseTo(PASS_MS * 2, 2);
      expect(window?.spans.shadowPass?.p50).toBeCloseTo(PASS_MS, 2);
      expect(window?.spans.projectObject?.p50).toBeCloseTo(PROJECT_MS * 2, 2);
      expect(window?.spans.sort?.p50).toBeCloseTo(SORT_MS * 2, 2);
      expect(window?.spans.draw?.p50).toBeCloseTo(DRAW_MS * DRAWS_PER_PASS * 2, 2);
      // The window residual is the phase minus its top-level spans; the main pass is the only one.
      expect(window?.residualMs).toBeCloseTo(0, 2);
      expect(window?.coverage).toBeGreaterThanOrEqual(0.97);
      // The main pass's own residual is the per-pass setup it does outside the parts we measure —
      // its own 0.2 ms plus the shadow pass's, and nothing else.
      expect(window?.spans.mainPass?.residualP50).toBeCloseTo(PASS_SETUP_MS, 2);
    } finally {
      uninstall();
      globalThis.performance.now = realNow;
      setSpanRecorder(undefined);
    }
  });

  it("puts the probes back exactly as it found them", () => {
    const renderer = new FakeRenderer();
    const render = renderer.render;
    const project = renderer._projectObject;
    const direct = renderer._renderObjectDirect;
    const sort = Object.getPrototypeOf(renderer.list).sort;
    const uninstall = installSpanProbes(renderer, sceneRoot());
    expect(renderer.render).not.toBe(render);
    uninstall();
    expect(renderer.render).toBe(render);
    expect(renderer._projectObject).toBe(project);
    expect(renderer._renderObjectDirect).toBe(direct);
    expect(Object.getPrototypeOf(renderer.list).sort).toBe(sort);
    expect(spanRecorder()).toBeUndefined();
  });
});

describe("the loop closes the span tree", () => {
  it("emits a window on a loop that collects no per-frame samples, which is every shipped game", () => {
    // The regression this is for: the tree used to close on the phase-split object, and
    // `endFrame` builds one only when `collectMetrics` is on. Off — the default — every frame was
    // abandoned and the span window never appeared at all, on any game, however long it ran.
    const recorder = new SpanRecorder();
    setSpanRecorder(recorder);
    const budget = new FrameBudget({ report: () => undefined, reportEvery: 10_000 });
    let clock = 0;
    const loop = new FixedStepLoop({
      budget,
      now: () => clock,
      onRender: () => {
        // One measured span inside the render phase, the way a real frame reports one.
        recorder.begin(SPANS.mainPass, clock);
        clock += 4;
        recorder.end(SPANS.mainPass, clock);
        budget.addRender(4);
        return undefined;
      },
      onUpdate: () => {
        clock += 1;
      },
      spans: recorder,
    });
    try {
      for (let frame = 0; frame < 5; frame += 1) {
        clock += 16;
        loop.stepFrame(frame * 16);
      }
      const window = recorder.window();
      expect(window).toBeDefined();
      expect(window?.frames).toBe(5);
      expect(window?.spans.mainPass?.p50).toBeCloseTo(4, 2);
      expect(window?.renderMs).toBeCloseTo(4, 2);
    } finally {
      setSpanRecorder(undefined);
    }
  });
});

describe("the frame record carries the boundary counts", () => {
  it("summarises host calls and GPU bytes on the same window as the phases", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery: 2 });
    const device = {
      createCommandEncoder: () => ({ drawIndexed: () => undefined }),
      queue: { submit: () => undefined, writeBuffer: (..._args: unknown[]) => undefined },
    };
    const counters = FrameCounters.install(device);
    expect(counters).toBeDefined();

    // The tick moves by more than one fixed step per frame. The window reports the last tick it
    // saw, not the sum across frames and not the frame count, so the join to the simulation is
    // independent of how many frames the window happened to render.
    let tick = 0;
    for (let frame = 0; frame < 2; frame += 1) {
      device.createCommandEncoder().drawIndexed();
      device.queue.writeBuffer({}, 0, new Uint8Array(1_024));
      device.queue.submit();
      budget.beginFrame(frame * 16, frame * 16);
      budget.markSimulationEnd(frame * 16 + 1, 1);
      budget.addRender(10);
      tick += frame === 0 ? 2 : 3;
      budget.addCounters({ ...(counters as FrameCounters).read(), simulationTick: tick });
      budget.endFrame(frame * 16 + 12);
    }

    const window = JSON.parse(lines[0]?.slice("TN_FRAME_BUDGET:".length) ?? "{}");
    expect(window.counters.hostCalls.p50).toBe(4);
    expect(window.counters.gpuBytes.p50).toBe(1_024);
    // 5 is the end tick; the frame count is 2 and the sum of the ticks is 7.
    expect(window.counters.simulationTick).toBe(5);
    counters?.uninstall();
  });

  it("leaves the counters off the window when nothing counted them", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery: 1 });
    budget.beginFrame(0, 0);
    budget.markSimulationEnd(1, 1);
    budget.addRender(10);
    budget.endFrame(12);
    const window = JSON.parse(lines[0]?.slice("TN_FRAME_BUDGET:".length) ?? "{}");
    expect(window.counters).toBeUndefined();
  });

  it("keeps the boundary counts but omits the tick when a frame fed counts without one", () => {
    const lines: string[] = [];
    const budget = new FrameBudget({ report: (line) => lines.push(line), reportEvery: 1 });
    budget.beginFrame(0, 0);
    budget.markSimulationEnd(1, 1);
    budget.addRender(10);
    budget.addCounters({ hostCalls: 3 });
    budget.endFrame(12);
    const window = JSON.parse(lines[0]?.slice("TN_FRAME_BUDGET:".length) ?? "{}");
    expect(window.counters.hostCalls.p50).toBe(3);
    expect(window.counters.simulationTick).toBeUndefined();
  });

  it("rejects a tick that is not a non-negative integer", () => {
    const budget = new FrameBudget({ report: () => undefined, reportEvery: 2 });
    budget.beginFrame(0, 0);
    expect(() => budget.addCounters({ simulationTick: 1.5 })).toThrow(/simulationTick/u);
    expect(() => budget.addCounters({ simulationTick: -1 })).toThrow(/simulationTick/u);
    budget.endFrame(1);
  });
});

/** A Scene-shaped prototype, which is what the walk probe patches. */
class FakeScene {
  updateMatrixWorld(): void {
    // The walk itself is three's; the probe only needs a prototype method to wrap.
  }
}

/** A test seam: the probe reads one prototype method off the root and nothing else about it. */
function sceneRoot(): Object3D {
  return new FakeScene() as unknown as Object3D;
}
