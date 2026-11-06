# PRD-828 — JS keeps only game logic: engine work moves into C++

**Status:** NOT STARTED
**Priority:** P1 — on the stress lab about 30% of the busy main thread is JS (2026-11-02 profile). The animation tick (about 2.2 ms a frame) and the per-pass uniform sync have no owning PRD. Every box below is open.
**Complexity:** 8 (HIGH) — 11+ implementation files (3), crosses the C++/Wasm ABI and the JS package release boundary (+2), animation listener and wrapper lifetime state (+2), new ABI exports on web and native (+1 compatibility). Risk override: none.
**Owner:** João
**Depends on:** PRD-770 (the fair window, `pnpm stress:loop fair`) and PRD-771 (the stage meter). Both tools ship. Coordinates with PRD-772 (C++ skeleton update and GPU joints), PRD-765 (bulk physics interpolation), PRD-768 (uniform scan scope), PRD-773 and PRD-774 (C++ plan). None of their scope moves here.

## Context

Owner, 2026-11-03: "whatever you can move to C++/gpu you move, reduce js<>wasm bridge crossings".
Owner, 2026-11-06: move code execution out of JS into C++ so that as little as possible runs in JS, for significant performance gains. Measure it on the stress benchmark against three.js, and use the benchmark artifacts to pick what moves.

### What one crossing costs

- A **facade crossing** (`browser-backend.ts` `invoke`: alloc, `toEngine`, `wrap`, `countCall`) costs about 0.8 µs. `Color.lerp` measured 796-939 ms per 1 M calls, against 4 ms in three.js (PRD-742).
- A **direct Emscripten export** (`module._tnw_web_frame(n)`) costs tens of nanoseconds.
- Rule of this PRD: **one crossing does the work of many objects.** That is a typed-array span, a whole loop in C++, or a GPU pass. Tiny per-call math stays in JS (PRD-742).

### Evidence 1: the stress-lab CPU profile (measured)

Artifact: `~/.cache/tmp-tn/stress-loop/hunt/js1102.cpuprofile` and `js1102.json`, 2026-11-02, `?stress`, 15 s, 1,013 frames at 67.5 fps. Main thread busy 14.6 s, so 1% of samples is about 0.144 ms a frame. Report: frame p50 14.09 ms, update p50 2.16 ms, 734 crossings p50, 2,304 KB GPU upload p50. Counts: 4,000 trees, 6,000 rocks, 120 houses, 600 props, 120 crowd, 300 bodies, 18,000 particles, 16 lights. Self time by owner: Wasm 52.8%, facade `web-engine-runtime.js` 14.9%, `core` 9.2%, Emscripten glue 2.8%, three math about 2%.

Clues ranked by JS time that a move removes:

| # | Clue (inclusive share, ms a frame) | Call chain in the profile | Where it lives | Owner |
| --- | --- | --- | --- | --- |
| P1 | Animation tick 8.1% (1.17 ms) | `Stress.ts:384` → anim `update` → `#evaluate` 3.5%, `#syncStride` 3.1%, both mostly facade `value`→`invoke` | `packages/core/src/animation.ts:1180-1267,922-988,1498` | **this PRD** |
| P2 | Animation rate bands 7.0% (1.01 ms) | `onRender` → `prepareAnimation` → `#visitAnimation` → `#observeAnimation` (3.3% self JS) | `packages/core/src/render-camera-cull.ts:408-448,622-720` | **this PRD** |
| P3 | Facade value-class crossings 12.4% (1.79 ms), across P1, P5 and P6 | `value` → `invoke` 9.4% | `packages/three-native/src/browser-backend.ts` | PRD-742 for the classes; the loops that call them move here |
| P4 | WebGPU calls from Wasm into JS 10.2% (1.47 ms) | `wasm-to-js` → `writeBuffer` 4.2%, `beginRenderPass` 1.9%, `createCommandEncoder`, `submit`, `executeBundles` | the C++ renderer's per-call `wgpu*` use | **this PRD** (coalesce) |
| P5 | Uniform sync 4.6% (0.66 ms), once per nested render and per compute | `Renderer` → `sync` (3.0%), `compute` → `sync` (1.4%), under core `updateBefore` pass renders (6.0%) | `packages/three-native/src/tsl-uniforms.ts:223-296,430-460` | **this PRD** (write once a frame); PRD-768 keeps the scan scope |
| P6 | Compute-driven systems 5.9% (0.85 ms) | `processRender` → `process` → `compute` 3.1%, `Box3.applyMatrix4` 0.8%, `multiplyMatrices` 0.4% | `packages/core/src/fluid-particles.ts:1181-1215`, `particles.ts:477-582` | **this PRD** |
| P7 | Physics interpolation apply 3.3% (0.48 ms) | `onRender` → `apply` → `value` | `packages/core/src/game-frame-loop.ts` interpolation | PRD-765 |

PRD-771's stage split agrees (2026-10-30, 14.7 ms frame): jsBefore 2.65, update 2.26, engineJs 0.81 (735 host calls), residual 0.41. That is about 6 ms of JS.

### Evidence 2: code survey and scouts (counted from code, not measured)

Three Sonnet surveys and four DeepSeek v4.1 flash max scouts read the code on 2026-11-06. Their reports are in `~/.cache/tmp-tn/prd828/out/{A,B,C,D}.md`. Findings that match a profile clue join the phases below. The scout briefs are DeepSeek output: each one needs a full code review before it is implemented.

- Scout B confirms P1. A starter rig with 6 clips pays about 52 ABI calls a frame, and a crowd rig pays 2 (`animation.ts:1180-1267`). The C++ mixer already owns actions, weights and time scales (`packages/runtime-native/src/engine/animation/mixer.cpp:317,352,850`).
- Scout D confirms P6. A fluid step issues 25 `renderer.compute()` calls, and each opens its own compute pass (`compute.cpp:126-135`).
- Down-ranked: the 55 `_tnw_web_frame` telemetry reads (`browser-renderer.ts:650-760`) are direct exports, about 3 µs a frame. They are not a lever.

## Benchmark: the stress lab against three.js

Every lever is kept or rejected on the stress benchmark that exists. This PRD adds no new meter.

- **Scene:** `sandbox/stress-lab` (`main.html?stress`). `?load=N` scales density.
- **Arms:** `threenative-wasm` (the default owned engine) against `three-vanilla` (the same scene in plain three.js). `threenative-threejs` (the `engine: "threejs"` override) is an optional third arm.
- **Tool:** `pnpm stress:loop fair threenative-wasm=<url>?stress&arm=<label> three-vanilla=<url>?stress&arm=vanilla --passes vsync,uncapped --tag prd828-<lever>`. It runs ABBA in one clean browser at 1280x720, DPR 1, 80 s per run, on a quiet host. It records rows in `docs/stress-loop/ledger.json`, and `pnpm dashboard` shows them on its Stress lab tab.
- **Metrics per row:** `frameP50Ms`, `frameP95Ms` (CPU), `updateP50Ms`, `presentedP95Ms`, `fps`, `bridgeCrossingsP50`, `hostCallsP50`, `gpuUploadKbP50`, and the PRD-771 stages from `TN_FRAME_BUDGET` (`jsBefore`, `update`, `engineJs`, `residual`). The vanilla arm has no crossings. Compare it on frame, update, presented time and fps.
- **Attribution:** each lever also takes one CPU profile through the hunt lane (`measure.sh`, a `--profiling-funcs` Wasm build), compared with `js1102.cpuprofile` on the P1-P7 chains.
- **Last rows before this PRD** (2026-11-03, uncapped, RTX 2080):

| Row | Arm | frame p50 / p95 ms | update p50 ms | fps | crossings p50 |
| --- | --- | --- | --- | --- | --- |
| #285 | threenative-wasm (core@0.3.8) | 14.63 / 21.09 | 2.95 | 63.1 | 732 |
| #286 | three-vanilla (three@0.185.1) | 19.95 / 27.60 | 2.95 | 48.3 | n/a |

  These rows predate later develop commits, so Phase 1 takes a fresh baseline at the start commit.
- **Keep rule:** keep a lever only when its paired window shows a CPU frame p50 drop above run noise, with frame p95 no more than 5% worse and no new `TN_BRIDGE_WARNING`. Record it with `--decision keep` or `--decision reject`.
- **Gap:** the vanilla arm folder (`sandbox/stress-lab-vanilla`, port 5736 in PRD-770) is no longer on disk and was never tracked in git. Phase 1 rebuilds it.

## Solution

```mermaid
flowchart LR
  G[Game JS: rules and callbacks] -->|one call per system per frame| F[three-native facade]
  F -->|typed-array spans| C[C++ engine: animation tick, rate bands, uniforms, particle bounds]
  C -->|coalesced queue writes, fewer passes| W[WebGPU]
  F -.->|small value math stays in JS, PRD-742| F
```

1. **Measure first.** Rebuild the vanilla arm, take the baseline, and run the `TN_BRIDGE_CENSUS` census (`__THREENATIVE_ENGINE_COST__`) plus one profile at the start commit. Confirm P1-P7 still hold.
2. **The animation tick moves into C++** (P1, P2, scout B F1-F3).
   - JS keeps the clip-name to id map and the blend-space choice.
   - One `_tnw_anim_tick_batch` call per frame carries, per rig: clip ids, target weights, transition time, moved metres and dt. C++ runs the weight ramp, the stride rate and `AnimationMixer::update`, and returns one status word per rig (`finished`, `changed`).
   - The screen-size rate bands (`#observeAnimation`) are computed in C++ from engine bounds in the same call.
   - JS fires `finished` and `loop` listeners from the status words, in rig order.
3. **Render-side JS crosses once** (P4, P5, P6).
   - Changed uniforms are written once a frame as one span (`tn_tsl_set_uniforms(ctx, ids, laneCounts, lanes, n)`). Nested pass renders and compute dispatches do not run the sync again.
   - Compute-driven systems fold their bounds in C++, and the C++ `ComputeQueue` records consecutive dispatches into one compute pass (`compute.cpp:443-458`).
   - The C++ renderer coalesces queue writes into one staging upload a frame where the WebGPU spec allows it, which cuts the `wasm-to-js` `writeBuffer` calls.

Each new ABI call ships on the web Wasm engine and the native V8 host in the same commit (CHARTER: web-only is unfinished). The JS paths stay only behind the named `engine: "threejs"` override.

Risks: animation listener order and the loop-seam time adjustment (`animation.ts:1470-1493`); monkey-patched action methods (`animation-packet-state.ts`); stride overrides that must keep reporting `overridden`; user `onRenderUpdate` callbacks that must still run before the uniform flush; a queued readback that must end a compute pass; and pixels, which need a visual judge for every render-side change.

## Acceptance Criteria

- [ ] AC-1 [local]: On the stress lab, the JS stages (`jsBefore` + `update` + `engineJs` + `residual`) drop by at least 2 ms p50 against the Phase 1 baseline, and `bridgeCrossingsP50` drops by at least 50%. proof: `pnpm stress:loop fair` window, ledger rows — Evidence: pending.
- [ ] AC-2 [local]: In the same window, the `threenative-wasm` CPU frame p50 and p95 stay below `three-vanilla`, `presentedP95Ms` is no worse than the baseline, and a fresh visual judge reads NEUTRAL or IMPROVEMENT on the stress-lab pose. proof: ledger rows plus the judge verdict — Evidence: pending.

The AC-1 bars are proposed. P1 + P2 + P5 + P6 sum to about 3.7 ms of measured JS, so 2 ms leaves room for the parts that must stay in JS. Phase 1 confirms the bars against the fresh census, and any change to a bar goes under `## Decisions` with its reason.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Batched animation tick | Game `playWeighted`/`play` → `animation.ts` player update in `game-frame-loop.ts` → `_tnw_anim_tick_batch` | Per-rig `setEffectiveWeight`, `isScheduled`, `getWorldPosition`, `mixer.update` calls kept only under `engine: "threejs"` | Phase 2 |
| C++ rate bands | `render-camera-cull.ts` `prepareAnimation` → same batch call | `#visitAnimation` / `#observeAnimation` JS walk under `engine: "threejs"` only | Phase 2 |
| One uniform write a frame | `uniform().onRenderUpdate` → `tsl-uniforms.ts` sync → `tn_tsl_set_uniforms` | Per-uniform `tn_tsl_set_uniform` kept for one-off sets | Phase 3 |
| Batched compute and bounds | `computeDriven.processRender` → `renderer.compute([...])` → `ComputeQueue::flush` | One pass per kernel removed | Phase 3 |
| Coalesced queue writes | C++ renderer upload path → `wgpuQueueWriteBuffer` | Per-buffer writes merged where the buffers allow it | Phase 3 |

## Execution Phases

#### Phase 1: The benchmark and the census
**Status:** NOT STARTED
**Files:** `sandbox/stress-lab-vanilla/` (rebuilt, untracked like the other sandboxes), this PRD's tables.
**Implementation:** Rebuild the vanilla three.js arm of `sandbox/stress-lab`. It reads the same `?load=N` layer list as `src/scenes/Stress.ts:77`. Take the baseline window, one census frame and one profile at the start commit.
- [ ] The vanilla arm renders the same layers and counts as the Wasm arm, and the fair tool accepts both arms. proof: `pnpm stress:loop fair` window with both arms valid and no "not comparable" mark.
- [ ] The baseline (vsync and uncapped passes), the census (top 10 crossing classes with callers and counts per frame) and the P1-P7 shares from a fresh profile are recorded in this PRD. proof: ledger row ids, `TN_BRIDGE_CENSUS` output, profile path.

#### Phase 2: The animation tick runs in C++
**Status:** NOT STARTED
**Files:** `packages/core/src/animation.ts`, `render-camera-cull.ts`, `packages/runtime-native/src/engine/animation/mixer.{h,cpp}`, `packages/runtime-native/src/engine/abi/bindings_scene.cpp` (web and native exports), `packages/three-native/src/browser-backend.ts` (the binding).
**Implementation:** As in Solution 2. The existing stride report (`animation.ts:800-820`) is the parity oracle for stride rates.
- [ ] One call per frame advances every rig: weights, stride rate and the mixer step. Per-rig animation crossings fall to 0, and the poses match the JS path on a fixed seed. proof: core spec red-green plus a playtest scenario with an `engineCost` bound on the stress crowd.
- [ ] The rate bands come from C++ in the same call, and `#observeAnimation` is gone from the stress-lab profile. proof: stress-lab profile plus the paired stress window, ledger rows.

#### Phase 3: Render-side JS crosses once a frame
**Status:** NOT STARTED
**Files:** `packages/three-native/src/tsl-uniforms.ts`, `browser-renderer.ts`, `packages/runtime-native/src/engine/abi/abi.cpp`, `packages/runtime-native/src/engine/renderer/compute.cpp`, the C++ upload path, `packages/core/src/fluid-particles.ts`, `particles.ts`.
**Implementation:** As in Solution 3. Each lever is one commit with its red-green spec and its paired stress window.
- [ ] Changed uniforms cross in one span a frame, and nested pass renders do not sync again. proof: `packages/three-native/__tests__/` spec red-green plus a census count.
- [ ] Consecutive compute dispatches share one compute pass, and compute-driven bounds fold in C++. proof: native engine test plus a census `compute` row on `examples/spell-lab/playtests/inferno.playtest.json`.
- [ ] Queue writes coalesce, and the `wasm-to-js` `writeBuffer` share drops in the stress-lab profile with the same `gpuUploadKbP50`. proof: stress-lab profile plus the paired stress window, ledger rows.

## Follow-up candidates (not in this PRD's scope)

These findings are real but are not on the stress-lab frame, or they are a different lane. File each group as its own PRD, with its own benchmark scene, when this PRD's Phase 1 census is in.

1. **Facade bulk paths:** element setters (`setMatrixAt`, `setXYZ`) write the JS shadow and flush once (`browser-backend.ts:733-743,944-980`). Bind the C++ instanced and model LOD (`instanced-batch-lod.ts:187-250` → `instanced_batch.cpp`, `model_lod.cpp`). Other items: `children` cache misses, the `shadow-node.ts:51-86` walk, movers in `virtual-shadow.ts:1029-1110` and `static-transform.ts:243`, and the per-mesh `__tnVisibleInWorld`.
2. **Native V8 host (scout A):** the audio pose push per voice per tick (`audio.ts:499-563`), the frame recorder diff (`frame-op-stream.js`), the held-key poll, cached V8 names, and a clock slot instead of `__tnWallMs`.
3. **Kit patterns and lint (scout C):** instance spans for the rts, tower-defense and shooter kits, the camera obstruction raycast through the C++ raycaster, terrain `sampleMany`, dirty-key state publishing, and lint rules for `getObjectByName`, material writes and per-texel loops in hot code.
4. **VFX (scout D):** the `ReactionField` decay on the GPU (393k cells a frame), the idle skip for the spell world pack, and the `GroundField` probe readback gate.
5. **Load-time bakes:** the kit sky bakes (2.1 M texels in collectathon, 7.7 s in Hop Garden), the `noiseVolume` bake, and the Strata per-texel and per-vertex loops.
6. **Animation extras (scout B):** root motion and composition through the same tick call, and batched Detour crowd reads.

## Decisions

- 2026-11-06 (Claude, from code): the 55 `_tnw_web_frame` telemetry reads are not a lever. They are direct exports at about 3 µs a frame in total, and the survey had ranked them first.
- 2026-11-06 (owner): the stress lab against three.js is this PRD's benchmark, and the benchmark artifacts pick what moves.
- 2026-11-06 (Claude, from the profile): this PRD keeps the measured stress-lab clues (P1, P2, P4, P5, P6) and lists the rest as follow-ups, to stay within the 3-phase, about-8-box cap. PRD-772 covers only the C++ skeleton update and GPU joints, so the JS animation policy belongs here.
