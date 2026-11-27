// Playtest-only keys: each one puts the farmer at a fixed spot or bends the clock, so a scenario
// proves one mechanic in a few ticks instead of a scripted walk and a four-minute wait. They answer
// only when a playtest runner launched the page. Delete this file with the playtests.
import { PLAYTEST_RUNNER_EXPECTED_GLOBAL } from "@threenative/core/playtest";
import type { Farm } from "../farm/Farm.js";
import { CROP_IDS } from "../farm/crops.js";
import { FAINT_MINUTE } from "../farm/time.js";
import { BED_ZONE, BIN_ZONE, POND_ZONE, SHOP_ZONE, tileCenter } from "../level.js";

/**
 * A playtest runner sets this global before any game code runs. A player pressing the keys in a
 * real build gets nothing.
 */
export const UNDER_PLAYTEST =
  (globalThis as Record<string, unknown>)[PLAYTEST_RUNNER_EXPECTED_GLOBAL] === true;

type Facing = { x: number; z: number };
const NORTH: Facing = { x: 0, z: -1 };
const EAST: Facing = { x: 1, z: 0 };
const SOUTH: Facing = { x: 0, z: 1 };

/** The farmer's spot to work tile (col, row) from the south, west or north side. */
function standFor(col: number, row: number, facing: Facing): Spot {
  const target = tileCenter(col, row);
  return { facing, x: target.x - facing.x * 2, z: target.z - facing.z * 2 };
}

export interface Spot {
  readonly facing: Facing;
  readonly x: number;
  readonly z: number;
}

/** Numpad 1 to 9: three field tiles, a weed, a rock, the bed, the bin, the pond and the stall. */
export const STATIONS: Readonly<Record<string, Spot>> = {
  station1: standFor(3, 3, NORTH),
  station2: standFor(4, 3, NORTH),
  station3: standFor(5, 3, NORTH),
  station4: standFor(1, 0, NORTH),
  station5: standFor(0, 0, NORTH),
  station6: { facing: NORTH, x: BED_ZONE.x, z: BED_ZONE.z },
  station7: { facing: NORTH, x: BIN_ZONE.x, z: BIN_ZONE.z },
  station8: { facing: EAST, x: POND_ZONE.x - 4.2, z: POND_ZONE.z },
  station9: { facing: SOUTH, x: SHOP_ZONE.x, z: SHOP_ZONE.z },
};
export const STATION_NAMES = Object.keys(STATIONS);

/** The clock and purse keys. Each returns the playtest event it raised. */
export const CHEATS: Readonly<Record<string, (farm: Farm) => string>> = {
  /** Numpad 0: one swig left in the can. */
  cheatDry: (farm) => {
    farm.water = 1;
    return "dry-can";
  },
  /** Numpad +: noon. */
  cheatNoon: (farm) => {
    farm.minute = 12 * 60;
    return "noon";
  },
  /** Numpad -: nine at night. */
  cheatNight: (farm) => {
    farm.minute = 21 * 60;
    return "night";
  },
  /** Numpad *: ten minutes before the faint hour. */
  cheatLate: (farm) => {
    farm.minute = FAINT_MINUTE - 10;
    return "late";
  },
  /** Numpad /: spent, with eight stamina left: one more swing of the hoe and the farmer drops. */
  cheatTired: (farm) => {
    farm.stamina = 8;
    return "tired";
  },
  /** Numpad Enter: no seeds and no gold, with nothing growing. */
  cheatBroke: (farm) => {
    farm.money = 0;
    for (const id of CROP_IDS) farm.seeds[id] = 0;
    return "broke";
  },
  /** Numpad .: the last day of spring. */
  cheatSeason: (farm) => {
    farm.dayIndex = 29;
    return "last-day-of-spring";
  },
};
export const CHEAT_NAMES = Object.keys(CHEATS);
