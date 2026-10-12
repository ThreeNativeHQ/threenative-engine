/** PRD-521 box 37. Node drives the REAL WorldCells, with the specs' package/placement data,
 * DiscreteLodPlugin and scripted paths. No private field is exposed and no expected decision is
 * computed by a second implementation. Every output number is committed as its binary64 pattern
 * (matrix roots have already been stored by Three as f32). Inputs keep their original f32 words.
 *
 * Each step's observations are committed as one SHA-256 over their canonical stream (every number as
 * its bit pattern, object members in key order, no whitespace) plus the first 16 of them verbatim, so
 * a failing comparison names one observation instead of carrying 9 MB of table. `--dump=<scene>`
 * prints a scene's full stream for debugging; nothing is lost from the comparison.
 *
 * node --import tsx packages/runtime-native/tests/native-engine/world/world-cells-reference.ts [--check]
 *
 * coverage accounts for EVERY it/it.each declaration in world-cells*.spec.ts. Decision portions of
 * mixed assertions are named explicitly; renderer, GPU, three-object and loader assertions are not
 * claimed. Additional merge probes cover the exact vertex cap, order, indexed/mixed byte accounting,
 * shape cap, zero instances and atomic refusal, boundaries missing from the WorldCells chunk spec.
 */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { format } from "node:util";
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  type Object3D,
} from "three";
import ts from "typescript";
import {
  DISCRETE_LOD_SCHEMA_VERSION,
  DiscreteLodPlugin,
  TN_DISCRETE_LOD,
  lodChainOf,
} from "../../../../core/src/model-lod.js";
import { type IWorldPackage, TerrainTiles, WorldCells } from "../../../../core/src/world.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SPECS = path.resolve(HERE, "../../../../core/__tests__");
const FIXTURE = path.join(SPECS, "fixtures/world-v1");
const OUT = path.join(HERE, "world_cells_reference.json");
const manifest = JSON.parse(
  readFileSync(path.join(FIXTURE, "world.json"), "utf8"),
) as IWorldPackage;
const placementFile = readFileSync(path.join(FIXTURE, "placements.bin"));
const placementBytes = placementFile.buffer.slice(
  placementFile.byteOffset,
  placementFile.byteOffset + placementFile.byteLength,
) as ArrayBuffer;
const heightFile = readFileSync(path.join(FIXTURE, "terrain/heightmap.u16"));
const bits = (n: number): string =>
  `f64:${new BigUint64Array(new Float64Array([n]).buffer)[0]?.toString(16).padStart(16, "0")}`;
function exact(value: unknown): unknown {
  if (typeof value === "number") return bits(value);
  if (Array.isArray(value)) return value.map(exact);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([key, at]) => [key, exact(at)]));
  return value;
}
/** The stream world_cells_test.cpp hashes: every number as its f64 bit pattern, object members in
 * key order, no whitespace. JSON.stringify here and tn::engine::json::stringify there write the same
 * bytes for it, so one digest covers every observation a scene produced. */
function canonical(value: unknown): unknown {
  if (typeof value === "number") return bits(value);
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, at]) => [key, canonical(at)]),
    );
  return value;
}
const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
/** One observation per node compare() visits, plus one per f32 word, numbered across the scene. The
 * first 16 values stay in the table so a failure can name the observation, not only the digest. */
function countObservations(
  state: { count: number; prefix: [number, string][] },
  value: unknown,
): void {
  state.count += 1;
  if (state.prefix.length < 16 && (value === null || typeof value !== "object"))
    state.prefix.push([state.count, JSON.stringify(canonical(value))]);
  if (typeof value === "string" && value.startsWith("f32:")) {
    state.count += (value.length - 4) / 8;
    return;
  }
  if (Array.isArray(value)) for (const item of value) countObservations(state, item);
  else if (value !== null && typeof value === "object")
    for (const item of Object.values(value)) countObservations(state, item);
}
const plain = (): Group => {
  const group = new Group();
  group.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
  return group;
};
interface IPart {
  errors: number[];
  triangles: number[];
  alpha: boolean;
}
function observe(model: Object3D): IPart[] {
  const parts: IPart[] = [];
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof Mesh) || Reflect.get(object, "isSkinnedMesh") === true) return;
    const chain = lodChainOf(object.geometry);
    parts.push({
      alpha:
        !Array.isArray(object.material) &&
        (object.material.transparent || object.material.alphaTest > 0),
      errors: chain === undefined ? [] : [...chain.errors],
      triangles: (chain?.levels ?? [object.geometry]).map((g) =>
        Math.floor((g.index?.count ?? g.getAttribute("position").count) / 3),
      ),
    });
  });
  return parts;
}
async function chained(
  parts: { root: number; counts: number[]; errors: number[]; alpha?: boolean }[],
): Promise<Group> {
  const group = new Group();
  const indices: Uint32Array[] = [];
  const associations = new Map<object, { meshes: number; primitives: number }>();
  const primitives = [];
  for (const [part, spec] of parts.entries()) {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      "position",
      new BufferAttribute(new Float32Array([-0.5, 0, 0, 0.5, 0, 0, 0.5, 1, 0, -0.5, 1, 0]), 3),
    );
    const index = (count: number): Uint32Array => {
      const data = new Uint32Array(count * 3);
      for (let at = 0; at < count; at += 1) data.set([0, 1, 2], at * 3);
      return data;
    };
    geometry.setIndex(new BufferAttribute(index(spec.root), 1));
    const material = new MeshBasicMaterial();
    material.transparent = spec.alpha ?? false;
    const mesh = new Mesh(geometry, material);
    group.add(mesh);
    associations.set(mesh, { meshes: 0, primitives: part });
    const first = indices.length;
    indices.push(...spec.counts.map(index));
    primitives.push({
      extensions: {
        [TN_DISCRETE_LOD]: {
          absoluteErrors: spec.errors,
          counts: spec.counts,
          errors: spec.errors,
          indices: spec.counts.map((_, at) => first + at),
          lod0Triangles: spec.root,
          schemaVersion: DISCRETE_LOD_SCHEMA_VERSION,
        },
      },
    });
  }
  const plugin = new DiscreteLodPlugin();
  plugin.setParser({
    associations,
    getDependency: async (_type: string, index: number) => ({ array: indices[index] }),
    json: { meshes: [{ primitives }] },
  });
  await plugin.afterRoot({});
  plugin.attach(group, { hysteresis: 0.15, maxPixelError: 1 });
  return group;
}
const singleChain = [{ root: 16, counts: [8, 4], errors: [0.05, 0.2] }];
const deepChain = [
  { root: 4742, counts: [1128], errors: [2] },
  { root: 11222, counts: [5759, 2904, 1500], errors: [0.4, 0.6, 1] },
];
const center = (x: number, z: number): [number, number] => [
  manifest.extent.minX + (x + 0.5) * manifest.cellSize,
  manifest.extent.minZ + (z + 0.5) * manifest.cellSize,
];
function selected(
  predicate: (cell: IWorldPackage["cells"][number]) => boolean,
  asset?: string,
): IWorldPackage {
  return {
    ...manifest,
    cells: manifest.cells.filter(predicate).map((cell) => ({
      ...cell,
      chunks: [],
      runs: cell.runs.filter((run) => asset === undefined || run.asset === asset),
    })),
  };
}
const onePine = (): IWorldPackage => {
  const pkg = selected((c) => c.x === 1 && c.z === 1, "pine");
  const pine = pkg.assets.pine;
  if (!pine) throw new Error("fixture has no pine");
  return { ...pkg, assets: { ...pkg.assets, pine: { bounds: pine.bounds, glb: pine.glb } } };
};
interface IAction {
  at?: [number, number];
  dt?: number;
  flush?: boolean;
  dispose?: boolean;
}
interface IScene {
  name: string;
  pkg?: IWorldPackage;
  options?: Record<string, unknown>;
  priced?: boolean;
  chain?: typeof singleChain;
  collider?: boolean;
  fallback?: boolean;
  actions: IAction[];
}
const settle = (at: [number, number], frames = 1): IAction[] => [
  { at, flush: true },
  ...Array.from({ length: frames }, () => ({})),
];
const pathActions = (points: [number, number][]): IAction[] => points.flatMap((at) => settle(at));
const budgets = { bytes: 1_000_000_000, instances: 1_000_000, residentCells: 64 };
const scenes: IScene[] = [
  {
    name: "residencyPath",
    actions: pathActions(
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
        [0, 0],
        [3, 3],
      ].map(([x, z]) => center(x ?? 0, z ?? 0)),
    ),
  },
  {
    name: "eviction",
    options: { ring: 0 },
    actions: [
      ...settle(center(1, 1)),
      ...settle([100_000, 100_000]),
      ...settle(center(1, 1)),
      { dispose: true },
    ],
  },
  {
    name: "cellPressure",
    options: { budgets: { ...budgets, residentCells: 2 } },
    actions: pathActions([center(1, 1), center(3, 3)]),
  },
  ...[1, 2].map((jump) => ({
    name: `jump${jump}`,
    options: { budgets: { ...budgets, residentCells: 4 } },
    actions: pathActions([center(0, 0), center(jump, jump)]),
  })),
  {
    name: "instancePressure",
    options: { budgets: { ...budgets, instances: 369 } },
    actions: pathActions([center(1, 1), center(3, 3)]),
  },
  {
    name: "bytePressure",
    options: { budgets: { ...budgets, bytes: 369 * 32 } },
    actions: pathActions([center(1, 1), center(3, 3)]),
  },
  {
    name: "bytePressureOneShort",
    options: { budgets: { ...budgets, bytes: 369 * 32 - 1 } },
    actions: pathActions([center(1, 1), center(3, 3)]),
  },
  {
    name: "lookahead",
    options: { prefetchSeconds: 1.5 },
    actions: [
      ...Array.from({ length: 30 }, (_, frame) => ({
        at: [center(1, 1)[0] + (frame + 1) * 60 * 0.016, center(1, 1)[1]] as [number, number],
        dt: 16,
        flush: true,
      })),
      { at: [center(1, 1)[0] + 28.8 + 1000, center(1, 1)[1]], dt: 16, flush: true },
      { dt: 16 },
    ],
  },
  {
    name: "maxDistance",
    actions: pathActions(Array.from({ length: 13 }, (_, i) => [-96 + i * 16, -32])),
  },
  {
    name: "authoredLevels",
    options: { ring: 0 },
    actions: pathActions([[-64, -64], [-60, -64], center(1, 1)]),
  },
  {
    name: "farNoGate",
    pkg: selected((c) => c.x >= 1 && c.z >= 1 && !(c.x === 1 && c.z === 1), "pine"),
    options: { ring: 2 },
    actions: pathActions([
      [-96, -96],
      [-104, -96],
    ]),
  },
  {
    name: "oneGateCell",
    pkg: selected((c) => c.z === 1 && (c.x === 1 || c.x === 2), "ground_cover"),
    actions: pathActions([
      [-32, -32],
      [-45, -45],
    ]),
  },
  {
    name: "refilterCap",
    options: { rebuildsPerUpdate: 1, admissionBudgetMs: 1 },
    priced: true,
    actions: [
      ...settle([-32, -32], 200),
      { at: [-12, -32] },
      ...Array.from({ length: 200 }, () => ({})),
    ],
  },
  {
    name: "boundedAdmission",
    options: { admissionBudgetMs: 2 },
    priced: true,
    actions: [...settle(center(1, 1), 240), ...settle(center(3, 3), 240)],
  },
  {
    name: "boundedColliders",
    options: { admissionBudgetMs: 2, terrain: { tileResolution: 9, colliderRadius: 0 } },
    collider: true,
    priced: true,
    actions: [...settle(center(1, 1), 240), ...settle(center(3, 3), 240)],
  },
  {
    // The spec's 50-us allowance, priced deterministically: the forced first tile is uncharged,
    // then one priced tile fits. Do not flush loads, so this isolates terrain's shared budget.
    name: "tinyTerrainAdmission",
    options: { admissionBudgetMs: 0.05 },
    collider: true,
    priced: true,
    actions: [{ at: center(1, 1) }, ...Array.from({ length: 8 }, () => ({}))],
  },
  {
    name: "largeRefilterCap",
    options: { rebuildsPerUpdate: 1e30 },
    actions: pathActions([
      [-32, -32],
      [-12, -32],
    ]),
  },
  {
    name: "terrainBytePressure",
    options: { terrain: { tileResolution: 20_000_001 } },
    actions: [{ at: [0, 0] }, { at: center(1, 1) }],
  },
  { name: "unboundedAdmission", actions: pathActions([center(1, 1), center(3, 3)]) },
  {
    name: "replacement",
    options: { admissionBudgetMs: 1, ring: 0 },
    priced: true,
    actions: [...settle([-64, -64], 100), ...settle(center(1, 1), 100)],
  },
  {
    name: "queuedEviction",
    options: { admissionBudgetMs: 1, ring: 0 },
    priced: true,
    actions: [{ at: center(1, 1), flush: true }, {}, { at: [100_000, 100_000], flush: true }],
  },
  {
    name: "chain",
    pkg: onePine(),
    options: { ring: 0 },
    chain: singleChain,
    actions: [
      ...settle([-64, -64]),
      ...Array.from({ length: 12 }, (_, i) => ({
        at: [-64 + (i + 1) * 0.19, -64] as [number, number],
      })),
      ...settle(center(1, 1)),
    ],
  },
  {
    name: "chainOnePixel",
    pkg: onePine(),
    options: { ring: 0, autoLod: { maxPixelError: 1 } },
    chain: singleChain,
    actions: pathActions([[-64, -64], center(1, 1)]),
  },
  {
    name: "deepChain",
    pkg: onePine(),
    options: { ring: 4 },
    chain: deepChain,
    actions: pathActions([
      [-64, -64],
      [64, -64],
      [180, -64],
      [240, -64],
    ]),
  },
  {
    name: "alphaChain",
    pkg: onePine(),
    options: { ring: 4 },
    chain: deepChain.map((p, i) => ({ ...p, alpha: i === 1 })),
    actions: pathActions([
      [-64, -64],
      [180, -64],
      [240, -64],
    ]),
  },
  {
    name: "authoredWins",
    options: { ring: 0 },
    chain: singleChain.map((p) => ({ ...p, alpha: true })),
    actions: pathActions([[-64, -64], center(1, 1)]),
  },
];
// An order probe makes each cell's assets distinct without changing its record counts or package
// order. assetRefCounts is the real class's insertion-ordered public observation of admissions.
scenes.push(
  {
    name: "authoredFallback",
    options: { ring: 0 },
    fallback: true,
    actions: pathActions([[-64, -64], center(1, 1)]),
  },
  {
    name: "terrainRadius",
    options: { ring: 2, terrain: { tileResolution: 9 } },
    actions: pathActions([center(1, 1)]),
  },
  {
    name: "terrainWide",
    options: { ring: 2, terrain: { tileResolution: 9, streamRadius: 4 } },
    actions: pathActions([center(1, 1)]),
  },
  {
    name: "terrainColliders",
    options: { ring: 1, terrain: { tileResolution: 9, colliderRadius: 0 } },
    collider: true,
    actions: pathActions([center(1, 1), center(2, 1)]),
  },
);
const orderPackage = selected(() => true);
orderPackage.assets = {};
orderPackage.cells = orderPackage.cells.map((cell) => ({
  ...cell,
  runs: cell.runs.map((run) => {
    const name = `c${cell.x}_${cell.z}_${run.asset}`;
    const asset = manifest.assets[run.asset];
    if (!asset) throw new Error(`missing ${run.asset}`);
    orderPackage.assets[name] = { bounds: asset.bounds, glb: `assets/${name}.glb` };
    return { ...run, asset: name };
  }),
}));
scenes.push({
  name: "admissionOrder",
  pkg: orderPackage,
  options: { budgets: { ...budgets, residentCells: 4 } },
  actions: pathActions([center(0, 0), center(2, 2), center(3, 3), center(0, 0)]),
});
const pineRun = manifest.cells[1]?.runs.find((r) => r.asset === "pine");
const pineDef = manifest.assets.pine;
if (!pineRun || !pineDef) throw new Error("missing pine fixture");
scenes.push({
  name: "noGate256",
  pkg: {
    ...manifest,
    assets: {
      ...manifest.assets,
      pine: { bounds: pineDef.bounds, glb: pineDef.glb, maxDistance: 100_000 },
    },
    cellSize: 16,
    cells: Array.from({ length: 256 }, (_, i) => ({
      x: i % 16,
      z: Math.floor(i / 16),
      chunks: [],
      runs: [pineRun],
    })),
  },
  options: { ring: 8, budgets: { ...budgets, residentCells: 256 } },
  actions: [
    ...settle([0, 0]),
    ...Array.from({ length: 20 }, (_, i) => ({ at: [(i + 1) * 2, 0] as [number, number] })),
  ],
});

function fetchPackage(pkg: IWorldPackage): void {
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("world.json")) return new Response(JSON.stringify(pkg));
    if (url.endsWith("placements.bin")) return new Response(placementBytes.slice(0));
    if (url.endsWith("heightmap.u16")) return new Response(new Uint8Array(heightFile));
    return new Response(null, { status: 404 });
  };
}
const rootWords = (roots: number[][]): string =>
  `f32:${roots
    .flat()
    .map((at) =>
      (new Uint32Array(new Float32Array([at]).buffer)[0] ?? 0).toString(16).padStart(8, "0"),
    )
    .join("")}`;
function drawn(world: WorldCells): unknown[] {
  const draws: { key: string; triangles: number; roots: string }[] = [];
  world.traverse((object) => {
    if (!(object instanceof InstancedMesh) || object.name.includes("@")) return;
    if (!/^.+:\d+:\d+$/u.test(object.name)) return;
    const roots: number[][] = [];
    const records = object.instanceMatrix.array;
    for (let at = 0; at < object.count; at += 1) {
      const base = at * 16;
      if (records[base + 15] === 0) continue;
      // Identity part offsets in these fixtures: roots are the original authored placement.
      roots.push([records[base + 12] ?? 0, records[base + 13] ?? 0, records[base + 14] ?? 0]);
    }
    if (roots.length === 0) return;
    roots.sort((a, b) => {
      for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return (a[i] ?? 0) - (b[i] ?? 0);
      return 0;
    });
    draws.push({
      key: object.name,
      triangles: Math.floor(
        (object.geometry.index?.count ?? object.geometry.getAttribute("position").count) / 3,
      ),
      roots: rootWords(roots),
    });
  });
  return draws.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
async function runScene(scene: IScene): Promise<unknown> {
  const pkg = scene.pkg ?? selected(() => true);
  fetchPackage(pkg);
  const chain = scene.chain === undefined ? undefined : await chained(scene.chain);
  const follow = {
    position: { x: scene.actions[0]?.at?.[0] ?? 0, z: scene.actions[0]?.at?.[1] ?? 0 },
  };
  let clock = 0;
  const now = (): number => {
    if (scene.priced) clock += 1;
    return clock;
  };
  const pending: {
    url: string;
    resolve: (model: Object3D) => void;
    reject: (error: Error) => void;
  }[] = [];
  const markers: string[] = [];
  const originalInfo = console.info;
  const originalWarn = console.warn;
  console.warn = () => {};
  console.info = (...values: unknown[]) => {
    const text = String(values[0]);
    if (text.startsWith("TN_WORLD_LOD_CHAIN")) markers.push(text);
  };
  const options: Parameters<typeof WorldCells.load>[0] = {
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    bundles: false,
    concurrency: 12,
    follow,
    freshMeshesPerUpdate: Number.MAX_SAFE_INTEGER,
    gpuScene: false,
    impostors: false,
    loadModel: (url: string) =>
      new Promise<Object3D>((resolve, reject) => pending.push({ url, resolve, reject })),
    prefetchSeconds: 0,
    ring: 1,
    surface: new MeshBasicMaterial(),
    url: "/world/world.json",
    ...scene.options,
    ...(scene.collider ? { createCollider: () => ({ dispose() {} }) } : {}),
    admissionNow: now,
  };
  const world = await WorldCells.load(options);
  const observedTerrain = world.children.find((node) => node instanceof TerrainTiles);
  if (!observedTerrain) throw new Error("WorldCells has no terrain");
  const followTerrain = observedTerrain.follow.bind(observedTerrain);
  let terrainSpent = 0;
  observedTerrain.follow = (...args) => {
    followTerrain(...args);
    terrainSpent = (args[1] as { spentMs?: number } | undefined)?.spentMs ?? 0;
  };
  const steps = [];
  const digests: string[] = [];
  // `--dump=<scene>` prints the full canonical stream of one scene; the table keeps only digests.
  const dump = process.argv.includes(`--dump=${scene.name}`);
  const dumped: string[] = [];
  const observed = { count: 0, prefix: [] as [number, string][] };
  try {
    for (const action of scene.actions) {
      if (action.at) [follow.position.x, follow.position.z] = action.at;
      clock += action.dt ?? 0;
      terrainSpent = 0;
      const companionPending = world.stats().pendingPrewarm > 0;
      if (action.dispose) world.dispose();
      else world.update();
      const stats = world.stats();
      const terrain = world.children.find((node) => node instanceof TerrainTiles);
      const currentDraws = drawn(world);
      const refs = world.assetRefCounts();
      const recorded = {
        residentKeys: stats.residentKeys,
        instances: stats.instances,
        pressure: stats.pressure,
        evictions: stats.evictions,
        refilters: stats.refilters,
        refilterEntries: stats.refilterEntries,
        rebuilds: stats.rebuilds,
        admission: stats.admission,
        terrainSpent,
        refs: Object.entries(refs),
        order:
          scene.name === "admissionOrder"
            ? Object.keys(refs)
                .filter((id) => id.endsWith("_ground_cover"))
                .map((id) => id.slice(1, id.indexOf("_ground_cover")).replace("_", ":"))
            : null,
        draws: currentDraws,
        chainDistances: Object.fromEntries(
          markers
            .map((line) => {
              const match = /^TN_WORLD_LOD_CHAIN (.+): levels=\d+ distances=([^ ]+) /u.exec(line);
              if (!match) throw new Error(`bad marker: ${line}`);
              return [match[1], match[2]?.split(",").map(Number)];
            })
            .filter(([id]) => typeof id === "string" && id in refs),
        ),
        terrain:
          terrain === undefined
            ? null
            : {
                residentKeys: terrain.residentKeys,
                deferred: terrain.deferredAdmissions,
                colliderKeys: terrain.residentColliderKeys,
              },
      };
      const stream = JSON.stringify(canonical(recorded));
      const before = observed.count;
      countObservations(observed, recorded);
      const digest = sha256(stream);
      digests.push(digest);
      if (dump) dumped.push(`step ${steps.length} ${digest} ${stream}`);
      const completed: { id: string; models: IPart[][] }[] = [];
      if (action.flush) {
        // Resolve one asset's complete model list at a time. This controls I/O completion, not
        // WorldCells' decisions: the REAL adoption queues each resident run in its own order.
        for (let round = 0; round < 1000; round += 1) {
          await setImmediate();
          const next = pending[0];
          if (!next) {
            if (world.stats().loadsInFlight === 0 && world.stats().loadsQueued === 0) break;
            if (round === 999) throw new Error(`${scene.name}: unresolved loader`);
            continue;
          }
          const id = Object.keys(pkg.assets).find((id) =>
            next.url.endsWith(pkg.assets[id]?.glb ?? "!"),
          );
          if (!id) throw new Error(`unknown model root ${next.url}`);
          const definition = pkg.assets[id];
          if (!definition) throw new Error(`missing asset ${id}`);
          const paths = [
            definition.glb,
            ...(definition.lods ?? [])
              .filter(
                (lod) =>
                  definition.maxDistance === undefined || lod.distance < definition.maxDistance,
              )
              .map((lod) => lod.glb),
          ];
          const models: IPart[][] = [];
          for (const glb of paths) {
            for (let wait = 0; !pending.some((p) => p.url.endsWith(glb)); wait += 1) {
              if (wait > 100) throw new Error(`no pending ${glb}`);
              await setImmediate();
            }
            const index = pending.findIndex((p) => p.url.endsWith(glb));
            const request = pending.splice(index, 1)[0];
            if (!request) throw new Error(`missing request ${glb}`);
            const model = glb.endsWith("pine.glb") && chain !== undefined ? chain : plain();
            const parts = observe(model);
            if (scene.fallback && glb.includes("_lod")) {
              models.push(models[models.length - 1] as IPart[]);
              request.reject(new Error("spec lod load refusal"));
            } else {
              models.push(parts);
              request.resolve(model);
            }
            await setImmediate();
          }
          completed.push({ id, models });
        }
      }
      steps.push({
        action,
        companionPending,
        completed,
        observations: observed.count - before,
        digest,
      });
    }
    if (dump) console.log(dumped.join("\n"));
    return {
      name: scene.name,
      digest: sha256(`${digests.join("\n")}\n`),
      prefix: observed.prefix,
      manifest: pkg,
      options: exact({
        ring: options.ring,
        residentCells: options.budgets.residentCells,
        instances: options.budgets.instances,
        bytes: options.budgets.bytes,
        admissionBudgetMs: options.admissionBudgetMs,
        rebuildsPerUpdate: options.rebuildsPerUpdate ?? 16,
        concurrency: options.concurrency,
        prefetchSeconds: options.prefetchSeconds,
        fovY: options.autoLod?.fovY ?? 60,
        viewportHeight: options.autoLod?.viewportHeight ?? 1080,
        maxPixelError: options.autoLod?.maxPixelError ?? 4,
      }),
      terrain: {
        tileResolution: options.terrain?.tileResolution ?? 129,
        streamRadius: options.terrain?.streamRadius ?? options.ring,
        colliderRadius: options.terrain?.colliderRadius ?? options.ring,
        createCollider: scene.collider ?? false,
      },
      priced: scene.priced ?? false,
      steps,
    };
  } finally {
    world.dispose();
    console.info = originalInfo;
    console.warn = originalWarn;
  }
}

interface IChunkPart {
  id: number;
  material: number;
  vertices: number;
  indices: number;
  copies: number;
  instanced?: boolean;
  chain?: boolean;
  morph?: boolean;
  normal?: boolean;
  uv?: boolean;
}
const box = (id: number, material: number, copies = 1, instanced = false): IChunkPart => ({
  id,
  material,
  vertices: 24,
  indices: 36,
  copies,
  instanced,
});
const chunkParts = [0, 1, 2].flatMap((material) =>
  Array.from({ length: 4 }, (_, part) => box(material * 4 + part, material)),
);
chunkParts.push(box(12, 0, 5, true));
const chunkScenes = [
  { name: "chunkMaterials", parts: chunkParts, maxTriangles: 43690 },
  { name: "chunkKept", parts: chunkParts, maxTriangles: 1 },
  {
    name: "chunkExcluded",
    parts: [...chunkParts, { ...box(13, 3), chain: true }, { ...box(14, 4), morph: true }],
    maxTriangles: 43690,
  },
  {
    name: "chunkExactCap",
    parts: [
      { id: 0, material: 0, vertices: 65535, indices: 3, copies: 1 },
      { id: 1, material: 1, vertices: 3, indices: 3, copies: 1 },
      { id: 2, material: 0, vertices: 65537, indices: 3, copies: 1 },
      { id: 3, material: 0, vertices: 3, indices: 3, copies: 1 },
    ],
    maxTriangles: 43690,
  },
  {
    name: "chunkOrder",
    parts: [box(0, 2), box(1, 0), box(2, 2), box(3, 1), box(4, 0)],
    maxTriangles: 43690,
  },
  {
    name: "chunkMixedIndex",
    parts: [box(0, 0), { ...box(1, 0), vertices: 36, indices: 0 }],
    maxTriangles: 43690,
  },
  { name: "chunkTriangleBoundary", parts: [box(0, 0), box(1, 0, 5, true)], maxTriangles: 72 },
  { name: "chunkTriangleOneShort", parts: [box(0, 0), box(1, 0, 5, true)], maxTriangles: 71 },
  {
    name: "chunkDetailedShape",
    parts: [{ ...box(0, 0, 2, true), indices: 2049 * 3 }],
    maxTriangles: 100000,
  },
  {
    name: "chunkShapeBoundary",
    parts: [{ ...box(0, 0, 2, true), indices: 2048 * 3 }],
    maxTriangles: 100000,
  },
  { name: "chunkZero", parts: [box(0, 0, 0, true)], maxTriangles: 1 },
  { name: "chunkMissingUv", parts: [box(0, 0), { ...box(1, 0), uv: false }], maxTriangles: 43690 },
  { name: "chunkNoUv", parts: [{ ...box(0, 0), uv: false, normal: false }], maxTriangles: 43690 },
];
async function runChunk(scene: (typeof chunkScenes)[number]): Promise<unknown> {
  const materials = new Map<number, MeshBasicMaterial>();
  const group = new Group();
  const modelChain = await chained(singleChain);
  const sources = new Map<Mesh, number>();
  const normalized: IChunkPart[] = [];
  for (const part of scene.parts) {
    const p: IChunkPart = { normal: true, uv: true, ...part };
    let geometry: BufferGeometry;
    if (p.chain) geometry = (modelChain.children[0] as Mesh).geometry;
    else {
      geometry = new BufferGeometry();
      const positions = new Float32Array(p.vertices * 3);
      for (let at = 0; at < p.vertices; at += 1) positions[at * 3] = p.id;
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      if (p.normal)
        geometry.setAttribute("normal", new BufferAttribute(new Float32Array(p.vertices * 3), 3));
      if (p.uv)
        geometry.setAttribute("uv", new BufferAttribute(new Float32Array(p.vertices * 2), 2));
      if (p.indices > 0) {
        const indices = new Uint16Array(p.indices);
        for (let at = 0; at < indices.length; at += 1) indices[at] = at % Math.min(p.vertices, 3);
        geometry.setIndex(new BufferAttribute(indices, 1));
      }
      if (p.morph) geometry.morphAttributes.position = [geometry.getAttribute("position").clone()];
    }
    if (!materials.has(p.material)) materials.set(p.material, new MeshBasicMaterial());
    const material = materials.get(p.material) as MeshBasicMaterial;
    const mesh = p.instanced
      ? new InstancedMesh(geometry, material, p.copies)
      : new Mesh(geometry, material);
    if (mesh instanceof InstancedMesh)
      for (let at = 0; at < mesh.count; at += 1)
        mesh.setMatrixAt(at, new Matrix4().makeTranslation(0, at, 0));
    group.add(mesh);
    sources.set(mesh, p.id);
    normalized.push({
      ...p,
      vertices: geometry.getAttribute("position").count,
      indices: geometry.index?.count ?? 0,
    });
  }
  const cell = manifest.cells.find((c) => c.x === 1 && c.z === 1);
  if (!cell) throw new Error("missing chunk cell");
  fetchPackage({ ...manifest, cells: [{ ...cell, runs: [], chunks: ["chunks/yard_1_1.glb"] }] });
  const info = console.info;
  const warn = console.warn;
  const error = console.error;
  const mergeMarkers: string[] = [];
  console.info = (...values: unknown[]) => {
    if (String(values[0]).startsWith("TN_WORLD_CHUNK_MERGE")) mergeMarkers.push(String(values[0]));
  };
  console.warn = () => {};
  console.error = () => {};
  const world = await WorldCells.load({
    admissionBudgetMs: Number.POSITIVE_INFINITY,
    budgets,
    bundles: false,
    chunkMergeMaxTriangles: scene.maxTriangles,
    follow: { position: { x: -32, z: -32 } },
    loadModel: async () => group,
    prefetchSeconds: 0,
    ring: 0,
    surface: new MeshBasicMaterial(),
    url: "/world/world.json",
  });
  try {
    let chunk: Object3D | undefined;
    // The attach yields to the host on real time, so the bound is a deadline, not a turn count:
    // 100 updates ran out under parallel ctest load (two "chunk never attached" reds in six runs).
    for (const deadline = performance.now() + 30_000; performance.now() < deadline; ) {
      world.update();
      for (let flush = 0; flush < 4; flush += 1) await setImmediate();
      chunk = world.getObjectByName("world-chunk");
      if (chunk) break;
    }
    if (!chunk) throw new Error(`${scene.name}: chunk never attached`);
    const groups = [];
    const kept: number[] = [];
    chunk.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = sources.get(object);
      if (source !== undefined) {
        kept.push(source);
        return;
      }
      const geometry = object.geometry;
      const positions = geometry.getAttribute("position");
      const tokens: [number, number][] = [];
      let last = "";
      for (let at = 0; at < positions.count; at += 1) {
        const id = positions.getX(at);
        const copy = positions.getY(at);
        const key = `${id}:${copy}`;
        if (key !== last) tokens.push([id, copy]);
        last = key;
      }
      groups.push({
        material: [...materials].find(([, material]) => material === object.material)?.[0],
        vertices: positions.count,
        indices: geometry.index?.count ?? 0,
        indexBytes: geometry.index?.array.byteLength ?? 0,
        bytes:
          Object.values(geometry.attributes).reduce((n, attr) => n + attr.array.byteLength, 0) +
          (geometry.index?.array.byteLength ?? 0),
        parts: tokens,
      });
    });
    const line = mergeMarkers[0];
    const field = (name: string): number => {
      const match = new RegExp(`(?:^| )${name}=(\\d+)`, "u").exec(line ?? "");
      if (!match) throw new Error(`${scene.name}: missing ${name} in ${line}`);
      return Number(match[1]);
    };
    return {
      name: scene.name,
      parts: normalized,
      maxTriangles: scene.maxTriangles,
      expected: exact({
        refused: line === undefined,
        expanded: line === undefined ? 0 : field("instancedExpanded"),
        keptInstanced:
          line === undefined
            ? normalized.filter((p) => p.instanced).length
            : field("keptInstanced"),
        bytes: line === undefined ? 0 : field("bytes"),
        kept,
        groups,
      }),
    };
  } finally {
    world.dispose();
    console.info = info;
    console.warn = warn;
    console.error = error;
  }
}

// Each covered title names the actual scripted fixture. Only the decision portion is claimed.
const covered: Record<string, string[]> = {
  "counts a real terrain byte-budget throw as byte pressure": ["terrainBytePressure"],
  "streams ahead of a moving follow point and keeps the cell it is in": ["lookahead"],
  "keeps exactly the in-ring cells, plus hysteresis, along a scripted path": [
    "residencyPath",
    "admissionOrder",
  ],
  "disposes a leaving cell's batches and returns asset refcounts to zero": ["eviction"],
  "never renders a maxDistance instance beyond its distance": ["maxDistance"],
  "reports cell budget pressure instead of throwing": ["cellPressure"],
  "rejects a concurrency or refilter cap that could never start a load": ["refusals"],
  "draws a far placement with the package's own lod and a near one with the asset's glb": [
    "authoredLevels",
  ],
  "moves a placement's level once the follow point has crossed the switch": ["authoredLevels"],
  "rebuilds nothing when no gate of a far cell's asset can have been crossed": ["farNoGate"],
  "allocates no refilter entry for 256 cells that crossed no gate": ["noGate256"],
  "rebuilds only the cell whose gate the follow point crossed": ["oneGateCell"],
  "refilters at most `rebuildsPerUpdate` cell-assets per update, and finishes them all": [
    "refilterCap",
  ],
  "falls back to the level above when a lod glb will not load": ["authoredFallback"],
  "keeps terrain resident at its own radius while the cell ring stays at the ring": [
    "terrainRadius",
    "terrainWide",
  ],
  "gives only the tiles inside `terrain.colliderRadius` a body, and moves that set": [
    "terrainColliders",
  ],
  "spends at most the budget plus one unit per update, however long the backlog": [
    "boundedAdmission",
  ],
  "keeps building props while the terrain catches up after a jump": ["boundedAdmission"],
  "admits the cells around a jumped camera when the ring it left filled the cell budget": [
    "jump1",
    "jump2",
  ],
  "reports the deferred work and the backlog while it waits, and empties both": [
    "boundedAdmission",
  ],
  "draws what an unbounded build draws, once the backlog has drained": [
    "boundedAdmission",
    "unboundedAdmission",
  ],
  "admits terrain tiles and colliders on the same budget, and still converges": [
    "boundedColliders",
    "tinyTerrainAdmission",
  ],
  "keeps a refiltered cell drawing what it had until the replacement is ready": ["replacement"],
  "drops the queued work of a cell that left, instead of resuming it into a dead graph": [
    "queuedEviction",
  ],
  "refuses a budget that would never admit anything": ["refusals"],
  "draws the chain's levels at the distances their errors project to": ["chain"],
  "keeps every level of the deepest part's chain when a sibling's chain is shallower": [
    "deepChain",
  ],
  "reduces the alpha needles down their own chain, not to the root card at every level": [
    "alphaChain",
  ],
  "keeps the package's own lods when it names them, chain or not": ["authoredWins"],
  "batches at a 4 px budget, so its switches are a quarter of the chain's own 1 px": [
    "chain",
    "chainOnePixel",
  ],
  "refilters an asset across a chain's switch as the follow point moves": ["chain"],
  "refilters on the 2 m step, not on the smaller moves inside it": ["chain"],
  "leaves an asset with one level drawing the geometry it drew before": ["maxDistance"],
  "attaches as one mesh per material, at the vertices the package authored": ["chunkMaterials"],
  "keeps an instanced mesh whose group would cross the triangle cap": ["chunkKept"],
  "leaves a chained or morphed mesh exactly where the package put it": ["chunkExcluded"],
};
const excluded: Record<string, string> = {
  "creates at most freshMeshesPerUpdate new meshes a frame, and still builds them all":
    "Three mesh/pipeline allocation ceiling; decision traces remove that ceiling, retaining the admission time budget.",
  "draws every cell of an asset part and level through one mesh, whatever the ring":
    "Shared Three mesh identity/count, not residency or per-placement LOD selection.",
  "drops a chunk load whose cell left range before it resolved":
    "Asynchronous loader cancellation and late Object3D attachment; cell/queued-decision eviction is reproduced, no native Object3D loader is ported here.",
  "rethrows a game's terrain error instead of reporting it as byte pressure":
    "Game callback exception identity/propagation, not a residency/merge/LOD decision.",
  "rethrows a game error that borrows the terrain budget error's name":
    "Game callback exception identity/propagation, not a residency/merge/LOD decision.",
  "keeps refcounts and geometry consistent when one asset load fails":
    "IO failure/retry and geometry ownership; residency budgets count authored records even when a model load refuses.",
  "names a refused world load in a TN_WORLD_CELL_FAILURE marker":
    "Loader error diagnostic text, not a residency/merge/LOD decision.",
  "bounds model loads across every admitted cell, not per cell":
    "Asynchronous model IO scheduling/concurrency (PRD-520), distinct from cell admission and decision-build pacing.",
  "skips a queued load whose cell was evicted, without loading or failing":
    "Asynchronous model IO queue cancellation (PRD-520); eviction of queued decision builds is reproduced.",
  "streams a compiled package, every file reached through the asset manifest":
    "Compiled asset manifest/path resolution and IO, not residency/merge/LOD decisions.",
  "still loads the package from assets/ when the compiled output is gone":
    "Compiled asset fallback/path resolution and IO, not residency/merge/LOD decisions.",
  "survives a teardown that throws, and reports it instead of killing the frame":
    "Three resource destructor exception handling, not residency/merge/LOD decisions.",
  "releases every level's geometry and material when its cell leaves":
    "Three resource lifetime; the cell's eviction and removed draws are reproduced.",
  "hands back the exact model paths it asked the loader for, and only those":
    "Loader cache path ownership, not residency/merge/LOD decisions.",
  "holds one cached source for two distinct assets naming it, releasing it only with the last":
    "Loader cache alias/refcount/resource ownership, not residency/merge/LOD decisions.",
  "releases the actual requested path of a level the asset fell back over":
    "Loader cache path ownership; fallback LOD selection is reproduced by authoredFallback.",
  "leaves the cache untouched when loadModel overrides it":
    "Loader cache ownership, not residency/merge/LOD decisions.",
  "never releases an explicitly supplied loader's cached model another holder keeps":
    "Loader cache ownership, not residency/merge/LOD decisions.",
  "hands a path back safely when the world leaves before the load settles":
    "Asynchronous loader cache lifetime, not residency/merge/LOD decisions.",
  "tears each streamed shape down once, however many cells and batches held it":
    "Three geometry destructor ownership/count, not residency/merge/LOD decisions.",
  "casts shadows from the near levels and receives them everywhere only when asked":
    "Shadow layers/cast/receive flags, not residency/merge/main-chain LOD decisions.",
  "batches every primitive of a multi-primitive asset, at its own offset and material":
    "Three matrix/primitive/material composition, not level gates; multi-part chain counts are reproduced.",
  "keeps an authored middle level's own reduced cutout and tears each card down once":
    "Three geometry/material identity and disposal; authored-versus-chain gate precedence is reproduced by authoredWins.",
  "draws a transparent scatter part as a cutout clone, and as authored with `blend`":
    "Three alpha/material cloning, not residency/merge/LOD decisions.",
  "compensates the mip chain on a cutout that has one, leaving an unmapped one plain":
    "Texture/material mip bias, not residency/merge/LOD decisions.",
  "leaves a MASK scatter part's authored surface untouched":
    "Three material identity, not residency/merge/LOD decisions.",
  "releases every part of every level exactly once when its last cell leaves":
    "Three resource disposal count, not residency/merge/LOD decisions.",
  "draws the coarsest level into the wide half and level 0 into the fine clusters":
    "Shadow caster geometry/layer selection; main-chain levels are reproduced, caster draw objects are outside box 37.",
  "prewarms the wide half out of the coarsest level, so the walk builds no node":
    "Shadow shader/mesh prewarm, outside residency/merge/main-chain LOD decisions.",
  "uploads the merged buffers during admission, not on the first draw":
    "Renderer upload timing; merge groups and byte totals are reproduced by chunkMaterials.",
  "tags every mesh the main pass draws from the chunk as chunks":
    "Three userData draw-origin tags, not merge membership or byte accounting.",
  "disposes the merged buffers when the chunk's cell is evicted":
    "Three merged-buffer destruction; residency eviction is reproduced separately.",
  "leaves AutoLOD, alpha, morph and deforming retained parts casting their own silhouettes":
    "Shadow silhouettes/proxy eligibility, outside chunk material merge decisions.",
  "collapses the chunk's shadow bill into one position-only proxy per side":
    "Shadow proxy geometry/material generation, outside chunk material merge decisions.",
  "should leave every merged caster that is not an opaque group alpha-cut":
    "Shadow proxy alpha/material flags, outside chunk material merge decisions.",
  "a level selecting %s casters draws the merged chunk proxy: %s":
    "Shadow renderer/proxy selection, outside chunk material merge decisions.",
  "consolidates retained opaque parts with exact %s level inputs and unchanged main draws":
    "Per-shadow-camera proxy geometry/frustum/diameter selection, outside chunk material merge decisions.",
  "does no retained proxy index writes or uploads after warming each %s level":
    "Shadow proxy upload/index-buffer caching, outside chunk material merge decisions.",
};
function coverage(): unknown[] {
  const rows: unknown[] = [];
  for (const file of readdirSync(SPECS)
    .filter((name) => /^world-cells.*\.spec\.ts$/u.test(name))
    .sort()) {
    const source = ts.createSourceFile(
      file,
      readFileSync(path.join(SPECS, file), "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
        const expression = node.expression;
        const simple = ts.isIdentifier(expression) && expression.text === "it";
        const each =
          ts.isCallExpression(expression) &&
          ts.isPropertyAccessExpression(expression.expression) &&
          expression.expression.name.text === "each" &&
          ts.isIdentifier(expression.expression.expression) &&
          expression.expression.expression.text === "it";
        if (simple || each) {
          const title = node.arguments[0].text;
          const lanes = covered[title];
          const fileReason = file.includes("main-cull")
            ? "Render-camera frustum/shared-buffer repacking/visibility; resident cells remain admitted, so these are rendering assertions, not residency decisions."
            : file.includes("static")
              ? "Three static-transform/attribute-version flags, not residency/merge/LOD decisions."
              : file.includes("shadow-prewarm")
                ? "Shadow draw hooks and shader-prewarm readiness, not residency/merge/LOD decisions."
                : file.includes("streamed-warmup")
                  ? "Renderer compilation, shadow material pooling, or GPU buffer upload ranges, not residency/merge/LOD decisions."
                  : undefined;
          const reason = lanes ? undefined : (excluded[title] ?? fileReason);
          if (!lanes && !reason) throw new Error(`unaccounted spec: ${file}: ${title}`);
          let cases = [title];
          if (each && ts.isCallExpression(expression)) {
            let data = expression.arguments[0];
            if (data && ts.isAsExpression(data)) data = data.expression;
            if (!data || !ts.isArrayLiteralExpression(data))
              throw new Error(`nonliteral cases: ${title}`);
            const literal = (value: ts.Expression): string | boolean => {
              if (ts.isStringLiteral(value)) return value.text;
              if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
              if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
              throw new Error(`nonliteral parameter: ${value.getText(source)}`);
            };
            cases = data.elements.map((element) =>
              format(
                title,
                ...(ts.isArrayLiteralExpression(element)
                  ? element.elements.map(literal)
                  : [literal(element)]),
              ),
            );
          }
          for (const test of cases)
            rows.push({
              file,
              test,
              reproduced: lanes ?? [],
              scope: lanes
                ? "Decision assertions only; no GPU/mesh identity or resource-lifetime claim."
                : reason,
            });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const names of Object.values(covered))
    for (const name of names)
      if (
        name !== "refusals" &&
        !scenes.some((scene) => scene.name === name) &&
        !chunkScenes.some((scene) => scene.name === name)
      )
        throw new Error(`unknown coverage scene ${name}`);
  return rows;
}
async function refusals(): Promise<unknown[]> {
  const result = [];
  for (const option of [
    "concurrency",
    "rebuildsPerUpdate",
    "chunkMergeMaxTriangles",
    "admissionBudgetMs",
  ])
    for (const value of option === "admissionBudgetMs"
      ? [0, Number.NaN]
      : [0, -1, 1.5, Number.NaN]) {
      fetchPackage(manifest);
      const info = console.info;
      console.info = () => {};
      let refused: Error | undefined;
      try {
        const world = await WorldCells.load({
          budgets,
          follow: { position: { x: 0, z: 0 } },
          ring: 1,
          surface: new MeshBasicMaterial(),
          url: "/world/world.json",
          [option]: value,
        });
        world.dispose();
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        refused = error;
      } finally {
        console.info = info;
      }
      if (!refused?.message.includes(option)) throw new Error(`${option} did not refuse ${value}`);
      result.push({ option, value: bits(value), expected: option });
    }
  return result;
}
const originalFetch = globalThis.fetch;
try {
  const table = {
    source:
      "packages/core/src/world-cells.ts (real WorldCells.load/update; real DiscreteLodPlugin)",
    coverage: coverage(),
    placements: rootWords([Array.from(new Float32Array(placementBytes))]),
    heightmap: Array.from(
      new Uint16Array(
        heightFile.buffer.slice(
          heightFile.byteOffset,
          heightFile.byteOffset + heightFile.byteLength,
        ),
      ),
    ),
    scenes: await (async () => {
      const records = [];
      for (const scene of scenes) records.push(await runScene(scene));
      return records;
    })(),
    chunks: await (async () => {
      const records = [];
      for (const scene of chunkScenes) records.push(await runChunk(scene));
      return records;
    })(),
    refusals: await refusals(),
  };
  // Compact: the table carries 1776 step digests, not 1776 pretty-printed observation trees.
  const output = `${JSON.stringify(table)}\n`;
  if (process.argv.includes("--check")) {
    if (readFileSync(OUT, "utf8") !== output)
      throw new Error("world_cells_reference.json differs; rerun the generator");
    console.log(
      `world cells reference current: ${table.scenes.length} paths, ${table.chunks.length} merges, ${table.coverage.length} spec cases accounted`,
    );
  } else {
    writeFileSync(OUT, output);
    console.log(
      `wrote ${OUT}: ${table.scenes.length} paths, ${table.chunks.length} merges, ${table.coverage.length} spec cases accounted`,
    );
  }
} finally {
  globalThis.fetch = originalFetch;
}
