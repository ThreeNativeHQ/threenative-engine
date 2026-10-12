import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  type BufferAttribute,
  type BufferGeometry,
  Group,
  InstancedInterleavedBuffer,
  InstancedMesh,
  type InterleavedBufferAttribute,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Texture,
  Vector3,
} from "three";
import { getCurrentStack, setCurrentStack, stack } from "three/tsl";
import {
  BufferAttributeNode,
  EventNode,
  type Node,
  NodeBuilder,
  type NodeMaterial,
  NodeUpdateType,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The loader a world builds for itself, overridable per test. A world only releases the cache of a
 * loader it created itself, so the owned teardown this file proves routes the real factory loader
 * through this seam rather than passing it in as `assets`.
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
import { RenderCameraCull } from "../src/render-camera-cull.js";
import {
  IMPOSTOR_FAR_CULL_ATTRIBUTE,
  WorldImpostorSurface,
} from "../src/render/world-impostor-surface.js";
import { type IImpostorRawRenderer, WorldImpostorAtlas } from "../src/render/world-impostor.js";
import type { IRendererLike } from "../src/renderer.js";
import { type IWorldAsset, type IWorldRun, cellPlacements } from "../src/world-package.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

// Exercise the installed renderer's actual upload decision; its private module has no declarations.
interface ITestAttributes {
  update(attribute: BufferAttribute | InterleavedBufferAttribute, type: number): void;
}
const { default: ThreeAttributes } = (await import(
  import.meta.resolve("three/src/renderers/common/Attributes.js")
)) as { default: new (backend: object, info: object) => ITestAttributes };
const { AttributeType } = (await import(
  import.meta.resolve("three/src/renderers/common/Constants.js")
)) as { AttributeType: { readonly VERTEX: number } };

function attributeUploads(attribute: BufferAttribute | InterleavedBufferAttribute) {
  const copies: number[][] = [];
  const backend = {
    createAttribute: vi.fn(),
    updateAttribute: vi.fn((written: BufferAttribute | InterleavedBufferAttribute) => {
      copies.push(Array.from(written.array));
    }),
  };
  const attributes = new ThreeAttributes(backend, { createAttribute: vi.fn() });
  const submit = () => attributes.update(attribute, AttributeType.VERTEX);
  submit(); // Initial allocation/upload is required even if nothing changed afterward.
  return { backend, copies, submit };
}

/** Build only the real surface's CPU column bindings, not a GPU shader or a mirrored usage branch. */
function farMatrixRoute(mesh: InstancedMesh) {
  const material = mesh.material as NodeMaterial;
  const body = (
    material.positionNode as unknown as {
      node: { shaderNode: { jsFunc: (inputs: unknown, builder: { object: Object3D }) => Node } };
    }
  ).node.shaderNode.jsFunc;
  const previous = getCurrentStack();
  const scope = stack();
  const columns = new Set<BufferAttributeNode<unknown>>();
  const events = new Set<EventNode>();
  const collect = (node: Node) => {
    if (node instanceof EventNode) events.add(node);
    if (
      node instanceof BufferAttributeNode &&
      node.value instanceof InstancedInterleavedBuffer &&
      node.value.array === mesh.instanceMatrix.array
    )
      columns.add(node);
  };
  setCurrentStack(scope);
  try {
    body([], { object: mesh }).traverse(collect);
    scope.traverse(collect);
  } finally {
    setCurrentStack(previous);
  }
  expect(columns.size).toBe(4);
  // The installed JS base implements attribute setup; its declarations require a shader subclass.
  // No shader generation or renderer/backend method is invoked by this CPU binding setup.
  const AttributeBuilder = NodeBuilder as unknown as new (
    object: InstancedMesh,
    renderer: null,
    parser: null,
  ) => NodeBuilder;
  const builder = new AttributeBuilder(mesh, null, null);
  for (const column of columns) column.setup(builder);
  const attribute = [...columns][0]?.attribute as InterleavedBufferAttribute;
  expect(attribute.data.array).toBe(mesh.instanceMatrix.array);
  expect(events.size).toBe(1);
  const event = [...events][0];
  if (event === undefined) throw new Error("Production far matrix FRAME sync was not observed.");
  expect(event.updateType).toBe(NodeUpdateType.FRAME);
  const sync = () => event.update({} as never);
  sync();
  return { attribute, sync };
}

/**
 * The automatic runtime impostor path, on the real streaming class over the committed package.
 *
 * The model loader is injected, so the only thing under test is WorldCells' own wiring: which asset
 * gets baked, when the terminal level appears, what the far caster draws, and that neither the opt
 * out nor a failed bake touches the source levels. The baker and the surface have their own focused
 * specs; this one proves the integration between them.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

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

/** The committed package, cut to one cell and the pine run inside it, so one asset bakes at a time. */
function pineOnly(): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  return {
    ...manifest,
    assets: { pine },
    cells: manifest.cells
      .filter((cell) => cell.x === 1 && cell.z === 1)
      .map((cell) => ({
        ...cell,
        chunks: [],
        runs: cell.runs.filter((run) => run.asset === "pine"),
      })),
  };
}

/**
 * `count` distinct alpha assets, each one placement, on one cell. Every `glb` is unique, so nothing
 * aliases and each asset wants its own atlas: the shape the cache budget has to hold back.
 */
function manyAlphaAssets(count: number): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  const assets: Record<string, IWorldAsset> = {};
  const runs: IWorldRun[] = [];
  for (let index = 0; index < count; index += 1) {
    const id = `tree_${String(index)}`;
    assets[id] = { bounds: pine.bounds, glb: `assets/tree_${String(index)}.glb` };
    runs.push({ asset: id, count: 1, offset: 0 });
  }
  return {
    ...manifest,
    assets,
    cells: [{ chunks: [], runs, x: 1, z: 1 }],
  };
}

/**
 * Two entries over the SAME cooked LOD0 bytes, with different `lods`/`maxDistance` metadata so the
 * package's own aliasing leaves them separate. The atlas is built from LOD0 alone, so it must still
 * be one bake.
 */
function sameGlbTwoEntries(): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  return {
    ...manifest,
    assets: {
      alpha_a: {
        bounds: pine.bounds,
        glb: "assets/shared_tree.glb",
        lods: [{ distance: 60, glb: "assets/shared_lod1.glb" }],
        maxDistance: 120,
      },
      alpha_b: { bounds: pine.bounds, glb: "assets/shared_tree.glb", maxDistance: 200 },
    },
    cells: [
      {
        chunks: [],
        runs: [
          { asset: "alpha_a", count: 1, offset: 0 },
          { asset: "alpha_b", count: 1, offset: 0 },
        ],
        x: 1,
        z: 1,
      },
    ],
  };
}

function stubManifestFetch(pkg: IWorldPackage): void {
  const body = JSON.stringify(pkg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      if (url.endsWith("world.json")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          json: async () => pkg,
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

interface ITreeLoader {
  readonly load: (url: string) => Promise<Object3D>;
  /** The geometry a level's `part` primitive was loaded as. */
  readonly geometryFor: (part: number) => BufferGeometry;
}

/**
 * Every model is the same two-part tree: a bark box at the model origin and a transparent needles
 * box 1.5 m up it. The needles part is the alpha-cutout foliage the automatic bake exists for.
 */
function treeLoader(): ITreeLoader {
  const handed: Array<{ geometry: BufferGeometry; material: Material }> = [];
  return {
    geometryFor: (part) => {
      const entry = handed[part];
      if (entry === undefined) throw new Error(`No part ${String(part)} was loaded.`);
      return entry.geometry;
    },
    load: () => {
      const group = new Group();
      for (const [index, y] of [0, 1.5].entries()) {
        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshBasicMaterial();
        if (index === 1) material.transparent = true;
        const mesh = new Mesh(geometry, material);
        mesh.position.y = y;
        group.add(mesh);
        handed[index] = { geometry, material };
      }
      return Promise.resolve(group);
    },
  };
}

/**
 * A tree whose bark part sits half a metre up, so part 0's own local is nonidentity. The whole-asset
 * impostor must draw each placement at its root: composing part 0's offset again would lift the far
 * quad by `placement rotation * scale * (0, 0.5, 0)`.
 */
function offsetTreeLoader(): ITreeLoader {
  const handed: Array<{ geometry: BufferGeometry; material: Material }> = [];
  return {
    geometryFor: (part) => {
      const entry = handed[part];
      if (entry === undefined) throw new Error(`No part ${String(part)} was loaded.`);
      return entry.geometry;
    },
    load: () => {
      const group = new Group();
      for (const [index, y] of [0.5, 2].entries()) {
        const geometry = new BoxGeometry(1, 1, 1);
        const material = new MeshBasicMaterial();
        if (index === 1) material.transparent = true;
        const mesh = new Mesh(geometry, material);
        mesh.position.y = y;
        group.add(mesh);
        handed[index] = { geometry, material };
      }
      return Promise.resolve(group);
    },
  };
}

function stubPlacementFetch(pkg: IWorldPackage, records: Float32Array): void {
  const body = JSON.stringify(pkg);
  const bytes = Buffer.from(records.buffer, records.byteOffset, records.byteLength);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<IResponseLike> => {
      const url = String(input);
      if (url.endsWith("world.json")) {
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          json: async () => pkg,
        };
      }
      if (url.endsWith("placements.bin")) return fileResponse(bytes);
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain", "heightmap.u16")));
      return notFound;
    }),
  );
}

function rendererStub(options: { readonly throwOnRender?: boolean } = {}): IRendererLike {
  const raw: IImpostorRawRenderer = {
    autoClear: true,
    getActiveCubeFace: () => 0,
    getActiveMipmapLevel: () => 0,
    getClearAlpha: () => 1,
    getClearColor: (target) => target,
    getMRT: () => null,
    getRenderTarget: () => null,
    // The legitimate seam: the bake only runs on a renderer that declares itself WebGPU and carries
    // the full getter/setter set. A WebGL fallback exposes the first three and is refused; see the
    // unsupported-backend test.
    isWebGPURenderer: true,
    initRenderTarget: () => {},
    render: () => {
      if (options.throwOnRender === true) throw new Error("impostor capture failed");
    },
    setClearAlpha: () => {},
    setClearColor: () => {},
    setMRT: () => {},
    setRenderTarget: () => {},
    xr: { enabled: false },
  } as IImpostorRawRenderer & { isWebGPURenderer: true };
  return {
    compute: (): void => {},
    kind: "webgpu",
    raw,
    readback: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
  } as unknown as IRendererLike;
}

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update();
    const stats = world.stats();
    if (stats.admission.backlog === 0 && stats.loadsInFlight === 0) return;
  }
}

/** The committed package, one cell, one pine, and a loader that hands back the two-part tree. */
async function loadPine(
  loader: ITreeLoader,
  options: Partial<Parameters<typeof WorldCells.load>[0]> = {},
): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets: { bytes: 64 * 1024 * 1024, instances: 50000, residentCells: 25 },
    follow: { position: { x: -32, z: -32 } },
    // Impostors are opt-in (default false); this suite is about them.
    impostors: true,
    loadModel: loader.load,
    prefetchSeconds: 0,
    ring: 1,
    surface: new MeshBasicMaterial(),
    url: "/world/world.json",
    ...options,
  } as Parameters<typeof WorldCells.load>[0]);
}

function partsOf(world: WorldCells, asset: string, level: number, part: number): InstancedMesh[] {
  const key = `${asset}:${String(level)}:${String(part)}`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.name === key) meshes.push(object);
  });
  return meshes;
}

/**
 * A far record's xyz/scale affine block, all-zero on the slots a near run owns. The far mesh keeps a
 * homogeneous `w` of 1 on those collapsed records so `computeBoundingBox` stays finite, so `w` alone
 * no longer separates live from hidden; the affine block does.
 */
function farRecordLive(array: Float32Array, index: number): boolean {
  for (let word = 0; word < 12; word += 1) if (array[index * 16 + word] !== 0) return true;
  return false;
}

/** The live wide casters of one asset, alone on the wide-caster layer, keyed `asset:level:part@*`. */
function liveWideCasters(world: WorldCells, asset: string): InstancedMesh[] {
  const key = `${asset}:`;
  const meshes: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (!(object instanceof InstancedMesh) || !object.name.startsWith(key)) return;
    if (!object.name.endsWith("@*") || object.layers.mask !== 1 << 27) return;
    const array = object.instanceMatrix.array as Float32Array;
    for (let index = 0; index < object.count; index += 1)
      if (array[index * 16 + 15] !== 0) {
        meshes.push(object);
        return;
      }
  });
  return meshes;
}

/** Drive the bake's sixteen views to completion, one per render-cadence update. */
function runBake(world: WorldCells, renderer: IRendererLike): void {
  for (let view = 0; view < 16; view += 1) world.update(renderer);
}

afterEach(() => {
  internalLoader.load = undefined;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells automatic impostors", () => {
  it("bakes an alpha-cutout asset over the render cadence and appends a two-triangle terminal level", async () => {
    stubManifestFetch(pineOnly());
    const loader = treeLoader();
    const world = await loadPine(loader);
    await flushed(world);

    // The source levels are all the asset has until the bake lands.
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "pine", 0, 1).length).toBeGreaterThan(0);

    runBake(world, rendererStub());
    await flushed(world);

    const terminal = partsOf(world, "pine", 2, 0);
    expect(terminal.length).toBeGreaterThan(0);
    const mesh = terminal[0] as InstancedMesh;
    expect(mesh.geometry.index?.count).toBe(6);
    // One part only: no per-bark/needle duplicate at the terminal level.
    expect(partsOf(world, "pine", 2, 1).length).toBe(0);
    // The full source stays: far levels draw it until the impostor switch.
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "pine", 0, 1).length).toBeGreaterThan(0);

    // The proving numbers: one asset landed, nothing pending, one two-triangle terminal, and the
    // atlas charged against the world's own budget.
    const impostor = world.stats().impostor;
    expect(impostor.assets).toBe(1);
    expect(impostor.pending).toBe(0);
    expect(impostor.terminalTriangles).toBe(2);
    expect(impostor.atlasBytes).toBe(2_796_160);
    // The bake is independent of the GPU-driven main pass: this renderer is WebGPU but carries no
    // GPU-scene features, so the scene stays off while the atlas still lands on the CPU path.
    expect(world.stats().gpuScene.on).toBe(false);
    world.dispose();
  });

  it("keeps the source levels and appends nothing when impostors are opted out", async () => {
    stubManifestFetch(pineOnly());
    const loader = treeLoader();
    const world = await loadPine(loader, { impostors: false });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);

    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    world.dispose();
  });

  it("bakes nothing by default: the source levels stay the forest's shadow casters", async () => {
    stubManifestFetch(pineOnly());
    const loader = treeLoader();
    const world = await loadPine(loader, { impostors: undefined });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);

    expect(world.stats().impostor.atlasBytes).toBe(0);
    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    world.dispose();
  });

  it("keeps the source levels when a bake fails, and counts the failure", async () => {
    stubManifestFetch(pineOnly());
    const loader = treeLoader();
    const world = await loadPine(loader);
    await flushed(world);
    runBake(world, rendererStub({ throwOnRender: true }));
    await flushed(world);

    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(world.stats().failures).toBeGreaterThan(0);
    world.dispose();
  });

  it("cancels the bake, drops the queue and keeps the source when the renderer has no bake seam", async () => {
    stubManifestFetch(pineOnly());
    const world = await loadPine(treeLoader());
    await flushed(world);
    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");

    // A renderer that exists but carries none of the layered capture seam — the answer a native host
    // or a stripped backend gives. The bake must not wait forever behind it: the in-flight atlas is
    // released, the reservation cleared, and the asset keeps its source levels.
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: {},
    } as unknown as IRendererLike;
    world.update(renderer);
    await flushed(world);

    const impostor = world.stats().impostor;
    expect(impostor.assets).toBe(0);
    expect(impostor.pending).toBe(0);
    expect(impostor.atlasBytes).toBe(0);
    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "pine", 0, 1).length).toBeGreaterThan(0);
    // The one atlas the refused bake had allocated is disposed, not leaked.
    expect(dispose).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("refuses a WebGL backend that carries the three capture methods and falls back to source", async () => {
    stubManifestFetch(pineOnly());
    const world = await loadPine(treeLoader());
    await flushed(world);
    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");

    // A WebGL fallback carries `render`/`setRenderTarget`/`initRenderTarget`, so a method-shape test
    // alone would accept it and then fail on the layered MRT capture it cannot run. It backends as
    // webgl2 and its raw object is not a WebGPURenderer, so it must be classified unsupported: the
    // in-flight atlas is released, the reservation cleared, and the source levels kept.
    const renderer = {
      compute: (): void => {},
      kind: "webgl2",
      raw: {
        autoClear: true,
        getActiveCubeFace: () => 0,
        getActiveMipmapLevel: () => 0,
        getClearAlpha: () => 1,
        getClearColor: (target: unknown) => target,
        getMRT: () => null,
        getRenderTarget: () => null,
        initRenderTarget: () => {},
        render: () => {},
        setClearAlpha: () => {},
        setClearColor: () => {},
        setMRT: () => {},
        setRenderTarget: () => {},
        xr: { enabled: false },
      },
    } as unknown as IRendererLike;
    world.update(renderer);
    await flushed(world);

    const impostor = world.stats().impostor;
    expect(impostor.assets).toBe(0);
    expect(impostor.pending).toBe(0);
    expect(impostor.atlasBytes).toBe(0);
    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "pine", 0, 1).length).toBeGreaterThan(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("refuses a WebGPU renderer that wrapped the WebGL fallback backend", async () => {
    stubManifestFetch(pineOnly());
    const world = await loadPine(treeLoader());
    await flushed(world);
    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");

    // A `WebGPURenderer` on the WebGL fallback reports `kind: 'webgpu'` and `isWebGPURenderer` and
    // carries every capture method, but its backend is the one that cannot do layered MRT. The bake
    // must settle as unsupported rather than fail mid-frame and leak the atlas.
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: {
        autoClear: true,
        backend: { isWebGLBackend: true },
        getActiveCubeFace: () => 0,
        getActiveMipmapLevel: () => 0,
        getClearAlpha: () => 1,
        getClearColor: (target: unknown) => target,
        getMRT: () => null,
        getRenderTarget: () => null,
        initRenderTarget: () => {},
        isWebGPURenderer: true,
        render: () => {},
        setClearAlpha: () => {},
        setClearColor: () => {},
        setMRT: () => {},
        setRenderTarget: () => {},
        xr: { enabled: false },
      },
    } as unknown as IRendererLike;
    world.update(renderer);
    await flushed(world);

    const impostor = world.stats().impostor;
    expect(impostor.assets).toBe(0);
    expect(impostor.pending).toBe(0);
    expect(impostor.atlasBytes).toBe(0);
    expect(partsOf(world, "pine", 2, 0).length).toBe(0);
    expect(partsOf(world, "pine", 0, 0).length).toBeGreaterThan(0);
    expect(dispose).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("draws one wide representation per placement, never a per-part trunk or needle fallback", async () => {
    stubManifestFetch(pineOnly());
    const loader = treeLoader();
    const world = await loadPine(loader, { shadows: { cast: true, castLevels: 3 } });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);

    // The terminal level exists and carries the impostor quad...
    expect(partsOf(world, "pine", 2, 0).length).toBeGreaterThan(0);
    // ...and every live wide caster draws that one two-triangle whole-asset shape, never the source
    // box a per-part fallback would leave behind, and never a second part's copy.
    const wide = liveWideCasters(world, "pine");
    expect(wide.length).toBeGreaterThan(0);
    for (const mesh of wide) {
      expect(mesh.geometry.index?.count).toBe(6);
      // The whole-asset wide mesh's surface is the one the shadow node keeps in its coarse levels,
      // so every one of them carries the marker; see `virtual-shadow.ts` `#probe`.
      expect((mesh.material as Material).userData.tnWholeAssetImpostor).toBe(true);
    }
    // The ordinary alpha source card is not the whole-asset silhouette and takes no marker.
    const alphaMain = partsOf(world, "pine", 0, 1)[0];
    expect(
      (alphaMain?.material as Material | undefined)?.userData.tnWholeAssetImpostor,
    ).toBeUndefined();
    world.dispose();
  });

  it("keeps every authored level's part at its own index and never duplicates part 0 in the wide shadow", async () => {
    // The root LOD0 has its alpha needles FIRST, then two opaque parts, and the two middle levels each
    // have one opaque part. In-place coverage keeps each level's own part count and index; the wide
    // half must draw this entry's own part shape for the alpha slot and for a part the terminal has no
    // counterpart for, never the terminal's part 0 (the old append-and-fallback duplicated it).
    const base = new BoxGeometry(1, 1, 1, 2, 2, 2);
    const opaqueA = new BoxGeometry(1, 1, 1);
    const opaqueB = new BoxGeometry(1, 1, 1, 4, 4, 4);
    const mid = new BoxGeometry(1, 1, 1, 8, 8, 8);
    const far = new BoxGeometry(1, 1, 1, 16, 16, 16);
    const load = (url: string): Promise<Object3D> => {
      const group = new Group();
      if (url.includes("mid")) {
        group.add(new Mesh(mid, new MeshBasicMaterial()));
        return Promise.resolve(group);
      }
      if (url.includes("far")) {
        group.add(new Mesh(far, new MeshBasicMaterial()));
        return Promise.resolve(group);
      }
      const alpha = new MeshBasicMaterial();
      alpha.transparent = true;
      const needles = new Mesh(base, alpha);
      needles.position.y = 2;
      group.add(needles);
      group.add(new Mesh(opaqueA, new MeshBasicMaterial()));
      const second = new Mesh(opaqueB, new MeshBasicMaterial());
      second.position.y = 1;
      group.add(second);
      return Promise.resolve(group);
    };
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const pkg: IWorldPackage = {
      ...manifest,
      assets: {
        tree: {
          bounds: pine.bounds,
          glb: "assets/tree-base.glb",
          lods: [
            { distance: 60, glb: "assets/tree-mid.glb" },
            { distance: 120, glb: "assets/tree-far.glb" },
          ],
          maxDistance: 300,
        },
      },
      cells: [{ chunks: [], runs: [{ asset: "tree", count: 1, offset: 0 }], x: 1, z: 1 }],
    };
    // One placement at the origin, unit scale, within the 60 m first gate, so it draws LOD0.
    const records = new Float32Array([0, 0, 0, 0, 0, 0, 1, 1]);
    stubPlacementFetch(pkg, records);
    const world = await loadPine(
      { geometryFor: () => base, load },
      { impostors: false, shadows: { cast: true, castLevels: 3 } },
    );
    await flushed(world);

    // Settle the prewarm and the deferred swaps: `flushed` only waits on admission, and this asset's
    // builds land on later updates once the prewarm allowance has been spent.
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const wide = liveWideCasters(world, "tree");
    const alphaSlot = wide.find((mesh) => mesh.name === "tree:0:0@*");
    const outOfRange = wide.find((mesh) => mesh.name === "tree:0:2@*");
    // This asset never baked an impostor, so its wide casters are ordinary ones with no marker: the
    // exemption is opt-in per whole-asset material, never a blanket alpha exemption.
    expect(
      (alphaSlot?.material as Material | undefined)?.userData.tnWholeAssetImpostor,
    ).toBeUndefined();
    expect(
      (outOfRange?.material as Material | undefined)?.userData.tnWholeAssetImpostor,
    ).toBeUndefined();
    const alphaMain = partsOf(world, "tree", 0, 0)[0];
    const lastMain = partsOf(world, "tree", 0, 2)[0];
    if (alphaMain === undefined || lastMain === undefined)
      throw new Error("the tree's LOD0 main parts were not built.");
    // The alpha slot draws the root cutout, not the terminal's part 0 (an opaque box).
    expect(alphaSlot?.geometry).toBe(alphaMain.geometry);
    // The part the terminal has no counterpart for draws its own shape, not part 0's duplicate.
    expect(outOfRange?.geometry).toBe(lastMain.geometry);
    expect(outOfRange?.geometry).not.toBe(far);
    world.dispose();
  });

  it("installs every root alpha part at a middle level authored with none or fewer", async () => {
    // Root LOD0: two alpha cutouts at nonidentity locals (y=2, y=4) and one opaque bark at y=0. The
    // middle LOD1 authors ZERO cutout slots (one opaque only); the far LOD2 authors FEWER than the
    // root (one reduced card plus two opaques), so the per-level part counts are deliberately not
    // equal. Coverage must append ONLY the missing root cards — both at the middle, just the second
    // at the far — each with the root's own local and material, while keeping the far's own reduced
    // card and every level's own opaque reduction. One placement sits in each level's band, so the
    // middle and the far are actually selected.
    const alphaA = new BoxGeometry(1, 1, 1, 2, 2, 2);
    const alphaB = new BoxGeometry(1, 1, 1, 3, 3, 3);
    const rootBark = new BoxGeometry(1, 1, 1, 4, 4, 4);
    const midOpaque = new BoxGeometry(1, 1, 1, 5, 5, 5);
    const farOpaque = new BoxGeometry(1, 1, 1, 6, 6, 6);
    const farOpaque2 = new BoxGeometry(1, 1, 1, 8, 8, 8);
    const reducedAlpha = new BoxGeometry(1, 1, 1, 7, 7, 7);
    const load = (url: string): Promise<Object3D> => {
      const group = new Group();
      const add = (geometry: BufferGeometry, local: number, alpha: boolean): void => {
        const material = new MeshBasicMaterial();
        if (alpha) material.transparent = true;
        const mesh = new Mesh(geometry, material);
        mesh.position.y = local;
        group.add(mesh);
      };
      if (url.includes("mid")) add(midOpaque, 0.5, false);
      else if (url.includes("far")) {
        add(reducedAlpha, 9, true);
        add(farOpaque, 0.25, false);
        add(farOpaque2, 0.75, false);
      } else {
        add(alphaA, 2, true);
        add(alphaB, 4, true);
        add(rootBark, 0, false);
      }
      return Promise.resolve(group);
    };
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const pkg: IWorldPackage = {
      ...manifest,
      assets: {
        tree: {
          bounds: pine.bounds,
          glb: "assets/tree-base.glb",
          lods: [
            { distance: 60, glb: "assets/tree-mid.glb" },
            { distance: 120, glb: "assets/tree-far.glb" },
          ],
          maxDistance: 400,
        },
      },
      cells: [{ chunks: [], runs: [{ asset: "tree", count: 3, offset: 0 }], x: 1, z: 1 }],
    };
    // One placement per level, from the follow point at (-32,-32): 0 m (LOD0), 80 m (LOD1),
    // 150 m (LOD2), all inside the 400 m cull.
    const records = new Float32Array([
      -32, 0, -32, 0, 0, 0, 1, 1, 48, 0, -32, 0, 0, 0, 1, 1, 118, 0, -32, 0, 0, 0, 1, 1,
    ]);
    stubPlacementFetch(pkg, records);
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine({ geometryFor: () => alphaA, load }, { follow, impostors: false });
    await flushed(world);
    for (let pass = 0; pass < 40; pass += 1) world.update();

    const meshAt = (level: number, part: number): InstancedMesh | undefined =>
      partsOf(world, "tree", level, part)[0] as InstancedMesh | undefined;
    const geometryAt = (level: number, part: number): BufferGeometry | undefined =>
      meshAt(level, part)?.geometry;
    const translationAt = (level: number, part: number): [number, number, number] => {
      const mesh = meshAt(level, part);
      if (mesh === undefined)
        throw new Error(`tree:${String(level)}:${String(part)} was not built.`);
      const array = mesh.instanceMatrix.array as Float32Array;
      for (let index = 0; index < mesh.count; index += 1)
        if (array[index * 16 + 15] !== 0)
          return [
            array[index * 16 + 12] as number,
            array[index * 16 + 13] as number,
            array[index * 16 + 14] as number,
          ];
      throw new Error(`tree:${String(level)}:${String(part)} has no live instance.`);
    };
    const liveAt = (level: number, part: number): number => {
      const mesh = meshAt(level, part);
      if (mesh === undefined) return 0;
      const array = mesh.instanceMatrix.array as Float32Array;
      let live = 0;
      for (let index = 0; index < mesh.count; index += 1)
        if (array[index * 16 + 15] !== 0) live += 1;
      return live;
    };

    // LOD0: two alpha cards and the opaque bark, one placement.
    expect(geometryAt(0, 0)).toBe(alphaA);
    expect(geometryAt(0, 1)).toBe(alphaB);
    expect(geometryAt(0, 2)).toBe(rootBark);
    // The middle authored no cutout slot at all, so both root cards are appended after its opaque.
    expect(geometryAt(1, 0)).toBe(midOpaque);
    expect(geometryAt(1, 1)).toBe(alphaA);
    expect(geometryAt(1, 2)).toBe(alphaB);
    // The far authored one reduced card and two opaques: it keeps its own card at part 0 and the
    // root's second card is appended for the slot it has none of — four parts, its own count plus the
    // one fallback, unlike the middle's three.
    expect(geometryAt(2, 0)).toBe(reducedAlpha);
    expect(geometryAt(2, 1)).toBe(farOpaque);
    expect(geometryAt(2, 2)).toBe(farOpaque2);
    expect(geometryAt(2, 3)).toBe(alphaB);
    // The far's own reduced card is drawn only at the far, where it authored it; nothing replaces an
    // authored alpha slot with the root's, so the root's first card is never at the far level.
    expect(geometryAt(0, 0)).not.toBe(reducedAlpha);
    expect(geometryAt(1, 1)).not.toBe(reducedAlpha);
    expect(geometryAt(2, 0)).not.toBe(alphaA);

    // The root cards draw with the root's own nonidentity locals wherever they fall back, composed by
    // the placement: y=2 for alphaA and y=4 for alphaB. The far's own card keeps its authored y=9.
    expect(translationAt(1, 1)).toEqual([48, 2, -32]);
    expect(translationAt(1, 2)).toEqual([48, 4, -32]);
    expect(translationAt(2, 0)).toEqual([118, 9, -32]);
    expect(translationAt(2, 3)).toEqual([118, 4, -32]);

    // Every level's own opaque reduction is the placement's, and the materials are the root cards'.
    expect(translationAt(1, 0)).toEqual([48, 0.5, -32]);
    expect(translationAt(2, 1)).toEqual([118, 0.25, -32]);
    expect(translationAt(2, 2)).toEqual([118, 0.75, -32]);
    const rootAlphaMaterial = (meshAt(0, 0) as InstancedMesh).material;
    expect((meshAt(1, 1) as InstancedMesh).material).toBe(rootAlphaMaterial);
    expect((meshAt(2, 3) as InstancedMesh).material).toBe(rootAlphaMaterial);

    // Cardinality: each placement draws exactly one level's parts. alphaA is the root's first card,
    // appended only to the middle (the far authored its own slot 0), so it is live at LOD0 and LOD1.
    // alphaB is the slot missing at both the middle and the far, so it is live at all three levels.
    // The far's own reduced card is live exactly once, only where it authored it.
    expect(liveAt(0, 0) + liveAt(1, 1)).toBe(2);
    expect(liveAt(0, 1) + liveAt(1, 2) + liveAt(2, 3)).toBe(3);
    expect(liveAt(2, 0)).toBe(1);

    // The replaced reduced card is released once; the root cards are shared by every level and are
    // released once too, not once per level.
    const rootADispose = vi.spyOn(alphaA, "dispose");
    const rootBDispose = vi.spyOn(alphaB, "dispose");
    const reducedDispose = vi.spyOn(reducedAlpha, "dispose");
    const midDispose = vi.spyOn(midOpaque, "dispose");
    const farDispose = vi.spyOn(farOpaque, "dispose");
    const farDispose2 = vi.spyOn(farOpaque2, "dispose");
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flush();
    expect(rootADispose).toHaveBeenCalledTimes(1);
    expect(rootBDispose).toHaveBeenCalledTimes(1);
    expect(reducedDispose).toHaveBeenCalledTimes(1);
    expect(midDispose).toHaveBeenCalledTimes(1);
    expect(farDispose).toHaveBeenCalledTimes(1);
    expect(farDispose2).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("draws one whole-asset wide mesh per placement across every source level at the exact root", async () => {
    // A bark part lifted half a metre (nonidentity part0.local) and four placements spanning two
    // source LODs (one at LOD0, two at the authored LOD1) at scales 0.5/1/8 and a mirrored -1. The
    // far quad is one whole-asset representation per placement, so after the bake there is exactly
    // one global wide mesh holding every placement once at its root — never a per-level duplicate
    // and never the part0 offset composed a second time.
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const pkg: IWorldPackage = {
      ...manifest,
      assets: {
        prop: {
          bounds: pine.bounds,
          glb: "assets/prop.glb",
          lods: [{ distance: 5, glb: "assets/prop-lod1.glb" }],
          maxDistance: 400,
        },
      },
      cells: [{ chunks: [], runs: [{ asset: "prop", count: 4, offset: 0 }], x: 1, z: 1 }],
    };
    // x, y, z, quaternion, uniform scale: one at the follow point (LOD0), two in the authored LOD1
    // band, and a mirrored one, all inside the cull.
    const records = new Float32Array([
      -32, 0, -32, 0, 0, 0, 1, 0.5, -32, 0, -17, 0, 0, 0, 1, 1, 18, 0, -32, 0, 0, 0, 1, 8, -20, 0,
      -20, 0, 0, 0, 1, -1,
    ]);
    stubPlacementFetch(pkg, records);
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine(offsetTreeLoader(), {
      follow,
      shadows: { cast: true, castLevels: 3 },
    });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    // Settle the handoff: the pre-bake per-level wide casters empty and retire over updates.
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const expected = [
      [-32, 0, -32, 0.5],
      [-32, 0, -17, 1],
      [18, 0, -32, 8],
      [-20, 0, -20, -1],
    ].map(([x, y, z, scale]) =>
      new Matrix4().compose(
        new Vector3(x, y, z),
        new Quaternion(0, 0, 0, 1),
        new Vector3(scale, scale, scale),
      ),
    );
    const liveMatrices = (mesh: InstancedMesh): Float32Array[] => {
      const array = mesh.instanceMatrix.array as Float32Array;
      const out: Float32Array[] = [];
      for (let index = 0; index < mesh.count; index += 1)
        if (array[index * 16 + 15] !== 0) out.push(array.slice(index * 16, index * 16 + 16));
      return out;
    };

    const wide = liveWideCasters(world, "prop");
    expect(wide.length).toBe(1);
    const wideMesh = wide[0] as InstancedMesh;
    // Every placement once, in the one mesh: the original cardinality, not one per part or level.
    const live = liveMatrices(wideMesh);
    expect(live.length).toBe(expected.length);
    for (const matrix of live) {
      const at = expected.find(
        (candidate) =>
          Math.abs((candidate.elements[12] as number) - (matrix[12] as number)) < 1e-4 &&
          Math.abs((candidate.elements[13] as number) - (matrix[13] as number)) < 1e-4 &&
          Math.abs((candidate.elements[14] as number) - (matrix[14] as number)) < 1e-4,
      );
      expect(at).toBeDefined();
      for (let word = 0; word < 16; word += 1)
        expect(matrix[word]).toBeCloseTo(at?.elements[word] as number, 4);
    }

    // A refilter across a switch keeps the one mesh and every root record.
    follow.position.x = -25;
    world.update();
    for (let pass = 0; pass < 8; pass += 1) world.update();
    const refiltered = liveWideCasters(world, "prop");
    expect(refiltered.length).toBe(1);
    expect(liveMatrices(refiltered[0] as InstancedMesh).length).toBe(expected.length);

    // Leaving the ring evicts every record; coming back rebuilds the same one-mesh set.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    expect(liveWideCasters(world, "prop").length).toBe(0);
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();
    const restored = liveWideCasters(world, "prop");
    expect(restored.length).toBe(1);
    expect(liveMatrices(restored[0] as InstancedMesh).length).toBe(expected.length);
    world.dispose();
  });

  it("bounds the default cache at 48 active atlases and keeps the refused asset's source LODs", async () => {
    const count = 49;
    stubManifestFetch(manyAlphaAssets(count));
    const world = await loadPine(treeLoader());
    // Settle the loads with no renderer: every asset is adopted and queued, and the first bake
    // begins but cannot advance, so all 49 want an atlas before any lands.
    await flushed(world);

    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");
    const stub = rendererStub();
    const raw = stub.raw as unknown as { render: () => void };
    const render = vi.spyOn(raw, "render");
    const budget = 128 * 1024 * 1024;
    for (let pass = 0; pass < (count + 1) * 16 + 64; pass += 1) {
      world.update(stub);
      await flush(1);
    }

    const impostor = world.stats().impostor;
    expect(world.stats().failures).toBe(0);
    // 48 atlases fit in the default budget; the 49th is refused rather than overrunning it, and no
    // atlas is disposed while a live asset still borrows it (that would have made a surface read a
    // destroyed atlas). One bake per landed asset: 16 capture calls each.
    expect(impostor.assets).toBe(48);
    expect(impostor.pending).toBe(0);
    expect(impostor.atlasBytes).toBe(48 * 2_796_160);
    expect(impostor.atlasBytes).toBeLessThanOrEqual(budget);
    expect(impostor.budgetBytes).toBe(budget);
    expect(render).toHaveBeenCalledTimes(48 * 16);
    expect(dispose).not.toHaveBeenCalled();

    // A landed asset appended its terminal level; the refused one kept every source level and
    // appended none.
    expect(partsOf(world, "tree_0", 1, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "tree_48", 1, 0).length).toBe(0);
    expect(partsOf(world, "tree_48", 0, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "tree_48", 0, 1).length).toBeGreaterThan(0);

    // Teardown releases each owned atlas exactly once, no more and no fewer.
    world.dispose();
    expect(dispose).toHaveBeenCalledTimes(48);
  });

  it("shares one bake between two entries over the same cooked LOD0 with different metadata", async () => {
    stubManifestFetch(sameGlbTwoEntries());
    const world = await loadPine(treeLoader());
    await flushed(world);

    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");
    const stub = rendererStub();
    const raw = stub.raw as unknown as { render: () => void };
    const render = vi.spyOn(raw, "render");
    for (let pass = 0; pass < 3 * 16 + 32; pass += 1) {
      world.update(stub);
      await flush(1);
    }

    // Both entries landed a terminal level, but from ONE atlas: the second re-checked the completed
    // cache when it was dequeued and reused the first bake instead of building a second surface on
    // a disposed atlas. One bake is 16 capture calls, not 32.
    const impostor = world.stats().impostor;
    expect(world.stats().failures).toBe(0);
    expect(impostor.assets).toBe(2);
    expect(impostor.atlasBytes).toBe(2_796_160);
    expect(render).toHaveBeenCalledTimes(16);
    expect(dispose).not.toHaveBeenCalled();
    expect(partsOf(world, "alpha_a", 2, 0).length).toBeGreaterThan(0);
    expect(partsOf(world, "alpha_b", 1, 0).length).toBeGreaterThan(0);

    world.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});

/**
 * Far residency: one whole-map instanced impostor mesh per atlas asset, built from every original
 * placement root, drawn for the placements the near ring does not hold, and handed back to the near
 * ring per cell/run as it lands. The near source GLBs are not what keeps it alive.
 */
describe("WorldCells far impostor residency", () => {
  /** The committed package with every cell's pine run, so the near ring is a strict subset. */
  function pineEverywhere(): IWorldPackage {
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    return {
      ...manifest,
      assets: { pine },
      cells: manifest.cells.map((cell) => ({
        ...cell,
        chunks: [],
        runs: cell.runs.filter((run) => run.asset === "pine"),
      })),
    };
  }

  const placementBytes = readFileSync(path.join(fixture, "placements.bin"));
  const placementBuffer = placementBytes.buffer.slice(
    placementBytes.byteOffset,
    placementBytes.byteOffset + placementBytes.byteLength,
  ) as ArrayBuffer;

  /** The exact instance matrix a placement record composes, as `#addPlacements` composes it. */
  function rootMatrix(records: Float32Array, index: number): Matrix4 {
    const base = index * 8;
    return new Matrix4().compose(
      new Vector3(
        records[base] as number,
        records[base + 1] as number,
        records[base + 2] as number,
      ),
      new Quaternion(
        records[base + 3] as number,
        records[base + 4] as number,
        records[base + 5] as number,
        records[base + 6] as number,
      ),
      new Vector3().setScalar(records[base + 7] as number),
    );
  }

  /** Every original root of the cells outside the ring, the whole set the far mesh must hold. */
  function expectedFarRoots(): Matrix4[] {
    const roots: Matrix4[] = [];
    for (const cell of manifest.cells) {
      if (Math.max(Math.abs(cell.x - 1), Math.abs(cell.z - 1)) <= 1) continue;
      for (const run of cell.runs) {
        if (run.asset !== "pine") continue;
        const records = cellPlacements(placementBuffer, run);
        for (let index = 0; index < run.count; index += 1) roots.push(rootMatrix(records, index));
      }
    }
    return roots;
  }

  function farMeshes(world: WorldCells): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];
    world.traverse((object: Object3D) => {
      if (object instanceof InstancedMesh && object.name.startsWith("tn-far:")) meshes.push(object);
    });
    return meshes;
  }

  function farLive(mesh: InstancedMesh): number {
    const array = mesh.instanceMatrix.array as Float32Array;
    let live = 0;
    for (let index = 0; index < mesh.count; index += 1) if (farRecordLive(array, index)) live += 1;
    return live;
  }

  /** The live records every near main mesh of pine draws, one part per level to count placements. */
  function nearPineLive(world: WorldCells): number {
    let live = 0;
    world.traverse((object: Object3D) => {
      if (!(object instanceof InstancedMesh) || !/^pine:\d+:0$/u.test(object.name)) return;
      const array = object.instanceMatrix.array as Float32Array;
      for (let index = 0; index < object.count; index += 1)
        if (array[index * 16 + 15] !== 0) live += 1;
    });
    return live;
  }

  async function loadPineEverywhere(follow: {
    position: { x: number; z: number };
  }): Promise<WorldCells> {
    stubManifestFetch(pineEverywhere());
    const world = await loadPine(treeLoader(), { follow });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();
    return world;
  }

  it("draws every original placement root outside the ring from one far mesh after the atlas lands", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPineEverywhere(follow);

    const meshes = farMeshes(world);
    expect(meshes.length).toBe(1);
    const far = meshes[0] as InstancedMesh;
    // Two triangles: the whole-asset impostor quad, one per original placement.
    expect(far.geometry.index?.count).toBe(6);

    const expected = expectedFarRoots();
    expect(expected.length).toBe(263);
    expect(farLive(far)).toBe(expected.length);

    const array = far.instanceMatrix.array as Float32Array;
    for (let index = 0; index < far.count; index += 1) {
      if (!farRecordLive(array, index)) continue;
      const match = expected.find(
        (candidate) =>
          Math.abs((candidate.elements[12] as number) - (array[index * 16 + 12] as number)) <
            1e-4 &&
          Math.abs((candidate.elements[13] as number) - (array[index * 16 + 13] as number)) <
            1e-4 &&
          Math.abs((candidate.elements[14] as number) - (array[index * 16 + 14] as number)) < 1e-4,
      );
      expect(match).toBeDefined();
      for (let word = 0; word < 16; word += 1)
        expect(array[index * 16 + word]).toBeCloseTo(match?.elements[word] as number, 4);
    }

    // The capacity is the whole map's original count, not the near ring's: the physical allocation
    // the budget is charged for, with exactly the far half live.
    const stats = world.stats().impostor;
    expect(stats.far.aggregates).toBe(1);
    expect(stats.far.instances).toBe(799);
    expect(stats.far.live).toBe(263);
    expect(stats.far.nearOwned).toBe(536);
    expect(stats.far.bytes).toBe(799 * 68);
    expect(stats.far.uploads).toBeGreaterThan(0);
    world.dispose();
  });

  it("hands each run between the near ring and the far mesh with no double and no hole", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPineEverywhere(follow);

    // Resident: the near ring owns its run, the far mesh keeps the other 263 original roots.
    expect(nearPineLive(world)).toBe(536);
    const first = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(first)).toBe(263);
    expect(nearPineLive(world) + farLive(first)).toBe(799);

    // Leave the whole map: every cell evicts, every original root falls back to the far mesh.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    expect(nearPineLive(world)).toBe(0);
    const away = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(away)).toBe(799);
    expect(nearPineLive(world) + farLive(away)).toBe(799);

    // Walk back: the near ring re-adopts from the cached atlas and takes its runs back.
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();
    expect(nearPineLive(world)).toBe(536);
    const restored = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(restored)).toBe(263);
    expect(nearPineLive(world) + farLive(restored)).toBe(799);
    world.dispose();
  });

  it("keeps far instance bounds finite for the inactive slots across the handoff", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPineEverywhere(follow);

    const far = farMeshes(world)[0] as InstancedMesh;
    const array = far.instanceMatrix.array as Float32Array;
    // The mesh draws all 799 slots; 536 are collapsed, the ones a near run owns.
    expect(far.count).toBe(799);
    expect(farLive(far)).toBe(263);

    // The real aggregate's own bounds over the mixed live/collapsed buffer, through Three's own
    // `computeBoundingBox`/`computeBoundingSphere` — the exact pair that returned NaN before.
    const finiteBounds = (mesh: InstancedMesh): boolean => {
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      const box = mesh.boundingBox;
      const sphere = mesh.boundingSphere;
      if (box === null || sphere === null) return false;
      return [
        box.min.x,
        box.min.y,
        box.min.z,
        box.max.x,
        box.max.y,
        box.max.z,
        sphere.center.x,
        sphere.center.y,
        sphere.center.z,
        sphere.radius,
      ].every((value) => Number.isFinite(value));
    };
    expect(finiteBounds(far)).toBe(true);

    // A collapsed slot is not all-zero: it keeps w = 1 with an empty affine block. An all-zero record
    // leaves w = 0, and Three's `Box3.applyMatrix4` divides by it.
    let hidden = -1;
    for (let index = 0; index < far.count; index += 1)
      if (!farRecordLive(array, index)) hidden = index;
    expect(hidden).toBeGreaterThanOrEqual(0);
    expect(array[hidden * 16 + 15]).toBe(1);
    for (let word = 0; word < 12; word += 1) expect(array[hidden * 16 + word]).toBe(0);

    // Leave the map: every run hands back to the far mesh. That matrix write stales the cached pair
    // so it is rebuilt from the now-fully-live buffer, and the extent is finite again.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    const away = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(away)).toBe(799);
    expect(away.boundingBox).toBeNull();
    expect(finiteBounds(away)).toBe(true);

    // Walk back: the near ring takes its runs again and collapses 536 slots. No duplicate: near plus
    // far is the original 799 once, and the bounds stay finite over the re-collapsed buffer.
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();
    const restored = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(restored)).toBe(263);
    expect(nearPineLive(world) + farLive(restored)).toBe(799);
    expect(finiteBounds(restored)).toBe(true);

    // A restored live record is an original placement root, never a collapsed or duplicated one.
    const data = restored.instanceMatrix.array as Float32Array;
    let sample: Float32Array | undefined;
    for (let index = 0; index < restored.count; index += 1)
      if (farRecordLive(data, index)) {
        sample = data.slice(index * 16, index * 16 + 16);
        break;
      }
    expect(sample).toBeDefined();
    if (sample !== undefined) {
      const match = expectedFarRoots().find(
        (candidate) =>
          Math.abs((candidate.elements[12] as number) - (sample[12] as number)) < 1e-4 &&
          Math.abs((candidate.elements[13] as number) - (sample[13] as number)) < 1e-4 &&
          Math.abs((candidate.elements[14] as number) - (sample[14] as number)) < 1e-4,
      );
      expect(match).toBeDefined();
    }
    world.dispose();
  });

  it("keeps the far mesh and its atlas alive after the near source is released", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPineEverywhere(follow);
    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");

    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);

    // Every near source mesh is gone and the asset itself has been released, but the far mesh still
    // draws every original root from an atlas the far aggregate holds its own user on.
    expect(nearPineLive(world)).toBe(0);
    expect(world.stats().impostor.atlasBytes).toBe(2_796_160);
    const far = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(far)).toBe(799);
    expect(dispose).not.toHaveBeenCalled();

    world.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the loader's cached source texture on the last cell while the far atlas stays", async () => {
    stubManifestFetch(pineEverywhere());
    // A real `createAssetLoader`, so `release` reaches the loader's own teardown: the source scene's
    // texture is disposed, not merely a name recorded as released. Every model is the two-part tree,
    // its needles card carrying a texture so the teardown is observable.
    const sourceTextures: Texture[] = [];
    const makeTree = (): Object3D => {
      const group = new Group();
      for (const [index, y] of [0, 1.5].entries()) {
        const material = new MeshBasicMaterial();
        if (index === 1) {
          const texture = new Texture();
          sourceTextures.push(texture);
          material.transparent = true;
          material.map = texture;
        }
        const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
        mesh.position.y = y;
        group.add(mesh);
      }
      return group;
    };
    const unrelatedTexture = new Texture();
    const unrelated = new Group();
    unrelated.add(
      new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ map: unrelatedTexture })),
    );
    const assets = createAssetLoader({
      model: (url: string) =>
        Promise.resolve({ scene: url.includes("unrelated") ? unrelated : makeTree() }),
    });
    // The world's own loader: the mocked factory hands back this real one, so the world owns the
    // cache entries it asks for and the teardown below really disposes. A loader passed in as
    // `assets` is the caller's and is deliberately not released; see `world-cells.spec.ts`.
    internalLoader.load = () => assets;
    // A source the world never names is a real cache entry; the world's release must not touch it.
    await assets.model("world/assets/unrelated.glb");
    const unrelatedDispose = vi.spyOn(unrelatedTexture, "dispose");

    const follow = { position: { x: -32, z: -32 } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets: { bytes: 64 * 1024 * 1024, instances: 50000, residentCells: 25 },
      follow,
      impostors: true,
      prefetchSeconds: 0,
      ring: 1,
      surface: new MeshBasicMaterial(),
      url: "/world/world.json",
    } as Parameters<typeof WorldCells.load>[0]);
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    expect(world.stats().impostor.atlasBytes).toBe(2_796_160);

    const sourceDisposes = sourceTextures.map((texture) => vi.spyOn(texture, "dispose"));
    for (const dispose of sourceDisposes) expect(dispose).not.toHaveBeenCalled();

    // Every near cell leaves: the asset's last source is gone and its cached GLB entries are handed
    // back, tearing down the source textures. The far aggregate keeps the atlas, and the unrelated
    // cached model — a path this world never asked for — survives untouched.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);

    expect(farMeshes(world).length).toBe(1);
    expect(world.stats().impostor.atlasBytes).toBe(2_796_160);
    expect(sourceDisposes.length).toBeGreaterThan(0);
    for (const dispose of sourceDisposes) expect(dispose).toHaveBeenCalledTimes(1);
    expect(unrelatedDispose).not.toHaveBeenCalled();
    world.dispose();
  });

  it("uploads no instance data while the follow point is still", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPineEverywhere(follow);
    const before = world.stats().impostor.far.uploads;
    const far = farMeshes(world)[0] as InstancedMesh;
    const live = farLive(far);

    for (let pass = 0; pass < 12; pass += 1) world.update();

    expect(world.stats().impostor.far.uploads).toBe(before);
    expect(farLive(far)).toBe(live);
    world.dispose();
  });

  it.each(["source", "shader-columns"] as const)(
    "uploads no unchanged far %s buffer over 60 frames or camera-only movement",
    async (route) => {
      const follow = { position: { x: -32, z: -32 } };
      const world = await loadPineEverywhere(follow);
      try {
        const far = farMeshes(world)[0] as InstancedMesh;
        const columns = farMatrixRoute(far);
        const tracked = attributeUploads(
          route === "source" ? far.instanceMatrix : columns.attribute,
        );
        const version = far.instanceMatrix.version;
        for (let frame = 0; frame < 60; frame++) {
          world.update();
          columns.sync();
          tracked.submit();
        }
        expect(tracked.backend.createAttribute).toHaveBeenCalledTimes(1);
        expect(tracked.backend.updateAttribute).not.toHaveBeenCalled();
        const camera = new PerspectiveCamera(60, 1, 0.1, 2000);
        for (let frame = 0; frame < 10; frame++) {
          camera.position.set(frame * 20, 3, 200);
          camera.lookAt(0, 0, 0);
          camera.updateMatrixWorld();
          world.update(rendererStub(), camera);
          columns.sync();
          tracked.submit();
        }
        expect(far.instanceMatrix.version).toBe(version);
        expect(tracked.backend.updateAttribute).not.toHaveBeenCalled();
      } finally {
        world.dispose();
      }
    },
  );
  it.each(["source", "shader-columns"] as const)(
    "uploads real near/far handoffs once to the %s route and preserves cull/disposal",
    async (route) => {
      const follow = { position: { x: -32, z: -32 } };
      const world = await loadPineEverywhere(follow);
      try {
        const far = farMeshes(world)[0] as InstancedMesh;
        const columns = farMatrixRoute(far);
        const tracked = attributeUploads(
          route === "source" ? far.instanceMatrix : columns.attribute,
        );
        const cull = far.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE) as BufferAttribute;
        expect(cull).toBeDefined();
        const cullUploads = attributeUploads(cull);
        const version = far.instanceMatrix.version;
        const initial = Array.from(far.instanceMatrix.array);
        expect(farLive(far)).toBe(263);
        follow.position.x = 100_000;
        follow.position.z = 100_000;
        world.update();
        await flushed(world);
        columns.sync();
        tracked.submit();
        cullUploads.submit();
        expect(far.instanceMatrix.version).toBeGreaterThan(version);
        expect(tracked.backend.updateAttribute).toHaveBeenCalledTimes(1);
        expect(tracked.copies[0]).toEqual(Array.from(far.instanceMatrix.array));
        expect(tracked.copies[0]).not.toEqual(initial);
        expect(farLive(far)).toBe(799);
        expect(cullUploads.backend.updateAttribute).toHaveBeenCalledTimes(1);
        for (let frame = 0; frame < 20; frame++) {
          world.update();
          columns.sync();
          tracked.submit();
          cullUploads.submit();
        }
        expect(tracked.backend.updateAttribute).toHaveBeenCalledTimes(1);
        expect(cullUploads.backend.updateAttribute).toHaveBeenCalledTimes(1);
        follow.position.x = -32;
        follow.position.z = -32;
        world.update();
        await flushed(world);
        for (let frame = 0; frame < 32; frame++) world.update();
        columns.sync();
        tracked.submit();
        expect(tracked.backend.updateAttribute).toHaveBeenCalledTimes(2);
        expect(tracked.copies[1]).toEqual(Array.from(far.instanceMatrix.array));
        expect(farLive(far)).toBe(263);
        const disposal = vi.fn();
        far.addEventListener("dispose", disposal);
        world.dispose();
        world.update();
        world.dispose();
        expect(disposal).toHaveBeenCalledTimes(1);
        expect(far.parent).toBeNull();
        expect(farMeshes(world)).toHaveLength(0);
      } finally {
        world.dispose();
      }
    },
  );

  it("draws the far mesh from CPU instance matrices with the GPU scene off", async () => {
    const follow = { position: { x: -32, z: -32 } };
    stubManifestFetch(pineEverywhere());
    const world = await loadPine(treeLoader(), { follow, gpuScene: false });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();

    expect(world.stats().gpuScene.on).toBe(false);
    const far = farMeshes(world)[0] as InstancedMesh;
    expect(far).toBeDefined();
    expect(far.instanceMatrix).toBeDefined();
    expect(farLive(far)).toBe(263);
    world.dispose();
  });

  it("keeps the production far mesh drawn past the projected-size gate by its frustumCulled opt-out", async () => {
    stubManifestFetch(pineEverywhere());
    const world = await loadPine(treeLoader(), { follow: { position: { x: -32, z: -32 } } });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const far = farMeshes(world)[0] as InstancedMesh;
    // No shadows configured: nothing here is a shadow caster, so the projected-size gate is the only
    // thing that could drop it. The production opt-out is `frustumCulled = false` alone — the gate
    // exempts it before reading bounds — with no `alwaysRender` marker installed.
    expect(far.castShadow).toBe(false);
    expect(far.frustumCulled).toBe(false);
    expect(far.userData.alwaysRender).toBeUndefined();

    const camera = new PerspectiveCamera(60, 1, 0.1, 1e6);
    camera.position.set(0, 0, 50_000);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const cull = new RenderCameraCull();

    // The gate is live: the same mesh with trusted bounds this far out projects to well under
    // 0.5 px and is hidden.
    far.frustumCulled = true;
    cull.apply(world, camera, 1080);
    expect(far.visible).toBe(false);
    cull.restore();

    // Production state: `frustumCulled = false` exempts it before bounds, so it stays drawn.
    far.frustumCulled = false;
    cull.apply(world, camera, 1080);
    expect(far.visible).toBe(true);
    expect(cull.report.exemptFrustumCulled).toBeGreaterThanOrEqual(1);
    cull.restore();
    world.dispose();
  });

  it("builds no far mesh and leaves nothing pending when the renderer cannot bake", async () => {
    stubManifestFetch(pineEverywhere());
    const world = await loadPine(treeLoader(), { follow: { position: { x: -32, z: -32 } } });
    await flushed(world);
    // A renderer with no layered capture seam is the unsupported answer, not a wait: the queued bake
    // is cancelled and the source LODs stay — and no far aggregate is built from an atlas that never
    // landed.
    world.update({ compute: (): void => {}, kind: "webgpu", raw: {} } as unknown as IRendererLike);
    await flushed(world);

    expect(farMeshes(world).length).toBe(0);
    const stats = world.stats().impostor;
    expect(stats.pending).toBe(0);
    expect(stats.far.aggregates).toBe(0);
    expect(stats.far.instances).toBe(0);
    world.dispose();
  });

  it("refuses an unseen far aggregate over budget and retries it when a near cell frees the room", async () => {
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const pkg: IWorldPackage = {
      ...manifest,
      assets: { pine, oak: { bounds: pine.bounds, glb: "assets/oak.glb" } },
      cells: [
        { chunks: [], runs: [{ asset: "pine", count: 85, offset: 1059 }], x: 1, z: 1 },
        { chunks: [], runs: [{ asset: "oak", count: 1, offset: 0 }], x: 3, z: 3 },
      ],
    };
    stubManifestFetch(pkg);
    const follow = { position: { x: -32, z: -32 } };
    // 2,720 near bytes + 5,780 pine-far bytes (85 x 68: matrix plus the per-instance cull) fits;
    // oak's 68 does not, so pine's aggregate lands and oak's is refused.
    const world = await loadPine(treeLoader(), {
      budgets: { bytes: 8520, instances: 50000, residentCells: 25 },
      follow,
    });
    await flushed(world);

    const stub = rendererStub();
    for (let pass = 0; pass < 4 * 16 + 96; pass += 1) {
      world.update(stub);
      await flush(1);
    }
    // Pine's far aggregate exists; oak's was refused, so its source is kept for the retry.
    expect(farMeshes(world).some((mesh) => mesh.name === "tn-far:pine")).toBe(true);
    expect(farMeshes(world).some((mesh) => mesh.name === "tn-far:oak")).toBe(false);
    expect(world.stats().impostor.far.aggregates).toBe(1);

    // Leaving the ring frees the near allocation, and the retry builds oak without re-loading it.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    const oak = farMeshes(world).find((mesh) => mesh.name === "tn-far:oak") as
      | InstancedMesh
      | undefined;
    expect(oak).toBeDefined();
    expect(farLive(oak as InstancedMesh)).toBe(1);
    // Its temporary source is released the moment the retried aggregate lands.
    expect(world.stats().impostor.atlasBytes).toBe(2 * 2_796_160);
    world.dispose();
  });

  it("casts the far half into the coarse wide shadow layer, not the main-only layer", async () => {
    const follow = { position: { x: -32, z: -32 } };
    stubManifestFetch(pineEverywhere());
    const world = await loadPine(treeLoader(), {
      follow,
      shadows: { cast: true, castLevels: 3 },
    });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const far = farMeshes(world)[0] as InstancedMesh;
    expect(far.castShadow).toBe(true);
    expect(far.receiveShadow).toBe(false);
    // Layer 0 (main) plus the wide caster layer: one representation serves both, so no run need be
    // drawn twice in any shadow representation.
    expect(far.layers.isEnabled(0)).toBe(true);
    expect(far.layers.isEnabled(27)).toBe(true);
    world.dispose();
  });

  it("draws a species that never enters the near ring and releases its source once the atlas lands", async () => {
    const follow = { position: { x: -32, z: -32 } };
    const near = new Set(["0,0", "0,1", "0,2", "1,0", "1,1", "1,2", "2,0", "2,1", "2,2"]);
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const pkg: IWorldPackage = {
      ...manifest,
      assets: { pine, oak: { bounds: pine.bounds, glb: "assets/oak.glb" } },
      cells: manifest.cells
        .map((cell) => ({
          ...cell,
          chunks: [],
          runs: cell.runs
            .filter((run) => run.asset === "pine")
            .map((run) => ({
              ...run,
              // Every far cell's pine run becomes an oak run: oak is placed, but nowhere the ring
              // can reach from the start point, so only the unseen-acquisition path can bake it.
              asset: near.has(`${String(cell.x)},${String(cell.z)}`) ? "pine" : "oak",
            })),
        }))
        .filter((cell) => cell.runs.length > 0),
    };
    stubManifestFetch(pkg);

    const byUrl = new Map<string, BufferGeometry[]>();
    const world = await loadPine(
      {
        geometryFor: () => new BoxGeometry(1, 1, 1),
        load: (url: string) => {
          const group = new Group();
          const geometries: BufferGeometry[] = [];
          for (const [index, y] of [0, 1.5].entries()) {
            const geometry = new BoxGeometry(1, 1, 1);
            vi.spyOn(geometry, "dispose");
            geometries.push(geometry);
            const material = new MeshBasicMaterial();
            if (index === 1) material.transparent = true;
            const mesh = new Mesh(geometry, material);
            mesh.position.y = y;
            group.add(mesh);
          }
          byUrl.set(url, geometries);
          return Promise.resolve(group);
        },
      },
      { follow },
    );
    await flushed(world);
    // No renderer yet: only the near species loaded, no far aggregate, no bake.
    expect(farMeshes(world).length).toBe(0);

    const stub = rendererStub();
    for (let pass = 0; pass < 4 * 16 + 96; pass += 1) {
      world.update(stub);
      await flush(1);
    }

    // The unseen oak baked and its whole-map aggregate exists, drawing every original far root.
    const oakFar = farMeshes(world).find((mesh) => mesh.name === "tn-far:oak") as
      | InstancedMesh
      | undefined;
    expect(oakFar).toBeDefined();
    expect(world.stats().impostor.far.aggregates).toBeGreaterThanOrEqual(2);
    expect(farLive(oakFar as InstancedMesh)).toBeGreaterThan(0);
    // Its source GLB is released once the atlas lands — every oak geometry disposed exactly once —
    // while the atlas it baked persists in the cache.
    const oakGeometries = [...byUrl]
      .filter(([url]) => url.includes("oak"))
      .flatMap(([, geometries]) => geometries);
    expect(oakGeometries.length).toBe(2);
    for (const geometry of oakGeometries)
      expect(vi.mocked(geometry.dispose).mock.calls.length).toBe(1);
    // Two distinct atlases (pine + oak) held after oak's source is gone.
    expect(world.stats().impostor.atlasBytes).toBe(2 * 2_796_160);
    world.dispose();
  });

  it("keeps a far-pinned atlas out of the LRU when the cache is full", async () => {
    const count = 49;
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    const assets: Record<string, IWorldAsset> = {};
    const runs: IWorldRun[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = `tree_${String(index)}`;
      assets[id] = { bounds: pine.bounds, glb: `assets/tree_${String(index)}.glb` };
      runs.push({ asset: id, count: 1, offset: 0 });
    }
    // Every species sits far from the follow point, so the far half acquires and bakes each one and
    // its aggregate holds the atlas user. No near cell holds any of them.
    stubManifestFetch({ ...manifest, assets, cells: [{ chunks: [], runs, x: 3, z: 3 }] });
    const world = await loadPine(treeLoader(), { follow: { position: { x: -32, z: -32 } } });
    await flushed(world);

    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");
    const stub = rendererStub();
    for (let pass = 0; pass < (count + 2) * 24 + 128; pass += 1) {
      world.update(stub);
      await flush(1);
    }

    const stats = world.stats().impostor;
    expect(world.stats().failures).toBe(0);
    // 48 atlases fit; the 49th is refused. Every one of the 48 is pinned by a far aggregate, so the
    // LRU finds nothing inactive to evict and no atlas is disposed under a live far surface.
    expect(stats.atlasBytes).toBe(48 * 2_796_160);
    expect(stats.far.aggregates).toBe(48);
    expect(stats.far.instances).toBe(48);
    expect(dispose).not.toHaveBeenCalled();
    world.dispose();
  });

  it("tells the shadow levels when a far aggregate adopts and when a run hands back", async () => {
    stubManifestFetch(pineEverywhere());
    const invalidate = vi.fn();
    let now = 0;
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine(treeLoader(), {
      admissionNow: () => now,
      follow,
      shadows: { cast: true, castLevels: 3, invalidate },
    });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) {
      now += 2000;
      world.update();
    }

    // The far aggregate's records arrived; the levels that draw the ground were told.
    expect(world.stats().impostor.far.aggregates).toBeGreaterThanOrEqual(1);
    const adopted = invalidate.mock.calls.length;
    expect(adopted).toBeGreaterThanOrEqual(1);

    // Leaving the ring hands every run back to the far mesh and evicts the near cells; that moved
    // records too, so the levels are told again.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    now += 2000;
    world.update();
    expect(invalidate.mock.calls.length).toBeGreaterThan(adopted);
    world.dispose();
  });
});

/**
 * The far cohort: two canonical entries over one exact atlas key, placed in different runs, must
 * share one aggregate and grow it without overcounting, and a shared atlas key must not make two
 * different `maxDistance` values borrow each other's cull.
 */
describe("WorldCells far impostor cohorts", () => {
  function sameAtlasTwoCells(): IWorldPackage {
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    return {
      ...manifest,
      assets: {
        cohort_a: {
          bounds: pine.bounds,
          glb: "assets/shared_tree.glb",
          lods: [{ distance: 60, glb: "assets/shared_lod1.glb" }],
          maxDistance: 200,
        },
        cohort_b: { bounds: pine.bounds, glb: "assets/shared_tree.glb", maxDistance: 200 },
      },
      cells: [
        { chunks: [], runs: [{ asset: "cohort_a", count: 1, offset: 0 }], x: 1, z: 1 },
        { chunks: [], runs: [{ asset: "cohort_b", count: 2, offset: 0 }], x: 1, z: 2 },
      ],
    };
  }

  function farMeshes(world: WorldCells): InstancedMesh[] {
    const meshes: InstancedMesh[] = [];
    world.traverse((object: Object3D) => {
      if (object instanceof InstancedMesh && object.name.startsWith("tn-far:")) meshes.push(object);
    });
    return meshes;
  }

  function farLive(mesh: InstancedMesh): number {
    const array = mesh.instanceMatrix.array as Float32Array;
    let live = 0;
    for (let index = 0; index < mesh.count; index += 1) if (farRecordLive(array, index)) live += 1;
    return live;
  }

  it("shares one aggregate across two ids sharing an atlas key and grows it once per run", async () => {
    stubManifestFetch(sameAtlasTwoCells());
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine(treeLoader(), { follow });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const far = farMeshes(world).filter((mesh) => mesh.name.startsWith("tn-far:"));
    expect(far.length).toBe(1);
    const mesh = far[0] as InstancedMesh;
    // Three originals, each once: cohort_a's one and cohort_b's two, not one count charged twice.
    expect(world.stats().impostor.far.instances).toBe(3);
    expect(mesh.instanceMatrix.array.length).toBe(3 * 16);

    // Leave the map: both runs fall back to the far mesh and every original is live once.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    const restored = farMeshes(world)[0] as InstancedMesh;
    expect(farLive(restored)).toBe(3);

    // One atlas, disposed exactly once at teardown.
    const dispose = vi.spyOn(WorldImpostorAtlas.prototype, "dispose");
    world.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("keeps ONE aggregate per atlas key and carries each asset's own cutoff per instance", async () => {
    stubManifestFetch(sameGlbTwoEntries());
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine(treeLoader(), { follow });
    await flushed(world);
    runBake(world, rendererStub());
    await flushed(world);
    for (let pass = 0; pass < 32; pass += 1) world.update();

    const far = farMeshes(world);
    // One atlas key, one aggregate: a shared atlas is not split into a second surface per authored
    // maxDistance. The per-placement cutoff rides the instance attribute instead. See #buildFar.
    expect(far.length).toBe(1);
    const mesh = far[0] as InstancedMesh;
    // Production metadata: the shared far surface reads the per-instance attribute, so two canonical
    // ids over one atlas cannot borrow the first member's maximum.
    const material = mesh.material as Material;
    expect(material.userData.tnFarCull).toBe(IMPOSTOR_FAR_CULL_ATTRIBUTE);
    const attribute = mesh.geometry.getAttribute(IMPOSTOR_FAR_CULL_ATTRIBUTE);
    expect(attribute).toBeDefined();
    // Shader logic: the attribute carries one cutoff per placement. alpha_a maxDistance 120 -> 105,
    // alpha_b 200 -> 175: each is its own author, both live in the one aggregate.
    const culls = Array.from((attribute.array as Float32Array).slice(0, mesh.count)).sort(
      (a, b) => a - b,
    );
    expect(culls).toEqual([105, 175]);
    // Roots/cardinality: two canonical ids, two placement roots, one aggregate and one bake.
    expect(mesh.count).toBe(2);
    expect(world.stats().impostor.assets).toBe(2);
    expect(world.stats().impostor.atlasBytes).toBe(2_796_160);
    world.dispose();
  });

  it("disposes the unused deferred surface when a retry grows the existing aggregate", async () => {
    const pine = manifest.assets.pine;
    if (pine === undefined) throw new Error("the committed package has no pine asset.");
    // One key, two canonical ids: alpha_a near (it builds the aggregate), alpha_b far (its growth is
    // refused, so it is deferred against the same key with its own metadata and surface).
    const pkg: IWorldPackage = {
      ...manifest,
      assets: {
        alpha_a: {
          bounds: pine.bounds,
          glb: "assets/shared_tree.glb",
          lods: [{ distance: 60, glb: "assets/shared_lod1.glb" }],
          maxDistance: 200,
        },
        alpha_b: { bounds: pine.bounds, glb: "assets/shared_tree.glb", maxDistance: 200 },
      },
      cells: [
        { chunks: [], runs: [{ asset: "alpha_a", count: 85, offset: 0 }], x: 1, z: 1 },
        { chunks: [], runs: [{ asset: "alpha_b", count: 1, offset: 0 }], x: 3, z: 3 },
      ],
    };
    stubManifestFetch(pkg);
    const originalDispose = WorldImpostorSurface.prototype.dispose;
    const disposed: WorldImpostorSurface[] = [];
    vi.spyOn(WorldImpostorSurface.prototype, "dispose").mockImplementation(function (
      this: WorldImpostorSurface,
    ) {
      disposed.push(this);
      originalDispose.call(this);
    });
    const follow = { position: { x: -32, z: -32 } };
    const world = await loadPine(treeLoader(), {
      budgets: { bytes: 12_000, instances: 50_000, residentCells: 25 },
      follow,
    });
    await flushed(world);
    const stub = rendererStub();
    for (let pass = 0; pass < 4 * 16 + 96; pass += 1) {
      world.update(stub);
      await flush(1);
    }
    // alpha_a's aggregate landed on the shared key with its 85 roots; alpha_b's one-root growth was
    // refused and kept as deferred metadata, no second aggregate.
    expect(world.stats().impostor.far.aggregates).toBe(1);
    expect(world.stats().impostor.far.instances).toBe(85);
    expect(farMeshes(world).some((mesh) => mesh.name === "tn-far:alpha_b")).toBe(false);
    const original = farMeshes(world)[0] as InstancedMesh;
    const originalColumns = farMatrixRoute(original);
    const originalMatrixUploads = attributeUploads(original.instanceMatrix);
    const originalColumnUploads = attributeUploads(originalColumns.attribute);
    const originalDisposed = vi.fn();
    original.addEventListener("dispose", originalDisposed);

    // Leaving the ring frees alpha_a's near allocation; the retry grows the one existing aggregate.
    follow.position.x = 100_000;
    follow.position.z = 100_000;
    world.update();
    await flushed(world);
    for (let pass = 0; pass < 8; pass += 1) world.update();

    expect(world.stats().impostor.far.aggregates).toBe(1);
    expect(world.stats().impostor.far.instances).toBe(86);
    const grown = farMeshes(world)[0] as InstancedMesh;
    expect(grown.name).toBe("tn-far:alpha_a");
    expect(grown).not.toBe(original);
    expect(grown.instanceMatrix).not.toBe(original.instanceMatrix);
    expect(originalDisposed).toHaveBeenCalledTimes(1);
    expect(original.parent).toBeNull();
    expect(farLive(grown)).toBe(86);
    const grownColumns = farMatrixRoute(grown);
    expect(grownColumns.attribute.data).not.toBe(originalColumns.attribute.data);
    expect(Array.from(grown.instanceMatrix.array).slice(0, 85 * 16)).toEqual(
      Array.from(original.instanceMatrix.array),
    );
    const grownMatrixUploads = attributeUploads(grown.instanceMatrix);
    const grownColumnUploads = attributeUploads(grownColumns.attribute);
    for (let frame = 0; frame < 20; frame++) {
      world.update();
      grownColumns.sync();
      grownMatrixUploads.submit();
      grownColumnUploads.submit();
    }
    expect(grownMatrixUploads.backend.createAttribute).toHaveBeenCalledTimes(1);
    expect(grownColumnUploads.backend.createAttribute).toHaveBeenCalledTimes(1);
    expect(grownMatrixUploads.backend.updateAttribute).not.toHaveBeenCalled();
    expect(grownColumnUploads.backend.updateAttribute).not.toHaveBeenCalled();
    expect(originalMatrixUploads.backend.updateAttribute).not.toHaveBeenCalled();
    expect(originalColumnUploads.backend.updateAttribute).not.toHaveBeenCalled();
    // The aggregate's own surface was reused by the grow, never disposed: the grown mesh still draws
    // it. Only the two near terminal surfaces and alpha_b's unused deferred surface are gone.
    expect(disposed.some((surface) => surface.geometry === grown.geometry)).toBe(false);
    expect(disposed.length).toBe(3);
    world.dispose();
  });
});
