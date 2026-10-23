---
prd_contract: v1
---

# PRD-641 — Bounce light holds still while the camera moves and follows a light that changes

**Status:** IN PROGRESS
**Priority:** P2 — Phase 0 is ticked (the wall grain and the 8-bit contours): no gate measures GI flicker, lag or smear, and the GI gather keeps no history of its own.
**Complexity:** 6 (MEDIUM) — 1–5 files: the gather history, the light revision, specs, one conformance scene (+1), state across frames: history targets and a light revision (+2), velocity reuse from PRD-269 (+0), native proof (+1), a measured tuning loop against Unreal's motion series (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-638](../../done/PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 3 (the motion pipeline and metrics) and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (the calibration round). This PRD authors the `neon` motion run. [PRD-640](PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md) (the gather whose history this is; if PRD-640 declines its Phase 2, the history goes on `ssgi`). [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 3 (the lighting-step rule of the radiance cache).

## Context

- Velocity exists for skinned, instanced and batched meshes ([PRD-269](../../done/PRD-269-motion-vectors-or-the-temporal-filters-lie.md),
  `packages/core/src/render/velocity.ts`). TRAA uses it as generated source in the templates and no
  tier turns it on.
- `ssgi` on the owned engine (`packages/three-native/src/addons/screen-space.ts`) has no history of its
  own. Its noise is hidden only by the spatial `denoise` stage and by TRAA when a game turns TRAA on.
- The world radiance cache changes only when its probes are traced again. The harness cache
  (`giCache.ts`) never changes after the bake. PRD-603 adds a budgeted refresh and a lighting-step
  rule that marks probes stale.
- No gate reads a moving camera or a switched light. PRD-638 Phase 3 adds the motion pipeline.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Two histories.** The screen probe gather accumulates probe radiance over frames, and a second
  temporal filter runs on the per-pixel result (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenScreenProbeFiltering.cpp`,
  `Engine/Shaders/Private/Lumen/LumenScreenProbeGatherTemporal.usf`).
- **Bounded and rejected.** The pixel history accumulates at most 10 frames. It is rejected when the
  reprojected depth differs by more than a relative distance of 0.01 (0.03 for foliage), and it is
  clamped to the neighbourhood (`r.Lumen.ScreenProbeGather.Temporal.*`, same files).
- **Disocclusion.** Probe history for newly visible areas is limited by a disocclusion fraction of
  0.4 over 4 frames.
- **A moving light shortens the history.** A fast-update mode cuts the accumulated frames where
  the lighting moves (`LightIsMoving`). Lumen's own visualize modes 22 and 23 show the fast-update
  amount and the frames accumulated (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/LumenVisualizationData.cpp`).
- **World data moves slower.** The radiance cache refreshes a budget of probes per frame and the
  surface cache radiosity accumulates over 4 frames (UE 5.8.3:
  `Engine/Source/Runtime/Renderer/Private/Lumen/LumenRadiosity.cpp`). A post-process setting,
  `LumenFinalGatherLightingUpdateSpeed`, scales the probe budget.
- **The irradiance field path has no screen history** (Medium; UE 5.8.3: `Engine/Config/BaseScalability.ini`,
  comment at `[GlobalIlluminationQuality@1]`). Its stability comes from the world-space cache.

## Solution

1. **Measure first (Phase 1).** Run every registered PRD-638 motion run (`pan`, this PRD's `neon`, and `door` and `occluder` from PRD-VQ-09 when they exist) on the current chain and on Unreal
   Epic and Medium. Record flicker, response and overshoot per region. These numbers are the targets.
   No threshold is chosen before Unreal is measured.
2. **Gather history (Phase 2).** The gather (Screen Probe Gather, or `ssgi` if PRD-640 declines)
   keeps one history target. Each frame reprojects it with the PRD-269 velocity, rejects it where
   the relative depth difference exceeds 0.01 (0.03 on foliage), clamps it to the neighbourhood of
   the current frame and blends with at most 10 accumulated frames. A newly visible pixel starts at
   frame 1 and leans on the spatial filter. Unreal's values are the start values. Phase 2 may change
   them only against the Phase 1 targets, and records each change under `## Decisions`.
3. **Fast update on a light change (Phase 3).** Each GI light (sun, sky, local lights, emissive
   material) carries a revision. A change in position, direction, colour or intensity bumps it. The
   gather caps its history at a fast-update frame count (start value 2) for the pixels whose
   cached radiance changed by more than the noise floor, and the radiance cache moves the probes
   around the changed light to the front of the PRD-603 queue. `finalGatherLightingUpdateSpeed`
   scales both budgets, with Unreal's name and meaning.

**Where each part lives.** History, rejection and the revision are mechanism beside the gather in
`packages/core/src/render/`. The update-speed values are look decisions in the template's
`src/render/`. `TN_GI_TEMPORAL` reports frames accumulated (median and p5), the rejected share and
the fast-update share, the counterparts of Unreal visualize modes 22 and 23. The `GIVisualize`
modes of PRD-646 gain `framesAccumulated` and `fastUpdateAmount`.

## Acceptance Criteria

- [ ] AC-1 [local]: On the still-camera part of every motion run, GI flicker on the owned engine is at or below Unreal Epic's flicker in every region. proof: `pnpm unreal-look:compare --scene gi --metric motion` — Evidence: pending.
- [ ] AC-2 [local]: After the neon switch, the response on the lit wall takes no more frames than Unreal Epic's response, and overshoot stays within the noise floor. proof: the same command, `neon` run — Evidence 2026-10-21 (partly met, cornell `switch` run, the `neon` run is not authored yet): the world cache follows the lamp. Floor, Wall_Red, Wall_Green, Box_Tall and Box_Short reach 90% of the change in 0 frames (Unreal 32 to 46), against "never" with a fixed bake (55 to 90% of the old light left at frame 179). Ceiling, Back and Shade read "never" because the owned engine ends fully black and Unreal's frame 179 is still fading (residual 24%, 12%, 93%). The step is one frame, not a fade.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `gi-history-rejection` passes on the desktop lane: a disoccluded region holds no stale light after 4 frames. proof: `pnpm parity --target desktop --only-tests gi-history-rejection` — Evidence: pending.
- [ ] AC-4 [local]: On the walls and ceilings of the `sunlit-room` poses, the soft-blotch share of the owned engine at L7 and L9 is at most 1.2 times Unreal's in every region. proof: `pnpm unreal-look:compare --scene gi:sunlit-room --layer L7,L9 --metric blotch` — Evidence 2026-10-21 (not met): on the frames captured before the epic merge (Phase 4), 10 of 22 regions pass at L9 (median ratio 1.31, worst 1.95) and 9 of 22 pass at L7 (median 1.37, worst 9.39).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Gather history | The gather in `worldEnvironment.ts`, every frame | New. TRAA stays a separate, optional stage | AC-1 |
| Light revision and fast update | Every GI light the game adds | New. Feeds the PRD-603 stale queue | AC-2 |

## Execution Phases

#### Phase 0: The sunlit-room walls lose their grain and their 8-bit contours
**Status:** DONE
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/scaffold/render/tonemap.ts`, `scripts/unreal-look/capture-gi-threenative.ts`, `scripts/unreal-look/capture.ts`
- [x] The `ssgi` stage denoises its gather with `RENDER_CHAIN_TIERS[tier].denoiseIterations` passes (3 at `high`). It ran one pass whatever the tier said. It no longer denoises the owned engine's constant occlusion. proof: `pnpm unreal-look:capture --engine threenative --scene gi:sunlit-room --layers L7,L9 --reuse`, then the wall grain share (mean absolute difference from a 9x9 box, as a share of the wall level) of the `sun60-window` pose — Result 2026-10-21: L7 left, right and back wall 0.023, 0.061 and 0.042 before and 0.0069, 0.0099 and 0.0093 after (Unreal L7-Epic 0.0108, 0.0104 and 0.0128). L9 0.010, 0.021 and 0.016 before and 0.0043, 0.0047 and 0.0048 after (Unreal L9-Epic 0.0054, 0.0052 and 0.0052). Mean wall luminance changes by less than 1.1%. Two runs per arm: L7 identical, L9 within 13 levels at a few pixels. A fresh read-only judge (criteria written first) returns IMPROVEMENT overall: L7 and L9 `sun60-window` IMPROVEMENT, L7 `sun15-door` IMPROVEMENT, L9 `sun15-door` NEUTRAL leaning IMPROVEMENT. Frames are on PR #541. Still open: blotches 10 to 40 px wide stay about 2 to 4 times Unreal's (coarse share 0.012, 0.017 and 0.046 against 0.006, 0.005 and 0.023 at L7). Phase 2 is the lever for those.
- [x] The GPU time of the extra passes is measured at L9 and recorded here. proof: `pnpm unreal-look:capture --engine threenative --scene gi:sunlit-room --layers L9 --reuse --measure 6` with `TN_GI_URL_EXTRA='&dn=1'` and without, read from the `TN_FRAME_BUDGET` windows, exclusive GPU slot — Result 2026-10-21: six poses, 6 s each, arms in the order 3 passes, 1 pass, 2 passes, 2 passes, 1 pass, 3 passes, so a drift in the GPU clock cancels. The median GPU frame is 10.6 ms. Three passes cost 0.39 ms more than one (standard error 0.38 ms), so one pass costs about 0.20 ms (0.19 ms error). The old code ran one GI pass and one occlusion pass, so the change adds one pass. The mean of the window means gives 1.23 ms (0.92 ms error) for the same pair, because single frames spike. The median GPU frame fell 1.7 ms between the two halves of the run (11.5 ms, then 9.8 ms), so this instrument cannot resolve a cost below about 0.4 ms.
- [x] The final output carries Unreal's 8-bit dither. It is one step of triangular grain, added to the display colour inside the tone-mapping node. `dither: 1` in `FILMIC_CURVE` sets it and 0 turns it off. Unreal 5.8.3 dithers every 8-bit output (`Engine/Shaders/Private/PostProcessTonemap.usf`, and `BackbufferQuantizationDithering` in `Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessTonemap.cpp`). It was missing. The very dim L6 walls (levels 0 to 13 of 255) showed their 8-bit steps as hard blobs and rings. proof: `pnpm unreal-look:capture --engine threenative --scene gi:sunlit-room --layers L6,L7,L9 --reuse` before and after, then the mean length of runs of identical pixels along the rows of each dark surface, pose `sun60-window` — Result 2026-10-21: L6 right wall, left wall, back wall and floor glow 10.5, 12.6, 210 and 10.1 px before, and 1.45, 1.45, 1.60 and 1.46 px after (Unreal `L7-Low` 1.43, 1.30, 1.34 and 1.41). Pose `sun15-door`: 33.0, 32.1, 9.0 and 3.9 px before, and 1.53, 1.44, 1.35 and 1.36 px after. Runs of 12 px or more fall from 26%, 33%, 100% and 13% of all runs to 0%, 0%, 0.1% and 0%. The grain changes 59% of the pixels by one level. That is 32% of the channel values, and theory gives 33% for this dither. The mean level holds (it moves by 0.005 levels or less at L7). Two runs match bit for bit at L6 and L7. At L7 and L9 the grain is invisible at x1. L9 `sun15-door` reads 1.7 levels darker after (mean 168.4 and 170.2, against 170.7 and 171.3 before). The two runs of one arm differ by up to 1.8 levels at that pose, and L7 at the same pose moves by 0.002. That shift is the pose's own GI noise. A fresh read-only judge (criteria written first) returns IMPROVEMENT: L6 `sun60-window` and `sun15-door` IMPROVEMENT, L7 and L9 NEUTRAL. Frames are on PR #541. Not run: the stock three.js renderer (`engine: "threejs"`). Only the owned engine ran. The grain stays on its pixel, and Unreal moves it every frame. Finding for the engine: a first version hashed `screenUV` and gave exactly zero grain on the owned engine. `Renderer::outputPass` (`packages/runtime-native/src/engine/renderer/renderer.cpp`) fills the output block from `postUniforms_`, and that map holds no `screenSize`. A custom tone-mapping node then reads `screenUV` as the position over zero. This cause comes from reading the code. No run has proven it. The hash reads `screenCoordinate` instead.
**Verification:** the fresh judge rounds above.

#### Phase 1: The motion targets
**Status:** NOT STARTED
**Files:** `tools/unreal-reference/gi/neon-corridor/scene.py` (the `neon` run; the scene comes from PRD-639 or is created here), `tools/unreal-reference/gi/scenes.json`
- [ ] The `neon` run renders 180 frames in both engines with matching frame counts. proof: `pnpm unreal-look:capture --engine unreal --scene gi:neon-corridor --motion neon` and `pnpm unreal-look:compare --scene gi:neon-corridor --metric motion`.
- [ ] Flicker, response and overshoot per region for Unreal Epic, Unreal Medium and the current owned-engine chain are recorded under `## Decisions`. proof: `pnpm unreal-look:compare --scene gi --metric motion`.

#### Phase 2: The gather keeps a history
**Status:** NOT STARTED
**Files:** `packages/core/src/render/gi-history.ts` (new), `packages/core/src/render/screen-probe-gather.ts`, `packages/core/__tests__/gi-history.spec.ts` (new)
- [ ] A history sample whose reprojected depth differs by more than 0.01 relative is rejected, and accumulation stops at 10 frames. proof: `pnpm exec vitest run packages/core/__tests__/gi-history.spec.ts`.
- [ ] The pan run on the owned engine meets AC-1 for flicker without a smear above the overshoot limit. proof: `pnpm unreal-look:compare --scene gi --metric motion`, `pan` run.
**Verification:** a PRD-647 round on the `pan` and `neon` runs (frames 0, 60, 90, 120 and 179) at `high`, Unreal Epic as the target, must return IMPROVEMENT against the current chain.

#### Phase 3: A changed light updates fast
**Status:** NOT STARTED
**Files:** `packages/core/src/render/gi-history.ts`, `packages/core/src/render/probe-volume.ts`, `packages/core/__tests__/gi-history.spec.ts`, `packages/runtime-native/conformance/scenes/shared/gi-history-rejection.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A light revision bump caps the history of the affected pixels at the fast-update count, and the probes in that light's range move to the front of the queue. proof: `pnpm exec vitest run packages/core/__tests__/gi-history.spec.ts`.
**Verification:** AC-2 and AC-3.

#### Phase 4: A band-pass metric reads the soft blotches on the walls
**Status:** DONE
**Files:** `scripts/unreal-look/blotch.ts` (new), `scripts/unreal-look/gi.ts`, `scripts/__tests__/unreal-look-blotch.spec.ts` (new)
- [x] `--metric blotch` measures the soft blotches of each wall and ceiling against Unreal's. The Phase 0 grain share cannot see them: a pixel against its 9x9 box follows a cloud 10 to 40 px across. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-blotch.spec.ts` and `pnpm unreal-look:compare --scene gi:sunlit-room --layer L7,L9 --metric blotch` — Result 2026-10-21: the metric works on the display luma of the pixels of one region of the Unreal ID frame, in both arms. It cuts the region's border (28 px) and removes a least-squares plane. It then takes the standard deviation of two bands as a share of the mean luma. Grain is the luma minus its blur at sigma 1.5. Blotch is the blur at sigma 3 minus the blur at sigma 14. A region passes when its blotch is at most 1.2 times Unreal's (`BLOTCH_LIMIT`). The ratio floors each share at 0.2%, so a flat Unreal frame keeps it finite. `--regions a,b` picks regions. The default is the walls and the ceiling (`isFlatRegion`), where bounce light shows. The spec has 11 cases. Red first: the old 9x9 grain measure reads soft clouds of 2 levels as under 0.6%, against 2% for white noise of the same size. The new blotch band reads the clouds at more than 2.5 times the old value. A smooth 8-bit wall in the shape of the real `sun60-window` right wall passes against itself and keeps passing with 0.2 levels of cloud. It fails with 1.5 levels. Measured on the sunlit-room frames before the epic merge (22 wall and ceiling regions, six poses): at L9 the median ratio is 1.31 (1.45 before Phase 0). 10 regions pass and the worst ratio is 1.95. The median blotch share is 0.34% against Unreal's 0.31%. At L7 the median is 1.37 (1.52 before Phase 0). 9 regions pass and the worst ratio is 9.39 (`sun60-door` left wall, 2.93% against 0.31%). The median grain share at L9 is 0.18% against Unreal's 0.24% (0.42% before Phase 0). So the grain is gone and the soft blotches remain: this is the gather lane's number (AC-4).
**Verification:** AC-4.

#### Phase 5: The world cache follows a light that changes
**Status:** DONE
**Files:** `scripts/unreal-look/scaffold/render/giCache.ts`, `scripts/unreal-look/scaffold/CalibrationScene.ts.in`, `scripts/__tests__/unreal-look-gi-cache.spec.ts`
- [x] A light that has a `source` and changes intensity or colour after the bake changes the bounce light on the next frame, with no new trace. The field is linear in each light, so the cache solves one field per light from the rays it kept, on the first change, and blends them into the texture. proof: `pnpm exec vitest run scripts/__tests__/unreal-look-gi-cache.spec.ts -t "after the bake"` and the cornell `switch` run — Result 2026-10-21: spec red first (`refresh` undefined), green after: off leaves under 0.1% of the baked light, 2x reads 2x within 1%, back to 1x reads the bake. Cornell `switch`, two runs per arm, same code with `?giFollow=0` for the fixed arm: 5 of 8 regions at lag 0. Judge (criteria first, `scripts/unreal-look/judge.ts`, 2 runs per arm): overall IMPROVEMENT against the fixed bake, FAR against Unreal (a one-frame blackout, Unreal fades over about 50 frames). The first solve of a light is one gather, smooth and resample over the kept rays (0.3 to 0.5 s in the unit scene, not measured on cornell), and a later change costs a texture blend. Not followed: a moved light, a changed shadow, a changed emissive material.
**Verification:** AC-2.

## Decisions

- 2026-10-23 (team-lead): `lane/motion3` (receiptD) 758cdaaee is not in #541. It goes to the follow-up PR. Reason: it has a receipt (#541 comment 6357251492: cornell IMPROVEMENT and CLOSE, stills and neon NEUTRAL, 0 newly broken locks) but it needs integration evidence on the combined head. Open flag: neon frame 62 sits 6.7 mean levels above the one-frame arm. Next step: merge it on the merged develop with the combined lock board. Rebuild the Wasm pair if C++ changed. Tick AC-2 only when neon shows a fade close to Unreal.
