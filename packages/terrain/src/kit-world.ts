// The streamed-world bake every kit shares: the recipe and biome rows are the kit's data, the look
// and the prop policy come from the kit's own source through `IKitWorldLook`.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bakeBiome } from "./biome/bake-biome.js";
import { validateBiome } from "./biome/biome.js";
import { MATERIAL_IDS } from "./core/masks.js";
import { Terrain } from "./core/terrain.js";
import type { IPlacement, ITerrainDocument, ITerrainState, Layer } from "./core/types.js";
import { paintCanopyCover } from "./ground/canopy.js";
import { placeMassif } from "./ground/massif.js";
import { type LandformKind, landformBackdrop } from "./ground/presets.js";
import { skyVisibility } from "./ground/sky-visibility.js";
import { bakeMesh } from "./package/bake.js";
import { compilePropBuckets, propPackageFiles } from "./package/prop-package.js";

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
    readonly backdrop: {
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

/** The far ring: a generated backdrop on the surveyed ring's relief, then the kit's massif. */
async function farRing(assetsDir: string, ring: NonNullable<IKitWorldRecipe["farRing"]>) {
  const surveyed = await survey(assetsDir, ring.survey);
  const { meta } = surveyed;
  const values = decimetres(surveyed).values;
  const backdrop = landformBackdrop(ring.backdrop.landform, {
    size: meta.size,
    resolution: meta.resolution,
    seed: ring.backdrop.seed,
    relief: ring.backdrop.relief,
    centerHeight: values[((meta.resolution - 1) / 2) * (meta.resolution + 1)] as number,
  });
  const doc: ITerrainDocument = {
    version: 1,
    config: { size: meta.size, resolution: meta.resolution, seed: ring.seed },
    layers: [
      {
        enabled: true,
        opacity: 1,
        id: ring.backdrop.id,
        type: "heightmap",
        params: {
          data: {
            width: meta.resolution,
            height: meta.resolution,
            values: Array.from(backdrop.heights),
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
  const { scatter } = bakeBiome({ state, spec });
  assert(scatter !== null, "the biome file places nothing");
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
  paintCanopyCover(canopy, baked, scatter.placements, look.canopy);
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
  const buckets = await writeProps(worldDir, row.name, scatter.placements, baked.size, look.props);

  for (const path of row.art) await cp(join(assetsDir, path), join(out, path), { recursive: true });
  console.log(
    `${row.name}: ${scatter.placements.length} placements (${buckets}); ${row.art.length} art entries; ${((performance.now() - started) / 1000).toFixed(1)} s -> ${out}`,
  );
}
