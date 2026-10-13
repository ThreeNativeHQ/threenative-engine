---
prd_contract: v1
---

# PRD-570 — A character costs what the camera sees of it

**Status:** PARTIAL — current runtime regressions, CPU/GPU attribution, native behavior and repeated visual equivalence are verified; stable CPU acceptance, shooter and final qualification remain open.
**Priority:** P2 — finish GPU attribution, the conditional skin-once decision and shooter acceptance.
**Complexity:** 5 (MEDIUM) — 1–5 engine files (`animation.ts`, `projection-skinned.ts`, `render-camera-cull.ts`) (+1), skipped-frame accumulation and interpolation state carries across frames (+2), a skin-once compute pass is a new mechanism, gated by Phase 1 (+2); risk override: none
**Owner:** João
**Depends on:** None. Coordinate with [PRD-486](../../open-world/PRD-486-characters-get-a-lod-chain.md): its posed-bounds rule (Phase 2) is the bound this PRD reads when that lands, and its mannequin crowd is a shared subject.

## Context

Every animated character pays its full cost every frame:

- `AnimationPlayer.update(dt)` (`packages/core/src/animation.ts:734-741`) calls `mixer.update(dt)`
  on every call. The documented pattern calls it every frame
  (`packages/core/src/index.ts:80-89`, `SkeletalMesh3D` extends `AnimationPlayer`,
  `skeletal-mesh.ts:16`). Nothing reads distance or visibility. The term frame-skip appears nowhere
  in the animation sources.
- `SkinnedBatch.write` (`packages/core/src/projection-skinned.ts:357`) runs one matrix product per
  bone per rig, then uploads the palette (`:404-405`). It runs for every claimed rig. The batch
  draw sets `frustumCulled = false` (`:274`) and `instanceCount = this.used` (`:401`), so every rig
  draws, including rigs off screen.
- Skinning runs in the vertex stage of every pass that draws the batch. The position node blends 4
  palette matrices per vertex, and the velocity history blends 4 more (`projection-skinned.ts:251-267`).
  Main, shadow and any other pass each repeat it. three 0.185.1 ships an opt-in compute skinning helper
  (`computeSkinning`, `three/build/three.webgpu.js:18951`), which nothing in `packages/core/src` or
  the templates calls. It serves three's own `SkinnedMesh`, not `SkinnedBatch`.

Subjects: the shooter's soldiers (`packages/create-threenative/templates/shooter/src/entities/Enemy.ts`, `SkeletalMesh3D`, five
per scene), the action-rpg fighters, and `examples/skinned-crowd`. The crowd drives 64 rigs through
raw `AnimationMixer` (`examples/skinned-crowd/src/scenes/Crowd.ts:92-105`), so it does not reach
`AnimationPlayer` today.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **Update and evaluation are separate rates** (update-rate optimization, URO). Each skinned
  component chooses rates from its state
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp:283-370`):
  - A human-controlled character, or one that needs root motion every frame, always runs at rate 1
    while visible.
  - A rig that was not recently rendered evaluates at `BaseNonRenderedUpdateRate`, default 4: one
    frame evaluated, then three skipped.
  - A visible rig picks its rate from its screen size, the same "distance factor" its LOD uses.
    The defaults are thresholds 0.24 and 0.12: above 0.24 every frame, above 0.12 every second
    frame, below that every third (`Classes/Engine/EngineTypes.h:2776-2785`, defaults at
    `:2825-2826`). A map from LOD to frame skip can replace the thresholds
    (`EngineTypes.h:2787-2794`).
- **Skipped time is not lost.** Each skipped update subtracts its `dt` from a running offset.
  The next real update adds that total to its own `dt` (`SkinnedMeshComponent.cpp:6103-6116`).
- **Characters are staggered by a unique tag.** Each character gets the next number from a shared
  counter. The number is added to the global frame counter before the modulo test
  (`SkinnedMeshComponent.cpp:194-200, 6079-6081`; bucket enum at `EngineTypes.h:2693-2702`).
  A character that skips longer than its rate is forced to update, so a rate change cannot starve
  it (`SkinnedMeshComponent.cpp:6084-6098`).
- **Evaluation rate is a multiple of update rate.** The code rounds it down to one
  (`SkinnedMeshComponent.cpp:6074`). A rig with root motion from the animation alone runs every
  frame. A rig with "root motion from everything" may still skip, through a look-ahead mode
  (`SkinnedMeshComponent.cpp:360-364`). This PRD keeps every root-motion player at rate 1 and does
  not copy the look-ahead mode.
- **Interpolation is limited.** Skipped frames blend toward the last evaluated pose by
  `1 / framesToNextEval`. Interpolation turns off at evaluation rates of `MaxEvalRateForInterpolation`
  (default 4) or above (`SkinnedMeshComponent.cpp:6075-6076, 6154-6165`; default at `EngineTypes.h:2821`).
- **Unreal ships URO off.** `bEnableUpdateRateOptimizations = false` per component
  (`Private/Components/SkeletalMeshComponent.cpp:493`). This repository's rule is the opposite
  (conventions ship on, with a named override), so this PRD turns it on by default and reports it.
- **Skin once, read in every pass.** The GPU skin cache skins in a compute shader into a buffer that
  depth, velocity, shadow and the base pass then read instead of skinning again
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Public/GPUSkinCache.h:5, 13-19`). On higher-end platforms
  it also writes tight posed bounds for instance culling (`r.SkinCache.DynamicMeshBounds`, default
  auto, `Private/GPUSkinCache.cpp:205-215`). The cache keys its position buffers by the revision of
  the bone buffer, so a rig whose pose did not change finds its buffers again and is not skinned
  twice (`GPUSkinCache.cpp:1644-1663`). It also keeps a previous-position buffer for velocity.

## Solution

1. **Measure first (Phase 1).** On a crowd driven through `SkeletalMesh3D` at mixed distances,
   attribute the CPU cost of `AnimationPlayer.update` plus `SkinnedBatch.write`, and the GPU vertex
   cost of skinning in each pass. The Phase 2 and Phase 3 gates read these numbers.
2. **Rate by what the camera sees (Phase 2), in core, on by default.**
   - `AnimationPlayer.update(dt)` always accumulates `dt`. It calls `mixer.update(accumulated)` only
     on its evaluation frames, so clip time, fades, `finished` events and stride sync see the same
     total time.
   - The rate comes from a projected size. `render-camera-cull.ts` has the formula for its
     one-pixel gate (`:318`) but exposes no size. It also skips every object with
     `frustumCulled === false` (`:280`), and the `SkinnedBatch` mesh is one. Phase 2 therefore
     extracts the formula into a pure helper and calls it once per rig with the rig's bounds. A rig
     outside the camera frustum uses the not-rendered rate.
   - The thresholds are a starting table, recorded in the PRD and tuned by the Phase 2 visual gate.
     They are not constants for the game to revisit.
   - Each player gets a stable stagger offset. A forced evaluation follows any skip that runs longer
     than the rate.
   - Rate 1 always: the camera's own target, root-motion players
     (`animation-root-motion.ts`), and any player with `updateRate: 1`.
   - The named override is `updateRate: "auto" | number` on the player. Every non-auto choice is
     reported.
   - A skipped frame leaves the palette slot unwritten, so `SkinnedBatch.write` is skipped too.
     Interpolation is added only if the Phase 2 judge rejects the plain trail at rate 2.
   - The velocity history follows the drawn pose. `SkinnedBatch.begin` copies the whole current palette into
     the previous palette every frame (`projection-skinned.ts:291-293`). A skipped rig then has zero
     velocity, and its next evaluation frame has the full multi-frame step as velocity. The
     temporal anti-aliasing stage reads that step. This matches the pose that is drawn, and Phase 2 asserts it.
3. **Skin once (Phase 3), only if Phase 1 shows skinning is at least 0.5 ms of GPU across passes on
   the crowd.** A compute pass writes skinned position and previous position into storage once per
   frame. The batch's `positionNode` and the velocity history read it in every pass. The pass skips a rig whose palette was not written this frame. Otherwise the
   phase is declined under `## Decisions`, and the measurement is the record.

Scout lead dropped: an earlier review warned that `maxStorageBuffersInVertexStage` might default
to 0 and break the palette read. The limit exists only in Dawn's `CompatibilityModeLimits`
(`packages/runtime-native/third_party/dawn/dawn-headers/include/dawn/wire/client/webgpu_cpp.h:4546-4565`),
which is compatibility mode, not the core WebGPU that this engine requests.

## Acceptance Criteria

- [ ] AC-1 [local]: A 128-rig `SkeletalMesh3D` crowd receding to 120 m spends at least 40% less CPU in `AnimationPlayer.update` plus `SkinnedBatch.write` than the rate-1 arm, from one build. proof: new `examples/skinned-crowd/playtests/crowd-rate.playtest.json` through `node packages/playtest/dist/runner/cli.js ... --browser-recipe webgpu` with `playtest perf`, adapter named.
- [ ] AC-2 [local]: The shooter's soldiers keep their gameplay behavior: the existing shooter playtests stay green with the policy on. proof: `pnpm test:templates` for shooter.

## Blocked on

- An Android frame-time claim for the crowd needs the Pixel 8, because the emulator cannot hold a performance claim. Unblocked when João attaches the device.

## Decisions

- 2026-10-12 (Unreal source review): the projected-size source was wrong. `render-camera-cull.ts` skips the skinned batch and exposes no size, so Phase 2 extracts the formula as a helper and tests each rig. Unreal interpolates skipped frames below rate 4, so its pose still moves each frame. A plain skip here freezes the pose, so velocity is zero on skipped frames and one large step on the evaluation frame. That is the true motion of the drawn pose, and one Phase 2 box now asserts it.
- 2026-10-12 (Unreal source review): Unreal's skin cache reuses a rig's skinned buffers while its bone-buffer revision is unchanged. Phase 3, if it runs, keys the stored skin by palette write so a skipped rig is not skinned again.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Visibility-driven evaluation rate | game `update(dt)` → `SkeletalMesh3D.update` / `AnimationPlayer.update` (`animation.ts:734`) → `mixer.update` on evaluation frames | Every-frame evaluation; rate 1 stays as the named override | Phase 2, AC-1 |
| Skipped palette writes | projection reconcile → `SkinnedBatch.write` (`projection-skinned.ts:357`) | Unconditional per-rig write | Phase 2, AC-1 |
| Skin-once compute (conditional) | `SkinnedBatch` position node → storage written once per frame | Per-pass vertex-stage skinning, or declined by Phase 1's numbers | Phase 3 |

## Execution Phases

#### Phase 1: The cost is measured
**Status:** COMPLETE — CPU costs are reported for the current runtime at all three crowd sizes and GPU attribution is verified; the unstable CPU savings comparison does not close AC-1.
**Files:** `examples/skinned-crowd/src/scenes/Crowd.ts`, `examples/skinned-crowd/src/game.ts`, `examples/skinned-crowd/playtests/crowd-rate.playtest.json` (new), `packages/core/src/profiling/Spans.ts`, `packages/core/src/projection-skinned.ts`, `packages/core/__tests__/projection-skinned.spec.ts` (exact write probe).
- [x] [local] The crowd scenario reports CPU milliseconds for `AnimationPlayer.update` and `SkinnedBatch.write` at 32, 128 and 256 rigs, with the result recorded under `## Decisions`. proof: `crowd-rate.playtest.json` with `playtest perf` and span probes. 2026-10-13: runtime `067b2fed2`, all six scenarios and three-window perf validations exit 0; 18 complete post-startup windows. Observed costs and variability are recorded below; AC-1 remains inconclusive.
- [x] [local] The same scenario reports GPU milliseconds for skinned draws in the main and shadow passes, against an arm where the crowd is static. The result decides Phase 3 under `## Decisions`. proof: the same playtest, both arms, `TN_FRAME_BUDGET` `main`/`shadow` buckets.

#### Phase 2: Rigs evaluate at the rate their screen size earns
**Status:** PARTIAL — accumulated time, stagger, skipped writes, velocity history, native desktop and repeated visual equivalence are verified; AC-1 remains inconclusive because loaded-host variability exceeds its ceiling.
**Files:** `packages/core/src/animation.ts`, `packages/core/src/projection-skinned.ts`, `packages/core/src/render-camera-cull.ts`, `packages/core/__tests__/animation-rate.spec.ts` (new)
- [x] [local] Accumulated `dt` keeps clip time, fade progress and the `finished` event identical to rate-1 playback over 300 frames, and a forced evaluation follows any skip longer than the rate. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts`. 2026-10-11 green: `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts` 26/26, red first on `updateRateReport` missing; rates 2/4/8 match rate-1 clip time over 300 frames, crossfade weights, interruption, weighted blends, `finished` timing and replay, forced evaluation, stop/pause/stride-rate integration all exact. Surface: `AnimationPlayer.updateRate` (`"auto"` | positive integer), `updateRateReport`, `update(dt, force)`. 111 existing animation/composition/cull regressions pass.
- [x] [local] Velocity history matches the pose that was drawn: zero on a skipped frame, the whole step on the evaluation frame, and no stale previous palette after a rate change or a first write. proof: a red-green case in `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`. 2026-10-12 green: the focused animation/projection run passes 42/42, including skipped-frame zero-history, evaluation-frame whole-step, rate-1 history and projected-batch auto-rate cases; the implementation commits as `172b80bf3`.
- [x] [local] Stagger offsets spread 128 rigs so that the evaluations in any one frame stay within 1.5× of the mean. Root-motion and `updateRate: 1` players never skip. proof: the same spec. 2026-10-11 green: same spec, 128 rigs at rates 2/4/8 over 240 frames, per-frame evaluations never exceed 1.5x the mean (mean = 128/rate); `updateRate: 1` and root-motion composers evaluate every tick. Auto-rate pixel bands (128/32/8 px) are provisional until AC-1's judge.
- [ ] [local] AC-1 passes. A fresh judge subagent compares 10 m, 40 m and 120 m captures against rate 1 and finds no visible loss. proof: `crowd-rate.playtest.json` plus `pnpm visuals:ab --before <rate1> --after <auto> --out <dir>`. 2026-10-13 reopened: fresh Sonnet 5.5 high inspection found no visible pose loss (NEUTRAL), but the previous captures lack two independent runs per arm, burned-in labels and complete per-run pose provenance. Repeat captures are required before this box is verified.
- [ ] [local] The native desktop host runs the crowd scenario with the policy on. proof: `crowd-rate.playtest.json --target desktop` with the shipped CLI. 2026-10-13 final runtime `067b2fed2`: Linux V8/Dawn, RTX 2080/Turing, matching NVIDIA 615.71.09; all 15 assertions pass with zero diagnostics and the same three invariant waivers. Complete verdict: `artifacts/prd570-native-067b2fed2.log`; raw observations: `artifacts/prd570-native-067b2fed2/`. Reopened after integrating origin/develop `5e2a9d3d3`, which changes upstream game/frame-budget/index inputs and invalidates whole-build freshness.

#### Phase 3: Skinning runs once per frame, if Phase 1 earns it
**Status:** COMPLETE — skin-once declined: measured held-minus-static main-plus-shadow GPU overhead is below 0.5 ms at 32, 128 and 256 rigs on Intel Iris Xe.
**Files:** `packages/core/src/projection-skinned.ts`, `packages/core/src/render/velocity.ts`, `packages/core/__tests__/projection-skinned.spec.ts`
- [x] [local] With the skin-once pass, the crowd's main-plus-shadow GPU time falls against Phase 1's arm, and the existing velocity-history assertions stay green. If Phase 1 shows less than 0.5 ms, the decline is recorded under `## Decisions` instead. proof: `crowd-rate.playtest.json` perf arms and `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`.


## Decisions

- 2026-10-10, execution lane `perf/prd570-skin-animation-gate` at
  `.worktrees/prd570`, owned by the PRD-570 worker; retained for coordinator inspection.
  Scope is the baseline gate only. No update-rate policy or skin-once optimization is implemented.
  No phase or acceptance box is ticked, and Phase 3 is neither earned nor declined.
- The original no-query 64-rig fixture keeps its raw-mixer path. Measurement runs require
  `?tnFrameSpans=1&crowdCount=32&crowdArm=animated` (repeat with counts 128 and 256).
  `animated` uses actual `SkeletalMesh3D` instances and spans each inherited
  `AnimationPlayer.update(1/60)` call; `skinnedWrite` spans the actual shared
  `SkinnedBatch.write` body, including `skeleton.update`, excluding reconcile and palette upload.
  `TN_CROWD_RATE` publishes their window means and calls per frame alongside GPU main/shadow
  buckets, rendered-shadow sample count, main/shadow draws and triangles, and drawing surface.
  Missing timestamps, spans, rendered shadows or expected call counts leave `ready` false.
- Two frozen controls isolate the GPU comparison: `crowdArm=held` keeps the skeletal rigs at
  sway time 0; `crowdArm=static` bakes that same pose's positions and skin-transformed normals
  once into shared unskinned geometry, drawn with stock `InstancedMesh`. Both retain the same
  actor transforms, material, topology, cast/receive-shadow settings and 10/40/120 m depth bands.
  The fixture forces a shadow redraw in every arm. Check actual main/shadow draws and triangles
  for **every** count before comparing timings; a differing 256-rig batch count invalidates a
  skinning-only attribution. Frozen-pose equality is unverified visually, and neither frozen
  control is claimed pixel-identical to a later animated pose. `projectedHeldHeights` reports each
  root's measured held-pose height projected at its camera-space depth in viewport pixels; it is
  an initialization observation, not continuously updated animated bounds.
- The baseline includes instrumentation overhead: two clock/recorder crossings per player update
  and palette write, plus existing span probes. No invented overhead has been subtracted.
  GPU values are existing resolved whole-pass windows, not direct vertex-stage timestamps.
  Only a matched held-minus-static main-plus-shadow comparison can inform the 0.5 ms gate.
- Local proof: the new exact-write assertion failed before instrumentation (`undefined` versus
  8 writes), then passed. Focused projection/span specs: **25 tests passed**. Crowd TypeScript
  check, checkout-local core ESM/declaration build, playtest package build and scenario schema
  loading passed. Vite build passed with existing chunk/dynamic-import warnings; Biome passed
  with one non-fatal complexity warning in `Crowd.enter`. At first draft delivery, no browser, GPU,
  native, shooter or visual-judge run had been performed. Baseline cost comparisons and all PRD
  outcomes remain unverified pending the coordinator's exclusive cost window.

- Coordinator review found a bridge serialization defect in the frozen controls: absent span or
  GPU metrics were published as `undefined`. They now publish `null`, retaining missing-work
  semantics and `ready: false` for missing mandatory measurements. A focused Node/tsx falsifier
  using the bridge's actual `assertJsonSafe` rejected held/static snapshots before the fix;
  after it, all four held/static × present/missing-GPU cases pass, including explicit null-value
  and readiness assertions. Crowd TypeScript and Vite build pass; no GPU run was needed or claimed.

- Draft PR #487 targets develop at `prd:0%`. The initial normal pre-push hook passed agents,
  documentation, lint and drift checks; the exact seven-package build closure passed with source
  hashes unchanged. A subsequent local scenario change waits on an observed window of at least
  2, then readiness, rather than treating 600 fixed ticks as 600 renders. Readiness requires 120
  actual render frames and 120 sampled frames for each active CPU span. Fresh GPU and rendered-
  shadow sample counts remain explicit; they are not claimed to cover all 120 render frames.
  Schema loading, Crowd TypeScript/Vite and six focused bridge/readiness cases pass: complete
  animated/held/static windows are ready; an incomplete CPU window or missing GPU data is not.
  These local changes remain unpushed; the bounded functional run below exercises them.

- The local GPU coverage extension exposes `gpuMainSamples` from the same existing ring
  summary that supplies `gpuMain`; absent measurements stay absent in FrameBudget and publish
  `null` in the fixture. Readiness now requires an observed main sample as well as rendered-shadow
  samples. The focused fresh/deduplicated-main assertion failed before the field existed, then
  all **17 frame-budget GPU-series tests passed**, including measured zero and missing-main cases.
  Core ESM/DTS/bundler build and publint pass. Crowd TypeScript, scenario schema and Vite build
  pass. Six bridge/readiness cases pass: a global GPU sample count cannot substitute for missing
  main samples. Main sample counts are observed independently of the 120 render frames.

The coordinator reviewed `5e0cba5f8..cd48d5ae7` and granted one bounded 32-animated functional
preflight. The exact built fixture was served by an owned `vite preview` at port 57170. Doctor
passed before and after the run with the four approved extras; it supplies the shipped five args:

```sh
node packages/playtest/dist/runner/cli.js doctor --url 'http://127.0.0.1:57170/?tnFrameSpans=1&crowdCount=32&crowdArm=animated' --text \
  --browser-arg --use-angle=vulkan --browser-arg --use-vulkan \
  --browser-arg --disable-vulkan-surface --browser-arg --no-sandbox
```

The following single 32-animated run uses an explicit manual override equivalent to the shipped
WebGPU recipe plus those four extras (the scenario CLI rejects combining recipe and arguments):

```sh
node packages/playtest/dist/runner/cli.js examples/skinned-crowd/playtests/crowd-rate.playtest.json \
  --url 'http://127.0.0.1:57170/?tnFrameSpans=1&crowdCount=32&crowdArm=animated' \
  --headed --artifacts artifacts/prd570-functional-cd48d5ae7/run \
  --browser-arg --ozone-platform=x11 --browser-arg --enable-unsafe-webgpu \
  --browser-arg --disable-gpu-sandbox --browser-arg --ignore-gpu-blocklist \
  --browser-arg --enable-features=Vulkan --browser-arg --use-angle=vulkan \
  --browser-arg --use-vulkan --browser-arg --disable-vulkan-surface --browser-arg --no-sandbox
```

- Actual capture adapter: `vendor=nvidia`, `architecture=turing` (physical GPU RTX 2080).
  At completed window 2, `ready=true`; render, animation-span and palette-span frame counts were
  each 120. Main and rendered-shadow GPU sample counts were each **120 observed samples**.
  Animation calls and palette writes were each 32 per frame. Main/shadow draws were 3/1 and
  triangles 17,667/17,664, at 1280×720, scale 1, DPR 1, sample count 4.
- The single scenario exited **1**: 11 `TN_PLAYTEST_ASSERTION_TRIVIAL` diagnostics rejected held
  invariants already satisfied in the startup observation. The observed window/readiness checks
  passed. No assertion was weakened and no runtime retry was made; scenario success remains
  unverified. Doctor before/after both exited 0, identified NVIDIA/Turing and reported no console
  errors. The next scenario change must distinguish held invariants from transitions, using the
  existing harness contract, before another runtime grant.
- Raw artifacts are retained in `artifacts/prd570-functional-cd48d5ae7/`: `before.json` and
  `after.json` contain capacity/source and built-artifact hashes, `doctor.log`/`doctor-after.log`,
  `run.log`, `receipt.json`, `state.json`, and `run/capture.json`/`run/console.json`. Source and
  bundle hashes were unchanged during the run. Owned preview PID 1795686 was terminated after
  doctor, and port 57170 was verified closed. Other GPU processes were present (26% utilization
  before, 22% after); these observations establish functional coverage only, with no cost,
  savings, visual-quality or native claim.

A separate exclusive cost window is required before the nine count/control arms. Proposed minimum:
three complete post-startup 120-render windows per arm, each with at least 30 actual main and 30
rendered-shadow samples; report both observed coverage counts and draws/triangles. Reserve 20 minutes
and record fresh CPU/RAM/GPU utilization/process metadata before and after. The coordinator has not
granted this series. AC-1's 40% reduction is a later Phase 2 gate.

2026-10-10, game-fixture correction after the functional preflight: `crowdRate.measured` starts
at null and latches exactly one completed ready window numbered at least 2. Its explicit JSON-safe
snapshot contains CPU/GPU costs and counts, draws/triangles, surface and control metadata. Flat
startup metrics continue updating, including later windows; they are not hidden or overwritten.
The scenario retains both raw readiness/window wait steps and assertion rows, checks window metrics
through this receipt with the original limits, and adds the receipt's window-at-least-2 proof.
Its 14 resource rows contain 11 unwaived checks and exactly three
held invariants use the installed `allowTrivial`: measurement mode and count are fixed by the URL,
and projected-rig count is computed in `Crowd.enter` before startup sampling. Each written reason
points to the unwaived post-baseline window checks. No window metric has a waiver.

Proof: `node --import tsx artifacts/prd570-measurement-check.mjs` first failed on the absent initial
null receipt, then passed six cases using actual Crowd initialization/callbacks, the bridge's
`assertJsonSafe`, and its installed resource evaluator. Cases cover window 1 remaining visible,
valid 120-frame window 2 receipts for animated/held/static, missing GPU/CPU and 119 CPU frames
preventing a receipt, later raw updates leaving the receipt immutable, and held/static optional
CPU costs remaining null. All 14 rows pass with the initial pre-window baseline; all 11 unwaived
rows reject an already-held late baseline with `TN_PLAYTEST_ASSERTION_TRIVIAL`. An already-ready
window-1 baseline also remains rejected by the raw readiness row. Crowd TypeScript, scenario
loading, Biome and diff checks pass;
Biome reports non-fatal complexity warnings in `crowdSpans` and `Crowd.enter`. The check script is
an ignored executable consumed by this focused check, not a verification report.

If startup sampling already observes readiness or the latched window, the scenario must fail honestly; warmup
has not been adjusted to evade that guard. One receipt does not implement or earn the proposed
three-window-per-arm cost series. No new browser/GPU/build run, optimization claim or PRD checkbox
completion accompanies this local change.

2026-10-10, bounded functional recheck at local commit `16f2173f9`: normal commit and
`timeout 240s pnpm --filter ./examples/skinned-crowd build` passed (Vite 2.04 s). One headed
32-animated NVIDIA/Turing run passed all 14 resource assertions with exactly three documented
held-invariant waivers, original warmup 120, 1280×720 and unchanged limits. Startup
`ready:false, measured:null` became immutable ready window 2: 120 render/animation/palette frames,
32 calls/writes per frame and 120 actual main/120 rendered-shadow GPU samples. Main/shadow
counts were 3/1 draws and 17,667/17,664 triangles, scale 1/MSAA 4. Doctor before/after passed;
no console errors or runtime diagnostics. Source/bundle hashes remained unchanged during capture.
Commands, exact nine manual browser arguments, hashes, adapter, state and host/process metadata
remain in `artifacts/prd570-functional-16f2173f9/` (`receipt.json`, `before.json`, `after.json`,
`state.json` and logs). Unowned GPU load was 14%/22%; this is functional proof only. The owned
preview stopped and port 57170 closed. No push, retry, cost series, savings, visual comparison or
native claim; late-baseline rejection still applies and every PRD gate remains open.
- **2026-10-11, owner delegated the cost-window grant; Phase 1 series run on a loaded host, NOT accepted as cost evidence:** four headed `--browser-recipe webgpu` runs on NVIDIA/Turing (`artifacts/prd570-cost-series-20261011T213750Z` held/static 128, first animated attempts; `artifacts/prd570-cost-series-20261011T213750Z-rerun` animated 128 and 256 reruns after an Xvfb 10 s start timeout and a window-2 wait timeout at 256 under load). All six reported runs exit 0 or are explained, 120 GPU samples each, draws 3 main / 1 shadow. GPU main/shadow ms: animated-128 1.3/0.2, held-128 1.3/0.1, static-128 0.1/0, animated-256 0.1/0. The 256 arm reading is implausibly below 128 and the host load average was about 44–50, so no box is ticked and no CPU `AnimationPlayer.update`/`SkinnedBatch.write` span values were extracted (the playtest assertions carry frame counts, not span milliseconds). Next: rerun on a quiet host and read spans with `playtest perf`; Phase 2 (policy + `animation-rate.spec.ts` red-green) does not depend on these numbers.

- Shooter template gate (AC-2), 2026-10-12, headed `--browser-recipe webgpu` with the NVIDIA env
  (`adapterClass: hardware`), policy on (`updateRate: 'auto'`): two full runs passed 33 of 34
  scenarios, all gameplay and behaviour scenarios included. The one failure each time is
  `performance.maxFrameMsP95` (limit 33 ms; observed 178.9, 86.7 ms) at host load 11–17. A middle
  run added two `Instance dropped in popErrorScope` device-loss reds (`crouch-lowers-the-eye`,
  `enemy-body-is-a-body`) that passed in the other two runs. Three low-load replays of that scenario
  gave 41.1–45.8 ms. The same scenario on a scaffold without the PRD-570 changes gave 51 ms, an
  error exit and one pass, so the budget fails on this lane without the policy too. The first
  gate run used the software adapter (swiftshader) and is void. AC-2 stays open: "stay green" is
  not met while `performance` is red, and a quiet-host baseline is the missing evidence.

- 2026-10-12, runtime implementation and environment check: `172b80bf3` adds camera-projected
  auto-rate observations for source rigs behind a `SkinnedBatch`, skips duplicate palette writes
  when an `AnimationPlayer` did not evaluate, preserves the existing full-step velocity history,
  and keeps `crowdRate=1` as the named control. Focused animation/projection tests pass 42/42;
  core and skinned-crowd builds pass; Biome reports only the existing non-fatal complexity
  warnings. The headed auto fixture reaches `TN_CROWD_RATE ready:true` with 49.75 palette writes
  against 128 animation calls, but its adapter is `vendor=google, architecture=swiftshader` and
  is not cost or visual proof. The NVIDIA-forced replay also selects SwiftShader and times out
  readiness after repeated `GPUBuffer.mapAsync` external-instance errors. Setup diagnosis:
  `/proc/driver/nvidia/version` is `615.71.09`, installed Vulkan/NVML libraries are `615.78.08`,
  `vulkaninfo` finds no driver, and `nvidia-smi` reports a driver/library mismatch. No Phase 1,
  AC-1, Phase 3, visual, native or AC-2 box is ticked from these runs.

- 2026-10-12, manager-reproduced moving-root defect fixed in `86d284513`: the red regression
  failed with `batch.palette[12] = 0` after a skipped-rate-4 frame while the moved actor's
  `matrixWorld.elements[12] = 10`. `SkinnedBatch.write` now compares the rig's current
  `matrixWorld` with the last world transform written; a changed gameplay transform writes the
  world-space palette even when animation evaluation is skipped, while an unchanged skipped pose
  still omits `skinnedWrite`. The regression also proves velocity history is old-root to new-root.
  `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts packages/core/__tests__/projection-skinned.spec.ts`
  passes 43/43, and touched-file Biome passes.

- 2026-10-12, hardware doctor after sourcing
  `/home/joao/.cache/nvidia-615.71.09/env.sh`: `nvidia-smi` reports NVIDIA GeForce RTX 2080,
  driver `615.71.09`; `vulkaninfo --summary` reports Vulkan 1.4.363; the headed playtest doctor
  exits 0 with `adapter nvidia turing`, a nonblank rendered scene and 0 console errors. The first
  doctor attempt was intentionally invalid because the owned preview was stopped and returned
  `ERR_CONNECTION_REFUSED`; the corrected doctor run used the preview on port 57170 and passed.

- 2026-10-12, skinned-write measurement coverage corrected: the first focused regression run was
  red because a stationary skipped `SkinnedBatch.write` call had no `skinnedWrite` span
  (`undefined`, expected `perFrame=1`), although its `skeleton.update` spy was not called. The
  existing span now brackets the whole `write()` function, including the animation-rate lookup,
  world-matrix guard and early return; the focused animation/projection contracts pass 43/43.
  `skinnedWrite.perFrame` is therefore function-call count, including skipped stationary calls,
  while the regression still proves skipped calls do not update the skeleton or rewrite the
  palette. The crowd receipt exposes this scope as `paletteCalls`, and readiness requires exactly
  `count` calls per frame for animated, held and auto/rate-1 arms; no call-count reduction is
  expected from auto-rate policy. Historical `paletteWrites` evidence above is retained as-is.

- 2026-10-12, portable crowd-rate selection corrected: `Crowd.ts` now uses the shipped
  `spansRequested()` launch helper when no `crowdCount` query is present, so native
  `TN_FRAME_SPANS=1` selects the 128-rig animated auto-rate measuring fixture without a browser
  location. The focused actual-module check was red before the change (`count=64`,
  `measuring=false`) and is green after it for native flag selection, legacy no-flag mode and
  explicit `crowdCount=32` precedence. Crowd typecheck and build pass; the native desktop box
  remains open for the manager's post-build scenario.

- 2026-10-12, the manager's native run at `c579311ed` passed all 14 resource assertions and
  measured the 128-rig auto fixture, but exited only on `TN_PLAYTEST_NETWORK_ERROR` for the
  missing `assets.manifest.json` (`artifacts/prd570-desktop-c579311ed/`). The geometry-only crowd
  now ships the standard empty manifest in `public/`; Crowd build copies and parses it at
  `dist/assets.manifest.json` as `{"version":1,"entries":{}}`. The native desktop box remains
  open pending rerun with the built dist asset root.

- 2026-10-12, manager verification: all 60 focused animation/projection/GPU-series tests pass (2.15 s), and `artifacts/prd570-functional-bfa55ee5f/manager-run-1/` passes the 14-resource 128-auto hardware scenario with 120 observed main/shadow samples. The subsequent native run at `artifacts/prd570-desktop-c579311ed/` passed every resource but failed its one missing asset-manifest request. The standard empty manifest was staged, the game bundle rebuilt, and `artifacts/prd570-desktop-210264de2/` passes the full desktop scenario from the dist asset root. These are functional/native proofs, not CPU or GPU savings measurements.

- 2026-10-12, matched visual evidence prepared for the fresh judge: the fixture-only `crowdFocus=10|40|120` query selects the existing near/mid/far depth bands (10+row, 40+row, 120-row) without changing the default mixed-distance performance view. `crowd-rate-visual.playtest.json` captures the animated 128-rig arm at 1280×720 after the same fixed 120-tick step. Rate-1 and auto pairs used the same Vite build, camera position `[0,3,0]`, light/material setup, render tick 180, and NVIDIA/Turing WebGPU adapter; all six runs passed with zero console/network/runtime diagnostics and nonblank 1280×720 PNGs. Flat pairs are in `artifacts/prd570-visual-210264de2/rate1/` and `artifacts/prd570-visual-210264de2/auto/`; `pnpm visuals:ab --before artifacts/prd570-visual-210264de2/rate1 --after artifacts/prd570-visual-210264de2/auto --out artifacts/prd570-visual-210264de2/visual-ab` created the 3-pair blind bundle and exited 2 awaiting judge verdicts. The visual box remains open pending the manager's fresh judge.

- 2026-10-12, camera-target policy red-green and final-policy visual recapture: the manager's unparented animated target at `z=-120`, observed through `camera.lookAt(target)`, first reported `rate=4` instead of the required full rate. `RenderCameraCull` now promotes each known world bound independently only when it intersects the camera's forward centre ray; camera-parented rigs retain their existing protection, retargeting recomputes the promotion, and off-centre/off-frustum rigs keep the normal screen-size policy. No closest-object choice or per-frame bounds recomputation was added. The direct target, retarget-away, and projected-`SkinnedBatch` regressions are green with `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts packages/core/__tests__/projection-skinned.spec.ts packages/core/__tests__/render-camera-cull.spec.ts` (3 files, 64 tests); `pnpm --filter @threenative/core build` also passes.

  The visual fixture now freezes only after its normal `beforeRender` update at `crowdFreezeFrame=120`, without forcing a final evaluation, and exposes `visualRenderFrame`, `visualLogicalSeconds`, `visualEvaluationTimes`, `visualRates`, `visualEvaluated`, and `visualThrottledRigs`. Final rate-1 captures report frame 120, 2 seconds, 128 rate-1 rigs and zero throttled rigs. Final auto captures report frame 120, 2 seconds, 112 throttled rigs; the retained 40 m witness has rates `1×16, 2×49, 4×63`, and the 120 m witness has `1×16, 2×53, 4×59`. All six corrected-policy runs used the same 1280×720 NVIDIA/Turing WebGPU build, camera/light/material setup and matching focus bands (`10+row`, `40+row`, `120-row`), with zero diagnostics and nonblank PNGs. Final pairs are in `artifacts/prd570-visual-camera-target/rate1/` and `artifacts/prd570-visual-camera-target/auto/`; the rebuilt blind bundle is `artifacts/prd570-visual-camera-target/visual-ab/blind/`. `pnpm visuals:ab ...` exited 2 only because it awaits the manager's judge verdict; the visual box remains open.

- 2026-10-12, public contract/discovery completion: `packages/core/src/index.ts` now documents
  `updateRate: "auto"` as the default camera policy, `updateRate: 1` as full evaluation, another
  positive safe integer as a requested frame interval, and `updateRateReport` as the effective-rate,
  override-status and latest-evaluation report. It names the full-rate protections without changing
  runtime behavior: one-shots/fades, root-motion `AnimationComposer`, automatic camera-ray targets
  and camera-parented rigs. All 13 shipped template `AGENTS.md` files carry the same authoring
  convention and their generated `CLAUDE.md` mirrors are synced. The draw-cull class comment no
  longer misstates the animation-only camera-ray exemption.

  `pnpm sync:agents` passed (`25` mirrors checked, `13` written); `pnpm capabilities:sync` passed
  (`439` entries, `6` not-owned rows, `427/427` package-backed scaffold imports, `0` unresolved),
  regenerating both capability manifests and the capability reference. The focused capability,
  mirror and scaffold checks passed 8 files/72 tests; `pnpm check:docs` passed 3,087 links across
  1,361 Markdown files; Biome passed with only the two existing camera-cull complexity warnings.
  The visual, performance and shooter boxes remain open for the manager's actual gates and
  independent judge/review.

  The 2026-10-13 follow-up compacted the shared updateRate paragraph to one physical line so all
  templates remain under 100 lines; the scaffold constants were refreshed from all 13 actual
  no-install trees after genuine 65-pass/1-hash-failure hash measurements.

- 2026-10-12 (independent visual judgment, current camera-target build): a fresh read-only `gpt-5.6-sol` reviewer inspected all eight shuffled captures in `artifacts/prd570-visual-camera-target/visual-ab/blind/`, including duplicate controls, at actual render frame 120 and logical 2.0 seconds. Corrected scoped pose-integrity scores are 5/5 for every sample: no visible pose loss at 10/40/120 m against rate 1. The initial blank observation for sample-02 was rejected: it is byte-identical to sample-01 (SHA256 `e762bb465f89237bb88ac856eca2cda4055a6fe1bd10cc1d3af35e0905b5a908`); sequential image inspection corrected the verdict. Reviewer session `01a133c3-7425-77b0-ae9f-94956a9a0a3a`. These stills prove pose integrity, not temporal smoothness or a commercial-template art score. `visuals:ab` built the blind bundle and exited 2 pending its separate generic template-quality verdict schema; no generic visual-quality gate is claimed. The combined Phase 2 AC-1 box stays open until CPU reduction is verified.
- 2026-10-12 (manager verification after camera-target repair): the current animation-rate, projection-skinned and render-camera-cull specs pass 64/64 across three files; `pnpm api:surface:check` passes for 14 packages and 413 symbols. Full final verification remains pending.

- 2026-10-12 (AC-1 measured): immutable production bundle, matching NVIDIA 615.71.09 userspace/kernel, RTX 2080 / NVIDIA Turing WebGPU. Four 128-rig runs in rate1 → auto → auto → rate1 order, each with startup window 1 discarded and three complete 120-render windows. Combined AnimationPlayer.update + full SkinnedBatch.write call CPU means: pair A 3.987 → 2.130 ms (46.57% lower); reversed pair B 2.667 → 1.420 ms (46.75% lower). Both pairs exceed 40%; aggregate 46.64%. Every window is ready, with 128 animation/palette calls per frame, 120 span/render frames, 120 main/shadow timestamp samples, 3/1 main/shadow draws, 70,659/70,656 triangles, pinned 1280×720 scale 1, 4× samples. Each scenario and `playtest perf --require-windows 3` passes. Artifacts and immutable bundle hashes: `artifacts/prd570-final-series-attempt1/`. Background CPU load varied (roughly 17–23), so absolute CPU/FPS figures are not quiet-machine throughput claims; both independently paired reduction ratios agree within 0.2 percentage points. The fresh matched visual judgment above completes the Phase 2 AC-1 box.

- 2026-10-12 (Phase 1 CPU attribution): rate-1 animated controls from the same immutable production build and RTX 2080 series: 32 rigs: animation 0.563 ms + palette-call 0.287 ms = 0.850 ms; 128 rigs: animation 2.552 ms + palette-call 0.775 ms = 3.327 ms; 256 rigs: animation 4.703 ms + palette-call 2.673 ms = 7.377 ms. Per run, startup window 1 is discarded; three complete 120-render/span windows pass scenario readiness and `playtest perf --require-windows 3`. The 128-rig result combines both reversed-order control runs. These are measured call costs under the recorded shared-host CPU load, not quiet-machine FPS claims. GPU observations from this first series are retained but not used to decide Phase 3 because competing Chrome/native runs overlapped; the locked repeat is pending.
- 2026-10-12 (final static qualification): `pnpm typecheck` and `pnpm lint` both exit 0 after the camera fix and public convention documentation. Logs: `artifacts/prd570-final-typecheck.log` and `artifacts/prd570-final-lint.log`.

- 2026-10-13 (qualification repair): the whole root unit phase completed with 10,180 passing, 28 failing and 20 skipped tests across 778 files. Four failing suites were a stale installed Three patch plus an AST timeout; `pnpm install --frozen-lockfile --force` restored the canonical dependency patch, the shipped patch helper now reports unchanged, and all four suites pass 59/59 with ordinary test timeouts. The two template suites exposed genuine instruction-length and stale scaffold-fingerprint regressions: `39b9a3de6` compacts the convention, regenerates mirrors and refreshes all 13 actual no-install tree hashes; focused scaffold 66/66 and template 38/38 pass. The whole unit phase has not been rerun after these repairs; its earlier failure is not reported as a whole-suite pass.
- 2026-10-13 (native package qualification): canonical V8 contract targets and the QuickJS host/timestamp/rg11b10 targets built locally using the existing CI recipe. `taskset -c 0-1 pnpm --filter @threenative/runtime-native test` exits 0: 137 files, 1,581 passing and 62 skipped tests, plus 29 physics-contract tests, 23 Rust tests and strict publint. The earlier eight missing-executable failures are resolved; the isolated SIGKILL startup check also passes without a source change. Current animation/projection/camera focused tests pass 64/64 after dependency repair.
- 2026-10-13 (measurement protocol refresh): the crowd fixture advances animation exactly once per actual draw, so the shipped runner `--live-clock` option is used for fresh cost measurements against the rebuilt canonical dependency candidate. The exact three-window scenario passes its original 15 assertions, with no new triviality waivers. A transient missing-bridge launch was diagnosed with runtime/scene doctor and passes unchanged against the owned persistent Vite preview server; failed launch artifacts are retained and excluded from cost results. Fresh paired CPU/GPU and repeated visual proof remain pending; no quiet-machine FPS claim is made under the recorded shared-host load.

- 2026-10-13 (canonical live-clock GPU decision): all 14 arms in `artifacts/prd570-canonical-live-series-attempt2/` pass the original 15 scenario assertions. Startup window 1 is excluded; each arm supplies three complete 120-frame windows with 120 main and shadow timestamp samples. Held/static surface and full pass topology match at each count. The prespecified conservative bound (maximum held main-plus-shadow window minus minimum static window, including both reversed 256-rig pairs) is 0.0 ms at 32 rigs, 0.1 ms at 128, and 0.1 ms at 256. All bounds are below 0.5 ms, so Phase 3 declines skin-once on the named NVIDIA/Turing RTX 2080. The 256-held low-clock window remains included; it cannot improve this upper bound. Immutable bundle hashes are retained with the series. All 14 arms also pass `playtest perf --require-windows 3`.
- 2026-10-13 (AC-1 reopened): the rebuilt canonical candidate live-clock CPU pairs measure 3.020 to 2.167 ms (28.25% lower) and 3.757 to 2.270 ms (39.57% lower), below the required 40% in both pairs. Earlier scripted-clock success is historical and does not close current acceptance. Shared desktop scheduler contention is recorded; a quiet laptop comparison is requested before deciding whether implementation optimization is needed. The first quiet job exits 75 at the capacity guard, so it produced no measurement; `prd570-quiet-cpu-retry` is the replacement. Shooter qualification on the laptop also exits 1 and AC-2 remains open.
- 2026-10-13 (current native rerun): after the canonical dependency repair and candidate rebuild, the current V8 desktop crowd again passes all 15 assertions, including readiness, animation/palette spans, main/shadow observations and clean diagnostics. Artifacts: `artifacts/prd570-native-canonical-28c4/` and its CLI log. The initial launch used a relative scenario with an explicit project root and failed path resolution before execution; rerunning the same scenario by its required absolute path passes unchanged.
- 2026-10-13 (shooter current result): the existing laptop scaffold suite completes 33/34 scenarios successfully. Only `performance` fails: frame p95 127.8 ms against 33 ms, FPS 21.05 against 30; draw calls 1,177/1,300 and triangles 420,933/500,000 pass. All gameplay scenarios pass, but AC-2 still requires the complete suite. Source receipt is clean `39b9a3de6`, with identical runtime inputs to `28c4d8ff2`; the log and preserved scaffold are on the laptop under `prd570-final-gates` and `/tmp/threenative-template-playtests-ycy7z2`. No threshold is waived.
- 2026-10-13 (canonical repeated visual proof): all 12 fresh headed Chromium captures from the rebuilt candidate pass: two independent runs per rate1/auto arm at 10/40/120 m, burned-in BEFORE/AFTER labels, fixed render frame 120 and logical 2.0 seconds, complete per-run pose/rate/evaluation-time provenance, NVIDIA/Turing adapter and immutable bundle hashes. The new bundle hash is `6a167ef23aa64056916b49fbea2d9c69a19066f872af526fde24b5f4de225ea9`; all 12 PNG hashes exactly match the earlier independently judged set. A fresh pinned `gpt-5.6-sol` read-only reviewer opens all images sequentially at original resolution and returns PASS: no visible pose loss in any of the six matched pairs. Artifacts: `artifacts/prd570-visual-canonical-28c4/`; reviewer log: primary checkout `.linchpin/pr487-canonical-visual-judge.log`. João explicitly accepts unchanged visuals for this performance change. Stills establish pose integrity only; the combined Phase 2 box remains open because current CPU acceptance fails.
- 2026-10-13 (canonical root unit rerun): 10,204 tests pass; one scaffold-build subprocess exceeds its existing 60-second exit ceiling, and one asset-health worker exits unexpectedly. Comparing all 778 planned files with the 777 completed summaries identifies `packages/assets/__tests__/health.spec.ts` as the missing suite. Both affected specs are rerunning with one worker; no timeout or assertion is relaxed. The whole run exits 1, including one retained temporary directory, so it is not a whole-suite pass. Log: `artifacts/prd570-unit-canonical.log`.
- 2026-10-13 (canonical package board): the root package-test phase passes with prebuilt outputs and serial package scheduling, including the current native contracts, all package test/publint scripts and no temporary-directory growth. `TN_SUITE_PHASES=package-test TN_SUITE_PREBUILT=1 TN_SUITE_PACKAGE_CONCURRENCY=1 pnpm test` exits 0. Log/status: `artifacts/prd570-package-canonical.log` and `artifacts/gates/prd570-package-canonical-status.json`.
- 2026-10-13 (focused unit failures resolved without edits): the unchanged scaffold build and asset-health specs pass 85/85 with one worker, including the original 60-second build exit assertion. Log: `artifacts/prd570-unit-failure-focused.log`. This clears the two observed cases, while the failed full-run status remains recorded honestly.
- 2026-10-13 (hidden-slot cache repair): the new rate-4/8 regression was red before the fix: after `hide`, a skipped `AnimationPlayer.update`, `restart` and `write`, both palettes remained all zero. `SkinnedBatch` now indexes rigs by slot and invalidates only the returning/hidden rig's evaluation and world-transform cache before the existing write guard. `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts -t 'rewrites a hidden slot'` is green with 2/2 tests; full affected focused tests remain pending after the remaining review findings.
- 2026-10-13 (camera-policy ordering repair): the engine-order regression was red before the fix: `RenderCameraCull.apply` had run, but `cullsBeforeBeforeRender` was `0`, so a beforeRender animation update and the following palette pack could use the previous camera rate. The existing single cull now publishes metadata before beforeRender and projection reconciliation; no duplicate cull was added. `pnpm exec vitest run packages/core/__tests__/game.spec.ts -t 'applies camera animation policy before beforeRender projection work'` is green with 1/1 test. Native, CPU and visual proof remain reopened for the final repaired build.
- 2026-10-13 (loop-listener timing repair): the new short-clip red reproduced Three.js event coalescing: over 60 ticks, rate 1 delivered 20 `loop` callbacks with `loopDelta: 1`, while rate 8 delivered 7 callbacks with `loopDelta: 2` or `3` at later ticks. `AnimationPlayer` now uses an internal mixer subclass that tracks only official `addEventListener`/`removeEventListener` registrations for the public `"loop"` event; an active listener promotes that player alone to effective rate 1, preserving `{ action, loopDelta }` timing without forcing all repeating clips to rate 1. The focused regression is green, and the four affected files pass 124/124: `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts packages/core/__tests__/projection-skinned.spec.ts packages/core/__tests__/render-camera-cull.spec.ts packages/core/__tests__/game.spec.ts`. `pnpm --filter @threenative/core typecheck` also exits 0. The public AnimationPlayer/SkeletalMesh3D JSDoc now names this protection; native, CPU, visual and shooter gates remain manager-owned and open.
- 2026-10-13 (loop-listener registration boundary repair): a real public-API red advanced both rate-1 and rate-8 players for six ticks on a 0.05-second loop with no listeners, then registered the first listeners; rate 8 replayed an unobserved `loopDelta: 2` at registration frame 6 while rate 1 had no event until frame 8. `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts -t 'starts a newly registered loop listener after skipped time'` failed before the fix. The mixer now consumes pending player time before the first loop listener is installed, so registration observes only later loops with the same frame, delta and clip; duplicate listener adds remain set-like, the last removal restores rate 8, and listener additions from mixer callbacks do not reenter pending synchronization. The focused animation spec passes 31/31, including those boundary cases. Public JSDoc and generated capability manifests/reference now state that skipped pre-registration loops are not replayed; capability/doc checks pass 5 files/78 tests. Native, CPU, visual and shooter gates remain manager-owned and open.
- 2026-10-13 (draw-cull ordering repair): a real game-order red used a `0.1`-radius mesh at `z=-1000`, moved by `beforeRender` to `z=-10` with its world matrix updated; the old pre-callback `RenderCameraCull.apply` hid it before the callback, so `pnpm exec vitest run packages/core/__tests__/game.spec.ts -t 'culls after beforeRender moves geometry into camera space'` failed with `drawnVisibilities.at(-1) === false` instead of `true`. `RenderCameraCull.prepareAnimation` now publishes camera-parent and centre-ray animation metadata before `beforeRender`/projection packing without changing draw visibility, while the one actual `apply` runs after projection reconciliation, clustered meshes and LOD against the final render root. The same focused core command passes 125/125; `pnpm --filter @threenative/core typecheck` exits 0 and the touched-file Biome check exits 0 with eight existing complexity warnings. Native, CPU, visual and shooter evidence remains open for the corrected build.

- 2026-10-13 (final regression candidate `498745bc0`): full typecheck and lint exit 0; four affected core suites pass 128/128. `pnpm check:docs` exits 0 and the six documented doc/CI contract suites pass 246/246. Twelve fresh, separately launched, labeled physical RTX captures at 10/40/120 m all pass and every PNG is byte-identical to the previously independently judged canonical set; immutable bundle `4de0de81c394915a6f6f4d84730fc34c095d9ba2fdbd81d8f77f88f66bd355cb`, artifacts `artifacts/prd570-visual-498745bc0/`. This preserves the accepted no-visible-pose-loss result and does not claim temporal smoothness or a new art win.
- 2026-10-13 (current native verification): rebuilt core, browser and desktop crowd bundles from clean `498745bc0`; Linux V8/Dawn with the matching NVIDIA 615.71.09 environment reports RTX 2080/Turing and passes all 15 assertions with zero diagnostics. The first CLI process ended without its final verdict and is not counted. A bounded 120-second invocation of the same exported CLI `main`, held alive until its promise settled, returns the complete passing report at `artifacts/prd570-native-498745bc0-keepalive.log` with raw observations in `artifacts/prd570-native-498745bc0-keepalive/`. No assertion, runtime or host configuration changed.
- 2026-10-13 (loaded-host protocol authorization): João explicitly authorizes preserving existing jobs while running the comparison with host load recorded, rejecting unstable data, and retaining all acceptance criteria. This overrides only the laptop skill's quiet-wait requirement. The clean final candidate is synchronized to the owned laptop lane; six bounded arms are ordered rate1/auto/auto/rate1 at 128 rigs, followed by 32/256 rate1 attribution. All three post-startup 120-frame windows are retained; both ordered pairs must reduce combined animation/palette CPU by at least 40%, and any 128-rig within-arm CV above 15% makes the comparison inconclusive. Results will be labeled loaded-host measurements, with no quiet-host or FPS claim. Current job `prd570-loaded-498745bc0` is waiting for another lane's GPU lock; all unrelated jobs remain active and untouched.

- 2026-10-13 (review-round-2 runtime repairs): four production-order/public-API red cases were reproduced and fixed without changing policy thresholds. The game-order case proved an exact projection proxy could carry the new authored local matrix while final culling still read its stale world matrix; the existing `MatrixWorldPass` now runs before final culling, and the projection-enabled `beforeRender` regression is green. The public `AnimationAction.warp()`, `halt()` and warp-enabled `crossFadeFrom()` cases matched an unwrapped Three mixer at rate 1; grouped stride scaling remains intact, and a throttled warp remains active. A finished-callback listener-registration case now delivers a later same-update loop event instead of suppressing it. Exact projected mirrored/non-uniform skinned sources now carry the existing animation-source ownership metadata; off-centre sources throttle while centre-ray and camera-parented sources remain full-rate. Red/green proof: `pnpm exec vitest run packages/core/__tests__/game.spec.ts -t "refreshes exact projection proxies before the final camera cull"`, `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts -t "preserves Three action time-scale interpolation|does not cancel a public warp|warp-enabled public crossfades|delivers later loop events"`, and `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts -t "observes animation roots behind exact projection proxies"`; the full affected focused set is green at 134/134 and `pnpm --filter @threenative/core typecheck` exits 0. Native and current CPU evidence are reopened for a final build; no unrun acceptance box is ticked.

- 2026-10-13 (public time-scale interpolation repair): the source-hash-guarded diagnostic reproduced raw Three drift after a duration-10 clip's public `warp(1, 2, 0.5)` at rate 4/8 (`+0.023333332936`/`+0.055000011126` seconds) and `halt(0.5)` (`-0.023888885789`/`-0.050000002297`); rate 1 matched. The player now flushes pending time before public `warp`/`crossFadeFrom`, tracks only those official action calls, protects the effective rate at 1 until each interpolant settles, and avoids stride sync cancelling it. The red-green cases compare clip time, effective time scale and evaluated-frame rate against an unwrapped Three mixer at rates 1/4/8, include skipped time before warp, unequal-duration warp-enabled crossfades and a mixer-callback warp; the full animation-rate spec passes 36/36. All four affected focused suites pass 135/135, core typecheck exits 0, and focused Biome plus `git diff --check` pass with six existing complexity warnings. Native evidence is reopened because runtime changed after the manager's `498` proof; CPU, AC-1, visual and shooter gates remain open. No generated capability contract changed.

- 2026-10-13 (final loaded-host execution plan): `067b2fed2` repairs the remaining public interpolation drift. The prior laptop job `prd570-loaded-498745bc0` was cancelled while queued, before execution, because final review required further repairs; it produced no measurements. Two later laptop capacity probes refuse launch at 97–98°C. The authorized bounded comparison therefore uses the existing physical RTX desktop display and matching NVIDIA environment, retaining every other job and the same preregistered six-arm order, three post-startup windows, 40% paired reduction threshold and 15% sample-CV stability limit. No capacity threshold, power setting, model or configuration is changed; results remain loaded-host measurements.

- 2026-10-13 (final-runtime CPU attribution, acceptance inconclusive): runtime `067b2fed2` was unchanged before, after and throughout all six ordered physical-display arms; core bundle digest starts `63efed62`, crowd bundle digest `570c8271`. All six scenarios and `playtest perf --require-windows 3` exit 0; every one of the 18 retained post-startup windows contains 120 frames with zero overflow. Observed mean `AnimationPlayer.update / SkinnedBatch.write` milliseconds: 32 rate-1 rigs 1.050 / 0.360; 128 rate-1 pair A 4.467 / 1.743 and pair B 2.280 / 0.803; 256 rate-1 rigs 6.477 / 3.407. These are loaded-host observations (Ryzen 9 5900X, 24 threads, load 30–40, 81–85°C; physical RTX 2080, matching NVIDIA 615.71.09, 1280×720, timestamp-query), not quiet-host throughput. Paired total-cost reductions are 54.97% and 53.62%, but rate-1 A and auto A sample CVs are 25.77% and 75.14%, above the preregistered 15% ceiling. The entire comparison is INCONCLUSIVE, so AC-1 and the combined visual/CPU box remain open. All windows are retained; no retry or favorable-window selection occurred. Artifact: `artifacts/prd570-proof-067b2fed2/cpu-summary.json`. Visual and native gates were not run by this CPU-first lane. CPU cost reporting closes Phase 1; acceptance still needs a stable comparison.

- 2026-10-13 (supplemental loaded-host attempt, rejected): the separate isolated-display attempt `artifacts/prd570-loaded-isolated-269ccc95b/` retained all three predefined windows for four paired 128-rig arms and 32-rig attribution. All five scenarios passed, but metadata-only PRD commits tripped its broader HEAD guard before the 256-rig arm; runtime code and measured bundle bytes remained unchanged. The partial comparison is not accepted: observed pair reductions 77.01%/54.10% coexist with sample CVs 17.61%/26.66%/95.14%/33.91% across the four 128-rig arms, all above the 15% ceiling. No arm is rerun or window discarded to seek a win. The already complete same-runtime six-arm artifact above supplies CPU attribution and remains INCONCLUSIVE for AC-1. All unrelated jobs/background tests were preserved; no models, repository configuration or power settings changed. Current native/visual, shooter and full workspace qualification remain open for the final runtime.

- 2026-10-13 (current native and visual refresh): the same final runtime `067b2fed2` passes all 15 native crowd assertions on Linux V8/Dawn with the physical RTX 2080/Turing adapter and zero diagnostics. Rebuilt the native entry with `pnpm --filter skinned-crowd build:desktop`, then awaited the exported shipped CLI `main` with a keepalive and 120-second bound; the complete report is `artifacts/prd570-native-067b2fed2.log`. Twelve separately launched labeled physical WebGPU captures in `artifacts/prd570-behavior-067b2fed2/visual/` all pass: two per rate1/auto × 10/40/120 m, render frame 120, logical time 2 s, frozen state and 128 rate observations; auto throttles 112–118 rigs while rate1 throttles zero. Every PNG is byte-identical to the canonical set already opened and independently judged as no visible pose loss, preserving the user-accepted unchanged-visual result. Immutable visual bundle: `7f266d0c40d45606f7ef2954c084e6b0eb9a014cd2e38b0fcfe8924aa2d59374`. The combined CPU/visual box stays open because AC-1 is inconclusive. Full workspace typecheck passes; full lint found one test-formatting error, being corrected separately.
- 2026-10-13 (origin/develop integration): merge resolution for `5e2a9d3d3` retains both PRD-570 `updateRate` guidance and PRD-569 particle `onCull` guidance. The existing scaffold hash helper first observed 65/66 with only `action-rpg` stale, then passed 66/66 after recording measured hash `4b5b69696ed344b4306d71a1040ce86d34e5d815e17c7fdc61e5d86d38437262`; the other 12 values were unchanged. Template/generated contracts pass 51/51, affected core contracts pass 159/159, `pnpm capabilities:check`, `pnpm sync:agents --check`, core typecheck, focused Biome and `git diff --check` pass. The native box remains open for a fresh whole-build run after this merge.
