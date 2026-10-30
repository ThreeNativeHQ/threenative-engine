import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Texture,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The loader a world builds for itself, overridable per test. `vi.mock` replaces the named export
 * the constructor calls, which `spyOn` on a namespace cannot reach — an ESM named import is a live
 * read of the module record, and a factory is the one seam that reroutes it.
 */
const internalLoader = vi.hoisted(() => ({ load: undefined as (() => IAssetLoader) | undefined }));
vi.mock("../src/assets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/assets.js")>();
  return {
    ...actual,
    createAssetLoader: (...args: Parameters<typeof actual.createAssetLoader>) =>
      internalLoader.load?.() ?? actual.createAssetLoader(...args),
  };
});

import { type IAssetLoader, createAssetLoader } from "../src/assets.js";
import type { IRendererLike } from "../src/renderer.js";
import { loadModelWith } from "../src/world-cell-models.js";
import { type IWorldPackage, TerrainTiles, WorldCells } from "../src/world.js";

/**
 * The runtime fixture is the committed Phase 2 package. Serving it from disk through a stubbed
 * `fetch` keeps the test on the real contract; the model loader is injected so the GPU/network
 * parts stay out of the lane.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const CELL_SIZE = manifest.cellSize;
const MIN_X = manifest.extent.minX;
const MIN_Z = manifest.extent.minZ;

function cellKey(x: number, z: number): string {
  return `${String(x)}:${String(z)}`;
}

function cellAt(x: number, z: number): { x: number; z: number } {
  return {
    x: Math.floor((x - MIN_X) / CELL_SIZE),
    z: Math.floor((z - MIN_Z) / CELL_SIZE),
  };
}

function cellCenter(x: number, z: number): { x: number; z: number } {
  return { x: MIN_X + (x + 0.5) * CELL_SIZE, z: MIN_Z + (z + 0.5) * CELL_SIZE };
}

function chebyshev(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));
}

function makeModel(): Object3D {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

interface IResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: Headers;
  arrayBuffer: () => Promise<ArrayBuffer>;
  json: () => Promise<unknown>;
}

const notFound: IResponseLike = {
  ok: false,
  status: 404,
  headers: new Headers(),
  arrayBuffer: async () => new ArrayBuffer(0),
  json: async () => ({}),
};

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

function stubFixtureFetch(): { requested: string[] } {
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("world.json"))
        return fileResponse(readFileSync(path.join(fixture, "world.json")));
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return notFound;
    }),
  );
  return { requested };
}

function stubManifestFetch(override: IWorldPackage): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      const body = JSON.stringify(override);
      if (url.endsWith("world.json")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          json: async () => override,
        };
      }
      if (url.endsWith("placements.bin"))
        return fileResponse(readFileSync(path.join(fixture, "placements.bin")));
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return notFound;
    }),
  );
}

/** Every logical path the committed package names, as `world/<relative>`. */
function packageLogicalPaths(pkg: IWorldPackage): string[] {
  const paths = new Set<string>([
    "world/world.json",
    "world/placements.bin",
    `world/${pkg.terrain.heightmap}`,
  ]);
  for (const asset of Object.values(pkg.assets)) {
    paths.add(`world/${asset.glb}`);
    for (const lod of asset.lods ?? []) paths.add(`world/${lod.glb}`);
  }
  for (const cell of pkg.cells) for (const chunk of cell.chunks ?? []) paths.add(`world/${chunk}`);
  return [...paths];
}

/** The name the compile step writes a file under: its content hash in the stem, its kind kept. */
function compiledName(logicalPath: string, bytes: Buffer): string {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
  const dot = logicalPath.lastIndexOf(".");
  return `${logicalPath.slice(0, dot)}.${hash}${logicalPath.slice(dot)}`;
}

/**
 * How many macrotasks a model's bytes take to answer. Above the old fixed drain of 12, so the
 * wait has to be the attachment itself.
 */
const MODEL_LATENCY_TASKS = 24;

/**
 * Serve the package the way the asset pipeline writes it: every file under a content-addressed
 * name, reachable only through `assets.manifest.json`, with the authored names 404ing. A real
 * `Response` carries `headers`, and the loader reads the manifest's content type off it.
 */
function stubCompiledFetch(): { requested: string[] } {
  const served = new Map<string, Buffer>();
  const entries: Record<string, { bytes: number; output: string }> = {};
  for (const logicalPath of packageLogicalPaths(manifest)) {
    const buffer = readFileSync(
      path.join(fixture, ...(logicalPath.slice("world/".length).split("/") as string[])),
    );
    const output = compiledName(logicalPath, buffer);
    entries[logicalPath] = { bytes: buffer.byteLength, output };
    served.set(output, buffer);
  }
  const body = JSON.stringify({ entries, version: 1 });
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("assets.manifest.json")) return fileResponse(Buffer.from(body));
      const buffer = served.get(url);
      // A model's bytes land later than the terrain's, so a chunk attaches after residency is
      // already at 9 and after any fixed number of drained macrotasks. A test that waits a round
      // count instead of the attachment is only green until the schedule shifts under it.
      if (buffer !== undefined && url.endsWith(".glb")) await flush(MODEL_LATENCY_TASKS);
      return buffer === undefined ? notFound : fileResponse(buffer);
    }),
  );
  return { requested };
}

/**
 * A compiled project with its compile step's output deleted: no manifest is served, and the only
 * names that answer are the sources the author left under `assets/`. The authored path 404s, which
 * is exactly the case the loader's second candidate exists for.
 */
function stubSourceDirFetch(): { requested: string[] } {
  const served = new Map<string, Buffer>([
    ["assets/world/world.json", readFileSync(path.join(fixture, "world.json"))],
    ["assets/world/placements.bin", readFileSync(path.join(fixture, "placements.bin"))],
    [
      "assets/world/terrain/heightmap.u16",
      readFileSync(path.join(fixture, "terrain", "heightmap.u16")),
    ],
  ]);
  const requested: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      requested.push(url);
      const buffer = served.get(url);
      return buffer === undefined ? notFound : fileResponse(buffer);
    }),
  );
  return { requested };
}

/** A loader that never settles until `release`, so concurrency can be measured mid-flight. */
interface IGatedLoader {
  readonly probe: { current: number; max: number; total: number };
  readonly load: (url: string) => Promise<Object3D>;
  readonly release: () => void;
}

function gatedLoader(): IGatedLoader {
  const probe = { current: 0, max: 0, total: 0 };
  const waiting: Array<() => void> = [];
  let open = false;
  return {
    probe,
    load: () => {
      probe.total += 1;
      probe.current += 1;
      probe.max = Math.max(probe.max, probe.current);
      return new Promise<Object3D>((resolve) => {
        const settle = (): void => {
          probe.current -= 1;
          resolve(makeModel());
        };
        if (open) settle();
        else waiting.push(settle);
      });
    },
    release: () => {
      open = true;
      for (const settle of waiting.splice(0)) settle();
    },
  };
}

function withChunks(
  cell: IWorldPackage["cells"][number],
  prefix: string,
): IWorldPackage["cells"][number] {
  return {
    ...cell,
    chunks: Array.from(
      { length: 8 },
      (_, index) => `chunks/${prefix}_${String(cell.x)}_${String(cell.z)}_${String(index)}.glb`,
    ),
  };
}

interface IControlledLoader {
  readonly calls: string[];
  holdChunks: boolean;
  readonly chunkCalls: () => number;
  readonly load: (url: string) => Promise<Object3D>;
  readonly resolveChunks: () => void;
}

function controlledLoader(): IControlledLoader {
  const calls: string[] = [];
  const held: Array<(model: Object3D) => void> = [];
  const api: IControlledLoader = {
    calls,
    holdChunks: false,
    chunkCalls: () => calls.filter((url) => url.includes("/chunks/")).length,
    load: (url) => {
      calls.push(url);
      if (api.holdChunks && url.includes("/chunks/"))
        return new Promise<Object3D>((resolve) => held.push(resolve));
      return Promise.resolve(makeModel());
    },
    resolveChunks: () => {
      for (const resolve of held.splice(0)) resolve(makeModel());
    },
  };
  return api;
}

interface ILevelLoader {
  readonly calls: string[];
  readonly load: (url: string) => Promise<Object3D>;
  /** The geometry handed out for the url ending in `fragment`, so a level is provable by identity. */
  readonly geometryFor: (fragment: string) => BufferGeometry;
}

/**
 * One model per url, each carrying a geometry the test can name, so which level a batch drew is
 * proven by the shape it holds rather than by counting meshes. `refuse` is where a broken GLB is
 * simulated.
 */
function levelLoader(refuse: (url: string) => boolean = () => false): ILevelLoader {
  const calls: string[] = [];
  const handed: Array<{ geometry: BufferGeometry; url: string }> = [];
  return {
    calls,
    geometryFor: (fragment) => {
      const entry = handed.find((candidate) => candidate.url.endsWith(fragment));
      if (entry === undefined) throw new Error(`No model was loaded for '${fragment}'.`);
      return entry.geometry;
    },
    load: (url) => {
      calls.push(url);
      if (refuse(url)) return Promise.reject(new Error(`${url} is offline`));
      const group = new Group();
      const geometry = new BoxGeometry(1, 1, 1);
      geometry.name = url;
      handed.push({ geometry, url });
      group.add(new Mesh(geometry, new MeshBasicMaterial()));
      return Promise.resolve(group);
    },
  };
}

/** The cell `1:1` batch of `asset` at `level`, the runtime's own name for it. */
/**
 * The first cluster mesh one asset level and part draws through. A key is one mesh per world-grid
 * square (PRD-458), so this is the first of them rather than the only one.
 */
function levelMesh(
  world: WorldCells,
  asset: string,
  level: number,
  part = 0,
): InstancedMesh | undefined {
  const key = `${asset}:${String(level)}:${String(part)}`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === key) meshes.push(object);
  });
  return meshes[0];
}

/** Instances a shared batch actually draws: a free segment's slots are zero matrices. */
function liveIndices(mesh: InstancedMesh | undefined): number[] {
  if (mesh === undefined) return [];
  const array = mesh.instanceMatrix.array as Float32Array;
  const live: number[] = [];
  for (let index = 0; index < mesh.count; index += 1)
    if (array[index * 16 + 15] !== 0) live.push(index);
  return live;
}

function liveCount(mesh: InstancedMesh | undefined): number {
  return liveIndices(mesh).length;
}

interface IPartLoader {
  readonly calls: string[];
  readonly load: (url: string) => Promise<Object3D>;
  /** The geometry a level's `part` primitive was loaded as, so a part is provable by identity. */
  readonly geometryFor: (fragment: string, part: number) => BufferGeometry;
  readonly materialFor: (fragment: string, part: number) => Material;
}

/**
 * Every model is a tree: one node, one mesh, two primitives — a bark part at the model origin and a
 * needles part 1.5 m up it, which is what three hands back as a `Group` of two child `Mesh`es. The
 * needles part is `transparent`, the way a Blender `BLEND` material arrives.
 */
function treeLoader(
  needles: { alphaTest?: number; map?: Texture; transparent?: boolean } = {},
): IPartLoader {
  const calls: string[] = [];
  const handed = new Map<string, Array<{ geometry: BufferGeometry; material: Material }>>();
  const part = (url: string, index: number): { geometry: BufferGeometry; material: Material } => {
    const parts = handed.get(url);
    const found = parts?.[index];
    if (found === undefined) throw new Error(`No part ${String(index)} was loaded for '${url}'.`);
    return found;
  };
  return {
    calls,
    geometryFor: (fragment, index) => {
      const entry = [...handed.entries()].find(([url]) => url.endsWith(fragment));
      if (entry === undefined) throw new Error(`No model was loaded for '${fragment}'.`);
      return part(entry[0], index).geometry;
    },
    load: (url) => {
      calls.push(url);
      const group = new Group();
      const parts = [0, 1].map((index) => {
        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshBasicMaterial();
        if (index === 1) {
          material.transparent = needles.transparent ?? true;
          if (needles.alphaTest !== undefined) material.alphaTest = needles.alphaTest;
          if (needles.map !== undefined) material.map = needles.map;
        }
        const mesh = new Mesh(geometry, material);
        mesh.position.y = index === 1 ? 1.5 : 0;
        group.add(mesh);
        return { geometry, material };
      });
      handed.set(url, parts);
      return Promise.resolve(group);
    },
    materialFor: (fragment, index) => {
      const entry = [...handed.entries()].find(([url]) => url.endsWith(fragment));
      if (entry === undefined) throw new Error(`No model was loaded for '${fragment}'.`);
      return part(entry[0], index).material;
    },
  };
}

/** Every instance the batches for `asset` draw, paired with how far it is from the follow point. */
function drawnDistances(mesh: InstancedMesh, follow: { x: number; z: number }): number[] {
  const matrix = new Matrix4();
  const distances: number[] = [];
  for (const index of liveIndices(mesh)) {
    mesh.getMatrixAt(index, matrix);
    distances.push(
      Math.hypot(
        (matrix.elements[12] as number) - follow.x,
        (matrix.elements[14] as number) - follow.z,
      ),
    );
  }
  return distances;
}

/** The `TerrainTiles` a `WorldCells` composed, so its residency is observable from the outside. */
function terrainOf(world: WorldCells): TerrainTiles {
  const terrain = world.children.find((child) => child instanceof TerrainTiles);
  if (terrain === undefined) throw new Error("WorldCells composed no TerrainTiles.");
  return terrain;
}

/**
 * A world whose admission has no millisecond ceiling, which is the configuration every assertion in
 * this file was written against: one `update` admits a whole cell, so a test can say what a cell
 * draws after a single step. The bounded budget is a real option with its own contract, and
 * `world-cells-admission.spec.ts` is where that contract is proved.
 */
function loadWorld(options: Parameters<typeof WorldCells.load>[0]): Promise<WorldCells> {
  // Residency tests place the follow point by teleport; prefetch is opted into where it is tested.
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    prefetchSeconds: 0,
    ...options,
  });
}

/** The one surface a batch draws with: an `InstancedMesh` is built from one, unlike a source mesh. */
/** The `alphaTestNode` slot three's node materials carry; the marker of a mip-aware cutout. */
interface NodeMaterialLike {
  alphaTestNode?: unknown;
}

function batchMaterial(mesh: InstancedMesh | undefined): Material {
  const material = mesh?.material;
  if (!(material instanceof Material))
    throw new Error(`No batch mesh named '${mesh?.name ?? "undefined"}'.`);
  return material;
}

/**
 * Every batch mesh the world drew for `asset`'s level and part, across every resident cell and
 * every world-grid cluster that key is split into (PRD-458): one mesh per `key@x,z` now.
 */
function partsOf(
  world: WorldCells,
  asset: string,
  level: number,
  part: number,
): readonly InstancedMesh[] {
  const key = `${asset}:${String(level)}:${String(part)}`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === key) meshes.push(object);
  });
  return meshes;
}

/**
 * The shadow-caster clusters of one key: the meshes alone on `VIRTUAL_SHADOW_CASTER_LAYER`, one per
 * world-grid square of `clusterSize` (PRD-458). The main pass's mesh for the same key is
 * {@link levelMesh}, and it casts nothing.
 */
function clustersOf(world: WorldCells, asset: string, level: number, part = 0): InstancedMesh[] {
  const key = `${asset}:${String(level)}:${String(part)}@`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    // The layer, not the name: the key-wide half of the same split is `key@*` on the wide-caster
    // layer, and it is one mesh per key rather than one per square.
    if (
      object instanceof InstancedMesh &&
      object.name.startsWith(key) &&
      object.layers.mask === 1 << 28
    )
      meshes.push(object);
  });
  return meshes;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let a world's loads settle, then step it again.
 *
 * Adopting a loaded model queues the resident cells' batches instead of building them inside the
 * promise, because a promise callback has no frame to spend a budget in: the step after the load is
 * the one that admits them. A test that has just awaited `flush()` and wants to see what a cell draws
 * steps once more — and with this suite's unbounded budget, one step is all of it.
 */
/**
 * Settles a world: loads resolved and the per-frame admission backlog drained. The admission
 * budget is wall-clock, so on a loaded machine one update may defer work a quiet one finishes;
 * a test asserts what streaming settles to, not what one frame managed.
 */
async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update();
    const stats = world.stats();
    if (stats.admission.backlog === 0 && stats.loadsInFlight === 0) return;
  }
}

function followAt(x: number, z: number): { position: { x: number; z: number } } {
  return { position: { x, z } };
}

/**
 * An `IAssetLoader` whose model loads resolve locally and whose releases are recorded, so a test can
 * see exactly which cache paths a world asks for and hands back. `load` returning `undefined`
 * refuses that path, the shape a level that falls back produces.
 */
function cacheLoader(load: (path: string) => Object3D | undefined = () => makeModel()): {
  assets: IAssetLoader;
  cleared: number[];
  loaded: string[];
  released: string[];
} {
  const loaded: string[] = [];
  const released: string[] = [];
  const cleared: number[] = [];
  const assets: IAssetLoader = {
    audio: () => Promise.reject(new Error("unused")),
    cache: {
      backgroundFill: false,
      bytesOnDisk: 0,
      bytesTotal: 0,
      clear: async () => {
        cleared.push(2);
      },
      enabled: false,
      filling: false,
      hits: 0,
      misses: 0,
      persisted: false,
      reason: "test double",
    },
    clear: () => {
      cleared.push(1);
    },
    dispose: () => undefined,
    prefetch: async () => ({
      requested: 0,
      requestedBytes: 0,
      settled: 0,
      settledBytes: 0,
    }),
    startBackgroundFill: async () => undefined,
    model: ((path: string) => {
      loaded.push(path);
      const model = load(path);
      // `assets.model` hands back a GLTF-ish `{ scene }`, which is what `WorldCells` unwraps.
      return model === undefined
        ? Promise.reject(new Error(`no model for ${path}`))
        : Promise.resolve({ scene: model });
    }) as IAssetLoader["model"],
    progress: { pending: [], requested: 0, requestedBytes: 0, settled: 0, settledBytes: 0 },
    release: (kind, path) => {
      if (kind !== "model") return false;
      released.push(path);
      return true;
    },
    resolve: (path) => Promise.resolve([path]),
    resolved: new Map(),
    texture: () => Promise.reject(new Error("unused")),
  };
  return { assets, cleared, loaded, released };
}

/**
 * Make a {@link cacheLoader} the loader a world builds for itself, by mocking the factory. Only a
 * world-owned loader releases its cache now, so a test proving that release calls this and omits
 * `assets` rather than handing the loader in.
 */
function mockInternalLoader(loader: { assets: IAssetLoader }): void {
  internalLoader.load = () => loader.assets;
}

/** The committed package cut to one cell and its pine run, so one asset is the whole world. */
function pineCell(): IWorldPackage {
  const run = manifest.cells
    .find((cell) => cell.x === 1 && cell.z === 1)
    ?.runs.find((one) => one.asset === "pine");
  if (run === undefined) throw new Error("the committed package has no pine run.");
  return { ...manifest, cells: [{ chunks: [], runs: [run], x: 1, z: 1 }] };
}

/**
 * A shape in the shape a compiled world ships: two attributes over one shared `InterleavedBuffer`,
 * which is what the quantized GLBs the engine streams hand the loader, and one index.
 */
function interleavedGeometry(): BufferGeometry {
  const shared = new InterleavedBuffer(new Float32Array(6 * 5), 5);
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new InterleavedBufferAttribute(shared, 3, 0));
  geometry.setAttribute("uv", new InterleavedBufferAttribute(shared, 2, 3));
  geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 3, 4, 5]), 1));
  return geometry;
}

function interleavedModel(geometry: BufferGeometry): Object3D {
  const group = new Group();
  group.add(new Mesh(geometry, new MeshBasicMaterial()));
  return group;
}

/** The buffer attribute a GPU buffer is keyed by: the shared one, for an interleaved attribute. */
function bufferKey(attribute: BufferAttribute | InterleavedBufferAttribute): object {
  // three patches these in, so `instanceof` is not the test it uses either.
  const interleaved = attribute as Partial<InterleavedBufferAttribute>;
  return interleaved.isInterleavedBufferAttribute === true
    ? (interleaved.data as InterleavedBuffer)
    : attribute;
}

/**
 * Three's WebGPU attribute registry, reduced to what disposing a geometry does to it: every
 * attribute the geometry carries is deleted, and each delete destroys the GPU buffer behind it.
 *
 * `uploaded: false` is what a lost device leaves behind. `Attributes.update` registers the
 * attribute before `createAttribute` runs, so when the upload fails the key is there and the buffer
 * never was — and `destroyAttribute` reads `data.buffer` with no guard, which is the page crash.
 */
function attributeRegistry(
  geometry: BufferGeometry,
  uploaded: boolean,
): { destroys: () => number } {
  const buffers = new Map<object, { buffer?: { destroy: () => void } } | undefined>();
  // What three deletes on a geometry `dispose`: the index, then every attribute the render object
  // used — here the whole interleaved pair.
  const carried: Array<BufferAttribute | InterleavedBufferAttribute> = [
    ...(geometry.index === null ? [] : [geometry.index]),
    ...Object.values(geometry.attributes),
  ];
  let destroys = 0;
  for (const attribute of carried) {
    const key = bufferKey(attribute);
    if (buffers.has(key)) continue;
    buffers.set(
      key,
      uploaded
        ? {
            buffer: {
              destroy: () => {
                destroys += 1;
              },
            },
          }
        : undefined,
    );
  }
  geometry.addEventListener("dispose", () => {
    for (const attribute of carried) {
      const record: { buffer?: { destroy: () => void } } = buffers.get(bufferKey(attribute)) ?? {};
      if (record.buffer === undefined)
        throw new TypeError("Cannot read properties of undefined (reading 'destroy')");
      record.buffer.destroy();
    }
  });
  return { destroys: () => destroys };
}

const surface = new MeshBasicMaterial();
const largeBudgets = {
  residentCells: manifest.cells.length,
  instances: 1_000_000,
  bytes: 1_000_000_000,
};

afterEach(() => {
  internalLoader.load = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells", () => {
  it("streams ahead of a moving follow point and keeps the cell it is in", async () => {
    stubFixtureFetch();
    let clock = 0;
    const start = cellCenter(1, 1);
    const follow = followAt(start.x, start.z);
    const world = await loadWorld({
      admissionNow: () => clock,
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      prefetchSeconds: 1.5,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    // 60 m/s along +x for half a second of 16 ms frames: the lead is ~90 m, most of a cell.
    for (let frame = 0; frame < 30; frame += 1) {
      clock += 16;
      follow.position.x += 60 * 0.016;
      world.update();
    }
    const followCell = Math.floor((follow.position.x - MIN_X) / CELL_SIZE);
    const keys = world.stats().residentKeys;
    const columns = keys.map((key) => Number(key.split(":")[0]));
    expect(Math.max(...columns)).toBeGreaterThan(followCell + 1);
    expect(columns).toContain(followCell);

    // A teleport is not speed: the lead collapses instead of flinging the ring across the map.
    follow.position.x += 1_000;
    clock += 16;
    world.update();
    clock += 16;
    world.update();
    world.dispose();
  });

  it("clears cloned streamed render children on the clone's first update", async () => {
    stubFixtureFetch();
    const start = cellCenter(1, 1);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow: followAt(start.x, start.z),
      loadModel: controlledLoader().load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    await flushed(world);
    const streamed = world.children.find(
      (child) => (child as InstancedMesh).isInstancedMesh === true,
    );
    expect(streamed).toBeDefined();

    const copy = world.clone();
    const copiedStream = copy.children.find(
      (child) => (child as InstancedMesh).isInstancedMesh === true,
    );
    expect(copiedStream).toBeDefined();
    copy.update();
    expect(copy.children).not.toContain(copiedStream);
    expect(world.children).toContain(streamed);
    copy.dispose();
    world.dispose();
  });

  it("creates at most freshMeshesPerUpdate new meshes a frame, and still builds them all", async () => {
    stubFixtureFetch();
    const center = cellCenter(1, 1);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow: followAt(center.x, center.z),
      freshMeshesPerUpdate: 1,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    const meshes = (): number =>
      world.children.filter((child) => (child as InstancedMesh).isInstancedMesh).length;
    world.update();
    await flush();
    const before = meshes();
    world.update();
    // Each new InstancedMesh costs a shader build on WebGPU: one frame may add only one. The
    // prewarm is the one exception and it is a different allowance (`PREWARM_PER_UPDATE`), spent on
    // batches no placement has asked for yet — so the ceiling this measures is the drawn meshes.
    const drawn = (): number =>
      world.children.filter(
        (child) => (child as InstancedMesh).isInstancedMesh && (child as InstancedMesh).count > 0,
      ).length;
    const beforeDrawn = drawn();
    expect(drawn() - beforeDrawn).toBeLessThanOrEqual(1);
    await flushed(world);
    expect(meshes()).toBeGreaterThan(1);
    world.dispose();
  });

  it("draws every cell of an asset part and level through one mesh, whatever the ring", async () => {
    // three builds a shader per InstancedMesh and pays a per-object cost every frame; a mesh per
    // cell made a 25-cell ring thousands of objects. Shared, a walk adds cells, not meshes.
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    const meshes = (): Set<InstancedMesh> => {
      const found = new Set<InstancedMesh>();
      world.traverse((object) => {
        if ((object as InstancedMesh).isInstancedMesh) found.add(object as InstancedMesh);
      });
      return found;
    };
    const walk = [
      { x: 1, z: 1 },
      { x: 2, z: 1 },
      { x: 3, z: 1 },
      { x: 3, z: 2 },
    ];
    for (const cell of walk) {
      const center = cellCenter(cell.x, cell.z);
      follow.position.x = center.x;
      follow.position.z = center.z;
      await flushed(world);
      const now = meshes();
      // Names are asset:level:part — no cell in them — and never repeat.
      const names = [...now].map((mesh) => mesh.name);
      expect(new Set(names).size).toBe(names.length);
      for (const name of names) expect(name.split(":")).toHaveLength(3);
    }
    world.dispose();
  });

  it("keeps exactly the in-ring cells, plus hysteresis, along a scripted path", async () => {
    stubFixtureFetch();
    const ring = 1;
    const follow = followAt(0, 0);
    const loader = controlledLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring,
      surface,
      url: "/world/world.json",
    });

    const path: Array<{ x: number; z: number }> = [
      { x: 1, z: 1 },
      { x: 2, z: 1 },
      { x: 2, z: 2 },
      { x: 1, z: 2 },
      { x: 0, z: 0 },
      { x: 3, z: 3 },
    ];

    let expected = new Set<string>();
    for (const cell of path) {
      const center = cellCenter(cell.x, cell.z);
      follow.position.x = center.x;
      follow.position.z = center.z;
      world.update();

      const followCell = cellAt(center.x, center.z);
      const retained = new Set(
        [...expected].filter((key) => {
          const [x = 0, z = 0] = key.split(":").map(Number);
          return chebyshev({ x, z }, followCell) <= ring + 1;
        }),
      );
      for (const candidate of manifest.cells) {
        if (chebyshev(candidate, followCell) <= ring)
          retained.add(cellKey(candidate.x, candidate.z));
      }
      expected = retained;

      expect(new Set(world.stats().residentKeys)).toEqual(expected);
      await flush();
    }

    world.dispose();
  });

  it("disposes a leaving cell's batches and returns asset refcounts to zero", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const loader = controlledLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flushed(world);

    expect(world.stats().residentKeys).toEqual([cellKey(1, 1)]);
    expect(world.assetRefCounts()).toEqual({ ground_cover: 1, pine: 1, rock: 1 });

    const batches = world.children.filter((child) => child instanceof InstancedMesh);
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();

    expect(world.stats().residentKeys).toEqual([]);
    // The mesh is released from the graph and kept empty for the walk back, so a cell that comes
    // back draws into the same uuid three already built a node for.
    for (const batch of batches) {
      expect(batch.parent).toBeNull();
      expect(batch.count).toBe(0);
    }
    expect(world.assetRefCounts()).toEqual({});
    world.dispose();
  });

  it("never renders a maxDistance instance beyond its distance", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const loader = controlledLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const maxDistance = manifest.assets.ground_cover?.maxDistance as number;
    const matrix = new Matrix4();
    let rendered = 0;
    for (let step = 0; step <= 12; step += 1) {
      follow.position.x = -96 + step * 16;
      follow.position.z = -32;
      world.update();
      await flushed(world);

      world.traverse((object: Object3D) => {
        if (!(object instanceof InstancedMesh) || !object.name.includes("ground_cover")) return;
        for (const index of liveIndices(object)) {
          object.getMatrixAt(index, matrix);
          const elements = matrix.elements;
          const x = elements[12] as number;
          const z = elements[14] as number;
          const distance = Math.hypot(x - follow.position.x, z - follow.position.z);
          expect(distance).toBeLessThanOrEqual(maxDistance + 1e-6);
          rendered += 1;
        }
      });
    }
    expect(rendered).toBeGreaterThan(0);
    world.dispose();
  });

  it("drops a chunk load whose cell left range before it resolved", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const loader = controlledLoader();
    loader.holdChunks = true;
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });

    const chunkCell = cellCenter(0, 2);
    follow.position.x = chunkCell.x;
    follow.position.z = chunkCell.z;
    world.update();
    await flush();
    expect(loader.chunkCalls()).toBeGreaterThan(0);
    expect(world.stats().loadsInFlight).toBeGreaterThan(0);

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();
    expect(world.stats().residentKeys).toEqual([]);
    expect(world.assetRefCounts()).toEqual({});

    loader.resolveChunks();
    await flush();
    expect(world.stats().failures).toBe(0);
    expect(world.stats().loadsInFlight).toBe(0);
    expect(world.getObjectByName("world-chunk")).toBeUndefined();
    world.dispose();
  });

  it("reports cell budget pressure instead of throwing", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const loader = controlledLoader();
    const world = await loadWorld({
      budgets: { residentCells: 2, instances: 1_000_000, bytes: 1_000_000_000 },
      follow,
      loadModel: loader.load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    expect(() => world.update()).not.toThrow();
    expect(world.stats().residentCells).toBe(2);
    expect(world.stats().pressure.cells).toBeGreaterThan(0);
    world.dispose();
  });

  it("rethrows a game's terrain error instead of reporting it as byte pressure", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      createCollider: () => {
        throw new Error("game collider factory failed");
      },
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    expect(() => world.update()).toThrow(/game collider factory failed/u);
    expect(world.stats().pressure.bytes).toBe(0);
    world.dispose();
  });

  it("rethrows a game error that borrows the terrain budget error's name", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      createCollider: () => {
        const error = new Error("game collider factory failed");
        error.name = "TerrainTileBudgetError";
        throw error;
      },
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    expect(() => world.update()).toThrow(/game collider factory failed/u);
    expect(world.stats().pressure.bytes).toBe(0);
    world.dispose();
  });

  it("counts a real terrain byte-budget throw as byte pressure", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      // A 20M-vertex tile cannot fit any byte budget, and the estimate is checked before the tile
      // is built, so the cap fires for real on the tile the camera follows.
      terrain: { tileResolution: 20_000_001 },
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    expect(() => world.update()).not.toThrow();
    expect(world.stats().pressure.bytes).toBe(1);
    world.dispose();
  });

  it("keeps refcounts and geometry consistent when one asset load fails", async () => {
    // Two cells one ring apart, so the second comes into range only after the first load refused.
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells
        .filter((cell) => (cell.x === 0 || cell.x === 2) && cell.z === 0)
        .map((cell) => ({
          ...cell,
          chunks: [],
          runs: cell.runs.filter((run) => run.asset === "pine"),
        })),
    });
    const follow = followAt(0, 0);
    const models: Object3D[] = [];
    let refused = false;
    const load = (url: string): Promise<Object3D> => {
      if (url.includes("pine") && !refused) {
        refused = true;
        return Promise.reject(new Error("pine is offline"));
      }
      const model = makeModel();
      models.push(model);
      return Promise.resolve(model);
    };
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const first = cellCenter(0, 0);
    follow.position.x = first.x;
    follow.position.z = first.z;
    world.update();
    await flush();
    expect(world.stats().failures).toBe(1);

    // The second cell retries the load, and its geometry is what both cells now draw.
    const second = cellCenter(1, 0);
    follow.position.x = second.x;
    follow.position.z = second.z;
    world.update();
    await flush();
    expect(world.stats().residentKeys).toEqual([cellKey(0, 0), cellKey(2, 0)]);
    // Three models for two cells: the refused round took the asset's own shape and released the
    // level that loaded beside it, and the retried round took one model per level. No cell loaded
    // the asset twice.
    expect(models.length).toBe(3);
    const source = (models[1] as Group).children[0] as Mesh;
    const dispose = vi.spyOn(source.geometry, "dispose");

    // Past the hysteresis ring the first cell leaves; the second must keep drawing that geometry.
    const away = cellCenter(3, 0);
    follow.position.x = away.x;
    follow.position.z = away.z;
    world.update();
    await flush();

    expect(world.stats().residentKeys).toEqual([cellKey(2, 0)]);
    expect(world.assetRefCounts()).toEqual({ pine: 1 });
    expect(dispose).not.toHaveBeenCalled();
    world.dispose();
  });

  it("names a refused world load in a TN_WORLD_CELL_FAILURE marker", async () => {
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells
        .filter((cell) => cell.x === 0 && cell.z === 0)
        .map((cell) => ({
          ...cell,
          chunks: [],
          runs: cell.runs.filter((run) => run.asset === "pine"),
        })),
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const follow = followAt(0, 0);
    let refused = false;
    const load = (url: string): Promise<Object3D> => {
      if (url.includes("pine") && !refused) {
        refused = true;
        return Promise.reject(new Error("pine is offline"));
      }
      return Promise.resolve(makeModel());
    };
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(0, 0);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flush();

    const lines = warn.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith("TN_WORLD_CELL_FAILURE"));
    expect(lines[0]).toContain("kind=asset id=pine");
    expect(lines[0]).toContain("pine.glb");
    expect(lines[0]).toContain("message=pine is offline");
    expect(world.stats().failures).toBe(1);
    world.dispose();
  });

  it("rejects a concurrency or refilter cap that could never start a load", async () => {
    stubFixtureFetch();
    for (const option of ["concurrency", "rebuildsPerUpdate", "chunkMergeMaxTriangles"] as const)
      for (const value of [0, -1, 1.5, Number.NaN])
        await expect(
          loadWorld({
            budgets: { residentCells: 9, instances: 1_000_000, bytes: 1_000_000_000 },
            follow: followAt(0, 0),
            loadModel: controlledLoader().load,
            ring: 1,
            surface,
            url: "/world/world.json",
            [option]: value,
          }),
        ).rejects.toThrow(new RegExp(option, "u"));
  });

  it("bounds model loads across every admitted cell, not per cell", async () => {
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells.map((cell) => withChunks(cell, "synth")),
    });
    const follow = followAt(0, 0);
    const gate = gatedLoader();
    const concurrency = 3;
    const world = await loadWorld({
      budgets: largeBudgets,
      concurrency,
      follow,
      loadModel: gate.load,
      ring: 3,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flush();

    expect(world.stats().loadsInFlight).toBe(concurrency);
    expect(world.stats().loadsQueued).toBeGreaterThan(0);
    expect(gate.probe.max).toBeLessThanOrEqual(concurrency);

    gate.release();
    await flush();
    expect(gate.probe.total).toBeGreaterThan(concurrency);
    expect(gate.probe.max).toBeLessThanOrEqual(concurrency);
    expect(world.stats().loadsInFlight).toBe(0);
    expect(world.stats().loadsQueued).toBe(0);
    world.dispose();
  });

  it("skips a queued load whose cell was evicted, without loading or failing", async () => {
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells.map((cell) => ({ ...withChunks(cell, "skip"), runs: [] })),
    });
    const follow = followAt(0, 0);
    const gate = gatedLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      concurrency: 1,
      follow,
      loadModel: gate.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flush();
    const started = gate.probe.total;
    expect(started).toBe(1);
    expect(world.stats().loadsQueued).toBeGreaterThan(0);

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();

    gate.release();
    await flush();
    expect(gate.probe.total).toBe(started);
    expect(world.stats().failures).toBe(0);
    expect(world.stats().loadsInFlight).toBe(0);
    expect(world.stats().loadsQueued).toBe(0);
    world.dispose();
  });

  it("streams a compiled package, every file reached through the asset manifest", async () => {
    const { requested } = stubCompiledFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      ring: 1,
      surface,
      url: "world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    // Drain the world's own work (scatter batches attach here), then wait for the chunk model
    // itself: residency reports 9 before the model attaches, and that gap is however many
    // macrotasks the loader took, so a drained round count alone is not a wait.
    await flushed(world);
    await vi.waitFor(() => {
      expect(world.getObjectByName("world-chunk")).toBeDefined();
    });

    // The models came through the loader too: batches exist, and the one cell carrying a chunk
    // attached it. A model served by an authored name would have 404ed instead.
    expect(world.stats().failures).toBe(0);
    expect(world.stats().residentCells).toBe(9);
    expect(world.getObjectByName("world-chunk")).toBeDefined();
    expect(world.children.filter((child) => child instanceof InstancedMesh).length).toBeGreaterThan(
      0,
    );
    for (const url of requested) expect(url).toMatch(/assets\.manifest\.json$|\.[0-9a-f]{8}\./u);
    world.dispose();
  });

  it("still loads the package from assets/ when the compiled output is gone", async () => {
    // The delete-test: every compiled output is gone, so only the author's `assets/` sources are
    // left to serve the package, and nothing names them.
    const { requested } = stubSourceDirFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      url: "world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flush();

    expect(world.stats().failures).toBe(0);
    expect(world.stats().residentCells).toBe(9);
    // Each file was asked for by its authored name first, 404ed, and then found under `assets/`.
    expect(requested).toEqual([
      "assets.manifest.json",
      "world/world.json",
      "assets/world/world.json",
      "world/placements.bin",
      "assets/world/placements.bin",
      "world/terrain/heightmap.u16",
      "assets/world/terrain/heightmap.u16",
    ]);
    world.dispose();
  });

  it("survives a teardown that throws, and reports it instead of killing the frame", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      // Every model hands back a shape the renderer never finished uploading, so releasing an asset
      // is the page's crash: `TypeError: Cannot read properties of undefined (reading 'destroy')`
      // thrown from inside `update`, on the residency step that has to keep the world streaming.
      loadModel: (): Promise<Object3D> => {
        const geometry = interleavedGeometry();
        attributeRegistry(geometry, false);
        return Promise.resolve(interleavedModel(geometry));
      },
      ring: 0,
      surface,
      url: "/world/world.json",
    });

    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    await flush();
    expect(world.stats().residentKeys).toEqual([cellKey(1, 1)]);
    // Already one: the chunk's shape is released as soon as the merge has baked it into the merged
    // buffers (PRD-458), so its teardown throws here rather than at the eviction below. Counted on
    // the frame it happens, either way — the point is that it is never swallowed.
    expect(world.stats().failures).toBe(1);

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    expect(() => world.update()).not.toThrow();
    expect(world.stats().residentKeys).toEqual([]);
    // Counted, not swallowed: the cell's three asset shapes and its one chunk shape each reported
    // the teardown that threw on the way out.
    expect(world.stats().failures).toBe(4);
    expect(world.assetRefCounts()).toEqual({});
    expect(() => world.dispose()).not.toThrow();
  });

  it("draws a far placement with the package's own lod and a near one with the asset's glb", async () => {
    // The follow point sits on cell (1,1)'s min corner, so the run reaches 83 m past it: past the
    // asset's 60 m lod1 switch and inside its own range. Ring 0 keeps that one cell.
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = levelLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    const lodDistance = manifest.assets.pine?.lods?.[0]?.distance as number;
    const near = levelMesh(world, "pine", 0) as InstancedMesh;
    const far = levelMesh(world, "pine", 1) as InstancedMesh;
    expect(near.geometry).toBe(loader.geometryFor("pine.glb"));
    expect(far.geometry).toBe(loader.geometryFor("pine_lod1.glb"));
    // The whole run, split by each placement's own distance: no placement dropped, none doubled.
    expect(liveCount(near) + liveCount(far)).toBe(85);
    for (const distance of drawnDistances(near, follow.position))
      expect(distance).toBeLessThanOrEqual(lodDistance);
    for (const distance of drawnDistances(far, follow.position))
      expect(distance).toBeGreaterThan(lodDistance);

    // A lod beyond the asset's cull distance can never be drawn, so it is never even asked for.
    expect(loader.calls.some((url) => url.includes("ground_cover_lod1"))).toBe(false);
    world.dispose();
  });

  it("moves a placement's level once the follow point has crossed the switch", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = levelLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);
    expect(liveCount(levelMesh(world, "pine", 1))).toBeGreaterThan(0);

    // The cell centre is 45 m away — past the eighth of the 60 m switch the refilter waits for — and
    // from there every placement in the cell is inside that switch.
    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();

    // The shared lod1 mesh stays for the next cell that needs it; this cell's segment is empty.
    expect(liveCount(levelMesh(world, "pine", 1))).toBe(0);
    const near = levelMesh(world, "pine", 0) as InstancedMesh;
    expect(near.geometry).toBe(loader.geometryFor("pine.glb"));
    expect(liveCount(near)).toBe(85);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("rebuilds nothing when no gate of a far cell's asset can have been crossed", async () => {
    // `pine`'s only gate is its 60 m level switch, and every cell kept here sits 135 m or more from
    // the follow point, so each cell's whole run draws with the lod and no move short of a cell
    // boundary can move a placement across it.
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells
        .filter((cell) => cell.x >= 1 && cell.z >= 1 && !(cell.x === 1 && cell.z === 1))
        .map((cell) => ({
          ...cell,
          chunks: [],
          runs: cell.runs.filter((run) => run.asset === "pine"),
        })),
    });
    const follow = followAt(-96, -96);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 2,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The three cells ring 2 reaches each sit in their own world-grid square (PRD-458), so each one
    // mints its own lod cluster mesh, at two fresh meshes an update. Let the ring finish admitting.
    for (let frame = 0; frame < 60; frame += 1) {
      world.update();
      await flushed(world);
      if (world.stats().residentCells === 3 && world.stats().admission.backlog === 0) {
        if (
          [...world.children].every(
            (child) =>
              !(child instanceof InstancedMesh) || child.count > 0 || child.name.includes(":"),
          )
        )
          break;
      }
    }

    const before = world.stats().rebuilds;
    const meshes = world.children.filter((child) => child instanceof InstancedMesh);
    expect(liveCount(levelMesh(world, "pine", 1))).toBeGreaterThan(0);
    // One main mesh per key for the whole ring, and one caster cluster per resident cell (PRD-458):
    // the shadow half is the per-cell one. The rest are the prewarmed square the follow point is in,
    // one per level and part, minted empty so the walk's first shadow pass builds no node for the
    // key the walk reaches first.
    expect(world.stats().residentCells).toBe(3);
    const live = meshes.filter((mesh) => mesh.count > 0);
    // Shadows are off in this world, so there is no caster half at all and the whole ring is one
    // mesh for the key; a world that asks to cast also gets one caster cluster per resident cell.
    expect(live.map((mesh) => mesh.name)).toEqual(["pine:1:0"]);
    expect(meshes.length).toBeLessThanOrEqual(5);

    // Past the eighth of the 60 m gate the old code refiltered every resident cell, for every
    // asset, on this move alone.
    follow.position.x = -104;
    world.update();

    expect(world.stats().rebuilds).toBe(before);
    expect(world.children.filter((child) => child instanceof InstancedMesh)).toEqual(meshes);
    world.dispose();
  });

  /**
   * The refilter pass runs every 2 m of travel, and at 20 m/s that is ten times a second over every
   * resident cell. It gates the whole cell before it looks at one batch, so a follow point that has
   * crossed nothing walks 256 cells and allocates nothing — the array, the set and the per-batch
   * entry objects the pass used to build per cell are gone, and `refilterEntries` is the counter that
   * says so.
   *
   * A 16 m `cellSize` over the committed extent is 16 × 16 = 256 cells, and the one asset's only gate
   * is its `maxDistance` cull distance at 87.5 km: no cell's own distance bracket can contain it, so
   * the honest answer is nothing stale, ten times a second, over a quarter of a thousand cells.
   */
  it("allocates no refilter entry for 256 cells that crossed no gate", async () => {
    const CELL = 16;
    const side = manifest.extent.sizeX / CELL;
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const run = manifest.cells[1]?.runs.find((one) => one.asset === "pine");
    if (run === undefined) throw new Error("the committed package has no pine run.");
    const cells: Array<IWorldPackage["cells"][number]> = [];
    for (let z = 0; z < side; z += 1)
      for (let x = 0; x < side; x += 1) cells.push({ chunks: [], runs: [run], x, z });
    stubManifestFetch({
      ...manifest,
      assets: {
        ...manifest.assets,
        // No authored `lods`, so the cull distance is the only gate there is, and it is 87.5 km out.
        pine: { bounds: pine.bounds, glb: pine.glb, maxDistance: 100_000 },
      },
      cellSize: CELL,
      cells,
    });
    const follow = followAt(MIN_X + (side / 2) * CELL, MIN_Z + (side / 2) * CELL);
    const world = await loadWorld({
      budgets: { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 256 },
      follow,
      freshMeshesPerUpdate: 4096,
      loadModel: controlledLoader().load,
      prefetchSeconds: 0,
      ring: 8,
      surface,
      url: "/world/world.json",
    });
    world.update();
    for (let frame = 0; frame < 12; frame += 1) await flushed(world);
    expect(world.stats().residentCells).toBe(256);

    const before = world.stats();
    // Ten refilter passes, the cadence a 20 m/s walk gets: each one two metres of travel.
    for (let step = 1; step <= 20; step += 1) {
      follow.position.x += 2;
      world.update();
    }
    const after = world.stats();

    // The pass ran, over the whole resident set, every time — and found nothing to rebuild, so it
    // allocated nothing: no entry objects, no per-cell array, no per-cell set.
    expect(after.refilters - before.refilters).toBeGreaterThanOrEqual(10);
    expect(after.refilterEntries).toBe(before.refilterEntries);
    expect(after.rebuilds).toBe(before.rebuilds);
    // And nothing was queued, dropped or failed: the ring slid 40 m east, so the eastern column of
    // 16 left the package and the ring is the 240 that is left of it.
    expect(after.residentCells).toBe(240);
    expect(after.failures).toBe(0);
    world.dispose();
  });

  it("rebuilds only the cell whose gate the follow point crossed", async () => {
    // Two cells one ring apart, both carrying the culled asset. Cell (1,1) holds the 26.25 m gate
    // in its span; cell (2,1)'s nearest placement is 32 m out and the move only takes it further,
    // so its whole run stays culled either way.
    stubManifestFetch({
      ...manifest,
      cells: manifest.cells
        .filter((cell) => (cell.x === 1 && cell.z === 1) || (cell.x === 2 && cell.z === 1))
        .map((cell) => ({
          ...cell,
          chunks: [],
          runs: cell.runs.filter((run) => run.asset === "ground_cover"),
        })),
    });
    const follow = followAt(-32, -32);
    const loader = levelLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    const near = levelMesh(world, "ground_cover", 0);
    expect(near).toBeDefined();
    expect(world.stats().rebuilds).toBe(0);

    follow.position.x = -45;
    follow.position.z = -45;
    world.update();

    // One cell-asset, the near one: the far cell's placements cannot have changed side of a gate.
    expect(world.stats().rebuilds).toBe(1);
    // The shared mesh is the same object; the near cell's segment was rewritten.
    const rebuilt = levelMesh(world, "ground_cover", 0) as InstancedMesh;
    expect(rebuilt).toBe(near);
    // And it was refiltered from where the follow point is now, not from where it was.
    for (const distance of drawnDistances(rebuilt, follow.position))
      expect(distance).toBeLessThanOrEqual(26.25);
    world.dispose();
  });

  it("refilters at most `rebuildsPerUpdate` cell-assets per update, and finishes them all", async () => {
    stubFixtureFetch();
    const follow = followAt(-32, -32);
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      rebuildsPerUpdate: 1,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);
    expect(world.stats().rebuilds).toBe(0);

    // 20 m east puts the 60 m level switch inside every resident cell's span, so all 27 cell-assets
    // of the ring are stale at once.
    follow.position.x = -12;
    const perUpdate: number[] = [];
    for (let step = 0; step < 60; step += 1) {
      const before = world.stats().rebuilds;
      world.update();
      const done = world.stats().rebuilds - before;
      perUpdate.push(done);
      if (done === 0) break;
    }

    // One per update until the ring is drained, which takes more updates than the cap would allow in
    // one — and the last update is the one that finds nothing left to do.
    expect(perUpdate.length).toBeGreaterThan(3);
    expect(perUpdate.at(-1)).toBe(0);
    expect(perUpdate.slice(0, -1).every((count) => count === 1)).toBe(true);
    // Drained: the stale-but-drawn batches were all replaced, and one more update changes nothing.
    const settled = world.stats().rebuilds;
    world.update();
    expect(world.stats().rebuilds).toBe(settled);
    // And the ring is correct again: nothing culled asset is left drawn past its cull distance.
    const matrix = new Matrix4();
    let drawn = 0;
    world.traverse((object: Object3D) => {
      if (!(object instanceof InstancedMesh) || !object.name.includes("ground_cover")) return;
      for (const index of liveIndices(object)) {
        object.getMatrixAt(index, matrix);
        expect(
          Math.hypot(
            (matrix.elements[12] as number) - follow.position.x,
            (matrix.elements[14] as number) - follow.position.z,
          ),
        ).toBeLessThanOrEqual((manifest.assets.ground_cover?.maxDistance as number) + 1e-6);
        drawn += 1;
      }
    });
    expect(drawn).toBeGreaterThan(0);
    world.dispose();
  });

  it("releases every level's geometry and material when its cell leaves", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = levelLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    const lod0 = vi.spyOn(loader.geometryFor("pine.glb"), "dispose");
    const lod1 = vi.spyOn(loader.geometryFor("pine_lod1.glb"), "dispose");
    const meshes = vi.spyOn(InstancedMesh.prototype, "dispose");
    const retired = world.children.filter((child) => child instanceof InstancedMesh);

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();

    expect(world.stats().residentKeys).toEqual([]);
    expect(lod0).toHaveBeenCalledTimes(1);
    expect(lod1).toHaveBeenCalledTimes(1);
    // A released asset keeps its empty batch for the walk back, so nothing is disposed on the
    // spot; `dispose` on the world is what gives the buffer up.
    for (const mesh of retired) expect(mesh.count).toBe(0);
    expect(meshes).not.toHaveBeenCalled();
    expect(world.assetRefCounts()).toEqual({});
    world.dispose();
    expect(meshes).toHaveBeenCalled();
  });

  /**
   * The world asks `assets.model` for every source level, and the loader caches by logical path. The
   * loader it created itself owns those entries: they are handed back once the last asset naming the
   * path is gone, so a streamed package does not pin the loader's source scenes and their textures
   * for its whole life. A `loadModel` override reaches no cache and owns nothing, and an explicitly
   * supplied loader is the caller's — its cache is never released here.
   */
  describe("model path ownership", () => {
    it("hands back the exact model paths it asked the loader for, and only those", async () => {
      stubManifestFetch(pineCell());
      const loader = cacheLoader();
      mockInternalLoader(loader);
      const { cleared, loaded, released } = loader;
      const follow = followAt(-32, -32);
      const world = await loadWorld({
        budgets: largeBudgets,
        follow,
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);

      // Both of the asset's level paths were requested, and none is handed back while it is held.
      expect(loaded.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);
      expect(released).toEqual([]);

      world.dispose();
      expect(released.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);
      // The loader is never cleared: a path this world did not ask for stays cached.
      expect(cleared).toEqual([]);
    });

    it("holds one cached source for two distinct assets naming it, releasing it only with the last", async () => {
      const pine = manifest.assets.pine;
      if (pine === undefined) throw new Error("the committed package has no pine asset.");
      // One cooked path, two `maxDistance` values: the package's own aliasing keeps them separate,
      // so both assets really do ask the loader for the same cache key.
      const shared = {
        bounds: pine.bounds,
        glb: "assets/pine.glb",
        lods: [{ distance: 60, glb: "assets/pine_lod1.glb" }],
      };
      stubManifestFetch({
        ...manifest,
        assets: {
          pine: { ...shared, maxDistance: 120 },
          pine_b: { ...shared, maxDistance: 200 },
        },
        cells: [
          { chunks: [], runs: [{ asset: "pine", count: 1, offset: 1059 }], x: 0, z: 1 },
          { chunks: [], runs: [{ asset: "pine_b", count: 1, offset: 1059 }], x: 2, z: 1 },
        ],
      });
      const loader = cacheLoader();
      mockInternalLoader(loader);
      const { released } = loader;
      const follow = followAt(-32, -32);
      const world = await loadWorld({
        budgets: largeBudgets,
        follow,
        ring: 1,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);
      expect(Object.keys(world.assetRefCounts()).sort()).toEqual(["pine", "pine_b"]);

      // Cell (0,1) leaves the ring; (2,1) still names the same cooked path, so nothing is released.
      follow.position.x = 96;
      world.update();
      expect(world.stats().residentKeys).toContain("2:1");
      expect(released).toEqual([]);

      // The last holder gone, the path is handed back exactly once.
      world.dispose();
      expect(released.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);
    });

    it("releases the actual requested path of a level the asset fell back over", async () => {
      stubManifestFetch(pineCell());
      const loader = cacheLoader((path) => (path.includes("pine_lod1") ? undefined : makeModel()));
      mockInternalLoader(loader);
      const { released } = loader;
      const follow = followAt(-32, -32);
      const world = await loadWorld({
        budgets: largeBudgets,
        follow,
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);

      // Level 1 was asked for and refused, so level 0's shape draws in its place — but the refused
      // path was requested all the same and is handed back with the asset.
      expect(world.stats().failures).toBe(1);
      expect(released).toEqual([]);
      world.dispose();
      expect(released.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);
    });

    it("leaves the cache untouched when loadModel overrides it", async () => {
      stubManifestFetch(pineCell());
      const { assets, loaded, released } = cacheLoader();
      const follow = followAt(-32, -32);
      const world = await loadWorld({
        assets,
        budgets: largeBudgets,
        follow,
        loadModel: () => Promise.resolve(makeModel()),
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);
      world.dispose();

      expect(loaded).toEqual([]);
      expect(released).toEqual([]);
    });

    /**
     * A caller-supplied loader is the caller's cache: a second game or world holding the same
     * model keeps it alive when this world's last cell stops naming the path. Only the loader this
     * world created itself may have its cache released. The real `createAssetLoader` is used with
     * the standard loader path (no `loadModel` override, which bypasses the retained paths), and
     * the world-local refcount dropping to zero must not dispose the held original's GPU resources.
     */
    it("never releases an explicitly supplied loader's cached model another holder keeps", async () => {
      const oneAsset: IWorldPackage = {
        ...manifest,
        assets: { tree: { bounds: { max: [4, 24, 4], min: [-4, 0, -4] }, glb: "assets/tree.glb" } },
        cells: [{ chunks: [], runs: [{ asset: "tree", count: 1, offset: 1059 }], x: 1, z: 1 }],
      };
      stubManifestFetch(oneAsset);

      const held = makeModel();
      const heldMesh = held.children[0] as Mesh;
      const modelPath = "world/assets/tree.glb";
      const assets = createAssetLoader({
        manifest: "/world/assets.manifest.json",
        model: () => Promise.resolve({ scene: held }),
      });
      // The cached source, as the caller holds it: a game that asked the same loader for the same
      // model before the world ever named it.
      expect(await assets.model<{ scene: Object3D }>(modelPath)).toEqual({ scene: held });
      const originalGeometry = heldMesh.geometry;
      const originalMaterial = heldMesh.material;
      const geometryDisposed = vi.spyOn(originalGeometry, "dispose");
      const materialDisposed = vi.spyOn(originalMaterial as Material, "dispose");

      const follow = followAt(-32, -32);
      const world = await loadWorld({
        assets,
        budgets: largeBudgets,
        follow,
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);
      expect(world.stats().residentCells).toBe(1);

      // The world's last cell leaves: its world-local refcount reaches zero.
      follow.position.x = 100_000;
      follow.position.z = 100_000;
      world.update();
      await flush();
      expect(world.stats().residentKeys).toEqual([]);
      world.dispose();

      // The held original is untouched: an explicitly supplied loader's cache is the caller's.
      expect(geometryDisposed).not.toHaveBeenCalled();
      expect(materialDisposed).not.toHaveBeenCalled();
      expect(heldMesh.geometry).toBe(originalGeometry);
      expect(heldMesh.material).toBe(originalMaterial);

      // The caller's own release is what ends the cache entry, and it still disposes.
      expect(assets.release("model", modelPath)).toBe(true);
      expect(geometryDisposed).toHaveBeenCalled();
      expect(materialDisposed).toHaveBeenCalled();
    });

    it("hands a path back safely when the world leaves before the load settles", async () => {
      stubManifestFetch(pineCell());
      let open: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        open = resolve;
      });
      const loaded: string[] = [];
      const released: string[] = [];
      const assets: IAssetLoader = {
        ...cacheLoader().assets,
        model: ((path: string) => {
          loaded.push(path);
          return ready.then(() => ({ scene: makeModel() }));
        }) as IAssetLoader["model"],
        release: (kind, path) => {
          if (kind !== "model") return false;
          released.push(path);
          return true;
        },
      };
      mockInternalLoader({ assets });
      const follow = followAt(-32, -32);
      const world = await loadWorld({
        budgets: largeBudgets,
        follow,
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      expect(loaded.length).toBeGreaterThan(0);

      // The cell leaves while both level loads are still in flight; the paths are handed back now,
      // and the models that arrive later are torn down rather than adopted.
      follow.position.x = 100_000;
      follow.position.z = 100_000;
      world.update();
      expect(released.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);

      open?.();
      await flushed(world);
      expect(released.sort()).toEqual(["world/assets/pine.glb", "world/assets/pine_lod1.glb"]);
      world.dispose();
    });
  });

  it("falls back to the level above when a lod glb will not load", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = levelLoader((url) => url.includes("pine_lod1"));
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // Counted as one refused load, and the asset is not refused: both levels draw with the asset's
    // own shape, near and far together, and every placement in the run is still there.
    expect(world.stats().failures).toBe(1);
    const lod0 = levelMesh(world, "pine", 0) as InstancedMesh;
    const lod1 = levelMesh(world, "pine", 1) as InstancedMesh;
    expect(lod0.geometry).toBe(loader.geometryFor("pine.glb"));
    expect(lod1.geometry).toBe(loader.geometryFor("pine.glb"));
    expect(liveCount(lod0) + liveCount(lod1)).toBe(85);
    world.dispose();
  });

  it("tears each streamed shape down once, however many cells and batches held it", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const adopted: Array<{ destroys: () => number; disposals: () => number }> = [];
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: (): Promise<Object3D> => {
        const geometry = interleavedGeometry();
        let disposals = 0;
        geometry.addEventListener("dispose", () => {
          disposals += 1;
        });
        const registry = attributeRegistry(geometry, true);
        adopted.push({ destroys: registry.destroys, disposals: () => disposals });
        return Promise.resolve(interleavedModel(geometry));
      },
      ring: 1,
      surface,
      url: "/world/world.json",
    });

    for (const cell of [cellCenter(0, 0), cellCenter(1, 1), cellCenter(2, 2), cellCenter(3, 3)]) {
      follow.position.x = cell.x;
      follow.position.z = cell.z;
      world.update();
      await flush();
    }
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();
    world.dispose();

    // One shape per asset load, several cell batches over each of them, and every load released at
    // the refcount's last decrement — so the count of shapes is the count of loads, and each is torn
    // down once. The registry then sees one pass over it: two destroys on the shared interleaved
    // buffer, which is three's own keying, and one on the index.
    expect(adopted.length).toBeGreaterThan(1);
    for (const shape of adopted) {
      expect(shape.disposals()).toBe(1);
      expect(shape.destroys()).toBe(3);
    }
  });

  it("casts shadows from the near levels and receives them everywhere only when asked", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const plain = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: treeLoader().load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    plain.update();
    await flushed(plain);
    const near = levelMesh(plain, "pine", 0, 0) as InstancedMesh;
    expect(near.castShadow).toBe(false);
    expect(near.receiveShadow).toBe(false);
    plain.dispose();

    const shaded = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: treeLoader().load,
      ring: 0,
      shadows: { cast: true, receive: true },
      surface,
      url: "/world/world.json",
    });
    shaded.update();
    await flushed(shaded);
    // Only the finest level casts by default: a far LOD's shadow is sub-texel and every caster is
    // redrawn per shadow level. The main mesh casts nothing — its records reach the shadow maps
    // through the caster cluster, which is what a level culls (PRD-458).
    expect((levelMesh(shaded, "pine", 0, 0) as InstancedMesh).castShadow).toBe(false);
    expect((levelMesh(shaded, "pine", 1, 0) as InstancedMesh).receiveShadow).toBe(true);
    const casters = clustersOf(shaded, "pine", 0, 0);
    expect(casters.length, "no caster cluster was minted").toBeGreaterThan(0);
    for (const caster of casters) {
      expect(caster.castShadow, "the finest level's caster cluster does not cast").toBe(true);
      expect(caster.layers.mask, "a caster is not alone on the caster layer").toBe(1 << 28);
    }
    expect(clustersOf(shaded, "pine", 1, 0), "a far level minted a caster cluster").toEqual([]);
    const terrain: Mesh[] = [];
    shaded.traverse((object) => {
      // A mesh alone on a caster layer is a shadow-only proxy: it casts, and by construction it
      // receives nothing, exactly as the caster clusters the same test blesses above do.
      if (object.layers.isEnabled(0) === false) return;
      if ((object as Mesh).isMesh && !(object as InstancedMesh).isInstancedMesh)
        terrain.push(object as Mesh);
    });
    expect(terrain.length).toBeGreaterThan(0);
    // Terrain tiles, seam bridges and hand-placed chunks all receive.
    for (const mesh of terrain) expect(mesh.receiveShadow).toBe(true);
    shaded.dispose();

    await expect(
      loadWorld({
        budgets: largeBudgets,
        follow,
        loadModel: treeLoader().load,
        ring: 0,
        shadows: { cast: true, castLevels: 0 },
        surface,
        url: "/world/world.json",
      }),
    ).rejects.toThrow(/castLevels/u);
  });

  it("batches every primitive of a multi-primitive asset, at its own offset and material", async () => {
    // A GLB with several primitives loads as a `Group` of one child `Mesh` per primitive. Batching
    // only the first is what drew 62k trees as bare trunks.
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = treeLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // One batch per (level, part), and the part is named, so a scene dump can tell them apart.
    const bark = levelMesh(world, "pine", 0, 0) as InstancedMesh;
    const needles = levelMesh(world, "pine", 0, 1) as InstancedMesh;
    const farBark = levelMesh(world, "pine", 1, 0) as InstancedMesh;
    const farNeedles = levelMesh(world, "pine", 1, 1) as InstancedMesh;
    expect(bark).toBeDefined();
    expect(needles).toBeDefined();
    expect(farBark).toBeDefined();
    expect(farNeedles).toBeDefined();
    // Each part keeps its own geometry, on both levels. The far level authored its own reduced
    // needles, so it draws them; the root LOD0 card is appended only where a level authored no alpha
    // slot at all, never in place of one the level already carries.
    expect(bark.geometry).toBe(loader.geometryFor("pine.glb", 0));
    expect(needles.geometry).toBe(loader.geometryFor("pine.glb", 1));
    expect(farBark.geometry).toBe(loader.geometryFor("pine_lod1.glb", 0));
    expect(farNeedles.geometry).toBe(loader.geometryFor("pine_lod1.glb", 1));
    expect(farNeedles.geometry).not.toBe(loader.geometryFor("pine.glb", 1));
    // Materials are shared by content: both levels' bark (and both levels' needles) carry the same
    // authored material, so they draw with one surface and three builds one shader for it.
    expect(farBark.material).toBe(bark.material);
    expect(farNeedles.material).toBe(needles.material);
    expect(needles.material).not.toBe(bark.material);
    expect(needles.material).not.toBe(loader.materialFor("pine.glb", 1));
    // Every placement is in both parts, and the whole run is still drawn exactly once per part.
    expect(liveCount(needles)).toBe(liveCount(bark));
    expect(liveCount(farNeedles)).toBe(liveCount(farBark));
    expect(liveCount(bark) + liveCount(farBark)).toBe(85);

    // The needles instance is the placement transformed by the part's own offset in the model, so
    // `placementMatrix * partLocalMatrix` is recoverable from the pair whatever the placement's
    // rotation and scale are.
    const placed = new Matrix4();
    const raised = new Matrix4();
    const local = new Matrix4();
    const expected = new Matrix4().makeTranslation(0, 1.5, 0);
    for (const index of liveIndices(bark)) {
      bark.getMatrixAt(index, placed);
      needles.getMatrixAt(index, raised);
      local.copy(placed).invert().multiply(raised);
      for (let element = 0; element < 16; element += 1)
        expect(local.elements[element]).toBeCloseTo(expected.elements[element] as number, 4);
    }
    world.dispose();
  });

  it("keeps an authored middle level's own reduced cutout and tears each card down once", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    // The LOD1 foliage card sits at 4 m, deliberately different from the root card's 1.5 m, so the
    // far level's transform proves which card it draws: its own authored reduced card, kept as
    // authored, never swapped for the root's. The reduced geometry is its own object.
    const handed = new Map<string, Array<{ geometry: BufferGeometry; material: Material }>>();
    const load = (url: string): Promise<Object3D> => {
      const group = new Group();
      const reduced = url.endsWith("pine_lod1.glb");
      const parts = [0, 1].map((index) => {
        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshBasicMaterial();
        if (index === 1) material.transparent = true;
        const mesh = new Mesh(geometry, material);
        mesh.position.y = index === 1 ? (reduced ? 4 : 1.5) : 0;
        group.add(mesh);
        return { geometry, material };
      });
      handed.set(url, parts);
      return Promise.resolve(group);
    };
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    const forUrl = (fragment: string, part: number): BufferGeometry => {
      const entry = [...handed.entries()].find(([url]) => url.endsWith(fragment));
      if (entry === undefined) throw new Error(`No model loaded for '${fragment}'.`);
      return (entry[1][part] as { geometry: BufferGeometry }).geometry;
    };
    const rootFoliage = forUrl("pine.glb", 1);
    const reducedFoliage = forUrl("pine_lod1.glb", 1);
    const farBark = levelMesh(world, "pine", 1, 0) as InstancedMesh;
    const farNeedles = levelMesh(world, "pine", 1, 1) as InstancedMesh;
    // The far level keeps the opaque bark AND the reduced foliage card it authored: it authored an
    // alpha slot, so no root card is appended and the root's is never drawn at this level.
    expect(farBark.geometry).toBe(forUrl("pine_lod1.glb", 0));
    expect(farNeedles.geometry).toBe(reducedFoliage);
    expect(farNeedles.geometry).not.toBe(rootFoliage);

    // And it draws its own card with the LOD1 transform: `placement * 4`, never the root's 1.5 m.
    const placed = new Matrix4();
    const raised = new Matrix4();
    const local = new Matrix4();
    const expected = new Matrix4().makeTranslation(0, 4, 0);
    for (const index of liveIndices(farBark)) {
      farBark.getMatrixAt(index, placed);
      farNeedles.getMatrixAt(index, raised);
      local.copy(placed).invert().multiply(raised);
      for (let element = 0; element < 16; element += 1)
        expect(local.elements[element]).toBeCloseTo(expected.elements[element] as number, 4);
    }

    // Both cards stay in DRAW and are owned: one teardown of the root card and one of the reduced
    // card, exactly, when the last cell leaves.
    const rootDispose = vi.spyOn(rootFoliage, "dispose");
    const reducedDispose = vi.spyOn(reducedFoliage, "dispose");
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();
    expect(rootDispose).toHaveBeenCalledTimes(1);
    expect(reducedDispose).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("draws a transparent scatter part as a cutout clone, and as authored with `blend`", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = treeLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // An `InstancedMesh` cannot sort its instances, so the BLEND part draws as a cutout: the clone
    // writes depth and discards below the threshold, and the GLB's own material is untouched.
    const needles = batchMaterial(levelMesh(world, "pine", 0, 1));
    const authored = loader.materialFor("pine.glb", 1);
    expect(needles).not.toBe(authored);
    expect(needles.transparent).toBe(false);
    expect(needles.depthWrite).toBe(true);
    expect(needles.alphaTest).toBe(0.5);
    expect(authored.transparent).toBe(true);
    expect(authored.alphaTest).toBe(0);
    // An opaque part draws with an authored material (the first one seen with its content), with
    // no clone made for it.
    const bark = batchMaterial(levelMesh(world, "pine", 0, 0));
    expect(bark.transparent).toBe(false);
    expect(bark.alphaTest).toBe(0);
    world.dispose();

    // A material that already names a cutout point keeps it.
    const thresholded = treeLoader({ alphaTest: 0.25 });
    const second = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: thresholded.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    second.update();
    await flushed(second);
    expect(batchMaterial(levelMesh(second, "pine", 0, 1)).alphaTest).toBe(0.25);
    second.dispose();

    // One clone per asset part, so every cell batch of the asset shares it.
    const ringed = followAt(-32, -32);
    const shared = treeLoader();
    const wide = await loadWorld({
      budgets: largeBudgets,
      follow: ringed,
      loadModel: shared.load,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    wide.update();
    await flushed(wide);
    // Every cell of the ring draws through the one shared mesh and its one cutout. Its shadow twin
    // is a mesh per world-grid cluster, on the caster layer; see the split in `#batchFor`.
    const near = partsOf(wide, "pine", 0, 1);
    expect(near).toHaveLength(1);
    expect(liveCount(near[0] as InstancedMesh)).toBeGreaterThan(0);
    expect(new Set(partsOf(wide, "pine", 0, 1).map((mesh) => mesh.material)).size).toBe(1);
    // Every asset in this package carries the same two materials, so however many GLBs loaded the
    // world draws with two surfaces: one opaque, one cutout. One shader each, not one per asset.
    const drawn = new Set<Material>();
    wide.traverse((object) => {
      if ((object as InstancedMesh).isInstancedMesh)
        drawn.add((object as InstancedMesh).material as Material);
    });
    expect(shared.calls.length).toBeGreaterThan(2);
    expect(drawn.size).toBe(2);
    wide.dispose();

    // `"blend"` keeps the old behaviour: the material as the package authored it, no clone.
    const blended = treeLoader();
    const old = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: blended.load,
      ring: 0,
      surface,
      transparentScatter: "blend",
      url: "/world/world.json",
    });
    old.update();
    await flushed(old);
    const part = batchMaterial(levelMesh(old, "pine", 0, 1));
    // An authored material (shared by content across every asset carrying it), never a cutout twin.
    expect((part as { isNodeMaterial?: boolean }).isNodeMaterial).not.toBe(true);
    expect(part.transparent).toBe(true);
    expect(part.alphaTest).toBe(0);
    old.dispose();

    await expect(
      loadWorld({
        budgets: largeBudgets,
        follow,
        loadModel: blended.load,
        ring: 0,
        surface,
        transparentScatter: "sort" as "blend",
        url: "/world/world.json",
      }),
    ).rejects.toThrow(/transparentScatter/u);
  });

  it("compensates the mip chain on a cutout that has one, leaving an unmapped one plain", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    // A leaf card with a needle map, the shape a tree's `BLEND` part arrives as.
    const map = new Texture();
    map.image = { width: 2048, height: 2048 };
    const loader = treeLoader({ map });
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The cutout is still a cutout — not transparent, depth-writing, the map intact — and it now
    // carries a dynamic `alphaTestNode`, so the mip the fragment lands on decides the cutoff it is
    // compared against instead of a constant 0.5 that discards every needle past mip one.
    const needles = batchMaterial(levelMesh(world, "pine", 0, 1)) as MeshBasicMaterial &
      NodeMaterialLike;
    expect(needles.transparent).toBe(false);
    expect(needles.depthWrite).toBe(true);
    expect(needles.map).toBe(map);
    expect(needles.alphaTest).toBe(0.5);
    expect(needles.alphaTestNode).not.toBeNull();
    expect(Reflect.get(needles, "isNodeMaterial")).toBe(true);
    // The package's own material is untouched, and the authored cutoff still wins where it is named.
    const authored = loader.materialFor("pine.glb", 1) as MeshBasicMaterial;
    expect(authored.transparent).toBe(true);
    expect(authored.alphaTestNode).toBeUndefined();

    const thresholded = treeLoader({ alphaTest: 0.25, map });
    const second = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: thresholded.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    second.update();
    await flushed(second);
    expect((batchMaterial(levelMesh(second, "pine", 0, 1)) as MeshBasicMaterial).alphaTest).toBe(
      0.25,
    );
    second.dispose();
    world.dispose();
  });

  it("leaves a MASK scatter part's authored surface untouched", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    // A needle card with a real map size, arriving the way a GLTF MASK material does: opaque, with an
    // authored cutoff and no `transparent`. The cutout path exists for `transparent` scatter, so a
    // MASK part draws with the surface the package authored, never a clone.
    const map = new Texture();
    map.image = { width: 2048, height: 2048 };
    const loader = treeLoader({ alphaTest: 0.42, map, transparent: false });
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The MASK part keeps the authored surface class: its cutoff, its map, its depth write, and no
    // synthesized `alphaTestNode`.
    const needles = batchMaterial(levelMesh(world, "pine", 0, 1)) as MeshBasicMaterial &
      NodeMaterialLike;
    const authored = loader.materialFor("pine.glb", 1) as MeshBasicMaterial & NodeMaterialLike;
    expect(needles.constructor).toBe(authored.constructor);
    expect(needles.transparent).toBe(false);
    expect(needles.depthWrite).toBe(true);
    expect(needles.map).toBe(map);
    expect(needles.alphaTest).toBe(0.42);
    expect(needles.alphaTestNode).toBeUndefined();
    expect(Reflect.get(needles, "isNodeMaterial")).not.toBe(true);
    // The package's authored MASK material is never mutated.
    expect(authored.transparent).toBe(false);
    expect(authored.alphaTest).toBe(0.42);
    expect(authored.alphaTestNode).toBeUndefined();
    // An OPAQUE part (no `transparent`, no cutoff) still draws with the authored material unchanged.
    const bark = batchMaterial(levelMesh(world, "pine", 0, 0)) as MeshBasicMaterial &
      NodeMaterialLike;
    expect(bark.transparent).toBe(false);
    expect(bark.alphaTest).toBe(0);
    expect(bark.alphaTestNode).toBeUndefined();

    // The authored surface is released exactly once, with the last batch that holds it.
    const disposed = vi.spyOn(needles, "dispose");
    world.dispose();
    expect(disposed).toHaveBeenCalledTimes(1);

    // `blend` keeps the authored MASK surface as well, making no clone.
    const blended = treeLoader({ alphaTest: 0.42, map, transparent: false });
    const old = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: blended.load,
      ring: 0,
      surface,
      transparentScatter: "blend",
      url: "/world/world.json",
    });
    old.update();
    await flushed(old);
    const kept = batchMaterial(levelMesh(old, "pine", 0, 1)) as MeshBasicMaterial &
      NodeMaterialLike;
    expect(kept.transparent).toBe(false);
    expect(kept.alphaTest).toBe(0.42);
    expect(kept.alphaTestNode).toBeUndefined();
    expect(Reflect.get(kept, "isNodeMaterial")).not.toBe(true);
    old.dispose();
  });

  it("releases every part of every level exactly once when its last cell leaves", async () => {
    stubFixtureFetch();
    const follow = followAt(-64, -64);
    const loader = treeLoader();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: loader.load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    const released = [
      vi.spyOn(loader.geometryFor("pine.glb", 0), "dispose"),
      vi.spyOn(loader.geometryFor("pine.glb", 1), "dispose"),
      vi.spyOn(loader.geometryFor("pine_lod1.glb", 0), "dispose"),
      vi.spyOn(loader.geometryFor("pine_lod1.glb", 1), "dispose"),
      // Every surface the batches draw with — shared by content across the two levels, so one
      // bark and one needle cutout — is released once, with the last part that holds it.
      ...new Set(
        [0, 1].flatMap((level) =>
          [0, 1].map((part) => batchMaterial(levelMesh(world, "pine", level, part))),
        ),
      ).values(),
    ].map((target) =>
      target instanceof Object && "dispose" in target
        ? vi.spyOn(target as { dispose: () => void }, "dispose")
        : target,
    );

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();

    expect(world.stats().residentKeys).toEqual([]);
    for (const dispose of released) expect(dispose).toHaveBeenCalledTimes(1);
    expect(world.assetRefCounts()).toEqual({});
    world.dispose();
  });

  it("does not read a raster viewport for a world without terrain", async () => {
    stubFixtureFetch();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow: followAt(0, 0),
      loadModel: async () => new Group(),
      ring: 0,
      surface,
      terrain: false,
      gpuScene: false,
      url: "/world/world.json",
    });
    const renderer = {
      info: { render: { drawCalls: 0 } },
      get domElement() {
        throw new Error("No terrain viewport requested");
      },
      kind: "webgl",
      raw: {},
      compileAsync: vi.fn(async () => undefined),
      uploadAttributes: vi.fn(() => 1),
    } as unknown as IRendererLike;
    try {
      expect(() => world.update(renderer, new PerspectiveCamera())).not.toThrow();
    } finally {
      world.dispose();
    }
  });

  it("meshes terrain tiles at the heightmap's own sample spacing by default", async () => {
    // 64 m tiles over a 2 m heightmap: 33 vertices a side. The fixed 129 interpolated the same
    // samples at 0.5 m and drew 3.01M terrain triangles, 25 ms on an Iris Xe (PRD-762).
    stubFixtureFetch();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow: followAt(0, 0),
      loadModel: async () => new Group(),
      ring: 0,
      surface,
      gpuScene: false,
      url: "/world/world.json",
    });
    try {
      expect(terrainOf(world).tileResolution).toBe(33);
    } finally {
      world.dispose();
    }
  });

  it("passes the resolved props pixel policy and current raster view to settled terrain", async () => {
    stubFixtureFetch();
    const world = await loadWorld({
      budgets: largeBudgets,
      follow: followAt(0, 0),
      loadModel: async () => new Group(),
      ring: 0,
      surface,
      terrain: { tileResolution: 9 },
      autoLod: { maxPixelError: 0.75 },
      gpuScene: false,
      lodHysteresis: 0.2,
      url: "/world/world.json",
    });
    const renderer = {
      info: { render: { drawCalls: 0 } },
      domElement: { height: 720 },
      kind: "webgl",
      raw: {},
      compileAsync: vi.fn(async () => undefined),
      uploadAttributes: vi.fn(() => 1),
    } as unknown as IRendererLike;
    const camera = new PerspectiveCamera(60, 1280 / 720, 0.1, 10_000);
    camera.position.set(0, 0, 4000);
    camera.lookAt(0, 0, 0);
    const terrain = terrainOf(world);
    const follow = vi.spyOn(terrain, "follow");
    const process = vi.spyOn(terrain, "process");
    try {
      world.update(renderer, camera);
      expect(follow.mock.calls[0]?.[2]).toEqual({
        camera,
        viewportHeight: 720,
        maxPixelError: 0.75,
        hysteresis: 0.2,
      });
      await flushed(world);
      for (let frame = 0; frame < 4; frame++) world.update(renderer, camera);
      follow.mockClear();
      process.mockClear();
      renderer.domElement.height = 1440;
      camera.position.z = 2000;
      world.update(renderer, camera);
      expect(follow).not.toHaveBeenCalled();
      expect(process).toHaveBeenCalledOnce();
      expect(process.mock.calls[0]?.[3]).toEqual({
        camera,
        viewportHeight: 1440,
        maxPixelError: 0.75,
        hysteresis: 0.2,
      });
      expect(terrain.residentTileCount).toBe(1);
    } finally {
      world.dispose();
    }
  });

  it("keeps terrain resident at its own radius while the cell ring stays at the ring", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    const ring = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 2,
      surface,
      terrain: { tileResolution: 9 },
      url: "/world/world.json",
    });
    ring.update();
    expect(ring.stats().residentCells).toBe(16);
    expect(terrainOf(ring).residentTileCount).toBe(25);

    // Terrain to the horizon, props at the ring: radius 4 asks for 81 tiles, and the 4 x 4 cell world
    // touches 25 of them. A tile wholly off the map only repeats the edge sample (PRD-762: the MCP
    // snippet's 13 x 13 ring drew 169 tiles over an 8 x 8 tile map).
    const wide = await loadWorld({
      budgets: largeBudgets,
      follow,
      loadModel: controlledLoader().load,
      ring: 2,
      surface,
      terrain: { streamRadius: 4, tileResolution: 9 },
      url: "/world/world.json",
    });
    wide.update();
    const terrain = terrainOf(wide);
    expect(wide.stats().residentCells).toBe(16);
    expect(terrain.residentTileCount).toBe(25);
    // The default `lodDistances` are tile-size multiples, so a wider ring puts its far tiles on the
    // coarse levels instead of drawing 81 tiles at full resolution.
    expect(terrain.getTile("0:0")?.lodLevel).toBe(0);
    expect(terrain.getTile("2:2")?.lodLevel).toBeGreaterThan(0);
    ring.dispose();
    wide.dispose();
  });

  it("gives only the tiles inside `terrain.colliderRadius` a body, and moves that set", async () => {
    stubFixtureFetch();
    const follow = followAt(0, 0);
    const created: string[] = [];
    const disposed: string[] = [];
    const world = await loadWorld({
      budgets: largeBudgets,
      createCollider: ({ key }) => {
        created.push(key);
        return { dispose: () => disposed.push(key) };
      },
      follow,
      loadModel: controlledLoader().load,
      ring: 1,
      surface,
      terrain: { colliderRadius: 0, tileResolution: 9 },
      url: "/world/world.json",
    });
    const terrain = terrainOf(world);
    const center = cellCenter(1, 1);
    follow.position.x = center.x;
    follow.position.z = center.z;
    world.update();
    expect(terrain.residentTileCount).toBe(9);
    expect(terrain.residentColliderKeys).toEqual(["0:0"]);

    // One tile east: the body follows the follow point rather than being fixed at tile creation.
    const east = cellCenter(2, 1);
    follow.position.x = east.x;
    follow.position.z = east.z;
    world.update();
    expect(terrain.residentColliderKeys).toEqual(["1:0"]);
    expect(created).toContain("1:0");
    expect(disposed).toContain("0:0");
    world.dispose();
  });
});

describe("loadModelWith", () => {
  it("selects the named scene when one file carries every level", async () => {
    const near = new Group();
    near.name = "pine";
    const far = new Group();
    far.name = "pine_lod1";
    const model = vi.fn(async () => ({ scene: near, scenes: [near, far] }));
    const loader = {
      model,
      resolve: vi.fn(async () => []),
    } as unknown as IAssetLoader;
    // A package that stores one level per file names no scene and gets the default one.
    expect(await loadModelWith(loader, "models/pine.glb")).toBe(near);
    // A cooked species stores every level in one file; each level selects its own scene.
    expect(await loadModelWith(loader, "models/pine.glb", "pine_lod1")).toBe(far);
    await expect(loadModelWith(loader, "models/pine.glb", "pine_lod9")).rejects.toThrow(
      /'models\/pine\.glb' has no scene 'pine_lod9'/u,
    );
    // Both levels come from the one cached parse: the file is fetched and decoded once.
    expect(model).toHaveBeenCalledTimes(3);
  });
});
