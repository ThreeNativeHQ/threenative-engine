// Every starter file this game can ask for, in one table.
//
// The names live here and nowhere else so that replacing the starter art is one edit in one file:
// a game that ships its own models and maps rewrites these paths, or points them at a directory it
// owns, and nothing under `packages/terrain` changes. Nothing in this file loads anything — the
// loaders in `src/render/` ask for the paths, and a path that is absent leaves the surface on its
// own colours rather than failing the world.
//
// Two kinds of entry, and the difference is the caller's: a `map` is a PBR image the game binds,
// and a `model` is a placement asset a variant resolves to. Neither carries a scale, a material or
// a role decision; those are the render modules' business.

/** The surfaces that can cover ground. Order is the blend order in `src/render/terrain.ts`. */
export type LayerKey = "grass" | "dirt" | "rock" | "moss" | "sand" | "snow";

/**
 * One ground layer's PBR images: an albedo, and relief where the surface shows it.
 *
 * The ground material samples 16 textures at most; the starter spends them with normals on four
 * layers (not sand or snow), so a replacement that gives all six a normal map is refused by WebGPU.
 */
export interface IGroundMaps {
  readonly diffuse: string;
  readonly normal?: string;
  /** Only the portable export reads these two; the runtime ground derives its own. */
  readonly occlusion?: string;
  readonly roughness?: string;
}

/** The ground's layers, and the file each one draws with. */
export const GROUND_MAPS: Record<LayerKey, IGroundMaps> = {
  dirt: {
    diffuse: "forest_ground_04/forest_ground_04_diff_1k.jpg",
    normal: "forest_ground_04/forest_ground_04_nor_gl_1k.jpg",
  },
  grass: {
    diffuse: "leafy_grass/leafy_grass_diff_1k.jpg",
    normal: "leafy_grass/leafy_grass_nor_gl_1k.jpg",
    occlusion: "leafy_grass/leafy_grass_ao_1k.jpg",
    roughness: "leafy_grass/leafy_grass_rough_1k.jpg",
  },
  moss: {
    diffuse: "mossy_rock/mossy_rock_diff_1k.jpg",
    normal: "mossy_rock/mossy_rock_nor_gl_1k.jpg",
  },
  rock: {
    diffuse: "rock_boulder_dry/rock_boulder_dry_diff_512.jpg",
    normal: "rock_boulder_dry/rock_boulder_dry_nor_gl_512.jpg",
  },
  sand: { diffuse: "sand_01/sand_01_diff_1k.jpg" },
  snow: { diffuse: "snow_02/snow_02_diff_1k.jpg" },
};

/** Metres one ground tile spans, per layer. The size of a pattern, not of the file. */
export const GROUND_TILE: Record<LayerKey, number> = {
  dirt: 3.4,
  grass: 2.6,
  moss: 3.6,
  rock: 3.8,
  sand: 3.2,
  snow: 12,
};

/** Optional owner-local Kite crags and rock-face maps; CI retains the CC0/procedural art. */
export const WORLD_ROCKS = [
  // Closed surfaces avoid detached scan fringes at exposed silhouettes.
  { asset: "mountain", variant: 0, path: "temperate/mountain/1.glb", metres: 24 },
  { asset: "mountain", variant: 1, path: "temperate/mountain/1.glb", metres: 24 },
  ...[0, 1, 2, 3].map((variant) => ({
    asset: "volcanic",
    variant,
    path: `temperate/volcanic/${variant}.glb`,
    metres: 10,
  })),
  ...[0, 1].map((variant) => ({
    asset: "reveal",
    variant,
    path: `temperate/reveal/${variant}.glb`,
    metres: 5,
  })),
] as const;
export const ROCKFACE_MAPS: IGroundMaps = {
  diffuse: "temperate/rockface/diffuse.ktx2",
  normal: "temperate/rockface/normal.ktx2",
};

/** One mapped prop surface's albedo, tangent-space normal and roughness. */
export interface ISurfaceMaps {
  readonly diffuse: string;
  readonly normal: string;
  readonly roughness: string;
}

/** The bark and stone the props bind, and the soil the bases of both fade into. */
export const PROP_MAPS: Record<"bark" | "stone", ISurfaceMaps> = {
  bark: {
    diffuse: "bark_brown_02/bark_brown_02_diff_1k.jpg",
    normal: "bark_brown_02/bark_brown_02_nor_gl_1k.jpg",
    roughness: "bark_brown_02/bark_brown_02_rough_1k.jpg",
  },
  stone: {
    diffuse: "mossy_rock/mossy_rock_diff_1k.jpg",
    normal: "mossy_rock/mossy_rock_nor_gl_1k.jpg",
    roughness: "mossy_rock/mossy_rock_rough_1k.jpg",
  },
};

/** The forest floor the props' bases blend into. */
export const SOIL_MAP = "forest_ground_04/forest_ground_04_diff_1k.jpg";

/** The generated needle atlas, and the relief it carries in RG with occlusion in B. */
export const NEEDLE_ATLAS = "needle-atlas.png";
export const NEEDLE_SURFACE = "needle-surface.png";

/** The prepared fir's twig atlas: colour, tangent-space normal, and the packed arms map. */
export const FIR_MAPS = {
  arms: "fir_tree_01/fir_tree_01_twig_arm_1k.jpg",
  normal: "fir_tree_01/fir_tree_01_twig_nor_gl_1k.jpg",
  surface: "fir_tree_01/fir_tree_01_twig_diff_1k.jpg",
} as const;

/** The fern's own atlas: a photographed frond and its separate cut-out alpha. */
export const FERN_MAPS = {
  alpha: "fern_02/fern_02_alpha_512.png",
  diffuse: "fern_02/fern_02_diff_512.jpg",
} as const;

/** The licensed Fab pine's cut from its crown atlas, and the far card baked from the uncut one. */
export const PINE_ATLAS = "prepared/pine-tall-atlas.png";
export const IMPOSTOR_CARD = "prepared/pine-tall-impostor.png";

/** One prepared placement file: what it is, which variant it fills, and which detail level it is. */
export interface IPreparedFile {
  readonly asset: string;
  readonly level: number;
  readonly path: string;
  readonly variant: number;
}

/**
 * The prepared files, in the order they are asked for.
 *
 * **Nothing on this list any more.** The three CC0 rocks and the two prepared firs were replaced by
 * the licensed Landscape Pro species in `src/render/pack.ts` — real photoscanned stone at 7,178
 * triangles where the CC0 set's were 1–2k, and real pines where the fir's crown measured 0.3% of
 * its own silhouette at the tree budget (`credits.json` has that number, and it is why the starter
 * kept its procedural spruce). The list and its loader stay because they are how the next source is
 * measured, and because a prepared file that is not there is not an error: this map is empty on CI,
 * on a fresh clone and in a review, and the procedural variants are what draw there.
 *
 * A species that IS added back comes in as one entry per detail level, because a variant with a near
 * level and no mid level is a variant whose middle distance pops. Three rocks at both of their levels
 * was six draws for stone the eye cannot tell apart at meadow distance, against the starter's
 * twenty-four-draw ceiling for the whole meadow — which is the trade this list now records.
 */
export const PREPARED: readonly IPreparedFile[] = [
  // The committed fallback's stone: two photoscanned CC0 rocks at both levels. Where the licensed
  // pack loaded, its boulders take these same indices 1 and 2 (the pack's parts are merged after these), so
  // this only draws on CI, on a fresh clone and in a review — which is the starter that ships, and
  // a procedural lump there is the wrong first impression. Two, not three: three at two levels put
  // the pack-less meadow one draw over its ceiling.
  { asset: "boulder", level: 0, path: "rocks/rock01-near.glb", variant: 1 },
  { asset: "boulder", level: 1, path: "rocks/rock01-mid.glb", variant: 1 },
  { asset: "boulder", level: 0, path: "rocks/boulder-near.glb", variant: 2 },
  { asset: "boulder", level: 1, path: "rocks/boulder-mid.glb", variant: 2 },
];
