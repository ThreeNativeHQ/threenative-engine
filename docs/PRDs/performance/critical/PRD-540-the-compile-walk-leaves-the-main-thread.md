---
prd_contract: v1
---

# PRD-540 — the compile walk leaves the main thread, and compiled pipelines survive a relaunch

**Status:** PROPOSED, filed 2026-09-03 from PRD-327's device session. Planning and evidence in
`docs/verification/runtime-perf-state.md` §5a (Phase 2's device acceptance section).

**Priority:** P1 — Unstarted: move the 33 s Pixel 8 compile walk off the main thread and survive relaunch.
**Owner:** unassigned

**Source:** PRD-327's device acceptance runs on the Pixel 8 (six instrumented launches, 2026-09-03).

**Outcome:** a Bayview-class game's first frame reaches the display in ≤ 8 s median over three cold
launches with no 30-second silent window, and a second cold launch's `pipelineCompile` is ≤ 25 % of
the first.

## Context

Three stacked defects, each measured on the physical Pixel 8 (2026-09-03):

1. **The whole-scene compile walk is synchronous.** three's `renderer.compileAsync(scene, camera)`
   walks 835 renderables, builds every node graph and creates every pipeline **on the main
   thread** before its first per-item yield: 33 s for Bayview, measured by a three-side debug
   probe (`walk-begin` at 16:13:40.305, first per-item log at 16:14:13, no pump in between). The
   API is asynchronous in name on this backend. PRD-327 Phase 1's native async bindings are
   correct (pool `enqueued → finished → drained` verified) but are reached only after the walk.
2. **The per-item yield is frame-coupled.** three's `yieldToMain()` resolves through
   `requestAnimationFrame` on this host — a host-side counter read 1 scheduler yield against 892
   items — and rAF cannot resolve while the launch loop is held, so the warm-up couples to
   presented frames that do not exist yet. `TN_WARMUP` reported `{"compiled":0,"abandoned":1,
   "timedOut":true}` on every arm.
3. **Nothing is cached across launches.** Every launch's `pipelineCompile` sat at 8.2–8.3 s
   across six runs; the driver cache does not carry these pipelines.

Net effect measured: opting a game into warm-up **regressed** the launch (Bayview 14.4 s → ~35 s
to first frame); without it, the first frame still pays an 8.2 s synchronous pipeline compile
(103 calls, 72.4 % attribution).

## Solution

Ordered, each step gated on the previous:

1. **The walk must yield for real.** Root-cause why `self.scheduler.yield` is invisible to three
   on the shipped host (the shim installs on `globalThis` and asserts `self.scheduler ===
   scheduler`; three reads `self.scheduler`; yet the fallback ran) and make three's per-item
   yield resolve on the host's own pump. Red: the device arm above (`yields: 1` against 892
   items). Green: the counter reads one yield per item while the loop is held.
2. **The walk must leave the main thread.** Either three's backend walk is driven per-object from
   the host's pump (the "object" granularity warm-up already in `warmup.ts`), or the synchronous
   backend creation moves to the Phase 1 compile pool. Pre-registered bar: ≥ 2 ms/frame of main
   thread freed during the walk, and no regression in total walk time ≥ 20 %.
3. **The persisted cache**, per PRD-327 Phase 3's pre-registered rule (already executed and
   rejected for "driver does it for free"): a persisted pipeline cache (wgpu-native pipeline-cache
   hook or Dawn device cache per backend), red = second-launch `pipelineCompile` unchanged with
   the cache file present; green = ≤ 25 % of the first launch.

**Key decisions:** no warm-up default flips until 1 and 2 land — the measurement above shows the
opt-in is harmful today. The kill switch applies: if the framework cannot make three's walk yield
without forking it, the "object" granularity warm-up (already implemented, unmeasured on device)
is the fallback and the whole-scene path is documented as unusable on native.

**Data changes:** None.

## Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| ---: | --- | --- | --- | --- | --- |
| 1 | Yield root-cause fix (host or shim) | `packages/runtime-native/src/runtime-scripts/scheduler-yield.js` + `runtime.cpp` install | frame-coupled rAF fallback during launch | yes | the device arm: `yields` counter must read per-item while held |
| 2 | Off-loop walk (object granularity on device, or pooled backend creation) | `packages/core/src/warmup.ts` granularity selection + `bindings_pipelines.cpp` | synchronous whole-scene walk | yes | `TN_WARMUP.compiled` ≥ pipelines with first-frame `pipelineCompile` ≤ 500 ms |
| 3 | Persisted pipeline cache | device creation in `android_main.cpp` / `bindings.cpp` | nothing | n/a | second launch with cache file present vs deleted: `pipelineCompile` must differ measurably, else kill the row |

## Reachability

**User-facing:** launch time on every Android game. **Observable:** `TN_WARMUP`, `TN_STALL_SEGMENTS`,
`TN_COLD_START first_frame`, the loading screen. **Replaces:** the synchronous walk documented in
`runtime-perf-state.md` §5a.

## Acceptance criteria

1. Three cold launches of a Bayview-class game, physical Pixel 8, unplugged, thermal NONE:
   tap-to-playable ≤ 8 s median; first present `pipelineCompile.ms ≤ 500`. *Red:* the 2026-09-03
   runs (14.4 s / 8.2 s) in §5a.
2. A host-side yield counter reads one yield per walked item while the launch loop is held.
   *Red:* `yields: 1` against 892 items (measured, §5a).
3. Second cold launch `pipelineCompile` ≤ 25 % of the first, or the cache row is closed
   RECOMMEND-AGAINST with the numbers. *Red:* 8.2–8.3 s on every launch (§5a).
4. No launch presents a first frame whose `TN_STALL_SEGMENTS.attributedShare` drops below the
   instrument's bar because work moved off-loop without being counted.

## Out of scope

- The TSL/shader-compile segment (measured small on device).
- Texture upload (asset-pipeline question).
- Anything that changes what a pipeline draws.
