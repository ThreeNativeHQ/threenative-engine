# Alpine starter kit

A 512 m alpine headwall on a real survey (USGS 1 m DEM, Longs Peak, Colorado), with hydraulic and
thermal erosion, rock base, dirt on slopes, snow on the high steep ground and boulder scree. It is
game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the rock, dirt and snow surfaces, and the scree. |
| `assets.json` | The boulder model, its LOD distance and draw distance, and its bounds. |
| `surface.json` | The ground: the rock base, the dirt and snow layers, tiles, tints and blend thresholds. |
| `bake.mjs` | Writes the world package from the three files above. |
| `world.ts` | The runtime: streams the baked world, one heightfield for the ground, sphere colliders for the boulders near the player, and the sky as the props' light. |
| `sky.ts` | The daylight: the sun, sky, fill, haze, exposure and tone curve. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-assets/credits.json`.

## Status

The kit bakes and streams. The kit ships no scene: the game writes one. The terrain is too steep to
stand on near its centre, so a scene picks its spawn from the loaded heightfield. The proof's scene
rings the nearest boulder with gentle ground and a clear walk.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/alpine` to `src/terrain/alpine`.
2. Run `node src/terrain/alpine/bake.mjs --out assets/terrain/alpine` (needs `@threenative/terrain`
   as a devDependency). The same recipe always writes the same bytes.
3. In the scene, call `addAlpine(ctx, follow)` for the world and `alpineDaylight(follow)` for the light.
