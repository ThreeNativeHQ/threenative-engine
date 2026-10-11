import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  DataTexture,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
} from "three";
// Three's own sources, not the bundle `three` resolves to: the renderer under test is the source
// one, and it culls with a `Frustum` of its own — a second class, so the seam below has to be that
// one rather than the `Frustum` this file's world was built with.
import { Frustum } from "three/src/math/Frustum.js";
import Renderer from "three/src/renderers/common/Renderer.js";
import { uniform, viewportSharedTexture } from "three/tsl";
import {
  BundleGroup,
  type Material,
  MeshPhysicalNodeMaterial,
  MeshStandardNodeMaterial,
} from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IRendererLike } from "../src/renderer.js";
import { bundleSafeMaterial } from "../src/world-cells.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * The main pass's draw bundles: every GPU-dressed batch mesh parented under one `BundleGroup`, and
 * every resident cell's hand-placed chunks parented under one of their own, each re-recorded only
 * when the set of things it draws changes.
 *
 * The claim is a count. Three fixes a bundle's render list when it records it and replays the
 * encoded draws until `bundleGroup.version` moves, so a walk that re-records every frame is a walk
 * that paid the whole per-draw cost twice, and a walk that re-records only on a key arriving or
 * leaving is the one this is for. The renderer here is a stub that never executes a bundle, so what
 * is under test is the parenting, the visibility and the version bookkeeping — not a draw.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;
const placementBytes = readFileSync(path.join(fixture, "placements.bin"));
const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
/** The fixture's `cellSize`; a square is one cell unless the test says otherwise. */
const CELL = 64;

/** The world-space centre of cell `(x, z)`, from the package's own extent and cell size. */
function cellCentre(x: number, z: number): { x: number; z: number } {
  return { x: manifest.extent.minX + (x + 0.5) * CELL, z: manifest.extent.minZ + (z + 0.5) * CELL };
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
 * The package with `pine`'s authored `lods` removed, so one level and one part is the whole cast.
 *
 * `rockInWest` also drops `rock` from every cell but the westernmost column. Every asset is in every
 * cell of the committed package, so no key's refcount ever reaches zero and a walk over this fixture
 * can never retire one — which is the one event the version is supposed to answer. A world where an
 * asset belongs to part of the map is the ordinary case, and it is what makes a key come and go. One
 * column is what it takes: the ring is three cells wide, so a key has to be out of all three before
 * its refcount reaches zero.
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

/** A player camera in the middle of cell (0,1) at head height, looking west. */
function playerCamera(at: readonly [number, number] = [0, 1]): PerspectiveCamera {
  const centre = cellCentre(at[0], at[1]);
  const camera = new PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.set(centre.x, 4, centre.z);
  camera.lookAt(centre.x - CELL * 4, 4, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/**
 * The same player camera turned east, which is where cell (1, 1) and its chunk stand: the pose a
 * chunk's draws are visible from, and the one the west-facing camera has to lose them in.
 */
function eastCamera(): PerspectiveCamera {
  const centre = cellCentre(0, 1);
  const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
  camera.position.set(centre.x, 4, centre.z);
  camera.lookAt(centre.x + CELL * 4, 4, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/** Every `InstancedMesh` under the world, wherever it hangs — including inside a bundle group. */
function worldMeshes(world: WorldCells): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh) found.push(object);
  });
  return found;
}

/** The main pass's own meshes. A caster half carries an `@` in its key, and the main half does not. */
function mainKeys(world: WorldCells): InstancedMesh[] {
  return worldMeshes(world).filter((one) => one.name !== "" && !one.name.includes("@"));
}

/** Whether this object is one of a hand-placed chunk's own meshes, wherever in the world it hangs. */
function isChunk(object: Object3D): boolean {
  return object.userData.tnDrawSource === "chunks";
}

/**
 * Whether this object is a main-role batch mesh the GPU scene has not dressed, which is the
 * `instanced` origin and so the batch the main record is for. A dressed batch carries `gpuScene`
 * instead, and a recorded one carries `tnBundled`, which `RenderPassBudget` reads first.
 */
function isMainBatch(object: Object3D): boolean {
  return object.userData.tnDrawSource === "instanced";
}

/**
 * The meshes' own names, sorted, so two projections are compared as sets: which meshes a frame draws
 * is the claim, and the order three happens to hand them over in is not.
 */
function names(meshes: readonly Object3D[]): string[] {
  return meshes.map((mesh) => mesh.name).sort();
}

/** Every mesh a prepared chunk drew through the main pass, in no particular order. */
function chunkMeshes(world: WorldCells): Mesh[] {
  const found: Mesh[] = [];
  world.traverse((object: Object3D) => {
    if ((object as Mesh).isMesh === true && isChunk(object)) found.push(object as Mesh);
  });
  return found;
}

/** The bundle groups a hand-placed chunk's draws are recorded in: one per resident cell that has one. */
function chunkBundles(world: WorldCells): BundleGroup[] {
  const found: BundleGroup[] = [];
  world.traverse((object: Object3D) => {
    if (!(object instanceof BundleGroup)) return;
    let holdsChunk = false;
    object.traverse((child) => {
      if (isChunk(child)) holdsChunk = true;
    });
    if (holdsChunk) found.push(object);
  });
  return found;
}

/**
 * Three's own projection of the world, with what it would submit per object counted.
 *
 * A mesh in the base render list is one `_renderObjectDirect` call a frame — the cost the draw
 * attribution measured — and a `BundleGroup` records its children into a render list of its own and
 * hands the frame one bundle entry instead, so `bundled` is what the replay draws in their place.
 *
 * The renderer is a stub holding only what `_projectObject` reads, called through three's own
 * prototype, because a node-environment test has no renderer with a GPU behind it. The frustum is
 * the one seam patched rather than faked: the count depends on it, since a record is culled by the
 * same test the old per-object path was, and three keeps that frustum in a module the test cannot
 * reach.
 */
/** Three's projection, which is private and whose signature the class's types do not name. */
interface IProjector {
  _projectObject(
    object: Object3D,
    camera: PerspectiveCamera,
    groupOrder: number,
    renderList: unknown,
    clippingContext: unknown,
  ): void;
  /** Whether a recorded group has to be recorded again, which is what makes a bundle frozen. */
  _bundleNeedsUpdate(bundleGroup: BundleGroup, renderBundleData: { version?: number }): boolean;
}

function project(
  root: Object3D,
  camera: PerspectiveCamera,
): {
  readonly bundled: readonly Object3D[];
  readonly groups: readonly BundleGroup[];
  readonly perObject: readonly Object3D[];
} {
  const perObject: Object3D[] = [];
  const bundled: Object3D[] = [];
  const recorded = new Map<BundleGroup, Object3D[]>();
  const list = (into: Object3D[]): object => ({
    begin: (): void => {},
    finish: (): void => {},
    push: (object: Object3D): void => {
      into.push(object);
    },
    pushBundle: (): void => {},
  });
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const projector = Renderer.prototype as unknown as IProjector;
  const renderer = {
    _bundles: { get: (): object => ({}) },
    // Three answers this off the recorded version, so the stub holds the real answer: a group whose
    // `version` moved is recorded again, and one that did not is replayed as it stands.
    _bundleNeedsUpdate: projector._bundleNeedsUpdate,
    _currentRenderContext: {},
    _renderLists: {
      get: (group: BundleGroup): object => {
        const into = recorded.get(group) ?? [];
        recorded.set(group, into);
        return list(into);
      },
    },
    // Three recurses through `this._projectObject`, so the stub has to answer with the method itself.
    // Every argument is forwarded: a bundle's own record is projected into the list three hands the
    // recursion, and a stub that pinned the base list would count a record as per-object draws.
    _projectObject(
      this: unknown,
      object: Object3D,
      at: PerspectiveCamera,
      groupOrder: number,
      renderList: unknown,
      clippingContext: unknown,
    ): void {
      projector._projectObject.call(this, object, at, groupOrder, renderList, clippingContext);
    },
    backend: { beginBundle: (): undefined => undefined, get: (): object => ({}) },
    sortObjects: true,
  };
  const culled = Frustum.prototype.intersectsObject;
  Frustum.prototype.intersectsObject = (object: Object3D): boolean => culled.call(frustum, object);
  try {
    projector._projectObject.call(renderer, root, camera, 0, list(perObject), undefined);
  } finally {
    Frustum.prototype.intersectsObject = culled;
  }
  for (const into of recorded.values()) bundled.push(...into);
  return { bundled, groups: [...recorded.keys()], perObject };
}

/**
 * Count the writes each mesh's `visible` takes, keyed by name, and leave the flag frozen at whatever
 * it was. Returns the live counts, so a walk's writes are read with `writes.get(name)`.
 */
function watchVisible(meshes: readonly InstancedMesh[]): Map<string, { count: number }> {
  const writes = new Map<string, { count: number }>();
  for (const mesh of meshes) {
    const held = { count: 0 };
    const current = mesh.visible;
    Object.defineProperty(mesh, "visible", {
      configurable: true,
      get: (): boolean => current,
      set: (): void => {
        held.count += 1;
      },
    });
    writes.set(mesh.name, held);
  }
  return writes;
}

/** Every `BundleGroup` that holds a main batch: the main record's shards, never a chunk's group. */
function mainBundleGroups(world: WorldCells): BundleGroup[] {
  const dressed = new Set(mainKeys(world));
  const found: BundleGroup[] = [];
  world.traverse((object: Object3D) => {
    if (
      object instanceof BundleGroup &&
      object.children.some((child) => dressed.has(child as never))
    )
      found.push(object);
  });
  return found;
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

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let the loads settle, then step again: a build waiting on the frame's mesh allowance is deferred.
 *
 * The camera comes with the renderer, because a world with no camera never runs `#cullMainPass` and so
 * never dresses a key or builds a bundle — everything these tests look at has to exist before the
 * walk under test starts.
 */
async function flushed(
  world: WorldCells,
  renderer: IRendererLike,
  camera: PerspectiveCamera,
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

/** A chunk as the loader hands it over: one box, standing in the cell that asked for it, because a
 * hand-placed chunk is placed by the export and a test that leaves every chunk at the origin cannot
 * say anything about which cell's cull answer draws it.
 */
function chunkModelAt(url: string): Group {
  const model = plainModel();
  const cell = /chunks\/.*_(\d+)_(\d+)\.glb$/u.exec(url);
  if (cell !== null) {
    const centre = cellCentre(Number(cell[1]), Number(cell[2]));
    model.position.set(centre.x, 0, centre.z);
  }
  return model;
}

/** The cell a chunk url was exported for, so a hand-built chunk stands where the export put it. */
function standAtCellOf(url: string, group: Group): Group {
  const cell = /chunks\/.*_(\d+)_(\d+)\.glb$/u.exec(url);
  if (cell === null) return group;
  const centre = cellCentre(Number(cell[1]), Number(cell[2]));
  group.position.set(centre.x, 0, centre.z);
  return group;
}

/**
 * The three surfaces a bundle answers differently, and one chunk carrying a draw for each.
 *
 * The second reads the framebuffer — `viewportSharedTexture` copies the bound framebuffer in its
 * `updateBefore`, and inside a bundle the pass it would copy is a bundle encoder with no `end()` —
 * and the third is the same sampler reached through three's own lighting model, which no structural
 * walk of a material can see. One material per mesh, because the bake groups by material: each of
 * these stays its own draw, and the bake hands the material on by reference.
 */
function mixedChunkMaterials(): readonly [Material, Material, Material] {
  const painted = new MeshStandardNodeMaterial();
  const refraction = new MeshStandardNodeMaterial();
  refraction.colorNode = viewportSharedTexture().rgb;
  const glass = new MeshPhysicalNodeMaterial();
  glass.transmission = 0.6;
  return [painted, refraction, glass];
}

function chunkOf(materials: readonly Material[]): Group {
  const model = new Group();
  for (const [index, material] of materials.entries()) {
    const mesh = new Mesh(new BoxGeometry(2, 2, 2), material);
    mesh.position.x = index * 3;
    model.add(mesh);
  }
  return model;
}

/**
 * Two parts of one asset: a surface a record can hold, and a transmissive one it cannot.
 *
 * One asset with both is the whole of the claim — a refusal is per draw, so the other part of the
 * same model is still recorded, which is what stops "unbundleable" from reading as "off".
 */
function mixedMainMaterials(): readonly [Material, Material] {
  const painted = new MeshStandardNodeMaterial();
  const glass = new MeshPhysicalNodeMaterial();
  glass.transmission = 0.6;
  return [painted, glass];
}

/** The clock the marker windows read, so a test can walk into the next one instead of waiting 5 s. */
const realNow = (): number => globalThis.performance?.now() ?? Date.now();

/** The `TN_WORLD_*` lines the world prints, captured until `afterEach` restores the console. */
function captureMarkers(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    lines.push(String(line));
  });
  return lines;
}

/** The bundle line itself, or `""` when the marker window has not come round yet. */
function bundleMarker(lines: readonly string[]): string {
  return lines.find((line) => line.startsWith("TN_WORLD_BUNDLE ")) ?? "";
}

/** A world on the committed package, walked the way the GPU-scene spec walks it. */
async function world(
  options: {
    readonly admissionNow?: () => number;
    readonly bundles?: boolean;
    readonly chunkModel?: (url: string) => Group;
    readonly gpuScene?: boolean;
    readonly rockInWest?: boolean;
  } = {},
): Promise<{
  follow: { position: { x: number; z: number; y: number } };
  renderer: IRendererLike;
  world: WorldCells;
}> {
  stubManifestFetch(options.rockInWest === true);
  const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number; y: number } };
  const cells = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow,
    loadModel: async (url: string) => (options.chunkModel ?? chunkModelAt)(url),
    prefetchSeconds: 0,
    ring: 1,
    shadows: { cast: true, receive: true },
    surface,
    url: "/world/world.json",
    ...options,
  });
  return { follow, renderer: gpuRendererStub(), world: cells };
}

/**
 * Turn the camera with the follow point parked, which is the one walk that changes no residency and
 * so re-dresses nothing: every write these tests count is the frame's own answer, not a key arriving.
 */
function turn(
  cells: WorldCells,
  renderer: IRendererLike,
  frames: number,
  at: readonly [number, number],
): void {
  for (let index = 0; index < frames; index += 1) {
    const centre = cellCentre(at[0], at[1]);
    const camera = playerCamera(at);
    camera.lookAt(centre.x + Math.sin(index / 9) * CELL * 4, 4, centre.z - CELL * 4);
    camera.updateMatrixWorld();
    cells.update(renderer, camera);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the main pass's draw bundles", () => {
  it("parents every GPU-dressed main mesh under a main record shard and never re-records a settled frame", async () => {
    const { renderer, world: cells } = await world({ bundles: true });
    cells.update(renderer, playerCamera());
    await flushed(cells, renderer, playerCamera());

    const groups = mainBundleGroups(cells);
    expect(groups.length).toBeGreaterThan(0);
    const dressed = mainKeys(cells);
    expect(dressed.length).toBeGreaterThan(0);
    // Every dressed main mesh in a shard, and the shards hold nothing else — the whole point of the
    // thing, since a mesh left outside is a mesh whose per-object path still runs every frame.
    for (const mesh of dressed) expect(groups).toContain(mesh.parent);
    expect(groups.reduce((sum, group) => sum + group.children.length, 0)).toBe(dressed.length);
    // The casters are not in them: a bundle is recorded per pass, and the shadow levels are not these
    // groups. A caster parented here would be drawn by the main pass too.
    const casters = worldMeshes(cells).filter((one) => one.name.includes("@"));
    expect(casters.length).toBeGreaterThan(0);
    for (const mesh of casters) expect(groups).not.toContain(mesh.parent);

    const settled = cells.stats().bundle;
    expect(settled.on).toBe(true);
    // A camera at rest: 200 frames that mint nothing, retire nothing and re-dress nothing.
    for (let index = 0; index < 200; index += 1) cells.update(renderer, playerCamera());
    const after = cells.stats().bundle;
    expect(after.records).toBe(settled.records);
    expect(after.children).toBe(settled.children);
    cells.dispose();
  });

  it("re-records a streaming walk only where a key is minted or retired", async () => {
    // The follow point walks two cells east and back, which carries `rock`'s keys out of the ring and
    // into it while the ring itself stays full. Five crossings is what the counter is allowed to move
    // for; 200 frames at one record a frame is what it must not do.
    const { follow, renderer, world: cells } = await world({ bundles: true, rockInWest: true });
    cells.update(renderer, playerCamera([0, 1]));
    await flushed(cells, renderer, playerCamera([0, 1]));
    const dressed = mainKeys(cells).length;
    expect(dressed).toBeGreaterThan(0);
    const before = cells.stats().bundle.records;
    // The same names the last census held, so a mint is a name arriving and a retire a name leaving.
    const seen = new Set(mainKeys(cells).map((mesh) => mesh.name));
    let structural = 0;
    const census = (): void => {
      const names = new Set(mainKeys(cells).map((mesh) => mesh.name));
      for (const name of names) if (!seen.has(name)) structural += 1;
      for (const name of seen) if (!names.has(name)) structural += 1;
      seen.clear();
      for (const name of names) seen.add(name);
    };
    for (let phase = 0; phase < 5; phase += 1) {
      const at = cellCentre(phase % 2 === 0 ? 3 : 1, 1);
      follow.position.x = at.x;
      follow.position.z = at.z;
      cells.update(renderer, playerCamera([0, 1]));
      await census();
      await flushed(cells, renderer, playerCamera([0, 1]));
      for (let index = 0; index < 40; index += 1) cells.update(renderer, playerCamera([0, 1]));
      await census();
    }
    const after = cells.stats().bundle.records - before;
    // The walk really did stream, so this is not the settled case proving itself twice.
    expect(structural).toBeGreaterThan(0);
    // Every key that came and went cost at least its own re-record, and none of the 200 frames cost
    // one of its own: a walk that re-recorded per frame would be `200 * dressed`, not `structural`.
    expect(after).toBeGreaterThanOrEqual(structural);
    expect(after).toBeLessThan(200 * dressed);
    // The over-count is the ring refilling: a key handed back by the retained set starts on a region
    // sized for the cells that are resident, so each buffer regrow behind it is one more record — a
    // listed structural cause, and still a handful against 200 frames. Culling and LOD are not on the
    // list, and a settled camera records nothing at all: the case above.
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("re-records a mint's share of the main pass, not the whole of it", async () => {
    // Machinefall's map-walk, 30-frame windows: for ~90 frames after the overlay drops the world is
    // still streaming, and every key it mints re-records the one main group, so three walks ~200
    // draws in that frame (traversed p95 257–291 against 31–78 settled). A record is per group, so
    // the cost of a mint is the size of the group it lands in, and the main pass must be split.
    const { follow, renderer, world: cells } = await world({ bundles: true, rockInWest: true });
    cells.update(renderer, playerCamera([0, 1]));
    await flushed(cells, renderer, playerCamera([0, 1]));
    const groups = mainBundleGroups(cells);
    expect(groups.length).toBeGreaterThan(1);
    const before = new Map(groups.map((group) => [group, group.version]));
    // Two cells east: `rock`'s keys leave the ring and others are dressed.
    const at = cellCentre(3, 1);
    follow.position.x = at.x;
    follow.position.z = at.z;
    cells.update(renderer, playerCamera([0, 1]));
    await flushed(cells, renderer, playerCamera([0, 1]));
    const touched = [...before].filter(([group, version]) => group.version !== version);
    expect(touched.length).toBeGreaterThan(0);
    // The mint re-recorded its own group; the rest of the main pass replayed what it had.
    expect(touched.length).toBeLessThan(before.size);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("never writes `visible` on a bundled mesh, so a bundle is never re-recorded to hide one", async () => {
    const { renderer, world: cells } = await world({ bundles: true });
    cells.update(renderer, playerCamera());
    await flushed(cells, renderer, playerCamera());

    // Count the writes rather than reading the flag: hiding a bundled mesh and showing it again
    // leaves it visible, and that pair is what a bundle pays a whole re-record for. The coarse gate
    // in `visibleFrom` is the writer, and the prewarm settle is the one other.
    const meshes = mainKeys(cells);
    const watched = watchVisible(meshes);
    turn(cells, renderer, 200, [0, 1]);
    for (const held of watched.values()) expect(held.count).toBe(0);
    // The bundle is still whole, and still the whole of the main pass. The meshes are the ones that
    // were watched, so "never written" is about the meshes that are actually drawing.
    const groups = mainBundleGroups(cells);
    for (const mesh of meshes) expect(groups).toContain(mesh.parent);
    expect(groups.reduce((sum, group) => sum + group.children.length, 0)).toBe(watched.size);
    // And the stat counts every recorded object: the dressed main meshes plus one entry per chunk,
    // because a cell's own record holds whole chunks where every draw in them is recordable — and
    // the individual draws of a chunk that is not, one entry each. See `bundleSafe`.
    const chunks = chunkBundles(cells).reduce((total, group_) => total + group_.children.length, 0);
    expect(cells.stats().bundle.children).toBe(watched.size + chunks);
    cells.dispose();
  });

  it("is the coarse per-key visibility again with the option off", async () => {
    const { renderer, world: cells } = await world({ bundles: false });
    cells.update(renderer, playerCamera());
    await flushed(cells, renderer, playerCamera());

    // No group, and the marker and the stats say so.
    expect(mainBundleGroups(cells)).toEqual([]);
    expect(cells.stats().bundle).toEqual({
      children: 0,
      cpuMeshes: 0,
      gpuMeshes: 0,
      eligibility: { checks: 0, refreshes: 0, validations: 0, uncached: 0 },
      on: false,
      reason: "option",
      records: 0,
    });
    const dressed = mainKeys(cells);
    expect(dressed.length).toBeGreaterThan(0);
    for (const mesh of dressed) expect(mesh.parent).toBe(cells);

    // The one behaviour the two paths disagree about: with the option off the coarse gate runs and
    // writes `visible` on every dressed mesh every frame, and the walk costs what it always cost.
    const watched = watchVisible(dressed);
    turn(cells, renderer, 200, [0, 1]);
    for (const held of watched.values()) expect(held.count).toBeGreaterThan(0);
    for (const mesh of dressed) expect(mesh.parent).toBe(cells);
    // The GPU scene is still on either way: the option is about the draw commands, not the cull.
    expect(cells.stats().gpuScene.on).toBe(true);
    cells.dispose();
  });

  it("names a main batch the GPU scene never dressed as instanced", async () => {
    // The CPU path is where `other` was largest and least explainable: one draw per key per frame,
    // submitted per object, with no indirect record behind it to tell it from a dressed key. The
    // origin is written where the mesh is dressed for the main pass, and the GPU-scene dress
    // overwrites it, so the tag says which of the two a batch actually took.
    const { renderer, world: cells } = await world({ gpuScene: false });
    cells.update(renderer, playerCamera());
    await flushed(cells, renderer, playerCamera());

    expect(cells.stats().gpuScene.on).toBe(false);
    const dressed = mainKeys(cells);
    expect(dressed.length).toBeGreaterThan(0);
    for (const mesh of dressed) expect(mesh.userData.tnDrawSource).toBe("instanced");
    // The caster halves are off layer 0, so the main pass never counts them; they stay unnamed.
    for (const mesh of worldMeshes(cells).filter((one) => one.name.includes("@")))
      expect(mesh.userData.tnDrawSource).toBeUndefined();
    cells.dispose();
  });

  it("replays a hand-placed chunk instead of walking its draws, and draws the same ones", async () => {
    // The subject of the box: chunks are the largest source left on the per-draw path with bundles
    // on (106–194 draws a frame p50 on the map-walk), and a chunk is one mesh per material that three
    // projects, sorts and submits every frame. The same pose in both worlds, projected by three.
    const { renderer, world: bundled } = await world({ bundles: true });
    bundled.update(renderer, eastCamera());
    await flushed(bundled, renderer, eastCamera());
    const { renderer: plain, world: walked } = await world({ bundles: false });
    walked.update(plain, eastCamera());
    await flushed(walked, plain, eastCamera());

    const chunks = chunkMeshes(walked);
    expect(chunks.length).toBeGreaterThan(0);
    // What the old path submitted per object, from the world's own draw list.
    const before = project(walked, eastCamera()).perObject.filter(isChunk);
    expect(before.length).toBeGreaterThan(0);
    // And what it submits now: none of them per object, and the same ones from a cell's own record.
    const after = project(bundled, eastCamera());
    expect(after.perObject.filter(isChunk)).toEqual([]);
    expect(names(after.bundled.filter(isChunk))).toEqual(names(before));
    // The same picture, and the two ways it could stop being the same: a record is fixed when it is
    // recorded, so a mesh the record dropped is missing geometry the moment the camera turns towards
    // it — hence never culled by the record itself — and a cell the cull can only partly see holds
    // meshes the frustum had rejected, which rasterize nothing. Both are per-cell, not per-mesh.
    for (const mesh of chunkMeshes(bundled)) {
      expect(mesh.userData.tnBundled).toBe(true);
      expect(mesh.frustumCulled).toBe(false);
    }
    expect(bundled.stats().failures).toBe(0);
    expect(walked.stats().failures).toBe(0);
    bundled.dispose();
    walked.dispose();
  });

  it("records only the draws a bundle can replay, and leaves the rest walking per object", async () => {
    // The blank-frame bug, as a claim about which draws end up where. A bundle is recorded into a
    // bundle encoder, so a draw that needs the pass it was recorded in cannot be replayed from it:
    // three encodes it anyway and the frame comes back empty. One cell, three draws in one chunk,
    // and the two that cannot be recorded must stay on the path they were already on.
    const materials = mixedChunkMaterials();
    const [painted, refraction, glass] = materials;
    const { renderer, world: cells } = await world({
      bundles: true,
      chunkModel: (url) => standAtCellOf(url, chunkOf(materials)),
    });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());

    const drawn = project(cells, eastCamera());
    const walked = drawn.perObject.filter(isChunk);
    const recorded = drawn.bundled.filter(isChunk);
    // The painted surface is the whole of the record: one entry, holding the one draw it can hold.
    expect(recorded.map((mesh) => (mesh as Mesh).material)).toEqual([painted]);
    // The framebuffer reader and the transmissive surface are both submitted per object, which is
    // where every chunk draw was before bundles existed.
    expect(new Set(walked.map((mesh) => (mesh as Mesh).material))).toEqual(
      new Set([refraction, glass]),
    );
    // And the marker says which of the two paths drew them, because that is what the draw-source
    // split and the shadow texel gate read.
    for (const mesh of recorded) expect(mesh.userData.tnBundled).toBe(true);
    for (const mesh of walked) expect(mesh.userData.tnBundled).toBeUndefined();
    // The same cell's record is still the record: what it holds is exactly what it replayed.
    expect(chunkBundles(cells).length).toBeGreaterThan(0);
    expect(new Set(drawn.groups.flatMap((group) => group.children).filter(isChunk))).toEqual(
      new Set(recorded),
    );
    expect(cells.stats().failures).toBe(0);
    // And the cell still owns what the record holds: a recorded draw left in the record outlives its
    // chunk, and the chunk's own disposal walk only finds what is still under it.
    const lifted = recorded[0] as Mesh;
    const group = lifted.parent;
    expect(lifted.userData.tnChunkRoot).toBeDefined();
    cells.dispose();
    expect(lifted.parent).not.toBe(group);
    expect(lifted.parent instanceof BundleGroup).toBe(false);
  });

  it("never copies a texture's pixels while it asks whether a draw can be recorded", async () => {
    // A sky-lit prop carries an HDR DataTexture as its envMap. The structural walk that looks for a
    // framebuffer node must not descend into the texture's pixel array: Object.values on a typed
    // array copies every element, which measured 4 s of a 4.3 s profile (5 fps) in a fresh game.
    const materials = mixedChunkMaterials();
    const painted = materials[0] as Material & { envMap: DataTexture | null };
    painted.envMap = new DataTexture(new Float32Array(64 * 64 * 4), 64, 64);
    const values = vi.spyOn(Object, "values");
    try {
      const { renderer, world: cells } = await world({
        bundles: true,
        chunkModel: (url) => standAtCellOf(url, chunkOf(materials)),
      });
      cells.update(renderer, eastCamera());
      await flushed(cells, renderer, eastCamera());
      const drawn = project(cells, eastCamera());
      expect(drawn.bundled.filter(isChunk).map((mesh) => (mesh as Mesh).material)).toEqual([
        painted,
      ]);
      expect(values.mock.calls.filter(([value]) => ArrayBuffer.isView(value))).toEqual([]);
    } finally {
      values.mockRestore();
    }
  });

  it("asks a textured surface whether it can be recorded without reading its pixels", async () => {
    // Machinefall's map-walk blocked its main thread for 22.9 s on the develop core: the
    // framebuffer walk went through `Object.values` of everything a material reaches, so every
    // texture's pixel array was enumerated one element at a time. A pixel array holds bytes,
    // never a node, so a walk that reads one is all cost. The spy is an enumerable own property
    // of the array, which only an element-by-element enumeration of the array itself reaches.
    let pixelReads = 0;
    const pixels = new Uint8Array(4 * 4 * 4);
    Object.defineProperty(pixels, "spy", {
      enumerable: true,
      get: () => {
        pixelReads += 1;
        return 0;
      },
    });
    const textured = new MeshStandardNodeMaterial();
    textured.map = new DataTexture(pixels, 4, 4);
    const { renderer, world: cells } = await world({
      bundles: true,
      chunkModel: (url) => standAtCellOf(url, chunkOf([textured])),
    });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());

    const drawn = project(cells, eastCamera());
    expect(drawn.bundled.filter(isChunk).map((mesh) => (mesh as Mesh).material)).toContain(
      textured,
    );
    expect(pixelReads).toBe(0);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("leaves a main batch a record cannot replay on the per-object path, and records the rest", async () => {
    // The blank-frame bug the chunk side already guards, on the main pass: a record is encoded into
    // a bundle encoder, and a draw that needs the pass it was recorded in — an impostor's
    // framebuffer read, a transmissive batch's transmission — cannot be replayed from one. So the
    // refusal is that one draw and not the world: the other part of the same asset is recorded.
    const [painted, glass] = mixedMainMaterials();
    const materials = [painted, glass];
    // Every model stands in cell (1, 1), the cell `eastCamera` looks at, so the assertion is about
    // which path a draw took and not about whether the frustum kept it.
    const at = cellCentre(1, 1);
    const { renderer, world: cells } = await world({
      chunkModel: (url) => {
        const model = chunkOf(materials);
        model.position.set(at.x, 0, at.z);
        return standAtCellOf(url, model);
      },
    });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());

    const drawn = project(cells, eastCamera());
    // By what the mesh draws, not by which material object: the GPU-scene dress gives every dressed
    // mesh a clone of the asset's surface, so identity is not the game's material any more.
    const transmissive = (mesh: Object3D): boolean => {
      const transmission = Reflect.get((mesh as Mesh).material, "transmission");
      return typeof transmission === "number" && transmission > 0;
    };
    const refused = mainKeys(cells).filter(transmissive);
    const recorded = mainKeys(cells).filter((mesh) => transmissive(mesh) === false);
    expect(refused.length).toBeGreaterThan(0);
    expect(recorded.length).toBeGreaterThan(0);
    // The transmissive batch is submitted per object, which is the path every main batch drew before
    // bundles existed, and never appears in a record.
    for (const mesh of refused) {
      expect(drawn.perObject).toContain(mesh);
      expect(drawn.bundled).not.toContain(mesh);
      expect(mesh.parent).toBe(cells);
      expect(mesh.userData.tnBundled).not.toBe(true);
    }
    // Its sibling is recorded, so the group is the whole of what a bundle can hold rather than a
    // world that gave up on recording.
    for (const mesh of recorded) expect(drawn.bundled).toContain(mesh);
    expect(mainBundleGroups(cells).length).toBeGreaterThan(0);
    // And a refused draw keeps the coarse gate that hides it, because that is the CPU path's answer:
    // a record's render list is fixed when it was recorded and never reads `visible` again.
    const watched = watchVisible(refused);
    turn(cells, renderer, 20, [0, 1]);
    for (const held of watched.values()) expect(held.count).toBeGreaterThan(0);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("records a main batch the GPU scene does not own, so its window costs no traversal", async () => {
    // The `instanced` source is a main batch the GPU scene never dressed, and it is the one main
    // batch a record could not take: `#dressGpu` was the only caller of `#bundleIn`, so every key
    // outside the scene's answer — a backend with no compute, `gpuScene: false`, a dress that gave up
    // — was submitted per object for the whole walk. Its window is a per-frame answer, which is
    // exactly what a frozen render list cannot re-read, so the record answers the gate instead: a
    // batch the gate shows is recorded, a batch it hides leaves, and a window that moved re-records.
    // Same trade a cell's chunk record makes, and the same one the visual A/B judged equal.
    const { renderer, world: cells } = await world({ bundles: true, gpuScene: false });
    cells.update(renderer, playerCamera());
    await flushed(cells, renderer, playerCamera());

    expect(cells.stats().gpuScene.on).toBe(false);
    const dressed = mainKeys(cells);
    expect(dressed.length).toBeGreaterThan(0);
    const drawn = project(cells, playerCamera());
    // Zero of them walks three's per-object path — that traversal is what AC-1's draw span is — and
    // the record draws the very same meshes in their place.
    expect(drawn.perObject.filter(isMainBatch)).toEqual([]);
    expect(names(drawn.bundled.filter(isMainBatch))).toEqual(names(dressed));
    // The picture is the same one: every one of them is in the one record, still cull-free because a
    // record's list was cut by its own camera, and nothing failed on the way.
    for (const mesh of dressed) {
      expect(mesh.userData.tnBundled).toBe(true);
      expect(mesh.frustumCulled).toBe(false);
      expect(mesh.visible).toBe(true);
    }
    expect(cells.stats().failures).toBe(0);
    // And the gate is what the record answers with: turning the camera is what moves a key in and out
    // of it, and the union over the two directions the ring holds is every key. A record that ignored
    // the gate would hold all of them from whichever camera last recorded it.
    cells.update(renderer, eastCamera());
    const east = project(cells, eastCamera()).bundled.filter(isMainBatch);
    cells.update(renderer, playerCamera());
    const west = project(cells, playerCamera()).bundled.filter(isMainBatch);
    expect(west.length).toBeGreaterThan(0);
    expect(east.length).toBeGreaterThan(0);
    expect([...new Set([...names(west), ...names(east)])].sort()).toEqual(names(dressed));
    cells.dispose();
  });

  it("reuses structural bundle eligibility without recursive values allocations on a settled CPU frame", async () => {
    const painted = new MeshStandardNodeMaterial();
    const probe = {
      isBundleProbe: true,
      nested: { node: { isNode: true, updateBeforeType: "none" } },
    };
    painted.userData.bundleProbe = probe;
    const values = vi.spyOn(Object, "values");
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      expect(mainKeys(cells).length).toBeGreaterThan(1);
      values.mockClear();
      const records = cells.stats().bundle.records;
      for (let frame = 0; frame < 20; frame++) cells.update(renderer, playerCamera());
      expect(values.mock.calls.filter(([value]) => value === probe)).toHaveLength(0);
      expect(cells.stats().bundle.records).toBe(records);
      expect(cells.stats().bundle).toMatchObject({
        on: true,
        cpuMeshes: expect.any(Number),
        gpuMeshes: 0,
      });
      expect(cells.stats().bundle.cpuMeshes).toBeGreaterThan(0);
    } finally {
      cells.dispose();
    }
  });
  it("validates own TSL graph properties without visiting inherited chain methods", async () => {
    const painted = new MeshStandardNodeMaterial();
    const node = uniform(1);
    painted.colorNode = node;
    // The installed TSL prototype carries thousands of enumerable chaining methods. They are
    // outside Object.values' safety graph, so scanning them cannot certify any additional link.
    const inherited = new Set<string>();
    for (const key in node) if (!Object.hasOwn(node, key)) inherited.add(key);
    expect(inherited.size).toBeGreaterThan(1000);
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      const records = cells.stats().bundle.records;
      const validations = cells.stats().bundle.eligibility.validations;
      const hasOwn = vi.spyOn(Object, "hasOwn");
      for (let frame = 0; frame < 20; frame++) cells.update(renderer, playerCamera());
      expect(cells.stats().bundle.eligibility.validations).toBeGreaterThan(validations);
      expect(cells.stats().bundle.records).toBe(records);
      expect(
        hasOwn.mock.calls.filter(([object, key]) => object === node && inherited.has(String(key))),
      ).toHaveLength(0);
    } finally {
      cells.dispose();
    }
  });
  it("matches Three's exclusion of a directly inherited Node child", async () => {
    const painted = new MeshStandardNodeMaterial();
    const node = uniform(1);
    const reader = viewportSharedTexture();
    const prototype = Object.create(Object.getPrototypeOf(node));
    prototype.bundleInheritedChild = reader;
    Object.setPrototypeOf(node, prototype);
    painted.colorNode = node;
    expect([...node.getChildren()]).not.toContain(reader);
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      const keys = mainKeys(cells);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
    } finally {
      cells.dispose();
    }
  });
  it.each(["node", "material"] as const)(
    "checks a renderer-visible non-enumerable %s child and its deep mutation",
    async (target) => {
      const painted = new MeshStandardNodeMaterial();
      const root = uniform(1);
      const child = uniform(2);
      Reflect.set(child, "updateBefore", () => undefined);
      if (target === "node") {
        Object.defineProperty(root, "bundleHiddenChild", {
          value: child,
          enumerable: false,
          configurable: true,
        });
        painted.colorNode = root;
        expect([...root.getChildren()]).toContain(child);
      } else {
        Object.defineProperty(painted, "colorNode", {
          value: child,
          enumerable: false,
          configurable: true,
        });
        const getNodes = Reflect.get(painted, "_getNodeChildren") as () => { childNode: unknown }[];
        expect(getNodes.call(painted).map((entry) => entry.childNode)).toContain(child);
      }
      const { renderer, world: cells } = await world({
        bundles: true,
        gpuScene: false,
        chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
      });
      try {
        cells.update(renderer, playerCamera());
        await flushed(cells, renderer, playerCamera());
        const keys = mainKeys(cells);
        expect(keys.length).toBeGreaterThan(0);
        expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
        Reflect.set(child, "updateBeforeType", "render");
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
        Reflect.set(child, "updateBeforeType", "none");
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
      } finally {
        cells.dispose();
      }
    },
  );
  it.each(["dictionary", "sparse-array"] as const)(
    "checks Three's inherited %s child, prototype change and unversioned mutation",
    async (container) => {
      const painted = new MeshStandardNodeMaterial();
      const root = uniform(1);
      const child = uniform(2);
      Reflect.set(child, "updateBefore", () => undefined);
      const branch = container === "dictionary" ? Object.create(null) : new Array(105);
      Reflect.set(root, "bundleChildren", branch);
      painted.colorNode = root;
      const { renderer, world: cells } = await world({
        bundles: true,
        gpuScene: false,
        chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
      });
      const prototype = container === "dictionary" ? Object.prototype : Array.prototype;
      const arrayLength = Object.getOwnPropertyDescriptor(Array.prototype, "length");
      const key = container === "dictionary" ? "bundleInheritedChild" : "104";
      expect(Object.hasOwn(prototype, key)).toBe(false);
      try {
        cells.update(renderer, playerCamera());
        await flushed(cells, renderer, playerCamera());
        const keys = mainKeys(cells);
        expect(keys.length).toBeGreaterThan(0);
        expect([...root.getChildren()]).not.toContain(child);
        const records = cells.stats().bundle.records;
        Object.defineProperty(prototype, key, {
          value: child,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        if (container === "dictionary") Object.setPrototypeOf(branch, Object.prototype);
        expect([...root.getChildren()]).toContain(child);
        cells.update(renderer, playerCamera());
        expect(cells.stats().bundle.records).toBeGreaterThan(records);
        Reflect.set(child, "updateBeforeType", "render");
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
        Reflect.set(child, "updateBeforeType", "none");
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
      } finally {
        Reflect.deleteProperty(prototype, key);
        if (container === "sparse-array" && arrayLength !== undefined)
          Object.defineProperty(Array.prototype, "length", arrayLength);
        cells.dispose();
      }
    },
  );
  it.each([
    "malformed",
    "oversized",
    "reader-error",
    "iterator-error",
    "invalid-iterator",
  ] as const)(
    "retains the source path for %s Node child output and permits repair",
    async (output) => {
      const painted = new MeshStandardNodeMaterial();
      const root = uniform(1);
      const child = uniform(2);
      painted.colorNode = root;
      const { renderer, world: cells } = await world({
        bundles: true,
        gpuScene: false,
        chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
      });
      try {
        cells.update(renderer, playerCamera());
        await flushed(cells, renderer, playerCamera());
        const keys = mainKeys(cells);
        expect(keys.length).toBeGreaterThan(0);
        Reflect.set(root, "getChildren", () => {
          if (output === "reader-error") throw new Error("reader failed");
          if (output === "invalid-iterator")
            return { [Symbol.iterator]: () => ({ next: () => 1 }) };
          return (function* () {
            if (output === "iterator-error") throw new Error("iterator failed");
            if (output === "malformed") yield {};
            else for (let index = 0; index < 8193; index++) yield child;
          })();
        });
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
        expect(keys.every((mesh) => mesh.parent === cells)).toBe(true);
        Reflect.deleteProperty(root, "getChildren");
        cells.update(renderer, playerCamera());
        expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
      } finally {
        cells.dispose();
      }
    },
  );
  it("removes CPU keys on a deep unsafe graph edit without needsUpdate and records them again after repair", async () => {
    const painted = new MeshStandardNodeMaterial();
    const branch: { child?: unknown } = {};
    painted.userData.branch = branch;
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      const keys = mainKeys(cells);
      expect(keys.length).toBeGreaterThan(0);
      expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
      branch.child = { isNode: true, updateBefore() {}, updateBeforeType: "render" };
      cells.update(renderer, playerCamera());
      expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
      expect(keys.every((mesh) => mesh.parent === cells)).toBe(true);
      const refused = cells.stats().bundle.records;
      Reflect.deleteProperty(branch, "child");
      cells.update(renderer, playerCamera());
      expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
      expect(cells.stats().bundle.records).toBeGreaterThan(refused);
      const recorded = cells.stats().bundle.records;
      painted.needsUpdate = true;
      cells.update(renderer, playerCamera());
      expect(cells.stats().bundle.records).toBeGreaterThan(recorded);
    } finally {
      cells.dispose();
    }
  });
  it("rerecords live CPU material visibility changes without needsUpdate", async () => {
    const painted = new MeshStandardNodeMaterial();
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      const before = cells.stats().bundle.records;
      painted.visible = false;
      cells.update(renderer, playerCamera());
      const hidden = cells.stats().bundle.records;
      expect(hidden).toBeGreaterThan(before);
      painted.visible = true;
      cells.update(renderer, playerCamera());
      expect(cells.stats().bundle.records).toBeGreaterThan(hidden);
    } finally {
      cells.dispose();
    }
  });
  it("keeps mutable CPU array materials on the per-object path", async () => {
    const painted = new MeshStandardNodeMaterial();
    const { renderer, world: cells } = await world({
      bundles: true,
      gpuScene: false,
      chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
    });
    try {
      cells.update(renderer, playerCamera());
      await flushed(cells, renderer, playerCamera());
      const keys = mainKeys(cells);
      expect(keys.length).toBeGreaterThan(0);
      for (const mesh of keys) mesh.material = [painted, new MeshStandardNodeMaterial()];
      cells.update(renderer, playerCamera());
      expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
      expect(keys.every((mesh) => mesh.parent === cells)).toBe(true);
    } finally {
      cells.dispose();
    }
  });
  it.each(["root", "flag", "transparent", "transmission", "hook", "node-version"] as const)(
    "invalidates CPU bundle eligibility and records on %s mutation",
    async (mutation) => {
      const painted = new MeshStandardNodeMaterial();
      const node = { isNode: true, updateBefore() {}, updateBeforeType: "none", version: 0 };
      const branch = { child: node, pixels: new Uint8Array(64) };
      painted.userData.branch = branch;
      Reflect.set(branch, "self", branch);
      const { renderer, world: cells } = await world({
        bundles: true,
        gpuScene: false,
        chunkModel: (url) => standAtCellOf(url, chunkOf([painted])),
      });
      try {
        cells.update(renderer, playerCamera());
        await flushed(cells, renderer, playerCamera());
        const keys = mainKeys(cells);
        expect(keys.length).toBeGreaterThan(0);
        const before = cells.stats().bundle.records;
        if (mutation === "root")
          painted.userData.branch = {
            child: { isNode: true, updateBefore() {}, updateBeforeType: "render" },
          };
        if (mutation === "flag") node.updateBeforeType = "render";
        if (mutation === "transparent") painted.transparent = true;
        if (mutation === "transmission") Reflect.set(painted, "transmission", 0.5);
        if (mutation === "hook") for (const mesh of keys) mesh.onBeforeRender = () => undefined;
        if (mutation === "node-version") node.version++;
        cells.update(renderer, playerCamera());
        if (mutation === "node-version") {
          expect(keys.every((mesh) => mesh.userData.tnBundled)).toBe(true);
          expect(cells.stats().bundle.records).toBeGreaterThan(before);
        } else {
          expect(keys.every((mesh) => mesh.userData.tnBundled === false)).toBe(true);
          expect(keys.every((mesh) => mesh.parent === cells)).toBe(true);
        }
      } finally {
        cells.dispose();
      }
    },
  );

  it("re-records a main shard in the same update that changed which meshes it holds", async () => {
    // A record fixes its render list, so a mesh that joins a shard and is not followed by a re-record
    // of that shard is not drawn until some later event happens to bump the same group. With one
    // group that was masked: any key minted in the same load bumped it. With a group per shard the
    // repair needs a bump in the *same* shard, so a join without one hides geometry for as long as
    // that shard stays quiet — Machinefall's first capture lost its mid-field forest at the pose the
    // overlay drops on, and a re-capture of the same build had it.
    const {
      follow,
      renderer,
      world: cells,
    } = await world({
      bundles: true,
      gpuScene: false,
      rockInWest: true,
    });
    const members = (group: BundleGroup): string =>
      group.children
        .map((child) => `${child.name}#${child.id}`)
        .sort()
        .join(",");
    const stale: string[] = [];
    const check = (label: string, camera: PerspectiveCamera): void => {
      const before = new Map(
        mainBundleGroups(cells).map((group) => [group, [members(group), group.version] as const]),
      );
      cells.update(renderer, camera);
      for (const group of mainBundleGroups(cells)) {
        const was = before.get(group);
        const changed = was === undefined ? group.children.length > 0 : was[0] !== members(group);
        const rerecorded = was === undefined ? group.version > 0 : group.version > was[1];
        if (changed && !rerecorded) stale.push(`${label}: ${group.children.length} meshes`);
      }
    };
    for (let index = 0; index < 8; index += 1) check("settle", playerCamera());
    await flushed(cells, renderer, playerCamera());
    for (let phase = 0; phase < 5; phase += 1) {
      const at = cellCentre(phase % 2 === 0 ? 3 : 1, 1);
      follow.position.x = at.x;
      follow.position.z = at.z;
      for (let index = 0; index < 12; index += 1)
        check(`walk-${phase}`, phase % 2 === 0 ? eastCamera() : playerCamera());
      await flushed(cells, renderer, playerCamera());
    }
    expect(stale).toEqual([]);
    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("re-records a shard recorded during a compile once the compile has settled", async () => {
    // Three encodes a draw only when its pipeline is ready, so a record cut while a `compileAsync`
    // overlaps silently leaves the not-yet-ready draw out — and the replay never re-checks. A shard
    // bumped during a compile must be re-recorded once the compile settles, or its geometry stays
    // missing until something else happens to bump that same shard.
    const {
      follow,
      renderer,
      world: cells,
    } = await world({
      bundles: true,
      gpuScene: false,
      rockInWest: true,
    });
    cells.update(renderer, playerCamera([0, 1]));
    await flushed(cells, renderer, playerCamera([0, 1]));

    // The stub with a settable compile state: `compiling` in flight and a compile that has started.
    const busy: IRendererLike & { compiling: boolean; compileCount: number } = Object.assign(
      Object.create(renderer) as IRendererLike,
      { compileCount: 1, compiling: true },
    );

    const before = new Map(mainBundleGroups(cells).map((group) => [group, group.version]));
    // Walk east into a new cell with a compile in flight, so the shards the walk re-dresses are
    // recorded during a busy renderer.
    const at = cellCentre(3, 1);
    follow.position.x = at.x;
    follow.position.z = at.z;
    cells.update(busy, playerCamera([0, 1]));
    await flushed(cells, busy, playerCamera([0, 1]));
    const bumped = [...before]
      .filter(([group, version]) => group.version !== version)
      .map(([group]) => group);
    expect(bumped.length).toBeGreaterThan(0);
    const during = new Map(bumped.map((group) => [group, group.version]));

    // The compile settles: the same `compileCount`, no longer `compiling`. Every shard the busy
    // phase recorded has to be re-recorded, or the draw it left out is never drawn again.
    busy.compiling = false;
    for (let index = 0; index < 2; index += 1) cells.update(busy, playerCamera([0, 1]));
    for (const group of bumped) expect(group.version).toBeGreaterThan(during.get(group) as number);

    // Settled once, not every frame: further resting frames change no shard's version.
    const settled = new Map(mainBundleGroups(cells).map((group) => [group, group.version]));
    for (let index = 0; index < 20; index += 1) cells.update(busy, playerCamera([0, 1]));
    for (const group of mainBundleGroups(cells)) expect(group.version).toBe(settled.get(group));

    expect(cells.stats().failures).toBe(0);
    cells.dispose();
  });

  it("records by default, and the marker says the run asked for nothing else", async () => {
    // Phase 2 box 2: the default follows the measurement. AC-2 measured the walking `draw` span at
    // -5.0 ms against develop over 3 interleaved runs with bundles on, so a world that says nothing
    // is on — and says so, because the one thing a run must not hide is which path it took.
    const lines = captureMarkers();
    let clock = 0;
    const { renderer, world: cells } = await world({ admissionNow: () => clock + realNow() });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());
    clock += 6e3;
    cells.update(renderer, eastCamera());

    expect(cells.stats().bundle.on).toBe(true);
    expect(cells.stats().bundle.reason).toBe("default");
    expect(bundleMarker(lines)).toContain("TN_WORLD_BUNDLE on reason=default");
    // And the walk really is replaying: every main batch hangs in a main record shard.
    const groups = mainBundleGroups(cells);
    expect(groups.length).toBeGreaterThan(0);
    for (const mesh of mainKeys(cells)) expect(groups).toContain(mesh.parent);
    cells.dispose();
  });

  it("honours `bundles: false`, and the marker says the game overrode the default", async () => {
    // The override is the named one on the same object, so it can come back to a picture a machine
    // cannot run: the per-object path every main batch drew before this PRD, and the marker says the
    // run is not on the default.
    const lines = captureMarkers();
    let clock = 0;
    const { renderer, world: cells } = await world({
      admissionNow: () => clock + realNow(),
      bundles: false,
    });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());
    clock += 6e3;
    cells.update(renderer, eastCamera());

    expect(cells.stats().bundle.on).toBe(false);
    expect(cells.stats().bundle.reason).toBe("option");
    expect(bundleMarker(lines)).toContain("TN_WORLD_BUNDLE off reason=option");
    expect(mainBundleGroups(cells)).toEqual([]);
    cells.dispose();
  });

  it("honours a launch override, and the marker says the launch asked", async () => {
    // The same switch from the outside — `?tnBundles=0`, `TN_BUNDLES=0` or `__tnBundles = 0` — so a
    // machine can A/B a picture without a source change, and the line says which arm it was.
    vi.stubGlobal("__tnBundles", 0);
    const lines = captureMarkers();
    let clock = 0;
    const { renderer, world: cells } = await world({ admissionNow: () => clock + realNow() });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());
    clock += 6e3;
    cells.update(renderer, eastCamera());

    expect(cells.stats().bundle.on).toBe(false);
    expect(cells.stats().bundle.reason).toBe("launch");
    expect(bundleMarker(lines)).toContain("TN_WORLD_BUNDLE off reason=launch");
    expect(mainBundleGroups(cells)).toEqual([]);
    cells.dispose();
  });

  it("hides a cell's chunk record while the cull cannot see the cell, and shows it again", async () => {
    const { renderer, world: cells } = await world({ bundles: true });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());

    // One group per cell that has a chunk, and the one that holds cell (1, 1)'s is the answer the
    // camera gets from the east: the cell is ahead, so the record is drawn.
    const groups = chunkBundles(cells);
    expect(groups.length).toBeGreaterThan(0);
    cells.update(renderer, eastCamera());
    const drawn = groups.filter((group) => group.visible);
    expect(drawn.length).toBeGreaterThan(0);
    const resident = names(chunkMeshes(cells));
    // Turned west, that same cell is behind the camera and its record goes out of the frame whole —
    // the one lever a frozen render list has, and the granularity the main cull already answers at.
    cells.update(renderer, playerCamera());
    for (const group of drawn) expect(group.visible).toBe(false);
    // The chunk was never removed from the world, only unanswered: it is still there for the next
    // frame that can see it, and it is the record, not a per-mesh `visible`, that came and went.
    expect(names(chunkMeshes(cells))).toEqual(resident);
    cells.update(renderer, eastCamera());
    for (const group of drawn) expect(group.visible).toBe(true);
    cells.dispose();
  });

  it("re-records a chunk cell when its chunks attach, and drops the record when the cell leaves", async () => {
    const { follow, renderer, world: cells } = await world({ bundles: true });
    cells.update(renderer, eastCamera());
    await flushed(cells, renderer, eastCamera());

    // One record per attach: the recorded list does not hold this render object, and the replay
    // would draw the cell's chunks without it.
    expect(chunkBundles(cells).length).toBeGreaterThan(0);
    const settled = cells.stats().bundle;
    expect(settled.on).toBe(true);
    expect(settled.records).toBeGreaterThan(0);
    expect(settled.children).toBeGreaterThan(0);
    // A camera at rest streams nothing, so nothing re-records — including the chunk groups, whose
    // visibility the cull answers with a write rather than with a record.
    for (let index = 0; index < 40; index += 1) cells.update(renderer, eastCamera());
    expect(cells.stats().bundle.records).toBe(settled.records);

    // Far enough east that neither cell that owns a chunk is resident: the record goes with the cell,
    // so no frame can replay a cell the world has released.
    follow.position.x = cellCentre(4, 1).x;
    for (let pass = 0; pass < 40 && cells.stats().residentKeys.includes("1:1"); pass += 1) {
      cells.update(renderer, eastCamera());
      await flush();
    }
    expect(cells.stats().residentKeys).not.toContain("1:1");
    expect(cells.stats().residentKeys).not.toContain("0:2");
    expect(chunkBundles(cells)).toEqual([]);
    expect(chunkMeshes(cells)).toEqual([]);
    // And the stat gives the chunks back rather than counting records nothing owns any more.
    expect(cells.stats().bundle.children).toBe(
      mainBundleGroups(cells).reduce((sum, group) => sum + group.children.length, 0),
    );
    expect(cells.stats().bundle.records).toBeGreaterThan(settled.records);
    cells.dispose();
  });

  it("does not enumerate a typed array in bundleSafeMaterial", () => {
    const material = new MeshBasicMaterial();
    (material.userData as { pixels?: Float32Array }).pixels = new Float32Array(1_000_000);
    // Each Object.values entry is one walk step. A typed array has one entry per element.
    const realValues = Object.values;
    let enumerated = 0;
    const spy = vi.spyOn(Object, "values").mockImplementation((target) => {
      const values = realValues(target);
      enumerated += values.length;
      return values;
    });
    try {
      expect(bundleSafeMaterial(material)).toBe(true);
      expect(enumerated).toBeLessThan(10_000);
    } finally {
      spy.mockRestore();
    }
  });
});
