import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  Frustum,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyRecords } from "../src/world-cell-records.js";
import { STALE_ENTRY, STALE_HEADER, patchRows, staleRows } from "../src/world-cell-stale.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * The main pass narrows each `asset:level:part` mesh to the world-grid squares the main camera's
 * frustum covers.
 *
 * The mesh is one per key and holds every resident cell's records across the whole ring, so three's
 * whole-mesh frustum test always passes on it and every instance behind or beside the camera is
 * vertex-shaded. The camera here is the honest case: a player standing in one square of a resident
 * ring and looking along an axis, so the squares behind and beside it are unambiguously out of the
 * frustum and the ones it draws are a number the package's own runs state.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
/** The fixture's `cellSize`; a square is one cell unless the test says otherwise. */
const CELL = 64;
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
 */
function packageOf(): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  return {
    ...manifest,
    assets: { ...manifest.assets, pine: { bounds: pine.bounds, glb: pine.glb } },
  };
}

function stubManifestFetch(): void {
  const pkg = packageOf();
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
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
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

const placements = readFileSync(path.join(fixture, "placements.bin"));

/** The instance matrix one placement record composes into, which is the whole of an instance. */
function placementMatrix(index: number): Matrix4 {
  const at = index * 32;
  const scale = placements.readFloatLE(at + 28);
  return new Matrix4().compose(
    new Vector3(
      placements.readFloatLE(at),
      placements.readFloatLE(at + 4),
      placements.readFloatLE(at + 8),
    ),
    new Quaternion(
      placements.readFloatLE(at + 12),
      placements.readFloatLE(at + 16),
      placements.readFloatLE(at + 20),
      placements.readFloatLE(at + 24),
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

/** Every drawn instance, compared against the runs named: the window holds them and nothing else. */
function expectInstances(mesh: InstancedMesh, ...cells: string[]): void {
  const matrix = new Matrix4();
  let at = 0;
  for (const cell of cells) {
    const run = PINE.get(cell);
    if (run === undefined) throw new Error(`the committed package has no pine run in ${cell}.`);
    for (let index = 0; index < run.count; index += 1, at += 1) {
      mesh.getMatrixAt(at, matrix);
      const expected = placementMatrix(run.offset + index);
      for (let element = 0; element < 16; element += 1)
        expect(matrix.elements[element]).toBeCloseTo(expected.elements[element] as number, 4);
    }
  }
  expect(at).toBe(mesh.count);
}

async function loadWorld(
  follow: { position: { x: number; z: number } },
  clusterSize?: number,
  shadows?: { cast: boolean },
): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    // Off, because this file's subject is the coarse per-key window: a bundled mesh is never hidden
    // again, so a record — not `mesh.count` — is what decides what a frame draws.
    bundles: false,
    clusterSize,
    follow,
    shadows,
    loadModel: async () => plainModel(),
    prefetchSeconds: 0,
    ring: 1,
    surface,
    url: "/world/world.json",
  });
}

/** The `pine` level-0 main mesh: one per key, the one every camera here draws. */
function mainMesh(world: WorldCells): InstancedMesh {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === "pine:0:0") found.push(object);
  });
  const mesh = found[0];
  if (mesh === undefined) throw new Error("the world has no pine:0:0 mesh.");
  return mesh;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let the loads settle, then step again: a build waiting on the frame's mesh allowance is deferred. */
async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update();
    const stats = world.stats();
    if (
      stats.admission.backlog === 0 &&
      stats.admission.deferred === 0 &&
      stats.loadsInFlight === 0
    )
      return;
  }
}

/**
 * A player camera in the middle of cell (0,1) — world x,z `[-128, -64)` and `[-64, 0)` — at head
 * height, looking west along −X.
 *
 * 30° of field of view rather than a game's usual 60, because the test is about the window and a
 * wide frustum would legitimately reach the squares either side. Looking west is the axis the ring
 * ends on, so what is ahead is nothing and what is beside and behind is out.
 */
function playerCamera(
  at: readonly [number, number] = [0, 1],
  heading: -1 | 1 = -1,
  height = 4,
): PerspectiveCamera {
  const centre = cellCentre(at[0], at[1]);
  const camera = new PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.set(centre.x, height, centre.z);
  camera.lookAt(centre.x + heading * CELL * 4, height, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/** The same camera, turned to face the other way along the same axis. */
function turn(camera: PerspectiveCamera, heading: -1 | 1): PerspectiveCamera {
  camera.lookAt(camera.position.x + heading * CELL * 4, 4, camera.position.z);
  camera.updateMatrixWorld();
  return camera;
}

/** A virtual-shadow level's camera: a `DirectionalLightShadow`'s own, and three's shadow passes make
 * it orthographic. It looks down the light over one level's window, not along the main view. */
function levelCamera(): OrthographicCamera {
  const centre = cellCentre(1, 1);
  const camera = new OrthographicCamera(-32, 32, 32, -32, 1, 800);
  camera.position.set(centre.x, 400, centre.z);
  camera.lookAt(centre.x, 0, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/**
 * One frame of the world drawn with `camera`, which is what the engine's render-cadence dispatch
 * does: the update, then the whole main set narrowed to that camera's frustum. The narrowing is not
 * the meshes' own draw hook any more, because an empty batch is not submitted and three never calls
 * the hook of a mesh it is not about to draw.
 */
function frame(world: WorldCells, camera: PerspectiveCamera | OrthographicCamera): void {
  world.update(undefined, camera);
}

/** Every `WorldCells`-owned `InstancedMesh` under the world, whatever role or key it serves. */
function worldMeshes(world: WorldCells): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh) found.push(object);
  });
  return found;
}

/** One caster mesh by name: `pine:0:0@x,z` for a square, `pine:0:0@*` for the wide one. */
function casterMesh(world: WorldCells, name: string): InstancedMesh {
  const found = worldMeshes(world).filter((mesh) => mesh.name === name);
  const mesh = found[0];
  if (mesh === undefined) throw new Error(`the world has no ${name} mesh.`);
  return mesh;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells main-pass cluster cull", () => {
  it("draws only the square the camera is in, and exactly its instances", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);

    const mesh = mainMesh(world);
    // A ring of six cells, each its own square, and no authored lod and no cull distance, so the
    // mesh holds every resident `pine` placement until a camera asks it for less.
    expect(mesh.count).toBe(pineIn("0,0", "0,1", "0,2", "1,0", "1,1", "1,2"));

    frame(world, playerCamera());

    // The camera stands in cell (0,1)'s square, so the window is that cell's records and nothing
    // else: five sixths of the ring's are gone before the vertex stage is reached, and they are its
    // own placements, in the order its run wrote them.
    expect(mesh.count).toBe(pineIn("0,1"));
    expectInstances(mesh, "0,1");
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("tests every visibility cell in one engine call when the engine binds it", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    // The owned engine's `Frustum.__tnIntersectsBoxes` (PRD-879), answered here as three would.
    const box = new Box3();
    const engine = vi.fn(function (this: Frustum, boxes: Float64Array): number[] {
      const hits: number[] = [];
      for (let at = 0; at < boxes.length; at += 6) {
        box.min.fromArray(boxes, at);
        box.max.fromArray(boxes, at + 3);
        if (this.intersectsBox(box)) hits.push(at / 6);
      }
      return hits;
    });
    Object.defineProperty(Frustum.prototype, "__tnIntersectsBoxes", {
      configurable: true,
      value: engine,
    });
    try {
      const perBox = vi.spyOn(Frustum.prototype, "intersectsBox");
      frame(world, playerCamera());
      // One crossing for the frame's whole set; every per-cell test ran inside it.
      expect(engine).toHaveBeenCalledTimes(1);
      expect(perBox.mock.calls.length).toBe((engine.mock.calls[0]?.[0] as Float64Array).length / 6);
      expect(mainMesh(world).count).toBe(pineIn("0,1"));
      expectInstances(mainMesh(world), "0,1");
    } finally {
      Reflect.deleteProperty(Frustum.prototype, "__tnIntersectsBoxes");
    }
    world.dispose();
  });

  it("streams a walk in one engine call per system a frame and no per-cell or per-record JS pass (PRD-879 guard)", async () => {
    // The owned engine's two world calls, answered here as three would: the main cull's cell test
    // (`Frustum.__tnIntersectsBoxes`) and the shared batches' instance records
    // (`InstancedBufferAttribute.__tnRecords`). Work inside them is the engine's; the same work
    // outside them is a JS pass the engine was meant to own.
    let inside = 0;
    const box = new Box3();
    const cull = vi.fn(function (this: Frustum, boxes: Float64Array): number[] {
      inside += 1;
      try {
        const hits: number[] = [];
        for (let at = 0; at < boxes.length; at += 6) {
          box.min.fromArray(boxes, at);
          box.max.fromArray(boxes, at + 3);
          if (this.intersectsBox(box)) hits.push(at / 6);
        }
        return hits;
      } finally {
        inside -= 1;
      }
    });
    const records = vi.fn(
      (attributes: InstancedBufferAttribute[], ops: Float64Array, payload: Float32Array) => {
        inside += 1;
        try {
          return applyRecords(attributes, ops, payload);
        } finally {
          inside -= 1;
        }
      },
    );
    // The engine keeps the slab `__tnStaleRows` patched; the scan reads it there.
    let keptRows = new Float64Array(0);
    const rows = vi.fn((blocks: Float64Array, plan: Float64Array) => {
      keptRows = patchRows(keptRows, blocks, plan);
      return keptRows.length;
    });
    const stale = vi.fn((gates: Float64Array, query: Float64Array) => {
      inside += 1;
      try {
        return staleRows(keptRows, gates, query);
      } finally {
        inside -= 1;
      }
    });
    let jsBoxTests = 0;
    let jsUploads = 0;
    const intersectsBox = Frustum.prototype.intersectsBox;
    const needsUpdate = Object.getOwnPropertyDescriptor(BufferAttribute.prototype, "needsUpdate");
    Object.defineProperty(Frustum.prototype, "__tnIntersectsBoxes", {
      configurable: true,
      value: cull,
    });
    Object.defineProperty(InstancedBufferAttribute.prototype, "__tnRecords", {
      configurable: true,
      value: records,
    });
    Object.defineProperty(Object3D.prototype, "__tnStaleRows", { configurable: true, value: rows });
    Object.defineProperty(Object3D.prototype, "__tnStaleEntries", {
      configurable: true,
      value: stale,
    });
    Frustum.prototype.intersectsBox = function (this: Frustum, target: Box3): boolean {
      if (inside === 0) jsBoxTests += 1;
      return intersectsBox.call(this, target);
    };
    Object.defineProperty(BufferAttribute.prototype, "needsUpdate", {
      configurable: true,
      set(this: BufferAttribute, value: boolean) {
        if (inside === 0 && this instanceof InstancedBufferAttribute) jsUploads += 1;
        needsUpdate?.set?.call(this, value);
      },
    });
    try {
      stubManifestFetch();
      const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
      const world = await loadWorld(follow);
      let frames = 0;
      let written = 0;
      let scanned = 0;
      // Load at (0, 1), then walk one cell along x, and settle: admissions, evictions, refilters
      // and the cull's repacks all run inside these updates.
      for (const at of [
        [0, 1],
        [1, 1],
        [1, 1],
      ] as const) {
        Object.assign(follow.position, cellCentre(at[0], at[1]));
        for (let pass = 0; pass < 60; pass += 1) {
          await flush();
          cull.mockClear();
          records.mockClear();
          stale.mockClear();
          frame(world, playerCamera(at));
          frames += 1;
          expect(cull).toHaveBeenCalledTimes(1);
          expect(records.mock.calls.length).toBeLessThanOrEqual(1);
          expect(stale.mock.calls.length).toBeLessThanOrEqual(1);
          written += records.mock.calls.length;
          scanned += stale.mock.calls.length;
          const stats = world.stats();
          if (stats.admission.backlog === 0 && stats.loadsInFlight === 0 && pass > 2) break;
        }
      }
      expect(frames).toBeGreaterThan(3);
      // The walk wrote records, and every byte of them went through the one call a frame.
      expect(written).toBeGreaterThan(0);
      // The walk refiltered, and each pass scanned the resident ring in the one call.
      expect(scanned).toBeGreaterThan(0);
      expect(jsUploads).toBe(0);
      expect(jsBoxTests).toBe(0);
      expect(mainMesh(world).count).toBeGreaterThan(0);
      world.dispose();
    } finally {
      Reflect.deleteProperty(Frustum.prototype, "__tnIntersectsBoxes");
      Reflect.deleteProperty(InstancedBufferAttribute.prototype, "__tnRecords");
      Reflect.deleteProperty(Object3D.prototype, "__tnStaleEntries");
      Reflect.deleteProperty(Object3D.prototype, "__tnStaleRows");
      Frustum.prototype.intersectsBox = intersectsBox;
      if (needsUpdate !== undefined)
        Object.defineProperty(BufferAttribute.prototype, "needsUpdate", needsUpdate);
    }
  });

  it("sends the engine's stale rows only the cell blocks that changed (PRD-879)", async () => {
    // A refilter rebuilds one cell's block; the rest of the slab is already in the engine.
    const blockCount = (slab: Float64Array): number => {
      let blocks = 0;
      let at = 0;
      while (at < slab.length) {
        at += STALE_HEADER + (slab[at + 6] as number) * STALE_ENTRY;
        blocks += 1;
      }
      // A plan that copied from the wrong offset leaves a slab whose blocks do not end at its end.
      expect(at).toBe(slab.length);
      return blocks;
    };
    let kept = new Float64Array(0);
    const sends: Array<{ blocks: number; held: number }> = [];
    let sentFloats = 0;
    let heldFloats = 0;
    Object.defineProperty(Object3D.prototype, "__tnStaleRows", {
      configurable: true,
      value: (blocks: Float64Array, plan: Float64Array) => {
        kept = patchRows(kept, blocks, plan);
        sends.push({ blocks: blockCount(blocks), held: blockCount(kept) });
        sentFloats += blocks.length;
        heldFloats += kept.length;
        return kept.length;
      },
    });
    Object.defineProperty(Object3D.prototype, "__tnStaleEntries", {
      configurable: true,
      value: (gates: Float64Array, query: Float64Array) => staleRows(kept, gates, query),
    });
    try {
      stubManifestFetch();
      const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
      const world = await loadWorld(follow);
      // Settle, then walk across the cell in short steps: each step refilters the cells whose gate
      // it crossed, not the ring.
      for (let step = 0; step <= 16; step += 1) {
        const centre = cellCentre(0, 1);
        Object.assign(follow.position, { x: centre.x + step * 4, z: centre.z });
        for (let pass = 0; pass < (step === 0 ? 60 : 8); pass += 1) {
          await flush();
          frame(world, playerCamera([0, 1]));
        }
      }
      expect(sends.length).toBeGreaterThan(1);
      // One changed cell sends one block while the engine holds the whole ring.
      expect(sends.some((send) => send.blocks === 1 && send.held > 1)).toBe(true);
      // The full slab every time is what this replaced.
      expect(sentFloats).toBeLessThan(heldFloats);
      world.dispose();
    } finally {
      Reflect.deleteProperty(Object3D.prototype, "__tnStaleEntries");
      Reflect.deleteProperty(Object3D.prototype, "__tnStaleRows");
    }
  });

  it("refuses an engine scan that cannot be handed its rows (PRD-879)", async () => {
    // An engine whose scan is bound but whose row store is not would scan an empty slab and find
    // nothing stale, so the walk would never refilter. It throws instead.
    Object.defineProperty(Object3D.prototype, "__tnStaleEntries", {
      configurable: true,
      value: () => [],
    });
    try {
      stubManifestFetch();
      const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
      const world = await loadWorld(follow);
      const walk = async (): Promise<void> => {
        for (const at of [
          [0, 1],
          [1, 1],
        ] as const) {
          Object.assign(follow.position, cellCentre(at[0], at[1]));
          for (let pass = 0; pass < 60; pass += 1) {
            await flush();
            frame(world, playerCamera(at));
          }
        }
      };
      await expect(walk()).rejects.toThrow("TN_WORLD_STALE");
      world.dispose();
    } finally {
      Reflect.deleteProperty(Object3D.prototype, "__tnStaleEntries");
    }
  });

  it("regroups when the camera turns and writes nothing when it does not", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);

    const camera = playerCamera();
    frame(world, camera);
    expect(mesh.count).toBe(pineIn("0,1"));
    const settled = mesh.instanceMatrix.version;

    // The next frame with the same camera: the same squares, so no copy and no attribute version.
    // The version is what a settled static draw watches, so a bump here would make three rescan the
    // window every frame for no change at all.
    frame(world, camera);
    expect(mesh.instanceMatrix.version).toBe(settled);
    expect(mesh.count).toBe(pineIn("0,1"));

    // Turned to face east in the next frame — the same camera object, moved, which is what a player
    // does. The window is then the square it stands in and the column in front of it, laid out
    // contiguously in the order the buffer already held them; what is behind and beside it is out.
    frame(world, turn(camera, 1));
    expect(mesh.count).toBe(pineIn("0,1", "1,1", "1,0", "1,2"));
    expectInstances(mesh, "0,1", "1,1", "1,0", "1,2");
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("never repacks for a shadow level's camera", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);
    const resident = pineIn("0,0", "0,1", "0,2", "1,0", "1,1", "1,2");

    // The shadow passes render before the main one, so a level's orthographic camera is the first
    // to reach this mesh in a frame and must leave the window alone: the count is still the whole
    // ring, exactly as it is with no cull at all.
    frame(world, levelCamera());
    expect(mesh.count).toBe(resident);
    const version = mesh.instanceMatrix.version;
    frame(world, levelCamera());
    expect(mesh.instanceMatrix.version).toBe(version);

    // The main camera then narrows it, and a level's camera after that cannot widen it back.
    frame(world, playerCamera());
    expect(mesh.count).toBe(pineIn("0,1"));
    const narrowed = mesh.instanceMatrix.version;
    frame(world, levelCamera());
    expect(mesh.count).toBe(pineIn("0,1"));
    expect(mesh.instanceMatrix.version).toBe(narrowed);
    world.dispose();
  });

  /**
   * The volume the cull tests is a sub-square of the shadow caster's own square, and it is that
   * narrowness the vertex stage is paid for.
   *
   * The caster square here is two cells on a side — the `clusterSize` a real world streams with —
   * so it straddles this camera's frustum: one 128 m square holds both the cells the camera draws
   * and a cell behind it. A volume for that square is drawn whole, which is what a `clusterSize` of
   * 128 m costs the main pass on every frame, and what the sub-squares exist to stop paying.
   */
  it("takes a sub-square out of a caster square the frustum straddles", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow, CELL * 2);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);

    frame(world, playerCamera([1, 1]));

    // Standing in cell (1,1) looking west: cell (1,0) is behind the camera and (1,2) is off its
    // side, and each of them shares a 128 m caster square with a cell that is drawn — (1,0) with
    // (0,1), (1,2) with (0,2) — so a volume for the caster square would have drawn all four.
    expect(draws(mesh, "0,1")).toBe(true);
    expect(draws(mesh, "0,2")).toBe(true);
    expect(draws(mesh, "1,0")).toBe(false);
    expect(draws(mesh, "1,2")).toBe(false);
    // And what is left is exactly the four cells' records: the whole ring was 328.
    expect(mesh.count).toBe(pineIn("0,0", "0,1", "0,2", "1,1"));
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  /**
   * The volume's Y comes from the placements it holds and the bounds of the assets standing on them,
   * not from the map's terrain range — so it must still reach up to the top of a tree whose ground
   * the frustum's floor has already passed.
   *
   * This is the guard for the tightening, not for the tightening: every placement in this package is
   * scattered flat at y 0, so a camera 20 m up looking level has its frustum's floor 2.8 m over the
   * cell 64 m ahead — above the ground of every `pine` there and below the top of all of them. A
   * volume built from the ground alone would take that cell out of the window and drop its trees.
   */
  it("keeps a sub-square whose ground is under the view and whose trees reach into it", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);

    frame(world, playerCamera([0, 1], 1, 20));

    // Cell (1,1) is 64 m ahead of a camera 20 m up: its floor is 2.8 m up, above the y 0 every
    // placement in it stands on, and the cell's own trees are what reach the frustum.
    expect(draws(mesh, "1,1")).toBe(true);
    expect(mesh.count).toBe(pineIn("0,1", "1,1", "1,0", "1,2"));
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("regroups a visible square after residency changes under it", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    // A square two cells on a side, so a cell leaving the ring is a cell leaving the *square* the
    // camera is standing in rather than a square of its own leaving with it.
    const world = await loadWorld(follow, CELL * 2);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);

    // A two-cell caster square is broad enough that the square beside it is still in reach of the
    // camera's, so both of its visibility cells are drawn and both change when a cell leaves: the
    // camera stands in (1,1), which the far ring keeps, so the change is to records inside what it
    // draws. Four of the ring's six cells are what a 30° view of that position draws.
    const whole = pineIn("0,0", "0,1", "0,2", "1,1");
    const half = pineIn("1,1");
    const camera = playerCamera([1, 1]);
    frame(world, camera);
    expect(mesh.count).toBe(whole);

    // Three cells east, which evicts column 0 — two of them inside the square the camera is still
    // standing in. The write widened `mesh.count` to the live total, and the next draw has to narrow
    // it again from the authoritative per-square data, with the camera unmoved.
    const corner = cellCentre(3, 1);
    follow.position.x = corner.x;
    follow.position.z = corner.z;
    world.update();
    await flushed(world);
    expect(mesh.count).not.toBe(half);
    expect(mesh.count).toBeGreaterThan(half);
    const live = mesh.count;
    frame(world, camera);
    // The window is the visibility cells the frame's one shared volume says the frustum covers,
    // intersected with this batch's own. With the camera unmoved in (1,1) and the ring now east of
    // it, that is the cell it stands in and nothing else — which is what "the draw narrowed it
    // again, with the camera unmoved" claims, to the record.
    expect(mesh.count).toBe(half);
    expect(mesh.count).toBeLessThan(live);
    // Cell (0,1) is one of the two that left, so its records are not in what the camera draws.
    expect(draws(mesh, "0,1")).toBe(false);

    // And back, which re-admits them. The window is the square's, so the next draw is the one that
    // repacks — but nothing may wait for the squares to come back around.
    const home = cellCentre(0, 1);
    follow.position.x = home.x;
    follow.position.z = home.z;
    world.update();
    await flushed(world);
    expect(world.stats().failures).toBe(0);
    frame(world, camera);
    expect(mesh.count).toBe(whole);
    // And it is back: the very record that was gone is in the window again, one draw after the cell
    // holding it was admitted.
    expect(draws(mesh, "0,1")).toBe(true);
    expect(draws(mesh, "0,0")).toBe(true);
    world.dispose();
  });
  /**
   * The pass is one frustum, one set of visible squares and one epoch for the whole frame, and a
   * batch that packed at that epoch answers from two integers.
   *
   * Every key drew the same square set, so deriving it per key was ~230 frustum builds, ~230 `Set`
   * allocations and ~230 sphere walks a frame to learn one answer — ~4 ms of the render cadence's
   * `compute` span on a 2 km walk, for a camera that had not moved. The frame count below is the
   * counter for "one, not one per mesh", and it is asserted against the mesh count rather than a
   * literal, so a package that grew a mesh could not satisfy it.
   */
  it("derives the window once a frame, and re-derives nothing while the camera is still", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const camera = playerCamera();
    frame(world, camera);

    // The main pass's own meshes, which is what a per-key frustum would have been multiplied by.
    const main = worldMeshes(world).filter((mesh) => !mesh.name.includes("@"));
    expect(main.length).toBeGreaterThan(2);
    const settled = world.stats().mainCull;
    const versions = new Map(main.map((mesh) => [mesh, mesh.instanceMatrix.version] as const));

    const frames = 100;
    for (let index = 0; index < frames; index += 1) frame(world, camera);
    const after = world.stats().mainCull;

    // One frustum a frame, and none of them per mesh: this cost `frames * main.length` before.
    expect(after.frustums - settled.frustums).toBe(frames);
    expect(frames).toBeLessThan(frames * main.length);
    // Not one window re-derived and not one record copied: the camera moved nothing, so the frame's
    // epoch is the one every batch packed at and each of them returned before allocating anything.
    expect(after.visibleEpoch).toBe(settled.visibleEpoch);
    expect(after.windows).toBe(settled.windows);
    expect(after.repacks).toBe(settled.repacks);
    // And a settled draw stays settled, which is what the attribute version a static draw watches is
    // for: a bump here would make three rescan every window a frame for no change at all.
    for (const [mesh, version] of versions) expect(mesh.instanceMatrix.version).toBe(version);
    expect(mainMesh(world).count).toBe(pineIn("0,1"));

    // Turning the camera is the one thing that does move the window: the epoch moves once, and each
    // mesh whose own squares changed is repacked exactly once for it.
    frame(world, turn(camera, 1));
    const turned = world.stats().mainCull;
    expect(turned.visibleEpoch).toBe(settled.visibleEpoch + 1);
    expect(turned.repacks).toBeGreaterThan(settled.repacks);
    // The frame after that one is settled again, at the epoch the turn settled it at.
    const held = world.stats().mainCull;
    frame(world, camera);
    expect(world.stats().mainCull.windows).toBe(held.windows);
    expect(world.stats().mainCull.repacks).toBe(held.repacks);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("hides a batch the camera culled to nothing, and shows it again when it turns back", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    world.update();
    await flushed(world);
    const mesh = mainMesh(world);
    const resident = pineIn("0,0", "0,1", "0,2", "1,0", "1,1", "1,2");

    // Six cells west of the ring, looking further away from it. No square is in that frustum, and
    // the mesh's own bounds are the whole ring, so three's whole-mesh test still passes it: the
    // window is the only thing that can take it out, and a window of nothing is not submitted.
    const away = playerCamera([-6, 1], -1);
    frame(world, away);
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);

    // A hook that counts, so the next frame's showing is provably not a draw's doing. Three never
    // calls the hook of a mesh it is not about to draw, and that is exactly why the decision cannot
    // live in one: this frame brings the camera back and the batch with it.
    let draws = 0;
    const own = mesh.onBeforeRender as ((...args: unknown[]) => void) | undefined;
    mesh.onBeforeRender = function (this: unknown, ...args: unknown[]): void {
      draws += 1;
      own?.apply(this, args);
    } as typeof mesh.onBeforeRender;

    frame(world, turn(away, 1));
    expect(draws).toBe(0);
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(resident);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("hides an emptied caster and shows the same mesh again when the walk comes back", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow, undefined, { cast: true });
    world.update();
    await flushed(world);
    // One caster mesh per world-grid square, and this walk stands in square (0,1).
    const name = "pine:0:0@0,1";
    const mesh = casterMesh(world, name);
    expect(mesh.count).toBeGreaterThan(0);
    expect(mesh.visible).toBe(true);

    // Three cells east, which evicts column 0 and empties that square's caster batch. The batch is
    // parked and kept for the walk back, and an empty one is not submitted while it waits.
    const corner = cellCentre(3, 1);
    follow.position.x = corner.x;
    follow.position.z = corner.z;
    world.update();
    await flushed(world);
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);

    // Home again: the retained batch is rebound and refilled, and it is the same mesh — the uuid
    // and the node three built for it are the ones the walk came back to.
    const home = cellCentre(0, 1);
    follow.position.x = home.x;
    follow.position.z = home.z;
    world.update();
    await flushed(world);
    expect(casterMesh(world, name)).toBe(mesh);
    expect(mesh.count).toBeGreaterThan(0);
    expect(mesh.visible).toBe(true);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("draws an empty prewarmed batch once to build its node, then hides it", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await loadWorld(follow);
    // In a scene: a batch added to a world nothing projects builds nothing, so the gate is
    // deliberately still shut without somewhere to draw.
    new Group().add(world);
    world.update();
    // What three does to a mesh it is about to draw: the hook, on the way to the submission.
    const draw = (mesh: InstancedMesh): void => {
      (mesh.onBeforeRender as (...args: unknown[]) => void)(mesh, null, null, null, null, null);
    };
    // Census and draw in the same place: the census runs after an update and before the frame's
    // render, which is where a renderer finds the meshes, so this is that frame's draw of each one
    // — not after the ring is up, when this package has filled every prewarmed key.
    let settled = false;
    const gate = world.prewarmed.then(() => {
      settled = true;
    });
    const drawn = new Set<InstancedMesh>();
    let emptyDraws = 0;
    for (let pass = 0; pass < 200 && settled === false; pass += 1) {
      await flush();
      world.update();
      for (const mesh of worldMeshes(world)) {
        // An empty mesh that is still shown is one owed its prewarm draw, and the borrow counting
        // that draw is on it. `visible` at count 0 is what makes the submission that builds the node
        // and the pipeline three would otherwise build on the walk's first frame instead.
        if (mesh.count > 0 || mesh.visible === false || drawn.has(mesh)) continue;
        expect(Object.hasOwn(mesh, "onBeforeRender")).toBe(true);
        drawn.add(mesh);
        const owed = world.stats().pendingPrewarm;
        draw(mesh);
        emptyDraws += 1;
        // Counted, so the batch follows the count rule again, and a key no placement ever wanted is
        // not submitted for the rest of the walk.
        expect(mesh.visible).toBe(false);
        expect(Object.hasOwn(mesh, "onBeforeRender")).toBe(false);
        expect(world.stats().pendingPrewarm).toBe(owed - 1);
      }
    }
    // Every prewarmed main batch was drawn once while it was still empty, and the gate — a promise
    // about batches, not about draws — settled anyway.
    await gate;
    expect(emptyDraws).toBeGreaterThan(0);
    expect(world.stats().prewarmMinted).toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });
});
