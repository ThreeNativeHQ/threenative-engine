# PRD-580 — Strata starter-kit art bar

**Status:** NOT STARTED
**Priority:** P2 — Five starter kits still need a score of at least 4 on every visual rubric row.
**Complexity:** 3 (LOW); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** [PRD-466](../done/PRD-466-strata-terrain-threejs-integration.md), retained terrain and starter-kit contracts
**Parent:** [PRD-466](../done/PRD-466-strata-terrain-threejs-integration.md)

## Context

PRD-466 supplies terrain, editable kits, asset budgets, runtime wiring and
playtests. Its unmet AC-5, K3 and K4 art criteria move here by João's decision
on 2026-10-09. Work proceeds in order: forest, coastal, alpine, desert, tundra.
A fresh judge subagent must score at least 4 on every rubric row for each kit.
Ground, trees_rocks and lighting_depth are required. Water and artifacts also
apply where the kit rubric names them. A nonblank capture is not art acceptance.

## Solution

Keep appearance in the editable starter source under
`packages/terrain/starter/<world>/`. Reuse the existing kit scenes and
`test:kit` captures. Improve forest crown and rock geometry, ground variation,
contact shadows and the authored sky before extending the changes to other kits.
Replace faceted leaf-card crowns with non-faceted crown geometry. Keep asset
credits, runtime behaviour and the cooked budget of at most 25 MiB per kit.

Author the sky and horizon for elevated edge and overview views. Draw coastal
waves and shore foam through the installed ocean mechanism. Give tundra kettles
an ice surface. Preserve the terrain and collision identity and the closed basins.
Each kit's existing runtime proof must still pass after its art changes.

For each art proof, run the named kit command to capture ground, edge, lake and
overview. Give those captures to a fresh judge subagent for absolute scoring
against the parent rubric. Record its scores and before/after views in the PR.
All rows must reach 4. Lowering that threshold needs an owner decision first.

## Acceptance Criteria

- [ ] AC-1 [local, actor: implementing agent]: The authored sky and horizon reach at least 4 on lighting_depth in elevated views of all five kits. proof: `KIT=<world> pnpm --filter strata-terrain-preview test:kit` for forest, coastal, alpine, desert and tundra, plus fresh judge scores on edge and overview captures — Evidence: pending.

## Execution Phases

### Phase 1: Forest art

**Status:** NOT STARTED
**Files:** `packages/terrain/starter/forest/`, shared CC0 starter assets and the existing forest kit scene.
**Implementation:** Replace faceted crowns and improve rock geometry, ground detail, shadows and sky. Keep all appearance editable.

- [ ] F1 [local, actor: implementing agent]: The forest kit reaches at least 4 on every rubric row. proof: `KIT=forest pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

### Phase 2: Coastal and alpine art

**Status:** NOT STARTED
**Files:** `packages/terrain/starter/coastal/`, `packages/terrain/starter/alpine/` and their existing kit scenes.
**Implementation:** Complete visible coastal waves and shore foam. Improve coastal ground and alpine steep-face textures and horizon framing.

- [ ] C1 [local, actor: implementing agent]: Coastal water renders waves and shore foam. proof: `KIT=coastal pnpm --filter strata-terrain-preview test:kit` plus fresh judge water scores of at least 4 on shore captures — Evidence: pending.
- [ ] C2 [local, actor: implementing agent]: The coastal kit reaches at least 4 on every rubric row. proof: `KIT=coastal pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.
- [ ] A1 [local, actor: implementing agent]: The alpine kit reaches at least 4 on every rubric row. proof: `KIT=alpine pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

### Phase 3: Desert and tundra art

**Status:** NOT STARTED
**Files:** `packages/terrain/starter/desert/`, `packages/terrain/starter/tundra/` and their existing kit scenes.
**Implementation:** Remove visible desert tiling and improve its props and horizon. Render ice in the tundra kettle basins and improve shoreline transitions.

- [ ] D1 [local, actor: implementing agent]: The desert kit reaches at least 4 on every rubric row. proof: `KIT=desert pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.
- [ ] T1 [local, actor: implementing agent]: Tundra kettles render as an ice surface. proof: `KIT=tundra pnpm --filter strata-terrain-preview test:kit` plus fresh judge water scores of at least 4 on kettle captures — Evidence: pending.
- [ ] T2 [local, actor: implementing agent]: The tundra kit reaches at least 4 on every rubric row. proof: `KIT=tundra pnpm --filter strata-terrain-preview test:kit` plus fresh judge scores for ground, edge, lake and overview — Evidence: pending.

## Blocked on

- A lower art bar is an alternative to new geometry and an authored sky. João must choose and record any lower threshold; the current bar stays at 4 until that decision.

## Integration Ledger

Integration: unchanged — existing copied kit source, kit scenes and playtest capture paths remain the consumer route. This PRD changes their appearance.

## Decisions

- 2026-10-09 (João, owner; recorded by the implementing agent): Transfer PRD-466's unmet K3, K4 and AC-5 art bar here. The owner said "ok, update label, push forward to 100%" after the plan to move scores below 4 into a follow-up. This grants the transfer; it does not lower the art bar.

## Prior evidence (PRD-466)

The parent retains the complete AC-5, K3 and K4 text under Decisions, including
scores, proofs and tried-and-reverted levers. Eight bounded rounds ran on
2026-10-09 using CC0 Poly Haven fir_tree_01, boulder_01 and Kloofendal HDRI.
Scores below use ground / trees_rocks / lighting_depth:

| Reading | Scores | Disposition |
| --- | --- | --- |
| Before | about 2–3 each | Baseline |
| R2 | 2 / 2 / 3 | Prior round |
| R3 | 3 / 2 / 3 | Prior round |
| R4 | 2 / 2 / 3 | Prior round |
| R5 | 2 / 3 / 3 | Prior round |
| R6 | 3 / 3 / 2 | Prior round |
| R7 | 3 / 3 / 3 | Final committed kit |
| R8 | 3 / 3 / 3 | Neutral; reverted |

The committed forest improved over BEFORE in edge, ground, lake and overview.
It still missed the bar. The judge named faceted leaf-card crowns, flat blown-out
sky in elevated views, stair-stepped shorelines, tiled flat ground and hard dark
shadow slabs. Parameter changes plateaued. Doubled haze, foliage sky light
changes and a tundra frost band were tried and reverted; the parent keeps their
individual scores and reasons. New tree/rock geometry, an authored sky or an
owner-approved lower bar is required.

AC-5 already has measured terrain relief and cooked-budget proofs. K4 already
has kit bake, runtime and playtest proofs for coastal, alpine, desert and tundra.
Those proofs do not establish visual acceptance. Tundra ice and final coastal
waves/shore foam remain here. The later coastal spectral surface scored water 3;
that observation does not prove the wave/foam art bar. The later tundra basin
change scored water 3, with all other rows still below 4.
