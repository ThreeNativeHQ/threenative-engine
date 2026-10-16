import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import * as three from "three";
import ts from "typescript";
import { afterEach, expect, it, vi } from "vitest";
import { initialState } from "../scripts/fixtures/kit-game/state.js";
import * as loading from "../src/render/loading.js";

// Execute the shipped fixture itself; only renderer/physics/assets are replaced at their seams.
const source = readFileSync(
  new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url),
  "utf8",
);
const code = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const stand = { fir: { x: 0, z: 0 }, spawn: { x: 4, z: 0 }, edge: { x: 24, z: 10 }, groundY: 10 };

function harness() {
  vi.useFakeTimers();
  let covered = false;
  const visible = { required: 4, loaded: 4 };
  const warmup = {
    pendingPrewarm: 0,
    pendingCpuDraws: 0,
    residentCells: 1,
    loadedCells: 1,
    loadsInFlight: 0,
    loadsQueued: 0,
    admission: { backlog: 0 },
  };
  const shadow = { frame: 1, levels: 3, deferred: 0, held: 0, rendered: 3, cached: 0 };
  let admit = () => {};
  const body = {
    velocity: new three.Vector3(),
    moveAndSlide: vi.fn(),
    dispose: vi.fn(),
    grounded: false,
  };
  const forest = {
    world: Object.assign(new three.Group(), {
      dispose: vi.fn(),
      stats: () => warmup,
      terrainReadinessInView: () => visible,
      pendingCpuDrawsInView: () => warmup.pendingCpuDraws,
      whenSpawnReady: () =>
        new Promise<void>((resolve) => {
          admit = resolve;
        }),
      prewarmed: Promise.resolve(),
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
    water: { lakes: 1, rivers: 1, dispose: vi.fn() },
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
    "kit.js": {
      addKit: addForest,
      kitDaylight: () =>
        Object.assign(new three.Group(), { sun: { shadow: { shadowNode: { stats: shadow } } } }),
      forestStand: stand,
      KIT: "Forest",
    },
    "state.js": { initialState },
    "loading.js": loading,
    "../terrain/composition.js": { composition: null, edits: undefined },
  };
  runInNewContext(code, {
    exports,
    setTimeout,
    clearTimeout,
    console,
    performance,
    Error,
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
  const Forest = exports.KitScene as new () => Fixture;
  return {
    scene: new Forest(),
    ctx,
    forest,
    visible,
    warmup,
    shadow,
    body,
    addForest,
    setCovered: (value = true) => {
      covered = value;
      if (value) admit();
    },
    draw: () => {
      shadow.frame++;
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
    await vi.advanceTimersByTimeAsync(0);
    h.draw();
    h.draw();
    await h.ctx.startup.hold.mock.calls[0]?.[1];
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

it("holds the actual loading cover for missing visible terrain and completed shadow draws", async () => {
  const h = harness();
  try {
    h.visible.loaded = 1;
    await h.scene.load(h.ctx);
    h.scene.enter(h.ctx);
    h.setCovered();
    await vi.advanceTimersByTimeAsync(0);
    h.ctx.startup.phase = "ready";
    h.draw();
    expect(h.state().worldReady).toBe(0);
    expect(h.ctx.canvasLayer.opaque).toBe(true);
    h.visible.loaded = 4;
    h.shadow.held = 2;
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.shadow.held = 0;
    h.shadow.deferred = 1;
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.shadow.deferred = 0;
    h.warmup.pendingPrewarm = 1;
    h.draw();
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.warmup.pendingPrewarm = 0;
    h.warmup.loadedCells = 0;
    h.draw();
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.warmup.loadedCells = 1;
    h.warmup.pendingCpuDraws = 1;
    h.draw();
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.warmup.pendingCpuDraws = 0;
    h.draw();
    h.draw();
    await Promise.resolve();
    h.draw();
    expect(h.state().worldReady).toBe(1);
  } finally {
    h.scene.exit();
  }
});

it("does not mistake zero shadow counters before the first draw for completed startup", async () => {
  const h = harness();
  try {
    h.shadow.frame = -3;
    h.shadow.levels = 0;
    await h.scene.load(h.ctx);
    h.scene.enter(h.ctx);
    h.setCovered();
    await vi.advanceTimersByTimeAsync(0);
    h.draw();
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.shadow.levels = 3;
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.draw();
    expect(h.state().worldReady).toBe(0);
    h.draw();
    expect(h.state().worldReady).toBe(1);
  } finally {
    h.scene.exit();
  }
});

it("runs the asymmetric contact witness without a legacy terrain mesh", () => {
  const source = readFileSync(new URL("../src/game.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("game.ts", source, ts.ScriptTarget.Latest, true);
  let witness: ts.IfStatement | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !witness &&
      ts.isIfStatement(node) &&
      node.thenStatement.getText(ast).includes("Missing asymmetric terrain contact")
    )
      witness = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (!witness) throw new Error("Missing asymmetric witness block");
  const probeMesh = new three.Mesh(new three.PlaneGeometry(16, 16), new three.MeshBasicMaterial());
  const context = {
    mesh: undefined,
    frames: 0,
    probeMesh,
    Vector3: three.Vector3,
    fixture: { heightAt: () => 0 },
    ctx: {
      raycast: vi.fn(() => ({ point: { y: 1 } })),
      physics: { directSpaceState: { intersectRay: vi.fn(() => ({ position: { y: 1 } })) } },
    },
    maxContactError: 0,
    bilinearDifference: 0,
    contactSamples: 0,
  };
  const code = ts.transpileModule(witness.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  runInNewContext(code, context);
  expect(context.contactSamples).toBe(8);
  expect(context.bilinearDifference).toBe(1);
  context.ctx.raycast.mockReturnValue(undefined as never);
  expect(() => runInNewContext(code, context)).toThrow("Missing asymmetric terrain contact");
  probeMesh.geometry.dispose();
  probeMesh.material.dispose();
});
