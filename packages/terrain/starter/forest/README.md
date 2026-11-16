# Forest starter kit

A 512 m broadleaf valley on real elevations (Sprague Lake, USGS 3DEP), eroded, with its lake and
creek, streamed ground, scanned trees, shrubs, ferns, flowers, fallen wood and rocks, a mountain
ring with a surveyed massif, a physical sky and a walking player. It is game source: once copied,
every file is yours to edit.

All art is CC0 (Poly Haven, Quaternius). Provenance is in `@threenative/terrain/starter-credits.json`.

## Three steps

1. Copy `node_modules/@threenative/terrain/starter/forest` to `src/terrain/forest`.
2. Install the bake's tools, then bake:

   ```sh
   npm install --save-dev @threenative/terrain tsx
   node src/terrain/forest/bake.mjs
   ```

   The bake writes `assets/terrain/forest/` (`--out <dir>` moves it): the baked world under
   `world/`, and the art it draws, copied from the terrain package's starter assets. It downloads
   those once and checks their hash. The same kit always bakes the same bytes. Keep the starter
   `mannequin.glb` in `assets/`: it is the player.
3. Start the game on the forest scene:

   ```ts
   import { defineGame } from "@threenative/core";
   import { type IPhysicsContext, rapier } from "@threenative/physics";
   import { FOREST_GAME, ForestScene } from "./terrain/forest/scene.js";
   import type { TerrainState } from "./terrain/forest/sceneState.js";

   export default defineGame<TerrainState, IPhysicsContext>({
     ...FOREST_GAME,
     plugins: [rapier({ deterministicRestart: true })],
     scenes: { forest: ForestScene },
     start: "forest",
   });
   ```

`FOREST_GAME` holds the camera (60 degrees, 5000 m far plane, for the sky), the input map (WASD or
arrows, Space jump, Shift sprint, pointer look, V cycles the benchmark views, L toggles the sun) and
the renderer. Spread it first and override any field after it.

## What each part decides

| Path | What it decides |
| --- | --- |
| `bake.mjs` | The landform: survey, erosion, lake bed, creek, road and pad; the far ring and its massif; the art copied. |
| `biome.data.json` | Where the stands, understorey, rocks and ground cover grow (`bakeBiome`). |
| `scene.ts` | `ForestScene` and `FOREST_GAME`: load, spawn, the player, the views and the frame facts it reports. |
| `world/terrainAssets.ts` | Every art path the forest asks for. Replace the art by editing this table. |
| `render/biomes.ts` | The forest's look row: sun, sky, haze, exposure, tints and ground cover. |
| `render/ground/` | The ground material, the streamed tiles, ground cover and the far collar. |
| `render/props/` | The prop pack (`pack.ts` names each species' scan and size), materials, wind and far trees. |
| `render/sky/`, `render/water/` | The sky, atmosphere and post chain; the lake and creek surfaces. |

`recipe.json`, `assets.json`, `surface.json` and `heightmap.r16` are the inputs the `terrain_generate`
MCP tool cooks a new landform from. The forest bake does not read them.

## Changing it

- **The landform:** edit the recipe chain in `bake.mjs`, then bake again.
- **What grows where:** edit `biome.data.json`, then bake again.
- **A model or map:** edit its path in `world/terrainAssets.ts` or `render/props/pack.ts`, add the
  file under `assets/terrain/forest/`, and reload.
- **The look:** edit `render/biomes.ts` (the forest row), then reload.
