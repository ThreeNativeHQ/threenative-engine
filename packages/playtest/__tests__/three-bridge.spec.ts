import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Scene, type Vector2, type WebGLRenderer } from "three";
import { expect, test, vi } from "vitest";

import { PLAYTEST_CLOCK_GLOBAL } from "../src/protocol.js";
import { waitForResource } from "../src/runner/wait-for-resource.js";
import { installThreePlaytestBridge } from "../src/three/bridge.js";
import { ThreePlaytestEntityRegistry } from "../src/three/entities.js";

// Ported from src/three/bridge.test.ts, which was written in node:test format and
// therefore matched no pattern in vitest.config.ts — the three.js adapter, the one
// piece every real application installs, had zero executing coverage.
//
// A stub for the renderer size and optional `info.render` counters is enough and
// keeps the suite off the GPU.
const renderer = {
  getDrawingBufferSize(target: Vector2) {
    return target.set(1280, 720);
  },
} as WebGLRenderer;

test("resource-only polls leave scene, entity and component observers for the full witness", async () => {
  const scene = new Scene();
  const entities = vi.fn(() => [{ id: "wolf", object: new Mesh() }]);
  const components = vi.fn(() => ({ wolf: { alive: true } }));
  const gameplay = vi.fn(() => ({ animation: {}, states: { wolf: "walking" } }));
  const update = vi.spyOn(scene, "updateMatrixWorld");
  const size = vi.fn(renderer.getDrawingBufferSize);
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    clockMode: "wall-clock",
    components,
    entities,
    gameplay,
    renderer: { getDrawingBufferSize: size },
    scene,
    tick: () => 7,
    fixedStep: () => {},
    resources: { read: () => ({ state: { ready: true } }) },
  });
  try {
    entities.mockClear();
    const poll = await installation.bridge.sample({ entities: [], include: ["resources"], resources: ["state"] });
    expect(poll.resources).toEqual({ state: { ready: true } });
    expect(poll.clock).toMatchObject({ mode: "wall-clock", tick: 7 });
    expect(Number.isFinite(poll.clock.timeMs)).toBe(true);
    for (const observer of [entities, components, gameplay, update, size]) expect(observer).not.toHaveBeenCalled();
    expect(poll.components).toBeUndefined();
    const full = await installation.bridge.sample({});
    expect(full.components).toEqual({ wolf: { alive: true } });
    expect(full.entities?.[0]?.id).toBe("wolf");
    for (const observer of [entities, components, gameplay, update, size]) expect(observer).toHaveBeenCalled();
  } finally {
    installation.dispose();
  }
});

test("marks the sample as the observer's, so a bridge census leaves its scene walk out", async () => {
  // three-native's census (TN_BRIDGE_WARNING) failed hosted CI's adventure runs on the sample's
  // own material count and bounds walk, reads that no player run makes.
  const host = globalThis as { __tnPlaytestObserving?: number };
  const seen: (number | undefined)[] = [];
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
    resources: {
      read: () => {
        seen.push(host.__tnPlaytestObserving);
        throw new Error("a failing observer still ends the scope");
      },
    },
  });
  try {
    await expect((async () => installation.bridge.sample({ include: ["resources"], resources: ["state"] }))()).rejects.toThrow();
    expect(seen).toEqual([1]);
    expect(host.__tnPlaytestObserving ?? 0).toBe(0);
  } finally {
    installation.dispose();
  }
});

test("resource-only polls still reject non-JSON observations", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
    resources: { read: () => ({ state: { ready: Number.NaN } }) },
  });
  try {
    await expect(Promise.resolve().then(() => installation.bridge.sample({ entities: [], include: ["resources"], resources: ["state"] }))).rejects.toThrow();
  } finally {
    installation.dispose();
  }
});

test("a passing resource poll cannot bypass an invalid full component witness", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
    resources: { read: () => ({ state: { ready: true } }) },
    components: () => ({ wolf: { value: Number.NaN } }),
  });
  let polls = 0;
  let full = 0;
  try {
    await expect(
      waitForResource({
        id: "state",
        path: "ready",
        predicate: { equals: true },
        timeoutMs: 1000,
        poll: async () => {
          polls++;
          return installation.bridge.sample({ entities: [], include: ["resources"], resources: ["state"] });
        },
        sample: async () => {
          full++;
          return installation.bridge.sample({});
        },
      }),
    ).rejects.toThrow(/finite JSON/u);
    expect({ polls, full }).toEqual({ polls: 1, full: 1 });
  } finally {
    installation.dispose();
  }
});

test("bridge samples registered transforms and projected bounds without owning a render loop", async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.z = 5;
  const player = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  player.name = "Player";
  scene.add(player);
  const installation = installThreePlaytestBridge({
    camera,
    entities: [{ id: "player", object: player }],
    renderer,
    scene,
  });

  const snapshot = await installation.bridge.sample({ entities: ["player"] });

  expect(snapshot.entities?.[0]?.transform?.position).toEqual([0, 0, 0]);
  expect(snapshot.entities?.[0]?.bounds?.width ?? 0).toBeGreaterThan(0);
  expect(snapshot.entities?.[0]?.visible).toBe(true);
  expect((await installation.bridge.describe()).capabilities).not.toContain("runtime.fixedStep");
  installation.dispose();
});

test("bridge exposes WebGPU render.drawCalls and finite triangles", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer: {
      ...renderer,
      info: { render: { calls: 99, drawCalls: 17, triangles: 42 } },
    } as unknown as WebGLRenderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.sample({})).performance).toEqual({ drawCalls: 17, triangles: 42 });
  installation.dispose();
});

test("bridge does not treat WebGL render.calls as a drawCalls counter", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer: {
      ...renderer,
      info: { render: { calls: 17, triangles: 42 } },
    } as unknown as WebGLRenderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.sample({})).performance).toEqual({ triangles: 42 });
  installation.dispose();
});

test("bridge omits unavailable and non-finite renderer counters", async () => {
  const missing = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer: {
      ...renderer,
      info: { render: { calls: Number.POSITIVE_INFINITY, drawCalls: Number.NaN, triangles: "unavailable" } },
    } as unknown as WebGLRenderer,
    scene: new Scene(),
  });

  expect((await missing.bridge.sample({})).performance).toBeUndefined();
  missing.dispose();
});

test("duplicate ids fail with both conflicting object paths", () => {
  const scene = new Scene();
  scene.name = "World";
  const first = new Mesh();
  first.name = "First";
  const second = new Mesh();
  second.name = "Second";
  scene.add(first, second);
  const registry = new ThreePlaytestEntityRegistry();
  registry.register({ id: "player", object: first });

  expect(() => registry.register({ id: "player", object: second })).toThrow(/World\/First.*World\/Second/u);
});

test("fixed-step and resource providers advertise only installed capabilities", async () => {
  const state = { score: 0 };
  let tick = 0;
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: (ticks) => {
      state.score += ticks;
      tick += ticks;
    },
    renderer,
    resources: {
      read: () => ({ GameState: { score: state.score } }),
      write: (_id, _path, value) => {
        state.score = Number(value);
        return true;
      },
    },
    scene: new Scene(),
    tick: () => tick,
  });

  await installation.bridge.advance?.(3);

  expect(state.score).toBe(3);
  expect((await installation.bridge.sample({})).resources).toEqual({ GameState: { score: 3 } });
  const capabilities = (await installation.bridge.describe()).capabilities;
  expect(capabilities).toContain("runtime.fixedStep");
  expect(capabilities).toContain("runtime.resources");
  installation.dispose();
});

test("reports the bounded runtime diagnostics series through the bridge", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    runtimeDiagnosticsSeries: () => [
      { drawCalls: 4, frameMs: 16.7, triangles: 96 },
      { frameMs: 17.2 },
    ],
    scene: new Scene(),
  });

  const description = await installation.bridge.describe();
  const omitted = await installation.bridge.sample({});
  const snapshot = await installation.bridge.sample({ include: ["runtimeDiagnosticsSeries"] });

  expect(description.capabilities).toContain("runtime.performance");
  expect(omitted.runtimeDiagnosticsSeries).toBeUndefined();
  expect(snapshot.runtimeDiagnosticsSeries).toEqual([
    { drawCalls: 4, frameMs: 16.7, triangles: 96 },
    { frameMs: 17.2 },
  ]);
  installation.dispose();
});

test("fixed-step fails closed when actual updates differ from requested ticks", async () => {
  let tick = 2;
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: () => { tick += 2; },
    renderer,
    scene: new Scene(),
    tick: () => tick,
  });

  expect((await installation.bridge.sample({})).clock.tick).toBe(2);
  await expect(installation.bridge.advance?.(1)).rejects.toThrow(
    "fixedStep advanced 2 actual ticks; expected 1.",
  );
  installation.dispose();
});

test("a wall-clock request makes the host's own pump the clock, whatever the installer passed", async () => {
  // The browser half of the production profile: a runner asks for the wall clock before the page
  // loads, the game's own frame pump moves the simulation, and `advance` names the span those
  // ticks cover rather than stepping the loop itself. The bridge judged that pump a fixed-step
  // producer and failed a healthy run with "fixedStep advanced 3 actual ticks; expected 1" — a
  // count error about a clock nobody had chosen, thrown at a loop that was running correctly.
  const host = globalThis as Record<string, unknown>;
  const previous = host[PLAYTEST_CLOCK_GLOBAL];
  host[PLAYTEST_CLOCK_GLOBAL] = "wall-clock";
  let tick = 0;
  // A live host, not the bridge's own stepping: the claim is that ticks arriving from somewhere
  // else are the clock, so the pump has to be the only thing that produces them.
  const pump = setInterval(() => { tick += 1; }, 10);
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: async (ticks) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      tick += ticks;
    },
    renderer,
    scene: new Scene(),
    tick: () => tick,
  });

  try {
    const advanced = await installation.bridge.advance?.(1);
    expect(advanced?.clock.mode).toBe("wall-clock");
    // The ticks the pump really ran during the span, not the count the request named.
    expect(advanced?.ticks ?? 0).toBeGreaterThan(1);
    expect((await installation.bridge.sample({})).clock.mode).toBe("wall-clock");
  } finally {
    clearInterval(pump);
    installation.dispose();
    if (previous === undefined) Reflect.deleteProperty(host, PLAYTEST_CLOCK_GLOBAL);
    else host[PLAYTEST_CLOCK_GLOBAL] = previous;
  }
});

test("an unrecognised clock request fails closed instead of falling back to fixed-step", async () => {
  const host = globalThis as Record<string, unknown>;
  const previous = host[PLAYTEST_CLOCK_GLOBAL];
  // A misspelling that quietly became a fixed-step run published a frame rate for a game that was
  // not playing, which is the whole reason this switch is a name and not a boolean.
  host[PLAYTEST_CLOCK_GLOBAL] = "wallclock";
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: () => undefined,
    renderer,
    scene: new Scene(),
    tick: () => 0,
  });

  try {
    expect(() => installation.bridge.sample({})).toThrow("TN_PLAYTEST_CLOCK_UNSUPPORTED");
  } finally {
    installation.dispose();
    if (previous === undefined) Reflect.deleteProperty(host, PLAYTEST_CLOCK_GLOBAL);
    else host[PLAYTEST_CLOCK_GLOBAL] = previous;
  }
});

test("fixed-step refuses to advertise without an authoritative tick provider", () => {
  expect(() => installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: () => undefined,
    renderer,
    scene: new Scene(),
  })).toThrow("fixedStep and its authoritative tick provider must be installed together.");
});

test("gameplay providers advertise and return animation and state channels together", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    gameplay: () => ({
      animation: { fox: { advancedFrames: 12, clip: "run" } },
      states: { fox: "run" },
    }),
    renderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.describe()).capabilities).toEqual([
    "camera.observe",
    "entity.bounds",
    "entity.observe",
    "entity.setup",
    "scene.nodes",
    "scene.observe",
    "runtime.animation",
    "runtime.state",
  ]);
  expect((await installation.bridge.sample({})).gameplay).toEqual({
    animation: { fox: { advancedFrames: 12, clip: "run" } },
    states: { fox: "run" },
  });
  installation.dispose();
});

test("component and event providers advertise only the observations they supply", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    components: () => ({ player: { health: 2 } }),
    events: () => [{ entity: "player", name: "collected" }],
    renderer,
    scene: new Scene(),
  });

  const description = await installation.bridge.describe();
  expect(description.capabilities).toContain("runtime.components");
  expect(description.capabilities).toContain("runtime.events");
  expect((await installation.bridge.sample({})).components).toEqual({ player: { health: 2 } });
  expect(await installation.bridge.drainEvents?.()).toEqual([{ entity: "player", name: "collected" }]);
  installation.dispose();
});

test("an empty component provider does not advertise a dead capability", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    components: () => ({}),
    renderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.describe()).capabilities).not.toContain("runtime.components");
  expect((await installation.bridge.sample({})).components).toBeUndefined();
  installation.dispose();
});

test("gameplay channels stay absent when no provider supplies them", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
  });

  const description = await installation.bridge.describe();
  const snapshot = await installation.bridge.sample({});
  expect(description.capabilities).not.toContain("runtime.animation");
  expect(description.capabilities).not.toContain("runtime.state");
  expect(snapshot.gameplay).toBeUndefined();
  installation.dispose();
});

test("gameplay channels advertise the world observation supplied by the game", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    gameplay: () => ({
      animation: {},
      states: {},
      world: { seed: 6132 },
    }),
    gameplayChannels: () => ["runtime.world"],
    renderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.describe()).capabilities).toContain("runtime.world");
  installation.dispose();
});

// The observation half of the adapter decides `visible`, which camera and
// visibility assertions rest on. An entity behind the camera that still reported
// visible:true would turn every visibility assertion into a vacuous pass.
test("an entity outside the frustum is reported not visible and carries no bounds", async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.z = 5;
  const behind = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  behind.position.z = 40;
  scene.add(behind);
  const installation = installThreePlaytestBridge({ camera, entities: [{ id: "behind", object: behind }], renderer, scene });

  const observed = (await installation.bridge.sample({ entities: ["behind"] })).entities?.[0];

  expect(observed?.visible).toBe(false);
  expect(observed?.bounds).toBeUndefined();
  installation.dispose();
});

test("an object hidden with visible=false is reported not visible even while in frustum", async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
  camera.position.z = 5;
  const hidden = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  hidden.visible = false;
  scene.add(hidden);
  const installation = installThreePlaytestBridge({ camera, entities: [{ id: "hidden", object: hidden }], renderer, scene });

  expect((await installation.bridge.sample({ entities: ["hidden"] })).entities?.[0]?.visible).toBe(false);
  installation.dispose();
});

test("sampling an unregistered id returns no observation rather than a zeroed one", async () => {
  // A zeroed placeholder would read as "entity is at the origin" and could satisfy
  // a position assertion the application never actually met.
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
  });

  expect((await installation.bridge.sample({ entities: ["ghost"] })).entities).toEqual([]);
  installation.dispose();
});

test("setup on an unregistered entity fails loudly instead of being ignored", async () => {
  const installation = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    renderer,
    scene: new Scene(),
  });

  await expect(installation.bridge.applySetup?.({ entities: [{ entity: "ghost", transform: { position: [1, 2, 3] } }] }))
    .rejects.toThrow(/ghost/u);
  installation.dispose();
});

test("setup refreshes dynamic entities before applying placement", async () => {
  const scene = new Scene();
  const camera = new PerspectiveCamera();
  const player = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  let entities: Array<{ id: string; object: Mesh }> = [];
  const installation = installThreePlaytestBridge({
    camera,
    entities: () => entities,
    renderer,
    scene,
  });

  entities = [{ id: "player", object: player }];
  await installation.bridge.applySetup?.({
    entities: [{ entity: "player", transform: { position: [2, 0, 2] } }],
  });

  expect(player.position.toArray()).toEqual([2, 0, 2]);
  installation.dispose();
});

test("dispose restores a previously installed bridge instead of deleting it", () => {
  const first = installThreePlaytestBridge({ camera: new PerspectiveCamera(), renderer, scene: new Scene() });
  const second = installThreePlaytestBridge({ camera: new PerspectiveCamera(), renderer, scene: new Scene() });

  second.dispose();

  expect((globalThis as Record<string, unknown>).__THREENATIVE_PLAYTEST_BRIDGE__).toBe(first.bridge);
  first.dispose();
  expect((globalThis as Record<string, unknown>).__THREENATIVE_PLAYTEST_BRIDGE__).toBeUndefined();
});

test("a runtime render-only provider is advertised and serviced, and absent otherwise", async () => {
  // A driven native loop presents nothing between ticks, so a desktop screenshot needs an explicit
  // render-only frame. The bridge owns the operation; the capability is the runner's signal that
  // the operation exists, so a capture that needs one is never sent to a bridge that lacks it.
  let rendered = 0;
  const withRender = installThreePlaytestBridge({
    camera: new PerspectiveCamera(),
    fixedStep: () => undefined,
    renderCurrent: () => {
      rendered += 1;
    },
    renderer,
    scene: new Scene(),
    tick: () => 0,
  });
  expect((await withRender.bridge.describe()).capabilities).toContain("runtime.renderOnly");
  await withRender.bridge.renderOnly?.();
  expect(rendered).toBe(1);
  withRender.dispose();

  const without = installThreePlaytestBridge({ camera: new PerspectiveCamera(), renderer, scene: new Scene() });
  expect((await without.bridge.describe()).capabilities).not.toContain("runtime.renderOnly");
  expect(without.bridge.renderOnly).toBeUndefined();
  without.dispose();
});
