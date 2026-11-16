import type { IBiomeSpec } from "@threenative/terrain";
import forest from "../biome.data.json";
import type { WorldName } from "./biomes.js";

/**
 * The forest's biome file (`biome.data.json`): the rules it grows by. The bake validates it with
 * `validateBiome` before it places anything, so the game reads it as data and ships no validator.
 */
const FOREST_SPEC = forest as unknown as IBiomeSpec;

/** The world's rules. */
export function biomeSpec(_world?: WorldName): IBiomeSpec {
  return FOREST_SPEC;
}
