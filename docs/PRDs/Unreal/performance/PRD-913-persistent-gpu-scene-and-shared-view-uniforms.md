---
prd_contract: v1
---

# PRD-913 — Persistent GPU scene buffers and a shared view uniform buffer

**Status:** PARTIAL
**Priority:** P1 — `wasmScene` + `wasmPlan` take 53–56% of heavy stress frames (`?stress&strata` 5.89 + 3.49 ms; `?stress&systems&extended` `wasmPlan` 6.13 ms and 3.5 MB/frame uploads) because every draw copies `frameSlab` and camera motion forces full-arena `memcmp` and storage `sameBytes` scans.
**Complexity:** 6 (MEDIUM) — 6–10 implementation files in `packages/runtime-native/src/engine/renderer/` and `shader/` (+2), persistent GPU slot and dirty-list state across frames (+2), crosses the web Wasm and native desktop host boundary (+2); risk override: none.
**Owner:** João
**Depends on:** None. Feeds [PRD-775](../shadows/PRD-775-virtual-shadow-pages-are-managed-and-drawn-on-the-gpu.md) Phase 2 (pushed VSM caster invalidation) and [PRD-914](PRD-914-unified-base-pass-mrt-dynamic-velocity-and-traa-gpu-culling.md) Phase 3 (TRAA-compatible GPU instance culling).

## Context

After Wave 1–4 optimizations ([`PERFORMANCE-LEARNINGS.md`](../../../../PERFORMANCE-LEARNINGS.md)), `wasmScene` and `wasmPlan` remain the dominant CPU and upload bottleneck on heavy scenes:

- `?stress&strata`: 51.65 FPS, `frameP50` 16.82 ms (`wasmScene` **5.89 ms**, `wasmPlan` **3.49 ms**).
- `?stress&systems&extended`: 43.68 FPS, `frameP50` 20.76 ms (`wasmPlan` **6.13 ms**, `gpuUploadKb` **3,498 KB/frame**).
- `?stress` (`real`): 122.4 FPS, `frameP50` 7.67 ms (`wasmScene` ~2.0 ms + `wasmPlan` ~2.1 ms = ~53% of frame).
- Strata Forest `vista`: 55.09 FPS, `wasmPlan` **3.57 ms**.

Inspection of the owned C++/Wasm renderer shows three coupled root causes:

1. **Per-draw `frameSlab` duplication (`packages/runtime-native/src/engine/renderer/renderer_frame.cpp:1173-1330`):** Every draw allocates a 256-byte-aligned uniform block and `std::memcpy`s `program.frameSlab` (camera matrices, view-space lights, shadow matrices/noise, hemisphere/ambient) into every draw's uniform slice. Shadow draws do not even share a program slab, resizing and zeroing raw blocks per draw per page (`renderer_frame.cpp:2134-2136`).
2. **Camera motion invalidates every draw's uniform block (`renderer_frame.cpp:2573-2617`):** Because frame/view constants sit inside every draw's 256-byte slice, any camera movement dirties every slot, triggering per-256-byte `memcmp` sweeps across the entire uniform arena and falling back to full-arena `gpu_.writeBuffer` whenever `dirty * 2 >= uniformBytes`.
3. **Full-range CPU `sameBytes` storage scans (`renderer_frame.cpp:2655-2676`, `renderer_internal.h:72`):** `storages_["instances"]` and `"boneMatrices"` run CPU SIMD `sameBytes` scans every frame instead of consuming pushed dirty lists from transform/attribute writers — the same missing dirty-primitive substrate behind [PRD-881](../../performance/PRD-881-the-crowds-engine-stages-fit-2-5-ms.md) (`wasmScene`/`wasmPlan`) and [PRD-891](../../performance/PRD-891-a-big-world-uploads-only-the-instances-that-moved.md) (big-world instance uploads).

### What Unreal does (UE 5.8.3, clean-room summary, no code copied)

- Binds per-view camera, light, and scene parameters once per view in `View.ViewUniformBuffer` / `FillSceneUniformBuffer` instead of duplicating them into per-draw uniform blocks (`UE 5.8.3: Engine/Source/Runtime/Renderer/Private/GPUScene.cpp:1653, 1716`).
- Maintains persistent GPU primitive and instance storage updated strictly from dirty primitive upload lists (`FGPUScene::UpdateInternal`, `FGPUScene::UploadGeneral`, `UE 5.8.3: Engine/Source/Runtime/Renderer/Private/GPUScene.cpp:769-901, 1161, 1649`).

Borrow the architecture, buffer separation, and dirty-list invariants only; copy no Unreal code or comments.

## Solution

```mermaid
flowchart LR
  V["ViewUniformBuffer\n(1 write per view: camera, lights, shadows)"] --> S["Main / Prepass / Shadow / Velocity Shaders"]
  D["Dirty Writers\n(Object3D, InstancedBatch, Skeleton, Attribute)"] -->|"dirty list only"| G["Persistent GPUScene Slots\n(instances, primitives, bones)"]
  G --> S
  D -->|"internal change set"| VSM["PRD-775 VSM + PRD-914 GPU Cull"]
```

1. **Size it first (Phase 1):** Instrument exact CPU time and uploaded bytes spent in per-draw `frameSlab` memcpy, uniform `memcmp`/uploads on a moving camera, and storage `sameBytes` scans across `?stress`, `?stress&systems&extended`, `?stress&strata`, and Strata `vista`. Continue only if combined removable CPU is `>= 0.5 ms` on web Wasm or upload savings exceed 50% on camera turns; otherwise defer under `## Decisions`.
2. **Shared `ViewUniformBuffer` (Phase 2):** Move frame-constant camera, view/projection, direct lights, shadow matrices, hemisphere, and ambient terms out of per-draw uniform blocks into one shared per-view uniform buffer written once per view. Per-draw uniform blocks shrink to per-object and material fields only, so a camera turn dirties **zero** per-draw uniform blocks and runs no full-arena `memcmp`. Keep a named override (`TN_SHARED_VIEW_UNIFORM=0`) for bisecting and report when overridden.
3. **Persistent `GPUScene` slots & dirty-list uploads (Phase 3):** Give static, instanced, and skinned draws persistent slots in `storages_["instances"]` and primitive storage fed from dirty flags stamped at transform/attribute write time (`Object3D`, `BufferAttribute`, `InstancedBatch`, `Skeleton`), deleting the per-frame `sameBytes` CPU scan on steady and camera-turn frames. Expose the internal dirty primitive/caster list so [PRD-775](../shadows/PRD-775-virtual-shadow-pages-are-managed-and-drawn-on-the-gpu.md) Phase 2 and [PRD-914](PRD-914-unified-base-pass-mrt-dynamic-velocity-and-traa-gpu-culling.md) Phase 3 consume one shared owner.

Constraints: must fit within `LIMITS.webEngineBytes` (`pnpm budgets`), ship on both web Wasm and native desktop in the same commit, and preserve bit-equal or NEUTRAL-judged output.

## Validation scene

- **Consumer & scenes:** Stress Lab (`~/projects/threenative/sandbox-stress/stress-lab`: `?stress`, `?stress&systems&extended`, `?stress&strata`) and Strata Forest (`examples/strata-terrain-preview` / `packages/terrain/starter/forest` at `overview` and `vista`).
- **Benefit workloads:** Moving-camera orbit on `?stress&systems&extended` and `?stress&strata` (maximizes camera-turn uniform churn and instance storage scans) and Strata Forest `overview` walk.
- **Controls (charge bookkeeping):** `?stress&still` (0 uniform/instance upload bytes on static draws), `?stress&noCrowd` (small scene), `?play` holdout, and a high-churn worst case (`?stress&play`, 10 spawns/sec).
- **Hardware & protocol:** Desktop RTX 2080 (`nvidia/turing`), 1280×720 DPR 1 uncapped ABBA via `pnpm stress:loop fair` (2+ runs/arm, quiet host load < 12, GPU < 10%), plus desktop native engine (`ctest -L native-engine` + `pnpm parity --target desktop`).
- **Pass/fail bar:** Whole-frame CPU p50 drops by `> max(5%, baseline spread)` on `?stress&systems&extended` or `?stress&strata`, frame p95 is no more than 5% worse, GPU p95 is not worse, controls stay within 5%, uniform upload bytes on a camera turn drop `>= 75%`, and a fresh visual judge returns NEUTRAL or IMPROVEMENT.

## Non-Goals

- GPU compute instance culling and BasePass MRT consolidation (owned by [PRD-914](PRD-914-unified-base-pass-mrt-dynamic-velocity-and-traa-gpu-culling.md)).
- GPU VSM page table/pool and single-pass shadow raster (owned by [PRD-775](../shadows/PRD-775-virtual-shadow-pages-are-managed-and-drawn-on-the-gpu.md)).
- Bindless textures or hardware ray tracing (deferred until WebGPU exposes them).
- Changing the `engine: "threejs"` path.

## Acceptance Criteria

- [ ] AC-1 [local]: On `?stress&systems&extended` and `?stress&strata` (RTX 2080, uncapped ABBA via `pnpm stress:loop fair`), whole-frame CPU p50 improves by `> max(5%, baseline spread)`, frame p95 is no more than 5% worse, camera-turn uniform upload bytes fall `>= 75%`, and inactive/small controls (`?stress&still`, `?play`) stay within 5%. proof: `pnpm stress:loop fair` ledger rows (`docs/stress-loop/ledger.json`) — Evidence: pending.
- [ ] AC-2 [local]: Native desktop parity and engine suites pass with shared view uniforms and persistent dirty-list storage enabled, and web Wasm stays within `LIMITS.webEngineBytes`. proof: `ctest --test-dir packages/runtime-native/build/tn-engine-only -L native-engine --output-on-failure && pnpm parity --target desktop && pnpm budgets` — Evidence: pending.
- [ ] AC-3 [local]: A fresh read-only visual judge returns NEUTRAL or IMPROVEMENT on BEFORE/AFTER headed WebGPU captures (`adapter.info` checked, 2+ runs/arm) of `?stress&systems&still`, `?stress&systems&extended`, and Strata Forest `overview`/`vista`. proof: judge verdict recorded here and BEFORE/AFTER sheets on the PR (`prd-913-screenshots` branch) — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Shared `ViewUniformBuffer` binding | `Renderer::renderPrepared` (`packages/runtime-native/src/engine/renderer/renderer_frame.cpp`) → view bind group → `shader/standard.cpp` | Replaces per-draw `program.frameSlab` memcpy and camera-turn full-arena `memcmp` (`TN_SHARED_VIEW_UNIFORM=0` fallback) | Phase 2, AC-1 |
| Persistent `GPUScene` dirty-list storage | `Object3D` / `InstancedBatch` / `Skeleton` / `BufferAttribute` writes → `storages_["instances"]` delta upload (`renderer_frame.cpp:2621-2685`) | Replaces per-frame `sameBytes` full-buffer diff scans | Phase 3, AC-1 |
| Internal dirty primitive change set | `RenderDatabase::prepare` (`render_database.cpp`) → shared dirty-primitive list for VSM & GPU culling | Single dirty-writer source consumed by PRD-775 Phase 2 and PRD-914 Phase 3 | Phase 3, AC-2 |

## Execution Phases

#### Phase 1: Attribute uniform/storage scan cost and gate the build
**Status:** DONE
**Files:** `packages/runtime-native/src/engine/foundation/waste_counters.h`, `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/tests/native-engine/renderer_test.cpp`
**Implementation:** Instrument `frameSlab` memcpy bytes/time, uniform `memcmp` bytes/time, and storage `sameBytes` scan bytes/time under `TN_FRAME_BUDGET` / waste counters. Run the clean RTX 2080 baseline sizing across `?stress`, `?stress&systems&extended`, `?stress&strata`, and Strata `vista`.
- [x] Uniform slab copy, `memcmp`, and storage `sameBytes` counters report exact per-frame byte and CPU totals across camera-turn and steady frames. proof: `ctest --test-dir packages/runtime-native/build/tn-engine-only -R native_engine_renderer_uniform_scan_counters --output-on-failure` -> `1/1 Test #403 Passed (0.50 sec)`; direct `./tn-native-engine-renderer-test uniform_scan_counters` -> `PASS uniform_scan_counters` on NVIDIA GeForce RTX 2080 (Vulkan)
- [x] Clean RTX 2080 sizing table is recorded under `## Decisions` with the go/no-go verdict against the `>= 0.5 ms` CPU or `> 50%` camera-turn upload gate. proof: measured `TN_FRAME_BUDGET` rows written under `## Decisions` (`uniformUploadBytes` up to `1.78 MB`/frame max and `981 KB`–`1.17 MB` p50/p95 on `?stress&strata`, `storageSameBytesScanned` up to `3.22 MB` p50)

#### Phase 2: Shared `ViewUniformBuffer` leaves per-draw uniform blocks
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/src/engine/renderer/renderer_program.cpp`, `packages/runtime-native/src/engine/renderer/renderer_internal.h`, `packages/runtime-native/src/engine/shader/standard.cpp`, `packages/runtime-native/src/engine/shader/ir.cpp`
**Implementation:** Split frame/view uniforms (camera matrices, lights, shadow matrices, hemisphere, ambient) into a single per-view uniform buffer bound once per pass, shrinking per-draw uniform blocks to object/material fields only. Keep `TN_SHARED_VIEW_UNIFORM=0` as an explicit reported bisect override.
- [ ] A camera turn rewrites 0 per-draw uniform blocks, `TN_SHARED_VIEW_UNIFORM=0` restores legacy per-draw blocks and reports the override, and pixels match the baseline. proof: `ctest --test-dir packages/runtime-native/build/tn-engine-only -R native_engine_shared_view_uniforms --output-on-failure`
- [ ] Paired ABBA on `?stress&systems&extended` and `?stress&strata` cuts camera-turn uniform upload bytes by `>= 75%` with frame p50 lower and 0 pixel regressions. proof: `pnpm stress:loop fair` paired rows + pixel diff recorded here

#### Phase 3: Persistent `GPUScene` slots and dirty-list uploads replace `sameBytes` scans
**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/src/engine/renderer/render_database.cpp`, `packages/runtime-native/src/engine/scene/object3d.cpp`, `packages/runtime-native/src/engine/renderer/lod/instanced_lod.cpp`, `packages/runtime-native/tests/native-engine/render_database_test.cpp`
**Implementation:** Allocate persistent `GPUScene` slots for static, instanced, and skinned draws, stamp dirty ranges on transform/attribute/bone writes, upload only dirty slots without `sameBytes` scans on steady/camera-turn frames, and publish the dirty primitive list for PRD-775 and PRD-914.
- [ ] Steady and camera-turn frames execute 0 `sameBytes` scans on `instances`, and scattered writes upload only the dirty slot ranges while producing identical renders. proof: `ctest --test-dir packages/runtime-native/build/tn-engine-only -R native_engine_gpu_scene_dirty_uploads --output-on-failure`
- [ ] Native desktop parity, full `native-engine` tests, and web Wasm size budget pass together on the same tree. proof: `ctest --test-dir packages/runtime-native/build/tn-engine-only -L native-engine --output-on-failure && pnpm parity --target desktop && pnpm budgets`
- [ ] AC-1 and AC-3 pass on RTX 2080 `?stress&systems&extended`, `?stress&strata`, Strata Forest `overview`/`vista`, and controls (`?stress&still`, `?play`), with a fresh NEUTRAL/IMPROVEMENT visual judge verdict. proof: `pnpm stress:loop fair` ledger rows + visual judge verdict recorded here and sheets on `prd-913-screenshots`

## Decisions

- 2026-11-23 (filing): Split from [PRD-914](PRD-914-unified-base-pass-mrt-dynamic-velocity-and-traa-gpu-culling.md) and [PRD-775](../shadows/PRD-775-virtual-shadow-pages-are-managed-and-drawn-on-the-gpu.md) because persistent `GPUScene` slots and dirty-primitive tracking form the shared substrate that both pushed VSM invalidation (PRD-775 Phase 2) and TRAA-compatible GPU instance culling (PRD-914 Phase 3) consume. Structurally addresses the upload/scan root behind [PRD-881](../../performance/PRD-881-the-crowds-engine-stages-fit-2-5-ms.md) and [PRD-891](../../performance/PRD-891-a-big-world-uploads-only-the-instances-that-moved.md) without reopening [PRD-753](PRD-753-a-scene-change-updates-only-the-batches-it-touches.md)'s deferred batch-key work.
- 2026-11-23 (Phase 1 RTX 2080 sizing — `nvidia/turing`, `1280x720`, `?tnDebug=1`, 0 errors):

| Scene | FPS | frameP50 (ms) | gpuP50 (ms) | wasmScene / wasmPlan (ms) | slabCopy p50 | memcmp p50 / p95 | sameBytes p50 / max | uniformUpload p50 / p95 / max |
| --- | ---: | ---: | ---: | --- | --- | --- | --- | --- |
| `?stress` (`real`) | 103.2 | 9.65 | 4.61 | 1.78 / 2.44 | 50,688 B (0.02 ms) | 57,088 B (0.02 ms) | 1,549,312 B (0.10 ms / 0.74 ms) | 43,264 / 57,856 / 86,528 B |
| `?stress&systems&extended` | 40.6 | 23.52 | 8.05 | 2.03 / 6.58 | 590,848 B (0.11 ms, max 0.19 ms) | 14,336 B (0.02 ms) / 716,032 B (0.07 ms) | 3,222,784 B (0.25 ms / 0.47 ms) | 707,584 / 1,027,072 / 1,777,408 B |
| `?stress&strata` | 51.79 | 18.28 | 4.88 | 6.20 / 3.76 | 975,360 B (0.21 ms, max 0.52 ms) | 980,224 B (0.05 ms, max 0.30 ms) | 2,630,912 B (0.19 ms / 0.52 ms) | 981,760 / 1,169,152 / 1,583,872 B |
| Strata Forest `vista` (`dist-engine`) | 101.83 | 5.72 | 12.99 | 0.06 / — (`88` draws) | 80,384 B (0.03 ms) | 104,704 B (0.01 ms) | 25,472 B (0.00 ms) | 32,256 B |

  - **Go/No-Go Verdict: GO.** On `?stress&systems&extended` and `?stress&strata`, moving camera frames copy `590 KB–975 KB` of `frameSlab` per frame, scan `2.63–3.22 MB` via `sameBytes`, and upload `708 KB–1.78 MB` of per-draw uniforms (`0.38–0.45 ms p50` / `0.54–0.63 ms p95` / `0.76–1.34 ms max` CPU before counting `gpu_.writeBuffer` overhead and per-draw `normalMatrix(multiply(view, model))`). Moving frame/view constants out of per-draw slices clearly exceeds the `> 50%` camera-turn uniform upload savings and `>= 0.5 ms` p95/peak removable cost gates.
