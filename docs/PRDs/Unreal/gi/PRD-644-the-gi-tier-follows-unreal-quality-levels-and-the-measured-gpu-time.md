---
prd_contract: v1
---

# PRD-644 — The GI tier follows Unreal's quality levels and the measured GPU time

**Status:** IN PROGRESS
**Priority:** P1 — no box is ticked: no tier says which GI algorithm it runs, so the default-on contract of PRD-631 (a budget that holds on `high`, a `low` fallback that still draws) cannot be met for GI.
**Complexity:** 6 (MEDIUM) — 1–5 files: the harness `quality.ts`, a GI budget watcher in `packages/core`, specs, one conformance scene (+1), state across frames: a measured window and a hysteresis (+2), runs on three platforms (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phases 1 and 2 (cells at Unreal GI quality Low, Medium and Epic) and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (parity per tier). The algorithms of each tier come from [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md), [PRD-604](../rendering/PRD-604-a-surface-is-lit-only-by-probes-that-can-see-it.md), [PRD-605](../rendering/PRD-605-the-probe-field-follows-the-camera-in-nested-rings.md) and [PRD-640](PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md). The templates take the tier table through [PRD-267](../../useful-defaults/PRD-267-screen-space-gi-ships-in-the-templates.md), last.

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

   Each tier is compared against its own Unreal level on every registered calibration scene and the PRD-631 scene. The
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

- [ ] AC-1 [local]: Each ThreeNative tier matches its own Unreal level within the PRD-631 thresholds on every registered calibration scene at L7: `low` against Low, `medium` against Medium, `high` against Epic. proof: `pnpm unreal-look:compare --scene gi --layer L7 --unreal-level 0|1|3` — Evidence: open, measured 2026-10-21. `high` is byte-identical to the pre-change `L7` in all 8 poses (maximum difference 0). `medium` removes the screen-space stipple and keeps the pre-change dE (`sunlit-room` 4.77 to 4.60, `cornell` 10.10 to 8.53). `low` lifts `sunlit-room` from a black interior to the Unreal Low look (mean dE 36.60 to 10.54, `cornell` 2.97 to 0.83). `low` stays open for one gap: its ceilings read 0 to 1 where Unreal Low reads 72 to 112 (dE 24 to 38), see `## Decisions`. Re-judged 2026-10-22 on head `2a824a22e`, because the epic changed the `high` gather after the 2026-10-21 round (the byte-identical claim holds only against the older base). The judge command (Sonnet, 2 AFTER runs, 1 BEFORE run: the tier state of 2026-10-21 cannot be captured again, so `--min-runs 1`) returned IMPROVEMENT overall at `low`, `medium` and `high`, and CLOSE to Unreal `L7-Low`, `L7-Medium` and `L7-Epic` on 8 of 8 frames each. The gains come from the epic's merges since then (smoother walls, no corner leak line), not from these commits, which change no pixels. The two AFTER runs differ by at most 0.09 mean levels. The judge saw one run-to-run change: the bright patch on the right wall of `sun60-leak` at `high` is present in run 1 and absent in run 2. The ceiling gap of `low` stays.
- [ ] AC-2 [local]: On the RTX 2080 browser lane at 1920 × 1080, the GI stages of each tier stay inside that tier's budget after 120 warm-up frames. proof: `node packages/playtest/dist/runner/cli.js perf` on the harness, per tier — Evidence: open, measured 2026-10-22 in an exclusive GPU window (RTX 2080, Vulkan, 1920 × 1080, `gi:cornell`, owned Wasm engine, `pnpm tsx scripts/unreal-look/gi-tier-cost.ts`). The owned engine now reports the SSGI pass as its own GPU stage, so the budget sees a reading (see `## Decisions`). `low` holds: it has no GI pass. `medium` has no pass of its own, so its stage reads 0 ms, and its frame difference to `low` (−0.8 ms, sd 6.5 ms over 5 rounds) is smaller than the clock noise. `high` is over its 6 ms budget in every run. The SSGI stage reads 7.42 ms for the per-pixel gather (600 frames, median 6.92, p95 15.08), 6.45 ms for screen probes (`?probes=1`, 16 × 16 rays) and 15.95 ms in the interleaved run. The live budget takes the step: from `high` with `giAuto=1`, window 1 reads 13.66 ms, the method steps to `irradianceField`, and window 2 reads 0.47 ms and holds. The AC stays open because `high` costs more than its budget on this GPU: 6.4 to 16 ms against 3.1 to 5.8 ms for Unreal Epic. Rerun 2026-10-22 00:00 PDT, one exclusive window of 770 s (`gpu-slot.sh --exclusive`, no gpu-prio overlap, RTX 2080, 1920 × 1080, `gi:cornell`, owned Wasm engine, scaffold packed at lane head 39ea18b3a, Wasm pair unchanged): (a) `--interleave --rounds 5 --burst 100`: `none` frame 20.80 ms, `irradianceField` 20.79 ms, `screenProbeGather` 25.46 ms with its SSGI stage at 13.72 ms (median 13.30, p95 16.65). The paired difference to `none` is −0.005 ms (sd 0.53) for `irradianceField` and +4.67 ms (sd 1.33, rounds 3.5 to 7.0) for `screenProbeGather`. (b) `--tiers low,medium,high`: `low` frame 20.32 ms, `medium` 20.73 ms (+0.41 ms, budget 1.5 ms, inside), `high` frame mean 26.63 ms with SSGI 14.29 ms (median 13.07, p95 19.03) and +6.32 ms over `low`, against its 6 ms budget: outside. (c) `--auto` from `high`: window 1 reads 15.77 ms, the method steps to `irradianceField`, window 2 reads 0.42 ms and holds. From `medium` the first window has no GI stage and steps up to `screenProbeGather`; window 2 reads 14.70 ms and steps back down, window 3 reads 0.45 ms and holds. AC-2 stays open: `high` is 13 to 14 ms in its own stage and 4.7 to 6.3 ms over `low` in the frame, against 6 ms, and Unreal Epic reads 3.1 to 5.8 ms. The GPU clock confounds the frame deltas: `low` and `medium` ran at P8 (420 to 540 MHz) and `high` at P5 (1125 MHz), so the real cost of `high` at one clock is larger than its delta. The live `--auto` run also shows the shadow budget stepping `high` to `low` on a frame of 19.5 to 19.8 ms at P8, over the 16.7 ms period for a reason that is not the shadows (see PRD-652 `## Decisions`).
- [ ] AC-3 [local]: The `medium` tier runs on the Android emulator with `TN_GI.method` `irradianceField` and a non-blank frame, labelled as an emulator result. proof: `node packages/playtest/dist/runner/cli.js <scenario> --target android` — Evidence: pending.

### Visual judge criteria (written 2026-10-21, before any judge ran)

A fresh read-only judge compares `WASM ENGINE BEFORE`, `WASM ENGINE AFTER` and `UNREAL 5.8.3` for the same pose, per
tier and per calibration scene (`cornell`, `sunlit-room`). The verdict is IMPROVEMENT, NEUTRAL or REGRESSION against
these criteria, per frame and overall.

- `low` against Unreal `L7-Low`: direct light and shadow only, with no colour bounce from the walls onto the boxes. A
  room that has a sky opening is lit by the sky light, not black. The stipple noise that the stray SSGI added to the
  old `L6` frames is gone. REGRESSION: a black interior where Unreal is lit, a colour bleed that Unreal does not show,
  or visible noise.
- `medium` against Unreal `L7-Medium`: soft, low-frequency bounce light from the cache, with no black patch, no light
  leak through a wall and no screen-space noise. ThreeNative may be brighter in shaded corners, and Unreal's black
  `Box_Short` (an irradiance field artifact) is not required. REGRESSION: a black patch or a leak that BEFORE does
  not show, or a missing bounce.
- `high` against the pre-change `L7` and Unreal `L7-Epic`: no visible change. NEUTRAL is the pass.
- Across tiers: bounce light must rise in the order Unreal's levels do (`low` below `medium`, `medium` at or below `high`).

## Blocked on

- A physical Android mid-range device for the `medium` frame cost on hardware — unblocked by João attaching one. The emulator result in AC-3 does not claim device cost.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Tier table with `finalGatherMethod` | `quality.ts` in the harness, later the templates via PRD-267 | Replaces layer-based GI switches in the harness overlay | AC-1 |
| `GIBudget` watcher | `watchGi` in the harness `render/giTier.ts` calls `ctx.beforeRender(() => gi.observeRenderer(ctx.renderer.raw))` for each scene (`ctx.add` takes only an `Object3D`) | New. Reads the per-pass GPU times that `RenderPassBudget` resolves, or the owned engine's `info.engine.gpuStages` | AC-2 |

## Execution Phases

#### Phase 1: The tier table matches its Unreal level
**Status:** DONE
**Files:** `scripts/unreal-look/scaffold/render/quality.ts`, `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/compare.ts`
- [x] The compare tool pairs a ThreeNative tier with its Unreal level and fails closed when the cell of that level is missing. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-compare.spec.ts` — red first (`unrealVariant` absent, `L7-medium` rejected as `GI layer`), then 32 passed on 2026-10-21. `L7-low`, `L7-medium` and `L7-high` pair with `L7-Low`, `L7-Medium` and `L7-Epic`; `--unreal-level 0|1|3` pairs one capture with another level; a missing Unreal frame throws `TN_UNREAL_LOOK_MISSING_CELL` and names `L7-Medium`.
- [x] Unreal's GI GPU time at Low, Medium and Epic on the RTX 2080 is recorded under `## Decisions` as the tier budgets. proof: `TN_UE_RESOLUTION=1920x1080 TN_UE_PROFILE_FRAME=40 pnpm unreal-look:capture --engine unreal --scene gi:cornell --variants L7-Medium` inside `ue-gpu.sh`, parsed from `Saved/Logs/ThreeNativeReference.log` on 2026-10-21 (exit 0; `r.ProfileGPU` dumps of frames 54, 134, 214). Low has no GI pass, Epic is 3.09, 4.56 and 5.79 ms (PRD-640), and Medium is in `## Decisions` (2026-10-22, tier2-lane, Unreal Medium GI time).

#### Phase 2: The measured budget steps the method
**Status:** DONE
**Files:** `packages/core/src/render/gi-budget.ts` (new), `packages/core/src/index.ts`, `packages/core/__tests__/gi-budget.spec.ts` (new), `packages/engine-mcp/__tests__/search.spec.ts`, `packages/core/src/render-pass-budget.ts`, `packages/core/__tests__/owned-engine-stage-reading.spec.ts` (new), `packages/three-native/src/gpu-stages.ts` (new), `packages/runtime-native/src/engine/renderer/post/effects.cpp`
- [x] A window above budget steps the method down once, a window below 70% of the next budget steps it up, and an explicit `finalGatherMethod` never changes. proof: `pnpm exec vitest run packages/core/__tests__/gi-budget.spec.ts packages/core/__tests__/budget-ladder.spec.ts`, with injected GPU readings — 7 and 10 tests passed on 2026-10-21 (step down once, step up below 70% with room in the frame, no climb on a full frame, growing retry wait after a failed step, explicit keeps the method and reports, no timestamps holds the method).
- [x] A capability search for "global illumination quality" returns `GIBudget`. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts` — 57 passed on 2026-10-22, including "global illumination quality", "lumen scalability" and "sg.GlobalIlluminationQuality". The plain words reach `GIBudget` through its situations, so the alias "global illumination quality" is gone. The aliases "lumen scalability", "sg.GlobalIlluminationQuality" and "final gather method" have recall rows (`request.gi-quality-scalability`), and `pnpm caps:recall` holds.
- [x] The owned engine times the SSGI pass as its own GPU stage, and `GIBudget` and `ShadowFilterBudget` read it. proof: native tests on the RTX 2080 (Vulkan, `timestamp-query`) on 2026-10-21: `gpu_timer_splits_the_gather`, `gpu_timer_covers_offscreen`, `gpu_timer_covers_shadows` and `gpu_timer_is_opt_in` in `tn-native-engine-render-database-test`, `starter_post_bindings` and `tsl_effect_parameter` in `tn-native-engine-abi-test`, and `full_stream` in the frame GPU timer test all pass (an unlabelled gather lands in segment 2 with `segments[4] == 0`, a labelled one in `segments[4] > 0`; the new symbols leave no red-first run for C++). TypeScript: `pnpm exec vitest run packages/core/__tests__/owned-engine-stage-reading.spec.ts` red first (5 failed), then 6 passed; the `screen-space`, `starter-post` and `browser-renderer` specs of `three-native` red first (4 failures), then green. Live, 2026-10-22: `gi-tier-cost.ts --auto` reads the SSGI stage on 600 frames (mean 7.42 ms), and `giAuto=1` steps `high` to `irradianceField` on a 13.66 ms window against the 6 ms budget.
- [x] The native desktop player passes the stage to `GIBudget`. proof: `ctest -R native_engine_player_gpu_stages` on the V8 player (`packages/runtime-native/tests/native-engine/player-gpu-stages.mjs`) red first: `renderer.backend.getTimestampFrames is not a function` on the build of HEAD 23d05fa76, then PASS on 2026-10-21 (RTX 2080, Vulkan, `timestamp-query` yes): a pass labelled `gpuStage: "SSGI"` reads `info.engine.gpuStages.SSGI` 0.003 ms of `info.render.timestamp` 0.044 ms, the sample belongs to frame 117 of 120, and core's `stageGpuReading` returns the same numbers, which is what `GIBudget` and `ShadowFilterBudget` read. Cause: `V8Game::renderInfo` (`v8_main.cpp`) had no GPU times and the player timed no frame unless `TN_PLAYER_GPU_TIMING` was set. Fix: `renderInfo().gpuTiming` carries the newest sample (`enabled`, `samples`, `source`, `ms`, `segments`), `tn.setGpuTimer(on)` starts timing, and `core-webgpu.mjs` turns the first `backend.getTimestampFrames("render")` read into that call, so a game with no budget pays nothing. The sample's frame id is the game's `info.frame` at its last `render()`, as on the Wasm engine. `player_frame_per_present` and `player_host_projection` still pass. This is a player test on the real V8 player, not a playtest scenario; the budgets' step on a desktop game stays unproved until a scenario runs `GIBudget` there. The same ctest run shows `player_temporal_aa` red at the epic head (`requestAnimationFrame is not defined`: it bundles with `host` off), which this change does not touch; the temporal AA lane has the finding.

#### Phase 3: Desktop host and emulator
**Status:** PARTIAL
**Files:** `packages/runtime-native/conformance/scenes/shared/gi-tier-medium.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] The desktop host renders the `medium` tier within tolerance of the browser. proof: `pnpm parity --target desktop --only-tests gi-tier-medium` — `run-conformance.mjs --target web` then `--target desktop --reference <web capture>` on 2026-10-21: both pass. The desktop frame has pixel mismatch 0 and delta E 0 against the web frame (1280 x 720). The scene also runs `GIBudget` on injected readings: `medium` holds with no frame room, steps to `none` above its 1.5 ms budget, and an explicit method stays and reports the exceeded budget. The desktop binary was the clean `prd-ocean` build (HEAD d0c2635d5), reused read-only, because this worktree has no native build and the lane changes no C++. `registry.json` row `gi-tier-medium`; `conformance-runner.test.mjs` 84 passed.
**Verification:** AC-3. A PRD-647 round per tier on every registered calibration scene returns no REGRESSION against BEFORE.

## Decisions

- 2026-10-21 (tier-lane, layer): the engine owns when to step (`packages/core/src/render/gi-budget.ts`, built on the
  shared `budget-ladder.ts`). The game owns what each method draws, so `quality.ts` keeps the tier table and the
  `finalGatherMethod` names. This is the same kind of measured ladder as the `RenderChain` auto tier. `CHARTER.md`
  has no line for it yet. That file is the owner's, so the line stays open.
- 2026-10-22 (tier2-lane, Unreal Medium GI time): `sg.GlobalIlluminationQuality` 1 runs `LumenIrradianceFieldGather` and no screen probe gather (`r.Lumen.FinalGatherMethod` 1). On the RTX 2080 at 1920 x 1080 (`gi:cornell`, `L7-Medium`, three `ProfileGPU` frames that drew the scene) its inclusive time is 0.61, 2.35 and 1.77 ms. Inside it, `UpdateWorldRadianceCaches` takes 0.32, 0.28 and 0.28 ms, `InterpolateIrradianceProbesToPixels` (960 x 540, downsample 2) takes 0.15, 0.51 and 0.40 ms, and the short-range ambient occlusion horizon search takes 0.15, 1.55 and 1.09 ms. The probe update and the interpolation, which are the part ThreeNative's `irradianceField` method replaces, add up to 0.46, 0.79 and 0.68 ms. Short-range AO is a separate pass in ThreeNative (GTAO). So the Medium GI time of Unreal is 0.5 to 0.8 ms without its AO and 0.6 to 2.4 ms with it, against 3.1 to 5.8 ms for Epic: Medium costs about a fifth of Epic. The spread between the frames was not traced: frame 54 comes first in the run and counts 99 draws, and the cause of its lower AO time was not checked.
- 2026-10-21 (tier-lane, window): the window value is the mean GI-stage GPU time of 120 frames, not p95, with at
  least 8 resolved frames. A window with fewer resolved frames is "unobserved" and the method holds.
- 2026-10-21 (tier-lane, hysteresis): the 70% rule alone can flap when two budgets are close, so a step up also needs
  room in the whole frame, and a method that failed is retried after 5, 10, 20 ... windows (at most 160).
- 2026-10-21 (tier-lane, no timestamps): an adapter without timestamp queries holds the method. The Solution text
  "else the `render` phase of `FrameBudget`" is not built: that phase is whole-frame CPU time and cannot name the GI
  share, so a fallback would step on a number that is not the GI cost.
- 2026-10-21 (tier-lane, stage names): `RenderPassBudget` now attributes nested passes to the scene name three gives
  them (`SSGI`, `AO`, ...) and hands out `stageGpuReading(renderer)`. The game lists the pass names that are GI
  work in `stages`.
- 2026-10-21 (tier-lane, wiring): the ledger said `ctx.add(new GIBudget(...))`. `ctx.add` takes only an `Object3D`,
  so the watcher is fed with `ctx.beforeRender`.
- 2026-10-21 (tier-lane, retry): a failed method came back as soon as its wait ended and its budget fitted the
  frame. A gather that measured 31 ms against a 6 ms budget then failed again after every wait. The ladder now keeps
  the cost a method measured in its failed window and asks the frame for that cost, never less than the budget.
  A lighter frame lets the method back in (`budget-ladder.ts`, `427fc5fec`, red first).
- 2026-10-21 (tier-lane, axes): Unreal's GI and shadow levels are separate scalability groups. The `L7-Low`,
  `L7-Medium` and `L7-Epic` frames change only `sg.GlobalIlluminationQuality`, so their shadows stay at Epic. A GI
  tier capture therefore adds `shadowTier=high` (`tierQuery` in `capture-gi-threenative.ts`). PRD-652 owns the
  shadow tiers.
- 2026-10-21 (tier-lane, stray SSGI): calibration scenes enabled SSGI at every layer, because `harnessLayer()` reads
  only `tnRef`. `worldEnvironment.ts` now takes `finalGatherMethod` explicitly and it is `none` below L7. The old
  `L6` BEFORE frames carry that stray SSGI, so a BEFORE of `low` is the pre-change `L6` and says so on the sheet.
- 2026-10-21 (tier-lane, high tier): `high` is pixel-neutral. Its cornell L7 frames match the pre-change L7 frames
  with 0.00 mean difference.
- 2026-10-21 (tier-lane, low tier sky light): Unreal Low turns off distance field AO and sets
  `r.SkylightIntensityMultiplier` to 0.8 (`Engine/Config/BaseScalability.ini`, `[GlobalIlluminationQuality@0]`).
  The tier table now carries both (`distanceFieldAO`, `skylightIntensityMultiplier` in `giPreset`). With AO off the sky
  light reaches an interior unoccluded, so the harness passes `skyShadowDistance: 0` and `skyIntensity: 0.8` to
  `installGi`. Red first: `unreal-look-gi-tier.spec.ts` failed on the missing fields, then 3 passed.
- 2026-10-21 (tier-lane, multiplier A/B): the multiplier is Unreal's own value, so it stays at 0.8. The A/B on
  `sunlit-room` `low` (`?skyMul=1` against 0.8): mean dE 6.74 at 1.0 and 6.92 at 0.8, mean dP50 0.138 and 0.115, over the
  32 regions that exclude ceiling and ground. The sun60 poses favour 1.0 (5.74 against 8.21) and the sun15 poses favour 0.8
  (5.62 against 7.74). No single value fits both, so the Unreal value wins.
- 2026-10-21 (tier-lane, low tier ceiling, open): Unreal Low lights the ceiling of `sunlit-room` (p50 72 to 112) and
  ThreeNative draws it black (0 to 1). The Unreal sky light is `SLS_CAPTURED_SCENE` with real-time capture
  (`tools/unreal-reference/template-actors.json`), so its cube map may hold the lit room and not only the sky. The harness sky
  bake keeps a dark nadir (`bakeSkyRadiance`, `atmosphere.ts`). The sky and GI lanes own how that radiance looks, so
  this lane adds no ceiling term. The gap is named on the sheet.
- 2026-10-21 (tier-lane, BEFORE arms): the `sunlit-room` BEFORE of `medium` and `high` is the pre-change `L7`, captured
  from the base scaffold (`work-base`, 6 poses, `sun60` frames repeat the first base run with mean difference 0.00 to
  0.04). The BEFORE of `low` is the pre-change `L6`, because the old `L7` carried the stray SSGI.
- 2026-10-22 (tier-lane, owned engine was blind): `stageGpuReading` read only the timestamp pool of three. The owned Wasm
  renderer has no such pool, so on the default engine `GIBudget` and `ShadowFilterBudget` saw no readings and held their
  tier for ever (`packages/core/src/render-pass-budget.ts`). A budget step could happen on three only.
- 2026-10-22 (tier-lane, stage label): a post pass carries a numeric GPU stage (`kStageScreenSpaceGi`,
  `shader/graph/post_effects.h`). The game sets it with `node.__effect("stage", id)`, and `abi/tsl_call.cpp` checks the
  id. `PostEffects::render` times a labelled pass into its own segment (`kGpuGiSegment`, 4 of 5), `tnw_web_frame(19..23)`
  exports the segments, and `info.engine.gpuStages` publishes `{ SSGI: ms }`. The engine knows only the id. The game
  names it: `ssgi()` and its denoise label their passes with `gpuStage: "SSGI"` in `three-native`. `stageGpuReading`
  falls back to this reading when the pool of three has none, and a recorder reading wins when both exist.
- 2026-10-22 (tier-lane, SSR): the SSR pass has no label. It is not GI work, and the shadow budget counts it in the frame.
- 2026-10-22 (tier-lane, clock trap): a GPU that idles drops to P5 or P8, and every pass then reads 2 to 5 times dearer.
  The cost script keeps the GPU busy with a draw loop beside the host's own frame. Even so, the same gather-off pose read
  7.3 to 23.9 ms from one 100-frame burst to the next in the exclusive window. A run per tier compares clocks, not
  methods. `--interleave` alternates the methods in one page and reports the paired difference per round. The paired
  difference (+14.9 ms, sd 5.5 ms) agrees with the SSGI stage (15.95 ms) within 1.1 ms, so the stage reading prices
  the gather.
- 2026-10-22 (tier-lane, step cycle): from `medium` the first window reads 0 ms, because the irradiance field has no pass
  of its own, so the ladder steps up. The next window reads 6.12 ms against the 6 ms budget, so the ladder steps back
  down and waits. This is the designed hysteresis (a failed method waits 5, 10, 20 ... windows). It costs one slow window.
- 2026-10-22 (tier-lane, budgets): `GI_BUDGET_MS` keeps `screenProbeGather` at 6 ms, the top of Unreal Epic's 3.09 to
  5.79 ms. `irradianceField` stays at 1.5 ms. Unreal Medium is not profiled, and the cost of this method is invisible
  here, so no number can move a step today. Profiling Medium waits for a free Unreal editor lock and an exclusive GPU window.
- 2026-10-22 (tier-lane, aliases): the aliases "global illumination quality" and "shadow quality" are gone. The recall
  baseline without them already reaches `GIBudget` and `ShadowFilterBudget` through their situations, and the
  predecessor-row test requires an alias to add recall.
- 2026-10-22 (tier-lane, desktop player open): the V8 player's `renderInfo` has no GPU timestamps or stage times, so
  `GIBudget` holds its method there. The web path is the only one claimed.
