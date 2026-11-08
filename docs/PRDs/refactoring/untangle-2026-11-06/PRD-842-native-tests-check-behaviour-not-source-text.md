# PRD-842 — Native tests check behaviour, not source text

**Status:** PARTIAL — Phase 1 and Phase 2 box 1 done. Phase 2 box 2 and AC-2 stay open: the iOS WebUI order tests and the `ui_overlay.cpp` and `window.cpp` slices in `ui-layer-host-contract.test.mjs` still read source as text. The other text readers are named wire contracts. AC-1 passed.
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
- [ ] AC-2 [local]: Source-text tests remain only for the ABI digest and the named wire contracts. Not met: 18 readers before, 4 now (the ABI spec, 2 other named wire contracts, and `ui-layer-host-contract` with its open tests), see Phase 2. proof: `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists only the ABI spec and the named wire contracts

## Integration Ledger

Integration: tests, five new native test targets and host-run vitest files. Four small seams in runtime source, with no behaviour change: `vfs::resolveFetchPath` (same mapping, in `embedded_bundle.h`), the `TN_WINDOW_MODE` host marker, `buffer_map_state.h` (the buffer-map state moved out of `context.cpp`), `platform/resize_plan.h` (the resize decision) and `canvas/font_backend.h` (platform to font backend, dispatched through `makeFontMgr<Backend>()`).

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
  Done: 14 of the 18 `.cpp|.mm` readers are gone. Left: the ABI spec, `ios-packaging`, `ios-contract` and `ui-layer-host-contract` (wire contracts by the Decision below). Open: the iOS WebUI order tests and the `ui_overlay.cpp` and `window.cpp` slices in `ui-layer-host-contract.test.mjs`. `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists them.

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

Restored on 2026-11-08 (the lead ruled that a deleted check must be converted, not dropped):

| Behaviour | Test | Red check |
| --- | --- | --- |
| `fullscreen`, `maximized` and `resizable` config keys, fullscreen wins over maximized | `host-window.test.mjs`. The host prints `TN_WINDOW_MODE:{...}`, the mode it hands to SDL. No window manager needed | with fullscreen no longer winning, and with the embedded keys ignored when a flag is set, 3 tests fail |
| `--windowed`, `--maximized`, `--fullscreen` override the embedded mode | `host-window.test.mjs`, same marker | same run |
| `display.maxFps` reaches the presentation cap | `host-window.test.mjs` reads `Presentation cap: N fps` (30, 144, and the 60 default) | skipping the `maxFps` parse fails it |
| mobile fetch path mapping (`resolveFetchFilePath`) | the mapping moved to `vfs::resolveFetchPath(path, platform)` and `embedded_bundle_test.cpp` asserts all three platforms, so Linux runs the Android and iOS branches | dropping the Android `game/` prefix fails 3 asserts |
| `pollEvents()` head stamp ahead of the paused return | `host-window.test.mjs`: unmap the X window, wait 1.5 s, map it; `TN_PUMP_SILENCE.maxGapMs` must stay under 250 ms | stamping after the paused return reads 1511 ms and fails |
| `production-profile`: screenshot mailbox protocol in `runtime.cpp` | `host-window.test.mjs`: a game clears to magenta, the test writes `tn-playtest-screenshot-request.txt`, and the saved PNG is magenta and the request file is gone | renaming the request file in `runtime.cpp` fails it |
| `production-profile`: `BufferMapDataPtr` outlives a timed-out wait | `buffer_map_state.h` holds the state; `threenative-buffer-map-lifetime-test` (contract lane, 55 targets now) drops the waiter's share before the late callback | a callback that holds no share fails 3 asserts |
| `traa_reference_test`: resolve arithmetic and reset seed | `traa_resolve_blend` in `renderer_test.cpp` reads the resolved pixel back on the RTX 2080: still 0.5, noisy neighbourhood 0.22437 (worked by hand 0.22447), stale history clipped to 0.5. The seed order is already read back by `traa_reset_seed` | raising the base current weight 0.05 to 0.10 gives 0.2493 and fails it |
| `web-host-refusal` | `web-host-refusal.test.mjs` runs the built Wasm host in Chromium (WebGPU, private Xvfb) through `fixtures/web-host-refusal-probe.mjs`: the read returns 0, the error names the slot, the host is still Ready after two reads | replacing `refuse()` with `fail()` in `tnw_web_read_mrt` leaves the host Failed and fails it |


Two more rows of the restored table, added on 2026-11-08 after the lead asked for a deterministic seam:

| Behaviour | Test | Red check |
| --- | --- | --- |
| `resize-event-no-reconfigure`: a resize event syncs the platform window and does not reconfigure the surface | `planResizeEvent` in `include/mystral/platform/resize_plan.h` holds the decision. `dispatchResizeEvent` calls it and obeys the plan. `threenative-platform-policy-test` (contract lane, 56 targets now) asserts `syncPlatformWindow` and `!reconfigureSurface` | returning `reconfigureSurface = true` fails it (`FAIL !plan.reconfigureSurface`). With that value, the call site reaches `resize()`, the call that aborted a Pixel 8. The test file `resize-event-no-reconfigure.test.mjs` is deleted |
| `android-canvas-skia`: Android builds the system font manager, not Fontconfig or the empty manager | `fontBackendFor` in `include/mystral/canvas/font_backend.h` maps platform to backend. `canvas2d.cpp` builds the manager through `makeFontMgr<Backend>()`, and a backend that the mapping picks but the file does not define fails to link. `font_backend.h` also holds a `static_assert` that the Android build checks, outside the Skia `#if`, so every Android compile runs it. The same policy test asserts the mapping | mapping Android to `FontConfig` fails the policy test, and `g++ -D__ANDROID__ -fsyntax-only` fails with `static assertion failed: Android canvas text needs the Android system font manager`. The gradle Android build compiled the new code and the first proof passed 4/4 on the emulator |

Limit of the font check: the factories share one return type, `sk_sp<SkFontMgr>`, so the build pins which backend a platform picks and not the body of the Android factory. Swapping `SkFontMgr_New_Android` for `SkFontMgr::RefEmpty()` inside `makeFontMgr<AndroidSystem>()` still compiles. No Android gradle build can catch that swap today (see the Finding below). The old text test caught it in a Skia-enabled build only.

## Finding (2026-11-08): the Android gradle build ships no Skia canvas

`packages/runtime-native/android/app/build.gradle.kts:380` passes `-DTN_ENABLE_CANVAS2D=OFF`. The Android APK compiles `canvas2d.cpp` without `MYSTRAL_HAS_SKIA`, so `SkFontMgr_New_Android` is not in the APK. Measured on the QuickJS build, x86_64 emulator `threenative_api35` (API 35, swiftshader), real source:

- `measureText("iiii").width` and `measureText("MMMM").width` both return 57.6 at `24px sans-serif`. That is exactly `length * size * 0.6`, the no-Skia estimate in `Canvas2DContext::measureText`.
- `getImageData` returns 15 360 bytes with no ink after a `fillRect` and after a `fillText`. The no-Skia stub does not draw.

So an Android game that uses canvas text gets an estimated width and no pixels. The earlier emulator run in this lane (a `RefEmpty` mutation that read 48 for both strings) hit the same stub. It proved nothing about fonts, and its result is withdrawn. The finding is not fixed here. The owner decides whether Android should ship Skia canvas. The V8 build could not run on this machine (`third_party/v8-android/build-receipt.json` is missing), so the numbers come from QuickJS. The canvas path does not depend on the JS engine, but no V8 run confirms it.

## Decision (2026-11-08): cross-language wire contracts

A wire contract is a test that compares two source files, written in different languages or built for different platforms, that must agree on one name or value. Neither side has a seam to call from a desktop test, because the other side runs on a device. These tests stay as text checks beside the ABI digest. Each names its wire and the evidence that it is one:

| Wire | Between | Evidence |
| --- | --- | --- |
| `TNMaxFps` plist key (`ios-packaging.test.mjs`) | `scripts/package-ios.mjs:186` writes it into `Info.plist`, and `ios/main.mm:97` reads it | `rg TNMaxFps scripts ios` finds exactly these two sites. The key is a string in two languages, and a rename in one breaks the frame cap on iOS only |
| UI bridge names (`ui-layer-host-contract.test.mjs`, tests 1-4) | `core/src/ui-bridge.ts` (`UI_BRIDGE_GLOBALS`), `TnUiOverlay.java`, `ui_overlay_ios.mm`, the Rust `abi.rs` and `offscreen.rs`, and `ui_overlay.cpp` | The page-facing object `tnHost` and the inbound global `__tnUiReceive` must be the same string in five sources. The test reads the names from `ui-bridge.ts` instead of restating them |
| No web view in the iOS app shell (`ios-contract.test.mjs`) | `ios/main.mm` and `ios/ui_overlay_ios.mm` | `rg -c WebView ios/` finds 12 hits, all in `ui_overlay_ios.mm`, and none in `main.mm`. The shell draws through the owned renderer, and the web UI reaches the page only through the bridge above. This is the weakest case: its form is a single-file lint. The lead classed it as a wire, and the boundary is the shell and overlay split |

The Decision does not cover the other tests in `ui-layer-host-contract.test.mjs`: the iOS WebUI order tests on `ui_overlay_ios.mm` and `main.mm`, and the slices of `ui_overlay.cpp` and `window.cpp`. They compare one platform's own source with itself and stay open.

iOS removals in this lane (the `jsc_engine.mm` text match and the `ios-contract` text tests) are covered only by the macOS `build-ios-simulator` job. Unverified here.

`web-host-refusal.test.mjs` no longer reads source. It needs `pnpm wasm:build` and Chromium with WebGPU, so it skips when `build/wasm` is absent. No CI job builds the Wasm host and runs it yet. That wiring is open.

Files that still read `.cpp` or `.mm` as text:

| File | Class |
| --- | --- |
| `web-host-abi.spec.ts` | wire (ABI digest, by design) |
| `ios-packaging.test.mjs` | wire (`TNMaxFps`) |
| `ios-contract.test.mjs` | wire (shell and overlay split) |
| `ui-layer-host-contract.test.mjs` | wire for tests 1-4. Open for the iOS WebUI order tests and the `ui_overlay.cpp` and `window.cpp` slices |

