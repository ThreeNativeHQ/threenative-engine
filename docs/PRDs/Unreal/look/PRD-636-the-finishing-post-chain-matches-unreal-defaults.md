---
prd_contract: v1
---

# PRD-636 — The finishing post chain matches Unreal's defaults

**Status:** NOT STARTED
**Priority:** P2 — no box is ticked: the template bloom, vignette, grade and motion settings were tuned by eye, and three of them run opposite to Unreal's defaults (thresholded bloom, a contrast grade, no motion blur).
**Complexity:** 5 (MEDIUM) — template post source in 13 templates (+2), a local-exposure stage that is new to the chain (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-631](PRD-631-an-unreal-reference-scene-measures-the-default-look.md) Phase 3 (the L9 row) and [PRD-632](PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md): bloom and local exposure act on the exposed scene-linear frame, so they cannot be compared before exposure matches. Anti-aliasing and temporal reconstruction belong to [PRD-539](../performance/PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md).

## Context

Layer L9 is the last rung of the PRD-631 ladder: everything a fresh Unreal project adds after
lighting.

| Stage | ThreeNative starter `high` | Unreal 5.8.3 default | Unreal source |
| --- | --- | --- | --- |
| Bloom | `BloomNode`, strength 0.22, radius 0.6, **threshold 1**: only the sun disk and emissives bloom | Sum of Gaussians, intensity 0.675, **no threshold**: every pixel blooms a little. Six stages: sizes 0.3/1/2/10/30/64 % × size scale 4, tints 0.3465/0.138/0.1176/0.066/0.066/0.061 | `Engine/Source/Runtime/Engine/Private/Scene.cpp:453-470` |
| Vignette | 0.22, `smoothstep(0.55, 1.02, r)` | 0.4, cosine-fourth law | `Scene.cpp:541` |
| Local exposure | none | Bilateral grid, highlight and shadow contrast 0.8 (set by the project generator), detail 1, blurred-luminance blend 0.6 | `Scene.cpp:525-532`; `Engine/Source/Editor/GameProjectGeneration/Private/GameProjectUtils.cpp:155` |
| Motion blur | off | Amount 0.5, at most 5% of screen width, desktop only | `Scene.cpp:646`; `Engine/Source/Editor/HardwareTargeting/Private/HardwareTargetingModule.cpp:250` |
| Grade | 9³ LUT: contrast 1.06, small RGB gains (starter only) | Neutral: every saturation, contrast, gamma and gain is 1; white balance 6500 K | `Scene.cpp:403-451` |
| Grain | 0.0039, animated (starter only) | 0 | `Scene.cpp:552` |
| Chromatic aberration, lens flare, depth of field | off | off (fringe 0; flare off by project feature; focal distance 0) | `Scene.cpp:452,537,606`; `Engine/Source/Runtime/Engine/Private/SceneView.cpp:228` |

Template values: `packages/create-threenative/templates/starter/src/render/quality.ts:104-167`,
`worldEnvironment.ts:897-992`, `grade.ts:112-143`. Platformer, racing and sailing use other values.

## Solution

All of it is look, so all of it lives in template `src/render/`. Core keeps only the chain
plumbing it already owns (`packages/core/src/render/chain.ts`).

1. **Bloom in Unreal's shape.** Six Gaussian stages at Unreal's relative sizes and weights, with no
   threshold, at half resolution. Phase 1 first checks whether three.js `BloomNode` (five mips) can
   reach the L9 cells with tuned weights. A new bloom node is written only if it cannot.
2. **Vignette** at Unreal's strength and falloff.
3. **Local exposure**: a small bilateral-grid stage with highlight and shadow contrast 0.8. It is
   new, so Phase 1 measures its cost first. It stays off at `low`, as Unreal turns it off on
   mobile (`Engine/Config/BaseDeviceProfiles.ini:411`).
4. **Motion blur** on at `high` on desktop, using the velocity buffer from
   [PRD-269](../../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md). It stays off on
   phones.
5. **Grade and grain go neutral** by default. Each template keeps its LUT and grain as a named
   option, so an art direction can turn them back on.

## Acceptance Criteria

- [ ] AC-1 [local]: The starter L9 cells match the Unreal L9 cells within the PRD-631 thresholds in all 12 poses. proof: `pnpm unreal-look:compare --layer L9` — Evidence: pending.
- [ ] AC-2 [local]: A visual judge subagent returns IMPROVEMENT against the current starter, with the Unreal frames as the target. proof: judge verdict on the PRD-631 contact sheet — Evidence: pending.
- [ ] AC-3 [local]: The finished chain holds the `high` frame budget on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Unreal-shaped bloom | `templates/*/src/render/worldEnvironment.ts` bloom stage | Replaces the thresholded `BloomNode` settings | Phase 2 |
| Local exposure | new stage before the tone curve in `worldEnvironment.ts` | New | Phase 2 |
| Motion blur default | `quality.ts` `high` preset on desktop | Turns on an existing opt-in stage | Phase 3 |
| Neutral grade and grain | `quality.ts`, `grade.ts` | The LUT and grain become named options | Phase 3 |

## Execution Phases

#### Phase 1: Measure what the stock nodes can reach
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/bloom-fit.ts` (new)
- [ ] `BloomNode` with fitted weights is scored on the L9 cells against Unreal, and the outcome (keep it or write a six-stage node) is recorded under `## Decisions`. proof: `pnpm unreal-look:compare --layer L9 --stage bloom`.
- [ ] The local-exposure stage cost is measured at 1080p on the RTX 2080 browser lane. proof: `node packages/playtest/dist/runner/cli.js perf`.

#### Phase 2: The starter matches L9
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/starter/src/render/{worldEnvironment,quality,grade}.ts`
- [ ] Bloom, vignette and local exposure are in place, and AC-1 passes. proof: `pnpm unreal-look:compare --layer L9`.

#### Phase 3: Every template, native included
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/`, `packages/runtime-native/conformance/scenes/shared/local-exposure.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] Local exposure and the new bloom render on the desktop native engine within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests local-exposure`.
- [ ] Motion blur is on at desktop `high` and off on phones, and the template gate passes. proof: `pnpm test:templates`.
- [ ] Every template defaults to the neutral grade and no grain, with the LUT kept as an option. proof: `pnpm test:templates`.
- [ ] Every affected template's `AGENTS.md` (and mirror) states the Unreal-shaped bloom, vignette, local exposure, motion blur and neutral grade, with the LUT (`grade.cube`) and grain as the named options, so a new project's agent knows the default and how to override it. proof: `rg -l 'grade.cube' packages/create-threenative/templates/*/AGENTS.md` lists every affected template, and `pnpm sync:agents --check` exits 0.

## Decisions

- 2026-10-19: Chromatic aberration, lens flare and depth of field stay off. Unreal's effective
  defaults are off too.
