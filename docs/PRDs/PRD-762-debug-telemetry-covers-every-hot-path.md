# PRD-762 — One debug switch covers every engine hot path

**Status:** PARTIAL — coverage audit complete; implementation pending.
**Priority:** P1 — ordinary engine activity can consume a frame without an actionable warning.
**Progress:** Phase 0 complete, phases 1–2 pending.
**Owner:** João · 2026-10-28
**Branch:** `feat/web-engine-debug-telemetry` (this checkout only; local commits, no push).
**Complexity:** 9 → HIGH; risk override: none. Crosses JS/Wasm and native renderer boundaries.

## Outcome and decisions

`TN_DEBUG=1`, `?tnDebug=1`, or `globalThis.__THREENATIVE_DEBUG__ = true` before boot enables all diagnostic producers. Existing frame-budget windows carry every numeric observation in `counters.engine`; one `TN_DEBUG_REPORT` ranks costs and waste in the same window, with measurement basis, caller and a matching performance-learning lever. Missing observations remain absent. Counts are not invented milliseconds. Debug-off preserves the existing crossing/allocation census and does not install diagnostic wrappers, observers, timers or per-call stacks.

Engine layer: the shared bridge, loop and C++ renderer own these costs across games. Detection only: fixes to timestamp sampling, fog transport, frame pacing and reprojection belong to other branches. No render settings, draw order or image changes. This is an audit instrument, not an Unreal feature port.

Reuse `Spans.ts`, `FrameCounters.ts`, `frame-budget.ts`, `render-pass-budget.ts`, `scene-warning.ts`, `render-trap-audit.ts`, `bridge-meter.ts`, native `waste_counters.h` and playtest `engineCost`. Keep the earlier uncommitted bridge work where valid. Replace its independent `TN_ENGINE_DEBUG` cadence with the frame budget's report. The requested `packages/three-native/AGENTS.md` does not exist; add its contract. `rg TN_HOT_CALL` finds no implementation in this checkout: use the existing game-span/callback seams and add the missing actionable marker there, rather than creating a competing profiler.

The always-on bridge rule uses the existing `REDUNDANT_SHARE` against the observed median interval and a measured crossing calibration, extended to all crossings. Other findings are debug-only. A count/share trigger derives from an observed denominator (submitted draws, requested samples, live bytes, available arena, interval or measured baseline); diagnostic presentation limits are not warning thresholds. GPU saturation, callback delivery delay and host contention remain separate observations, not inferred causes.

## Phase 0 — audited coverage matrix

- [x] Every critical area has a producer, gap, derived rule and proof below. proof: source audit below; `pnpm prd:progress docs/PRDs/PRD-762-debug-telemetry-covers-every-hot-path.md` (run before commit).

Anchors name the audited baseline; implementation can move line numbers. All listed proofs are local agent lanes unless the blocker section says otherwise.

| Area | Waste it can hide | Existing signal (file:line, marker) | Gap | Signal to add | Derived threshold | Proof test |
| --- | --- | --- | --- | --- | --- | --- |
| Bridge crossings | Distinct gets, writes and invokes dominate `army.sync` without repeated reads | `packages/three-native/src/bridge-meter.ts:98`, `TN_BRIDGE_WARNING`; `browser-backend.ts:393`, calibration | Warning prices only repeated reads; census callers only under engine-cost flag | Counts by kind/name/caller; calibrated crossing ms and redundant reads in budget/report | All crossing count × measured crossing cost / observed median interval > existing `REDUNDANT_SHARE` | Bridge spec: 995 distinct RTS-shaped crossings, zero redundant reads, warning fires; unrelated inspector reads excluded |
| Bridge encoding/arena | 50,176 bytes widened to 401,408; scratch malloc/zero/free churn | `packages/three-native/src/browser-backend.ts:2520`, 64 KiB arena and `writeValue` | No widening, overflow or copy byte counts | Source/encoded bytes, overflow allocations/bytes, property/caller, bridge scratch bytes | Encoded/source byte ratio > 1; actual allocation exceeds remaining arena; measured bridge share | Real ABI stub census for 112×112×4 fog; flag off has identical malloc/free/crossings |
| Bridge hierarchy/wrappers | Child wrapping and handle sharing on repeated hierarchy reads | `browser-backend.ts:2079`, `childrenReads`/`walkVisits`; `foundation/waste_counters.h:24`, shares | Census not enabled by debug; wrapping/leak growth unreported | Wraps, live handles, hierarchy changes and traversal visits alongside reads | Extra hierarchy work / observed hierarchy change; live-handle growth over window; no guessed ns | Browser hierarchy and lifecycle specs, repeated children read and release |
| Update and systems | Game update vs engine overhead; physics catch-up, navigation, animation, terrain, input, audio, network callbacks | `packages/core/src/profiling/Spans.ts:92`, `GAME_SPANS`; `frame-budget.ts:72`, phase partition | Many flags; no unified ranked hot caller (no `TN_HOT_CALL` implementation) | Enable incumbent spans; timed named callbacks/systems with caller and update/render shares | Measured callback/system ms / current observed interval; fixed-step count retained | Loop integration with slow named callback and plugin; same update count off/on |
| Scene graph | Repeated matrix walks/traversals, unchanged dirty writes, add/remove churn | `scene/object3d.cpp:104,645,806`, matrix evaluations; core MatrixWorldPass and projection windows | Traversal/dirty/lifecycle work not unified or exposed on native | Debug-only transform marks, visits, adds/removes; retain existing matrix evaluations | Dirty marks / actual evaluations; traversed nodes / rendered objects; measured scene-update share | Native object3d and core scene instrumentation tests |
| Renderer CPU and compilation | Pipeline/program compilation on first view; bind-group/buffer creation; invalidation and uniform name scans | `renderer/pipeline_cache.cpp:106,227,260`; `renderer.h:621`, `FrameStats`; `waste_counters.h:24` | Counters fragmented; native not in budget; compile hitches have no caller | Shared cumulative debug counters and measured compile cost; retain program/cache diagnostics | Creation delta per rendered frame, compile elapsed / observed interval, cache misses / attempts | Native pipeline/cache tests and window/report regression |
| Uploads and post chain | Repeated uniform packing, attribute/texture uploads, material callbacks in nested targets | `renderer.h:549,552,643`, texture/uniform bytes; `render-pass-budget.ts`, per-pass samples | Attribute bytes and repeated work not in engine-cost series | Uniform/attribute/texture bytes, target renders/passes and callback attempts | Uploaded bytes / live resource bytes, nested passes / world renders, measured pass share | Native GPU resource and render-chain tests; core nested-pass budget spec |
| Culling and batching | Whole scene visits, small draws, unbatched identical meshes | `profiling/scene-warning.ts:111`, `TN_SCENE_WARNING`; core `AutoBatch`; native `RenderDatabase` | Debug switch does not activate counters; misses need actionable context | Feed existing cull/batch decisions and candidate/rejection counts to report | Submitted / considered, eligible / merged; existing scene-warning GPU/CPU and triangles/draw rule | Existing AutoBatch/culling specs extended through budget window |
| GPU queries and readbacks | Timestamp maps every frame despite requesting one in eight; generic readback churn | `browser-renderer.ts:562`, resolved sample count; `frame_gpu_timer.h`; `gpu_resources.cpp:305` | Requested stride not reconciled with actual resolves/maps | Requested samples, actual resolves, map/readback bytes and GPU per-pass times | Actual query resolves / requested samples; no resolve allowed for an unsampled frame | Stub GPU/renderer: eight frames, one request, eight resolves must be flagged |
| GPU queue and gate | Queue submits, delayed work-done, capacity vs old completion frame declines | `gpu_resources.cpp:485`, submits; `frame_gate.h:24`, measured interval; `browser-renderer.ts:512`, skips | Bare skip count; callback delivery latency not GPU duration | Attempts/declines by actual gate reason; submits/maps, oldest age and completion-delivery ms | Gate's own `kMaxFrames` and `kBehindIntervals × interval`; latency / frame interval | Native FrameGate tests for both reasons; GPU callback integration |
| Temporal stages | Missing velocity leaves pan smear; invalid history, high rejection, wrong resolution | `renderer.h:440`, TemporalStatus; `browser-renderer.ts:589`, temporal fields | Skipped velocity draws absent; health not actionable | Eligible/skipped velocity draws, history-valid frames, measured rejection/clamp pixels, input/output pixels | Skipped / eligible draws; rejected / measured pixels; invalid history / active frames | Native renderer temporal test plus core RTS-shaped health report |
| Memory and lifetime | Wasm heap growth, GPU bytes, leaked handles; JS heap churn and GC stalls | `browser-backend.ts:2494`, heap identity; GPU records/handles; `FrameCounters.ts:207`, JS heap | No growth/leak trend or GC pause; native memory not unified | Heap-growth bytes/events, created/released/live GPU bytes/handles; heap delta and available GC observations | Window growth / starting live population; GC duration / observed interval; unavailable stays absent | Heap-growth ABI stub; native create/release; observer stub with missing-platform case |
| Main thread and host | Long tasks, rAF gaps; contention mistaken for slow GPU or physics | `frame-budget.ts:84`, hostGap/update/render; `TN_FRAME_HITCH` | No long-task observations or unified share ranking | Long-task count/ms, rAF gap vs callback body; reuse frame phase and simulation-step series | Measured pause / interval; host gap separate from callback and GPU time | FrameBudget integration with delayed callbacks; PerformanceObserver stub lifecycle |
| Worker/HUD messages | Whole-state publish and large/high-rate UI messages; repeated serialization | `packages/core/src/ui-state.ts:80`, publisher; `ui-bridge.ts:150,296`, serialized transport | No message rate/UTF-8 bytes/time in frame counters | Publish attempts/sends, serialized bytes, serialization/send elapsed and source | Changed sends / attempts; measured serialization/send ms / interval, bytes / window elapsed | UI publisher/bridge specs, non-ASCII bytes, unchanged state, teardown |
| Loading/streaming | Compile-on-first-view and main-thread texture decode hitches | Pipeline compile above; core asset loader and `createImageBitmap` integration | Loading attribution disappears from steady counters | Decode count/elapsed and loading/streaming callback elapsed with source URL; compile counter shared above | Measured synchronous decode/compile work / interval; async wall time labelled separately | Loader stubs with slow decode and cold compile in a later frame |
| Native host parity | Desktop/Android renderer work bypasses JS device wrappers | `abi/bindings_scene.cpp:555`, `__engineCounters` only read by Wasm; V8 player globals in `player/v8_main.cpp:1246` | No native producer for same budget reader; flags not forwarded consistently | Common C++ totals exposed to native JS using same counter names and debug switch | Same counter semantics and derived frame rules on each host | Native C++ counter tests and host bridge test; desktop/Android execution separately recorded |

## Phase 1 — producers and common window

- [ ] Bridge diagnostics detect the RTS crossing/widening/overflow classes, with debug-off census unchanged. proof: focused `packages/three-native/__tests__/debug-telemetry.spec.ts` and related bridge specs.
- [ ] Shared native renderer/scene/GPU/lifetime counters cover the matrix and expose the same names to Wasm and native JS. proof: matching native-engine C++ tests and `pnpm wasm:build`.
- [ ] Core activates incumbent diagnostics from one switch and feeds counters, measured callers, HUD/loading/main-thread observations into the existing frame budget. proof: focused core debug/loop/UI/loader Vitest specs.

## Phase 2 — verdicts, consumer proof and documentation

- [ ] One report per budget window ranks offenders with explicit cost/share basis, source and matching lever; missing/malformed observations fail closed. proof: core report/window integration specs; playtest engine-cost evaluator and warning specs.
- [ ] A runnable playtest scenario bounds the debug counters through `engineCost`. proof: focused playtest scenario/bridge integration (runtime lane recorded explicitly).
- [ ] Changed TypeScript and C++ pass their requested checks. proof: `pnpm exec biome check <changed TS files>`, package `tsc --noEmit -p .`, focused Vitest, Wasm build and matching native tests.
- [ ] Debug-surface reference and package instructions describe measured signals and limitations. proof: `pnpm sync:agents`, `pnpm check:docs`.

## Integration ledger

| Capability | Reachable trigger | Reuse/disposition | Evidence |
| --- | --- | --- | --- |
| All debug producers | Launch flag → game/bridge/native initialization | Extend incumbent counters and spans; no new game API | Phase 1 tests |
| Ranked detection | Loop → FrameBudget window callback → `TN_DEBUG_REPORT` | One window owner, no independent engine report cadence | Phase 2 window integration |
| Regression gate | Playtest `engineCost` → `TN_FRAME_BUDGET.counters.engine` | Existing evaluator; warnings retain existing fail-closed lane | Phase 2 consumer proof |

## Blocked on

None established. Native build dependencies are absent in this checkout at audit time; attempt the shipped build before claiming a blocker. No push or remote PR is authorized. Desktop and Android execution claims require their actual lanes; C++ unit coverage alone is not a device run.

## Validation results

Audit only. Implementation checks not yet run. Results are updated in the owning commit; final per-row status also goes in the requested uncommitted `CODEX-RESULT.md`.
