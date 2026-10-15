import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  DepthTexture,
  Frustum,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Vector3,
  WebGPUCoordinateSystem,
} from "three";
// @ts-expect-error Three's render-object module has no public declaration; this test exercises the
// draw gate itself, which is what the submission contract is about.
import RenderObject from "three/src/renderers/common/RenderObject.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lodBias, setLodBias } from "../src/model-lod.js";
import {
  type IDepthPyramid,
  type IKernelOcclusion,
  type IOcclusionFrame,
  buildDepthPyramid,
  occludedBy,
} from "../src/render/depth-pyramid.js";
import type { IRendererLike } from "../src/renderer.js";
import { isStatic } from "../src/static-transform.js";
import {
  COARSEST_SHADOW_LEVEL,
  DRAW_ARGS_BYTES,
  type IAssetSlot,
  type IGpuPlacement,
  type IKernelInput,
  type IKernelResult,
  type ILiveAsset,
  type IMeshDraw,
  type IRegion,
  WorldGpuScene,
  addRange,
  compareMeshDraws,
  cullAndSelect,
  cullAndSelectShadow,
  gpuSceneUnsupported,
  levelAtGates,
  liveKeyInstances,
  storageElementBytes,
  validationReport,
} from "../src/world-gpu-scene.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * The GPU scene's per-instance kernel, proved against the CPU path it replaces.
 *
 * The reference is `cullAndSelect` — plain TypeScript, no GPU, the exact branch order the TSL
 * kernel mirrors — so this is where AC-1's "the drawn instance set equals the CPU reference path's
 * set, frame by frame" and AC-6's "regions never overflow" are proved at all. The kernel itself is
 * compiled in a browser and is not what these tests can see.
 */

/** A camera whose frustum every placement in the fixture is inside, so cull is not what is tested. */
function cameraAt(x: number, z: number): { camera: PerspectiveCamera; planes: Float32Array } {
  const camera = new PerspectiveCamera(60, 1, 0.1, 10_000);
  camera.position.set(x, 0, z);
  camera.lookAt(x, 0, z + 1);
  camera.updateMatrixWorld(true);
  const frustum = new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
  const planes = new Float32Array(24);
  for (const [index, plane] of frustum.planes.entries()) {
    const at = index * 4;
    planes[at] = plane.normal.x;
    planes[at + 1] = plane.normal.y;
    planes[at + 2] = plane.normal.z;
    planes[at + 3] = plane.constant;
  }
  return { camera, planes };
}

/** One placement at `(x, z)`, at the given distance from the origin along +Z. */
function placement(x: number, y: number, z: number, slot: number, radius = 0.5): IGpuPlacement {
  const matrix = new Matrix4().makeTranslation(x, y, z);
  return {
    centre: new Float32Array([x, y, z, radius]),
    matrix: new Float32Array(matrix.elements),
    slot,
  };
}

/**
 * The CPU path's own selection, written out from `world-cells.ts`: `levelAt` is the ascending
 * `distance > gate` test and `cullDistance` is `maxDistance` less its eighth. A key's drawn set is
 * the placements that reach it.
 */
function cpuReference(
  placements: readonly IGpuPlacement[],
  origin: { x: number; z: number; planes: Float32Array },
  slot: number,
  distances: readonly number[],
  cull: number | undefined,
  firstKey: number,
  parts: number,
): Map<number, number[]> {
  const drawn = new Map<number, number[]>();
  // One entry per level's part, exactly as the GPU scene's key table holds them.
  for (let key = firstKey; key < firstKey + parts * distances.length; key += 1) drawn.set(key, []);
  const planes = origin.planes;
  for (const [index, one] of placements.entries()) {
    // `#addPlacements` runs per asset: a key's drawn set is its own asset's placements only, so
    // another slot's placement reaching the same level is not in this key's set.
    if (one.slot !== slot) continue;
    const at = one.centre;
    // The coarse CPU cull and the GPU's per-placement sphere test are the same six planes: what is
    // compared here is the level selection and the per-key set, on the placements both keep.
    let inside = true;
    for (let plane = 0; plane < 6; plane += 1) {
      const base = plane * 4;
      const signed =
        (planes[base] as number) * (at[0] as number) +
        (planes[base + 1] as number) * (at[1] as number) +
        (planes[base + 2] as number) * (at[2] as number) +
        (planes[base + 3] as number);
      if (signed < -(at[3] as number)) {
        inside = false;
        break;
      }
    }
    if (inside === false) continue;
    const distance = Math.hypot((at[0] as number) - origin.x, (at[2] as number) - origin.z);
    if (cull !== undefined && distance > cull) continue;
    let level = 0;
    for (let gate = 1; gate < distances.length; gate += 1)
      if (distance > (distances[gate] as number)) level = gate;
    const key = firstKey + level * parts;
    drawn.get(key)?.push(index);
  }
  return drawn;
}

/**
 * The CPU path's own instances for one key, written out from `world-cells.ts` and naming no key at
 * all: the placements of one asset that its cull distance keeps, whose `distance > gate` level test
 * reaches the level this key is, each multiplied by the part's own offset as `#addPlacements` does.
 * A reference built this way cannot agree with a wrong `firstKey`, because it never heard of one.
 */
function cpuKeyInstances(
  placements: readonly IGpuPlacement[],
  slot: number,
  level: number,
  distances: readonly number[],
  cull: number | undefined,
  local: Float32Array,
): Float32Array {
  const wanted = placements.filter((one) => {
    if (one.slot !== slot) return false;
    const distance = Math.hypot(one.centre[0] as number, one.centre[2] as number);
    if (cull !== undefined && distance > cull) return false;
    let reached = 0;
    for (let gate = 1; gate < distances.length; gate += 1)
      if (distance > (distances[gate] as number)) reached = gate;
    return reached === level;
  });
  const out = new Float32Array(wanted.length * 16);
  const part = new Matrix4().fromArray(local);
  for (const [index, one] of wanted.entries())
    new Matrix4()
      .fromArray(one.matrix)
      .multiply(part)
      .toArray(out, index * 16);
  return out;
}

/** The reference kernel's drawn placement indexes per key, read back out of its `drawn` buffer. */ function kernelDrawn(
  result: ReturnType<typeof cullAndSelect>,
  input: IKernelInput,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (let key = 0; key < input.regions.length; key += 1) out.set(key, []);
  // The regions are disjoint, so a drawn matrix names exactly one placement: the one whose world
  // translation it carries. `local` is the identity throughout this fixture, so the drawn matrix is
  // the placement matrix and the lookup is the translation, not a full compare.
  for (const [key, region] of input.regions.entries()) {
    const count = result.counts[key] as number;
    for (let taken = 0; taken < count; taken += 1) {
      const at = (region.start + taken) * 16;
      const x = result.drawn[at + 12] as number;
      const z = result.drawn[at + 14] as number;
      const found = input.placements.findIndex(
        (one, index) =>
          one.slot >= 0 &&
          Math.abs((one.matrix[12] as number) - x) < 1e-5 &&
          Math.abs((one.matrix[14] as number) - z) < 1e-5,
      );
      if (found < 0) throw new Error(`region ${String(key)} drew a matrix no placement owns.`);
      out.get(key)?.push(found);
    }
  }
  return out;
}

const DISTANCES = [0, 40, 120] as const;
const LOCAL = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

/**
 * The committed `world-v1` package, which is what the wiring half below streams: one `pine` asset
 * with a run per cell, so a walk over its ring admits, refills and evicts real records. The harness
 * is the main-cull spec's, unchanged — the same package, the same camera, the same flush — so a
 * number here and a number there are about the same world.
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

/** Every `pine` placement each cell files, so a cell's own records are a number. */
const PINE = new Map<string, number>();
for (const cell of manifest.cells)
  for (const run of cell.runs)
    if (run.asset === "pine") PINE.set(`${String(cell.x)},${String(cell.z)}`, run.count);

function pineIn(...cells: string[]): number {
  return cells.reduce((sum, cell) => sum + (PINE.get(cell) ?? 0), 0);
}

/** The world-space centre of cell `(x, z)`, from the package's own extent and cell size. */
function cellCentre(x: number, z: number): { x: number; z: number } {
  return { x: manifest.extent.minX + (x + 0.5) * CELL, z: manifest.extent.minZ + (z + 0.5) * CELL };
}

/** The complete source transform set for resident cells, independent of WorldGpuScene storage. */
function sourceMatricesFor(...cells: string[]): string[] {
  const wanted = new Set(cells);
  const records = new Float32Array(
    placementBytes.buffer,
    placementBytes.byteOffset,
    placementBytes.byteLength / Float32Array.BYTES_PER_ELEMENT,
  );
  const matrices: string[] = [];
  for (const cell of manifest.cells) {
    if (!wanted.has(`${String(cell.x)},${String(cell.z)}`)) continue;
    for (const run of cell.runs)
      for (let index = 0; index < run.count; index += 1) {
        const base = (run.offset + index) * 8;
        const matrix = new Matrix4().compose(
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
        matrices.push(Float32Array.from(matrix.elements).join(","));
      }
  }
  return matrices.sort();
}

function plainModel(): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

/** A tree of two parts — trunk and canopy — each with its own material, so the asset is multi-part. */
function multiPartModel(): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  group.add(new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshBasicMaterial()));
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
 * The package with `pine`'s authored `lods` removed, so every one of its placements is drawn at level
 * 0 and a cell's worth of a key is exactly the count its run states. `authoredLods` keeps them, for
 * the tests about what minting a level's key regrows.
 */
function stubManifestFetch(authoredLods = false): void {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  const pkg: IWorldPackage = {
    ...manifest,
    assets: {
      ...manifest.assets,
      pine: authoredLods ? pine : { bounds: pine.bounds, glb: pine.glb },
    },
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

/**
 * A one-asset package whose prop reaches ten metres along +Z of its placement point, with that one
 * placement turned a quarter turn about +Y, over the committed terrain and extent.
 *
 * The production `WorldCells` build is what places the source record, so the sphere it hands the
 * dispatch is the sphere the wiring actually computes. Answers the centre the rotation should carry:
 * the authored centre `(0, 0, 10)` under the turn lands at `(10, 0, 0)`, and the radius is half the
 * authored bounds' diagonal: a 0..20 span is a diagonal of 20, so `10`. It used to be halved a second
 * time to `5`, a sphere inside the prop that culled the half reaching away from the placement point.
 */
function stubTurnedPropFetch(scale = 1): {
  centre: { x: number; y: number; z: number };
  radius: number;
} {
  const pkg: IWorldPackage = {
    assets: { prop: { bounds: { max: [0, 0, 20], min: [0, 0, 0] }, glb: "prop.glb" } },
    cellSize: CELL,
    cells: [{ runs: [{ asset: "prop", count: 1, offset: 0 }], x: 0, z: 0 }],
    extent: manifest.extent,
    placements: "placements.bin",
    terrain: manifest.terrain,
    version: 1,
  };
  // One record: x, y, z, the quaternion (x, y, z, w) of a +Y quarter turn, and the placement scale.
  const half = Math.SQRT1_2;
  const records = new Float32Array([0, 0, 0, 0, half, 0, half, scale]);
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
      if (url.endsWith("placements.bin")) return fileResponse(Buffer.from(records.buffer));
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
  return { centre: { x: 10 * scale, y: 0, z: 0 }, radius: 10 * scale };
}

/**
 * A player camera in the middle of cell (0,1) at head height, looking west: the main-cull spec's
 * camera, so the visible visibility cells are the ones the coarse gate below is judged against.
 */
function playerCamera(at: readonly [number, number] = [0, 1]): PerspectiveCamera {
  const centre = cellCentre(at[0], at[1]);
  const camera = new PerspectiveCamera(30, 1, 0.1, 1000);
  camera.position.set(centre.x, 4, centre.z);
  camera.lookAt(centre.x - CELL * 4, 4, centre.z);
  camera.updateMatrixWorld();
  return camera;
}

/** Every `WorldCells`-owned `InstancedMesh` under the world, whatever role or key it serves. */
function worldMeshes(world: WorldCells): InstancedMesh[] {
  const found: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh) found.push(object);
  });
  return found;
}

/** The `pine` level-0 main mesh: one per key, the one every camera here draws. */
function mainMesh(world: WorldCells): InstancedMesh {
  const mesh = worldMeshes(world).find((one) => one.name === "pine:0:0");
  if (mesh === undefined) throw new Error("the world has no pine:0:0 mesh.");
  return mesh;
}

/**
 * The main pass's own meshes. A main key is `asset:level:part` and a caster or wide half carries an
 * `@x,z` or `@*` of its own, so the name is what separates them.
 */
function mainKeys(world: WorldCells): InstancedMesh[] {
  return worldMeshes(world).filter((one) => one.name !== "" && !one.name.includes("@"));
}

/** Every main mesh of one level of one asset: `pine:0:0`, `pine:0:1`, … */
function mainLevel(world: WorldCells, asset: string, level: number): InstancedMesh[] {
  const prefix = `${asset}:${String(level)}:`;
  return mainKeys(world).filter((one) => one.name.startsWith(prefix));
}

/**
 * Whether three's own draw path admits this object, run on the real `RenderObject` the renderer
 * uses: `getDrawParameters` is the exact gate that suppresses an indirect draw. A zero
 * `InstancedMesh.count` makes it answer `null`, and the WebGPU backend returns before
 * `drawIndexedIndirect` — so the GPU's args record is never read, whatever the dispatch selected.
 * The fields below are the ones the renderer sets on a render object before drawing it.
 */
function threeAdmitsDraw(mesh: InstancedMesh): boolean {
  const object = Object.create(RenderObject.prototype) as {
    object: InstancedMesh;
    material: unknown;
    geometry: BufferGeometry;
    group: null;
    drawRange: { start: number; count: number };
    drawParams: null;
    _geometries: { getIndex: () => unknown };
    getDrawParameters: () => unknown;
  };
  object.object = mesh;
  object.material = mesh.material;
  object.geometry = mesh.geometry;
  object.group = null;
  object.drawRange = mesh.geometry.drawRange;
  object.drawParams = null;
  object._geometries = { getIndex: () => mesh.geometry.index ?? null };
  return object.getDrawParameters() !== null;
}

/**
 * A WebGPU renderer with no GPU behind it, which is what lets the world's own dispatch and its
 * markers run: the args it reads back are the zeros the clear dispatch never wrote, so the counts
 * mismatch the reference by construction and only `compared` — the number of regions the dispatch
 * had, the number that was `0` in the real run — is worth reading.
 */
function gpuRendererStub(log: string[] = []): IRendererLike {
  return {
    compute: (): void => {},
    kind: "webgpu",
    log: (message: string): void => {
      log.push(message);
    },
    readback: async (args: { array: Uint32Array }): Promise<ArrayBuffer> =>
      args.array.slice().buffer as ArrayBuffer,
    raw: { backend: { hasFeature: (): boolean => true } },
  } as unknown as IRendererLike;
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A scene wired the way the package's own assets wire it, and the reference that says what each key
 * must draw.
 *
 * The shapes below are the ones a real package is made of: authored `lods` with a `maxDistance`, an
 * asset whose model is several parts, a key a walk outgrows, and a prop whose model does not
 * straddle the origin. Each is compared against `cpuReference` — the CPU path's own level and cull
 * tests, written out in this file — key for key and placement for placement.
 */

/** The region index one main key owns, which is what a gate table and the kernel both address. */
function keyOf(scene: WorldGpuScene, name: string): number {
  const at = scene.regions.findIndex((one) => one.name === name);
  if (at < 0) throw new Error(`the scene has no region for ${name}.`);
  return at;
}

/** A scene with one asset per name, every level's `parts` keys minted in part order. */
function wired(
  assets: readonly {
    readonly name: string;
    readonly levels: readonly number[];
    readonly cull?: number;
  }[],
  parts: number,
  capacity: number,
): WorldGpuScene {
  const scene = new WorldGpuScene();
  scene.enable(
    { kind: "webgpu", raw: { backend: { hasFeature: () => true } }, compute: () => {} } as never,
    true,
  );
  for (const asset of assets) {
    const gates: { firstKey: number; parts: number }[] = [];
    for (const [level, distance] of asset.levels.entries()) {
      const group = `${asset.name}:${String(level)}`;
      for (let part = 0; part < parts; part += 1)
        scene.key(`${group}:${String(part)}`, LOCAL, capacity, { group, part, parts });
      gates.push(scene.levelKeys(group) ?? { firstKey: 0, parts: 0 });
    }
    scene.slot(asset.name, { cull: asset.cull, distances: asset.levels, levels: gates });
  }
  return scene;
}

/** `n` placements of `slot` spread along +Z from the origin, at the given spacing. */
function placed(
  scene: WorldGpuScene,
  slot: number,
  n: number,
  spacing: number,
  radius = 0.5,
): void {
  for (let index = 0; index < n; index += 1)
    scene.place(
      slot,
      new Matrix4().makeTranslation(0, 0, 12 + index * spacing),
      0,
      0,
      12 + index * spacing,
      radius,
    );
}

describe("WorldCells GPU-driven main pass", () => {
  it("draws the same set per key as the CPU path, over a 50-pose walk", () => {
    const slots = [
      {
        cull: undefined,
        distances: DISTANCES,
        levels: [
          { firstKey: 0, parts: 1 },
          { firstKey: 1, parts: 1 },
          { firstKey: 2, parts: 1 },
        ],
      },
      {
        cull: 260,
        distances: DISTANCES,
        levels: [
          { firstKey: 3, parts: 1 },
          { firstKey: 4, parts: 1 },
          { firstKey: 5, parts: 1 },
        ],
      },
    ];
    // Six contiguous regions, as a real key minting hands out.
    let start = 0;
    const regions: IRegion[] = slots.flatMap((slot) =>
      slot.levels.map((level, index) => {
        const region: {
          argsIndex: number;
          capacity: number;
          indexCount: number;
          local: Float32Array;
          start: number;
        } = {
          argsIndex: slots.indexOf(slot) * 3 + index,
          capacity: 4096,
          indexCount: 0,
          local: LOCAL,
          start,
        };
        start += region.capacity;
        return region;
      }),
    );

    // 200 placements over a 400 m square, every eighth on the second asset.
    const placements: IGpuPlacement[] = [];
    for (let index = 0; index < 200; index += 1) {
      const x = -200 + (index % 20) * 20;
      const z = -200 + Math.floor(index / 20) * 20;
      placements.push(placement(x, 0, z, index % 8 === 0 ? 1 : 0));
    }

    for (let pose = 0; pose < 50; pose += 1) {
      const origin = { x: -180 + pose * 7, z: -180 + (pose % 11) * 30 };
      const { planes } = cameraAt(origin.x, origin.z);
      const input: IKernelInput = {
        camera: { planes, x: origin.x, y: 0, z: origin.z },
        count: placements.length,
        placements,
        regionCount: regions.length,
        regions,
        slots,
      };
      const result = cullAndSelect(input);
      const fromKernel = kernelDrawn(result, input);
      for (const [slotIndex, slot] of slots.entries())
        for (const [level, gate] of slot.levels.entries()) {
          const key = slotIndex * 3 + level;
          const expected = cpuReference(
            placements,
            { planes, x: origin.x, z: origin.z },
            slotIndex,
            slot.distances,
            slot.cull,
            slot.levels[0]?.firstKey ?? 0,
            1,
          ).get(gate.firstKey) as number[];
          expect([...(fromKernel.get(key) as number[])].sort((a, b) => a - b)).toEqual(
            [...expected].sort((a, b) => a - b),
          );
          // And the args record the draw reads carries the same count.
          expect(result.args[gate.firstKey * 5 + 1]).toBe(expected.length);
          expect(result.args[gate.firstKey * 5 + 4]).toBe(regions[gate.firstKey]?.start);
        }
    }
  });

  it("never writes past a region, and regrows are structural only", () => {
    const scene = new WorldGpuScene();
    expect(scene.key("a:0:0", LOCAL, 2)).toBe(0);
    expect(scene.key("b:0:0", LOCAL, 4)).toBe(1);
    const first = scene.regionOf("a:0:0") as IRegion;
    const second = scene.regionOf("b:0:0") as IRegion;
    // Disjoint regions: a key's survivors can never land in another's.
    expect(first.start).toBe(0);
    expect(second.start).toBe(2);

    // Two placements, one region of two: the third is dropped, never written past the end.
    const regions: IRegion[] = [first, second];
    const slots = [
      { cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] },
      { cull: undefined, distances: [0], levels: [{ firstKey: 1, parts: 1 }] },
    ];
    const { planes } = cameraAt(0, 0);
    const result = cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: 3,
      placements: [placement(0, 0, 10, 0), placement(1, 0, 10, 0), placement(2, 0, 10, 0)],
      regionCount: 2,
      regions,
      slots,
    });
    expect(result.counts[0]).toBe(2);
    expect(result.counts[1]).toBe(0);
    expect(result.args[1]).toBe(2);

    // A key that asks for the room it already has is not a regrow, and one that asks for more is,
    // once, and lands at the tail.
    const version = scene.version;
    expect(scene.key("a:0:0", LOCAL, 2)).toBe(0);
    expect(scene.version).toBe(version);
    const grown = scene.key("a:0:0", LOCAL, 8);
    expect(grown).toBe(2);
    expect(scene.version).toBeGreaterThan(version);
    const regrown = scene.regionOf("a:0:0") as IRegion;
    expect(regrown.capacity).toBe(8);
    expect(regrown.start).toBe(6);
    scene.dispose();
  });

  it("keeps a level's run and the drawn buffer stable across unchanged registrations", () => {
    // The walk's own cadence: a re-dress asks for the keys it already has. Registering one is not a
    // structural change, and laying the level out again appended the whole group to the drawn
    // buffer's tail every call — so 200 unchanged registrations grew the buffer without bound until
    // a real GPU refused the allocation.
    const scene = wired([{ name: "pine", levels: [0, 40, 120] }], 2, 64);
    const drawnBytes = (): number => (scene.footprint().drawn as { bytes: number }).bytes;
    const bytesBefore = drawnBytes();
    const starts = scene.regions.map((region) => region.start);
    const capacities = scene.regions.map((region) => region.capacity);
    const version = scene.version;
    for (let round = 0; round < 200; round += 1)
      for (let level = 0; level < 3; level += 1)
        for (let part = 0; part < 2; part += 1)
          scene.key(`pine:${String(level)}:${String(part)}`, new Float32Array(LOCAL), 64, {
            group: `pine:${String(level)}`,
            part,
            parts: 2,
          });
    // The same buffer, size and offsets after 200 unchanged registrations: a no-op really is one.
    expect(drawnBytes()).toBe(bytesBefore);
    expect(scene.regions.map((region) => region.start)).toEqual(starts);
    expect(scene.regions.map((region) => region.capacity)).toEqual(capacities);
    expect(scene.version).toBe(version);
    scene.dispose();
  });

  it("bounds the drawn buffer when a level is repeatedly regrown and re-streamed", () => {
    // A walk outgrows a level's region, the ring streams, the level is regrown again: each structural
    // change re-packs every run from zero, so the buffer is the sum of the runs that exist, not of
    // every run ever abandoned. Without the re-pack each regrow left its old run behind and the
    // buffer grew by both parts per call, without bound.
    const scene = wired([{ name: "pine", levels: [0] }], 2, 4);
    const drawnBytes = (): number => (scene.footprint().drawn as { bytes: number }).bytes;
    let peak = drawnBytes();
    for (let round = 1; round <= 64; round += 1) {
      const capacity = 4 * round;
      for (const part of [0, 1])
        scene.key(`pine:0:${String(part)}`, LOCAL, capacity, { group: "pine:0", part, parts: 2 });
      const bytes = drawnBytes();
      peak = Math.max(peak, bytes);
      // Two parts of the current capacity, so the compaction reclaimed every abandoned run. The
      // doubling growth may round the allocation up to the next power of two, never past 2x.
      expect(bytes).toBeGreaterThanOrEqual(2 * 64 * capacity);
      expect(bytes).toBeLessThanOrEqual(4 * 64 * capacity);
    }
    // The peak is the last stale buffer, not a sum over 64 rounds of two 256-part relocations each.
    expect(peak).toBeLessThanOrEqual(4 * 64 * 4 * 64);
    scene.dispose();
  });

  it("falls back to the CPU path, and says why, on a backend without the three", () => {
    expect(gpuSceneUnsupported({ kind: "webgl2", raw: {} } as never)).toBe("backend=webgl2");
    expect(
      gpuSceneUnsupported({
        kind: "webgpu",
        raw: { backend: { hasFeature: () => false } },
      } as never),
    ).toBe("feature=core");
    expect(
      gpuSceneUnsupported({
        kind: "webgpu",
        raw: { backend: { hasFeature: (name: string) => name !== "indirect-first-instance" } },
      } as never),
    ).toBe("feature=indirect-first-instance");
    expect(
      gpuSceneUnsupported({
        kind: "webgpu",
        raw: { backend: { hasFeature: () => true } },
      } as never),
    ).toBe("");

    const lines: string[] = [];
    const log = (message: string): void => {
      lines.push(message);
    };
    console.info = log;
    try {
      const scene = new WorldGpuScene();
      // The option, not the backend: the same answer a WebGL renderer gets.
      expect(
        scene.enable(
          {
            kind: "webgpu",
            raw: { backend: { hasFeature: () => true } },
            compute: () => {},
          } as never,
          false,
        ),
      ).toBe(false);
      expect(scene.on).toBe(false);
      expect(scene.report().reason).toBe("option-off");
      expect(lines.join("\n")).toContain("TN_WORLD_GPU_SCENE off reason=option-off");
      // And a WebGL renderer, which is never asked.
      const gl = new WorldGpuScene();
      expect(gl.enable({ kind: "webgl2", raw: {} } as never, true)).toBe(false);
      expect(gl.report().reason).toBe("backend=webgl2");
      // A backend that can run it is on, and the marker says so — through `announce`, which is what
      // the owner calls once it has dressed the keys its ring was already holding, so the line
      // carries a census rather than the count of a ring that has not been built yet.
      const on = new WorldGpuScene();
      const supported = {
        compute: () => {},
        kind: "webgpu",
        raw: { backend: { hasFeature: () => true } },
      } as never;
      expect(on.enable(supported, true)).toBe(true);
      expect(on.on).toBe(true);
      expect(on.report().reason).toBe("on");
      on.announce(supported, { dressed: 21094, meshes: 21094 });
      expect(lines.at(-1)).toContain("TN_WORLD_GPU_SCENE on reason=on");
      expect(lines.at(-1)).toContain("dressed=21094/21094");
    } finally {
      console.info = () => {};
    }
  });

  it("a released placement is skipped and its source record is handed back", () => {
    const scene = new WorldGpuScene();
    scene.enable(
      { kind: "webgpu", raw: { backend: { hasFeature: () => true } }, compute: () => {} } as never,
      true,
    );
    const slot = scene.slot("pine", {
      cull: undefined,
      distances: [0],
      levels: [{ firstKey: 0, parts: 1 }],
    });
    scene.key("pine:0:0", LOCAL, 8);
    const first = scene.place(slot, new Matrix4().makeTranslation(0, 0, 10), 0, 0, 10, 0.5);
    const second = scene.place(slot, new Matrix4().makeTranslation(1, 0, 10), 1, 0, 10, 0.5);
    expect(scene.report().instances).toBe(2);
    scene.release(first);
    expect(scene.report().instances).toBe(1);
    expect(scene.placements[first]?.slot).toBe(-1);
    // The record is reused rather than the buffer growing on a walk's back-traffic.
    expect(scene.place(slot, new Matrix4().makeTranslation(2, 0, 10), 2, 0, 10, 0.5)).toBe(first);
    expect(scene.placements[second]?.slot).toBe(slot);
    scene.dispose();
    // A disposed scene holds nothing, and a dispatch on it is a no-op rather than a throw.
    expect(scene.report().instances).toBe(0);
    expect(scene.place(0, new Matrix4(), 0, 0, 0, 1)).toBe(-1);
  });

  it("culls a placement the frustum leaves, exactly as the camera's planes say", () => {
    const camera = new PerspectiveCamera(30, 1, 0.1, 100);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, 1);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const planes = new Float32Array(24);
    for (const [index, plane] of frustum.planes.entries()) {
      const at = index * 4;
      planes[at] = plane.normal.x;
      planes[at + 1] = plane.normal.y;
      planes[at + 2] = plane.normal.z;
      planes[at + 3] = plane.constant;
    }
    const region: IRegion = { argsIndex: 0, capacity: 8, indexCount: 0, local: LOCAL, start: 0 };
    const result = cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: 2,
      placements: [placement(0, 0, 20, 0, 0.5), placement(0, 0, -20, 0, 0.5)],
      regionCount: 1,
      regions: [region],
      slots: [{ cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] }],
    });
    // Ahead of the camera and behind it: one survivor.
    expect(result.counts[0]).toBe(1);
    // A sphere large enough to touch the frustum from behind is drawn, which is the whole point of
    // testing a sphere rather than a point.
    const padded = cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: 1,
      placements: [placement(0, 0, -20, 0, 40)],
      regionCount: 1,
      regions: [region],
      slots: [{ cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] }],
    });
    expect(padded.counts[0]).toBe(1);
  });

  it("composes the part offset into the drawn matrix, the way the CPU path does", () => {
    const { planes } = cameraAt(0, 0);
    const offset = new Matrix4().makeTranslation(0, 3, 0);
    const local = new Float32Array(offset.elements);
    const result = cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: 1,
      placements: [placement(0, 0, 10, 0)],
      regionCount: 1,
      regions: [{ argsIndex: 0, capacity: 4, indexCount: 0, local, start: 0 }],
      slots: [{ cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] }],
    });
    // The placement at y 0 with a part three metres up draws at y 3.
    expect(result.drawn[13]).toBeCloseTo(3, 5);
    expect(result.drawn[14]).toBeCloseTo(10, 5);
  });
});

/**
 * The CPU reference's hierarchical-depth occlusion test.
 *
 * A pyramid of the previous frame's own depth is the whole of the extra visibility rule, and the
 * four answers it must never give — a near-plane sphere, a sphere off screen last frame, and
 * anything on a camera-cut frame — are the cases a conservative test gets wrong by being clever.
 * A measured run counts what the test hides and draws all of it, which is what makes a measured
 * frame the frame an unmeasured run draws.
 */
describe("the CPU reference's pyramid occlusion test", () => {
  /** A pyramid whose every texel is a wall at `metres`, which is a depth buffer with one surface. */
  function wallPyramid(metres: number): IDepthPyramid {
    return buildDepthPyramid(new Float32Array(64 * 36).fill(metres), 64, 36);
  }

  /** The `projection * viewInverse` of a camera at the origin looking down `z` (or `-z` for behind). */
  function frameViewProjection(behind = false): Float32Array {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 0, 0);
    camera.lookAt(0, 0, behind ? -1 : 1);
    camera.updateMatrixWorld(true);
    return new Float32Array(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements,
    );
  }

  /** One key with one part of 36 indices, so a hidden placement is one instance and 12 triangles. */
  const region: IRegion = { argsIndex: 0, capacity: 8, indexCount: 36, local: LOCAL, start: 0 };

  function run(
    at: readonly [number, number, number],
    radius: number,
    occlusion: IKernelOcclusion | undefined,
  ): IKernelResult {
    const { planes } = cameraAt(0, 0);
    return cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: 1,
      ...(occlusion === undefined ? {} : { occlusion }),
      placements: [placement(at[0], at[1], at[2], 0, radius)],
      regionCount: 1,
      regions: [region],
      slots: [{ cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] }],
    });
  }

  /** A pyramid ten metres in front of a camera looking down +Z, culling or counting as asked. */
  function occlusion(cull: boolean, over: Partial<IOcclusionFrame> = {}): IKernelOcclusion {
    return {
      cull,
      frame: {
        cut: false,
        height: 36,
        viewProjection: frameViewProjection(),
        width: 64,
        ...over,
      },
      pyramid: wallPyramid(10),
    };
  }

  it("rejects a sphere the previous frame's depth put behind a surface", () => {
    // 20 m out with a 1 m sphere, behind a wall the depth says is 10 m away.
    const culled = run([0, 0, 20], 1, occlusion(true));
    expect(culled.counts[0]).toBe(0);
    expect(culled.occluded).toEqual({ instances: 1, triangles: 12 });
  });

  it.each([0, 0.9])("keeps visible tall thin trees above foreground terrain at yaw %s", (yaw) => {
    const width = 128;
    const height = 73;
    const camera = new PerspectiveCamera(60, width / height, 0.1, 1000);
    camera.coordinateSystem = WebGPUCoordinateSystem;
    camera.updateProjectionMatrix();
    camera.rotation.y = yaw;
    camera.updateMatrixWorld(true);
    const boxes = [-12, -6, 0, 6, 12].map((x) => {
      const centre = new Vector3(x, 16, -40).applyMatrix4(camera.matrixWorld);
      return { centre, box: new Box3().setFromCenterAndSize(centre, new Vector3(0.9, 8, 0.9)) };
    });
    const distance = new Float32Array(width * height);
    const visible = new Set<number>();
    const hit = new Vector3();
    const ray = new Ray();
    // Render thin boxes, far terrain and foreground ground into top-left-origin WebGPU depth.
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        ray.origin.copy(camera.position);
        ray.direction
          .set((2 * (x + 0.5)) / width - 1, 1 - (2 * (y + 0.5)) / height, 0.5)
          .unproject(camera)
          .sub(ray.origin)
          .normalize();
        let far = ray.direction.y < 0 ? -2 / ray.direction.y : 500;
        let owner = -1;
        for (const [index, tree] of boxes.entries()) {
          if (ray.intersectBox(tree.box, hit) !== null && hit.distanceTo(ray.origin) < far) {
            far = hit.distanceTo(ray.origin);
            owner = index;
          }
        }
        if (owner >= 0) visible.add(owner);
        hit
          .copy(ray.direction)
          .multiplyScalar(far)
          .add(ray.origin)
          .applyMatrix4(camera.matrixWorldInverse);
        // Perspective depth is nonlinear; the pyramid compares decoded view-axis metres.
        const viewDistance = -hit.z;
        const stored =
          (camera.far * (viewDistance - camera.near)) / ((camera.far - camera.near) * viewDistance);
        distance[y * width + x] =
          (camera.near * camera.far) / (camera.far - stored * (camera.far - camera.near));
      }
    }
    expect(visible.size).toBe(boxes.length);
    const frame = {
      cut: false,
      width,
      height,
      viewProjection: Float32Array.from(
        new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements,
      ),
    };
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().fromArray(frame.viewProjection),
      WebGPUCoordinateSystem,
    );
    const planes = Float32Array.from(
      frustum.planes.flatMap((plane) => [
        plane.normal.x,
        plane.normal.y,
        plane.normal.z,
        plane.constant,
      ]),
    );
    const result = cullAndSelect({
      camera: { planes, x: 0, y: 0, z: 0 },
      count: boxes.length,
      occlusion: { cull: true, frame, pyramid: buildDepthPyramid(distance, width, height) },
      placements: boxes.map(({ centre, box }) =>
        placement(centre.x, centre.y, centre.z, 0, box.getSize(new Vector3()).length() / 2),
      ),
      regionCount: 1,
      regions: [region],
      slots: [{ cull: undefined, distances: [0], levels: [{ firstKey: 0, parts: 1 }] }],
    });
    expect(result.occluded?.instances).toBe(0);
    expect(result.counts[0]).toBe(boxes.length);
  });

  it("covers a visible sphere edge when a quarter-turn zeroes the view-projection diagonal", () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.rotation.y = Math.PI / 2;
    camera.updateMatrixWorld(true);
    const centre = new Vector3(0.5, 0, -20).applyMatrix4(camera.matrixWorld);
    const distance = new Float32Array(64 * 36).fill(10);
    // A narrow opening in a 10 m wall exposes the sphere's left edge at 18 m.
    distance[18 * 64 + 22] = 18;
    expect(
      occludedBy(
        {
          ...occlusion(true),
          frame: {
            ...occlusion(true).frame,
            viewProjection: Float32Array.from(
              new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
                .elements,
            ),
          },
          pyramid: buildDepthPyramid(distance, 64, 36),
        },
        centre.toArray(),
        4,
      ),
    ).toBe(false);
  });

  it("reads the selected mip's footprint rather than base-resolution coordinates", () => {
    const distance = new Float32Array(64 * 36).fill(10);
    distance[18 * 64 + 32] = 50;
    expect(
      run([0, 0, 20], 1, { ...occlusion(true), pyramid: buildDepthPyramid(distance, 64, 36) })
        .counts[0],
    ).toBe(1);
  });

  it("reads top-left texture rows rather than mirroring foreground terrain over visible trees", () => {
    const distance = new Float32Array(64 * 36).fill(10);
    distance.fill(50, 0, 64 * 12);
    const test = { ...occlusion(true), pyramid: buildDepthPyramid(distance, 64, 36) };
    expect(occludedBy(test, [0, 6, 20], 1)).toBe(false);
    expect(occludedBy(test, [0, -6, 20], 1)).toBe(true);
  });

  it("keeps a sphere reaching the camera's positive near plane", () => {
    expect(
      occludedBy(
        { ...occlusion(true, { near: 0.1 }), pyramid: wallPyramid(0.01) },
        [0, 0, 0.105],
        0.01,
      ),
    ).toBe(false);
  });

  it("keeps a sphere that touches the near plane, off screen last frame, or a cut frame", () => {
    // Reaches the near plane: its own screen rect is not a thing last frame's depth can hold.
    expect(run([0, 0, 0.5], 1, occlusion(true)).counts[0]).toBe(1);
    // Off screen last frame: the pyramid's own camera looks the other way.
    expect(
      run([0, 0, 20], 1, occlusion(true, { viewProjection: frameViewProjection(true) })).counts[0],
    ).toBe(1);
    // A camera cut skips the test for the whole frame.
    expect(run([0, 0, 20], 1, occlusion(true, { cut: true })).counts[0]).toBe(1);
  });

  it("counts what it hides and draws all of it when it only measures", () => {
    const measured = run([0, 0, 20], 1, occlusion(false));
    // The picture is develop's: the placement the frustum kept is still drawn.
    expect(measured.counts[0]).toBe(1);
    expect(measured.drawn.length).toBe((region.capacity ?? 0) * 16);
    expect(measured.occluded).toEqual({ instances: 1, triangles: 12 });
  });

  it("reports no occlusion at all when no test ran, rather than an empty one", () => {
    expect(run([0, 0, 20], 1, undefined).occluded).toBeUndefined();
  });
});

/**
 * The GPU scene wired into `WorldCells`, default off and proven with the flag on.
 *
 * The claims are the ones the walk has to earn: a moving follow point spends nothing on the CPU work
 * the dispatch replaced — no main regroup and no cull/LOD replacement — while the retained aggregate
 * scan remains observable. Residency still feeds the complete source buffer both ways, and every main
 * key's mesh is dressed against the scene's own buffers rather than its own. The renderer is a stub
 * that reports the three features, because what is under test is the wiring and the counters, not a
 * hardware draw.
 */
describe("WorldCells with the GPU-driven main pass", () => {
  it("keeps every multi-part placement drawable after partial eviction and readmission", async () => {
    stubManifestFetch(true);
    const follow = { position: { ...cellCentre(0, 1), y: 0 } };
    const keyed = vi.spyOn(WorldGpuScene.prototype, "key");
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => multiPartModel(),
      prefetchSeconds: 0,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    const renderer = gpuRendererStub();
    const camera = playerCamera();
    for (const x of [0, 1, 2]) {
      Object.assign(follow.position, cellCentre(x, 1));
      world.update(renderer, camera);
      await flushed(world);
    }
    const scene = keyed.mock.contexts.at(-1) as WorldGpuScene;
    expect(world.stats().evictions).toBeGreaterThan(0);
    const slot = scene.gates().findIndex((_, index) => scene.slotAsset(index) === "pine");
    const expected = pineIn("1,1", "2,1");
    expect(scene.placements.filter((one) => one.slot === slot)).toHaveLength(expected);
    // Put every resident pine in the far level: any LOD can receive every placement this frame.
    const result = cullAndSelect({
      camera: { planes: new Float32Array(24), x: 0, y: 0, z: -1000 },
      count: scene.placements.length,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    });
    for (const mesh of mainLevel(world, "pine", 1)) {
      const region = scene.regionOf(mesh.name) as IRegion;
      expect(result.counts[region.argsIndex], mesh.name).toBe(expected);
      expect(region.capacity, mesh.name).toBeGreaterThanOrEqual(expected);
      expect(mesh.instanceMatrix).toBe(scene.drawn);
      expect(mesh.geometry.indirect).toBe(scene.args);
    }
    world.dispose();
  });

  it("spends no regroup or replacement LOD work, feeds the source buffer, and dresses every main key", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      // This measures prop dispatch; keep terrain residency without rebuilding dense morph buffers.
      terrain: { tileResolution: 9 },
      url: "/world/world.json",
    });
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    const camera = playerCamera();
    world.update(renderer, camera);
    await flushed(world);
    // Dressed and fed, both of them, before a single walked frame.
    const settled = world.stats();
    expect(settled.gpuScene.on).toBe(true);
    expect(settled.gpuScene.reason).toBe("on");
    expect(settled.gpuScene.keys).toBeGreaterThan(0);
    expect(settled.gpuScene.instances).toBeGreaterThan(0);
    const main = mainMesh(world);
    // The shared compaction buffer is the mesh's `instanceMatrix`, its own indirect record is on the
    // geometry, and three's whole-mesh test is off because the dispatch already did the culling.
    expect(
      (main.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
        .isStorageInstancedBufferAttribute,
    ).toBe(true);
    expect((main.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
    expect(main.frustumCulled).toBe(false);

    for (let index = 0; index < 200; index += 1) {
      // A walk across the ring, so residency changes underneath the camera rather than a camera
      // turning on the spot: this is the case the CPU per-instance work existed for.
      const at = cellCentre(index % 3, 1 + (index % 2));
      follow.position.x = at.x;
      follow.position.z = at.z;
      world.update(renderer, camera);
    }
    const after = world.stats();
    // The whole claim: 200 frames of a moving follow point, and not one main regroup. With the
    // option off the same walk repacks every time the window moves.
    expect(after.mainCull.repacks - settled.mainCull.repacks).toBe(0);
    expect(after.mainCull.windows - settled.mainCull.windows).toBe(0);
    // The aggregate pass still runs as the follow point moves, but complete GPU source admission
    // means it finds no cull/LOD replacement to rebuild. The dispatch owns those two decisions.
    expect(after.refilters - settled.refilters).toBeGreaterThan(0);
    expect(after.refilterEntries - settled.refilterEntries).toBe(0);
    expect(after.levelRefilters - settled.levelRefilters).toBe(0);
    expect(after.gpuScene.dispatches - settled.gpuScene.dispatches).toBe(200);
    expect(after.gpuScene.instances).toBeGreaterThan(0);
    expect(world.stats().failures).toBe(0);
    const gpuRebuilds = after.refilterEntries - settled.refilterEntries;
    world.dispose();

    // The CPU path retains its maxDistance/lods source filtering, so this control still does actual
    // replacement selection on the same walk.
    stubManifestFetch();
    const cpuFollow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const cpu = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow: cpuFollow,
      gpuScene: false,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      terrain: { tileResolution: 9 },
      url: "/world/world.json",
    });
    cpu.update(renderer, camera);
    await flushed(cpu);
    const cpuSettled = cpu.stats();
    for (let index = 0; index < 200; index += 1) {
      const at = cellCentre(index % 3, 1 + (index % 2));
      cpuFollow.position.x = at.x;
      cpuFollow.position.z = at.z;
      cpu.update(renderer, camera);
    }
    const cpuAfter = cpu.stats();
    const cpuRebuilds = cpuAfter.refilterEntries - cpuSettled.refilterEntries;
    expect(cpuAfter.levelRefilters - cpuSettled.levelRefilters).toBeGreaterThan(0);
    expect(gpuRebuilds).toBeLessThan(cpuRebuilds);
    cpu.dispose();
  });

  it("holds the prewarm gate until the scene's re-seed of a CPU-built ring has landed", async () => {
    // Machinefall loads its ring with no renderer, so the ring is built on the CPU path; the first
    // rendered update brings the scene up, re-queues a rebuild of every resident run and dresses
    // every key, and a dressed key draws nothing until its run's rebuild lands. The gate settled
    // over 1,378 owed builds and a third of the forest arrived in the first 4 s of play (PRD-478).
    stubManifestFetch();
    let clock = 0;
    const world = await WorldCells.load({
      // One build unit per update, so the re-seed spans many updates.
      admissionBudgetMs: 1,
      admissionNow: () => {
        clock += 10_000;
        return clock;
      },
      budgets,
      follow: { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } },
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      // The synthetic clock refuses terrain-block merges; this fixture measures prop admission.
      terrain: false,
      url: "/world/world.json",
    });
    await flushed(world);
    expect(world.stats().admission.backlog, "the CPU ring did not finish building").toBe(0);
    let settled = false;
    void world.prewarmed.then(() => {
      settled = true;
    });
    new Group().add(world);
    const renderer = gpuRendererStub([]);
    const camera = playerCamera();
    let owedAtSettle: number | undefined;
    let sawOwed = false;
    for (let frame = 0; frame < 400 && !settled; frame += 1) {
      world.update(renderer, camera);
      await flush(2);
      const owed = world.stats().admission.backlog;
      if (owed > 0) sawOwed = true;
      if (settled) owedAtSettle = owed;
    }
    expect(sawOwed, "the scene coming up re-seeded nothing").toBe(true);
    expect(settled, "the gate never settled").toBe(true);
    expect(owedAtSettle, "the gate settled with re-seed builds still owed").toBe(0);
    world.dispose();
  });

  it("dresses a ring the prewarm built before the scene came up", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      gpuSceneValidate: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    // A real game loads, mints the whole ring on its loading screen, and hands the world its first
    // renderer a frame later. The prewarm therefore mints every main key while the scene is still
    // off, and the tests that enable it on the first frame never reached that: a `dressGpu` at mint
    // time is the whole of what dresses a key, so a ring built before the scene is on came up with
    // nothing named and every batch still on the CPU path.
    await flushed(world);
    const minted = mainKeys(world);
    expect(minted.length).toBeGreaterThan(0);
    for (const mesh of minted) {
      expect((mesh.geometry as BufferGeometry & { indirect: unknown }).indirect).toBeNull();
      expect(
        (mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
          .isStorageInstancedBufferAttribute,
      ).toBeUndefined();
    }
    expect(world.stats().gpuScene.keys).toBe(0);
    // What each mesh was compiled with before the scene came up, and where it sat: three keeps an
    // instanced mesh's instancing node from its first build, so a dressed mesh cannot be the object
    // the prewarm compiled — it has to be a fresh one carrying what that object carried.
    const before = new Map(
      minted.map((mesh) => {
        const was = {
          at: world.children.indexOf(mesh),
          freed: 0,
          material: mesh.material,
          mesh,
          position: mesh.geometry.getAttribute("position"),
        };
        mesh.addEventListener("dispose", () => {
          was.freed += 1;
        });
        return [mesh.name, was] as const;
      }),
    );

    const lines: string[] = [];
    const renderer = gpuRendererStub(lines);
    const camera = playerCamera();
    world.update(renderer, camera);
    await flushed(world);

    // Every main mesh draws from the scene's own buffers, and every one of them has a region: the
    // gate table addresses `firstKey + part`, so a key the scene never named is a placement the
    // dispatch draws nowhere.
    const main = mainKeys(world);
    expect(main.length).toBeGreaterThanOrEqual(minted.length);
    for (const mesh of main) {
      expect(
        (mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
          .isStorageInstancedBufferAttribute,
      ).toBe(true);
      expect((mesh.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
      expect(mesh.frustumCulled).toBe(false);
      // The record the GPU draws from names the dressed shape's triangles. It said 0 in the real
      // run: every key submitted, counted and drew nothing.
      const geometry = mesh.geometry as BufferGeometry & {
        indirect: { array: Uint32Array };
        indirectOffset: number;
      };
      const record = geometry.indirectOffset / 4;
      expect(geometry.indirect.array[record]).toBe(geometry.index?.count);
      expect(geometry.indirect.array[record]).toBeGreaterThan(0);
      const was = before.get(mesh.name);
      if (was !== undefined) {
        // A fresh object, in the slot and the parent's own list the old one held, with a material of
        // its own and over the same vertex buffers (never a copy).
        expect(mesh).not.toBe(was.mesh);
        // Under the world's one bundle group when bundles are on (the default), and the world itself
        // when they are off. Booleans, not `toBe(object)`: a failed comparison of two scene graphs
        // makes vitest pretty-print a cycle, which reads as a hang.
        expect(mesh.parent?.name === "world-main-bundles" || mesh.parent === world).toBe(true);
        expect(mesh.parent?.children.includes(mesh)).toBe(true);
        expect(mesh.material).not.toBe(was.material);
        expect(mesh.geometry.getAttribute("position")).toBe(was.position);
      }
    }
    // The object the prewarm compiled is out of the world and let go: the node three built for it
    // binds the per-mesh buffer nothing writes any more, and it is that node a dressed forest was
    // measured drawing nothing through.
    for (const was of before.values()) {
      expect(world.children).not.toContain(was.mesh);
      expect(was.mesh.parent).toBeNull();
      expect(was.freed).toBe(1);
    }
    // The material a dressed mesh was given leaves with it.
    const probe = main.find((mesh) => before.has(mesh.name));
    expect(probe).toBeDefined();
    if (probe !== undefined) {
      let disposed = 0;
      (probe.material as { addEventListener: (t: string, f: () => void) => void }).addEventListener(
        "dispose",
        () => {
          disposed += 1;
        },
      );
      probe.dispose();
      expect(disposed).toBe(1);
    }
    expect(world.stats().gpuScene.keys).toBe(main.length);
    // And the marker names it, because a browser run reads the line and nothing else.
    const on = lines.find((one) => one.includes("TN_WORLD_GPU_SCENE on"));
    expect(on).toContain(`dressed=${String(main.length)}/${String(main.length)}`);

    // Thirty dispatches, so a readback lands: a scene with regions compares them.
    for (let index = 0; index < 40; index += 1) world.update(renderer, camera);
    await flush();
    const validation = lines.find((one) => one.includes("TN_WORLD_GPU_SCENE_VALIDATE"));
    expect(validation).toBeDefined();
    expect(Number(validation?.match(/compared=(\d+)/u)?.[1])).toBeGreaterThan(0);
    // And the third family, which the world answers for itself: every dressed main mesh's own
    // record against the instances its own CPU path composes for that key. The stub readback above is
    // the zeros a dispatch never wrote, so nothing is holding a foreign instance here — what this
    // proves is that the world's own records reach the check at all, over a real ring.
    expect(validation).toContain("meshMismatched=0");

    // A key the walk retires into the pool and comes back to: the rebind replaces the instance
    // buffer, so the key is not the one the scene dressed and the batch is re-dressed onto a fresh
    // object — the retained batch keeps its records and its fresh allowance, and the object three
    // compiled against the parked buffer is not the object that draws.
    const held = mainMesh(world);
    const away = cellCentre(6, 1);
    follow.position.x = away.x;
    follow.position.z = away.z;
    world.update(renderer, camera);
    await flushed(world);
    expect(world.stats().evictions).toBeGreaterThan(0);
    const home = cellCentre(0, 1);
    follow.position.x = home.x;
    follow.position.z = home.z;
    world.update(renderer, camera);
    await flushed(world);
    const back = mainMesh(world);
    expect(back).not.toBe(held);
    expect(back.name).toBe(held.name);
    expect(back.instanceMatrix).not.toBe(held.instanceMatrix);
    expect(
      (back.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
        .isStorageInstancedBufferAttribute,
    ).toBe(true);
    expect((back.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("keeps a key's region at its logical capacity across repeated move-out and return", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 2,
      surface,
      url: "/world/world.json",
    });
    const renderer = gpuRendererStub();
    const camera = playerCamera();
    const home = cellCentre(0, 1);
    // A cell the committed package has none of, so the walk out retires every key the return rebinds.
    // The ring is wide enough that a few returns admit more blocks for one key than the world first
    // sized it for, which is the streaming churn a freed range has to serve.
    const away = cellCentre(6, 1);
    const oscillate = async (): Promise<void> => {
      follow.position.x = away.x;
      follow.position.z = away.z;
      world.update(renderer, camera);
      await flushed(world);
      follow.position.x = home.x;
      follow.position.z = home.z;
      world.update(renderer, camera);
      await flushed(world);
    };
    for (let index = 0; index < 12; index += 1) world.update(renderer, camera);
    await flushed(world);
    // The park/rebind cycle is exercised once before the measurement, so the key table and its
    // regions have reached the size a returned walk settles at; what is asserted is that returning
    // again never moves it.
    await oscillate();
    expect(world.stats().evictions).toBeGreaterThan(0);
    // The scene's one shared compaction buffer, which every dressed main mesh binds. It is not this
    // key's, and a retired batch parked by its `count` resized the whole world against it.
    const drawn = mainMesh(world).instanceMatrix;
    const records = drawn.count;
    for (let round = 0; round < 4; round += 1) {
      await oscillate();
      // The rebind is the object that draws, over the scene's same shared buffer: a parked/rebound
      // batch must not resize or replace the world's compaction buffer, whose records are every
      // other key's too.
      const back = mainMesh(world);
      expect(back.instanceMatrix).toBe(drawn);
      expect(drawn.count).toBe(records);
      expect(
        (back.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
          .isStorageInstancedBufferAttribute,
      ).toBe(true);
      expect(back.frustumCulled).toBe(false);
      expect((back.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
      // And it is still a live submission: a fresh node bound to the buffer, admitted by three's own
      // draw gate at the region capacity rather than skipped at a zero count.
      expect(back.count).toBeGreaterThan(0);
      expect(threeAdmitsDraw(back)).toBe(true);
    }
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("hands a dressed main batch a fresh object, carrying everything the compiled one had", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      shadows: { receive: true },
      surface,
      url: "/world/world.json",
    });
    await flushed(world);
    // The prewarm mints the whole ring while the scene is off, and three compiles each of these
    // meshes the first time it draws it — against its own per-mesh `instanceMatrix`, which the GPU
    // scene's dispatch never writes. That node is kept for the object's whole life, so the object
    // itself is what a dress has to replace: measured on machinefall, 3,724 indirect draws submitted
    // in 2 s over correct records over a forest that drew nothing, until each dressed mesh was fresh.
    const compiled = mainKeys(world);
    expect(compiled.length).toBeGreaterThan(0);
    const was = new Map(
      compiled.map((mesh) => [
        mesh.name,
        {
          castShadow: mesh.castShadow,
          freed: 0,
          layers: mesh.layers.mask,
          matrix: mesh.matrix.clone(),
          matrixAutoUpdate: mesh.matrixAutoUpdate,
          matrixWorld: mesh.matrixWorld.clone(),
          mesh,
          receiveShadow: mesh.receiveShadow,
          renderOrder: mesh.renderOrder,
          userData: mesh.userData,
        },
      ]),
    );
    for (const one of was.values())
      one.mesh.addEventListener("dispose", () => {
        one.freed += 1;
      });

    const renderer = gpuRendererStub();
    const camera = playerCamera();
    world.update(renderer, camera);
    await flushed(world);
    for (let index = 0; index < 8; index += 1) world.update(renderer, camera);

    // Every dressed main batch draws with an object the prewarm never saw, and everything the
    // compiled one carried came with it: the name the world's own checks and markers address it by,
    // the layer and the two shadow flags its pass is chosen by, the frozen transform, and the slot
    // it held in the world's own children.
    const dressed = mainKeys(world);
    expect(dressed.length).toBe(was.size);
    for (const mesh of dressed) {
      const one = was.get(mesh.name);
      expect(one).toBeDefined();
      if (one === undefined) continue;
      expect(mesh).not.toBe(one.mesh);
      expect(mesh.name).toBe(one.mesh.name);
      expect(mesh.layers.mask).toBe(one.layers);
      expect(mesh.castShadow).toBe(one.castShadow);
      expect(mesh.receiveShadow).toBe(one.receiveShadow);
      expect(mesh.renderOrder).toBe(one.renderOrder);
      expect(mesh.userData).toBe(one.userData);
      expect(mesh.matrix.equals(one.matrix)).toBe(true);
      expect(mesh.matrixAutoUpdate).toBe(one.matrixAutoUpdate);
      expect(mesh.matrixWorld.equals(one.matrixWorld)).toBe(true);
      // The freeze is keyed by the object, so a replacement that did not re-arm it would compose its
      // own world matrix every walk forever.
      expect(isStatic(mesh)).toBe(true);
      expect(mesh.matrixAutoUpdate).toBe(false);
      // Under the one bundle group (the default) or the world; booleans, so a failure cannot make
      // vitest pretty-print a scene graph's cycle.
      expect(mesh.parent?.name === "world-main-bundles" || mesh.parent === world).toBe(true);
      expect(mesh.parent?.children.includes(mesh)).toBe(true);
      // And the object it replaced is out of the world, and let go: nothing else holds a node for it.
      expect(world.children).not.toContain(one.mesh);
      expect(one.mesh.parent).toBeNull();
      expect(one.freed).toBe(1);
    }
    // The world's own bookkeeping answers to the new object: the cull narrows what it publishes on
    // it, and the census counts it.
    const stats = world.stats();
    expect(stats.gpuScene.keys).toBe(dressed.length);
    expect(stats.failures).toBe(0);
    expect(mainMesh(world).count).toBeGreaterThan(0);
    world.dispose();
  });

  it("dresses every main batch onto the scene's live buffer and re-dresses none on a settled walk", async () => {
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    // The fixture's authored lods rather than the stubbed single level: a level's key is minted when
    // that level is first dressed. Minting every level mints every group before the first dress, so
    // the drawn buffer reaches its final size once and a settled frame re-dresses nothing. The walk
    // that used to re-lay each level out on every dress grew that buffer without bound.
    stubManifestFetch(true);
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    await flushed(world);
    expect(mainKeys(world).length).toBeGreaterThan(1);
    // Every generation of every key's mesh is watched, because a replacement is a dispose of the
    // generation before it: a key whose count reaches two was dressed, regrown under, and dressed
    // again.
    const watched = new WeakSet<InstancedMesh>();
    const freed = new Map<string, number>();
    const watch = (): void => {
      for (const mesh of mainKeys(world)) {
        if (watched.has(mesh)) continue;
        watched.add(mesh);
        if (freed.has(mesh.name) === false) freed.set(mesh.name, 0);
        mesh.addEventListener("dispose", () => {
          freed.set(mesh.name, (freed.get(mesh.name) ?? 0) + 1);
        });
      }
    };
    watch();

    const renderer = gpuRendererStub();
    const camera = playerCamera();
    for (let index = 0; index < 12; index += 1) {
      world.update(renderer, camera);
      watch();
    }
    await flushed(world);

    // Every key's CPU mesh was replaced once when the scene came up, onto the shared buffer; no key
    // was replaced a second time, because a settled registration keeps its run and the buffer it
    // points at. A regrow that does replace `drawn` is the same road as the first dress — a node
    // bound to an attribute nothing writes any more — and `#dressGpu`'s fast path takes it.
    const counts = [...freed.values()];
    expect(counts.length).toBeGreaterThan(1);
    expect(counts.every((count) => count > 0)).toBe(true);
    expect(counts.every((count) => count === 1)).toBe(true);
    // And the replacements are the objects that draw, over the live buffer.
    for (const mesh of mainKeys(world)) {
      expect(
        (mesh.instanceMatrix as unknown as { isStorageInstancedBufferAttribute?: boolean })
          .isStorageInstancedBufferAttribute,
      ).toBe(true);
      expect((mesh.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
      expect(watched.has(mesh)).toBe(true);
    }
    expect(world.stats().gpuScene.keys).toBe(mainKeys(world).length);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("names the live level selection in the mesh check, over a ring the camera can see", async () => {
    /**
     * The reference the mesh check compares against, over a real ring, in one number.
     *
     * The stub readback below is the zeros a dispatch that never ran leaves behind, so the counts
     * are wrong by construction and this proves nothing about the kernel. What it does prove is the
     * wiring of the third check: the expected set is built from the owner's live gates, so a `mesh=`
     * line names `live=N` with N the placements the camera and `asset.distances` select — a reference
     * built from the CPU path's stale per-cell records would name a different N, and an empty one
     * would name nothing at all. The camera faces east into the ring: `playerCamera` looks west, out
     * of the world, where nothing is in the frustum and every expected set is legitimately empty.
     */
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      gpuSceneValidate: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    await flushed(world);
    const lines: string[] = [];
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (message: string): void => {
        lines.push(message);
      },
      readback: async (attribute: { array: Uint32Array | Float32Array }): Promise<ArrayBuffer> =>
        attribute.array.slice().buffer as ArrayBuffer,
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    const centre = cellCentre(0, 1);
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(centre.x, 4, centre.z);
    camera.lookAt(centre.x + CELL * 4, 4, centre.z);
    camera.updateMatrixWorld();
    for (let index = 0; index < 40; index += 1) world.update(renderer, camera);
    await flush();
    const meshes = lines.filter((line) => line.includes(" count gpu="));
    expect(meshes.length).toBeGreaterThan(0);
    for (const line of meshes) {
      const live = Number(line.match(/live=(\d+)/u)?.[1]);
      expect(live).toBeGreaterThan(0);
      expect(line).toMatch(/ count gpu=0 /u);
    }
    // More than one key is named, so this is the whole dressed set and not one key's own accident.
    expect(new Set(meshes.map((line) => line.match(/mesh=(\S+)/u)?.[1])).size).toBeGreaterThan(1);
    world.dispose();
  });

  it("hands the source records back when the ring empties, and says it is off by default", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    world.update(renderer, playerCamera());
    await flushed(world);
    const resident = world.stats().gpuScene.instances;
    expect(resident).toBeGreaterThan(0);

    // Six cells east, which evicts every resident cell. The records the dispatches were drawing are
    // handed back, or the source buffer would grow for the rest of the walk.
    const away = cellCentre(6, 1);
    follow.position.x = away.x;
    follow.position.z = away.z;
    world.update(renderer, playerCamera());
    await flushed(world);
    expect(world.stats().evictions).toBeGreaterThan(0);
    expect(world.stats().gpuScene.instances).toBe(0);
    world.dispose();
  });

  it.each([false, true])(
    "publishes the CPU shadow fallback policy for authored LODs=%s",
    async (authoredLods) => {
      stubManifestFetch(authoredLods);
      const adopted = vi.spyOn(WorldGpuScene.prototype, "slot");
      const world = await WorldCells.load({
        admissionBudgetMs: Number.POSITIVE_INFINITY,
        budgets,
        follow: { position: { ...cellCentre(0, 1), y: 0 } },
        gpuScene: true,
        loadModel: async () => plainModel(),
        prefetchSeconds: 0,
        ring: 1,
        shadows: { cast: true, castLevels: 1 },
        surface,
        url: "/world/world.json",
      });
      world.update(gpuRendererStub(), playerCamera());
      await flushed(world);
      const pine = adopted.mock.calls.filter(([name]) => name === "pine");
      expect(pine.length).toBeGreaterThan(0);
      for (const [, slot] of pine) expect(slot.shadowFallback).toBe(!authoredLods);
      world.dispose();
    },
  );

  it("is the CPU path byte for byte with the option off", async () => {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: false,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    const renderer = {
      compute: (): void => {},
      kind: "webgl2",
      raw: {},
    } as unknown as IRendererLike;
    world.update(renderer, playerCamera());
    await flushed(world);
    // Off, and it says so: the option was asked to be off, so a WebGL renderer is never even the
    // interesting answer — the marker names the option.
    expect(world.stats().gpuScene.on).toBe(false);
    expect(world.stats().gpuScene.reason).toBe("option-off");
    expect(world.stats().gpuScene.dispatches).toBe(0);
    // And the batch draws from its own buffer, which is the whole of "byte for byte today".
    const main = mainMesh(world);
    expect(main.frustumCulled).toBe(true);
    expect((main.geometry as BufferGeometry & { indirect: unknown }).indirect).toBeNull();
    expect(mainMesh(world).count).toBe(pineIn("0,0", "0,1", "0,2", "1,0", "1,1", "1,2"));
    world.dispose();
  });

  it("hands the dispatch a turned off-centre prop's sphere centred where its quaternion carries the bounds", async () => {
    // The source record's centre is the authored bounds centre under the placement's own transform:
    // a prop whose bounds reach ten metres along +Z, turned a quarter turn about +Y, has its centre
    // ten metres along +X. The wiring translated the centre and never turned it, so the sphere sat
    // where the unturned prop would be and the dispatch culled a prop on screen.
    const { centre, radius } = stubTurnedPropFetch();
    const placed = vi.spyOn(WorldGpuScene.prototype, "place");
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow: { position: { ...cellCentre(0, 0), y: 0 } as { x: number; z: number } },
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    world.update(gpuRendererStub(), playerCamera([0, 0]));
    await flushed(world);
    // The production build is what placed it, through the same `place` the world always calls.
    expect(placed).toHaveBeenCalled();
    for (const [, , x, y, z, at] of placed.mock.calls) {
      expect(x).toBeCloseTo(centre.x, 4);
      expect(y).toBeCloseTo(centre.y, 4);
      expect(z).toBeCloseTo(centre.z, 4);
      expect(at).toBeCloseTo(radius, 4);
    }
    world.dispose();
  });

  it("scales the turned prop's sphere radius by the placement's own scale, once", async () => {
    // The same turned prop, placed 3x: its authored bounds radius is half the 20 m diagonal (10),
    // and the placement's uniform scale carries it to 30. The wiring halved it twice, so this read
    // 7.5 — a sphere well inside the prop that culled most of it.
    const { centre, radius } = stubTurnedPropFetch(3);
    const placed = vi.spyOn(WorldGpuScene.prototype, "place");
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow: { position: { ...cellCentre(0, 0), y: 0 } as { x: number; z: number } },
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    world.update(gpuRendererStub(), playerCamera([0, 0]));
    await flushed(world);
    expect(placed).toHaveBeenCalled();
    for (const [, , x, y, z, at] of placed.mock.calls) {
      expect(x).toBeCloseTo(centre.x, 4);
      expect(y).toBeCloseTo(centre.y, 4);
      expect(z).toBeCloseTo(centre.z, 4);
      expect(at).toBeCloseTo(radius, 4);
    }
    world.dispose();
  });

  for (const bundles of [false, true])
    it(`keeps the near LOD mesh of a walked-into key renderable while the CPU's level membership is stale (bundles ${bundles ? "on" : "off"})`, async () => {
      /**
       * The per-key coarse gate against a level only the dispatch ever selects.
       *
       * Authored `lods` put pine's second shape at 60 m, so a placement's level is decided twice:
       * once on the CPU, from the follow point at build time, and every frame on the GPU, from the
       * camera. `#refilterStale` is disabled while the scene is on, so the CPU's answer never moves:
       * a follow point parked outside the package builds every placement into the coarse level and
       * the near key's `#squareSizes` stays empty forever. The camera then walks in — a plain camera
       * move, no residency change and no rebuild — and the dispatch selects the near level. The near
       * mesh has no CPU cell of its own, so the old gate hid exactly the mesh the dispatch was
       * drawing. Run with bundles both ways, which are the default and its override: a bundled mesh
       * is shown by its recorded bundle and never asked, so the two paths must both keep it
       * renderable.
       */
      stubManifestFetch(true);
      // Far past the 60 m switch from every resident cell, and never moved, so every build is coarse.
      const follow = { position: { x: 200, z: -32, y: 0 } as { x: number; z: number } };
      const world = await WorldCells.load({
        admissionBudgetMs: Number.POSITIVE_INFINITY,
        budgets,
        bundles,
        follow,
        gpuScene: true,
        loadModel: async () => multiPartModel(),
        prefetchSeconds: 0,
        ring: 2,
        surface,
        url: "/world/world.json",
      });
      await flushed(world);
      // The near level of a multi-part tree: minted empty, because no placement reached it.
      expect(mainLevel(world, "pine", 0).length).toBeGreaterThan(1);
      expect(mainLevel(world, "pine", 1).length).toBe(mainLevel(world, "pine", 0).length);
      for (const mesh of mainLevel(world, "pine", 0)) expect(mesh.count).toBe(0);

      const renderer = gpuRendererStub();
      const camera = playerCamera([3, 1]);
      // One frame dresses every key, then the loading screen's prewarm submissions count — the moment
      // the coarse gate takes over from the owed-draw exception. A unit world is never projected, so
      // nothing else ever counts them.
      world.update(renderer, camera);
      for (const mesh of mainKeys(world)) (mesh.onBeforeRender as () => void)();
      const before = world.stats();
      world.update(renderer, camera);
      await flushed(world);
      // The camera is on the coarse-built trees now: the dispatch selects the near level for them.
      // Every part of the near key has to stay renderable, empty on the CPU or not.
      const near = mainLevel(world, "pine", 0);
      const coarse = mainLevel(world, "pine", 1);
      for (const mesh of near) {
        expect(mesh.visible).toBe(true);
        // A zero count is not renderable: three's own gate answers null there and the backend never
        // submits the indirect record the dispatch wrote. The region's capacity is the bound the mesh
        // is submitted at, and the record's count is what actually draws.
        expect(mesh.count).toBeGreaterThan(0);
        expect(threeAdmitsDraw(mesh)).toBe(true);
        // A fresh, attached generation and not a detached one: a dressed replacement is parented on
        // the bundle group when bundles are on and on the world when they are off, and the object the
        // parent holds is this one.
        expect(mesh.parent?.name === "world-main-bundles" || mesh.parent === world).toBe(true);
        expect(mesh.parent?.children.includes(mesh)).toBe(true);
        expect((mesh.geometry as BufferGeometry & { indirect: unknown }).indirect).not.toBeNull();
      }
      for (const mesh of coarse) {
        expect(mesh.visible).toBe(true);
        expect(threeAdmitsDraw(mesh)).toBe(true);
      }
      // Distinct live objects, one per `asset:level:part`: near and coarse never share a mesh. That a
      // placement is also drawn by exactly one of them is the dispatch's own level test, proved by
      // identity in the spec's "sends each placement to exactly one level" case.
      const mainNames = mainKeys(world).map((mesh) => mesh.name);
      expect(new Set(mainNames).size).toBe(mainNames.length);
      expect(near.every((mesh) => coarse.includes(mesh) === false)).toBe(true);
      // No CPU repack and no refilter: the level membership is stale by construction, which is the
      // whole reason the gate was wrong.
      const after = world.stats();
      expect(after.mainCull.repacks - before.mainCull.repacks).toBe(0);
      expect(after.refilters - before.refilters).toBe(0);

      // Walk back out: same keys, same stale membership, still nothing repacked.
      camera.position.set(follow.position.x, 4, follow.position.z);
      camera.lookAt(follow.position.x, 4, follow.position.z + 1);
      camera.updateMatrixWorld();
      world.update(renderer, camera);
      await flushed(world);
      const home = world.stats();
      expect(home.mainCull.repacks - after.mainCull.repacks).toBe(0);
      expect(home.refilters - after.refilters).toBe(0);
      expect(home.failures).toBe(0);
      world.dispose();
    });

  for (const bundles of [false, true])
    it(`rebinds a dressed mesh whose args buffer was replaced under it (bundles ${bundles ? "on" : "off"})`, async () => {
      /**
       * The seam a machinefall walk hit: the args buffer and the drawn matrix buffer are allocated
       * and grown independently, and minting a key replaces `args` while `drawn` keeps its object.
       * `#dressGpu`'s fast path checked only `drawn`, the capacity and the parent, so a mesh whose
       * geometry held the old args attribute was left reading a buffer the dispatch no longer wrote —
       * the forest drew nothing while the readback reported the counts correct.
       *
       * The growth is forced through the scene's own public `key`, the registration seam the world
       * itself uses: capacity-zero keys left of the world grow the key count and so `args`, and touch
       * `drawn` not at all. The scene is reached through a spy on `WorldGpuScene.prototype.key`, so
       * nothing is exported or unwrapped for the test. One completed update, no settling frame.
       */
      stubManifestFetch();
      const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
      const world = await WorldCells.load({
        admissionBudgetMs: Number.POSITIVE_INFINITY,
        budgets,
        bundles,
        follow,
        gpuScene: true,
        loadModel: async () => multiPartModel(),
        prefetchSeconds: 0,
        ring: 1,
        surface,
        url: "/world/world.json",
      });
      const keyed = vi.spyOn(WorldGpuScene.prototype, "key");
      const renderer = gpuRendererStub();
      const camera = playerCamera();
      world.update(renderer, camera);
      await flushed(world);
      const scene = keyed.mock.contexts.at(-1) as WorldGpuScene;
      expect(scene).toBeInstanceOf(WorldGpuScene);
      const meshes = mainKeys(world);
      expect(meshes.length).toBeGreaterThan(0);
      const argsBefore = scene.args;
      const drawnBefore = scene.drawn;
      for (let index = 0; index < 600 && scene.args === argsBefore; index += 1)
        scene.key(`pad:${String(index)}:0`, LOCAL, 0);
      // The two buffers moved apart: args is a new object, drawn is not.
      expect(scene.args).not.toBe(argsBefore);
      expect(scene.drawn).toBe(drawnBefore);
      // One completed update: every attached main mesh must read the args the dispatch will write.
      world.update(renderer, camera);
      const after = mainKeys(world);
      expect(after.length).toBeGreaterThan(0);
      for (const mesh of after) {
        const region = scene.regionOf(mesh.name);
        expect(region).toBeDefined();
        expect(mesh.instanceMatrix).toBe(scene.drawn);
        expect(mesh.geometry.indirect).toBe(scene.args);
        expect(mesh.geometry.indirectOffset).toBe((region?.argsIndex ?? -1) * DRAW_ARGS_BYTES);
      }
      expect(world.stats().failures).toBe(0);
      world.dispose();
    });
});

describe("WorldCells GPU-driven main pass, against the CPU path's own drawn set", () => {
  it("draws every part of a multi-part asset into the level's own contiguous run", () => {
    // A tree is three parts at two levels — a trunk and two canopies, each with a coarser shape of
    // its own. The gate table addresses a level's parts as `firstKey + part`, so the run has to be
    // the level's own and start at its *first* part: a table that recorded the key it saw last named
    // the last part as the first, and the whole asset then drew into its neighbour's regions.
    const scene = wired([{ name: "oak", levels: [0, 40] }], 3, 64);
    const origin = { x: 0, z: 0, planes: cameraAt(0, 0).planes };
    placed(scene, 0, 12, 8);
    const input: IKernelInput = {
      camera: { planes: origin.planes, x: 0, y: 0, z: 0 },
      count: scene.placements.length,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    };
    const fromKernel = kernelDrawn(cullAndSelect(input), input);
    // The run each level's parts occupy, from the first part and as wide as the asset's parts.
    expect(scene.levelKeys("oak:0")).toEqual({ firstKey: keyOf(scene, "oak:0:0"), parts: 3 });
    expect(scene.levelKeys("oak:1")).toEqual({ firstKey: keyOf(scene, "oak:1:0"), parts: 3 });
    // `cpuReference` is a single-part model — one key per level — so it is asked for the level's
    // first key, and every part of that level must carry the same placements as it.
    for (const level of [0, 1]) {
      // In the reference's own key space, where a level is `firstKey + level * parts`; from zero with
      // one part, level `n` is key `n`. The scene's region for it is the level's own run.
      const wanted = cpuReference(scene.placements, origin, 0, [0, 40], undefined, 0, 1).get(
        level,
      ) as number[];
      expect(wanted.length).toBeGreaterThan(0);
      for (let part = 0; part < 3; part += 1) {
        const key = keyOf(scene, `oak:${String(level)}:${String(part)}`);
        expect([...(fromKernel.get(key) as number[])].sort((a, b) => a - b)).toEqual(
          [...wanted].sort((a, b) => a - b),
        );
      }
    }
    // 12 m to 36 m at level 0, 44 m to 100 m at level 1: three parts each, nothing drawn nowhere.
    expect(fromKernel.get(keyOf(scene, "oak:0:2"))).toHaveLength(4);
    expect(fromKernel.get(keyOf(scene, "oak:1:2"))).toHaveLength(8);
    scene.dispose();
  });

  it("keeps every key's record holding its own instances, over keys minted in prewarm order", async () => {
    /**
     * A package the way a real one is made, with the key order a real one mints them in.
     *
     * A tree is two parts at one level, a fern is one part across a three-level chain, and a post has
     * authored lods and a cull distance. The keys are then registered the way a ring that was built
     * before the scene came up registers them: in the order the prewarm queued them, which is every
     * level and part of one asset before the next — so a level's parts are NOT a contiguous run of
     * key indices, because another asset's keys are minted between them. The gate table addresses a
     * level's parts as `firstKey + part`, so that is the whole question: whose instances land in
     * whose record.
     *
     * The instances on the CPU side are the CPU path's own answer, written out from `world-cells`:
     * the same ascending `distance > gate` level test over the same gates `assetLevels` builds, the
     * same cull distance, and the part's own offset multiplied in exactly as `#addPlacements` does —
     * with no key table, no `firstKey` and no part arithmetic anywhere in it.
     */
    // The needles sit three metres up the trunk, so a record holding another part's instances is
    // caught by their translation and not only by which placements they name.
    const LOCAL_NEEDLES = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
    const ASSETS = [
      { cull: undefined, distances: [0], name: "pine", parts: [LOCAL, LOCAL_NEEDLES] },
      { cull: undefined, distances: [0, 40, 120], name: "fern", parts: [LOCAL] },
      { cull: 70, distances: [0, 60], name: "post", parts: [LOCAL] },
    ] as const;
    /** The prewarm's order: asset by asset, level by level, part by part. */
    const PREWARM = [
      "pine:0:0",
      "fern:0:0",
      "post:0:0",
      "fern:1:0",
      "pine:0:1",
      "fern:2:0",
      "post:1:0",
    ];
    const lines: string[] = [];
    const { camera, planes } = cameraAt(0, 0);
    /** The bytes the last readback answered with, which is what the check reads. */
    const readback: { args: Uint32Array; drawn: Float32Array } = {
      args: new Uint32Array(0),
      drawn: new Float32Array(0),
    };
    const scene = new WorldGpuScene();
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: (attribute: unknown): Promise<ArrayBuffer> => {
        const result = cullAndSelect({
          camera: { planes, x: 0, y: 0, z: 0 },
          count: scene.placements.length,
          placements: scene.placements,
          regionCount: scene.regions.length,
          regions: scene.regions,
          slots: scene.gates(),
        });
        const args = Uint32Array.from(result.args);
        const drawn = Float32Array.from(result.drawn);
        for (const region of scene.regions) {
          args[region.argsIndex * 5] = region.indexCount;
          args[region.argsIndex * 5 + 4] = region.start;
        }
        const words = (attribute as { array: Uint32Array | Float32Array }).array;
        readback.args = args;
        readback.drawn = drawn;
        return Promise.resolve((words instanceof Float32Array ? drawn : args).buffer);
      },
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    for (const name of PREWARM) {
      const asset = ASSETS.find((one) =>
        name.startsWith(`${one.name}:`),
      ) as (typeof ASSETS)[number];
      const [, level, part] = name.split(":");
      scene.key(name, asset.parts[Number(part)] as Float32Array, 64, {
        group: `${asset.name}:${level ?? "0"}`,
        part: Number(part),
        parts: asset.parts.length,
      });
      scene.indexCount(name, 96);
    }
    for (const [slot, asset] of ASSETS.entries()) {
      const gates = asset.distances.map((_distance, level) => {
        const group = `${asset.name}:${String(level)}`;
        return scene.levelKeys(group) ?? { firstKey: 0, parts: 0 };
      });
      scene.slot(asset.name, { cull: asset.cull, distances: asset.distances, levels: gates });
      // Six placements per asset, spread so both the chain's levels and the post's cull are reached.
      for (let taken = 0; taken < 6; taken += 1) {
        const z = 8 + taken * 26;
        scene.place(slot, new Matrix4().makeTranslation(slot, 0, z), slot, 0, z, 0.5);
      }
    }
    // A walk that filled one key's region past its capacity: the regrow re-lays the level's run.
    const regrown = scene.key("pine:0:1", LOCAL_NEEDLES, 128, {
      group: "pine:0",
      part: 1,
      parts: 2,
    });
    expect(regrown).toBe(keyOf(scene, "pine:0:1"));
    // The CPU path's own records, per key, and the record each dressed mesh reads — which is this
    // scene's own `argsIndex`, since a unit fixture has no mesh to read the offset off.
    const draws: IMeshDraw[] = PREWARM.map((name) => {
      const asset = ASSETS.find((one) =>
        name.startsWith(`${one.name}:`),
      ) as (typeof ASSETS)[number];
      const [, level, part] = name.split(":");
      const level0 = Number(level);
      return {
        // A unit fixture has no mesh to read the binding off, so the identity the owner would ask of
        // one is stated: this key's record is the scene's live args buffer's.
        bound: true,
        instances: cpuKeyInstances(
          scene.placements,
          ASSETS.indexOf(asset),
          level0,
          asset.distances,
          asset.cull,
          asset.parts[Number(part)] as Float32Array,
        ),
        name,
        record: (scene.regionOf(name) as IRegion).argsIndex,
      };
    });
    scene.drawsFrom(() => draws);
    lines.length = 0;
    // Thirty dispatches, so the thirtieth asks for its readback.
    for (let index = 0; index < 30; index += 1) {
      scene.dispatch(renderer, camera);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Every key drew the instances its own name says, and every one of them in full: the fixture's
    // camera holds every placement, so a run shorter than its key's records is a mapping fault too,
    // and containment alone would not see it.
    expect(scene.validation.meshMismatched).toBe(0);
    for (const draw of draws) {
      const region = scene.regionOf(draw.name) as IRegion;
      expect(region.name).toBe(draw.name);
      expect(readback.args[region.argsIndex * 5 + 1]).toBe(draw.instances.length / 16);
    }
    expect(scene.validation.verdict).toBe("ok");
    expect(lines.filter((line) => line.includes(" compared=")).at(-1)).toContain(
      "mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    scene.dispose();
  });

  it("culls authored ground cover at its maxDistance and switches its lods inside it", () => {
    // `ground_cover` as the committed package writes it: a `lods` entry at 60 m under a `maxDistance`
    // of 30 m, so `assetLevels` drops the level outright — an instance that far out is culled, so
    // its shape is never asked for — and the asset is one level culled at 30 less its eighth.
    const ground = wired([{ name: "gc", levels: [0], cull: 26.25 }], 1, 64);
    const origin = { x: 0, z: 0, planes: cameraAt(0, 0).planes };
    placed(ground, 0, 4, 7);
    // 10 m, 17 m, 24 m inside the cull; 31 m past it.
    const input: IKernelInput = {
      camera: { planes: origin.planes, x: 0, y: 0, z: 0 },
      count: ground.placements.length,
      placements: ground.placements,
      regionCount: ground.regions.length,
      regions: ground.regions,
      slots: ground.gates(),
    };
    const fromKernel = kernelDrawn(cullAndSelect(input), input);
    const expected = cpuReference(ground.placements, origin, 0, [0], 26.25, 0, 1);
    expect([...(fromKernel.get(keyOf(ground, "gc:0:0")) as number[])]).toEqual([
      ...(expected.get(keyOf(ground, "gc:0:0")) as number[]),
    ]);
    expect(fromKernel.get(keyOf(ground, "gc:0:0"))).toHaveLength(3);
    ground.dispose();

    // The same asset with a `lods` entry inside its `maxDistance`: two levels, the switch at 20 m,
    // and the cull still at 26.25 m — a level the package named is the one that takes over.
    const both = wired([{ name: "gc", levels: [0, 20], cull: 26.25 }], 1, 64);
    placed(both, 0, 4, 7);
    const second: IKernelInput = {
      camera: { planes: origin.planes, x: 0, y: 0, z: 0 },
      count: both.placements.length,
      placements: both.placements,
      regionCount: both.regions.length,
      regions: both.regions,
      slots: both.gates(),
    };
    const drawn = kernelDrawn(cullAndSelect(second), second);
    const wanted = cpuReference(both.placements, origin, 0, [0, 20], 26.25, 0, 1);
    for (const [key, indexes] of wanted)
      expect([...(drawn.get(key) as number[])].sort((a, b) => a - b)).toEqual(
        [...indexes].sort((a, b) => a - b),
      );
    // 10 m and 17 m at level 0, 24 m at level 1, 31 m culled.
    expect(drawn.get(keyOf(both, "gc:0:0"))).toHaveLength(2);
    expect(drawn.get(keyOf(both, "gc:1:0"))).toHaveLength(1);
    both.dispose();
  });

  it("regrows a level whole when its placements outgrow the region, and draws all of them", () => {
    const scene = wired([{ name: "gc", levels: [0] }], 2, 2);
    const origin = { x: 0, z: 0, planes: cameraAt(0, 0).planes };
    const run = (): Map<number, number[]> => {
      const input: IKernelInput = {
        camera: { planes: origin.planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      };
      return kernelDrawn(cullAndSelect(input), input);
    };
    placed(scene, 0, 5, 4);
    // The capacity guard drops what does not fit, and says so in the count rather than writing past
    // the region: two of five in each part.
    expect(run().get(keyOf(scene, "gc:0:0"))).toHaveLength(2);

    // A walk that brings the rest in: the level is regrown whole, both parts with it, and the run
    // the gate table addresses is still the two keys side by side.
    for (const part of [0, 1])
      scene.key(`gc:0:${String(part)}`, LOCAL, 8, { group: "gc:0", part, parts: 2 });
    expect(scene.levelKeys("gc:0")).toEqual({ firstKey: keyOf(scene, "gc:0:0"), parts: 2 });
    const grown = run();
    expect(grown.get(keyOf(scene, "gc:0:0"))).toHaveLength(5);
    expect(grown.get(keyOf(scene, "gc:0:1"))).toHaveLength(5);
    // The regrown run is the level's whole, packed from the front of the buffer with its sibling
    // right after it, and the draw's own `firstInstance` reads the same offsets.
    const region = scene.regionOf("gc:0:0") as IRegion;
    expect(region.capacity).toBe(8);
    expect(region.start).toBe(0);
    expect(scene.regionOf("gc:0:1")?.start).toBe(8);
    expect(scene.regionOf("gc:0:1")?.capacity).toBe(8);
    scene.dispose();
  });

  it("selects a level deeper than eight, which the kernel's own unrolled bound could not reach", () => {
    // A baked AutoLOD chain is not eight levels long by construction, and an unrolled loop bounded
    // by a fixed count drew everything past its last one at the wrong shape. The reference is the
    // branch the kernel mirrors, and it has no such bound.
    const distances = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120];
    const scene = wired([{ name: "pine", levels: distances }], 1, 64);
    const origin = { x: 0, z: 0, planes: cameraAt(0, 0).planes };
    placed(scene, 0, 3, 45);
    const input: IKernelInput = {
      camera: { planes: origin.planes, x: 0, y: 0, z: 0 },
      count: scene.placements.length,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    };
    const fromKernel = kernelDrawn(cullAndSelect(input), input);
    const expected = cpuReference(scene.placements, origin, 0, distances, undefined, 0, 1);
    for (const [key, indexes] of expected)
      expect([...(fromKernel.get(key) as number[])].sort((a, b) => a - b)).toEqual(
        [...indexes].sort((a, b) => a - b),
      );
    // 10 m at level 1, 55 m at level 5, 100 m at level 10: past every fixed count a loop could hold.
    expect(fromKernel.get(keyOf(scene, "pine:1:0"))).toHaveLength(1);
    expect(fromKernel.get(keyOf(scene, "pine:5:0"))).toHaveLength(1);
    expect(fromKernel.get(keyOf(scene, "pine:10:0"))).toHaveLength(1);
    scene.dispose();
  });

  it("keeps a prop whose model reaches away from its placement point, the way the CPU path does", () => {
    // A 20 m pole: bounds from y 0 to y 20 and a hand's width across, so a sphere at the placement
    // with the bounds' half-diagonal as its radius covers the first ten metres and no more. A camera
    // above it looking down sees metres 10.8 to 20 of it and none of the placement, and a point
    // sphere culls the whole pole. The CPU path's own gate is the cell's box over the same widened
    // bounds, so it draws it; the dispatch has to.
    const camera = new PerspectiveCamera(60, 1, 0.1, 1000);
    camera.position.set(0, 20, 0);
    camera.lookAt(0, 0, 80);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(
      new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    );
    const planes = new Float32Array(24);
    for (const [index, plane] of frustum.planes.entries()) {
      const at = index * 4;
      planes[at] = plane.normal.x;
      planes[at + 1] = plane.normal.y;
      planes[at + 2] = plane.normal.z;
      planes[at + 3] = plane.constant;
    }
    const scene = wired([{ name: "pole", levels: [0] }], 1, 8);
    scene.place(0, new Matrix4().makeTranslation(0, 0, 4), 0, 10, 4, 10);
    const input: IKernelInput = {
      camera: { planes, x: 0, y: 20, z: 0 },
      count: 1,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    };
    // The bounds' own sphere, which is what `#addPlacements` places: centred where the bounds' centre
    // lands, with the same radius.
    expect(cullAndSelect(input).counts[keyOf(scene, "pole:0:0")]).toBe(1);
    // The same placement with a sphere at its own point, which is what the wiring used to place: the
    // pole's upper half is on screen and the placement is not.
    const atPoint: IGpuPlacement[] = [
      { ...(scene.placements[0] as IGpuPlacement), centre: new Float32Array([0, 0, 4, 10]) },
    ];
    expect(cullAndSelect({ ...input, placements: atPoint }).counts[keyOf(scene, "pole:0:0")]).toBe(
      0,
    );
    scene.dispose();
  });

  it("sends each placement to exactly one level, so two keys never draw it twice", () => {
    // The coarse gate hides a key's mesh and the dispatch still has to draw the placement once. The
    // kernel's level test is ascending and `>`, so a placement belongs to the last gate it passes and
    // to no other — and this proves it by identity: the drawn matrix of every region is mapped back
    // to the placement it carries, and no placement may answer for two keys.
    const scene = wired([{ name: "prop", levels: [0, 20, 60] }], 1, 64);
    placed(scene, 0, 12, 7);
    const input: IKernelInput = {
      camera: { planes: cameraAt(0, 0).planes, x: 0, y: 0, z: 0 },
      count: scene.placements.length,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    };
    const drawn = kernelDrawn(cullAndSelect(input), input);
    const seen = new Map<number, number>();
    for (const [key, indexes] of drawn)
      for (const index of indexes) {
        expect(seen.has(index)).toBe(false);
        seen.set(index, key);
      }
    // Every placement is inside the camera's frustum here, so all twelve are drawn — none dropped,
    // none twice.
    expect(seen.size).toBe(12);
    expect([...drawn.values()].reduce((sum, run) => sum + run.length, 0)).toBe(12);
    scene.dispose();
  });
});

describe("WorldCells whose GPU scene comes up under a built ring", () => {
  it.each([1, 3, 5, 8])(
    "seeds source records for a build sliced before the renderer arrived (%i CPU units)",
    async (units) => {
      stubManifestFetch();
      const follow = { position: { ...cellCentre(1, 1), y: 0 } };
      const keyed = vi.spyOn(WorldGpuScene.prototype, "key");
      const logged = vi.spyOn(console, "info");
      let clock = 0;
      const world = await WorldCells.load({
        admissionBudgetMs: 1,
        admissionNow: () => {
          clock += 10_000;
          return clock;
        },
        budgets,
        follow,
        freshMeshesPerUpdate: 1,
        gpuScene: true,
        loadModel: async () => plainModel(),
        prefetchSeconds: 0,
        ring: 0,
        shadows: { cast: true },
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flush();
      // Enable during placement slicing or mesh publication, including a pending pine build.
      for (let unit = 0; unit < units; unit += 1) world.update();
      expect(world.stats().admission.backlog).toBeGreaterThan(0);
      expect(world.stats().admission.deferred).toBeGreaterThan(0);
      world.update(gpuRendererStub(), playerCamera());
      await flushed(world);
      const mainReport = logged.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.startsWith("TN_WORLD_MAIN_CULL "))
        .at(-1);

      const cpu = await WorldCells.load({
        admissionBudgetMs: Number.POSITIVE_INFINITY,
        budgets,
        follow,
        gpuScene: false,
        loadModel: async () => plainModel(),
        prefetchSeconds: 0,
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      cpu.update();
      await flushed(cpu);
      // GPU source residency is the raw resident placement count, not the CPU path's already
      // maxDistance-filtered draw count. The dispatch applies that cull later.
      const expected = cpu.stats().instances;
      const expectedMatrices = sourceMatricesFor("1,1");
      expect(world.stats().gpuScene.instances).toBe(expected);
      expect(mainReport).toContain(`instances=${String(expected)} `);
      const scene = keyed.mock.contexts.at(-1) as WorldGpuScene;
      expect(expectedMatrices).toHaveLength(expected);
      const assertSources = (): void => {
        expect(
          scene.placements
            .filter((one) => one.slot >= 0)
            .map((one) => one.matrix.join(","))
            .sort(),
        ).toEqual(expectedMatrices);
      };
      assertSources();
      Object.assign(follow.position, cellCentre(6, 1));
      world.update();
      await flushed(world);
      expect(world.stats().gpuScene.instances).toBe(0);
      Object.assign(follow.position, cellCentre(1, 1));
      world.update();
      await flushed(world);
      expect(world.stats().evictions).toBeGreaterThan(0);
      assertSources();
      expect(world.stats().failures).toBe(0);
      cpu.dispose();
      world.dispose();
    },
  );

  /** A world over the same package, the same ring and the same camera, built the way the test asks. */
  async function build(framesWithoutARenderer: number): Promise<WorldCells> {
    stubManifestFetch();
    const follow = { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } };
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    for (let index = 0; index < framesWithoutARenderer; index += 1) {
      world.update();
      await flush();
    }
    await flushed(world);
    return world;
  }

  it("gives the dispatch the ring it built before the scene came up", async () => {
    // The frames before the world has a renderer: the ring is admitted, decoded and swapped into the
    // CPU path's own batches, and not one of those placements has a source record. Nothing else in
    // the class would ever hand them over — a cell is only rebuilt when its records change, and
    // theirs have not.
    const late = await build(20);
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    late.update(renderer, playerCamera());
    await flushed(late);
    const on = late.stats();
    expect(on.gpuScene.on).toBe(true);
    expect(on.gpuScene.instances).toBeGreaterThan(0);
    expect(on.failures).toBe(0);
    late.dispose();

    // And it is the same set a world whose scene was on from its first frame holds: the ring is not
    // half given over, it is all of it.
    const fromFirstFrame = await build(0);
    fromFirstFrame.update(renderer, playerCamera());
    await flushed(fromFirstFrame);
    expect(on.gpuScene.instances).toBe(fromFirstFrame.stats().gpuScene.instances);
    fromFirstFrame.dispose();
  });
});

describe("WorldCells caster admission while the GPU scene is still being seeded", () => {
  /** One caster half the world holds: `@x,z` for a world-grid square, `@*` for the wide mesh. */
  interface ICasterHalf {
    /** What `WorldCells#publishCasterAdmission` published on the mesh, read as the probe reads it. */
    readonly admitted: boolean;
    /** The `x,z` after the `@`, or `*` for the one wide mesh that covers every cell of its asset. */
    readonly cluster: string;
    /** Records behind it, which is what a shadow level would submit. */
    readonly records: number;
  }

  it("bills a caster half only for the sources the dispatch has been given", async () => {
    /**
     * The orphan shadows Machinefall's start pose drew: dozens of mid-distance canopies on empty
     * ground. The scene came up under a ring the CPU path had already built, `#seedGpuSources` queued
     * the source records behind the admission budget, and the near cells were placed first — so while
     * an asset had *anything* placed, its far clusters drew shadows for trees the main pass had not
     * been given a record for. One capture in four showed them.
     *
     * The window is measured, not hoped for: a fake clock that charges 10 s an admission makes every
     * `update` admit exactly one unit, so the seed's rebuild is spread over hundreds of frames and a
     * half-placed ring is a frame the test lands on deliberately.
     *
     * One asset over four cells, and `clusterSize: CELL` so a cell is a caster cluster of its own:
     * every placed source in the ring is this asset's, so a half's records can be set against the
     * sources behind it without knowing which asset a source was filed under.
     */
    const grid = [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ] as const;
    const records: number[] = [];
    for (const [x, z] of grid) {
      const centre = cellCentre(x, z);
      for (let at = 0; at < 4; at += 1)
        records.push(
          centre.x + (at % 2) * 4 - 2,
          0,
          centre.z + Math.floor(at / 2) * 4 - 2,
          0,
          0,
          0,
          1,
          1,
        );
    }
    const pkg: IWorldPackage = {
      assets: { pine: { bounds: { max: [1, 2, 1], min: [-1, -2, -1] }, glb: "assets/pine.glb" } },
      cellSize: CELL,
      cells: grid.map(([x, z], index) => ({
        runs: [{ asset: "pine", count: 4, offset: index * 4 }],
        x,
        z,
      })),
      extent: manifest.extent,
      placements: "placements.bin",
      terrain: manifest.terrain,
      version: 1,
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
        if (url.endsWith("placements.bin"))
          return fileResponse(Buffer.from(new Float32Array(records).buffer));
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
    const keyed = vi.spyOn(WorldGpuScene.prototype, "key");
    let clock = 0;
    const world = await WorldCells.load({
      admissionBudgetMs: 1,
      admissionNow: () => {
        clock += 10_000;
        return clock;
      },
      budgets,
      clusterSize: CELL,
      follow: { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } },
      freshMeshesPerUpdate: 1,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      shadows: { cast: true },
      surface,
      // The synthetic clock refuses terrain-block merges; this fixture measures prop admission.
      terrain: false,
      url: "/world/world.json",
    });
    const renderer = gpuRendererStub();
    const camera = playerCamera();
    /** Every caster half the world holds, whatever it draws. */
    const halves = (): ICasterHalf[] =>
      worldMeshes(world)
        .map((mesh) => {
          const at = mesh.name.indexOf("@");
          // A main mesh is `asset:level:part` and has no `@`; a chunk mesh is not a caster half.
          if (at < 0) return undefined;
          return {
            admitted: (mesh as InstancedMesh & { mainAdmitted?: boolean }).mainAdmitted !== false,
            cluster: mesh.name.slice(at + 1),
            records: mesh.count,
          } as ICasterHalf;
        })
        .filter((half): half is ICasterHalf => half !== undefined);
    /** Nothing left to admit: no backlog, no deferred build, no model still loading. */
    const settled = (): boolean => {
      const stats = world.stats();
      return (
        stats.admission.backlog === 0 && stats.admission.deferred === 0 && stats.loadsInFlight === 0
      );
    };

    // The ring builds with no renderer: every caster half holds its cell's records and the scene holds
    // no placement at all. That is the state the seed's rebuild then repairs one cell at a time.
    let frames = 0;
    for (; frames < 600; frames += 1) {
      await flush(4);
      world.update();
      const stats = world.stats();
      if (
        stats.admission.backlog === 0 &&
        stats.admission.deferred === 0 &&
        stats.loadsInFlight === 0 &&
        halves().filter((half) => half.records > 0).length > 4
      )
        break;
    }
    expect(frames).toBeLessThan(599);
    expect(world.stats().gpuScene.on).toBe(false);
    expect(halves().filter((half) => half.records > 0).length).toBeGreaterThan(4);

    // The renderer arrives, and the scene comes up under that ring.
    world.update(renderer, camera);
    await flush(4);
    const scene = keyed.mock.contexts.at(-1) as WorldGpuScene;
    expect(scene).toBeInstanceOf(WorldGpuScene);
    /** Sources the dispatch still holds, per `x,z` cluster and over the whole map. */
    const placed = (): { readonly byCluster: Map<string, number>; readonly total: number } => {
      const byCluster = new Map<string, number>();
      let total = 0;
      for (const one of scene.placements) {
        if (one.slot < 0) continue;
        const key = `${String(Math.floor(((one.centre[0] as number) - manifest.extent.minX) / CELL))},${String(Math.floor(((one.centre[2] as number) - manifest.extent.minZ) / CELL))}`;
        byCluster.set(key, (byCluster.get(key) ?? 0) + 1);
        total += 1;
      }
      return { byCluster, total };
    };

    // Drive to a frame with some of the ring placed and some of it still holding records the dispatch
    // has none of, which is the only state this test means anything in.
    let halfPlaced = false;
    for (frames = 0; frames < 900; frames += 1) {
      world.update(renderer, camera);
      await flush(2);
      const held = placed();
      if (
        held.total > 0 &&
        halves().some(
          (half) => half.records > 0 && (held.byCluster.get(half.cluster) ?? 0) < half.records,
        )
      ) {
        halfPlaced = true;
        break;
      }
    }
    expect(halfPlaced).toBe(true);
    // The frame just driven, read once for the bill: no update has run since, so the ring and the
    // dispatch are the ones the loop stopped on.
    const sources = placed();
    /** Placed sources standing behind a half's records: its own cluster, or the map for the wide one. */
    const behind = (half: ICasterHalf): number =>
      half.cluster === "*" ? sources.total : (sources.byCluster.get(half.cluster) ?? 0);
    const bill = (count: readonly ICasterHalf[]): number =>
      count.reduce((sum, half) => sum + half.records, 0);

    const every = halves().filter((half) => half.records > 0);
    const placedHalves = every.filter((half) => behind(half) >= half.records);
    // One asset with cells on both sides of the placement: some placed, some resident and not.
    expect(placedHalves.length).toBeGreaterThan(0);
    expect(placedHalves.length).toBeLessThan(every.length);
    // So the bill the shadow levels take is the records behind the halves the dispatch can draw, and
    // nothing else. Admitting a half with a record no placed source stands behind is what drew
    // canopy shadows on empty ground.
    expect(bill(every.filter((half) => half.admitted))).toBe(bill(placedHalves));

    // The drain's end state is the whole ring casting again: the rule withholds a half until its own
    // sources arrive, it does not withhold the asset for good.
    for (frames = 0; frames < 900 && !settled(); frames += 1) {
      world.update(renderer, camera);
      await flush(2);
    }
    expect(settled()).toBe(true);
    expect(world.stats().failures).toBe(0);
    expect(world.stats().gpuScene.instances).toBeGreaterThan(0);
    expect(halves().filter((half) => half.admitted).length).toBe(halves().length);
    world.dispose();
  });
});

describe("WorldCells GPU scene source records past the build-time cull", () => {
  it("gives the dispatch a placement that was past maxDistance once the camera walks into its range", async () => {
    // One cell, two props 42 m apart under a 40 m `maxDistance`: the dispatch culls the second at
    // the first pose, but GPU admission must retain its source record so the midpoint can draw it
    // without a CPU replacement.
    const centre = cellCentre(0, 0);
    const pkg: IWorldPackage = {
      assets: {
        prop: { bounds: { max: [1, 1, 1], min: [-1, 0, -1] }, glb: "prop.glb", maxDistance: 40 },
      },
      cellSize: CELL,
      cells: [{ runs: [{ asset: "prop", count: 2, offset: 0 }], x: 0, z: 0 }],
      extent: manifest.extent,
      placements: "placements.bin",
      terrain: manifest.terrain,
      version: 1,
    };
    const records = new Float32Array([
      centre.x,
      0,
      centre.z,
      0,
      0,
      0,
      1,
      1,
      centre.x + 30,
      0,
      centre.z + 30,
      0,
      0,
      0,
      1,
      1,
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown): Promise<object> => {
        const url = String(input);
        if (url.endsWith("world.json"))
          return {
            arrayBuffer: async () =>
              new TextEncoder().encode(JSON.stringify(pkg)).buffer as ArrayBuffer,
            headers: new Headers(),
            json: async () => pkg,
            ok: true,
            status: 200,
          };
        if (url.endsWith("placements.bin")) return fileResponse(Buffer.from(records.buffer));
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
    const follow = { position: { ...centre } };
    const sourceBudget = { bytes: 2 * 32, instances: 2, residentCells: 1 };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    const keyed = vi.spyOn(WorldGpuScene.prototype, "key");
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets: sourceBudget,
      follow,
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
    });
    world.update(renderer, playerCamera([0, 0]));
    await flushed(world);

    expect(world.stats().gpuScene.on).toBe(true);
    expect(world.stats().gpuScene.instances).toBe(2);
    expect(world.stats().pressure.instances).toBe(0);
    expect(world.stats().pressure.bytes).toBe(0);
    const scene = keyed.mock.contexts.at(-1) as WorldGpuScene;
    const key = keyOf(scene, "prop:0:0");
    const slot = scene.placements[0]?.slot ?? -1;
    expect(slot).toBeGreaterThanOrEqual(0);
    const drawnAt = (x: number, z: number): number => {
      const planes = new Float32Array(24);
      const input: IKernelInput = {
        camera: { planes, x, y: 0, z },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      };
      const actual = kernelDrawn(cullAndSelect(input), input);
      const expected = cpuReference(
        scene.placements,
        { planes, x, z },
        slot,
        [0],
        40 - 40 / 8,
        key,
        1,
      );
      expect(actual).toEqual(expected);
      return actual.get(key)?.length ?? 0;
    };
    expect(drawnAt(centre.x, centre.z)).toBe(1);
    const beforeWalk = world.stats();
    follow.position.x = centre.x + 15;
    follow.position.z = centre.z + 15;
    for (let frame = 0; frame < 10; frame += 1) {
      world.update(renderer, playerCamera([0, 0]));
      await flushed(world);
    }
    expect(world.stats().gpuScene.instances).toBe(2);
    expect(drawnAt(follow.position.x, follow.position.z)).toBe(2);
    const afterWalk = world.stats();
    expect(afterWalk.refilterEntries - beforeWalk.refilterEntries).toBe(0);
    expect(afterWalk.levelRefilters - beforeWalk.levelRefilters).toBe(0);
    world.dispose();
  });
});

/**
 * The cull kernel's bindings, against the sizes WebGPU holds them to.
 *
 * A real WebGPU run of `?scene=map-walk&tnGpuScene=1&tnGpuSceneValidate=1` raised a validation error
 * 956 times a run — `[Buffer (unlabeled)] bound with size 16 at group 0, binding 6 is too small` —
 * and `TN_WORLD_GPU_SCENE_VALIDATE ok keys=0` printed throughout, because the refused dispatch left
 * the args buffer holding what the clear pass wrote. The kernel never ran and the check agreed. So:
 * every buffer holds at least one element of the type the kernel declares it as, and a check that
 * compared nothing while placements existed is an error rather than a pass.
 */
describe("WorldGpuScene storage bindings and its validation verdict", () => {
  /**
   * Drive `count` frames of the dispatch and let the readbacks land, so a validation that runs every
   * thirtieth dispatch has actually run by the time this returns.
   */
  async function drive(
    scene: WorldGpuScene,
    renderer: IRendererLike,
    count: number,
  ): Promise<void> {
    const { camera } = cameraAt(0, 0);
    for (let index = 0; index < count; index += 1) {
      scene.dispatch(renderer, camera);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Asserts every buffer the scene owns can be bound as the type the kernel declares it as. */
  function expectBindable(scene: WorldGpuScene, where: string): void {
    const footprint = scene.footprint();
    // Every buffer the class allocates, so a new one cannot join without being checked.
    expect(Object.keys(footprint).sort()).toEqual([
      "args",
      "drawn",
      "gates",
      "keys",
      "levels",
      "locals",
      "source",
    ]);
    for (const [name, buffer] of Object.entries(footprint)) {
      const floor = storageElementBytes(buffer.type);
      expect(buffer.bytes, `${where}: ${name} is under one ${buffer.type}`).toBeGreaterThanOrEqual(
        floor,
      );
      // And the item size the kernel indexes by is the declared element size, not a word count that
      // happens to divide: `drawn` at four words per `mat4` is 16 bytes against a 64-byte minimum.
      expect(buffer.count * floor, `${where}: ${name} element count`).toBe(buffer.bytes);
    }
  }

  it("holds every storage binding to at least one element of its declared type", () => {
    const scene = new WorldGpuScene();
    scene.enable({ kind: "webgpu", raw: { backend: { hasFeature: () => true } } } as never, true);
    // Nothing is bound before a slot or a key exists, so there is nothing that can be too small.
    expect(scene.footprint()).toEqual({});

    // Empty: a slot and no key and no placement. The smallest set of bindings there is, and the
    // state the real run failed in — the one-element `drawn` buffer was 16 bytes against the 64 a
    // `mat4` needs.
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 0 }] });
    expectBindable(scene, "empty");

    // One key and one placement — the first structural change a real ring makes.
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);
    expectBindable(scene, "one-key");

    // A regrow: the key outgrows its region and is re-minted at the tail, which replaces `keys`,
    // `locals`, `args` and `drawn` in one go.
    scene.key("pine:0:0", LOCAL, 4096);
    expectBindable(scene, "regrown");
    expect(scene.footprint().drawn?.count).toBeGreaterThan(1);
  });

  it("keeps the gate table whole when it is written", () => {
    // Two assets, three levels each: the table is sized before it is written, so the second asset's
    // first `vec4` is a value and not a hole the `Float32Array` swallowed.
    const scene = wired(
      [
        { cull: 120, levels: DISTANCES, name: "pine" },
        { cull: 40, levels: DISTANCES, name: "rock" },
      ],
      1,
      4,
    );
    const gates = scene.footprint().gates;
    expect(gates?.count).toBeGreaterThanOrEqual(2);
    // `wired` adopts both assets, and the second one's gate is only there if the table was sized
    // first; a table written at one `vec4` and grown afterwards leaves the tail zero.
    expect(scene.gates()).toHaveLength(2);
    const levels = scene.footprint().levels;
    expect((levels?.count ?? 0) * 4).toBeGreaterThanOrEqual(6);
  });

  it("republishes a slot when its shadow fallback policy changes", () => {
    const scene = wired([{ name: "rock", levels: DISTANCES }], 1, 4);
    const slot = scene.gates()[0] as IAssetSlot;
    scene.slot("rock", { ...slot, shadowFallback: false });
    expect(scene.gates()[0]?.shadowFallback).toBe(false);
    scene.slot("rock", { ...slot, shadowFallback: true });
    expect(scene.gates()[0]?.shadowFallback).toBe(true);
  });

  it("keeps every regrown binding as wide as the kernel declares it", () => {
    // 40 keys, then one regrown past all of them: a regrow must re-allocate through the same
    // declared type, and a stride written at the call site is how `drawn` lost 48 bytes.
    const scene = wired([{ name: "pine", levels: DISTANCES }], 1, 8);
    scene.key("pine:2:0", LOCAL, 64);
    expectBindable(scene, "grown");
    const drawn = scene.footprint().drawn;
    expect(drawn?.type).toBe("mat4");
    expect(drawn?.bytes).toBe((drawn?.count ?? 0) * 64);
  });

  it("names what a device error and an empty comparison do to the verdict", () => {
    const base = {
      compared: 6,
      deviceError: "",
      instancesCpu: 120,
      instancesGpu: 120,
      matricesMismatched: 0,
      meshMismatched: 0,
      meshMismatches: [] as readonly string[],
      mismatched: 0,
      mismatches: [] as readonly string[],
      matrixMismatches: [] as readonly string[],
      placed: 400,
    };
    const agreed = validationReport(base);
    expect(agreed.verdict).toBe("ok");
    expect(agreed.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=6 instancesGpu=120 instancesCpu=120 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(agreed.lines).toEqual([]);

    // The run that shipped: a kernel the device refused, and a check that reported success anyway.
    const nothing = validationReport({
      ...base,
      compared: 0,
      instancesCpu: 0,
      instancesGpu: 0,
      placed: 0,
    });
    expect(nothing.verdict).toBe("ok");
    expect(nothing.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=0 instancesGpu=0 instancesCpu=0 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );

    // Compared nothing with placements resident: nothing was checked, so it is not a pass, and the
    // line says which of the two numbers is the wrong one.
    const blind = validationReport({
      ...base,
      compared: 0,
      instancesCpu: 0,
      instancesGpu: 0,
      placed: 812,
    });
    expect(blind.verdict).toBe("error");
    expect(blind.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE error compared=0 instancesGpu=0 instancesCpu=0 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(blind.lines).toEqual(["cause=compared-0-with-placed=812"]);

    // A refused dispatch, however good the counts look.
    const refused = validationReport({
      ...base,
      deviceError: "GPUValidationError: bound with size 16 is too small",
    });
    expect(refused.verdict).toBe("error");
    expect(refused.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE error compared=6 instancesGpu=120 instancesCpu=120 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(refused.lines).toEqual([
      "cause=device-error GPUValidationError: bound with size 16 is too small",
    ]);

    // A readback that never landed, with nothing resident to blame: a named cause is an error on its
    // own, because a check that did not run is not a check that passed.
    const failed = validationReport({
      ...base,
      cause: "readback-failed: mapAsync device lost",
      compared: 0,
      instancesCpu: 0,
      instancesGpu: 0,
      placed: 0,
    });
    expect(failed.verdict).toBe("error");
    expect(failed.lines).toEqual(["cause=readback-failed: mapAsync device lost"]);

    // And one cause cannot own the report: 160 characters, however long the device's message is.
    const long = validationReport({
      ...base,
      cause: `readback-failed: ${"x".repeat(400)}`,
      compared: 0,
    });
    expect(long.lines[0]).toHaveLength("cause=".length + 160);

    const differing = validationReport({
      ...base,
      instancesGpu: 96,
      mismatched: 2,
      mismatches: ["pine:0:0 gpu=40 cpu=48", "pine:1:0 gpu=56 cpu=48"],
    });
    expect(differing.verdict).toBe("mismatch");
    expect(differing.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE mismatch compared=6 instancesGpu=96 instancesCpu=120 mismatched=2 matricesMismatched=0 meshMismatched=0",
    );
    expect(differing.lines).toEqual(["pine:0:0 gpu=40 cpu=48", "pine:1:0 gpu=56 cpu=48"]);
  });

  it("carries the memory fields a backend offers and omits the ones it does not", () => {
    const base = {
      compared: 1,
      deviceError: "",
      instancesCpu: 1,
      instancesGpu: 1,
      matricesMismatched: 0,
      meshMismatched: 0,
      meshMismatches: [] as readonly string[],
      mismatched: 0,
      mismatches: [] as readonly string[],
      matrixMismatches: [] as readonly string[],
      placed: 1,
    };
    const known = validationReport({
      ...base,
      memory: {
        storageAttributes: 4,
        storageAttributesSize: 256,
        indirectStorageAttributes: 2,
        indirectStorageAttributesSize: 128,
        readbackBuffers: 1,
        readbackBuffersSize: 512,
        total: 2048,
        footprintBytes: 4096,
      },
    });
    expect(known.line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=1 instancesGpu=1 instancesCpu=1 mismatched=0 " +
        "matricesMismatched=0 meshMismatched=0 storageAttributes=4 storageAttributesSize=256 " +
        "indirectStorageAttributes=2 indirectStorageAttributesSize=128 readbackBuffers=1 " +
        "readbackBuffersSize=512 total=2048 footprintBytes=4096",
    );
    // No memory object at all is no memory fields, and the line is exactly what it always was.
    expect(validationReport(base).line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=1 instancesGpu=1 instancesCpu=1 mismatched=0 " +
        "matricesMismatched=0 meshMismatched=0",
    );
    // A field the backend did not offer is omitted, not printed as a fake zero, and a non-finite
    // reading is not a number either.
    expect(validationReport({ ...base, memory: { readbackBuffers: 2 } }).line).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=1 instancesGpu=1 instancesCpu=1 mismatched=0 " +
        "matricesMismatched=0 meshMismatched=0 readbackBuffers=2",
    );
    expect(
      validationReport({ ...base, memory: { total: Number.NaN } }).line.includes("total="),
    ).toBe(false);
  });

  it("counts a mesh reading a stale args buffer as a mismatch even when its record agrees", () => {
    // The readback is of the live args buffer, so a record's numbers can agree with the reference
    // while the mesh's own geometry still points at an older buffer with the same layout — the args
    // buffer is allocated independently of `drawn`, and a mint replaces it under a dressed mesh. The
    // record offset alone cannot see it; the owner's own `bound` is what does.
    const region: IRegion = { argsIndex: 0, capacity: 4, indexCount: 96, local: LOCAL, start: 0 };
    const gpu = Uint32Array.from([96, 2, 0, 0, 0]);
    const drawn = new Float32Array(32);
    drawn.set(LOCAL, 0);
    drawn.set(LOCAL, 16);
    const instances = new Float32Array(32);
    instances.set(LOCAL, 0);
    instances.set(LOCAL, 16);
    const draw = (bound: boolean | undefined): IMeshDraw[] => [
      { bound, instances, name: "pine:0:0", record: 0 },
    ];
    // A bound record and a stale one read the same numbers and the same matrices; only the binding
    // differs, and it is the difference that reports.
    expect(compareMeshDraws(gpu, drawn, draw(true), [region]).mismatched).toBe(0);
    const stale = compareMeshDraws(gpu, drawn, draw(false), [region]);
    expect(stale.mismatched).toBe(1);
    expect(stale.mismatches[0]).toContain("indirect=stale");
    // A missing field is not a pass: production is never blind to an unstated binding.
    expect(compareMeshDraws(gpu, drawn, draw(undefined), [region]).mismatched).toBe(1);
  });

  it("reports the device's own uncaptured error instead of the counts", async () => {
    // The device three's backend wrapped, raising exactly the error the real run raised.
    let raise: ((event: unknown) => void) | null = null;
    const device: { onuncapturederror?: ((event: unknown) => void) | null } = {};
    const lines: string[] = [];
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      // three chains its own handler onto the device, printing the message; ours must add to it, not
      // replace it, or the console line the evidence came from would go quiet.
      log: (line: string): void => {
        lines.push(line);
      },
      raw: {
        backend: {
          device,
          hasFeature: (): boolean => true,
        },
      },
      readback: async (attribute: unknown): Promise<ArrayBuffer> =>
        (attribute as { array: Uint32Array }).array.buffer.slice(0) as ArrayBuffer,
    } as unknown as IRendererLike;
    device.onuncapturederror = (): void => {
      raise = device.onuncapturederror ?? null;
    };
    const scene = new WorldGpuScene();
    expect(scene.enable(renderer, true, true)).toBe(true);
    raise = device.onuncapturederror ?? null;
    expect(typeof raise).toBe("function");

    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    // One dispatched frame, then the readback lands with the GPU half of the counts still zero —
    // and a device error in between, which is the whole point.
    (raise as unknown as (event: unknown) => void)({
      error: {
        constructor: { name: "GPUValidationError" },
        message:
          "[Buffer (unlabeled)] bound with size 16 at group 0, binding 6 is too small. The pipeline requires a buffer binding which is at least 64 bytes.",
      },
    });
    await drive(scene, renderer, 30);
    const reported = lines.filter((line) => line.startsWith("TN_WORLD_GPU_SCENE_VALIDATE"));
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.some((line) => line.includes(" error "))).toBe(true);
    expect(
      reported.some((line) => line.includes("GPUValidationError") && line.includes("binding 6")),
    ).toBe(true);
    expect(scene.validation.verdict).toBe("error");
    expect(scene.validation.compared).toBe(1);

    // Reported once: the next check with no new error is a check of its own, and a cleared message
    // does not come back to claim a second one.
    lines.length = 0;
    await drive(scene, renderer, 30);
    expect(lines.some((line) => line.includes("device-error"))).toBe(false);
    expect(scene.validation.verdict).not.toBe("error");
  });

  it("reuses and releases validation readback buffers", async () => {
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    const targets: unknown[] = [];
    const releases = new Map<unknown, number>();
    const disposals = new Set<unknown>();
    const mirror = (attribute: unknown, target?: unknown): Promise<ArrayBuffer> => {
      expect(target).toBeDefined();
      if (!releases.has(target)) {
        releases.set(target, 0);
        const readback = target as {
          addEventListener: (type: string, listener: () => void) => void;
        };
        readback.addEventListener("release", () => {
          releases.set(target, (releases.get(target) ?? 0) + 1);
        });
        readback.addEventListener("dispose", () => disposals.add(target));
      }
      targets.push(target);
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (): void => {},
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    await drive(scene, renderer, 30);
    expect(targets).toHaveLength(2);
    expect([...releases.values()]).toEqual([1, 1]);
    await drive(scene, renderer, 30);
    expect(targets).toHaveLength(4);
    expect(targets[2]).toBe(targets[0]);
    expect(targets[3]).toBe(targets[1]);
    expect([...releases.values()]).toEqual([2, 2]);
    scene.dispose();
    expect(disposals.size).toBe(2);
  });

  it("returns one completed manual frame validation with its dispatch identity", async () => {
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    let readbacks = 0;
    const mirror = (attribute: unknown): Promise<ArrayBuffer> => {
      readbacks += 1;
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, false)).toBe(true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);
    scene.dispatch(renderer, camera);

    const result = await scene.validateCurrentDispatch(renderer, 17);
    expect(result.frame).toBe(17);
    expect(result.dispatch).toBe(1);
    expect(result.verdict).toBe("ok");
    expect(result.compared).toBe(1);
    expect(result.instancesGpu).toBe(1);
    expect(result.instancesCpu).toBe(1);
    await expect(scene.validateCurrentDispatch(renderer, 18)).rejects.toThrow(
      "already manually validated",
    );
    for (let dispatch = 2; dispatch <= 30; dispatch += 1) scene.dispatch(renderer, camera);
    const thirtieth = await scene.validateCurrentDispatch(renderer, 30);
    expect(thirtieth.dispatch).toBe(30);
    expect(thirtieth.frame).toBe(30);
    expect(thirtieth.verdict).toBe("ok");
    expect(readbacks).toBe(4);
    scene.dispose();
  });

  it("holds both validation targets until a failed pair has settled", async () => {
    const lines: string[] = [];
    const scene = new WorldGpuScene();
    const targets: unknown[] = [];
    const releases = new Map<unknown, number>();
    const disposals = new Set<unknown>();
    let calls = 0;
    let settleDrawn!: (bytes: ArrayBuffer) => void;
    const drawnPending = new Promise<ArrayBuffer>((resolve) => {
      settleDrawn = resolve;
    });
    const readback = (_attribute: unknown, target?: unknown): Promise<ArrayBuffer> => {
      expect(target).toBeDefined();
      if (!releases.has(target)) {
        releases.set(target, 0);
        const readbackTarget = target as {
          addEventListener: (type: string, listener: () => void) => void;
        };
        readbackTarget.addEventListener("release", () => {
          releases.set(target, (releases.get(target) ?? 0) + 1);
        });
        readbackTarget.addEventListener("dispose", () => disposals.add(target));
      }
      targets.push(target);
      calls += 1;
      if (calls === 1) return Promise.reject(new Error("args map failed"));
      if (calls === 2) return drawnPending;
      return Promise.resolve(new ArrayBuffer(0));
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    await drive(scene, renderer, 30);
    expect(scene.validation.verdict).toBe("error");
    expect(lines).toContain("TN_WORLD_GPU_SCENE_VALIDATE cause=readback-failed: args map failed");
    expect(targets).toHaveLength(2);
    expect([...releases.values()]).toEqual([0, 0]);
    expect(disposals.size).toBe(0);

    // A structural grow while the pair is pending must not replace or release either target.
    scene.key("oak:0:0", LOCAL, 128, { group: "oak:0", part: 0, parts: 1 });
    scene.slot("oak", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 1, parts: 1 }] });
    await drive(scene, renderer, 30);
    expect(targets).toHaveLength(2);
    expect([...releases.values()]).toEqual([0, 0]);
    expect(disposals.size).toBe(0);

    // Disposal also waits for the GPU operation: the cleanup owns the pair after the scene drops it.
    scene.dispose();
    expect([...releases.values()]).toEqual([0, 0]);
    expect(disposals.size).toBe(0);
    settleDrawn(new ArrayBuffer(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect([...releases.values()]).toEqual([1, 1]);
    expect(disposals.size).toBe(2);
  });

  /**
   * The readback is held against the dispatch that produced it, not against the frames that followed.
   *
   * A 20 m/s map-walk flyover printed `error compared=0 instancesGpu=0 instancesCpu=0` over 21,147
   * resident placements and never once compared a key: the check dropped the bytes whenever a
   * structural change landed between asking for them and receiving them, and while a world streams
   * that is every readback. So the reference is now a copy taken in the dispatch itself, and a new
   * key minted while the bytes are in flight is no longer a reason to throw them away.
   */
  it("compares the dispatch's own snapshot after a structural change lands in flight", async () => {
    const lines: string[] = [];
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    // The kernel mirror: a readback that answers with exactly what the reference would have written
    // for the dispatch it was asked about, which is what a correct kernel produces.
    const mirror = (attribute: unknown): Promise<ArrayBuffer> => {
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      // Which buffer is asked for decides which half answers, exactly as the device's two copies do:
      // the records are `uint` words and the compacted matrices are `mat4` floats.
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    // The level declares both of its parts, so the run is claimed whole: the second part's key
    // exists, empty, from the first key on.
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 2 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 2 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    // Thirty dispatches, so the thirtieth asks for its readback — and the structural change lands
    // between the request and the bytes, which is the window the check used to discard.
    for (let index = 0; index < 30; index += 1) scene.dispatch(renderer, camera);
    scene.key("pine:0:1", LOCAL, 4, { group: "pine:0", part: 1, parts: 2 });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 12), 0, 0, 12, 0.5);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // One instance, because that is what the snapshot's own placements held: the live scene has a
    // second placement by now, and the reference for it did not exist when the dispatch ran.
    expect(scene.regions).toHaveLength(2);
    expect(lines).toContain(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=2 instancesGpu=1 instancesCpu=1 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(scene.validation.verdict).toBe("ok");
    expect(scene.validation.compared).toBe(2);

    // And the next check is a check of the world as it now is: two keys, each drawing both of the
    // two placements, so four instances where the first dispatch had one.
    lines.length = 0;
    await drive(scene, renderer, 30);
    expect(lines).toContain(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=2 instancesGpu=4 instancesCpu=4 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(scene.validation.compared).toBe(2);
  });

  /**
   * The snapshot carries the placement's own scale, so the reference selects the impostor terminal
   * at the same distance the kernel does.
   *
   * `#snapshot` copied the centre, the matrix and the slot and dropped `scale`, so every placement
   * whose scale is not 1 made `cullAndSelect(snapshot)` read `scale ?? 1`: the terminal switched at
   * the unscaled base gate and the reference named a different key than the scaled/mirrored terminal
   * the readback held. The mirror below is the kernel — it selects over the live placements, whose
   * scale is exactly what the dispatch wrote into `info.y`.
   */
  it("validates a source/impostor switch under the placement's scale, not a default of 1", async () => {
    setLodBias(1);
    const lines: string[] = [];
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    const mirror = (attribute: unknown): Promise<ArrayBuffer> => {
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    // Three levels, the last a whole-asset impostor: its terminal is the base 120 scaled by the
    // placement's magnitude, so the source/impostor boundary moves with the scale.
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.key("pine:1:0", LOCAL, 4, { group: "pine:1", part: 0, parts: 1 });
    scene.key("pine:2:0", LOCAL, 4, { group: "pine:2", part: 0, parts: 1 });
    scene.slot("pine", {
      cull: undefined,
      distances: [0, 40, 120],
      impostor: true,
      levels: [
        { firstKey: 0, parts: 1 },
        { firstKey: 1, parts: 1 },
        { firstKey: 2, parts: 1 },
      ],
    });
    // Half scale switches the terminal at 60 m, so 100 m draws the impostor; a snapshot defaulting
    // to 1 keeps the 120 m source level.
    scene.place(0, new Matrix4().makeTranslation(0, 0, 100), 0, 0, 100, 0.5, 0.5);
    // Twice the scale, and its mirror, floor the terminal at 240 m, so 200 m is still the source
    // level; a snapshot defaulting to 1 puts both on the terminal.
    scene.place(0, new Matrix4().makeTranslation(0, 0, 200), 0, 0, 200, 0.5, 2);
    scene.place(0, new Matrix4().makeTranslation(0, 0, 200), 0, 0, 200, 0.5, -2);

    await drive(scene, renderer, 30);
    // The kernel's own selection: two source, one impostor. A snapshot that dropped the scale reads
    // one source and two impostors, so both regions mismatch.
    expect(scene.validation.verdict).toBe("ok");
    expect(scene.validation.mismatched).toBe(0);
    expect(scene.validation.matricesMismatched).toBe(0);
    expect(lines).toContain(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=3 instancesGpu=3 instancesCpu=3 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
  });

  it("says a readback that never landed failed, instead of leaving the last verdict standing", async () => {
    const lines: string[] = [];
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: (): Promise<ArrayBuffer> => Promise.reject(new Error("mapAsync: device lost")),
    } as unknown as IRendererLike;
    const scene = new WorldGpuScene();
    scene.enable(renderer, true, true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    await drive(scene, renderer, 30);
    expect(scene.validation.verdict).toBe("error");
    expect(lines).toContain(
      "TN_WORLD_GPU_SCENE_VALIDATE error compared=0 instancesGpu=0 instancesCpu=0 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(lines).toContain(
      "TN_WORLD_GPU_SCENE_VALIDATE cause=readback-failed: mapAsync: device lost",
    );

    // And the mode keeps checking: a failed readback does not leave the flag set and silence it.
    lines.length = 0;
    await drive(scene, renderer, 30);
    expect(lines.some((line) => line.includes("readback-failed"))).toBe(true);
  });

  it("names the snapshot's own camera and nearest placement when a comparison held no instances", async () => {
    // The zero/zero line the static map views printed: both counts at zero, and nothing on it to say
    // whether the snapshot held no live source or held one the camera, sphere, range or frustum
    // rejected. The probe is taken from the snapshot, so it names the camera and the nearest live
    // placement the dispatch actually read.
    const lines: string[] = [];
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    const mirror = (attribute: unknown): Promise<ArrayBuffer> => {
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    // Behind the camera, so the reference and the readback both select nothing.
    scene.place(0, new Matrix4().makeTranslation(0, 0, -40), 0, 0, -40, 0.5);

    await drive(scene, renderer, 30);
    const line = lines.find((one) => one.startsWith("TN_WORLD_GPU_SCENE_VALIDATE ")) ?? "";
    expect(line).toContain("instancesGpu=0 instancesCpu=0");
    expect(line).toContain("eye=[0.000,0.000,0.000]");
    expect(line).toContain("snapshot=1 live=1");
    expect(line).toContain("nearSphere=[0.000,0.000,-40.000]");
    expect(line).toContain("nearRoot=[0.000,0.000,-40.000]");
    expect(line).toContain("nearSlot=0");
    expect(line).toContain("nearCull=100.000");
    expect(line).toContain("nearXZ=40.000");
    // Rejected by the near plane, which is what the negative margin says.
    expect(line).toContain("nearMargin=-");

    // And a comparison that did hold instances carries no probe: the fields exist only to explain a
    // zero/zero, and a nonzero line's counts are their own answer.
    lines.length = 0;
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);
    await drive(scene, renderer, 30);
    const passing = lines.find((one) => one.startsWith("TN_WORLD_GPU_SCENE_VALIDATE ")) ?? "";
    expect(passing).toContain("instancesGpu=1 instancesCpu=1");
    expect(passing).not.toContain("eye=");
    expect(passing).not.toContain("nearXZ=");
    scene.dispose();
  });

  it("reports the device memory tally and the scene footprint on the validation line", async () => {
    // The memory this seam has to expose: a backend whose Three renderer tracks `info.memory` gets
    // those fields, plus the scene's own footprint, so a readback that accumulates staging buffers
    // is visible as `readbackBuffersSize` growing rather than only as a later OOM.
    const lines: string[] = [];
    const { camera, planes } = cameraAt(0, 0);
    const scene = new WorldGpuScene();
    const mirror = (attribute: unknown): Promise<ArrayBuffer> => {
      const result = cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: scene.placements.length,
        placements: scene.placements,
        regionCount: scene.regions.length,
        regions: scene.regions,
        slots: scene.gates(),
      });
      const words = (attribute as { array: Uint32Array | Float32Array }).array;
      const bytes = words instanceof Float32Array ? result.drawn : result.args;
      return Promise.resolve(bytes.slice().buffer as ArrayBuffer);
    };
    const renderer = {
      compute: (): void => {},
      kind: "webgpu",
      log: (line: string): void => {
        lines.push(line);
      },
      raw: {
        backend: { hasFeature: (): boolean => true },
        info: {
          memory: {
            indirectStorageAttributes: 2,
            indirectStorageAttributesSize: 128,
            readbackBuffers: 2,
            readbackBuffersSize: 640,
            storageAttributes: 5,
            storageAttributesSize: 700,
            total: 4096,
          },
        },
      },
      readback: mirror,
    } as unknown as IRendererLike;
    expect(scene.enable(renderer, true, true)).toBe(true);
    scene.key("pine:0:0", LOCAL, 4, { group: "pine:0", part: 0, parts: 1 });
    scene.slot("pine", { cull: 100, distances: DISTANCES, levels: [{ firstKey: 0, parts: 1 }] });
    scene.place(0, new Matrix4().makeTranslation(0, 0, 8), 0, 0, 8, 0.5);

    await drive(scene, renderer, 30);
    const line = lines.find((one) => one.startsWith("TN_WORLD_GPU_SCENE_VALIDATE ")) ?? "";
    expect(line).toContain("storageAttributes=5 storageAttributesSize=700");
    expect(line).toContain("indirectStorageAttributes=2 indirectStorageAttributesSize=128");
    expect(line).toContain("readbackBuffers=2 readbackBuffersSize=640");
    expect(line).toContain("total=4096");
    const footprint = Object.values(scene.footprint()).reduce(
      (sum, buffer) => sum + buffer.bytes,
      0,
    );
    expect(footprint).toBeGreaterThan(0);
    expect(line).toContain(`footprintBytes=${String(footprint)}`);
    scene.dispose();
  });

  /**
   * The drawn matrices, held against the dispatch that compacted them, with one thing wrong at a
   * time.
   *
   * A real WebGPU walk printed `mismatched=0` over 200 keys and drew no forest: every count landed
   * and the picture did not, because a count says how many instances a region holds and nothing
   * about where they are or whether the record naming them is a draw at all. So the readback now
   * answers for the matrix buffer as well, and each fault below is a picture that a count cannot
   * name: a run one slot out, a run that was never written, and a record whose `firstInstance` reads
   * from somewhere other than the region the kernel filled.
   */
  it("holds each key's drawn matrices and its record against the reference", async () => {
    /**
     * A scene of three keys and a readback that answers with what a correct kernel wrote, `fault`
     * breaking exactly one thing in the bytes it returns.
     */
    async function checked(
      fault: (args: Uint32Array, drawn: Float32Array, scene: WorldGpuScene) => void,
    ): Promise<{ lines: string[]; scene: WorldGpuScene }> {
      const lines: string[] = [];
      const { camera, planes } = cameraAt(0, 0);
      const scene = new WorldGpuScene();
      const renderer = {
        compute: (): void => {},
        kind: "webgpu",
        log: (line: string): void => {
          lines.push(line);
        },
        raw: { backend: { hasFeature: (): boolean => true } },
        readback: (attribute: unknown): Promise<ArrayBuffer> => {
          const result = cullAndSelect({
            camera: { planes, x: 0, y: 0, z: 0 },
            count: scene.placements.length,
            placements: scene.placements,
            regionCount: scene.regions.length,
            regions: scene.regions,
            slots: scene.gates(),
          });
          const words = (attribute as { array: Uint32Array | Float32Array }).array;
          const args = Uint32Array.from(result.args);
          const drawn = Float32Array.from(result.drawn);
          // What a correct record carries: the CPU's own `indexCount` and `firstInstance`, which the
          // kernel only ever adds the count to.
          for (const region of scene.regions) {
            args[region.argsIndex * 5] = region.indexCount;
            args[region.argsIndex * 5 + 4] = region.start;
          }
          fault(args, drawn, scene);
          return Promise.resolve((words instanceof Float32Array ? drawn : args).buffer);
        },
      } as unknown as IRendererLike;
      expect(scene.enable(renderer, true, true)).toBe(true);
      // Three keys, each with a run of two of its own, so a run one slot out is one run out rather
      // than one whole instance out, and a fault in one key is a fault in one line.
      for (const [index, name] of ["pine:0:0", "rock:0:0", "fern:0:0"].entries()) {
        const group = name.replace(":0:0", ":0");
        scene.key(name, LOCAL, 4, { group, part: 0, parts: 1 });
        scene.slot(group, { cull: 1000, distances: [0], levels: [{ firstKey: index, parts: 1 }] });
        for (let taken = 0; taken < 2; taken += 1) {
          const z = 8 + index * 4 + taken;
          scene.place(index, new Matrix4().makeTranslation(0, 0, z), 0, 0, z, 0.5);
        }
        // What the owner records when it dresses the mesh: the shape this key draws.
        scene.indexCount(name, 96);
      }
      lines.length = 0;
      await drive(scene, renderer, 30);
      return { lines, scene };
    }

    /** The report line, and the detail lines under it. */
    function report(lines: string[]): { head: string; detail: string[] } {
      const head = lines.find((line) => line.includes(" compared=")) ?? "";
      return {
        detail: lines.filter(
          (line) => line.startsWith("TN_WORLD_GPU_SCENE_VALIDATE ") && !line.includes(" compared="),
        ),
        head,
      };
    }

    // A correct kernel: the counts, the matrices and the record all agree, so it is an `ok` and it
    // names no key.
    const correct = await checked(() => {});
    expect(correct.scene.validation.verdict).toBe("ok");
    expect(report(correct.lines).head).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE ok compared=3 instancesGpu=6 instancesCpu=6 mismatched=0 matricesMismatched=0 meshMismatched=0",
    );
    expect(report(correct.lines).detail).toEqual([]);

    // A run one slot out: every count still lands, and the first instance is somewhere else.
    const shifted = await checked((args, drawn, scene) => {
      const region = scene.regionOf("rock:0:0") as IRegion;
      // The run the draw reads is one slot late: the second instance is where the first was.
      drawn.copyWithin(region.start * 16, (region.start + 1) * 16, (region.start + 2) * 16);
      expect(args[region.argsIndex * 5 + 4]).toBe(region.start);
      expect(args[region.argsIndex * 5 + 1]).toBe(2);
    });
    expect(shifted.scene.validation.verdict).toBe("mismatch");
    expect(shifted.scene.validation.mismatched).toBe(0);
    expect(report(shifted.lines).head).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE mismatch compared=3 instancesGpu=6 instancesCpu=6 mismatched=0 matricesMismatched=1 meshMismatched=0",
    );
    expect(report(shifted.lines).detail[0]).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE rock:0:0 first gpu=[0.000,0.000,13.000] cpu=[0.000,0.000,12.000] firstInstance gpu=4 expected=4 indexCount gpu=96 expected=96",
    );

    // A run that was never written: the slot holds the zeros a fresh buffer is made of, which is
    // what a dispatch the device refused leaves behind.
    const zeroed = await checked((args, drawn, scene) => {
      const region = scene.regionOf("fern:0:0") as IRegion;
      drawn.fill(0, region.start * 16, (region.start + 1) * 16);
      expect(args[region.argsIndex * 5 + 1]).toBe(2);
    });
    expect(zeroed.scene.validation.verdict).toBe("mismatch");
    expect(zeroed.scene.validation.mismatched).toBe(0);
    expect(zeroed.scene.validation.matricesMismatched).toBe(1);
    expect(report(zeroed.lines).detail[0]).toContain(
      "fern:0:0 first gpu=[0.000,0.000,0.000] cpu=[0.000,0.000,16.000]",
    );

    // And a record that names no triangle: every instance is where the reference put it and the
    // draw submits nothing, which is a submitted draw that is not a draw.
    const empty = await checked((args, _drawn, scene) => {
      const region = scene.regionOf("pine:0:0") as IRegion;
      args[region.argsIndex * 5] = 0;
    });
    expect(empty.scene.validation.verdict).toBe("mismatch");
    expect(empty.scene.validation.mismatched).toBe(0);
    expect(report(empty.lines).detail[0]).toBe(
      "TN_WORLD_GPU_SCENE_VALIDATE pine:0:0 first gpu=[0.000,0.000,8.000] cpu=[0.000,0.000,8.000] firstInstance gpu=0 expected=0 indexCount gpu=0 expected=96",
    );
    // Every key the check could name is named at most five times, however many disagree.
    expect(report(empty.lines).detail.length).toBeLessThanOrEqual(5);

    // A record whose `firstInstance` reads from another region's run, which is what a stale record
    // left by a re-layout draws.
    const stale = await checked((args, _drawn, scene) => {
      const region = scene.regionOf("rock:0:0") as IRegion;
      args[region.argsIndex * 5 + 4] = region.start + 2;
    });
    expect(stale.scene.validation.verdict).toBe("mismatch");
    expect(report(stale.lines).detail[0]).toContain(
      "rock:0:0 first gpu=[0.000,0.000,0.000] cpu=[0.000,0.000,12.000] firstInstance gpu=6 expected=4",
    );
  });
});

/**
 * The gate table against the owner's own `distances`, which is the question a browser walk cannot
 * answer from the inside: the kernel and `cullAndSelect` read the same table, so a table written
 * before the model's chain widened its levels makes both agree with each other while both are wrong.
 */
describe("WorldGpuScene gate tables against the owner's own distances", () => {
  /** One pine, one part per level, the six placements `placed` files at 12, 24 … 72 m. */
  function pine(): WorldGpuScene {
    return wired([{ name: "pine", levels: [0] }], 1, 64);
  }

  /** The keys the prewarm mints for a chain's two extra levels. */
  function widen(scene: WorldGpuScene, cull?: number): void {
    for (const level of [1, 2])
      scene.key(`pine:${String(level)}:0`, LOCAL, 64, {
        group: `pine:${String(level)}`,
        part: 0,
        parts: 1,
      });
    scene.slot("pine", {
      cull,
      distances: [0, 20, 60],
      levels: [0, 1, 2].map(
        (level) => scene.levelKeys(`pine:${String(level)}`) ?? { firstKey: 0, parts: 0 },
      ),
    });
  }

  /** What the dispatch that is running now would draw per key, over the table it reads. */
  function run(scene: WorldGpuScene): ReturnType<typeof cullAndSelect> {
    return cullAndSelect({
      camera: { planes: cameraAt(0, 0).planes, x: 0, y: 0, z: 0 },
      count: scene.placements.length,
      placements: scene.placements,
      regionCount: scene.regions.length,
      regions: scene.regions,
      slots: scene.gates(),
    });
  }

  it("re-registers an asset whose gates widen after its first placement, and its cull with it", () => {
    const scene = pine();
    placed(scene, 0, 6, 12);
    // The fault, before the chain arrives: the table says one level, so every placement draws at it.
    expect(scene.gates()[0]?.distances).toEqual([0]);
    expect(run(scene).counts[keyOf(scene, "pine:0:0")]).toBe(6);

    // The order a real adoption takes — the keys for the chain's levels are minted, and the asset's
    // own `distances` are what the slot is re-registered with.
    widen(scene);
    expect(scene.gates()[0]?.distances).toEqual([0, 20, 60]);
    expect(scene.footprint().levels?.count).toBeGreaterThanOrEqual(3);
    const after = run(scene);
    // 12 m; 24, 36, 48 and 60 m, which the second switch takes at 60 exclusive; and 72 m.
    expect(after.counts[keyOf(scene, "pine:0:0")]).toBe(1);
    expect(after.counts[keyOf(scene, "pine:1:0")]).toBe(4);
    expect(after.counts[keyOf(scene, "pine:2:0")]).toBe(1);

    // And `maxDistance` on its own, which the cull gate is read from: a distance is the only thing
    // that changes, and everything past it draws nowhere.
    widen(scene, 40);
    expect(scene.gates()[0]?.cull).toBe(40);
    const culled = run(scene);
    expect(culled.counts[keyOf(scene, "pine:1:0")]).toBe(2);
    expect(culled.counts[keyOf(scene, "pine:2:0")]).toBe(0);
    scene.dispose();
  });

  it("answers a stale table at the level the owner's distances name, which is what it is for", () => {
    // The needles sit three metres up the trunk, so a level that did not take the part's own offset
    // is caught by a number rather than by a count.
    const needles = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
    // A table left holding the pre-widening distances, and the owner's live ones beside it.
    const scene = pine();
    placed(scene, 0, 6, 12);
    for (const level of [1, 2])
      scene.key(`pine:${String(level)}:0`, LOCAL, 64, {
        group: `pine:${String(level)}`,
        part: 0,
        parts: 1,
      });
    const live: ILiveAsset = {
      cull: undefined,
      distances: [0, 20, 60],
      id: "pine",
      locals: [[LOCAL], [needles], [LOCAL]],
    };
    const expected = liveKeyInstances(
      scene.placements,
      (slot: number) => (slot === 0 ? live : undefined),
      { planes: cameraAt(0, 0).planes, x: 0, y: 0, z: 0 },
    );
    expect((expected.get("pine:0:0")?.length ?? 0) / 16).toBe(1);
    expect((expected.get("pine:1:0")?.length ?? 0) / 16).toBe(4);
    expect((expected.get("pine:2:0")?.length ?? 0) / 16).toBe(1);
    // The kernel's own reference, reading the same stale table, puts all six at level 0 — so the two
    // references disagree exactly where a far tree is drawn at its near shape.
    expect(run(scene).counts[keyOf(scene, "pine:0:0")]).toBe(6);
    // And the part's own offset is composed in, as the dispatch composes it.
    expect(expected.get("pine:1:0")?.[13]).toBe(3);
    expect(expected.get("pine:0:0")?.[13]).toBe(0);
    scene.dispose();
  });

  /**
   * A level whose keys are not minted yet is a level the dispatch cannot draw, and the biased
   * selection must not land on one.
   *
   * `WorldCells#gatesOf` names every level of an asset from the moment it is adopted and fills in the
   * keys the prewarm has minted so far, so a chain widens to `parts=2,0,0,0` and holds `2,2,0,0` and
   * `2,2,2,0` while the loading screen is still up — measured on a four-level chain through the
   * world. The CPU path draws `asset.levels[level]` for whatever level the gates name, so it always
   * has a shape there; the kernel selects the level and then loops `at.z` times, which is zero times,
   * and the placement is drawn nowhere. With the bias at 2.5 the far placements are exactly the ones
   * past the last source gate, so a forest 80-300 m out stands in its own shadows.
   */
  it("draws the last source level that has keys when the biased gate names one that has none", () => {
    setLodBias(2.5);
    try {
      const distances = [0, 20, 60];
      const live: ILiveAsset = {
        cull: undefined,
        distances,
        id: "pine",
        locals: [[LOCAL], [LOCAL], [LOCAL]],
      };
      // 100 m is past 60 m itself and 25 m past it once, and a half, are — so both paths name the
      // last source level here, and the CPU path's own answer says which key that is.
      const at = (z: number): Map<string, Float32Array> =>
        liveKeyInstances(
          [placement(0, 0, z, 0)],
          (slot: number) => (slot === 0 ? live : undefined),
          { planes: cameraAt(0, 0).planes, x: 0, y: 0, z: 0 },
        );
      expect(at(100).has("pine:2:0")).toBe(true);

      /** The three levels, with the top one keyed or not, exactly as `#gatesOf` writes them. */
      const chain = (topKeyed: boolean): WorldGpuScene => {
        const scene = pine();
        for (const level of [1, 2]) {
          if (level === 2 && topKeyed === false) break;
          scene.key(`pine:${String(level)}:0`, LOCAL, 64, {
            group: `pine:${String(level)}`,
            part: 0,
            parts: 1,
          });
        }
        scene.slot("pine", {
          cull: undefined,
          distances,
          levels: [0, 1, 2].map(
            (level) => scene.levelKeys(`pine:${String(level)}`) ?? { firstKey: 0, parts: 0 },
          ),
        });
        scene.place(0, new Matrix4().makeTranslation(0, 0, 100), 0, 0, 100, 0.5);
        return scene;
      };

      // Every level keyed: the dispatch answers the CPU path's level, the last source one.
      const keyed = chain(true);
      expect(run(keyed).counts[keyOf(keyed, "pine:2:0")]).toBe(1);
      expect(run(keyed).counts[keyOf(keyed, "pine:1:0")]).toBe(0);
      keyed.dispose();

      // The top level named but not minted: the last level that has keys, so the tree is drawn.
      const unkeyed = chain(false);
      const drawn = run(unkeyed);
      expect(unkeyed.gates()[0]?.levels[2]?.parts).toBe(0);
      expect(drawn.counts[keyOf(unkeyed, "pine:0:0")]).toBe(0);
      expect(drawn.counts[keyOf(unkeyed, "pine:1:0")]).toBe(1);
      // And the placement is drawn at all: the sum is zero while the gates name a level with no key,
      // which is the tree that stands in its own shadow.
      expect([...drawn.counts].reduce((sum, count) => sum + count, 0)).toBe(1);
      unkeyed.dispose();
    } finally {
      setLodBias(1);
    }
  });
});

/**
 * The GPU-selected main-pass tally: what the kernel wrote into the indirect records, not the mesh
 * capacity three reports as `tri=`. The readback rides the same path and staging buffer a validation
 * uses, a frame whose predecessor is still in flight is skipped rather than queued, and nothing is
 * asked for at all when neither the tally nor a validation is on.
 */
describe("WorldGpuScene GPU-selected main-pass tally", () => {
  /** One main key: one indirect record, which is what the readback's bytes stand for. */
  function tallyScene(): WorldGpuScene {
    const scene = new WorldGpuScene();
    scene.key("pine:0:0", LOCAL, 16, { group: "pine:0", part: 0, parts: 1 });
    return scene;
  }

  /** A renderer whose readback answers with whatever the test hands it, and counts every request. */
  function tallyRenderer(
    read: () => ArrayBuffer | Promise<ArrayBuffer>,
    requests: { count: number },
  ): IRendererLike {
    return {
      compute: (): void => {},
      kind: "webgpu",
      log: (): void => {},
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: (): Promise<ArrayBuffer> => {
        requests.count += 1;
        return Promise.resolve(read());
      },
    } as unknown as IRendererLike;
  }

  it("sums instanceCount and instanceCount x indexCount / 3, and ages the sample in dispatches", async () => {
    const scene = tallyScene();
    const requests = { count: 0 };
    // Record: indexCount 36, instanceCount 5, so 5 x 36 / 3 = 60 triangles.
    const renderer = tallyRenderer(
      () => Uint32Array.from([36, 5, 0, 0, 0]).buffer.slice(0),
      requests,
    );
    expect(scene.enable(renderer, true, false, true)).toBe(true);
    const { camera } = cameraAt(0, 0);
    scene.dispatch(renderer, camera);
    await flush();
    const landed = scene.report();
    expect(landed.gpuInstances).toBe(5);
    expect(landed.gpuTriangles).toBe(60);
    expect(landed.gpuTallyAgeFrames).toBe(0);
    expect(requests.count).toBe(1);
    // Five dispatches later the sample is five old, and the thirty-dispatch clock has not fired.
    for (let index = 0; index < 5; index += 1) scene.dispatch(renderer, camera);
    expect(scene.report().gpuTallyAgeFrames).toBe(5);
    expect(requests.count).toBe(1);
    scene.dispose();
  });

  it("adds no GPU work when neither the tally nor a validation is on", async () => {
    const scene = tallyScene();
    const requests = { count: 0 };
    const renderer = tallyRenderer(() => Uint32Array.from([36, 5, 0, 0, 0]).buffer, requests);
    scene.enable(renderer, true, false, false);
    const { camera } = cameraAt(0, 0);
    for (let index = 0; index < 90; index += 1) scene.dispatch(renderer, camera);
    await flush();
    expect(requests.count).toBe(0);
    expect(scene.report().gpuTriangles).toBeUndefined();
    scene.dispose();
  });

  it("skips a readback while the previous one is still in flight", async () => {
    const scene = tallyScene();
    const requests = { count: 0 };
    let settle: ((bytes: ArrayBuffer) => void) | undefined;
    const renderer = tallyRenderer(
      () =>
        new Promise<ArrayBuffer>((resolve) => {
          settle = resolve;
        }),
      requests,
    );
    expect(scene.enable(renderer, true, false, true)).toBe(true);
    const { camera } = cameraAt(0, 0);
    scene.dispatch(renderer, camera);
    expect(requests.count).toBe(1);
    // Sixty more dispatches while the first is in flight: not one queued behind it.
    for (let index = 0; index < 60; index += 1) scene.dispatch(renderer, camera);
    expect(requests.count).toBe(1);
    expect(scene.report().gpuTriangles).toBeUndefined();
    settle?.(Uint32Array.from([36, 5, 0, 0, 0]).buffer);
    await flush();
    expect(scene.report().gpuInstances).toBe(5);
    // The clock is measured from the issued dispatch, so the next request is allowed now.
    scene.dispatch(renderer, camera);
    expect(requests.count).toBe(2);
    scene.dispose();
  });
});

/**
 * The measured occlusion cull: `?tnOcclusion=measure` builds the pyramid from the scene pass's own
 * depth, counts what the test hides, and draws all of it.
 *
 * The counters ride the args buffer's own tail and land with the GPU-selected tally, so the drawn
 * counts and the would-cull share come out of one readback of one frame.
 */
describe("WorldGpuScene measured occlusion cull", () => {
  /** A renderer whose compute calls are counted, so the chain's dispatches are observable. */
  function measureRenderer(
    bytes: () => ArrayBuffer,
    depth: { width: number; height: number } | undefined,
    computes: { count: number },
  ): IRendererLike {
    const texture = { image: depth } as DepthTexture;
    return {
      compute: (node: unknown): void => {
        computes.count += Array.isArray(node) ? node.length : 1;
      },
      kind: "webgpu",
      log: (): void => {},
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: (): Promise<ArrayBuffer> => Promise.resolve(bytes()),
      scenePassDepth: () =>
        depth === undefined
          ? undefined
          : {
              height: depth.height,
              texture,
              width: depth.width,
            },
    } as unknown as IRendererLike;
  }

  /** One main key: a 5-word record and, past it, the one word the occlusion tail holds. */
  function scene(): WorldGpuScene {
    const own = new WorldGpuScene();
    own.key("pine:0:0", LOCAL, 16, { group: "pine:0", part: 0, parts: 1 });
    return own;
  }

  it("counts the hidden instances out of the same readback that counts the drawn ones", async () => {
    const world = scene();
    const computes = { count: 0 };
    // Record: indexCount 36, instanceCount 5, so 60 drawn triangles; tail: 3 hidden parts, so 36.
    const renderer = measureRenderer(
      () => Uint32Array.from([36, 5, 0, 0, 0, 3]).buffer,
      { width: 1280, height: 720 },
      computes,
    );
    expect(world.enable(renderer, true, false, false, "measure")).toBe(true);
    const { camera } = cameraAt(0, 0);
    world.dispatch(renderer, camera as PerspectiveCamera);
    world.dispatch(renderer, camera as PerspectiveCamera);
    await flush();
    const report = world.report().occlusion;
    // Ceil each halving so the 640 -> 320 -> ... -> 5 -> 3 -> 2 -> 1 chain loses no edge.
    expect(report?.levels).toBe(11);
    expect(report?.reason).toBe("");
    expect(report?.instances).toBe(3);
    expect(report?.triangles).toBe(36);
    expect(report?.share).toBeCloseTo(0.6, 6);
    expect(report?.samples).toBe(1);
    // A clear and a cull, plus one dispatch per level of the chain.
    expect(computes.count).toBe(26);
    world.dispose();
  });

  it("skips warmup, cuts and resized depth, but measures a normal walk and turn", async () => {
    const world = scene();
    const depth = { width: 8, height: 8 };
    const renderer = measureRenderer(() => Uint32Array.from([36, 5, 0, 0, 0, 3]).buffer, depth, {
      count: 0,
    });
    const readback = vi.spyOn(renderer, "readback");
    world.enable(renderer, true, false, false, "measure");
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion?.samples).toBe(0);
    expect(readback).not.toHaveBeenCalled();
    camera.position.x = 0.1;
    camera.rotation.y = 0.01;
    camera.updateMatrixWorld();
    world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion?.samples).toBe(1);
    expect(world.report().occlusion?.share).toBeCloseTo(0.6);
    camera.position.x = 10;
    camera.updateMatrixWorld();
    for (let frame = 0; frame < 30; frame += 1) world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion?.samples).toBe(2);
    camera.fov = 60;
    camera.updateProjectionMatrix();
    world.dispatch(renderer, camera);
    expect(world.report().occlusion?.reason).toContain("cut");
    depth.width = 16;
    world.dispatch(renderer, camera);
    expect(world.report().occlusion?.reason).toContain("depth");
    expect(readback).toHaveBeenCalledTimes(2);
    world.dispose();
  });

  it("skips same-size depth replacement, odd resize and depth resource rebuild", async () => {
    const world = scene();
    let depth = new DepthTexture(8, 8);
    const renderer = measureRenderer(
      () => Uint32Array.from([36, 5, 0, 0, 0, 3]).buffer,
      { width: 8, height: 8 },
      { count: 0 },
    );
    renderer.scenePassDepth = () => {
      const { width, height } = depth.image;
      if (width === undefined || height === undefined) {
        throw new Error("depth fixture requires known dimensions");
      }
      return { texture: depth, width, height };
    };
    const readback = vi.spyOn(renderer, "readback");
    world.enable(renderer, true, false, false, "measure");
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    world.dispatch(renderer, camera);
    world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion?.samples).toBe(1);
    // 8 -> 9 expands the half-resolution chain from 4 -> 2 -> 1 to 5 -> 3 -> 2 -> 1.
    depth.image.width = 9;
    world.dispatch(renderer, camera);
    expect(world.report().occlusion?.reason).toContain("depth");
    expect(world.report().occlusion?.levels).toBe(4);
    depth = new DepthTexture(9, 8);
    world.dispatch(renderer, camera);
    expect(world.report().occlusion?.reason).toContain("depth");
    depth.needsUpdate = true;
    world.dispatch(renderer, camera);
    expect(world.report().occlusion?.reason).toContain("depth");
    expect(readback).toHaveBeenCalledTimes(1);
    world.dispose();
  });

  it("decodes delayed counts with their dispatch's region layout", async () => {
    const world = scene();
    const renderer = measureRenderer(
      () => new ArrayBuffer(0),
      { width: 8, height: 8 },
      { count: 0 },
    );
    let land: ((bytes: ArrayBuffer) => void) | undefined;
    renderer.readback = () =>
      new Promise((resolve) => {
        land = resolve;
      });
    world.enable(renderer, true, false, false, "measure");
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    world.dispatch(renderer, camera);
    world.dispatch(renderer, camera);
    world.key("oak:0:0", LOCAL, 16, { group: "oak:0", part: 0, parts: 1 });
    land?.(Uint32Array.from([36, 5, 0, 0, 0, 3]).buffer);
    await flush();
    expect(world.report().gpuTriangles).toBe(60);
    expect(world.report().occlusion?.triangles).toBe(36);
    expect(world.report().occlusion?.share).toBeCloseTo(0.6);
    expect(world.report().occlusion?.samples).toBe(1);
    world.dispose();
  });

  it("keeps a genuine zero sample and its paired denominator when a later readback is invalid", async () => {
    const world = scene();
    let bytes = Uint32Array.from([36, 5, 0, 0, 0, 0]).buffer;
    const renderer = measureRenderer(() => bytes, { width: 8, height: 8 }, { count: 0 });
    world.enable(renderer, true, false, false, "measure");
    const camera = new PerspectiveCamera();
    camera.updateMatrixWorld();
    world.dispatch(renderer, camera);
    world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion).toMatchObject({
      samples: 1,
      reason: "",
      share: 0,
      gpuTriangles: 60,
    });
    bytes = Uint32Array.from([36, 1, 0, 0, 0, 2]).buffer;
    for (let frame = 0; frame < 30; frame += 1) world.dispatch(renderer, camera);
    await flush();
    expect(world.report().occlusion).toMatchObject({ samples: 1, share: 0, gpuTriangles: 60 });
    expect(world.report().occlusion?.reason).toContain("readback");
    world.dispose();
  });

  it("flags inconsistent or short readbacks instead of publishing a share over one", async () => {
    for (const bytes of [Uint32Array.from([36, 5, 0, 0, 0, 6]).buffer, new ArrayBuffer(20)]) {
      const world = scene();
      const renderer = measureRenderer(() => bytes, { width: 8, height: 8 }, { count: 0 });
      world.enable(renderer, true, false, false, "measure");
      const camera = new PerspectiveCamera();
      camera.updateMatrixWorld();
      world.dispatch(renderer, camera);
      world.dispatch(renderer, camera);
      await flush();
      expect(world.report().occlusion?.samples).toBe(0);
      expect(world.report().occlusion?.reason).toContain("readback");
      expect(world.report().occlusion?.share).toBeLessThanOrEqual(1);
      world.dispose();
    }
  });

  it("refuses with a reason when no render chain installed a depth to test against", () => {
    const world = scene();
    const renderer = measureRenderer(() => new ArrayBuffer(0), undefined, { count: 0 });
    expect(world.enable(renderer, true, false, false, "measure")).toBe(true);
    const { camera } = cameraAt(0, 0);
    world.dispatch(renderer, camera as PerspectiveCamera);
    const report = world.report().occlusion;
    expect(report?.reason).toBe("refused: no scene depth");
    expect(report?.levels).toBe(0);
    world.dispose();
  });

  it("runs no test and no pyramid when the mode is off", () => {
    const world = scene();
    const computes = { count: 0 };
    const renderer = measureRenderer(
      () => new ArrayBuffer(0),
      { width: 1280, height: 720 },
      computes,
    );
    expect(world.enable(renderer, true, false, false, "off")).toBe(true);
    const { camera } = cameraAt(0, 0);
    world.dispatch(renderer, camera as PerspectiveCamera);
    // A clear and a cull, and nothing else: no chain, no test.
    expect(computes.count).toBe(2);
    expect(world.report().occlusion).toBeUndefined();
    world.dispose();
  });
});

/**
 * The adaptive LOD bias: the main pass over its share of the frame raises the one multiplier both
 * selection paths scale camera distance by, and decays it once the pass is comfortable again.
 */
describe("WorldCells adaptive LOD bias", () => {
  afterEach(() => {
    setLodBias(1);
  });

  function lodRenderer(main: () => number | undefined): IRendererLike {
    return {
      compute: (): void => {},
      gpuMainMs: main,
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
  }

  async function loadWorldAt(
    clock: () => number,
    options: Record<string, unknown> = {},
  ): Promise<WorldCells> {
    stubManifestFetch();
    return WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      admissionNow: clock,
      budgets,
      follow: { position: { ...cellCentre(0, 1), y: 0 } as { x: number; z: number } },
      gpuScene: true,
      loadModel: async () => plainModel(),
      prefetchSeconds: 0,
      ring: 1,
      surface,
      url: "/world/world.json",
      ...options,
    } as Parameters<typeof WorldCells.load>[0]);
  }

  it("raises the bias in bounded steps while the main pass is over its share, and coarsens both paths", async () => {
    let clock = 0;
    const world = await loadWorldAt(() => clock);
    const renderer = lodRenderer(() => 20);
    const camera = playerCamera();
    let previous = lodBias();
    let largestStep = 1;
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
      const current = lodBias();
      if (current !== previous) largestStep = Math.max(largestStep, current / previous);
      previous = current;
    }
    expect(lodBias()).toBeCloseTo(2.5, 6);
    expect(largestStep).toBeLessThanOrEqual(1.08 + 1e-9);

    // Both paths cross the same switch: a placement 10 m out is at level 1 under the raised bias and
    // level 0 under an authored one, through the shared multiplier `cullAndSelect` reads.
    const { planes } = cameraAt(0, 0);
    const regions: IRegion[] = [0, 1].map((index) => ({
      argsIndex: index,
      capacity: 4,
      indexCount: 0,
      local: LOCAL,
      start: index * 4,
    }));
    const select = (): Uint32Array =>
      cullAndSelect({
        camera: { planes, x: 0, y: 0, z: 0 },
        count: 1,
        placements: [placement(0, 0, 10, 0)],
        regionCount: 2,
        regions,
        slots: [
          {
            cull: undefined,
            distances: [0, 15],
            levels: [
              { firstKey: 0, parts: 1 },
              { firstKey: 1, parts: 1 },
            ],
          },
        ],
      }).counts;
    expect(select()[1]).toBe(1);
    setLodBias(1);
    expect(select()[0]).toBe(1);
    world.dispose();
  });

  it("budgets the main pass against the game's target frame, not the frame it just measured", async () => {
    // A 120 fps target is an 8.33 ms frame, so the main pass may take 4.17 ms. A fast frame used to
    // shrink that share: at 400 fps a 3 ms pass read as over budget and coarsened the whole world on
    // a GPU with room to spare (Machinefall: bias 2.5 on a 2.9 ms main pass, PRD-478).
    let clock = 0;
    let gpuMain = 3;
    const world = await loadWorldAt(() => clock);
    const renderer = {
      ...lodRenderer(() => gpuMain),
      targetFps: (): number => 120,
    } as unknown as IRendererLike;
    const camera = playerCamera();
    for (let frame = 0; frame < 3200; frame += 1) {
      clock += 2.5;
      world.update(renderer, camera);
    }
    expect(lodBias(), "a pass inside the target's share coarsened the world").toBe(1);

    // And the target is what sets it: at 60 fps frames a 5 ms pass is over a 120 fps target's share.
    gpuMain = 5;
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
    }
    expect(lodBias(), "a pass over the target's share kept the authored selection").toBeGreaterThan(
      1,
    );
    world.dispose();
  });

  it("decays back toward 1 once the main pass is comfortably under budget", async () => {
    let clock = 0;
    let gpuMain: number | undefined = 20;
    const world = await loadWorldAt(() => clock);
    const renderer = lodRenderer(() => gpuMain);
    const camera = playerCamera();
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
    }
    expect(lodBias()).toBeCloseTo(2.5, 6);
    gpuMain = 0;
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
    }
    expect(lodBias()).toBe(1);
    world.dispose();
  });

  it("holds the bias through the load and rises once the main pass draws the world", async () => {
    // A load's GPU time is shader compiles, buffer uploads and the prewarm, which a coarser selection
    // cannot reduce: the bias bought there is paid for at the first playable frame, where every tree
    // selects the level authored for its distance times that bias while the unbiased casters still
    // draw their shadows — a band of shadows with no trees. So the rise waits for the measurement that
    // says the world is being drawn, and the fixed warmup seconds are gone with it.
    let clock = 0;
    // The GPU's own main-pass tally, stubbed the way `WorldGpuScene` reads it: index count, instance
    // count. Zero instances is what an indirect world reports before its first draw.
    let instances = 0;
    const world = await loadWorldAt(() => clock, { gpuSceneTally: true });
    const renderer = {
      compute: (): void => {},
      gpuMainMs: (): number => 40,
      kind: "webgpu",
      log: (): void => {},
      raw: { backend: { hasFeature: (): boolean => true } },
      readback: (): Promise<ArrayBuffer> =>
        Promise.resolve(Uint32Array.from([36, instances, 0, 0, 0]).buffer.slice(0)),
    } as unknown as IRendererLike;
    const camera = playerCamera();

    // Loading: 3.2 s of a main pass four times over budget, with the prewarm holding batches the
    // gate is still waiting on. Nothing projects the world, which is why no batch has drawn.
    for (let frame = 0; frame < 200; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
      await flush(2);
    }
    expect(world.stats().prewarmMinted, "the fixture prewarmed a batch").toBeGreaterThan(0);
    expect(world.stats().pendingPrewarm, "the prewarm is still owed a draw").toBeGreaterThan(0);
    expect(lodBias(), "the bias rose during the load").toBe(1);

    // Playing: in a scene, so the gate's draws can come, the prewarm settles and the main pass reports
    // triangles. The same reading now buys a coarser world.
    new Group().add(world);
    instances = 5;
    for (let frame = 0; frame < 200 && lodBias() === 1; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
      await flush(2);
    }
    expect(world.stats().pendingPrewarm, "the settled gate is owed nothing").toBe(0);
    expect(world.gpuSceneTally()?.triangles, "the main pass reported triangles").toBeGreaterThan(0);
    expect(lodBias(), "the bias never rose on a drawn world").toBeGreaterThan(1);
    world.dispose();
  });

  it("pins the bias at 1 when disabled or unmeasured", async () => {
    // Disabled: an over-budget reading changes nothing, byte-identical to the authored selection.
    let clock = 0;
    const off = await loadWorldAt(() => clock, { adaptiveLod: false });
    const hot = lodRenderer(() => 100);
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      off.update(hot, playerCamera());
    }
    expect(lodBias()).toBe(1);
    off.dispose();

    // Enabled but no sample: absent means no adaptation, never a rise on nothing.
    setLodBias(1);
    clock = 0;
    const blind = await loadWorldAt(() => clock);
    const silent = {
      compute: (): void => {},
      kind: "webgpu",
      raw: { backend: { hasFeature: (): boolean => true } },
    } as unknown as IRendererLike;
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      blind.update(silent, playerCamera());
    }
    expect(lodBias()).toBe(1);
    blind.dispose();
  });

  it("holds the bias on a window with no fresh GPU sample", async () => {
    let clock = 0;
    let gpuMain: number | undefined = 20;
    const world = await loadWorldAt(() => clock);
    const renderer = lodRenderer(() => gpuMain);
    const camera = playerCamera();
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
    }
    const held = lodBias();
    expect(held).toBeCloseTo(2.5, 6);
    gpuMain = undefined;
    for (let frame = 0; frame < 800; frame += 1) {
      clock += 16;
      world.update(renderer, camera);
    }
    expect(lodBias()).toBe(held);
    world.dispose();
  });
});

/**
 * The placement-scale-correct impostor switch: every authored gate stays a world-metre distance
 * compared directly, and only a whole-asset impostor's terminal gate — stored as the base sphere's
 * projected distance at scale 1 — is scaled by the placement's own magnitude. The same rule is read
 * by the CPU build (`WorldCells.#addPlacements`), the reference kernels and the TSL dispatch.
 */
describe("levelAtGates impostor terminal scale", () => {
  const slot = { distances: [0, 60, 200], impostor: true };

  it("scales only the impostor terminal by the placement's magnitude, so screen size is constant", () => {
    // Authored gates compare directly whatever the scale: 100 is past 60 and before 200 at any scale.
    expect(levelAtGates({ distances: [0, 60, 200], impostor: false }, 100, 8)).toBe(1);
    // The terminal is base 200 at scale 1, so its switch distance is 200 * |scale|: same projected
    // size for a placement scaled a half, once, or eight times.
    expect(levelAtGates(slot, 99, 0.5)).toBe(1);
    expect(levelAtGates(slot, 101, 0.5)).toBe(2);
    expect(levelAtGates(slot, 199, 1)).toBe(1);
    expect(levelAtGates(slot, 201, 1)).toBe(2);
    expect(levelAtGates(slot, 1599, 8)).toBe(1);
    expect(levelAtGates(slot, 1601, 8)).toBe(2);
  });

  it("reads a mirrored (negative) placement scale as its magnitude", () => {
    expect(levelAtGates(slot, 101, -0.5)).toBe(2);
    expect(levelAtGates(slot, 199, -1)).toBe(1);
    expect(levelAtGates(slot, 1601, -8)).toBe(2);
  });

  it("never selects the terminal before the last source gate, however small the projected base", () => {
    // The projected base 5 at scale 8 is 40, inside the 60 m last source gate: the unscaled source
    // floor holds the terminal back until the last source level has ended, rather than scaling the
    // floor away with the base.
    const tiny = { distances: [0, 30, 60, 5], impostor: true };
    expect(levelAtGates(tiny, 59.9, 8)).toBe(1);
    // At its own gate the last source level is not yet past it (every gate is exclusive)...
    expect(levelAtGates(tiny, 60, 8)).toBe(1);
    // ...and just past it the last source level still draws: the terminal floor is strictly later,
    // not the same distance, so the source level is not starved by the later terminal gate.
    expect(levelAtGates(tiny, 60.000005, 8)).toBe(2);
    expect(levelAtGates(tiny, 60.00002, 8)).toBe(3);
  });

  it("selects the terminal through the live reference at each scale, positive and mirrored", () => {
    setLodBias(1);
    const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const live: ILiveAsset = {
      cull: undefined,
      distances: [0, 60, 200],
      id: "imp",
      impostor: true,
      locals: [[identity], [identity], [identity]],
    };
    const planes = cameraAt(0, 0).planes;
    const at = (z: number, scale: number): Map<string, Float32Array> =>
      liveKeyInstances(
        [{ centre: new Float32Array([0, 0, z, 0.5]), matrix: identity, scale, slot: 0 }],
        (index) => (index === 0 ? live : undefined),
        { planes, x: 0, y: 0, z: 0 },
      );
    // Below the 60 m source floor every scale still draws the near level.
    expect(at(50, 0.5).has("imp:0:0")).toBe(true);
    expect(at(50, 8).has("imp:0:0")).toBe(true);
    // Past the scaled terminal switch it draws the impostor, mirrored exactly like positive.
    expect(at(150, 0.5).has("imp:2:0")).toBe(true);
    expect(at(400, 1).has("imp:2:0")).toBe(true);
    expect(at(3200, 8).has("imp:2:0")).toBe(true);
    expect(at(150, -0.5).has("imp:2:0")).toBe(true);
  });
});

/**
 * A shadow level's own selection, PRD-478 phase 2.
 *
 * The map is not the camera: its frustum is the light's window, its gate is the texel size it can
 * resolve, and its base is the chain level the cluster path hands it. Its LOD is the main pass's,
 * from the eye, because a placement casts from the key the main pass draws it in. A selection that
 * took the main camera's frustum instead would drop the shadow the player is standing in.
 */

/** Six planes of a top-down `size` box over the origin, which is what a level's light frustum is. */
function levelPlanes(size: number, near = 1, far = 400): Float32Array {
  const planes = new Float32Array(24);
  const set = (index: number, x: number, y: number, z: number, d: number): void => {
    planes[index * 4] = x;
    planes[index * 4 + 1] = y;
    planes[index * 4 + 2] = z;
    planes[index * 4 + 3] = d;
  };
  set(0, 1, 0, 0, size);
  set(1, -1, 0, 0, size);
  set(2, 0, 0, 1, size);
  set(3, 0, 0, -1, size);
  set(4, 0, 1, 0, near);
  set(5, 0, -1, 0, far);
  return planes;
}

/** One asset with the committed fixture's three levels, one part each, one region per level. */
function shadowFixture(): { input: IKernelInput; placements: IGpuPlacement[] } {
  const slots = [
    {
      cull: undefined,
      distances: DISTANCES,
      levels: [
        { firstKey: 0, parts: 1 },
        { firstKey: 1, parts: 1 },
        { firstKey: 2, parts: 1 },
      ],
    },
  ];
  const levels = slots[0]?.levels ?? [];
  const regions: IRegion[] = levels.map((_, index) => ({
    argsIndex: index,
    capacity: 8,
    indexCount: 3,
    local: LOCAL,
    name: `k${String(index)}`,
    start: index * 8,
  }));
  // Four placements: one the main camera alone sees, one the map alone sees, one the map drops for
  // its gate, and one it keeps.
  const placements = [
    placement(0, 0, 0, 0, 0.5),
    placement(0, 0, -100, 0, 0.5),
    placement(0, 0, -50, 0, 0.2),
    placement(0, 0, -60, 0, 0.5),
  ];
  // The main camera stands 40 m back along +Z, so it sees the placement at the origin — 40 m ahead,
  // which is the first gate, so it is the near level — and nothing at all behind it.
  const { camera, planes } = cameraAt(0, -40);
  return {
    input: {
      camera: { planes, x: camera.position.x, y: 0, z: camera.position.z },
      count: placements.length,
      placements,
      regionCount: regions.length,
      regions,
      slots,
    },
    placements,
  };
}

/** Which placements reached which key, read back out of the reference's drawn matrices. */
function drawnPlacements(
  result: ReturnType<typeof cullAndSelect>,
  input: IKernelInput,
): Map<number, number[]> {
  return kernelDrawn(result, input);
}

describe("a shadow level's own selection", () => {
  it("takes its planes and its gate, and never the main camera's", () => {
    const { input } = shadowFixture();
    // The map is a 200 m box over the origin; the placement at the origin is inside it and the main
    // camera at 500 m back is not inside it.
    const level = {
      base: 0,
      gate: 1,
      planes: levelPlanes(100),
    };
    const shadow = cullAndSelectShadow(input, level);
    const byKey = drawnPlacements(shadow, input);
    const main = drawnPlacements(cullAndSelect(input), input);

    // The main camera's own selection: the one placement it sees, and nothing behind it.
    expect([...(main.get(0) ?? [])]).toEqual([0]);
    expect([...(main.get(1) ?? [])]).toEqual([]);
    expect([...(main.get(2) ?? [])]).toEqual([]);
    // The map's: the placement at the origin, which the camera sees, and the two behind the camera,
    // which the camera cannot see at all. Their levels are the main pass's, from the eye at
    // z = -40: 3 is 20 m away (level 0) and 1 is 60 m away, past the 40 m gate (level 1).
    expect([...(byKey.get(0) ?? [])]).toEqual([0, 3]);
    expect([...(byKey.get(1) ?? [])]).toEqual([1]);
    expect([...(byKey.get(2) ?? [])]).toEqual([]);
    // The sub-texel placement inside the map's own frustum, dropped by its own gate: the set above
    // holds placements 0 and 3 and not 2, and with the gate open it holds all three.
    expect([...(byKey.get(0) ?? [])]).not.toContain(2);
    const open = drawnPlacements(cullAndSelectShadow(input, { ...level, gate: 0 }), input);
    expect([...(open.get(0) ?? [])]).toEqual([0, 2, 3]);
  });

  it("draws each placement at the main pass's own level, from the eye, or at the coarsest level that casts", () => {
    const { input } = shadowFixture();
    // The map's window sits 100 m ahead of the eye, where an aerial view's focus is. The eye is at
    // z = -40: placements 0 and 3 are within its 40 m gate (level 0) and placement 1 is past it
    // (level 1). From the window centre the levels would invert: 0 → level 1, 1 and 3 → level 0.
    const level = { base: 0, gate: 1, planes: levelPlanes(100) };
    const byKey = drawnPlacements(cullAndSelectShadow(input, level), input);
    expect([...(byKey.get(0) ?? [])]).toEqual([0, 3]);
    expect([...(byKey.get(1) ?? [])]).toEqual([1]);
    // `castLevels: 1`: only the finest level has a twin, as on Machinefall. A placement the main
    // pass draws at a level that casts nothing casts with the coarsest shape that does, so its
    // shadow stays inside the map — never a write into a region no mesh draws (PRD-541).
    const uncast: IKernelInput = {
      ...input,
      regions: input.regions.map((region, index) =>
        index === 0 ? region : { ...region, uncast: true },
      ),
    };
    const fine = drawnPlacements(cullAndSelectShadow(uncast, level), uncast);
    expect([...(fine.get(0) ?? [])]).toEqual([0, 1, 3]);
    expect([...(fine.get(1) ?? [])]).toEqual([]);
    // A coarse map asks for the coarsest shape; with one casting level that is level 0, never a
    // level whose twin was not minted.
    const coarse = drawnPlacements(
      cullAndSelectShadow(uncast, { ...level, base: COARSEST_SHADOW_LEVEL }),
      uncast,
    );
    expect([...(coarse.get(0) ?? [])]).toEqual([0, 1, 3]);
    expect([...(coarse.get(2) ?? [])]).toEqual([]);
  });

  it.each([0, COARSEST_SHADOW_LEVEL])(
    "does not restore authored LODs past their casting levels (base=%s)",
    (base) => {
      const { input } = shadowFixture();
      const authored: IKernelInput = {
        ...input,
        slots: input.slots.map((slot) => ({ ...slot, shadowFallback: false })),
        regions: input.regions.map((region, index) =>
          index === 0 ? region : { ...region, uncast: true },
        ),
      };
      const level = { base, gate: 1, planes: levelPlanes(100) };
      const drawn = drawnPlacements(cullAndSelectShadow(authored, level), authored);
      expect(drawn.get(0)).toEqual([0, 3]);
      expect(drawn.get(1)).toEqual([]);
      expect(cullAndSelect(authored)).toEqual(cullAndSelect(input));
    },
  );

  it("reads a base past the chain as the coarsest shape the asset has, without reading past its levels", () => {
    const { input } = shadowFixture();
    const level = {
      base: COARSEST_SHADOW_LEVEL,
      gate: 0,
      planes: levelPlanes(100),
    };
    // A level table that refuses an index past its own end, which is what the twin's storage read
    // does and what an out-of-range base used to ask it for. The base is clamped per asset, so one
    // number — a node that coarsens a coarse level's casters without knowing an asset — asks every
    // chain for its own coarsest shape.
    const levels = input.slots[0]?.levels ?? [];
    const guarded: IKernelInput = {
      ...input,
      slots: [
        {
          ...(input.slots[0] as { cull: undefined; distances: readonly number[] }),
          levels: new Proxy(levels, {
            get: (target, at) => {
              // A property key is a string even when it was written as a number, so it is compared
              // as one: `levels[1048576]` is the read the twin's storage buffer would refuse.
              const index = Number(at);
              if (!Number.isInteger(index) || index < target.length) return Reflect.get(target, at);
              throw new RangeError(`level ${String(at)} is outside the asset's own chain.`);
            },
          }),
        },
      ],
    };
    const coarsest = drawnPlacements(cullAndSelectShadow(guarded, level), guarded);
    expect([...(coarsest.get(2) ?? [])].sort()).toEqual([0, 1, 2, 3]);
    // The same set the asset's own last level index names, which is what the base means.
    const named = drawnPlacements(cullAndSelectShadow(input, { ...level, base: 2 }), input);
    expect([...coarsest]).toEqual([...named]);
  });

  it("floors the level at the map's base, which is the shape the cluster path hands it", () => {
    const { input } = shadowFixture();
    const level = { base: 0, gate: 0, planes: levelPlanes(100) };
    const fine = drawnPlacements(cullAndSelectShadow(input, level), input);
    expect([...(fine.get(0) ?? [])]).toEqual([0, 2, 3]);
    expect([...(fine.get(1) ?? [])]).toEqual([1]);
    // A coarse map draws the coarsest shape whatever the placement's own distance selected, so every
    // placement the frustum holds moves up to the base — the same coarsening `#probe` does to a
    // coarse level's geometry.
    const coarse = drawnPlacements(cullAndSelectShadow(input, { ...level, base: 2 }), input);
    expect([...(coarse.get(1) ?? [])]).toEqual([]);
    expect([...(coarse.get(2) ?? [])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
  });
});

describe("the shadow twins of a registered provider", () => {
  it("allocates nothing and dispatches nothing without a provider, and nothing with the flag off", () => {
    const scene = wired([{ name: "a", levels: [...DISTANCES] }], 1, 64);
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      compute: () => {},
    } as never;
    const before = scene.footprint();
    const { camera, planes } = cameraAt(0, 0);
    const level = { base: 0, gate: 0, planes };
    // No provider: a level's own dispatch is a no-op, and says so.
    expect(scene.shadowKeys).toBe(false);
    scene.dispatchShadow(renderer, level);
    expect(scene.shadowDrawn).toBeUndefined();
    expect(scene.shadowArgs).toBeUndefined();
    expect(scene.footprint()).toEqual(before);
    // A provider with the flag off registers nothing, so the same dispatch is still a no-op.
    vi.stubGlobal("__tnShadowGpuKeys", 0);
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0", "a:2:0"]);
    expect(scene.shadowKeys).toBe(false);
    scene.dispatchShadow(renderer, level);
    expect(scene.footprint()).toEqual(before);
    // The flag on and a provider: the twins appear, and the footprint names what they cost.
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0", "a:2:0"]);
    expect(scene.shadowKeys).toBe(true);
    scene.dispatchShadow(renderer, level);
    const after = scene.footprint();
    expect(Object.keys(after)).toContain("shadowArgs");
    expect(Object.keys(after)).toContain("shadowDrawn");
    const twins = after.shadowDrawn;
    // A twin drawn run is the main drawn capacity again, at 64 bytes an instance slot: the whole
    // cost of the flag, and the args records are 20 bytes a key beside it.
    const drawn = scene.regions.reduce((sum, region) => sum + region.capacity, 0);
    expect(twins?.count).toBeGreaterThanOrEqual(drawn);
    expect(scene.shadowDrawn?.array.byteLength).toBeGreaterThanOrEqual(drawn * 64);
    expect(scene.shadowArgs?.array.byteLength).toBeLessThan(drawn * 64);
    scene.dispose();
  });

  it("gives each named key a record of its own, and an unnamed key none", () => {
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    const scene = wired([{ name: "a", levels: [...DISTANCES] }], 1, 64);
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      compute: () => {},
    } as never;
    const { planes } = cameraAt(0, 0);
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0"]);
    scene.dispatchShadow(renderer, { base: 0, gate: 0, planes });
    // The twin of a named key is the main key's own geometry and run, with the count left at zero
    // for the clear dispatch to write.
    const named = scene.regionOf("a:1:0") as IRegion;
    const twin = scene.shadowRegionOf("a:1:0") as IRegion;
    expect(twin.argsIndex).toBe(named.argsIndex);
    expect(twin.start).toBe(named.start);
    expect(twin.capacity).toBe(named.capacity);
    expect(scene.shadowRegionOf("a:2:0")).toBeUndefined();
    // A key the provider names later is a twin of the pass that first needs it.
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0", "a:2:0"]);
    scene.dispatchShadow(renderer, { base: 0, gate: 0, planes });
    expect(scene.shadowRegionOf("a:2:0")?.argsIndex).toBe(
      (scene.regionOf("a:2:0") as IRegion).argsIndex,
    );
    scene.dispose();
  });

  it("submits exactly two dispatches per level render, and none the main pass does not ask for", () => {
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    const scene = wired([{ name: "a", levels: [...DISTANCES] }], 1, 64);
    let computes = 0;
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      compute: (node: unknown) => {
        computes += Array.isArray(node) ? node.length : 1;
      },
    } as never;
    const { camera, planes } = cameraAt(0, 0);
    const level = { base: 0, gate: 0, planes };
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0", "a:2:0"]);
    // The frame's own main dispatch is its own two, and a level render is two more.
    scene.dispatch(renderer, camera);
    expect(computes).toBe(2);
    scene.dispatchShadow(renderer, level);
    expect(computes).toBe(4);
    scene.dispatchShadow(renderer, level);
    expect(computes).toBe(6);
    // The main pass's own pair is unchanged by all of it: the twins are separate buffers, and a
    // second level render cannot zero the records the main pass is about to draw.
    expect(scene.args).not.toBe(scene.shadowArgs);
    expect(scene.drawn).not.toBe(scene.shadowDrawn);
    scene.dispose();
  });

  it("makes one compute call of two kernels per main-pass dispatch", () => {
    const scene = wired([{ name: "a", levels: [...DISTANCES] }], 1, 64);
    const received: unknown[] = [];
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      compute: (node: unknown) => {
        received.push(node);
      },
    } as never;
    const { camera } = cameraAt(0, 0);
    scene.dispatch(renderer, camera);
    expect(received).toHaveLength(1);
    expect(Array.isArray(received[0])).toBe(true);
    expect(received[0]).toHaveLength(2);
    scene.dispose();
  });

  /**
   * Machinefall's walk: the first level render happens at the camp with a handful of placements,
   * and streaming then grows the placement buffer a thousandfold. A shadow kernel kept from that
   * first render still reads the first buffer at its first thread count, so every later level
   * selects from the camp's handful and a real walk read zero shadow instances on all 138 renders.
   */
  it("rebuilds the level's kernel against a placement buffer that grew after its first render", () => {
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    const scene = wired([{ name: "a", levels: [...DISTANCES] }], 1, 4096);
    const culls: { count: number }[] = [];
    const renderer = {
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
      compute: (node: { count: number } | { count: number }[]) => culls.push(...[node].flat()),
    } as never;
    const { planes } = cameraAt(0, 0);
    const level = { base: 0, gate: 0, planes };
    scene.shadowKeysFrom(() => ["a:0:0", "a:1:0", "a:2:0"]);
    placed(scene, 0, 2, 4);
    scene.dispatchShadow(renderer, level);
    const first = culls.at(-1);
    placed(scene, 0, 600, 1);
    scene.dispatchShadow(renderer, level);
    const second = culls.at(-1);
    expect(second, "a grown placement buffer is a new pipeline").not.toBe(first);
    expect(second?.count, "one thread per resident placement").toBeGreaterThanOrEqual(602);
    scene.dispose();
  });
});

describe("addRange", () => {
  /** An attribute with the two members `addRange` uses. It records each range, in order. */
  function uploads(): {
    updateRanges: { start: number; count: number }[];
    addUpdateRange(start: number, count: number): void;
  } {
    return {
      updateRanges: [],
      addUpdateRange(start, count) {
        this.updateRanges.push({ start, count });
      },
    };
  }

  it("merges consecutive ranges into one upload", () => {
    const attribute = uploads();
    addRange(attribute, 0, 24);
    addRange(attribute, 24, 24);
    addRange(attribute, 48, 24);
    expect(attribute.updateRanges).toEqual([{ start: 0, count: 72 }]);
  });

  it("does not merge across a gap", () => {
    const attribute = uploads();
    addRange(attribute, 0, 24);
    addRange(attribute, 100, 24);
    expect(attribute.updateRanges).toEqual([
      { start: 0, count: 24 },
      { start: 100, count: 24 },
    ]);
  });

  it("merges an earlier range that overlaps the last one", () => {
    const attribute = uploads();
    addRange(attribute, 48, 24);
    addRange(attribute, 40, 16);
    expect(attribute.updateRanges).toEqual([{ start: 40, count: 32 }]);
  });
});
