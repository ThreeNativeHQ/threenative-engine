# PRD-774 — Take the render plan off the main thread

**Status:** PARTIAL — TR1 and the JobPool async task are built in lane worktrees, with no paired browser proof yet.
**Priority:** P1 — the C++ render plan runs on the main thread for about 7 ms per frame while 8 workers idle, which caps every web game's CPU frame (Phases 1-3).
**Owner:** João · 2026-10-30
**Depends on:** PRD-771 Phase 1 to price each step. PRD-770 Phase 1 for the paired A/B.

## Why

`RenderDatabase::render` costs 7.91 ms per frame on the main thread, and only 0.80 ms of it is `encodeFrame`
(`hunt/HUNT-tr1.md`, `tr1-base`, 718 frames). The JobPool sits idle about 99% of the frame.

Unreal lets the render thread run one frame behind the game thread by default:
`UE 5.8.3: Engine/Source/Runtime/RenderCore/Private/RenderingThread.cpp:2435-2439` (`r.OneFrameThreadLag`, default 1).

What blocks a direct port, from lane TR2 (`.worktrees/stress-fix-tr2/FIX-REPORT.md`):

- **The plan is not free of the GPU.**
  - `renderPrepared` is a CPU plan (`renderer.cpp:2927-4430`) followed by a GPU phase (`:4434-5148`).
  - The plan holds about 18 lazy creation sites: programs, pipelines, environments and shadow-map textures.
  - The canvas acquire sits at `:2852`.
- **`DrawItem` holds about 25 live scene pointers.** A job that runs during the JS update races, or reads freed memory.
- **The safe design.** Run the plan as one async pool task, and join it at the first engine export of the next frame.
  JS cannot touch the engine in between, so the task is memory-safe without a scene snapshot.
  - Ceiling: about 3.3 ms of movable CPU per frame.
  - The JS window it can hide behind: 2.0 ms p50.
  - This is arithmetic on one profile, not a measured gain.

Lane state at 2026-10-30 06:00Z, all uncommitted:

- **TR1** (`.worktrees/stress-fix-tr13`): stable per-draw slots in the `instances` storage, plus dirty-range uploads.
  - A camera step that swaps two instanced draws sends 41,028 B on develop and 1,028 B with the change.
  - 112 of 112 native cases pass. Wasm build `4d5e7b87db9b`.
  - Its paired window (`tr13-window.sh`) is queued.
- **TR2 slice** (`.worktrees/stress-fix-tr2`): `JobPool::submit` and `JobPool::join`, with 7 tests.
  - It widens one regex in `cmake/CheckNoBlockingWaits.cmake`. Review that before merge.

## Validation scene

- **Consumer and scene:** the stress lab, `main.html?stress`.
- **Window:** the PRD-770 fair window on the RTX 2080 at 1280x720.
- **Benefit workload:** `?stress`.
- **Inactive control:** `?stress&still`, which must upload 0 instance bytes per frame after TR1.
- **Worst case:** `?stress` with a camera cut every frame, which charges the dirty-range bookkeeping.
- **Pass:** CPU frame p50 lower by more than 3% in both ABBA pairs for each phase, with byte-identical frames.

### Phase 1 — TR1: upload only what changed

- [x] Per-draw slots and dirty-range uploads merge onto develop. A still scene uploads 0 instance bytes on its second frame. proof: native red-green case in `.worktrees/stress-fix-tr13` — landed on perf/stress-lab-120 with TR1b (unchanged instanced draws skip the copy and compare): `static_instances_are_not_recopied` red with the skip off (copies 2 every frame), green with it (still 0, edit 1); renderer 53, render-database 113, vsm 3, vsm-atlas 10, pixel goldens render_vsm / render_vsm_open / render_instanced_geometry / vsm_reference_current pass (2026-10-30).
- [x] Paired A/B: CPU frame p50 lower by more than 3%, and bytes uploaded per frame lower, with no visual change. proof: PRD-770 window rows — rows #85-#88 on top of the stack: uncapped CPU p50 13.55 -> 12.89 and 13.79 -> 12.74 (-4.9%, -7.6%), p95 18.13 -> 17.64, GPU p95 7.52 -> 7.39; vsync -2.5% / -3.7%. Upload 3.32 -> 2.10 MB/frame (TR1 audit). Opus judge NEUTRAL on the TR1b frames (visual/r5-*).

### Phase 2 — TR3: a pooled draw pack

- [ ] The per-draw pack becomes a flat, slot-addressed schedule run on `JobPool::forEach`, with output byte-identical to the serial pack. proof: native case
- [ ] Paired A/B: CPU frame p50 lower by more than 3% against Phase 1. proof: PRD-770 window rows

### Phase 3 — TR2: the plan overlaps the next update

- [ ] The JobPool async task (`submit`/`join`) merges, after review of the `CheckNoBlockingWaits` regex change. proof: `job_pool_test` cases, `native_engine_no_blocking_waits`
  Review 2026-10-30: the regex change is safe. It adds only an optional `taskQueued_ ||` to the one reviewed worker park, and `join()` spins with `yield` like the `forEach` join, so the browser main thread never parks. Merge it in the same commit as its first caller (the box below), not alone: an API with no caller is dead code.
- [ ] `renderPrepared` splits at the GPU phase. A guard keeps a frame with a lazy-creation miss serial, and a plan task joins at the first engine export. proof: native case where a mutation before the join is impossible
- [ ] A named override `oneFrameThreadLag: false` restores the serial path and is reported when set. Paired A/B shows CPU frame p50 lower by more than 3%. proof: PRD-770 window rows

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: no prototype of the full overlap in one step. Lane TR2 showed the plan touches the GPU and
  live scene memory, so the order is TR1, TR3, then TR2.
