# PRD-790 — A new biome is a data row, and the world streams past one square

**Status:** NOT STARTED
**Priority:** P2 — Biome rules are 71 code branches and every world is one 512 m square, so a sixth biome or a larger world needs edits in four files (Phase 1 and Phase 2 boxes open).
**Complexity:** 7 (MEDIUM-HIGH); risk override: the refactor must not change the look of the five worlds, so the owner's visual-judge rule applies
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-591](PRD-591-the-preview-stops-reimplementing-engine-mechanisms.md) AC-4 (height bands from the measured height range) for the band fields of a row
**Epic:** [Strata terrain hardening](README.md) (PR #483)

## Context

Owner, 2026-11-04: "do you think we shold do some refactoring? is the code we ahve scalable enough
to support differnt biomes, terrains, etc etc?", then "ok, please write a PRD about 1/2". Option 1
was a biome spec table and option 2 was terrain streaming fed by the heightmap generator. Options 3
(split `game.ts`) and 4 (split the engine files) are not in this PRD.

Audit of `cf7b43e10`, `examples/strata-terrain-preview/src/`:

- **Biome rules are code, not data.** `world === "..."` branches: `render/terrain.ts` 30,
  `game.ts` 22, `render/scatter.ts` 11, `render/biomes.ts` 8 (71 in total). A sixth biome needs a
  new branch in each of these files, and a missed branch fails silently: the world draws the
  fallback of the branch it fell through.
- **One square per world.** `scripts/bake.mjs:117` and `:185` bake each world as one
  `Terrain({ size: 512, resolution: 257 })`. Past the square there is only the surveyed horizon
  ring (`render/horizon.ts`), with a 200 m walkable band since `167b5a796` and walls past it.
- **The streaming mechanism exists but the game does not use it.** `TerrainTiles` in
  `packages/core/src/world-tiles.ts` (residency, LOD, skirts, collider lifetime, hard budgets) has
  one caller in the game, `src/world/forestStage.ts`, the staged A/B arm.
- **The generator exists.** `a11d3e6f9` and `c6dfb94e2` added fluvial erosion and landform presets
  to `@threenative/terrain` (`LANDFORMS`, `landform(kind, { size, resolution, seed })`,
  `landformBackdrop`, `packages/terrain/src/core/presets.ts:39, 94, 269`). Nothing streams its
  output yet.

Unreal reference (read in `~/projects/UnrealEngine`, borrow the data layout and defaults, never the
code):

- Placement rules are per-type data, not code: `UE 5.8.3: Engine/Source/Runtime/Foliage/Public/FoliageType.h:151`
  (`Density`), `:240` (`GroundSlopeAngle` interval), `:244` (`Height` interval), `:450`
  (`InitialSeedDensity`), and `:375` (`BodyInstance`: collision is a field of the foliage type).
- Ground cover is per landscape layer: `UE 5.8.3: Engine/Source/Runtime/Landscape/Classes/LandscapeGrassType.h:45`
  (`GrassDensity`), `:59` (`StartCullDistance`), `:176` (`GrassVarieties`).
- Streaming by range around the player: `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/RuntimeHashSet/RuntimePartition.cpp:27`
  (default `LoadingRange` 25600 cm = 256 m), `RuntimePartitionLHGrid.cpp:128` (cell size at least
  1600 cm), and per-region landscape actors in
  `Engine/Source/Runtime/Landscape/Classes/LandscapeStreamingProxy.h:20`.
- Feature map row: "World Partition and HLOD", **Partial** (`docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.md:264`).

## Solution

**One biome is one row.** `render/biomes.ts` exports a typed `BiomeSpec` table, one row per biome:
ground palette (meadow, soil, litter, snow and shore bands as fractions of the measured height
range), scatter rules per species (density, slope interval, height interval, spacing, as in
`FoliageType`), a collision class per asset (none, trunk or hull), water (river, lake, ocean),
the atmosphere and light preset, and the landform kind for the generator. `terrain.ts`,
`scatter.ts` and `game.ts` read the row and keep no biome branch. A missing field fails the
bake with the biome and field name.

**The world streams.** The bake writes the generator's heights as tiles instead of one square.
The game drives `TerrainTiles` around the player (ring, colliders, LOD, budgets from core) and
the horizon ring stays the far backdrop. A biome map gives each tile its row weights, so two
biomes meet at a blended border. Look stays in game `src/render/`, and residency stays in core.

## Execution Phases

### Phase 1 — Biome rows

- [x] `BiomeSpec` table with five rows; `terrain.ts`, `scatter.ts`, `game.ts` and `biomes.ts` hold 0 `world === "..."` branches. proof: `rg -c 'world [!=]== "' examples/strata-terrain-preview/src` prints nothing, plus `pnpm --filter strata-terrain-preview typecheck` — 2026-11-08, found shipped by #483 (972d1e371): the five rows are `packages/terrain/starter/<biome>/biome.data.json`, read once through `validateBiome` into `BIOME_SPECS` (`src/render/biomeData.ts`); the grep prints nothing and the example's `tsc --noEmit` exits 0.
- [x] A row with a missing or out-of-range field fails the bake and names the biome and field. proof: `examples/strata-terrain-preview/__tests__/biome-spec.spec.ts` (red with a removed field, green with the full table) — 2026-11-08: the spec lives with the validator, `packages/terrain/__tests__/biome-spec.spec.ts`, 7/7: every shipped file validates, and a removed `seed`, a removed `grass[0].spacing`, an unknown `sky` and a slope of `[0, 120]` each throw naming the biome and the field. The bake reads each row through the same `validateBiome` (`scripts/bake.mjs:32`), so a bad row stops the bake by name.
- [ ] The five worlds look the same as before the refactor. proof: `capture-strata-worlds` before/after, two runs per arm, fresh visual judge NEUTRAL or better for all five
  2026-11-08: open. The refactor landed inside #483, so its before arm is a pre-#483 commit; `biome-values.spec.ts` pins every value the old branches computed, which proves the numbers, not the look.

### Phase 2 — The world streams

- [ ] The playable terrain is generator tiles streamed by `TerrainTiles` around the player, with colliders in the collider radius. proof: `playtests/stream.playtest.json` walks 2 km in a straight line and asserts `travel` >= 2000 and `grounded`
- [ ] Tiles join with no gap, to each other and to the horizon ring. proof: the same scenario with `?tnTerrainValidate=1` asserts `maxSeamGap` <= 0.01 m 2026-11-10: tile-to-tile proven, `streamSeamGap` 0 (≤ 0.01) over 81 resident tiles in the green stream run. The tile-to-ring join is not measured: both sample `createWorldHeight` and the judge read it NEUTRAL, so this stays open until a ring seam is measured.
  2026-11-09, groundwork only: `createWorldHeight(data, world)` (`src/render/horizon.ts`) is the one height a streamed tile samples, the square inside and the collar's own height past its edge. The collar's seam step was read at the nearest edge vertex, so between vertices the joined surface stepped 0.56 m; it now reads the square bilinearly along the edge. `__tests__/world-height.spec.ts`: the edge gap is 0.56 m red and <= 0.01 m green, and the sampler answers the collar mesh's own heights; every forest and coastal collar vertex matches the previous build within 1 mm. Still open: the tiles themselves. The ground material reads square-space maps (curvature, erosion) and the collar draws boundary vertex colours, so a tile past the square needs its own ground look in `src/render/` and a visual judge.
  Design for the tiles (2026-11-09, not started): `TerrainTiles` samples `createWorldHeight` over the collar's reach, with colliders in `colliderRadius` and skirts. One uniform square around the player splits the draw: the collar discards its fragments inside that square and the tiles discard theirs outside it, and inside the playable square, so nothing draws twice and the skirts hide the coarse-to-fine crack (the Unreal shape is World Partition's landscape proxy hiding its HLOD while the components are resident). The tile look copies the collar's (the boundary colour of the edge point a site projects to, as `collarColors` does), so the swap is invisible; the walk-band walls then move to the collar's reach. The `?tnTerrainValidate=1` seam gap reads `createWorldHeight` on both sides of every resident tile edge. PRD-580 AC-1 needs the same horizon in the kits.
  2026-11-09, tiles built behind `?stream=1` (default unchanged until the judge and a quiet-host perf read): `src/world/streamedGround.ts` streams 64 m tiles (2 m spacing, one LOD level, radius 4, colliders radius 1) out to the collar's reach from `createWorldHeight`; core `TerrainTiles` gained `hole` (a tile wholly inside a region another surface draws is never meshed and gets no collider; red-green in `world-terrain-tiles.spec.ts`). The split square follows the player's tile and covers only resident tiles, so a building tile leaves the collar showing. `stream.playtest.json` (load 31 host): `travel` 2121 m, `edgeOvershoot` 1802 m, `grounded`, 81 resident tiles, seam gap 0 (default three LOD levels measured 0.45–1.96 m, so the tiles run one level). Box 1 stays open: the 2 km is 1.8 km straight south to the foot of a 47° slope (south is the longest line from the spawn with no slope over 45°; north circles because the camera follows the player) and 0.3 km along it. Box 3 stays open: the run logs 8 `TN_SCENE_WARNING`s at load 31 and the no-stream `edge.playtest.json` control logs one on the same host, so they are unattributed; `pipelinesSinceReveal` is not asserted yet.
  2026-11-09, attribution: the edge pose before/after (two runs per arm, NVIDIA Turing, sheets in the PR) was judged NEUTRAL by a fresh judge: no seam, hole or colour step at tile borders, RMSE 0.0169 both runs; the 1.8 km frames pass. The scene warnings are host load: the no-stream arm logged 3 and 2, the stream arm 0 and 2. `pipelinesSinceReveal` is 1–2 after the straight run and 46–60 after the turn along the slope. A census log of each late pipeline names them: one is the tile block's `main-clipped` (mirror pass) variant, which the warm-up compiled only for `main`; the other 58 are the `lake-surface` material (one material id) created again and again in `main-clipped`, a pipeline that is released and rebuilt rather than a new material. The loop scenario turns the camera at the spawn with 0, so the churn needs a pose only streaming reaches; its owner is the owned engine's pipeline cache (see below), and it gets its own investigation before box 3 can tick.
  Second census run with reasons: every `lake-surface` creation has the same program (vertex and fragment hashes `3fceb7f774a309d3/1cbf2416a4c5264b`) and a new backend pipeline, reason `unknown-structural-difference`; no game code changes the lake's side, blending, depth or transparency. So the pipeline is released and rebuilt with no shader change. A third run hooked three's `Renderer._pipelines` and found none: the preview draws on the owned engine (the default renderer), so the rebuild is in the engine's pipeline cache, not three's. Correction after a fourth run: the census wraps three's `WebGPUBackend` (`ctx.renderer.raw`), and logging the lake's render object on each key change shows one field flipping, `material.side` 0 <-> 1: three draws a transparent `DoubleSide` material twice per frame (BackSide, then FrontSide), and at that pose the flip rebuilt the pipeline each time. Fix in the game (`src/render/river.ts`): the lake sets `forceSinglePass: true`, one draw for a near-flat sheet. Late pipelines on the scenario went 46–60 -> 4; a fresh judge rated the vista lake before/after NEUTRAL (lake mean colour within run-to-run noise, no artifact). `stream.playtest.json` now asserts `pipelinesSinceReveal` <= 4 as a ratchet; the 4 left are the tile block's mirror variant, one unnamed basic material at the first step, and `authored-terrain` and the distant ridges on the far turn. `loop.playtest.json` read 1 late pipeline once with the fix and once without it (load 27), and 0 on a third run, so its single pipeline is a load flake on this host, not this change. Engine follow-up: why a two-pass draw rebuilds instead of reusing its two pipelines is three's (or the census's) question; any game with a transparent double-sided material can meet it.
  The 4 left, from a log of each render object's first draw per render context after the reveal: (1) the tile block's first draw — the streamed ground starts after the curtain lifts (the ground material and the actor resolve late), so keeping tiles unculled behind the curtain never ran and was reverted; the fix is to join the stream's first tiles to the spawn readiness so the curtain waits for them; (2) one unnamed `MeshBasicNodeMaterial` at the first step, not yet named; (3, 4) `authored-terrain` and `temperate-distant-ridges` drawn for the first time into the lake mirror's `Reflector` target (640 px) on the far turn — their keys never change, so the mirror pass reaches them only from there. Warming every mirror-visible object, or skipping the mirror for a lake that covers a few pixels, is the `WaterSurface3D` question (core).
  Cause (1) fixed: the stream now runs on `ctx.beforeRender` (the fixed step does not run behind the curtain), draws its tiles unculled until every tile around the spawn has drawn twice, and `groundReady` joins the spawn readiness so the curtain waits for that. `stream.playtest.json`: 0 late pipelines through the 1.8 km straight run, 3 on the far turn (the unnamed basic material, created mid-run, and the two mirror first draws); the ratchet is now 3.
  Tried and reverted: drawing the lake unculled behind the curtain so its mirror builds both pipelines there. It worked (stream 3 -> 1 late pipeline, the loop 0), but every curtain frame logged `copyFramebufferToTexture: Source and destination formats do not match. rgba8unorm rgba16float`: behind the curtain the world draws to the 8-bit canvas, not the HDR target play uses, so the lake's `viewportSharedTexture` copy fails. The curtain-time world draw taking a different render path from play is a core question (`game-frame-loop.ts` world pass under `keepWorldRendering`); until it matches, a screen-copy material cannot warm there. It also suggests the loop's intermittent single late pipeline is this mirror's first draw on the 360° turn.
- [ ] Streaming builds no pipeline and adds no hitch after the reveal. proof: `stream.playtest.json` asserts `pipelinesSinceReveal` 0 and no `TN_SCENE_WARNING` or `TN_HOT_CALL`; `loop.playtest.json` stays green — 2026-11-10: pipeline half proven. `stream.playtest.json` reads `pipelinesSinceReveal` 0 (ratchet now `lte 0`) and `loop.playtest.json` reads 0 and passes whole, on a quiet host (load 5). The last three late pipelines had two causes: the lake mirror first drew its reflected surfaces on the far turn (the lake now draws unculled for two draws inside the spawn join, re-culled before the held startup compile, whose canvas-format screen copy the lake's refraction refuses), and core's partial-shadow reset quad was built on the first partial reset (core now draws it once under the first whole shadow render; red-green in `virtual-shadow-partial.spec.ts`). This also explains the loop's intermittent single late pipeline. Open: one `TN_SCENE_WARNING` in the stream run at window 8 (spawn view, `renderMs` 31.5, 385 objects considered), not in the far run. Rerun 2026-11-10 (load 9): `stream.playtest.json` exit 0, `pipelinesSinceReveal` 0, no `TN_SCENE_WARNING`, no console error. So the spawn-window warning showed in 1 of 2 quiet-host runs; left open until it is 0 in repeated runs.

### Phase 3 — Proof by a new biome

- [ ] A sixth biome ships as one new row plus bake data, with no code branch. proof: the commit diff touches only `render/biomes.ts` and bake inputs; `capture-strata-worlds --worlds <new>` frames non-blank on NVIDIA — 2026-11-09, prep: the five world names lived in seven copies (the `WorldName` type, the key map, bake, stamp, recipe, measure). They now come from one list, `src/render/worldNames.ts`; the number keys follow its order. A sixth world is a name there, its row in `biomes.ts` and its `dem/<name>{,-horizon}` survey pair. Typecheck, 273 preview tests and the bake pass with no baked-file change. Open: the biome itself.
- [ ] Two biomes meet at a blended border in one streamed world. proof: `stream.playtest.json` crosses the border; fresh visual judge rates the border frames with no hard seam

## Acceptance Criteria

- [ ] AC-1: Adding a biome needs no code edit outside its row. proof: Phase 3 box 1
- [ ] AC-2: A player walks 2 km without a wall, a gap or a hitch. proof: Phase 2 boxes
- [ ] AC-3: The five shipped worlds keep their look. proof: Phase 1 box 3

## Out of scope

- River look, swimming and prop colliders: separate fixes on PR #483 (owner reports, 2026-11-04).
- Splitting `game.ts` (1817 lines) or the large engine files: refactor options 3 and 4, not asked.
- `loadTerrainSplat` ground plumbing: PRD-591 AC-4.

## Decisions

- 2026-11-04, owner: options 1 and 2 of the refactor answer go into one PRD ("please write a PRD
  about 1/2"). Options 3 and 4 are not planned.
