# Coastal starter kit

A 512 m coastline on a real survey (USGS 1 m DEM, Colorado), with hydraulic and thermal erosion,
rock on the steep ground, sand on the low ground, an ocean at 1.5 m and fir stands kept out of the
water. It is game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the rock and sand surfaces, the ocean and the stands. |
| `assets.json` | The fir model, its LOD distance and draw distance, and its bounds. |
| `surface.json` | The ground: the sand base, the rock layer, tiles, tints and blend thresholds. |
| `bake.mjs` | Writes the world package and `world/water.json` from the three files above. |
| `world.ts` | The runtime: streams the baked world, one heightfield for the ground, sphere colliders for the firs near the player, and the sky as the props' light. |
| `sky.ts` | The daylight: the sun, sky, fill, haze, exposure and tone curve. |
| `sea.ts` | The sea: the installed spectral simulation drives a lit water surface at the level the bake wrote. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-assets/credits.json`.

## Substitution

The preview's coastal stands use its licensed spruce models, which cannot ship in a kit. This kit
plants the CC0 fir from the forest kit in their place, with the same count and spacing. The
ocean is written to `water.json` as the one entry in `lakes`, with no `at`: the game draws it.

## Status

The kit bakes, streams and draws its sea. The kit ships no scene: the game writes one. The sea is a
lit surface at the baked level: the simulation's waves, the surf from the bake's shoreline, and the depth
tint. Its colours and sea state are in `sea.ts`. The close-up view is named `boulders` in the shared captures, although
it frames a fir.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/coastal` to `src/terrain/coastal`.
2. Run `node src/terrain/coastal/bake.mjs --out assets/terrain/coastal` (needs `@threenative/terrain`
   as a devDependency). The same recipe always writes the same bytes.
3. In the scene, call `addCoastal(ctx, follow)` for the world and `coastalDaylight(follow)` for the light.
