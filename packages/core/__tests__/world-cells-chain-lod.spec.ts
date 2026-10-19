import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DISCRETE_LOD_SCHEMA_VERSION,
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
} from "../src/model-lod.js";
import { type IWorldPackage, WorldCells } from "../src/world.js";

/**
 * A world asset with no `lods` of its own is drawn at the levels its own model's baked AutoLOD chain
 * carries, switched at the distance each level's error projects over.
 *
 * The chain here is a fake one over a fake model — a 16-triangle grid reduced to 8 and then to 4,
 * with absolute errors a test chose — registered through the real `DiscreteLodPlugin` over a parser
 * that answers with those index arrays, so the registration under test is the real one. Everything
 * the world then does with it is the ordinary level machinery: a batch key per (level, part), the
 * prewarm, and a refilter when the follow point crosses a switch.
 */

const fixture = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "world-v1");
const manifest = JSON.parse(
  readFileSync(path.join(fixture, "world.json"), "utf8"),
) as IWorldPackage;

const surface = new MeshBasicMaterial();
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };

/** Pixels per world unit at unit depth, for the default 60° over 1080 raster rows. */
const PIXELS_PER_UNIT = 1080 / (2 * Math.tan(Math.PI / 6));
/** The chain's absolute errors, so every switch distance below is a number the test can check. */
const ERRORS = [0.05, 0.2];
const LOD0_TRIANGLES = 16;
const LEVEL_TRIANGLES = [8, 4];

/**
 * A two-part asset whose parts carry chains of *different* depth: bark reduces 4742 -> 1128 in one
 * terminal step with a large error, needles 11222 -> 5759 -> 2904 -> 1500. The shallow part's
 * terminal error is bigger than the deep part's middle errors — the scots pine shape that collapsed
 * the merged chain to two levels and drew needles level 1 at 394 m.
 */
const BARK_LOD0 = 4742;
const BARK_COUNTS = [1128];
const BARK_ERRORS = [2.0];
const NEEDLE_LOD0 = 11222;
const NEEDLE_COUNTS = [5759, 2904, 1500];
const NEEDLE_ERRORS = [0.4, 0.6, 1.0];
const [BARK_LAST = 0] = BARK_COUNTS;
const [NEEDLE_FIRST = 0, NEEDLE_SECOND = 0, NEEDLE_LAST = 0] = NEEDLE_COUNTS;
/** Level 0 draws both parts whole; above it a part at its last level keeps that level's shape. */
const MERGED_TRIANGLES = [
  BARK_LOD0 + NEEDLE_LOD0,
  BARK_LAST + NEEDLE_FIRST,
  BARK_LAST + NEEDLE_SECOND,
  BARK_LAST + NEEDLE_LAST,
];

/**
 * The budget the chain is registered with, and the one the world batches at by default. They are
 * different numbers on purpose, and the gap is the point: see `IWorldCellsLoadOptions.autoLod`.
 */
const REGISTERED_PIXEL_ERROR = 1;
const AUTO_LOD_PIXEL_ERROR = 4;

/** Where a level of the chain takes over at the default projection and the default batched budget. */
const SWITCH = ERRORS.map((error) => (error * PIXELS_PER_UNIT) / AUTO_LOD_PIXEL_ERROR);
/** The deep chain's switches: the merged chain keeps every one of them, in order. */
const MERGED_SWITCH = NEEDLE_ERRORS.map(
  (error) => (error * PIXELS_PER_UNIT) / AUTO_LOD_PIXEL_ERROR,
);
/** The same switches at the budget the chain was registered with, which is `SWITCH` times four. */
const REGISTERED_SWITCH = ERRORS.map((error) => (error * PIXELS_PER_UNIT) / REGISTERED_PIXEL_ERROR);

// --- The fake chain, registered the way the loader registers a real one -----------------------

function gridIndices(triangles: number): Uint32Array {
  const indices = new Uint32Array(triangles * 3);
  for (let quad = 0; quad < triangles / 2; quad += 1) {
    const at = quad * 6;
    indices[at] = quad * 2;
    indices[at + 1] = quad * 2 + 1;
    indices[at + 2] = quad * 2 + 2;
    indices[at + 3] = quad * 2 + 1;
    indices[at + 4] = quad * 2 + 3;
    indices[at + 5] = quad * 2 + 2;
  }
  return indices;
}

function gridGeometry(): BufferGeometry {
  const quads = LOD0_TRIANGLES / 2;
  const positions = new Float32Array((quads + 1) * 2 * 3);
  for (let vertex = 0; vertex <= quads; vertex += 1) {
    const at = (vertex / quads - 0.5) * 2;
    positions.set([at, 0, at, at, 1, at], vertex * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(gridIndices(LOD0_TRIANGLES), 1));
  return geometry;
}

/**
 * One primitive carrying a baked `TN_discrete_lod` chain, registered against `mesh`'s geometry by
 * the real plugin: the parser is the only fake part, and it hands back the level index arrays the
 * chain is written from.
 */
async function chainedModel(maxPixelError: number): Promise<Group> {
  const group = new Group();
  const mesh = new Mesh(gridGeometry(), new MeshBasicMaterial());
  group.add(mesh);
  const levels = LEVEL_TRIANGLES.map((triangles) => gridIndices(triangles));
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map<object, { meshes: number; primitives: number }>([
      [mesh, { meshes: 0, primitives: 0 }],
    ]),
    getDependency: async (_type: string, index: number) => ({ array: levels[index] }),
    json: {
      meshes: [
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: {
                  absoluteErrors: ERRORS,
                  counts: LEVEL_TRIANGLES,
                  errors: ERRORS,
                  indices: [0, 1],
                  lod0Triangles: LOD0_TRIANGLES,
                  schemaVersion: DISCRETE_LOD_SCHEMA_VERSION,
                },
              },
            },
          ],
        },
      ],
    },
  });
  await plugin.afterRoot({});
  plugin.attach(group, { hysteresis: 0.15, maxPixelError });
  return group;
}

/** A mesh of `triangles` triangles over one quad; only the index count is under test. */
function quadGeometry(triangles: number): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    "position",
    new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3),
  );
  const indices = new Uint32Array(triangles * 3);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const at = triangle * 3;
    indices[at] = 0;
    indices[at + 1] = 1;
    indices[at + 2] = 2;
  }
  geometry.setIndex(new BufferAttribute(indices, 1));
  return geometry;
}

/**
 * The two-part asset the scots pine is: bark and needles, each with its own baked chain, registered
 * through the real plugin exactly as {@link chainedModel} registers one. `needleAlpha` makes the
 * needles part alpha-cutout foliage, the shape whose reduced cards drop the silhouette.
 */
async function chainedTwoPartModel(
  options: { readonly needleAlpha?: boolean } = {},
): Promise<Group> {
  const group = new Group();
  const bark = new Mesh(quadGeometry(BARK_LOD0), new MeshBasicMaterial());
  const needles = new Mesh(quadGeometry(NEEDLE_LOD0), new MeshBasicMaterial());
  if (options.needleAlpha === true) needles.material.transparent = true;
  group.add(bark);
  group.add(needles);
  const levels = [...BARK_COUNTS, ...NEEDLE_COUNTS].map((triangles) => {
    const indices = new Uint32Array(triangles * 3);
    for (let triangle = 0; triangle < triangles; triangle += 1) {
      const at = triangle * 3;
      indices[at] = 0;
      indices[at + 1] = 1;
      indices[at + 2] = 2;
    }
    return indices;
  });
  const def = (lod0Triangles: number, counts: number[], errors: number[], indices: number[]) => ({
    absoluteErrors: errors,
    counts,
    errors,
    indices,
    lod0Triangles,
    schemaVersion: DISCRETE_LOD_SCHEMA_VERSION,
  });
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations: new Map<object, { meshes: number; primitives: number }>([
      [bark, { meshes: 0, primitives: 0 }],
      [needles, { meshes: 1, primitives: 0 }],
    ]),
    getDependency: async (_type: string, index: number) => ({ array: levels[index] }),
    json: {
      meshes: [
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: def(
                  BARK_LOD0,
                  BARK_COUNTS,
                  BARK_ERRORS,
                  BARK_COUNTS.map((_count, index) => index),
                ),
              },
            },
          ],
        },
        {
          primitives: [
            {
              extensions: {
                [TN_DISCRETE_LOD]: def(
                  NEEDLE_LOD0,
                  NEEDLE_COUNTS,
                  NEEDLE_ERRORS,
                  NEEDLE_COUNTS.map((_count, index) => BARK_COUNTS.length + index),
                ),
              },
            },
          ],
        },
      ],
    },
  });
  await plugin.afterRoot({});
  plugin.attach(group, { hysteresis: 0.15, maxPixelError: REGISTERED_PIXEL_ERROR });
  return group;
}

// --- The world, served from the committed package ---------------------------------------------

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

function stubManifestFetch(pkg: IWorldPackage): void {
  const body = JSON.stringify(pkg);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown): Promise<object> => {
      const url = String(input);
      if (url.endsWith("world.json")) {
        return {
          arrayBuffer: async () => new TextEncoder().encode(body).buffer as ArrayBuffer,
          headers: new Headers(),
          json: async () => pkg,
          ok: true,
          status: 200,
        };
      }
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

/** The fixture's `pine` with its authored `lods` removed, so only a chain can widen it. */
function withoutAuthoredLods(): IWorldPackage {
  const pine = manifest.assets.pine;
  if (pine === undefined) throw new Error("the committed package has no pine asset.");
  return {
    ...manifest,
    assets: { ...manifest.assets, pine: { bounds: pine.bounds, glb: pine.glb } },
    // One asset, so one refilter is one asset: the cell's other two runs have gates of their own.
    cells: manifest.cells
      .filter((cell) => cell.x === 1 && cell.z === 1)
      .map((cell) => ({
        ...cell,
        chunks: [],
        runs: cell.runs.filter((run) => run.asset === "pine"),
      })),
  };
}

/** A model with nothing baked into it, for every path in the package but `pine`. */
function plainModel(): Group {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
}

/** The chained model for `pine`, a plain one for every other path the world asks for. */
function chainLoader(chained: Group): (url: string) => Promise<Object3D> {
  return async (url) => (url.includes("pine.glb") ? chained : plainModel());
}

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

/** The caster layer masks, from `render/virtual-shadow.ts`; the main camera renders neither. */
const CLUSTER_LAYER = 1 << 28;
const WIDE_LAYER = 1 << 27;
/** The wide half for ground cover, which only the finest level renders; see `smallCasterMetres`. */
const SMALL_WIDE_LAYER = 1 << 26;

/** Every batch mesh on one caster layer, by name. */
function castersOn(world: WorldCells, mask: number): Map<string, InstancedMesh> {
  const out = new Map<string, InstancedMesh>();
  world.traverse((object: Object3D) => {
    if (object instanceof InstancedMesh && object.layers.mask === mask)
      out.set(object.name, object);
  });
  return out;
}

/** The one mesh a key drew as a wide caster, `key@*`. */
function wideCaster(world: WorldCells, key: string): InstancedMesh | undefined {
  return (
    castersOn(world, WIDE_LAYER).get(`${key}@*`) ??
    castersOn(world, SMALL_WIDE_LAYER).get(`${key}@*`)
  );
}

/** The live caster cluster of a key, `key@x,z`, in the square one shadow level's window covers. */
function fineCaster(world: WorldCells, key: string): InstancedMesh | undefined {
  return [...castersOn(world, CLUSTER_LAYER)].find(
    ([name, mesh]) => name.startsWith(`${key}@`) && mesh.count > 0,
  )?.[1];
}

function trianglesOf(mesh: InstancedMesh | undefined): number {
  const geometry = mesh?.geometry;
  if (geometry === undefined) return 0;
  const drawn = geometry.index?.count ?? geometry.getAttribute("position")?.count ?? 0;
  return Math.floor(drawn / 3);
}

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

/** How far each live instance of `mesh` is from the follow point. */
function drawnDistances(
  mesh: InstancedMesh | undefined,
  follow: { x: number; z: number },
): number[] {
  if (mesh === undefined) return [];
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

async function flush(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Let the loads settle, then step again: adopting a model queues the batches, it does not build. */
async function flushed(world: WorldCells): Promise<void> {
  for (let pass = 0; pass < 200; pass += 1) {
    await flush();
    world.update();
    const stats = world.stats();
    // `deferred` is the job queue, and a build waiting on the frame's fresh-mesh allowance has
    // nothing left in `backlog` — so without it a three-level asset is reported finished one mesh
    // short of drawn.
    if (
      stats.admission.backlog === 0 &&
      stats.admission.deferred === 0 &&
      stats.loadsInFlight === 0
    )
      return;
  }
}

function markers(): string[] {
  return (console.info as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.startsWith("TN_WORLD_LOD_CHAIN"));
}

function loadWorld(options: Parameters<typeof WorldCells.load>[0]): Promise<WorldCells> {
  return WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    prefetchSeconds: 0,
    ...options,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("WorldCells with a baked AutoLOD chain and no authored lods", () => {
  it.each([{ lods: undefined }, { lods: [] }] as const)(
    "draws compatible baked levels with authored metadata %j",
    async ({ lods }) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const model = await chainedModel(REGISTERED_PIXEL_ERROR);
      const chain = lodChainOf((model.children[0] as Mesh).geometry);
      const source = withoutAuthoredLods();
      stubManifestFetch({
        ...source,
        assets: {
          ...source.assets,
          pine: {
            ...(source.assets.pine as NonNullable<IWorldPackage["assets"][string]>),
            ...(lods === undefined ? {} : { lods }),
          },
        },
      });

      const follow = { position: { x: -64, z: -64 } };
      const world = await loadWorld({
        budgets,
        follow,
        loadModel: chainLoader(model),
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);

      // The asset is now drawn at three levels, switched at
      // `error * pixelsPerUnit / autoLod.maxPixelError` — the world's 4 px budget, not the 1 px the
      // chain was registered with — level 0 leading at 0. Triangles fall 16 -> 8 -> 4, the reduction
      // the whole line is about.
      expect(markers()).toEqual([
        `TN_WORLD_LOD_CHAIN pine: levels=3 distances=0.0,${SWITCH[0]?.toFixed(1)},${SWITCH[1]?.toFixed(1)} tris=16,8,4`,
      ]);
      expect(chain?.levels.length).toBe(3);

      // Every level is an ordinary one: its own batch key, holding the chain's own geometry, and the
      // placements split across them at the reported distances. The follow point is on cell (1,1)'s
      // corner, so the run reaches 83 m — past both switches.
      const levels = [0, 1, 2].map((level) => levelMesh(world, "pine", level) as InstancedMesh);
      for (const [level, mesh] of levels.entries())
        expect(mesh.geometry).toBe(chain?.levels[level]);
      expect(levels.reduce((sum, mesh) => sum + liveCount(mesh), 0)).toBe(85);
      for (const [level, mesh] of levels.entries()) {
        const lower = level === 0 ? 0 : (SWITCH[level - 1] as number);
        // `SWITCH` is one shorter than the levels: nothing bounds the last one's far side.
        const upper = SWITCH[level];
        for (const distance of drawnDistances(mesh, follow.position)) {
          expect(distance).toBeGreaterThan(lower);
          if (upper !== undefined) expect(distance).toBeLessThanOrEqual(upper);
        }
      }
      expect(world.stats().failures).toBe(0);
      world.dispose();
    },
  );

  it.each(["section", "attributes", "wind", "alpha"] as const)(
    "retains prepared source detail for incompatible empty-LOD %s",
    async (reason) => {
      vi.spyOn(console, "info").mockImplementation(() => undefined);
      const model = await chainedModel(REGISTERED_PIXEL_ERROR);
      const mesh = model.children[0] as Mesh;
      if (reason === "section") mesh.geometry.setDrawRange(0, 12);
      if (reason === "attributes")
        mesh.geometry.setAttribute("inner", new BufferAttribute(new Float32Array(12), 1));
      if (reason === "wind") Reflect.set(mesh.material, "positionNode", {});
      if (reason === "alpha") (mesh.material as MeshBasicMaterial).alphaTest = 0.5;
      const source = withoutAuthoredLods();
      stubManifestFetch({
        ...source,
        assets: {
          ...source.assets,
          pine: {
            ...(source.assets.pine as NonNullable<IWorldPackage["assets"][string]>),
            lods: [],
          },
        },
      });
      const world = await loadWorld({
        budgets,
        follow: { position: { x: -64, z: -64 } },
        loadModel: chainLoader(model),
        ring: 0,
        surface,
        url: "/world/world.json",
        preserveAuthoredParts: true,
        adaptiveLod: false,
      });
      try {
        world.update();
        await flushed(world);
        expect(markers()).toEqual([]);
        expect(levelMesh(world, "pine", 1)).toBeUndefined();
        expect(levelMesh(world, "pine", 0)?.geometry).toBe(mesh.geometry);
        expect(world.stats().failures).toBe(0);
      } finally {
        world.dispose();
      }
    },
  );

  it("keeps every level of the deepest part's chain when a sibling's chain is shallower", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedTwoPartModel();
    stubManifestFetch(withoutAuthoredLods());

    const follow = { position: { x: -64, z: -64 } };
    const world = await loadWorld({
      budgets,
      follow,
      loadModel: chainLoader(model),
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // Four levels, not two: needles walks its whole ladder at the distances its own errors project
    // to, and bark — whose one-step chain cannot offer a finer shape past level 1 — rides along at
    // its last shape instead of collapsing its sibling's intermediate levels away.
    const distances = MERGED_SWITCH.map((distance) => distance.toFixed(1)).join(",");
    expect(markers()).toEqual([
      `TN_WORLD_LOD_CHAIN pine: levels=4 distances=0.0,${distances} ` +
        `tris=${MERGED_TRIANGLES.join(",")}`,
    ]);
    for (let level = 1; level < MERGED_SWITCH.length; level += 1)
      expect(MERGED_SWITCH[level] as number).toBeGreaterThan(MERGED_SWITCH[level - 1] as number);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("reduces the alpha needles down their own chain, not to the root card at every level", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    // Alpha needles and opaque bark, each descending its own baked chain. `impostors: false`
    // isolates the chain: this is not the atlas's coverage path.
    const model = await chainedTwoPartModel({ needleAlpha: true });
    const barkChain = lodChainOf((model.children[0] as Mesh).geometry);
    const needleChain = lodChainOf((model.children[1] as Mesh).geometry);
    stubManifestFetch(withoutAuthoredLods());

    const world = await loadWorld({
      budgets,
      follow: { position: { x: -64, z: -64 } },
      impostors: false,
      loadModel: chainLoader(model),
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The deep needle chain still sets the ladder: four levels, not two. Every part draws its own
    // chain's shape, so the triangles fall along the merged ladder rather than pinning the leaf card.
    const distances = MERGED_SWITCH.map((distance) => distance.toFixed(1)).join(",");
    expect(markers()).toEqual([
      `TN_WORLD_LOD_CHAIN pine: levels=4 distances=0.0,${distances} tris=${MERGED_TRIANGLES.join(",")}`,
    ]);

    // The alpha needles descend their own chain at the middle levels: the authored reduction is
    // kept, not replaced by the root leaf card. Bark clamps to its one-step chain's last shape.
    const barkShapes = [0, 1, 1, 1].map((level) => barkChain?.levels[level]);
    const needleShapes = [0, 1, 2, 3].map((level) => needleChain?.levels[level]);
    for (const level of [0, 1, 2, 3]) {
      expect(levelMesh(world, "pine", level, 0)?.geometry).toBe(barkShapes[level]);
      expect(levelMesh(world, "pine", level, 1)?.geometry).toBe(needleShapes[level]);
    }
    expect(needleChain?.levels[1]).not.toBe(needleChain?.levels[0]);
    expect(world.stats().failures).toBe(0);
    world.dispose();
  });

  it("keeps the package's own lods when it names them, chain or not", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    // Both levels are alpha-cutout foliage, the shape the rejected coverage pass forced back to the
    // root card: the authored middle must still draw its own geometry at its own distance.
    ((model.children[0] as Mesh).material as MeshBasicMaterial).transparent = true;
    const chain = lodChainOf((model.children[0] as Mesh).geometry);
    const lodGeometry: BufferGeometry[] = [];
    // The authored lod, as the pipeline writes it: a second GLB, not a second level of this one.
    const load = async (url: string): Promise<Object3D> => {
      if (url.includes("pine.glb")) return model;
      if (url.includes("pine_lod1")) {
        const group = plainModel();
        const mesh = group.children[0] as Mesh;
        (mesh.material as MeshBasicMaterial).transparent = true;
        lodGeometry.push(mesh.geometry);
        return group;
      }
      return plainModel();
    };
    stubManifestFetch(manifest);

    const follow = { position: { x: -64, z: -64 } };
    const world = await loadWorld({
      budgets,
      follow,
      impostors: false,
      loadModel: load,
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    expect(markers()).toEqual([]);
    expect(chain?.levels.length).toBe(3);
    // The authored shape, at the authored 60 m — not the chain's, and not the 11.7 m the chain's
    // first level would have taken over at under the batched budget.
    const far = levelMesh(world, "pine", 1) as InstancedMesh;
    expect(far.geometry).toBe(lodGeometry[0]);
    expect(far.geometry).not.toBe(chain?.levels[1]);
    for (const distance of drawnDistances(far, follow.position)) {
      expect(distance).toBeGreaterThan(60);
      expect(distance).toBeLessThanOrEqual(83);
    }
    world.dispose();
  });

  it("batches at a 4 px budget, so its switches are a quarter of the chain's own 1 px", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    stubManifestFetch(withoutAuthoredLods());
    const follow = { position: { x: -64, z: -64 } };

    // The same chain, the same world, and only the batched budget's four pixels against the one
    // pixel the loader registered the chain with. Every switch moves inward by exactly the ratio,
    // which is the whole claim: a 1 px budget puts a tree's first switch past most of a 2 km ring.
    const at = async (autoLod: { maxPixelError: number } | undefined): Promise<number[]> => {
      const world = await loadWorld({
        autoLod,
        budgets,
        follow,
        loadModel: chainLoader(model),
        ring: 0,
        surface,
        url: "/world/world.json",
      });
      world.update();
      await flushed(world);
      // The newest line: the mock spans both worlds this test builds, and the second one is the
      // one being read.
      const distances = (markers().at(-1) ?? "").split("distances=")[1]?.split(" tris=")[0];
      world.dispose();
      return (distances ?? "").split(",").map(Number);
    };

    const defaulted = await at(undefined);
    expect(defaulted).toEqual([0, ...SWITCH.map((distance) => Number(distance.toFixed(1)))]);
    const registered = await at({ maxPixelError: REGISTERED_PIXEL_ERROR });
    expect(registered).toEqual([
      0,
      ...REGISTERED_SWITCH.map((distance) => Number(distance.toFixed(1))),
    ]);
    for (const [index, distance] of REGISTERED_SWITCH.entries())
      expect((distance / (defaulted[index + 1] as number)).toFixed(2)).toBe("4.00");
  });

  it("refilters an asset across a chain's switch as the follow point moves", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    stubManifestFetch(withoutAuthoredLods());

    const follow = { position: { x: -64, z: -64 } };
    const world = await loadWorld({
      budgets,
      follow,
      loadModel: chainLoader(model),
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);
    expect(liveCount(levelMesh(world, "pine", 1))).toBeGreaterThan(0);

    // The cell centre is 45 m away — past the first switch, and past the eighth of it a refilter
    // waits for — and from there every placement in the cell is inside the second. The run stops
    // spanning all three levels and splits across the first two.
    follow.position.x = -32;
    follow.position.z = -32;
    world.update();

    expect(world.stats().rebuilds).toBe(1);
    expect(liveCount(levelMesh(world, "pine", 2))).toBe(0);
    expect(liveCount(levelMesh(world, "pine", 0)) + liveCount(levelMesh(world, "pine", 1))).toBe(
      85,
    );
    for (const distance of drawnDistances(levelMesh(world, "pine", 0), follow.position))
      expect(distance).toBeLessThanOrEqual(SWITCH[0] as number);
    for (const distance of drawnDistances(levelMesh(world, "pine", 1), follow.position))
      expect(distance).toBeGreaterThan(SWITCH[0] as number);
    world.dispose();
  });

  it("refilters on the 2 m step, not on the smaller moves inside it", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    stubManifestFetch(withoutAuthoredLods());

    const follow = { position: { x: -64, z: -64 } };
    const world = await loadWorld({
      budgets,
      follow,
      loadModel: chainLoader(model),
      ring: 0,
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);
    expect(world.stats().rebuilds).toBe(0);
    const far = liveCount(levelMesh(world, "pine", 2));

    // Ten updates, 1.9 m in total. The chain's nearest gate is 11.7 m out, so the per-asset
    // hysteresis (an eighth of a gate, 1.46 m) would call this batch stale on the ninth update and
    // the pass used to run every residency pass, scanning every cell to re-derive brackets the
    // answer could not have moved past. The step is 2 m, so it does not: the switch lands within
    // the 2 m the step is allowed to be late by, and nothing is rebuilt early.
    for (let step = 1; step <= 10; step += 1) {
      follow.position.x = -64 + step * 0.19;
      world.update();
    }
    expect(world.stats().rebuilds).toBe(0);
    expect(liveCount(levelMesh(world, "pine", 2))).toBe(far);

    // Past the step the pass runs, and the placements that crossed a switch are rebuilt into the
    // other level: 2.28 m of movement, and level 2 is the band that switch emptied.
    for (let step = 11; step <= 12; step += 1) {
      follow.position.x = -64 + step * 0.19;
      world.update();
    }
    expect(world.stats().rebuilds).toBeGreaterThan(0);
    expect(liveCount(levelMesh(world, "pine", 2))).toBeLessThan(far);

    // And the ring is still right after the walk: every drawn placement is inside its own level's
    // switch band, so a switch that landed 2 m late still landed on the right side of it.
    const levels = [0, 1, 2].map((level) => levelMesh(world, "pine", level) as InstancedMesh);
    for (const [level, mesh] of levels.entries()) {
      for (const distance of drawnDistances(mesh, follow.position)) {
        expect(distance).toBeGreaterThan(level === 0 ? 0 : (SWITCH[level - 1] as number));
        const upper = SWITCH[level];
        if (upper !== undefined) expect(distance).toBeLessThanOrEqual(upper);
      }
    }
    world.dispose();
  });
});

/**
 * A shadow level picks its caster granularity by bill — one mesh per square on
 * `VIRTUAL_SHADOW_CASTER_LAYER`, one mesh per key on the wide layer — so the wide half is what the
 * levels whose window holds the resident ring submit, and their texels are metres across. That half
 * therefore draws the asset's coarsest level, and the cluster half a fine level culls down to its
 * own window keeps level 0. Measured on a 2 km map: 53 M resident caster triangles, every one of
 * them level-0 geometry, and a level render submitting 6-32 M of them.
 */
describe("WorldCells shadow casters over a chain", () => {
  it("draws the coarsest level into the wide half and level 0 into the fine clusters", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    const chain = lodChainOf((model.children[0] as Mesh).geometry);
    stubManifestFetch(withoutAuthoredLods());

    const world = await loadWorld({
      budgets,
      follow: { position: { x: -64, z: -64 } },
      loadModel: chainLoader(model),
      ring: 0,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The wide half: the last level the chain carries, 4 of the 16 triangles the main pass draws
    // for the same records, because the only level that submits it is one whose window holds the
    // ring and whose texels cannot tell the two shapes apart.
    const wide = wideCaster(world, "pine:0:0");
    expect(wide?.geometry, "the wide caster is not drawn").toBe(chain?.levels[2]);
    expect(trianglesOf(wide)).toBe(LEVEL_TRIANGLES[1]);
    expect(wide?.count, "the wide caster holds no records").toBeGreaterThan(0);

    // The fine half: level 0, untouched, for the one level whose window is small enough to cull
    // clusters down to the squares it covers.
    const fine = fineCaster(world, "pine:0:0");
    expect(fine?.geometry, "a fine caster is not drawn").toBe(chain?.levels[0]);
    expect(trianglesOf(fine)).toBe(LOD0_TRIANGLES);
    expect(fine?.layers.mask).toBe(CLUSTER_LAYER);
    expect(wide?.layers.mask).toBe(WIDE_LAYER);

    // The main pass is untouched: it still draws the level the placement selected.
    expect(levelMesh(world, "pine", 0)?.geometry).toBe(chain?.levels[0]);
    world.dispose();
  });

  it("casts the placements past castLevels with the level-0 casters, minting none for them", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    stubManifestFetch(withoutAuthoredLods());

    const world = await loadWorld({
      budgets,
      follow: { position: { x: -64, z: -64 } },
      loadModel: chainLoader(model),
      ring: 0,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // The main pass splits the 85 placements across the chain's three levels; `castLevels` is 1, so
    // only level 0 has casters. Every placement still casts, through level 0's: a tree past its
    // first switch keeps its shadow instead of leaving a hole in the map (PRD-541).
    const drawn = [0, 1, 2].reduce(
      (sum, level) => sum + liveCount(levelMesh(world, "pine", level) as InstancedMesh),
      0,
    );
    expect(drawn).toBe(85);
    expect(liveCount(levelMesh(world, "pine", 1) as InstancedMesh)).toBeGreaterThan(0);
    expect(liveCount(wideCaster(world, "pine:0:0"))).toBe(drawn);
    let clustered = 0;
    for (const [name, mesh] of castersOn(world, CLUSTER_LAYER))
      if (name.startsWith("pine:0:0@")) clustered += liveCount(mesh);
    expect(clustered).toBe(drawn);
    // And no caster for the coarser levels: they cast through level 0's, at no extra mesh.
    for (const mask of [CLUSTER_LAYER, WIDE_LAYER, SMALL_WIDE_LAYER])
      for (const name of castersOn(world, mask).keys())
        expect(name.startsWith("pine:1:") || name.startsWith("pine:2:"), name).toBe(false);
    world.dispose();
  });

  it("leaves an asset with one level drawing the geometry it drew before", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    stubManifestFetch(manifest);

    const world = await loadWorld({
      budgets,
      follow: { position: { x: -64, z: -64 } },
      loadModel: chainLoader(model),
      ring: 0,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });
    world.update();
    await flushed(world);

    // `ground_cover` names a lod at 60 m and culls at 30 m, so it has exactly one level: there is
    // nothing coarser to draw, and both halves keep the shape the main pass draws.
    const main = levelMesh(world, "ground_cover", 0);
    expect(main?.count, "the asset placed nothing").toBeGreaterThan(0);
    const wide = wideCaster(world, "ground_cover:0:0");
    expect(wide?.geometry).toBe(main?.geometry);
    expect(fineCaster(world, "ground_cover:0:0")?.geometry).toBe(main?.geometry);
    world.dispose();
  });

  it("prewarms the wide half out of the coarsest level, so the walk builds no node", async () => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    const model = await chainedModel(REGISTERED_PIXEL_ERROR);
    const chain = lodChainOf((model.children[0] as Mesh).geometry);
    stubManifestFetch(withoutAuthoredLods());

    const world = await loadWorld({
      budgets,
      follow: { position: { x: -64, z: -64 } },
      loadModel: chainLoader(model),
      ring: 0,
      shadows: { cast: true },
      surface,
      url: "/world/world.json",
    });

    // Step until the prewarm has minted the key, which it does empty: the queue is filled the
    // moment the asset is adopted and drained before that asset's builds publish anything into it.
    let prewarmed: InstancedMesh | undefined;
    for (let pass = 0; pass < 200 && prewarmed === undefined; pass += 1) {
      world.update();
      await flush(1);
      prewarmed = wideCaster(world, "pine:0:0");
    }
    expect(prewarmed, "the prewarm never minted the wide caster").toBeDefined();
    expect(prewarmed?.count, "the prewarmed batch already held records").toBe(0);
    expect(prewarmed?.geometry, "the prewarm queued the level-0 geometry").toBe(chain?.levels[2]);

    // And it is the same mesh the walk draws into — the mint happened once, on the loading screen.
    await flushed(world);
    expect(wideCaster(world, "pine:0:0")).toBe(prewarmed);
    expect(prewarmed?.count, "the prewarmed batch took no records").toBeGreaterThan(0);
    expect(prewarmed?.geometry).toBe(chain?.levels[2]);
    world.dispose();
  });
});
