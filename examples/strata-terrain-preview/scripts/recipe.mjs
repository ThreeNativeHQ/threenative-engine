// The five worlds' landform recipes and their surface manifests, as a module.
//
// `bake.mjs` is the orchestration now: it evaluates a recipe, asks `bakeBiome` for the biome's own
// placements and writes the game's containers. The recipe chain itself lives here, unchanged from
// the script it came out of, so the bake reads as one loop instead of six hundred lines of authoring
// between it and its output. `pnpm bake` runs `bake.mjs`; nothing else imports this module.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  MATERIAL_IDS,
  Mask,
  Terrain,
  bakeMesh,
  landformBackdrop,
  placeMassif,
} from "@threenative/terrain";
import { terrainPalette } from "../src/render/palette.js";
import { WORLD_NAMES } from "../src/render/worldNames.js";

const { GROUND_MAPS, GROUND_TILE } = await import("../src/world/terrainAssets.js");

/** Existing surface-loader descriptor; raw planes preserve all eight authored material channels. */
export function terrainSurfacePackage(name, state, maps) {
  const count = state.resolution ** 2;
  assert.equal(state.height.length, count, `${name}: invalid height grid`);
  assert.equal(state.splat.length, count * MATERIAL_IDS.length, `${name}: invalid splat grid`);
  const splat = new Uint8Array(count * 8);
  for (let row = 0; row < state.resolution; row += 1)
    for (let column = 0; column < state.resolution; column += 1)
      for (let channel = 0; channel < MATERIAL_IDS.length; channel += 1) {
        const value = state.splat[(row * state.resolution + column) * 8 + channel];
        assert(Number.isFinite(value), `${name}: nonfinite splat channel`);
        // Package ground is (x, -z): reverse the evaluator's increasing-Z rows.
        const pixel = (state.resolution - 1 - row) * state.resolution + column;
        splat[Math.floor(channel / 4) * count * 4 + pixel * 4 + (channel % 4)] = Math.round(
          Math.max(0, Math.min(1, value)) * 255,
        );
      }
  const layer = (id) => {
    // Match loadGroundMaps' CC0 fallback; licensed overrides stay game-owned and are not staged.
    const source = maps[id].diffuse.startsWith("temperate/") ? GROUND_MAPS[id] : maps[id];
    return {
      id,
      tile: GROUND_TILE[id],
      tint: [1, 1, 1],
      roughness: 0.95,
      metalness: 0,
      normal: source.normal !== undefined,
      maps: {
        diffuse: `../${source.diffuse}`,
        ...(source.normal === undefined ? {} : { normal: `../${source.normal}` }),
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
      terrain: { layers: { table: `${name}.layers.json`, splat: `${name}.splat.rgba8` } },
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

// Authoring runs before either runtime is bundled. The game imports only the baked JSON.

// Public-domain surveyed elevations; one offset and orientation are shared by detail and horizon.
export const dem = {};
for (const name of WORLD_NAMES.flatMap((name) => [name, `${name}-horizon`])) {
  const meta = JSON.parse(await readFile(new URL(`dem/${name}.json`, import.meta.url), "utf8"));
  const bytes = await readFile(new URL(`dem/${name}.bin`, import.meta.url));
  assert.equal(meta.encoding, "int16-le-decimetres-relative-to-elevationOffset");
  assert.equal(bytes.length, meta.resolution ** 2 * 2, `${name}: truncated DEM`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    meta.sha256,
    `${name}: DEM hash mismatch`,
  );
  dem[name] = {
    size: meta.size,
    resolution: meta.resolution,
    data: {
      width: meta.resolution,
      height: meta.resolution,
      values: Array.from({ length: meta.resolution ** 2 }, (_, i) => bytes.readInt16LE(i * 2) / 10),
    },
  };
}

/** Whole surveyed mountains, foot to foot at 4 m (`scripts/dem/massif.mjs`), for `placeMassif`. */
export const MASSIF_TILES = [];
/** The seed the pinned forest stands its massif with. */
const MASSIF_SEED = Number(process.env.STRATA_MASSIF_SEED ?? 6);
for (const id of ["longs", "teton", "maroon"]) {
  const meta = JSON.parse(
    await readFile(new URL(`dem/massif-${id}.json`, import.meta.url), "utf8"),
  );
  const bytes = await readFile(new URL(`dem/massif-${id}.bin`, import.meta.url));
  assert.equal(bytes.length, meta.resolution ** 2 * 2, `massif-${id}: truncated tile`);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    meta.sha256,
    `massif-${id}: tile hash mismatch`,
  );
  MASSIF_TILES.push({
    id,
    size: meta.size,
    resolution: meta.resolution,
    heights: Float32Array.from(
      { length: meta.resolution ** 2 },
      (_, i) => meta.elevationOffset + bytes.readInt16LE(i * 2) / 10,
    ),
  });
}

// The Sprague Lake hydro-flattened survey measures the water surface, not its bed.
// Retain the real valley and shore; author shallow bathymetry and a creek into that surface.
/**
 * `STRATA_WORLD=<terrain_generate out dir>` bakes the forest from a cooked world (PRD-866): its
 * recipe (ground, erosion and water layers, and its seed) and its far ring, under this example's own
 * biome row and look. Unset, the forest is the pinned survey below.
 */
export const cooked = process.env.STRATA_WORLD
  ? {
      recipe: JSON.parse(
        await readFile(
          new URL("recipe.json", pathToFileURL(`${process.env.STRATA_WORLD}/`)),
          "utf8",
        ),
      ),
      ring: JSON.parse(
        await readFile(new URL("ring.json", pathToFileURL(`${process.env.STRATA_WORLD}/`)), "utf8"),
      ),
    }
  : undefined;

const pinnedForest = new Terrain({ size: 512, resolution: 257, seed: 73 })
  .heightmap({ id: "usgs-3dep", data: dem.forest.data })
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
export const coastal = new Terrain({ size: 512, resolution: 257, seed: 73 })
  .heightmap({ id: "usgs-3dep", data: dem.coastal.data })
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
  .erode({ id: "loose-talus", method: "thermal", talus: 48, iterations: 1, rate: 0.004 })
  .materials({
    id: "surfaces",
    rules: [
      { material: "rock", mask: Mask.slope(35, 90, 10) },
      { material: "sand", mask: Mask.height(-1000, 6, 4) },
    ],
  })
  .water({ id: "ocean", kind: "ocean", level: 1.5, radius: 512 })
  .scatter({
    id: "stand",
    asset: "spruce",
    count: 80,
    minDistance: 8,
    minHeight: 4,
    maxSlope: 35,
    avoidWater: true,
    scale: [0.9, 1.4],
  });
// Real glaciated granite and bedded sandstone. Only a light transport pass follows the survey:
// no fabricated ridges, shelves, dunes, river cuts or smoothing of the measured landform.
export const alpine = new Terrain({ size: 512, resolution: 257, seed: 41 })
  .heightmap({ id: "usgs-3dep", data: dem.alpine.data })
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
  .erode({ id: "loose-talus", method: "thermal", talus: 48, iterations: 1, rate: 0.004 })
  .materials({
    id: "surfaces",
    rules: [
      { material: "rock", mask: Mask.all() },
      { material: "dirt", mask: Mask.slope(20, 38, 6), strength: 0.4 },
      { material: "snow", mask: Mask.and(Mask.height(80, 1e9, 60), Mask.slope(0, 42, 8)) },
    ],
  })
  .scatter({
    id: "scree",
    asset: "boulder",
    count: 90,
    minDistance: 6,
    minSlope: 15,
    maxSlope: 45,
    scale: [0.6, 1.6],
  });
export const desert = new Terrain({ size: 512, resolution: 257, seed: 97 })
  .heightmap({ id: "usgs-3dep", data: dem.desert.data })
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
  .erode({ id: "loose-talus", method: "thermal", talus: 60, iterations: 1, rate: 0.004 })
  .materials({
    id: "surfaces",
    rules: [
      { material: "sand", mask: Mask.all() },
      { material: "dirt", mask: Mask.noise(40, 0.7, 97, 0.2), strength: 0.25 },
      { material: "rock", mask: Mask.slope(28, 90, 8) },
    ],
  })
  .scatter({
    id: "scrub",
    asset: "scrub",
    count: 140,
    minDistance: 5,
    maxSlope: 25,
    scale: [0.7, 1.3],
  });
// Measured low-relief alpine basin; the retained playable meltwater/pond beds are authored.
export const tundra = new Terrain({ size: 512, resolution: 257, seed: 131 })
  .heightmap({ id: "usgs-3dep", data: dem.tundra.data })
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
  .flatten({ id: "near-kettle-bed", at: [65, 80], radius: 30, height: 27, falloff: 0.65 })
  .flatten({ id: "far-kettle-bed", at: [-65, -50], radius: 42, height: 28, falloff: 0.65 })
  .river({
    id: "meltwater",
    points: [
      [-210, 36, -135],
      [-125, 33, -80],
      [-100, 30, -90],
      [-65, 30, -50],
      [-30, 30, -15],
      [0, 29.3, 5],
      [38, 28.8, 47],
      [65, 28.8, 80],
      [100, 28.8, 100],
      [160, 27, 140],
      [250, 26, 150],
    ],
    width: 7,
    depth: 1.5,
    shoulder: 18,
    enforceDownhill: true,
  })
  .river({
    id: "braid",
    points: [
      [-65, 30, -50],
      [-40, 30, -18],
      [-30, 29.4, 40],
      [15, 28.8, 105],
      [65, 28.8, 80],
    ],
    width: 4,
    depth: 1.2,
    shoulder: 12,
    enforceDownhill: true,
  })
  .water({ id: "near-kettle", kind: "lake", at: [65, 80], radius: 34, level: 28.8 })
  .water({ id: "far-kettle", kind: "lake", at: [-65, -50], radius: 46, level: 30 })
  .materials({
    id: "surfaces",
    rules: [
      { material: "moss", mask: Mask.all() },
      { material: "snow", mask: Mask.noise(85, 0.68, 131, 0.3), strength: 0.6 },
      { material: "rock", mask: Mask.slope(23, 90, 8) },
    ],
  })
  .scatter({
    id: "erratics",
    asset: "boulder",
    count: 70,
    minDistance: 8,
    maxSlope: 30,
    avoidWater: true,
    scale: [0.6, 1.8],
  });
// Forest/coast keep their existing bundle. The other three are separate lazy imports: every
// baked world is a 257-square of heights/colours, so bundling all five would add about 15 MB
// to the initial page module.
export const drawn = new Set(["forest", "coastal"]);
export const outputDir = new URL("../src/world/", import.meta.url);
export const forest = cooked ? Terrain.fromJSON(cooked.recipe) : pinnedForest;
export const recipes = { forest, coastal, alpine, desert, tundra };

/**
 * One world as the game reads it: the baked field, its colour, the transport the erosion passes
 * measured and the water it floods. `data` is what `paintCanopy` and the ground material read.
 */
export function worldOf(state) {
  return {
    size: state.size,
    resolution: state.resolution,
    heights: Array.from(state.height),
    colors: Array.from(bakeMesh(state, { palette: terrainPalette }).colors),
    // Actual transport from the installed erosion passes, not a curvature/noise proxy.
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
}

// The forest's surveyed surroundings read as smooth rounded blobs at this resolution, so its
// backdrop is generated instead: Glacier Creek's relief (865 m over 5 km, `forest-horizon.json`)
// with fluvial drainage, a valley floor at the centre and the survey's own ground height there.
const forestSurvey = dem["forest-horizon"];
const forestBackdrop = landformBackdrop("temperateMountains", {
  size: forestSurvey.size,
  resolution: forestSurvey.resolution,
  seed: 23,
  relief: 865,
  centerHeight:
    forestSurvey.data.values[((forestSurvey.resolution - 1) / 2) * (forestSurvey.resolution + 1)],
});
/** Each world's placed massif: its tile, pose and 4 m heights, for the bake's relief file. */
export const massif = {};
export const realContinuation = Object.fromEntries(
  Object.keys(recipes).flatMap((name) => {
    const source =
      name === "forest"
        ? {
            ...forestSurvey,
            data: {
              width: forestSurvey.resolution,
              height: forestSurvey.resolution,
              values: forestBackdrop.heights,
            },
          }
        : dem[`${name}-horizon`];
    const surroundings = () =>
      new Terrain({
        size: source.size,
        resolution: source.resolution,
        seed: 1,
      }).heightmap({ id: "usgs-surroundings", data: source.data });
    if (name === "forest" && cooked) {
      // The cook's own ring: its survey continued, its massif already standing in it.
      const { size, resolution, heights } = cooked.ring;
      return [
        [
          name,
          new Terrain({ size, resolution, seed: 1 }).heightmap({
            id: "cooked-ring",
            data: { width: resolution, height: resolution, values: heights },
          }),
        ],
      ];
    }
    return name === "forest"
      ? [[name, nearMassif(alpineCrests(surroundings()))]]
      : [[name, surroundings()]];
  }),
);

/**
 * The vista's near massif (owner, 2026-11-04: "make sure we have the proper mountain on this
 * capture"; 2026-11-09: "think about heightmaps etc. real shapes"). A whole surveyed mountain, foot
 * to foot at 4 m, stands with its summit 2.4 km from the vista eye (`BENCHMARK.forest.poses.vista`),
 * left of its look line, its steepest wall turned south into the low sun. `forest-backdrop.spec.ts` measures
 * the skyline from that eye; `massif` keeps the placement and its 4 m heights for the relief map.
 */
function nearMassif(terrain) {
  const placed = placeMassif(terrain, {
    seed: MASSIF_SEED,
    tile: MASSIF_TILES,
    at: [-2050, -150],
    // South: the sun stands west-south-west, so a north-east face toward the vista is backlit.
    face: 90,
    keepOut: 650,
    top: [1100, 1160],
  });
  massif.forest = placed.placement;
  return placed.terrain;
}

/**
 * The fluvial pass alone leaves one smooth 30 degree wall cut by straight, evenly spaced radial
 * channels: under a 36 degree sun every other channel wall is at grazing light, which read as
 * vertical light streaks. Ridged crests above 320 m break it into separate peaks with cliffs
 * (owner goal 2026-11-04: rocky alpine peaks); fbm spurs above 200 m bend the channels. Both masks
 * are zero below 120 m, so the valley floor, the seam with the playable square and the vista's near
 * meadow keep their surveyed height.
 */
function alpineCrests(terrain) {
  return terrain
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
      // Droplet erosion above the treeline cuts the gullies and sharp aretes the owner asked for
      // ("mountain tops textures and heightmaps suck", 2026-11-04); a thermal pass smoothed them and
      // terraces read as stair steps. 40000 droplets keep curvature kurtosis above 40.
      id: "gullies",
      method: "hydraulic",
      droplets: 40000,
      mask: Mask.height(380, 1e9, 160),
    });
}
