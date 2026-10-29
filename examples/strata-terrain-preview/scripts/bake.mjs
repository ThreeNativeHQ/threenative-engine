import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { Heightfield } from "@threenative/core/world";
import { BufferGeometry, Float32BufferAttribute, Mesh } from "three";
import { register } from "tsx/esm/api";

register();
import { MATERIAL_IDS, Mask, Terrain, bakeMesh } from "@threenative/terrain";
import { terrainPalette } from "../src/render/palette.js";

const { BIOMES } = await import("../src/render/biomes.js");
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
const dem = {};
for (const name of ["forest", "coastal", "alpine", "desert", "tundra"].flatMap((name) => [
  name,
  `${name}-horizon`,
])) {
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

// The Sprague Lake hydro-flattened survey measures the water surface, not its bed.
// Retain the real valley and shore; author shallow bathymetry and a creek into that surface.
export const forest = new Terrain({ size: 512, resolution: 257, seed: 73 })
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
// `pnpm dev` checks the cache on every start; strong erosion runs only on a cold bake. The recipes are seeded and deterministic, so a
// bake is only needed when the recipe, the palette it colours with, or the terrain build it
// evaluates against has changed since the output was written. `bake.mjs --force` overrides.
const recipes = { forest, coastal, alpine, desert, tundra };
// Forest/coast keep their existing bundle. The other three are separate lazy imports: every
// baked world is a 257-square of heights/colours, so bundling all five would add about 15 MB
// to the initial page module.
const drawn = new Set(["forest", "coastal"]);
const outputDir = new URL("../src/world/", import.meta.url);
const realContinuation = Object.fromEntries(
  Object.keys(recipes).map((name) => {
    const source = dem[`${name}-horizon`];
    return [
      name,
      new Terrain({ size: source.size, resolution: source.resolution, seed: 1 }).heightmap({
        id: "usgs-surroundings",
        data: source.data,
      }),
    ];
  }),
);
const fingerprint = createHash("sha256")
  .update(
    JSON.stringify(Object.fromEntries(Object.entries(recipes).map(([n, t]) => [n, t.toJSON()]))),
  )
  .update(
    JSON.stringify(
      Object.fromEntries(
        Object.entries(realContinuation).map(([name, terrain]) => [name, terrain.toJSON()]),
      ),
    ),
  )
  .update(JSON.stringify(terrainPalette))
  .update(await readFile(new URL("../src/render/scatter.ts", import.meta.url)))
  .update(await readFile(new URL("../src/render/terrain.ts", import.meta.url)))
  .update(await readFile(new URL("../src/render/biomes.ts", import.meta.url)))
  .update(await readFile(new URL("../src/world/terrainAssets.ts", import.meta.url)))
  .update(await readFile(new URL("../src/render/benchmark.ts", import.meta.url)))
  .update(await readFile(new URL("../src/render/placements.ts", import.meta.url)))
  .update(await readFile(new URL(import.meta.url)))
  .update(await readFile(new URL("../../../packages/terrain/dist/index.js", import.meta.url)))
  .digest("hex");

// An importer that only wants the recipes must not rewrite the baked files either: a fresh stamp
// skips the bake for every caller, so a dev server or a proof running beside it is never reloaded
// under its feet. `process.exit` is not how this skips — it would take the importer down with it.
const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
let baked = false;
if (!(isEntry && process.argv.includes("--force"))) {
  try {
    const stamp = new URL(".bake-stamp", outputDir);
    const [old, out] = await Promise.all([readFile(stamp, "utf8"), stat(stamp)]);
    // `drawn` worlds live inside baked.json; the rest are written beside it. Checking the drawn
    // set's own filenames would stat files that never exist and re-bake on every start.
    const undrawn = Object.keys(recipes).filter((name) => !drawn.has(name));
    const stale = (
      await Promise.all(
        [
          "baked.json",
          "horizon.json",
          ...undrawn.map((name) => `${name}.json`),
          ...Object.keys(recipes).flatMap((name) => [
            `${name}.placements.bin`,
            `${name}.world.json`,
            `${name}.layers.json`,
            `${name}.splat.rgba8`,
          ]),
        ].map((file) =>
          stat(new URL(file, outputDir)).then(
            (s) => s.mtimeMs > out.mtimeMs,
            () => true,
          ),
        ),
      )
    ).some(Boolean);
    if (old.trim() === fingerprint && !stale) {
      console.log("Worlds are already baked from this recipe and terrain build; nothing to do.");
      baked = true;
    }
  } catch {
    // No stamp yet: bake.
  }
}

if (!baked) {
  const bakeStarted = performance.now();
  const worlds = {};
  await mkdir(outputDir, { recursive: true });
  for (const [name, terrain] of Object.entries(recipes)) {
    const started = performance.now();
    const state = terrain.evaluate();
    if (name === "alpine" || name === "desert" || name === "coastal") {
      const maxDelta = state.height.reduce(
        (max, height, i) => Math.max(max, Math.abs(height - dem[name].data.values[i])),
        0,
      );
      assert(maxDelta < 1, `${name}: transport changed surveyed geology by ${maxDelta} m`);
      if (name !== "coastal")
        assert.equal(state.waters.length, 0, `${name}: this surveyed crop has no authored water`);
      console.log(`${name}: maximum DEM change ${maxDelta.toFixed(3)} m`);
    }
    for (const channel of ["flow", "sediment", "deposition", "talus"]) {
      assert.equal(
        state.erosion?.[channel]?.length,
        state.height.length,
        `${name}: missing ${channel}`,
      );
      assert(state.erosion[channel].every(Number.isFinite), `${name}: nonfinite ${channel}`);
    }
    const maps =
      name === "forest" || name === "coastal"
        ? { ...GROUND_MAPS, dirt: BIOMES.alpine.maps.dirt }
        : BIOMES[name].maps;
    const surface = terrainSurfacePackage(name, state, maps);
    await Promise.all([
      writeFile(new URL(`${name}.world.json`, outputDir), JSON.stringify(surface.world)),
      writeFile(new URL(`${name}.layers.json`, outputDir), JSON.stringify(surface.table)),
      writeFile(new URL(`${name}.splat.rgba8`, outputDir), surface.splat),
    ]);
    const mesh = bakeMesh(state, { palette: terrainPalette });
    worlds[name] = {
      size: state.size,
      resolution: state.resolution,
      heights: Array.from(state.height),
      colors: Array.from(mesh.colors),
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
    console.log(
      `${name}: ${((performance.now() - started) / 1000).toFixed(2)} s; ${Buffer.byteLength(JSON.stringify(worlds[name]))} JSON bytes`,
    );
  }
  const started = performance.now();
  const horizon = JSON.stringify({
    ...Object.fromEntries(
      Object.entries(realContinuation).map(([name, terrain]) => {
        const state = terrain.evaluate();
        return [
          name,
          {
            size: state.size,
            resolution: state.resolution,
            heights: Array.from(state.height, (height) => Math.round(height * 10) / 10),
          },
        ];
      }),
    ),
  });
  await writeFile(new URL("horizon.json", outputDir), horizon);
  console.log(
    `Continuation (five same-site USGS DEMs): ${((performance.now() - started) / 1000).toFixed(2)} s; ${Buffer.byteLength(horizon)} JSON bytes`,
  );
  await writeFile(
    new URL("../src/world/baked.json", import.meta.url),
    JSON.stringify(Object.fromEntries(Object.entries(worlds).filter(([name]) => drawn.has(name)))),
  );
  for (const [name, world] of Object.entries(worlds))
    if (!drawn.has(name))
      await writeFile(new URL(`${name}.json`, outputDir), JSON.stringify(world));
  // Import after the JSON outputs exist: terrain's horizon reads the newly baked continuation.
  const { scatterProps } = await import("../src/render/scatter.js");
  const { paintCanopy } = await import("../src/render/terrain.js");
  const { BENCHMARK } = await import("../src/render/benchmark.js");
  const { encodePlacements } = await import("../src/render/placements.js");
  for (const [name, data] of Object.entries(worlds)) {
    const field = new Heightfield({
      rows: data.resolution,
      columns: data.resolution,
      width: data.size,
      depth: data.size,
      origin: { x: 0, z: 0 },
      heights: Float32Array.from(data.heights),
    });
    const scatter = scatterProps(
      { ...data, field, world: name },
      BENCHMARK[name].focus,
      Object.values(BENCHMARK[name].poses)
        .filter((pose) => pose.eye < 20)
        .map((pose) => [...pose.at, 10]),
    );
    const mesh = new Mesh(new BufferGeometry());
    mesh.geometry.setAttribute(
      "canopy",
      new Float32BufferAttribute(new Float32Array(data.resolution ** 2), 1),
    );
    paintCanopy(mesh, data, scatter.placements);
    const table = encodePlacements(scatter, mesh.geometry.getAttribute("canopy").array);
    await writeFile(new URL(`${name}.placements.bin`, outputDir), new Uint8Array(table));
    mesh.geometry.dispose();
    console.log(
      `${name}: ${scatter.placements.length} baked placements; ${table.byteLength} bytes`,
    );
  }
  await writeFile(new URL(".bake-stamp", outputDir), `${fingerprint}\n`);
  console.log(
    `Cold bake total: ${((performance.now() - bakeStarted) / 1000).toFixed(2)} s; five worlds plus continuation.`,
  );
}
