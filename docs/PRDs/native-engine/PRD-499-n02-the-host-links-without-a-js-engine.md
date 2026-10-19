# PRD-499 — The host links and runs without a JS engine (N02)

**Status:** PROPOSED
**Priority:** P1 — Wave 1: gate E requires the host to link and run with no JS engine; 8 open boxes.
**Complexity:** 5 — splits the native CMake tree, decouples the GPU context from scripting, and adds an artifact inspector every strict gate reuses
**Owner:** João
**Work package:** N02 — [native-engine batch](README.md)
**Depends on:** [PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)

## Context

Gate E needs a native application that renders with no V8, QuickJS, JavaScriptCore, Hermes, engine JS bundle or WebView (§1). Today the GPU context in `packages/runtime-native/include/mystral/webgpu/context.h` holds a `BindingsState*` (`setBindingsState`, R2), so linking the context still pulls in scripting state. `packages/runtime-native/CMakeLists.txt` builds C++20 only when `MYSTRAL_USE_V8` is on and falls back to C++17 otherwise (R6). The JS engines live in `packages/runtime-native/src/js/`.

§15.2 says a `.js` filename scan proves nothing. JS-free status is shown by the build dependency graph, linker map/symbol inspection, the packaged-resource inventory and runtime module inspection together. §17 asks for sanitizers on native-engine code. The repo already has `native:test:asan` and the `native-sanitizer` ctest label.

## Solution

1. **Target split** per §13: proposed CMake targets `tn_engine_foundation`, `tn_engine_scene`, `tn_engine_animation`, `tn_engine_assets`, `tn_engine_shader`, `tn_engine_renderer`, `tn_host_services`, `tn_abi`, and optional `tn_adapter_v8`. Every engine target requires C++20 regardless of `MYSTRAL_USE_V8`. No target below a scripting adapter includes VM headers or links VM libraries.
2. **Host-services extraction** (proposed: `packages/runtime-native/src/host/`). The GPU context, window/surface, IO, input and audio move behind interfaces with no `BindingsState` reference. The scripting bindings register as a consumer of the context instead of being owned by it.
3. **Gate-E driver** (proposed: `packages/runtime-native/tests/native-engine/gate_e_driver.cpp`). A C++ test driver opens a window or headless target, clears and presents frames, and exits clean.
4. **Artifact inspector** (proposed: `packages/runtime-native/scripts/inspect-js-free.mjs`). It reads the CMake target dependency graph, the linker map, the exported/imported symbols (`nm`/`objdump`/`dumpbin` per platform) and the packaged-resource list. It fails when any VM symbol family, embedded script blob or WebView library is present, and writes an evidence manifest naming the binary hash and capabilities (§15.2). [PRD-530](PRD-530-n17-strict-native-typescript-game-packaging.md) reuses it unchanged.
5. **CI**: a `native-engine` step inside the existing `test-native` job in `.github/workflows/ci.yml` (no new workflow file). It builds the engine targets with scripting off, runs the gate-E driver headless, runs the inspector, and runs the engine tests under the `native-sanitizer` label.
6. **Wasm-safe from day one** (owner decision 4): engine targets use no blocking waits, no mandatory threads and no platform API outside the host-service interfaces. A compile-only Emscripten configuration of the engine targets guards this in CI, ahead of the full browser port ([PRD-532 (N19)](PRD-532-n19-webassembly-native-core-browser-port.md)).
7. **Rollback**: the legacy host targets keep building unchanged; the split adds targets and moves no behaviour of the shipped player.

## Out of scope

- Upload/readback, resize and device loss on the extracted context: [PRD-509](PRD-509-n07-gpu-resources-presentation-and-device-loss.md).
- Strict *game* packaging: [PRD-530](PRD-530-n17-strict-native-typescript-game-packaging.md).

## Execution Phases

#### Phase 1: The context no longer knows about scripting
**Status:** NOT STARTED
**Files:** `packages/runtime-native/include/mystral/webgpu/context.h`, `packages/runtime-native/src/webgpu/`, proposed `packages/runtime-native/src/host/`
- [ ] `context.h` and the extracted host services compile with no `BindingsState` reference and no `src/js/` include. proof: `rg -n "BindingsState|src/js" packages/runtime-native/src/host packages/runtime-native/include/mystral/webgpu/context.h` returns nothing, then `pnpm native:build`
- [ ] The shipped desktop host still passes its gate after the extraction. proof: `pnpm native:verify:desktop`

#### Phase 2: Engine targets build and run with scripting off
**Status:** NOT STARTED
**Files:** `packages/runtime-native/CMakeLists.txt`, proposed `packages/runtime-native/tests/native-engine/gate_e_driver.cpp`
- [ ] Engine targets configure as C++20 with `-DMYSTRAL_USE_V8=OFF -DTN_SCRIPTING=OFF`, and none links a JS engine library. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_target_graph`
- [ ] The gate-E driver presents 300 headless frames with scripting compiled out. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_gate_e`
- [ ] The engine targets also compile under Emscripten with threads off, compile-only. proof: `emcmake cmake -S packages/runtime-native -B packages/runtime-native/build/wasm-check -DTN_ENGINE_ONLY=ON && cmake --build packages/runtime-native/build/wasm-check`

#### Phase 3: JS-free status is inspected, not assumed
**Status:** NOT STARTED
**Files:** proposed `packages/runtime-native/scripts/inspect-js-free.mjs`, `packages/runtime-native/tests/inspect-js-free.test.mjs`; `.github/workflows/ci.yml`
- [ ] The inspector fails on a binary carrying V8, QuickJS, JSC or Hermes symbols or an embedded script resource, and passes on the gate-E driver. proof: red-green `pnpm --filter @threenative/runtime-native exec vitest run tests/inspect-js-free.test.mjs`
- [ ] The inspector writes an evidence manifest with binary hash, target, backend and capability list. proof: `node packages/runtime-native/scripts/inspect-js-free.mjs --binary <gate-e driver> --manifest artifacts/native-engine/gate-e.json`
- [ ] CI's `test-native` job runs the gate-E driver, the inspector and the sanitizer-labelled engine tests. proof: the `test-native` job on the PRD's PR
