import { ComputeDrivenRegistry, type ICtx, InputMap } from "@threenative/core";
import { type IPhysicsContext, rapier } from "@threenative/physics";
import { Group, PerspectiveCamera } from "three";
import { expect, it, vi } from "vitest";
import { createGameStore } from "../../../packages/core/src/state.js";
import { RiggingScene, registrations } from "../src/game.js";
import {
  AvbdRigging,
  type IAvbdOptions,
  type ISecondarySolver,
} from "../src/physics/avbd-adapter.js";
import { disposeDraw } from "../src/render/rigging.js";
import { fixture } from "./adapter-fixture.js";

// Only GPU execution is replaced. The real scene, model, adapter, registry, input and Rapier run.
vi.mock("../src/physics/avbd-adapter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/physics/avbd-adapter.js")>();
  const { gpuParams3D } = await import("../src/physics/vendor/avbd3d/gpu/solver.js");
  return {
    ...actual,
    AvbdRigging: class extends actual.AvbdRigging {
      constructor(options: IAvbdOptions) {
        super({
          ...options,
          finiteChecks: false,
          readbackEveryTicks: 0,
          solverFactory:
            options.solverFactory ??
            (() =>
              ({
                params: { ...gpuParams3D(), iterations: 12 },
                contactStorage: { counters: {} as GPUBuffer },
                setWorldAnchor: vi.fn(),
                rewriteFixed: vi.fn(),
                step: vi.fn(),
              }) satisfies ISecondarySolver),
        });
      }
    },
  };
});

async function inputScene() {
  const f = fixture();
  const target = new EventTarget();
  const input = new InputMap(
    { moveAnchor: { keys: ["KeyA"] }, fastStop: { keys: ["KeyS"] } },
    target,
  );
  const plugin = rapier({ deterministicRestart: true });
  const scene = new RiggingScene();
  const graph = new Group();
  const registry = new ComputeDrivenRegistry();
  const store = createGameStore<Record<string, unknown>>({});
  const state = store.getState();
  const memory = Object.fromEntries(
    [
      "storageAttributes",
      "storageAttributesSize",
      "readbackBuffers",
      "readbackBuffersSize",
      "attributes",
      "attributesSize",
      "geometries",
      "indexAttributes",
      "indexAttributesSize",
      "indirectStorageAttributes",
      "indirectStorageAttributesSize",
      "programs",
      "programsSize",
      "renderTargets",
      "textures",
      "texturesSize",
      "uniformBuffers",
      "uniformBuffersSize",
      "total",
    ].map((name) => [name, 0]),
  );
  let rigging: AvbdRigging | undefined;
  const renderer = { ...f.renderer, info: { memory }, render: vi.fn() };
  const ctx = {
    input,
    physics: undefined,
    scene: graph,
    camera: new PerspectiveCamera(),
    renderer,
    state: store,
    add: (object: Group) => {
      graph.add(object);
      if (object instanceof AvbdRigging) {
        rigging = object;
        registry.add(object, renderer);
      }
      return object;
    },
  } as unknown as Parameters<RiggingScene["load"]>[0];
  const tap = (code: string) => {
    for (const type of ["keydown", "keyup"]) {
      const event = new Event(type);
      Object.defineProperty(event, "code", { value: code });
      target.dispatchEvent(event);
    }
  };
  await plugin.setup?.(ctx as unknown as ICtx<Record<string, unknown>, IPhysicsContext>);
  await scene.load(ctx);
  scene.enter(ctx);
  if (rigging === undefined) throw new Error("actual candidate was not registered");
  const candidate = rigging;
  return {
    state,
    store,
    tap,
    candidate,
    render: () => scene.render(ctx),
    tick: (compute = true) => {
      input.tick();
      scene.update(ctx, 1 / 60);
      plugin.update?.(ctx, 1 / 60);
      if (compute) registry.process(renderer);
    },
    close: async () => {
      registry.clear();
      candidate.detach();
      await candidate.whenReleased();
      disposeDraw(graph);
      graph.clear();
      plugin.dispose?.(ctx);
      input.dispose();
      expect(f.device.destroy).not.toHaveBeenCalled();
    },
  };
}

it("bounds input and accepted receipts even while startup prevents compute and a second tap arrives", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let f: Awaited<ReturnType<typeof inputScene>> | undefined;
  const count = (prefix: string) =>
    log.mock.calls.filter(([value]) => String(value).startsWith(prefix)).length;
  try {
    f = await inputScene();
    f.tap("KeyA");
    for (let tick = 0; tick < 20; tick++) {
      if (tick === 10) f.tap("KeyA");
      f.tick(false);
    }
    expect(f.candidate.steps).toBe(0);
    expect(count("TN_AVBD_ANCHOR_INPUT:")).toBe(1);
    expect(count("TN_AVBD_ANCHOR_ACCEPTED:")).toBe(0);
    f.tick();
    f.tap("KeyA");
    f.tick();
    expect(count("TN_AVBD_ANCHOR_INPUT:")).toBe(1);
    expect(count("TN_AVBD_ANCHOR_ACCEPTED:")).toBe(1);
  } finally {
    try {
      await f?.close();
    } finally {
      log.mockRestore();
    }
  }
});

it("publishes actual post-Rapier accepted movement at every compute tick without requiring a render", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let f: Awaited<ReturnType<typeof inputScene>> | undefined;
  try {
    f = await inputScene();
    f.tap("KeyA");
    for (let tick = 0; tick < 120; tick++) {
      f.tick();
      expect(f.state.acceptedAnchorVelocity).toBeCloseTo(0.25, 4);
      expect(f.state.acceptedAnchorMoving).toBe(true);
      expect(f.state.anchorX).toBeCloseTo((tick + 1) / 240, 5);
    }
    expect(f.state.anchorMoveRequests).toBe(1);
    expect(f.state.anchorMoving).toBe(1);
    expect(f.state.requestedAnchorX).toBeCloseTo(0.5, 5);
    f.tap("KeyS");
    f.tick();
    expect(f.state.anchorX).toBeCloseTo(0.5, 5);
    expect(f.state.acceptedAnchorVelocity).toBe(0);
    expect(f.state.acceptedAnchorMoving).toBe(false);
    expect(f.state.acceptedAnchorDelta).toBe(0);
    expect(f.state.anchorMoving).toBe(0);
    expect(f.candidate.steps).toBe(121);
  } finally {
    try {
      await f?.close();
    } finally {
      log.mockRestore();
    }
  }
});

it("keeps subscriber navigation outside the current solver dispatch while immediately exposing accepted state", async () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let f: Awaited<ReturnType<typeof inputScene>> | undefined;
  let unsubscribe: (() => void) | undefined;
  try {
    f = await inputScene();
    f.store.flush(); // Publish scene initialization before installing the navigation subscriber.
    const candidate = f.candidate;
    const published = vi.fn(() => candidate.detach());
    unsubscribe = f.store.subscribe(published);
    f.tap("KeyA");
    f.tick();
    expect(f.state.acceptedAnchorVelocity).toBeCloseTo(0.25, 4);
    expect(f.store.getPublishedState().acceptedAnchorVelocity).toBe(0);
    expect(published).not.toHaveBeenCalled();
    expect(candidate.released).toBe(false);
    expect(candidate.steps).toBe(1);
    f.store.flush(); // The existing bridge reads and flushes outside the fixed dispatch.
    expect(published).toHaveBeenCalledTimes(1);
    expect(candidate.released).toBe(true);
    expect(candidate.steps).toBe(1);
  } finally {
    unsubscribe?.();
    try {
      await f?.close();
    } finally {
      log.mockRestore();
    }
  }
});

it("retains one copied sampled peak and recomputes freshness when cached GPU poses age", async () => {
  registrations.install();
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  let f: Awaited<ReturnType<typeof inputScene>> | undefined;
  let restoreObservation: (() => void) | undefined;
  try {
    f = await inputScene();
    f.tick();
    const candidate = f.candidate;
    const bodies = new Float32Array(candidate.model.solver.bodies.length * 40);
    for (const [index, body] of candidate.model.solver.bodies.entries()) {
      bodies.set(body.positionLin, index * 40);
      bodies.set(body.positionAng, index * 40 + 4);
    }
    // A controlled CPU fixture intrudes one thin panel into the real wall proxy.
    bodies.set([0, -0.606656987306814, 4], 0);
    let fixedStep = 1;
    const observation = vi.spyOn(candidate, "observation", "get").mockImplementation(() => ({
      generation: candidate.generation,
      fixedStep,
      staleTicks: candidate.steps - fixedStep,
      bytes: bodies.byteLength,
      totalBytes: bodies.byteLength * fixedStep,
      bodies,
    }));
    restoreObservation = () => observation.mockRestore();
    f.render();
    const peak = f.state.penetrationPeak as Record<string, unknown>;
    expect(peak).toMatchObject({
      generation: candidate.generation,
      sampledFixedStep: 1,
      observedFixedStep: 1,
      staleTicks: 0,
    });
    expect(f.state.penetrationMaximum).toBeGreaterThan(0.02);
    expect(f.state.sampleChecks).toMatchObject({
      penetrationMaximum: false,
      fresh: true,
      readback: true,
    });
    const copy = JSON.stringify(peak);
    bodies.set([0, 0, 4], 0);
    f.tick();
    fixedStep = 2;
    f.render();
    expect(JSON.stringify(f.state.penetrationPeak)).toBe(copy);
    expect(f.state.sampleChecks).toMatchObject({ penetrationMaximum: false });
    for (let tick = 0; tick < 121; tick++) f.tick();
    f.render();
    expect(f.state.sampleChecks).toMatchObject({ fresh: false });
  } finally {
    try {
      restoreObservation?.();
    } finally {
      try {
        await f?.close();
      } finally {
        try {
          registrations.dispose();
        } finally {
          log.mockRestore();
        }
      }
    }
  }
});
