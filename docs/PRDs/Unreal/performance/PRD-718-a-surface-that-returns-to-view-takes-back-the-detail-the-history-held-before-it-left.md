---
prd_contract: v1
---

# PRD-718 — A surface that returns to view takes back the detail the history held before it left

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: no number says how long an uncovered surface stays soft in the default temporal resolve, and Unreal turns this feature on at Medium and above through its scalability file.
**Complexity:** 6 (MEDIUM) — a second history layer (+2), 3–5 files (+1), the same rule on the owned engine (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-539](PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md) for the corpus. [PRD-717](PRD-717-a-pixel-a-moving-object-just-uncovered-reprojects-through-the-surface-that-left-it.md) for the reveal test, which decides when a pixel counts as uncovered.

## Context

**Unreal LOC:** about 400, spread over `TSRDecimateHistory.usf` (the second reprojection, about 150 of 543), `TemporalSuperResolution.cpp` (the persistent frames, about 200 of 3,780) and the guide reads in the update pass. **Port estimate:** about 250 lines, a second history layer and one more reprojection.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **The cvar says off, the scalability file says on.** `r.TSR.Resurrection` is 0 and its help calls the
  feature experimental (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/PostProcess/TemporalSuperResolution.cpp:246-264`).
  `Engine/Config/BaseScalability.ini` sets it to 1 at anti-aliasing levels 1, 2 and 3 and to 0 at level 0
  (`:61`, `:72`, `:83`, `:94`). A fresh project runs the Epic level, so the feature is on in the default look.
- **Persistent frames.** The history is one array texture. It holds the last frames plus a number of
  persistent frames, 2 by default, and one persistent frame is recorded every 31 frames by default
  (`TemporalSuperResolution.cpp:265-278`). The help text says the history memory grows.
- **Two candidates each frame.** The decimate pass reprojects both the previous frame and the oldest
  persistent frame, reads the guide colour and uncertainty of each, and keeps the one that matches the
  current frame better (`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRDecimateHistory.usf:149-250`,
  frame index at `:59`, matrix at `:61`). The shading rejection pass makes the per-pixel and per-tile choice (`TSRRejectShading.usf:261-317`). A surface that shows again, by parallax, by a shading change
  or by a moving translucent effect, takes its old detail without a new accumulation.

### ThreeNative today

- One half-float history target (`TRAANode.js:145`). A pixel that fails the depth test restarts from
  the current frame, with the minimum weight 0.05 (`:686`), so it needs about 20 frames to reach a
  stable edge. [PRD-455](../../done/PRD-455-temporal-reconstruction-from-dynamic-resolution.md) built the lifecycle that resets on a cut, a resize and a lost device.
- Nothing stores an older frame. A strafe past a fence or a door that opens shows each uncovered pixel as
  one noisy sample for the first frames.

## Solution

**The gate first (Phase 1).** On a fixture where a pillar crosses a detailed wall at 3 px per frame,
measure the frames an uncovered pixel needs to return to 90% of its settled edge accuracy, and the
share of screen pixels uncovered per second on the walk route of a foliage template. **Continue** only
if recovery takes more than 8 frames and more than 2% of pixels per second are uncovered. Otherwise
record the numbers under `## Decisions` and delete Phases 2 and 3.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Persistent frames in the history array | a second history layer, one frame every 31 frames, in the template's temporal stage | generated template source |
| Two-candidate reprojection and the match test | the resolve reads both layers and keeps the closer to the current input | generated template source |
| Frame and interval counts | options `resurrectionPersistentFrameCount`, `resurrectionPersistentFrameInterval` | core option |

- **Auto by default.** It follows the temporal tier of PRD-720 (off at `low`, on above). The tier
  table owns the switch. The stage report names it.
- **Deferred, not built:** more than one persistent frame. Revisit if the gate shows a second frame
  recovers a measured case that the first does not.

## Acceptance Criteria

- [ ] AC-1 [local]: A pixel uncovered after 40 frames behind a pillar recovers 90% of its settled edge accuracy within 3 frames with the feature on, and the feature adds no stale colour to a pixel that really changed. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` — Evidence: pending.
- [ ] AC-2 [local]: The extra layer costs at most 0.4 ms GPU at 1920 × 1080 on the RTX 2080. proof: `node packages/playtest/dist/runner/cli.js perf`, on against off — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Resurrection layer | the template's temporal stage when the tier turns it on | Adds a second candidate beside the previous frame | AC-1, AC-2 |

## Execution Phases

#### Phase 1: How long does an uncovered pixel stay soft?
**Status:** NOT STARTED
**Files:** `scripts/verify-temporal-motion.ts` (fixture only)
- [ ] The recovery frames on the pillar fixture and the uncovered share on the foliage walk are recorded with the verdict under `## Decisions`. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts`.

#### Phase 2: The second layer
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/temporalAAResolve.ts`, `packages/core/__tests__/temporal-resurrection.spec.ts` (new)
- [ ] The layer records every 31st frame, the resolve keeps the closer candidate, and a camera cut clears the layer. proof: red-green `pnpm exec vitest run packages/core/__tests__/temporal-resurrection.spec.ts`.
- [ ] AC-1 and AC-2 hold. proof: the AC-1 and AC-2 commands.

#### Phase 3: Native and judge
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/post/traa.cpp`, `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine matches the browser. proof: `pnpm parity --target desktop --only-tests temporal-resurrection`.
- [ ] A fresh visual judge returns IMPROVEMENT on a strafe past a fence, 2 runs per arm. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent.
**Verification:** AC-1 and AC-2.
