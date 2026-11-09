# PRD-863: World-building mechanisms leave the Strata preview

**Status:** IN PROGRESS — Phase 1 started 2026-11-10 (PR #635).
**Priority:** P1 — a fix in the preview leaves every kit and every game with the bug.
**Complexity:** 6 (MEDIUM-HIGH): water, streaming and terrain fields; props, models and the collar are [PRD-864](PRD-864-prop-and-collar-mechanisms-leave-the-strata-preview.md).
**Epic:** [Strata terrain hardening](README.md); rides PR #635 (owner, this session: no extra PRs).

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
- [ ] Lake surface geometry (flood fill, wet-cell triangulation, depth attribute): one core function for the preview and both kits. proof: a core spec, kit playtests, judge
- [ ] Shore distance and open-sea exposure field: one core function for the preview and the coastal kit. proof: a core spec, the coastal playtest

### Phase 2 — streaming and startup

- [ ] Streamed ground: per-frame admission budget, covered-block split and warm-before-reveal move into `TerrainTiles` (`ready`, a time budget option); `streamedGround.ts` shrinks to the game's colliders and material. proof: `world-terrain-tiles.spec.ts`, `stream.playtest.json` `pipelinesSinceReveal` 0
- [ ] Mirror warm behind the curtain: `WaterSurface3D` draws its reflector once before the reveal; the preview's lake hook is deleted. proof: a core spec, `loop.playtest.json` 0 late pipelines
- [ ] Spawn admission gate (one deadline, readiness join, failure receipt). proof: a core spec, `reveal.playtest.json`

### Phase 3 — terrain fields

- [ ] `measureBiome` uses the terrain package's `measureBands` (an exact duplicate). proof: preview tests
- [ ] Curvature field, sky visibility bake, drawn-surface sampler. proof: a core spec each, values equal to the preview's before the move

## Acceptance

- [ ] AC-1: No water, streaming or terrain-field mechanism in the inventory is left only in the preview, or each one left has a written reason here. proof: the inventory table in this PRD's PR comment
- [ ] AC-2: `engine_search_capabilities` returns each moved export for its situation. proof: `node packages/core/mcp/call.mjs threenative-engine engine_search_capabilities` per situation
- [ ] AC-3: The five worlds and the kits look the same or better (fresh judge per visual phase). proof: judge verdicts on the PR
