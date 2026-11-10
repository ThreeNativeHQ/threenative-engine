import { TERRAIN_KITS, type TerrainKit } from "./kits.js";

/**
 * The words a request may use for each shipped biome: the `aliases` row of
 * `starter/<biome>/biome.data.json`, mirrored here because the tool's request parser is synchronous
 * and the files are read at bake time, not at parse time.
 *
 * The file stays the owner: `biome-words.spec.ts` fails if any row here stops matching its file, so a
 * sixth biome's alias edit reaches the tool only through this list, and an edit to one side is caught
 * instead of silently losing a word.
 */
export const BIOME_WORDS: Readonly<Record<TerrainKit, readonly string[]>> = {
  alpine: ["alpine", "mountain", "mountains", "snowy", "peaks", "alps", "glacier", "glaciers", "snow"],
  coastal: ["coastal", "beach", "coast", "sea", "ocean", "tropical", "shore", "lagoon", "fjord", "fjords"],
  desert: ["desert", "dune", "dunes", "sand", "canyon", "canyons", "arid", "badlands", "mesa"],
  forest: ["forest", "pine", "pines", "woods", "woodland", "spruce", "fir", "trees", "jungle", "rainforest", "grove"],
  tundra: ["tundra", "arctic", "ice", "frozen", "permafrost", "glacial"],
};

/** Every biome's words, in starter order, as `[kit, words]` rows a request may match against. */
export const BIOME_WORD_ROWS: readonly (readonly [TerrainKit, readonly string[]])[] =
  TERRAIN_KITS.map((kit) => [kit, BIOME_WORDS[kit]] as const);

/** One line naming every biome and the words it answers to, for a request that matched none. */
export function biomeWordList(): string {
  return BIOME_WORD_ROWS.map(([kit, words]) => `${kit} (${words.slice(1).join(", ")})`).join("; ");
}
