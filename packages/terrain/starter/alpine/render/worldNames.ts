/**
 * The one world this kit draws. Every baked file is `world/<WORLD>.*`, so it equals `recipe.json`'s
 * `world.name`; rename both to make a new environment, and the `WorldName` rows follow it.
 */
export const WORLD = "alpine";
export const WORLD_NAMES = [WORLD] as const;
