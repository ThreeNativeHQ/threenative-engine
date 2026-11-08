# PRD-842 — Native tests check behaviour, not source text

**Status:** PARTIAL — Phase 1 and Phase 2 box 1 done. Phase 2 box 2 and AC-2 stay open for 8 platform-bound files (see the table in Phase 2). AC-1 passed.
**Priority:** P2 — the open box replaces regex assertions over `runtime.cpp`, `bindings.cpp` and platform sources, which go red on renames and stay green on behaviour regressions.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — N5

## Context

Report ids D2, D5. In 120 days, `bindings.cpp` changed in 86 commits and `runtime.cpp` in 71.
These are the two most-changed native files, and 35 test files read them as text.

| Problem | Where |
| --- | --- |
| 35 test files (12 397 lines) read `bindings.cpp`, `runtime.cpp`, `browser-renderer.ts` or `frame-op-stream.js` as text. They hold 166 `assert.doesNotMatch`. | `packages/runtime-native/tests/`, `packages/three-native/__tests__/` |
| The timer contract slices `runtime.cpp` between two literal strings | `packages/runtime-native/tests/timer-contract.test.mjs:21-30` |
| `embedded-js.mjs` hardcodes 7 historical C++ block names | `packages/runtime-native/tests/embedded-js.mjs:17-26` |
| `js-engine-fast-path.test.mjs` loads 3 engine sources as text | `packages/runtime-native/tests/js-engine-fast-path.test.mjs:12-20` |
| `MYSTRAL_USE_LIBUV_TIMERS` is a derived macro (`runtime.cpp:73-76`). Desktop runs the libuv timers. Android and iOS run the `#ifndef` twin. A test locked the shape of `runtime.cpp` text instead of timer behaviour. | `packages/runtime-native/src/runtime.cpp:73-76,910-960,2871-2983` |

## Correction (2026-11-07, measured)

The Context row claims `MYSTRAL_USE_LIBUV_TIMERS` "is defined in no build". It is **not** dead, and
Phase 1 cannot be executed as written:

- the macro is derived, not defined by a build: `runtime.cpp:73-76` sets it when
  `MYSTRAL_HAS_LIBUV` is defined and the target is not Android or iOS;
- `packages/runtime-native/CMakeLists.txt:1320,1359` adds `MYSTRAL_HAS_LIBUV` on desktop, so the
  libuv timer path is the one every desktop build runs;
- its twin under `#ifndef` is the path Wasm, Android and iOS compile.

So there is no undefined-macro branch to delete, and deleting either implementation would break a
platform. What the phase should claim instead: timer ordering is proved by `timer_delivery_test.cpp`
and `timer-contract.test.mjs` stops slicing `runtime.cpp` as text. That rewording is the owner's or
the next agent's call, not a silent edit of the box.

## Decision (2026-11-08)

The lead decided on the Phase 1 correction above, citing its measurements: `MYSTRAL_USE_LIBUV_TIMERS`
is a derived macro, and both timer implementations ship. Libuv timers run on desktop. The
`#ifndef` twin runs on Android and iOS. Neither implementation is deleted. Phase 1 now proves timer
ordering by running the host, not by slicing `runtime.cpp`.

The `#ifndef` twin has no desktop test. No CMake option builds desktop without libuv, and the
runtime library compiles once per build tree, so a per-target define cannot select the twin. The
Android and iOS device lanes are the only runs of that code. This lane did not run them.

## Solution

Each asserted behaviour gets a callable seam: timer semantics through `timer_delivery_test.cpp`,
staging call order through a C++ unit test, and shim bootstrap through the embedded-bundle test.
The text assertions are deleted. The ABI digest in `web-host-abi.spec.ts` stays, because it guards a
real wire. Both timer implementations stay (see the Decision below).

## Acceptance Criteria

- [x] AC-1 [local]: The native host runs with timers and shims intact. proof: `pnpm native:verify:desktop` exit 0 (2026-11-08): `native contract lane passed: 54 of 54 targets` (includes `threenative-timer-delivery-test`, `-timer-engine-first-test`, `-shim-bootstrap-test` in 3 modes, `-webgpu-wrapper-bag-test`, `-image-decode-teardown-test`, `-worker-production-test`), desktop core gate 300 frames at 1280x720 with a screenshot, `tests/external-bundle-discovery`, `host-cli` and `host-window` 18 of 18 tests
- [ ] AC-2 [local]: The source-text test count drops to the ABI digest only. Not met: 18 readers before, 9 now (8 platform-bound files plus the ABI spec), see Phase 2. proof: `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists only the ABI spec

## Integration Ledger

Integration: unchanged — tests, three new native test targets and two new host-run vitest files. No runtime source changes.

## Execution Phases


#### Phase 1: Timers
**Status:** DONE
**Files:** `tests/timer-contract.test.mjs`, `tests/timer_delivery_test.cpp`, `scripts/verify-native-contracts.mjs`.

- [x] `timer-contract.test.mjs` no longer slices `runtime.cpp` as text, and timer ordering is proved by `timer_delivery_test.cpp` on the desktop path. Both timer implementations stay. proof: `build/tn-linux/threenative-timer-delivery-test` and `threenative-timer-engine-first-test` print their pass lines and exit 0 (2026-11-08). The 269-line text test is now a 12-line wiring check of `executionContracts`. Red check: with the post-engine installation skipped in `runtime.cpp`, all three host binaries exit 1 (`could not create headless native runtime`). Platform note: the `#ifndef` twin is covered only by the Android and iOS lanes, which this lane did not run (see the Decision).

#### Phase 2: Bindings and shims
**Status:** PARTIAL
**Files:** `tests/embedded-js.mjs`, `tests/shim_bootstrap_test.cpp`, `tests/webgpu_wrapper_bag_test.cpp`, `tests/image_decode_teardown_test.cpp`, `tests/host-cli.test.mjs`, `tests/host-window.test.mjs`, and the text specs listed in the tables.

- [x] Shim bootstrap and fast-path selection are asserted by running the host, and the 7 historical block names are gone. `tests/js-engine-fast-path.test.mjs` is deleted. proof: `threenative-shim-bootstrap-test` passes in three modes (default, `--worker-rollback`, `--callback-retention`), `threenative-webgpu-wrapper-bag-test` passes, and `rg SCRIPT_FOR_BLOCK packages/runtime-native/tests` returns nothing. Red checks: skipping the streams shim makes `Runtime::create` fail (`Web Streams not available`), and passing the borrowed `document.addEventListener` handle makes `--callback-retention` fail (`listener:0`). `embedded_bundle_test` tests the VFS container only, so it does not carry this claim.
- [ ] The remaining text specs on `bindings.cpp`, `runtime.cpp` and `browser-renderer.ts` are replaced by behaviour checks or deleted when a behaviour test already covers them. proof: AC-2
  Done: 10 of the 18 `.cpp|.mm` readers are gone. Open: 8 files, each platform-bound (second table). `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists them plus the ABI spec.

Every removed assertion and the test that covers it:

| Removed text assertion | Covered by |
| --- | --- |
| `timer-contract`: no engine `setTimeout` stub, install order, `performance.now` monotonic, fail-closed executable | `timer_delivery_test.cpp`, both binaries: a stub or a skipped install breaks delivery or `Runtime::create` |
| `js-engine-fast-path`: own data property, V8 entry scope | `js_engine_contract_test.cpp` (`property=own-data`, nested callbacks) |
| `js-engine-fast-path`: C++-only WebGPU metadata outside JS property bags | `webgpu_wrapper_bag_test.cpp` (own keys, prototype chain and `for in` of module, texture, view and pipeline). Red: a forbidden name on `createView` fails it |
| `js-engine-fast-path`: V8 callbacks retained | `shim_bootstrap_test.cpp --callback-retention` (timeout, interval, document listener after heap churn) |
| `js-engine-fast-path`: shader metadata release | `shader_module_metadata_test.cpp` (already ran) |
| `fetch-shim`: `playtestMailbox.network` in `runtime.cpp` | `shim_bootstrap_test.cpp` (`__THREENATIVE_NATIVE__.playtest.network === fetch.network`) |
| `native-worker-production`: rollback env text | `shim_bootstrap_test.cpp --worker-rollback` |
| `native-worker-production`: marker lines, registry drain and reopen, V8 task runner retire, clone matrix parity, failure paths | `threenative-worker-production-test` through the vitest packed contract: `finalMessageSurvivesSelfClose`, `shutdownJoinsEveryWorker`, `registryReopensForASecondRuntime`, `cloneMatrixRoundTrip`, `workerSideCloneRefusalReachesError`, `topLevelThrowReachesError`, `handlerThrowReachesError`, plus a check that each marker ends its line |
| `scheduler-yield`: `runtime.cpp` loads the script | `shim_bootstrap_test.cpp` (`scheduler.yield`, `self.scheduler`) |
| `run-script-ordering` and its line-count limits | `host-cli.test.mjs`: the bridge exists at script load, then the loop fires the script timer. Red: wiring the bridge after `loadScript` fails it. Line counts belong to `pnpm quality` |
| `host-gap-meter` | `host-cli.test.mjs`: 300-frame window, default and `TN_HOST_GAP_DETAIL=1` sample shapes, exact-`1` rule. Red: dropping the period assignment fails 3 tests |
| `ui-layer-packaging`: web UI fails closed | `host-cli.test.mjs` (`TN_UI_BUNDLE_MISSING`, `--bypass-ui-loading`) |
| `desktop-assets`: title, size, resizable, `uiRenderer`, icon, escaped JSON title | `host-window.test.mjs` (packaged binary under Xvfb). Red: wrong key names fail it, and a disabled `SDL_SetWindowIcon` fails the icon test |
| `pump-silence`: 4 text tests | the real-host tests in the same file |
| `async-image-decode`: bindings invalidate the owner before engine teardown | `image_decode_teardown_test.cpp`. Limit: three independent guards protect the teardown, so removing one does not fail the test. The test fails on a crash or hang across Runtime recreation |
| `mobile-assets`: mobile fetch path mapping | none on this machine. The Android emulator and iOS simulator lanes load the packaged game through that path. This lane did not run them |

Not covered by any behaviour test (the assertions are gone, so these are open risks):

- `desktop-assets`: the `fullscreen`, `maximized` and `maxFps` config keys, and the `--windowed`, `--maximized` and `--fullscreen` overrides. They need a window manager, and this machine has none. A `maxFps` frame-rate check may work and was not tried.
- `mobile-assets`: the Android and iOS path mapping in `resolveFetchFilePath`.
- `pump-silence`: the `pollEvents()` head stamp ahead of the paused and lifecycle early returns. The real-host tests cover the normal path only.

Files that still read `.cpp` or `.mm` as text, and why each stays:

| File | Why it stays |
| --- | --- |
| `web-host-refusal.test.mjs` | `web_host.cpp` is Wasm-only. A refused MRT read needs the browser and the Wasm build. No web playtest reads a slot the frame never wrote |
| `resize-event-no-reconfigure.test.mjs` | The abort happened on a Pixel 8 only. Linux reconfigures the surface without harm, so only a device run can show the regression |
| `ios-contract.test.mjs`, `ios-packaging.test.mjs` | `.mm` sources need macOS. The iOS simulator lane runs on the hosted macOS runner, not here |
| `ui-layer-host-contract.test.mjs` | Compares Java, Objective-C, Rust and C++ host sources for one bridge contract, and compiles slices of `ui_overlay.cpp` and `window.cpp`. Needs a seam per slice plus device lanes |
| `android-canvas-skia.test.mjs` | Android font manager text in `canvas2d.cpp`. Needs the Android lane |
| `production-profile.test.mjs` | Two tests: the `runtime.cpp` screenshot mailbox name, and the `BufferMapDataPtr` lifetime in `context.cpp`. Neither has a behaviour test yet |
| `native-engine/traa_reference_test.mjs` | Evaluates the WGSL resolve expressions from `traa.cpp` text and checks the seed order in `renderer.cpp`. Needs a GPU resolve readback |
| `web-host-abi.spec.ts` | The ABI digest. It stays by design |
