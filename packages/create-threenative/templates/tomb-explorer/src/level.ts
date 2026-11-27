// The temple, as data. `render/temple.ts` turns it into meshes; the simulation in `src/sim/` reads
// it only through the queries below. Change the level here: one table, and the look, the collision,
// the grabs and the swim follow it.
//
// Scale: one sector is 1024 units (room-portals card, const.h:8) and the grid is authored in
// clicks of 256 units (a quarter sector). x runs east, z runs south, y is up. The map reads
// north (z = 0) to south: the player starts at the south end and works north to the deck, jumps
// east into the flooded hall, and takes the relic from the far shore.
import { CLICK, SECTOR } from "./tuning.js";

export const COLUMNS = 28;
export const ROWS = 22;
/** A floor this high is a wall to everything; outside the grid is the same. */
export const SOLID = 1_000_000;
/** No ceiling: the sky. */
export const OPEN = 1_000_000;

const floors = new Float32Array(COLUMNS * ROWS).fill(SOLID);
const ceilings = new Float32Array(COLUMNS * ROWS).fill(OPEN);

/** Fill a rectangle of cells (inclusive) with a floor height in clicks, and optionally a ceiling. */
function fill(x0: number, z0: number, x1: number, z1: number, floor: number, ceiling = OPEN): void {
  for (let z = z0; z <= z1; z += 1)
    for (let x = x0; x <= x1; x += 1) {
      floors[z * COLUMNS + x] = floor * CLICK;
      ceilings[z * COLUMNS + x] = ceiling === OPEN ? OPEN : ceiling * CLICK;
    }
}

// The south hall, with a one-click step across it (walk up it: the step allowance).
fill(1, 15, 5, 21, 11);
fill(1, 18, 5, 18, 12);
// Gap one: a single sector, three clicks deep. A standing jump clears it.
fill(1, 14, 5, 14, 8);
// A run-up platform, then gap two: two sectors, so only a running jump clears it.
fill(1, 10, 5, 13, 11);
fill(1, 8, 5, 9, 8);
// The foot of the ledge wall.
fill(1, 5, 5, 7, 11);
// The deck, five clicks up. Its west three columns sit under a low ceiling: a hang there cannot be
// pulled up, so the player shimmies east to the open part.
fill(1, 2, 3, 4, 16, 18);
fill(4, 2, 12, 4, 16);
// The flooded hall below the deck's east edge: a dry chasm, an open pool, a submerged tunnel, a
// second pool, then a wading shelf and the far shore.
fill(13, 1, 17, 5, 2);
fill(18, 1, 20, 5, 0);
fill(21, 1, 22, 5, 0, 4);
fill(23, 1, 23, 5, 0);
fill(24, 1, 24, 5, 6);
fill(25, 1, 25, 5, 7);
fill(26, 1, 27, 5, 8);

/** The water: a rectangle of cells and the height of its plane in units. */
export const WATER = { x0: 18, x1: 25, z0: 1, z1: 5, level: 2000 } as const;

function cellIndex(x: number, z: number): number {
  const cx = Math.floor(x / SECTOR);
  const cz = Math.floor(z / SECTOR);
  return cx < 0 || cz < 0 || cx >= COLUMNS || cz >= ROWS ? -1 : cz * COLUMNS + cx;
}

/** The floor height under a point, in units. `SOLID` for a wall. */
export function floorAt(x: number, z: number): number {
  const index = cellIndex(x, z);
  return index < 0 ? SOLID : (floors[index] ?? SOLID);
}

/** The ceiling height over a point, in units. `OPEN` for sky. */
export function ceilingAt(x: number, z: number): number {
  const index = cellIndex(x, z);
  return index < 0 ? -SOLID : (ceilings[index] ?? OPEN);
}

/** The water plane over a point, in units, or undefined when the cell holds no water. */
export function waterAt(x: number, z: number): number | undefined {
  const cx = Math.floor(x / SECTOR);
  const cz = Math.floor(z / SECTOR);
  return cx >= WATER.x0 && cx <= WATER.x1 && cz >= WATER.z0 && cz <= WATER.z1
    ? WATER.level
    : undefined;
}

/** Raw cell data for the mesh builder. */
export function cellFloor(cx: number, cz: number): number {
  return cx < 0 || cz < 0 || cx >= COLUMNS || cz >= ROWS
    ? SOLID
    : (floors[cz * COLUMNS + cx] ?? SOLID);
}
export function cellCeiling(cx: number, cz: number): number {
  return cx < 0 || cz < 0 || cx >= COLUMNS || cz >= ROWS
    ? -SOLID
    : (ceilings[cz * COLUMNS + cx] ?? OPEN);
}

/** The centre of a cell, units. */
export function cellCentre(cx: number, cz: number): { x: number; z: number } {
  return { x: cx * SECTOR + SECTOR / 2, z: cz * SECTOR + SECTOR / 2 };
}

/** Where she starts, facing north (yaw pi: yaw 0 faces +z). */
export const SPAWN = { ...cellCentre(3, 20), yaw: Math.PI } as const;

/**
 * The relic on the far shore. The item frame faces west (yaw 3pi/2), toward the pool. y is the floor
 * under it, units. item-pickup card: the reach box lives in this frame.
 */
export const RELIC = {
  x: 27 * SECTOR + 512,
  z: 3 * SECTOR + 512,
  y: 8 * CLICK,
  yaw: (3 * Math.PI) / 2,
} as const;

/** The slicing blade across the deck corridor: the x it hangs at, and its footprint. */
export const BLADE = {
  x: 8 * SECTOR + 512,
  z0: 2 * SECTOR,
  z1: 5 * SECTOR,
  halfWidth: 140,
} as const;

export type Station = {
  readonly x: number;
  readonly z: number;
  readonly y: number;
  readonly yaw: number;
  readonly air?: number;
  /** Water stations start swimming (on the surface, or treading under it). `fall` starts a drop. */
  readonly mode?: "surface" | "tread" | "fall";
  /** Restart the blade's cycle, so the trap is on a known beat. */
  readonly clock?: true;
};

const N = Math.PI;
const E = Math.PI / 2;
/**
 * Playtest stations: each key puts her at a fixed spot so one scenario proves one mechanic in a
 * few ticks. They answer only under a playtest runner. Delete them with the playtests.
 */
export const STATIONS: Readonly<Record<string, Station>> = {
  // 300 units before gap one, facing it.
  station1: { x: 3 * SECTOR + 512, z: 15 * SECTOR + 300, y: 11 * CLICK, yaw: N },
  // South end of the run-up platform, facing gap two.
  station2: { x: 3 * SECTOR + 512, z: 14 * SECTOR - 200, y: 11 * CLICK, yaw: N },
  // At the foot of the ledge wall, a third of a sector from it, under the low-ceiling part.
  station3: { x: 3 * SECTOR + 200, z: 5 * SECTOR + 230, y: 11 * CLICK, yaw: N },
  // On the deck by its east edge, facing the chasm.
  station4: { x: 12 * SECTOR + 700, z: 3 * SECTOR + 512, y: 16 * CLICK, yaw: E },
  // In the open pool, on the surface. The tunnel mouth lies ahead (east).
  station5: {
    x: 19 * SECTOR + 512,
    z: 3 * SECTOR + 512,
    y: WATER.level - 100,
    yaw: E,
    mode: "surface",
  },
  // Underwater in the second pool with almost no air left.
  station6: { x: 23 * SECTOR + 512, z: 3 * SECTOR + 512, y: 800, yaw: E, air: 40, mode: "tread" },
  // On the far shore, facing the relic from a metre and a half.
  station7: { x: RELIC.x - 700, z: 3 * SECTOR + 512, y: 8 * CLICK, yaw: E },
  // West end of the blade corridor, facing east, with the blade just starting its raised beat.
  station8: { x: BLADE.x - 1500, z: 3 * SECTOR + 512, y: 16 * CLICK, yaw: E, clock: true },
  // Standing under the blade: it falls on her once, a beat later.
  station9: { x: BLADE.x, z: 3 * SECTOR + 512, y: 16 * CLICK, yaw: E, clock: true },
  // On the south lip of gap two, 300 units from the edge, facing it.
  station10: { x: 3 * SECTOR + 512, z: 10 * SECTOR + 300, y: 11 * CLICK, yaw: N },
  // High over the dry chasm, falling: far enough that the landing is fatal.
  station11: { x: 15 * SECTOR + 512, z: 3 * SECTOR + 512, y: 28 * CLICK, yaw: E, mode: "fall" },
};
