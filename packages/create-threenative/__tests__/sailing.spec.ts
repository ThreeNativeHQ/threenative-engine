import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => {
  const order: string[] = [];
  const ocean = {
    advance: vi.fn((seconds: number) => order.push(`ocean:${seconds}`)),
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
// These cases exercise course scoring, not appearance; material lifecycle has dedicated tests.
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

/** The four marks, in the order the scene lays them out. */
const COURSE = [
  { x: 12, z: -10 },
  { x: 2, z: -40 },
  { x: -30, z: -46 },
  { x: -34, z: -6 },
] as const;

/**
 * The scene's own context, with the state object it mutates handed back so a case can read the
 * status the frame reached. Every case builds its own: the ship mock is shared and hoisted, so a
 * case that inherited another's call log would pass on the previous case's frames.
 */
async function createScene(): Promise<{
  context: never;
  frame: (ctx: never, deltaTime: number) => void;
  state: typeof Sailing.initialState;
}> {
  const state = { ...Sailing.initialState };
  const context = {
    add: <T>(object: T): T => object,
    camera: {},
    entities: { add: <T>(_id: string, entity: T): T => entity },
    interpolate: () => () => undefined,
    input: {
      justPressed: () => false,
      raw: { pointers: new Map() },
    },
    physics: {},
    renderer: { raw: {} },
    startup: { phase: "ready" },
    scene: {},
    state: {
      flush: vi.fn(),
      getState: () => state,
      set: (patch: Partial<typeof state>) => Object.assign(state, patch),
    },
    viewport: { size: { aspect: 16 / 9, height: 720, width: 1280 } },
  } as never;

  const sailing = new Sailing();
  const frame = sailing.enter(context);
  if (typeof frame !== "function") throw new Error("Sailing.enter returned no scene frame.");
  return { context, frame, state };
}

/** Put the hull on a mark, which is how a mark is rounded. */
function at(index: number): void {
  const mark = COURSE[index];
  if (mark === undefined) return;
  fixture.ship.mesh.position.x = mark.x;
  fixture.ship.mesh.position.z = mark.z;
  fixture.ship.visual.position.x = mark.x;
  fixture.ship.visual.position.z = mark.z;
}

beforeEach(() => {
  fixture.order.length = 0;
  for (const mock of [
    fixture.ocean.advance,
    fixture.sea.advance,
    fixture.sea.follow,
    fixture.sea.wake,
    fixture.ship.update,
    fixture.ship.capsize,
  ])
    mock.mockClear();
  // Every mutable field on the shared mock, not just the ones a case happens to touch today: the
  // fixture is hoisted once for the whole file, so a field left dirty here is a case reading the
  // previous case's ship.
  fixture.ship.capsized = false;
  fixture.ship.immersion = 0;
  fixture.ship.speed = 0;
  fixture.ship.mesh.position = { x: 0, y: 0, z: 0 };
  fixture.ship.visual.position = { x: 0, y: 0, z: 0 };
});

describe("sailing scene ocean clock", () => {
  it("advances the ocean and the surface's own clock, then moves the hull", async () => {
    const { context, frame } = await createScene();

    frame(context, 0.25);
    frame(context, 0.5);

    // The ripple normals run on the game's clock rather than the engine's, so a paused game has a
    // still sea and a capture is reproducible. Both clocks read the same elapsed seconds.
    expect(fixture.ocean.advance.mock.calls.map(([seconds]) => seconds)).toEqual([0.25, 0.75]);
    expect(fixture.sea.advance.mock.calls.map(([seconds]) => seconds)).toEqual([0.25, 0.75]);
    expect(fixture.order).toEqual([
      "ocean:0.25",
      "sea:0.25",
      "ship",
      "ocean:0.75",
      "sea:0.75",
      "ship",
    ]);
  });
});

describe("sailing scene terminal states", () => {
  it("keeps the hull moving after the course is won, and stops scoring", async () => {
    const { context, frame, state } = await createScene();

    // One mark per frame, so four frames round the whole circuit.
    for (let index = 0; index < COURSE.length; index += 1) {
      at(index);
      frame(context, 0.1);
    }
    expect(state.status).toBe("won");
    expect(state.buoysRounded).toBe(4);

    fixture.order.length = 0;
    frame(context, 0.1);
    frame(context, 0.1);

    // The sea keeps moving under the hull, and the hull keeps being carried: a finished ship still
    // has way on, still rides the swell and still slows down. Freezing it where it stood left the
    // player looking at a stationary boat on a moving sea, which is the one thing in the frame
    // that cannot happen.
    expect(fixture.ocean.advance).toHaveBeenCalledTimes(6);
    expect(fixture.sea.advance).toHaveBeenCalledTimes(6);
    expect(fixture.ship.update).toHaveBeenCalledTimes(6);
    expect(fixture.order).toEqual(["ocean:0.5", "sea:0.5", "ship", "ocean:0.6", "sea:0.6", "ship"]);
    // Only the scoring stops: the passage stays won and no further mark is collected.
    expect(state.status).toBe("won");
    expect(state.buoysRounded).toBe(4);
  });

  it("keeps the hull moving after the wind expires, and stops scoring", async () => {
    const { context, frame, state } = await createScene();

    // Never reaches a mark; the wind runs out at 120 s and the passage is lost where it sits.
    frame(context, 100);
    expect(state.status).toBe("sailing");
    expect(state.wind).toBeGreaterThan(0);
    frame(context, 40);
    expect(state.status).toBe("lost");
    expect(state.wind).toBe(0);

    fixture.order.length = 0;
    frame(context, 1);
    frame(context, 1);

    expect(fixture.ship.update).toHaveBeenCalledTimes(4);
    expect(fixture.order).toEqual(["ocean:141", "sea:141", "ship", "ocean:142", "sea:142", "ship"]);
    expect(state.status).toBe("lost");
    expect(state.buoysRounded).toBe(0);
  });
});
