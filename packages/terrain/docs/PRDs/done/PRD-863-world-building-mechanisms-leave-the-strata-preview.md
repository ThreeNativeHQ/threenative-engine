# PRD-863: World-building mechanisms leave the Strata preview

**Status:** IN PROGRESS — Phase 1 started 2026-11-10 (PR #635).
**Priority:** P1 — a fix in the preview leaves every kit and every game with the bug.
**Complexity:** 6 (MEDIUM-HIGH): water, streaming and terrain fields; props, models and the collar are [PRD-864](../P2/PRD-864-prop-and-collar-mechanisms-leave-the-strata-preview.md).
**Epic:** [Strata terrain hardening](../README.md); rides PR #635 (owner, this session: no extra PRs).

## Problem

Owner, 2026-11-10: "are these structures being hardcoded on examples/strata-terrain-preview/? shouldnt these abstractions to create rivers, etc, line on the terrain package? it should be reusable. also the performance related ones (core?)", then "extract all world building abstractions you can" and "hook with engine_capabilities".

The proof: the river surface stopped in a straight edge at its first station while core's `WaterBodies` floods a round cap past it, so the player swam in water nobody drew. The preview, the forest kit and the tundra kit each drew their own ribbon, and none matched the query. A read-only inventory (DeepSeek arm, 2026-11-10) lists 17 mechanisms that live only in `examples/strata-terrain-preview/src/`, about 3 000 lines, with 342 lines of lake geometry copied into two kits.

## Rules

- Runtime mechanism goes to `@threenative/core` (`/world` for terrain and water); `packages/terrain` stays authoring and bake only, because a shipped game plays without it (`test:consumer`).
- Look stays game source in `src/render/`: every colour, ripple, opacity and timing comes from the caller.
- Each moved export carries `@situation`, `@constraint` and `@example` JSDoc, so `engine_search_capabilities` returns it; the pre-commit `capabilities:sync` regenerates the manifest.
- Each move is red-green: a core spec, the preview and kit callers switched in the same commit, the old copy deleted.
- A move that changes a frame gets before/after captures and a fresh visual judge.

## Execution Phases

### Phase 1 — water

- [x] River surface geometry: core `riverRibbonGeometry` beside `WaterBodies`, a reach past each end; the preview and both kits call it. proof: `world-river-ribbon.spec.ts`, `river-ribbon.spec.ts` (forest bake), `test:water`, the river-head judge — 2026-11-10: `river-ribbon.spec.ts` red on the old ribbon (the swim query floods half a reach past the head, nothing drawn) then green; core spec 4/4; preview 274/274 and `test:water` PASS; the kits pass a half-width reach and 3 columns, so only their end caps change. Fresh judge on the river-head sheets (two runs, NVIDIA Turing, `~/Downloads/strata-river-head/`): IMPROVEMENT both runs — the straight edge is gone, the carved head fills, no new artefact.
- [x] Lake surface geometry: core `lakeSurfaceGeometry` draws the disc `WaterBodies` floods (out to `lakeReach`, wet cells only, `metres` depth); the preview calls it. proof: `world-river-ribbon.spec.ts` lake cases, the forest lake mesh before and after — 2026-11-10: core 7/7 (every point the lake query floods over ground under the level is drawn); the forest lake is 6 992 triangles before and after, positions and `metres` exact, `waveDepth` within 6e-8, so no frame changes and no judge is due. The port also sizes the vertex buffer to the rings it fills (the preview's held one unused ring at the origin).
- [x] Shore distance and open-sea exposure field: core `shoreField` for the preview and the coastal kit. proof: `world-shore-field.spec.ts`, the coastal bake's field before and after — 2026-11-10: core 3/3; on the coastal bake both arrays are identical to the old inline code across 66 049 nodes (5 733 exposed), so no frame changes; the kit ran the same 57 lines, now one call.

### Phase 2 — streaming and startup

- [x] Streamed ground: the per-frame budget is core's existing `AdmissionBudget` (now exported and tagged), the settled block is `TerrainTiles.settledHalf`, and the warm-before-reveal is core `warmUnculled`; `streamedGround.ts` keeps the game's tile size, colliders and material (170 -> 100 lines). proof: `world-terrain-tiles.spec.ts`, `world-warm.spec.ts`, `stream.playtest.json` `pipelinesSinceReveal` 0 — 2026-11-10: core 82/82 (settled block red without the method); `stream.playtest.json` (`?stream=1&tnTerrainValidate=1`, load 17) `pipelinesSinceReveal` 0 and every stream counter passes. The run exits 1 on 3 console errors and 2 `TN_SCENE_WARNING`s, and HEAD's code shows the same 3 errors on the same host (A/B below), so they are not this change.
- [x] Lake warm behind the curtain: the preview's hand-written lake hook is now `warmUnculled(ctx, lake.mesh)`, the same helper the tiles use. proof: `world-warm.spec.ts`, `loop.playtest.json` 0 late pipelines — 2026-11-10: `loop.playtest.json` `pipelinesSinceReveal` 0 with HEAD's `game.ts` and with this one (load 17); both runs log the same 3 `copyFramebufferToTexture` console errors inside the held startup compile, a pre-existing core bug: on the owned engine `warmUpWorldPass` is undefined, so `renderWarmPasses` draws every object unculled straight to the `rgba8unorm` canvas, and a refracting water material copies that into its `rgba16float` scene copy. Tracked in PRD-790's streaming box.

### Phase 3 — terrain fields

- [x] `measureBiome` uses the terrain package's `measureBands`. proof: preview tests, the bands before and after — 2026-11-10: `measureBiome` is now a 15-line adapter from the preview's fraction record to `measureBands` layers; the measured biome is deep-equal to the old code on all five worlds; preview 274/274.
- [x] Drawn-surface sampler: core `surfaceSampler(field, matrixWorld)` replaces the preview's `createGroundSampler` (same logic; the unused geometry argument is gone). proof: `world-surface-sampler.spec.ts`, the preview's `groundSampler.spec.ts` against a raycaster and the collider — 2026-11-10: core 2/2; the preview's 8 cases pass on the core function; preview 274/274.

## Decisions

- 2026-11-10 (agent, AFK): the spawn gate stays in the preview. Its generic part, a deadline that holds the loading curtain, is already core's `ctx.startup.hold(label, promise, budgetMs, progress)`; what is left is this game's `TN_STRATA_SPAWN_FAILURE` receipt, its witness fields and its `worldReady`/`loadingError` state.

- 2026-11-10 (agent, AFK): the curvature texture stays in `src/render/terrain.ts`. Its Laplacian gain, 8 m neighbourhood, wet margin, river reach and flow normalisation decide how the ground shades, and look stays game source.
- 2026-11-10 (agent, AFK): `skyVisibility` moves to `@threenative/terrain` with the next rebake, not now. `scripts/stamp.mjs` hashes its source into every bake, so a move alone rebakes all five worlds and commits about 50 MB of new JSON for no runtime change.

- 2026-11-10 (agent): the forest and tundra kits keep their own lake surfaces; the box that switched them to `lakeSurfaceGeometry` is deleted. `lakeSurfaceGeometry` exists so the drawn lake matches `WaterBodies`' swim query, and the kits run no swim query, so there is no mismatch to fix. The tundra kit also clips each frozen kettle at the ground's contour, which a disc of wet cells would coarsen. A kit that adds swimming switches then.

## Acceptance Criteria

- [x] AC-1: No water, streaming or terrain-field mechanism in the inventory is left only in the preview, or each one left has a written reason here. proof: the inventory table in this PRD's PR comment — 2026-11-10: [PR #635 comment](https://github.com/ThreeNativeHQ/threenative-engine/pull/635#issuecomment-6750056714), 12 mechanisms: 9 moved, 3 kept with the reasons under Decisions.
- [x] AC-2: `engine_search_capabilities` returns each moved export for its situation. proof: `searchCapabilities` (the MCP tool's function) on the worktree manifest — 2026-11-10: 7/7 rank first: `riverRibbonGeometry`, `lakeSurfaceGeometry`, `shoreField`, `AdmissionBudget`, `TerrainTiles` (`settledHalf`), `warmUnculled`, `surfaceSampler`. Note: `call.mjs` from this worktree reaches the main checkout's `.mcp.json` and its older manifest; an installed game reads its own.
- [x] AC-3: The five worlds and the kits look the same or better (fresh judge per visual phase). proof: judge verdicts on the PR — 2026-11-09: forest river head IMPROVEMENT (above). Kits, forest and tundra, 5 shots, 2 runs per arm, headed WebGPU on NVIDIA Turing: NEUTRAL, no regression; no close river end in their shots. Preview tundra, 3 river-end poses pinned by script in headed Chrome on the same GPU: the first judge found a REGRESSION at the meltwater head, where the cap past the head hung 2-3 m over snow that falls away upstream. Fix: core `riverRibbonGeometry` drops a cap whose ground sits below the bed at its end station (`world-river-ribbon.spec.ts` red, then 8/8; core world specs 973/973; forest ribbon index arrays identical before and after, tundra 27 600 -> 27 522 triangles). Fresh judge on the fixed arm: NEUTRAL at all three poses, 2 runs per arm. Coastal, alpine and desert draw no river; the other moves are equality-proven. The kit judge ran before the fix; the fix only drops caps, toward BEFORE. Open beside it: the swimmer query (`WaterBodies`) still floods past the meltwater head, as before this PRD.
