import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  type CanvasTexture,
  type Mesh,
  type MeshBasicMaterial,
  OrthographicCamera,
  PerspectiveCamera,
  Scene,
} from "three";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import {
  createLoadingScreen,
  createSpawnReadiness,
  spawnReadinessSnapshot,
} from "../../../examples/strata-terrain-preview/src/render/loading.js";

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
    const source = ts.createSourceFile(
      "game.ts",
      readFileSync(
        new URL("../../../examples/strata-terrain-preview/src/game.ts", import.meta.url),
        "utf8",
      ),
      ts.ScriptTarget.Latest,
      true,
    );
    let declaration = "";
    function visit(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "buildProps")
        declaration = node.getText(source);
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (!declaration) throw new Error("Missing production Strata preparation controller");
    const controllerHost = host(new Promise<void>(() => undefined));
    controllerHost.canvasLayer.opaque = true;
    controllerHost.canvasLayer.renderWorldDuringStartup = false;
    const world = new Scene();
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
        `export class Controller { #surfaces; async run() { const ${declaration}; await buildProps(); } }`,
        { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
      ).outputText,
      scope,
    );
    if (!scope.exports.Controller)
      throw new Error("Production preparation controller did not load");
    const work = new scope.exports.Controller().run();
    await preparing;
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
  const spawn = createSpawnReadiness("Strata spawn");
  expect(spawn.ready).toBe(false);
  spawn.observe(false);
  expect(spawn.ready).toBe(false);
  spawn.observe(true);
  await spawn.promise;
  spawn.observe(false, 1);
  expect(spawn.ready).toBe(true);
  expect(spawn.error).toBe("");
  spawn.cancel();
});

it("rejects a timed out spawn and never treats later coverage as playable", async () => {
  vi.useFakeTimers();
  const spawn = createSpawnReadiness("Forest spawn", 100);
  const rejection = expect(spawn.promise).rejects.toThrow("Forest spawn admission exceeded 100 ms");
  await vi.advanceTimersByTimeAsync(100);
  await rejection;
  spawn.observe(true);
  expect(spawn.ready).toBe(false);
  expect(spawn.error).toContain("exceeded");
  spawn.cancel();
  vi.useRealTimers();
});

it("captures the pending gate before timeout latches or rejects, once per failure", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  const spawn = createSpawnReadiness("Forest spawn", 100, (reason) => {
    events.push(`capture:${spawn.ready}:${spawn.error}:${reason}`);
  });
  const rejection = spawn.promise.catch((error: Error) => events.push(`rejected:${error.message}`));
  try {
    await vi.advanceTimersByTimeAsync(100);
    await rejection;
    spawn.observe(true);
    spawn.fail("late failure");
    spawn.cancel();
    expect(events).toEqual([
      "capture:false::Forest spawn admission exceeded 100 ms",
      "rejected:Forest spawn admission exceeded 100 ms",
    ]);
    expect(spawn.ready).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    spawn.cancel();
    vi.useRealTimers();
  }
});

it("keeps the original admission failure when its diagnostic capture throws", async () => {
  vi.useFakeTimers();
  const capture = vi.fn(() => {
    throw new Error("diagnostic observer failed");
  });
  const spawn = createSpawnReadiness("Forest spawn", 100, capture);
  const rejection = expect(spawn.promise).rejects.toThrow("Forest spawn assets failed to load");
  try {
    spawn.observe(false, 1);
    await rejection;
    expect(capture).toHaveBeenCalledOnce();
    expect(spawn.error).toBe("Forest spawn assets failed to load");
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    spawn.cancel();
    vi.useRealTimers();
  }
});

it.each(["observe", "cancel"])(
  "keeps capture reentry through %s from changing failure settlement",
  async (action) => {
    const spawn = createSpawnReadiness("Controlled spawn", 100, () => {
      if (action === "observe") spawn.observe(true);
      else spawn.cancel();
    });
    const rejection = expect(spawn.promise).rejects.toThrow("original admission failure");
    spawn.fail("original admission failure");
    await rejection;
    expect(spawn.ready).toBe(false);
    expect(spawn.error).toBe("original admission failure");
    spawn.cancel();
  },
);

it("cancels a pending scene without leaving its readiness promise or timer behind", async () => {
  vi.useFakeTimers();
  const spawn = createSpawnReadiness("Forest spawn");
  const rejection = expect(spawn.promise).rejects.toThrow("Forest spawn cancelled");
  spawn.cancel();
  await rejection;
  expect(vi.getTimerCount()).toBe(0);
  expect(spawn.ready).toBe(false);
  vi.useRealTimers();
});

it("keeps even an empty-message rejection failed after late coverage", async () => {
  const spawn = createSpawnReadiness("Strata spawn");
  const rejection = expect(spawn.promise).rejects.toThrow("Strata spawn failed");
  spawn.fail(new Error());
  await rejection;
  spawn.observe(true);
  expect(spawn.ready).toBe(false);
  spawn.cancel();
});
