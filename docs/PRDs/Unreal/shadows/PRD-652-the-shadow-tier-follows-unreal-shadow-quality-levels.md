---
prd_contract: v1
---

# PRD-652 — The shadow tier follows Unreal's shadow quality levels

**Status:** IN PROGRESS
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
   | `high` | 3 Epic | source angle, Epic samples | source radius, Epic samples | −1.5, held at 0 (see `## Decisions`) | 0 / 1 |

   At level 0, `r.ShadowQuality=0` (`BaseScalability.ini:134`) turns dynamic shadows off, so the `low` tier casts none
   (see `## Decisions`). A resolution bias of −1 halves the finest clip level's texel. The sample counts start from
   Unreal's rays × samples product and are then set by the PRD-647 round on `penumbra-lab`. They are
   not fitted by eye. Distance-field shadows enter the table only if PRD-649's `horizon` ablation
   shows them in Unreal's default look.
2. **The filter steps down under GPU pressure (Phase 2).** The GPU time of the shadow passes is read
   from the existing per-pass budget (`packages/core/src/render-pass-budget.ts`) as the `Shadow` stage. Above the tier's
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

- [ ] AC-1 [local]: A PRD-647 round on `penumbra-lab` and `horizon` at each tier, against that tier's Unreal level, returns MATCH or CLOSE on every cell and no REGRESSION against BEFORE. proof: `pnpm unreal-look:calibrate --scene shadow:<name> --tier <low|medium|high> --before <commit>` — Evidence: open, partial 2026-10-21. `penumbra-lab` only, judged by a fresh read-only Sonnet on 4 poses per tier (`sun60-contact`, `sun15-contact`, `sun4-contact`, `sun4-ramp`): `low` IMPROVEMENT (no cast shadow, as Unreal Low), `medium` IMPROVEMENT (soft edges, no acne, no peter-panning), `high` NEUTRAL (byte-identical to the pre-change `L5` in 9 poses, see `## Decisions`). `horizon` is not run, and `calibrate` does not exist yet.
- [x] AC-2 [local]: `engine_search_capabilities` with "shadow quality" returns the tier report entry. proof: `pnpm exec vitest run packages/engine-mcp` (search fixture) — Evidence: `packages/engine-mcp/__tests__/search.spec.ts` 55 passed on 2026-10-21. "shadow quality", "virtual shadow map scalability" and "sg.ShadowQuality" return `ShadowFilterBudget`.

### Visual judge criteria (written 2026-10-21, before any judge ran)

A fresh read-only judge compares `WASM ENGINE BEFORE`, `WASM ENGINE AFTER` and `UNREAL 5.8.3` for the same pose on
`penumbra-lab` (sun at 60, 15 and 4 degrees), per tier. The verdict is IMPROVEMENT, NEUTRAL or REGRESSION against
these criteria, per frame and overall.

- `low` against Unreal `L5-Low`: no cast shadow on any receiver, as Unreal draws at `sg.ShadowQuality` 0. Receivers
  stay lit and nothing else changes. This is an owner-visible deviation from the old look, so it is named on the
  sheet. REGRESSION: any cast shadow, or a change to a surface that is not a shadow.
- `medium` against Unreal `L5-Medium`: cast shadows are present with a soft edge. The edge shows no banding or stair
  step that Unreal Medium does not show, and no acne or peter-panning. REGRESSION: a hard stair-stepped edge, a
  missing shadow, or acne.
- `high` against the pre-change `L5` and Unreal `L5` (Epic): no visible change. NEUTRAL is the pass. The finer
  directional resolution bias (-1.5) must not coarsen any edge.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Shadow tier table | `templates/*/src/render/quality.ts`, read by `lighting.ts` | Replaces the map-size-only tiers | AC-1 |
| Filter cost step | `watchShadowTier` in the harness `render/shadowTier.ts` feeds `ShadowFilterBudget` the `Shadow` stage of `stageGpuReading` (the shadow passes' own GPU time) from `ctx.beforeRender`, held to Unreal's `ShadowDepths` time per tier | New; redraw cost keeps its own levers | Phase 2 |
| `shadowQuality` report | `TN_SHADOW_TIER` marker and the manifest | New read-only field | AC-2 |

## Execution Phases

#### Phase 1: The tier table on the harness
**Status:** PARTIAL
**Files:** `scripts/unreal-look/scaffold/render/quality.ts`, `scripts/unreal-look/scaffold/render/lighting.ts`, `packages/core/src/render/virtual-shadow.ts` (resolution bias option)
- [x] `resolutionLodBiasDirectional` −1 halves the finest level's texel and keeps the clipmap's outer reach. proof: `pnpm exec vitest run packages/core/__tests__/virtual-shadow.spec.ts` — 124 passed on 2026-10-21. A bias of −1 turns clip extents `[8, 32, 128]` into `[4, 32, 128]`, −1.5 gives `8 / 2^1.5`, and a bias that passes the next level throws `TN_VIRTUAL_SHADOW_INVALID`.
- [ ] Each tier is captured on `penumbra-lab` against its Unreal level, and the sample counts that bring the penumbra metric inside the thresholds are recorded. proof: `pnpm unreal-look:calibrate --scene shadow:penumbra-lab --tier <tier>`.

#### Phase 2: The filter steps down under GPU pressure
**Status:** DONE
**Files:** `packages/core/src/render/shadow-filter-budget.ts` (new), `packages/core/src/render/budget-ladder.ts` (new, shared with PRD-644), `packages/core/src/render-pass-budget.ts`, `packages/core/__tests__/shadow-filter-budget.spec.ts` (new), `packages/core/__tests__/owned-engine-stage-reading.spec.ts` (new)
- [x] A filter over budget for a 120-frame window steps its samples down one level, steps up only below 70% of the next level's budget, and leaves an explicit setting alone with a report. proof: `pnpm exec vitest run packages/core/__tests__/shadow-filter-budget.spec.ts packages/core/__tests__/budget-ladder.spec.ts` — 5 and 10 tests passed on 2026-10-21 (step down one tier over the period, up below 70%, explicit keeps the counts and reports, no timestamps holds the tier).
- [x] `ShadowFilterBudget` reads the GPU time of the shadow passes (the `Shadow` stage) against a per-tier budget, and a slow frame its stage did not cause keeps its tier. proof: `pnpm exec vitest run packages/core/__tests__/shadow-filter-budget.spec.ts packages/core/__tests__/owned-engine-stage-reading.spec.ts packages/core/__tests__/render-pass-budget.spec.ts packages/three-native/__tests__/browser-renderer.spec.ts` — red first on 2026-10-22 (2 of 8 failed: a 0.3 ms shadow stage inside a 19.5 ms frame stepped `high` down, and a 2.5 ms stage inside an 8 ms frame did not; the stage specs failed on the missing `Shadow` stage), then all passed (8, 6, 12 and 22 tests). Native: `node packages/runtime-native/tests/native-engine/player-gpu-stages.mjs <tn-native-engine-player-v8>` prints `PASS ... SSGI 0.004 ms, Shadow 0.007 ms of 0.074 ms` on the V8 player (a sibling lane's player build, the JS stage table comes from the bundle). Live, 2026-10-22, `gi-tier-cost.ts --auto` on the owned Wasm engine at P2 clocks (1410 MHz), `gi:cornell`: the shadow report holds 34 and 30 samples, a frame of 9.9 and 7.9 ms, a shadow window of 0 ms (the sun map is cached, so the steady frame draws no shadow pass) and the tier `high` stays. The receiver filter's own cost is not in this stage (see `## Decisions`, 2026-10-22 budget-lane).
- [x] The step runs on the native engine. proof: `pnpm parity --target desktop --only-tests shadow-filter-step` — `run-conformance.mjs --target web` then `--target desktop --reference <web capture>` on 2026-10-21: both pass. A `ShadowFilterBudget` fed 12 frames of 22 ms against a 16.7 ms period steps `high` to `medium` once, the scene rebuilds both lamp filters with 4 + 4 taps, and an explicit setting stays and reports. The desktop frame shows the 4-tap penumbra steps and has pixel mismatch 0 and delta E 0 against the web frame (1280 x 720). The desktop binary was the clean `prd-ocean` build (HEAD d0c2635d5), reused read-only, because this worktree has no native build and the lane changes no C++. `registry.json` row `shadow-filter-step`; `conformance-runner.test.mjs` 84 passed. Rerun 2026-10-22 after the budget reads the `Shadow` stage (the scene feeds 2.4 ms of shadow stage in a 22 ms frame against a 1 ms budget): `--target web` then `--target desktop --reference <web capture>` both `pass` (web 9.5 s, desktop 19.8 s, legacy `mystral` host of the `prd-ocean` build reused read-only).

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
- 2026-10-21 (tier-lane, signal): the receiver filter runs inside the colour pass and three labels no pass for it,
  so its own GPU time cannot be read from the per-pass budget. `ShadowFilterBudget` holds the whole frame's GPU
  time to the frame period instead. A frame that is slow for another reason also steps the filter down, and the
  `@constraint` tag says so. The step rules are the ones of PRD-644 (`budget-ladder.ts`).
- 2026-10-21 (tier-lane, layer): the engine owns when the filter steps. The game owns what each tier samples and
  rebuilds its filter in `onStep`. The tier table is `shadowPreset` in the harness `quality.ts`.
- 2026-10-21 (tier-lane, new Unreal cells): `tools/unreal-reference/shadow/scenes.json` gains the variants
  `L5-Low` (`sg.ShadowQuality` 0) and `L5-Medium` (`sg.ShadowQuality` 1) so each tier has its own Unreal frame.
  Both keep the L5 layer, so GI and AO stay off (`validateShadowRegistry`).
- 2026-10-21 (tier-lane, Low draws no shadow): the Solution said Low is "one hard tap". The Unreal frames say
  otherwise. `sg.ShadowQuality` 0 sets `r.ShadowQuality=0` (`BaseScalability.ini:134`), and the `penumbra-lab` `L5-Low`
  frames hold no cast shadow of the cube at `sun15-contact` and `sun4-contact`. The remaining dark bands are unlit
  faces. The harness `low` tier therefore sets `castShadows: false`. This is owner-visible: a template `low` tier
  will draw no shadows once Phase 3 lands.
- 2026-10-21 (tier-lane, axes): GI and shadow quality are separate Unreal groups, so `?tier=` picks the GI and
  `?shadowTier=` picks the shadows. A GI tier capture keeps the shadows at `high` (see PRD-644 `## Decisions`).
- 2026-10-21 (tier-lane, one filter pair): the sun and every lamp share one filter pair per tier. Unreal's
  directional and local ray counts are equal at Medium (4 x 2) and Epic (8 x 4). The local resolution bias is
  dropped from the table. ThreeNative has no lamp-atlas option to set it on, and PRD-650 Phase 1 has not landed.
- 2026-10-21 (tier-lane, small casters): at Low and Medium Unreal also drops the shadows of small elevated
  casters. The cause is `r.Shadow.RadiusThreshold` (0.06 Low, 0.05 Medium, 0.01 Epic), a screen-radius cull.
  ThreeNative has only the camera-independent `minCasterTexels` gate. A screen-radius cull needs a change in
  `VirtualShadowNode` and in the native `atlas.cpp`. Both belong to the shadows lane, so this lane does not add it.
- 2026-10-21 (tier2-lane, Phase 3 is blocked, no template edit): the shadow tier table drives the receiver filter and `castShadow`
  of the harness sun (`Reference.ts.in`, `shadowTier.ts`). Every template still draws one `PCFSoftShadowMap` sun map
  (`templates/*/src/render/lighting.ts`, 12 lines apart from the harness file) with no virtual shadow node and no filter node. A
  template has no filter taps for the table to set, and a `shadowQuality` report field with no effect would be a false claim in
  its `AGENTS.md`. [PRD-634](../look/PRD-634-sun-shadows-reach-the-horizon-and-soften-with-distance-from-the-caster.md) Phase 1
  (the method) and Phase 3 (all templates take the method and the filter) are NOT STARTED, so this phase starts after them. The
  only effect a table could have today is `low` turning the sun's shadows off, which changes template pictures and needs the
  visual judge.
- 2026-10-22 (tier2-lane, a slow frame costs the shadows): in the exclusive window of 2026-10-22 00:00 PDT (`gi-tier-cost.ts --auto`, RTX 2080 at P8, 420 to 540 MHz, 1920 × 1080), `ShadowFilterBudget` read frames of 19.5 ms (from `high`) and 19.8 ms (from `medium`) against the 16.7 ms period and stepped the shadow tier to `low` in both runs. The shadows were not the cost, because `low` and `medium` GI frames read 20.3 and 20.7 ms with the shadows at `high`. The harness `low` tier draws no shadow, so a frame that is slow for another reason removes every shadow. The earlier note about the whole-frame signal predicted the step, and this run shows what it costs. A fix needs the shadow pass's own time, or a floor of `medium` for the step-down. That choice is open and belongs to the PRD owner.
- 2026-10-21 (tier-lane, no calibrate command): `pnpm unreal-look:calibrate` does not exist in this tree (PRD-647
  owns it). `pnpm unreal-look:compare --metric penumbra` is the substitute for the per-tier rows.
- 2026-10-21 (tier-lane, Unreal's own spread): on `penumbra-lab`, Unreal Medium differs from Unreal Epic by a mean of
  1.00 sRGB levels with 0.52% of pixels past 24 levels. Unreal Low differs by 4.38 with 6.08%. Medium edges are wider
  than Epic edges: the Epic to Medium edge width ratio is 0.44 to 0.94.
- 2026-10-21 (tier-lane, harness watcher): the harness scenes build a `ShadowFilterBudget` and report its newest
  window through `window.__tnRef.shadowBudget()`. The tier is `explicit` unless the URL adds `shadowAuto=1`,
  because a capture must draw the tier it names. `window.__tnRef.setShadowTier(tier)` applies a step from the page.
- 2026-10-21 (tier-lane, high bias held at 0): the first `high` table set `resolutionLodBiasDirectional` to Unreal Epic's
  −1.5. The judge returned REGRESSION against the `high` criterion "no visible change": `sun4-ramp` shows a second
  shadow band, and 3.0% of its pixels differ by more than 8 levels (`sun4-contact` 3.2%, the other 7 poses under 0.5%).
  A capture with `?shadowBias=0` is byte-identical to the pre-change `L5` in all 9 poses (maximum difference 0), so the
  bias is the whole cause. Against Unreal's edge width the bias is mixed: 5 poses move closer, 1 stays, 3 move away.
  No judge has called it an improvement, and the sun look is the shadows lane's, so the table holds 0 and `high` stays
  the pre-change look. The bias stays an option of `VirtualShadowNode` and a `?shadowBias=` diagnosis knob. The shadows
  lane may set −1.5 once a judge finds it an improvement.
- 2026-10-22 (tier-lane, owned engine): `ShadowFilterBudget` was blind on the owned engine for the same reason as
  `GIBudget` (PRD-644 `## Decisions`): `stageGpuReading` read only the timestamp pool of three. It now also returns the
  frame total (`info.render.timestamp`) and the named stage times of the owned engine. The harness holds the frame
  minus the `SSGI` stage to the period, so a slow gather steps the GI method and not the shadow filter.
- 2026-10-22 (budget-lane, the budget reads the stage, not the frame): `ShadowFilterBudget` held the whole frame's GPU time
  to the frame period, so it stepped the tier down for cost that the shadows did not cause (the 19.5 ms frame of
  tier2-lane's entry above). The cause is the signal, in the class and not in the game: `observeRenderer` fed
  `reading.total` to the ladder (`shadow-filter-budget.ts`). The class now reads the GPU time of the stages it names
  (`stages`, default `SHADOW_STAGES` = `["Shadow"]`, as `GIBudget` does with `SSGI`) against a per-tier `budgetMs`, and the
  whole frame only gates a step up (`frameBudgetMs`). `excludeStages` is gone, because nothing needs to be left out of a
  signal that holds only the stage. The shadow passes are one named stage on every engine: the owned engine's shadow
  segment (`tnw_web_frame(19)`, `info.engine.gpuStages.Shadow` in `browser-renderer.ts` and `core-webgpu.mjs`) and three's
  nested `Shadow Map` passes (`render-pass-budget.ts`, `SHADOW_STAGE`). Red first: `shadow-filter-budget.spec.ts` failed 2 of 8
  (a 0.3 ms shadow stage inside a 19.5 ms frame stepped `high` down; a 2.5 ms stage inside an 8 ms frame did not), then 8 passed.
  `render-pass-budget.spec.ts` and `browser-renderer.spec.ts` each failed 1 on the missing `Shadow` stage, then passed.
  Limit: the receiver filter runs inside the colour pass, so its cost is not in the `Shadow` stage. Medium and Epic differ
  only by filter taps in the harness, so a `Shadow` reading over budget steps through both to `low`. A stage reading of the
  filter itself needs its own pass and stays open.
- 2026-10-22 (budget-lane, the tier budgets are Unreal's own): `ProfileGPU` of Unreal 5.8.3 on `penumbra-lab` at 1920 x 1080 on
  the RTX 2080 (`TN_UE_PROFILE_FRAME=40`, `ue-gpu.sh`, variants `L5`, `L5-Low`, `L5-Medium`, 3 runs of 18 cells): Low shows no
  `ShadowDepths` row in any of its 5 scene frames (no shadow pass, `GetShadowQuality() != 0` gates the depth pass,
  `Engine/Source/Runtime/Renderer/Private/ShadowDepthRendering.cpp:2309`). Medium reads 0.453 to 0.553 ms and Epic 0.424 to 0.471 ms
  on steady frames (first-draw frames read 0.86 and 2.20 ms and are left out). The pooled median of the 11 steady frames is
  0.46 ms, so `shadowPreset` carries `budgetMs` 0, 0.46 and 0.46 for `low`, `medium` and `high`.
- 2026-10-22 (budget-lane, Unreal Low draws no sun shadow): the lane brief said Unreal's Low scalability still draws a sun shadow. The
  source and the frames say it does not. `[ShadowQuality@0]` sets `r.ShadowQuality=0` (`Engine/Config/BaseScalability.ini:134`).
  `GetShadowQuality()` (`ShadowRendering.cpp:258`) gates the dynamic shadow setup (`ShadowSetup.cpp:6365`), the light shadow masks
  (`LightRendering.cpp:626`, `:1434`) and the shadow depth mesh pass for virtual shadow maps too (`ShadowDepthRendering.cpp:2309`).
  The `penumbra-lab` `L5-Low` frames (variant `sg.ShadowQuality 0`, `r.Shadow.Virtual.Enable 1`) hold no cast shadow of the cube
  or the bars. The harness `low` tier (`castShadows: false`) already matches Unreal Low, and the tier-lane judge called it IMPROVEMENT
  on 4 poses. No change is made. A `low` tier that keeps a sun shadow would be a ThreeNative choice against Unreal and needs the owner.
