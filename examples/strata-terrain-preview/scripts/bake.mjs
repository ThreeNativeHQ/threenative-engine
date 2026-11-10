// The bake: one loop over the five worlds, one package call per world, one container written.
//
// `@threenative/terrain` owns the placement rules: a biome file says `"stream": "ordered"`, so
// `bakeBiome` runs the game's generators on one ordered stream and hands the instances back in the
// order this game's table stores them. This script keeps what the GAME owns: the recipes
// (`recipe.mjs`), the surface manifest, the canopy the ground shader reads, and the prop packages.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { BufferGeometry, Float32BufferAttribute, Mesh } from "three";
import { register } from "tsx/esm/api";

register();
import { bakeBiome, validateBiome } from "@threenative/terrain";

const {
  cooked,
  dem,
  drawn,
  massif,
  outputDir,
  realContinuation,
  recipes,
  terrainSurfacePackage,
  worldOf,
} = await import("./recipe.mjs");
const { isFresh, stamp } = await import("./stamp.mjs");
const { GROUND_MAPS } = await import("../src/world/terrainAssets.js");
const { BIOMES } = await import("../src/render/biomes.js");
const { WORLD_NAMES: WORLDS } = await import("../src/render/worldNames.js");

const DRIVEN = ["alpine", "desert", "coastal"];

/**
 * A placed massif's heights at its tile's own spacing, for the collar's relief map: int16
 * decimetres above `offset`, base64, row-major from `origin` (+X east, +Z south).
 */
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

/**
 * `STRATA_SEED=<integer>` bakes a variation of every world: the same surveyed ground, biome rules
 * and look, with every tree, rock and plant in a new place. 0, the default, is the pinned bake.
 */
const VARIATION = Number(process.env.STRATA_SEED ?? 0);
assert(Number.isSafeInteger(VARIATION), "STRATA_SEED must be an integer");

/** One biome file, validated: the rules this world places by. */
function biomeOf(name) {
  const file = new URL(
    `../../../packages/terrain/starter/${name}/biome.data.json`,
    import.meta.url,
  );
  const spec = validateBiome(JSON.parse(readFileSync(file, "utf8")), name);
  // A variation keeps the rules and moves the stream they draw from; a cooked forest draws from the
  // cook's own seed (`STRATA_WORLD`).
  const seed = name === "forest" && cooked ? cooked.recipe.config.seed : spec.cover.seed;
  return { ...spec, cover: { ...spec.cover, seed: seed + VARIATION } };
}

/** The surface and placement outputs of one world, written as the game reads them. */
async function writeWorld(name, state) {
  const started = performance.now();
  // A cooked forest (`STRATA_WORLD`) is not the pinned survey, so the survey's own checks skip it.
  if (DRIVEN.includes(name) && !(name === "forest" && cooked)) {
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
  const baked = bakeBiome({ state, spec: biomeOf(name) });
  assert(baked.scatter !== null, `${name}: the biome file places nothing`);
  const world = worldOf(state);
  console.log(
    `${name}: ${((performance.now() - started) / 1000).toFixed(2)} s; ${Buffer.byteLength(JSON.stringify(world))} JSON bytes`,
  );
  return { scatter: baked.scatter, world };
}

const isEntry = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isEntry) {
  // An importer reads the recipes; it must not rewrite the baked files.
} else if (!process.argv.includes("--force") && (await isFresh(outputDir))) {
  console.log("Worlds are already baked from this recipe and terrain build; nothing to do.");
} else {
  const bakeStarted = performance.now();
  const worlds = {};
  const scatter = {};
  await mkdir(outputDir, { recursive: true });
  for (const [name, terrain] of Object.entries(recipes)) {
    const written = await writeWorld(name, terrain.evaluate());
    worlds[name] = written.world;
    scatter[name] = written.scatter;
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
            ...(massif[name] && { massif: packMassif(massif[name].detail) }),
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
    new URL("baked.json", outputDir),
    JSON.stringify(Object.fromEntries(Object.entries(worlds).filter(([name]) => drawn.has(name)))),
  );
  for (const [name, world] of Object.entries(worlds))
    if (!drawn.has(name))
      await writeFile(new URL(`${name}.json`, outputDir), JSON.stringify(world));
  // Import after the JSON outputs exist: terrain's horizon reads the newly baked continuation.
  const { paintCanopy } = await import("../src/render/terrain.js");
  const { skyVisibility } = await import("../src/render/skyVisibility.js");
  const { writeProps } = await import("./props.mjs");
  for (const name of WORLDS) {
    const data = worlds[name];
    const mesh = new Mesh(new BufferGeometry());
    mesh.geometry.setAttribute(
      "canopy",
      new Float32BufferAttribute(new Float32Array(data.resolution ** 2), 1),
    );
    paintCanopy(mesh, data, scatter[name].placements);
    const canopy = mesh.geometry.getAttribute("canopy").array;
    await writeFile(
      new URL(`${name}.canopy.bin`, outputDir),
      new Uint8Array(canopy.buffer, canopy.byteOffset, canopy.byteLength),
    );
    // The share of the sky each vertex sees past the relief, one byte a vertex, for the ground's AO.
    const sky = skyVisibility(data.heights, data.resolution, data.size);
    await writeFile(
      new URL(`${name}.sky.bin`, outputDir),
      Uint8Array.from(sky, (value) => Math.round(value * 255)),
    );
    const buckets = await writeProps(outputDir, name, scatter[name].placements, data.size);
    mesh.geometry.dispose();
    console.log(`${name}: ${scatter[name].placements.length} baked placements -> ${buckets}`);
  }
  await writeFile(new URL(".bake-stamp", outputDir), `${stamp}\n`);
  console.log(
    `Cold bake total: ${((performance.now() - bakeStarted) / 1000).toFixed(2)} s; five worlds plus continuation.`,
  );
}
