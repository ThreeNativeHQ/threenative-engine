import { type IBiomeSpec, validateBiome } from "@threenative/terrain";
import alpine from "../../../../packages/terrain/starter/alpine/biome.data.json";
import coastal from "../../../../packages/terrain/starter/coastal/biome.data.json";
import desert from "../../../../packages/terrain/starter/desert/biome.data.json";
import forest from "../../../../packages/terrain/starter/forest/biome.data.json";
import tundra from "../../../../packages/terrain/starter/tundra/biome.data.json";
import type { WorldName } from "./biomes.js";

const FILES: Readonly<Record<WorldName, unknown>> = {
  alpine,
  coastal,
  desert,
  forest,
  tundra,
};

/**
 * The five biome files, validated once at load.
 *
 * The rules a world grows by are a data file beside its kit (`starter/<biome>/biome.data.json`), not
 * a branch in the code that reads them: a sixth biome is a sixth file. Reading them here means the
 * game draws what the file says, and `validateBiome` refuses a mistyped or missing field by name
 * before anything is placed.
 */
export const BIOME_SPECS: Readonly<Record<WorldName, IBiomeSpec>> = Object.fromEntries(
  (Object.keys(FILES) as WorldName[]).map((world) => [world, validateBiome(FILES[world], world)]),
) as Readonly<Record<WorldName, IBiomeSpec>>;

/** One world's rules; the shared baked pair reads as the forest's, as its bake does. */
export function biomeSpec(world: WorldName | undefined): IBiomeSpec {
  return BIOME_SPECS[world ?? "forest"];
}
