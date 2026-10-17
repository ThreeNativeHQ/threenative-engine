/**
 * Records `TerrainTiles`' admission, LOD and collider decisions as a C++ table the native port
 * rebuilds and compares value for value (PRD-521 box 38). Every f32 is its 32-bit pattern and every
 * double its 64-bit pattern, so the comparison is exact.
 *
 * The table is driven through the REAL `TerrainTiles` in node, over scripted follow paths built from
 * world-terrain-tiles.spec.ts and world-tiles-cost.spec.ts: the edge-sample byte cap, the eviction
 * ring, `colliderRadius` moving with the follow point, the neighbour LOD rule, the LOD pop bound on a
 * cliff, a byte-starved admission budget that must force its first tile, the stitched-geometry cap,
 * the topology region's own bytes, and the constructor refusals. Per follow step it records which
 * tiles are resident and in what order, each tile's bytes, LOD level, per-level resolutions and
 * collider body with the body's exact collider-order heights, the body's create/hand-back sequence,
 * the bridges the mixed-LOD pairs need, the peaks, the deferral count and the transition count.
 *
 * The fields themselves are game data, so the generator re-derives each tile's canonical grid from
 * the spec's own `sampleHeight` at the points `Heightfield.fromSampler` samples, and fails if that
 * grid ever differs from the live field's own samples. The port reads those grids, not a second
 * sampler, so both sides hold the same heights.
 *
 *   pnpm --workspace-root exec tsx packages/runtime-native/tests/native-engine/world/world-tiles-reference.ts
 *   ... -- --check   (fails when the committed table is not what the core module produces)
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { type BufferAttribute, type BufferGeometry, LOD, MeshBasicMaterial } from "three";

import { type IAdmissionBudget, TerrainTiles } from "../../../../core/src/world-tiles.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "world_tiles_reference.inc");

const bits32 = (value: number): number =>
  new Uint32Array(new Float32Array([value]).buffer)[0] as number;
const bits64 = (value: number): bigint =>
  new BigUint64Array(new Float64Array([value]).buffer)[0] as bigint;
const u32 = (value: number): string => `0x${(value >>> 0).toString(16).padStart(8, "0")}u`;
const f32 = (value: number): string => u32(bits32(value));
const u64 = (value: number): string => `0x${bits64(value).toString(16).padStart(16, "0")}ull`;
const f32row = (values: ArrayLike<number>): string => Array.from(values, f32).join(", ");
const f64row = (values: readonly number[]): string => values.map(u64).join(", ");
const u32row = (values: ArrayLike<number>): string => Array.from(values, u32).join(", ");
const dec = (value: number): string => `${value}u`;
const strings = (values: readonly string[]): string => values.map((key) => `"${key}"`).join(", ");

/* ---- the specs' own height functions, so the port reads the samples the assertions did ---- */

const specSampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.17) * 2 + Math.cos(z * 0.13) * 1.5 + Math.sin((x + z) * 0.07);
const costSampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.017) * 12 + Math.cos(z * 0.013) * 9 + Math.sin((x + z) * 0.007) * 4;
const cliffSampleHeight = (x: number, z: number): number => Math.sin(x * (Math.PI / 2)) * 100;
const gorgeSampleHeight = (x: number, z: number): number =>
  Math.sin(x * 0.25) * 8 +
  Math.cos(z * 0.2) * 6 +
  (x >= 4 && x < 40 ? 40 + Math.sin(z * 0.9) * 20 : 0);

/* ---- the grids every scene's tiles read, derived once and checked against the live fields ---- */

interface IGrid {
  columns: number;
  rows: number;
  tileX: number;
  tileZ: number;
  values: number[];
}

const grids = new Map<string, IGrid>();
/** Every grid a scene's tiles read, in the order the pool emitted them. */
const sceneGrids = new Map<
  string,
  { columns: number; rows: number; tileX: number; tileZ: number }[]
>();

/** `Heightfield.fromSampler`'s own sample points for one tile: minimum-corner origin, own cells. */
function gridKey(
  scene: string,
  tileX: number,
  tileZ: number,
  tileSize: number,
  resolution: number,
): string {
  return `${scene}:${String(tileSize)}:${String(resolution)}:${String(tileX)}:${String(tileZ)}`;
}

function buildGrid(
  label: string,
  sampleHeight: (x: number, z: number) => number,
  tileX: number,
  tileZ: number,
  tileSize: number,
  resolution: number,
): IGrid {
  // Keyed by the scene too: each scene samples a different terrain, so two scenes' tile 0:0 grids
  // are different numbers under the same coordinates.
  const key = gridKey(label, tileX, tileZ, tileSize, resolution);
  const at = grids.get(key);
  if (at !== undefined) return at;
  const originX = tileX * tileSize;
  const originZ = tileZ * tileSize;
  const minimumX = originX - tileSize / 2;
  const minimumZ = originZ - tileSize / 2;
  const cellWidth = tileSize / (resolution - 1);
  const cellDepth = tileSize / (resolution - 1);
  const values: number[] = [];
  for (let row = 0; row < resolution; row += 1) {
    const z = minimumZ + row * cellDepth;
    for (let column = 0; column < resolution; column += 1)
      values.push(Math.fround(sampleHeight(minimumX + column * cellWidth, z)));
  }
  const grid: IGrid = { columns: resolution, rows: resolution, tileX, tileZ, values };
  grids.set(key, grid);
  const owned = sceneGrids.get(label);
  if (owned === undefined) sceneGrids.set(label, [grid]);
  else owned.push(grid);
  return grid;
}

/** The live field's own samples, so a grid that ever disagreed with the module fails the generator. */
function checkAgainstField(
  tiles: TerrainTiles,
  gridOf: (tileX: number, tileZ: number) => IGrid,
): void {
  for (const key of tiles.residentKeys) {
    const tile = tiles.getTile(key);
    if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
    const grid = gridOf(tile.tileX, tile.tileZ);
    const live = tile.field.heights;
    if (live.length !== grid.values.length)
      throw new Error(
        `Tile '${key}' holds ${String(live.length)} samples, expected ${String(grid.values.length)}.`,
      );
    for (let index = 0; index < grid.values.length; index += 1)
      if (bits32(live[index] as number) !== bits32(grid.values[index] as number))
        throw new Error(`Tile '${key}' sample ${String(index)} differs from the derived grid.`);
  }
}

/* ---- one scene, driven and recorded ---- */

interface ISceneSpec {
  name: string;
  /** Options exactly as the spec case wrote them, minus the surface the port does not own. */
  options: Record<string, unknown>;
  sample: (x: number, z: number) => number;
  steps: IStepSpec[];
  /** Records every body the game's factory is asked for, so the fixture proves the placement. */
  colliderFactory?: "record" | "throws";
}

/** One scripted follow: where the point is, what it may spend, and what it settles afterwards. */
interface IStepSpec {
  x: number;
  z: number;
  /** The follow's own allowance; a step without one admits as freely as it wants. */
  units?: number;
  /** `process()` calls after the follow. */
  processes?: number;
  /** Unbudgeted follows and processes that leave the ring settled before the step is recorded. */
  settle?: number;
}

interface ITileRecord {
  bytes: number;
  colliderHeights: number[];
  hasCollider: boolean;
  key: string;
  lodLevel: number;
  resolutions: number[];
  tileX: number;
  tileZ: number;
}

interface IStepRecord {
  bridges: number;
  /** The follow this step recorded, so the port can replay the same path. */
  x: number;
  z: number;
  processes: number;
  blendingTiles: number;
  colliderEvents: { created: boolean; key: string }[];
  colliderKeys: string[];
  deferredAdmissions: number;
  insertionKeys: string[];
  lodTransitions: number;
  outcome: number;
  peakBytes: number;
  peakTiles: number;
  residentBytes: number;
  residentKeys: string[];
  stitchBytes: number;
  tiles: ITileRecord[];
  units: number;
}

interface ISceneRecord {
  /** 0 none, 1 the constructor refused, 2 a follow refused the followed tile, 3 the stitched cap. */
  refusal: number;
  steps: IStepRecord[];
}

/** One budget with a fixed allowance, so a refusal is a number and not a race with a clock. */
function budget(units: number): IAdmissionBudget {
  let spent = 0;
  return {
    admit(work: () => void): boolean {
      if (spent >= units) return false;
      spent += 1;
      work();
      return true;
    },
  };
}

/** The resolution a level's own geometry renders at: its surface plus four skirts. */
function levelResolution(level: { object: unknown }): number {
  const geometry = (level.object as { geometry?: BufferGeometry }).geometry;
  const position = geometry?.getAttribute("position") as BufferAttribute | undefined;
  if (position === undefined) throw new Error("A terrain level has no position attribute.");
  return Math.round(Math.sqrt(position.count + 4) - 2);
}

/** The bridges the seam pass holds: unnamed mesh children that are not a merged block. */
function bridgeBytes(tiles: TerrainTiles): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const child of tiles.children) {
    if (child instanceof LOD) continue;
    const mesh = child as { geometry?: BufferGeometry; name: string };
    const geometry = mesh.geometry;
    if (geometry === undefined || mesh.name.startsWith("tn-terrain-block:")) continue;
    const index = geometry.getIndex();
    if (index === null) continue;
    bytes +=
      geometry.getAttribute("position").array.byteLength +
      geometry.getAttribute("normal").array.byteLength +
      index.array.byteLength;
    count += 1;
  }
  return { bytes, count };
}

/**
 * The resident tiles in the order the ring holds them, which is the order the body walk reads: each
 * LOD child sits at its own tile's origin, and children keep the order they were added in.
 */
function insertionKeys(tiles: TerrainTiles, tileSize: number): string[] {
  return tiles.children
    .filter((child): child is LOD => child instanceof LOD)
    .map(
      (child) =>
        `${String(Math.round(child.position.x / tileSize))}:${String(Math.round(child.position.z / tileSize))}`,
    );
}

/** The game's `createCollider` for a scene that records the bodies it is asked for. */
function recordingFactory(
  events: { created: boolean; key: string }[],
): (input: { key: string }) => { dispose(): void } {
  return ({ key }: { key: string }) => {
    events.push({ created: true, key });
    return {
      dispose: () => {
        events.push({ created: false, key });
      },
    };
  };
}

/** The scene's own factory, folded into the options `TerrainTiles` is built from. */
function optionsOf(
  scene: ISceneSpec,
  events: { created: boolean; key: string }[],
): Record<string, unknown> {
  const options: Record<string, unknown> = { ...scene.options, sampleHeight: scene.sample };
  if (scene.colliderFactory === "record") options.createCollider = recordingFactory(events);
  if (scene.colliderFactory === "throws")
    options.createCollider = () => {
      throw new Error("collider-nope");
    };
  return options;
}

/** The recorded outcome of one follow: 0 admitted, 1 threw, 2 refused a tile, 3 the stitched cap. */
function outcomeOf(error: unknown): number {
  const message = (error as Error).message;
  if (message.includes("stitched")) return 3;
  return message.includes("followed tile") ? 2 : 1;
}

/** Every resident tile's recorded decisions, in the sorted order the core lists them in. */
function tilesOf(tiles: TerrainTiles): ITileRecord[] {
  const recorded: ITileRecord[] = [];
  for (const key of tiles.residentKeys) {
    const tile = tiles.getTile(key);
    if (tile === undefined) throw new Error(`Missing resident tile '${key}'.`);
    recorded.push({
      bytes: tile.bytes,
      // Only a tile that holds a body has a collider-order copy to record; the core's empty
      // placeholder for a scene without a factory has none.
      colliderHeights:
        tile.collider === undefined ? [] : Array.from(tile.field.toColliderHeights()),
      hasCollider: tile.collider !== undefined,
      key,
      lodLevel: tile.lodLevel,
      resolutions: tile.lod.levels.map(levelResolution),
      tileX: tile.tileX,
      tileZ: tile.tileZ,
    });
  }
  return recorded;
}

/** One scripted follow plus whatever it settles, and the outcome it raised, if any. */
function followStep(tiles: TerrainTiles, step: IStepSpec): number {
  const allowance = step.units === undefined ? undefined : budget(step.units);
  let outcome = 0;
  try {
    tiles.follow({ x: step.x, z: step.z }, ...(allowance === undefined ? [] : [allowance]));
  } catch (error) {
    outcome = outcomeOf(error);
  }
  for (let frame = 0; frame < (step.processes ?? 0); frame += 1) tiles.process();
  for (let frame = 0; frame < (step.settle ?? 0); frame += 1) {
    tiles.follow({ x: step.x, z: step.z });
    tiles.process();
  }
  return outcome;
}

/** Runs one scene's scripted follow path and records what the core decided after every step. */
function run(scene: ISceneSpec): ISceneRecord {
  const tileSize = scene.options.tileSize as number;
  const resolution = scene.options.tileResolution as number;
  const gridOf = (tileX: number, tileZ: number): IGrid =>
    buildGrid(scene.name, scene.sample, tileX, tileZ, tileSize, resolution);

  const events: { created: boolean; key: string }[] = [];
  let tiles: TerrainTiles;
  try {
    tiles = new TerrainTiles(optionsOf(scene, events) as never);
  } catch {
    return { refusal: 1, steps: [] };
  }

  const steps: IStepRecord[] = [];
  const record = (step: IStepSpec, outcome: number): void => {
    const bridges = bridgeBytes(tiles);
    const recorded = tilesOf(tiles);
    checkAgainstField(tiles, gridOf);
    steps.push({
      blendingTiles: tiles.blendingTiles,
      bridges: bridges.count,
      colliderEvents: events.map((event) => ({ ...event })),
      colliderKeys: [...tiles.residentColliderKeys],
      deferredAdmissions: tiles.deferredAdmissions,
      insertionKeys: insertionKeys(tiles, tileSize),
      lodTransitions: tiles.lodTransitions,
      outcome,
      peakBytes: tiles.peakResidentBytes,
      peakTiles: tiles.peakResidentTileCount,
      processes: step.processes ?? 0,
      residentBytes: tiles.residentBytes,
      residentKeys: [...tiles.residentKeys],
      stitchBytes: bridges.bytes,
      tiles: recorded,
      units: step.units ?? 0,
      x: step.x,
      z: step.z,
    });
    // Every grid a resident tile reads, so the port never has to invent a height it did not record.
    for (const tile of recorded) gridOf(tile.tileX, tile.tileZ);
  };

  for (const step of scene.steps) {
    events.length = 0;
    record(step, followStep(tiles, step));
    // A settling step records the ring it converged to as well, so the settled decision is recorded.
    if ((step.settle ?? 0) > 0) record(step, 0);
  }
  tiles.dispose();
  return { refusal: 0, steps };
}

/* ---- the scenes, one per spec case the port covers ---- */

const base = { surface: new MeshBasicMaterial() };

const scenes: ISceneSpec[] = [
  // "counts retained edge samples in each tile and its admission estimate".
  {
    name: "edgeSampleBytes",
    options: {
      ...base,
      residentByteBudget: 9_000,
      residentTileBudget: 1,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 0, z: 0 }],
  },
  // "rejects a tile when retained edge samples make it exceed the byte cap".
  {
    name: "edgeSampleBytesRefused",
    options: {
      ...base,
      residentByteBudget: 8_400,
      residentTileBudget: 1,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 0, z: 0 }],
  },
  // "fails closed when one tile cannot fit the byte cap".
  {
    name: "oneTileCannotFit",
    options: {
      ...base,
      residentByteBudget: 1,
      residentTileBudget: 1,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 0, z: 0 }],
  },
  // "keeps resident tile count and bytes under caps while evicting complete units": a nine-tile ring
  // against a cap of four, followed two widths east so the near half is evicted whole.
  {
    name: "eviction",
    options: {
      ...base,
      residentByteBudget: 200_000,
      residentTileBudget: 4,
      streamRadius: 1,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      { x: 64, z: 0 },
      { x: 64, z: 0 },
    ],
  },
  // "gives only the tiles inside `colliderRadius` a body, and moves that set as follow moves": a
  // seven-wide stream ring of ground around a one-tile body ring, moved three tiles east.
  {
    colliderFactory: "record",
    name: "colliderRadius",
    options: {
      ...base,
      colliderRadius: 1,
      residentByteBudget: 4_000_000,
      residentTileBudget: 49,
      streamRadius: 3,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [
      { x: 0, z: 0 },
      { x: 48, z: 0 },
      { x: 48, z: 0 },
    ],
  },
  // "releases a half-built tile when its collider factory throws".
  {
    colliderFactory: "throws",
    name: "colliderThrows",
    options: {
      ...base,
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 0, z: 0 }],
  },
  // "coordinates adjacent resident LOD targets instead of allowing a two-level jump": gates at one and
  // two world units, so every neighbour of a 16-unit tile stands past both.
  {
    name: "lodCoordination",
    options: {
      ...base,
      lodDistances: [1, 2],
      residentByteBudget: 1_000_000,
      residentTileBudget: 9,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [
      { x: 0, z: 0 },
      { x: 0, z: 0 },
      { x: 4, z: 4, processes: 4 },
    ],
  },
  // "keeps a tile off a level whose height error exceeds the pop bound": a cliff whose coarser level
  // misses by more than the bound, so the tile may only ever show its finest.
  {
    name: "popBound",
    options: {
      ...base,
      lodDistances: [4, 8],
      residentByteBudget: 200_000,
      residentTileBudget: 1,
      streamRadius: 0,
      tileResolution: 17,
      tileSize: 16,
    },
    sample: cliffSampleHeight,
    steps: [
      { x: 0, z: 0 },
      { x: 6, z: 0, processes: 4 },
    ],
  },
  // "walks a gorge cliff across LOD distances without throwing past the pop bound".
  {
    name: "gorge",
    options: {
      ...base,
      lodDistances: [32, 48],
      residentByteBudget: 4_000_000,
      residentTileBudget: 2,
      streamRadius: 1,
      tileResolution: 33,
      tileSize: 128,
    },
    sample: gorgeSampleHeight,
    steps: [
      { x: 0, z: 0 },
      { x: 40, z: 0, processes: 3 },
      { x: 56, z: 0, processes: 3 },
    ],
  },
  // world-tiles-cost.spec.ts's own ring, settled and then walked across its LOD gates.
  {
    name: "settledRing",
    options: {
      ...base,
      residentByteBudget: 64_000_000,
      residentTileBudget: 25,
      streamRadius: 2,
      tileResolution: 17,
      tileSize: 32,
    },
    sample: costSampleHeight,
    steps: [
      { x: 0, z: 0, processes: 4, settle: 70 },
      { x: 0, z: 0, processes: 4 },
      { x: 6, z: 0, processes: 4 },
      { x: 0.3, z: 0, processes: 4 },
      { x: 20.4, z: 0, processes: 4 },
      { x: 20.4, z: 0, processes: 4 },
    ],
  },
  // The starved path `IAdmissionBudget` exists for: a one-unit follow that must still force its
  // nearest tile and defer the rest, then enough allowance for the ring to converge.
  {
    colliderFactory: "record",
    name: "starvedBudget",
    options: {
      ...base,
      colliderRadius: 1,
      residentByteBudget: 4_000_000,
      residentTileBudget: 9,
      streamRadius: 1,
      tileResolution: 9,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [
      { x: 0, z: 0, units: 1 },
      { x: 0, z: 0, units: 1 },
      { x: 0, z: 0, units: 1 },
      { x: 0, z: 0, units: 2 },
      { x: 0, z: 0, units: 9 },
      { x: 16, z: 0, units: 1 },
      { x: 16, z: 0, units: 9 },
    ],
  },
  // "fails closed when stitched neighbor geometry exceeds the byte cap": the same ring measured
  // against a cap it fits, then against one byte under what it measured, which is the bridge's own
  // cost pushing the ring past the cap after the pass.
  {
    name: "stitchCap",
    options: {
      ...base,
      lodDistances: [8, 16],
      residentByteBudget: 1_000_000,
      residentTileBudget: 2,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 2, z: 0 }],
  },
  {
    name: "stitchCapRefused",
    options: {
      ...base,
      lodDistances: [8, 16],
      residentByteBudget: 53_615,
      residentTileBudget: 2,
      streamRadius: 1,
      tileResolution: 17,
      tileSize: 16,
    },
    sample: specSampleHeight,
    steps: [{ x: 2, z: 0 }],
  },
  // "counts retained topology storage against the hard byte cap": a 16-tile region at 129x129 held
  // against a cap smaller than its own samples.
  {
    name: "topologyCap",
    options: {
      ...base,
      residentByteBudget: 100_000,
      residentTileBudget: 1,
      streamRadius: 0,
      tileResolution: 9,
      tileSize: 16,
      topologyObservation: {
        columns: 129,
        depth: 256,
        origin: { x: 0, z: 0 },
        rows: 129,
        width: 256,
      },
    },
    sample: specSampleHeight,
    steps: [],
  },
];

const records = scenes.map((scene) => ({ record: run(scene), scene }));

/* ---- emit the C++ table ---- */

const lines = [
  "// Generated by packages/runtime-native/tests/native-engine/world/world-tiles-reference.ts from",
  "// packages/core/src/world-tiles.ts. Do not edit: rerun the generator. Every f32 is its 32-bit",
  "// pattern and every double its 64-bit pattern, so the comparison is exact.",
  "",
];

const gridNames = new Map<string, string>();
let gridIndex = 0;
for (const [key, grid] of grids) {
  const name = `kWorldTileGrid${String(gridIndex)}`;
  gridIndex += 1;
  gridNames.set(key, name);
  lines.push(`static const uint32_t ${name}[] = {${f32row(grid.values)}};`, "");
}

records.forEach(({ record, scene }, sceneIndex) => {
  const s = `S${String(sceneIndex)}`;
  const tileSize = scene.options.tileSize as number;
  const factors = (scene.options.lodFactors as number[] | undefined) ?? [1, 2, 4];
  // The core's own defaults, resolved, so the port is given what the module actually used.
  const distances = (scene.options.lodDistances as number[] | undefined) ?? [
    tileSize * 2,
    tileSize * 4,
  ];
  const topology = scene.options.topologyObservation as
    | { columns: number; depth: number; rows: number; width: number }
    | undefined;
  const factory = scene.colliderFactory ?? "none";

  lines.push(`static const uint64_t kWorldTile${s}Distances[] = {${f64row(distances)}};`);
  lines.push(`static const uint32_t kWorldTile${s}Factors[] = {${u32row(factors)}};`);
  lines.push(
    `static const RefOptions kWorldTile${s}Options = {`,
    `    ${u64(tileSize)}, ${dec(scene.options.tileResolution as number)}, ` +
      `${dec(scene.options.residentTileBudget as number)}, ${scene.options.residentByteBudget as number}u, ` +
      `${u64((scene.options.skirtDepth as number | undefined) ?? tileSize)}, ` +
      `${dec((scene.options.streamRadius as number | undefined) ?? 1)}, ` +
      `${dec((scene.options.colliderRadius as number | undefined) ?? (scene.options.streamRadius as number | undefined) ?? 1)},`,
    `    ${dec(factors.length)}, ${dec(distances.length)}, kWorldTile${s}Factors, kWorldTile${s}Distances,`,
    `    ${factory === "record" ? 1 : 0}, ${factory === "throws" ? 1 : 0}, ${topology === undefined ? 0 : 1},`,
    `    ${topology === undefined ? "0u, 0u" : `${dec(topology.columns)}, ${dec(topology.rows)}`}, ` +
      `${topology === undefined ? "0ull, 0ull" : `${u64(topology.width)}, ${u64(topology.depth)}`},`,
    "};",
    "",
  );
  lines.push(`static const RefGrid kWorldTile${s}Grids[] = {`);
  for (const grid of sceneGrids.get(scene.name) ?? [])
    lines.push(
      `    {${grid.tileX}, ${grid.tileZ}, ${dec(grid.columns)}, ${dec(grid.rows)}, ` +
        `${gridNames.get(gridKey(scene.name, grid.tileX, grid.tileZ, tileSize, scene.options.tileResolution as number))}},`,
    );
  lines.push("};", "");

  record.steps.forEach((step, stepIndex) => {
    const at = `${s}Step${String(stepIndex)}`;
    step.tiles.forEach((tile, tileIndex) => {
      lines.push(
        `static const uint32_t kWorldTile${at}Tile${String(tileIndex)}Collider[] = {${f32row(tile.colliderHeights)}};`,
      );
    });
    lines.push(`static const RefTile kWorldTile${at}Tiles[] = {`);
    step.tiles.forEach((tile, tileIndex) => {
      lines.push(
        `    {${tile.tileX}, ${tile.tileZ}, ${tile.bytes}u, ${dec(tile.lodLevel)}, ${tile.hasCollider ? 1 : 0}, ` +
          `${u32row(tile.resolutions)}, ${dec(tile.resolutions.length)}, ` +
          `${dec(tile.colliderHeights.length)}, kWorldTile${at}Tile${String(tileIndex)}Collider},`,
      );
    });
    lines.push("};", "");
    lines.push(`static const RefEvent kWorldTile${at}Events[] = {`);
    for (const event of step.colliderEvents)
      lines.push(`    {"${event.key}", ${event.created ? 1 : 0}},`);
    lines.push("};", "");
    lines.push(
      `static const char* const kWorldTile${at}Resident[] = {${strings(step.residentKeys)}};`,
    );
    lines.push(
      `static const char* const kWorldTile${at}Insertion[] = {${strings(step.insertionKeys)}};`,
    );
    lines.push(
      `static const char* const kWorldTile${at}Colliders[] = {${strings(step.colliderKeys)}};`,
    );
  });

  lines.push(`static const RefStep kWorldTile${s}Steps[] = {`);
  record.steps.forEach((step, stepIndex) => {
    const at = `${s}Step${String(stepIndex)}`;
    lines.push(
      `    {${dec(step.outcome)}, ${dec(step.deferredAdmissions)}, ${dec(step.units)}, ` +
        `${u64(step.x)}, ${u64(step.z)}, ${dec(step.processes)}, ` +
        `kWorldTile${at}Resident, ${dec(step.residentKeys.length)}, ` +
        `kWorldTile${at}Insertion, ${dec(step.insertionKeys.length)}, ` +
        `kWorldTile${at}Colliders, ${dec(step.colliderKeys.length)}, ` +
        `kWorldTile${at}Tiles, ${dec(step.tiles.length)}, ` +
        `kWorldTile${at}Events, ${dec(step.colliderEvents.length)}, ` +
        `${step.residentBytes}u, ${step.stitchBytes}u, ${step.bridges}u, ${step.peakBytes}u, ` +
        `${step.peakTiles}, ${step.lodTransitions}, ${step.blendingTiles}},`,
    );
  });
  lines.push("};", "");
  const sceneGridCount = (sceneGrids.get(scene.name) ?? []).length;
  lines.push(
    `static const RefScene kWorldTile${s} = {"${scene.name}", kWorldTile${s}Options, ` +
      `kWorldTile${s}Grids, ${dec(sceneGridCount)}, kWorldTile${s}Steps, ${dec(record.steps.length)}, ${dec(record.refusal)}};`,
  );
  lines.push("");
});

lines.push("static const RefScene kWorldTileScenes[] = {");
records.forEach((_, sceneIndex) => lines.push(`    kWorldTileS${String(sceneIndex)},`));
lines.push("};", "");

const text = lines.join("\n");
if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      "TN_FIXTURE_STALE: world_tiles_reference.inc is not what the core module produces",
    );
    process.exit(1);
  }
  console.log("current: world_tiles_reference.inc");
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}`);
}
