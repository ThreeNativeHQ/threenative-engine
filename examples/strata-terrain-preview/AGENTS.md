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

### Script, playtest and fixture index

All scripts, playtest definitions, manual preparation helpers and fixtures under `scripts/` and `playtests/`:

- Playtest scenarios:
  - `playtests/editor.playtest.json`: playtest scenario checking vertex count and appearance in the recovered editor view.
  - `playtests/export.playtest.json`: playtest scenario checking static GLB export loading and appearance.
  - `playtests/terrain.playtest.json`: primary playtest scenario for shared web/desktop showcase views.
  - `playtests/walk.playtest.json`: playtest scenario checking baked terrain triangles and player walk stability.

- Verification and test suites:
  - `scripts/verify-assets.mjs`: verifies asset manifests, replacement tables, and model loading.
  - `scripts/verify-authored-world.mjs`: verifies that editor-authored modifications reproduce committed baseline output.
  - `scripts/verify-cameras.mjs`: checks camera viewpoints, transitions, and framing across all world biomes.
  - `scripts/verify-consumer.mjs`: verifies packaging and consumption of the authored world in an external project.
  - `scripts/verify-custom-assets.mjs`: proves custom asset overrides swap cleanly without starter assets.
  - `scripts/verify-editor.mjs`: verifies live editor tool application, brush operations, and undo/redo state.
  - `scripts/verify-environment.mjs`: tests biome-specific environmental lighting and atmosphere settings.
  - `scripts/verify-game-handoff.mjs`: verifies clean scene handoff into an ordinary playable ThreeNative game.
  - `scripts/verify-import-export.mjs`: checks full import and export roundtrips for world documents.
  - `scripts/verify-landforms.mjs`: validates terrain elevation bounds, slopes, and landform contours.
  - `scripts/verify-ocean.mjs`: verifies ocean surface rendering, shorelines, and waterline properties.
  - `scripts/verify-sky.mjs`: checks procedural and LUT sky dome conditions across time and weather.
  - `scripts/verify-starter-kit.mjs`: verifies starter kit configuration, generation, and multi-world playtests.
  - `scripts/verify-surfaces.mjs`: verifies PBR terrain surface materials, splat textures, and blend transitions.
  - `scripts/verify-tool-groups.mjs`: tests editor UI tool groupings, interactions, and parameter schemas.
  - `scripts/verify-transforms.mjs`: validates coordinate transforms, rotations, and placement matrices.
  - `scripts/verify-world-export.mjs`: verifies headless static world GLB export and vanilla Three.js loading.
  - `scripts/check-water.mjs`: regression tests for shared water rendering and shoreline depths.
  - `scripts/check-temperate.mts`: checks foliage cover distribution and LOD distance compaction.

- Authoring, staging and data preparation:
  - `scripts/bake.mjs`: bakes source elevation data and generates canonical world JSON packages.
  - `scripts/consumer-world.mjs`: exports `openConsumerPage` to serve an installed consumer directory to headless Chromium and run vanilla full-world export against packed tarballs.
  - `scripts/stage-native-assets.mjs`: stages textures and models for native desktop/mobile bundles.
  - `scripts/make-needle-atlas.mjs`: procedural generator for conifer needle foliage atlases.
  - `scripts/prep-fab-pines.py`: manual prep script requiring Blender CLI and authored Fab Scots pine GLB to decimate and budget pines.
  - `scripts/prep-fab-temperate.mjs`: cooks and fixes texture atlas and opacity bindings for temperate models.
  - `scripts/prep-landscape-pro.mjs`: stages licensed Landscape Pro species for game runtime loading.
  - `scripts/prep-polyhaven-fir.py`: manual prep script requiring Blender CLI and authored Poly Haven fir 1k .blend to export game GLBs.
  - `scripts/prep-polyhaven-rock.py`: manual prep script requiring Blender CLI and authored Poly Haven boulder 1k .blend to export game GLBs.
  - `scripts/prep-trees.py`: manual prep script requiring Blender CLI and authored CC0 tree models to decimate to triangle and atlas budgets.

- Landform measurement and diagnostics:
  - `scripts/measure-embankment.mjs`: measures cross-section geometry and bench cut slope of road embankments.
  - `scripts/measure-light.mjs`: measures display-referred Rec.709 luminance against reference calibration.
  - `scripts/measure-spikes.mjs`: detects elevation spikes and gradient discontinuities across terrain bakes.
  - `scripts/measure-terrain.mjs`: tabulates terrain relief, slope, bake timing, and drainage metrics.

- USGS DEM source data and cropping:
  - `scripts/dem/crop.mjs`: crops and transforms raw USGS 3DEP GeoTIFFs into canonical DEM bins and metadata.
  - `scripts/dem/alpine.bin`: canonical elevation heightfield binary for the alpine world.
  - `scripts/dem/alpine.json`: grid metadata and coordinate bounding bounds for the alpine world.
  - `scripts/dem/alpine-horizon.bin`: distant horizon ring elevation binary for the alpine world.
  - `scripts/dem/alpine-horizon.json`: distant horizon ring grid metadata for the alpine world.
  - `scripts/dem/coastal.bin`: canonical elevation heightfield binary for the coastal world.
  - `scripts/dem/coastal.json`: grid metadata and coordinate bounding bounds for the coastal world.
  - `scripts/dem/coastal-horizon.bin`: distant horizon ring elevation binary for the coastal world.
  - `scripts/dem/coastal-horizon.json`: distant horizon ring grid metadata for the coastal world.
  - `scripts/dem/desert.bin`: canonical elevation heightfield binary for the desert world.
  - `scripts/dem/desert.json`: grid metadata and coordinate bounding bounds for the desert world.
  - `scripts/dem/desert-horizon.bin`: distant horizon ring elevation binary for the desert world.
  - `scripts/dem/desert-horizon.json`: distant horizon ring grid metadata for the desert world.
  - `scripts/dem/forest.bin`: canonical elevation heightfield binary for the forest world.
  - `scripts/dem/forest.json`: grid metadata and coordinate bounding bounds for the forest world.
  - `scripts/dem/forest-horizon.bin`: distant horizon ring elevation binary for the forest world.
  - `scripts/dem/forest-horizon.json`: distant horizon ring grid metadata for the forest world.
  - `scripts/dem/tundra.bin`: canonical elevation heightfield binary for the tundra world.
  - `scripts/dem/tundra.json`: grid metadata and coordinate bounding bounds for the tundra world.
  - `scripts/dem/tundra-horizon.bin`: distant horizon ring elevation binary for the tundra world.
  - `scripts/dem/tundra-horizon.json`: distant horizon ring grid metadata for the tundra world.

- Fixtures and testing environments:
  - `scripts/fixtures/consumer-world.mjs`: driver running an authored world in an isolated browser harness.
  - `scripts/fixtures/editor-authored.json`: golden recorded output of real editor authoring operations.
  - `scripts/fixtures/editor-readback.mjs`: browser harness reading back live editor canvas state.
  - `scripts/fixtures/export-world.mjs`: browser-side test driver for headless full-world export.
  - `scripts/fixtures/vanilla-world.mjs`: vanilla Three.js runner verifying static world GLB rendering.
  - `scripts/fixtures/handoff-game/Handoff.ts`: handoff harness component receiving exported terrain.
  - `scripts/fixtures/handoff-game/game.ts`: standalone ThreeNative entrypoint testing handoff consumption.
  - `scripts/fixtures/handoff-game/handoffEnvironment.ts`: lighting and environment setup for handoff fixture.
  - `scripts/fixtures/handoff-game/state.ts`: reactive state management for handoff fixture game.
  - `scripts/fixtures/kit-game/Alpine.ts`: starter kit fixture scene for the alpine biome.
  - `scripts/fixtures/kit-game/Coastal.ts`: starter kit fixture scene for the coastal biome.
  - `scripts/fixtures/kit-game/Desert.ts`: starter kit fixture scene for the desert biome.
  - `scripts/fixtures/kit-game/Forest.ts`: starter kit fixture scene for the forest biome.
  - `scripts/fixtures/kit-game/Tundra.ts`: starter kit fixture scene for the tundra biome.
  - `scripts/fixtures/kit-game/game.ts`: standalone multi-world game harness testing starter kit scenes.
  - `scripts/fixtures/kit-game/state.ts`: shared state for starter kit game fixture.
  - `scripts/fixtures/kit-game/playtests/alpine.playtest.json`: playtest scenario for starter kit alpine world.
  - `scripts/fixtures/kit-game/playtests/coastal.playtest.json`: playtest scenario for starter kit coastal world.
  - `scripts/fixtures/kit-game/playtests/desert.playtest.json`: playtest scenario for starter kit desert world.
  - `scripts/fixtures/kit-game/playtests/kit.playtest.json`: master playtest scenario verifying starter kit worlds.
  - `scripts/fixtures/kit-game/playtests/tundra.playtest.json`: playtest scenario for starter kit tundra world.
