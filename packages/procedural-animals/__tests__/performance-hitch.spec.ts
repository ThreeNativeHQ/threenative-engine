import type { IPhysicsContext } from "@threenative/physics";
import { PLAYTEST_BRIDGE_GLOBAL, PLAYTEST_CLOCK_GLOBAL } from "@threenative/playtest/protocol";
import { PerspectiveCamera, Scene } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAnimalsState } from "../../../examples/procedural-animals/src/Animals.js";
import { FrameBudget } from "../../core/src/frame-budget.js";
import type { IGameConfig } from "../../core/src/game.js";

const captured = vi.hoisted(() => ({
  config: undefined as IGameConfig<IAnimalsState, IPhysicsContext> | undefined,
}));
// Capture authored configuration without starting a DOM/GPU game; the report sink, collector,
// public Three callbacks and FrameBudget are real. GPU destruction alone is stubbed.
vi.mock("../../core/dist/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@threenative/core")>()),
  defineGame: (config: IGameConfig<IAnimalsState, IPhysicsContext>) => {
    captured.config = config;
    return {};
  },
}));
import { makeAnimalPerformanceGame } from "../../../examples/procedural-animals/src/performance-game.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function admission() {
  makeAnimalPerformanceGame("baseline");
  const config = captured.config;
  if (!config || !config.frameBudget) throw new Error("Missing authored benchmark");
  const plugin = config.plugins?.[2];
  if (!plugin || typeof plugin === "function" || !plugin.setup)
    throw new Error("Missing authored plugin");
  let beforeRender: (() => void) | undefined;
  const state: Record<string, unknown> = {};
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const dispose = vi.fn();
  const observer = {
    take: vi.fn(() => [] as readonly unknown[]),
    status: vi.fn(() => ({ state: "active", generation: 1 })),
    stop: vi.fn(),
    dispose,
  };
  const ctx = {
    startup: { phase: "ready" },
    input: { justPressed: () => true },
    renderer: { compiling: false, compileCount: 0, observeGpuFrames: () => observer },
    state: { set: (patch: Record<string, unknown>) => Object.assign(state, patch) },
    beforeRender: (callback: () => void) => {
      beforeRender = callback;
      return () => {};
    },
    scene,
    camera,
  };
  const restoreScene = scene.onBeforeRender;
  const budget = new FrameBudget(config.frameBudget);
  // Establish a presented timestamp before the benchmark is armed.
  budget.beginFrame(0, 0);
  budget.markSimulationEnd(0, 0);
  budget.endFrame(0);
  const cleanup = await plugin.setup(ctx as never, { tick: () => 10 } as never);
  vi.stubGlobal(PLAYTEST_CLOCK_GLOBAL, "wall-clock");
  vi.stubGlobal(PLAYTEST_BRIDGE_GLOBAL, {
    sample: async () => ({ clock: { mode: "wall-clock", tick: 10, timeMs: 20 } }),
  });
  plugin.beforeUpdate?.(ctx as never, 1 / 60);
  if (!beforeRender) throw new Error("Missing frame admission");
  beforeRender();
  await Promise.resolve();
  await Promise.resolve();
  beforeRender();
  expect(state.performanceStarted).toBe(true);
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  return { budget, state, scene, camera, restoreScene, cleanup, dispose, observer, error, log };
}

describe("animal benchmark hitch attribution", () => {
  it("retains already-resolved GPU observations before cleanup without claiming a complete series", async () => {
    const s = await admission();
    const queued = Object.freeze({
      generation: 1,
      frame: 0,
      batch: 1,
      ms: 2,
      queries: Object.freeze([Object.freeze({ uid: "r:main:f0", begin: 0, end: 1, ms: 2 })]),
    });
    s.observer.take.mockReturnValue([queued]);
    s.budget.beginFrame(2500, 2500);
    s.budget.markSimulationEnd(2501, 1);
    s.budget.endFrame(2502);
    expect(s.observer.take).toHaveBeenCalledTimes(1);
    expect(s.observer.take.mock.invocationCallOrder[0]).toBeLessThan(
      s.dispose.mock.invocationCallOrder[0] ?? 0,
    );
    const abort = String(s.log.mock.calls[0]?.[0]);
    expect(abort).toContain('"resolvedGpuFrames":1');
    expect(abort).toContain('"observerStatusBeforeCleanup":{"state":"active","generation":1}');
    const partial = String(s.log.mock.calls[1]?.[0]);
    expect(partial).toContain("TN_ANIMAL_PERFORMANCE_PARTIAL_GPU ");
    expect(JSON.parse(partial.slice("TN_ANIMAL_PERFORMANCE_PARTIAL_GPU ".length))).toEqual({
      index: 0,
      ...queued,
    });
    expect(
      s.log.mock.calls.every(([value]) => !String(value).includes("TN_ANIMAL_PERFORMANCE_END ")),
    ).toBe(true);
    expect(s.log.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...s.dispose.mock.invocationCallOrder),
    );
    s.cleanup?.();
  });

  it.each(["take", "status"] as const)(
    "preserves the first error and releases resources when diagnostic %s fails",
    async (method) => {
      const s = await admission();
      s.observer[method].mockImplementation(() => {
        throw new Error(`diagnostic-${method}`);
      });
      s.budget.beginFrame(2500, 2500);
      s.budget.markSimulationEnd(2501, 1);
      s.budget.endFrame(2502);
      expect(s.state.performanceFinished).toBe(true);
      expect(s.state.performanceDone).toBe(false);
      // The existing collector and release list both dispose the idempotent observer.
      expect(s.dispose).toHaveBeenCalledTimes(2);
      const abort = String(s.log.mock.calls[0]?.[0]);
      expect(abort).toContain("TN_ANIMAL_PERFORMANCE_FRAME_HITCH:TN_FRAME_HITCH:");
      expect(abort).toContain(`diagnostic-${method}`);
      expect(s.error.mock.calls[0]?.[0]).toBeInstanceOf(AggregateError);
      const failure = s.error.mock.calls[0]?.[0] as AggregateError;
      expect(String(failure.errors[0])).toContain("TN_ANIMAL_PERFORMANCE_FRAME_HITCH:");
      expect(String(failure.errors[1])).toContain(`diagnostic-${method}`);
      s.cleanup?.();
    },
  );

  it("preserves specific cleanup and diagnostic causes in captured console text", async () => {
    const s = await admission();
    s.observer.take.mockImplementation(() => {
      throw new AggregateError([new Error("diagnostic-specific")], "diagnostic-wrapper");
    });
    s.dispose.mockImplementation(() => {
      throw new Error("cleanup-specific");
    });
    s.budget.beginFrame(2500, 2500);
    s.budget.markSimulationEnd(2501, 1);
    s.budget.endFrame(2502);
    const abort = String(s.log.mock.calls[0]?.[0]);
    expect(abort).toContain("TN_ANIMAL_PERFORMANCE_FRAME_HITCH:TN_FRAME_HITCH:");
    expect(abort).toContain("diagnostic-specific");
    expect(abort).toContain("cleanup-specific");
    expect(s.state.performanceFinished).toBe(true);
    expect(s.state.performanceDone).toBe(false);
    expect(s.dispose).toHaveBeenCalledTimes(2);
    expect(() => s.cleanup?.()).toThrow("TN_ANIMAL_CLEANUP_FAILED");
  });

  it("rejects and releases an armed collector on the exact public hitch marker before another render", async () => {
    const s = await admission();
    const renderer = { info: { frame: 1, update: () => {} } };
    s.budget.beginFrame(2500, 2500);
    s.scene.onBeforeRender(
      renderer as never,
      s.scene,
      s.camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    s.scene.onAfterRender(
      renderer as never,
      s.scene,
      s.camera,
      null as never,
      undefined as never,
      undefined as never,
    );
    s.budget.markSimulationEnd(2501, 1);
    s.budget.endFrame(2502);
    expect(s.state.performanceFinished).toBe(true);
    expect(s.state.performanceDone).toBe(false);
    expect(s.state.performanceError).toContain("TN_ANIMAL_PERFORMANCE_FRAME_HITCH:TN_FRAME_HITCH:");
    expect(s.state.performanceError).toContain('"gapMs":2500');
    expect(s.scene.onBeforeRender).toBe(s.restoreScene);
    expect(s.dispose).toHaveBeenCalled();
    expect(s.error.mock.calls).toHaveLength(1);
    expect(s.log.mock.calls).toHaveLength(2);
    expect(s.log.mock.invocationCallOrder[0]).toBeGreaterThan(
      Math.max(...s.dispose.mock.invocationCallOrder),
    );
    const abort = s.log.mock.calls[0]?.[0];
    const row = s.log.mock.calls[1]?.[0];
    expect(abort).toContain("TN_ANIMAL_PERFORMANCE_ABORT ");
    expect(abort).toContain('"recordedFrames":1');
    expect(row).toContain("TN_ANIMAL_PERFORMANCE_PARTIAL_ROW ");
    const partial = JSON.parse(String(row).slice("TN_ANIMAL_PERFORMANCE_PARTIAL_ROW ".length));
    expect(partial).toMatchObject({ index: 0, frame: 1, ended: true, warmup: true });
    expect(partial.cpuMs).toBeUndefined();
    expect(partial.gpu).toBeUndefined();
    s.cleanup?.();
  });
});
