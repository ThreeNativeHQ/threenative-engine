---
prd_contract: v1
---

# PRD-719 — History rejection judges a color change by whether the display can show it

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: the default temporal resolve clips history in the frame's own color space with one variance gamma, and no measurement says whether dark regions ghost or bright regions flicker because of it.
**Complexity:** 6 (MEDIUM) — 2–4 files (+1), a color-space change in a shared resolve (+2), the same rule on the owned engine (+2), a visual judge (+1); risk override: none
**Owner:** João
**Depends on:** [PRD-539](PRD-539-low-resolution-temporal-reconstruction-quality-and-cost.md) for the corpus, which also names the moire error of lever 4. `docs/PRDs/Unreal/look/PRD-632-the-frame-is-exposed-and-tone-mapped-the-way-a-fresh-unreal-project-is.md` (on `feat/unreal-look-epic`) for the exposure the rejection reads.

## Context

**Unreal LOC:** about 1,890 for `TSRRejectShading.usf` 953, `TSRShadingAnalysis.ush` 644 and `TSRColorSpace.ush` 293. The learned filter inside the rejection is a separate row (PRD-539 does not cover it, and this PRD defers it). **Port estimate:** about 150 to 250 lines for the color space and the display-error floor, without the network.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **Rejection works in a display-shaped space.** The color space file defines two spaces. One compresses
  scene-linear color with a rational curve, so highlights keep precision before bloom. The other is a
  gamma encoding of that curve for the stored guide texture, so the 8-bit guide error spreads the way a
  display's does (`UE 5.8.3: Engine/Shaders/Private/TemporalSuperResolution/TSRColorSpace.ush:1-60`).
  A weight family divides a sample by its brightness, so a very bright sample cannot dominate
  (`:191-240`).
- **A floor from the display.** The rejection asks how large a color change must be before a 10-bit
  back buffer can show it. The answer is half of one 10-bit step, 0.5/1024 (`:244-248`). The analysis uses it as the
  noise floor when it compares input and history (`TSRShadingAnalysis.ush:278`, `:509`). A change
  below the floor never rejects history.
- **An exposure offset.** `r.TSR.ShadingRejection.ExposureOffset` is 0 and lifts the shadows inside the
  rejection only (`TemporalSuperResolution.cpp:206-228`). Its help text warns that a floor
  spread unevenly over the brightness range hides subtle effects and causes ghosting.
- **The pass.** `TSRRejectShading.usf` analyses moire over time (`:467-523`), converts input and history
  to this display space (`:682`, `:761`), measures the rejection with a network of convolutions in
  tiles of 32 by 32 (`:640-720`) and updates the guide for the next frame (`:384-398`, `:791`).

### ThreeNative today

- `TRAANode` clips history by variance in the color space it receives, with a gamma that moves from
  0.5 to 1 with motion (`examples/jsm/tsl/display/TRAANode.js:578-612`, `:686-700`). A luminance weight
  reduces flicker (`:631`). No floor from the display exists. The same color distance rejects in a dark
  floor and in a bright sky.
- On the epic branch the resolve runs late, on the scene-linear frame that the screen-space stages
  drew (`PRD-636` Phase 4). It runs before tone mapping, so the display cannot see the distance it
  measures.
- PRD-539 lever 4 mentions the moire error. It does not cover the display floor or the guide space.

## Solution

**The gate first (Phase 1).** On the PRD-539 corpus add two fixtures. A dim object (scene-linear 0.02)
crosses a dark floor, and a bright object (scene-linear 8) crosses a bright wall, both at 2 px per
frame. Measure the ghost trail length in frames and the edge flicker, in the current space and in a
display-shaped space with the 1/1024 floor, using the template's tone curve. **Continue** only if the
trail in the dim case is more than 25% longer than in the bright case, or the flicker differs by
more than 25%. Otherwise record the numbers under `## Decisions` and delete Phases 2 and 3.

**The mapping (Phases 2 and 3).**

| Unreal part | ThreeNative part | Layer |
| --- | --- | --- |
| Display-shaped color space and its guide encoding | a pair of node functions in the template's temporal resolve, built on the template's own tone curve | generated template source |
| Back-buffer error floor | one constant of the output format, read from the render target format | core mechanism |
| Exposure offset | option `shadingRejectionExposureOffset`, default 0 | generated template source |

- **Auto by default.** The floor comes from the output format: 8 bit gives 1/512, 10 bit gives 1/2048.
  A game does not set it.
- **Look stays the game's.** The space follows the template's tone curve, so a game that changes its
  grade changes the rejection with it.
- **Deferred, not built:** the convolution network. Its weights are Epic's trained data. A
  clean-room port needs its own training. Revisit if PRD-539's gate arms 1 to 4 fail and a learned
  classifier is the next candidate.

## Acceptance Criteria

- [ ] AC-1 [local]: The dim-object trail is within 25% of the bright-object trail in frames, and the edge flicker of both is within the pinned thresholds. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts` — Evidence: pending.
- [ ] AC-2 [local]: The moving-edge ratios of PRD-539 (`<=.75`, `>=1.25x`) hold. proof: the same command — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Display-space rejection | the template's `temporalAAResolve.ts` | Replaces the variance clip's color space, when the gate passes | AC-1, AC-2 |

## Execution Phases

#### Phase 1: Do dark and bright regions reject unevenly?
**Status:** NOT STARTED
**Files:** `scripts/verify-temporal-motion.ts` (fixtures only)
- [ ] The trail and flicker numbers for the dim and bright fixtures, in both spaces, are recorded with the verdict under `## Decisions`. proof: `sh scripts/xvfb.sh node --import tsx scripts/verify-temporal-motion.ts`.

#### Phase 2: The space and the floor
**Status:** NOT STARTED
**Files:** `packages/create-threenative/templates/*/src/render/temporalAAResolve.ts`, `packages/core/__tests__/temporal-display-space.spec.ts` (new)
- [ ] The two conversions round-trip to 1/255, the floor follows the output format, and a change below the floor does not reject. proof: red-green `pnpm exec vitest run packages/core/__tests__/temporal-display-space.spec.ts`.
- [ ] AC-1 and AC-2 hold. proof: the AC commands.

#### Phase 3: Native and judge
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/post/traa.cpp`, `packages/runtime-native/conformance/registry.json`
- [ ] The owned engine matches the browser. proof: `pnpm parity --target desktop --only-tests temporal-display-space`.
- [ ] A fresh visual judge returns NEUTRAL or IMPROVEMENT on a dark interior pan, 2 runs per arm. proof: headed `--browser-recipe webgpu` captures judged by a fresh read-only subagent.
**Verification:** AC-1 and AC-2.
