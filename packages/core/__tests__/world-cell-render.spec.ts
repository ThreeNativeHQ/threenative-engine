import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import { BundleGroup } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import { mainShard } from "../src/world-cell-render.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * `CellRender`'s four load-bearing behaviours, pinned before PRD-798 moves the class into five
 * modules.
 *
 * The class is constructed by `WorldCells` alone and keeps its claims, bundles and keys in `#`
 * fields, so the pins drive it the way the engine does — a world loaded from the committed
 * `world-v1` package, stepped, and read back through `WorldCells`' own public surface: the drawn
 * mesh, its instance list, the `world.stats()` counters and the meshes' names. They are deliberately
 * written against that surface and not against internals, so a pure move cannot change their
 * answers and a changed answer is a changed picture.
 *
 * `mainShard` is pure and is pinned directly, table and all: it decides which record a key's mesh
 * lives in, so a different hash is a different bundle layout for the same key.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const placementBytes = readFileSync(path.join(fixture, "placements.bin"));
const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
/** The fixture's `cellSize`; a square is one cell unless the test says otherwise. */
const CELL = manifest.cellSize;

/** Every `pine` placement each cell files, and the first record of each run, from the package. */
const PINE = new Map<string, { count: number; offset: number }>();
for (const cell of manifest.cells)
  for (const run of cell.runs)
    if (run.asset === "pine")
      PINE.set(`${String(cell.x)},${String(cell.z)}`, { count: run.count, offset: run.offset });

/** The world-space centre of cell `(x, z)`, from the package's own extent and cell size. */
function cellCentre(x: number, z: number): { x: number; z: number } {
  return { x: manifest.extent.minX + (x + 0.5) * CELL, z: manifest.extent.minZ + (z + 0.5) * CELL };
}

/** How many `pine` records a set of cells holds, in the order they are named. */
function pineIn(...cells: string[]): number {
  return cells.reduce((sum, cell) => sum + (PINE.get(cell)?.count ?? 0), 0);
}

function plainModel(): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function fileResponse(buffer: Buffer): object {
  return {
    arrayBuffer: async () =>
      buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
    headers: new Headers(),
    json: async () => JSON.parse(buffer.toString("utf8")),
    ok: true,
    status: 200,
  };
}

/**
 * The package with `pine`'s authored `lods` removed, so every one of its placements is drawn at
 * level 0 and a square's worth of a key is exactly the count its run states.
 *
 * `rockInWest` also drops `rock` from every cell but the western column, so walking east retires
 * that asset's keys — the one event that takes a main mesh back out of its bundle record.
 */
function stubManifestFetch(rockInWest = false): void {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  const pkg: IWorldPackage = {
    ...manifest,
    assets: { ...manifest.assets, pine: { bounds: pine.bounds, glb: pine.glb } },
    cells: rockInWest
      ? manifest.cells.map((cell) =>
          cell.x < 1 ? cell : { ...cell, runs: cell.runs.filter((run) => run.asset !== "rock") },
        )
      : manifest.cells,
  };
  const body = JSON.stringify(pkg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => pkg,
          ok: true,
          status: 200,
        };
      if (url.endsWith("placements.bin")) return fileResponse(placementBytes);
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
        ok: false,
        status: 404,
      };
    }),
  );
}

/** The instance matrix one placement record composes into, which is the whole of an instance. */
function placementMatrix(index: number): Matrix4 {
  const at = index * 32;
  const scale = placementBytes.readFloatLE(at + 28);
  return new Matrix4().compose(
    new Vector3(
      placementBytes.readFloatLE(at),
      placementBytes.readFloatLE(at + 4),
      placementBytes.readFloatLE(at + 8),
    ),
    new Quaternion(
      placementBytes.readFloatLE(at + 12),
      placementBytes.readFloatLE(at + 16),
      placementBytes.readFloatLE(at + 20),
      placementBytes.readFloatLE(at + 24),
    ),
    new Vector3(scale, scale, scale),
  );
}

/** Whether the drawn window holds this exact placement, wherever in it. */
function draws(mesh: InstancedMesh, cell: string, placement = 0): boolean {
  const run = PINE.get(cell);
  if (run === undefined) throw new Error(`the committed package has no pine run in ${cell}.`);
  const wanted = placementMatrix(run.offset + placement).elements[12] as number;
  const matrix = new Matrix4();
  for (let index = 0; index < mesh.count; index += 1) {
    mesh.getMatrixAt(index, matrix);
    if (Math.abs((matrix.elements[12] as number) - wanted) < 1e-3) return true;
  }
  return false;
}

/** A WebGPU renderer with no GPU behind it: the world's dispatch and markers run, no draw does. */
function gpuRendererStub(): IRendererLike {
  return {
    compute: (): void => {},
    kind: "webgpu",
    readback: async (args: { array: Uint32Array }): Promise<ArrayBuffer> =>
      args.array.slice().buffer as ArrayBuffer,
    raw: { backend: { hasFeature: (): boolean => true } },
  } as unknown as IRendererLike;
}

async function load(
  follow: { position: { x: number; z: number; y: number } },
  options: {
    readonly bundles?: boolean;
    readonly gpuScene?: boolean;
    readonly shadows?: { cast: boolean; receive?: boolean };
  } = {},
): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow,
    loadModel: async () => plainModel(),
    prefetchSeconds: 0,
    ring: 1,
    surface,
    url: "/world/world.json",
    ...options,
  });
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let the loads settle, then step again: a build waiting on the frame's mesh allowance is deferred.
 *
 * The camera comes with the renderer, because the main cull — and so every bundle record — runs only
 * on a frame that had one.
 */
async function flushed(
  world: WorldCells,
  renderer?: IRendererLike,
  camera?: PerspectiveCamera,
): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update(renderer, camera);
    const stats = world.stats();
    if (
      stats.admission.backlog === 0 &&
      stats.admission.deferred === 0 &&
      stats.loadsInFlight === 0
    )
      return;
  }
}

/** A player camera in the middle of a cell at head height, looking west along −X. */
function playerCamera(
  at: readonly [number, number] = [0, 1],
  heading: -1 | 1 = -1,
): PerspectiveCamera {
  const centre = cellCentre(at[0], at[1]);
  const camera = new PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.set(centre.x, 4, centre.z);
  camera.lookAt(centre.x + heading * CELL * 4, 4, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/** The same camera, turned to face the other way along the same axis. */
function turn(camera: PerspectiveCamera, heading: -1 | 1): PerspectiveCamera {
  camera.lookAt(camera.position.x + heading * CELL * 4, 4, camera.position.z);
  camera.updateMatrixWorld();
  return camera;
}

/** The `pine` level-0 main mesh: one per key, the one every camera here draws. */
function mainMesh(world: WorldCells): InstancedMesh {
  return meshNamed(world, "pine:0:0");
}

/** One mesh by its exact name, wherever in the world it hangs. */
function meshNamed(world: WorldCells, name: string): InstancedMesh {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === name) found.push(object);
  });
  const mesh = found[0];
  if (mesh === undefined) throw new Error(`the world has no ${name} mesh.`);
  return mesh;
}

/** Every main-role mesh of `asset` that a bundle record holds: its parent is one of the shards. */
function recordedMeshesOf(world: WorldCells, asset: string): InstancedMesh[] {
  return mainMeshesOf(world, asset).filter((mesh) => mesh.parent instanceof BundleGroup);
}

/** Every main-role mesh of one asset: a caster half carries an `@` in its key, the main half not. */
function mainMeshesOf(world: WorldCells, asset: string): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name.startsWith(`${asset}:`)) found.push(object);
  });
  return found.filter((mesh) => !mesh.name.includes("@"));
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mainShard", () => {
  it("keeps a key in one of thirty-two groups for the key's whole life", () => {
    // A fixed table: these are today's buckets, and a key that moved shard would be recorded in
    // another group for no gain. The hash is FNV-1a over the key, modulo 32.
    const table = ["pine:0:0", "pine:1:0", "rock:0:0", "pine:0:0@0,1", "pine:0:0@*"];
    expect(table.map(mainShard)).toEqual([19, 20, 4, 12, 25]);

    // Every name a package mints, as the world mints it: keys per level and part, and the caster
    // halves' `@square` and `@wide` suffixes. Integer, in range, and the same answer on a second call
    // and in another order, which is what "stable for its whole life" means for a pure function.
    const keys: string[] = [];
    for (const asset of Object.keys(manifest.assets))
      for (let level = 0; level < 3; level += 1)
        for (let part = 0; part < 2; part += 1)
          keys.push(`${asset}:${String(level)}:${String(part)}`);
    for (const key of [...keys]) keys.push(`${key}@0,1`, `${key}@*`);
    const shards = keys.map(mainShard);
    for (const shard of shards) {
      expect(Number.isInteger(shard)).toBe(true);
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(32);
    }
    expect([...keys].reverse().map(mainShard)).toEqual([...shards].reverse());
    // A constant answer would satisfy every check above and land the whole world in one group.
    expect(new Set(shards).size).toBeGreaterThan(8);
  });
});

describe("CellRender", () => {
  it("keeps the square the camera stands in and drops the ones beside it", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } };
    const world = await load(follow, { bundles: false, gpuScene: false });
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);
    // A ring of six cells, one per square, no authored lod and no cull distance, so the mesh holds
    // every resident `pine` placement until a camera asks it for less.
    const resident = pineIn("0,0", "0,1", "0,2", "1,0", "1,1", "1,2");
    expect(mesh.count).toBe(resident);

    // West from cell (0,1): the square the camera stands in is kept, and the ones beside and behind
    // it are dropped — their records are gone from the draw window, not merely off screen.
    const camera = playerCamera();
    world.update(undefined, camera);
    expect(world.stats().mainCull.frustums).toBe(1);
    expect(mesh.count).toBe(pineIn("0,1"));
    expect(draws(mesh, "0,1")).toBe(true);
    expect(draws(mesh, "1,2")).toBe(false);

    // Turned east, the same square is kept and the column ahead joins it, in the window's order.
    world.update(undefined, turn(camera, 1));
    expect(mesh.count).toBe(pineIn("0,1", "1,1", "1,0", "1,2"));
    expect(draws(mesh, "1,0")).toBe(true);
    expect(draws(mesh, "0,0")).toBe(false);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("gives a shadow claim back when the cell that asked for it leaves", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } };
    const world = await load(follow, {
      bundles: false,
      gpuScene: false,
      shadows: { cast: true },
    });
    world.update();
    await flushed(world);

    // One caster cluster per `(key, square)`, and the claim it holds is exactly the square's records:
    // cell (0,0) is one 64 m square, so its own pine count is what the caster draws.
    const claimed = meshNamed(world, "pine:0:0@0,0");
    expect(claimed.count).toBe(pineIn("0,0"));
    expect(claimed.visible).toBe(true);

    // Three cells east evicts column 0. The claim goes with the cell that held it: no record is left
    // and the batch is not submitted, so nothing draws a square no resident cell owns.
    const corner = cellCentre(3, 1);
    follow.position.x = corner.x;
    follow.position.z = corner.z;
    world.update();
    await flushed(world);
    expect(world.stats().residentKeys).not.toContain("0:0");
    expect(claimed.count).toBe(0);
    expect(claimed.visible).toBe(false);

    // And the same cell, claimed again on the way back, draws its own records once more.
    const home = cellCentre(0, 1);
    follow.position.x = home.x;
    follow.position.z = home.z;
    world.update();
    await flushed(world);
    expect(claimed.count).toBe(pineIn("0,0"));
    expect(claimed.visible).toBe(true);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("puts a retired key's mesh back in the record when the walk comes back", async () => {
    // `rock` only in the western column, so walking east retires its keys and takes their meshes out
    // of the record, and walking back mints them into it again.
    stubManifestFetch(true);
    const follow = { position: { ...cellCentre(0, 1), y: 0 } };
    const renderer = gpuRendererStub();
    const world = await load(follow, {
      bundles: true,
      gpuScene: false,
      shadows: { cast: true, receive: true },
    });
    world.update(renderer, playerCamera());
    await flushed(world, renderer, playerCamera());

    const before = world.stats().bundle.children;
    expect(before).toBeGreaterThan(0);
    // Every rock main mesh is in a record: a mesh left outside one is a mesh whose per-object path
    // still runs every frame, and the record is the draw list this test is about.
    const recorded = recordedMeshesOf(world, "rock")
      .map((mesh) => mesh.name)
      .sort();
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded).toEqual(
      mainMeshesOf(world, "rock")
        .map((mesh) => mesh.name)
        .sort(),
    );

    // East, past the column that owns every rock: the key retires, its record leaves, and the world
    // holds no rock main mesh at all — the draw list is the record's, so it has to shrink with it.
    const records = world.stats().bundle.records;
    follow.position.x = cellCentre(3, 1).x;
    for (let pass = 0; pass < 40 && world.stats().residentKeys.includes("0:1"); pass += 1) {
      world.update(renderer, playerCamera([3, 1]));
      await flush();
    }
    expect(world.stats().residentKeys).not.toContain("0:1");
    expect(mainMeshesOf(world, "rock")).toEqual([]);
    expect(recordedMeshesOf(world, "rock")).toEqual([]);
    expect(world.stats().bundle.records).toBeGreaterThan(records);

    // Back west: the same cells come back, so the same roots are recorded again and the record holds
    // exactly what it held before the walk.
    follow.position.x = cellCentre(0, 1).x;
    for (let pass = 0; pass < 40 && world.stats().bundle.children !== before; pass += 1) {
      world.update(renderer, playerCamera());
      await flush();
    }
    expect(world.stats().bundle.children).toBe(before);
    expect(
      recordedMeshesOf(world, "rock")
        .map((mesh) => mesh.name)
        .sort(),
    ).toEqual(recorded);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });
});
