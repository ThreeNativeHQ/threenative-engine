import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Box3,
  BoxGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  type Sphere,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InstancedBatch } from "../src/instanced-batch.js";
import {
  MESH_POOL_MAX_HELD,
  MESH_POOL_MAX_PER_PAIR,
  drainMeshPool,
  dropPooledFor,
  parkMesh,
  pooledMesh,
} from "../src/render/mesh-pool.js";
import { VirtualShadowNode } from "../src/render/virtual-shadow.js";
import { TerrainTiles } from "../src/world-tiles.js";
import type { IWorldPackage } from "../src/world.js";
import { WorldCells } from "../src/world.js";

/**
 * The streaming-performance contract, as assertions rather than as a profile.
 *
 * Three hunks, ported from the game-side checks that measured them: a shared batch draws only live
 * records and keeps a uuid across a residency cycle; the prewarm gate a loading screen waits on
 * settles; and a refilter that came back identical is counted instead of rewritten.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;
const CELL_SIZE = manifest.cellSize;
const MIN_X = manifest.extent.minX;
const MIN_Z = manifest.extent.minZ;
const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 16 };
const DT = 1 / 60;

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
        return fileResponse(readFileSync(path.join(fixture, "terrain/heightmap.u16")));
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

/** Two drawable parts per model, so a shared batch key is not one mesh per asset. */
function model(): Object3D {
  const group = new Group();
  for (let part = 0; part < 2; part += 1)
    group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function cellCenter(x: number, z: number): { x: number; z: number } {
  return { x: MIN_X + (x + 0.5) * CELL_SIZE, z: MIN_Z + (z + 0.5) * CELL_SIZE };
}

async function makeWorld(): Promise<{
  readonly follow: { position: { x: number; z: number } };
  readonly world: WorldCells;
}> {
  stubFixtureFetch();
  const follow = { position: cellCenter(1, 1) };
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow,
    loadModel: async () => model(),
    ring: 1,
    // Both halves stream: the caster clusters are keys too, and one that re-mints costs the same
    // node build twice.
    shadows: { cast: true },
    surface,
    url: "/world/world.json",
  });
  return { follow, world };
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Update until the admission queue is empty. */
function settle(world: WorldCells, limit = 4000): void {
  for (let frame = 0; frame < limit; frame += 1) {
    world.update();
    if (world.stats().admission.backlog === 0) return;
  }
  throw new Error(`WorldCells still owed ${String(world.stats().admission.backlog)} units.`);
}

/** Every batch mesh the world drew, keyed by the `asset:level:part` name it carries. */
function batches(world: WorldCells): Map<string, InstancedMesh> {
  const meshes = new Map<string, InstancedMesh>();
  world.traverse((object) => {
    if (object instanceof InstancedMesh) meshes.set(object.name, object);
  });
  return meshes;
}

/**
 * What the GPU would hold, replayed through the same rule three's WebGPU backend uses: an empty
 * range list uploads the whole buffer, and each range uploads its own span.
 */
function uploaded(mesh: InstancedMesh): Float32Array {
  const array = mesh.instanceMatrix.array as Float32Array;
  const matrix = mesh.instanceMatrix;
  if (matrix.updateRanges.length === 0) return Float32Array.from(array);
  const shadow = new Float32Array(array.length);
  for (const range of matrix.updateRanges)
    shadow.set(array.subarray(range.start, range.start + range.count), range.start);
  return shadow;
}

afterEach(() => {
  drainMeshPool();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("InstancedBatch.equals", () => {
  const place = (batch: InstancedBatch, x: number): void => {
    const matrix = new Matrix4().makeTranslation(x, 0, 0);
    batch.add(matrix);
  };

  it("is true for the same matrices in the same order and false for any other answer", () => {
    const mine = new InstancedBatch({
      geometry: new BoxGeometry(),
      material: new MeshBasicMaterial(),
    });
    const theirs = new InstancedBatch({ geometry: mine.geometry, material: mine.material });
    place(mine, 1);
    place(mine, 2);
    place(theirs, 1);
    place(theirs, 2);
    expect(mine.equals(theirs)).toBe(true);

    // Same records, different order: a rebuild's order is its own, so this is a different answer.
    const swapped = new InstancedBatch({ geometry: mine.geometry, material: mine.material });
    place(swapped, 2);
    place(swapped, 1);
    expect(mine.equals(swapped)).toBe(false);

    place(swapped, 3);
    expect(mine.equals(swapped)).toBe(false);
    expect(mine.equals(undefined)).toBe(false);
    expect(
      new InstancedBatch({ geometry: mine.geometry, material: mine.material }).equals(mine),
    ).toBe(false);
  });
});

describe("mesh pool", () => {
  it("hands the same object back, and a parked mesh goes away with the parts it drew", () => {
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const first = pooledMesh(geometry, material, 8);
    expect(first.instanceMatrix.count).toBeGreaterThanOrEqual(8);
    expect(parkMesh(first)).toBe(true);
    expect(first.visible).toBe(false);
    const second = pooledMesh(geometry, material, 8);
    expect(second).toBe(first);
    expect(second.uuid).toBe(first.uuid);
    drainMeshPool();
  });

  it("refuses and disposes the ninth park of one pair, and the park past MESH_POOL_MAX_HELD", () => {
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    for (let index = 0; index < MESH_POOL_MAX_PER_PAIR; index += 1)
      expect(parkMesh(new InstancedMesh(geometry, material, 64))).toBe(true);
    const ninth = new InstancedMesh(geometry, material, 64);
    const ninthDispose = vi.spyOn(ninth, "dispose");
    expect(parkMesh(ninth)).toBe(false);
    expect(ninthDispose).toHaveBeenCalledOnce();

    const pairs = MESH_POOL_MAX_HELD / MESH_POOL_MAX_PER_PAIR;
    for (let pair = 1; pair < pairs; pair += 1) {
      const anotherGeometry = new BoxGeometry();
      const anotherMaterial = new MeshBasicMaterial();
      for (let index = 0; index < MESH_POOL_MAX_PER_PAIR; index += 1)
        parkMesh(new InstancedMesh(anotherGeometry, anotherMaterial, 64));
    }
    const pastFull = new InstancedMesh(new BoxGeometry(), new MeshBasicMaterial(), 64);
    const fullDispose = vi.spyOn(pastFull, "dispose");
    expect(parkMesh(pastFull)).toBe(false);
    expect(fullDispose).toHaveBeenCalledOnce();
    drainMeshPool();
  });

  it("dropPooledFor disposes the parked meshes of one pair and forgets the pair", () => {
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    const first = new InstancedMesh(geometry, material, 64);
    const second = new InstancedMesh(geometry, material, 64);
    parkMesh(first);
    parkMesh(second);
    const firstDispose = vi.spyOn(first, "dispose");
    const secondDispose = vi.spyOn(second, "dispose");
    dropPooledFor(geometry, material);
    expect(firstDispose).toHaveBeenCalledOnce();
    expect(secondDispose).toHaveBeenCalledOnce();
    // The pair has no parked capacity, so the pool mints a fresh mesh for the next caller.
    const reclaimed = pooledMesh(geometry, material, 64);
    expect(reclaimed).not.toBe(first);
    expect(reclaimed).not.toBe(second);
    drainMeshPool();
  });
});

describe("WorldCells streaming performance", () => {
  it("draws only live records, and never gives one key a second mesh across a residency cycle", async () => {
    const { follow, world } = await makeWorld();
    const seen = new Set<string>();
    const uuidByKey = new Map<string, string>();
    const reminted: string[] = [];
    let now = 0;

    // Out for half the walk, back for the rest: a straight walk never re-admits a cell, so it
    // reports zero churn by construction and hides the cost the check is for.
    for (let leg = 0; leg < 2; leg += 1) {
      const direction = leg === 0 ? 1 : -1;
      for (let frame = 0; frame < 240; frame += 1) {
        follow.position.x += direction * CELL_SIZE * 0.5 * DT;
        now += DT * 1e3;
        world.update();
        if (frame % 4 === 0) await flush(1);
        for (const [name, mesh] of batches(world)) {
          // A key keeps one uuid for the whole walk, on the main half and on the caster clusters
          // alike: a second mesh is a node three built twice, in the main pass and in every shadow
          // pass. Compared frame by frame, because `grow` swaps a fresh mesh in under the same name
          // inside a settle — two quiescent snapshots never see it.
          const held = uuidByKey.get(name);
          if (held !== undefined) {
            if (held !== mesh.uuid) reminted.push(name);
            continue;
          }
          uuidByKey.set(name, mesh.uuid);
          if (seen.has(mesh.uuid)) reminted.push(`${name} took a mesh another key already had`);
          seen.add(mesh.uuid);
          // A prewarmed batch is minted empty and only filled when a placement wants the key, so
          // `count` 0 is a mesh waiting rather than a hole.
          if (mesh.count === 0) continue;
          // `count` is the live total: every drawn slot holds a real record, and no record is
          // drawn twice. A dead slot is a whole mesh run through the vertex shader for nothing.
          const shadow = uploaded(mesh);
          const identities = new Set<number>();
          for (let index = 0; index < mesh.count; index += 1) {
            const at = index * 16;
            expect(shadow[at + 15], `${name} slot ${String(index)} is not a live matrix`).not.toBe(
              0,
            );
            identities.add(shadow[at + 12] as number);
          }
          expect(identities.size, `${name} drew a record twice`).toBe(mesh.count);
          // The mesh's own bounds hold every drawn record, on every axis, and the sphere covers the
          // box: three tests the sphere, and a batch it culls disappears from the shadow levels.
          const box = mesh.boundingBox as Box3;
          const sphere = mesh.boundingSphere as Sphere;
          expect(mesh.frustumCulled).toBe(true);
          expect(box).not.toBeNull();
          expect(sphere).not.toBeNull();
          for (let index = 0; index < mesh.count; index += 1) {
            const at = index * 16;
            for (const [axis, value] of [
              ["x", shadow[at + 12] as number],
              ["y", shadow[at + 13] as number],
              ["z", shadow[at + 14] as number],
            ] as const)
              expect(
                (box.min[axis] as number) <= value && value <= (box.max[axis] as number),
                `${name} slot ${String(index)} at ${String(value)} on ${axis} is outside [${String(box.min[axis])}, ${String(box.max[axis])}]`,
              ).toBe(true);
          }
          const centre = box.getCenter(new Vector3());
          expect(sphere.center.distanceTo(centre)).toBeLessThan(1e-3);
          expect(sphere.radius).toBeGreaterThanOrEqual(
            box.getSize(new Vector3()).length() / 2 - 1e-3,
          );
          // Tight enough to catch the fallback: a batch that used the package extent would pass
          // every assertion above and still submit the whole forest to a 48 m shadow level.
          expect(box.max.x - box.min.x, `${name} fell back to the package extent`).toBeLessThan(
            manifest.extent.sizeX,
          );
        }
      }
    }
    const stats = world.stats();
    expect(stats.failures).toBe(0);
    expect(stats.rebuilds).toBeGreaterThan(0);
    expect(reminted, "a shared batch was given a second mesh").toEqual([]);
    world.dispose();
    expect(now).toBeGreaterThan(0);
  });

  it("parks a released batch, and hands the same mesh back on the walk home", async () => {
    const { follow, world } = await makeWorld();
    new Group().add(world);
    settle(world);
    for (let frame = 0; frame < 300; frame += 1) {
      world.update();
      await flush(1);
      if (world.stats().prewarmMinted > 0 && world.stats().pendingPrewarm === 0) break;
    }
    const home = new Map<string, InstancedMesh>(batches(world));
    expect(home.size).toBeGreaterThan(0);

    // Far enough that the ring empties and every batch is released into the retained set. A walk too
    // short to leave a cell never releases anything, so the retained path is never taken at all.
    follow.position.x += CELL_SIZE * 12;
    settle(world);
    const away = batches(world);
    const retained = [...home].filter(([name, mesh]) => away.get(name) !== mesh);
    expect(retained.length, "no batch was released, so nothing was retained").toBeGreaterThan(0);

    // A parked batch holds no records, so what it keeps is the uuid three built a node for and
    // nothing else. Charged at a ring's capacity instead, the retained set costs more than
    // `RETIRED_SHARED_BYTES` holds, the budget evicts the keys a walk is about to return to, and the
    // walk mints a second mesh for each of them.
    for (const [name, mesh] of retained) {
      expect(mesh.count, `${name} was released still holding records`).toBe(0);
      expect(mesh.instanceMatrix.count, `${name} kept its buffer while parked`).toBe(1);
      expect((mesh.instanceMatrix.array as Float32Array).byteLength).toBe(64);
    }

    // Home again. The retained mesh is the one the cell draws into: the prewarm must not mint a
    // second batch for a key the retained set is already holding, and `#sharedFor` must rebind that
    // one rather than fall through to the fresh allowance.
    follow.position.x -= CELL_SIZE * 12;
    settle(world);
    for (let frame = 0; frame < 60; frame += 1) {
      world.update();
      await flush(1);
    }
    const back = batches(world);
    const secondMesh: string[] = [];
    for (const [name, mesh] of retained) {
      const again = back.get(name);
      if (again === undefined) continue;
      if (again.uuid !== mesh.uuid) secondMesh.push(name);
    }
    expect(secondMesh, "a key the retained set was holding was given a second mesh").toEqual([]);
    expect(back.size).toBeGreaterThan(0);
    world.dispose();
  });

  it("settles the prewarm gate and reports it as a number", async () => {
    const { world } = await makeWorld();
    // In a scene: a batch added to a world nothing projects builds nothing, so the gate is
    // deliberately still shut.
    new Group().add(world);
    settle(world);
    // The gate settles on updates, not on its own: minting is an update's work, and the readiness
    // signal only advances on an update that had somewhere to draw.
    for (let frame = 0; frame < 300; frame += 1) {
      world.update();
      await flush(1);
      if (world.stats().prewarmMinted > 0 && world.stats().pendingPrewarm === 0) break;
    }
    // The gate is a promise, and `pendingPrewarm` is the same thing as a number: a loading screen
    // waits on the first and draws a bar from the second.
    await world.prewarmed;
    expect(world.stats().prewarmMinted).toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
    world.dispose();
    // A world torn down mid-prewarm must not leave a game awaiting the gate.
    const torn = await makeWorld();
    new Group().add(torn.world);
    torn.world.update();
    torn.world.dispose();
    await torn.world.prewarmed;
  });

  it("counts a refilter that came back identical instead of writing it again", async () => {
    const { follow, world } = await makeWorld();
    settle(world);
    const before = world.stats();
    // A walk in 0.25 m updates, 7.5 m in all: the refilter pass runs on its own 2 m step, not on
    // every update, so the ring is refiltered a handful of times and not thirty.
    for (let frame = 0; frame < 30; frame += 1) {
      follow.position.x += 0.25;
      world.update();
      await flush(1);
    }
    const after = world.stats();
    // It did run, and it queued real work: at a 2 m step a placement can cross a level or cull
    // boundary, which is the whole reason the step exists — a scan every half metre spent its cost
    // re-deriving brackets for the same answer, and still let a switch land as late as the scan.
    expect(after.rebuilds).toBeGreaterThan(before.rebuilds);
    // Fewer refilters than updates, and the unchanged share is still a share of the refilters.
    expect(after.rebuilds - before.rebuilds).toBeLessThan(30);
    expect(after.unchanged).toBeLessThanOrEqual(after.rebuilds);
    world.dispose();
  });

  // The step has to be a gate on the *pass*, not only on the answer it reaches. The per-batch
  // hysteresis is `threshold / 8`, so a walk inside the step still finds nothing stale — while a
  // pass that ran anyway walked every resident cell, derived both distance brackets per batch,
  // allocated the stale list and sorted it, to reach that same nothing (~60 ms on the 2 km map).
  // `rebuilds` cannot tell those two frames apart: only the pass count can.
  it("does not touch the cell loop for ten updates inside the refilter step", async () => {
    const { follow, world } = await makeWorld();
    settle(world);
    const before = world.stats();
    const start = follow.position.x;
    for (let frame = 0; frame < 10; frame += 1) {
      follow.position.x = start + frame * 0.19;
      world.update();
      await flush(1);
    }
    const inside = world.stats();
    // Ten updates, 1.9 m in total, and not one of them reached a cell: `rebuilds` already said
    // nothing was rebuilt, and `refilters` says the ring was never walked to find that out.
    expect(inside.rebuilds).toBe(before.rebuilds);
    expect(inside.refilters).toBe(before.refilters);

    // Past the 2 m step the pass runs, because that is the only thing the step buys.
    follow.position.x = start + 2.4;
    world.update();
    const past = world.stats();
    expect(past.refilters).toBe(before.refilters + 1);
    world.dispose();
  });
});

/** A budget that admits nothing at all, as a frame whose 2 ms went somewhere else. */
const spentBudget = { admit: (): boolean => false, spentMs: 2 };

describe("TerrainTiles admission budget", () => {
  function tiles(overrides: Record<string, unknown> = {}): TerrainTiles {
    return new TerrainTiles({
      createCollider: () => ({ dispose: () => undefined }),
      residentByteBudget: 100_000_000,
      residentTileBudget: 9,
      sampleHeight: (x: number, z: number) => Math.sin(x * 0.17) + Math.cos(z * 0.13),
      streamRadius: 2,
      surface: new MeshBasicMaterial(),
      tileResolution: 9,
      tileSize: 16,
      ...overrides,
    } as never);
  }

  it("builds the nearest missing tile even when the budget refuses every unit", () => {
    const world = tiles();
    // Every pass wants the same ring, so the only tile a spent budget may not refuse is the first
    // one it builds, and `selected` is sorted nearest first: that is the followed tile.
    world.follow({ x: 0, z: 0 }, spentBudget);
    expect(world.getTile("0:0")).toBeDefined();
    // Exactly one, not the ring: a forced pass is a floor, not a bypass.
    expect(world.residentTileCount).toBe(1);
    expect(world.deferredAdmissions).toBe(1);
    // The next pass, with the budget spent again, converges one tile nearer each time.
    world.follow({ x: 0, z: 0 }, spentBudget);
    expect(world.residentTileCount).toBe(2);
    world.dispose();
  });

  it("gives the 3x3 ring around the followed point its bodies, and defers the rest", () => {
    const world = tiles({ colliderRadius: 2 });
    world.follow({ x: 0, z: 0 }, spentBudget);
    // Five tiles are resident by now: the forced tile and the four its own collider admitted with
    // it, all of them inside the 3x3 the budget may not refuse.
    for (const key of world.residentKeys) {
      const [tileX, tileZ] = key.split(":").map(Number);
      const near = Math.max(Math.abs(tileX as number), Math.abs(tileZ as number)) <= 1;
      expect({ key, hasCollider: world.residentColliderKeys.includes(key) }).toEqual({
        key,
        hasCollider: near,
      });
    }
    world.dispose();
  });
});

describe("VirtualShadowNode per-level refresh and region invalidation", () => {
  function node(refreshStep: number | readonly number[]): VirtualShadowNode {
    const light = new DirectionalLight(0xffffff, 3);
    light.castShadow = true;
    light.target.position.set(0, 0, 0);
    const built = new VirtualShadowNode(light, {
      clipExtents: [24, 96, 320],
      mapSize: 512,
      marker: false,
      refreshStep,
    });
    built.setup({
      context: {},
      material: {},
      renderer: { shadowMap: { enabled: true } },
    } as never);
    for (const levelNode of [...built.levelNodes, ...built.moverNodes]) {
      (levelNode as unknown as { updateShadow(frame: unknown): void }).updateShadow = () =>
        undefined;
    }
    light.add(light.target);
    return built;
  }

  // The engine frame clock, four seconds per read: past every `invalidationDelay` of the 24 / 96 /
  // 320 cascade on the very first frame. This suite is about *which* levels an invalidation asks,
  // and a coarse enough clock keeps the delay from ever being the reason one of them is not due.
  let clock = 0;
  const frame = {
    camera: new PerspectiveCamera(),
    renderer: {},
    get time(): number {
      clock += 4;
      return clock;
    },
  } as never;

  it("gives every level its own step, so the fine one re-renders a walking camera far less", () => {
    const perLevel = node([0.25, 0.125, 0.125]);
    const shared = node(0.125);
    const windows = (built: VirtualShadowNode) => {
      built.updateBefore(frame);
      return built.clipmap.levelCount;
    };
    expect(windows(perLevel)).toBe(3);
    // The steps are the node's own, and each level's guard is paid by its own step: 0.9 - 0.25 on
    // the fine level, 0.9 - 0.125 on the two coarse ones.
    expect([...perLevel.options.refreshStep]).toEqual([0.25, 0.125, 0.125]);
    expect([...perLevel.options.selectionGuard]).toEqual([0.65, 0.775, 0.775]);
    // A scalar is held as one entry per level, so what the node reports names the level it read.
    expect([...shared.options.refreshStep]).toEqual([0.125, 0.125, 0.125]);
    expect([...shared.options.selectionGuard]).toEqual([0.775, 0.775, 0.775]);
    perLevel.dispose();
    shared.dispose();
  });

  it("rejects a step that would cost a level its selection guard", () => {
    expect(() => node([0.9, 0.125])).toThrow(RangeError);
    expect(() => node([0.25, 0.5])).toThrow(RangeError);
    expect(() => node(-0.1)).toThrow(RangeError);
  });

  it("invalidates only the levels whose window covers the region, and nothing when it is unchanged", () => {
    const built = node(0.125);
    // One level per frame, finest first, so the node needs a few frames to map all three before a
    // steady walk is the thing under test.
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ moved: 3, rendered: 1, deferred: 2 });
    while (built.stats.deferred > 0) built.updateBefore(frame);
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ rendered: 0, deferred: 0 });

    // A corner the coarsest window reaches and the two fine ones do not.
    built.invalidateRegion({
      max: { x: 300, y: 1, z: 300 },
      min: { x: 280, y: -1, z: 280 },
    });
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ moved: 0, invalidated: 1, rendered: 1 });

    // A pass in which nothing changed hands over no region at all, so nothing is redrawn: this is
    // what turns a caster refresh that wrote back the same records into zero draws.
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ invalidated: 0, rendered: 0, moved: 0 });

    // A region at the camera redraws every window, and `invalidateAll` still redraws them all.
    built.invalidateRegion({ max: { x: 1, y: 1, z: 1 }, min: { x: -1, y: -1, z: -1 } });
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ invalidated: 3, rendered: 1, deferred: 2 });
    while (built.stats.deferred > 0) built.updateBefore(frame);
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ rendered: 0, deferred: 0 });
    built.invalidateAll();
    built.updateBefore(frame);
    expect(built.stats).toMatchObject({ invalidated: 3, rendered: 1, deferred: 2 });
    built.dispose();
  });
});
