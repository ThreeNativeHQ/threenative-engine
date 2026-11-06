import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
} from "three";
import { describe, expect, it, vi } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

const SEEDS = 1000;
const STEPS = 18;
const CELLS = 4;
const CELL_SIZE = 32;
const DRAIN_ROUNDS = 32;

interface ITotals {
  completed: number;
  loads: number;
  geometriesDisposed: number;
  disposedWhilePending: number;
  lateLoads: number;
  evictions: number;
  reentries: number;
  hlodSeeds: number;
  refcountSeeds: number;
}

/** Mulberry32: one seed fixes every decision a scenario makes. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function geometry(triangles: number): BufferGeometry {
  const result = new BufferGeometry();
  result.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  result.setIndex(
    new BufferAttribute(new Uint16Array(Array.from({ length: triangles * 3 }, (_, i) => i % 3)), 1),
  );
  return result;
}
function model(triangles: number): Group {
  const result = new Group();
  result.add(new Mesh(geometry(triangles), new MeshBasicMaterial()));
  return result;
}
function manifest(): IWorldPackage {
  return {
    version: 1,
    extent: { minX: 0, minZ: 0, sizeX: CELL_SIZE * CELLS, sizeZ: CELL_SIZE },
    cellSize: CELL_SIZE,
    terrain: {
      heightmap: "height.u16",
      columns: CELLS + 1,
      rows: 2,
      spacing: 32,
      heightMin: 0,
      heightMax: 2,
    },
    placements: "placements.bin",
    assets: { stone: { glb: "stone.glb", lods: [], bounds: { min: [0, 0, 0], max: [1, 1, 0] } } },
    cells: Array.from({ length: CELLS }, (_, x) => ({
      x,
      z: 0,
      runs: [{ asset: "stone", offset: 2 * x, count: 2 }],
      proxy: {
        glb: `proxy${x}.glb`,
        scope: "cell",
        triangles: 1,
        materialGroups: 1,
        error: 0.1,
        bounds: { min: [x * CELL_SIZE + 10, 0, 10], max: [x * CELL_SIZE + 20, 1, 10] },
      },
    })),
  };
}
// Two placements per cell, eight floats each: position, identity quaternion, unit scale.
function placements(): ArrayBuffer {
  const buffer = new ArrayBuffer(CELLS * 2 * 8 * Float32Array.BYTES_PER_ELEMENT);
  const result = new Float32Array(buffer);
  for (let i = 0; i < CELLS * 2; i++) {
    const x = Math.floor(i / 2) * CELL_SIZE + (i % 2 === 0 ? 10 : 19);
    result.set([x, 0, 10, 0, 0, 0, 1, 1], i * 8);
  }
  return buffer;
}
const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
function aim(x: number, z: number, near: boolean): void {
  camera.position.set(x, 1, near ? z - 4 : z + 600);
  camera.lookAt(x, 1, z);
  camera.updateMatrixWorld(true);
}
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

async function scenario(seed: number, totals: ITotals): Promise<void> {
  const next = random(seed);
  const pick = (count: number): number => Math.floor(next() * count);
  const follow = { position: { x: 16, z: 16 } };
  // Loader and compile completions are held here until the schedule resolves them.
  const pendingLoads: Array<() => void> = [];
  const pendingCompiles: Array<() => void> = [];
  const disposals: Array<() => number> = [];
  let near = false;
  let disposed = false;

  const renderer = {
    info: { render: { drawCalls: 0 } },
    domElement: { height: 1080 },
    kind: "webgl",
    raw: {},
    compileAsync: () =>
      new Promise<void>((done) => {
        pendingCompiles.push(() => done());
      }),
    uploadAttributes: () => 1,
  } as unknown as IRendererLike;
  const loadModel = (url: string): Promise<Object3D> => {
    totals.loads += 1;
    const proxy = /proxy(\d+)\.glb$/.exec(url);
    const result = model(proxy ? 1 : 2);
    if (proxy) result.position.set(Number(proxy[1]) * CELL_SIZE + 10, 0, 10);
    const dispose = vi.spyOn((result.children[0] as Mesh).geometry, "dispose");
    disposals.push(() => dispose.mock.calls.length);
    return new Promise<Object3D>((done) => {
      pendingLoads.push(() => done(result));
    });
  };

  const world = await WorldCells.load({
    url: "/world/world.json",
    surface: new MeshBasicMaterial(),
    follow,
    ring: 0,
    budgets: { bytes: 10_000_000, instances: 100, residentCells: 2 },
    terrain: false,
    gpuScene: false,
    bundles: false,
    adaptiveLod: false,
    data: { manifest: manifest(), placements: placements() },
    loadModel,
  });
  new Scene().add(world);

  const settle = async (queue: Array<() => void>): Promise<void> => {
    if (queue.length === 0) return;
    const [run] = queue.splice(pick(queue.length), 1);
    if (disposed && queue === pendingLoads) totals.lateLoads += 1;
    run?.();
    await flush();
  };
  const drain = async (): Promise<void> => {
    for (let guard = 0; guard < 10_000; guard++) {
      const fromLoad = pendingLoads.length > 0;
      const run = fromLoad ? pendingLoads.shift() : pendingCompiles.shift();
      if (run === undefined) return;
      if (disposed && fromLoad) totals.lateLoads += 1;
      run();
      await flush();
    }
    throw new Error("drain never emptied the pending queue");
  };
  const pump = async (): Promise<void> => {
    aim(follow.position.x, follow.position.z, near);
    world.update(renderer, camera);
    await flush();
  };

  let residents = new Set<string>();
  const evicted = new Set<string>();
  let hlodSeen = false;
  let refcountSeen = false;
  let residentBytesSeen = false;
  const observe = (): void => {
    const stats = world.stats();
    const now = new Set(stats.residentKeys);
    for (const key of residents) if (!now.has(key)) evicted.add(key);
    for (const key of now) if (!residents.has(key) && evicted.has(key)) totals.reentries += 1;
    residents = now;
    if (stats.hlod.bytes > 0) hlodSeen = true;
    residentBytesSeen ||= stats.residentBytes > 0;
    if (Object.values(world.assetRefCounts()).some((count) => count > 0)) refcountSeen = true;
  };

  // One residency pass before the schedule, so every seed starts a load that the schedule can race.
  await pump();
  observe();

  const disposeAt = 2 + pick(STEPS - 4);
  for (let step = 0; step < STEPS; step++) {
    const roll = next();
    if (step === disposeAt) {
      const stats = world.stats();
      if (pendingLoads.length > 0 || stats.loadsInFlight > 0 || stats.loadsQueued > 0)
        totals.disposedWhilePending += 1;
      world.dispose();
      disposed = true;
    } else if (!disposed && roll < 0.2) {
      const cell = pick(CELLS + 1);
      follow.position.x = cell < CELLS ? cell * CELL_SIZE + 16 : -1000;
      follow.position.z = cell < CELLS ? 16 : -1000;
    } else if (!disposed && roll < 0.3) {
      near = next() < 0.4;
    } else if (!disposed && roll < 0.55) {
      await pump();
    } else {
      await settle(roll < 0.8 ? pendingLoads : pendingCompiles);
    }
    observe();
  }

  if (!disposed) {
    for (let round = 0; round < DRAIN_ROUNDS; round++) {
      await pump();
      await drain();
      const stats = world.stats();
      if (stats.loadsInFlight === 0 && stats.loadsQueued === 0) break;
    }
    expect(world.stats().loadsInFlight, "admission settles before dispose").toBe(0);
    world.dispose();
    disposed = true;
  }
  await drain();

  const final = world.stats();
  expect(disposals.length, "loader calls observed").toBeGreaterThan(0);
  expect(pendingLoads.length + pendingCompiles.length, "nothing pending after drain").toBe(0);
  expect(residentBytesSeen, "resident bytes observed before teardown").toBe(true);
  expect(final.residentBytes, "resident bytes").toBe(0);
  expect(final.residentCells, "resident cells").toBe(0);
  expect(final.instances, "resident instances").toBe(0);
  expect(final.residentKeys, "resident keys").toEqual([]);
  expect(final.hlod.bytes, "HLOD bytes").toBe(0);
  expect(final.hlod.pending, "HLOD pending").toBe(0);
  expect(final.loadsInFlight, "loads in flight").toBe(0);
  expect(final.loadsQueued, "loads queued").toBe(0);
  expect(final.failures, "counted teardown failures").toBe(0);
  expect(
    Object.values(world.assetRefCounts()).filter((count) => count !== 0),
    "asset refcounts left after dispose",
  ).toEqual([]);
  for (const calls of disposals) expect(calls(), "geometry dispose calls").toBe(1);

  totals.geometriesDisposed += disposals.filter((calls) => calls() > 0).length;
  totals.evictions += final.evictions;
  totals.completed += 1;
  if (hlodSeen) totals.hlodSeeds += 1;
  if (refcountSeen) totals.refcountSeeds += 1;
}

describe("WorldCells load, eviction, dispose and re-entry interleavings", () => {
  it("ends every seeded interleaving with no resident bytes, nothing resident, no HLOD bytes or refcounts, and each geometry disposed once", async () => {
    const totals: ITotals = {
      completed: 0,
      loads: 0,
      geometriesDisposed: 0,
      disposedWhilePending: 0,
      lateLoads: 0,
      evictions: 0,
      reentries: 0,
      hlodSeeds: 0,
      refcountSeeds: 0,
    };
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      try {
        await scenario(seed, totals);
      } catch (error) {
        failures.push(`seed ${seed}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.info(`world-cells-race totals: ${JSON.stringify(totals)}`);
    expect(failures.length, failures.slice(0, 20).join("\n")).toBe(0);
    expect(totals.completed).toBe(SEEDS);
    expect(totals.loads, "observed loader calls").toBeGreaterThan(0);
    expect(totals.geometriesDisposed, "observed geometry disposals").toBeGreaterThan(0);
    expect(totals.disposedWhilePending, "dispose while a load was pending").toBeGreaterThan(0);
    expect(totals.lateLoads, "loads completing after dispose").toBeGreaterThan(0);
    expect(totals.evictions, "evictions").toBeGreaterThan(0);
    expect(totals.reentries, "re-entries after eviction").toBeGreaterThan(0);
    expect(totals.hlodSeeds, "seeds with HLOD bytes observed").toBeGreaterThan(0);
    expect(totals.refcountSeeds, "seeds with positive refcounts observed").toBeGreaterThan(0);
  }, 50_000);
});
