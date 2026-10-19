# Forest starter kit

A 512 m forest on real elevations (USGS 3DEP), with hydraulic and thermal erosion, clustered fir
stands, young firs and boulder fields. It is game source: once copied, every file is yours to edit.

| File | What it decides |
| --- | --- |
| `recipe.json` | The terrain and the scatter: seed, size, erosion, `count`, `minDistance`, slope limits, `scale`, masks. |
| `assets.json` | Each prop's models, LOD distance, draw distance and bounds. |
| `surface.json` | The ground: texture layers, tiles, tints, far tiles and blend thresholds. |
| `bake.mjs` | Writes the world package and `world/water.json` (the lake and river) from the three files above. |
| `world.ts` | `addForest(ctx, follow)`: terrain, props, shadows, collision; `COLLIDERS` per prop. |
| `water.ts` | `addForestWater(ctx, water, field)`: the lake's surface (`WaterSurface3D`) and the river's ribbon, from `water.json`. |
| `sky.ts` | `forestDaylight(follow)`: sun, sky, fill, haze, exposure and tone curve. |

Art is CC0 (Poly Haven); provenance is in `@threenative/terrain/starter-assets/credits.json`.

## Three steps

1. Copy `node_modules/@threenative/terrain/starter/forest` to `src/terrain/forest`.
2. Run `node src/terrain/forest/bake.mjs --out assets/terrain/forest` (needs `@threenative/terrain`
   as a devDependency). The same recipe always writes the same bytes.
3. Add it to a scene:

```ts
import { forestDaylight } from "../terrain/forest/sky.js";
import { addForest } from "../terrain/forest/world.js";

// In Scene.load (it awaits the package) — `player` is what the world streams around.
const forest = await addForest(ctx, player);
// In Scene.enter.
ctx.add(forestDaylight(ctx.camera));
```

`addForest` resolves once the ground can be stood on: one heightfield collider covers the whole
world before it returns. Set the camera's `far` to at least the sky size in `sky.ts` (5000 m).

## Changing it

- **A prop's collider:** edit its row in `COLLIDERS` in `world.ts` (`capsule`, `sphere` or `null`).
- **A prop's model:** point `assets.json` at another glTF with its bounds, then re-bake.
- **The layout:** edit `recipe.json` (or open it in the terrain editor), then re-bake.
- **The water:** the recipe's `lake-bed`, `river` and `lake` layers set where it lies and how deep;
  `water.ts` sets how it looks.
- **The look:** `surface.json` for the ground, `sky.ts` for the light, `PROP_SKY_LIGHT` in
  `world.ts` for how strongly the sky lights the props.
