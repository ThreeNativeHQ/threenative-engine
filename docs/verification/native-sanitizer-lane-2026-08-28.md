<!-- native-sanitizer-generated:start -->
# Native sanitizer lane — 2026-08-28

Configuration: `tn-linux-asan`

## Ran under ASan + UBSan

- `threenative-bindings-creation-test`
- `threenative-dom-dispatch-lifetime-test`
- `threenative-frame-op-stream-replay-test`
- `threenative-handle-lifetime-test`
- `threenative-shutdown-lifetime-test`
- `threenative-webgpu-bindings-reentrancy-test`

## Not run by this lifetime-focused lane

- `threenative-async-pipeline-thread-test`: outside the lifetime sanitizer scope
- `threenative-audio-decode-ogg-test`: outside the lifetime sanitizer scope
- `threenative-audio-decode-promise-test`: outside the lifetime sanitizer scope
- `threenative-audio-graph-test`: outside the lifetime sanitizer scope
- `threenative-canvas-audio-comprehensive-test`: outside the lifetime sanitizer scope
- `threenative-canvas-presentation-test`: outside the lifetime sanitizer scope
- `threenative-canvas2d-dirty-test`: outside the lifetime sanitizer scope
- `threenative-cli-network-fs-test`: outside the lifetime sanitizer scope
- `threenative-command-encoder-class-table-test`: outside the lifetime sanitizer scope
- `threenative-crash-handler-policy-test`: outside the lifetime sanitizer scope
- `threenative-css-ui-overlay-test`: outside the lifetime sanitizer scope
- `threenative-device-pixel-ratio-test`: outside the lifetime sanitizer scope
- `threenative-embedded-bundle-test`: outside the lifetime sanitizer scope
- `threenative-exposure-graph-test`: outside the lifetime sanitizer scope
- `threenative-input-restart-test`: outside the lifetime sanitizer scope
- `threenative-js-engine-contract-test`: outside the lifetime sanitizer scope
- `threenative-js-module-comprehensive-test`: outside the lifetime sanitizer scope
- `threenative-lifecycle-policy-test`: outside the lifetime sanitizer scope
- `threenative-local-storage-test`: outside the lifetime sanitizer scope
- `threenative-metahuman-bindings-test`: outside the lifetime sanitizer scope
- `threenative-physics-actuation-bindings-test`: outside the lifetime sanitizer scope
- `threenative-pipeline-cache-api-test`: outside the lifetime sanitizer scope
- `threenative-pipeline-cache-lifecycle-test`: outside the lifetime sanitizer scope
- `threenative-pipeline-cache-test`: outside the lifetime sanitizer scope
- `threenative-presentation-pacing-test`: outside the lifetime sanitizer scope
- `threenative-render-pass-class-table-test`: outside the lifetime sanitizer scope
- `threenative-rg11b10-renderable-test`: outside the lifetime sanitizer scope
- `threenative-rt-handle-allocation-test`: outside the lifetime sanitizer scope
- `threenative-runtime-platform-comprehensive-test`: outside the lifetime sanitizer scope
- `threenative-screenshot-capture-gate-test`: outside the lifetime sanitizer scope
- `threenative-shader-module-metadata-test`: outside the lifetime sanitizer scope
- `threenative-stall-budget-hitch-test`: outside the lifetime sanitizer scope
- `threenative-surface-format-selection-test`: outside the lifetime sanitizer scope
- `threenative-surface-texture-status-test`: outside the lifetime sanitizer scope
- `threenative-timer-delivery-test`: outside the lifetime sanitizer scope
- `threenative-timer-engine-first-test`: outside the lifetime sanitizer scope
- `threenative-timestamp-query-test`: outside the lifetime sanitizer scope
- `threenative-transient-attachments-test`: outside the lifetime sanitizer scope
- `threenative-video-recorder-state-test`: outside the lifetime sanitizer scope
- `threenative-webgpu-comprehensive-test`: outside the lifetime sanitizer scope
- `threenative-webtransport-surface-test`: outside the lifetime sanitizer scope
- `threenative-webtransport-wire-test`: outside the lifetime sanitizer scope
- `threenative-wgpu-null-handle-test`: outside the lifetime sanitizer scope
- `threenative-worker-production-test`: outside the lifetime sanitizer scope
<!-- native-sanitizer-generated:end -->

## Red-green evidence

The lane first failed at link time because UBSan's `vptr` check requires RTTI symbols that the
prebuilt V8 and Skia archives do not export. The final build keeps
`-fsanitize=address,undefined -fno-omit-frame-pointer` while narrowly excluding only `vptr`.

Once linked, LeakSanitizer exposed two engine leaks: V8 weak-release records were not owned at
teardown, and four WebGPU registries were never released by `destroyBindingsState`. After those
engine fixes, the real lane passed:

```text
Test Files 3 passed (3)
Tests 18 passed (18)

100% tests passed out of 6
native-sanitizer = 12.19 sec*proc (6 tests)
```

Leak detection remains enabled. The generated dated suppression file names only DBus process
state, three NVIDIA userspace-driver modules, and Dawn's Vulkan queue. Each entry carries its own
reason; there is no `detect_leaks=0` or unknown-module suppression.

## Negative control

A disposable `-O0` executable deleted an integer and then read it. The instrumented executable
failed closed and surfaced the source line:

```text
ERROR: AddressSanitizer: heap-use-after-free
READ of size 4
SUMMARY: AddressSanitizer: heap-use-after-free prd229-asan-negative.cpp:6 in main
NEGATIVE_EXIT=1
```
