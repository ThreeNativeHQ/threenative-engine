---
prd_contract: v1
---

# PRD-570 — A character costs what the camera sees of it

**Status:** PARTIAL — baseline instrumentation is implemented; runtime measurements remain unverified.
**Priority:** P2 — AC-1 is open: every rig evaluates its full pose every frame, near or far, on screen or off. Phase 1 has not yet measured how much that costs.
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
**Status:** PARTIAL — fixture and exact CPU spans implemented; accepted cost windows remain open because the local NVIDIA Vulkan driver is mismatched.
**Files:** `examples/skinned-crowd/src/scenes/Crowd.ts`, `examples/skinned-crowd/src/game.ts`, `examples/skinned-crowd/playtests/crowd-rate.playtest.json` (new), `packages/core/src/profiling/Spans.ts`, `packages/core/src/projection-skinned.ts`, `packages/core/__tests__/projection-skinned.spec.ts` (exact write probe).
- [ ] [local] The crowd scenario reports CPU milliseconds for `AnimationPlayer.update` and `SkinnedBatch.write` at 32, 128 and 256 rigs, with the result recorded under `## Decisions`. proof: `crowd-rate.playtest.json` with `playtest perf` and span probes.
- [ ] [local] The same scenario reports GPU milliseconds for skinned draws in the main and shadow passes, against an arm where the crowd is static. The result decides Phase 3 under `## Decisions`. proof: the same playtest, both arms, `TN_FRAME_BUDGET` `main`/`shadow` buckets.

#### Phase 2: Rigs evaluate at the rate their screen size earns
**Status:** PARTIAL — accumulated time, stagger, skipped writes and velocity-history coverage are implemented; visual, native and cost gates remain open.
**Files:** `packages/core/src/animation.ts`, `packages/core/src/projection-skinned.ts`, `packages/core/src/render-camera-cull.ts`, `packages/core/__tests__/animation-rate.spec.ts` (new)
- [x] [local] Accumulated `dt` keeps clip time, fade progress and the `finished` event identical to rate-1 playback over 300 frames, and a forced evaluation follows any skip longer than the rate. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts`. 2026-10-11 green: `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts` 26/26, red first on `updateRateReport` missing; rates 2/4/8 match rate-1 clip time over 300 frames, crossfade weights, interruption, weighted blends, `finished` timing and replay, forced evaluation, stop/pause/stride-rate integration all exact. Surface: `AnimationPlayer.updateRate` (`"auto"` | positive integer), `updateRateReport`, `update(dt, force)`. 111 existing animation/composition/cull regressions pass.
- [x] [local] Velocity history matches the pose that was drawn: zero on a skipped frame, the whole step on the evaluation frame, and no stale previous palette after a rate change or a first write. proof: a red-green case in `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`. 2026-10-12 green: the focused animation/projection run passes 42/42, including skipped-frame zero-history, evaluation-frame whole-step, rate-1 history and projected-batch auto-rate cases; the implementation commits as `172b80bf3`.
- [x] [local] Stagger offsets spread 128 rigs so that the evaluations in any one frame stay within 1.5× of the mean. Root-motion and `updateRate: 1` players never skip. proof: the same spec. 2026-10-11 green: same spec, 128 rigs at rates 2/4/8 over 240 frames, per-frame evaluations never exceed 1.5x the mean (mean = 128/rate); `updateRate: 1` and root-motion composers evaluate every tick. Auto-rate pixel bands (128/32/8 px) are provisional until AC-1's judge.
- [ ] [local] AC-1 passes. A fresh judge subagent compares 10 m, 40 m and 120 m captures against rate 1 and finds no visible loss. proof: `crowd-rate.playtest.json` plus `pnpm visuals:ab --before <rate1> --after <auto> --out <dir>`.
- [ ] [local] The native desktop host runs the crowd scenario with the policy on. proof: `node packages/playtest/dist/runner/cli.js examples/skinned-crowd/playtests/crowd-rate.playtest.json --target desktop`.

#### Phase 3: Skinning runs once per frame, if Phase 1 earns it
**Status:** NOT STARTED
**Files:** `packages/core/src/projection-skinned.ts`, `packages/core/src/render/velocity.ts`, `packages/core/__tests__/projection-skinned.spec.ts`
- [ ] [local] With the skin-once pass, the crowd's main-plus-shadow GPU time falls against Phase 1's arm, and the existing velocity-history assertions stay green. If Phase 1 shows less than 0.5 ms, the decline is recorded under `## Decisions` instead. proof: `crowd-rate.playtest.json` perf arms and `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`.


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
