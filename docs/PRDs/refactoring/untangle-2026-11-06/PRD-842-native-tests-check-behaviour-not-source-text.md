# PRD-842 — Native tests check behaviour, not source text

**Status:** NOT STARTED
**Priority:** P2 — the open boxes replace regex assertions over `bindings.cpp` and `runtime.cpp`, which go red on renames and stay green on behaviour regressions, and delete a timer branch compiled in no build.
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
| `MYSTRAL_USE_LIBUV_TIMERS` is defined in no build, yet its timer twin ships and a test locks its shape | `packages/runtime-native/src/runtime.cpp:1969,2871-2983` |

## Solution

Each asserted behaviour gets a callable seam: timer semantics through `timer_delivery_test.cpp`,
staging call order through a C++ unit test, and shim bootstrap through the embedded-bundle test.
The text assertions are deleted. The ABI digest in `web-host-abi.spec.ts` stays, because it guards a
real wire. The undefined-macro timer branch is deleted.

## Acceptance Criteria

- [ ] AC-1 [local]: The native host runs with timers and shims intact. proof: `pnpm native:verify:desktop`
- [ ] AC-2 [local]: The source-text test count drops to the ABI digest only. proof: `rg -l 'readFileSync\([^)]*\.(cpp|mm)' packages/runtime-native/tests packages/three-native/__tests__` lists only the ABI spec

## Integration Ledger

Integration: unchanged — tests and one dead branch only.

## Execution Phases

#### Phase 1: Timers
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/runtime.cpp`, `tests/timer-contract.test.mjs`, `tests/timer_delivery_test.cpp`.

- [ ] The `MYSTRAL_USE_LIBUV_TIMERS` branch is deleted, and timer ordering is proved by `timer_delivery_test.cpp`, not by slicing source. proof: the native test binary (`tn-native-engine-tests`) plus `rg -n MYSTRAL_USE_LIBUV_TIMERS packages` returns nothing

#### Phase 2: Bindings and shims
**Status:** NOT STARTED
**Files:** `tests/embedded-js.mjs`, `tests/js-engine-fast-path.test.mjs`, `tests/embedded_bundle_test.cpp`, the bindings text specs.

- [ ] Shim bootstrap and fast-path selection are asserted by running the host, and the 7 historical block names are gone. proof: `node --test packages/runtime-native/tests/` plus `embedded_bundle_test`
- [ ] The remaining text specs on `bindings.cpp` and `browser-renderer.ts` are replaced by behaviour checks or deleted when a behaviour test already covers them. proof: AC-2
