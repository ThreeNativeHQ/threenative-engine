import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  DirectionalLight,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
  PerspectiveCamera,
  Scene,
} from "three";
import type { NodeBuilder, NodeFrame } from "three/webgpu";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIRTUAL_SHADOW_CASTER_LAYER,
  VIRTUAL_SHADOW_SMALL_CASTER_LAYER,
  VIRTUAL_SHADOW_WIDE_CASTER_LAYER,
  VirtualShadowNode,
} from "../src/render/virtual-shadow.js";
import type { IShadowRegion, IWorldPackage } from "../src/world.js";
import { WorldCells } from "../src/world.js";

/**
 * PRD-458: what a streamed world costs the shadow lane.
 *
 * Two costs, both measured on the 2 km walk. A change of records was handed to the levels as a
 * blanket `invalidateAll()`, so a tree 100 m from the follow point redrew the 48 m level whose
 * window does not reach it — ~4 fine renders a second against the ~1.7 a walk alone predicts. And
 * every wide level drew every wide caster, ground cover included: 615 draws a render on the 640 m
 * level, most of them ferns whose shadow is sub-texel noise at that range.
 *
 * The first is answered with the changed records' own bounds, which is a region the levels test
 * against their own windows; the second with a caster layer only the finest level renders. Both are
 * asserted through the real node: a region is checked against the level's own window, and a layer
 * by what that level's camera actually submits.
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

const CLUSTER_MASK = 1 << VIRTUAL_SHADOW_CASTER_LAYER;
const WIDE_MASK = 1 << VIRTUAL_SHADOW_WIDE_CASTER_LAYER;
const SMALL_MASK = 1 << VIRTUAL_SHADOW_SMALL_CASTER_LAYER;
/** The finest level's window, from `CLIP_EXTENTS` below: what a region is measured against. */
const FINE_EXTENT = 48;
/** `ground_cover`'s authored bounds are 0 m tall, `pine`'s are 4 m; the default threshold is 1.5 m. */
const SMALL_ASSET = "ground_cover";
const TALL_ASSET = "pine";

/** Two drawable parts per model, so a shared batch key is not one mesh per asset. */
function model(): Object3D {
  const group = new Group();
  for (let part = 0; part < 2; part += 1)
    group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

function fileResponse(body: Buffer): object {
  return {
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    headers: new Headers(),
    json: async () => JSON.parse(body.toString("utf8")),
    ok: true,
    status: 200,
  };
}

/**
 * A three-by-three ring, each cell holding one `ground_cover` record and one `pine`, both at the
 * cell's centre.
 *
 * One record a cell is the point: the bounds a cell's records are reported at are then exactly that
 * record's own, so any region wider than the asset is the cell box rather than the measurement.
 */
function stubRingFetch(): void {
  const floats: number[] = [];
  const cells: {
    runs: { asset: string; count: number; offset: number }[];
    x: number;
    z: number;
  }[] = [];
  for (let x = 0; x < 3; x += 1)
    for (let z = 0; z < 3; z += 1) {
      const offset = floats.length / 8;
      for (const asset of [SMALL_ASSET, TALL_ASSET])
        floats.push(MIN_X + (x + 0.5) * CELL_SIZE, 0, MIN_Z + (z + 0.5) * CELL_SIZE, 0, 0, 0, 1, 1);
      cells.push({
        runs: [
          { asset: SMALL_ASSET, count: 1, offset },
          { asset: TALL_ASSET, count: 1, offset: offset + 1 },
        ],
        x,
        z,
      });
    }
  const body = JSON.stringify({ ...manifest, cells } as IWorldPackage);
  const placements = Buffer.from(new Float32Array(floats).buffer);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json")) return fileResponse(Buffer.from(body));
      if (url.endsWith("placements.bin")) return fileResponse(placements);
      if (url.endsWith("heightmap.u16"))
        return fileResponse(readFileSync(path.join(fixture, "terrain/heightmap.u16")));
      return {
        arrayBuffer: async () => new ArrayBuffer(0),
        headers: new Headers(),
        json: async () => ({}),
        ok: false,
        status: 404,
      };
    }),
  );
}

function cellCenter(x: number, z: number): { x: number; z: number } {
  return { x: MIN_X + (x + 0.5) * CELL_SIZE, z: MIN_Z + (z + 0.5) * CELL_SIZE };
}

async function makeWorld(
  invalidate?: (region?: IShadowRegion) => void,
  now?: () => number,
  rebuildsPerUpdate?: number,
  admissionBudgetMs = Number.POSITIVE_INFINITY,
  position = cellCenter(1, 1),
): Promise<WorldCells> {
  stubRingFetch();
  return WorldCells.load({
    admissionBudgetMs,
    admissionNow: now,
    budgets,
    follow: { position },
    loadModel: async () => model(),
    prefetchSeconds: 0,
    rebuildsPerUpdate,
    ring: 1,
    shadows: { cast: true, castLevels: 1, invalidate },
    surface,
    url: "/world/world.json",
  });
}

/** Every batch mesh on one layer, keyed by the name it draws under. */
function meshesOn(world: WorldCells, mask: number): string[] {
  const names: string[] = [];
  world.traverse((object) => {
    if (!(object instanceof InstancedMesh) || object.layers.mask !== mask) return;
    names.push(object.name);
  });
  return names;
}

/**
 * Whether a level whose window is `extent` wide, centred on the follow point, covers a region. The
 * sun is straight down in this harness, so the node's two window axes are world x and z.
 */
function coversFineWindow(region: IShadowRegion, follow: { x: number; z: number }): boolean {
  return (
    region.min.x <= follow.x + FINE_EXTENT &&
    region.max.x >= follow.x - FINE_EXTENT &&
    region.min.z <= follow.z + FINE_EXTENT &&
    region.max.z >= follow.z - FINE_EXTENT
  );
}

function cameraAt(x: number, z: number): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1.7, 0.1, 900);
  camera.position.set(x, 12, z);
  camera.lookAt(x + 60, 0, z);
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  return camera;
}

/** What a shadow level's own last render submitted, and the mask it rendered it through. */
interface ILevelDraws {
  readonly masks: Map<number, number>;
  readonly submitted: Map<number, Set<string>>;
}

interface ILevelNode {
  readonly shadow: { camera: PerspectiveCamera };
  updateShadow(frame: NodeFrame): void;
}

/**
 * One shadow level's render as three performs it, minus the window cull: the level camera's layers
 * decide what exists for the pass, and the survivors are the draw. The cull is deliberately not
 * mirrored — the level's near/far come out of `#deriveDepth`'s own pool of casters, so a harness
 * camera would be culling against a span this test is not about — and the node build that follows a
 * real submission needs a GPU. What is under test here is which layer each level renders.
 */
function mirrorLevelRenders(node: VirtualShadowNode, root: Object3D, sink: ILevelDraws): void {
  for (const mover of node.moverNodes)
    (mover as unknown as ILevelNode).updateShadow = () => undefined;
  node.levelNodes.forEach((levelNode, index) => {
    (levelNode as unknown as ILevelNode).updateShadow = (): void => {
      const camera = (levelNode as unknown as ILevelNode).shadow.camera;
      sink.masks.set(index, camera.layers.mask);
      const names = new Set<string>();
      root.traverse((object) => {
        const mesh = object as InstancedMesh;
        if ((mesh as { isMesh?: boolean }).isMesh !== true) return;
        if (mesh.visible !== true || mesh.castShadow !== true) return;
        if ((mesh.layers.mask & camera.layers.mask) === 0) return;
        names.add(mesh.name);
      });
      sink.submitted.set(index, names);
    };
  });
}

const builder = {
  context: {},
  material: {},
  renderer: { shadowMap: { enabled: true } },
} as unknown as NodeBuilder;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a streamed world's shadow invalidation", () => {
  it("batches pure admissions with their own source bounds", async () => {
    const regions: (IShadowRegion | undefined)[] = [];
    let clock = 0;
    const world = await makeWorld(
      (region) => regions.push(region),
      () => clock,
    );
    try {
      for (let frame = 0; frame < 80; frame += 1) {
        world.update();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      regions.length = 0;
      clock = 1000;
      world.update();
      expect(regions).toHaveLength(1);
      expect(regions[0]).toMatchObject({ admission: true });
      const first = cellCenter(0, 0);
      const last = cellCenter(2, 2);
      expect(regions[0]).toMatchObject({
        min: { x: first.x - 1, y: -2, z: first.z - 1 },
        max: { x: last.x + 1, y: 2, z: last.z + 1 },
      });
      clock = 2000;
      world.update();
      expect(regions).toHaveLength(1);
    } finally {
      world.dispose();
    }
  });

  it("keeps admissions and evictions in separate rate-limited regions", async () => {
    const regions: (IShadowRegion | undefined)[] = [];
    const position = cellCenter(0, 0);
    let clock = 0;
    const world = await makeWorld(
      (region) => regions.push(region),
      () => clock,
      undefined,
      Number.POSITIVE_INFINITY,
      position,
    );
    try {
      for (let frame = 0; frame < 80; frame += 1) {
        world.update();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      clock = 1000;
      world.update();
      regions.length = 0;
      Object.assign(position, cellCenter(1, 2));
      for (let frame = 0; frame < 80; frame += 1) {
        world.update();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      expect(regions).toHaveLength(0);
      clock = 2000;
      world.update();
      expect(regions).toHaveLength(2);
      const admission = regions.find((region) => region?.admission === true);
      const eviction = regions.find((region) => region !== undefined && !region.admission);
      expect(admission).toBeDefined();
      expect(eviction).toBeDefined();
      expect(eviction?.max.z).toBe(cellCenter(1, 0).z + 1);
      expect(admission?.max.x).toBe(cellCenter(2, 2).x + 1);
      // Hysteresis and refiltering choose the changed cells; every edge still comes from a source.
      for (const region of [admission, eviction]) {
        expect(region).toMatchObject({ min: { y: -2 }, max: { y: 2 } });
        for (const axis of ["x", "z"] as const) {
          const centers = [0, 1, 2].map((index) => cellCenter(index, index)[axis]);
          expect(centers.map((center) => center - 1)).toContain(region?.min[axis]);
          expect(centers.map((center) => center + 1)).toContain(region?.max[axis]);
        }
      }
      clock = 3000;
      world.update();
      expect(regions).toHaveLength(2);
    } finally {
      world.dispose();
    }
  });

  it("hands the levels the changed records' own bounds, so a change far from the player leaves the fine level alone", async () => {
    const regions: (IShadowRegion | undefined)[] = [];
    // The world's own clock, which jumps a second per reading: the tell is at most one a second,
    // and a budget of a millisecond against that clock is one admission unit an update — so each
    // tell carries one build's records rather than a burst's.
    let clock = 0;
    const ticking = (): number => {
      clock += 1e3;
      return clock;
    };
    const world = await makeWorld((region) => regions.push(region), ticking, 1, 1);
    new Group().add(world);
    for (let frame = 0; frame < 600; frame += 1) {
      world.update();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (frame > 4 && world.stats().admission.backlog === 0 && world.stats().loadsInFlight === 0)
        break;
    }

    const told = regions.filter((region): region is IShadowRegion => region !== undefined);
    expect(told.length, "the world never told the levels which records changed").toBeGreaterThan(0);

    // One record a cell, so the answer is that record: `pine` is 2 m across and 4 m tall. A 64 m
    // cell box, or the 256 m extent, would be the other two answers.
    const widest = Math.max(...told.map((region) => region.max.x - region.min.x));
    const tallest = Math.max(...told.map((region) => region.max.y - region.min.y));
    expect(widest, "a region was wider than the records that changed").toBeLessThanOrEqual(2.001);
    expect(
      tallest,
      "a region was taller than the asset bounds of the records that changed",
    ).toBeLessThanOrEqual(4.001);
    expect(widest, "no record bounds were told at all").toBeGreaterThan(0);

    // The claim in the level's own terms: a change 100 m out does not reach a 48 m window, and the
    // change in the cell under the player does.
    const follow = cellCenter(1, 1);
    const far = told.filter(
      (region) =>
        Math.hypot(
          (region.min.x + region.max.x) / 2 - follow.x,
          (region.min.z + region.max.z) / 2 - follow.z,
        ) > 90,
    );
    expect(far.length, "no change outside the fine window was told about").toBeGreaterThan(0);
    for (const region of far)
      expect(
        coversFineWindow(region, follow),
        "a change 90 m from the follow point still reached the 48 m window",
      ).toBe(false);
    expect(
      told.filter((region) => coversFineWindow(region, follow)).length,
      "the change under the follow point never reached the 48 m window",
    ).toBeGreaterThan(0);
    world.dispose();
  });

  it("keeps resolvable ground-cover shadows on coarse levels as well as the fine level", async () => {
    const scene = new Scene();
    const light = new DirectionalLight(0xffffff, 1);
    // Off vertical: a sun exactly overhead leaves the level camera's own placement degenerate,
    // and a mirror of three's cull has to mirror a camera that points at its window.
    light.position.set(60, 200, -40);
    light.castShadow = true;
    scene.add(light, light.target);
    const node = new VirtualShadowNode(light, {
      clipExtents: [FINE_EXTENT, 192],
      mapSize: 1024,
      marker: false,
    });
    node.setup(builder);
    const draws: ILevelDraws = { masks: new Map(), submitted: new Map() };
    const follow = { position: cellCenter(1, 1) };
    // The hook a game passes: streamed records have to reach the levels, or a level that holds its
    // map never re-reads the batches the walk wrote into them.
    const world = await makeWorld(() => node.invalidateAll());
    scene.add(world);
    mirrorLevelRenders(node, scene, draws);

    let clock = 0;
    const step = async (): Promise<void> => {
      const camera = cameraAt(follow.position.x, follow.position.z);
      world.update(undefined, camera);
      clock += 1;
      node.updateBefore({ camera, renderer: {}, time: clock } as unknown as NodeFrame);
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    // The node has to run *through* the load: a prewarmed caster's first draw is a level render, and
    // a level rendering while one is owed takes every caster layer, which is the prewarm's promise
    // and would hide the choice this is about.
    for (let frame = 0; frame < 400; frame += 1) {
      await step();
      if (frame > 8 && world.stats().pendingPrewarm === 0) break;
    }
    expect(world.stats().pendingPrewarm, "the prewarm never settled").toBe(0);
    // A metre a frame, which moves both windows and re-renders both levels with nothing owed.
    for (let frame = 0; frame < 12; frame += 1) {
      follow.position.x += 1;
      await step();
    }

    // The layers themselves: ground cover's wide half is alone on the small-caster layer, pine's on
    // the wide one, and ground cover keeps its clusters on the layer a fine level picks.
    const small = meshesOn(world, SMALL_MASK);
    const wide = meshesOn(world, WIDE_MASK);
    const clusters = meshesOn(world, CLUSTER_MASK);
    expect(
      small.length,
      "no ground cover wide caster was culled to the finest level",
    ).toBeGreaterThan(0);
    for (const name of small)
      expect(name.startsWith(`${SMALL_ASSET}:`), `${name} is not ground cover`).toBe(true);
    for (const name of wide)
      expect(name.startsWith(`${TALL_ASSET}:`), `${name} is not a pine`).toBe(true);
    expect(
      clusters.some((name) => name.startsWith(`${SMALL_ASSET}:`)),
      "ground cover lost its caster clusters",
    ).toBe(true);

    // Both levels resolve this fixture's metre-wide parts; authored height cannot drop them.
    expect(
      ((draws.masks.get(0) ?? 0) & SMALL_MASK) !== 0,
      "the finest level did not render the small-caster layer",
    ).toBe(true);
    expect(
      (draws.masks.get(1) ?? 0) & SMALL_MASK,
      "the coarse level lost resolved small casters",
    ).toBe(SMALL_MASK);
    const fine = draws.submitted.get(0) ?? new Set<string>();
    const coarse = draws.submitted.get(1) ?? new Set<string>();
    expect(
      [...fine].some((name) => name.startsWith(`${SMALL_ASSET}:`)),
      "the finest level drew no ground cover caster",
    ).toBe(true);
    expect(
      [...coarse].some((name) => name.startsWith(`${SMALL_ASSET}:`)),
      "the coarse level lost a resolved ground-cover caster",
    ).toBe(true);
    expect(
      [...coarse].some((name) => name.startsWith(`${TALL_ASSET}:`)),
      "a wide level stopped drawing a tree's caster",
    ).toBe(true);
    world.dispose();
    node.dispose();
  });
});
