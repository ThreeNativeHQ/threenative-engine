/** The starter kits, one folder each under the package's `starter/`. */
export const TERRAIN_KITS = ["forest", "coastal", "alpine", "desert", "tundra"] as const;

export type TerrainKit = (typeof TERRAIN_KITS)[number];
