# PRD-864: Prop and collar mechanisms leave the Strata preview

**Status:** IN PROGRESS — Phase 1 done 2026-11-10 (PR #635).
**Priority:** P2 — the prop placement, prop streaming, model preparation and collar code live only in the preview, so a game or kit cannot reuse them.
**Complexity:** 7 (HIGH): about 1 900 lines.
**Depends on:** [PRD-863](PRD-863-world-building-mechanisms-leave-the-strata-preview.md) (same rules, same inventory)
**Epic:** [Strata terrain hardening](README.md); rides PR #635.

## Problem

The second half of the PRD-863 inventory (owner, 2026-11-10: "extract all world building abstractions you can"): prop placement and grounding, the baked prop package stream and the meadow lifecycle, model-to-prop preparation, and the terrain mesh, far collar, walk band, canopy paint, texture preparation and baked file fetch. The rules are PRD-863's.

## Execution Phases

### Phase 1 — placement

- [x] Placement pose: core `staticLowestY`, `footprintGap` and `baseRingGap` (`@threenative/core/world`); the preview's `preparePose` calls them, and the per-asset burial shares stay game choices. proof: `world-static-pose.spec.ts`, `collide.playtest.json` — 2026-11-10: core 3/3 (lowest point equals a full vertex scan on three tilted poses); old and new `preparePose` gave bit-identical matrices and clearances on over 100 asset, pose and ground cases; preview 274/274; `collide` (load 13) passes `propColliders`, `propOverlapFrames`, `grounded` and `movement`, and exits 1 only on the known spawn-view `TN_SCENE_WARNING` (window 15, `renderMs` 42.7) that PRD-790 tracks.

### Phase 2 — prop streaming and models

- [ ] Baked prop package decode and per-bucket stream; meadow lifecycle. proof: `reveal.playtest.json`, `lod.playtest.json`, judge
- [ ] Model to prop parts (sections, whole-model base and scale, normal repair). proof: a core spec, judge

### Phase 3 — collar, walk band and loading

- [ ] Terrain mesh and far collar build, collar walk band, canopy paint, texture preparation, baked file fetch. proof: a core spec each, `edge.playtest.json`, judge

## Acceptance

- [ ] AC-1: No prop, model or collar mechanism in the PRD-863 inventory is left only in the preview, or each one left has a written reason here. proof: the inventory table in this PRD's PR comment
- [ ] AC-2: `engine_search_capabilities` returns each moved export for its situation. proof: `node packages/core/mcp/call.mjs threenative-engine engine_search_capabilities` per situation
- [ ] AC-3: The five worlds look the same or better (fresh judge per visual phase). proof: judge verdicts on the PR
