# Tundra starter kit

A 512 m low-relief tundra on a real survey (USGS 1 m DEM, Colorado), with hydraulic and thermal
erosion, two meltwater rivers, two kettle lakes, moss ground with snow and rock, and boulder
erratics. It is game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain: the survey heightmap, erosion, the kettle beds, the two rivers, the two lakes, the surfaces and the erratics. |
| `assets.json` | The boulder model, its LOD distance and draw distance, and its bounds. |
| `surface.json` | The ground: the moss base, the snow and rock layers, tiles, tints and blend thresholds. |
| `bake.mjs` | Writes the world package and `world/water.json` (the rivers and lakes) from the three files above. |
| `world.ts` | The runtime: streams the baked world, one heightfield for the ground, sphere colliders for the boulders near the player, and the sky as the props' light. |
| `sky.ts` | The daylight: the sun, sky, fill, haze, exposure and tone curve. It also lights the lakes' mirror. |
| `water.ts` | The kettle lakes and meltwater rivers, drawn with a pale ice tint on the lakes. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-assets/credits.json`.

## Status

The kit bakes, streams and draws its water. The kit ships no scene: the game writes one. The terrain is
gentle, so the scene picks its spawn from the loaded heightfield and keeps it off the lake shores.

## Steps

1. Copy `node_modules/@threenative/terrain/starter/tundra` to `src/terrain/tundra`.
2. Run `node src/terrain/tundra/bake.mjs --out assets/terrain/tundra` (needs `@threenative/terrain`
   as a devDependency). The same recipe always writes the same bytes.
3. In the scene, call `addTundra(ctx, follow)` for the world and `tundraDaylight(follow)` for the light.
