import type { WorldName } from "./biomes.js";

/**
 * Where each world's player starts, in world metres: a place the bake surveyed, on the ground the
 * level was authored around. `game.ts` adds the camera offset below to it before the first frame.
 */
export const SPAWN_POINTS: Readonly<Record<WorldName, readonly [number, number]>> = {
  forest: [-220, -165],
  coastal: [180, 65],
  alpine: [180, -190],
  desert: [180, 160],
  tundra: [180, 160],
};

/**
 * Metres the launch camera stands back and up from the spawn point, and from the player in the
 * fixed player framing of a vista world. The coast's framing is tighter and higher than a valley's.
 */
export const SPAWN_CAMERA_OFFSET: Readonly<Record<WorldName, readonly [number, number, number]>> = {
  forest: [28, 24, 42],
  coastal: [28, 18, 34],
  alpine: [28, 24, 42],
  desert: [28, 24, 42],
  tundra: [28, 24, 42],
};
