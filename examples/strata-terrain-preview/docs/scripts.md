# Strata preview: proofs, scripts and controls

Every proof command, the controls a playtest drives, and an index of each file under `scripts/` and
`playtests/`. Read [`../AGENTS.md`](../AGENTS.md) first. `scripts/__tests__/strata-script-census.spec.ts`
fails when a file in those folders has no entry here.

## Proofs

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

## Controls and URL flags

- WASD/arrows move, Space jumps, C switches forest/coast, L changes sunlight, V cycles views.
  Keys 1–5 select forest, coast, alpine, desert and tundra; `?world=alpine|desert|tundra` starts there.
  All five use the shared scene; `src/render/biomes.ts` owns biome surfaces/weather and terrain JSON
  for the three additional worlds loads lazily. The player owns its camera.

## Index

All scripts, playtest definitions, manual preparation helpers and fixtures under `scripts/` and `playtests/`:

- Playtest scenarios:
  - `playtests/collide.playtest.json`: checks scattered rocks and trunks are solid (`ScatterColliders`): a walk through spruce trunks never puts the player's capsule inside a prop body; `?propCollision=off` is its before arm.
  - `playtests/edge.playtest.json`: checks the player walks past the playable square onto the surrounding hills (streamed tiles by default; their 200 m collider band under `?stream=off`), stays grounded and logs no errors.
  - `playtests/editor-conflict.playtest.json`: checks concurrent editor saves preserve both clients’ edits.
  - `playtests/editor.playtest.json`: playtest scenario checking vertex count and appearance in the recovered editor view.
  - `playtests/export.playtest.json`: playtest scenario checking static GLB export loading and appearance.
  - `playtests/lod.playtest.json`: run with `?world=forest&meadow=off`: at the vista, 685 m from the player, the props draw at the level the camera sees (`propTriangles` at most 18 M); `?tnLodFromCamera=0` is its before arm.
  - `playtests/loop.playtest.json`: checks the owner's loop (reveal, 10 s walk, camera turn, idle) builds no pipeline after the reveal.
  - `playtests/stream.playtest.json`: run with `?tnTerrainValidate=1&propCollision=off` (PRD-790; streaming is the default, `?stream=off` is its named override and logs `TN_STREAM_OVERRIDE`): a click takes the pointer, the camera turns 156°, and the player sprints 2 km in one straight line (`straightTravel`) north-north-west, 1.6 km past the square over ground `TerrainTiles` streams around it, stays grounded, and the tile edges meet with no height gap; the outermost tile slides onto the collar, so `streamCollarGap` (the step at a tile vertex) stays at most 0.01 m and `streamCollarFold` reports the step between vertices. Prop collision is off because the route is a straight line through a forest: a trunk stands just past the 4 m spawn clearing (the run stops after 4.46 m with it on); `collide.playtest.json` proves the trunks.
  - `playtests/swim.playtest.json`: checks the player walks into the forest river, swims across it afloat (`CharacterBody3D.water`, immersion 0.62, off the bed) with the UAL1 swim clip, and climbs out on the far bank, and floats with no key held while the river carries it downstream (`CharacterBody3D.waterCurrent`, `swimDrift` at least 1.5 m); `?swim=off` and `?current=off` are its before arms.
  - `playtests/switch.playtest.json`: checks the world keys re-enter scenes: forest ready, `Digit2` to a ready coast, `Digit1` back to a ready forest, on one page with no console error. Before the fix it aborted the Wasm engine in the switch frame (`TN_VIRTUAL_SHADOW_UNINITIALISED`'s cause, a `t_vsm0` binding with no atlas view).
  - `playtests/terrain.playtest.json`: primary playtest scenario for shared web/desktop showcase views.
  - `playtests/upload.playtest.json`: smoke scenario proving the forest world loads and renders on WebGPU with no console or runtime errors under the generated Three.js patch.
  - `playtests/vista.playtest.json`: the fixed forest pose the look goal is judged at (forest, lake and mountain backdrop) with no console or runtime error.
  - `playtests/walk.playtest.json`: playtest scenario checking baked terrain triangles and player walk stability.
  - `playtests/water-proof.playtest.json`: the coastal water-contribution proof on the owned engine: it enters the coast from the forest walk as the terrain scenario does, and the sheltered pool's diagnostic attachment reads back above the gate.

- Verification and test suites:
  - `scripts/verify/verify-assets.mjs`: verifies asset manifests, replacement tables, and model loading.
  - `scripts/verify/verify-authored-world.mjs`: verifies that editor-authored modifications reproduce committed baseline output.
  - `scripts/verify/verify-cameras.mjs`: checks camera viewpoints, transitions, and framing across all world biomes.
  - `scripts/verify/verify-consumer.mjs`: verifies packaging and consumption of the authored world in an external project.
  - `scripts/verify/verify-custom-assets.mjs`: proves custom asset overrides swap cleanly without starter assets.
  - `scripts/verify/verify-editor.mjs`: verifies live editor tool application, brush operations, and undo/redo state.
  - `scripts/verify/verify-environment.mjs`: tests biome-specific environmental lighting and atmosphere settings.
  - `scripts/verify/verify-game-handoff.mjs`: verifies clean scene handoff into an ordinary playable ThreeNative game.
  - `scripts/verify/verify-import-export.mjs`: checks full import and export roundtrips for world documents.
  - `scripts/verify/verify-landforms.mjs`: validates terrain elevation bounds, slopes, and landform contours.
  - `scripts/verify/verify-ocean.mjs`: verifies ocean surface rendering, shorelines, and waterline properties.
  - `scripts/verify/verify-sky.mjs`: checks procedural and LUT sky dome conditions across time and weather.
  - `scripts/verify/verify-starter-kit.mjs`: verifies starter kit configuration, generation, and multi-world playtests.
  - `scripts/verify/verify-surfaces.mjs`: verifies PBR terrain surface materials, splat textures, and blend transitions.
  - `scripts/verify/verify-tool-groups.mjs`: tests editor UI tool groupings, interactions, and parameter schemas.
  - `scripts/verify/verify-transforms.mjs`: validates coordinate transforms, rotations, and placement matrices.
  - `scripts/verify/verify-variations.mjs`: PRD-866 Phase 3: cooks "a spruce forest under mountains" through the terrain MCP server with seeds 1, 2 and 3, bakes each with `STRATA_WORLD`, and asserts three ground hashes, three massif poses and the backdrop gates on each ring (network on a cold tile cache).
  - `scripts/verify/verify-world-export.mjs`: verifies headless static world GLB export and vanilla Three.js loading.
  - `scripts/verify/check-water.mjs`: regression tests for shared water rendering and shoreline depths.

- Authoring, staging and data preparation:
  - `scripts/fixtures/editor-conflict.ts`: mounts two editor clients against the same document for the conflict scenario.
  - `scripts/bake/bake.mjs`: bakes source elevation data and generates canonical world JSON packages.
  - `scripts/bake/recipe.mjs`: the five worlds' landform recipes and surface manifests as a module; `bake.mjs` evaluates them, nothing else imports it.
  - `scripts/bake/recipe.d.mts`: the TypeScript declarations for `recipe.mjs` (`outputDir`); the recipe's worlds stay untyped script values.
  - `scripts/bake/props.mjs`: the prop half of the bake: one container per streamed world through `compilePropBuckets`, with the game's own bucket and reach policy.
  - `scripts/bake/stamp.mjs`: hashes every input a bake depends on and reports whether the written worlds are stale; `pnpm dev` checks it on every start.
  - `scripts/bake/stamp.d.mts`: the TypeScript declarations for `stamp.mjs` (`stamp`, `isFresh`).
  - `scripts/bake/world-files.mjs`: lists the baked files the game fetches, read from the bake's own `<world>.props.json` manifests, and stops the build by name (`TN_STRATA_BUILD_MISSING`) on a file the bake did not write.
  - `scripts/verify/consumer-world.mjs`: exports `openConsumerPage` to serve an installed consumer directory to headless Chromium and run vanilla full-world export against packed tarballs.
  - `scripts/prep/stage-native-assets.mjs`: stages textures and models for native desktop/mobile bundles.
  - `scripts/verify/verify-native-staging.mjs`: verifies staged native assets resolve with their manifest hashes and sizes.
  - `playtests/reveal.playtest.json`: checks startup readiness and publication, shadow and impostor stability after reveal.
  - `scripts/prep/make-needle-atlas.mjs`: procedural generator for conifer needle foliage atlases.
  - `scripts/prep/prep-fab-pines.py`: manual prep script requiring Blender CLI and authored Fab Scots pine GLB to decimate and budget pines.
  - `scripts/prep/prep-fab-temperate.mjs`: cooks and fixes texture atlas and opacity bindings for temperate models.
  - `scripts/prep/prep-landscape-pro.mjs`: stages licensed Landscape Pro species for game runtime loading.
  - `scripts/prep/prep-polyhaven-fir.py`: manual prep script requiring Blender CLI and authored Poly Haven fir 1k .blend to export game GLBs.
  - `scripts/prep/prep-polyhaven-rock.py`: manual prep script requiring Blender CLI and authored Poly Haven boulder 1k .blend to export game GLBs.
  - `scripts/prep/prep-trees.py`: manual prep script requiring Blender CLI and authored CC0 tree models to decimate to triangle and atlas budgets.

- Landform measurement and diagnostics:
  - `scripts/measure/measure-embankment.mjs`: measures cross-section geometry and bench cut slope of road embankments.
  - `scripts/measure/measure-light.mjs`: measures display-referred Rec.709 luminance against reference calibration.
  - `scripts/measure/measure-spikes.mjs`: detects elevation spikes and gradient discontinuities across terrain bakes.
  - `scripts/measure/measure-terrain.mjs`: tabulates terrain relief, slope, bake timing, and drainage metrics.

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
  - `scripts/dem/massif.mjs`: cuts whole mountains, foot to foot, from the USGS 3DEP elevation service (public domain, 1 m lidar) into the int16 tiles `placeMassif` stands behind a world; needs the network and rewrites `massif-<name>.bin` and `.json`.
  - `scripts/dem/massif-longs.bin`: int16 elevation tile for the Longs Peak massif backdrop.
  - `scripts/dem/massif-longs.json`: grid metadata, site and coordinate bounds for the Longs Peak massif.
  - `scripts/dem/massif-maroon.bin`: int16 elevation tile for the Maroon Bells massif backdrop.
  - `scripts/dem/massif-maroon.json`: grid metadata, site and coordinate bounds for the Maroon Bells massif.
  - `scripts/dem/massif-teton.bin`: int16 elevation tile for the Grand Teton massif backdrop.
  - `scripts/dem/massif-teton.json`: grid metadata, site and coordinate bounds for the Grand Teton massif.

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
  - `scripts/fixtures/kit-game/KitScene.ts`: shared starter kit fixture scene parameterised by biome.
  - `scripts/fixtures/kit-game/game.ts`: standalone multi-world game harness testing starter kit scenes.
  - `scripts/fixtures/kit-game/state.ts`: shared state for starter kit game fixture.
  - `scripts/fixtures/kit-game/playtests/alpine.playtest.json`: playtest scenario for starter kit alpine world.
  - `scripts/fixtures/kit-game/playtests/coastal.playtest.json`: playtest scenario for starter kit coastal world.
  - `scripts/fixtures/kit-game/playtests/desert.playtest.json`: playtest scenario for starter kit desert world.
  - `scripts/fixtures/kit-game/playtests/kit.playtest.json`: master playtest scenario verifying starter kit worlds.
  - `scripts/fixtures/kit-game/playtests/tundra.playtest.json`: playtest scenario for starter kit tundra world.
