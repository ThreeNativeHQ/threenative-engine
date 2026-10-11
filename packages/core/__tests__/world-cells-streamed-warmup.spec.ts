import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  FrontSide,
  Group,
  type InstancedBufferAttribute,
  InstancedMesh,
  type Material,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import type { IWorldPackage } from "../src/world.js";
import { WorldCells } from "../src/world.js";

/**
 * What a streaming world must never do on a walking frame: build a chunk's pipelines inside the
 * frame that first draws it, and re-send a whole key's records because its draw window moved.
 *
 * Three contracts, measured on a browser walk (111 frames at 20 m/s) whose worst `_renderObjectDirect`
 * calls were one 248 ms chunk's first draw, 23 shadow-proxy draws at up to 18 ms, and 37 draws of
 * 7 ms on a single main batch key.
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
const DT = 1 / 60;
const FOLLOW = {
  x: MIN_X + 1.5 * CELL_SIZE,
  z: MIN_Z + 1.5 * CELL_SIZE,
};

/** Two drawable parts per model, so a shared batch key is not one mesh per asset. */
function model(): Object3D {
  const group = new Group();
  for (let part = 0; part < 2; part += 1)
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

function stubFixtureFetch(pkg: IWorldPackage = manifest): void {
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

/** A renderer that records what it was asked to compile, and when. */
function stubRenderer(): {
  readonly calls: { readonly object: Object3D; readonly attached: boolean }[];
  readonly renderer: IRendererLike;
} {
  const calls: { object: Object3D; attached: boolean }[] = [];
  const renderer = {
    compileAsync: (object: Object3D): Promise<void> => {
      // Whether the chunk was already in the world is the whole claim: a compile that ran after the
      // attach would have been paid by the frame that drew it.
      calls.push({ attached: object.parent !== null, object });
      return Promise.resolve();
    },
    compute: (): void => undefined,
    domElement: {} as HTMLCanvasElement,
    info: {},
    kind: "webgpu",
    raw: {},
    readback: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    render: (): void => undefined,
    renderOverlay: (): void => undefined,
  } as unknown as IRendererLike;
  return { calls, renderer };
}

async function flush(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

function cameraAt(x: number, z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1.7, 0.1, 900);
  camera.position.set(x, 12, z);
  camera.lookAt(x + 60, 0, z);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps settled prewarm counters at zero when an initial main batch first draws late", async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  stubFixtureFetch();
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow: { position: { ...FOLLOW } },
    loadModel: async () => model(),
    prefetchSeconds: 0,
    ring: 0,
    shadows: { cast: false },
    terrain: false,
    bundles: false,
    surface,
    url: "/world/world.json",
  });
  new Group().add(world);
  let settled = false;
  void world.prewarmed.then(() => {
    settled = true;
  });
  try {
    for (let frame = 0; frame < 100 && !settled; frame++) {
      world.update();
      await flush(1);
    }
    expect(settled).toBe(true);
    expect(world.stats().pendingPrewarm).toBe(0);
    const late: InstancedMesh[] = [];
    world.traverse((object) => {
      if (object instanceof InstancedMesh && Reflect.get(object, "casterPrewarmOwed") === true)
        late.push(object);
    });
    expect(late.length).toBeGreaterThan(0);
    for (const mesh of late) {
      Reflect.apply(mesh.onBeforeRender, mesh, []);
      expect(Reflect.get(mesh, "casterPrewarmOwed")).toBe(false);
      expect(world.stats().pendingPrewarm).toBe(0);
    }
  } finally {
    world.dispose();
  }
});

it("keeps late initial draws separate from newly streamed prewarm work", async () => {
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  const initial = manifest.cells.find((cell) => cell.x === 1 && cell.z === 1);
  const distant = manifest.cells.find((cell) => cell.x === 3 && cell.z === 1);
  const rock = manifest.assets.rock;
  if (!initial || !distant || !rock) throw new Error("The fixture needs cells 1:1, 3:1 and rock.");
  stubFixtureFetch({
    ...manifest,
    assets: {
      ...manifest.assets,
      rock: {
        ...rock,
        lods: [{ distance: 10_000, glb: "assets/rock_lod1.glb" }],
      },
    },
    cells: [
      { ...initial, chunks: [], runs: initial.runs.filter((run) => run.asset === "pine") },
      { ...distant, chunks: [], runs: distant.runs.filter((run) => run.asset === "rock") },
    ],
  });
  const follow = { position: { ...FOLLOW } };
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow,
    loadModel: async () => model(),
    prefetchSeconds: 0,
    ring: 1,
    shadows: { cast: false },
    terrain: false,
    bundles: false,
    surface,
    url: "/world/world.json",
  });
  new Group().add(world);
  let settled = false;
  void world.prewarmed.then(() => {
    settled = true;
  });
  try {
    for (let frame = 0; frame < 100 && !settled; frame++) {
      world.update();
      await flush(1);
    }
    expect(settled).toBe(true);
    const late: InstancedMesh[] = [];
    world.traverse((object) => {
      if (object instanceof InstancedMesh && Reflect.get(object, "casterPrewarmOwed") === true)
        late.push(object);
    });
    expect(late.length).toBeGreaterThan(0);
    follow.position.x += CELL_SIZE;
    for (let frame = 0; frame < 100 && world.stats().pendingPrewarm === 0; frame++) {
      world.update();
      await flush(1);
    }
    const pending = world.stats().pendingPrewarm;
    expect(pending).toBeGreaterThan(0);
    for (const mesh of late) {
      expect(Reflect.get(mesh, "casterPrewarmOwed")).toBe(true);
      Reflect.apply(mesh.onBeforeRender, mesh, []);
      expect(world.stats().pendingPrewarm).toBe(pending);
    }
    let newDraws = 0;
    for (let frame = 0; frame < 100 && world.stats().pendingPrewarm > 0; frame++) {
      world.traverse((object) => {
        if (!(object instanceof InstancedMesh) || Reflect.get(object, "casterPrewarmOwed") !== true)
          return;
        const before = world.stats().pendingPrewarm;
        Reflect.apply(object.onBeforeRender, object, []);
        expect(world.stats().pendingPrewarm).toBe(before - 1);
        newDraws += 1;
      });
      if (world.stats().pendingPrewarm === 0) break;
      world.update();
      await flush(1);
    }
    expect(newDraws).toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm).toBe(0);
  } finally {
    world.dispose();
  }
});

describe("a chunk streamed into a walking world", () => {
  it("is compiled before it is attached, with the world's lights as its target scene", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    stubFixtureFetch();
    const follow = { position: { ...FOLLOW } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      loadModel: async () => model(),
      prefetchSeconds: 0,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    // In a scene, because a world nothing projects is a world whose first frame is the first draw.
    new Group().add(world);
    const { calls, renderer } = stubRenderer();
    const camera = cameraAt(follow.position.x, follow.position.z);
    for (let pass = 0; pass < 200; pass += 1) {
      world.update(renderer, camera);
      await flush();
      if (world.getObjectByName("world-chunk") !== undefined) break;
    }
    const chunk = world.getObjectByName("world-chunk");
    if (chunk === undefined) throw new Error("the world never attached a chunk.");

    // It was compiled, once, while it was still the world's to attach: nothing drew it yet, so the
    // pipeline build the census measured at 248 ms was paid by the admission, off the draw thread.
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.map((call) => call.attached)).toEqual(calls.map(() => false));
    // The third argument is the world, not the chunk: three resolves lights, environment and
    // clipping from it, and a compile that saw no lights would build a different pipeline than the
    // frame needs — which is the cost moved rather than removed.
    expect(calls[0]?.object).toBe(chunk);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("gives every chunk's shadow proxies the world's one material per side", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const cell = manifest.cells.find((candidate) => candidate.x === 1 && candidate.z === 1);
    if (cell === undefined) throw new Error("the committed package has no cell 1:1.");
    const paths = ["chunks/yard_1_1.glb", "chunks/yard_2_1.glb"];
    stubFixtureFetch({ ...manifest, cells: [{ ...cell, chunks: paths, runs: [] }] });
    const follow = { position: { ...FOLLOW } };
    // A distinct material per chunk, so "shared" cannot pass by accident on one instance.
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      // Off: what is under test is the chunk's own shadow proxies, and a cell's BundleGroup
      // re-parents a recorded chunk away from the `world-chunk` root they hang under.
      bundles: false,
      follow,
      loadModel: async (url: string) => {
        const material = new MeshBasicMaterial();
        const group = new Group();
        for (let part = 0; part < 2; part += 1) {
          const mesh = new Mesh(new BoxGeometry(2, 2, 2), material);
          mesh.position.set(part * 3, part, 0);
          group.add(mesh);
        }
        void url;
        return group;
      },
      prefetchSeconds: 0,
      ring: 0,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });
    new Group().add(world);
    for (let pass = 0; pass < 200; pass += 1) {
      world.update(undefined, cameraAt(follow.position.x, follow.position.z));
      await flush();
      if (world.children.filter((child) => child.name === "world-chunk").length === paths.length)
        break;
    }
    const chunks = world.children.filter((child) => child.name === "world-chunk");
    expect(chunks.length, "both chunks of the cell").toBe(paths.length);
    const proxies = chunks.map((chunk) => chunk.getObjectByName("world-chunk-shadow") as Mesh);
    for (const proxy of proxies) expect(proxy).toBeDefined();

    // Two chunks, two materials, one side: one depth pipeline for the world rather than one per
    // chunk — which is what 23 shadow draws and an 18 ms worst case were made of. The shared surface
    // is still opaque, non-alphaTest, and carries the side the group was formed by.
    expect(proxies[1]?.material).toBe(proxies[0]?.material);
    expect((proxies[0]?.material as Material).side).toBe(FrontSide);
    expect((proxies[0]?.material as Material).alphaTest).toBe(0);
    expect((proxies[0]?.material as Material).transparent).toBe(false);
    // Each proxy is still its own geometry: only the surface is shared, never the vertices.
    expect(proxies[1]?.geometry).not.toBe(proxies[0]?.geometry);

    // Kept alive while a proxy uses it: the cell's teardown releases every geometry and every
    // material the chunks brought, and the surface the two proxies share is not one of them.
    const shared = proxies[0]?.material as Material;
    const dispose = vi.spyOn(shared, "dispose");
    const geometries = proxies.map((proxy) => vi.spyOn(proxy.geometry, "dispose"));
    follow.position.x += 4 * CELL_SIZE;
    for (let pass = 0; pass < 40 && world.stats().residentKeys.length > 0; pass += 1) {
      world.update(undefined, cameraAt(follow.position.x, follow.position.z));
      await flush();
    }
    expect(world.stats().residentKeys).toEqual([]);
    for (const spy of geometries) expect(spy).toHaveBeenCalled();
    expect(
      dispose,
      "a chunk's teardown released the world's shared proxy material",
    ).not.toHaveBeenCalled();
    // And it goes with the world that owns it, not before.
    world.dispose();
    expect(dispose).toHaveBeenCalled();
  });

  it("uploads only the records a reordering moved, and regrows a key at most logarithmically", async () => {
    stubFixtureFetch();
    const follow = { position: { ...FOLLOW } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      loadModel: async () => model(),
      ring: 2,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });
    new Group().add(world);
    const camera = cameraAt(follow.position.x, follow.position.z);
    // Fill the ring first: the claim under test is what a *reorder* costs, and a frame that also
    // admits a cell writes records of its own however narrow the range is.
    for (let frame = 0; frame < 400; frame += 1) {
      world.update(undefined, camera);
      await flush(1);
      const admission = world.stats().admission;
      if (admission.backlog === 0 && admission.deferred === 0 && world.stats().loadsInFlight === 0)
        break;
    }
    const attribute = new Map<string, InstancedBufferAttribute>();
    const grows = new Map<string, number>();
    // The bytes a frame held before it, so the upload can be checked against what actually changed.
    const before = new Map<string, Float32Array>();
    const missed: string[] = [];
    const narrow: number[] = [];
    const frames = 200;
    const walkFrom = { ...follow.position };
    for (let frame = 0; frame < frames; frame += 1) {
      follow.position.x = walkFrom.x + frame * 0.4;
      follow.position.z = walkFrom.z + frame * 0.15;
      camera.position.set(follow.position.x, 12, follow.position.z);
      camera.lookAt(follow.position.x + 60, 0, follow.position.z);
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      world.update(undefined, camera);
      await flush(1);
      world.traverse((object) => {
        if (!(object instanceof InstancedMesh) || object.count === 0) return;
        const name = object.name;
        const matrix = object.instanceMatrix;
        if (attribute.get(name) !== matrix) {
          attribute.set(name, matrix);
          grows.set(name, (grows.get(name) ?? 0) + 1);
        }
        // Replayed through the rule three's WebGPU backend uses: an empty range list is a whole
        // buffer, and each range is its own writeBuffer.
        const ranges = matrix.updateRanges;
        const array = matrix.array as Float32Array;
        // Every record the frame changed, in elements, and every element the upload covers.
        let changedLow = -1;
        let changedHigh = 0;
        const held = before.get(name);
        // Only the drawn prefix: a record past `mesh.count` is not submitted this frame, and the
        // write that puts one back there touches its own range.
        const drawn = Math.min(object.count * 16, array.length, held?.length ?? array.length);
        if (held !== undefined)
          for (let index = 0; index < drawn; index += 1)
            if (held[index] !== array[index]) {
              if (changedLow < 0) changedLow = index;
              changedHigh = index;
            }
        // An upload that misses a record that moved hands the GPU a matrix the walk has left
        // behind — the failure a narrower range can have and a whole-buffer one cannot.
        if (changedLow >= 0) {
          const low = ranges.length === 0 ? 0 : Math.min(...ranges.map((one) => one.start));
          const high =
            ranges.length === 0
              ? array.length
              : Math.max(...ranges.map((one) => one.start + one.count));
          if (low > changedLow || high <= changedHigh)
            missed.push(`${name} at ${String(changedLow)}`);
          narrow.push(changedHigh - changedLow);
        }
        before.set(name, Float32Array.from(array));
      });
    }
    expect(world.stats().mainCull.repacks, "the walk never moved a window").toBeGreaterThan(0);
    // The bytes that actually moved, and nothing left behind: the upload a reorder asks for is the
    // span it moved, not the key's whole record set.
    expect(missed).toEqual([]);
    expect(narrow.length, "no frame moved a record").toBeGreaterThan(0);
    for (const [name, count] of grows) {
      // One buffer per key, whatever the ring did: a regrow is a new GPUBuffer, a new node and a
      // full upload, and `grow` doubles, so a key's whole life is log2 of its growth at worst.
      const capacity = attribute.get(name)?.count ?? 0;
      expect(count, `${name} regrew`).toBeLessThanOrEqual(
        Math.ceil(Math.log2(Math.max(1, capacity))) + 1,
      );
    }
    world.dispose();
  });
});
