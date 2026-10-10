---
prd_contract: v1
---

# PRD-571 — Exposure meters a histogram and ignores the sun

**Blocked:** 2026-10-10, filed under `BLOCKED/requires-physical-device/` — only the `## Blocked on` items remain.

**Status:** BLOCKED — 2026-10-10. Every box is ticked; only the `## Blocked on` items remain.
**Priority:** P2 — the shipped meter was a clamped linear mean, so a bright sky behind the subject still set the exposure. AC-1 and AC-2 are met in the browser and on the desktop host; the phone cost is blocked on the device.
**Complexity:** 2 (LOW) — 1–5 files (1): three identical template files, copied to 13 templates by the scaffolder, plus the existing fixture; no new module, no package change. Risk override: none.
**Owner:** João
**Commit names:** proofs cite `a0b7c91bc`, the tiled-gather commit before the rebase onto develop 07bcdf8d2. The rebase only re-pinned the starter scaffold hash for PRD-572's `AGENTS.md` change; the exposure sources are byte-identical. On this branch it is `e6e6bbba8`.
**Depends on:** None. Follows [PRD-339](../../done/PRD-339-the-frame-sets-its-own-exposure.md) (done), which shipped the mean meter and says a compute histogram "is a separate PRD if a game ever needs one" (PRD-339:106-107). This is that PRD. Judged with the tone gate of [PRD-341](../../done/PRD-341-a-frames-tone-is-a-number-and-the-number-is-a-gate.md) (done).

## Context

Auto exposure is generated template source. The three files are byte-identical in all 13
templates (`md5sum` on 2026-10-09): `src/render/exposure.ts`, `src/render/exposureGraph.ts` and
`src/render/autoExposure.ts`. It ships opt-in (`exposure.ts:29`, `enabled: false`).

What the meter does today (`templates/starter/src/render/`):

- `exposureMeter` (`exposure.ts:45-50`) takes linear luminance, clamps it to `[0.0001, 8]`, and
  weights the bottom of the frame more (`1 + uv.y`) so that ground counts more than sky.
- `reduceExposure` (`exposureGraph.ts:33-51`) averages 4×4 blocks, level after level, down to
  1×1 (`exposureReductionSizes`, `exposure.ts:85-97`).
- `adaptExposure` (`exposureGraph.ts:53-84`) turns the mean into a goal in stops,
  `log2(key) − log2(mean)`, clamps it to `[minStops, maxStops]`, and moves toward it at
  `rateUp` / `rateDown` in log2 space, with a snap for cuts.

PRD-339 already recorded why both textbook metrics fail (PRD-339:51-56): a log mean is wrong for a
mostly dark frame, and a clamped mean is wrong for a mostly bright one. In its reference, a
sun aureole over a tenth of the frame set the exposure, and the ground sat three stops under.
The clamp at 8 and the bottom weight reduce that error but do not remove it. A backlit subject
in front of a bright sky is still exposed for the sky.

[PRD-345](../../rendering/PRD-345-a-backlit-subject-is-not-a-hole-in-the-sky.md) fixes the backlit subject from the
material side. Its "Out of scope" section gives exposure to PRD-339 and PRD-343, and its
2026-10-09 decision points here for the metering side.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **The default method is the histogram.** `AutoExposureMethod = AEM_Histogram`
  (`Engine/Source/Runtime/Engine/Private/Scene.cpp:494`). The low and high percents are 10 and 90
  (`Scene.cpp:495-496`). The histogram covers log2 luminance from −8 to 4 by default, or −10 to
  20 EV100 when the extended range is on (`Scene.cpp:499-513`). The speeds are 3 up and 1 down
  (`Scene.cpp:519-520`).
- **64 bins.** `HISTOGRAM_SIZE` is 64 (`Engine/Shaders/Private/PostProcessHistogramCommon.ush:89-90`).
  The build pass gives each thread its own histogram in group-shared memory, adds pixels to it with
  atomic adds, and then merges (`Engine/Shaders/Private/PostProcessHistogram.usf:69-72`, `:99-102`,
  `:169-170`). A second pass reduces the group histograms (`PostProcessHistogramReduce.usf`).
- **The average ignores both tails.** The average walks the bins from dark to bright. It first
  removes the darkest `low percent` of the total weight, then keeps weight only until it reaches
  the `high percent`. The result is the weighted mean of the kept bins in log2 space, and it
  returns to linear with `exp2` (`PostProcessHistogramCommon.ush:150-186`). With 10/90, the
  darkest 10% and the brightest 10% of the frame do not move the exposure.
- **No weight means no change.** If nothing is left after the clip, the average falls back to the
  minimum luminance, not to a division by zero (`PostProcessHistogramCommon.ush:176-179`).
- **A meter mask weights the screen.** Each pixel's histogram weight comes from a mask texture
  (`PostProcessHistogramCommon.ush:37-38`, `:201-204`; used at `PostProcessHistogram.usf:141`).
  The default is a white texture
  (`Engine/Source/Runtime/Renderer/Private/PostProcess/PostProcessEyeAdaptation.cpp:792-805`).
  TN's bottom weight in `exposureMeter` is the same idea as a function of UV.
- **Adaptation runs in log2 space.** It uses exponential approach when the error is small and a
  linear rate when the error is larger than a start distance (`PostProcessHistogramCommon.ush:208-240`).
  TN already adapts in log2 space with a snap for large errors (`exposureGraph.ts:73-79`), so this
  PRD does not change adaptation.
- **Local exposure is separate, and neutral by default.** UE also ships a bilateral-grid local
  exposure (`Engine/Shaders/Private/PostProcessLocalExposure.usf`), but its contrast scales and
  detail strength default to 1.0 (`Scene.cpp:527-529`), which changes nothing. This PRD defers it
  (see Decisions).

## Solution

Replace the metric, not the pipeline. The goal, clamp, adaptation, snap, readback and lifecycle
from PRD-339 stay as they are. Only the value that `adaptExposure` reads as "scene luminance"
changes: it becomes the clipped histogram average instead of the 1×1 mean.

1. **Bins.** 64 bins over log2 luminance. The range comes from the settings the game already
   authors, so there is no new constant: from `log2(key) − maxStops` to `log2(key) − minStops`.
   With the shipped `−12..12` this is 24 stops, 0.375 stop per bin.
2. **Weight.** Each sample's weight is the existing `exposureMeter` weight (the bottom-of-frame
   preference). The luminance clamp at 8 is removed from the histogram path, because the
   percentile clip now does that job. The game can still edit both.
3. **Clip.** `lowPercent` and `highPercent` join `IExposureSettings`, at UE's 10 and 90. The
   average follows the UE walk above: remove the low tail, stop at the high tail, take the
   weighted log2 mean of what is left. Empty weight keeps the previous exposure (the existing
   `valid` select at `exposureGraph.ts:65-68`).
4. **Build.** Phase 1 chooses between two arms by measured cost:
   - **Gather arm (default if it is cheap enough).** One extra 4×4 level stores the log2
     luminance and weight per block. A 64×1 fragment pass then gives each bin one texel. That
     texel loops over the second reduction level (about 8,160 texels at 1080p) and sums the
     weight that falls in its bin. No compute, no atomics, and it runs on every backend that
     runs the current meter.
   - **Compute arm.** A TSL compute pass with workgroup atomics, like UE's. Use it only if the
     gather arm costs more than the phone budget below.
5. **Templates.** The three files stay byte-identical, so all 13 templates get the change in one
   edit. Exposure stays opt-in (`enabled: false`). Turning it on by default is outside this PRD.

The consumer flow does not change: the game opts in through `src/render/exposure.ts`, the render
chain installs `AutoExposureNode`, and `TN_AUTO_EXPOSURE` diagnostics report the result.

Risk: the 4×4 pre-average mixes a small sun disc with the sky around it before the histogram sees
it. This is acceptable because the goal is to ignore small bright sources. A fixture box proves
that a sun disc of 1% of the frame does not move the exposure.

## Acceptance Criteria

- [x] AC-1 [local]: In the auto-exposure fixture, a subject in front of a sky ten stops brighter is metered within the PRD-341 tone band. The current mean meter fails the same scene (red), and the histogram meter passes it (green). proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure-proof.spec.ts` (new `backlit` room; qualifier specs, 43 passed) and the GPU rooms `sh scripts/xvfb.sh pnpm exec tsx packages/create-threenative/__tests__/fixtures/auto-exposure/verify.ts`, exit 0 at a0b7c91bc. Histogram: `backlit-sky` tone mean 129.3, blackFraction 0; `backlit-disc` passes. Red control (the pre-change mean meter served from 2d212479255cf725f64343dc72aa2eafe9b7b92d): `backlit-sky-mean` and `backlit-disc-mean` fail the tone gate and move the target 6.2 and 5.5 stops. Visual judge (owner rule): headed `--browser-recipe webgpu` captures from `verify.ts` (adapter nvidia/turing RTX 2080 in every `capture.json`), two runs per arm, BEFORE and AFTER burned in large, judged by a fresh read-only subagent that did not write the change. Verdict IMPROVEMENT on all four pairs (sky and disc, run 1 and run 2), runs agree, no tile seams, banding or blown boxes. The mean frame is crushed to black, the histogram frame reads cleanly. The flat white strip in the sky room is the fixture's intended 10-stop band over the top 8% of the frame. Images: orphan branch `prd-571-screenshots` at f2b7936975bbc2226c3c1aa712149deec376737e.
- [x] AC-2 [local]: On the RTX 2080 browser WebGPU lane at 1080p, the histogram meter costs at most 0.1 ms GPU more than the mean meter. proof: `node packages/playtest/dist/runner/cli.js perf` on the fixture, both arms, `--browser-recipe webgpu`. Measured with `TN_COST_ROUNDS=8 TN_COST_SECONDS=45 sh scripts/xvfb.sh pnpm exec tsx packages/create-threenative/__tests__/fixtures/auto-exposure/measureMeterCost.ts` (alternating arms, the engine's own `TN_FRAME_BUDGET` `gpuMs`, `--enable-webgpu-developer-features`, 1920x1080, adapter nvidia/turing RTX 2080; logs in `artifacts/prd571-cost/`, readable with `perf --file <log> --allow-virtual-display --text`). Paired round deltas (histogram minus mean, ms): -0.123, +0.112, -0.038, +0.040, +0.007, -0.023, -0.164, +0.016; mean -0.021, standard error 0.031. Two earlier 3-round runs gave pooled deltas of -0.024 and +0.080. The meter is below the instrument noise (single rounds swing about 0.1 ms, one resolved sample per 300-frame window), so the claim is "not measurably above the mean meter", not "0.00 ms". The first single-stage gather cost 3.28 ms and was replaced by the tiled one (Decisions).

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Histogram exposure metric | Game sets `enabled: true` in `src/render/exposure.ts` → `AutoExposureNode` (`autoExposure.ts`) → `adaptExposure` | Replaces the 1×1 mean as the luminance input. The mean reduction stays only if the gather arm reads its levels. | AC-1, Phase 1 |

## Decisions

- 2026-10-09 (João, via the Unreal source review): local exposure (UE's bilateral grid) is
  deferred. UE ships it neutral by default (`Scene.cpp:527-529`), so it is not part of UE's
  default look, and PRD-345 covers the backlit subject from the material side. A game that needs
  it after this PRD gets a separate PRD.

- 2026-10-09 (PRD-571 lane): the Solution's gather arm, as first written (one 64x1 pass looping the
  second level, about 8 160 texels per bin), cost 3.28 ms GPU at 1080p on the RTX 2080 and missed
  AC-2 by 30x, because 64 threads each ran the whole loop. The compute arm was not needed. The
  gather now draws a 64-bin by 64-tile target (each texel loops about 130 block texels) and a 64x1
  pass sums the tiles. It stays fragment-only and runs on every backend that runs the mean meter.
  The meter's luminance clamp moved from 8 to 65 504 (half-float overflow guard only), as the
  Solution says.

## Blocked on

- Pixel 8 cost: the histogram meter costs at most 0.2 ms GPU more than the mean meter, measured
  with `node packages/playtest/dist/runner/cli.js perf --logcat <serial>` on both builds. Needs the
  Pixel 8 attached to this desktop (only `emulator-5554` was visible on 2026-10-09). Owner: João.
  An emulator result cannot stand in for the device.

## Execution Phases

#### Phase 1: The histogram metric in the fixture

**Status:** DONE (2026-10-09)
**Files:** `packages/create-threenative/templates/starter/src/render/{exposure,exposureGraph,autoExposure}.ts`; `packages/create-threenative/__tests__/fixtures/auto-exposure/fixedRooms.ts` (new `backlit` room); `packages/create-threenative/__tests__/auto-exposure*.spec.ts`
**Implementation:** Add `lowPercent` and `highPercent` to `IExposureSettings` and validate them (`0 <= low < high <= 100`). Build the gather arm. Record the gather and compute costs. Keep the compute arm only if the gather arm misses AC-2.

- [x] The clipped average matches a CPU reference of the UE walk on synthetic histograms: all weight in one bin, a uniform spread, an empty histogram, and `low == high`. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts` — 1 file, 33 tests passed. The GPU graph is checked against the same reference by the in-page histogram probe inside `verify.ts` (`histogram-reference` room, exit 0).
- [x] A sun disc covering 1% of the frame moves the settled exposure by less than 0.1 stop. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure-proof.spec.ts` (43 passed) plus the GPU room `backlit-disc` in `verify.ts` (gate `maxShiftStops` 0.1): the settled target moved 0.035 stop against the disc-free room, exit 0 at a0b7c91bc.
- [x] The existing static, cut, cold-boot and lifecycle fixture scenarios still pass with the histogram metric. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure-proof.spec.ts packages/create-threenative/__tests__/auto-exposure-lifecycle.spec.ts` — 2 files, 61 tests passed. GPU scenarios at a0b7c91bc, each exit 0: `verify.ts` (23 captures: static, cuts, reverse, snap, mutations), `verifySnap.ts`, `verifyLifecycle.ts`, `verifyColdBoot.ts` (20 launches, limit 0.1). The metered luminance of the bright room changed from 3.896 to 3.058 by design (clipped log mean), so the cold-boot and native references moved with it.

#### Phase 2: All templates, native and the phone

**Status:** DONE — 2026-10-10.
**Files:** the same three files copied into the 12 other templates; `packages/create-threenative/agent-docs/references/auto-exposure.md`
**Implementation:** Copy the three files byte for byte. Document `lowPercent` and `highPercent` and say when to change them.

- [x] All 13 templates ship byte-identical exposure source with the histogram metric, and the scaffold test passes. proof: `pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure-scaffold.spec.ts packages/create-threenative/__tests__/scaffold.spec.ts` — 2 files, 79 tests passed; `md5sum` of `exposureGraph.ts` in `template-assets/` and the 13 templates gives one hash. `PRD_201_PARENT_SCAFFOLD_HASHES` is re-pinned for the 13 templates.
- [x] The desktop native host settles the static fixture with the histogram metric. proof: `node packages/playtest/dist/runner/cli.js packages/create-threenative/__tests__/fixtures/auto-exposure/native-static.playtest.json --target desktop`; run through its qualifier `TN_NATIVE_EXECUTABLE=<tn-linux/mystral built 2026-10-05> sh scripts/xvfb.sh pnpm exec tsx packages/create-threenative/__tests__/fixtures/auto-exposure/verifyNative.ts`, exit 0 at a0b7c91bc: 180 paired GPU readbacks, `native:vulkan/nvidia/NVIDIA GeForce RTX 2080`, terminal luminance 3.05789 (browser 3.05789), settled, scopes clean, validation negative arm fails as required. The host binary was prebuilt (no native rebuild in this lane); the change is template JS, so the host source is not part of this diff.
- [x] The reference doc names `lowPercent`, `highPercent` and the meter weight, and the doc checks pass. proof: `pnpm check:docs` — checked 2988 relative links across 1331 files, exit 0; `packages/create-threenative/agent-docs/references/auto-exposure.md` names all three.

Native contract correction (2026-10-10, PR478): the 65×33 contract fixture still expected the
unclipped weighted mean 2.065428175 (target −3.520372080 stops). Its dark column and bright row
carry 1.4768% and 4.0098% of the metered weight and align with the 16×16 reduction blocks, so
10/90 clipping leaves luminance 2 (target −3.473931188 stops). Updated only the fixture
expectation and added a regression using the existing independent `referenceClippedMean`;
product rendering, pixels and all native assertion tolerances remain unchanged. Reproduction:
`pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts -t 'odd native fixture'`
failed before the correction (expected 2, received 2.065428175). Focused proof:
`pnpm exec vitest run --maxWorkers=1 packages/create-threenative/__tests__/auto-exposure.spec.ts packages/create-threenative/__tests__/auto-exposure-proof.spec.ts`
passed, 77 tests; `pnpm --filter create-threenative typecheck` and focused Biome checks passed.
`pnpm check:docs` passed (3025 links); doc-link, evidence-budget and evidence-citation specs
passed (31 tests). PRD board/progress remain blocked-only, 6/6 phase and 2/2 acceptance boxes.
Native GPU contract and its validation-negative invocation remain unverified here: this checkout
has no `packages/runtime-native/build/tn-linux/threenative-exposure-graph-test` (ENOENT), and no
native build was run. Windows/macOS reruns and the Pixel 8 cost proof remain pending.
