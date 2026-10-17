# PRD-625 — Walking CPU tail at 120 fps

**Status:** NOT STARTED

**Priority:** P1 — Open: Machinefall `?scene=map-walk` walking CPU render p95 is 9.4–11.1 ms per window against the 8.3 ms target, and the GPU p95 has a walking window above 8.3 ms (AC-1, AC-2).

**Owner:** João
**Depends on:** PRD-478 (done: its shadow, submission and streaming phases, the settled-texture fix and the AC-3 visual pass are the baseline)

## Context

PRD-478 landed its three phases and passed its visual criterion, but its two timing criteria did not pass. They moved here on 2026-10-17 (see PRD-478 Decisions), with the measurements that close them unchanged.

The 2026-10-17 round ran on an RTX 2080 (Turing, headed, 1280×720, scale 1, live clock). It used three interleaved `map-walk` pairs, the PRD-478 candidate against a develop-equivalent build (the same source with PRD-478's five branch-only core files restored to its merge-base). The load average was 5.4–13.6. Per-window `TN_FRAME_BUDGET` results:

| Measure | PRD-478 candidate | Develop-equivalent |
| --- | --- | --- |
| CPU render p95, median per window | 9.4 / 10.7 / 11.1 ms | 8.7 / 9.5 / 10.2 ms |
| Windows over 8.3 ms (CPU) | 23 / 34 / 21 of 31–36 | 17 / 24 / 22 of 31–33 |
| GPU p95 (`gpuMain + gpuShadow + gpuOther + gpuCompute`), median | 2.9–3.0 ms | 2.9 ms |
| GPU windows over 8.3 ms | 1 / 3 / 1 (max 9.5 ms) | 1 / 1 / 1 (max 8.6 ms) |

- The CPU tail sits in the first 14–15 windows of each walk, at 9–29 ms in both arms. Later windows are mostly 7–9 ms.
- About 83 % of every window is walking (150 held ticks, 30 settle ticks per leg).
- Every run has one GPU window above 8.3 ms at window index 1 (tick about 600, right after the loading overlay comes down). The develop-equivalent has it as well.
- Console windows carry no per-frame tick, so no held-tick mask could be applied per frame.

The CPU tail is shared with develop, so it is not a PRD-478 regression. It is the remaining work toward 120 fps while walking.

## Acceptance Criteria

- [ ] AC-1 [local]: `map-walk` walking CPU render p95 ≤ 8.3 ms, read as the walk/idle split of `TN_FRAME_BUDGET` frames with the per-frame held-tick mask from Phase 1, over 3 interleaved pairs against develop on a quiet RTX 2080 (load below 10 throughout). proof: the Phase 1 mask report on the three pairs.
- [ ] AC-2 [local]: the same walking frames' GPU p95 ≤ 8.3 ms, from `gpuMain + gpuShadow + gpuOther + gpuCompute`. proof: the same report.
- [ ] AC-3 [local]: no visual loss against develop. 3 fresh blind raters score every `map-walk` and `map-views` pose at or above develop, and the pop series shows no late object, shadow or material. proof: `scripts/visual-ab.ts` score plus the pop series.

## Execution Phases

#### Phase 1: A per-frame walking mask
**Status:** NOT STARTED
- [ ] The frame budget reports each frame's simulation tick (or held-key state), so the walk/idle split is per frame, not per 5-second window. proof: a red-green unit case in `packages/core/__tests__/` plus one `map-walk` report whose walking frames match the scenario's held legs.
- [ ] The tail is attributed: `?tnFrameSpans=1` ranks the CPU spans inside the walking frames of the first 15 windows, for both arms. proof: the span table in this PRD from one paired run.

#### Phase 2: Cut the early-route CPU tail
**Status:** NOT STARTED
- [ ] The top-ranked span from Phase 1 drops in the walking frames of the first 15 windows, with a counter that moves under any host load. proof: the counter in a paired walk, plus a unit case for the change.
- [ ] The window-1 GPU spike (tick about 600, after the overlay) is attributed and either cut or shown to sit outside the walking mask. proof: the Phase 1 report around tick 600.

#### Phase 3: Timing round
**Status:** NOT STARTED
- [ ] Three interleaved quiet pairs against develop, booked as a `gpu-timing` slot on the `ci-pipeline` claim board. proof: the AC-1/AC-2 report with the load and adapter recorded beside each run.

## Blocked on

- A quiet RTX 2080 window (load below 10) for Phase 3. Other sessions and the tn-local runners load the desktop; the claim board is the way to book it.
