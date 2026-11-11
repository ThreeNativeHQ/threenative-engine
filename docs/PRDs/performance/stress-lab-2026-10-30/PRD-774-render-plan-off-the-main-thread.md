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

Closed without code: see the 2026-10-30 lane decision under `## Decisions`.

### Phase 3 — TR2: the plan overlaps the next update

- [ ] The JobPool async task (`submit`/`join`) merges, after review of the `CheckNoBlockingWaits` regex change. proof: `job_pool_test` cases, `native_engine_no_blocking_waits`
  Review 2026-10-30: the regex change is safe. It adds only an optional `taskQueued_ ||` to the one reviewed worker park, and `join()` spins with `yield` like the `forEach` join, so the browser main thread never parks. Merge it in the same commit as its first caller (the box below), not alone: an API with no caller is dead code.
- [ ] `renderPrepared` splits at the GPU phase. A guard keeps a frame with a lazy-creation miss serial, and a plan task joins at the first engine export. proof: native case where a mutation before the join is impossible
- [ ] A named override `oneFrameThreadLag: false` restores the serial path and is reported when set. Paired A/B shows CPU frame p50 lower by more than 3%. proof: PRD-770 window rows

## Unreal reference (2026-11-10 read)

Each line was re-checked against the `UE 5.8.3` clone on 2026-11-10. Paths are under `Engine/Source/Runtime/`.

- **Phase 3 is Unreal's late join.** Pass setup runs as a task, and the render thread waits for it only where the pass draws
  (`r.MeshDrawCommands.ParallelPassSetup` 1 and `r.DeferredMeshPassSetupTaskSync` 1, `Renderer/Private/MeshDrawCommands.cpp:22-23,54-55`).
  It hides plan time behind the JS update. It removes no work, so the ceiling stays the 2.0 ms JS window.
- **The lazy-creation guard of box 2 gets smaller when programs are built at add time.** Unreal builds a draw command when the
  primitive is added (`Renderer/Private/PrimitiveSceneInfo.cpp:51-53`). PRD-573 Phase v2.4 box 3 owns that step. With it, fewer
  frames hit a lazy-creation miss and fall back to the serial path.
- **State the lag in frames.** Unreal holds the render thread at most one frame behind (`RenderCore/Private/RenderingThread.cpp:2435`).
  The web `FrameGate` allows 6 unfinished frames (`renderer/frame_gate.h:30`, `kMaxFrames`). The override box should report frames
  in flight beside the CPU gain, so a latency cost cannot hide behind a frame-time win.
- **The join must not park the thread.** Unreal waits on a fence in 1 ms slices and keeps serving OS messages
  (`RenderingThread.cpp:1081-1084,1189`). Our `join()` spins with `yield`, which matches (Phase 3 box 1 review).
- **Flush before a surface change.** Unreal flushes every render command before a viewport resize
  (`SlateRHIRenderer/Private/SlateRHIRenderer.cpp:564`). The plan task must join before a canvas resize, surface loss or device loss.
- **Shadow planning is not this PRD.** PRD-871 Phase 3 (PR #659, lane `perf/stress-lab-audit`) owns `planVirtualPages` and
  `planShadowLists`. Reference for that lane: Unreal gathers shadow subjects in parallel packets and merges them in packet order
  (`Renderer/Private/ShadowSetup.cpp:324-325,331-332`), and it invalidates virtual shadow pages only from instances that moved or
  deform (`Renderer/Private/VirtualShadowMaps/VirtualShadowMapCacheManager.cpp:105,110-112`). On our side, caster selection goes to
  the pool above 16,384 page-caster pairs, a gate the code calls proposed and not measured (`renderer/renderer_internal.h:243`), and
  the row build after it is serial (`renderer/renderer_frame.cpp:1199`).

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: no prototype of the full overlap in one step. Lane TR2 showed the plan touches the GPU and
  live scene memory, so the order is TR1, TR3, then TR2.
- 2026-10-30, lane 774: TR3 rejected on the stage meters, and its two boxes are deleted as moot. `planDraws` reads p50 0.07 ms,
  p95 0.09 ms (`hunt/s771-b5-on.json`, frame p50 14.7 ms). The pack cannot clear a 0.5 ms bar, and the pool join costs the same order.
  Recorded here on 2026-11-02 from `.worktrees/stress-fix-tr2/FIX-REPORT.md`.
