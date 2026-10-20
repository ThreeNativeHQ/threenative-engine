---
prd_contract: v1
---

# PRD-644 — The GI tier follows Unreal's quality levels and the measured GPU time

**Status:** NOT STARTED
**Priority:** P1 — no box is ticked: no tier says which GI algorithm it runs, so the default-on contract of PRD-631 (a budget that holds on `high`, a `low` fallback that still draws) cannot be met for GI.
**Complexity:** 6 (MEDIUM) — 1–5 files: the harness `quality.ts`, a GI budget watcher in `packages/core`, specs, one conformance scene (+1), state across frames: a measured window and a hysteresis (+2), runs on three platforms (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-638](PRD-638-a-gi-reference-scene-shows-every-lumen-behaviour-still-and-in-motion.md) Phase 1 (cells at Unreal GI quality Low, Medium and Epic). The algorithms of each tier come from [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md), [PRD-604](../rendering/PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md), [PRD-605](../rendering/PRD-605-the-probe-field-follows-the-camera-in-nested-rings.md) and [PRD-640](PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md). The templates take the tier table through [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md), last.

## Context

- Each template's `src/render/quality.ts` picks `low`, `medium` or `high` from `ctx.renderer.gpuClass`
  (`packages/create-threenative/templates/starter/src/render/quality.ts:42-60`): software and mobile-low
  or mobile-mid start at `low`, mobile-high and integrated at `medium`, discrete at `high`. An
  explicit `tier` wins.
- No tier names a GI algorithm. SSGI is off in every template. GTAO is on at `high` and `medium`.
  The harness overlay (`scripts/unreal-look/scaffold/render/quality.ts`) turns GI on by layer, not
  by tier.
- `FrameBudget` (`packages/core/src/frame-budget.ts:609`) and `ResolutionScaler`
  (`packages/core/src/resolution-scaler.ts:240`) already measure phases and react to them. Nothing
  reacts to the GI cost.
- The pasted plan proposed a renderer option such as `globalIllumination: { quality: "high" }`. The
  charter closes preset systems in packages, and the root `AGENTS.md` puts every look decision in
  generated `src/render/`. The tier table therefore lives in `quality.ts`, and the engine only
  measures and reports.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

| `sg.GlobalIlluminationQuality` | GI algorithm | Key values | Source |
|---|---|---|---|
| 0 Low | None. Sky light × 0.8, no distance field AO | `r.Lumen.DiffuseIndirect.Allow=0`, `r.SkylightIntensityMultiplier=0.8` | `Engine/Config/BaseScalability.ini`, `[GlobalIlluminationQuality@0]` |
| 1 Medium | Irradiance field gather | 4 clipmaps of 64³ from 50 m, 100 probes traced per frame, 16² rays, 6² irradiance, half-res interpolate; Short Range AO 1 slice, no bent normal; surface cache 2048² | `@1`; `Engine/Source/Runtime/Renderer/Private/Lumen/LumenIrradianceFieldGather.cpp` |
| 2 High | Screen probe gather | 32 px probes, radiance cache 16² rays, 100 probes per frame | `@2` |
| 3 Epic (default) | Screen probe gather | 16 px probes, 8 adaptive per tile, radiance cache 32² rays, 150 probes per frame, bent normal | `@3`; `Engine/Source/Runtime/Engine/Private/Scalability.cpp` (default 3) |

- The level changes the algorithm. Medium is "targeted at mid range PC and Switch 2"
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/Lumen.cpp`, `r.Lumen.FinalGatherMethod`).
- The level comes from a hardware benchmark (`PerfIndexThresholds_GlobalIlluminationQuality="GPU 18 42 115"`,
  `BaseScalability.ini`) and from device profiles: Android_Mid and IOS_Mid map to Medium
  (UE 5.8.3: `Engine/Config/BaseDeviceProfiles.ini`).
- Reflections follow their own level: Lumen reflections are off at Reflection quality Low and Medium.

## Solution

1. **The tier table (Phase 1).** The harness `quality.ts` gains one field per tier, with Unreal's
   names in camelCase:

   | ThreeNative tier | Unreal level | `finalGatherMethod` | AO | Reflections |
   |---|---|---|---|---|
   | `low` | 0 Low | `"none"`, sky light × 0.8 | GTAO on indirect (PRD-635) | sky and captures (PRD-VQ-03) |
   | `medium` | 1 Medium | `"irradianceField"` (PRD-603 to PRD-605) | `ShortRangeAO`, 1 slice | sky and captures |
   | `high` | 3 Epic | `"screenProbeGather"` (PRD-640) | `ShortRangeAO`, bent normal | `TracedReflections` (PRD-642) |

   Each tier is compared against its own Unreal level on the GI scene and the reference scene. The
   `high` tier maps to Epic because a fresh project runs Epic, and Epic is the reference every
   other PRD matches.
2. **The measured budget (Phase 2).** A `GIBudget` watcher reads the GPU time of the GI stages
   (timestamp queries where the adapter grants them, else the `render` phase of `FrameBudget`) over a
   120-frame window. The budget of each tier is Unreal's own measured GI time at the matching level
   on the RTX 2080 from PRD-638, so the target is measured, not guessed. When the window stays above
   budget, the watcher steps `finalGatherMethod` down one level. It steps up only after a window
   below 70% of the next level's budget, so the tier does not oscillate. `TN_GI` reports the method,
   the tier, the window time, the budget and the reason for each step. A game that sets
   `finalGatherMethod` explicitly keeps it: the report says the budget is exceeded and nothing
   changes.
3. **Every platform the tiers start on (Phase 3).** The desktop host and the Android emulator run
   the `medium` tier, and the report names the method that ran.

**Names and manifest.** `finalGatherMethod` mirrors `r.Lumen.FinalGatherMethod`, and
`globalIlluminationQuality` mirrors `sg.GlobalIlluminationQuality` as a read-only report field. The
`GIBudget` entry carries `@alias global illumination quality` and `@alias lumen scalability`.

## Acceptance Criteria

- [ ] AC-1 [local]: Each ThreeNative tier matches its own Unreal level within the PRD-631 thresholds on the GI scene at L7: `low` against Low, `medium` against Medium, `high` against Epic. proof: `pnpm unreal-look:compare --scene gi --layer L7 --unreal-level 0|1|3` — Evidence: pending.
- [ ] AC-2 [local]: On the RTX 2080 browser lane at 1920 × 1080, the GI stages of each tier stay inside that tier's budget after 120 warm-up frames. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness, per tier — Evidence: pending.
- [ ] AC-3 [local]: The `medium` tier runs on the Android emulator with `TN_GI.method` `irradianceField` and a non-blank frame, labelled as an emulator result. proof: `node packages/playtest/dist/runner/cli.js <scenario> --target android` — Evidence: pending.

## Blocked on

- A physical Android mid-range device for the `medium` frame cost on hardware — unblocked by João attaching one. The emulator result in AC-3 does not claim device cost.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tier table with `finalGatherMethod` | `quality.ts` in the harness, later the templates via PRD-267 | Replaces layer-based GI switches in the harness overlay | AC-1 |
| `GIBudget` watcher | `ctx.add(new GIBudget(...))` from `worldEnvironment.ts` | New. Reuses `FrameBudget` | AC-2 |

## Execution Phases

#### Phase 1: The tier table matches its Unreal level
**Status:** NOT STARTED
**Files:** `scripts/unreal-look/scaffold/render/quality.ts`, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/compare.ts`
- [ ] The compare tool pairs a ThreeNative tier with its Unreal level and fails closed when the cell of that level is missing. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-compare.spec.ts`.
- [ ] Unreal's GI GPU time at Low, Medium and Epic on the RTX 2080 is recorded under `## Decisions` as the tier budgets. proof: `r.ProfileGPU` logs from `pnpm unreal-look:capture --engine unreal --scene gi`.

#### Phase 2: The measured budget steps the method
**Status:** NOT STARTED
**Files:** `packages/core/src/render/gi-budget.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/gi-budget.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] A window above budget steps the method down once, a window below 70% of the next budget steps it up, and an explicit `finalGatherMethod` never changes. proof: `pnpm exec vitest run packages/core/__tests__/gi-budget.spec.ts`, with an injected clock.
- [ ] A capability search for "global illumination quality" returns `GIBudget`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.

#### Phase 3: Desktop host and emulator
**Status:** NOT STARTED
**Files:** `packages/runtime-native/conformance/scenes/shared/gi-tier-medium.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] The desktop host renders the `medium` tier within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests gi-tier-medium`.
**Verification:** AC-3.
