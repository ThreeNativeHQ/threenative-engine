---
prd_contract: v1
---

# PRD-787 — Hardware ray tracing of a clustered mesh returns when its transport beats the software trace

**Status:** NOT STARTED
**Priority:** P3 — nothing depends on it. A fresh Unreal project traces Nanite through the fallback mesh in software, and PRD-645 declined hardware at its gate. Phase 1 is a cheap re-measure that fires when the revisit condition becomes true.
**Complexity:** 7 (HIGH) — 6+ files across `packages/runtime-native/src/raytracing/` and `packages/core` (+2), crosses the native build boundary (+2), acceleration structures that follow a view-dependent cut (+2), a cache with an error tolerance (+1); risk override: none
**Owner:** unassigned
**Depends on:** [PRD-645](../../done/PRD-645-a-desktop-gpu-with-ray-tracing-traces-gi-rays-in-hardware.md) (done, supplies the hardware trace and the gate numbers). Phases 2 and 3 also need [PRD-694](PRD-694-traces-and-colliders-see-a-clustered-mesh-at-one-fixed-error-not-at-the-camera-cut.md) (the fixed fallback cut) and [PRD-603](../../done/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the per-frame GPU trace). Both read NOT STARTED.

## Context

This PRD covers four rows of the Nanite map (`docs/PRDs/Unreal/research/internals/nanite.json`, group "Ray tracing"): cluster acceleration structures and BLAS build (5157 LOC), BLAS cache (259), stream-out of the cut (1317) and ray-triangle decode (777). All four are `deferred` with the note "Revisit with PRD-645's revisit condition". The owner rule of 2026-10-21 is "defer, never decline": a failed gate becomes Deferred plus a revisit condition.

- PRD-645 built a Vulkan ray query trace in `packages/runtime-native/src/raytracing/`. The trace kernel is 12 to 15 times faster than the `GPUSceneBVH` compute trace on the RTX 2080.
- The gate needed 2x end to end. The GPU transport read 0.14 to 0.16x at 100 probes (6,400 rays) and 1.04 to 1.28x at 8,192 probes. One call spends about 1.1 ms of thread CPU on two Dawn submits and a fence hand-off, whatever the batch size.
- Nothing in `packages/core` calls the hardware trace. The software trace through `GPUSceneBVH` is the only path, and it reads a fixed fallback cut of a clustered mesh (PRD-694), not the camera cut.
- WebGPU has no ray tracing API. A web build keeps the software trace in every case. Every change here is native desktop only and ships native proof.
- This host exposes `VK_NV_cluster_acceleration_structure` (revision 4, `vulkaninfo` on the RTX 2080, 2026-11-02). `rg` finds no use of it in `packages/runtime-native`. The Vulkan backend builds plain BLASes only.

### The revisit condition (PRD-645, `## Decisions`, "Phase 2 deleted")

A reopen needs two things first.

1. A per-frame GPU probe trace exists (PRD-603 Phase 2).
2. A transport costs less than the software trace at 100 probes per frame.

PRD-645 adds one idea for a later box: run the trace inside the C++ frame on GPU buffers, with the TLAS refit in C++, so a steady-state frame has 0 JavaScript calls and 0 CPU readbacks. It would remove the JavaScript call but not the two Dawn submits and the fence hand-off.

### What Unreal does (UE 5.8.3, read 2026-11-02; clean-room summary, no code copied)

- **The default is the fallback mesh.** `r.RayTracing.Nanite.Mode` is 0 (fallback mesh), 1 (streamed out mesh) or 2 (CLAS). It defaults to 0 (UE 5.8.3: `Engine/Source/Runtime/Engine/Private/Rendering/NaniteResources.cpp:192-203`). Mode 2 falls back to mode 0 with a warning when the device has no ray tracing cluster operations (`NaniteResources.cpp:249-266`). A fresh project therefore runs none of the four rows. `BaseScalability.ini` has no Nanite ray tracing cvar at any quality level. It sets only `r.RayTracing.Scene.BuildMode` and the skeletal and dynamic geometry limits (UE 5.8.3: `Engine/Config/BaseScalability.ini:324,364-367,410-414,458-462,506-510`).
- **Stream-out writes the cut as plain triangles.** The cut error is `r.RayTracing.Nanite.MinCutError`, default 0 for visible instances. Offscreen instances take a LOD bias of 1 and a minimum cut error of 4 (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteRayTracing.cpp:57-82`).
- **One reference instance per resource sets the cut.** `UseReferenceInstances` defaults to true. Streaming requests and the BLAS level of detail follow that instance, not each placed copy (`NaniteRayTracing.cpp:84-90`).
- **The BLAS cache reuses a build while the cut stays near.** The cache is on by default. The relative error tolerance is 0.5 (0 is an exact match, 1 or more is frozen). The cache buffer is 64 MB. Streaming can still force a rebuild (`NaniteRayTracing.cpp:92-115`). The cache keeps one entry per runtime resource id and learns hits from a GPU readback of per-root-page requests (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Nanite/NaniteRayTracingASCache.cpp:37-110`).
- **Budgets bound the work per frame.** The stream-out caps are 16M vertices and 64M indices. Built primitives are capped at 8M per frame. The staging buffer is 1024 MB. The CLAS buffer is 512 MB in 16 KB chunks (`NaniteRayTracing.cpp:125-190`).
- **Ray hits decode cluster triangles.** The hit shader reads the cluster and triangle ids, then decodes positions and attributes (UE 5.8.3: `Engine/Shaders/Private/Nanite/NaniteRayTracing.usf`, `NaniteRayTrace.ush`). ThreeNative stores ordinary vertex attributes, so a hit reads them directly. The decode row has no work of its own until a hit-shading path exists.

## Solution

1. **Turn the revisit condition into a check (Phase 1).** Re-run the `raytracing-probe-trace` row on the current host. A contract test reads the `TN_RT_PROBE_TRACE` records and the capability report. It prints the 100-probe ratio of the GPU transport and whether `VK_NV_cluster_acceleration_structure` is present. The test fails when the transport costs less than the software trace at 100 probes. The failure message says "the PRD-787 condition is true: start Phase 2". Until then the test passes and prints the numbers.
2. **Trace the fixed fallback cut in hardware (Phase 2, starts only when the Phase 1 test fires).** This matches Unreal mode 0. The BLAS comes from the PRD-694 fallback cut of each clustered mesh. It needs no stream-out and no cache, because the cut never changes.
3. **Stream out the camera cut and cache the BLAS (Phase 3, starts only when Phase 2 passes its gate).** This matches Unreal mode 1. The stream-out follows the `selectClusterCut` output of one reference instance per mesh. The cache reuses a BLAS while the cut error stays within the relative tolerance. CLAS (mode 2) stays deferred, see `## Decisions`.

**Where it lives.** The acceleration structure build, the cache and the interop are platform seams. They belong to the framework in `packages/runtime-native/`. Any option that picks `hardware` or `software` is mechanism in `packages/core` and keeps `software` as the auto choice. Nothing here decides how anything looks.

**Risks.**

- **The condition may never become true.** The hand-off cost stays near 1.1 ms. Only the in-frame C++ trace removes it. Phase 1 stays a cheap guard and costs nothing when the condition is false.
- **A rebuild per frame can cost more than the trace saves.** The Phase 3 gate charges build time, the cache miss rate and memory.

**Left out on purpose:** ReSTIR GI and hit lighting (PRD-645 left them out), skeletal and dynamic geometry in the TLAS, and DXR and Metal backends. The `rayBatch` path exists on Vulkan only.

## Acceptance Criteria

- [ ] AC-1 [local; needs a built desktop host]: The Phase 1 check reports the 100-probe transport ratio and the CLAS capability on the RTX 2080. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace` and `pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts tests/raytracing-contract.test.mjs` — Evidence: pending.
- [ ] AC-2 [local; needs a built desktop host; opens only if the Phase 1 test fires]: A clustered mesh traced in hardware returns the same hit distances as the software trace of the same fallback cut, within 1 mm. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace` — Evidence: pending.
- [ ] AC-3 [local; needs a built desktop host; opens only if Phase 2 passes]: On a named scene, a frame with the streamed-out cut in hardware costs less than the same frame in software, with the BLAS cache on, and tail frames and memory do not rise. proof: `node packages/playtest/dist/runner/cli.js <scenario>.playtest.json --target desktop` with a `TN_FRAME_BUDGET` read per arm — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Condition check in `raytracing-contract.test.mjs` | `pnpm --filter @threenative/runtime-native exec vitest run` | Adds a guard. The software trace stays the only path in `packages/core` | AC-1 |
| BLAS from the PRD-694 fallback cut | The PRD-603 probe trace, through a `hardware` choice that falls back to `software` with a `TN_RAY_TRACING` line | Adds a path beside the `GPUSceneBVH` trace. Auto stays `software` | AC-2 |
| Cut stream-out and BLAS cache | The same consumer, for a mesh whose cut follows the camera | Adds a path. The fixed fallback cut stays the default, as in Unreal | AC-3 |

## Execution Phases

#### Phase 1: The revisit condition becomes a test
**Status:** NOT STARTED
**Files:** `packages/runtime-native/tests/raytracing-contract.test.mjs`, `packages/runtime-native/conformance/scenes/shared/raytracing-probe-trace.js`
**Implementation:** the contract test reads the row output and the capability report. It prints the 100-probe ratio, the in-frame trace state (always "not built") and whether `VK_NV_cluster_acceleration_structure` shows in the capabilities. It fails with the Phase 2 start message when the 100-probe ratio reaches 1.0 or more.
**Verification:** AC-1 closes this phase.
- [ ] The row prints the 100-probe GPU transport ratio and the CLAS capability, and the contract test passes today with the ratio below 1.0. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace` and the contract test command in AC-1
- [ ] A stubbed row record with a 100-probe ratio of 1.2 makes the contract test fail with the Phase 2 start message. proof: red-green `pnpm --filter @threenative/runtime-native exec vitest run --config vitest.config.ts tests/raytracing-contract.test.mjs`

#### Phase 2: A clustered mesh traces its fixed fallback cut in hardware
**Status:** NOT STARTED — waits for the Phase 1 test to fire
**Files:** `packages/runtime-native/src/raytracing/vulkan_rt.cpp`, `packages/runtime-native/conformance/scenes/shared/raytracing-probe-trace.js`, `packages/core/src/gpu-scene-bvh.ts`
**Implementation:** build one BLAS per clustered mesh from the PRD-694 fallback cut. Place each copy in the TLAS by its transform. Keep the choice `software` unless the host reports support, and log the reason otherwise.
**Verification:** AC-2 closes this phase.
- [ ] The hardware trace of a clustered mesh matches the software trace of its fallback cut within 1 mm, and a host without ray tracing logs `TN_RAY_TRACING` and keeps the software path. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace,98-native-raytracing-refusal`

#### Phase 3: The camera cut streams out and the BLAS cache reuses it
**Status:** NOT STARTED — waits for Phase 2
**Files:** `packages/runtime-native/src/raytracing/vulkan_rt.cpp`, `packages/core/src/clustered-mesh.ts`, `packages/core/__tests__/clustered-mesh.spec.ts`
**Implementation:** write the `selectClusterCut` triangles of one reference instance per mesh into a build buffer. Bound the work with the Unreal defaults: 8M built primitives per frame and a 64 MB cache. Reuse a BLAS while the relative cut error stays within 0.5. Offscreen copies take a minimum cut error of 4.
**Verification:** AC-3 closes this phase. The visual judge from the root `AGENTS.md` applies if the trace feeds a lit image.
- [ ] The streamed-out cut holds exactly the triangles of `selectClusterCut` for the same pose, and a pose change inside the tolerance reuses the BLAS while a change past it rebuilds. proof: red-green `pnpm exec vitest run packages/core/__tests__/clustered-mesh.spec.ts`
- [ ] A moving camera over the named scene shows a lower or equal frame cost in hardware than in software, with 0 `TN_HOT_CALL` lines and no rise in tail frames or memory. proof: `node packages/playtest/dist/runner/cli.js <scenario>.playtest.json --target desktop`, `TN_FRAME_BUDGET` per arm

## Decisions

- **2026-11-02, Phase 1 first (agent, owner away):** all four Nanite rows wait on one condition that no code watches. A test that fires when the condition becomes true costs one test and keeps the deferral honest.
- **2026-11-02, CLAS (Unreal mode 2) stays deferred inside this PRD:** Unreal defaults to mode 0 and falls back to it without cluster operations. The row "Cluster acceleration structures and BLAS build" (5157 LOC) gets work only if Phase 3 shows that the stream-out build misses its budget. The RTX 2080 host lists `VK_NV_cluster_acceleration_structure`, so a later box can target it. The revisit condition is a Phase 3 frame cost that rises with the cut size.
- **2026-11-02, ray-triangle decode has no box:** a ThreeNative hit reads ordinary vertex attributes. The row ships with the first hit-shading consumer, which no PRD plans.

## Blocked on

- PRD-603 Phase 2 (the per-frame GPU probe trace) — unblocks Phases 2 and 3 as consumers. It reads NOT STARTED.
- A transport that costs less than the software trace at 100 probes per frame, for example the trace inside the C++ frame on GPU buffers — João or the native lane decides to build it. Phase 1 reports the number.
- PRD-694 — gives the fixed fallback cut that Phase 2 builds from. It reads NOT STARTED.
