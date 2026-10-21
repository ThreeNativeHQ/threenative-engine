import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const order: string[] = [];
  const ocean = {
    advance: vi.fn((seconds: number) => order.push(`ocean:${seconds}`)),
    process: vi.fn(),
    sampleHeight: vi.fn<() => { height: number; staleFrames: number } | undefined>(() => undefined),
  };
  const sea = {
    advance: vi.fn((seconds: number) => order.push(`sea:${seconds}`)),
    dispose: vi.fn(),
    follow: vi.fn(),
    wake: vi.fn(),
  };
  const ship = {
    capsize: vi.fn(),
    capsized: false,
    forward: { x: 0, z: -1 },
    heading: 0,
    immersion: 0,
    mesh: { position: { x: 0, y: 0, z: 0 } },
    speed: 0,
    starboard: { x: 1, z: 0 },
    update: vi.fn(() => order.push("ship")),
    visual: { position: { x: 0, y: 0, z: 0 } },
  };
  return { ocean, order, sea, ship };
});

vi.mock("@threenative/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@threenative/core")>();
  return {
    ...actual,
    isMobile: () => false,
    isTouchscreenAvailable: () => false,
  };
});

vi.mock("../templates/sailing/src/entities/Ship.js", () => ({
  Ship: vi.fn(function ShipMock() {
    return fixture.ship;
  }),
}));
vi.mock("../templates/sailing/src/render/camera.js", () => ({
  followShip: vi.fn(),
  setupCamera: vi.fn(),
}));
vi.mock("../templates/sailing/src/render/lighting.js", () => ({
  followSun: vi.fn(),
  setupLighting: vi.fn(() => ({})),
}));
vi.mock("../templates/sailing/src/render/loading.js", () => ({
  createLoadingScreen: vi.fn(() => ({ update: vi.fn() })),
}));
vi.mock("../templates/sailing/src/render/materials.js", () => ({
  createMaterials: vi.fn(() => ({})),
}));
vi.mock("../templates/sailing/src/render/ocean.js", () => ({
  createOcean: vi.fn(() => fixture.ocean),
  createWaterMesh: vi.fn(() => fixture.sea),
  markReflected: vi.fn(),
  SEA_MIRROR: { level: 0, maxThickness: 24, reflection: { resolutionScale: 0.5, layers: 2 } },
  surfaceHeight: vi.fn(() => 0),
}));
vi.mock("../templates/sailing/src/render/postprocessing.js", () => ({
  setupPost: vi.fn(() => ({ tier: "high", dispose: vi.fn() })),
}));
vi.mock("../templates/sailing/src/render/materialLighting.js", () => ({
  createMaterialLighting: vi.fn(() => ({
    setEnabled: vi.fn(),
    setEnvironmentMeasurement: vi.fn(),
    dispose: vi.fn(),
  })),
}));
vi.mock("../templates/sailing/src/render/environmentSetup.js", () => ({
  loadedEnvironmentSample: vi.fn(() => undefined),
}));
vi.mock("../templates/sailing/src/render/props.js", () => ({
  createBuoy: vi.fn(() => ({ position: { set: vi.fn() } })),
  createIsland: vi.fn(() => ({})),
  // `Sailing.enter()` reads this synchronously; `Boot.load()` populates it in the real game.
  getShipModel: vi.fn(() => ({ scene: {} })),
}));
vi.mock("../templates/sailing/src/render/sky.js", () => ({
  setupSky: vi.fn(),
}));

import { Sailing } from "../templates/sailing/src/scenes/Sailing.js";

import { STARTUP_HOLD_BUDGET_MS, StartupReadiness } from "../../core/src/startup-readiness.js";

function harness(startup = new StartupReadiness({ stableFrames: 1 })) {
  const callbacks = new Set<() => void>();
  const context = {
    add: <T>(object: T): T => object,
    camera: {},
    entities: { add: <T>(_id: string, entity: T): T => entity },
    interpolate: () => () => undefined,
    input: { justPressed: () => false, raw: { pointers: new Map() } },
    physics: {},
    renderer: { raw: {} },
    scene: {},
    state: { flush: () => undefined, getState: () => Sailing.initialState, set: () => undefined },
    viewport: { size: { aspect: 16 / 9, height: 720, width: 1280 } },
    startup: {
      get phase() {
        return startup.ready ? "ready" : "collapsing";
      },
      hold: startup.hold.bind(startup),
      whenFrameworkReady: startup.whenFrameworkReady.bind(startup),
    },
    beforeRender(callback: () => void) {
      callbacks.add(callback);
      return () => callbacks.delete(callback);
    },
  } as never;
  const scene = new Sailing();
  scene.enter(context);
  return {
    callbacks,
    context,
    scene,
    startup,
    render: () => {
      for (const callback of [...callbacks]) callback();
    },
  };
}
async function framework(h: ReturnType<typeof harness>) {
  h.startup.start();
  await Promise.resolve();
  await Promise.resolve();
  h.startup.observe(1);
  await Promise.resolve();
  await Promise.resolve();
}
beforeEach(() => {
  vi.useFakeTimers();
  fixture.ocean.process.mockReset();
  fixture.ocean.advance.mockClear();
  fixture.ocean.sampleHeight.mockReset().mockReturnValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sailing first height readiness", () => {
  it("registers its initial hold synchronously and dispatches only after framework readiness", async () => {
    const h = harness();
    expect(h.startup.pendingHolds).toHaveLength(1);
    h.render();
    expect(fixture.ocean.process).not.toHaveBeenCalled();
    await framework(h);
    expect(fixture.ocean.process).toHaveBeenCalledTimes(1);
    h.render();
    h.render();
    expect(fixture.ocean.process).toHaveBeenCalledTimes(1);
    expect(h.startup.ready).toBe(false);
    h.scene.exit(h.context);
  });
  it.each([
    undefined,
    { height: Number.NaN, staleFrames: 0 },
    { height: Number.POSITIVE_INFINITY, staleFrames: 0 },
  ])("keeps readiness held for unavailable or invalid samples (%s)", async (sample) => {
    const h = harness();
    await framework(h);
    fixture.ocean.sampleHeight.mockReturnValue(sample);
    h.render();
    await Promise.resolve();
    expect(h.startup.ready).toBe(false);
    h.scene.exit(h.context);
  });
  it("accepts a finite zero height without advancing simulation and removes its observer", async () => {
    const h = harness();
    await framework(h);
    expect(h.startup.ready).toBe(false);
    fixture.ocean.sampleHeight.mockReturnValue({ height: 0, staleFrames: 0 });
    h.render();
    await h.startup.whenReady();
    expect(h.startup.ready).toBe(true);
    expect(fixture.ocean.advance).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.scene.exit(h.context);
  });
  it("reports its bounded failure before the fail-open gate releases without fabricating height", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const h = harness();
    await framework(h);
    expect(h.startup.ready).toBe(false);
    await vi.advanceTimersByTimeAsync(STARTUP_HOLD_BUDGET_MS);
    await h.startup.whenReady();
    expect(errors.mock.calls.flat().join(" ")).toContain("TN_SAILING_HEIGHT_READBACK_FAILED");
    expect(h.callbacks.size).toBe(0);
    expect(fixture.ocean.sampleHeight()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    h.scene.exit(h.context);
  });
  it("cancels polling on exit and cannot dispatch after late framework completion", async () => {
    const h = harness();
    expect(h.startup.pendingHolds).toHaveLength(1);
    h.scene.exit(h.context);
    await framework(h);
    expect(fixture.ocean.process).not.toHaveBeenCalled();
    expect(h.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports a synchronous compute failure and releases the hold", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    fixture.ocean.process.mockImplementation(() => {
      throw new Error("compute failed");
    });
    const h = harness();
    await framework(h);
    await h.startup.whenReady();
    expect(errors.mock.calls.flat().join(" ")).toContain("compute failed");
    expect(h.callbacks.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    h.scene.exit(h.context);
  });
  it("restarts after readiness without registering a late or duplicate hold", async () => {
    const h = harness();
    await framework(h);
    fixture.ocean.sampleHeight.mockReturnValue({ height: 1, staleFrames: 0 });
    h.render();
    await h.startup.whenReady();
    h.scene.exit(h.context);
    expect(() => new Sailing().enter(h.context)).not.toThrow();
    expect(h.startup.holdReport).toHaveLength(1);
    expect(h.callbacks.size).toBe(0);
  });
  it("can replace an exited scene during startup without a duplicate hold label", async () => {
    const h = harness();
    expect(h.startup.pendingHolds).toHaveLength(1);
    h.scene.exit(h.context);
    const next = new Sailing();
    expect(() => next.enter(h.context)).not.toThrow();
    await framework(h);
    expect(fixture.ocean.process).toHaveBeenCalledTimes(1);
    fixture.ocean.sampleHeight.mockReturnValue({ height: 0, staleFrames: 0 });
    h.render();
    await h.startup.whenReady();
    expect(h.startup.holdReport).toHaveLength(2);
    next.exit(h.context);
  });
});
