import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as three from "three";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../../../examples/strata-terrain-preview/scripts/fixtures/kit-game/state.js";
import * as loading from "../../../examples/strata-terrain-preview/src/render/loading.js";

// Execute the shipped fixture itself; only renderer/physics/assets are replaced at their seams.
const source = readFileSync(
  new URL(
    "../../../examples/strata-terrain-preview/scripts/fixtures/kit-game/Forest.ts",
    import.meta.url,
  ),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const stand = { fir: { x: 0, z: 0 }, spawn: { x: 4, z: 0 }, edge: { x: 24, z: 10 }, groundY: 10 };

function harness() {
  vi.useFakeTimers();
  let covered = false;
  const body = {
    velocity: new three.Vector3(),
    moveAndSlide: vi.fn(),
    dispose: vi.fn(),
    grounded: false,
  };
  const forest = {
    world: Object.assign(new three.Group(), {
      dispose: vi.fn(),
      stats: () => ({ pendingPrewarm: 0 }),
      readinessAt: () => ({
        ready: covered,
        requiredCells: 1,
        loadedCells: covered ? 1 : 0,
        requiredTerrainTiles: 1,
        loadedTerrainTiles: covered ? 1 : 0,
        failures: 0,
      }),
    }),
    ground: { dispose: vi.fn() },
    water: { lakes: 1, rivers: 1 },
    colliders: { active: 198, detach: vi.fn() },
  };
  const addForest = vi.fn(async () => forest);
  const exports: Record<string, unknown> = {};
  const imports: Record<string, unknown> = {
    three,
    "@threenative/core": { Scene: class {} },
    "@threenative/physics": {
      CharacterBody3D: class {
        velocity = body.velocity;
        moveAndSlide = body.moveAndSlide;
        dispose = body.dispose;
        grounded = body.grounded;
      },
      CollisionShape3D: { capsule: () => ({}) },
    },
    "world.js": { addForest },
    "sky.js": { forestDaylight: () => new three.Group() },
    "stand.js": { stand },
    "state.js": { initialState },
    "loading.js": loading,
  };
  runInNewContext(code, {
    exports,
    setTimeout,
    clearTimeout,
    console,
    require(name: string) {
      const dependency = imports[name] ?? imports[name.split("/").at(-1) ?? ""];
      if (dependency) return dependency;
      throw new Error(`Unexpected fixture dependency: ${name}`);
    },
  });
  let state = { ...initialState };
  const callbacks: Array<() => void> = [];
  const ctx = {
    camera: new three.PerspectiveCamera(),
    scene: new three.Scene(),
    canvasLayer: {
      scene: new three.Scene(),
      camera: new three.OrthographicCamera(-400, 400, 300, -300, 0, 2),
      opaque: false,
      keepWorldRendering: false,
    },
    renderer: { compileAsync: async () => undefined },
    startup: {
      phase: "collapsing",
      progress: 0.9,
      hold: vi.fn((_label: string, work: Promise<void>) => {
        void work.catch(() => undefined);
      }),
      whenReady: async () => undefined,
    },
    state: {
      set: (patch: Partial<typeof state>) => {
        state = { ...state, ...patch };
      },
      getState: () => state,
    },
    input: { justPressed: vi.fn(() => false) },
    physics: {},
    add: (object: three.Object3D) => {
      ctx.scene.add(object);
      return object;
    },
    beforeRender: (callback: () => void) => callbacks.push(callback),
  };
  type Fixture = {
    load(context: typeof ctx): Promise<void>;
    enter(context: typeof ctx): void;
    update(context: typeof ctx, dt: number): void;
    exit(): void;
  };
  const Forest = exports.Forest as new () => Fixture;
  return {
    scene: new Forest(),
    ctx,
    forest,
    body,
    addForest,
    setCovered: (value = true) => {
      covered = value;
    },
    draw: () => {
      for (const callback of callbacks) callback();
    },
    state: () => state,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

it("keeps actual Forest controls held for coverage, then permits play after spawn eviction", async () => {
  const h = harness();
  try {
    await h.scene.load(h.ctx);
    h.scene.enter(h.ctx);
    expect(h.ctx.camera.position.x).toBe(stand.spawn.x);
    h.scene.update(h.ctx, 0.016);
    expect(h.state().worldReady).toBe(0);
    expect(h.ctx.input.justPressed).not.toHaveBeenCalled();
    expect(h.body.velocity.x).toBe(0);
    h.setCovered();
    h.draw();
    await Promise.resolve();
    await Promise.resolve();
    h.ctx.startup.phase = "ready";
    h.scene.update(h.ctx, 0.016);
    expect(h.body.velocity.x).not.toBe(0);
    expect(h.ctx.input.justPressed).toHaveBeenCalled();
    h.setCovered(false);
    h.draw();
    h.scene.update(h.ctx, 0.016);
    expect(h.state().worldReady).toBe(1);
    expect(h.body.velocity.x).not.toBe(0);
  } finally {
    h.scene.exit();
  }
});

it("keeps the actual Forest covered and reports a timeout after framework fail-open", async () => {
  const h = harness();
  try {
    await h.scene.load(h.ctx);
    h.scene.enter(h.ctx);
    h.ctx.startup.phase = "ready";
    await vi.advanceTimersByTimeAsync(120_000);
    h.scene.update(h.ctx, 0.016);
    expect(h.state().loadingError).toContain("exceeded");
    expect(h.state().worldReady).toBe(0);
    expect(h.ctx.input.justPressed).not.toHaveBeenCalled();
    expect(h.ctx.canvasLayer.opaque).toBe(true);
    expect(h.ctx.canvasLayer.keepWorldRendering).toBe(false);
  } finally {
    h.scene.exit();
  }
});

it("disposes a late forest completion and does not publish into an exited scene", async () => {
  const h = harness();
  let complete: (value: typeof h.forest) => void = () => undefined;
  h.addForest.mockImplementation(
    () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  );
  const work = h.scene.load(h.ctx);
  h.scene.exit();
  complete(h.forest);
  await work;
  expect(h.forest.world.dispose).toHaveBeenCalled();
  expect(h.state().propColliders).toBe(-1);
  expect(h.ctx.canvasLayer.opaque).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});
