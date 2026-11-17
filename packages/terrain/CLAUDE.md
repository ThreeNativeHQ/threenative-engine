<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

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

## Real ground comes from Mapterhorn

A starter kit's square and far ring, and a request cook, stand on surveyed heights from Mapterhorn
terrain tiles, not on noise, hand-sculpting or a stretched tile (owner, 2026-11-16: "use realistic
heightmaps"). Mapterhorn merges open elevation models (USGS 3DEP, swissALTI3D, IGN LiDAR HD, GSI,
Copernicus GLO-30 and more) into one tile set.

- Code: `surveyHeights(row, resolution)` in `src/ground/survey.ts` fetches and decodes a square crop.
  The survey rows and one attribution string per producer live in `src/ground/surveys.ts`.
- Detail depends on the region. Tile zoom 14-15 (1-3 m sources) holds a 512 m playable square. A
  Copernicus-only region (zoom 12 or less, 30 m) is good for a far ring, too coarse for the square.
- Probe the sites before you pick one (from `packages/terrain`, writes nothing):
  `npx tsx scripts/cook-kit-survey.ts --probe '[["name", lat, lon], ...]'`. It prints the square and
  ring relief, the share walkable under 25° and the tile zoom. Keep the square 80 % walkable or more.
  The ring is 5 km wide, so relief that the look needs must stand within 2.5 km of the centre.
- Cook the site: `npx tsx scripts/cook-kit-survey.ts <kit> <lat> <lon> "<site>" "<attribution>"`. It
  writes `starter/<kit>/heightmap.r16`, the recipe's heightmap range and `farRing.datum`, and
  `starter-assets/survey/<kit>-horizon.{bin,json}`, all on one datum. The bake fails closed with
  `TN_STARTER_RING_SEAM` when the ring stands more than 60 m off the square's edge.
- After a cook: add the credits rows (the `TILES` text plus the producer's statement from
  `surveys.ts`), name the site in the kit README, re-pin that kit's rows in `bake-golden.spec.ts` and
  `starter-kit.spec.ts`, and repack the starter assets with `--write-manifest`.

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
| [A new environment](docs/authoring/new-environment.md) | You add a biome, a place or a starter kit: copy the forest kit and change its data, not a new bake or scene |
| [Strata PRDs](docs/PRDs/README.md) | You pick up or file Strata terrain work |
