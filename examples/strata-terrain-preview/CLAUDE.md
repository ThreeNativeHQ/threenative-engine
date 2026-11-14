<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — Strata terrain preview

Read `/AGENTS.md` first. This example consumes build-baked arrays, not runtime recipes.
Before changing what this preview shows, read [the terrain map](../../packages/terrain/docs/architecture/architecture.md):
it names the stage folders, the three producers of terrain output and the command that puts a change
on screen.

## Rules

- Units are metres; Y is up; canonical heights are row-major Z then X, centred at zero.
- `scripts/bake.mjs` owns authoring. The game imports baked JSON and never evaluates terrain.
- Game appearance lives in `src/render/`; the ocean uses installed `SpectralOcean`.
- Use one `Heightfield` buffer for geometry and existing heightfield collision; do not resample.
- Ground contacts use actual mesh and physics queries. Bilinear heights are not triangle contacts.
- Licensed forest bytes are LOCAL-ONLY and never committed; provenance is in `CREDITS.md`.
- Never tint or flatten foliage to fix light. Missing light shows as `TN_UNLIT_FOLIAGE`.
- Every starter path lives in `src/world/terrainAssets.ts`; replace art by editing that table only.
- A new file under `scripts/` or `playtests/` gets an entry in [the script index](docs/scripts.md).

## Commands (from the repository root)

| When | Command |
| --- | --- |
| Start the preview (bakes when stale) | `pnpm --filter strata-terrain-preview dev` |
| After a `packages/terrain/src/` edit | `pnpm --filter strata-terrain-preview rebake`, then reload |
| The page still shows an old result | `pnpm --filter strata-terrain-preview dev:fresh` (rebuilds terrain and core, clears Vite's prebundle) |
| Bake the forest from an MCP cook's own recipe | `STRATA_WORLD=<cook out dir> pnpm --filter strata-terrain-preview bake` |
| Bake, unit tests and the water check | `pnpm --filter strata-terrain-preview test` |
| The shared scenario on web, then desktop | `pnpm --filter strata-terrain-preview test:terrain:web`, `pnpm --filter strata-terrain-preview test:terrain:desktop` |

## More detail

| Read | When |
| --- | --- |
| [Proofs, scripts and controls](docs/scripts.md) | You run or add a proof, drive the preview with keys or URL flags, or look for a script |
| [Assets](docs/assets.md) | You change ground maps, forest models, the licensed library or the fallback props |
| [The terrain map](../../packages/terrain/docs/architecture/architecture.md) | You change what the terrain produces, not how it looks |
