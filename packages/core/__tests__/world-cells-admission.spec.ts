import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Box3,
  BoxGeometry,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  WebGPUCoordinateSystem,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type IWorldPackage, TerrainTiles, WorldCells } from "../src/world.js";

/**
 * One admission budget per frame, and the ceiling it holds.
 *
 * The proof is the ceiling itself, so the clock is injected rather than hoped for: with a clock that
 * advances a fixed amount per reading, "one unit costs exactly this much" is an exact number instead
 * of a machine-dependent one, and every frame's spend can be compared against `budget + one unit`
 * without a tolerance. The tests that matter then re-run the same world on the real clock, so what is
 * being paced is real work and not bookkeeping the budget invented.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const CELL_SIZE = manifest.cellSize;
const MIN_X = manifest.extent.minX;
const MIN_Z = manifest.extent.minZ;
const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
it("reports completed spawn coverage separately from reserved cells and distant work", async () => {
  const { world, follow } = await makeWorld({ admissionBudgetMs: 2, priced: true });
  const at = { ...follow.position };
  try {
    expect(world.readinessAt(at, 0).ready).toBe(false);
    world.update();
    expect(world.stats().residentCells).toBeGreaterThan(0);
    expect(world.stats().loadedCells).toBe(0);
    await flush();
    for (let i = 0; i < 4000 && !world.readinessAt(at, 0).ready; i++) world.update();
    const local = world.readinessAt(at, 0);
    expect(
      local,
      JSON.stringify({ local, stats: world.stats(), terrain: terrainOf(world).debug() }),
    ).toMatchObject({ ready: true });
    expect(local.loadedCells).toBe(local.requiredCells);
    expect(local.loadedTerrainTiles).toBe(local.requiredTerrainTiles);
    expect(terrainOf(world).residentTileCount).toBeLessThan(terrainOf(world).residentTileBudget);
    world.dispose();
    expect(world.readinessAt(at, 0).cancelled).toBe(true);
    expect(world.readinessAt(at, 0).ready).toBe(false);
  } finally {
    world.dispose();
  }
});

it("keeps a failed spawn pending and reports its model failure by region", async () => {
  stubFixtureFetch();
  const at = cellCenter(1, 1);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const world = await WorldCells.load({
    url: "/world/world.json",
    surface,
    follow: followAt(at.x, at.z),
    terrain: false,
    ring: 0,
    budgets,
    loadModel: async () => {
      throw new Error("missing spawn model");
    },
  });
  try {
    world.update();
    await flush();
    world.update();
    expect(world.readinessAt(at).failures).toBeGreaterThan(0);
    expect(world.readinessAt(at).ready).toBe(false);
    expect(world.stats().loadedCells).toBe(0);
    expect(world.stats().admissionCompletedUnits).toBe(0);
    expect(() => world.readinessAt({ x: Number.NaN, z: 0 })).toThrow("finite");
  } finally {
    world.dispose();
    warning.mockRestore();
  }
});
/** What one unit of admission work costs on the injected clock: `admit` reads it twice per unit. */
const UNIT_MS = 1;

interface IResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
}

function fileResponse(buffer: Buffer): IResponseLike {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    json: async () => JSON.parse(buffer.toString("utf8")),
  };
}

function stubFixtureFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return fileResponse(readFileSync(path.join(fixture, "world.json")));
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        ok: false,
        status: 404,
        headers: new Headers(),
        arrayBuffer: async () => new ArrayBuffer(0),
        json: async () => ({}),
      };
    }),
  );
}

function model(): Object3D {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function cellKey(x: number, z: number): string {
  return `${String(x)}:${String(z)}`;
}

function cellCenter(x: number, z: number): { x: number; z: number } {
  return { x: MIN_X + (x + 0.5) * CELL_SIZE, z: MIN_Z + (z + 0.5) * CELL_SIZE };
}

function followAt(x: number, z: number): { position: { x: number; z: number } } {
  return { position: { x, z } };
}

/** The `TerrainTiles` a `WorldCells` composed, so its residency is observable from the outside. */
function terrainOf(world: WorldCells): TerrainTiles {
  const terrain = world.children.find((child) => child instanceof TerrainTiles);
  if (terrain === undefined) throw new Error("WorldCells composed no TerrainTiles.");
  return terrain;
}

/**
 * The shared mesh an asset's level draws through; every resident cell has a segment in it. One per
 * key for the main pass (PRD-458); the shadow-caster clusters beside it are one per world-grid
 * square and are not this lookup's business.
 */
function batchOf(world: WorldCells, _cell: string, asset: string, level: number): InstancedMesh {
  const key = `${asset}:${String(level)}:0`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === key) meshes.push(object);
  });
  const mesh = meshes[0];
  if (mesh === undefined) throw new Error(`No batch mesh named '${key}'.`);
  return mesh;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let the loads land, then step once.
 *
 * Adopting a loaded model queues the resident cells' batches rather than building them inside the
 * promise, and `stats()` is read at the end of an `update`, so a test that has just awaited the
 * loads needs a step before the queue it left behind is visible in the report.
 */
async function step(cells: WorldCells): Promise<void> {
  await flush();
  cells.update();
}

interface IWorldUnderTest {
  readonly world: WorldCells;
  readonly follow: { position: { x: number; z: number } };
}

/**
 * A world over the committed package, at `ring` cells around cell (1, 1).
 *
 * `admissionNow` advances the clock by `UNIT_MS` per reading, which prices one unit of admission
 * work at exactly `UNIT_MS` — the deliberately slow unit the ceiling is measured against.
 */
async function makeWorld(options: {
  readonly admissionBudgetMs?: number;
  readonly coveredAdmissionBudgetMs?: number;
  readonly freshMeshesPerUpdate?: number;
  readonly priced?: boolean;
  readonly ring?: number;
}): Promise<IWorldUnderTest> {
  stubFixtureFetch();
  const follow = followAt(cellCenter(1, 1).x, cellCenter(1, 1).z);
  let elapsed = 0;
  const world = await WorldCells.load({
    ...(options.admissionBudgetMs === undefined
      ? {}
      : { admissionBudgetMs: options.admissionBudgetMs }),
    ...(options.coveredAdmissionBudgetMs === undefined
      ? {}
      : { coveredAdmissionBudgetMs: options.coveredAdmissionBudgetMs }),
    // The fresh-mesh allowance is its own ceiling; these tests measure the time budget, so an
    // unbounded world is unbounded in both.
    ...(options.admissionBudgetMs === Number.POSITIVE_INFINITY
      ? { freshMeshesPerUpdate: Number.MAX_SAFE_INTEGER }
      : {}),
    ...(options.freshMeshesPerUpdate === undefined
      ? {}
      : { freshMeshesPerUpdate: options.freshMeshesPerUpdate }),
    budgets,
    follow,
    loadModel: async () => model(),
    ring: options.ring ?? 1,
    surface,
    url: "/world/world.json",
    ...(options.priced === true
      ? {
          admissionNow: () => {
            elapsed += UNIT_MS;
            return elapsed;
          },
        }
      : {}),
  });
  return { follow, world };
}

/** Update until nothing is queued, returning every frame's admission spend. */
function drain(world: WorldCells, limit = 10_000, covered = false): number[] {
  const spent: number[] = [];
  for (let frame = 0; frame < limit; frame += 1) {
    if (covered) world.process(undefined, undefined, true);
    else world.update();
    const { backlog, deferred, spentMs } = world.stats().admission;
    spent.push(spentMs);
    // Deferred terrain work counts as owed: a tile the budget refused is wanted again next pass,
    // and one pass is forced past the budget, so the ring closes a frame after the queue empties.
    if (backlog === 0 && deferred === 0) return spent;
  }
  throw new Error(`WorldCells still owed ${String(world.stats().admission.backlog)} units.`);
}

/** Instances a shared mesh draws: free segment slots are zero matrices and draw nothing. */
function live(mesh: InstancedMesh): number {
  const array = mesh.instanceMatrix.array as Float32Array;
  let count = 0;
  for (let index = 0; index < mesh.count; index += 1) if (array[index * 16 + 15] !== 0) count += 1;
  return count;
}

/**
 * Every batch mesh the world drew, keyed by `asset:level:part` with the drawn-instance total across
 * the world-grid clusters that key is split into (PRD-458).
 */
function drawn(world: WorldCells): Map<string, number> {
  const meshes = new Map<string, number>();
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh) {
      const key = object.name.split("@")[0] ?? object.name;
      meshes.set(key, (meshes.get(key) ?? 0) + live(object));
    }
  });
  return meshes;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells admission budget", () => {
  it("builds the nearest cell first even when its model loads last", async () => {
    // Each model's load queues every resident cell at once, so append order put the spawn cell of
    // the last-loaded model behind the whole ring: the forest waited ~25 s for its own feet.
    stubFixtureFetch();
    const at = cellCenter(1, 1);
    let elapsed = 0;
    let releasePine!: () => void;
    const pineHeld = new Promise<void>((resolve) => {
      releasePine = resolve;
    });
    const world = await WorldCells.load({
      admissionBudgetMs: 2,
      admissionNow: () => {
        elapsed += UNIT_MS;
        return elapsed;
      },
      budgets,
      follow: followAt(at.x, at.z),
      loadModel: async (url) => {
        if (url.includes("pine")) await pineHeld;
        return model();
      },
      ring: 1,
      surface,
      terrain: false,
      url: "/world/world.json",
    });
    try {
      world.update();
      await flush();
      world.update();
      releasePine();
      await flush();
      let readyAt = -1;
      let frames = 0;
      for (; frames < 10_000; frames += 1) {
        world.update();
        if (readyAt < 0 && world.readinessAt(at, 0).ready) readyAt = frames;
        const { backlog, deferred } = world.stats().admission;
        if (backlog === 0 && deferred === 0) break;
      }
      expect(readyAt).toBeGreaterThanOrEqual(0);
      // Nine resident cells share the backlog; the spawn cell's own work is a small part of it.
      expect(readyAt, JSON.stringify({ readyAt, frames })).toBeLessThan(frames / 3);
    } finally {
      world.dispose();
    }
  });

  it("counts completed admission units but not queued or idle work", async () => {
    const { world } = await makeWorld({ admissionBudgetMs: 1, priced: true });
    try {
      const stats = () => world.stats();
      expect(stats().admissionCompletedUnits).toBe(0);

      world.update();
      await flush();
      expect(world.stats().admissionBacklog).toBeGreaterThan(0);
      expect(stats().admissionCompletedUnits).toBe(0);

      world.update();
      expect(stats().admissionCompletedUnits).toBeGreaterThan(0);

      drain(world);
      const afterWork = stats().admissionCompletedUnits;
      world.update();
      expect(stats().admissionCompletedUnits).toBe(afterWork);
    } finally {
      world.dispose();
    }
  });

  it("flushes each covered publication to shadows while uncovered notifications remain throttled", async () => {
    const notifications = async (covered: boolean): Promise<number[]> => {
      stubFixtureFetch();
      let clock = 0;
      const tells: number[] = [];
      const at = cellCenter(1, 1);
      const world = await WorldCells.load({
        url: "/world/world.json",
        surface,
        follow: followAt(at.x, at.z),
        terrain: false,
        ring: 1,
        budgets,
        gpuScene: false,
        admissionBudgetMs: 1,
        coveredAdmissionBudgetMs: 1,
        admissionNow: () => ++clock,
        shadows: {
          cast: true,
          invalidate: (region) => {
            // Prewarm also requests blanket invalidations; measure publication notifications only.
            if (region?.admission) tells.push(clock);
          },
        },
        loadModel: async () => model(),
      });
      world.process(undefined, undefined, covered);
      await flush();
      drain(world, 4000, covered);
      world.dispose();
      return tells;
    };
    const uncovered = await notifications(false);
    const covered = await notifications(true);
    const gaps = (times: number[]) =>
      [...new Set(times)]
        .slice(1)
        .map((time, index) => time - ([...new Set(times)][index] as number));
    expect(gaps(uncovered).every((gap) => gap >= 1000)).toBe(true);
    expect(gaps(covered).some((gap) => gap < 1000)).toBe(true);
  });

  it("reuses exact view membership while readiness, projection and mutable reach stay live", async () => {
    stubFixtureFetch();
    const at = cellCenter(1, 1);
    const camera = new PerspectiveCamera(60, 1, 0.1, 500);
    camera.position.set(at.x, 20, at.z + 200);
    camera.lookAt(at.x, 0, at.z);
    const reach = new Float32Array(
      readFileSync(path.join(fixture, "placements.bin")).byteLength / 32,
    ).fill(Number.POSITIVE_INFINITY);
    const world = await WorldCells.load({
      url: "/world/world.json",
      surface,
      follow: camera,
      terrain: false,
      ring: 4,
      budgets,
      gpuScene: false,
      placementReach: reach,
      admissionBudgetMs: 1,
      loadModel: async () => model(),
    });
    const bounds = vi.spyOn(Box3.prototype, "applyMatrix4");
    try {
      const initial = world.readinessAt(camera);
      expect(initial.requiredCells).toBeGreaterThan(2);
      expect(initial.ready).toBe(false);
      const scans = bounds.mock.calls.length;
      expect(scans).toBeGreaterThan(0);
      expect(world.readinessAt(camera)).toEqual(initial);
      expect(bounds.mock.calls.length).toBe(scans);
      world.update();
      await flush();
      world.update();
      expect(world.readinessAt(camera).ready).toBe(false);
      for (let i = 0; i < 4000 && !world.readinessAt(camera).ready; i++) {
        world.update();
        await flush();
      }
      expect(world.readinessAt(camera)).toMatchObject({
        ready: true,
        requiredCells: initial.requiredCells,
      });
      reach.fill(1);
      expect(world.readinessAt(camera).requiredCells).toBe(2);
      reach.fill(Number.POSITIVE_INFINITY);
      expect(world.readinessAt(camera).requiredCells).toBe(initial.requiredCells);
      camera.far = 1;
      camera.updateProjectionMatrix();
      expect(world.readinessAt(camera).requiredCells).toBe(0);
      camera.far = 500;
      camera.updateProjectionMatrix();
      expect(world.readinessAt(camera).requiredCells).toBe(initial.requiredCells);
      const beforeCoordinateChange = bounds.mock.calls.length;
      camera.coordinateSystem = WebGPUCoordinateSystem;
      world.readinessAt(camera);
      expect(bounds.mock.calls.length).toBeGreaterThan(beforeCoordinateChange);
      camera.lookAt(at.x, 20, at.z + 400);
      expect(world.readinessAt(camera).requiredCells).toBe(0);
      camera.position.x += 1;
      const changed = bounds.mock.calls.length;
      world.readinessAt(camera);
      expect(bounds.mock.calls.length).toBeGreaterThan(changed);
      world.dispose();
      expect(world.readinessAt(camera)).toMatchObject({ ready: false, cancelled: true });
    } finally {
      bounds.mockRestore();
      world.dispose();
    }
  });

  it("requires visible distant placements within their draw reach, while preserving circle queries", async () => {
    stubFixtureFetch();
    const at = cellCenter(1, 1);
    const camera = new PerspectiveCamera(60, 1, 0.1, 500);
    camera.position.set(at.x, 20, at.z + 200);
    camera.lookAt(at.x, 0, at.z);
    camera.updateMatrixWorld();
    const world = await WorldCells.load({
      url: "/world/world.json",
      surface,
      follow: camera,
      terrain: false,
      ring: 4,
      budgets,
      gpuScene: false,
      loadModel: async () => model(),
    });
    const visible = world.readinessAt(camera);
    expect(visible.requiredCells).toBeGreaterThan(1);
    expect(visible.ready).toBe(false);
    expect(world.readinessAt(at, 0).requiredCells).toBe(1);
    camera.lookAt(at.x, 20, at.z + 400);
    camera.updateMatrixWorld();
    expect(world.readinessAt(camera).requiredCells).toBe(0);
    world.dispose();

    const reached = await WorldCells.load({
      url: "/world/world.json",
      surface,
      follow: camera,
      terrain: false,
      ring: 4,
      budgets,
      gpuScene: false,
      loadModel: async () => model(),
      placementReach: new Float32Array(
        readFileSync(path.join(fixture, "placements.bin")).byteLength / 32,
      ).fill(1),
    });
    camera.lookAt(at.x, 0, at.z);
    camera.updateMatrixWorld();
    // Two fixture cells also contain chunks: placement reach must not hide those draws.
    expect(reached.readinessAt(camera).requiredCells).toBe(2);
    expect(reached.readinessAt(camera).requiredCells).toBeLessThan(visible.requiredCells);
    reached.dispose();
  });

  it("observes drawable runs before cell readiness, but excludes outside-view publications", async () => {
    stubFixtureFetch();
    const at = cellCenter(1, 1);
    const camera = new PerspectiveCamera(45, 1, 0.1, 300);
    camera.position.set(at.x, 15, at.z + 40);
    camera.lookAt(at.x, 0, at.z);
    camera.updateMatrixWorld();
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    let published = 0;
    let inView = 0;
    let partial = false;
    let world: WorldCells;
    let elapsed = 0;
    world = await WorldCells.load({
      url: "/world/world.json",
      surface,
      follow: followAt(at.x, at.z),
      terrain: false,
      ring: 1,
      budgets,
      gpuScene: false,
      admissionBudgetMs: 1,
      admissionNow: () => ++elapsed,
      shadows: { cast: false },
      loadModel: async () => model(),
      onPublication: (bounds) => {
        // An allocated/staged mesh is insufficient: its instance records must be live.
        expect([...drawn(world).values()].some((count) => count > 0)).toBe(true);
        published++;
        if (frustum.intersectsBox(bounds)) inView++;
      },
    });
    world.update();
    await flush();
    // Placement slices and staged parts cannot yet draw or notify.
    world.update();
    expect(published).toBe(0);
    for (let frame = 0; frame < 4000; frame++) {
      world.update();
      if (inView > 0 && !world.readinessAt(at, 0).ready) partial = true;
      if (world.stats().admission.deferred === 0) break;
    }
    expect(partial).toBe(true);
    expect(inView).toBeGreaterThan(0);
    expect(published).toBeGreaterThan(inView);
    world.dispose();
  });

  it("spends at most the budget plus one unit per update, however long the backlog", async () => {
    const BUDGET_MS = 2;
    const { world: cells } = await makeWorld({ admissionBudgetMs: BUDGET_MS, priced: true });
    cells.update();
    await step(cells);

    // A unit is priced at 1 ms and a frame may start any unit while the budget is not yet spent, so
    // the worst a frame can do is two whole units plus the third: budget + one unit, exactly.
    const spent = drain(cells);
    expect(spent.length).toBeGreaterThan(2);
    for (const frame of spent) expect(frame).toBeLessThanOrEqual(BUDGET_MS + UNIT_MS);
    // Nothing is owed, and the frame that finished the ring spent what was left of the budget
    // rather than a whole one: the forced tile is one unit, and the rest of the pass had none.
    expect(cells.stats().admission).toMatchObject({ backlog: 0, deferred: 0 });
    expect(cells.stats().admission.spentMs).toBeLessThanOrEqual(BUDGET_MS);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("admits up to one 60 Hz frame per update behind the startup cover, and 2 ms after it", async () => {
    const { world: open } = await makeWorld({ priced: true });
    open.update();
    await step(open);
    const openSpent = drain(open);
    for (const frame of openSpent) expect(frame).toBeLessThanOrEqual(2 + UNIT_MS);

    const { world: covered } = await makeWorld({ priced: true });
    covered.update();
    await step(covered);
    const coveredSpent = drain(covered, 10_000, true);
    for (const frame of coveredSpent) expect(frame).toBeLessThanOrEqual(16 + UNIT_MS);
    expect(Math.max(...coveredSpent)).toBeGreaterThan(2 + UNIT_MS);
    expect(coveredSpent.length).toBeLessThan(openSpent.length);
    expect(covered.stats().failures).toBe(0);
    open.dispose();
    covered.dispose();
  });

  it("scales a game's own budget behind the startup cover", async () => {
    const { world: cells } = await makeWorld({ admissionBudgetMs: 1, priced: true });
    cells.update();
    await step(cells);
    const spent = drain(cells, 4000, true);
    for (const frame of spent) expect(frame).toBeLessThanOrEqual(8 + UNIT_MS);
    expect(Math.max(...spent)).toBeGreaterThan(1 + UNIT_MS);
    cells.dispose();
  });

  it("admits more fresh batches per update behind the startup cover", async () => {
    // The time budget is unpriced and large, so the fresh-mesh allowance alone gates each update.
    const frames = async (covered: boolean): Promise<number> => {
      const { world } = await makeWorld({ admissionBudgetMs: 1000, freshMeshesPerUpdate: 1 });
      world.update();
      await flush();
      const count = drain(world, 4000, covered).length;
      world.dispose();
      return count;
    };
    const open = await frames(false);
    const covered = await frames(true);
    expect(covered).toBeLessThan(open);
  });

  it("keeps a named covered budget behind the startup cover", async () => {
    const { world: cells } = await makeWorld({
      admissionBudgetMs: 2,
      coveredAdmissionBudgetMs: 2,
      priced: true,
    });
    cells.update();
    await step(cells);
    for (const frame of drain(cells, 10_000, true)) expect(frame).toBeLessThanOrEqual(2 + UNIT_MS);
    cells.dispose();
  });

  it("keeps building props while the terrain catches up after a jump", async () => {
    // Terrain admits first and every tile is a unit; with the whole allowance its own, a jump left
    // the prop queue nothing for as long as the ground took to follow — on the 2 km map, seconds of
    // a review camera looking at an empty forest.
    const { follow, world: cells } = await makeWorld({ admissionBudgetMs: 2, priced: true });
    cells.update();
    await step(cells);
    drain(cells);
    const far = cellCenter(3, 3);
    follow.position.x = far.x;
    follow.position.z = far.z;
    let shared = 0;
    let previous = cells.stats().admission.backlog;
    for (let frame = 0; frame < 400; frame += 1) {
      cells.update();
      await flush(1);
      const { backlog, deferred } = cells.stats().admission;
      // A frame where terrain still owed tiles and the prop queue still finished work of its own.
      if (terrainOf(cells).deferredAdmissions > 0 && backlog < previous) shared += 1;
      previous = backlog;
      if (backlog === 0 && deferred === 0 && terrainOf(cells).deferredAdmissions === 0) break;
    }
    expect(shared).toBeGreaterThan(0);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("admits the cells around a jumped camera when the ring it left filled the cell budget", async () => {
    // Residency keeps one ring of hysteresis, so after a jump those cells sat in a full budget and
    // the cells the camera now needed were refused (pressure) until it moved again.
    async function jump(to: readonly [number, number]): Promise<number> {
      stubFixtureFetch();
      const follow = followAt(cellCenter(0, 0).x, cellCenter(0, 0).z);
      const cells = await WorldCells.load({
        admissionBudgetMs: Number.POSITIVE_INFINITY,
        budgets: { ...budgets, residentCells: 4 },
        follow,
        loadModel: async () => model(),
        prefetchSeconds: 0,
        ring: 1,
        surface,
        url: "/world/world.json",
      });
      cells.update();
      await step(cells);
      expect(cells.stats().residentCells).toBe(4);
      const before = cells.stats().pressure.cells;
      const originalKeys = cells.stats().residentKeys;
      const at = cellCenter(to[0], to[1]);
      follow.position.x = at.x;
      follow.position.z = at.z;
      await step(cells);
      expect(cells.stats().residentCells).toBe(4);
      expect(cells.stats().failures).toBe(0);
      if (to[0] === 1) expect(cells.stats().residentKeys).toEqual(originalKeys);
      const refused = cells.stats().pressure.cells - before;
      cells.dispose();
      return refused;
    }
    // A two-cell jump to (2, 2) wants nine cells over a budget of four: the four the corner held are
    // all within the hysteresis ring, so without the yield all eight new ones are refused; with it
    // three of the four the corner held give way and only five are.
    expect(await jump([2, 2])).toBe(5);
    // All four original cells are still wanted after this one-cell step: pressure must not
    // evict a wanted resident merely to replace it with a different wanted cell.
    expect(await jump([1, 1])).toBe(5);
  });

  it.each([
    ...[Number.POSITIVE_INFINITY, 2].map((budgetMs) => ({
      name: `same-cell alternating speculative lead with admission budget ${budgetMs}`,
      sameCellAlternation: true,
      expectedLost: false,
      expectedLead: false,
      expectedRows: [],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs,
      startX: 537,
      endX: 600,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    })),
    {
      name: "same-cell speculative lead uses available slack",
      sameCellAlternation: true,
      expectedLost: false,
      expectedLead: true,
      expectedRows: [],
      capacity: 30,
      prefetchSeconds: 1.5,
      slack: true,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 537,
      endX: 600,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    },
    {
      name: "baseline hysteresis preserves retired visible lead cells",
      sameCellAlternation: false,
      expectedLost: false,
      expectedLead: false,
      expectedRows: [],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 403.7396859094827,
      endX: 394.7772706584761,
      endZ: -375.603969352881,
      lost: "11:4",
      ledEdge: "11:2",
    },
    {
      name: "full-capacity ordinary shift preserves hysteresis",
      sameCellAlternation: false,
      expectedLost: false,
      expectedLead: false,
      expectedRows: [
        [1, 10, 14],
        [2, 10, 14],
        [3, 10, 14],
        [4, 10, 14],
        [5, 10, 14],
      ],
      capacity: 25,
      prefetchSeconds: 0,
      slack: false,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 537,
      endX: 650,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    },
    {
      name: "finite ordinary shift and delayed models",
      sameCellAlternation: false,
      expectedLost: false,
      expectedLead: false,
      expectedRows: [
        [1, 10, 14],
        [2, 10, 14],
        [3, 10, 14],
        [4, 10, 14],
        [5, 10, 14],
      ],
      capacity: 25,
      prefetchSeconds: 0,
      slack: false,
      budgetMs: 2,
      startX: 537,
      endX: 650,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    },
    {
      name: "one-cell speculative lead preserves the full retained ring",
      sameCellAlternation: false,
      expectedLost: false,
      expectedLead: false,
      expectedRows: [
        [1, 10, 14],
        [2, 10, 14],
        [3, 10, 14],
        [4, 10, 14],
        [5, 10, 14],
      ],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 537,
      endX: 600,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    },
    {
      name: "ordinary shift retains hysteresis when there is room",
      sameCellAlternation: false,
      expectedLost: false,
      expectedLead: true,
      expectedRows: [
        [1, 10, 15],
        [2, 10, 15],
        [3, 10, 15],
        [4, 10, 15],
        [5, 10, 15],
      ],
      capacity: 30,
      prefetchSeconds: 0,
      slack: true,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 537,
      endX: 650,
      endZ: -555.5,
      lost: "10:3",
      ledEdge: "15:3",
    },
    {
      name: "one-cell move",
      sameCellAlternation: false,
      expectedLost: true,
      expectedLead: true,
      expectedRows: [
        [2, 12, 14],
        [3, 12, 16],
        [4, 12, 16],
        [5, 12, 17],
        [6, 13, 16],
        [7, 14, 15],
      ],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 537,
      endX: 739.1,
      endZ: -426.6,
      lost: "11:2",
      ledEdge: "15:7",
    },
    {
      name: "finite admission and delayed model",
      sameCellAlternation: false,
      expectedLost: true,
      expectedLead: true,
      expectedRows: [
        [2, 12, 14],
        [3, 12, 16],
        [4, 12, 16],
        [5, 12, 16],
        [6, 12, 16],
        [7, 14, 15],
      ],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs: 2,
      startX: 537,
      endX: 739.1,
      endZ: -426.6,
      lost: "11:2",
      ledEdge: "15:7",
    },
    {
      name: "two-cell jump below velocity reset distance",
      sameCellAlternation: false,
      expectedLost: true,
      expectedLead: true,
      expectedRows: [
        [1, 13, 17],
        [2, 13, 17],
        [3, 13, 17],
        [4, 13, 17],
        [5, 13, 17],
      ],
      capacity: 25,
      prefetchSeconds: 1.5,
      slack: false,
      budgetMs: Number.POSITIVE_INFINITY,
      startX: 639.9,
      endX: 850,
      endZ: -555.5,
      lost: "12:2",
      ledEdge: "17:3",
    },
  ])(
    "preserves bounded baseline residency after movement: $name",
    async ({
      name,
      capacity,
      prefetchSeconds,
      slack,
      budgetMs,
      startX,
      endX,
      endZ,
      lost,
      ledEdge,
      sameCellAlternation,
      expectedLost,
      expectedLead,
      expectedRows,
    }) => {
      const placements = new Float32Array(18 * 18 * 8);
      const cells = Array.from({ length: 18 * 18 }, (_, index) => {
        const x = index % 18;
        const z = Math.floor(index / 18);
        placements.set(
          [-1024 + (x + 0.5) * 128, 0, -1024 + (z + 0.5) * 128, 0, 0, 0, 1, 1],
          index * 8,
        );
        return { x, z, runs: [{ asset: "pine", offset: index, count: 1 }] };
      });
      let clock = 0;
      const finite = Number.isFinite(budgetMs);
      const now = vi.fn(() => {
        clock += finite ? 0.5 : 0;
        return clock;
      });
      let releaseModel: (() => void) | undefined;
      const modelReady = new Promise<void>((resolve) => {
        releaseModel = resolve;
      });
      const replay = name === "baseline hysteresis preserves retired visible lead cells";
      const follow = followAt(startX, replay ? -170.799977417021 : -555.5);
      const pine = manifest.assets.pine;
      if (pine === undefined) throw new Error("Missing pine fixture asset");
      const world = await WorldCells.load({
        url: "/world/world.json",
        data: {
          manifest: {
            ...manifest,
            assets: { pine: { glb: "assets/pine.glb", bounds: pine.bounds } },
            cellSize: 128,
            extent: { minX: -1024, minZ: -1024, sizeX: 2304, sizeZ: 2304 },
            terrain: { ...manifest.terrain, spacing: 18 },
            cells,
          },
          placements: placements.buffer,
        },
        admissionNow: now,
        admissionBudgetMs: budgetMs,
        budgets: { ...budgets, residentCells: capacity },
        prefetchSeconds,
        follow,
        concurrency: 1,
        loadModel: async () => {
          if (finite) await modelReady;
          return model();
        },
        ring: 2,
        surface,
        terrain: false,
      });
      try {
        world.update();
        await step(world);
        expect(world.stats().residentCells).toBe(25);
        expect(world.stats().residentKeys).toContain(lost);
        if (replay) {
          const trace = [];
          // Saved follow coordinates around diagnostic updates 69/233. A fast movement leads two
          // cells; a 0.6 m drift after waiting retires the lead without an actual-cell jump and
          // keeps the residency pass active independently of terrain work.
          for (const [time, x, z] of [
            [250, 400.44618046764936, -246.0612817706866],
            [1000, 399.84618046764933, -246.0612817706866],
            [1250, 399.0180232406597, -278.69671463201064],
            [2000, 398.4180232406597, -278.69671463201064],
            [2250, 394.7772706584761, -375.603969352881],
            [3000, 394.1772706584761, -375.603969352881],
          ]) {
            if (time === undefined || x === undefined || z === undefined)
              throw new Error("Missing replay coordinate");
            clock = time;
            follow.position.x = x;
            follow.position.z = z;
            await step(world);
            const stats = world.stats();
            expect(stats.residentCells).toBeLessThanOrEqual(25);
            expect(stats.failures).toBe(0);
            trace.push([
              time,
              ...["11:3", "11:2", "10:1"].map((key) => stats.residentKeys.includes(key)),
            ]);
          }
          expect(trace).toEqual([
            [250, true, true, false],
            [1000, true, false, false],
            [1250, true, true, false],
            [2000, true, true, false],
            [2250, true, true, true],
            [3000, true, true, false],
          ]);
          return;
        }
        if (sameCellAlternation) {
          if (releaseModel === undefined) throw new Error("Missing delayed model release");
          releaseModel();
          for (let frame = 0; frame < 80 && world.stats().loadedCells < 25; frame += 1) {
            clock += 600;
            await step(world);
          }
          expect(world.stats().loadedCells).toBe(25);
          const originalKeys = world.stats().residentKeys;
          const trace = [];
          for (const positionX of slack ? [600] : [600, 537, 600, 537]) {
            clock += 1660;
            follow.position.x = positionX;
            await step(world);
            const stats = world.stats();
            trace.push({
              actualCell: Math.floor((positionX + 1024) / 128),
              evictions: stats.evictions,
              missingActualKeys: originalKeys.filter((key) => !stats.residentKeys.includes(key)),
              residentCells: stats.residentCells,
              predictedKeys: stats.residentKeys.filter((key) => !originalKeys.includes(key)),
            });
          }
          expect(trace).toEqual(
            Array.from({ length: slack ? 1 : 4 }, () => ({
              actualCell: 12,
              evictions: 0,
              missingActualKeys: [],
              residentCells: capacity,
              predictedKeys: slack ? ["15:1", "15:2", "15:3", "15:4", "15:5"] : [],
            })),
          );
          return;
        }
        // An ordinary move retains the old ring while it fits the outer hysteresis boundary.
        // A farther lead may evict that boundary and admit forward cells without a recovery pass.
        clock = 1660;
        follow.position.x = endX;
        follow.position.z = endZ;
        world.update();
        expect(world.stats().residentKeys.includes(lost)).toBe(!expectedLost);
        expect(world.stats().residentKeys.includes(ledEdge)).toBe(expectedLead);
        // Let the lead retire, then stop completely. No further camera movement can rescue a cell.
        for (let frame = 0; frame < 8; frame += 1) {
          clock += 600;
          await step(world);
          expect(world.stats().residentCells).toBeLessThanOrEqual(capacity);
        }
        // Fixed row ranges from the immutable a602 residency-contract replay. The finite case
        // has its own expected rows because its injected clock also advances during admission.
        const wanted = new Set(
          expectedRows.flatMap(([z, minX, maxX]) => {
            if (z === undefined || minX === undefined || maxX === undefined)
              throw new Error("Missing expected baseline row");
            return Array.from({ length: maxX - minX + 1 }, (_, i) => `${minX + i}:${z}`);
          }),
        );
        expect(new Set(world.stats().residentKeys)).toEqual(wanted);
        expect(world.stats().residentCells).toBe(wanted.size);
        if (finite) {
          expect(world.stats().loadedCells).toBe(0);
          if (releaseModel === undefined) throw new Error("Missing delayed model release");
          releaseModel();
          await flush();
          world.update();
          expect(world.stats().admission.backlog).toBeGreaterThan(0);
          for (let frame = 0; frame < 80 && world.stats().loadedCells < 25; frame += 1) {
            clock += 600;
            await step(world);
            expect(world.stats().residentCells).toBeLessThanOrEqual(capacity);
          }
        }
        expect(world.stats().loadedCells).toBe(wanted.size);
        expect(new Set(world.stats().residentKeys)).toEqual(wanted);
        expect(world.stats().failures).toBe(0);
        now.mockClear();
        world.update();
        // Only the adaptive-LOD and census clocks remain; no lookahead/admission work spins forever.
        expect(now).toHaveBeenCalledTimes(2);
      } finally {
        world.dispose();
      }
    },
  );

  it("reports the deferred work and the backlog while it waits, and empties both", async () => {
    const { world: cells } = await makeWorld({ admissionBudgetMs: 2, priced: true });
    cells.update();
    await step(cells);

    // The adopted models queued every resident cell's batches, and one frame of two units cannot
    // hold them, so the report is not zero while the work is outstanding.
    expect(cells.stats().admission.deferred).toBeGreaterThan(0);
    expect(cells.stats().admission.backlog).toBeGreaterThan(0);

    drain(cells);
    expect(cells.stats().admission.deferred).toBe(0);
    expect(cells.stats().admission.backlog).toBe(0);
    cells.dispose();
  });

  it("draws what an unbounded build draws, once the backlog has drained", async () => {
    const bounded = await makeWorld({ admissionBudgetMs: 2, priced: true });
    bounded.world.update();
    await flush();
    drain(bounded.world);

    const unbounded = await makeWorld({ admissionBudgetMs: Number.POSITIVE_INFINITY });
    unbounded.world.update();
    await flush();
    // One mesh per world-grid cluster per key (PRD-458), and two fresh meshes an update, so an
    // unbounded ring still needs as many updates as it has clusters to mint. What this compares is
    // the answer, not how many frames it took.
    for (let frame = 0; frame < 200; frame += 1) {
      unbounded.world.update();
      await flush(1);
      if (unbounded.world.stats().admission.deferred === 0) break;
    }

    // Nothing dropped, nothing doubled: the same meshes, with the same instances, however many
    // frames it took to admit them.
    expect(drawn(bounded.world)).toEqual(drawn(unbounded.world));
    expect(drawn(bounded.world).size).toBeGreaterThan(0);
    expect(bounded.world.stats().residentCells).toBe(unbounded.world.stats().residentCells);
    bounded.world.dispose();
    unbounded.world.dispose();
  });

  it("admits terrain tiles and colliders on the same budget, and still converges", async () => {
    // A priced chunk costs more than the allowance: even the nearest tile must span updates.
    const { world: cells } = await makeWorld({ admissionBudgetMs: 0.05, priced: true });
    const terrain = terrainOf(cells);
    cells.update();
    expect(terrain.residentTileCount).toBe(0);
    expect(terrain.deferredAdmissions).toBe(1);
    expect(terrain.debug().pendingConstruction).toBeDefined();
    for (let frame = 0; frame < 10_000 && terrain.residentTileCount < 9; frame += 1) {
      cells.update();
      expect(cells.stats().admission.spentMs).toBeLessThanOrEqual(UNIT_MS);
      if (terrain.deferredAdmissions > 0)
        expect(cells.stats().admission.backlog).toBeGreaterThan(0);
    }
    expect(terrain.residentTileCount).toBe(9);
    drain(cells);
    expect(cells.stats().admission.backlog).toBe(0);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("keeps a refiltered cell drawing what it had until the replacement is ready", async () => {
    // One unit per frame: the follow point crosses `pine`'s level switch, the refilter is queued, and
    // the cell keeps drawing the lod the placements were built at until every mesh of the
    // replacement exists.
    const { follow, world: cells } = await makeWorld({
      admissionBudgetMs: 1,
      priced: true,
      ring: 0,
    });
    // From the cell's own corner the far half of its placements are past `pine`'s 60 m switch, so
    // the cell has a lod batch to keep drawing.
    follow.position.x = -CELL_SIZE;
    follow.position.z = -CELL_SIZE;
    cells.update();
    await step(cells);
    drain(cells);
    const far = batchOf(cells, cellKey(1, 1), "pine", 1);
    const farDrawn = live(far);
    expect(farDrawn).toBeGreaterThan(0);
    expect(far.parent).toBe(cells);

    // The cell centre is 45 m from where the batch was built — past the eighth of the 60 m switch a
    // refilter waits for — so every placement in it changes level.
    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    cells.update();
    // The move queued refilters; it did not perform them.
    expect(cells.stats().rebuilds).toBeGreaterThan(0);
    expect(cells.stats().admission.deferred).toBeGreaterThan(0);

    // Mid-refilter the outgoing lod is still the one attached, and it is the only one: the
    // replacement is never half-swapped in beside it.
    expect(batchOf(cells, cellKey(1, 1), "pine", 1)).toBe(far);
    expect(drawn(cells).get("pine:1:0")).toBe(farDrawn);

    drain(cells);
    expect(drawn(cells).get("pine:1:0") ?? 0).toBe(0);
    const near = batchOf(cells, cellKey(1, 1), "pine", 0);
    expect(live(near)).toBe(85);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("drops the queued work of a cell that left, instead of resuming it into a dead graph", async () => {
    const { follow, world: cells } = await makeWorld({
      admissionBudgetMs: 1,
      priced: true,
      ring: 0,
    });
    cells.update();
    await step(cells);
    expect(cells.stats().admission.deferred).toBeGreaterThan(0);

    // Far outside the hysteresis ring: the cell is evicted with its backlog, and the budget is not
    // spent on batches nothing will draw.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    cells.update();
    expect(cells.stats().residentKeys).toEqual([]);
    expect(cells.stats().admission.deferred).toBe(0);
    drain(cells);
    expect(cells.stats().admission.backlog).toBe(0);
    expect(drawn(cells).size).toBe(0);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("refuses a budget that would never admit anything", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    await expect(
      WorldCells.load({
        admissionBudgetMs: 0,
        budgets,
        follow,
        loadModel: async () => model(),
        ring: 1,
        surface,
        url: "/world/world.json",
      }),
    ).rejects.toThrow(/admissionBudgetMs/u);
    await expect(
      WorldCells.load({
        admissionBudgetMs: Number.NaN,
        budgets,
        follow,
        loadModel: async () => model(),
        ring: 1,
        surface,
        url: "/world/world.json",
      }),
    ).rejects.toThrow(/admissionBudgetMs/u);
  });
});
