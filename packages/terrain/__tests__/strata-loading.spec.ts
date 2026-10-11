import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  type CanvasTexture,
  type Mesh,
  type MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
  Vector3,
} from "three";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import {
  createLoadingScreen,
  spawnReadinessSnapshot,
} from "../../../examples/strata-terrain-preview/src/render/loading.js";

const GAME_URL = new URL("../../../examples/strata-terrain-preview/src/game.ts", import.meta.url);
const GATE_NAMES = [
  "deadlineAt",
  "spawnReady",
  "spawnError",
  "spawnSettled",
  "capturingSpawnFailure",
  "resolveSpawn",
  "rejectSpawn",
  "spawnPromise",
  "settleSpawn",
  "failSpawn",
  "spawnTimer",
] as const;

/** Pull named declarations straight out of the production `enter()` so the tests drive real code. */
function gameDeclarations(names: readonly string[]): string {
  const source = ts.createSourceFile(
    "game.ts",
    readFileSync(GAME_URL, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const wanted = new Set(names);
  const found = new Map<string, string>();
  function visit(node: ts.Node): void {
    if (ts.isVariableDeclaration(node)) {
      const name = node.name.getText(source);
      if (wanted.has(name)) found.set(name, node.parent.parent.getText(source));
    } else if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
      const name = node.name.getText(source);
      if (wanted.has(name)) found.set(name, node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return names
    .map((name) => {
      const text = found.get(name);
      if (text === undefined) throw new Error(`Missing production declaration ${name}`);
      return text;
    })
    .join("\n");
}

interface ISpawnGate {
  readonly spawn: Promise<void>;
  readonly state: { worldReady: boolean; loadingError: string };
  error(): string;
  fail(reason: unknown): void;
  ready(): boolean;
  settle(error?: Error): void;
}

/** Run the production spawn gate in a fresh context; `capture` receives each failure receipt. */
function spawnGate(capture: (reason: string) => void = () => undefined): ISpawnGate {
  vi.useFakeTimers();
  const state = { worldReady: false, loadingError: "" };
  const scope = {
    setTimeout,
    clearTimeout,
    performance,
    Error,
    captureSpawnFailure: capture,
    spawnState: state,
    ctx: {
      state: {
        set: (value: { worldReady: boolean; loadingError: string }) => Object.assign(state, value),
      },
    },
    exports: {} as { Gate?: new () => ISpawnGate },
  };
  runInNewContext(
    ts.transpileModule(
      `export class Gate {
        constructor() {
          ${gameDeclarations(GATE_NAMES)}
          this.settle = settleSpawn;
          this.fail = failSpawn;
          this.spawn = spawnPromise;
          this.ready = () => spawnReady;
          this.error = () => spawnError;
          this.state = spawnState;
        }
      }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
    ).outputText,
    scope,
  );
  if (scope.exports.Gate === undefined) throw new Error("Production spawn gate did not load");
  return new scope.exports.Gate();
}

function host(ready: Promise<void>) {
  return {
    camera: new PerspectiveCamera(),
    scene: new Scene(),
    renderer: { compileAsync: vi.fn(async () => undefined) },
    canvasLayer: {
      scene: new Scene(),
      camera: new OrthographicCamera(-400, 400, 300, -300, 0, 2),
      opaque: false,
      keepWorldRendering: false,
      renderWorldDuringStartup: true,
    },
    startup: { progress: 0.5, whenReady: () => ready },
  };
}

it.each(["attached", "cancelled", "released"] as const)(
  "defers hidden world draws until prepared streams attach: %s",
  async (outcome) => {
    const declarations = gameDeclarations(["buildProps"]);
    const controllerHost = host(new Promise<void>(() => undefined));
    controllerHost.canvasLayer.opaque = true;
    controllerHost.canvasLayer.renderWorldDuringStartup = false;
    const world = {
      prewarmed: Promise.resolve(),
      update: () => undefined,
      whenSpawnReady: () => Promise.resolve({}),
    };
    const attachments: boolean[] = [];
    let entered: () => void = () => undefined;
    const preparing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish: () => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let disposed = false;
    const parts = new Map();
    const scope = {
      exports: {} as { Controller?: new () => { run(): Promise<void> } },
      performance,
      deadlineAt: performance.now() + 120_000,
      settleSpawn: () => undefined,
      failSpawn: () => undefined,
      ctx: {
        ...controllerHost,
        assets: undefined,
        state: { getState: () => ({}) },
        entities: { add: () => undefined },
        add: () => {
          attachments.push(controllerHost.canvasLayer.keepWorldRendering);
        },
      },
      released: false,
      preparedDispose: undefined,
      preparedLodBaseSpread: 0,
      preparedLevelsWithoutSolid: 0,
      surfacesDispose: undefined,
      propsStage: "",
      completedPropsWork: 0,
      preparation: undefined,
      props: undefined,
      propParts: parts,
      world: "forest",
      data: { size: 512 },
      spawn: { x: 0, y: 0, z: 0 },
      biome: {},
      fallbackSaplingHeight: undefined,
      scatter: { placements: [], counts: {} },
      groundAt: () => ({ height: 0, offset: 0 }),
      textureUploads: { signal: new AbortController().signal },
      PerspectiveCamera,
      OrthographicCamera,
      loadPreparedProps: async () => ({ parts, dispose() {} }),
      loadPack: async () => ({ parts, dispose() {} }),
      buildPropVariants: () => parts,
      createPropSurfaces: async () => ({ materials: {}, dispose() {} }),
      preparePropTextures: async (
        _renderer: unknown,
        _materials: unknown,
        _signal: unknown,
        progress: (completed: number) => void,
      ) => {
        progress(1);
        progress(2);
      },
      createStreamedProps: async (options: { onProgress: (progress: object) => void }) => {
        for (const [phase, added] of [
          ["grounding", 0],
          ["grounding", 50],
          ["grounding", 50],
          ["models", 0],
          ["models", 3],
        ] as const)
          options.onProgress({ phase, bucket: "trees", added, total: 100 });
        entered();
        await prepared;
        return outcome === "cancelled"
          ? undefined
          : {
              worlds: [world],
              byId: new Map(),
              meshes: [],
              dispose: () => {
                disposed = true;
              },
            };
      },
    };
    runInNewContext(
      ts.transpileModule(
        `export class Controller { #surfaces; async run() { ${declarations}; await buildProps(); } }`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
      ).outputText,
      scope,
    );
    if (!scope.exports.Controller)
      throw new Error("Production preparation controller did not load");
    const work = new scope.exports.Controller().run();
    await Promise.race([
      preparing,
      work.then(() => {
        throw Error("preparation did not enter");
      }),
    ]);
    try {
      expect(scope.completedPropsWork).toBe(55);
      expect(controllerHost.canvasLayer.keepWorldRendering).toBe(false);
      expect(attachments).toEqual([]);
    } finally {
      scope.released = outcome === "released";
      finish();
      await work;
    }
    expect(attachments).toEqual(outcome === "attached" ? [false] : []);
    expect(controllerHost.canvasLayer.keepWorldRendering).toBe(outcome === "attached");
    expect(disposed).toBe(outcome === "released");
  },
);

it.each(["世界", "\u0000", "\uD800"])(
  "bounds failure receipts for %j without retaining scene objects or resident key arrays",
  (text) => {
    const stats = {
      residentCells: 16,
      loadedCells: 12,
      loadsInFlight: 1,
      loadsQueued: 2,
      pendingPrewarm: 3,
      prewarmMinted: 4,
      failures: 0,
      admission: { spentMs: 1.5, deferred: 2, backlog: 5 },
      residentKeys: ["must-not-copy"],
    };
    const stream = {
      uuid: "generation".repeat(100),
      name: text.repeat(1_000),
      parent: { uuid: "scene".repeat(100) },
      released: false,
      stats: () => stats,
    };
    const receipt = spawnReadinessSnapshot({
      reason: text.repeat(10_000),
      atMs: 120_000,
      world: "forest",
      sceneUuid: "scene-generation",
      released: false,
      gate: { ready: false, error: "" },
      stage: "streaming",
      propsSettled: false,
      preparation: {
        phase: "world-load",
        bucket: text.repeat(1_000),
        added: 0,
        total: 213_968,
        prewarmedWorlds: 3,
        worlds: Array.from({ length: 20 }, () => stream) as never,
      },
      assets: {
        requested: 323,
        settled: 300,
        requestedBytes: 500,
        settledBytes: 450,
        pending: Array.from({ length: 20 }, () => text.repeat(10_000)),
      },
      startup: {
        phase: "collapsing",
        progress: 0.95,
        compileSettled: true,
        timeline: { enteredMs: 10, compileSettledMs: 50 },
      },
      coverage: { required: 16, loaded: 12, failures: 0, ready: false },
    });
    const encoded = JSON.stringify(receipt);
    expect(Buffer.byteLength(encoded)).toBeLessThan(16_384);
    expect(receipt.preparation.worldCount).toBe(20);
    expect(receipt.preparation.prewarmedWorlds).toBe(3);
    expect(receipt.coverage).toEqual({ required: 16, loaded: 12, failures: 0, ready: false });
    expect(receipt.worlds).toHaveLength(4);
    expect(receipt.assets.pendingCount).toBe(20);
    expect(receipt.assets.pending).toHaveLength(4);
    expect(encoded).not.toContain("must-not-copy");
    stats.pendingPrewarm = 0;
    stream.released = true;
    expect(receipt.worlds[0]?.pendingPrewarm).toBe(3);
    expect(receipt.worlds[0]?.released).toBe(false);
  },
);

it("uploads the status canvas only when its displayed text changes", async () => {
  const drawn: string[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      clearRect: () => undefined,
      fillText: (text: string) => drawn.push(text),
    }),
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  let reject: (reason: Error) => void = () => undefined;
  const source = host(
    new Promise<void>((_resolve, fail) => {
      reject = fail;
    }),
  );
  const screen = createLoadingScreen(source);
  try {
    const status = source.canvasLayer.scene.children[3] as Mesh<never, MeshBasicMaterial>;
    const texture = status.material.map as CanvasTexture;
    source.startup.progress = 0.95;
    screen.update();
    const version = texture.version;
    for (let frame = 0; frame < 100; frame += 1) screen.update();
    source.startup.progress = 0.951;
    screen.update();
    expect(texture.version).toBe(version);
    expect(drawn).toEqual(["0%", "95%"]);
    source.startup.progress = 0.96;
    screen.update();
    expect(texture.version).toBe(version + 1);
    expect(drawn).toEqual(["0%", "95%", "96%"]);
    reject(new Error("Forest spawn: missing cell"));
    await Promise.resolve();
    screen.update();
    expect(texture.version).toBe(version + 2);
    expect(drawn.at(-1)).toBe("Forest spawn: missing cell");
    expect(source.canvasLayer.opaque).toBe(true);
  } finally {
    screen.finish();
    vi.unstubAllGlobals();
  }
});

it.each([false, true])(
  "keeps hidden world draws disabled during admission and restores previous flag %s",
  (previous) => {
    const source = host(new Promise<void>(() => undefined));
    source.canvasLayer.keepWorldRendering = previous;
    source.canvasLayer.renderWorldDuringStartup = !previous;
    const screen = createLoadingScreen({ ...source, keepWorldRendering: false });
    try {
      expect(source.canvasLayer.opaque).toBe(true);
      expect(source.canvasLayer.keepWorldRendering).toBe(false);
      expect(source.canvasLayer.renderWorldDuringStartup).toBe(false);
      screen.update();
      expect(source.canvasLayer.keepWorldRendering).toBe(false);
    } finally {
      screen.finish();
    }
    expect(source.canvasLayer.opaque).toBe(false);
    expect(source.canvasLayer.keepWorldRendering).toBe(previous);
    expect(source.canvasLayer.renderWorldDuringStartup).toBe(!previous);
    expect(source.canvasLayer.scene.children).toHaveLength(0);
  },
);

it("keeps the curtain and names a failed spawn even after framework readiness fails open", async () => {
  let reject: (reason: Error) => void = () => undefined;
  const source = host(
    new Promise<void>((_resolve, fail) => {
      reject = fail;
    }),
  );
  const screen = createLoadingScreen(source);
  reject(new Error("Spawn terrain: missing tile 0:0"));
  await Promise.resolve();
  await Promise.resolve();
  screen.update();
  expect(source.canvasLayer.opaque).toBe(true);
  expect(source.canvasLayer.keepWorldRendering).toBe(false);
  const backdrop = source.canvasLayer.scene.children[0] as Mesh;
  expect(backdrop.userData.loadingError).toBe("Spawn terrain: missing tile 0:0");
  const fill = source.canvasLayer.scene.children[2] as Mesh;
  expect((fill.material as MeshBasicMaterial).color.getHex()).toBe(0xe36b5c);
  screen.finish();
  expect(source.canvasLayer.scene.children).toHaveLength(0);
});

it("restores both prior draw flags when opted-out texture preparation rejects", async () => {
  let reject: (reason: Error) => void = () => undefined;
  const source = host(
    new Promise<void>((_done, fail) => {
      reject = fail;
    }),
  );
  source.canvasLayer.keepWorldRendering = true;
  const screen = createLoadingScreen({ ...source, keepWorldRendering: false });
  try {
    expect(source.canvasLayer.keepWorldRendering).toBe(false);
    expect(source.canvasLayer.renderWorldDuringStartup).toBe(false);
    reject(new Error("Texture preparation failed"));
    await Promise.resolve();
    await Promise.resolve();
    expect(source.canvasLayer.opaque).toBe(true);
    expect(source.canvasLayer.keepWorldRendering).toBe(true);
    expect(source.canvasLayer.renderWorldDuringStartup).toBe(true);
  } finally {
    screen.finish();
  }
});

it("releases its layer only after the combined spawn and startup promise resolves", async () => {
  let resolve: () => void = () => undefined;
  const source = host(
    new Promise<void>((done) => {
      resolve = done;
    }),
  );
  const screen = createLoadingScreen(source);
  screen.update();
  expect(source.canvasLayer.opaque).toBe(true);
  resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(source.canvasLayer.opaque).toBe(false);
  expect(source.canvasLayer.scene.children).toHaveLength(0);
});

it("latches playable coverage so later spawn eviction never disables controls", async () => {
  const gate = spawnGate();
  let settled = false;
  void gate.spawn.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  expect(gate.ready()).toBe(false);
  await Promise.resolve();
  expect(settled).toBe(false);
  gate.settle();
  await gate.spawn;
  gate.fail("late failure");
  expect(gate.ready()).toBe(true);
  expect(gate.error()).toBe("");
  gate.settle(new Error("Strata spawn cancelled"));
  vi.useRealTimers();
});

it("rejects a timed out spawn and never treats later coverage as playable", async () => {
  const gate = spawnGate();
  const rejection = expect(gate.spawn).rejects.toThrow("Strata spawn admission exceeded 120000 ms");
  await vi.advanceTimersByTimeAsync(120_000);
  await rejection;
  gate.settle();
  expect(gate.ready()).toBe(false);
  expect(gate.error()).toContain("exceeded");
  vi.useRealTimers();
});

it("captures the pending gate before timeout latches or rejects, once per failure", async () => {
  const events: string[] = [];
  const gate = spawnGate((reason) => {
    events.push(`capture:${gate.ready()}:${gate.error()}:${reason}`);
  });
  const rejection = gate.spawn.catch((error: Error) => events.push(`rejected:${error.message}`));
  await vi.advanceTimersByTimeAsync(120_000);
  await rejection;
  gate.settle();
  gate.fail("late failure");
  gate.settle(new Error("Strata spawn cancelled"));
  expect(events).toEqual([
    "capture:false::Strata spawn admission exceeded 120000 ms",
    "rejected:Strata spawn admission exceeded 120000 ms",
  ]);
  expect(gate.ready()).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it("keeps the original admission failure when its diagnostic capture throws", async () => {
  const capture = vi.fn(() => {
    throw new Error("diagnostic observer failed");
  });
  const gate = spawnGate(capture);
  const rejection = expect(gate.spawn).rejects.toThrow("Strata spawn assets failed to load");
  gate.fail(new Error("Strata spawn assets failed to load"));
  await rejection;
  expect(capture).toHaveBeenCalledOnce();
  expect(gate.error()).toBe("Strata spawn assets failed to load");
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

it.each(["observe", "cancel"])(
  "keeps capture reentry through %s from changing failure settlement",
  async (action) => {
    const gate = spawnGate(() => {
      if (action === "observe") gate.settle();
      else gate.settle(new Error("Strata spawn cancelled"));
    });
    const rejection = expect(gate.spawn).rejects.toThrow("original admission failure");
    gate.fail("original admission failure");
    await rejection;
    expect(gate.ready()).toBe(false);
    expect(gate.error()).toBe("original admission failure");
    vi.useRealTimers();
  },
);

it("cancels a pending scene without leaving its readiness promise or timer behind", async () => {
  const gate = spawnGate();
  const rejection = expect(gate.spawn).rejects.toThrow("Strata spawn cancelled");
  gate.settle(new Error("Strata spawn cancelled"));
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
  expect(gate.ready()).toBe(false);
  vi.useRealTimers();
});

it("keeps even an empty-message rejection failed after late coverage", async () => {
  const gate = spawnGate();
  const rejection = expect(gate.spawn).rejects.toThrow("Strata spawn failed");
  gate.fail(new Error());
  await rejection;
  gate.settle();
  expect(gate.ready()).toBe(false);
  vi.useRealTimers();
});

it("updates ctx state immediately when the spawn times out before any render frame", async () => {
  const gate = spawnGate();
  const rejection = gate.spawn.catch(() => undefined);
  expect(gate.state.loadingError).toBe("");
  expect(gate.state.worldReady).toBe(false);
  await vi.advanceTimersByTimeAsync(120_000);
  await rejection;
  expect(gate.state.loadingError).toBe("Strata spawn admission exceeded 120000 ms");
  expect(gate.state.worldReady).toBe(false);
  vi.useRealTimers();
});

const KIT_GATES = ["Alpine", "Coastal", "Desert", "Forest", "Tundra"] as const;
/** Module constants a kit gate reads while it loads; the rest of each fixture stays out of the VM. */
const KIT_CONSTANTS = new Set(["DRIVE_SECONDS", "viewWindows"]);

interface IKitProbe {
  ready(): boolean;
  error(): string;
  settle(error?: Error): void;
  fail(ctx: unknown, message: string): void;
}

interface IKitGate {
  load(ctx: unknown): Promise<void>;
  testProbe(): IKitProbe;
}

/** Run a starter-kit fixture's real gate class in a fresh context, with its spawn rejecting as `reason`. */
function kitGate(kit: string, reason: string): IKitGate {
  const url = new URL(
    `../../../examples/strata-terrain-preview/scripts/fixtures/kit-game/${kit}.ts`,
    import.meta.url,
  );
  const source = ts.createSourceFile(
    `${kit}.ts`,
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const constants: string[] = [];
  let gate = "";
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === kit) gate = node.getText(source);
    else if (ts.isVariableDeclaration(node) && KIT_CONSTANTS.has(node.name.getText(source)))
      constants.push(node.parent.parent.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (gate === "") throw new Error(`Missing ${kit} kit gate class`);
  // The probe sits inside the class to reach private gate state; the gate code itself is untouched.
  const probe =
    "testProbe() { return { ready: () => this.#ready, error: () => this.#error, settle: (error) => this.#settle?.(error), fail: (ctx, message) => this.#fail(ctx, message) }; }";
  const withProbe = `${gate.slice(0, gate.lastIndexOf("}"))}${probe}\n}`;
  const compiled = ts.transpileModule([...constants, withProbe].join("\n"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const scope = {
    exports: {} as Record<string, new () => IKitGate>,
    Scene: class {},
    // Each kit's static `initialState` field reads this global; the gate under test never uses it.
    initialState: {},
    VIEWS: { ground: { at: new Vector3(), look: new Vector3() } },
    VIEW_NAMES: [],
    stand: { spawn: new Vector3(), groundY: 0 },
    HALF_HEIGHT: 0,
    RADIUS: 0,
    Object3D,
    Vector3,
    // The host Error keeps `error instanceof Error` true for the rejection the spawn raises.
    Error,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    performance: { now: () => 0 },
    createLoadingScreen: () => ({ update: () => undefined, finish: () => undefined }),
    [`add${kit}`]: () => Promise.reject(new Error(reason)),
  };
  runInNewContext(compiled, scope);
  const Gate = scope.exports[kit];
  if (Gate === undefined) throw new Error(`Kit gate ${kit} did not load`);
  return new Gate();
}

function kitContext() {
  return {
    startup: { phase: "loading", progress: 0, hold: vi.fn(), whenReady: () => Promise.resolve() },
    state: { set: vi.fn(), getState: () => ({ loadingError: "" }) },
    camera: new PerspectiveCamera(),
  };
}

it.each(KIT_GATES)("%s normalizes an empty spawn failure to its kit label", async (kit) => {
  const ctx = kitContext();
  const gate = kitGate(kit, "");
  await gate.load(ctx);
  expect(gate.testProbe().error()).toBe(`${kit} spawn failed`);
  expect(ctx.state.set).toHaveBeenLastCalledWith({
    loadingError: `${kit} spawn failed`,
    worldReady: 0,
  });
});

it.each(KIT_GATES)("%s keeps an empty spawn failure latched through late success", async (kit) => {
  const ctx = kitContext();
  const gate = kitGate(kit, "");
  await gate.load(ctx);
  const probe = gate.testProbe();
  probe.settle();
  expect(probe.ready()).toBe(false);
  probe.fail(ctx, "A later failure");
  expect(probe.error()).toBe(`${kit} spawn failed`);
  expect(ctx.state.set).toHaveBeenLastCalledWith({
    loadingError: `${kit} spawn failed`,
    worldReady: 0,
  });
});
