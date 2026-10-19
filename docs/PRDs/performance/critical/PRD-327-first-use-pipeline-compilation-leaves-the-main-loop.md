---
prd_contract: v1
---

# PRD-327 — First-use pipeline compilation leaves the main loop

**Status:** **PHASES 0–2 DONE; PHASE 4 DONE (DESKTOP); DEVICE ACCEPTANCE EXECUTED AND FAILED — CRITERION 3 UNMET** —
executed 2026-09-03. Phase 0 measured the backends and chose the mechanism; Phase 1 made
`createRenderPipelineAsync` native and off-loop (0.27 ms of a 70 ms compile, ratio 0.0038 against a
0.25 bar, red-green in `threenative-async-pipeline-thread-test`); **Phase 2 was executed and not
adopted** (the framework already warms up by default from inside the loading layer's readiness
gate — flipping the default broke two desktop gates, and the mechanism, not the default, was the
defect). **Phase 4 landed 2026-09-03**: a late synchronous compile is a named hitch —
`TN_FRAME_HITCH` carries `pipelineCompileMs`/`pipelineCompileCalls` (red-green in
`threenative-stall-budget-hitch-test`, live print proven through `playtest perf` on desktop Dawn)
— acceptance criterion 6 is met. **Phase 3 executed on both arms**: desktop second launch 77 % of
the first (noise, three tiny pipelines); phone launches 2–6 never dropped below ~100 % of the
first's 8.2–8.3 s `pipelineCompile` — the 25 % cache rule rejected "driver does it for free" and
[PRD-540](PRD-540-the-compile-walk-leaves-the-main-thread.md) is filed. **Criterion 3 failed on
the device**: three cold launches, physical Pixel 8, `com.threenative.bayview`, first frame
14.4–14.8 s against ≤ 8 s median — the warm-up mechanism deadlocks on the Android path (three's
whole-scene compile walk is synchronous for ~33 s and its yield falls back to frame-coupled rAF;
`warmUp: true` regressed the launch to ~35 s and was reverted in the game). The findings and the
pasted reds are in `runtime-perf-state.md` §5a; the fix is PRD-540's, not a default flip. The PRD
stays open on criterion 3, and PRD-218's criteria 1 and 2 stay open with it.

**Priority:** P1 — Device acceptance failed criterion 3; open boxes build both desktop backends.
**Complexity:** +2 (6–10 files) + 2 (concurrency: compile threads completing into the JS loop) +
2 (multi-package: `runtime-native` and `core`) + 1 (external API: wgpu-native / Dawn async
pipeline entry points) = **7 → HIGH mode**. Automated checkpoint after every phase; manual device
checkpoint after Phases 2 and 3.

**Owner:** unassigned

**Source:** PRD-218 criterion 2 (still failing), `packages/core/src/game.ts:200-224` (the
`warmUp` option's own evidence), and the probe session of 2026-09-02.

**Outcome:** a real game on the physical Pixel 8 goes from tap to a moving first frame in
**≤ 8 s median over three cold launches**, down from 14–15 s; the first presented frame carries
**≤ 500 ms of `pipelineCompile`** instead of 8,038 ms; and `warmUp` is on by default on native
because `renderer.compileAsync()` finally resolves there.

---

## 1. Context

**Problem:** every distinct pipeline is compiled synchronously on the main loop the first time
something using it is drawn, inside the first rendered frame. On a Pixel 8 running Bayview that
frame lasts 12–14 s (8,038 ms across 105 `createRenderPipeline` calls, 67.5 % of an 11.7 s gap).
The warm-up that exists to hide this behind the loading screen compiles nothing on native,
because the host answers `createRenderPipelineAsync` with the synchronous call wrapped in a
resolved promise.

**Files analyzed:**

- `packages/runtime-native/src/runtime-scripts/install-async-pipelines.js` — the whole file:
  `createRenderPipelineAsync = (d) => Promise.resolve(createRenderPipeline(d))`. Nothing leaves
  the thread.
- `packages/runtime-native/src/webgpu/bindings.cpp:1970` — the comment where the async entry
  points are installed via that script.
- `packages/runtime-native/src/webgpu/bindings_pipelines.cpp:364,413` — `StallScope
  PipelineCompile` around the synchronous creates; `:786` — `wgpuDeviceCreateRenderPipeline`.
- `packages/runtime-native/third_party/wgpu/include/webgpu/webgpu.h:2605` —
  `wgpuDeviceCreateRenderPipelineAsync` exists in the pinned wgpu-native (v25.0.2.2); Dawn's
  header carries the same entry.
- `packages/runtime-native/src/runtime.cpp:1179-1330` — `pollEvents()`: the host loop's named
  segments; the `kIo` segment already delivers worker completions to the main engine
  (`processWorkerMessages`), which is the delivery shape a compile-completion needs.
- `packages/runtime-native/include/mystral/stall_budget.h` — `TN_STALL_SEGMENTS` on the first
  present: `pipelineCompile`, `shaderCompile`, `textureUpload`, `bufferUpload`, `queueSubmit`,
  `residualMs`. Accumulation stops at the first present.
- `packages/core/src/game.ts:200-224` — `warmUp` is off by default with the measurement
  recorded on the option: `TN_WARMUP:{"compiled":0,"abandoned":1,"timedOut":true,"elapsedMs":15325}`.
- `packages/core/src/game.ts:811-835` — `startupCompile` calls `warmUpScene(renderer,
  projection.root, camera, { budgetMs: STARTUP_COMPILE_BUDGET_MS })`;
  `packages/core/src/startup-readiness.ts:31` — the budget is 15,000 ms.
- `packages/core/src/renderer.ts:292-306` — `compileAsync` forwards to three's
  `WebGPURenderer.compileAsync`, which uses `createRenderPipelineAsync` per material.
- `packages/runtime-native/scripts/attribute-launch-stall.mjs` — parses `TN_STALL_SEGMENTS` and
  fails closed under 80 % attribution.
- No pipeline cache exists on any backend: `grep -ri pipelinecache packages/runtime-native/src
  include CMakeLists.txt` is empty.

**Current behaviour:**

- Web: three's `compileAsync` resolves; the loading layer's bounded readiness gate covers the
  compile.
- Native: the same call runs the synchronous compiles on the main loop one per microtask turn and
  is abandoned by its own budget; then the first world frame compiles the identical 105 pipelines
  again — 8 s — while the loop presents nothing. The player sees a loading screen that never
  moves, then a 12–14 s freeze.
- Every later cold launch pays the same 8 s. Nothing checks whether the driver's own shader cache
  makes the second launch cheaper.
- After the first frame, a material that appears later still compiles synchronously mid-frame,
  and `stall_budget.h` no longer counts it.

### Incumbent census

- `install-async-pipelines.js` **is the incumbent** and is replaced: Phase 1 deletes the wrap and
  installs native async entries. Two implementations of `createRenderPipelineAsync` must not
  coexist.
- `warmUpScene` (`packages/core/src/warm-up.ts` or wherever `TN_WARMUP` is emitted — confirm with
  `grep -rn TN_WARMUP packages/core/src`) is the caller that turns a resolving promise into a
  hidden compile. It stays; only its default flips.
- `stall_budget.h` is the meter; Phase 4 extends it past the first present rather than adding a
  second counter.
- PRD-218 owns the finding and the acceptance number; this PRD owns the mechanism. PRD-288
  (`docs/PRDs/useful-defaults/PRD-288-the-first-frame-is-not-the-compile-bill.md`) touches the
  same symptom from the template side — read it before Phase 2 so the two do not pick different
  defaults.

## 2. Solution

1. **Measure what the backends' async entries actually do** before choosing a mechanism. Dawn
   compiles async pipelines on its platform worker pool; wgpu-native's async entry may run the
   compile inline and only defer the callback. A contract test executable settles this per
   backend in a morning.
2. **Bind the real async entries.** `device.createRenderPipelineAsync` /
   `createComputePipelineAsync` become native functions that (a) call the backend's async entry
   where Phase 0 proved it leaves the thread, or (b) run `wgpuDeviceCreateRenderPipeline` on a
   host compile thread pool where it does not — wgpu's device is internally synchronised and
   pipeline creation from a second thread is legal. Completions are delivered in `pollEvents()`'s
   existing `kIo` segment and resolve the JS promise on the game thread. The synchronous
   `createRenderPipeline` stays untouched for callers that need the object immediately.
3. **Flip `warmUp` on for native** once `TN_WARMUP.compiled` matches the first frame's pipeline
   count, and raise nothing else: the loading layer already waits on startup readiness.
4. **Decide the persisted cache with a number**: measure the second cold launch. If the driver
   already caches, stop. If not, the cache is a follow-up PRD with the measured price.
5. **Keep counting after the first frame** so a mid-game synchronous compile is a named hitch, not
   an anonymous 200 ms spike.

```mermaid
sequenceDiagram
  participant L as loading layer (core)
  participant W as warmUpScene (core)
  participant T as three WebGPURenderer
  participant B as bindings (native)
  participant P as compile pool / backend async
  participant H as host loop pollEvents()
  L->>W: startupCompile()
  W->>T: compileAsync(root, camera)
  T->>B: createRenderPipelineAsync(desc)
  B->>P: enqueue compile (id, desc)
  B-->>T: pending promise
  P-->>H: completion (id, pipeline)
  H->>B: kIo segment: resolve promise(id)
  B-->>T: pipeline
  T-->>W: compiled += 1
  W-->>L: TN_WARMUP {compiled:105, timedOut:false}
  L->>L: release the held loop; first frame finds pipelines cached
```

**Key decisions:**

- Mechanism is chosen by Phase 0's measurement, not assumed. Both branches are written down so the
  executor does not improvise.
- Completion delivery reuses the `kIo` segment and the worker-message pattern; no new thread
  touches the JS engine.
- A pipeline that fails to compile rejects the promise with the backend's message; it never falls
  back to a silent synchronous retry.
- Appearance is untouched. This PRD moves *when* pipelines compile, never *what* they compile.

**Data changes:** None.

## 3. Integration Ledger

| # | New thing | Live caller (`file:line`, non-test) | Replaces | Old path removed? | Negative control |
| ---: | --- | --- | --- | --- | --- |
| 1 | async-pipeline thread contract test executable | `packages/runtime-native/CMakeLists.txt` CTest target (TBD), run by `pnpm --filter @threenative/runtime-native native:test:cpp` | nothing | n/a | run it against the sync wrap's behaviour (Phase 0) → main-thread-blocked assertion red |
| 2 | native `createRenderPipelineAsync` / `createComputePipelineAsync` | `bindings.cpp` device wrapper install (TBD) — called by three's `compileAsync` on every native launch | `install-async-pipelines.js` sync wrap | deleted in Phase 1 | reinstate the wrap → contract test red; `TN_WARMUP.compiled` returns to 0 on device |
| 3 | completion delivery in `pollEvents()` | `runtime.cpp` `kIo` segment (TBD) | nothing | n/a | skip the drain → promises never resolve; contract test times out with a named error |
| 4 | `warmUp` default on for native | `packages/core/src/game.ts` default resolution (TBD) | `warmUp: false` default | replaced | set `warmUp: false` in the device arm → first-frame `pipelineCompile` returns to seconds |
| 5 | second-launch measurement and cache decision | `docs/verification/runtime-perf-state.md` §6 (TBD) | nothing | n/a | n/a — a record with a pre-registered rule |
| 6 | post-first-frame sync compile counter in `TN_FRAME_HITCH` | `stall_budget.h` / hitch reporter (TBD), read by `playtest perf` | first-present-only accumulation | extended, not duplicated | force one late material → the hitch names `pipelineCompile` |

## 4. Reachability

**How will this work be reached?**

- Entry points: every native launch (`compileAsync` → async bindings); `pnpm native:test:cpp`
  (contract); the physical device lane (acceptance).
- Pre-existing collectors edited: `CMakeLists.txt` test registration, `bindings.cpp`,
  `runtime.cpp`, `game.ts`, `stall_budget.h`.
- Result observable in: `TN_WARMUP`, `TN_STALL_SEGMENTS`, `TN_FRAME_HITCH`, `TN_COLD_START
  first_frame`, and the loading screen on the phone.

**Is this user-facing?** Yes — launch time. There is no UI to add; the existing loading layer is
the surface, and it starts moving because the loop is no longer frozen beneath it.

**Full flow:** game boots → loading layer shows → `startupCompile` warms every pipeline off the
main loop → `TN_WARMUP` reports `compiled:N, timedOut:false` → loop released → first frame
presents within the stall bar → `TN_STALL_SEGMENTS.pipelineCompile.ms ≤ 500`.

**What does this replace?** `install-async-pipelines.js` (deleted in Phase 1) and the
`warmUp: false` native default (flipped in Phase 2).

## 5. Execution phases

#### Phase 0: The backends' async entries are measured, and the mechanism is chosen

**Outcome:** a table saying, per backend, whether `wgpuDeviceCreateRenderPipelineAsync` leaves the
calling thread, and a one-line decision naming branch (a) or (b) per backend.

**Files (max 5):**

- `packages/runtime-native/tests/async_pipeline_thread_test.cpp` — NEW: headless device (the
  pattern of the existing contract-test executables in `tests/`), one deliberately heavy WGSL
  shader (a long unrolled loop is enough), then: (1) call the sync create and record wall time
  `Tsync`; (2) call the async entry with a callback that records its arrival time; record the
  main thread's time inside the call `Tcall` and time-to-callback `Tcb` while pumping
  `wgpuDevicePoll` / `wgpuInstanceProcessEvents`; assert `Tcall < 0.25 × Tsync` for a backend
  that truly compiles off-thread, and print the three numbers either way.
- `packages/runtime-native/CMakeLists.txt` — EDIT: register the executable and its CTest entry.
  Check the memory rule: a new contract-test target needs every registration the existing ones
  have (source list check, coverage digest, lane script, build matrix). Grep an existing target
  name, e.g. `threenative-frame-op-stream-replay-test`, and mirror every hit.
- `docs/verification/runtime-perf-state.md` — EDIT §6: the per-backend table (desktop Dawn from
  `build/tn-linux`, desktop wgpu from `build/tn-linux-wgpu`; Android wgpu on the phone if the lane
  is available, else `UNVERIFIED`).

**Implementation:**

- [ ] Build both desktop backends: `pnpm native:build` (Dawn preset) and the wgpu preset in
  `CMakePresets.json` (`tn-linux-wgpu`).
- [ ] Run the test on each and paste the three numbers.
- [ ] Decide per backend: `Tcall < 0.25 × Tsync` → branch (a) native async entry; otherwise →
  branch (b) host compile thread pool calling the synchronous entry. Write the decision in the
  record.

**Negative control:** run the same test against a shim that mimics `install-async-pipelines.js`
(call sync, then invoke callback) → `Tcall ≈ Tsync`, assertion red. Paste it.

**Checkpoint:** table in the record; automated PRD checkpoint with the integration audit. Continue
only on PASS.

#### Phase 1: `createRenderPipelineAsync` is native and leaves the main loop

**Outcome:** on desktop, `renderer.compileAsync()` resolves, `TN_WARMUP.compiled` equals the
number of distinct pipelines, and the sync wrap is gone.

**Files (max 5):**

- `packages/runtime-native/src/webgpu/bindings_pipelines.cpp` — EDIT: add
  `createRenderPipelineAsync` / `createComputePipelineAsync` handlers. Branch (a): call the
  backend async entry with a heap-allocated completion record `{promiseHandle, pipelineId}`.
  Branch (b): push `{descriptor copy, promiseHandle}` onto a compile queue drained by a pool of
  `min(2, hardware_concurrency − 1)` threads that call the synchronous create; both branches
  post a completion into a mutex-guarded vector on `BindingsState`.
- `packages/runtime-native/src/webgpu/bindings.cpp` — EDIT at ~1970: install the two natives on
  the device wrapper; delete the call that evaluates `install-async-pipelines.js`.
- `packages/runtime-native/src/runtime-scripts/install-async-pipelines.js` — DELETE. Update
  `shim-manifest.json` if it lists the script.
- `packages/runtime-native/src/runtime.cpp` — EDIT in `pollEvents()` `kIo` segment: drain the
  completion vector; for each, resolve or reject the JS promise on the game thread and register
  the pipeline in `renderPipelineRegistry` / `computePipelineRegistry` exactly as the sync path
  does.
- `packages/runtime-native/tests/async_pipeline_thread_test.cpp` — EDIT: the same test now
  drives the real binding path (through the engine, not the raw backend) and asserts the promise
  resolves with a usable pipeline and `Tcall < 0.25 × Tsync`.

**Wiring:**

- [ ] Caller edited: `bindings.cpp` device install; three's `compileAsync` calls it unchanged.
- [ ] Registration: the two natives in the device wrapper; the contract test in CMake.
- [ ] Old path: `install-async-pipelines.js` deleted.
- [ ] Ledger rows filled: 2, 3.

**Tests required:**

| Test | Assertion | Negative control (must be observed red) |
| --- | --- | --- |
| contract executable (row 1) | promise resolves; `Tcall < 0.25 × Tsync`; a bad WGSL rejects with the backend message | reinstate the sync wrap → `Tcall ≈ Tsync` red |
| `verify-desktop-core.mjs` (existing gate) | `TN_WARMUP` on `examples/native-smoke` reports `compiled ≥ 1, timedOut:false` when the example opts into `warmUp: {}` | revert the `runtime.cpp` drain → `timedOut:true` |
| `pnpm test` in `packages/core` | no change expected; run it |  |

**Revert check:** delete the two native installs → `verify-desktop-core.mjs` fails on
`TN_WARMUP.compiled`.

**Checkpoint:** automated PRD checkpoint. Continue only on PASS.

#### Phase 2: Warm-up is on by default on native, and the phone launches in ≤ 8 s

**Outcome:** PRD-218 criterion 2 passes on the physical Pixel 8: three cold launches of a
Bayview-class game, tap-to-playable ≤ 8 s median, loading overlay moving throughout.

**Files (max 5):**

- `packages/core/src/game.ts` — EDIT: `warmUp` resolves to `{}` on native when unset (keep `false`
  as the explicit opt-out); rewrite the option's doc comment to state the new measurement and
  keep the old one as history. `TN_WARMUP` keeps reporting either way.
- `packages/core/src/startup-readiness.ts` — EDIT only if `STARTUP_COMPILE_BUDGET_MS` needs to
  change; the expectation is that it does not, because the compile now finishes well inside it.
- `packages/core/__tests__/game.spec.ts` (or the spec that already covers `warmUp`) — EDIT: on a
  native platform source the default is on; on web unchanged; `false` still opts out.
- `docs/verification/runtime-perf-state.md` — EDIT §6: three cold launches with
  `TN_COLD_START`, `TN_STALL_SEGMENTS`, `TN_WARMUP`, `TN_FRAME_HITCH`; battery, thermal and
  package id per the device lane rules in `packages/runtime-native/AGENTS.md`.
- `packages/runtime-native/scripts/attribute-launch-stall.mjs` — EDIT only if its 80 %
  attribution bar needs the new segment names; otherwise leave it.

**Implementation:**

- [ ] Build the sandbox game against a core tarball carrying this change; verify the installed
  bytes (grep `dist/index.js` for the new default) before trusting a number.
- [ ] Cold launch ×3 per method rule 4 (`am force-stop` → `pidof` empty → `am start -W`), unplugged,
  thermal `NONE`, correct `app.id` verified.
- [ ] Paste the three `TN_STALL_SEGMENTS` lines and the three `TN_WARMUP` lines.

**Negative control (must be observed red):** the same APK with `warmUp: false` in
`threenative.config.ts` → `pipelineCompile` on the first present returns to seconds and
tap-to-playable returns to > 12 s. Paste it.

**Revert check:** revert the `game.ts` default → the `warmUp` spec fails and the device arm returns
to the red above.

**Checkpoint:** automated PRD checkpoint **and** manual: the owner watches one launch video or the
three pasted lines. Continue only on PASS.

#### Phase 3: The second launch is measured, and the persisted cache is decided

**Outcome:** one recorded number for the second cold launch's `pipelineCompile`, and a decision.

**Files (max 5):**

- `docs/verification/runtime-perf-state.md` — EDIT §6: first vs second cold launch
  `pipelineCompile.ms` on the phone and on desktop Dawn.
- `docs/architecture/NATIVE-PERF-BOTTLENECKS.md` — EDIT the first-frame-hitch row with the
  outcome.

**Pre-registered rule:**

- If the second launch's `pipelineCompile` is **≤ 25 %** of the first on the phone, the driver
  cache is doing the job; write that down and stop.
- Otherwise file `PRD-33X — compiled pipelines survive a relaunch` naming the mechanism per
  backend: Dawn's device cache descriptor with load/store callbacks into the app storage root on
  desktop; on Android wgpu-native, either an upstream pipeline-cache hook or the Dawn-on-Android
  arm from PRD-329 — whichever PRD-329 Phase 2 has by then made buildable. Do not implement it
  here.

**Checkpoint:** the record says which branch was taken. Automated PRD checkpoint.

#### Phase 4: A mid-game synchronous compile is a named hitch

**Outcome:** after the first present, a synchronous pipeline compile on the main loop is reported
inside `TN_FRAME_HITCH` with its millisecond cost and call count, and `playtest perf` prints it.

**Files (max 5):**

- `packages/runtime-native/include/mystral/stall_budget.h` — EDIT: after the first present, keep
  a per-frame `pipelineCompile` accumulator (ms, calls) that the hitch reporter reads and resets
  each frame.
- `packages/runtime-native/src/webgpu/bindings_presentation.cpp` — EDIT: where
  `frameHitches().record()` runs, attach `{pipelineCompileMs, pipelineCompileCalls}` to the hitch
  payload.
- `packages/playtest/src/perf/*.ts` (the `perf` subcommand's parser) — EDIT: print the field
  when present.
- `packages/playtest/__tests__/perf-*.spec.ts` — EDIT: a hitch line with the field renders it;
  a hitch line without it still parses.
- `packages/runtime-native/tests/` — EDIT the existing stall-budget shape test if there is one;
  otherwise the presentation contract test asserts the new fields.

**Negative control:** a scene that introduces a new material 5 s in (any playtest fixture with
a late `MeshStandardMaterial` swap) → the hitch names `pipelineCompile`; with the accumulator
reset disabled, the field never appears.

**Checkpoint:** automated PRD checkpoint. Move this PRD to `docs/PRDs/done/` with PRD-218's
criteria 1 and 2 ticked in the same commit.

## 6. Acceptance criteria

1. **The async entry is real.** The contract executable shows the main thread inside
   `createRenderPipelineAsync` for < 25 % of the synchronous compile time on every desktop
   backend, and the promise resolves with a usable pipeline. *Red:* the sync wrap (Phase 0).
2. **Warm-up compiles on native.** `TN_WARMUP.compiled` equals the first frame's distinct
   pipeline count and `timedOut:false`, on desktop and on the phone. *Red:* `compiled:0,
   timedOut:true` on the pre-PRD host (already recorded in `game.ts:213`).
3. **Launch ≤ 8 s.** Three cold launches, physical Pixel 8, unplugged, thermal `NONE`,
   tap-to-playable ≤ 8 s median; first present `pipelineCompile.ms ≤ 500`. *Red:* `warmUp:
   false` arm (Phase 2).
4. **No two implementations.** `install-async-pipelines.js` is gone; `grep -rn
   createRenderPipelineAsync packages/runtime-native/src` shows only the native install.
5. **Second launch decided** under the pre-registered 25 % rule, in the record.
6. **Late compiles are named.** `TN_FRAME_HITCH` carries `pipelineCompile` after the first
   present; `playtest perf` prints it.

## 7. Out of scope

- Shader-side work (three's TSL → WGSL generation time, `shaderCompile` segment) — measured at
  1.8 ms desktop, small on the phone's record; not this PRD.
- Texture upload (346 MB on Bayview) — an asset-pipeline question (`@threenative/assets`), not a
  host question.
- Implementing the persisted cache (Phase 3 files it if the number says so).
- Anything that changes what a pipeline draws.
