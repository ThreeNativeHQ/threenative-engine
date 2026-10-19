import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  DirectionalLight,
  Frustum,
  type InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
  Sphere,
  Vector3,
} from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_KEY_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "../src/render/virtual-shadow.js";
import {
  type IGpuPlacement,
  type IKernelInput,
  type IRegion,
  type IShadowLevel,
  cullAndSelectShadow,
} from "../src/world-gpu-scene.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * PRD-478 phase 2: a shadow level's GPU-key selection against the cluster path it would replace, on
 * the committed `world-v1` package rather than on a fixture invented to agree with it.
 *
 * The cluster path is measured rather than modelled. A real `WorldCells` streams the package with the
 * GPU scene on, a real `VirtualShadowNode` runs `#probe` and takes its level renders, and the harness
 * mirrors three's own draw gate over the meshes that survive — so "what the old path submits for
 * this map" is read off the meshes and their instance matrices. The other side is
 * `cullAndSelectShadow` on an input this file builds from the package: the placement spheres, the
 * cull distances and the gate table come from the manifest, and the key layout is this file's own,
 * so a kernel that read the wrong planes, gate or level cannot agree with it by sharing the
 * mistake. Every frustum test below is three's own, applied here rather than through the reference.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;
const CELL = manifest.cellSize;
const RING = 1;
const MIN_CASTER_TEXELS = 1.5;
const CLIP_EXTENTS = [48, 192, 320] as const;
const MAP_SIZE = 256;
const ASSETS = Object.keys(manifest.assets).sort();
const IDENT = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
/** The follow point, and the cell it stands in: the ring is `ring` cells of it in Chebyshev distance. */
const FOLLOW = {
  x: manifest.extent.minX + 1.5 * CELL,
  z: manifest.extent.minZ + 1.5 * CELL,
};
const FOLLOW_CELL = {
  x: Math.floor((FOLLOW.x - manifest.extent.minX) / CELL),
  z: Math.floor((FOLLOW.z - manifest.extent.minZ) / CELL),
};
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };

interface IPlacement {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  readonly cull: number | undefined;
  /** Which asset's gate table this placement is selected against. */
  readonly slot: number;
  /** `x,z`, which is how both sides name a placement: the instance matrix is a translation here. */
  readonly key: string;
}

/** Half the diagonal of an asset's authored bounds: the sphere radius its placements are culled with. */
function radiusOf(id: string): number {
  const bounds = manifest.assets[id]?.bounds;
  if (bounds === undefined) throw new Error(`the committed package has no ${id} asset.`);
  return (
    0.5 *
    Math.hypot(
      (bounds.max[0] as number) - (bounds.min[0] as number),
      (bounds.max[1] as number) - (bounds.min[1] as number),
      (bounds.max[2] as number) - (bounds.min[2] as number),
    )
  );
}

/** `cullDistance(maxDistance)`: the authored reach less its eighth, which is what the world filters on. */
function cullOf(id: string): number | undefined {
  const max = manifest.assets[id]?.maxDistance;
  return max === undefined ? undefined : max - max / 8;
}

/**
 * One asset as a single box over its authored bounds, so the geometry radius the cluster path's texel
 * gate measures is the same number the placement's own sphere came from: a box at the origin would be
 * judged as 13.86 m wide while its fern placements are 1.41 m, and the two gates would then be
 * answering different questions.
 */
function modelFor(id: string): Object3D {
  const bounds = manifest.assets[id]?.bounds;
  if (bounds === undefined) throw new Error(`the committed package has no ${id} asset.`);
  const mesh = new Mesh(
    new BoxGeometry(
      (bounds.max[0] as number) - (bounds.min[0] as number),
      (bounds.max[1] as number) - (bounds.min[1] as number),
      (bounds.max[2] as number) - (bounds.min[2] as number),
    ),
    new MeshBasicMaterial(),
  );
  mesh.position.set(
    ((bounds.max[0] as number) + (bounds.min[0] as number)) * 0.5,
    ((bounds.max[1] as number) + (bounds.min[1] as number)) * 0.5,
    ((bounds.max[2] as number) + (bounds.min[2] as number)) * 0.5,
  );
  return mesh;
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

function stubFixtureFetch(): void {
  const body = JSON.stringify(manifest);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json"))
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => manifest,
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

async function flush(rounds = 4): Promise<void> {
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

/** What `VirtualShadowNode.setup` needs: a shadow-enabled renderer and a material context. */
const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

function frustumOf(camera: PerspectiveCamera): Frustum {
  return new Frustum().setFromProjectionMatrix(
    new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
  );
}

/** The six planes of a level's own shadow camera, in the order `cameraPlanes` writes them. */
function planesOf(camera: PerspectiveCamera): Float32Array {
  const planes = new Float32Array(24);
  for (const [index, plane] of frustumOf(camera).planes.entries()) {
    const at = index * 4;
    planes[at] = plane.normal.x;
    planes[at + 1] = plane.normal.y;
    planes[at + 2] = plane.normal.z;
    planes[at + 3] = plane.constant;
  }
  return planes;
}

/** Whether a placement of `radius` at `(x, z)` is in this camera's frustum, as three tests it. */
function inFrustum(camera: PerspectiveCamera, one: IPlacement): boolean {
  return frustumOf(camera).intersectsSphere(new Sphere(new Vector3(one.x, 0, one.z), one.radius));
}

interface ILevelNode {
  readonly light: DirectionalLight;
  readonly shadow: { readonly camera: PerspectiveCamera };
  updateShadow(frame: NodeFrame): void;
}

/** One level's last render: what it submitted, what its gate hid, and the four numbers it selects by. */
interface ILevelRender {
  readonly gated: Set<string>;
  readonly level: IShadowLevel;
  readonly submitted: Set<string>;
  draws: number;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a shadow level's GPU-key selection against the cluster path", () => {
  it("selects the cluster path's own instances, and drops only what its own frustum or gate drops", async () => {
    stubFixtureFetch();
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(60, 200, -40);
    light.castShadow = true;
    scene.add(light, light.target);
    const node = new VirtualShadowNode(light, {
      clipExtents: [...CLIP_EXTENTS],
      mapSize: MAP_SIZE,
      marker: false,
      // The package's own default, named here because the reference computes this level's gate from
      // it: `minCasterTexels * 2 * extent / mapSize`.
      minCasterTexels: MIN_CASTER_TEXELS,
    });
    node.setup(builder);

    /**
     * One level's render, as three performs it for a caster: `#probe` has already hidden what this
     * level's texel gate drops and chosen this level's caster layers, so what is left is the whole of
     * the cluster path's bill — the camera's layer mask, the frustum, `visible` and `castShadow` —
     * with the instances read off the meshes' own matrices.
     */
    const casterLayers =
      (1 << VIRTUAL_SHADOW_CASTER_LAYER) |
      (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER) |
      (1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER);
    const renders = new Map<number, ILevelRender>();
    for (const [index, levelNode] of node.levelNodes.entries()) {
      const level = levelNode as unknown as ILevelNode;
      level.updateShadow = (): void => {
        level.light.shadow.updateMatrices(level.light);
        const camera = level.shadow.camera;
        camera.updateMatrixWorld(true);
        camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
        const frustum = frustumOf(camera);
        const extent = node.stats.perLevel[index]?.extent ?? 0;
        const held: ILevelRender = {
          draws: 0,
          gated: new Set<string>(),
          level: {
            base: 0,
            gate: (MIN_CASTER_TEXELS * 2 * extent) / MAP_SIZE,
            planes: planesOf(camera),
          },
          submitted: new Set<string>(),
        };
        renders.set(index, held);
        scene.traverse((object: Object3D) => {
          const mesh = object as InstancedMesh;
          if ((mesh as { isInstancedMesh?: boolean }).isInstancedMesh !== true) return;
          if (mesh.castShadow !== true) return;
          if ((mesh.layers.mask & camera.layers.mask) === 0) return;
          if ((mesh.layers.mask & casterLayers) === 0) return;
          // A merged chunk proxy stands in for meshes the GPU keys do not draw — the box's own
          // residual — so it is not part of either side's set.
          if (mesh.name.endsWith("-shadow")) return;
          const reaches = frustum.intersectsObject(mesh);
          const matrix = mesh.instanceMatrix.array as Float32Array;
          const name = (instance: number): string => {
            const at = instance * 16;
            return `${(matrix[at + 12] as number).toFixed(3)},${(matrix[at + 14] as number).toFixed(3)}`;
          };
          if (mesh.visible === false) {
            // Hidden by this level's texel gate, which is the cluster path's own decision. Counted only
            // where the frustum would have kept the square, because a square the frustum drops is not
            // drawn by either path and the gate never got a say in it.
            if (reaches === false) return;
            for (let instance = 0; instance < mesh.count; instance += 1)
              held.gated.add(name(instance));
            return;
          }
          if (reaches === false) return;
          held.draws += 1;
          for (let instance = 0; instance < mesh.count; instance += 1)
            held.submitted.add(name(instance));
        });
      };
    }

    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow: { position: { ...FOLLOW } },
      gpuScene: true,
      loadModel: async (url: string) => modelFor(path.basename(url, ".glb").replace("_lod1", "")),
      prefetchSeconds: 0,
      ring: RING,
      shadows: { cast: true, castLevels: CLIP_EXTENTS.length },
      surface: new MeshBasicMaterial(),
      url: "/world/world.json",
    });
    scene.add(world);
    const camera = cameraAt(FOLLOW.x, FOLLOW.z);
    for (let frame = 1; frame <= 30; frame += 1) {
      world.update(undefined, camera);
      node.updateBefore({ camera, renderer: {}, time: frame } as unknown as NodeFrame);
      await flush();
    }
    expect(world.stats().loadsInFlight, "the world streamed").toBe(0);

    // The resident set, from the ring rule, checked against the world's own count: the reference is
    // fed the placements a resident world holds, and a placement from a cell that left the ring has
    // no caster mesh anywhere for either side to agree about.
    const resident = new Set(
      manifest.cells
        .filter(
          (cell) =>
            Math.abs(cell.x - FOLLOW_CELL.x) <= RING && Math.abs(cell.z - FOLLOW_CELL.z) <= RING,
        )
        .map((cell) => `${String(cell.x)},${String(cell.z)}`),
    );
    expect(resident.size).toBe(world.stats().residentCells);

    // The reference's input, built from the package: one key per asset at its near level, in asset
    // order, and every resident placement the package files — each admitted on the world's own
    // `maxDistance` rule, measured from the follow point as `#addPlacements` measures it.
    const bytes = readFileSync(path.join(fixture, "placements.bin"));
    const records = new Float32Array(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const placements: IPlacement[] = [];
    const slots: {
      cull: number | undefined;
      distances: readonly number[];
      levels: { firstKey: number; parts: number }[];
    }[] = [];
    const regions: IRegion[] = [];
    for (const [slot, id] of ASSETS.entries()) {
      const definition = manifest.assets[id];
      if (definition === undefined) continue;
      const radius = radiusOf(id);
      const cull = cullOf(id);
      slots.push({
        cull,
        distances: [0, ...(definition.lods ?? []).map((lod) => lod.distance)],
        levels: [{ firstKey: slot, parts: 1 }],
      });
      regions.push({
        argsIndex: slot,
        capacity: 4096,
        indexCount: 36,
        local: IDENT,
        name: `${id}:0:0`,
        start: slot * 4096,
      });
      for (const cell of manifest.cells) {
        if (!resident.has(`${String(cell.x)},${String(cell.z)}`)) continue;
        for (const run of cell.runs) {
          if (run.asset !== id) continue;
          for (let at = 0; at < run.count; at += 1) {
            const base = (run.offset + at) * 8;
            const x = records[base] as number;
            const z = records[base + 2] as number;
            const scale = Math.abs(records[base + 7] as number);
            if (cull !== undefined && Math.hypot(x - FOLLOW.x, z - FOLLOW.z) > cull) continue;
            placements.push({
              cull,
              key: `${x.toFixed(3)},${z.toFixed(3)}`,
              radius: radius * scale,
              slot,
              x,
              z,
            });
          }
        }
      }
    }
    expect(placements.length, "the resident world holds placements").toBeGreaterThan(0);

    let saved = 0;
    let drawnTotal = 0;
    for (const [index, held] of renders) {
      const levelCamera = (node.levelNodes[index] as unknown as ILevelNode).shadow.camera;
      const { base, gate, planes } = held.level;
      const level: IShadowLevel = { base, gate, planes };
      // The main camera's eye: a map draws each placement at the level the main pass draws it.
      const kernel: IKernelInput = {
        camera: { planes, x: FOLLOW.x, y: 0, z: FOLLOW.z },
        count: placements.length,
        placements: placements.map((one) => ({
          centre: new Float32Array([one.x, 0, one.z, one.radius]),
          matrix: new Float32Array(new Matrix4().makeTranslation(one.x, 0, one.z).elements),
          slot: one.slot,
        })),
        regionCount: regions.length,
        regions,
        slots,
      };
      const result = cullAndSelectShadow(kernel, level);
      const drawn = new Set<string>();
      for (const [key, count] of [...result.counts.entries()]) {
        const region = regions[key] as IRegion;
        for (let taken = 0; taken < count; taken += 1) {
          const at = (region.start + taken) * 16;
          drawn.add(
            `${(result.drawn[at + 12] as number).toFixed(3)},${(result.drawn[at + 14] as number).toFixed(3)}`,
          );
        }
      }
      const byKey = new Map(placements.map((one) => [one.key, one] as const));
      const owns = (one: string): IPlacement => {
        const found = byKey.get(one);
        if (found === undefined) throw new Error(`no resident placement owns ${one}.`);
        return found;
      };

      // Nothing this map draws is something the cluster path did not draw for it: the shadow set is
      // a subset of the old path's own submissions, so no shadow in this map is a new loss.
      expect(
        [...drawn].filter((one) => held.submitted.has(one) === false),
        `level ${String(index)} drew an instance its caster meshes never submitted`,
      ).toEqual([]);
      expect(drawn.size, `level ${String(index)} drew something`).toBeGreaterThan(0);
      // Every instance it draws is inside this map's own light frustum and past its own texel gate,
      // by three's own test applied here: the planes and the gate are the map's, not the camera's.
      for (const one of drawn) {
        const found = owns(one);
        expect(
          inFrustum(levelCamera, found),
          `level ${String(index)} drew ${one}, which its own frustum excludes`,
        ).toBe(true);
        expect(
          found.radius * 2,
          `level ${String(index)} drew a sub-texel instance`,
        ).toBeGreaterThanOrEqual(gate);
      }
      // Every instance it drops is one this map's own frustum excludes, or its own gate resolves, or
      // its asset's authored reach ends: the per-square over-draw the cluster path pays and the
      // per-placement test does not.
      const dropped = [...held.submitted].filter((one) => drawn.has(one) === false);
      for (const one of dropped) {
        const found = owns(one);
        const beyond =
          found.cull !== undefined &&
          Math.hypot(found.x - FOLLOW.x, found.z - FOLLOW.z) > found.cull;
        expect(
          inFrustum(levelCamera, found) === false || found.radius * 2 < gate || beyond,
          `level ${String(index)} dropped ${one}, which its own frustum holds and its own gate resolves`,
        ).toBe(true);
      }
      // And the gate answers the cluster path's own: every instance the reference drops for being
      // sub-texel is one on a mesh `#probe` hid, and as many as it hid.
      // A gate-hidden square submits nothing, so the sub-texel set is the one over every square the
      // frustum reached — submitted or hidden by the gate.
      const reached = new Set([...held.submitted, ...held.gated]);
      const subTexel = [...reached].filter((one) => owns(one).radius * 2 < gate);
      expect(
        [...subTexel].filter((one) => drawn.has(one)),
        `level ${String(index)} drew a sub-texel`,
      ).toEqual([]);
      expect(
        held.gated.size,
        `level ${String(index)}'s gate hid as many instances as the reference drops`,
      ).toBe(subTexel.length);
      saved += dropped.length + held.gated.size;
      drawnTotal += drawn.size;
    }
    // Every level rendered, and the per-placement test saved real submissions: the candidates this
    // phase exists to cut are the squares a whole-square frustum test keeps alive.
    expect(renders.size).toBe(CLIP_EXTENTS.length);
    expect(saved).toBeGreaterThan(0);
    console.info(
      `TN_SHADOW_GPU_KEYS levels=${String(renders.size)} drawn=${String(drawnTotal)} ` +
        `saved=${String(saved)} placements=${String(placements.length)}`,
    );
    world.dispose();
  });
});

/** `VirtualShadowNode`'s own per-level row, paired with the bill measured inside that same render. */
type ILevelStat = {
  readonly draws: number;
  readonly drawsBy: {
    readonly cluster: number;
    readonly keys: number;
    readonly small: number;
    readonly wide: number;
  };
};

/**
 * What one level render submitted, counted the way three counts it: the camera's layer mask decides
 * which meshes exist for the pass, `visible` and `castShadow` decide whether they are reached, and
 * `frustumCulled === false` is three's own exemption from the whole-mesh frustum test — which is what
 * a GPU-dressed mesh takes, since the dispatch tested every instance instead.
 */
interface ILevelSubmissions {
  keys: number;
  casters: number;
  /** Of the caster meshes, the ones alone on the cluster layer — the half a keyed camera still draws. */
  cluster: number;
  proxies: number;
  layer0: number;
  /** Every submitted draw, and how many of them were one indirect record rather than a whole mesh. */
  draws: number;
  indirect: number;
  /** The node's own row for this level, read on the same render; undefined until it has rendered. */
  stat: ILevelStat | undefined;
}

/**
 * What the main pass has to draw, read off the world rather than off a shadow render: the meshes it
 * draws them from — one `asset:level:part` per level, and `far` how many of those are the level at or
 * past the lod switch — and the resident source records behind them, which is the GPU scene's own
 * count of the placements the main pass dispatches from. The shadow halves and the key twins are all
 * minted under a name carrying an `@`, so what is left is the main pass's own set.
 *
 * `records` is the count rather than the matrices because a GPU-dressed main mesh's `count` is its
 * key's region capacity, not what it holds (see `SharedBatch.publish`), and its records live in a GPU
 * buffer the dispatch writes. The world's own source table is the CPU-visible truth of the same
 * thing, and it is filled by the one call a refused swap never reaches.
 */
function mainPassBill(world: WorldCells): {
  readonly far: number;
  readonly meshes: readonly string[];
  readonly records: number;
} {
  const meshes: string[] = [];
  let far = 0;
  world.traverse((object: Object3D) => {
    const mesh = object as InstancedMesh;
    if ((mesh as { isInstancedMesh?: boolean }).isInstancedMesh !== true) return;
    if (mesh.name.includes("@")) return;
    meshes.push(mesh.name);
    const level = /^[^:]+:(\d+):\d+$/.exec(mesh.name)?.[1];
    if (level !== undefined && Number(level) > 0) far += 1;
  });
  meshes.sort();
  return { far, meshes, records: world.stats().gpuScene.instances };
}

interface IArmResult {
  readonly perLevel: ILevelSubmissions[];
  /** Every dispatch the world submitted, and how many of them a level render took. */
  readonly dispatches: number;
  readonly levelRenders: number;
  readonly keys: InstancedMesh[];
  /** The main pass's own meshes and records, which the flag must not move. */
  readonly mainPass: ReturnType<typeof mainPassBill>;
  dispose(): void;
}

/**
 * One run of the package with the shadow keys on or off: a real `WorldCells` streams it, a real
 * `VirtualShadowNode` takes its level renders, and every render is measured here rather than
 * modelled. The GPU scene's own dispatches are counted rather than executed — nothing below needs a
 * device, and what is being counted is what a level submits.
 */
async function measureSubmissions(
  keys: boolean,
  extents: readonly number[] = CLIP_EXTENTS,
  gpuScene = true,
  sceneAfter = 0,
  mapSize = MAP_SIZE,
): Promise<IArmResult> {
  vi.stubGlobal("__tnShadowGpuKeys", keys ? 1 : 0);
  stubFixtureFetch();
  const scene = new Scene();
  const light = new DirectionalLight(0xffffff, 1);
  light.position.set(60, 200, -40);
  light.castShadow = true;
  scene.add(light, light.target);
  const node = new VirtualShadowNode(light, {
    clipExtents: [...extents],
    mapSize,
    marker: false,
    minCasterTexels: MIN_CASTER_TEXELS,
  });
  node.setup(builder);
  const keyLayer = 1 << VIRTUAL_SHADOW_KEY_LAYER;
  const clusterLayer = 1 << VIRTUAL_SHADOW_CASTER_LAYER;
  const casterLayers =
    clusterLayer |
    (1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER) |
    (1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER);
  const held: ILevelSubmissions[] = [];
  /** Which levels took this frame's render, so its published row can be paired with its bill. */
  const rendered = extents.map(() => false);
  let levelRenders = 0;
  for (const [index, levelNode] of node.levelNodes.entries()) {
    const level = levelNode as unknown as ILevelNode;
    level.updateShadow = (): void => {
      level.light.shadow.updateMatrices(level.light);
      const camera = level.shadow.camera;
      camera.updateMatrixWorld(true);
      camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
      const frustum = frustumOf(camera);
      const one: ILevelSubmissions = {
        casters: 0,
        cluster: 0,
        draws: 0,
        indirect: 0,
        keys: 0,
        layer0: 0,
        proxies: 0,
        // The node's per-frame stats are published at the end of the frame, so the row belonging to
        // *this* render is next frame's; that is the row a walk reads, and it is compared with the
        // bill this render measured.
        stat: undefined,
      };
      held[index] = one;
      rendered[index] = true;
      levelRenders += 1;
      scene.traverse((object: Object3D) => {
        const mesh = object as InstancedMesh;
        if ((mesh as { isInstancedMesh?: boolean }).isInstancedMesh !== true) return;
        if (mesh.visible !== true || mesh.castShadow !== true) return;
        if ((mesh.layers.mask & camera.layers.mask) === 0) return;
        if (mesh.frustumCulled !== false && !frustum.intersectsObject(mesh)) return;
        one.draws += 1;
        if ((mesh.layers.mask & keyLayer) !== 0) {
          one.keys += 1;
          if (mesh.geometry.indirect !== undefined) one.indirect += 1;
        } else if (mesh.name.endsWith("-shadow")) one.proxies += 1;
        else if ((mesh.layers.mask & casterLayers) !== 0) {
          one.casters += 1;
          if ((mesh.layers.mask & clusterLayer) !== 0) one.cluster += 1;
        } else if ((mesh.layers.mask & 1) !== 0) one.layer0 += 1;
      });
    };
  }
  let dispatches = 0;
  const renderer = {
    compileAsync: async (): Promise<void> => {},
    compute: (): void => {
      dispatches += 1;
    },
    kind: "webgpu",
    raw: { backend: { hasFeature: () => true } },
  } as unknown as Parameters<WorldCells["update"]>[0];
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    follow: { position: { ...FOLLOW } },
    gpuScene,
    loadModel: async (url: string) => modelFor(path.basename(url, ".glb").replace("_lod1", "")),
    prefetchSeconds: 0,
    // The whole package, not the nine cells the selection case reads: a per-square bill only shows
    // what it costs when the level's window covers squares, which is the case the box is about.
    ring: 3,
    shadows: { cast: true, castLevels: extents.length },
    surface: new MeshBasicMaterial(),
    url: "/world/world.json",
  });
  scene.add(world);
  const camera = cameraAt(FOLLOW.x, FOLLOW.z);
  for (let frame = 1; frame <= 30; frame += 1) {
    rendered.fill(false);
    // `sceneAfter`: the loading screen's own shape — no renderer at all for its frames, so the ring is
    // prewarmed and streamed with the GPU scene still off and comes up against a world already built.
    // A refusal is final (the scene reports once), so only the renderer-less frames can be late.
    const at = frame <= sceneAfter ? undefined : renderer;
    world.update(at, camera);
    node.updateBefore({ camera, renderer, time: frame } as unknown as NodeFrame);
    // The node publishes a frame's rows before `updateBefore` returns, so the level that took this
    // frame's render — one per frame is the budget — is read here rather than at the end, where it
    // would be the last level's row and the rest would read zero.
    for (const [index, one] of held.entries()) {
      if (rendered[index] !== true || one === undefined) continue;
      const row = node.stats.perLevel[index];
      if (row !== undefined)
        one.stat = {
          draws: row.draws,
          drawsBy: {
            cluster: row.drawsBy.cluster,
            keys: row.drawsBy.keys,
            small: row.drawsBy.small,
            wide: row.drawsBy.wide,
          },
        };
    }
    await flush();
  }
  // The live key meshes, read off the world rather than off the render history: a key whose twin
  // regrew was replaced by a fresh object, and the replaced one is not what a frame draws.
  const live: InstancedMesh[] = [];
  world.traverse((object: Object3D) => {
    const mesh = object as InstancedMesh;
    if ((mesh.layers.mask & (1 << VIRTUAL_SHADOW_KEY_LAYER)) !== 0) live.push(mesh);
  });
  return {
    dispose: (): void => {
      world.dispose();
      node.dispose();
    },
    dispatches,
    keys: live,
    levelRenders,
    mainPass: mainPassBill(world),
    perLevel: held,
  };
}

describe("a level render's own submissions with and without GPU keys", () => {
  it("preserves the fallback caster submissions when the flag cannot mint GPU keys", async () => {
    const off = await measureSubmissions(false, [250], false, 0, 4096);
    const on = await measureSubmissions(true, [250], false, 0, 4096);
    try {
      expect(on.keys).toHaveLength(0);
      expect(off.perLevel[0]?.casters).toBeGreaterThan(0);
      expect(off.perLevel[0]?.stat?.drawsBy.small).toBeGreaterThan(0);
      expect(on.perLevel.map(({ stat, ...draws }) => draws)).toEqual(
        off.perLevel.map(({ stat, ...draws }) => draws),
      );
      expect(on.perLevel.map(({ stat }) => stat)).toEqual(off.perLevel.map(({ stat }) => stat));
    } finally {
      on.dispose();
      off.dispose();
    }
  });

  /**
   * The loading screen's shape, which is the one a real game loads in: the ring is prewarmed and
   * streamed with no renderer at all, and the scene comes up on the first frame that has one, so
   * every main key is named in one seeding pass. This asserts that shape's whole key table reaches
   * every level and every level's counter: a twin minted from that pass is minted late, and the bill
   * that reported a partial table as fewer draws is the same miscount the single-level case below is
   * about, seen from the other side.
   */
  it("draws and counts the whole key table on a ring the scene came up to after", async () => {
    const on = await measureSubmissions(true, CLIP_EXTENTS, true, 20);
    const mains = on.mainPass.meshes.filter((name) => /:0:0$|:1:0$/.test(name));
    expect(mains.length, "the fixture's main keys").toBeGreaterThan(1);
    expect(
      on.keys.length,
      `a ring prewarmed before the scene came up drew ${String(on.keys.length)} of ${String(mains.length)} keys`,
    ).toBe(mains.length);
    console.info(
      `TN_SHADOW_KEY_LATE_SCENE keys=${String(on.keys.length)} mains=${mains.join(",")} ` +
        `records=${String(on.mainPass.records)} keysPerLevel=${on.perLevel.map((one) => one.keys).join(",")}`,
    );
    // Every level submits the whole table and counts it: a bill that says zero for a key the level
    // really draws is the miscount, not a cheaper shadow.
    for (const [index, one] of on.perLevel.entries()) {
      expect(one.keys, `level ${String(index)} drew a partial key table`).toBe(mains.length);
      expect(one.stat?.drawsBy.keys, `level ${String(index)} counted a partial table`).toBe(
        mains.length,
      );
    }
    on.dispose();
  });

  it("submits one indirect draw per key with the flag on, and the caster halves' own meshes with it off", async () => {
    const off = await measureSubmissions(false);
    const on = await measureSubmissions(true);
    // The control is the world as it is today: every level render is a bill of caster meshes, one
    // per world-grid square the window covers, and no key at all.
    for (const [index, one] of off.perLevel.entries()) {
      expect(one.keys, `level ${String(index)} submitted no key with the flag off`).toBe(0);
      expect(one.casters, `level ${String(index)} submitted caster meshes`).toBeGreaterThan(0);
      expect(one.indirect).toBe(0);
    }
    expect(off.keys, "the world minted no shadow key").toEqual([]);
    // The claim: with the flag on the same window submits one indirect draw per key and none of the
    // per-square caster meshes, and every level's own counter says so.
    expect(on.perLevel.length).toBe(CLIP_EXTENTS.length);
    for (const [index, one] of on.perLevel.entries()) {
      expect(one.stat?.drawsBy.keys, `level ${String(index)} reported no keys`).toBe(one.keys);
      expect(one.stat?.draws, `level ${String(index)} reported a different bill`).toBe(one.draws);
      expect(one.casters, `level ${String(index)} still submitted caster meshes`).toBe(0);
      expect(one.keys, `level ${String(index)} submitted a key`).toBeGreaterThan(0);
      // Every one of them is an indirect draw against a twin record, not a whole-mesh one.
      expect(one.indirect, `level ${String(index)} drew keys without their records`).toBe(one.keys);
      expect(one.draws).toBe(one.keys + one.proxies + one.layer0);
    }
    // And the whole bill is what the box is about: one draw per key, and the same number in every
    // level however wide its window is. The cluster path's bill is the squares each window covers —
    // which is why this fixture's control is already small (its coarse levels take the wide half, one
    // mesh per key, and its fine window covers a cell or two of a 256 m ring) and why the 630 the box
    // counts are Machinefall's level-0 bill rather than this one. What this case proves is the
    // mechanism that cuts that bill: the keyed bill is the key count, not the window's.
    const keysDrawn = on.perLevel.reduce((sum, one) => sum + one.keys, 0);
    const castersOff = off.perLevel.reduce((sum, one) => sum + one.casters, 0);
    console.info(
      `TN_SHADOW_KEY_DRAWS levels=${String(on.perLevel.length)} keys=${String(keysDrawn)} ` +
        `draws=${String(on.perLevel.reduce((sum, one) => sum + one.draws, 0))} ` +
        `off=${String(castersOff)} renders=${String(on.levelRenders)}/${String(off.levelRenders)} ` +
        `dispatches=${String(on.dispatches)}/${String(off.dispatches)} ` +
        `keysPerLevel=${on.perLevel.map((one) => one.keys).join(",")} ` +
        `offPerLevel=${off.perLevel.map((one) => one.casters).join(",")}`,
    );
    expect(keysDrawn).toBeGreaterThan(0);
    // Every dispatch the world submitted is accounted for: the main pass's own pair per update, and
    // a keyed level render its own clear-and-cull pair, which is what fills the twin records the keys
    // read. Nothing here executes them, so what is proved is that the flag is what asks for them and
    // that a launch without it asks for none.
    expect(off.levelRenders, "the control took level renders").toBeGreaterThan(0);
    expect(on.levelRenders, "the keyed arm took level renders").toBeGreaterThan(0);
    expect(
      on.dispatches,
      "a keyed level render dispatches its own selection before its draws",
    ).toBeGreaterThan(off.dispatches);
    // Every level drew the same keys, whatever its window: the bill is the key table, not the
    // squares a window happens to cover.
    const perLevel = new Set(on.perLevel.map((one) => one.keys));
    expect([...perLevel], "the keyed bill varied with the window").toHaveLength(1);
    expect([...perLevel][0], "every key is submitted by every level").toBe(on.keys.length);
    // Every key is one mesh per `asset:level:part`, and they all draw from the same twin buffers:
    // a world of per-mesh instance buffers would cost the very records this saves.
    expect(on.keys.length).toBeGreaterThan(0);
    for (const mesh of on.keys) {
      expect(mesh.count, `${mesh.name} is submitted at nothing`).toBeGreaterThan(0);
      expect(mesh.frustumCulled, `${mesh.name} is culled whole-mesh`).toBe(false);
      expect(mesh.geometry.indirect).toBe(on.keys[0]?.geometry.indirect);
      expect(mesh.instanceMatrix).toBe(on.keys[0]?.instanceMatrix);
      expect(mesh.castShadow).toBe(true);
      expect(mesh.visible).toBe(true);
      // Never bundled: a bundle's record is fixed when it is recorded, and only the main pass's
      // draws are replayed from it.
      expect(mesh.userData.tnBundled).toBeFalsy();
      expect(mesh.name.endsWith("@gpu")).toBe(true);
    }
    on.dispose();
    off.dispose();
  });

  /**
   * The regression the flag must not carry: the main pass is the game's picture, and the flag only
   * changes what a shadow level submits. A walk with the flag on lost the tree band beyond the
   * highway — bare meadow where the control draws a dense forest 220-400 m out — because nothing
   * handed the main meshes their records at all: with keys on the world mints no caster half, and the
   * two claims in `#swap` read "no caster half to mint" as "this frame's allowance is spent", so
   * every swap was refused, no cell ever published its placements to the scene, and the main pass had
   * nothing to draw from.
   *
   * This is that claim measured on both arms of the same package: the same `asset:level:part` meshes,
   * holding the same source records, the far band's own mesh included. Only the shadow submission may
   * differ.
   */
  it("hands the main pass the same meshes and records with the flag on as with it off", async () => {
    const off = await measureSubmissions(false, [250]);
    const on = await measureSubmissions(true, [250]);
    // The fixture has to carry the case at all: the far band's main mesh is the level the lod switch
    // moved placements into, and the band the regression emptied is that one.
    expect(off.mainPass.far, "the fixture holds a far band").toBeGreaterThan(0);
    expect(off.mainPass.records, "the control published records to the main pass").toBeGreaterThan(
      0,
    );
    console.info(
      `TN_SHADOW_KEY_MAIN_PASS off=${JSON.stringify(off.mainPass)} on=${JSON.stringify(on.mainPass)}`,
    );
    expect(on.mainPass.meshes, "the flag moved the main pass's own meshes").toEqual(
      off.mainPass.meshes,
    );
    expect(on.mainPass.records, "the flag moved the main pass's records").toBe(
      off.mainPass.records,
    );
    expect(on.mainPass.far, "the flag emptied the far band").toBe(off.mainPass.far);
    on.dispose();
    off.dispose();
  });
});

/** The frame three hands a node, as this harness can also clear: three's own is not writable here. */
interface IFrame {
  camera: unknown;
  material: unknown;
  object: unknown;
  renderer: unknown;
  scene: Scene | null;
  time: number;
}

describe("a keyed level render under three's own compute", () => {
  it("hands updateShadow the render's own scene, and the level settles instead of redrawing every frame", async () => {
    vi.stubGlobal("__tnShadowGpuKeys", 1);
    stubFixtureFetch();
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    light.position.set(60, 200, -40);
    light.castShadow = true;
    scene.add(light, light.target);
    const node = new VirtualShadowNode(light, {
      clipExtents: [...CLIP_EXTENTS],
      mapSize: MAP_SIZE,
      marker: false,
      minCasterTexels: MIN_CASTER_TEXELS,
    });
    node.setup(builder);
    const camera = cameraAt(FOLLOW.x, FOLLOW.z);
    const frame: IFrame = { camera, material: null, object: null, renderer: null, scene, time: 0 };
    let nullScenes = 0;
    let renders = 0;
    for (const levelNode of node.levelNodes) {
      const level = levelNode as unknown as ILevelNode;
      level.updateShadow = (at: NodeFrame): void => {
        renders += 1;
        if (at.scene !== scene) {
          nullScenes += 1;
          // What the stock node does with the frame it is handed: save the scene state before
          // drawing it (three.webgpu.js:45602), which reads `scene.background`
          // (three.webgpu.js:44561). On a null scene that is the reported TypeError.
          throw new TypeError("Cannot read properties of null (reading 'background')");
        }
      };
    }
    let dispatches = 0;
    let shadowDispatches = 0;
    const renderer = {
      compileAsync: async (): Promise<void> => {},
      compute: (): void => {
        dispatches += 1;
        // What three's `Renderer.compute` does to the one frame every node shares: it runs the
        // kernel's node updates through `Nodes.getNodeFrame()` (three.webgpu.js:62235 → 56359), which
        // sets every field on that frame to its bare default — `scene` included (56215) — and
        // restores `renderId` and nothing else (62249).
        frame.camera = null;
        frame.material = null;
        frame.object = null;
        frame.scene = null;
      },
      kind: "webgpu",
      raw: { backend: { hasFeature: () => true } },
    } as unknown as Parameters<WorldCells["update"]>[0];
    frame.renderer = renderer;
    const world = await WorldCells.load({
      admissionBudgetMs: Number.POSITIVE_INFINITY,
      budgets,
      follow: { position: { ...FOLLOW } },
      gpuScene: true,
      loadModel: async (url: string) => modelFor(path.basename(url, ".glb").replace("_lod1", "")),
      prefetchSeconds: 0,
      ring: RING,
      shadows: { cast: true, castLevels: CLIP_EXTENTS.length },
      surface: new MeshBasicMaterial(),
      url: "/world/world.json",
    });
    scene.add(world);
    let failures = 0;
    const step = async (at: number): Promise<void> => {
      frame.time = at;
      world.update(renderer, camera);
      // Three re-establishes that frame from the render object before every node's `updateBefore`
      // (`Nodes.getNodeFrameForRender`, three.webgpu.js:56224) — which is why a compute run outside a
      // render is harmless, and why only the dispatch *inside* one takes the scene away.
      frame.camera = camera;
      frame.material = null;
      frame.object = null;
      frame.scene = scene;
      const before = dispatches;
      try {
        node.updateBefore(frame as unknown as NodeFrame);
      } catch {
        failures += 1;
      }
      shadowDispatches += dispatches - before;
      await flush();
    };
    for (let at = 1; at <= 40; at += 1) await step(at);
    expect(world.stats().loadsInFlight, "the world streamed").toBe(0);
    expect(renders, "no level rendered at all").toBeGreaterThan(0);
    // Proof the arm under test ran: a keyed level render dispatches its own clear-and-cull pair from
    // inside `updateBefore`, and the main pass's own pair is counted separately above.
    expect(shadowDispatches, "a level render never dispatched its own keys").toBeGreaterThan(0);
    expect(nullScenes, "a compute took the render's own scene off the frame").toBe(0);
    expect(failures, "a level render threw inside the render it was dispatched from").toBe(0);
    // The walk then holds still. Nothing moved and nothing streamed in, so a window that keeps its
    // map has nothing to redraw: every level has settled. The throw above is what stopped this — the
    // light's `needsUpdate` is cleared after the level loop, so a frame that threw mid-loop left it
    // set and asked every level again, which is the 63 → 260 the walk reported.
    const settled = renders;
    for (let at = 41; at <= 50; at += 1) await step(at);
    console.info(
      `TN_SHADOW_GPU_KEYS_FRAME renders=${String(settled)} then=${String(renders - settled)} ` +
        `dispatches=${String(dispatches)}/${String(shadowDispatches)} ` +
        `nullScenes=${String(nullScenes)} failures=${String(failures)}`,
    );
    expect(renders - settled, "levels redrew with a still camera and a resident world").toBe(0);
    world.dispose();
    node.dispose();
  });
});
