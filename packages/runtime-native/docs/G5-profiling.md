# G5 — profiling

**Milestones:** M15, M16
**State:** IN PROGRESS. Physical Android attribution and engine pricing remain open.

No optimization fast path is accepted before a profile records the bottleneck. Evidence
must name the target, hardware, scene, build, sample duration and before/after measurement.
Simulator and emulator measurements may prove plumbing but must not stand in for physical
driver or phone-performance evidence.

## PRD-068 measurement path

The Android JavaScript-engine spike now has a default-off, fail-closed measurement path:

- `RuntimeConfig.vsync` selects FIFO or a supported uncapped present mode and preserves it on
  resize. An uncapped request refuses to fall back silently to FIFO.
- `TN_ANDROID_JS_NATIVE` records `Engine::getName()`, the six hot render-command counts and
  their time, plus submit/poll and present time for every submit.
- `examples/native-smoke` can bake a named mesh count, visibility rung, shared/distinct
  materials, and the 2,358-object pure-JavaScript matrix workload into one hashed bundle.
- `measure-android-js-engine.mjs` rejects missing or duplicate markers, subject drift, mixed
  engine identities, emulators, and any physical serial other than the named Pixel 8.

On 2026-08-10, `emulator-5554` proved only that this plumbing executes. After correcting the
measurement window to cover exactly 60 frame intervals, a 100-mesh, 0%-visible development run
recorded exactly 120 submits, 15 counted calls/frame, 0.0104 ms/frame in the six timed bindings,
and 11.01 ms/frame uncapped. The busy-loop control moved the binding figure to 0.1445 ms/frame,
about 14x. The same bundle with FIFO present reported 16.68 ms/frame. Kernel `VmHWM` recorded
171,924 kB peak RSS; actual `llvm-strip --strip-all` output was 20,099,904 bytes with 12,607,756
`.text` bytes. The final footprint pass also includes stripped `libSDL3.so`, producing a
22,338,816-byte total across packaged x86_64 shared libraries. A separate five-launch
development run reached the exact first-frame marker at a
1,023.6 ms p95. These are x86_64 emulator numbers under `packages/runtime-native/.runtime/`;
they are not PRD findings and satisfy no physical-hardware acceptance criterion.

The call-counter blind control is now a real JavaScript-side change: `--extra-draw-control`
adds one visible shared-geometry mesh. The emulator's main render submit changed from two to
three `drawIndexed` calls while its second submit was unchanged. The owning proof run was
interrupted by a concurrent PRD-066 package install on the shared emulator, so this remains a
development observation and the physical control is **UNVERIFIED**.

Candidate comparisons now fail closed unless both reports are acceptance-eligible Pixel 8 runs,
both exact packaged runtime hashes resolve to `-O2` CMake outputs, each has five cold starts, the
candidate has a clean-build time, the bundle SHA is identical, the stripped runtime SHA is
different, and the candidate reports the requested `Engine::getName()`. Every report owns a
separate sibling logcat file and content-addressed APK. Comparison reopens the control APK and
recomputes its complete native footprint and packaged JavaScript hash, so later builds cannot
silently replace either half of its evidence. The archived path is created before verification
and is the exact APK installed; evidence-eligible runs reject `--skip-install`.

Still owed on Pixel 8 serial `37251FDJH0037Z`: the full visibility ladders for both subjects,
Chrome-on-device pure-JavaScript comparison, varied-material crossing result, candidate-engine
measurements, every remaining negative control, and the decision record.

### Phase 2B cheapest-disqualifier audit

No candidate is eliminated before measurement:

| Branch | Audit status | Pinned dependency fact | Still unmeasured |
| --- | --- | --- | --- |
| JavaScriptCore | **SURVIVES.** The arm64 build enables the baseline JIT, with DFG and FTL disabled. | `jsc-android@294992.0.0`; its [tagged build script](https://github.com/react-native-community/jsc-android-buildscripts/blob/v294992.0.0/scripts/compile/jsc.sh#L43-L84) is the configuration evidence. | Adapter refactor, runtime JIT activation, size, build time and device performance. |
| Hermes | **SURVIVES.** JSI can retain caller storage as a no-copy external ArrayBuffer. | Hermes `v0.13.0`; [the implementation passes `MutableBuffer::data()` to the external data block](https://github.com/facebook/hermes/blob/v0.13.0/API/hermes/hermes.cpp#L2060-L2077). | Adapter, lifetime negative control, size, build time and device performance. |
| V8 | **CONDITIONAL.** A pinnable JIT artifact exists, but it contains V8 10.0 rather than the desktop pin and is not drop-in compatible. | [`v8-android-jit-nointl@11.1000.4`](https://registry.npmjs.org/v8-android-jit-nointl/-/v8-android-jit-nointl-11.1000.4.tgz), SHA-256 `46870658adfe0f6eaa4819226af37a25663bd54599304dd7d7c91ed1089dae9e`; arm64 `libv8android.so` is 15,507,808 bytes. | V8 10 adapter compatibility, snapshot staging, NDK/page compatibility, packaged size, build time and device performance. |

This table is dependency research, not engine pricing. Every performance and packaged-runtime
cell remains **UNMEASURED**, so it supports no recommendation.

## PRD-070 cold-start instrument — physical Pixel 8, 2026-08-11

`scripts/measure-cold-start.mjs` closes the hole that nothing in this repository measured launch
time. `include/mystral/cold_start.h` stamps every launch boundary from one monotonic clock as
`TN_COLD_START:{"segment":…,"atMs":…}`, so a reader subtracts two numbers rather than two logcat
timestamps from two different clocks.

Five cold launches, `fox-native`, native runtime `-O2`, serial `37251FDJH0037Z`: total **2,882 ms
median, 3,031 ms p95**, range 2,652–3,031 ms.

| Segment | Median | Share |
| --- | --- | --- |
| host bring-up | 0 ms | 0.0% |
| bundle read from APK | 13 ms | 0.4% |
| runtime creation | 34 ms | 1.2% |
| JavaScript parse and compile | 230 ms | 8.0% |
| bundle top-level execution | 43 ms | 1.5% |
| **first rendered frame** | **2,500 ms** | **86.8%** |

**Consequence: QuickJS bytecode precompilation is recommended against on this subject.** It targets
the 8.0% segment. The first-frame segment — WGSL built in JavaScript and pipelines compiled on
first draw — is where launch lives. A persisted pipeline cache is separately confirmed unreachable:
`wgpuDeviceCreateRenderPipeline` takes only a descriptor and the bound `webgpu.h` has no
`PipelineCache` type.

The instrument fails closed and each control was observed: an `emulator-*` serial exits 2 with
`TN_COLD_START_EMULATOR_BLOCKED` before measuring, a single launch is rejected as malformed input,
an unnamed build type is rejected, and a missing or malformed segment marker exits non-zero naming
it rather than reporting a partial total. That last control fired on the first real run: the host
evaluates two bootstrap scripts through the same `evalScript` path, so `game_eval_begin` now
brackets the game's own compile.

Largest stall in the session is not launch. `SceneCollapse` bakes inside one frame, measured at
**3,608 ms**, now **1,845 ms** after replacing `BufferGeometry.applyMatrix4` with a direct
typed-array transform; it is reported as `SceneCollapseReport.bakeMs`. (`SceneCollapse` was
deleted on 2026-08-21 — PRD-152's `SceneRenderProjection` is the shipping mechanism, and it
never rewrites the authored graph, so this stall no longer exists to measure. The numbers
below are kept as the record of the session that measured them.) Keeping indices instead of
expanding to non-indexed geometry was tried and **measured worse** (2,658 ms), and reverted.
## Cooperative compile scheduling — Linux, 2026-09-05

The host now queues `scheduler.yield()` continuations separately from frame-coupled timers.
It drains them with microtask checkpoints, bounded to 2 ms or 1,024 tasks per loop, then
returns to input, timers and presentation. Shutdown and reload release queued callback handles;
queued work also keeps no-SDL execution alive. No new public global or game option is introduced.
The time slice is cooperative: one synchronous callback or a self-replenishing microtask chain
cannot be preempted by this queue, just as it cannot be preempted by the existing timer loop.

The real-host contract in `tests/fixtures/scheduler-yield.js`, executed by the existing required
Linux `tests/runtime-next-contract.test.mjs` lane, failed before the change: 120 empty yields
crossed 120 frames. After rebuilding, they crossed zero frames; a controlled 50 ms workload
still allowed 25 animation callbacks and 25 timer callbacks. The native tests passed 37 cases
with 2 skips. This supplements the Node-hosted shim tests, which could not observe native
timer/frame coupling.

The freshly rebuilt Wildwood executable then ran for 75 seconds on private X11. Its third
300-frame window no longer reported compilation, at resolution scale 1; before this change,
all three completed windows reported compilation. This is not a presented-FPS result, and
the bounded warm-up still reported an abandoned scene compile during startup. No Android,
iOS, macOS or Windows execution is claimed for this change. Raw logs are under
`artifacts/wildwood-native-profile-20260905/scheduler-{native-green,suite,wildwood}.log`;
the broader evidence is in `docs/verification/native-canvas-presentation-2026-09-05.md`.

The rebuilt Wildwood passed all five native gameplay assertions (world/UI ready, movement
26.4476 m, odometer 26.7 m, zero game error diagnostics); its world screenshot was inspected.
Full `pnpm test` exited 0 with 4,299 passed / 4 skipped tests, and `pnpm typecheck` exited 0.
Changed-file Biome checks are clean. Root `pnpm lint` still exits 1 on eight pre-existing
`.linchpin` formatting errors, which were left untouched. Logs: `scheduler-native-flow-console.log`,
`scheduler-root-tests.log`, `scheduler-typecheck.log`, `scheduler-scoped-lint.log`, and
`scheduler-lint.log` in the artifact directory above.

The same fixture subsequently passed on the rebuilt Linux QuickJS host: zero crossed frames
for 120 empty yields, and 24 frames/timer callbacks during sustained work (exit 0,
`scheduler-quickjs-contract.log`). The required native test now executes both host variants;
the existing QuickJS CI build additionally builds `mystral`. This extends JS-engine coverage,
not platform coverage: physical Android and iOS/JSC remain unexecuted for this change.


## PRD-368 qualified compiler-cache persistence — 2026-09-10

The device owner now loads a versioned app/build/shader/adapter/driver/backend/ABI-qualified
compiler blob before pipeline creation. After settled compiles and later presents, one background
snapshot writes a bounded, checksum-validated, atomic replacement in existing app-private storage.
The compile workers and snapshot share device lifetime; teardown joins both. Unsupported backends
remain explicit. The game’s materials, warm-up choices, and scheduling policy are unchanged.

`TN_PIPELINE_CACHE` now separates load acceptance/rejection, serialized bytes, durable store
outcome, and load/snapshot/write costs. The owned cold-start CLI accepts `--pipeline-cache-pairs`
and `--startup-scenario`; the same installed APK runs empty, populated, and disabled-before/after
controls. Its validator requires complete matching compile populations, observed first-playable
and movement receipts, and qualified device conditions. A successful blob import is not a hit.

[The verification record](../../../docs/verification/prd-368-persistence-2026-09-10.md) distinguishes
executed sanitizer/filesystem and pinned dependency builds from host lifetime and physical timing
evidence still being collected. Hosted Lavapipe serializes only a header: its separate lifecycle
contract cannot prove compiled-data persistence, a speedup, or Pixel performance. The original
compiled-data-growth test stays strict. No <=8,000 ms or >=75% startup compile reduction is claimed.

## Desktop V8 profile ownership (2026-10-18)

The CLI profile path and start/dump callbacks are thread-local, so a worker engine cannot replace
the main engine's profiler. The two-thread regression fails with the previous declarations and
passes with this repair. Five profiler tests pass; the default-path built-host test is skipped.
Separately, a Release V8/Dawn host with `TN_JS_PROFILE=ON`, built from `3e5fb67ba`, has SHA-256
`0b8431a256892180d043572d492962d5391631a9928accd2cd25bce86d79a5a6`. Its actual headless
NVIDIA GeForce RTX 2080/Vulkan run of the existing quoted/backslash source-URL fixture produces
valid JSON, preserves the exact URL, and records 654 samples over 0.515223 seconds. This proves
desktop profiling plumbing, not a performance improvement or an Android result.

The Strata terrain diagnostic now records the main game bundle instead of only worker scripts:
718,835 samples over 495.070974 seconds. The host's supported SIGTERM flush ended this
instrumented run after 15 screenshots. The final CLI diagnostic is `Invalid string length`;
its origin and timing are unproven, and the failed report does not retain the game's adapter
identity. Full scenario acceptance, matched timing and physical Android attribution remain open.
