---
prd_contract: v1
---

# PRD-717 — A pixel a moving object just uncovered reprojects through the surface that left it

**Status:** NOT STARTED
**Priority:** P2 — Phase 1 is open: the default temporal resolve has no history at an uncovered pixel and no motion to borrow, and PRD-539 records a reveal check that fails (1.77% and 4.89% stale after one frame against 1%).
**Complexity:** 6 (MEDIUM) — 3–5 files (+1), a new scatter buffer per frame (+2), the same rule on the owned engine (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-539](PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md) for the corpus, the thresholds and the verdict. This PRD supplies one gate arm for 539's reveal box and changes no threshold. `docs/PRDs/Unreal/look/PRD-636-the-finishing-post-chain-matches-unreal-defaults.md` Phase 4 (on `feat/unreal-look-epic`) for the temporal default.

## Context

**Unreal LOC:** about 1,370 for the velocity and depth row (`TSRDilateVelocity.usf` 432, `TSRClosestOccluder.ush` 331, `TSRDepthVelocityAnalysis.ush` 607), of which the occluder scatter and its test are about 450. **Port estimate:** about 250 to 350 lines: a scatter pass in the temporal stage source, a buffer in `packages/core/src/render/velocity.ts`, and the same on the owned engine.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Each pixel tells the previous frame what covered it.** After the velocity dilation, every current
  pixel writes its closest depth and its dilated velocity into the four previous-frame input pixels
  that its reprojected position touches, weighted bilinearly. The write is an atomic maximum on one
  32-bit word, so the closest surface wins. The word holds the depth as a 16-bit float above 18 bits
  of velocity (`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRClosestOccluder.ush:101-158`,
  called from `TSRDilateVelocity.usf:421-423`). The velocity packs a 13-bit length and a 5-bit angle
  (`TSRClosestOccluder.ush:9-12`).
- **The test.** The decimate pass reads those words back around the reprojected position. It
  compares the stored occluder with the pixel's own previous depth, widened by the depth error of
  the depth format. A weighted mask under one half marks a parallax disocclusion
  (`TSRClosestOccluder.ush:190-331`, called at `TSRDecimateHistory.usf:163` and `:437`). The same
  routine returns the velocity of the surface that left, so the pixel can reproject through it.
- **The depth error.** The error of the depth value comes from the format's step at that depth
  (`TSRDepthVelocityAnalysis.ush:41-70`). Depth bilateral weights and the reprojection edge come
  from the same file (`:332-415`, `:550-607`).

### ThreeNative today

- `TRAANode` in Three 0.185.1 picks the velocity of the closest depth in a 3 by 3 block
  (`examples/jsm/tsl/display/TRAANode.js:499-540`). It samples the previous depth at the reprojected
  position and calls the history valid when the position is on screen and the depths differ by less
  than `depthThreshold` 0.0005, except on an edge where `edgeDepthDiff` is 0.001 (`:95`, `:103`,
  `:539`, `:671`). The test needs no scatter. Where it fails, the pixel takes the current frame.
- The pixel gets no motion from the surface that left. A background pixel uncovered by a moving
  object reprojects with the object's velocity if the 3 by 3 block still holds the object's edge,
  and with its own velocity otherwise.
- `scripts/verify-temporal-motion.ts` holds the reveal check (`revealRecovery`, `qualityRevealRecovery`).
  PRD-539 lists its failing numbers.

## Solution

**The gate first (Phase 1).** Add the Unreal test as a gate arm in the PRD-539 corpus and read the
reveal check, the moving-edge ratios and the edge flicker. **Continue** only if the arm brings the
stale-after-one-frame fraction to 1% or less on both fixtures with the pinned edge ratios kept.
Otherwise record the numbers under `## Decisions` and delete Phases 2 and 3.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Atomic-max scatter of closest depth and velocity | A pass in the template's temporal stage writes an `atomic<u32>` storage buffer at the input raster. A storage texture cannot hold atomics in WebGPU | generated template source |
| Parallax disocclusion test | The resolve reads the buffer around the reprojected position and rejects history | generated template source |
| Hole-filling velocity | The resolve reprojects a rejected pixel through the stored velocity | generated template source |
| The buffer and its clear | `RenderChain` provisions it with the velocity target, only when the temporal stage asks | core mechanism |

- **Auto by default.** The pass runs with the temporal stage and costs one buffer. `temporalAA: false`
  removes both. The stage report names the arm.
- **Unreal names.** The module uses `closestOccluder` and `holeFillingVelocity` as names.
- **Deferred, not built:** the depth bilateral weights and the reprojection edge of the depth analysis.
  They feed the reprojection field, which PRD-539 lists as lever 5. Revisit when that lever runs.

## Acceptance Criteria

- [ ] AC-1 [local]: A background pixel uncovered by an object that moves 3 px per frame takes no colour from the object, and a pixel that stays covered keeps its history. proof: red-green `pnpm exec vitest run packages/core/__tests__/temporal-closest-occluder.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The reveal check passes at 1% on both fixtures with the pinned edge ratios (`<=.75`, `>=1.25x`). proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` on hardware WebGPU — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Closest-occluder scatter and test | the template's `temporalAAStage.ts` resolve | Replaces the previous-depth compare as the reveal test, when the gate passes | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Does the scatter fix the failing reveal check?
**Status:** NOT STARTED
**Files:** `scripts/verify-temporal-motion.ts` (arm only), `packages/create-threenative/templates/starter/src/render/temporalAAResolve.ts` (test arm)
- [ ] The reveal numbers for the depth-compare resolve and the scatter arm are recorded with the verdict under `## Decisions`. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts`, one run per arm.

#### Phase 2: The pass and the resolve
**Status:** NOT STARTED
**Files:** `packages/core/src/render/velocity.ts`, `packages/create-threenative/templates/*/src/render/temporalAAResolve.ts`, `packages/core/__tests__/temporal-closest-occluder.spec.ts` (new)
- [ ] The scatter and the test follow AC-1, and the buffer exists only while the stage runs. proof: red-green `pnpm exec vitest run packages/core/__tests__/temporal-closest-occluder.spec.ts`.
- [ ] AC-2 holds. proof: the AC-2 command.

#### Phase 3: Native and judge
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/post/traa.cpp`, `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine runs the same scatter with `atomicMax` and matches the browser. proof: `pnpm parity --target desktop --only-tests temporal-closest-occluder`.
- [ ] A fresh visual judge returns IMPROVEMENT on a pan past a pole, 2 runs per arm. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent.
**Verification:** AC-1 and AC-2.
