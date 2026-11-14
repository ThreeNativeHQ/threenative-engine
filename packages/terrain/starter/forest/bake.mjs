// The forest's bake: `node src/terrain/forest/bake.mjs [--out <dir>]` (default `assets/terrain/forest`).
//
// It evaluates the surveyed Sprague Lake valley (USGS 3DEP, public domain), erodes it, floods its lake
// and river, places the biome file's stands, and writes what the game fetches under `<out>/world/`:
// the field, its splat, the far ring and its massif, the canopy and sky the ground shader reads, and
// the streamed prop containers. It then copies the CC0 art the forest draws from the terrain
// package's starter assets into `<out>/`. The game loads all of it through `forestAssets`.
//
// It imports this kit's own TypeScript (`render/`, `world/`) for the placement policy and the canopy,
// so it runs under `tsx` (`npm i -D tsx`).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MATERIAL_IDS,
  Mask,
  Terrain,
  bakeBiome,
  bakeMesh,
  compilePropBuckets,
  landformBackdrop,
  placeMassif,
  propPackageFiles,
  validateBiome,
} from "@threenative/terrain";
import { starterAssetsDir } from "@threenative/terrain/kit";
import { BufferGeometry, Float32BufferAttribute, Mesh } from "three";
import { register } from "tsx/esm/api";

register();
const here = dirname(fileURLToPath(import.meta.url));
const { terrainPalette } = await import("./render/ground/palette.js");
const { GROUND_MAPS, GROUND_TILE } = await import("./world/terrainAssets.ts");
const { paintCanopy } = await import("./render/ground/terrain.ts");
const { skyVisibility } = await import("./render/sky/skyVisibility.ts");
const { propKey, streamedBucket, streamedReach, variantFor, withAuthoredPose } = await import(
  "./render/props/props.ts"
);

const at = process.argv.indexOf("--out");
const given = at === -1 ? "assets/terrain/forest" : process.argv[at + 1];
if (!given || given.startsWith("--"))
  throw new Error("bake: --out needs a nonempty directory value");
const out = resolve(given);
const worldDir = join(out, "world");
const starter = await starterAssetsDir();

/** The CC0 art the forest draws, copied from the starter assets as it is named there. */
const ART = [
  "bark_brown_02",
  "boulder_01",
  "celandine_01",
  "dandelion_01",
  "dead_tree_trunk",
  "dry_branches_medium_01",
  "fern_02",
  "forest_ground_04",
  "grass_medium",
  "leafy_grass",
  "lichen_rock",
  "moss_01",
  "mossy_rock",
  "nettle_plant",
  "periwinkle_plant",
  "river_small_rocks",
  "rock_boulder_dry",
  "rock_face",
  "rocks",
  "sand_01",
  "shrub_02",
  "shrub_04",
  "snow_02",
  "tree_small_02",
  "tree_stump_01",
  "weed_plant_02",
  "needle-atlas.png",
  "needle-surface.png",
  "fir_tree_01/fir_tree_01_twig_arm_1k.jpg",
  "fir_tree_01/fir_tree_01_twig_diff_1k.jpg",
  "fir_tree_01/fir_tree_01_twig_nor_gl_1k.jpg",
  "hdri/kloofendal_48d_partly_cloudy_2k.hdr",
  "mannequin-swim.glb",
];

/** One surveyed grid from `starter-assets/survey/`, checked against its own hash. */
async function survey(name) {
  const meta = JSON.parse(await readFile(join(starter, "survey", `${name}.json`), "utf8"));
  const bytes = await readFile(join(starter, "survey", `${name}.bin`));
  assert.equal(bytes.length, meta.resolution ** 2 * 2, `${name}: truncated survey`);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), meta.sha256, `${name}: hash`);
  return { meta, bytes };
}
const decimetres = ({ meta, bytes }) => ({
  width: meta.resolution,
  height: meta.resolution,
  values: Array.from({ length: meta.resolution ** 2 }, (_, i) => bytes.readInt16LE(i * 2) / 10),
});

// Sprague Lake's hydro-flattened survey measures the water surface, not its bed: the valley and
// shore stay surveyed, and a shallow lake bed and a creek are authored into that surface.
const dem = decimetres(await survey("forest"));
const recipe = new Terrain({ size: 512, resolution: 257, seed: 73 })
  .heightmap({ id: "usgs-3dep", data: dem })
  .erode({
    id: "surface-runoff",
    method: "hydraulic",
    droplets: 20000,
    maxSteps: 45,
    capacity: 2,
    erosion: 0.015,
    strength: 0.002,
    deposition: 0.2,
    evaporation: 0.035,
  })
  .erode({ id: "loose-talus", method: "thermal", talus: 38, iterations: 1, rate: 0.004 })
  .materials({
    id: "surfaces",
    rules: [
      { material: "dirt", mask: Mask.noise(78, 0.52, 73, 0.32), strength: 0.5 },
      { material: "rock", mask: Mask.slope(34, 90, 9) },
    ],
  })
  .road({
    id: "access-road",
    followTerrain: true,
    points: [
      [-240, null, -185],
      [-150, null, -185],
      [-125, null, -185],
    ],
    width: 6,
    shoulder: 4,
  })
  .flatten({ id: "building-pad", at: [-160, -180], radius: 12, falloff: 0.75 })
  .paint({ id: "pad-surface", at: [-160, -180], radius: 12, material: "dirt" })
  .flatten({
    id: "lake-bed",
    at: [-70, 25],
    radius: 105,
    height: 11.4,
    falloff: 0.1,
    mask: Mask.height(12.8, 13.3, 0.1),
  })
  .river({
    id: "river",
    followTerrain: true,
    points: [
      [-120, null, -220],
      [-110, null, -175],
      [-120, null, -130],
      [-100, null, -95],
      [-70, null, -60],
    ],
    width: 7,
    depth: 1.8,
    shoulder: 10,
    enforceDownhill: true,
  })
  .water({ id: "lake", kind: "lake", at: [-70, 25], radius: 105, level: 13.3 })
  // What a full-world export places; the game draws its own runtime scatter, not these.
  .scatter({
    id: "stand",
    asset: "spruce",
    count: 120,
    minDistance: 8,
    maxSlope: 35,
    avoidWater: true,
    scale: [0.9, 1.5],
  });

/**
 * The far ring: Glacier Creek's relief (865 m over 5 km) as a generated temperate backdrop, ridged
 * crests and spurs above the treeline, and one whole surveyed mountain standing 2.4 km from the
 * vista eye, its steepest wall turned south into the low sun.
 */
async function continuation() {
  const { meta } = await survey("forest-horizon");
  const ring = decimetres(await survey("forest-horizon"));
  const backdrop = landformBackdrop("temperateMountains", {
    size: meta.size,
    resolution: meta.resolution,
    seed: 23,
    relief: 865,
    centerHeight: ring.values[((meta.resolution - 1) / 2) * (meta.resolution + 1)],
  });
  const crested = new Terrain({ size: meta.size, resolution: meta.resolution, seed: 1 })
    .heightmap({
      id: "usgs-surroundings",
      data: { width: meta.resolution, height: meta.resolution, values: backdrop.heights },
    })
    .noise({
      id: "crests",
      mode: "ridged",
      amplitude: 170,
      scale: 1100,
      octaves: 3,
      warp: 300,
      mask: Mask.height(320, 1e9, 200),
    })
    .noise({
      id: "spurs",
      mode: "fbm",
      amplitude: 45,
      scale: 320,
      octaves: 3,
      warp: 150,
      mask: Mask.height(200, 1e9, 80),
    })
    .erode({
      id: "gullies",
      method: "hydraulic",
      droplets: 40000,
      mask: Mask.height(380, 1e9, 160),
    });
  const tiles = [];
  for (const id of ["longs", "teton", "maroon"]) {
    const tile = await survey(`massif-${id}`);
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
  const placed = placeMassif(crested, {
    seed: 6,
    tile: tiles,
    at: [-2050, -150],
    face: 90,
    keepOut: 650,
    top: [1100, 1160],
  });
  return { state: placed.terrain.evaluate(), massif: placed.placement };
}

/** A placed massif's 4 m heights for the collar's relief map: int16 decimetres above `offset`. */
function packMassif({ origin, spacing, columns, rows, heights }) {
  let offset = Number.POSITIVE_INFINITY;
  for (const height of heights) offset = Math.min(offset, Math.floor(height));
  const bytes = Buffer.alloc(heights.length * 2);
  for (let i = 0; i < heights.length; i++) {
    const quantized = Math.round((heights[i] - offset) * 10);
    assert(quantized >= 0 && quantized <= 32767, "massif heights exceed int16 decimetres");
    bytes.writeInt16LE(quantized, i * 2);
  }
  return { origin, spacing, columns, rows, offset, heights: bytes.toString("base64") };
}

/** The splat the ground loader reads (`loadTerrainSplat`): eight raw planes, two RGBA images. */
function surfacePackage(state) {
  const count = state.resolution ** 2;
  assert.equal(state.splat.length, count * MATERIAL_IDS.length, "invalid splat grid");
  const splat = new Uint8Array(count * 8);
  for (let row = 0; row < state.resolution; row += 1)
    for (let column = 0; column < state.resolution; column += 1)
      for (let channel = 0; channel < MATERIAL_IDS.length; channel += 1) {
        const value = state.splat[(row * state.resolution + column) * 8 + channel];
        assert(Number.isFinite(value), "nonfinite splat channel");
        // Package ground is (x, -z): reverse the evaluator's increasing-Z rows.
        const pixel = (state.resolution - 1 - row) * state.resolution + column;
        splat[Math.floor(channel / 4) * count * 4 + pixel * 4 + (channel % 4)] = Math.round(
          Math.max(0, Math.min(1, value)) * 255,
        );
      }
  const maps = {
    ...GROUND_MAPS,
    dirt: {
      diffuse: "river_small_rocks/river_small_rocks_diff_512.jpg",
      normal: "river_small_rocks/river_small_rocks_nor_gl_512.jpg",
    },
  };
  const layer = (id) => ({
    id,
    tile: GROUND_TILE[id],
    tint: [1, 1, 1],
    roughness: 0.95,
    metalness: 0,
    normal: maps[id].normal !== undefined,
    maps: {
      diffuse: `../${maps[id].diffuse}`,
      ...(maps[id].normal === undefined ? {} : { normal: `../${maps[id].normal}` }),
    },
  });
  return {
    world: {
      version: 1,
      extent: {
        minX: -state.size / 2,
        minZ: -state.size / 2,
        sizeX: state.size,
        sizeZ: state.size,
      },
      terrain: { layers: { table: "forest.layers.json", splat: "forest.splat.rgba8" } },
    },
    table: {
      base: layer("grass"),
      layers: ["dirt", "moss", "sand", "rock", "snow"].map((id) => ({
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
async function writeProps(placements, size) {
  const indices = new Map();
  const entries = placements.map((placement) => {
    const variant = `${placement.asset}:${variantFor(placement, placement.asset)}`;
    const index = indices.get(variant) ?? 0;
    indices.set(variant, index + 1);
    const reach = streamedReach(placement, index);
    return {
      bucket: streamedBucket(placement, reach),
      key: propKey(placement),
      placement: withAuthoredPose(placement),
      reach,
    };
  });
  const pkg = compilePropBuckets(entries, {
    bounds: { minX: -size / 2, minZ: -size / 2, sizeX: size, sizeZ: size },
  });
  const { files, manifest } = propPackageFiles(pkg, "forest");
  await writeFile(join(worldDir, "forest.props.json"), manifest);
  for (const [file, bytes] of Object.entries(files)) await writeFile(join(worldDir, file), bytes);
  return pkg.buckets.map((bucket) => `${bucket.bucket} ${bucket.ids.length}`).join(", ");
}

const started = performance.now();
await mkdir(worldDir, { recursive: true });
const state = recipe.evaluate();
for (const channel of ["flow", "sediment", "deposition", "talus"])
  assert(state.erosion?.[channel]?.every(Number.isFinite), `missing or nonfinite ${channel}`);
const surface = surfacePackage(state);
await writeFile(join(worldDir, "forest.world.json"), JSON.stringify(surface.world));
await writeFile(join(worldDir, "forest.layers.json"), JSON.stringify(surface.table));
await writeFile(join(worldDir, "forest.splat.rgba8"), surface.splat);

const spec = validateBiome(
  JSON.parse(readFileSync(join(here, "biome.data.json"), "utf8")),
  "forest",
);
const { scatter } = bakeBiome({ state, spec });
assert(scatter !== null, "the biome file places nothing");
const world = {
  size: state.size,
  resolution: state.resolution,
  heights: Array.from(state.height),
  colors: Array.from(bakeMesh(state, { palette: terrainPalette }).colors),
  erosion: Object.fromEntries(
    Object.entries(state.erosion ?? {}).map(([key, values]) => [
      key,
      Array.from(values, (value) => Math.round(value * 1000) / 1000),
    ]),
  ),
  rivers: state.rivers,
  waterLevel: state.waters.find((water) => water.kind === "ocean")?.level ?? null,
  lakes: state.waters
    .filter((water) => water.kind === "lake")
    .map(({ id, at, radius, level }) => ({ id, at, radius, level })),
};
await writeFile(join(worldDir, "forest.json"), JSON.stringify(world));

const ring = await continuation();
await writeFile(
  join(worldDir, "horizon.json"),
  JSON.stringify({
    forest: {
      size: ring.state.size,
      resolution: ring.state.resolution,
      heights: Array.from(ring.state.height, (height) => Math.round(height * 10) / 10),
      massif: packMassif(ring.massif.detail),
    },
  }),
);

const mesh = new Mesh(new BufferGeometry());
mesh.geometry.setAttribute(
  "canopy",
  new Float32BufferAttribute(new Float32Array(world.resolution ** 2), 1),
);
paintCanopy(mesh, world, scatter.placements);
const canopy = mesh.geometry.getAttribute("canopy").array;
await writeFile(
  join(worldDir, "forest.canopy.bin"),
  new Uint8Array(canopy.buffer, canopy.byteOffset, canopy.byteLength),
);
// The share of the sky each vertex sees past the relief, one byte a vertex, for the ground's AO.
const sky = skyVisibility(world.heights, world.resolution, world.size);
await writeFile(
  join(worldDir, "forest.sky.bin"),
  Uint8Array.from(sky, (v) => Math.round(v * 255)),
);
const buckets = await writeProps(scatter.placements, world.size);

for (const path of ART) await cp(join(starter, path), join(out, path), { recursive: true });
console.log(
  `forest: ${scatter.placements.length} placements (${buckets}); ${ART.length} art entries; ${((performance.now() - started) / 1000).toFixed(1)} s -> ${out}`,
);
