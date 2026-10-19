# PRD-549 — The engine stays playable on a weak GPU

**Status:** PARTIAL
**Priority:** P1 — Open: on an Intel Iris Xe, Machinefall's main pass takes 43–110 ms and each shadow redraw 150–365 ms, and the engine's own scalers do not bring it near a playable rate.
**Complexity:** 6 (MEDIUM) — three engine control loops (`resolution-scaler.ts`, the adaptive LOD bias in `world-cells.ts`, shadow redraw cost in `render/virtual-shadow.ts`), measured on two machines
**Owner:** João
**Depends on:** PRD-478 (its RTX 2080 numbers and look are the regression floor here). Work rides on PR 473 (owner: one PR).

## Context

The owner, 2026-10-08: "make sure our engine also works reasonably well on crappy machines." The repository rule is that a value the engine can measure where it is used is decided by the engine. On a weak GPU the engine measures a frame 6–13× over its budget and still under-reacts.

Measured on the LAN laptop (Intel Iris Xe, Mesa Vulkan, Chrome WebGPU on its real display), Machinefall `map-walk`, fixed-step capture, this PRD's base build (PR 473, `d2bb5f649`):

| Fact | Value |
| --- | --- |
| Main-pass GPU, scale 1.0, 4× MSAA | 43–110 ms at 3–6 M GPU-selected triangles; 21–24 ms at 1.7 M late in the route |
| Same, resolution 0.5 and MSAA off (game config, variant A) | 17–23 ms at 4.4–5.0 M triangles; 53–55 ms at 6 M — the frame is largely fill-bound (4× MSAA plus alpha-coverage foliage) |
| Resolution scaler (`resolutionScale: "auto"`, target 120) | stays 1.0 through the early route, then 0.85 and 0.72 late in the walk; never touches the sample count |
| Adaptive LOD bias | at its constant cap, 2.5, for most of the walk, main pass still about 25× over its 4.17 ms share |
| One shadow-map redraw (4096², one ±250 m level) | 150–365 ms of GPU each time; each one is a visible hitch |
| RTX 2080, same build | main 2.8–8.6 ms, shadow redraw 4–6 ms; PRD-478 AC-2 passes |

## Findings

- 2026-10-08, live-clock walk on the laptop (`timing-walk` without screenshots, which the iGPU cannot answer in 30 s): the scale stays 1.0 for the whole walk at 16–57 fps. 11 of 22 windows are skipped as compiling; every other window but one has presented p99 15–63× its p50, and the scaler defers any window at `stallP99Multiple` 10 as "a stall, not a frame rate". The stalls are the shadow redraws, 120–350 ms each, in nearly every window. The rule was written for one-off compile stalls, so a recurring hitch freezes the scaler for good. The median frame is 9–12 ms presented: the laptop is mostly hitching, not uniformly slow.
- Variant B (`castLevels: 2`, casters at level 1 instead of LOD0): each redraw 63–210 ms against 205–365 ms, main pass unchanged. Coarser casters roughly halve the redraw.
- Order: Phase 3 (shadow redraw cost) removes the hitches, and with them the stall verdict; Phase 1 then fixes the stall rule so a recurring hitch cannot freeze the scaler again.
- 2026-10-08, the same walk's `TN_VIRTUAL_SHADOW` counters: 62 of 70 shadow redraws were invalidations (a streamed cell landing in the level), 8 were window moves. Machinefall has one level, so its invalidation delay is the 0.25 s base. The node priced a redraw by its CPU encode, 9–11 ms, against a GPU cost of 120–350 ms, so its adaptive refresh never saw the cost.

## Solution

Each control loop already measures its own cost; what is missing is the range and speed of its answer.

1. **Resolution scaler: reach the pixels the GPU needs, then the samples.** The scaler already steps up to 4 rungs at once, sized from the GPU deficit, but on the laptop it held 1.0 through the early route. It acts only after startup readiness, on windows that are not compiling, behind an insensitivity guard, and never below the 0.61 desktop floor. Find which gate held it there, and fix that gate. Then add MSAA as the last rung below the floor (4 → 1, alpha coverage falls back to alpha test), restored with the same hysteresis. Variant A ran at 0.5 without MSAA, below anything the scaler can reach today.
2. **LOD bias: a measured ceiling.** Replace the constant 2.5 cap with "keep rising while the main pass is over its share, until every asset is at its coarsest level". The rise rate stays bounded (no pop), and the decay is unchanged.
3. **Shadow redraw cost follows the GPU.** When one level redraw costs more than a share of the frame, halve that level's map resolution (4096 → 2048 → 1024) and coarsen the caster shape (cast with the coarsest level instead of the finest that casts); restore when it fits. Measured per redraw, reported in `TN_FRAME_BUDGET`.

All three are mechanism in `packages/core`; no game sets anything, and an explicit game value (a pinned scale, `castLevels`, a fixed map size) still wins.

## Acceptance Criteria

- [ ] AC-1: on the laptop's Iris Xe, Machinefall `map-walk` walking presented p50 ≤ 33.3 ms (30 fps), with no game config change. proof: a live-clock run on the laptop's display at laptop load < 4, load and CPU temperature recorded
- [ ] AC-2: at most one shadow redraw for invalidation per 3 s of walk on the laptop. proof: the same run's `TN_VIRTUAL_SHADOW.byInvalidation` over the walk's seconds
- [ ] AC-3: the RTX 2080 is not worse: PRD-478's AC-1/AC-2 numbers hold and 3 blind raters score the 8 poses at or above PRD-478's tip. proof: quiet-desktop runs and sheets on PR 473

## Decisions

- 2026-10-08, owner: "keep the cheap laptop probing … setup a realistic goal, then lets go and merge". The goal moved from 60 fps to 30 fps without hitches. Reason: the main pass alone is 25–45 ms at scale 1.0 and 17–23 ms at scale 0.5 without MSAA (variant A), so 60 fps needs the sample-count rung and a lower scale floor, which stay open in Phases 1–2.

## Execution Phases

#### Phase 1: Resolution and samples
**Status:** NOT STARTED
**Files:** `packages/core/src/resolution-scaler.ts`, `packages/core/src/renderer.ts`; `packages/core/__tests__/`

- [x] The gate that held the scale at 1.0 through the laptop's early route is named and fixed, so a fill-bound deficit reaches the floor within a few windows of readiness. proof: a laptop run's scaler markers, then a red-green `resolution-scaler.spec.ts` on that gate
  Laptop run live13 (2026-10-08, `lodfix11`, load 8.4–9.4, CPU 82 °C): the scale went 1.0 → 0.61 four windows into the walk (tick 1262) and held the desktop floor from tick 1882; main-pass GPU median 29–50 ms at 1.0 (live12) → 18–33 ms at 0.61; late-walk fps 33 → 47–50.
  Named: three gates in a row, each found by a laptop run. (1) The stall rule (`stallP99Multiple` 10) deferred every window (`4da9bdba4`). (2) Its exception asked for presented p50 over budget, which read 6–9 ms while the main pass took 25–40 ms (`6d8840163`). (3) The Iris Xe resolves GPU timestamps 233–593 frames late, past `maxGpuAgeFrames` 16, so the scaler saw no GPU reading; a window with ≥ 4 of its own samples now uses their median (`b4aa0155d`). Each is a red-green case in `resolution-scaler.spec.ts` (82/82 across the 8 scaler spec files).
- [ ] At the floor scale the sample count drops to 1, and comes back with the hysteresis. proof: red-green spec; laptop run shows the drop in `TN_FRAME_BUDGET.surface`

#### Phase 2: LOD ceiling
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`; `packages/core/__tests__/world-gpu-scene.spec.ts`

- [ ] The bias keeps rising past 2.5 while the main pass is over its share, until every asset sits at its coarsest level. proof: red-green spec
- [ ] Laptop main-pass p95 with Phases 1–2. proof: laptop run, numbers recorded here

#### Phase 3: Shadow cost
**Status:** NOT STARTED
**Files:** `packages/core/src/render/virtual-shadow.ts`, `packages/core/src/world-gpu-scene.ts`; `packages/core/__tests__/`

- [x] An invalidation redraw waits out its own GPU cost: an engine-chosen `invalidationDelay` is at least `shadowRedrawGpuMs / 0.1`, so a 300 ms redraw waits 3 s and a 5 ms one keeps the 0.25 s base. proof: `virtual-shadow.spec.ts` "should space a redraw that stalls a weak GPU to a tenth of the time" — red with the delay removed, green with it (96/96 with `render-pass-budget.spec.ts`), commit `748aab403`
- [ ] The first redraws are priced too: live13 made 42 of its 54 invalidation redraws in the first ~16 s, before any shadow-pass GPU reading resolved (timestamps are sampled one frame in eight); after the first reading (305 ms) it made 11 in ~80 s, one per 7 s. proof: a laptop run whose first-16-s count drops, plus a red-green spec
- [ ] A level whose redraw still exceeds its share halves its map and coarsens its casters, and restores both when it fits. proof: red-green `virtual-shadow.spec.ts`
- [ ] AC-1/AC-2 runs on the laptop. proof: recorded here
- [ ] AC-3 on the desktop. proof: quiet runs and raters on PR 473

## Blocked on

- AC-1's quiet laptop: live13 ran at load 8.4–9.4 (other sessions' CI runners on the laptop). Its walking presented p50 was 6.1–13.6 ms in every window, which is the AC-1 number, but the proof asks for load < 4.

- AC-3's timing: the RTX 2080 on a quiet desktop (shared with PRD-478's AC-1 loop).
