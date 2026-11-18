// The streamed-world bake every kit shares: the recipe and biome rows are the kit's data, the look
// and the prop policy come from the kit's own source through `IKitWorldLook`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bakeBiome, foliageScatterRules } from "./biome/bake-biome.js";
import { validateBiome } from "./biome/biome.js";
import { MATERIAL_IDS } from "./core/masks.js";
import { finalizeState } from "./core/operations.js";
import { Terrain } from "./core/terrain.js";
import type { IPlacement, ITerrainDocument, ITerrainState, Layer } from "./core/types.js";
import { paintCanopyCover } from "./ground/canopy.js";
import { placeMassif } from "./ground/massif.js";
import { type LandformKind, landformBackdrop } from "./ground/presets.js";
import { skyVisibility } from "./ground/sky-visibility.js";
import { bakeMesh } from "./package/bake.js";
import { compilePropBuckets, propPackageFiles } from "./package/prop-package.js";
import type { IBakedWorldPackage, IWorldPackageAsset } from "./package/world-package.js";
import { type IKitArborArt, growKitArborArt } from "./population/arbor-species.js";

type Palette = NonNullable<NonNullable<Parameters<typeof bakeMesh>[1]>["palette"]>;

/** The kit source a streamed-world bake reads: its look and its prop policy, never package defaults. */
export interface IKitWorldLook {
  /** Vertex colours of the baked ground, by material channel. */
  readonly palette: Palette;
  /** The ground layer table's maps and tile sizes, keyed by material id. */
  readonly ground: {
    readonly maps: Readonly<Record<string, { readonly diffuse: string; readonly normal?: string }>>;
    readonly tile: Readonly<Record<string, number>>;
  };
  /** Crown radius in metres per unit of placement scale, by asset; the ground's canopy grid. */
  readonly canopy: Readonly<Record<string, number>>;
  /** How each placement streams: the kit's species pack decides variants, reach and shadows. */
  readonly props: {
    readonly variantFor: (placement: IPlacement, asset: string) => number;
    readonly streamedReach: (placement: IPlacement, variantIndex: number) => number;
    readonly streamedBucket: (placement: IPlacement, reach: number) => string;
    readonly propKey: (placement: IPlacement) => string;
    readonly withAuthoredPose: (placement: IPlacement) => IPlacement;
  };
}

/** `recipe.json`'s `world` row: what a streamed world bakes beyond its terrain recipe. */
export interface IKitWorldRecipe {
  /** The world's name: every baked file is `<name>.*`. */
  readonly name: string;
  /** The ground layer table's base and its blended layers, by material id. */
  readonly ground: {
    readonly base: string;
    readonly layers: readonly string[];
    readonly roughness: number;
  };
  /** The far ring around the playable square; omitted bakes none. */
  readonly farRing?: {
    readonly survey: string;
    /**
     * The playable heightmap's elevation offset in the survey's vertical datum. Without a
     * `backdrop` the ring is the survey itself, re-based by this to the square's metres.
     */
    readonly datum?: number;
    /** A generated landform on the survey's centre height; omitted, the ring is the real survey. */
    readonly backdrop?: {
      readonly id: string;
      readonly landform: LandformKind;
      readonly seed: number;
      readonly relief: number;
    };
    readonly seed: number;
    readonly layers: readonly Layer[];
    readonly massif?: {
      readonly tiles: readonly string[];
      readonly seed: number;
      readonly at: readonly [number, number];
      readonly face: number;
      readonly keepOut: number;
      readonly top: readonly [number, number];
    };
  };
  /** Starter-asset paths copied as named into the bake's output. */
  readonly art: readonly string[];
  /** Arbor plants baked into the output by stem (`growKitArborArt`), drawn by the pack like scans. */
  readonly arbor?: Readonly<Record<string, IKitArborArt>>;
}

interface ISurvey {
  readonly meta: {
    readonly resolution: number;
    readonly size: number;
    readonly sha256: string;
    readonly elevationOffset: number;
  };
  readonly bytes: Buffer;
}

/** One surveyed grid from `<assets>/survey/`, checked against its own hash. */
async function survey(assetsDir: string, name: string): Promise<ISurvey> {
  const meta = JSON.parse(await readFile(join(assetsDir, "survey", `${name}.json`), "utf8"));
  const bytes = await readFile(join(assetsDir, "survey", `${name}.bin`));
  assert.equal(bytes.length, meta.resolution ** 2 * 2, `${name}: truncated survey`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.sha256, `${name}: hash`);
  return { meta, bytes };
}

function decimetres({ meta, bytes }: ISurvey) {
  return {
    width: meta.resolution,
    height: meta.resolution,
    values: Array.from({ length: meta.resolution ** 2 }, (_, i) => bytes.readInt16LE(i * 2) / 10),
  };
}

/**
 * The mean height step, in metres, between the playable square's boundary and the far ring under
 * it. The collar fades this step over its first 40 m, so a ring on another datum draws a wall.
 */
export function ringSeam(
  square: { resolution: number; size: number; heights: ArrayLike<number> },
  ring: { resolution: number; size: number; height: ArrayLike<number> },
): number {
  const m = ring.resolution;
  const spacing = ring.size / (m - 1);
  const at = (x: number, z: number): number => {
    const c = Math.min(m - 2, Math.max(0, (x + ring.size / 2) / spacing));
    const r = Math.min(m - 2, Math.max(0, (z + ring.size / 2) / spacing));
    const c0 = Math.floor(c);
    const r0 = Math.floor(r);
    const g = (row: number, column: number) => ring.height[row * m + column] as number;
    const top = g(r0, c0) + (g(r0, c0 + 1) - g(r0, c0)) * (c - c0);
    const bottom = g(r0 + 1, c0) + (g(r0 + 1, c0 + 1) - g(r0 + 1, c0)) * (c - c0);
    return top + (bottom - top) * (r - r0);
  };
  const n = square.resolution;
  const step = square.size / (n - 1);
  let sum = 0;
  for (let i = 0; i < n; i += 1)
    for (const [row, column] of [
      [0, i],
      [n - 1, i],
      [i, 0],
      [i, n - 1],
    ] as const)
      sum += Math.abs(
        (square.heights[row * n + column] as number) -
          at(column * step - square.size / 2, row * step - square.size / 2),
      );
  return sum / (4 * n);
}

/** A seam past this many metres is a ring on the wrong datum, not relief the collar can blend. */
const RING_SEAM_LIMIT = 60;

/** The far ring: a generated backdrop on the surveyed ring's relief, then the kit's massif. */
async function farRing(assetsDir: string, ring: NonNullable<IKitWorldRecipe["farRing"]>) {
  const surveyed = await survey(assetsDir, ring.survey);
  const { meta } = surveyed;
  const values = decimetres(surveyed).values;
  let heights: number[];
  let id: string;
  if (ring.backdrop === undefined) {
    if (ring.datum === undefined)
      throw new Error(
        `TN_STARTER_RING_DATUM: the far ring on '${ring.survey}' has no backdrop, so it needs the playable heightmap's 'datum' to stand the survey on the square's metres.`,
      );
    const shift = meta.elevationOffset - ring.datum;
    heights = values.map((value) => value + shift);
    id = ring.survey;
  } else {
    heights = Array.from(
      landformBackdrop(ring.backdrop.landform, {
        size: meta.size,
        resolution: meta.resolution,
        seed: ring.backdrop.seed,
        relief: ring.backdrop.relief,
        centerHeight: values[((meta.resolution - 1) / 2) * (meta.resolution + 1)] as number,
      }).heights,
    );
    id = ring.backdrop.id;
  }
  const doc: ITerrainDocument = {
    version: 1,
    config: { size: meta.size, resolution: meta.resolution, seed: ring.seed },
    layers: [
      {
        enabled: true,
        opacity: 1,
        id,
        type: "heightmap",
        params: {
          data: {
            width: meta.resolution,
            height: meta.resolution,
            values: heights,
          },
        },
      } as Layer,
      ...ring.layers,
    ],
  };
  const terrain = Terrain.fromJSON(doc);
  if (ring.massif === undefined) return { state: terrain.evaluate(), massif: undefined };
  const tiles = [];
  for (const id of ring.massif.tiles) {
    const tile = await survey(assetsDir, `massif-${id}`);
    tiles.push({
      id,
      size: tile.meta.size,
      resolution: tile.meta.resolution,
      heights: Float32Array.from(
        { length: tile.meta.resolution ** 2 },
        (_, i) => tile.meta.elevationOffset + tile.bytes.readInt16LE(i * 2) / 10,
      ),
    });
  }
  const placed = placeMassif(terrain, {
    seed: ring.massif.seed,
    tile: tiles,
    at: [ring.massif.at[0], ring.massif.at[1]],
    face: ring.massif.face,
    keepOut: ring.massif.keepOut,
    top: [ring.massif.top[0], ring.massif.top[1]],
  });
  return { state: placed.terrain.evaluate(), massif: placed.placement };
}

/** A placed massif's heights for the collar's relief map: int16 decimetres above `offset`. */
function packMassif(detail: {
  origin: unknown;
  spacing: number;
  columns: number;
  rows: number;
  heights: ArrayLike<number>;
}) {
  const { origin, spacing, columns, rows, heights } = detail;
  let offset = Number.POSITIVE_INFINITY;
  for (let i = 0; i < heights.length; i++)
    offset = Math.min(offset, Math.floor(heights[i] as number));
  const bytes = Buffer.alloc(heights.length * 2);
  for (let i = 0; i < heights.length; i++) {
    const quantized = Math.round(((heights[i] as number) - offset) * 10);
    assert(quantized >= 0 && quantized <= 32767, "massif heights exceed int16 decimetres");
    bytes.writeInt16LE(quantized, i * 2);
  }
  return { origin, spacing, columns, rows, offset, heights: bytes.toString("base64") };
}

/** The splat the ground loader reads (`loadTerrainSplat`): eight raw planes, two RGBA images. */
function surfacePackage(state: ITerrainState, world: IKitWorldRecipe, look: IKitWorldLook) {
  const count = state.resolution ** 2;
  assert.equal(state.splat.length, count * MATERIAL_IDS.length, "invalid splat grid");
  const splat = new Uint8Array(count * 8);
  for (let row = 0; row < state.resolution; row += 1)
    for (let column = 0; column < state.resolution; column += 1)
      for (let channel = 0; channel < MATERIAL_IDS.length; channel += 1) {
        const value = state.splat[(row * state.resolution + column) * 8 + channel] as number;
        assert(Number.isFinite(value), "nonfinite splat channel");
        // Package ground is (x, -z): reverse the evaluator's increasing-Z rows.
        const pixel = (state.resolution - 1 - row) * state.resolution + column;
        splat[Math.floor(channel / 4) * count * 4 + pixel * 4 + (channel % 4)] = Math.round(
          Math.max(0, Math.min(1, value)) * 255,
        );
      }
  const layer = (id: string) => {
    const maps = look.ground.maps[id];
    if (maps === undefined) throw new Error(`bake: the kit's ground maps name no '${id}' layer`);
    return {
      id,
      tile: look.ground.tile[id],
      tint: [1, 1, 1],
      roughness: world.ground.roughness,
      metalness: 0,
      normal: maps.normal !== undefined,
      maps: {
        diffuse: `../${maps.diffuse}`,
        ...(maps.normal === undefined ? {} : { normal: `../${maps.normal}` }),
      },
    };
  };
  return {
    world: {
      version: 1,
      extent: {
        minX: -state.size / 2,
        minZ: -state.size / 2,
        sizeX: state.size,
        sizeZ: state.size,
      },
      terrain: {
        layers: { table: `${world.name}.layers.json`, splat: `${world.name}.splat.rgba8` },
      },
    },
    table: {
      base: layer(world.ground.base),
      layers: world.ground.layers.map((id) => ({
        ...layer(id),
        mask: id,
        channel: "r",
        lo: 0,
        hi: 1,
      })),
      breakup: { scale: 1, push: 0 },
      macro: { scale: 1, min: 1, max: 1 },
      textures: "",
      splat: {
        size: state.resolution,
        planes: 2,
        masks: Object.fromEntries(
          MATERIAL_IDS.map((id, index) => [
            id,
            [Math.floor(index / 4), ["r", "g", "b", "a"][index % 4]],
          ]),
        ),
      },
    },
    splat,
  };
}

/** The asset record a seeded run indexes: the streamed prop pack draws its own geometry, so the id
 *  and bounds a cell package would carry are not read here. Any species the file names resolves. */
/** Eight float32 a placement record: position xyz, quaternion xyzw, uniform scale. */
const RECORD_FLOATS = 8;

const SEEDED_ASSET: IWorldPackageAsset = {
  glb: "",
  bounds: { min: [0, 0, 0], max: [0, 0, 0] },
};

function seededAssetTable(
  placements: readonly IPlacement[],
): Readonly<Record<string, IWorldPackageAsset>> {
  return Object.fromEntries(
    [...new Set(placements.map((placement) => placement.asset))].map((asset) => [
      asset,
      SEEDED_ASSET,
    ]),
  );
}

/** One seeded cell record as the placement the prop writer buckets. */
function seededPlacement(
  records: Float32Array,
  ids: readonly string[],
  index: number,
  asset: string,
): IPlacement {
  const offset = index * RECORD_FLOATS;
  const value = (at: number): number => records[offset + at] as number;
  const position: [number, number, number] = [value(0), value(1), value(2)];
  const scale = value(7);
  return {
    id: ids[index] as string,
    layer: "seeded",
    asset,
    position,
    rotation: 0,
    scale,
    normal: [0, 1, 0],
    alignToNormal: false,
    transform: {
      position,
      quaternion: [value(3), value(4), value(5), value(6)],
      scale: [scale, scale, scale],
      grounding: false,
    },
  };
}

/** The cell package a seeded bake writes, decoded into the placements the prop writer buckets. */
function packagePlacements(pkg: IBakedWorldPackage): readonly IPlacement[] {
  const bytes = pkg.files[pkg.manifest.placements];
  const idBytes = pkg.files[pkg.manifest.placementIds ?? "placement-ids.json"];
  assert(bytes !== undefined && idBytes !== undefined, "the seeded package wrote no placements");
  const records = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const ids = JSON.parse(new TextDecoder().decode(idBytes)) as string[];
  const placements: IPlacement[] = [];
  for (const cell of pkg.manifest.cells)
    for (const run of cell.runs)
      for (let at = 0; at < run.count; at += 1)
        placements.push(seededPlacement(records, ids, run.offset + at, run.asset));
  return placements;
}

/** The streamed prop package: one manifest and one container per streamed world. */
async function writeProps(
  worldDir: string,
  name: string,
  placements: readonly IPlacement[],
  size: number,
  props: IKitWorldLook["props"],
) {
  const indices = new Map<string, number>();
  const entries = placements.map((placement) => {
    const variant = `${placement.asset}:${props.variantFor(placement, placement.asset)}`;
    const index = indices.get(variant) ?? 0;
    indices.set(variant, index + 1);
    const reach = props.streamedReach(placement, index);
    return {
      bucket: props.streamedBucket(placement, reach),
      key: props.propKey(placement),
      placement: props.withAuthoredPose(placement),
      reach,
    };
  });
  const pkg = compilePropBuckets(entries, {
    bounds: { minX: -size / 2, minZ: -size / 2, sizeX: size, sizeZ: size },
  });
  const { files, manifest } = propPackageFiles(pkg, name);
  await writeFile(join(worldDir, `${name}.props.json`), manifest);
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(worldDir, file), bytes);
  return pkg.buckets.map((bucket) => `${bucket.bucket} ${bucket.ids.length}`).join(", ");
}

/**
 * Bake a streamed world into `<out>/world/` and copy its art into `<out>/`: the field, its splat,
 * the far ring and its massif, the canopy and sky the ground reads, and the streamed props.
 */
export async function bakeStreamedWorld(options: {
  readonly kitDir: string;
  readonly assetsDir: string;
  readonly out: string;
  readonly recipe: { readonly recipe: ITerrainDocument; readonly world: IKitWorldRecipe };
  readonly look: IKitWorldLook;
}): Promise<void> {
  const { kitDir, assetsDir, out, look } = options;
  const { world: row } = options.recipe;
  const worldDir = join(out, "world");
  const started = performance.now();
  await mkdir(worldDir, { recursive: true });
  const state = Terrain.fromJSON(options.recipe.recipe).evaluate();
  for (const channel of ["flow", "sediment", "deposition", "talus"] as const)
    assert(state.erosion?.[channel]?.every(Number.isFinite), `missing or nonfinite ${channel}`);
  const surface = surfacePackage(state, row, look);
  await writeFile(join(worldDir, `${row.name}.world.json`), JSON.stringify(surface.world));
  await writeFile(join(worldDir, `${row.name}.layers.json`), JSON.stringify(surface.table));
  await writeFile(join(worldDir, `${row.name}.splat.rgba8`), surface.splat);

  const spec = validateBiome(
    JSON.parse(await readFile(join(kitDir, "biome.data.json"), "utf8")),
    row.name,
  );
  // A seeded biome file states its stand itself, so its rows become the scatter rules the four
  // stages run; the ordered stream already emits the game's own placements and needs no bridge.
  const seeded = spec.stream === "seeded";
  const placed = seeded
    ? finalizeState({
        ...state,
        scatterRules: [...state.scatterRules, ...foliageScatterRules(spec.foliage, state.height)],
      })
    : state;
  const biome = bakeBiome({
    state: placed,
    spec,
    ...(seeded ? { assets: seededAssetTable(placed.instances), stream: "seeded" as const } : {}),
  });
  const placements =
    biome.scatter?.placements ??
    (biome.package === null ? undefined : packagePlacements(biome.package));
  if (placements === undefined)
    throw new Error(
      `TN_STARTER_STREAM_DATA: the '${row.name}' kit's biome file places nothing on the streamed path (stream '${spec.stream}'). Give its rows a stand the stages accept, or check the ordered generators.`,
    );
  const colors = bakeMesh(state, { palette: look.palette }).colors;
  assert(colors !== undefined, "the kit's palette baked no ground colours");
  const baked = {
    size: state.size,
    resolution: state.resolution,
    heights: Array.from(state.height),
    colors: Array.from(colors),
    erosion: Object.fromEntries(
      Object.entries(state.erosion ?? {}).map(([key, values]) => [
        key,
        Array.from((values ?? []) as ArrayLike<number>, (value) => Math.round(value * 1000) / 1000),
      ]),
    ),
    rivers: state.rivers,
    waterLevel: state.waters.find((water) => water.kind === "ocean")?.level ?? null,
    lakes: state.waters
      .filter((water) => water.kind === "lake")
      .map(({ id, at, radius, level }) => ({ id, at, radius, level })),
  };
  await writeFile(join(worldDir, `${row.name}.json`), JSON.stringify(baked));

  if (row.farRing !== undefined) {
    const ring = await farRing(assetsDir, row.farRing);
    const seam = ringSeam(baked, ring.state);
    if (!(seam <= RING_SEAM_LIMIT))
      throw new Error(
        `TN_STARTER_RING_SEAM: the '${row.name}' far ring stands ${seam.toFixed(1)} m off the playable square's edge (limit ${RING_SEAM_LIMIT} m); the collar would draw that step as a wall. Give the ring the square's 'datum', or a backdrop on the square's metres.`,
      );
    await writeFile(
      join(worldDir, "horizon.json"),
      JSON.stringify({
        [row.name]: {
          size: ring.state.size,
          resolution: ring.state.resolution,
          heights: Array.from(ring.state.height, (height) => Math.round(height * 10) / 10),
          ...(ring.massif === undefined ? {} : { massif: packMassif(ring.massif.detail) }),
        },
      }),
    );
  }

  const canopy = new Float32Array(baked.resolution ** 2);
  paintCanopyCover(canopy, baked, placements, look.canopy);
  await writeFile(
    join(worldDir, `${row.name}.canopy.bin`),
    new Uint8Array(canopy.buffer, canopy.byteOffset, canopy.byteLength),
  );
  // The share of the sky each vertex sees past the relief, one byte a vertex, for the ground's AO.
  const sky = skyVisibility(baked.heights, baked.resolution, baked.size);
  await writeFile(
    join(worldDir, `${row.name}.sky.bin`),
    Uint8Array.from(sky, (v) => Math.round(v * 255)),
  );
  const buckets = await writeProps(worldDir, row.name, placements, baked.size, look.props);

  for (const path of row.art) await cp(join(assetsDir, path), join(out, path), { recursive: true });
  const grown = await growKitArborArt(row.arbor ?? {}, kitDir, out, assetsDir);
  console.log(
    `${row.name}: ${placements.length} placements (${buckets}); ${row.art.length} art entries; ${grown.length} Arbor files; ${((performance.now() - started) / 1000).toFixed(1)} s -> ${out}`,
  );
}
