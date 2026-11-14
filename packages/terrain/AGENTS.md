# AGENTS.md — @threenative/terrain

Read `/AGENTS.md` first. This optional addon is authoring tooling, not a game runtime. This file is for
work in the engine repository and does not ship. The package's users start at [README.md](README.md).

## Rules

- Preserve the recovered evaluator, stable semantic IDs, validation and atomic transactions.
- The root is headless; `/three` creates only ordinary indexed geometry from supplied arrays.
- Keep renderer, scene, camera, material, DOM, editor and worker code outside both imports.
- Appearance belongs to game `src/render/`; add no palette, material or lighting defaults.
- `starter/<world>/` is copy-out game source (recipe, bake, look, colliders); package code does not import it.
- `/export` encodes caller-prepared static worlds; its images and final matrices come from the game, and unresolved, deforming or stale content fails.
- Bake before play. Games own their camera, mesh lifetime and physics registration.
- Keep raw terrain-only exports labelled; they do not prove full-world GLB delivery.
- A doc that ships goes under `docs/authoring/` and names no repository path. A doc for engine work goes
  under `docs/architecture/`.

## Facts every edit depends on

- Metres, Y up, X and Z from `-size/2` to `+size/2`. Degrees for rotations and slopes; placement yaw is radians.
- An operation records intent; `evaluate()` returns disposable arrays. Edit the recipe, not the arrays.
- Reusing a layer ID replaces that layer in place. Save placement IDs, not instance indices.
- A bake reads the package's built `dist`, not `src/`. Rebuild before you bake, or you see the old result.

## Commands (from the repository root)

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

## More detail

| Read | When |
| --- | --- |
| [README](README.md) | The public entry points, and the links to the shipped authoring docs (recipes, editor, world export) |
| [The terrain map](docs/architecture/architecture.md) | You change what a terrain produces: stages, the three producers, edit-to-pixel |
| [The cook stages](docs/architecture/cook.md) | You change `terrain_generate` |
| [The world package](docs/architecture/world-package.md) | You change a baked file or its reader |
| [Strata PRDs](docs/PRDs/README.md) | You pick up or file Strata terrain work |
