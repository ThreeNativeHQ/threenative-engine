const WORLD_HALF_EXTENT = 1_000;

export const TERRAIN_SEED = 251;

function lattice(seed: number, x: number, z: number): number {
  let value = Math.imul(Math.trunc(x), 0x45d9f3b);
  value = Math.imul(value ^ Math.imul(Math.trunc(z), 0x27d4eb2d), 0x165667b1);
  value = Math.imul(value ^ Math.trunc(seed), 0x85ebca6b);
  value ^= value >>> 13;
  return ((value >>> 0) / 4_294_967_295) * 2 - 1;
}

function smooth(value: number): number {
  return value * value * (3 - 2 * value);
}

function valueNoise(seed: number, x: number, z: number): number {
  const x0 = Math.floor(x);
  const z0 = Math.floor(z);
  const xMix = smooth(x - x0);
  const zMix = smooth(z - z0);
  const west = lattice(seed, x0, z0) * (1 - xMix) + lattice(seed, x0 + 1, z0) * xMix;
  const east = lattice(seed, x0, z0 + 1) * (1 - xMix) + lattice(seed, x0 + 1, z0 + 1) * xMix;
  return west * (1 - zMix) + east * zMix;
}

/** The game's landform function; the framework only receives its sampled output. */
export function sampleTerrainHeight(seed: number, x: number, z: number): number {
  if (!Number.isFinite(seed) || !Number.isFinite(x) || !Number.isFinite(z))
    throw new Error("Terrain sampler inputs must be finite.");
  if (Math.abs(x) > WORLD_HALF_EXTENT || Math.abs(z) > WORLD_HALF_EXTENT)
    throw new Error(`Terrain sample (${String(x)}, ${String(z)}) is outside the proof region.`);
  // A converging catchment keeps tributaries connected instead of draining off every edge.
  const absoluteX = Math.abs(x);
  const absoluteZ = Math.abs(z);
  const warpX = valueNoise(seed + 17, absoluteX / 180, absoluteZ / 180) * 42;
  const warpZ = valueNoise(seed + 31, absoluteX / 180, absoluteZ / 180) * 38;
  const basin =
    0.8 * (absoluteX + absoluteZ) + 0.0001 * (absoluteX * absoluteX + absoluteZ * absoluteZ);
  const ridge = Math.max(
    0,
    Math.abs(valueNoise(seed + 401, absoluteX / 34, absoluteZ / 34)) - 0.58,
  );
  return (
    basin +
    valueNoise(seed + 601, absoluteX / 8, absoluteZ / 8) * 2 +
    valueNoise(seed, (absoluteX + warpX) / 520, (absoluteZ + warpZ) / 520) * 52 +
    valueNoise(seed + 101, (absoluteX + warpX) / 220, (absoluteZ + warpZ) / 220) * 18 +
    valueNoise(seed + 211, (absoluteX + warpX) / 82, (absoluteZ + warpZ) / 82) * 20 +
    ridge * ridge * 70
  );
}

// Mirror the catchment across its diagonal so neither horizontal direction dominates.
export const terrainHeight = (x: number, z: number): number =>
  (sampleTerrainHeight(TERRAIN_SEED, x, z) + sampleTerrainHeight(TERRAIN_SEED, z, x)) * 0.2;
