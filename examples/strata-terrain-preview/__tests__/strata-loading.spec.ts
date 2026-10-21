import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  type CanvasTexture,
  InstancedMesh,
  Matrix4,
  Mesh,
  type MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PointLight,
  Scene,
  Vector3,
} from "three";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { createLoadingScreen } from "../src/render/loading.js";

const GAME_URL = new URL("../src/game.ts", import.meta.url);
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
function gameDeclarations(names: readonly string[], assignments = false): string {
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
    } else if (
      assignments &&
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      wanted.has(node.left.text)
    ) {
      found.set(node.left.text, `let ${node.getText(source)};`);
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

function startupProgressExpression(): string {
  const source = ts.createSourceFile(
    "game.ts",
    readFileSync(GAME_URL, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let expression: string | undefined;
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText(source) === "ctx.startup.hold" &&
      node.arguments.length >= 4
    )
      expression = node.arguments[3]?.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (expression === undefined)
    throw new Error("Missing production strata startup progress callback");
  return expression;
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

it.each(["attached", "cancelled", "released", "data-rejected", "prewarm-rejected"] as const)(
  "defers hidden world draws until prepared streams attach: %s",
  async (outcome) => {
    const declarations = gameDeclarations(["buildProps"], true);
    const controllerHost = host(new Promise<void>(() => undefined));
    controllerHost.canvasLayer.opaque = true;
    controllerHost.canvasLayer.renderWorldDuringStartup = false;
    const gates = [0, 1].map((index) => {
      let admit: () => void = () => undefined;
      let draw: () => void = () => undefined;
      let rejectData: (error: Error) => void = () => undefined;
      let rejectDraw: (error: Error) => void = () => undefined;
      const data = new Promise<{ requiredCells: number; loadedCells: number }>(
        (resolve, reject) => {
          admit = () => resolve({ requiredCells: index + 1, loadedCells: index + 1 });
          rejectData = reject;
        },
      );
      const world = {
        name: `strata-props:${index}`,
        prewarmed: new Promise<void>((resolve, reject) => {
          draw = resolve;
          rejectDraw = reject;
        }),
        update: () => undefined,
        whenSpawnReady: vi.fn(() => data),
        readinessAt: vi.fn(() => ({
          ready: false,
          requiredCells: index + 1,
          loadedCells: 0,
          failures: 0,
        })),
        stats: vi.fn(() => ({
          admission: { backlog: index + 4 },
          impostor: { pending: index + 2 },
        })),
      };
      return { world, data, admit, draw, rejectData, rejectDraw };
    });
    const all = vi.fn((values: Iterable<unknown>) => Promise.all(values));
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
    let clock = 0;
    const progressSnapshots: Array<{
      phaseStartedAt: number | undefined;
      lastProgressAt: number | undefined;
    }> = [];
    const failure = vi.fn();
    const parts = new Map();
    const scope = {
      exports: {} as { Controller?: new () => { run(): Promise<void> } },
      performance: { now: () => clock },
      deadlineAt: 120_000,
      buildStartedAt: undefined as number | undefined,
      phaseStartedAt: undefined as number | undefined,
      lastProgressAt: undefined as number | undefined,
      console: { error: failure },
      reason: "observed preparation failure",
      world: "forest",
      settleSpawn: vi.fn(),
      spawnJoins: new Map(),
      spawnSettled: false,
      spawnCells: { required: 0, loaded: 0 },
      failSpawn: vi.fn(),
      Promise: { all, resolve: Promise.resolve.bind(Promise) },
      ctx: {
        ...controllerHost,
        assets: undefined,
        state: { getState: () => ({}), set: vi.fn() },
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
        for (const [phase, bucket, added] of [
          ["grounding", "trees", 0],
          ["grounding", "trees", 50],
          ["grounding", "trees", 50],
          ["models", "trees", 0],
          ["models", "trees", 3],
          ["models", "trees", 4],
          ["models", "rocks", 2],
        ] as const) {
          clock += 10;
          options.onProgress({ phase, bucket, added, total: 100 });
          progressSnapshots.push({
            phaseStartedAt: scope.phaseStartedAt,
            lastProgressAt: scope.lastProgressAt,
          });
        }
        entered();
        await prepared;
        return outcome === "cancelled"
          ? undefined
          : {
              worlds: gates.map((gate) => gate.world),
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
        `export class Controller { #surfaces; async run() { ${declarations}; await buildProps(); ${gameDeclarations(["captureSpawnFailure"])}; captureSpawnFailure(reason); } }`,
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
      expect(scope.completedPropsWork).toBe(58);
      expect(controllerHost.canvasLayer.keepWorldRendering).toBe(false);
      expect(attachments).toEqual([]);
    } finally {
      scope.released = outcome === "released";
      finish();
      await work;
    }
    const encodedFailure = failure.mock.calls[0]?.[0] as string;
    const receipt = JSON.parse(encodedFailure.slice("TN_STRATA_SPAWN_FAILURE ".length));
    expect(receipt).toMatchObject({
      reason: "observed preparation failure",
      world: "forest",
      stage: "models",
      bucket: "rocks",
      added: 2,
      total: 100,
      buildStartedMs: 0,
      phaseStartedMs: 70,
      lastProgressMs: 70,
      deadlineElapsedMs: 70,
    });
    expect(progressSnapshots.slice(4, 7)).toEqual([
      { phaseStartedAt: 40, lastProgressAt: 50 },
      { phaseStartedAt: 40, lastProgressAt: 60 },
      { phaseStartedAt: 70, lastProgressAt: 70 },
    ]);
    const attached = outcome !== "cancelled" && outcome !== "released";
    expect(attachments).toEqual(attached ? [false, false] : []);
    expect(controllerHost.canvasLayer.keepWorldRendering).toBe(attached);
    expect(disposed).toBe(outcome === "released");
    expect(scope.settleSpawn).not.toHaveBeenCalled();
    expect(scope.spawnCells).toEqual({ required: 0, loaded: 0 });
    if (!attached) return;
    expect([...scope.spawnJoins.values()]).toEqual([
      { data: "pending", prewarm: "pending" },
      { data: "pending", prewarm: "pending" },
    ]);
    expect(
      all.mock.calls.some(
        ([values]) =>
          Array.isArray(values) && values[0] === gates[0]?.data && values[1] === gates[1]?.data,
      ),
    ).toBe(true);
    expect(
      all.mock.calls.some(
        ([values]) =>
          Array.isArray(values) &&
          values[1] === gates[0]?.world.prewarmed &&
          values[2] === gates[1]?.world.prewarmed,
      ),
    ).toBe(true);
    gates[0]?.admit();
    gates[1]?.draw();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    expect([...scope.spawnJoins.values()]).toEqual([
      { data: "resolved", prewarm: "pending" },
      { data: "pending", prewarm: "resolved" },
    ]);
    expect(scope.settleSpawn).not.toHaveBeenCalled();
    const error = new Error("original world gate rejection");
    if (outcome === "data-rejected") gates[1]?.rejectData(error);
    else gates[1]?.admit();
    if (outcome === "prewarm-rejected") gates[0]?.rejectDraw(error);
    else gates[0]?.draw();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    if (outcome === "attached") {
      expect(scope.settleSpawn).toHaveBeenCalledOnce();
      expect(scope.spawnCells).toEqual({ required: 3, loaded: 3 });
      expect([...scope.spawnJoins.values()]).toEqual([
        { data: "resolved", prewarm: "resolved" },
        { data: "resolved", prewarm: "resolved" },
      ]);
      expect(scope.failSpawn).not.toHaveBeenCalled();
    } else {
      expect(scope.settleSpawn).not.toHaveBeenCalled();
      expect(scope.failSpawn).toHaveBeenCalledExactlyOnceWith(error);
      expect([...scope.spawnJoins.values()]).toContainEqual(
        outcome === "data-rejected"
          ? { data: "rejected", prewarm: "resolved" }
          : { data: "resolved", prewarm: "rejected" },
      );
    }
    expect(scope.ctx.state.set).not.toHaveBeenCalled();
    expect(gates[0]?.world.whenSpawnReady).toHaveBeenCalledExactlyOnceWith(
      scope.spawn,
      60,
      119_930,
    );
    expect(gates[1]?.world.whenSpawnReady).toHaveBeenCalledExactlyOnceWith(
      scope.spawn,
      60,
      119_930,
    );
  },
);

it("reports each spawn region and promise status without querying readiness after settlement", () => {
  const status = { data: "pending", prewarm: "rejected" };
  const stream = {
    name: "strata-props:coastal-trees",
    readinessAt: vi.fn(() => ({
      ready: false,
      requiredCells: 3,
      loadedCells: 2,
      requiredTerrainTiles: 0,
      loadedTerrainTiles: 0,
      failures: 1,
      cancelled: false,
    })),
    stats: vi.fn(() => ({ admission: { backlog: 7 }, impostor: { pending: 4 } })),
  };
  const scope = {
    exports: { snapshot: [] as Array<Record<string, string | number | boolean>> },
    spawnJoins: new Map([[stream, status]]),
    spawn: { x: 11, z: 23 },
    spawnReady: false,
    frames: 12,
    ctx: { state: { getState: () => ({ spawnReadiness: scope.exports.snapshot }) } },
  };
  const code = ts.transpileModule(
    `(function () { ${gameDeclarations(["spawnReadiness"])}; exports.snapshot = spawnReadiness; })();`,
    {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    },
  ).outputText;
  runInNewContext(code, scope);
  expect(scope.exports.snapshot).toEqual([
    {
      name: stream.name,
      observedFrame: 12,
      data: "pending",
      prewarm: "rejected",
      ready: false,
      requiredCells: 3,
      loadedCells: 2,
      requiredTerrainTiles: 0,
      loadedTerrainTiles: 0,
      failures: 1,
      cancelled: false,
      admissionBacklog: 7,
      impostorPending: 4,
    },
  ]);
  expect(stream.readinessAt).toHaveBeenCalledExactlyOnceWith(scope.spawn, 60);
  status.data = "resolved";
  status.prewarm = "resolved";
  scope.spawnReady = true;
  scope.frames = 13;
  runInNewContext(code, scope);
  expect(scope.exports.snapshot[0]).toMatchObject({
    data: "resolved",
    prewarm: "resolved",
    loadedCells: 2,
    observedFrame: 12,
  });
  expect(stream.readinessAt).toHaveBeenCalledOnce();
  expect(stream.stats).toHaveBeenCalledOnce();
  scope.exports.snapshot = [];
  runInNewContext(code, scope);
  expect(scope.exports.snapshot).toEqual([
    { name: stream.name, data: "resolved", prewarm: "resolved" },
  ]);
  expect(stream.readinessAt).toHaveBeenCalledOnce();
});

it("reports completed streamed admission work before spawn cells become ready", () => {
  const progress = startupProgressExpression();
  const result = runInNewContext(`(${progress})()`, {
    completedPropsWork: 0,
    preparation: { prewarmedWorlds: 0 },
    props: {
      worlds: [
        { stats: () => ({ admissionCompletedUnits: 4, prewarmMinted: 2 }) },
        { stats: () => ({ admissionCompletedUnits: 3, prewarmMinted: 1 }) },
      ],
    },
    ctx: { state: { getState: () => ({ spawnCellsLoaded: 0 }) } },
  });
  expect(result).toBe(10);
});

it("reports that preparation has not started when the spawn fails before physics", () => {
  const error = vi.fn();
  const reason = "Strata spawn admission exceeded 120000 ms";
  runInNewContext(
    ts.transpileModule(
      `${gameDeclarations(["captureSpawnFailure"])}; captureSpawnFailure(reason);`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
    ).outputText,
    {
      console: { error },
      performance: { now: () => 121_000 },
      deadlineAt: 121_000,
      buildStartedAt: undefined,
      phaseStartedAt: undefined,
      lastProgressAt: undefined,
      reason,
      world: "forest",
      propsStage: "waiting-for-physics",
      preparation: undefined,
    },
  );
  expect(error).toHaveBeenCalledOnce();
  const encoded = error.mock.calls[0]?.[0] as string;
  const receipt = JSON.parse(encoded.slice("TN_STRATA_SPAWN_FAILURE ".length));
  expect(receipt).toMatchObject({
    reason,
    world: "forest",
    stage: "waiting-for-physics",
    bucket: null,
    added: null,
    total: null,
    deadlineElapsedMs: 120_000,
    buildStartedMs: null,
    phaseStartedMs: null,
    lastProgressMs: null,
  });
});

it.each(["世界", "\u0000", "\uD800"])(
  "bounds long failure receipts for %j without retaining scene objects or resident key arrays",
  (text) => {
    const error = vi.fn();
    runInNewContext(
      ts.transpileModule(
        `${gameDeclarations(["captureSpawnFailure"])}; captureSpawnFailure(reason);`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
      ).outputText,
      {
        console: { error },
        performance: { now: () => 121_000 },
        deadlineAt: 121_000,
        buildStartedAt: undefined,
        phaseStartedAt: undefined,
        lastProgressAt: undefined,
        reason: text.repeat(10_000),
        world: "forest",
        propsStage: "streaming",
        preparation: {
          phase: "world-load",
          bucket: "x".repeat(10_000),
          added: 0,
          total: 0,
        },
      },
    );
    expect(error).toHaveBeenCalledTimes(1);
    const encoded = error.mock.calls[0]?.[0] as string;
    expect(Buffer.byteLength(encoded)).toBeLessThan(2048);
    const receipt = JSON.parse(encoded.slice("TN_STRATA_SPAWN_FAILURE ".length));
    expect(receipt).toMatchObject({
      reason: text.repeat(10_000).slice(0, 256),
      world: "forest",
      stage: "world-load",
      bucket: "x".repeat(64),
      added: 0,
      total: 0,
      buildStartedMs: null,
      phaseStartedMs: null,
      lastProgressMs: null,
      deadlineElapsedMs: 120_000,
    });
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
    Object.assign(source.startup, { warmup: { status: "incomplete" } });
    source.startup.progress = 1;
    screen.update();
    expect(drawn.at(-1)).toBe("Preparing");
    reject(new Error("Forest spawn: missing cell"));
    await Promise.resolve();
    screen.update();
    expect(texture.version).toBe(version + 3);
    expect(drawn.at(-1)).toBe("Forest spawn: missing cell");
    expect(source.canvasLayer.opaque).toBe(true);
    // The quad keeps the canvas aspect, so the message reads instead of squeezing into a smear.
    expect(status.scale.x / status.scale.y).toBeCloseTo(canvas.width / canvas.height, 5);
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

it.each(["ready", "cleanup", "failed"] as const)(
  "notifies reveal synchronously after removing the cover only for successful startup: %s",
  async (outcome) => {
    let resolve: () => void = () => undefined;
    let reject: (reason: Error) => void = () => undefined;
    const source = host(
      new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      }),
    );
    const observations: { opaque: boolean; meshes: number }[] = [];
    const screen = createLoadingScreen({
      ...source,
      onReveal: () => {
        observations.push({
          opaque: source.canvasLayer.opaque,
          meshes: source.canvasLayer.scene.children.length,
        });
      },
    });
    expect(observations).toEqual([]);
    if (outcome === "cleanup") screen.finish();
    if (outcome === "failed") reject(new Error("Spawn failed"));
    else resolve();
    await Promise.resolve();
    expect(observations).toEqual(outcome === "ready" ? [{ opaque: false, meshes: 0 }] : []);
    screen.finish();
    screen.finish();
    await Promise.resolve();
    expect(observations).toHaveLength(outcome === "ready" ? 1 : 0);
  },
);

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
  const url = new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url);
  const source = ts.createSourceFile(
    "KitScene.ts",
    readFileSync(url, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const constants: string[] = [];
  let gate = "";
  function visit(node: ts.Node): void {
    if (ts.isClassDeclaration(node) && node.name?.text === "KitScene") gate = node.getText(source);
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
    KIT: kit,
    forestStand: undefined,
    addKit: () => Promise.reject(new Error(reason)),
  };
  runInNewContext(compiled, scope);
  const Gate = scope.exports.KitScene;
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

it("the edited alpine stand anchors on the moved ID rather than the nearest original boulder", () => {
  const source = readFileSync(
    new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url),
    "utf8",
  );
  const declarations = source.slice(
    source.indexOf("/** A 1.8"),
    source.indexOf("function forestViews"),
  );
  const scope = {
    exports: {},
    Vector3,
    KIT: "Alpine",
    COLLIDERS: { boulder: { sphere: 0.9 } },
    forestStand: undefined,
    proofFarTarget: null,
    proofClearTarget: null,
    composition: {
      anchorId: "moved",
      referencePlacements: [0, 0, 0, 0, 0, 0, 1, 1, 18, 0, 0, 0, 0, 0, 1, 1],
    },
    result: undefined as { anchor: { x: number } } | undefined,
    kit: {
      field: { heightAt: () => 0 },
      extent: { minX: -100, minZ: -100, sizeX: 200, sizeZ: 200 },
      placementIds: ["original", "moved"],
      placements: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 20, 0, 0, 0, 0, 0, 1, 1]),
    },
  };
  const script = ts.transpile(`${declarations}\nglobalThis.result = chooseStand(globalThis.kit);`, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
  });
  runInNewContext(script, scope);
  expect(scope.result?.anchor.x).toBe(20);
  scope.kit.placementIds = ["original", "missing"];
  expect(() => runInNewContext(script, { ...scope })).toThrow(/moved/);
});

it("alpine composition uses actual sidecar IDs and leaves every package byte unchanged", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const verifierUrl = new URL("../scripts/verify-starter-kit.mjs", import.meta.url).href;
  const { alpineComposition, packageHashes, compositionSource } = await import(verifierUrl);
  const directory = mkdtempSync(join(tmpdir(), "prd614-arm-test-"));
  try {
    const x = -200.389511;
    const z = -17.621393;
    const records = new Float32Array([
      x,
      20,
      z,
      0,
      0,
      0,
      1,
      1,
      x + 8,
      20,
      z,
      0,
      0,
      0,
      1,
      1,
      x + 40,
      20,
      z,
      0,
      0,
      0,
      1,
      1,
    ]);
    writeFileSync(
      join(directory, "world.json"),
      JSON.stringify({ placements: "placements.bin", placementIds: "placement-ids.json" }),
    );
    writeFileSync(join(directory, "placements.bin"), new Uint8Array(records.buffer));
    writeFileSync(
      join(directory, "placement-ids.json"),
      JSON.stringify(["scree:actual:31", "scree:actual:92", "scree:actual:105"]),
    );
    mkdirSync(join(directory, "models"));
    writeFileSync(join(directory, "models/boulder.glb"), "model bytes also count");
    const before = packageHashes(directory);
    const arm = alpineComposition(directory);
    expect(arm.anchorId).toBe("scree:actual:31");
    expect(arm.promotedId).toBe("scree:actual:92");
    expect(arm.proofFarTarget).toEqual(Array.from(records.subarray(8, 11)));
    expect(arm.proofFarTarget.filter((_: number, i: number) => i !== 1)).not.toEqual(
      arm.promotedAt,
    );
    // Typecheck both generated modules against the installed terrain types without writing a game.
    for (const composition of [undefined, arm]) {
      const filename = new URL("../scripts/virtual-composition.ts", import.meta.url).pathname;
      const generated = compositionSource(composition, arm.proofFarTarget, arm.clear.center);
      const options = {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: [],
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
      };
      const host = ts.createCompilerHost(options);
      const getSourceFile = host.getSourceFile.bind(host);
      host.getSourceFile = (path, version, onError, fresh) =>
        path === filename
          ? ts.createSourceFile(path, generated, version, true)
          : getSourceFile(path, version, onError, fresh);
      const program = ts.createProgram([filename], options, host);
      expect(
        ts
          .getPreEmitDiagnostics(program)
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
      ).toEqual([]);
    }
    expect(arm.clearedIds).toEqual(["scree:actual:105"]);
    expect(arm.edits.overrides[arm.anchorId].position[0]).toBeCloseTo(x + 2);
    expect(arm.edits.add[0].id).toBe("game:alpine-added-boulder");
    expect(packageHashes(directory)).toEqual(before);
    writeFileSync(join(directory, "models/boulder.glb"), "changed nested bytes");
    expect(packageHashes(directory)).not.toEqual(before);
    writeFileSync(join(directory, "world.json"), JSON.stringify({ placements: "placements.bin" }));
    expect(() => alpineComposition(directory)).toThrow(/sidecar/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("alpine composition observes live meshes, light, portable body IDs and far instance absence", () => {
  const source = ts.createSourceFile(
    "KitScene.ts",
    readFileSync(new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let method = "";
  function visit(node: ts.Node): void {
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === "#observeComposition")
      method = node.getText(source);
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(method).not.toBe("");
  const scene = new Scene();
  const object = new Object3D();
  const light = new PointLight(0xff9b47, 90, 12, 2);
  object.add(new Mesh(), light);
  object.position.set(5, 0, -1);
  scene.add(object);
  const moved = { position: [2, 0, 2], quaternion: [0, 0, 0, 1], scale: [0.9, 0.9, 0.9] };
  const added = { position: [-5, 0, -1], quaternion: [0, 0, 0, 1], scale: [1.4, 1.4, 1.4] };
  const state: Record<string, number> = {};
  let colliderPresent = true;
  const ctx = {
    scene,
    state: { set: (patch: Record<string, number>) => Object.assign(state, patch) },
    physics: {
      directSpaceState: { intersectRay: () => (colliderPresent ? { body: { id: 7 } } : undefined) },
    },
  };
  const kit = {
    field: { heightAt: () => 0 },
    placementIds: ["moved", "game:alpine-added-boulder"],
    placements: new Float32Array([2, 0, 2, 0, 0, 0, 1, 0.9, -5, 0, -1, 0, 0, 0, 1, 1.4]),
    editReport: { removed: [{ id: "promoted", position: [30, 0, 0] }] },
  };
  const scope = {
    exports: {},
    Matrix4,
    Vector3,
    kit,
    object,
    light,
    composition: {
      anchorId: "moved",
      promotedId: "promoted",
      clearedIds: ["cleared"],
      clear: { center: [0, 0], radius: 60 },
      edits: { overrides: { moved }, add: [added] },
    },
    probe: undefined as { observe(ctx: unknown): void } | undefined,
  };
  const probe = `class Probe { #kit = globalThis.kit; #promoted = globalThis.object; #promotedLight = globalThis.light; #fixedRigidBody = {body:{id:7}}; #view = "overview"; ${method} observe(ctx) { this.#observeComposition(ctx); } } globalThis.probe = new Probe();`;
  runInNewContext(
    ts.transpile(probe, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }),
    scope,
  );
  scope.probe?.observe(ctx);
  expect(state).toEqual({
    movedBoulder: 1,
    clearedCircle: 1,
    addedBoulder: 1,
    promotedObject: 1,
    promotedLight: 1,
    promotedCollider: 1,
    removedFar: 1,
  });
  colliderPresent = false;
  light.removeFromParent();
  const ghost = new InstancedMesh(new Mesh().geometry, new Mesh().material, 1);
  ghost.setMatrixAt(0, new Matrix4().makeTranslation(30, 0, 0));
  scene.add(ghost);
  scene.updateMatrixWorld(true);
  scope.probe?.observe(ctx);
  expect(state.promotedCollider).toBe(0);
  expect(state.promotedLight).toBe(0);
  expect(state.removedFar).toBe(0);
  kit.placementIds.push("cleared");
  scope.probe?.observe(ctx);
  expect(state.clearedCircle).toBe(0);
});

it.each(["missing", "malformed", "wrong path", "wrong kit", "valid"])(
  "starter-kit CLI requires retained scaffold ownership: %s",
  async (marker) => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, existsSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const verifierUrl = new URL("../scripts/verify-starter-kit.mjs", import.meta.url);
    const { packageHashes } = await import(verifierUrl.href);
    const directory = mkdtempSync(join(tmpdir(), "prd614-ownership-test-"));
    try {
      for (const path of ["src/entities", "playtests", "src/terrain", "assets/terrain/alpine"])
        mkdirSync(join(directory, path), { recursive: true });
      for (const path of ["src/entities/keep.ts", "playtests/keep.json", "src/game.ts"])
        writeFileSync(join(directory, path), `sentinel: ${path}`);
      if (marker !== "missing")
        writeFileSync(
          join(directory, ".threenative-kit-verifier.json"),
          marker === "malformed"
            ? "{"
            : JSON.stringify({
                game: marker === "wrong path" ? join(directory, "other") : realpathSync(directory),
                kit: marker === "wrong kit" ? "forest" : "alpine",
              }),
        );
      const before = packageHashes(directory);
      const result = spawnSync(process.execPath, [fileURLToPath(verifierUrl)], {
        encoding: "utf8",
        timeout: 10_000,
        env: {
          ...process.env,
          KIT: "alpine",
          KIT_ARM: "default",
          KIT_GAME: directory,
          KIT_BEFORE: "0",
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      if (marker === "valid") {
        // Acceptance reaches source replacement, then stops at the intentionally absent world source.
        expect(result.stderr).toContain("world.ts");
        expect(result.stderr).not.toContain("KIT_GAME ownership refused");
        expect(existsSync(join(directory, "src/entities"))).toBe(false);
        expect(readFileSync(join(directory, "src/game.ts"), "utf8")).not.toBe(
          "sentinel: src/game.ts",
        );
      } else {
        expect(result.stderr).toContain("KIT_GAME ownership refused");
        expect(packageHashes(directory)).toEqual(before);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("composition far proof shares the original target without default composition effects", async () => {
  const verifierUrl = new URL("../scripts/verify-starter-kit.mjs", import.meta.url).href;
  const { compositionSource } = await import(verifierUrl);
  const target = [31, 22, -47];
  const clearTarget = [-53, 19];
  for (const composition of [
    undefined,
    {
      proofFarTarget: target,
      clear: { center: clearTarget, radius: 12 },
      promotedAt: [5, -1],
      edits: {},
    },
  ]) {
    const scope = { exports: {} as Record<string, unknown> };
    runInNewContext(
      ts.transpile(compositionSource(composition, target, clearTarget), {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      }),
      scope,
    );
    expect(scope.exports.proofFarTarget).toEqual(target);
    expect(scope.exports.proofClearTarget).toEqual(clearTarget);
    expect(scope.exports.composition).toEqual(composition ?? null);
    expect(scope.exports.edits).toEqual(composition?.edits);
  }
  expect(compositionSource(undefined)).toContain("= null");
});

it("composition far pose centers the original record at 90 metres without changing fixed views", () => {
  const source = ts.createSourceFile(
    "KitScene.ts",
    readFileSync(new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "compositionFarView",
  );
  expect(declaration).toBeDefined();
  const scope = {
    exports: {} as { compositionFarView(target: number[]): { at: Vector3; look: Vector3 } },
    Vector3,
  };
  runInNewContext(
    ts.transpile(declaration?.getText(source) ?? "", {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    }),
    scope,
  );
  const view = scope.exports.compositionFarView([31, 22, -47]);
  expect(view.look.toArray()).toEqual([31, 23, -47]);
  expect(view.at.distanceTo(view.look)).toBeCloseTo(90);
  expect(view.at.y - view.look.y).toBe(54);
});

it("composition far scenario appends Digit5 and Digit6 with all view metrics while retaining existing gates", async () => {
  const verifierUrl = new URL("../scripts/verify-starter-kit.mjs", import.meta.url).href;
  const { appendCompositionFarScenario } = await import(verifierUrl);
  const original = JSON.parse(
    readFileSync(
      new URL("../scripts/fixtures/kit-game/playtests/alpine.playtest.json", import.meta.url),
      "utf8",
    ),
  );
  const scenario = structuredClone(original);
  appendCompositionFarScenario(scenario);
  expect(scenario.steps.slice(0, original.steps.length)).toEqual(original.steps);
  expect(scenario.steps.slice(original.steps.length)).toEqual([
    { kind: "input", label: "composition-far-view", press: "Digit5", holdTicks: 2, release: true },
    {
      kind: "wait",
      label: "composition-far",
      waitTicks: 150,
      release: true,
      screenshot: "composition-far",
    },
    {
      kind: "input",
      label: "composition-clear-view",
      press: "Digit6",
      holdTicks: 2,
      release: true,
    },
    {
      kind: "wait",
      label: "composition-clear",
      waitTicks: 150,
      release: true,
      screenshot: "composition-clear",
    },
  ]);
  expect(scenario.assert.resources.slice(0, original.assert.resources.length)).toEqual(
    original.assert.resources,
  );
  expect(
    scenario.assert.resources
      .slice(original.assert.resources.length)
      .map((row: { path: string; gte: number }) => [row.path, row.gte]),
  ).toEqual([
    ["viewGpuP50.composition-far", 0],
    ["viewGpuP95.composition-far", 0],
    ["viewFrameP95.composition-far", 0],
    ["viewGpuP50.composition-clear", 0],
    ["viewGpuP95.composition-clear", 0],
    ["viewFrameP95.composition-clear", 0],
  ]);
  expect(scenario.assert.performance).toEqual(original.assert.performance);
  expect(scenario.assert.performance.maxPhaseMsP95.render).toBe(40);
});

it("composition clear pose centers the shared circle on the heightfield at 30 metres", () => {
  const text = readFileSync(
    new URL("../scripts/fixtures/kit-game/KitScene.ts", import.meta.url),
    "utf8",
  );
  const source = ts.createSourceFile("KitScene.ts", text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find(
    (node) => ts.isFunctionDeclaration(node) && node.name?.text === "compositionClearView",
  );
  expect(declaration).toBeDefined();
  const scope = {
    exports: {} as {
      compositionClearView(
        target: number[],
        field: { heightAt(x: number, z: number): number },
      ): { at: Vector3; look: Vector3 };
    },
    Vector3,
  };
  runInNewContext(
    ts.transpile(declaration?.getText(source) ?? "", {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    }),
    scope,
  );
  const heightAt = vi.fn((x: number, z: number) => x / 2 + z);
  const targets: [number, number][] = [
    [31, -47],
    [-53, 19],
  ];
  for (const target of targets) {
    const view = scope.exports.compositionClearView(target, { heightAt });
    expect(heightAt).toHaveBeenLastCalledWith(...target);
    expect(view.look.toArray()).toEqual([target[0], target[0] / 2 + target[1], target[1]]);
    expect(view.at.distanceTo(view.look)).toBeCloseTo(30);
    expect(view.at.y - view.look.y).toBe(24);
  }
  expect(text).toContain('if (proofClearTarget) VIEW_NAMES.push("composition-clear")');
  expect(text).toContain('"composition-clear": compositionClearView(proofClearTarget, kit.field)');
  const verifier = readFileSync(
    new URL("../scripts/verify-starter-kit.mjs", import.meta.url),
    "utf8",
  );
  expect(verifier).toContain('CONFIG.views.push("composition-far", "composition-clear")');
  expect(verifier).toContain('CONFIG.captures.push("composition-far", "composition-clear")');
  expect(verifier).toContain('"composition-clear": { keys: ["Digit6"] }');
  expect(verifier).toContain("COMPOSITION_FAR ? alpine.clear.center : null");
});
