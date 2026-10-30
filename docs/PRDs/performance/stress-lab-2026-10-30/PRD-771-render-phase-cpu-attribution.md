# PRD-771 — Account for the whole main-thread frame on the Wasm engine

**Status:** NOT STARTED — an offline profile accounts for most of the frame; no stage meter publishes it yet.
**Priority:** P1 — the 120 fps goal needs CPU frame p95 from about 14.6 ms to 8.33 ms, and every lever below must name a measured ceiling first (Phase 1).
**Owner:** João · 2026-10-30
**Depends on:** PRD-770 Phase 1 for pinned arms. Reuses the producers of PRD-762 (`Spans.ts`, `FrameCounters.ts`, `frame-budget.ts`, `waste_counters.h`); adds no second meter.

## Why

The stress report's `renderP50Ms` ("JS render", 16.18 ms in row #44) is not JavaScript. It wraps the synchronous
`_tnw_web_render()` call, so it includes the C++ plan, the WebGPU phase and any driver wait. The owner's external audit
(2026-10-30) asked to split it before any C++ migration. That is right, and this PRD does it.

What the profiles already show, on develop `0974fd3b8` in the clean hunt Brave (`hunt/tr1-base.cpuprofile`, `ta1-base1`,
04:31-04:35Z; ms per frame):

- **Main thread:** busy 14.6 of a 16.7 ms vsync frame.
- **Wasm render:** 7.1 ms.
  - `renderPrepared` takes 5.1 ms, 1.4 of it self time.
  - prepare: 2.7 ms.
- **Other passes:** post 1.7 ms, compute 0.9 ms.
- **Update:** 2.3 ms, of which physics 0.85.
- **Animation-rate cull:** 0.94 ms.
- **JobPool:** idle about 99% of the frame (`HUNT-tr1.md` TR5).

Checked and closed, so not a lever:

- **`syncVirtualShadowLods` per pass.** The audit's first hypothesis. FS1 already cut it from 3.60 ms to 0.008 ms
  (`hunt/HUNT-main3.md:256`). A revision guard skips the walk (`packages/three-native/src/shadow-node.ts:36`).
- **The JS↔Wasm crossing count.** 739 crossings per frame cost about 0.1 ms (`getJsObject`, `bigintToI53Checked`,
  `growMemViews`), and FU4 cut the count with no frame gain.

## Validation scene

- **Consumer and scene:** the stress lab (`sandbox/stress-lab`, `main.html?stress`, `real` preset). The orbit and the
  walkers replay the same 40 s loop every run.
- **Hardware and window:** RTX 2080 at 1280x720. Measured with the PRD-770 fair window.
- **Controls:** `?stress&still` (inactive scene: meters must read near zero for the work that skips) and
  `?stress&noCrowd`.
- **Pass:** the published stages sum to at least 95% of the measured main-thread frame on both scenes.
- **Overhead:** turning the meters on costs under 0.1 ms per frame, measured as a paired A/B with meters off.

### Phase 1 — publish the stages

- [x] `TN_FRAME_BUDGET` and the stress report publish main-thread stages: JS update, JS orchestration before and after the engine call, Wasm plan (visibility, shadow page plan, draw pack), Wasm GPU phase (`writeBuffer`, bind groups, encode, submit), post passes, and idle. Each stage is p50 and p95 per window. proof: spec in `packages/core/__tests__/` plus a stress report Done 2026-10-30: `FrameStages.ts` + `FrameBudget.addStages`/`stagesAtP95`, `Renderer::CpuStage`, `RenderDatabase::sceneMs/rendererMs`, web host totals read in place (`tnw_web_frame` 78); unmeasured stages are absent, not zero (`frame-budget-stages.spec.ts`, `browser-renderer.spec.ts` "publishes no totals on a module without the array"); native `scene_stage_is_metered`, `overlay_leaves_stage_totals`; 176 native cases and 67 specs green on perf/stress-lab-120.
- [x] The stages sum to at least 95% of `frameP50Ms` on `?stress` and on `?stress&still`. proof: two reports from the PRD-770 window Done 2026-10-30: `stageSumP50Ms` = `frameP50Ms` on `?stress` (14.70) and `?stress&still` (14.36), coverage 1.00 over 6 + 2 runs (load <= 6, final Wasm `7e9276c7af99`). Named remainders `residual` 0.41 + `wasmOther` 0.39 ms are 5.5% of the frame; without them the named-with-a-cause share is 94.5%.
- [ ] Per-frame counts sit beside the stages: dirty transforms, casters re-planned, bytes uploaded, host (ABI) calls and JS allocation. These fill the dashboard's n/a cells. Reuse lane TM2's counters (`.worktrees/stress-fix-tm2`) where they are sound. proof: a report with no null in those fields Open 2026-10-30: dirtyTransforms (1509 / 4 still), castersMoving (537), hostCalls (735), gpuUploadKb (3399, buffer writes only) are live; `jsAllocKbP50` reads 0 under Brave's bucketed `performance.memory`, not a measurement, and TM2's texture-upload counter is not merged.
- [x] With the meters off, the stage code compiles out or costs under 0.1 ms per frame (paired A/B). proof: PRD-770 window, meters on against off Done 2026-10-30: `?stress` vs `?stress&tnStages=0`, 12 runs ABBA, 5 valid adjacent pairs: frame p50 on-off -0.14, +0.28, -0.04, +0.16, -0.03 ms (mean +0.05, median -0.03), under 0.1 ms. The first build that metered sibling renderers cost +0.23 ms (6/6 pairs) and was gated to the main renderer.

### Phase 2 — rank the levers

- [ ] Each stage over 0.3 ms gets a ceiling (its own ms per frame) and either an owning PRD or a closed entry in `PERFORMANCE-LEARNINGS.md`. proof: the ranked table added to this PRD Open 2026-10-30: ranked table below; `engineJs` (0.81 ms, 735 host calls) and `wasmTargets` (0.72 ms) have no owning PRD yet, and `residual`/`wasmOther` need a closed learnings entry.
- [x] The CPU p95 frames are split by cause: shadow refresh, crowd, GC or long task, and host load. Each p95 frame names one cause. proof: a report section from one window Done 2026-10-30: tail frames sit 5.3 ms above the median (20.0 vs 14.7): shadow refresh 3.78 ms (71%: wasmEncode +1.42, planVirtualPages +1.35, planShadowLists +1.01; gone in `still`), crowd and JS 1.17 (22%), other plan work 0.33 (6%), host load 0 (every run load <= 5.5). GC and long tasks are not separable from JS (65-91 long tasks per 80 s window).

Ranked stages, `?stress`, median of 6 runs, ms per frame (lane 771, 2026-10-30):

| Stage | p50 | p95 | Owner |
| --- | --- | --- | --- |
| wasmPlan | 4.00 | 6.17 | PRD-773 (planVirtualPages 1.81, planShadowLists 0.52), PRD-774 (rest of prepare, about 1.6) |
| wasmScene | 2.83 | 3.34 | PRD-772 (`Skeleton::updateAfterWorldWalk`, 1509 dirty transforms) |
| jsBefore | 2.65 | 3.94 | PRD-772 (JS rig step, subtree and matrix walks) |
| update | 2.26 | 3.11 | PRD-772 (mixer, bone palettes, crowd step) |
| engineJs | 0.81 | 0.93 | none yet (735 host calls; a crossing census by class) |
| wasmTargets | 0.72 | 0.83 | none yet (post-graph offscreen passes; candidate PRD-774 scope) |
| residual | 0.41 | 0.51 | remainder of the callback |
| wasmOther | 0.39 | 0.46 | remainder of `tnw_web_render` |
| wasmPost | 0.25 | 0.30 | under 0.3 ms |
| wasmEncode | 0.12 | 1.54 | PRD-773 (shadow encode on refresh frames) |

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: no wholesale port of JavaScript to C++. Only whole operations that this attribution prices
  above 0.3 ms move behind engine-owned commands, matching the audit's rule.
- In-flight related work:
  - FB1 tests link flags at `.worktrees/stress-fix-fb1`: mimalloc, `-sGROWABLE_ARRAYBUFFERS=2`, no memory growth.
  - FB1's measuring script hung while holding the measurement lock, so its numbers are not taken yet.
