<!-- Generated mirror of AGENTS.md. Do not edit; edit AGENTS.md. -->

# AGENTS.md — Strata terrain preview

Read `/AGENTS.md` first. This example consumes build-baked arrays, not runtime recipes.

- Units are metres; Y is up; canonical heights are row-major Z then X, centred at zero.
- `scripts/bake.mjs` owns authoring. The game imports baked JSON and never evaluates terrain.
- Game appearance lives in `src/render/`; the ocean uses installed `SpectralOcean`.
- The ground's PBR maps are the CC0 starter sets in `packages/terrain/starter-assets/`, served
  through this example's Vite `publicDir` and loaded by `ctx.assets`; provenance is that folder's
  `credits.json`, and `src/render/terrain.ts` owns the layer, tile-size and blend choices.
- The forest uses the owner's licensed Project Nature Spruce Forest, Grass Library, Ground Foliage,
  Meadow Flowers and Fern Collection, plus Epic Kite Demo photoscanned rocks. `src/render/pack.ts`
  loads this example's gitignored `local-assets/temperate/`; `scripts/prep-fab-temperate.mjs`
  repairs atlas/opacity bindings and calls the installed asset cook. Set `FAB_TEMPERATE` to the
  imported library. Licensed bytes are LOCAL-ONLY and never committed; provenance is in `CREDITS.md`.
  Missing models keep the procedural spruce, rock, fern, grass and flower fallback drawing.
  Cutout vegetation draws with its imported albedo, normal map and cutoff, lit by the CC0
  Kloofendal HDRI as each material's `envMap` (`local-assets/prepared/kloofendal_48d_2k.hdr`,
  local-only); without it core prints `TN_UNLIT_FOLIAGE`. Never tint or flatten foliage to fix light.
  All model sections share one whole-model scale/base. `src/render/props.ts` uses `InstancedBatch`
  with cooked reduced full-spruce geometry at distance and culls small cover beyond its readable range.
  `src/render/scatter.ts` plants noise-masked stands, clearings, edge saplings, and grass over the
  entire grass field, with denser cover at the walking/benchmark eyes.
- Use one `Heightfield` buffer for geometry and existing heightfield collision; do not resample.
- Ground contacts use actual mesh and physics queries. Bilinear heights are not triangle contacts.
- WASD/arrows move, Space jumps, C switches forest/coast, L changes sunlight, V cycles views.
  Keys 1–5 select forest, coast, alpine, desert and tundra; `?world=alpine|desert|tundra` starts there.
  All five use the shared scene; `src/render/biomes.ts` owns biome surfaces/weather and terrain JSON
  for the three additional worlds loads lazily. The player owns its camera.
- The live editor also takes environment, model, surface-image and sky-image edits (`src/render/imports.ts`, `surfaces.ts`, `environmentImages.ts`; inputs `bark.*`, `stone.*`); a mapping swaps the image inside a texture a material already samples, so it adds no sampler.
- The live editor and resolved static-world export proof are implemented; final starter art, complete GUI tooling and baked-water export remain subsequent PRD work.

Run `pnpm --filter strata-terrain-preview test:terrain:web` and
`pnpm --filter strata-terrain-preview test:terrain:desktop` for the shared scenario.

Run `pnpm --filter strata-terrain-preview test:terrain:export` to produce the bounded
static PBR fixture and load it in an isolated vanilla Three.js project. Its checker
textures qualify interchange, not final starter art; unresolved river export first
fails, then the proof removes the river from its temporary document only.
Run `pnpm --filter strata-terrain-preview test:terrain:export:desktop` afterward to
load that same generated GLB in an ordinary native game with no authoring imports.
The native host must already be built; both runs use the existing playtest harness.

Every starter path lives in `src/world/terrainAssets.ts`; replace art by editing that table only, and
`pnpm --filter strata-terrain-preview test:terrain:custom` proves the swap (zero starter requests, same
terrain arrays, a missing file fails by name; the ground samples 16 textures, so at most four layers
take a normal map). `pnpm --filter strata-terrain-preview test:consumer` packs the terrain package and
re-authors every world `bake.mjs` exports in an install outside the workspace, runs the shipped
terrain-authoring workflow in a scaffold there, exports each world (and the GUI-polished fixture) as
a full-world GLB in a plain browser page, and hands the result to a scaffolded ThreeNative game that
builds and plays with no authoring package (`CONSUMER_GAME=skip` leaves that last stage out).
`pnpm --filter strata-terrain-preview test:terrain:authored` polishes a world through the editor's
real controls, reloads it and reproduces `scripts/fixtures/editor-authored.json` (`RECORD=1` rewrites it).
