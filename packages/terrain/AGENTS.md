# AGENTS.md — @threenative/terrain

Optional, headless terrain authoring recovered from Strata: authoring tooling, not a game runtime.
This file ships in the npm package. In the engine repository, read `/AGENTS.md` first.

## Rules

- Preserve the recovered evaluator, stable semantic IDs, validation and atomic transactions.
- The root is headless; `/three` creates only ordinary indexed geometry from supplied arrays.
- Keep renderer, scene, camera, material, DOM, editor and worker code outside both imports.
- Appearance belongs to game `src/render/`; add no palette, material or lighting defaults.
- `starter/<world>/` is copy-out game source (recipe, bake, look, colliders); package code does not import it.
- `/export` encodes caller-prepared static worlds; its images and final matrices come from the game, and unresolved, deforming or stale content fails.
- Bake before play. Games own their camera, mesh lifetime and physics registration.
- Keep raw terrain-only exports labelled; they do not prove full-world GLB delivery.

## Facts every edit depends on

- Metres, Y up, X and Z from `-size/2` to `+size/2`. Degrees for rotations and slopes; placement yaw is radians.
- An operation records intent; `evaluate()` returns disposable arrays. Edit the recipe, not the arrays.
- Reusing a layer ID replaces that layer in place. Save placement IDs, not instance indices.
- A bake reads the package's built `dist`, not `src/`. Rebuild before you bake, or you see the old result.

## Commands (engine repository, from the root)

| When | Command |
| --- | --- |
| After any `src/` edit (build + fast spec, about 11 s) | `pnpm --filter @threenative/terrain test:consumer` |
| Before you commit a package change | `pnpm --filter @threenative/terrain typecheck` and `pnpm --filter @threenative/terrain test` |
| After a doc, folder or script change | `pnpm --filter @threenative/terrain test:map` |
| See a `src/` edit in the preview (about 27 s, then reload) | `pnpm --filter strata-terrain-preview rebake` |
| Start the preview | `pnpm --filter strata-terrain-preview dev` |
| The preview still shows an old result | `pnpm --filter strata-terrain-preview dev:fresh` |
| Bake one starter into `artifacts/terrain/<world>/` (about 14 s) | `pnpm --filter @threenative/terrain bake:forest`, or `bake:coastal`, `bake:alpine`, `bake:desert`, `bake:tundra` |
| Prove the preview on WebGPU | `pnpm --filter strata-terrain-preview test:terrain:web` |
| Prove the starter kits in a scaffolded game | `pnpm --filter strata-terrain-preview test:kit` |

## Entry points

| Import | Use |
| --- | --- |
| `@threenative/terrain` | `Terrain`, `Mask`, `landform`, `terrainStats`, `bakeTerrain`, `makeExport`, `bakeBiome`, `bakeWorldPackage` |
| `/three` | `toGeometry(bakeMesh(state))`: indexed geometry from your installed Three.js |
| `/kit`, `/starter` | `bakeKit` for a copied starter's `bake.mjs`; `addStarterWorld` loads the baked world and its collider |
| `/editor`, `/editor/server` | the live editor: browser mount and the Vite plugin `terrainEditor({ documentPath })` |
| `/export` | `prepareWorldGLTF`: a resolved static world for `cookTerrainWorld` in `@threenative/assets` |
| bin `dist/mcp/server.js` | MCP tools `terrain_generate`, `terrain_biome_new`, `terrain_patch` |

## More detail

| Read | When |
| --- | --- |
| [Authoring a recipe](docs/authoring/recipes.md) | You write or patch a recipe: operations, masks, materials, water, export formats, limits |
| [README](README.md) | You use the live editor, placement overrides or the static-world export |
| [The terrain map](docs/architecture/architecture.md) | You change what a terrain produces: stages, the three producers, edit-to-pixel (repository only) |
| [The cook stages](docs/architecture/cook.md) | You change `terrain_generate` (repository only) |
| [The world package](docs/architecture/world-package.md) | You change a baked file or its reader (repository only) |
