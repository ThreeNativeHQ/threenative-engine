# PRD-773 — Virtual shadow pages draw only the instances that touch them

**Status:** PARTIAL — the fix and its native red-green test exist in a lane worktree, with no browser proof yet.
**Priority:** P1 — the virtual shadow map burst holds GPU p95 at 34 ms against a 6.5 ms p50, which breaks "stable" for any game with instanced casters (Phases 2-3).
**Owner:** João · 2026-10-30
**Depends on:** PRD-770 Phase 1 for the paired A/B.

## Why

When the camera moves, a virtual shadow map level refills its pages, up to 256 of them. Each filled page draws the
whole instanced static set of the stress lab:

| Caster | Instances | Triangles each | Total |
| --- | --- | --- | --- |
| Trunks | 4000 | 28 | 112,000 |
| Canopies | 4000 | 18 | 72,000 |
| Rocks | 6000 | 36 | 216,000 |
| **All** | **14,000** | | **about 400k** |

At 256 pages, that is about 100 M shadow triangles in one burst frame (`hunt/HUNT-vsmgap.md`). The numbers:

- GPU p95 was 62 ms before FS11+FS12 and 34 ms after, against a p50 of 6.5 ms.
- `?stress&plainShadow` draws each caster once and holds GPU p95 at 8.4 ms.

Unreal culls every instance against the pages it can touch before it writes a draw command for a page:

- the compute pass, `UE 5.8.3: Engine/Shaders/Private/VirtualShadowMaps/VirtualShadowMapBuildPerPageDrawCommands.usf:155`;
- the per-instance page test, `:309` (`OverlapsAnyValidPage`);
- the shader class, `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapArray.cpp:3765`.

The lane FG1 (`.worktrees/stress-fix-fg1`, uncommitted) ports that rule on the CPU page index:

- It keeps the per-instance bounds and emits one compacted row per page.
- Its native test `virtual_shadow_page_draws_only_its_instances` passes:
  - RED (the develop path, `TN_SHADOW_INSTANCE_CULL=0`): 176 pages draw 180,224 instances.
  - GREEN: 124 pages draw 1,118 instances.
  - Pixels are byte-identical.

## Validation scene

- **Consumer and scene:** the stress lab, `main.html?stress`. VSM on, with the 40 s orbit.
- **Window:** the PRD-770 fair window on the RTX 2080 at 1280x720.
- **Benefit workload:** `?stress` while the camera moves.
- **Inactive control:** `?stress&still`, where the per-page selection bookkeeping must not cost CPU frame time.
- **Pass:**
  - GPU p95 on `?stress` at 16.7 ms or less.
  - CPU frame p50 not worse than develop by more than 3%.
  - Visual judge NEUTRAL on the shadow frames, `?stress&closeup` and `?stress&freezeAt=12`.

### Phase 1 — land the port

- [ ] FG1's change merges onto develop. The render database, VSM atlas, VSM and renderer suites pass. proof: `tn-native-engine-render-database-test`, `-vsm-atlas-test`, `-vsm-test`, `-renderer-test`
- [ ] The subsystem is mapped in `docs/PRDs/Unreal/research/unreal-visuals-and-performance-feature-map.html` (`SYS` and `F` rows). proof: `pnpm unreal:status`, `pnpm check:docs`

### Phase 2 — prove it in the browser

- [ ] Paired A/B against develop: GPU p95 on `?stress` at 16.7 ms or less, and CPU frame p50 within 3% of develop on `?stress&still`. proof: ledger rows from the PRD-770 window
- [ ] Visual judge NEUTRAL or IMPROVEMENT on the shadow frames, 2 runs per arm. proof: judge JSON
- [ ] Each shadow refresh publishes its reason (clipmap pan, invalidation, eviction), dirty pages, instances drawn per page and its GPU time in `TN_FRAME_BUDGET`, so every remaining p95 frame names its cause. proof: a report from one window

### Phase 3 — only if GPU p95 stays above 16.7 ms

- [ ] FG2: encode a level's depth from a fixed per-level band with a pan anchor, Unreal's rule (`HUNT-vsmgap.md` FG2), instead of from the casters in its window. proof: native case plus paired A/B

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: per-page instance culling first. Pass count per page and the fill count alone are closed
  levers (FP2: 259 passes, GPU p95 60.4 against 61.6; `PERFORMANCE-LEARNINGS.md`).
- Related in-flight work:
  - FP3 (numeric caster signatures, `.worktrees/stress-fix-fp3`) has native green.
  - FS11T (`.worktrees/stress-fix-fs11t`) locks the mover-page settle in a test.
