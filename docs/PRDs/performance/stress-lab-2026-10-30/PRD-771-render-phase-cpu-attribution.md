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

- [ ] `TN_FRAME_BUDGET` and the stress report publish main-thread stages: JS update, JS orchestration before and after the engine call, Wasm plan (visibility, shadow page plan, draw pack), Wasm GPU phase (`writeBuffer`, bind groups, encode, submit), post passes, and idle. Each stage is p50 and p95 per window. proof: spec in `packages/core/__tests__/` plus a stress report
- [ ] The stages sum to at least 95% of `frameP50Ms` on `?stress` and on `?stress&still`. proof: two reports from the PRD-770 window
- [ ] Per-frame counts sit beside the stages: dirty transforms, casters re-planned, bytes uploaded, host (ABI) calls and JS allocation. These fill the dashboard's n/a cells. Reuse lane TM2's counters (`.worktrees/stress-fix-tm2`) where they are sound. proof: a report with no null in those fields
- [ ] With the meters off, the stage code compiles out or costs under 0.1 ms per frame (paired A/B). proof: PRD-770 window, meters on against off

### Phase 2 — rank the levers

- [ ] Each stage over 0.3 ms gets a ceiling (its own ms per frame) and either an owning PRD or a closed entry in `PERFORMANCE-LEARNINGS.md`. proof: the ranked table added to this PRD
- [ ] The CPU p95 frames are split by cause: shadow refresh, crowd, GC or long task, and host load. Each p95 frame names one cause. proof: a report section from one window

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: no wholesale port of JavaScript to C++. Only whole operations that this attribution prices
  above 0.3 ms move behind engine-owned commands, matching the audit's rule.
- In-flight related work:
  - FB1 tests link flags at `.worktrees/stress-fix-fb1`: mimalloc, `-sGROWABLE_ARRAYBUFFERS=2`, no memory growth.
  - FB1's measuring script hung while holding the measurement lock, so its numbers are not taken yet.
