# PRD-864: Prop and collar mechanisms leave the Strata preview

**Status:** IN PROGRESS — Phase 1 done 2026-11-10 (PR #635).
**Priority:** P2 — the prop placement, prop streaming, model preparation and collar code live only in the preview, so a game or kit cannot reuse them.
**Complexity:** 7 (HIGH): about 1 900 lines.
**Depends on:** [PRD-863](../done/PRD-863-world-building-mechanisms-leave-the-strata-preview.md) (same rules, same inventory)
**Epic:** [Strata terrain hardening](../README.md); rides PR #635.

## Problem

The second half of the PRD-863 inventory (owner, 2026-11-10: "extract all world building abstractions you can"): prop placement and grounding, the baked prop package stream and the meadow lifecycle, model-to-prop preparation, and the terrain mesh, far collar, walk band, canopy paint, texture preparation and baked file fetch. The rules are PRD-863's.

## Execution Phases

### Phase 1 — placement

- [x] Placement pose: core `staticLowestY`, `footprintGap` and `baseRingGap` (`@threenative/core/world`); the preview's `preparePose` calls them, and the per-asset burial shares stay game choices. proof: `world-static-pose.spec.ts`, `collide.playtest.json` — 2026-11-10: core 3/3 (lowest point equals a full vertex scan on three tilted poses); old and new `preparePose` gave bit-identical matrices and clearances on over 100 asset, pose and ground cases; preview 274/274; `collide` (load 13) passes `propColliders`, `propOverlapFrames`, `grounded` and `movement`, and exits 1 only on the known spawn-view `TN_SCENE_WARNING` (window 15, `renderMs` 42.7) that PRD-790 tracks.

### Phase 2 — prop streaming and models

- [x] Baked prop package decode: `@threenative/terrain` `decodePropBucket`, the inverse of its own `compilePropBuckets`, replaces the preview's `recordsOf` decode. proof: `prop-package.spec.ts` round trip, `reveal.playtest.json` — 2026-11-10: terrain 6/6 (every compiled record reads back to its ID, model, pose and reach; a buffer that disagrees with its IDs throws `TN_PROP_BUCKET_INVALID`); the old and new decode are deep-equal on every record of the forest bake; preview 274/274; `reveal` exit 0, 10/10 (load 9). The records are identical, so no frame changes and no judge or `lod` run is due.
- [x] Model to prop parts: core `meshSections`, `sectionGeometry` (one whole-model base for every section) and `repairZeroNormals`; `pack.ts` keeps its per-world reshape table. proof: `world-model-sections.spec.ts`, the old and new `prepareGeometry` compared — 2026-11-10: core 2/2; positions, normals and draw ranges bit-identical on over 400 world, asset, stone and section cases, so no frame changes and no judge is due; preview 274/274.

### Phase 3 — collar, walk band and loading

- [x] Baked file fetch: core `fetchAsset(assets, path)` walks every url `assets.resolve` names and throws `TN_ASSET_NOT_SERVED` naming each miss; the preview's `fetchBakedFile` and core's own `loadTerrainSplat` call it. proof: `assets.spec.ts`, `world-terrain-splat.spec.ts`, preview tests — 2026-11-10: core and terrain 368/368 files; the splat loader keeps its message and its native-error cause; preview 274/274.
- [ ] Terrain mesh and far collar build, collar walk band, canopy paint, texture preparation. proof: a core spec each, `edge.playtest.json`, judge

## Decisions

- 2026-11-10 (agent, AFK): the per-bucket stream (`streamProps`) and the meadow lifecycle stay in the preview. The record format, residency, admission, LOD and shadows are already core's `WorldCells` and `cellPlacements`; what is left decides which buckets get impostors, the LOD and shadow bands, the swap timing and when a scene may revive, which is game policy.

- 2026-11-10 (agent): four other resolve-then-fetch loops keep their own copy of `fetchAsset`'s walk. `WorldCells`' `loadLogical` also retries the next url when parsing fails, a different contract; `@threenative/metahuman` and `@threenative/procedural-animals` do not depend on core (and the animals loop adds abort and a byte cap); `@threenative/terrain`'s starter peer range (`>=0.3.12 <0.4.0`) admits published cores without `fetchAsset`.

## Acceptance

- [ ] AC-1: No prop, model or collar mechanism in the PRD-863 inventory is left only in the preview, or each one left has a written reason here. proof: the inventory table in this PRD's PR comment
- [ ] AC-2: `engine_search_capabilities` returns each moved export for its situation. proof: `node packages/core/mcp/call.mjs threenative-engine engine_search_capabilities` per situation
- [ ] AC-3: The five worlds look the same or better (fresh judge per visual phase). proof: judge verdicts on the PR
