# PRD-509 — GPU resources, presentation and device loss (N07)

**Status:** PROPOSED
**Priority:** P2 — Wave 2: resource ownership, presentation and device loss; 8 open boxes.
**Complexity:** 4 — reuses the existing WebGPU context; the new work is resource ownership and the device-loss state machine on two backends
**Owner:** João
**Work package:** N07 — [native-engine batch](README.md)
**Depends on:** [PRD-499 (N02) — The host links and runs without a JS engine](PRD-499-n02-the-host-links-without-a-js-engine.md), [PRD-500 (N03)](PRD-500-n03-api-catalog-binding-abi-and-version-protocol.md)

## Context

§3 (R2) and §10: the host's GPU context (`packages/runtime-native/include/mystral/webgpu/context.h`,
`src/webgpu/context.cpp`) already exposes device, queue, surface, presentation, headless targets,
capture, timestamps and Android surface rebuilding (`Context::rebuildSurface`). Today JS drives
every resource through the bindings (`src/webgpu/bindings_resources.cpp`) and replays a serialized
command stream (`bindings_frame_stream.cpp`); §10 keeps that stream in the legacy backend only.
Device loss currently logs from `onDeviceLost` and stops. Backend selection is
`MYSTRAL_WEBGPU_BACKEND` (Dawn or wgpu-native) in `packages/runtime-native/CMakeLists.txt`.
§12 requires an explicit device-loss state machine.

## Solution

1. **Native resource layer** (proposed: `packages/runtime-native/src/engine/renderer/gpu_resources.cpp`):
   buffers, textures, samplers, bind groups and pipelines owned by native records keyed by
   generational handles that also carry a **device generation**. A handle from a dead generation is
   rejected with `TN_GPU_STALE_GENERATION`, never reused.
2. **Upload/readback:** staged uploads honour BufferAttribute version semantics (§7.2) and never
   recycle a submitted upload buffer early; async readback completes onto the engine event queue at
   a game-thread boundary (§11.1, §12).
3. **Deferred safe destruction:** a destroy request queues the resource until the GPU has finished
   the last submission that used it (queue `OnSubmittedWorkDone`), then frees it.
4. **Presentation:** one presentation owner (§5); resize and surface loss/rebuild (Android
   `ANativeWindow`, desktop window resize) recreate the surface and size-dependent targets only.
5. **Device-loss state machine (§12):**

   ```mermaid
   stateDiagram-v2
     [*] --> running
     running --> lost: device lost / removed
     lost --> recovering: new device acquired
     recovering --> running: resources rebuilt from CPU descriptors / cooked assets
     recovering --> failed: rebuild error or second loss
     lost --> failed: no adapter
     failed --> [*]
   ```

   Surface recreation stays inside `running`; only device recreation enters `lost`. Game state is
   preserved or visibly reset per the documented path; the state change is published in telemetry.
6. **Backend adapters:** Dawn and wgpu-native each qualified against the same resource test suite;
   device limits and enabled features recorded per backend, never assumed interchangeable (§10).
7. **No blocking waits** (owner decision 4): map, readback and pipeline compilation complete through the engine event queue, never by spinning on the device, so the same code runs on browser WebGPU.
8. **Rollback:** the JS bindings and frame-stream replay stay compiled into the legacy backend.

## Out of scope

- Deciding what to draw — [PRD-514 (N09)](PRD-514-n09-native-renderer-and-standard-materials.md).
- Render-graph transients and history — [PRD-523 (N14a)](N14-native-render-chain-and-advanced-visuals/PRD-523-n14a-the-render-graph-owns-passes-and-history.md).
- Removing `BindingsState` from the context — [PRD-499 (N02)](PRD-499-n02-the-host-links-without-a-js-engine.md).

## Execution Phases

#### Phase 1: Resources, upload, readback, destruction
**Status:** NOT STARTED
**Files:** proposed `src/engine/renderer/gpu_resources.cpp`, `tests/native-engine/gpu_resources_test.cpp`
- [ ] A headless C++ driver uploads a buffer and texture and reads them back byte-identical on Dawn. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_gpu_upload_readback`
- [ ] The same test passes on wgpu-native. proof: `ctest --test-dir packages/runtime-native/build/tn-linux-wgpu -R native_engine_gpu_upload_readback`
- [ ] A resource destroyed while still referenced by an in-flight submission is freed only after that submission completes. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_gpu_deferred_destroy`
- [ ] Readback and buffer mapping complete through the engine event queue with no blocking device wait in the engine targets. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_gpu_async_only`

#### Phase 2: Presentation, resize, surface lifecycle
**Status:** NOT STARTED
**Files:** proposed `src/engine/renderer/presentation.cpp`
- [ ] A windowed native driver presents 300 frames through 5 resizes with no validation error. proof: `pnpm native:verify:desktop`
- [ ] Android surface destroy/recreate (background → foreground) rebuilds the surface without recreating the device. proof: `node packages/playtest/dist/runner/cli.js packages/runtime-native/scenarios/native-engine-surface-cycle.playtest.json --target android`

#### Phase 3: Device loss
**Status:** NOT STARTED
**Files:** proposed `src/engine/renderer/device_state.cpp`
- [ ] A forced `device.destroy()` walks running → lost → recovering → running and the next frame renders from rebuilt resources. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_device_loss_recover`
- [ ] Any handle from the lost generation is rejected with `TN_GPU_STALE_GENERATION`. proof: `ctest --test-dir packages/runtime-native/build/tn-linux -R native_engine_device_stale_handle`

## Decisions

- **No new graphics abstraction (§4, §10).** A thin adapter over the existing context; Dawn and wgpu-native stay the only backends.
- **Native-owned submission does not replay the JS frame-op stream (§10).**
