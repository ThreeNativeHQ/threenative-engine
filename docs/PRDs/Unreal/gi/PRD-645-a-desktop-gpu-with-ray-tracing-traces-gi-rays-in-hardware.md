---
prd_contract: v1
---

# PRD-645 — A desktop GPU with ray tracing traces GI rays in hardware

**Status:** PARTIAL — Phase 1 done 2026-10-21 on `lane/rt`. Phase 2 is blocked (see `## Blocked on`).
**Priority:** P3 — nothing depends on it: a fresh Unreal project traces Lumen in software, so the default look does not need hardware ray tracing. It is a cost and quality option for the native desktop host.
**Complexity:** 7 (HIGH) — 1–5 files in `packages/runtime-native/src/raytracing/` and the trace seam (+1), crosses the native build boundary (+2), complex state: acceleration structures that follow moving meshes (+2), a buffer interop seam between the WebGPU device and the ray tracing device (+2); risk override: none
**Owner:** João
**Depends on:** [PRD-603](../rendering/PRD-603-probes-refresh-by-tracing-the-packed-scene-not-by-drawing-it-six-times.md) Phase 2 (the probe trace kernel whose rays this replaces). [PRD-VQ-09](../../rendering/PRD-VQ-09-incremental-diffuse-relighting.md) (moving meshes in the trace).

## Context

- `packages/runtime-native/src/raytracing/` holds Vulkan, Metal and DXR ray tracing backends behind a
  `mystralRT` JavaScript global (`bindings.h`: `isSupported`, `createBLAS`, `createTLAS`,
  `updateTLAS`, `traceRays`). They build with the native host (`packages/runtime-native/CMakeLists.txt`).
- They are switched off. `traceRays` refuses with `TN_NATIVE_RAYTRACING_UNAVAILABLE`, because no
  buffer-to-texture copy-out interop exists between the ray tracing device and the WebGPU device
  (`packages/runtime-native/conformance/scenes/shared/raytracing-refusal.js`). Nothing in
  `packages/core` can reach them.
- WebGPU, the browser target, has no ray tracing API in its shipped specification. A web build keeps
  the software trace through `GPUSceneBVH` in every case.

### What Unreal does (UE 5.8.3, read 2026-10-20; clean-room summary, no code copied)

- **Hardware Lumen exists and is off in a fresh project.** `r.Lumen.HardwareRayTracing` defaults to 1,
  but it is active only when the project enables ray tracing support
  (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenHardwareRayTracingCommon.cpp`). The
  third-person template enables no ray tracing and sets `r.Lumen.TraceMeshSDFs=0`
  (UE 5.8.3: `Templates/TP_ThirdPersonBP/Config/DefaultEngine.ini`). The reference captures of PRD-631
  and PRD-638 are therefore software Lumen.
- **Hit lighting and the far field need hardware.** Hit lighting is allowed at Epic and off at High
  and Medium. The far field (`r.LumenScene.FarField`, off by default) is hardware-only
  (UE 5.8.3: `Engine/Config/BaseScalability.ini`; `Lumen::UseFarField`).
- **ReSTIR GI needs hardware too.** `r.Lumen.FinalGatherMethod=2` selects it, and it is not a default
  at any level (UE 5.8.3: `Engine/Source/Runtime/Renderer/Private/Lumen/LumenReSTIRGather.cpp`).
  This PRD does not build it.

## Solution

1. **Make one traced result readable (Phase 1).** Build the missing copy-out interop on the Vulkan
   backend only: the ray tracing device writes into a buffer that the WebGPU device can read. Then
   trace the PRD-603 probe rays (64 per probe) with `traceRays` against a TLAS of the static scene.
   **Gate:** continue only if hardware tracing reaches at least 2× the probes per millisecond of the
   `GPUSceneBVH` compute trace on the same RTX 2080 and scene. Otherwise record the decline under
   `## Decisions` and delete Phase 2 (R4). The refusal message changes only on the path that works.
   **Delivered 2026-10-21:** Phase 1 returns the hit records in a typed array that the caller owns,
   not in a shared GPU buffer. The reason and the gate verdict are under `## Decisions`.
2. **A named override on the native desktop host (Phase 2).** The traced radiance cache gains
   `rayTracing: "hardware" | "software"`. Auto picks `software` everywhere. `hardware` runs only on the
   native desktop host with a supported GPU and falls back to `software` with a `TN_RAY_TRACING`
   line that names the reason. The atlas output is the same, so every consumer stays unchanged.
   The default flips to `hardware` only if PRD-631's L7 row still matches with it on and the frame is
   faster, and that decision is recorded here.

**Names and manifest.** `rayTracing: "hardware"` mirrors `r.Lumen.HardwareRayTracing`. The manifest
entry carries `@alias lumen hardware ray tracing` and `@alias hardware ray tracing`.

**Where each part lives.** The interop and the TLAS are platform seams, so they belong to the
framework in `packages/runtime-native/` (rule: the game cannot write them portably). The radiance
cache option is mechanism in `packages/core`.

## Acceptance Criteria

- [ ] AC-1 [local; needs a built desktop host]: With `rayTracing: "hardware"`, the L7 cells on the native desktop host match the software trace within the PRD-631 noise floor. proof: `pnpm unreal-look:capture --engine threenative --target desktop --layers L7` and `pnpm unreal-look:compare --layer L7` — Evidence: blocked. The option does not exist until Phase 2. `scripts/unreal-look/capture.ts` has no `--target` flag.
- [x] AC-2 [local; needs a built desktop host]: The conformance row `raytracing-probe-trace` passes on the desktop lane, and the existing refusal row still passes on a host without ray tracing. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace,98-native-raytracing-refusal` — Evidence: 2026-10-21. Command: `node conformance/run-conformance.mjs --target desktop --only-tests raytracing-probe-trace,98-native-raytracing-refusal`. This is the command behind `pnpm parity`. `THREENATIVE_RUNTIME_BINARY` named a `-DTN_ENABLE_RAYTRACING=ON` build. RTX 2080: `raytracing-probe-trace pass 8.2s` and `98-native-raytracing-refusal pass 14.0s`. The same command with `VK_ICD_FILENAMES` set to the SwiftShader ICD, which has no ray tracing device: `98-native-raytracing-refusal pass 47.5s` and `raytracing-probe-trace pass 37.7s`. On that host the row skips and names the reason.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `mystralRT.traceRayBatch` and `capabilities()` on the Vulkan backend | The conformance row `raytracing-probe-trace`. Nothing in `packages/core` calls it until Phase 2 | Adds a path. `traceRays` and its refusal stay, because the copy-out interop was not built | Phase 1 |
| `rayTracing: "hardware"` | The traced radiance cache on the native desktop host | Software trace stays the auto default and the fallback | AC-1 |

## Execution Phases

#### Phase 1: One readable hardware trace, and the gate
**Status:** DONE 2026-10-21
**Files:** `packages/runtime-native/src/raytracing/vulkan_rt.cpp`, `packages/runtime-native/src/raytracing/bindings.cpp`, `packages/runtime-native/src/raytracing/rt_common.h`, `packages/runtime-native/src/raytracing/shaders/probe_trace.comp` (new), `packages/runtime-native/tests/raytracing_probe_test.cpp` (new), `packages/runtime-native/conformance/scenes/shared/raytracing-probe-trace.js` (new), `packages/runtime-native/conformance/registry.json`
- [x] A hardware trace of one probe's 64 rays returns the same hit distances as the BVH trace within 1 mm. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace`. Result 2026-10-21: the row passes (`raytracing-probe-trace pass 8.2s`, RTX 2080). It traces 721,920 rays through both paths, in batches from 1,024 rays (16 probes) to 524,288 rays (8,192 probes). The largest distance error is 2.09e-5 m. The paths name different triangles on 11 rays. The exact trace sides with the hardware on all 11.
- [x] Probes per millisecond for hardware and for the BVH compute trace are recorded with the gate verdict under `## Decisions`. proof: the row prints one `TN_RT_PROBE_TRACE` record per batch on every run. It has no `--perf` flag. Result 2026-10-21: see `## Decisions`, "gate verdict".

#### Phase 2: The override on the radiance cache
**Status:** BLOCKED — see `## Blocked on` and the Phase 2 decision under `## Decisions`.
**Files:** `packages/core/src/render/probe-trace.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] `rayTracing: "hardware"` on a host without support falls back to software and logs the reason in `TN_RAY_TRACING`. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] A capability search for "lumen hardware ray tracing" returns the radiance cache option. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
**Verification:** AC-1 and AC-2. A PRD-647 round on `cornell` and `sunlit-room` at `high` returns no REGRESSION against the BVH trace.

## Blocked on

- PRD-603 Phase 2: the `probe-trace.ts` kernel does not exist on the epic or on any lane branch (checked 2026-10-21). The option has nothing to attach to. Unblocks: the gi lane.
- A transport that costs less than the trace it replaces. The Phase 1 path copies the rays and the hits through the CPU. Unblocks: a Dawn import of a Vulkan image (`SharedTextureMemoryOpaqueFD` plus a shared semaphore) in the host WebGPU binding. It also unblocks if a new transport shows an end-to-end gain of at least 2x at the scene sizes the cache traces. Owner call: whether to file the interop PRD.

## Decisions

- **2026-10-21, rt-lane (owner away): the native host reaches hardware ray tracing through Vulkan. It cannot reach it through Dawn.**
  The pinned Dawn `webgpu.h` has no feature name for ray tracing or for acceleration structures. Dawn imports Vulkan memory as images only (`SharedTextureMemoryOpaqueFD`, `SharedTextureMemoryDmaBuf`). It shares buffers on D3D12 only. The separate Vulkan backend reaches the hardware. The RTX 2080 (driver 615.78.08, Vulkan 1.4.351) exposes `VK_KHR_acceleration_structure`, `VK_KHR_ray_query` and `VK_KHR_ray_tracing_pipeline`.
- **2026-10-21, rt-lane: the blocker was a defect, not missing hardware support.**
  `rt_shaders_spirv.h` held placeholder SPIR-V. `spirv-val` rejects it, so `vkCreateRayTracingPipelinesKHR` failed. The backend factory then chose the stub (`getBackend()` returned `none`) on every host. Red, before the fix: `TN_RAYTRACING_REQUIRE=1 threenative-raytracing-probe-test` exits 1 with `Failed to create RT pipeline`. Green, after `cmake -P cmake/CompileRTShaders.cmake` (commit `ffaa4d380`): verdict `pass` on 16,549 ray evaluations over five batch sizes. It finds 0 hit or miss mismatches and 0 triangle mismatches against a double precision CPU trace. The largest distance error is 2.2e-6 m. The path exists only in a host built with `-DTN_ENABLE_RAYTRACING=ON`. Every preset keeps that option OFF, so a CI host takes the stub and the row skips with a reason.
- **2026-10-21, rt-lane: the hit records come back in a typed array that the caller owns.**
  `mystralRT.traceRayBatch({ tlas, rays, hits })` reads 8 floats per ray and writes 4 words per hit. The caller uploads the hits with an ordinary queue write. This needs no copy-out interop, so `traceRays` and its refusal stay as they were. A zero-copy path needs a Vulkan image with exportable memory. Dawn imports it through `SharedTextureMemoryOpaqueFD` with a shared semaphore. The host needs a new WebGPU binding for that import. That is a separate PRD. Only the Vulkan backend implements the batch path. DXR and Metal report `rayBatch: false` and a reason.
- **2026-10-21, rt-lane: how the numbers were measured.**
  The row builds one static room at three sizes (2,544, 46,832 and 261,040 triangles) and fills it with a regular probe grid. It traces 64 rays per probe (Fibonacci directions, one spin per probe). These rays stand in for the PRD-603 kernel, which does not exist yet. The same rays go through the upstream TSL `bvhIntersectFirstHit` over `GPUSceneBVH` (software) and through `traceRayBatch` (hardware). Kernel time is the GPU time of one dispatch: Dawn timestamp queries for software, Vulkan timestamps for hardware. End-to-end time starts with the rays in CPU memory and ends when the hit records are usable in a WebGPU compute pass. Every timed iteration ends in a 16-byte readback. The reason: `queue.onSubmittedWorkDone` does not wait for passes that the host recorded and has not replayed. Waiting on it after 20 batched dispatches read 0.02 ms per dispatch. GPU timestamps read 0.34 to 1.07 ms for the same dispatches. The row measures the readback cost and subtracts it. Two runs in one exclusive GPU slot on the RTX 2080, each cell is min-max over the two runs. The CPU load average was 25 to 36, so the end-to-end figures carry noise. The kernel figures repeat within 5%.

  | Scene (triangles) | Probes | Software kernel ms | Hardware kernel ms | Probes per ms, software | Probes per ms, hardware | Kernel ratio | Hardware end to end ms | End to end vs software kernel |
  |---|---|---|---|---|---|---|---|---|
  | room (2,544) | 16 | 0.138 | 0.011-0.012 | 116 | 1,381-1,408 | 11.9-12.1x | 0.40-0.49 | 0.28-0.35x |
  | room (2,544) | 1,024 | 0.334-0.341 | 0.023 | 3,005-3,064 | 44,818-44,881 | 14.6-14.9x | 1.25-1.48 | 0.23-0.27x |
  | room (2,544) | 8,192 | 1.868-1.881 | 0.146-0.147 | 4,355-4,386 | 55,798-56,128 | 12.8x | 11.40-12.34 | 0.15-0.16x |
  | dense (46,832) | 1,024 | 0.577 | 0.041 | 1,776 | 25,137-25,177 | 14.2x | 0.97-1.02 | 0.56-0.59x |
  | heavy (261,040) | 1,024 | 0.931-0.970 | 0.066 | 1,056-1,100 | 15,534-15,549 | 14.1-14.7x | 1.11-1.21 | 0.80-0.84x |

  "End to end vs software kernel" divides the software kernel time by the hardware end-to-end time. The software trace can generate its rays on the GPU, so its kernel time is its fair cost.
- **2026-10-21, rt-lane: gate verdict. The trace passes. The transport that Phase 1 built does not.**
  The hardware trace reaches 12 to 15 times the probes per millisecond of the software trace. For 1,024 probes in the room, that is about 44,800 against 3,000. End to end, the hardware path reaches 0.15 to 0.35 times the software kernel in the room. It reaches 0.6 times in the dense scene and 0.8 times in the 261,040-triangle scene. A 1,024-probe call spends about 0.7 ms on the copies across the PCIe bus and on the fence wait. The WebGPU upload of the hits and the consume dispatch add 0.3 to 0.7 ms. The end-to-end cost stays near 1 ms to 1.5 ms. The software kernel grows only from 0.33 ms to 0.95 ms over 100 times more triangles. A path that stages the data through the CPU cannot reach 2x at these scene sizes. Nobody has measured a zero-copy path. The kernel figures (0.02 to 0.07 ms against 0.33 to 0.95 ms) leave room for it to pass.
- **2026-10-21, rt-lane: Phase 2 stays in this PRD and stays blocked. It is not deleted.**
  The gate text says to delete Phase 2 (R4) when the gate fails. The gate fails for the transport only, and the trace itself is 12 to 15 times faster. Deleting Phase 2 would discard that result because the interop was out of reach in this run. Two facts block Phase 2 anyway. `probe-trace.ts` does not exist on the epic or on any of the 28 lane branches. `packages/core/src/render/` holds `probe-volume.ts` and `gi-budget.ts`. The option has nothing to attach to. No transport that beats the software trace exists. Owner call: if you read the gate as end-to-end cost, R4 says to delete Phase 2. Delete it then.
- **2026-10-21, rt-lane: parity method.**
  The software trace has an edge tolerance. The upstream `bvhIntersectFirstHit` accepts a hit up to 1e-5 (barycentric units) outside a triangle. At a silhouette edge it can name a surface that the exact test misses. In the 524,288-ray batch the two paths named different triangles for 10 rays, and for 1 ray in the dense scene. A double precision test of every triangle (the referee) sided with the hardware on all 11. The row fails if the hardware differs from the referee, or if the distances of the rays that agree differ by more than 1 mm. Negative control: adding 2 mm to every hardware distance makes the row fail with `room 16 probes: hit distances differ by 0.0020008087158203125 m, limit 0.001 m`. Three pads the `uvec3` storage of `GPUSceneBVH` to four words on first GPU use, so `bvh.indices.value.array` holds flat triples only before the first dispatch. The row reads both arrays before any dispatch.
- **2026-10-21, rt-lane: proof lines corrected.**
  `run-conformance.mjs` has no `--perf` flag. The row prints one `TN_RT_PROBE_TRACE` record per batch on every run, so the second Phase 1 box names that. The refusal row id is `98-native-raytracing-refusal`, not `raytracing-refusal`. AC-1 names `unreal-look:capture --target`, which does not exist.
