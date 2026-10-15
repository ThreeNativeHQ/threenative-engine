# PRD-613 — Native render thread: cull, project and encode leave the main thread

**Status:** NOT STARTED
**Priority:** P1 — the largest measured lever for PRD-610's 2x to 3x bar: render prepare and encode cost 1.65 / 2.89 / 4.41 ms of the native main thread per frame on Midway, and no box below is done.
**Complexity:** 7 (HIGH)
**Owner:** João
**Depends on:** PRD-610 (the matched yardstick, AC-15; this PRD delivers PRD-610 AC-16)

Complexity: 7 → HIGH (11+ implementation files: 3, new render-thread system: +2, concurrency and object lifetime across threads: +2); risk override: none.

## Context

PRD-610 sets the owner bar: the native desktop player is 2x to 3x faster than three.js in Chromium on Midway. The matched yardstick (PRD-610 AC-15) measures main-thread CPU per frame in 1,000-tick fixed-step windows at three poses. Pair 1 at engine `e3271a19c` (parity PASS, Xvfb, CPU and instructions only):

| Pose | three.js | native main thread | of which render (`renderCpuMs`) | render wall: prepare / encode+submit |
|---|---|---|---|---|
| takeoff | 9.09 ms | 7.31 ms | 1.65 ms | 1.33 / 0.41 ms |
| cockpit | 9.55 ms | 9.07 ms | 2.89 ms | 3.49 / 1.18 ms |
| rear gunner | 14.35 ms | 10.95 ms | 4.41 ms | 4.54 / 1.67 ms |

Chromium splits this work across the renderer main thread, the compositor and the GPU process. The native player runs it all on one thread. Present already runs on the `GpuThread` (old PRD-610 AC-9, −19% main-thread CPU).

A main-thread `perf record` (cycles:u, IPC 0.64, L1d miss rate 6.9%) puts `RenderDatabase::project` at 6.7%, `ProjectedCull::apply` 3.7%, `boundingSphereOf` 1.7%, `findRecord` 1.6%, `renderPrepared` 1.1% and `GeometryCache::sync` 1.0% of samples. Placement screens (one CCD, no SMT sharing) and the HUD snapshot mode did not move cycles, so the cost is the main thread's own work, not interference.

Package rule (`packages/runtime-native/AGENTS.md`): the JavaScript runtime that owns `THREE.Scene` also owns the renderer, and the `Object3D` tree is never mirrored across threads. Heavy systems use batched transfer surfaces. A per-frame packet of draw data is a batched transfer surface, not a mirrored tree.

Known hazards: encode syncs a live `BufferStore` and clears its update ranges (`renderer/renderer.cpp`, `renderer/geometry_cache.cpp`); `DrawItem.material` points to database-owned params (`renderer/render_database.cpp`); `cmake/CheckNoBlockingWaits.cmake` allows only the `GpuThread` join.

## Solution

Pending the implementation plan (2026-10-14). Outline: after JS and the matrix walk, the main thread hands an owned frame packet to a render thread. The render thread runs cull, project, resolve and encode on packet data only, then hands submit and present to the `GpuThread`. One frame in flight in total. The `GpuThread`'s deferred destruction extends to everything a packet references.

Measurement: PRD-610 tier ladder. Tier 0 is a ctest. Tier 1 is one matched native screen (about 4 min). Tier 2 is three alternating pairs with parity PASS and the visual judge.

## Acceptance Criteria

Boxes live under each phase.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Render thread | `player/run.cpp` frame loop → render thread → `GpuThread` | `database.render` on the main thread is removed from the frame loop | Phase 1 to 3 |

## Decisions

- 2026-10-14 (owner): "this shit that's days of work, you have to extract into a separate prd". PRD-610 AC-16 moves here; PRD-610 keeps AC-16 as the consumer box, proved by this PRD.

## Execution Phases

### Phase 1 — Encode and submit on the render thread

**Status:** NOT STARTED

### Phase 2 — Cull and project on the render thread

**Status:** NOT STARTED

### Phase 3 — Qualification

**Status:** NOT STARTED
