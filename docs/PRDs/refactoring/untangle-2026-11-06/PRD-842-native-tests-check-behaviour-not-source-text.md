# PRD-842 — Native tests check behaviour, not source text

**Status:** PARTIAL — Phase 1 and Phase 2 box 1 done. Phase 2 box 2 and AC-2 stay open until the macOS `build-ios-simulator` job passes with the new launch checks. The `ui-layer-host-contract` slice tests moved to PRD-862. AC-1 passed.
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
- [ ] AC-2 [local]: Source-text tests remain only for the ABI digest and the named wire contracts. The seven `open` rows of the last table moved to [PRD-862](PRD-862-untangle-native-leftovers.md) (Decision, 2026-11-09), so they stay as they are here. proof: `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists only the ABI spec and `ui-layer-host-contract`, whose remaining tests are the named wires and the seven rows PRD-862 owns, and the macOS `build-ios-simulator` job (native-release.yml, `release-proof` label) is green with the launch checks in the Decision. **Measured 2026-11-08:** the `release-proof` run 42533915774 went red on the seventh launch check (`web-ui-missing-bundle` did not log `TN_UI_BUNDLE_MISSING`); the other six passed. Recorded in Phase 2's box with the next step.

## Integration Ledger

Integration: tests, five new native test targets and host-run vitest files. Five small seams in runtime source, with no behaviour change: `vfs::resolveFetchPath` (same mapping, in `embedded_bundle.h`), the `TN_WINDOW_MODE` host marker, `buffer_map_state.h` (the buffer-map state moved out of `context.cpp`), `platform/resize_plan.h` (the resize decision) `canvas/font_backend.h` (platform to font backend, dispatched through `makeFontMgr<Backend>()`) and `platform::drainUiFramesToGame` (the split between hit regions and game frames). Two NSLog changes for the iOS launch checks: `TN_IOS_GAME_EVAL` in `ios/main.mm`, and a `parent` field in `ios/ui_overlay_ios.mm`.

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
  Done: 16 of the 18 `.cpp|.mm` readers are gone (`ios-contract` and `ios-packaging` joined them, with the iOS launch checks in the Decision as their replacement). Left: the ABI spec and `ui-layer-host-contract`. Proof still owed: the macOS `build-ios-simulator` job green on a `release-proof` run. The open rows of the last table moved to PRD-862.
  **Run 42648487428 (2026-11-09): the missing-bundle variant loaded the web-ui page** (`TN_UI_PAGE ready` from a fresh container, pid 42242), so the app it launched still held the previous variant's staged `ui/`. `verify-ios-simulator.mjs` now runs `simctl uninstall` before each variant install (`e5c89662d`).
  **First macOS run, 2026-11-08 (run 42533915774, `release-proof` label): red at 6 of 7 launch checks, one real gap.** The job built the simulator app (`** BUILD SUCCEEDED **`) and ran every variant; the plain smoke, `TNMaxFps`, `TNUIRenderer web`, `loaded:true`, `TN_UI_PAGE ready`/`first-state` and the `frame === parent` checks passed. It stopped at the seventh: `Error: iOS web-ui-missing-bundle launch failed: a web-renderer launch with no ui/index.html did not refuse with TN_UI_BUNDLE_MISSING` (log `artifacts/ios/variant-web-ui-missing-bundle.log`, uploaded as `evidence-ios-simulator-arm64`). So the refusal path exists in the host but does not print the marker on this launch, or the variant removes the bundle after the host has already resolved it. Not reproducible on Linux (`xcrun` and Objective-C++ are macOS-only), so the next step is the macOS lane: read the uploaded variant log and make the refusal emit `TN_UI_BUNDLE_MISSING` before the web view is created. The box stays open.
  **Second macOS run, 2026-11-09 (run 42541107269, job `build-ios-simulator`): red one variant earlier, at `web-ui`, not at `web-ui-missing-bundle`.** A CORS/MIME fix in `ui_overlay_ios.mm` (an `NSHTTPURLResponse` carrying `Access-Control-Allow-Origin: *` and a per-extension MIME map) landed in between, and the job now reaches the page-load variant and stops there: `iOS web-ui launch failed: - the page never finished loading (TN_UI_OVERLAY loaded:true) - the page module never ran (no TN_UI_PAGE ready) - the page never received game state (no TN_UI_PAGE first-state)`. The judge's other checks passed, which localises it: `TN_UI_OVERLAY attached:true`, `TN_IOS_GAME_EVAL` and `TN_UI_OVERLAY firstState:true` (frame `==` parent, non-zero size) all landed, and there is no `loaded:false` and no `TN_UI_PAGE [error]`. So the host attached, evaluated the game and delivered state, and the **main-frame navigation neither finished nor failed** — the shape of a `WKURLSchemeTask` that is never completed, not of a wrong MIME type (that logs `loaded:true` with a silent module, which the CORS fix in `ui_overlay_ios.mm:118-140` already covers). The `TN_UI_BUNDLE_MISSING` marker the first run asked for already sits before the web view exists (`ios/main.mm:127` logs it and returns 2 before `attachIosUiOverlay`), so that half of the instruction is satisfied by reading; the open question is the navigation. Not reproducible on Linux, so the box stays open.
  **The log that would answer it did not survive the run.** `artifacts/ios/variant-web-ui.log` is written by the throw itself, but `native-release.yml` uploaded `packages/runtime-native/artifacts/ios/` only after `verify-ios-simulator.mjs` succeeded, so the failing job uploaded no iOS evidence at all (`gh api .../runs/42541107269/artifacts` lists `evidence-desktop-*`, `release-prerequisites-*` and `runtime-android` only). The evidence upload now also runs when an earlier step failed (`if: ${{ !cancelled() }}`) and warns instead of failing when an early failure left nothing to upload; the runtime zip upload stays success-only and `if-no-files-found: error`. `scripts/__tests__/native-release-proof.spec.ts` 57/57 with the change; nothing pins that upload's shape.
  **The log is readable now, and it moves the next step (run 42562228363, job `build-ios-simulator`, `evidence-ios-simulator-arm64`).** `variant-web-ui.log` (1998 lines) says the page is *not* the problem:
  - `TN_UI_OVERLAY:{"attached":true}` at 05:03:30.377, `TN_IOS_GAME_EVAL` 1 ms later, `TN_UI_OVERLAY:{"firstState":true,"frame":"{{0, 0}, {480, 320}}","parent":"{{0, 0}, {480, 320}}"}` at 05:03:31.177 — the host half worked, the overlay is pinned to its parent and sized.
  - `WebPageProxy::loadRequest` 05:03:30.096, then a 5.8 s stall while the Network process launched (`NetworkProcessProxy` 30.097 -> `didFinishLaunching` 33.577), then `didStartProvisionalLoadForFrame` 35.900, `WebURLSchemeTaskProxy::startLoading` 35.902, `didReceiveData` + `didComplete` 35.924 — **the scheme handler served `index.html` with our `NSHTTPURLResponse`**, so the MIME/CORS fix is not what fails now.
  - After that: no `didCommit`, no `didFinishNavigation`, no `didFailProvisionalNavigation`, and no `TN_UI_PAGE` line anywhere. The document exists — the document-start probe and roughly 30 `evaluateJavaScript` calls a second all report `runJavaScriptInFrameInScriptWorld ... Request to run JavaScript succeeded` — while neither our `WKNavigationDelegate` nor the `tnHost` message handler is ever called.
  - So the failure is **callback delivery to the host**, not the bundle, the page or WebKit's loader: the delegate and message-handler callbacks are main-thread run-loop deliveries, and this shell's `runtime->run()` loop blocks the main thread. The desktop host pumps the equivalent surface every frame (`mystral::platform::pumpUiOverlay()` in `V8Game::uiFrame`); the iOS shell has no such pump. That is the hypothesis the next macOS run should test — it is not proven here, and no Objective-C++ was changed on Linux.

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

## Decision (2026-11-08, revised after the lead chose behaviour routes): wire contracts and the iOS simulator proof

A wire contract is a test that compares source files, written in different languages or built for different platforms, that must agree on one name or value. Neither side has a seam to call from a desktop test, because the other side runs on a device. These stay as text checks beside the ABI digest. Each names its wire:

| Wire | Between | Evidence |
| --- | --- | --- |
| UI bridge names `tnHost` and `__tnUiReceive` (`ui-layer-host-contract`, tests 1-2) | `core/src/ui-bridge.ts` (`UI_BRIDGE_GLOBALS`), `TnUiOverlay.java`, `ui_overlay_ios.mm`, the Rust `abi.rs` and `offscreen.rs` | One string in five sources. The test reads the names from `ui-bridge.ts` and does not restate them. A host that spells one differently has no bridge, silently |
| Message name `tn:hit-regions` (test 3) | `HIT_REGIONS_MESSAGE` in `ui-bridge.ts`, `TnUiOverlay.java`, `kHitRegions` in `ui_overlay_ios.mm`, and the match in `ui_overlay.cpp` | One string in four sources. The routing of that frame is no longer text: `threenative-platform-policy-test` drains the real queue through `platform::drainUiFramesToGame`, the function `runtime.cpp` uses |
| Page origin each host serves, with the `file://` ban (test 4) | Android `appassets.androidplatform.net`; iOS and desktop `threenative://localhost` | The page resolves its relative imports and `fetch` against that origin, so a host that serves another one changes module and fetch behaviour on that platform only. The `file://` ban is a lint on the same origin choice, and the pair stays together |

The iOS web view ban (`ios-contract`) and the `TNMaxFps` read in `ios/main.mm` (`ios-packaging`) are no longer wires or text. A launch proves them (next section). `ios-packaging` keeps its `Info.plist` regex, which checks what the packager writes and reads no `.mm` file.

### What the macOS `build-ios-simulator` job must prove

The job is in `native-release.yml`. It runs for a PR into `main` or a PR that carries the `release-proof` label, and the lead adds that label when pushing. `verify-ios-simulator.mjs` now judges these launch logs with `scripts/ios-webui-log.mjs`, which `tests/ios-webui-log.test.mjs` pins on Linux (10 cases, green and red):

| Check | Replaces the text test | Log evidence |
| --- | --- | --- |
| The plain smoke launch logs no `TN_UI_OVERLAY` and no `TN_UI_PAGE` | `ios-contract`: `main.mm` has no `WebView` | No web view exists in the native-renderer shell |
| A copy of the app with `TNMaxFps` 30 logs `Presentation cap: 30 fps` | `ios-packaging`: the `config.maxFps` regex on `main.mm` | The plist key reaches the host |
| A copy with `TNUIRenderer` `web` and the built smoke page logs `TN_UI_OVERLAY` `attached:true` before `TN_IOS_GAME_EVAL` | `ui-layer-host-contract`: attach after window creation and before the game starts, and the `TNUIRenderer` read | `attached:true` needs the SDL window, so it follows window creation |
| The same launch logs `loaded:true` and no `loaded:false` | page load finish and failure logs | `didFinishNavigation` ran |
| The same launch logs `TN_UI_PAGE` `ready` and `first-state`, and no `[error]` | bridge registered before the web view copies its configuration; scheme handler answers 200 with CORS and a JavaScript MIME; the page probe | The staged page marks its module script `crossorigin`, so `ready` means the module ran after a 200, a JavaScript MIME and the CORS header. A handler added late leaves `webkit.messageHandlers.tnHost` undefined, and the probe posts nothing |
| The same launch logs `firstState` with `frame` equal to `parent` and a size above zero | overlay frame on first state; layout constraints | The overlay follows the parent bounds through layout |
| A web renderer copy with no `ui/index.html` logs `TN_UI_BUNDLE_MISSING` | `TN_UI_BUNDLE_MISSING` between create and evaluate | The refusal runs before the game |

Markers added for this: `TN_IOS_GAME_EVAL` in `main.mm`, and a `parent` field on the `loaded` and `firstState` lines in `ui_overlay_ios.mm`. Variants run on a copy of the app under `artifacts/ios/variant`, so the zipped release app keeps its own `Info.plist` and files. None of this ran here: Objective-C++ and `xcrun` need macOS. The proof is the job going green.

### What still reads source as text

Decision, 2026-11-09 (owner: "reduce excess AC if necessary" to land PR #632): the seven `open` rows below move to [PRD-862](PRD-862-untangle-native-leftovers.md). Each needs a header seam in `ui_overlay.cpp`, `window.cpp` or `ui_overlay_ios.mm`, or a macOS-only lane, which is new native work rather than test conversion.

| File and test | Class | Why |
| --- | --- | --- |
| `web-host-abi.spec.ts` | wire | The ABI digest, by design |
| `ui-layer-host-contract`, tests 1-4 | wire | See the table above |
| `ui-layer-host-contract`, "iOS detaches the UI before either exit" | open | A launch cannot end the app through `return 2` or after `run()`, so no log shows the order |
| `ui-layer-host-contract`, "the MRC iOS bridge keeps a non-owning overlay link" | open | A memory-management property of `ui_overlay_ios.mm` with no log evidence |
| `ui-layer-host-contract`, "iOS scheme paths remain inside the UI directory" | open | Runs on macOS only. It extracts `resolveUiFile` by regex and compiles it |
| `ui-layer-host-contract`, "non-Linux keyboard routing", "UI gestures finish outside the window", "keyboard ownership survives focus changes", "native CSS scroll traces" | open | Each slices `ui_overlay.cpp` or `window.cpp` by regex and compiles the slice. The fix is a header seam per function |

`web-host-refusal.test.mjs` no longer reads source. It needs `pnpm wasm:build` and Chromium with WebGPU, so it skips when `build/wasm` is absent. No CI job builds the Wasm host and runs it yet. That wiring is open.
