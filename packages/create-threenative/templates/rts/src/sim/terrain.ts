/**
 * Shared terrain contract: one coordinate system for navigation, art and picking.
 *
 * Pure data and math. The world is 224 m across on a 2 m navigation grid, and every module that
 * asks where something is asks it in these units.
 */

export const MAP_SIZE = 224;
export const MAP_CELL = 2;
export const WORLD = MAP_SIZE;
export const HALF = WORLD / 2;

export interface IStart {
  team: number;
  x: number;
  z: number;
  name: string;
  color: number;
  css: string;
  pad: number;
}

export interface IResourceSite {
  x: number;
  z: number;
  gx: number;
  gz: number;
  baseX: number;
  baseZ: number;
}

export interface IPool {
  x: number;
  z: number;
  rx: number;
  rz: number;
  bridge?: boolean;
}

export const STARTS: readonly IStart[] = [
  { team: 0, x: -70, z: 66, name: "Astra", color: 0x69e9ec, css: "#70e6df", pad: 1.1 },
  { team: 1, x: 70, z: -68, name: "Dominion", color: 0xff8756, css: "#ff8756", pad: 1.5 },
  { team: 2, x: -70, z: -72, name: "Eclipse", color: 0xba8cff, css: "#bb95ff", pad: 2.2 },
];

export const RESOURCE_SITES: readonly IResourceSite[] = [
  { x: -85, z: 58, gx: -85, gz: 80, baseX: -70, baseZ: 66 },
  { x: 86, z: -79, gx: 88, gz: -58, baseX: 70, baseZ: -68 },
  { x: -87, z: -85, gx: -87, gz: -63, baseX: -70, baseZ: -72 },
  { x: 85, z: 76, gx: 91, gz: 53, baseX: 69, baseZ: 67 },
  { x: -58, z: 0, gx: -73, gz: 0, baseX: -59, baseZ: 15 },
  { x: 31, z: -63, gx: 18, gz: -62, baseX: 29, baseZ: -45 },
  { x: 32, z: 68, gx: 25, gz: 86, baseX: 19, baseZ: 64 },
  { x: 2, z: 15, gx: 13, gz: 10, baseX: -8, baseZ: 26 },
];

export const POOLS: readonly IPool[] = [
  { x: -12, z: -20, rx: 18, rz: 10, bridge: true },
  { x: 53, z: 19, rx: 12, rz: 19 },
  { x: -12, z: 80, rx: 12, rz: 7 },
  { x: -95, z: -20, rx: 8, rz: 15 },
];

/** Rock fields as `[x, z, radius]`, expanded into individual obstacles by the seeded worldgen. */
export const ROCK_FIELDS: readonly (readonly [number, number, number])[] = [
  [-100, 44, 5],
  [-99, 96, 6],
  [-60, 95, 6],
  [-42, 81, 5],
  [-49, 33, 5],
  [-79, 28, 5],
  [-37, 5, 5],
  [-39, -13, 4],
  [-37, -52, 7],
  [-45, -86, 5],
  [-23, -93, 6],
  [-101, -50, 5],
  [-101, -101, 5],
  [-54, -102, 5],
  [-4, -52, 5],
  [8, -87, 7],
  [44, -97, 5],
  [51, -45, 4],
  [83, -33, 6],
  [101, -93, 5],
  [101, -41, 6],
  [9, -2, 5],
  [29, -14, 5],
  [38, 36, 4],
  [76, 14, 5],
  [96, 14, 6],
  [60, 44, 4],
  [99, 93, 6],
  [51, 96, 6],
  [0, 101, 6],
  [-33, 47, 5],
  [-18, 52, 5],
  [-90, 2, 4],
  [-60, -35, 5],
  [18, 43, 3.5],
];

const smooth01 = (t: number): number => {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
};

const noiseHash = (x: number, z: number): number => {
  let n = Math.imul(x, 374761393) + Math.imul(z, 668265263);
  n = Math.imul(n ^ (n >>> 13), 1274126177);
  return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
};

/** Value noise on the unit lattice, smoothstepped between the four corners. */
export function terrainNoise(x: number, z: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smooth01(x - ix);
  const fz = smooth01(z - iz);
  const a = noiseHash(ix, iz) * (1 - fx) + noiseHash(ix + 1, iz) * fx;
  const b = noiseHash(ix, iz + 1) * (1 - fx) + noiseHash(ix + 1, iz + 1) * fx;
  return a * (1 - fz) + b * fz;
}

export function onBridge(x: number, z: number, margin = 0): boolean {
  return Math.abs(z + 20) <= 3.35 - margin && x >= -33.5 && x <= 9.5;
}

export function waterBlocked(
  x: number,
  z: number,
  pools: readonly IPool[] = POOLS,
  margin = 0,
): boolean {
  // Counted over the pool list rather than `pools.some((p) => ...)`: `game.blocked` asks this for
  // every separation query and every line sample, so the arrow was 200+ closures a step at sixty
  // units. `some` short-circuits and so does this.
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    if (p === undefined) continue;
    if (p.bridge && onBridge(x, z, margin * 0.3)) continue;
    if (((x - p.x) / (p.rx + margin)) ** 2 + ((z - p.z) / (p.rz + margin)) ** 2 < 1) return true;
  }
  return false;
}

export function terrainHeight(x: number, z: number, bridge = true): number {
  let h =
    0.15 +
    terrainNoise(x * 0.035 + 20, z * 0.035 + 31) * 1.8 +
    terrainNoise(x * 0.12, z * 0.12) * 0.45;
  for (const s of STARTS) {
    const d = Math.max(Math.abs(x - s.x) / 24, Math.abs(z - s.z) / 23);
    const w = 1 - smooth01((d - 0.9) / 0.45);
    if (w > 0) h = h * (1 - w) + s.pad * w;
  }
  for (const p of POOLS) {
    const d = Math.sqrt(((x - p.x) / p.rx) ** 2 + ((z - p.z) / p.rz) ** 2);
    if (d < 1.28) {
      const w = 1 - smooth01((d - 0.65) / 0.63);
      h = h * (1 - w) - 1.6 * w;
    }
  }
  if (bridge && onBridge(x, z)) h = 0.88;
  return h;
}
