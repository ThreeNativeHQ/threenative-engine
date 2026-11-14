# @threenative/terrain

Optional, headless terrain authoring recovered from Strata. One seeded recipe produces height and splat
arrays, resolved placements, baked LOD chunks and world packages. It is authoring tooling: run it in build
and authoring jobs, and let the game load the baked result. The game owns appearance, collision
registration and disposal.

```sh
npm install --save-dev @threenative/terrain three
```

```ts
import { Terrain, Mask, bakeMesh } from '@threenative/terrain';
import { toGeometry } from '@threenative/terrain/three';

const terrain = new Terrain({ size: 512, resolution: 257, seed: 73 })
  .noise({ id: 'hills', amplitude: 35 })
  .flatten({ id: 'camp', height: 12, mask: Mask.circle([20, 30], 15) });
const geometry = toGeometry(bakeMesh(terrain.evaluate()));
// Your game creates the Mesh and material, and disposes the geometry.
```

## Know this first

- Metres, Y up, X and Z from `-size/2` to `+size/2`. Degrees for rotations and slopes; placement yaw is radians.
- An operation records intent; `evaluate()` returns disposable arrays. Edit the recipe, not the arrays.
- Reusing a layer ID replaces that layer in place. `applyPatch` is atomic: a bad write keeps the previous recipe.
- `evaluate()` is synchronous. The root and `/three` imports carry no DOM, renderer or editor code, and
  Three.js is a peer dependency, never a second bundled copy.

## Entry points

| Import | Use |
| --- | --- |
| `@threenative/terrain` | `Terrain`, `Mask`, `landform`, `terrainStats`, `bakeTerrain`, `makeExport`, `bakeBiome`, `bakeWorldPackage` |
| `/three` | `toGeometry(bakeMesh(state))`: indexed geometry from your installed Three.js |
| `/kit`, `/starter` | `bakeKit` for a copied starter's `bake.mjs`; `addStarterWorld` loads the baked world and its collider |
| `/editor`, `/editor/server` | the live editor: browser mount and the Vite plugin `terrainEditor({ documentPath })` |
| `/export` | `prepareWorldGLTF`: a resolved static world for `cookTerrainWorld` in `@threenative/assets` |
| bin `dist/mcp/server.js` | MCP tools `terrain_generate`, `terrain_biome_new`, `terrain_patch` |

Five starter worlds ship as copy-out game source in `starter/<world>/` (`forest`, `coastal`, `alpine`,
`desert`, `tundra`). Each folder's `README.md` says how to copy, bake and load it.

## More detail

| Read | When |
| --- | --- |
| [Authoring a recipe](docs/authoring/recipes.md) | You write or patch a recipe: operations, masks, materials, water, export formats, limits |
| [The live editor](docs/authoring/editor.md) | You run the editor, change its environment or assets, or save placement overrides |
| [Exporting a static world](docs/authoring/world-export.md) | You export terrain, models and water as one GLB for another project |
| [Source provenance](THIRD_PARTY_NOTICES.md) | You need the origin and license of the recovered Strata code |
