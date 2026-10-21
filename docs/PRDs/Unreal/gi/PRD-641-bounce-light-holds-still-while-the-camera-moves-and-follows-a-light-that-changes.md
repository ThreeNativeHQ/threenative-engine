---
prd_contract: v1
---

# PRD-641 — Bounce light holds still while the camera moves and follows a light that changes

**Status:** IN PROGRESS
**Priority:** P2 — one box is ticked (Phase 0, the spatial denoise): no gate measures GI flicker, lag or smear, and the GI gather keeps no history of its own.
**Complexity:** 6 (MEDIUM) — 1–5 files: the gather history, the light revision, specs, one conformance scene (+1), state across frames: history targets and a light revision (+2), velocity reuse from PRD-269 (+0), native proof (+1), a measured tuning loop against Unreal's motion series (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-638](PRD-638-calibration-scenes-are-built-in-unreal-and-captured-as-the-gi-target.md) Phase 3 (the motion pipeline and metrics) and [PRD-647](../../done/PRD-647-a-visual-judge-calibrates-gi-against-the-unreal-scenes-until-parity.md) (the calibration round). This PRD authors the `neon` motion run. [PRD-640](PRD-640-pixels-gather-bounce-light-from-screen-probes-and-the-radiance-cache-answers-the-rest.md) (the gather whose history this is; if PRD-640 declines its Phase 2, the history goes on `ssgi`). [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 3 (the lighting-step rule of the radiance cache).

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
- [ ] AC-2 [local]: After the neon switch, the response on the lit wall takes no more frames than Unreal Epic's response, and overshoot stays within the noise floor. proof: the same command, `neon` run — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host]: The conformance row `gi-history-rejection` passes on the desktop lane: a disoccluded region holds no stale light after 4 frames. proof: `pnpm parity --target desktop --only-tests gi-history-rejection` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Gather history | The gather in `worldEnvironment.ts`, every frame | New. TRAA stays a separate, optional stage | AC-1 |
| Light revision and fast update | Every GI light the game adds | New. Feeds the PRD-603 stale queue | AC-2 |

## Execution Phases

#### Phase 0: The gather's spatial denoise runs the passes its tier declares
**Status:** IN PROGRESS
**Files:** `scripts/unreal-look/scaffold/render/worldEnvironment.ts`, `scripts/unreal-look/capture-gi-threenative.ts`, `scripts/unreal-look/capture.ts`
- [x] The `ssgi` stage denoises its gather with `RENDER_CHAIN_TIERS[tier].denoiseIterations` passes (3 at `high`). It ran one pass whatever the tier said. It no longer denoises the owned engine's constant occlusion. proof: `pnpm unreal-look:capture --engine threenative --scene gi:sunlit-room --layers L7,L9 --reuse`, then the wall grain share (mean absolute difference from a 9x9 box, as a share of the wall level) of the `sun60-window` pose — Result 2026-10-21: L7 left, right and back wall 0.023, 0.061 and 0.042 before and 0.0069, 0.0099 and 0.0093 after (Unreal L7-Epic 0.0108, 0.0104 and 0.0128). L9 0.010, 0.021 and 0.016 before and 0.0043, 0.0047 and 0.0048 after (Unreal L9-Epic 0.0054, 0.0052 and 0.0052). Mean wall luminance changes by less than 1.1%. Two runs per arm: L7 identical, L9 within 13 levels at a few pixels. A fresh read-only judge (criteria written first) returns IMPROVEMENT overall: L7 and L9 `sun60-window` IMPROVEMENT, L7 `sun15-door` IMPROVEMENT, L9 `sun15-door` NEUTRAL leaning IMPROVEMENT. Frames are on PR #541. Still open: blotches 10 to 40 px wide stay about 2 to 4 times Unreal's (coarse share 0.012, 0.017 and 0.046 against 0.006, 0.005 and 0.023 at L7). Phase 2 is the lever for those.
- [ ] The GPU time of the extra passes is measured at L9 and recorded here. proof: `pnpm unreal-look:capture --engine threenative --scene gi:sunlit-room --layers L9 --reuse --measure 6` with `TN_GI_URL_EXTRA='&dn=1'` and without, read from the `TN_FRAME_BUDGET` windows, exclusive GPU slot — Evidence: pending.
**Verification:** the fresh judge round above.

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
