import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Vector3,
} from "three";
import { afterEach, expect, it, vi } from "vitest";
import { createAssetLoader } from "../src/assets.js";
import { type IWorldPackage, TerrainTiles, WorldCells } from "../src/world.js";

const manifest: IWorldPackage = {
  version: 1,
  extent: { minX: 0, minZ: 0, sizeX: 256, sizeZ: 64 },
  cellSize: 64,
  terrain: {
    heightmap: "unused.u16",
    columns: 5,
    rows: 2,
    spacing: 64,
    heightMin: 0,
    heightMax: 1,
  },
  placements: "unused.bin",
  assets: { tree: { glb: "tree.glb", bounds: { min: [-1, 0, -1], max: [1, 2, 1] } } },
  cells: Array.from({ length: 4 }, (_, x) => ({
    x,
    z: 0,
    runs: [{ asset: "tree", offset: x, count: 1 }],
  })),
};
afterEach(() => vi.unstubAllGlobals());

const placements = new Float32Array(
  Array.from({ length: 4 }, (_, x) => [x * 64 + 32, 0, 32, 0, 0, 0, 1, 1]).flat(),
).buffer;

it("streams already decoded placements without fetching or duplicating the caller's terrain", async () => {
  const follow = { position: new Vector3(32, 0, 32) };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const fetch = vi.fn(() => {
    throw new Error("decoded data must not fetch");
  });
  vi.stubGlobal("fetch", fetch);
  const surface = new MeshBasicMaterial();
  const world = await WorldCells.load({
    url: "strata/world.json",
    assets,
    surface,
    follow,
    ring: 0,
    data: { manifest, placements },
    terrain: false,
    budgets: { bytes: 128, instances: 4, residentCells: 2 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), surface)),
  });
  try {
    expect(fetch).not.toHaveBeenCalled();
    expect(world.children.some((child) => child instanceof TerrainTiles)).toBe(false);
    for (let frame = 0; frame < 30; frame++) {
      world.update();
      await Promise.resolve();
    }
    expect(world.stats().instances).toBe(1);
    expect(world.stats().residentKeys).toEqual(["0:0"]);
    follow.position.x = 224;
    for (let frame = 0; frame < 30; frame++) {
      world.update();
      await Promise.resolve();
    }
    expect(world.stats().residentKeys).toEqual(["3:0"]);
    expect(world.stats().evictions).toBeGreaterThan(0);
    follow.position.x = 32;
    for (let frame = 0; frame < 30; frame++) {
      world.update();
      await Promise.resolve();
    }
    expect(world.stats().residentKeys).toEqual(["0:0"]);
    expect(world.stats().instances).toBe(1);
    expect(world.stats().failures).toBe(0);
  } finally {
    world.dispose();
    vi.unstubAllGlobals();
  }
  expect(world.released).toBe(true);
});

it("keeps decoded prop admission within the default 2ms budget plus one final unit", async () => {
  const count = 5000;
  const data = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) data.set([32, 0, 32, 0, 0, 0, 1, 1], i * 8);
  const dense: IWorldPackage = {
    ...manifest,
    cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
  };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const surface = new MeshBasicMaterial();
  let clock = 0;
  const world = await WorldCells.load({
    url: "strata/world.json",
    assets,
    surface,
    follow: { position: new Vector3(32, 0, 32) },
    ring: 0,
    data: { manifest: dense, placements: data.buffer, heightmap: new Uint16Array(10) },
    terrain: false,
    admissionNow: () => ++clock,
    placementReach: new Float32Array(count).fill(50),
    budgets: { bytes: count * 32, instances: count, residentCells: 1 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), surface)),
  });
  let sawBacklog = false;
  let admitted = false;
  try {
    for (let frame = 0; frame < 100; frame++) {
      world.update();
      await Promise.resolve();
      const stats = world.stats();
      expect(stats.admission.spentMs).toBeLessThanOrEqual(3);
      sawBacklog ||= stats.admission.backlog > 0;
      if (sawBacklog && stats.admission.backlog === 0 && stats.loadsInFlight === 0) {
        admitted = true;
        break;
      }
    }
    expect(sawBacklog).toBe(true);
    expect(admitted).toBe(true);
    expect(world.stats().instances).toBe(count);
    expect(world.stats().failures).toBe(0);
  } finally {
    world.dispose();
  }
});

it("rejects malformed decoded runs before loading a model", async () => {
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const loadModel = vi.fn();
  await expect(
    WorldCells.load({
      url: "strata/world.json",
      assets,
      surface: new MeshBasicMaterial(),
      follow: { position: new Vector3() },
      ring: 0,
      terrain: false,
      data: { manifest, placements: new ArrayBuffer(0), heightmap: new Uint16Array(10) },
      budgets: { bytes: 128, instances: 4, residentCells: 2 },
      loadModel,
    }),
  ).rejects.toThrow("WORLD_RUN_OUT_OF_RANGE");
  expect(loadModel).not.toHaveBeenCalled();
});

function drawn(world: WorldCells): number {
  let count = 0;
  world.traverse((node) => {
    if (node instanceof InstancedMesh && node.visible && node.layers.isEnabled(0))
      count += node.count;
  });
  return count;
}
async function settle(world: WorldCells): Promise<void> {
  for (let frame = 0; frame < 100; frame++) {
    world.update();
    await Promise.resolve();
  }
}
it("refilters placement-specific 3D reach from fully culled to visible and back without leaving the cell", async () => {
  const one: IWorldPackage = {
    ...manifest,
    cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 1, count: 1 }] }],
  };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const material = new MeshBasicMaterial();
  const follow = { position: new Vector3(40, 0, 32) };
  // Offset 1 must select 5 metres, not the unrelated zero reach at record 0.
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: material,
    follow,
    ring: 0,
    terrain: false,
    data: {
      manifest: one,
      placements: new Float32Array([0, 0, 0, 0, 0, 0, 1, 1, 50, 0, 32, 0, 0, 0, 1, 1]).buffer,
    },
    placementReach: new Float32Array([0, 5]),
    budgets: { bytes: 64, instances: 2, residentCells: 1 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), material)),
  });
  try {
    await settle(world);
    expect(drawn(world)).toBe(0);
    follow.position.x = 50;
    await settle(world);
    expect(drawn(world)).toBe(1);
    follow.position.y = 10;
    await settle(world);
    expect(drawn(world)).toBe(0);
    follow.position.y = 0;
    await settle(world);
    expect(drawn(world)).toBe(1);
    follow.position.x = 58;
    await settle(world);
    expect(drawn(world)).toBe(0);
    expect(world.stats().residentCells).toBe(1);
    expect(world.stats().failures).toBe(0);
  } finally {
    world.dispose();
  }
});
it.each([
  new Float32Array(3),
  new Float32Array([0, -1, 1, 1]),
  new Float32Array([0, Number.NaN, 1, 1]),
  new Float32Array([0, Number.NEGATIVE_INFINITY, 1, 1]),
])("rejects malformed placement reach before loading models: %s", async (placementReach) => {
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const loadModel = vi.fn();
  await expect(
    WorldCells.load({
      url: "world.json",
      assets,
      surface: new MeshBasicMaterial(),
      follow: { position: new Vector3() },
      ring: 0,
      terrain: false,
      data: { manifest, placements },
      placementReach,
      budgets: { bytes: 128, instances: 4, residentCells: 2 },
      loadModel,
    }),
  ).rejects.toThrow("placementReach");
  expect(loadModel).not.toHaveBeenCalled();
});

it("yields to host while validating and indexing decoded reach records before load resolves", async () => {
  const count = 2048;
  const packed = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) packed.set([32, 0, 32, 0, 0, 0, 1, 1], i * 8);
  const dense = {
    ...manifest,
    cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
  };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  // Charge the real preparation units so this checks a spent budget, not a record count.
  let clock = 0;
  const preparationClock = vi.spyOn(performance, "now").mockImplementation(() => {
    clock += 3;
    return clock;
  });
  let hostProgress = false;
  const timer = setTimeout(() => {
    hostProgress = true;
  }, 0);
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: new MeshBasicMaterial(),
    follow: { position: new Vector3(32, 0, 32) },
    ring: 0,
    terrain: false,
    data: { manifest: dense, placements: packed.buffer },
    placementReach: new Float32Array(count).fill(Number.POSITIVE_INFINITY),
    budgets: { bytes: count * 32, instances: count, residentCells: 1 },
    loadModel: async () => new Group(),
  });
  try {
    expect(hostProgress).toBe(true);
  } finally {
    clearTimeout(timer);
    world.dispose();
    preparationClock.mockRestore();
  }
});

it("separates the validation and indexing budgets with a host turn", async () => {
  const count = 512;
  const packed = new Float32Array(count * 8);
  const dense = {
    ...manifest,
    cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
  };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  let clock = 0;
  let firstRecordReads = 0;
  let hostProgress = false;
  let indexedAfterHostTurn = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reach = new Proxy(new Float32Array(count).fill(50), {
    get(target, key) {
      if (key === "0") {
        firstRecordReads++;
        clock += 7;
        if (firstRecordReads === 1)
          timer = setTimeout(() => {
            hostProgress = true;
          }, 0);
        if (firstRecordReads === 2) indexedAfterHostTurn = hostProgress;
      }
      return Reflect.get(target, key, target);
    },
  });
  const preparationClock = vi.spyOn(performance, "now").mockImplementation(() => clock);
  let world: WorldCells | undefined;
  try {
    world = await WorldCells.load({
      url: "world.json",
      assets,
      surface: new MeshBasicMaterial(),
      follow: { position: new Vector3() },
      ring: 0,
      terrain: false,
      data: { manifest: dense, placements: packed.buffer },
      placementReach: reach,
      budgets: { bytes: count * 32, instances: count, residentCells: 1 },
      loadModel: async () => new Group(),
    });
    expect(firstRecordReads).toBe(2);
    expect(indexedAfterHostTurn).toBe(true);
  } finally {
    clearTimeout(timer);
    world?.dispose();
    preparationClock.mockRestore();
  }
});

it("does not spend one host turn per decoded reach chunk when preparation stays below its time budget", async () => {
  const count = 65_537;
  const packed = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) packed.set([32, i % 3, 32, 0, 0, 0, 1, 1], i * 8);
  const dense = {
    ...manifest,
    cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
  };
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  // A controlled cheap-work clock isolates pacing from machine load. The production loops
  // still validate every actual record and construct their actual reach ranges.
  const preparationClock = vi.spyOn(performance, "now").mockReturnValue(0);
  const hostTurns = vi.spyOn(globalThis, "setTimeout");
  let world: WorldCells | undefined;
  try {
    world = await WorldCells.load({
      url: "world.json",
      assets,
      surface: new MeshBasicMaterial(),
      follow: { position: new Vector3(32, 0, 32) },
      ring: 0,
      terrain: false,
      data: { manifest: dense, placements: packed.buffer },
      placementReach: new Float32Array(count).fill(50),
      budgets: { bytes: count * 32, instances: count, residentCells: 1 },
      loadModel: async () => new Group(),
    });
    expect(world.released).toBe(false);
    expect(world.stats().failures).toBe(0);
    expect(hostTurns.mock.calls.length).toBeLessThanOrEqual(1);
  } finally {
    world?.dispose();
    preparationClock.mockRestore();
    hostTurns.mockRestore();
  }
});

it.each([
  { lodHysteresis: -0.1, gpuScene: false },
  { lodHysteresis: 1, gpuScene: false },
  { lodHysteresis: Number.NaN, gpuScene: false },
  { lodHysteresis: 0.2, gpuScene: true },
  { lodHysteresis: 0.2, gpuScene: false, impostors: true },
])("rejects unsupported authored CPU hysteresis settings before model work: %j", async (policy) => {
  const model = vi.fn(async () => new Group());
  await expect(
    WorldCells.load({
      url: "world.json",
      surface: new MeshBasicMaterial(),
      follow: { position: new Vector3() },
      ring: 0,
      terrain: false,
      data: { manifest, placements },
      budgets: { bytes: 128, instances: 4, residentCells: 4 },
      loadModel: model,
      ...policy,
    }),
  ).rejects.toThrow(/lodHysteresis/);
  expect(model).not.toHaveBeenCalled();
});

it("submits a rotated offset model when its actual geometry intersects the camera outside its source cell", async () => {
  const geometry = new BoxGeometry(4, 2, 4).translate(132, 0, 0);
  const surface = new MeshBasicMaterial();
  const camera = new PerspectiveCamera(30, 1, 0.1, 10);
  camera.position.set(32, 0, -94);
  camera.lookAt(32, 0, -100);
  camera.updateMatrixWorld(true);
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const data = new Float32Array([32, 0, 32, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 1]);
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface,
    follow: camera,
    ring: 10,
    terrain: false,
    gpuScene: false,
    adaptiveLod: false,
    shadows: { cast: false, receive: false },
    data: {
      manifest: {
        ...manifest,
        assets: { tree: { glb: "tree.glb", bounds: { min: [130, -1, -2], max: [134, 1, 2] } } },
        cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count: 1 }] }],
      },
      placements: data.buffer,
    },
    budgets: { residentCells: 4, instances: 1, bytes: 32 },
    loadModel: async () => new Group().add(new Mesh(geometry, surface)),
  });
  try {
    for (let frame = 0; frame < 100; frame++) {
      world.update(undefined, camera);
      await Promise.resolve();
    }
    let submitted = 0;
    world.traverse((node) => {
      if (node instanceof InstancedMesh && (node.layers.mask & 1) !== 0) submitted += node.count;
    });
    expect(world.stats().instances).toBe(1);
    expect(submitted).toBe(1);
  } finally {
    world.dispose();
  }
});

it("rejects exact authored parts combined with whole-asset impostors before model admission", async () => {
  const model = vi.fn();
  const promise = WorldCells.load({
    url: "world.json",
    surface: new MeshBasicMaterial(),
    follow: { position: new Vector3() },
    terrain: false,
    ring: 1,
    budgets: { residentCells: 4, instances: 4, bytes: 128 },
    data: { manifest, placements },
    gpuScene: false,
    preserveAuthoredParts: true,
    impostors: true,
    loadModel: model,
  });
  await expect(
    promise.then((world) => {
      world.dispose();
      return world;
    }),
  ).rejects.toThrow(/preserveAuthoredParts.*impostors/u);
  expect(model).not.toHaveBeenCalled();
});

it("admits a queued run for the current camera rather than its obsolete enqueue position", async () => {
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const material = new MeshBasicMaterial();
  const follow = { position: new Vector3(48, 0, 32) };
  let release!: (model: Group) => void;
  const model = new Promise<Group>((resolve) => {
    release = resolve;
  });
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: material,
    follow,
    ring: 4,
    terrain: false,
    prefetchSeconds: 0,
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    data: {
      manifest: {
        ...manifest,
        cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count: 1 }] }],
      },
      placements: new Float32Array([32, 0, 32, 0, 0, 0, 1, 1]).buffer,
    },
    placementReach: new Float32Array([5]),
    budgets: { bytes: 32, instances: 1, residentCells: 1 },
    loadModel: () => model,
  });
  try {
    world.update();
    release(new Group().add(new Mesh(new BoxGeometry(1, 2, 1), material)));
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    expect(world.stats().loadsInFlight).toBe(0);
    // The model adopted and queued its run while the camera was out of reach. Before any
    // placement slice was admitted, the camera arrived beside it. No obsolete empty publication
    // followed by another whole rebuild should be necessary to display this record.
    follow.position.x = 32;
    world.update();
    expect(drawn(world)).toBe(1);
    expect(world.stats().admission.backlog).toBe(0);
    expect(world.stats().rebuilds).toBe(0);
  } finally {
    world.dispose();
  }
});

it("keeps one camera snapshot across an admitted run's slices before refiltering its next pose", async () => {
  const count = 600;
  const packed = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) packed.set([32, 0, 32, 0, 0, 0, 1, 1], i * 8);
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const material = new MeshBasicMaterial();
  const follow = { position: new Vector3(32, 0, 32) };
  let clock = 0;
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: material,
    follow,
    ring: 0,
    terrain: false,
    prefetchSeconds: 0,
    admissionBudgetMs: 0.1,
    admissionNow: () => ++clock,
    data: {
      manifest: {
        ...manifest,
        cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
      },
      placements: packed.buffer,
    },
    placementReach: new Float32Array(count).fill(5),
    budgets: { bytes: count * 32, instances: count, residentCells: 1 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), material)),
  });
  try {
    world.update();
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    world.update(); // Only one 256-record placement slice fits this artificial budget.
    expect(world.stats().admission.backlog).toBeGreaterThan(0);
    expect(drawn(world)).toBe(0);
    follow.position.x = 48;
    let firstPublication = 0;
    for (let frame = 0; frame < 30 && firstPublication === 0; frame++) {
      world.update();
      firstPublication = drawn(world);
    }
    expect(firstPublication).toBe(count);
    await settle(world);
    expect(drawn(world)).toBe(0);
    expect(world.stats().admission.backlog).toBe(0);
    expect(world.stats().failures).toBe(0);
  } finally {
    world.dispose();
  }
});

it("converges every run of one asset after independently deferred camera snapshots", async () => {
  const runCount = 300;
  const count = runCount * 2;
  const packed = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) packed.set([32, 0, 32, 0, 0, 0, 1, 1], i * 8);
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const material = new MeshBasicMaterial();
  const follow = { position: new Vector3(32, 0, 32) };
  let clock = 0;
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: material,
    follow,
    ring: 4,
    terrain: false,
    prefetchSeconds: 0,
    admissionBudgetMs: 0.1,
    admissionNow: () => ++clock,
    data: {
      manifest: {
        ...manifest,
        cells: [
          {
            x: 0,
            z: 0,
            runs: [
              { asset: "tree", offset: 0, count: runCount },
              { asset: "tree", offset: runCount, count: runCount },
            ],
          },
        ],
      },
      placements: packed.buffer,
    },
    placementReach: new Float32Array(count).fill(5),
    budgets: { bytes: count * 32, instances: count, residentCells: 1 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), material)),
  });
  new Group().add(world);
  const pump = () => {
    world.update();
    world.traverse((node) => {
      if (node instanceof InstancedMesh && node.visible)
        (node.onBeforeRender as (...args: unknown[]) => void)(node, null, null, null, null, null);
    });
  };
  try {
    pump();
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    for (let frame = 0; frame < 30 && drawn(world) === 0; frame++) pump();
    expect(drawn(world)).toBe(runCount);
    expect(world.stats().admission.backlog).toBeGreaterThan(0);
    follow.position.x = 100;
    pump(); // Run B starts outside reach, independently of already-published run A.
    follow.position.x = 32;
    for (let frame = 0; frame < 100; frame++) {
      pump();
      await Promise.resolve();
    }
    expect(world.stats().unchanged).toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
    expect(world.stats().admission.backlog).toBe(0);
    expect(drawn(world)).toBe(count);
    expect(world.stats().failures).toBe(0);
  } finally {
    world.dispose();
  }
});

it("runs an owed stationary-camera refilter after the last byte-identical publication", async () => {
  const count = 600;
  const packed = new Float32Array(count * 8);
  for (let i = 0; i < count; i++) packed.set([32, 0, 32, 0, 0, 0, 1, 1], i * 8);
  const assets = createAssetLoader();
  vi.spyOn(assets, "resolve").mockResolvedValue([]);
  const material = new MeshBasicMaterial();
  const follow = { position: new Vector3(32, 0, 32) };
  let clock = 0;
  const world = await WorldCells.load({
    url: "world.json",
    assets,
    surface: material,
    follow,
    ring: 0,
    terrain: false,
    prefetchSeconds: 0,
    admissionBudgetMs: 0.1,
    admissionNow: () => ++clock,
    data: {
      manifest: {
        ...manifest,
        cells: [{ x: 0, z: 0, runs: [{ asset: "tree", offset: 0, count }] }],
      },
      placements: packed.buffer,
    },
    placementReach: new Float32Array(count).fill(5),
    budgets: { bytes: count * 32, instances: count, residentCells: 1 },
    loadModel: async () => new Group().add(new Mesh(new BoxGeometry(1, 2, 1), material)),
  });
  new Group().add(world);
  const pump = async () => {
    world.update();
    world.traverse((node) => {
      if (node instanceof InstancedMesh && node.visible)
        (node.onBeforeRender as (...args: unknown[]) => void)(node, null, null, null, null, null);
    });
    await Promise.resolve();
  };
  try {
    for (let frame = 0; frame < 100; frame++) await pump();
    expect(drawn(world)).toBe(count);
    expect(world.stats().pendingPrewarm).toBe(0);
    follow.position.x = 35;
    await pump(); // Gate bracket requests a build, but all records remain inside their reach.
    expect(world.stats().admission.backlog).toBeGreaterThan(0);
    follow.position.x = 48;
    for (let frame = 0; frame < 100; frame++) await pump();
    expect(world.stats().unchanged).toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
    expect(world.stats().admission.backlog).toBe(0);
    expect(drawn(world)).toBe(0);
  } finally {
    world.dispose();
  }
});
