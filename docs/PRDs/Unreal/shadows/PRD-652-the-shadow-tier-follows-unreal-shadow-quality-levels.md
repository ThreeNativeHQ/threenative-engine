---
prd_contract: v1
---

# PRD-652 — The shadow tier follows Unreal's shadow quality levels

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the templates' `low`, `medium` and `high` tiers change only the sun map size, while Unreal's shadow levels change the filter, its sample count and the shadow resolution bias, and nothing compares a ThreeNative tier with its Unreal level.
**Complexity:** 5 (MEDIUM) — 1–5 files: the harness `quality.ts`, the filter options, the native filter (+1), a tier table every template takes (+2), a cost step under GPU pressure (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-649](PRD-649-shadow-calibration-scenes-are-built-in-unreal-and-judged-until-parity.md) Phase 3 (the scenes and the scoreboard). Uses the filter of [PRD-634](../look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md) Phase 2 and the lamp atlas of [PRD-650](PRD-650-a-lamp-shadow-is-as-sharp-as-the-pixels-it-covers-and-softens-with-the-lamp-size.md) Phase 1. Mirrors the GI tier of [PRD-644](../gi/PRD-644-the-gi-tier-follows-unreal-quality-levels-and-the-measured-gpu-time.md), with the same tier-to-level map.

## Context

**ThreeNative today:**

- `sourceAngleShadowFilter` takes `blockerSamples` and `filterSamples`, 16 each by default
  (`packages/core/src/render/soft-shadow.ts:45-52`). No tier sets them.
- `VirtualShadowNode` already steps its redraw cost under measured GPU time: `adaptiveRefresh`
  widens the refresh trail and `adaptiveCasterGate` raises the caster gate up to 8×
  (`packages/core/src/render/virtual-shadow.ts:130-170`). [PRD-549](../../performance/PRD-549-the-engine-holds-60-fps-on-a-weak-gpu.md)
  Phase 3 halves a level whose redraw overruns. Nothing steps the receiver filter's cost.
- The template tiers live in generated source (`templates/*/src/render/quality.ts`), because a tier
  decides how the game looks.

**Unreal 5.8.3** (`Engine/Config/BaseScalability.ini`, `[ShadowQuality@0..3]`, read 2026-10-20):

| Unreal level | SMRT sun rays × samples | SMRT lamp rays × samples | Directional resolution bias | Lamp bias (still / moving) | Page pool | Distance-field shadows |
| --- | --- | --- | --- | --- | --- | --- |
| 0 Low (`:132-154`) | 0 (one hard tap) × 2 | 0 × 2 | 0 | 1 / 2 | 512 | off |
| 1 Medium (`:167-189`) | 4 × 2 | 4 × 2 | 0 | 1 / 2 | 512 | off |
| 2 High (`:202-227`) | 8 × 4 | 4 × 4 | 0 | 0 / 1 | 2048 | on |
| 3 Epic (`:240-265`) | 8 × 4 | 8 × 4 | −1.5 | 0 / 1 | 4096 | on |

When the page pool passes 85% use, Unreal raises a global resolution bias by up to 2 levels before
anything breaks (`Engine/Source/Runtime/Renderer/Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:156-188`).

## Solution

1. **The tier table (Phase 1).** The harness `quality.ts` gains one shadow field per tier, with
   Unreal's names in camelCase. The tier-to-level map is PRD-644's:

   | ThreeNative tier | Unreal level | Sun filter | Lamp filter | `resolutionLodBiasDirectional` | `resolutionLodBiasLocal` (still / moving) |
   |---|---|---|---|---|---|
   | `low` | 0 Low | one hard tap | one hard tap | 0 | 1 / 2 |
   | `medium` | 1 Medium | source angle, Medium samples | source radius, Medium samples | 0 | 1 / 2 |
   | `high` | 3 Epic | source angle, Epic samples | source radius, Epic samples | −1.5 | 0 / 1 |

   A resolution bias of −1 halves the finest clip level's texel. The sample counts start from
   Unreal's rays × samples product and are then set by the PRD-647 round on `penumbra-lab`. They are
   not fitted by eye. Distance-field shadows enter the table only if PRD-649's `horizon` ablation
   shows them in Unreal's default look.
2. **The filter steps down under GPU pressure (Phase 2).** The receiver filter's GPU time is read
   from the existing per-pass budget (`packages/core/src/render-pass-budget.ts`). Above the tier's
   budget over a 120-frame window, the sample count steps down one level. It steps back up only below
   70% of the next level's budget. Redraw cost keeps its existing levers (`adaptiveRefresh`,
   PRD-549). A game that sets the sample counts explicitly keeps them, and the report says so.
3. **Templates last (Phase 3).** After parity at a tier, every template takes the tuned table, as
   in PRD-644.

**Names and manifest.** `shadowQuality` mirrors `sg.ShadowQuality` as a read-only report field.
`resolutionLodBiasDirectional` and `resolutionLodBiasLocal` mirror the virtual-shadow cvars. The
manifest entry carries `@alias shadow quality`, `@alias virtual shadow map scalability` and
`@alias sg.ShadowQuality`.

## Acceptance Criteria

- [ ] AC-1 [local]: A PRD-647 round on `penumbra-lab` and `horizon` at each tier, against that tier's Unreal level, returns MATCH or CLOSE on every cell and no REGRESSION against BEFORE. proof: `pnpm unreal-look:calibrate --scene shadow:<name> --tier <low|medium|high> --before <commit>` — Evidence: pending.
- [ ] AC-2 [local]: `engine_search_capabilities` with "shadow quality" returns the tier report entry. proof: `pnpm exec vitest run packages/engine-mcp` (search fixture) — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Shadow tier table | `templates/*/src/render/quality.ts`, read by `lighting.ts` | Replaces the map-size-only tiers | AC-1 |
| Filter cost step | The per-pass budget's shadow-filter reading | New; redraw cost keeps its own levers | Phase 2 |
| `shadowQuality` report | `TN_SHADOW_TIER` marker and the manifest | New read-only field | AC-2 |

## Execution Phases

#### Phase 1: The tier table on the harness
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/quality.ts`, `scripts/unreal-look/scaffold/render/lighting.ts`, `packages/core/src/render/virtual-shadow.ts` (resolution bias option)
- [ ] `resolutionLodBiasDirectional` −1 halves the finest level's texel and keeps the clipmap's outer reach. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts`.
- [ ] Each tier is captured on `penumbra-lab` against its Unreal level, and the sample counts that bring the penumbra metric inside the thresholds are recorded. proof: `pnpm unreal-look:calibrate --scene shadow:penumbra-lab --tier <tier>`.

#### Phase 2: The filter steps down under GPU pressure
**Status:** NOT STARTED
**Files:** `packages/core/src/render/soft-shadow.ts`, `packages/core/src/render-pass-budget.ts`, `packages/core/__tests__/soft-shadow.spec.ts`
- [ ] A filter over budget for a 120-frame window steps its samples down one level, steps up only below 70% of the next level's budget, and leaves an explicit setting alone with a report. proof: `pnpm exec vitest run packages/core/__tests__/soft-shadow.spec.ts`.
- [ ] The step runs on the native engine. proof: `pnpm parity --target desktop --only-tests shadow-filter-step`.

#### Phase 3: Every template
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/quality.ts`, `packages/create-threenative/templates/*/AGENTS.md` (and mirrors)
- [ ] Every template takes the tuned table, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Each template's `AGENTS.md` names the shadow tier and its override. proof: `rg -l 'shadowQuality' packages/create-threenative/templates/*/AGENTS.md` lists every template, and `pnpm sync:agents --check` exits 0.
**Verification:** AC-1 and AC-2.

## Decisions

- 2026-10-20 (slicing): this PRD owns the shadow tier table. The PRD-634 Phase 3 box for the `low`
  tier follows it.
- 2026-10-20 (slicing): Unreal's `high` tier is Epic, as in PRD-644, because a fresh Unreal project
  runs Epic.
