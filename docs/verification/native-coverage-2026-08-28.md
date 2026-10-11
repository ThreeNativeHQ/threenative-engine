<!-- native-coverage-generated:start -->
# Native coverage — 2026-08-28

Configuration: `tn-linux-coverage` with clang source-based coverage. Executed
46 native contract targets; 3 configured
targets could not be built and are named below.

| Subsystem | Instrumented lines | Covered | Line coverage |
| --- | ---: | ---: | ---: |
| `src/async/` | 73 | 60 | 82.19% |
| `src/audio/` | 1471 | 1301 | 88.44% |
| `src/canvas/` | 1334 | 1110 | 83.21% |
| `src/cli/` | 1690 | 1242 | 73.49% |
| `src/fs/` | 235 | 189 | 80.43% |
| `src/http/` | 410 | 377 | 91.95% |
| `src/js/` | 2785 | 2212 | 79.43% |
| `src/platform/` | 1460 | 1003 | 68.70% |
| `src/raytracing/` | 461 | 399 | 86.55% |
| `src/runtime.cpp` | 2410 | 1886 | 78.26% |
| `src/screenshot_gate.cpp` | 27 | 24 | 88.89% |
| `src/storage/` | 327 | 286 | 87.46% |
| `src/utils/` | 0 | 0 | 0.00% |
| `src/vfs/` | 239 | 195 | 81.59% |
| `src/webgpu/` | 9801 | 7493 | 76.45% |
| `src/webtransport/` | 1391 | 1078 | 77.50% |
| `src/workers/` | 615 | 527 | 85.69% |
| **TOTAL** | **24729** | **19382** | **78.38%** |

Source digest: `sha256:5d324eaaa156c4fd352ef8e5837a0790060cfeda53a0d89226ce2880b179faeb`

The default `pnpm budgets` gate reads this committed measurement without configuring or compiling
the native host. Any native source, native C++ test, CTest registration, or coverage aggregation
change requires this opt-in command to refresh the record.

| Coverage floor | Minimum |
| --- | ---: |
| `src/async/` | 77.19% |
| `src/audio/` | 83.44% |
| `src/canvas/` | 78.21% |
| `src/cli/` | 68.49% |
| `src/fs/` | 75.43% |
| `src/http/` | 86.95% |
| `src/js/` | 74.43% |
| `src/platform/` | 63.70% |
| `src/raytracing/` | 81.55% |
| `src/runtime.cpp` | 73.26% |
| `src/screenshot_gate.cpp` | 88.89% |
| `src/storage/` | 86.54% |
| `src/utils/` | 0.00% |
| `src/vfs/` | 76.59% |
| `src/webgpu/` | 71.72% |
| `src/webtransport/` | 72.50% |
| `src/workers/` | 80.69% |

## Not compiled in this configuration

- `src/debug/debug_server.cpp`
- `src/gltf/gltf_loader.cpp`
- `src/js/jsc_engine.mm`
- `src/js/quickjs_engine.cpp`
- `src/metahuman/native_bindings.cpp`
- `src/physics/native_bindings.cpp`
- `src/platform/android_main.cpp`
- `src/platform/surface_android.cpp`
- `src/platform/surface_metal.mm`
- `src/raytracing/dxr_rt.cpp`
- `src/raytracing/metal_rt.mm`
- `src/raytracing/vulkan_rt.cpp`
- `src/utils/cgltf_impl.cpp`
- `src/video/async_capture.cpp`
- `src/video/gpu_readback_recorder.cpp`
- `src/video/screen_capture_kit.mm`
- `src/video/video_recorder.cpp`
- `src/video/windows_graphics_capture.cpp`
- `src/video/windows_graphics_capture_impl.cpp`

## Blocked targets

- `threenative-metahuman-bindings-test`: TN_ENABLE_METAHUMAN=OFF
- `threenative-physics-actuation-bindings-test`: TN_ENABLE_NATIVE_PHYSICS=OFF
- `threenative-video-recorder-state-test`: TN_ENABLE_VIDEO=OFF
<!-- native-coverage-generated:end -->

## Floor changes

**This section lives below the generated marker on purpose.** It sat inside the generated block
until 2026-08-29, where every `native:coverage` run silently deleted it — the ratchet-release
history this file calls rare and important was one regeneration away from being lost each time.
Keep hand-authored provenance below the marker.

`src/runtime.cpp` 39.50% -> 38.88%, released once on 2026-08-28 when PRD-250's off-thread
Worker landed. This is not a coverage regression: covered lines in that file went **up**,
771 -> 785. The file grew 1952 -> 2019 lines, so the ratio fell while absolute coverage
rose. The same change brought `src/workers/` into this configuration for the first time -
it was previously listed under "not compiled" - which is why a new 9.05% floor appears
above and why the total moved on a larger denominator.

Releasing a floor is a ratchet release and should stay rare. The debt this records is
`src/workers/` at 9.05%: `worker_registry.cpp` and `worker_thread.cpp` compile but are
barely exercised by this configuration's tests.

## Phase 1 red-green and fail-closed evidence

The test landed before the implementation:

```text
FAIL tests/native-coverage.test.mjs
Cannot find module '../scripts/measure-native-coverage.mjs'
Test Files 1 failed (1); Tests no tests
```

The first multi-executable export emitted `41 functions have mismatched data`. Making warnings
fatal turned that into a hard failure. A unique-object export still collided on inline/template
symbols (`89 functions`). The accepted implementation exports each executable against only its own
profiles and unions LCOV source lines; the final command emits no LLVM warnings.

```text
Checked 3 files in 17ms. No fixes applied.
Test Files 1 passed (1)
Tests 9 passed (9)
```

Every successful invocation produces its own required profile. Compile truth comes from
`compile_commands.json`; `src/audio/vorbis_impl.c` and `src/utils/stb_impl.cpp` therefore remain
compiled with 0 instrumentable lines rather than being misreported as uncompiled.

The compiler negative control failed during configuration as required:

```text
TN_ENABLE_COVERAGE requires clang source-based coverage; configure with clang/clang++
Configuring incomplete, errors occurred!
```

## Phase 2 CTest evidence

The registration test was red before `enable_testing()` and the 27 primary registrations existed:

```text
FAIL should register every native executable with CTest
The input did not match /enable_testing\(\)/
Test Files 1 failed (1); Tests no tests
```

After registration, the focused gate and full runner were green:

```text
Test Files 2 passed (2)
Tests 15 passed (15)

100% tests passed out of 26
native-contract = 6.62 sec*proc (28 tests)
17 - threenative-physics-actuation-bindings-test (Disabled)
26 - threenative-video-recorder-state-test (Disabled)
```

CTest owns all 27 primary target names plus the second required shutdown invocation. Phase 1 now
runs those registrations one at a time so its per-invocation profiles cannot drift from the
correctness runner.

The existing-build regression check removed `build/tn-linux/CTestTestfile.cmake`, made the source
newer than the generated build, and invoked only `pnpm native:test:cpp`. Its aggregate build
regenerated CTest metadata before inventory validation, then passed all 26 runnable registrations
with exactly the same two disabled feature-off rows.

The real legacy-shape negative control was registered in a disposable CTest file and failed:

```text
RED observed: legacy wrapper shape rejected
command-encoder-class-table contract: 2 failure(s)
0% tests passed, 1 tests failed out of 1
```

## Coverage expansion verification — 2026-09-07

The reconciled native contract suite executes five additional targets covering Canvas/audio,
CLI/network/filesystem, JavaScript modules, runtime/platform behavior, and WebGPU. The CLI
executables delegate to the same entry functions exercised by the contract tests. Assertions
check script completion as well as evaluation success, and filesystem fixtures use an isolated
temporary working directory.

The coverage candidate initially made the ray-tracing stub report support when an environment
variable was set. A compiled negative control exposed that false capability before the
production override was removed:

```text
[MystralRT] No hardware RT available, using stub backend
FAIL: unavailable native ray tracing became supported through an environment variable
```

After restoring honest stub support reporting, the same compiled probe passed. The new CLI
contract retains the unsupported-capability assertion:

```text
[MystralRT] No hardware RT available, using stub backend
PASS: unavailable native ray tracing remains unsupported
```

The expanded contract targets passed locally, followed by a complete `pnpm native:coverage`
measurement with all 38 runnable contract targets passing. The coverage command now provisions
the repository's `scripts/xvfb.sh` display wrapper on Linux, so the SDL/WebGPU surface paths are
measured instead of silently skipped. The generated result above is **17,524 / 21,784 lines
(80.44%)**, compared with the base commit's committed **9,579 / 21,762 lines (44.02%)**. No
coverage floor was lowered.

This coverage measurement is the Linux clang/V8/Dawn configuration. Physics and video remain
disabled as listed above. It does not establish Windows, macOS, Android, or iOS coverage.
The 80% target is a Linux desktop measurement only.


## Windowed desktop proof — 2026-09-07

The same changed Linux runtime then passed the existing desktop core verifier on an NVIDIA
GeForce RTX 2080 using Vulkan. The verifier provisions its own X display, renders exactly
300 frames, checks one present per frame plus the single capture refresh, verifies the native
worker lifecycle and ordered startup markers, and checks the saved overlay pixels. The
1280×720 capture was also visually inspected.

The first run reached all 300 frames but failed because this host's ALSA device was unavailable.
Setting SDL's existing dummy audio driver allowed the display proof to complete; this run
does not establish audible output.

```text
SDL_AUDIODRIVER=dummy node packages/runtime-native/scripts/verify-desktop-core.mjs
desktop core gate passed: 300 frames, 1280x720
[WebGPU] Adapter: NVIDIA GeForce RTX 2080
[WebGPU] Backend: Vulkan
TN_CAPTURE_REFRESH_PRESENTS:1
Rendered 300 frames in 13267ms
TN_PRESENTS:301
```

Retained receipts: [report](native-coverage-2026-09-07/desktop-linux-report.json),
[host log](native-coverage-2026-09-07/desktop-linux.txt), and
[capture](native-coverage-2026-09-07/desktop-core-2026-09-07.png). The report's artifact paths
name their original runtime output locations. The PNG copy is byte-identical. Biome
formatted the retained JSON report, and trailing whitespace was removed from the host log;
the recorded fields and observations are unchanged.

Original host-log SHA-256: `11fa54f8059fc2e8412a6eeed5f03d0dbf988f047963f6ce6b1900aaf100b149`.

Runtime SHA-256: `03637735e2bde54ca5f6c2b8e432047d2abc50784ac3095f63c07314b443216a`.
Capture SHA-256: `b7f96827af94c7346112d7b01c7b6d622b1fbbd5100606e60d19e2d61adc0bda`.


The existing `examples/native-smoke/playtests/loading-screen-desktop.playtest.json` scenario
also passed against this binary through the desktop playtest driver. Its assertions observe
the loading surface and readiness during the first-use stall and after startup settles.

```text
SDL_AUDIODRIVER=dummy sh scripts/xvfb.sh node packages/runtime-native/scripts/verify-desktop-loading.mjs
desktop loading playtest proof passed: 913920 startup loading pixels, 0 settled loading pixels
```

Retained loading receipts: [proof](native-coverage-2026-09-07/loading/loading-proof.json),
[console](native-coverage-2026-09-07/loading/console.json),
[startup capture](native-coverage-2026-09-07/loading/startup-stall.png),
[mid-stall capture](native-coverage-2026-09-07/loading/startup-mid-stall.png), and
[settled capture](native-coverage-2026-09-07/loading/startup-settled.png). The startup and
settled images were visually inspected. Original output paths remain in the byte-identical
proof record.


## Desktop test portability red-green — 2026-09-08

Hosted run `34170333684` exposed two assumptions in the new native tests. The CLI test
compiles the real CLI entry source, so it needs the same private WebP headers as the executable.
The WebGPU test must use only features granted to its device and wait for asynchronous GPU
completion before asserting the final sentinel. These are engine verification defects; the
shipping runtime and game appearance are unchanged by this follow-up.

The observed macOS and Windows failures were:

```text
fatal error: 'webp/encode.h' file not found
fatal error C1083: Cannot open include file: 'webp/encode.h': No such file or directory
[WebGPU] adapter feature probe timestamp-query: no
[error] WEBGPU_TEST_ERROR: createQuerySet: this device was not granted 'timestamp-query'
[V8] check.js:1: Error: not done
webgpu comprehensive test did not complete successfully
```

The CLI test target now inherits the WebP include directory, timestamp queries require the
device's feature grant, and the test pumps until completion or an explicit five-second deadline.
Missing device/encoder state and script errors still fail. The full Linux coverage command
then rebuilt and executed all 38 runnable native contract targets successfully under the
repository's display wrapper:

```text
CMAKE_BUILD_PARALLEL_LEVEL=2 pnpm --filter @threenative/runtime-native native:coverage
Configuration: tn-linux-coverage with clang source-based coverage
Executed 38 native contract targets; 2 configured targets could not be built
TOTAL: 21784 instrumented lines; 17524 covered; 80.44%
```

The two blocked rows are still the explicitly disabled physics and video targets. Native
coverage floors are unchanged. This is Linux green evidence for the repair; macOS and Windows
verification must run again on the published follow-up before either platform is claimed green.

## Native diagnostics capability preflight — 2026-09-08

Commit `5e2db7025f9055cd66d973d77abd892828439519` resolves omitted diagnostics for the
executed target before checking bridge capabilities. An Android scenario that omits
`noNetworkErrors` therefore records browser network observation as unavailable instead of
requiring the native bridge to provide `browser.network`; an explicit request remains a
fail-closed unsupported capability.

An exact semantic revert reproduced `TN_PLAYTEST_CAPABILITY_MISSING browser.network` and failed
the focused test 1/1. Restoring the target-aware call passed that test 1/1, then
`device-playtest`, `unobservable-lane`, `bridgeClient`, and `runner-lanes` passed 64/64. The
resulting generated capability metadata changed all ten scaffold trees; the measured hashes are
pinned in `packages/create-threenative/__tests__/scaffold.spec.ts`, whose complete suite passed
55/55.

## October 4 published-head reconciliation measurement

The first generated block was measured from the merged source with the existing native coverage command. It executed 46 contract targets with an explicitly verified two-worker build cap; three configured targets remain blocked as listed. The source freshness and unchanged coverage floors pass. Previous published-branch and develop measurements are archived below without altering their results.

## Historical develop measurement before conflict reconciliation

The following archived report measured develop `15adf350da53addfa33675c2b3f0e2722e086e37` before reconciliation. Archived reports retain their original measurements and digests; only the first generated block can qualify the current merged source.

<!-- native-coverage-generated:start -->
# Native coverage — 2026-08-28

Configuration: `tn-linux-coverage` with clang source-based coverage. Executed
45 native contract targets; 3 configured
targets could not be built and are named below.

| Subsystem | Instrumented lines | Covered | Line coverage |
| --- | ---: | ---: | ---: |
| `src/async/` | 73 | 60 | 82.19% |
| `src/audio/` | 1471 | 1301 | 88.44% |
| `src/canvas/` | 1334 | 1110 | 83.21% |
| `src/cli/` | 1682 | 1238 | 73.60% |
| `src/fs/` | 235 | 189 | 80.43% |
| `src/http/` | 410 | 377 | 91.95% |
| `src/js/` | 2785 | 2212 | 79.43% |
| `src/platform/` | 1293 | 936 | 72.39% |
| `src/raytracing/` | 461 | 399 | 86.55% |
| `src/runtime.cpp` | 2361 | 1870 | 79.20% |
| `src/screenshot_gate.cpp` | 27 | 24 | 88.89% |
| `src/storage/` | 327 | 286 | 87.46% |
| `src/utils/` | 0 | 0 | 0.00% |
| `src/vfs/` | 239 | 195 | 81.59% |
| `src/webgpu/` | 9753 | 7485 | 76.75% |
| `src/webtransport/` | 1391 | 1078 | 77.50% |
| `src/workers/` | 615 | 524 | 85.20% |
| **TOTAL** | **24457** | **19284** | **78.85%** |

Source digest: `sha256:7654bd1bddb42b3dd5eead4c6d0ea07705d7fe51ed41af9e4045e68ebe9b87e8`

The default `pnpm budgets` gate reads this committed measurement without configuring or compiling
the native host. Any native source, native C++ test, CTest registration, or coverage aggregation
change requires this opt-in command to refresh the record.

| Coverage floor | Minimum |
| --- | ---: |
| `src/async/` | 72.60% |
| `src/audio/` | 57.37% |
| `src/canvas/` | 48.39% |
| `src/cli/` | 0.00% |
| `src/fs/` | 37.45% |
| `src/http/` | 43.53% |
| `src/js/` | 38.23% |
| `src/platform/` | 21.87% |
| `src/raytracing/` | 13.10% |
| `src/runtime.cpp` | 38.88% |
| `src/screenshot_gate.cpp` | 88.89% |
| `src/storage/` | 86.54% |
| `src/utils/` | 0.00% |
| `src/vfs/` | 73.22% |
| `src/webgpu/` | 33.82% |
| `src/webtransport/` | 5.19% |
| `src/workers/` | 9.05% |

## Not compiled in this configuration

- `src/debug/debug_server.cpp`
- `src/gltf/gltf_loader.cpp`
- `src/js/jsc_engine.mm`
- `src/js/quickjs_engine.cpp`
- `src/metahuman/native_bindings.cpp`
- `src/physics/native_bindings.cpp`
- `src/platform/android_main.cpp`
- `src/platform/surface_android.cpp`
- `src/platform/surface_metal.mm`
- `src/raytracing/dxr_rt.cpp`
- `src/raytracing/metal_rt.mm`
- `src/raytracing/vulkan_rt.cpp`
- `src/utils/cgltf_impl.cpp`
- `src/video/async_capture.cpp`
- `src/video/gpu_readback_recorder.cpp`
- `src/video/screen_capture_kit.mm`
- `src/video/video_recorder.cpp`
- `src/video/windows_graphics_capture.cpp`
- `src/video/windows_graphics_capture_impl.cpp`

## Blocked targets

- `threenative-metahuman-bindings-test`: TN_ENABLE_METAHUMAN=OFF
- `threenative-physics-actuation-bindings-test`: TN_ENABLE_NATIVE_PHYSICS=OFF
- `threenative-video-recorder-state-test`: TN_ENABLE_VIDEO=OFF
<!-- native-coverage-generated:end -->

## Floor changes

**This section lives below the generated marker on purpose.** It sat inside the generated block
until 2026-08-29, where every `native:coverage` run silently deleted it — the ratchet-release
history this file calls rare and important was one regeneration away from being lost each time.
Keep hand-authored provenance below the marker.

`src/runtime.cpp` 39.50% -> 38.88%, released once on 2026-08-28 when PRD-250's off-thread
Worker landed. This is not a coverage regression: covered lines in that file went **up**,
771 -> 785. The file grew 1952 -> 2019 lines, so the ratio fell while absolute coverage
rose. The same change brought `src/workers/` into this configuration for the first time -
it was previously listed under "not compiled" - which is why a new 9.05% floor appears
above and why the total moved on a larger denominator.

Releasing a floor is a ratchet release and should stay rare. The debt this records is
`src/workers/` at 9.05%: `worker_registry.cpp` and `worker_thread.cpp` compile but are
barely exercised by this configuration's tests.

## Phase 1 red-green and fail-closed evidence

The test landed before the implementation:

```text
FAIL tests/native-coverage.test.mjs
Cannot find module '../scripts/measure-native-coverage.mjs'
Test Files 1 failed (1); Tests no tests
```

The first multi-executable export emitted `41 functions have mismatched data`. Making warnings
fatal turned that into a hard failure. A unique-object export still collided on inline/template
symbols (`89 functions`). The accepted implementation exports each executable against only its own
profiles and unions LCOV source lines; the final command emits no LLVM warnings.

```text
Checked 3 files in 17ms. No fixes applied.
Test Files 1 passed (1)
Tests 9 passed (9)
```

Every successful invocation produces its own required profile. Compile truth comes from
`compile_commands.json`; `src/audio/vorbis_impl.c` and `src/utils/stb_impl.cpp` therefore remain
compiled with 0 instrumentable lines rather than being misreported as uncompiled.

The compiler negative control failed during configuration as required:

```text
TN_ENABLE_COVERAGE requires clang source-based coverage; configure with clang/clang++
Configuring incomplete, errors occurred!
```

## Phase 2 CTest evidence

The registration test was red before `enable_testing()` and the 27 primary registrations existed:

```text
FAIL should register every native executable with CTest
The input did not match /enable_testing\(\)/
Test Files 1 failed (1); Tests no tests
```

After registration, the focused gate and full runner were green:

```text
Test Files 2 passed (2)
Tests 15 passed (15)

100% tests passed out of 26
native-contract = 6.62 sec*proc (28 tests)
17 - threenative-physics-actuation-bindings-test (Disabled)
26 - threenative-video-recorder-state-test (Disabled)
```

CTest owns all 27 primary target names plus the second required shutdown invocation. Phase 1 now
runs those registrations one at a time so its per-invocation profiles cannot drift from the
correctness runner.

The existing-build regression check removed `build/tn-linux/CTestTestfile.cmake`, made the source
newer than the generated build, and invoked only `pnpm native:test:cpp`. Its aggregate build
regenerated CTest metadata before inventory validation, then passed all 26 runnable registrations
with exactly the same two disabled feature-off rows.

The real legacy-shape negative control was registered in a disposable CTest file and failed:

```text
RED observed: legacy wrapper shape rejected
command-encoder-class-table contract: 2 failure(s)
0% tests passed, 1 tests failed out of 1
```

## Coverage expansion verification — 2026-09-07

The reconciled native contract suite executes five additional targets covering Canvas/audio,
CLI/network/filesystem, JavaScript modules, runtime/platform behavior, and WebGPU. The CLI
executables delegate to the same entry functions exercised by the contract tests. Assertions
check script completion as well as evaluation success, and filesystem fixtures use an isolated
temporary working directory.

The coverage candidate initially made the ray-tracing stub report support when an environment
variable was set. A compiled negative control exposed that false capability before the
production override was removed:

```text
[MystralRT] No hardware RT available, using stub backend
FAIL: unavailable native ray tracing became supported through an environment variable
```

After restoring honest stub support reporting, the same compiled probe passed. The new CLI
contract retains the unsupported-capability assertion:

```text
[MystralRT] No hardware RT available, using stub backend
PASS: unavailable native ray tracing remains unsupported
```

The expanded contract targets passed locally, followed by a complete `pnpm native:coverage`
measurement with all 38 runnable contract targets passing. The coverage command now provisions
the repository's `scripts/xvfb.sh` display wrapper on Linux, so the SDL/WebGPU surface paths are
measured instead of silently skipped. The generated result above is **17,524 / 21,784 lines
(80.44%)**, compared with the base commit's committed **9,579 / 21,762 lines (44.02%)**. No
coverage floor was lowered.

This coverage measurement is the Linux clang/V8/Dawn configuration. Physics and video remain
disabled as listed above. It does not establish Windows, macOS, Android, or iOS coverage.
The 80% target is a Linux desktop measurement only.


## Windowed desktop proof — 2026-09-07

The same changed Linux runtime then passed the existing desktop core verifier on an NVIDIA
GeForce RTX 2080 using Vulkan. The verifier provisions its own X display, renders exactly
300 frames, checks one present per frame plus the single capture refresh, verifies the native
worker lifecycle and ordered startup markers, and checks the saved overlay pixels. The
1280×720 capture was also visually inspected.

The first run reached all 300 frames but failed because this host's ALSA device was unavailable.
Setting SDL's existing dummy audio driver allowed the display proof to complete; this run
does not establish audible output.

```text
SDL_AUDIODRIVER=dummy node packages/runtime-native/scripts/verify-desktop-core.mjs
desktop core gate passed: 300 frames, 1280x720
[WebGPU] Adapter: NVIDIA GeForce RTX 2080
[WebGPU] Backend: Vulkan
TN_CAPTURE_REFRESH_PRESENTS:1
Rendered 300 frames in 13267ms
TN_PRESENTS:301
```

Retained receipts: [report](native-coverage-2026-09-07/desktop-linux-report.json),
[host log](native-coverage-2026-09-07/desktop-linux.txt), and
[capture](native-coverage-2026-09-07/desktop-core-2026-09-07.png). The report's artifact paths
name their original runtime output locations. The PNG copy is byte-identical. Biome
formatted the retained JSON report, and trailing whitespace was removed from the host log;
the recorded fields and observations are unchanged.

Original host-log SHA-256: `11fa54f8059fc2e8412a6eeed5f03d0dbf988f047963f6ce6b1900aaf100b149`.

Runtime SHA-256: `03637735e2bde54ca5f6c2b8e432047d2abc50784ac3095f63c07314b443216a`.
Capture SHA-256: `b7f96827af94c7346112d7b01c7b6d622b1fbbd5100606e60d19e2d61adc0bda`.


The existing `examples/native-smoke/playtests/loading-screen-desktop.playtest.json` scenario
also passed against this binary through the desktop playtest driver. Its assertions observe
the loading surface and readiness during the first-use stall and after startup settles.

```text
SDL_AUDIODRIVER=dummy sh scripts/xvfb.sh node packages/runtime-native/scripts/verify-desktop-loading.mjs
desktop loading playtest proof passed: 913920 startup loading pixels, 0 settled loading pixels
```

Retained loading receipts: [proof](native-coverage-2026-09-07/loading/loading-proof.json),
[console](native-coverage-2026-09-07/loading/console.json),
[startup capture](native-coverage-2026-09-07/loading/startup-stall.png),
[mid-stall capture](native-coverage-2026-09-07/loading/startup-mid-stall.png), and
[settled capture](native-coverage-2026-09-07/loading/startup-settled.png). The startup and
settled images were visually inspected. Original output paths remain in the byte-identical
proof record.


## Desktop test portability red-green — 2026-09-08

Hosted run `34170333684` exposed two assumptions in the new native tests. The CLI test
compiles the real CLI entry source, so it needs the same private WebP headers as the executable.
The WebGPU test must use only features granted to its device and wait for asynchronous GPU
completion before asserting the final sentinel. These are engine verification defects; the
shipping runtime and game appearance are unchanged by this follow-up.

The observed macOS and Windows failures were:

```text
fatal error: 'webp/encode.h' file not found
fatal error C1083: Cannot open include file: 'webp/encode.h': No such file or directory
[WebGPU] adapter feature probe timestamp-query: no
[error] WEBGPU_TEST_ERROR: createQuerySet: this device was not granted 'timestamp-query'
[V8] check.js:1: Error: not done
webgpu comprehensive test did not complete successfully
```

The CLI test target now inherits the WebP include directory, timestamp queries require the
device's feature grant, and the test pumps until completion or an explicit five-second deadline.
Missing device/encoder state and script errors still fail. The full Linux coverage command
then rebuilt and executed all 38 runnable native contract targets successfully under the
repository's display wrapper:

```text
CMAKE_BUILD_PARALLEL_LEVEL=2 pnpm --filter @threenative/runtime-native native:coverage
Configuration: tn-linux-coverage with clang source-based coverage
Executed 38 native contract targets; 2 configured targets could not be built
TOTAL: 21784 instrumented lines; 17524 covered; 80.44%
```

The two blocked rows are still the explicitly disabled physics and video targets. Native
coverage floors are unchanged. This is Linux green evidence for the repair; macOS and Windows
verification must run again on the published follow-up before either platform is claimed green.

## Native diagnostics capability preflight — 2026-09-08

Commit `5e2db7025f9055cd66d973d77abd892828439519` resolves omitted diagnostics for the
executed target before checking bridge capabilities. An Android scenario that omits
`noNetworkErrors` therefore records browser network observation as unavailable instead of
requiring the native bridge to provide `browser.network`; an explicit request remains a
fail-closed unsupported capability.

An exact semantic revert reproduced `TN_PLAYTEST_CAPABILITY_MISSING browser.network` and failed
the focused test 1/1. Restoring the target-aware call passed that test 1/1, then
`device-playtest`, `unobservable-lane`, `bridgeClient`, and `runner-lanes` passed 64/64. The
resulting generated capability metadata changed all ten scaffold trees; the measured hashes are
pinned in `packages/create-threenative/__tests__/scaffold.spec.ts`, whose complete suite passed
55/55.

## Rendering consolidation coverage status

The generated measurement above was refreshed on 2026-10-04 from the combined exposure/fog candidate. A fresh isolated `tn-linux-coverage` build executed 45 native contract targets; three explicitly disabled targets remain listed above. The source digest is `sha256:fa76aa265ca265cd6cb73c9fe0b2935598faf97c0f8dcf034a2fa19ea5196a16`, and the existing coverage floors are unchanged.

The original [exposure measurement](https://github.com/ThreeNativeHQ/threenative/blob/f54efbdc9cadac5bf8719adf3435fca98d872bb4/docs/verification/native-coverage-2026-08-28.md) and [fog measurement](https://github.com/ThreeNativeHQ/threenative/blob/edd5e1d6eef2ef306234a615d6f392861b2ee0f8/docs/verification/native-coverage-2026-08-28.md) remain preserved at their exact source commits. This Linux coverage result does not qualify combined browser or native GPU behavior, or macOS/Windows execution.

## Historical published CSS UI branch measurement before reconciliation

Published head `00da87339983470f060519652e900411c5cd3612`; retained unchanged for comparison.

<!-- native-coverage-generated:start -->
# Native coverage — 2026-08-28

Configuration: `tn-linux-coverage` with clang source-based coverage. Executed
43 native contract targets; 3 configured
targets could not be built and are named below.

| Subsystem | Instrumented lines | Covered | Line coverage |
| --- | ---: | ---: | ---: |
| `src/async/` | 73 | 60 | 82.19% |
| `src/audio/` | 1471 | 1296 | 88.10% |
| `src/canvas/` | 1334 | 1110 | 83.21% |
| `src/cli/` | 1690 | 1242 | 73.49% |
| `src/fs/` | 235 | 189 | 80.43% |
| `src/http/` | 410 | 377 | 91.95% |
| `src/js/` | 2785 | 2212 | 79.43% |
| `src/platform/` | 1451 | 995 | 68.57% |
| `src/raytracing/` | 461 | 399 | 86.55% |
| `src/runtime.cpp` | 2410 | 1888 | 78.34% |
| `src/screenshot_gate.cpp` | 27 | 24 | 88.89% |
| `src/storage/` | 327 | 286 | 87.46% |
| `src/utils/` | 0 | 0 | 0.00% |
| `src/vfs/` | 239 | 195 | 81.59% |
| `src/webgpu/` | 9661 | 7393 | 76.52% |
| `src/webtransport/` | 1391 | 1078 | 77.50% |
| `src/workers/` | 615 | 524 | 85.20% |
| **TOTAL** | **24580** | **19268** | **78.39%** |

Source digest: `sha256:227e47d9501744aa967f8ff75600a30c1f187a11e8a1cba701d19bafa68804b8`

The default `pnpm budgets` gate reads this committed measurement without configuring or compiling
the native host. Any native source, native C++ test, CTest registration, or coverage aggregation
change requires this opt-in command to refresh the record.

| Coverage floor | Minimum |
| --- | ---: |
| `src/async/` | 72.60% |
| `src/audio/` | 57.37% |
| `src/canvas/` | 48.39% |
| `src/cli/` | 0.00% |
| `src/fs/` | 37.45% |
| `src/http/` | 43.53% |
| `src/js/` | 38.23% |
| `src/platform/` | 21.87% |
| `src/raytracing/` | 13.10% |
| `src/runtime.cpp` | 38.88% |
| `src/screenshot_gate.cpp` | 88.89% |
| `src/storage/` | 86.54% |
| `src/utils/` | 0.00% |
| `src/vfs/` | 73.22% |
| `src/webgpu/` | 33.82% |
| `src/webtransport/` | 5.19% |
| `src/workers/` | 9.05% |

## Not compiled in this configuration

- `src/debug/debug_server.cpp`
- `src/gltf/gltf_loader.cpp`
- `src/js/jsc_engine.mm`
- `src/js/quickjs_engine.cpp`
- `src/metahuman/native_bindings.cpp`
- `src/physics/native_bindings.cpp`
- `src/platform/android_main.cpp`
- `src/platform/surface_android.cpp`
- `src/platform/surface_metal.mm`
- `src/raytracing/dxr_rt.cpp`
- `src/raytracing/metal_rt.mm`
- `src/raytracing/vulkan_rt.cpp`
- `src/utils/cgltf_impl.cpp`
- `src/video/async_capture.cpp`
- `src/video/gpu_readback_recorder.cpp`
- `src/video/screen_capture_kit.mm`
- `src/video/video_recorder.cpp`
- `src/video/windows_graphics_capture.cpp`
- `src/video/windows_graphics_capture_impl.cpp`

## Blocked targets

- `threenative-metahuman-bindings-test`: TN_ENABLE_METAHUMAN=OFF
- `threenative-physics-actuation-bindings-test`: TN_ENABLE_NATIVE_PHYSICS=OFF
- `threenative-video-recorder-state-test`: TN_ENABLE_VIDEO=OFF
<!-- native-coverage-generated:end -->

## Floor changes

**This section lives below the generated marker on purpose.** It sat inside the generated block
until 2026-08-29, where every `native:coverage` run silently deleted it — the ratchet-release
history this file calls rare and important was one regeneration away from being lost each time.
Keep hand-authored provenance below the marker.

`src/runtime.cpp` 39.50% -> 38.88%, released once on 2026-08-28 when PRD-250's off-thread
Worker landed. This is not a coverage regression: covered lines in that file went **up**,
771 -> 785. The file grew 1952 -> 2019 lines, so the ratio fell while absolute coverage
rose. The same change brought `src/workers/` into this configuration for the first time -
it was previously listed under "not compiled" - which is why a new 9.05% floor appears
above and why the total moved on a larger denominator.

Releasing a floor is a ratchet release and should stay rare. The debt this records is
`src/workers/` at 9.05%: `worker_registry.cpp` and `worker_thread.cpp` compile but are
barely exercised by this configuration's tests.

## Phase 1 red-green and fail-closed evidence

The test landed before the implementation:

```text
FAIL tests/native-coverage.test.mjs
Cannot find module '../scripts/measure-native-coverage.mjs'
Test Files 1 failed (1); Tests no tests
```

The first multi-executable export emitted `41 functions have mismatched data`. Making warnings
fatal turned that into a hard failure. A unique-object export still collided on inline/template
symbols (`89 functions`). The accepted implementation exports each executable against only its own
profiles and unions LCOV source lines; the final command emits no LLVM warnings.

```text
Checked 3 files in 17ms. No fixes applied.
Test Files 1 passed (1)
Tests 9 passed (9)
```

Every successful invocation produces its own required profile. Compile truth comes from
`compile_commands.json`; `src/audio/vorbis_impl.c` and `src/utils/stb_impl.cpp` therefore remain
compiled with 0 instrumentable lines rather than being misreported as uncompiled.

The compiler negative control failed during configuration as required:

```text
TN_ENABLE_COVERAGE requires clang source-based coverage; configure with clang/clang++
Configuring incomplete, errors occurred!
```

## Phase 2 CTest evidence

The registration test was red before `enable_testing()` and the 27 primary registrations existed:

```text
FAIL should register every native executable with CTest
The input did not match /enable_testing\(\)/
Test Files 1 failed (1); Tests no tests
```

After registration, the focused gate and full runner were green:

```text
Test Files 2 passed (2)
Tests 15 passed (15)

100% tests passed out of 26
native-contract = 6.62 sec*proc (28 tests)
17 - threenative-physics-actuation-bindings-test (Disabled)
26 - threenative-video-recorder-state-test (Disabled)
```

CTest owns all 27 primary target names plus the second required shutdown invocation. Phase 1 now
runs those registrations one at a time so its per-invocation profiles cannot drift from the
correctness runner.

The existing-build regression check removed `build/tn-linux/CTestTestfile.cmake`, made the source
newer than the generated build, and invoked only `pnpm native:test:cpp`. Its aggregate build
regenerated CTest metadata before inventory validation, then passed all 26 runnable registrations
with exactly the same two disabled feature-off rows.

The real legacy-shape negative control was registered in a disposable CTest file and failed:

```text
RED observed: legacy wrapper shape rejected
command-encoder-class-table contract: 2 failure(s)
0% tests passed, 1 tests failed out of 1
```

## Coverage expansion verification — 2026-09-07

The reconciled native contract suite executes five additional targets covering Canvas/audio,
CLI/network/filesystem, JavaScript modules, runtime/platform behavior, and WebGPU. The CLI
executables delegate to the same entry functions exercised by the contract tests. Assertions
check script completion as well as evaluation success, and filesystem fixtures use an isolated
temporary working directory.

The coverage candidate initially made the ray-tracing stub report support when an environment
variable was set. A compiled negative control exposed that false capability before the
production override was removed:

```text
[MystralRT] No hardware RT available, using stub backend
FAIL: unavailable native ray tracing became supported through an environment variable
```

After restoring honest stub support reporting, the same compiled probe passed. The new CLI
contract retains the unsupported-capability assertion:

```text
[MystralRT] No hardware RT available, using stub backend
PASS: unavailable native ray tracing remains unsupported
```

The expanded contract targets passed locally, followed by a complete `pnpm native:coverage`
measurement with all 38 runnable contract targets passing. The coverage command now provisions
the repository's `scripts/xvfb.sh` display wrapper on Linux, so the SDL/WebGPU surface paths are
measured instead of silently skipped. The generated result above is **17,524 / 21,784 lines
(80.44%)**, compared with the base commit's committed **9,579 / 21,762 lines (44.02%)**. No
coverage floor was lowered.

This coverage measurement is the Linux clang/V8/Dawn configuration. Physics and video remain
disabled as listed above. It does not establish Windows, macOS, Android, or iOS coverage.
The 80% target is a Linux desktop measurement only.


## Windowed desktop proof — 2026-09-07

The same changed Linux runtime then passed the existing desktop core verifier on an NVIDIA
GeForce RTX 2080 using Vulkan. The verifier provisions its own X display, renders exactly
300 frames, checks one present per frame plus the single capture refresh, verifies the native
worker lifecycle and ordered startup markers, and checks the saved overlay pixels. The
1280×720 capture was also visually inspected.

The first run reached all 300 frames but failed because this host's ALSA device was unavailable.
Setting SDL's existing dummy audio driver allowed the display proof to complete; this run
does not establish audible output.

```text
SDL_AUDIODRIVER=dummy node packages/runtime-native/scripts/verify-desktop-core.mjs
desktop core gate passed: 300 frames, 1280x720
[WebGPU] Adapter: NVIDIA GeForce RTX 2080
[WebGPU] Backend: Vulkan
TN_CAPTURE_REFRESH_PRESENTS:1
Rendered 300 frames in 13267ms
TN_PRESENTS:301
```

Retained receipts: [report](native-coverage-2026-09-07/desktop-linux-report.json),
[host log](native-coverage-2026-09-07/desktop-linux.txt), and
[capture](native-coverage-2026-09-07/desktop-core-2026-09-07.png). The report's artifact paths
name their original runtime output locations. The PNG copy is byte-identical. Biome
formatted the retained JSON report, and trailing whitespace was removed from the host log;
the recorded fields and observations are unchanged.

Original host-log SHA-256: `11fa54f8059fc2e8412a6eeed5f03d0dbf988f047963f6ce6b1900aaf100b149`.

Runtime SHA-256: `03637735e2bde54ca5f6c2b8e432047d2abc50784ac3095f63c07314b443216a`.
Capture SHA-256: `b7f96827af94c7346112d7b01c7b6d622b1fbbd5100606e60d19e2d61adc0bda`.


The existing `examples/native-smoke/playtests/loading-screen-desktop.playtest.json` scenario
also passed against this binary through the desktop playtest driver. Its assertions observe
the loading surface and readiness during the first-use stall and after startup settles.

```text
SDL_AUDIODRIVER=dummy sh scripts/xvfb.sh node packages/runtime-native/scripts/verify-desktop-loading.mjs
desktop loading playtest proof passed: 913920 startup loading pixels, 0 settled loading pixels
```

Retained loading receipts: [proof](native-coverage-2026-09-07/loading/loading-proof.json),
[console](native-coverage-2026-09-07/loading/console.json),
[startup capture](native-coverage-2026-09-07/loading/startup-stall.png),
[mid-stall capture](native-coverage-2026-09-07/loading/startup-mid-stall.png), and
[settled capture](native-coverage-2026-09-07/loading/startup-settled.png). The startup and
settled images were visually inspected. Original output paths remain in the byte-identical
proof record.


## Desktop test portability red-green — 2026-09-08

Hosted run `34170333684` exposed two assumptions in the new native tests. The CLI test
compiles the real CLI entry source, so it needs the same private WebP headers as the executable.
The WebGPU test must use only features granted to its device and wait for asynchronous GPU
completion before asserting the final sentinel. These are engine verification defects; the
shipping runtime and game appearance are unchanged by this follow-up.

The observed macOS and Windows failures were:

```text
fatal error: 'webp/encode.h' file not found
fatal error C1083: Cannot open include file: 'webp/encode.h': No such file or directory
[WebGPU] adapter feature probe timestamp-query: no
[error] WEBGPU_TEST_ERROR: createQuerySet: this device was not granted 'timestamp-query'
[V8] check.js:1: Error: not done
webgpu comprehensive test did not complete successfully
```

The CLI test target now inherits the WebP include directory, timestamp queries require the
device's feature grant, and the test pumps until completion or an explicit five-second deadline.
Missing device/encoder state and script errors still fail. The full Linux coverage command
then rebuilt and executed all 38 runnable native contract targets successfully under the
repository's display wrapper:

```text
CMAKE_BUILD_PARALLEL_LEVEL=2 pnpm --filter @threenative/runtime-native native:coverage
Configuration: tn-linux-coverage with clang source-based coverage
Executed 38 native contract targets; 2 configured targets could not be built
TOTAL: 21784 instrumented lines; 17524 covered; 80.44%
```

The two blocked rows are still the explicitly disabled physics and video targets. Native
coverage floors are unchanged. This is Linux green evidence for the repair; macOS and Windows
verification must run again on the published follow-up before either platform is claimed green.

## Native diagnostics capability preflight — 2026-09-08

Commit `5e2db7025f9055cd66d973d77abd892828439519` resolves omitted diagnostics for the
executed target before checking bridge capabilities. An Android scenario that omits
`noNetworkErrors` therefore records browser network observation as unavailable instead of
requiring the native bridge to provide `browser.network`; an explicit request remains a
fail-closed unsupported capability.

An exact semantic revert reproduced `TN_PLAYTEST_CAPABILITY_MISSING browser.network` and failed
the focused test 1/1. Restoring the target-aware call passed that test 1/1, then
`device-playtest`, `unobservable-lane`, `bridgeClient`, and `runner-lanes` passed 64/64. The
resulting generated capability metadata changed all ten scaffold trees; the measured hashes are
pinned in `packages/create-threenative/__tests__/scaffold.spec.ts`, whose complete suite passed
55/55.
