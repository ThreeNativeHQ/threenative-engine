---
prd_contract: v1
---

# PRD-645 — A desktop GPU with ray tracing traces GI rays in hardware

**Status:** NOT STARTED
**Priority:** P3 — no box is ticked, and nothing depends on it: a fresh Unreal project traces Lumen in software, so the default look does not need hardware ray tracing. It is a cost and quality option for the native desktop host.
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

- [ ] AC-1 [local; needs a built desktop host]: With `rayTracing: "hardware"`, the L7 cells on the native desktop host match the software trace within the PRD-631 noise floor. proof: `pnpm unreal-look:capture --engine threenative --target desktop --layers L7` and `pnpm unreal-look:compare --layer L7` — Evidence: pending.
- [ ] AC-2 [local; needs a built desktop host]: The conformance row `raytracing-probe-trace` passes on the desktop lane, and the existing refusal row still passes on a host without ray tracing. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace,raytracing-refusal` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Copy-out interop | `mystralRT.traceRays` on the Vulkan backend | Replaces the refusal on that path only | Phase 1 |
| `rayTracing: "hardware"` | The traced radiance cache on the native desktop host | Software trace stays the auto default and the fallback | AC-1 |

## Execution Phases

#### Phase 1: One readable hardware trace, and the gate
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/raytracing/vulkan_rt.cpp`, `packages/runtime-native/src/raytracing/bindings.cpp`, `packages/runtime-native/conformance/scenes/shared/raytracing-probe-trace.js` (new), `packages/runtime-native/conformance/registry.json`
- [ ] A hardware trace of one probe's 64 rays returns the same hit distances as the BVH trace within 1 mm. proof: `pnpm parity --target desktop --only-tests raytracing-probe-trace`.
- [ ] Probes per millisecond for hardware and for the BVH compute trace are recorded with the gate verdict under `## Decisions`. proof: the same row with `--perf`.

#### Phase 2: The override on the radiance cache
**Status:** NOT STARTED
**Files:** `packages/core/src/render/probe-trace.ts`, `packages/core/__tests__/probe-volume.spec.ts`, `packages/engine-mcp/__tests__/search.spec.ts`
- [ ] `rayTracing: "hardware"` on a host without support falls back to software and logs the reason in `TN_RAY_TRACING`. proof: `pnpm exec vitest run packages/core/__tests__/probe-volume.spec.ts`.
- [ ] A capability search for "lumen hardware ray tracing" returns the radiance cache option. proof: `pnpm exec vitest run packages/engine-mcp/__tests__/search.spec.ts`.
**Verification:** AC-1 and AC-2. A PRD-647 round on `cornell` and `sunlit-room` at `high` returns no REGRESSION against the BVH trace.
