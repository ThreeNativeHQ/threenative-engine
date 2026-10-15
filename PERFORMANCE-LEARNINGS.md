# Performance learnings

This file is the central record of performance levers tried in this repository, and of the method lessons they
taught. Read it before you choose a lever. Add one entry for each closed lever (keep, reject or inconclusive)
before you start the next one, and an insight from a failure only when it is valuable. Update an existing entry
instead of adding a near-duplicate, and merge or trim entries when the file grows redundant. Keep the conclusion of
every rejected lever so that nobody retries it without a new reason. The `performance-optimization-loop` skill follows this file. Older per-PRD records are in each
PRD's "Tried and rejected" or "Decisions" section, for example
[PRD-610](docs/PRDs/performance/PRD-610-native-engine-wins-on-real-games.md).

## Method lessons

- **Size a lever before you code it.** Measure its ceiling with a counter or a phase timer inside the measured pose
  windows (`TN_PLAYER_CROSSINGS=1`, `TN_RENDER_PREPARE_SPLIT=1`, a temporary env counter). Then project calls per
  frame times cost per call. On 2026-10-14, two levers chosen from profile shares were flat in A/B.
- **A profile window must exclude loading.** A 100 s call-graph capture of the Midway player included load-time
  garbage collections, so it gave the V8 GC prologue 4.9% of samples. Inside the pose windows there was one GC per
  34 frames. `TN_PLAYTEST_CPU_PROFILE_DIR` now records only the existing ACK-controlled 1,000-frame pose windows;
  sampled windows and runs are excluded from benchmark qualification.
- **Bound symbol decoding too.** On the native monolith, full inline expansion left `addr2line` at 99% CPU.
  `perf report --no-inline` decoded all three recordings in under one second each. Set `DEBUGINFOD_URLS=` for
  local-only decoding; use `TN_V8_FLAGS=--perf-basic-prof` before launch when JIT names are needed, and preserve
  that player's `/tmp/perf-<pid>.map`. Unresolved anonymous samples are not proven JavaScript.
- **Instructions per frame are the low-noise metric on a loaded host.** Milliseconds and cycles moved by 13 to 17%
  when only the host load changed (load 18 to 11) on 2026-10-14. Alternate off and on runs, and judge with at least
  two pairs.
- **Retired instructions undercount memory-bound work.** Record cycles or thread CPU time beside them. When the two
  disagree, the change moved memory traffic, not computation.
- **Serialize timed runs with one lock.** An "idle for 40 s" `pgrep` check starved queued runs for 50 minutes,
  because `pgrep -f` matches shells whose command text only contains the script name.
- **Ratio levers live in the engine.** A fix in code that both arms run (for example `@threenative/core`) lowers the
  absolute cost but does not move the native or web Wasm ratio against three.js.

## Levers

### 2026-10-15 — Web binding arena and fixed-arity wrappers — REJECT
- Where: PRD-612 AC-3, candidate `3d08db039` in `perf/prd610-promote`; frozen web game copies.
- Ceiling: the 23–26% engine-JS-glue owner includes all wrappers; this candidate only removes overflow allocation/bookkeeping and generic counter dispatch. Baseline already had a 64 KB arena.
- Result: one exact-window exploratory pair passes four assertions on NVIDIA. Takeoff / cockpit / rear-gunner instructions fall only 0.019 / 0.075 / 0.761%; CPU changes −7.12 / −7.42 / +11.02% with 27-minute separation and load drift. No all-pose CPU win or qualified parity. Network-failed and interrupted attempts are excluded.
- Insight: removing small machinery inside a large owner does not remove that owner. Size the specific crossing class or operation before implementing its replacement; no equivalent retry without a larger measured ceiling.
- Artifact: `~/.cache/tmp-tn/screens/glue-resume-{base-1,on-clean-1}/`; dashboard cycle `web-glue-arena-resume`. Candidate remains unpromoted.

### 2026-10-15 — Exact-window native stack sampling — KEEP (diagnostic)
- Where: PRD-610 AC-15/AC-20, branch `perf/prd610-resume`; existing Linux CPU-window collector and dashboard qualification.
- Ceiling: diagnostic only; removes loading and pose-boundary ambiguity, not game CPU work.
- Result: `perf-rt-exact-off-1` passes runtime assertions and three exact 1,000-update/render windows. Samples: 1,769 / 2,106 / 2,847; zero lost, decoded callchains. `RenderDatabase::project` has 6.10% / 5.41% / 6.06% self cycles. Unresolved shares are 7.11% / 7.96% / 9.25%; no JIT map was enabled. Real sampled run is excluded from CPU qualification, including with a non-`perf-` tag. Focused red/green: eight feature failures, then 179 passing tests; typecheck, build, publint and independent review pass.
- Cause: the recorder has its own FIFO/ACK lifecycle and samples the owned main TID only around the same fixed-step advance as the counters.
- Follow-up: `perf-rt-jit-off-1` enables `TN_V8_FLAGS=--perf-basic-prof`, preserves the owned player map, and passes three assertions plus exact 1,000-frame windows. A self-cycle symbol-prefix split gives engine/host C++ 61.02 / 64.19 / 67.23%, V8 runtime 19.57 / 15.99 / 13.78%, V8 JIT 10.43 / 10.02 / 8.91%, unresolved 1.13 / 1.80 / 1.32% (takeoff / cockpit / rear gunner). The monolith mixes V8 and engine symbols, so these are heuristic owner groups, not independent libraries. Most cycles remain outside V8; compression alone cannot be budgeted as fixing the whole IPC gap.
- Artifact: `~/.cache/tmp-tn/screens/perf-rt-exact-off-1/profiles/`, dashboard cycle `native-exact-window-profile`, and saved source patch in the original handover scratchpad (`exact-window-profile.patch`). No speed winner promoted.

### 2026-10-15 — PRD-613 Stage 1 encode thread, resumed screen — INCONCLUSIVE
- Where: PRD-613, branch `perf/prd610-resume`, candidate `a57423817`; `TN_RENDER_THREAD` remains default off.
- Ceiling: Stage 0 sized encode migration at about 0.2 / 0.6 / 1.0 ms main-thread CPU per frame.
- Result: fresh alternating `rt-resume-off-1` / `rt-resume-on-1`, three exact 1,000-update/render windows, runtime assertions PASS. Takeoff / cockpit / rear gunner CPU: 7.743 / 8.277 / 12.049 ms off versus 9.557 / 11.929 / 14.158 ms on; instructions: 20.482 / 22.748 / 29.980 M off versus 20.060 / 21.095 / 27.036 M on. Host load varied; no qualified CPU win, parity or visual verdict.
- Cause: encode moved off main, but the CPU/instruction disagreement is not yet attributed. Diagnose it before another equivalent timing attempt.
- Insight: relocating work can lower main-thread instructions without lowering its CPU time; instruction-only selection cannot qualify a thread migration against the CPU target.
- Artifact: candidate `a57423817`; raw `~/.cache/tmp-tn/screens/rt-resume-{off,on}-1/` and dashboard cycle `prd613-s1-render-thread-resume`. Current binary/game identities are in the screen host-load records; package provenance remains stale.

### 2026-10-14 — V8 GC prologue `promote()` skips the full wrapper walk while the ownership epoch is unmoved — REJECT
- Where: PRD-610, branch `perf/prd610-promote` (reverted).
- Ceiling: profile share 4.9% of samples. It was wrong (see method lessons).
- Result: second off/on pair flat (takeoff 8.58 / 8.70 ms, cockpit 10.44 / 10.44 ms, rear gunner 11.55 / 10.73 ms);
  instructions unchanged. Counter run: 249 GC prologues in 8,400 frames, 26,447 wrappers.
- Cause: GCs are rare in the pose windows, so the walk costs about 0.04 ms per frame.
- Artifact: patch kept outside the repository by the session; the change is a 20-line edit in
  `packages/runtime-native/src/adapters/v8/adapter.cpp`.

### 2026-10-14 — Crossing path reuses decoded numeric and handle arguments — REJECT
- Where: PRD-610, branch `perf/prd610-crossing` (not committed).
- Ceiling: 613 calls per frame × 60 to 120 ns = 0.04 to 0.07 ms per frame.
- Result: A/B flat on two pairs; adapter ctests 75 of 75 passed on and off.
- Cause: the per-call decode is a small part of a crossing. Remove whole classes of crossings instead.
- Measured on the way: 1,725 crossings per frame on Midway; top names per frame `visible` 315, `count` 152,
  `getY` 120, `getX` 120, `time` 109, `setEffectiveWeight` 104, `material` 98, `getZ` 87, `opacity` 83,
  `getWorldPosition` 58; 34,331 live wrappers.

### 2026-10-14 — `publishUiState` serializes a changed HUD frame once instead of three times — KEEP
- Where: `@threenative/core` (`ui-state.ts`, `ui-bridge.ts`), branch `perf/prd610-promote`, commit b642e5dfb.
- Ceiling: `JSON.stringify` was about 7% of the native main thread in the call-graph profile (the same profile
  that overstated GC, so treat this share as an upper bound).
- Result: red-green spy test 3 calls to 1; 101 UI core specs pass; public surface unchanged. Not timed on Midway.
- Cause: the publisher stringified the store to diff it, again for `lastFrame`, and the bridge stringified the
  message a third time.

### 2026-10-14 — PRD-613 Stage 0: render phase split — KEEP (diagnostic)
- Where: [PRD-613](docs/PRDs/native-engine/PRD-613-native-render-thread.md), commit 4abe3d020.
- Result (loaded host, shares only): the ocean reflection pass is about half the render wall at cockpit and rear
  gunner (0.85 / 2.67 / 4.32 ms); its encode costs about 2 ms for 8 items at cockpit, a per-pass fixed cost.
- Cause: one reflection pass per frame re-runs prepare and encode for its own camera.

### 2026-10-14 — Web Wasm owner profile — KEEP (diagnostic)
- Where: [PRD-612](docs/PRDs/native-engine/PRD-612-web-wasm-engine-beats-threejs-on-midway.md).
- Result: on the browser main thread, Wasm engine code 44 to 48%, engine JS glue 23 to 26%, game JS 12 to 15%,
  V8 `(program)` 8%, WebGPU natives 7 to 8%. Animation, the matrix walk and `RenderDatabase::project` are the same
  top owners as on native.
