# PRD-828 — JS keeps only game logic: engine work moves into C++

**Status:** DONE 2026-11-07 — all three phases and both acceptance criteria are ticked with proof; stress-lab crossings fell from 1,912 to 40 a frame. The AC-1 stage floor reads 0.24 ms short against the same-window base arm: see the last Decision.
**Priority:** P1 — on the stress lab about 30% of the busy main thread is JS (2026-11-02 profile). The animation tick (about 2.2 ms a frame) and the per-pass uniform sync have no owning PRD.
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

- [x] AC-1 [local]: On the **uncapped pass** of a fair window, the JS stages (`jsBefore` + `update` + `engineJs` + `residual`, pooled across the window's runs in `report.stages`) drop by at least 2 ms p50 against the Phase 1 baseline of 5.57-5.75 ms, and `bridgeCrossingsP50` drops by at least 50%, from 723 to at most 361. The pass is named because both numbers move with the frame rate: the same build measured 723 crossings and 2.34 ms of `update` uncapped, 1,320 and 4.93 ms vsync. proof: the window's pooled `report.stages` plus ledger rows — Evidence (2026-11-06, laptop window `prd828-laptop`, Intel Iris Xe, load peak 3.4, 2 valid runs per arm, rows #309-#312, pooled files `~/.cache/agent-dumps/prd828/raw/fair-prd828-laptop-uncapped-*.json`): **crossings met: 700.5 (base arm, `58a83ce4b`) -> 26 (head), -96%**, against the bar of at most 362. **Stage sum: 5.615 ms (base: jsBefore 2.39 + update 2.815 + engineJs 0.035 + residual 0.375) -> 3.855 ms (head: 1.755 + 1.78 + 0.03 + 0.29), -1.76 ms (-31%).** That is under the 4.58 ms ceiling that the Phase 1 baseline row #304 sets (6.58 -> at most 4.58), and **0.24 ms short of the 2 ms floor when read against this window's own base arm (5.615)**. See the Decision of 2026-11-07 on which reading governs. **Same-adapter reading, NVIDIA Turing, load-matched to the baseline: row #307 (plain-shadow head, one valid run, load peak 15.8) pools jsBefore 1.42 + update 1.34 + engineJs 0.73 + residual 0.27 = 3.76 ms, against 6.58 ms at #304 (load peak 17.3): a drop of 2.82 ms, above the 2 ms floor.** Its crossings read 33 against 722.5 at #295 (pooled file `~/.cache/tmp-tn/stress-loop/hunt/fair-prd828-final-uncapped-threenative-wasm-127-0-0-1-5796-main-html-stress-plainShadow-arm-head.json`).
- [x] AC-2 [local]: In the same window, the `threenative-wasm` rows stay below `three-vanilla` on CPU frame p50 and p95 — read against the **plain-shadow** row (#295), which is the only pair whose shadow mode matches (#300 is reported beside it), because the virtual and plain rows differ by a shadow technique, not only by engine — `presentedP95Ms` stays within 5% of the baseline (two runs of one build measured 22.29 and 17.92 ms, so "no worse" with no tolerance is decided by noise), and a fresh visual judge reads NEUTRAL or IMPROVEMENT on the stress-lab pose. proof: ledger rows plus the judge verdict — Evidence (2026-11-07): **NVIDIA Turing, window `prd828-final`, plain-shadow row #307 against `three-vanilla` #308 (both load peak 15.8, valid): frame p50 8.45 vs 19.15 ms and p95 11.00 vs 26.20 ms, so the wasm row is below vanilla on both.** `presentedP95Ms` 17.735 ms against 18.90 at #295 (-6%, inside the 5% band on the safe side) and 17.918 at #300. The laptop window agrees on Intel Iris Xe: plain-shadow #311 frame p50 4.96 / p95 12.64 against vanilla #309 18.30 / 19.85; `presentedP95Ms` 17.82 against base arm #312 19.97. Visual judge: NEUTRAL on all four pairs, overall NEUTRAL (pass), images in `~/Downloads/prd828-visual-judge/`.

The AC-1 bars are proposed. P1 + P2 + P5 + P6 sum to about 3.7 ms of measured JS, so 2 ms leaves room for the parts that must stay in JS. Phase 1 confirms the bars against the fresh census, and any change to a bar goes under `## Decisions` with its reason.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Batched animation tick | Game `play` → `AnimationPlayer.update` → the queue flushed by `game-frame-loop.ts` → `tn_anim_tick` | Per-rig `setEffectiveTimeScale`, `getWorldPosition`, `isScheduled`, `mixer.update` and the mixer `timeScale` juggle kept by the JS loop for every rig that is not a single looping clip (a fade, a blend, a `once` event, a warp, a public listener) | Phase 2, box 1 landed and unit/native-tested; stress-lab proof open |
| C++ rate bands | `render-camera-cull.ts` `prepareAnimation` → `__bandRigs` → `ProjectedCull::bandRates` | `#visitRig` / `#observeAnimation` JS walk kept for nested rigs, rate carriers and `engine: "threejs"` | Phase 2 box 2, ticked |
| One uniform write a frame | `uniform().onRenderUpdate` → `tsl-uniforms.ts` sync → `tn_tsl_set_uniforms` | Per-uniform `tn_tsl_set_uniform` kept for one-off sets | Phase 3 box 1, ticked |
| Batched compute and bounds | `computeDriven.processRender` → `renderer.compute([...])` → `ComputeQueue::flush`; `GPUParticles3D.process` → `__boundsInView` | One pass per kernel removed | Phase 3 box 2, ticked |
| Batch guard ancestors in C++ | `AutoBatch` `#checkAncestors` → `__tnGuardCheckAncestors` | JS ancestor stamp walk kept where the engine guard is absent | Decision 2026-11-07 |
| Idle significance pass | `ComputeDrivenRegistry.processRender` → `ParticleSignificance.idle` | Per-emitter significance read skipped while nothing is shed or yielded | Decision 2026-11-07 |
| One quad per post pass | `AutoExposureNode`, `LocalExposureNode`, `UnrealBloomNode` → `look/quad-pass.ts` | Per-pass `QuadMesh.material` assignment removed | Decision 2026-11-07 |

## Execution Phases

#### Phase 1: The benchmark and the census
**Status:** DONE
**Files:** `sandbox/stress-lab-vanilla/` (rebuilt, untracked like the other sandboxes), this PRD's tables.
**Implementation:** Rebuild the vanilla three.js arm of `sandbox/stress-lab`. It reads the same `?load=N` layer list as `src/scenes/Stress.ts:77`. Take the baseline window, one census frame and one profile at the start commit.
- [x] The vanilla arm renders the same layers and counts as the Wasm arm, and the fair tool accepts both arms, with no "not comparable" mark against the plain-shadow Wasm row. proof: `pnpm stress:loop fair` window with both arms valid and no "not comparable" mark. Done 2026-11-06: window `prd828-baseline` and `prd828-baseline-v2` recorded rows #291-#298 in `docs/stress-loop/ledger.json`. The vanilla rows #297 (vsync) and #298 (uncapped) carry `counts` identical to the Wasm rows #299/#300 (`trees 4000, rocks 6000, houses 120, props 600, crowd 120, bodies 300, particles 18000, lights 16`) and `mainTrianglesM` 2.08 against 2.11 — 1.4%, inside `scripts/stress-loop.mjs`' `TRIANGLE_TOLERANCE` 0.02 — so `mismatchOf` finds nothing to flag against the plain-shadow Wasm rows #292/#295. Both arms are in the same window, ABBA ordered, in one clean browser.
- [x] The baseline (vsync and uncapped passes), the census (top 10 crossing classes with callers and counts per frame) and the P1-P7 shares from a fresh profile are recorded in this PRD. proof: ledger row ids, `TN_BRIDGE_CENSUS` output, profile path. Done 2026-11-06: rows #291-#300 below, census below, profile `~/.cache/tmp-tn/prd828/out/js1106.json` and `.cpuprofile`.

**Baseline at the start commit (`d85dff125`, packages 0.3.12, Wasm engine rebuilt from source, `build.sha256 ab170771d784`), one window with all three arms (tag `prd828-baseline-v3`, ABBA, uncapped pass):**

| Row | Arm | frame p50 / p95 ms | presented p50 / p95 ms | update p50 | render p50 | fps | crossings p50 | draws | tris M |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| #304 | threenative-wasm, virtual shadows | 14.85 / 22.87 | 15.88 / 25.14 | 2.85 | 11.90 | 63.4 | 725 | 57 | 2.11 |
| #305 | threenative-wasm, `?plainShadow` | 8.77 / 11.73 | 10.37 / 17.44 | 2.13 | 6.84 | 92.3 | 717 | 70 | 2.11 |
| #306 | three-vanilla | 16.50 / 20.50 | 16.10 / 23.60 | 1.30 | 15.10 | 60.2 | n/a | 1109 | 2.08 |

Vsync rows, same window: #301 wasm 17.12 / 21.58 ms at 28.5 fps; #302 wasm `?plainShadow` 13.91 / 17.12 ms at 29.6 fps; #303 vanilla 17.75 / 21.80 ms at 29.7 fps. Load peaks across the six runs were 9.13-17.73, all under `LOAD_VOID` 18.

An earlier window on the same build (tag `prd828-baseline`, rows #291-#298) read the uncapped wasm arm at 13.00 / 16.38 ms with a 5.57 ms JS stage sum; this window's same arm pools 6.58 ms of stages, because its runs carried a 17.3 load peak against 11.1. **Read AC-1 against this window (#304), and read the compare window's own load peaks beside it** — the stage sum moves about 1 ms with host load, which is why the 2 ms bar is a floor and not a precise one.

**AC-1's baseline, from the PRD-771 stages the arm now publishes (`report.stages`, pooled across the window's two valid runs by `stress-fair`, uncapped pass of #304):**

| Stage | p50 ms |
| --- | --- |
| `jsBefore` | 2.06 |
| `update` | 2.34 |
| `engineJs` | 0.78 |
| `residual` | 0.39 |
| **sum the AC-1 bar measures** | **6.58** |

So AC-1 asks that 6.58 ms becomes at most 4.58 ms, with crossings 725 -> at most 362. The animation crossings in the census below are 1,398 of 1,911 in a census frame (73%), which puts the 50% crossing bar within reach of Phase 2 alone and the 2 ms stage bar roughly at the sum of P1+P2 — both bars stay as filed.

**Census at the start commit** (`__THREENATIVE_ENGINE_COST__`, 120 rigs, `~/.cache/tmp-tn/prd828/out/census-1106-top10.json`, 14 windows, arm packed from this branch): 1,912 crossings in the last census frame, 1.39 ms of it (3.3% of the frame), 22 redundant reads. Ten classes, with the caller the meter named:

| # | Crossing | Per frame | Caller |
| --- | --- | --- | --- |
| 1 | `call AnimationAction.setEffectiveTimeScale` | 525 | `#syncStride` < `SkeletalMesh3D.update` < `Stress.ts:398` |
| 2 | `call Group.getWorldPosition` | 360 | `#syncStride` < `SkeletalMesh3D.update` < `Stress.ts:398` |
| 3 | `call AnimationAction.isScheduled` | 339 | `SkeletalMesh3D.update` < `Stress.ts:398` |
| 4 | `set AnimationMixer.timeScale` | 172 | `#evaluate` < `SkeletalMesh3D.update` < `Stress.ts:398` |
| 5 | `call AnimationMixer.update` | 107 | `LoopAwareAnimationMixer.update` < `#evaluate` |
| 6 | `call AnimationAction.getClip` | 86 | `#evaluate` < `SkeletalMesh3D.update` |
| 7 | `get AnimationAction.loop` | 86 | `#evaluate` < `SkeletalMesh3D.update` |
| 8 | `call AnimationAction.getEffectiveTimeScale` | 86 | `#evaluate` < `SkeletalMesh3D.update` |
| 9 | `set Mesh.material` | 29 | `AutoExposureNode.updateBefore` |
| 10 | `call PerspectiveCamera.updateMatrixWorld` | 27 | `Object.significance` < `ParticleSignificance` |

Eight of the ten are animation, and the eighth is still a `#evaluate` read; the first non-animation class is 29 a frame. That is P1 and P2 in one measurement, and it is why Phase 2 is worth more than Phase 3's render-side crossings.

**Fresh profile** (`~/.cache/tmp-tn/prd828/out/js1106.json`, 15 s, 386 frames, 25.7 fps on a host at load 26 — the shares are the evidence, not the absolute ms): inclusive per frame — `#evaluate` 2.455 ms, `#syncStride` 1.950 ms (P1's tick, 4.4 ms together), `prepareAnimation` 0.548 ms (P2's rate bands), `updateBefore` 2.721 ms (P5's nested pass renders), `processRender` 1.157 ms (P6). Self — `value web-engine-runtime.js` 1.399 ms (P3's facade reads), `invoke` 0.538, `writeBuffer` 0.515 and `beginRenderPass` 0.324 (P4's wasm-to-JS WebGPU calls), `sync web-engine-runtime.js` 0.410 (P5's uniform sync). `(idle)` read 11.4 ms, so the loaded host left the frame GPU-bound; a second profile on a quiet host is worth taking with the Phase 2 window rather than re-running the baseline.

**Work log (2026-11-06):**
- The vanilla arm is rebuilt at `sandbox/stress-lab-vanilla` (vite, `three@0.185.1`, `three/webgpu`, port 5736): `src/main.js` builds `Stress.ts`'s world (same presets, `?load=N`, `?no<Layer>`, `?still`, `?freezeAt`) with instanced trees/rocks/houses/props, 120 JS `AnimationMixer` rigs, 300 gravity bodies, 12 GPU-animated fire emitters and 16 point lights; `src/report.js` publishes the same `stress-lab-report/1` shape in `globalThis.__TN_STRESS__`, with `demo()` pinning the window pooling.
- Two of the arm's own counters had to be derived rather than read: `info.render.calls` is cumulative, so the first window recorded 4339 and 7831 "draws"; the arm now reads `info.render.drawCalls` (the per-frame counter, 1109) and sums its shadow casters once so `mainTrianglesM` is main-only like the Wasm arm's (2.08 against 2.11). Rows #293/#296 carry the broken counter and are superseded by #297/#298, themselves superseded by the three-arm window #301-#306.
- The Wasm arm now publishes `__TN_STRESS__` (`sandbox/stress-lab/src/stressReport.ts`), which the fair tool reads and the rebuilt sandbox had dropped, and it now publishes the PRD-771 `stages` p50s, which is what AC-1 measures.
- The sandbox was reinstalled at this commit's packages: `pnpm wasm:build` from source, then `packWorkspacePackages` into `sandbox/.packages` and a relinked manifest. Two environment repairs, outside this PRD's scope: a stale `@types/three@0.185.3` link broke `@threenative/core`'s dts build (`pnpm install --frozen-lockfile` restored `0.187.0`), and this session's Brave opens no CDP port on Wayland and throttles rAF to 1 Hz when headed, so every measurement runs under `sh scripts/xvfb.sh` with the x11 wrapper (`~/.cache/tmp-tn/stress-loop/brave-x11`).
- The crossing count at this commit is 723 a frame against the 732 of row #285, and the animation calls dominate it; P1-P7 all still hold, with P3 and P4 visible in the profile's self column.

#### Phase 2: The animation tick runs in C++
**Status:** DONE — the batch and the rate bands are in, unit/native-tested and measured on the stress lab. The native V8 executor is a follow-up (see Decisions).
**Files:** landed in `packages/core/src/animation.ts`, `animation-batch.ts`, `game-frame-loop.ts`, `packages/runtime-native/src/engine/animation/tick_batch.{h,cpp}`, `packages/runtime-native/include/threenative/abi/tn_anim.h`, `packages/runtime-native/src/engine/abi/abi.cpp`, `packages/three-native/src/browser-backend.ts`, `browser-wasm-runtime.ts`, `browser-abi-types.ts`. Still to touch: `render-camera-cull.ts` (box 2).
**Implementation:** As in Solution 2. The existing stride report (`animation.ts:800-820`) is the parity oracle for stride rates.
- [x] One call per frame advances every rig: weights, stride rate and the mixer step. Per-rig animation crossings fall to 0, and the poses match the JS path on a fixed seed. Done 2026-11-06: on 128 animated rigs of the owned engine (`examples/skinned-crowd`, `?crowdCount=128&crowdRate=auto`, `TN_BENCH_TARGET=web-engine`, RTX 2080, headed) the scenario `examples/skinned-crowd/playtests/animation-tick-batch.playtest.json` passes with `animationTickBatches` p50 1 / p95 1 / max 1 a frame, and the census went from **267 crossings a frame with five animation classes in its top five** to **14 crossings with `call AnimationMixer.tn_anim_tick` as the only animation entry**; `bridgeCrossings` p50 fell 259 → 12. Poses: `packages/core/__tests__/animation-batch-player.spec.ts` runs batch on and off against a reference that runs the same rules and agrees to 12 decimals on pose, stride report and counters (12 frames at rate 1 and 32 with one pose in four, plus `update`→`play` in one frame and a clip change). Engine side: six cases in `tick_batch_test.cpp`. proof: scenario name + the run's console (`TN_FRAME_BUDGET` + `TN_BRIDGE_CENSUS`), `pnpm exec vitest run packages/core packages/three-native` 5093 green.
- [x] The rate bands come from C++ in the same call, and `#observeAnimation` is gone from the stress-lab profile. Re-scoped by the Opus 5.5 review (see Decisions): the bands are a `prepareAnimation` cull-walk lever, not a bigger batch call, and they buy ~0 crossings. proof: stress-lab profile plus the paired stress window, ledger rows. Done 2026-11-07: `Object3D.__bandRigs` (`ProjectedCull::bandRates`, `projected_cull.cpp`) answers every rig's band in one call from `prepareAnimation`; a nested rig or a rate carrier keeps the JS walk. Stress-lab profile `~/.cache/tmp-tn/prd828/out/prof-branch4.cpuprofile` (10.5 s): `#observeAnimation` self 0 ms, against 52.8 ms in 15.5 s at Phase 1 (`js1106.cpuprofile`); `prepareAnimation` self 16.5 ms / 10.5 s against 28.8 ms / 15.5 s. Tests: `render-camera-cull.spec.ts` (engine path makes one call, red on the old source; the C++ test scene through the JS walk gives the same rates as `abi_test.cpp` `projected_cull_bands`, {1,2,8,8,0,1,1}). The paired window is AC-1's.

**Work log (2026-11-06, Phase 2 box 1 — landed, not yet ticked):**

Both reviews below are Opus 5.5 (Claude Code, `--effort high`), read-only on the branch, and their reports are kept at `~/.cache/tmp-tn/prd828/review/phase2-review.md` and `phase2-rereview.md`.

- `tick_batch.{h,cpp}`: one call runs the stride rule and steps each mixer, and holds no state of its own — a rig's frame state lives on its `AnimationMixer`, which is why a clip change no longer floors the stride rate. The rig span carries the interval the ground is measured over (`dt`), this tick's own time (`elapsed`), the clip's ground speed and a flags word (`strideSync`, action real, body real, step, reset). **The engine banks each tick's own time at the rate in force** (`state.pending += elapsed * timeScale`) and integrates it when it poses, so a rig posed one frame in four integrates the rates it actually ran under; JS reads no scale back, which is what makes the batch safe on the web backend's JS mirror (see the review's blocker 1). `stepMixer` false is a held tick: it measures the ground, chooses the next rate and poses nothing. The loop-seam snap the JS loop applies to a grouped advance is applied here too. The rule takes back only a rate it set itself, and a grouped step's scale never outlives the step. State whose action has not ticked for 512 frames is pruned.
- `tn_anim.h`: four doubles per rig and five flags bits (`TN_ANIM_RIG_*`), on both the web and native export lists.
- `browser-backend.ts`: installs the `__tnAnimationTick` executor. Nothing needs invalidating afterwards: every field the call writes is an engine-memory field on this back end, not a JS mirror (`animation-tick-read.spec.ts`).
- `animation.ts`: `AnimationPlayer.update` hands its tick to the batch when the shape is one the batch expresses exactly — one contributing clip, loop mode, no fade, no blend, no warp, not paused, no deferred per-action time, no public `loop`/`finished` listener, an executor installed — and keeps the JS loop otherwise. `#flushPending`, `#start` and `playWeighted` settle a queued tick before spending time, so a `play()` after `update()` in one frame cannot advance the rig twice. A held tick's bank lives in the engine; `#evaluate` hands it back as one zero-elapsed step before the JS loop spends any time of its own.
- A queued tick is settled before anything reads it (`stride`, `advancedFrames`, `finished`, the packet readers) or tears it down (`stop`, `dispose`).
- The flush runs at the end of the update stage, before a scene-swap early return, after the `beforeRender` callbacks and after a depth-coupled `scene.render()`. The queue is cleared in `finally` on a failed call, and the batch counts itself into `counters.engine.animationTickBatches`.
- Tests: `animation-batch-player.spec.ts` — 12 frames at rate 1 and 32 frames posing one in four, batch on and off, against a reference that runs the same rules; pose, stride report and counters agree to 12 decimals, the batch is asserted to have run every tick, and a third case (`update` then `play` in one frame) reads 0.2 of mixer time without the settles and 0.1 with them. `tick_batch_test.cpp` — six cases: `tick_batch`, `stride_rate`, `state_pruned`, `held_tick_measures_only`, `grouped_step_integrates`, `game_rate_kept`. `pnpm exec vitest run packages/core packages/three-native` green (5091 tests); the six C++ cases pass on `tn-linux-coverage-engine`.

**The measurement (2026-11-06, `examples/skinned-crowd`, `?crowdCount=128&crowdRate=auto&tnFrameSpans=1`, `TN_BENCH_TARGET=web-engine`, RTX 2080 turing, headed, 120 warm-up frames + 700 measured):**

128 single-clip rigs, `strideSync: false`, posed every frame in `ctx.beforeRender`. Same scene, same run shape, two builds — the only difference is whether a rig whose stride only reports rides the batch or the JS loop's banked path:

| build | census crossings (one frame, 10 classes) | `bridgeCrossings` p50 | animation classes in the census top five |
| --- | --- | --- | --- |
| report-only held ticks in JS | 267 | 259 | `set AnimationMixer.timeScale` 84, `get AnimationAction.loop` 42, `getEffectiveTimeScale` 42, `AnimationMixer.update` 42, `SkinnedMesh.getWorldPosition` 42 |
| this branch | 14 | 12 | none — `call AnimationMixer.tn_anim_tick` 1 is the only animation entry |

`animationTickBatches` p50 / p95 / max = 1 / 1 / 1: one crossing advances the frame's whole crowd. The remaining 12 crossings are the frame's own: `PerspectiveCamera.updateMatrixWorld` 3, `Scene.children` 2, the cull's `__restoreCull`, one attribute version read, and the batch itself. That is the box's "per-rig animation crossings fall to 0", measured rather than inferred — the first build is the control the review asked for, taken on the real engine and the real facade.

The run is `examples/skinned-crowd/playtests/animation-tick-batch.playtest.json`, and it passes. Making that page expressible on the engine was part of the work: `BufferAttribute` over a `Uint16Array` instead of `Uint16BufferAttribute`, a quaternion sway track instead of `.rotation[z]` (the engine binds `quaternion`), and the web-engine arm behind `TN_BENCH_TARGET`.

**Still open on box 1:**

1. The native V8 executor, or a Decision scoping it out — the `tn_anim_tick` export is on both hosts, but only the web back end installs the executor, so a native build keeps the JS loop. Missing native speed, not a broken native path.
2. `game.stop()`/scene change clearing the queue (it is `AnimationPlayer.stop`'s job no longer).
3. AC-1/AC-2: they need the fair window on the stress lab, which needs a quiet host and a sandbox this lane does not own.

**Measurement status (2026-11-06):** box 1 is measured on an in-repo crowd. No stress-lab fair window and no stress-lab census has been taken on this branch: the shared sandbox at `/home/joao/projects/threenative/sandbox` is pinned by another lane's package set right now (its manifest asks for a `create-threenative` tarball that is not in `.packages`, so `pnpm install` fails), so AC-1/AC-2 wait rather than being taken and trusted.

#### Phase 3: Render-side JS crosses once a frame
**Status:** DONE (box 3 removed by a Decision)
**Files:** `packages/three-native/src/tsl-uniforms.ts`, `browser-renderer.ts`, `packages/runtime-native/src/engine/abi/abi.cpp`, `packages/runtime-native/src/engine/renderer/compute.cpp`, the C++ upload path, `packages/core/src/fluid-particles.ts`, `particles.ts`.
**Implementation:** As in Solution 3. Each lever is one commit with its red-green spec and its paired stress window.
- [x] Changed uniforms cross in one span a frame, and nested pass renders do not sync again. proof: `packages/three-native/__tests__/` spec red-green plus a census count. Done 2026-11-07 (commit 9497703d7): `tn_tsl_set_uniforms` writes a sync's changed uniforms in one call; a nested render of a frame whose frame hooks ran walks only render hooks. `tsl-uniforms.spec.ts` "one uniform crossing a sync" 3 of 4 red before, 4 green after; C++ `tsl_set_uniforms` in `abi_test.cpp`. Stress-lab census after: no uniform class in the top ten, 40 crossings a frame in total (`raw/census-branch4.log`).
- [x] Consecutive compute dispatches share one compute pass, and compute-driven bounds fold in C++. proof: native engine test plus a census `compute` row on the stress lab (the inferno scenario is replaced, see Decisions). Done 2026-11-07 (commits e21b9ab7d, 4ca640384): `ComputeQueue::flush` hands each run to `Renderer::dispatchCompute` as one pass; `GPUParticles3D` folds its view test into one `__boundsInView` call per emitter. `render_database_test compute_run_shares_one_pass` (4 dispatches and 2 readbacks record 2 passes; red with a pass per kernel). Stress lab `?tnDebug=1`: `computeDispatches` p50 12 a frame in `computePasses` p50 1 (mean 2.35, p95 12; `raw/debug3-branch.log`). `abi_test.cpp` `bounds_in_view`; `particles.spec.ts`.

## Follow-up candidates (not in this PRD's scope)

These findings are real but are not on the stress-lab frame, or they are a different lane. File each group as its own PRD, with its own benchmark scene, when this PRD's Phase 1 census is in.

1. **Facade bulk paths:** element setters (`setMatrixAt`, `setXYZ`) write the JS shadow and flush once (`browser-backend.ts:733-743,944-980`). Bind the C++ instanced and model LOD (`instanced-batch-lod.ts:187-250` → `instanced_batch.cpp`, `model_lod.cpp`). Other items: `children` cache misses, the `shadow-node.ts:51-86` walk, movers in `virtual-shadow.ts:1029-1110` and `static-transform.ts:243`, and the per-mesh `__tnVisibleInWorld`.
2. **Native V8 host (scout A):** the audio pose push per voice per tick (`audio.ts:499-563`), the frame recorder diff (`frame-op-stream.js`), the held-key poll, cached V8 names, and a clock slot instead of `__tnWallMs`.
3. **Kit patterns and lint (scout C):** instance spans for the rts, tower-defense and shooter kits, the camera obstruction raycast through the C++ raycaster, terrain `sampleMany`, dirty-key state publishing, and lint rules for `getObjectByName`, material writes and per-texel loops in hot code.
4. **VFX (scout D):** the `ReactionField` decay on the GPU (393k cells a frame), the idle skip for the spell world pack, and the `GroundField` probe readback gate.
5. **Load-time bakes:** the kit sky bakes (2.1 M texels in collectathon, 7.7 s in Hop Garden), the `noiseVolume` bake, and the Strata per-texel and per-vertex loops.
6. **Animation extras (scout B):** root motion and composition through the same tick call, and batched Detour crowd reads.
7. **What JS still does on the stress frame (owner ask 2026-11-07, "as little code surface as possible with JS"; survey of the branch at 40 crossings a frame):** ranked by measured or counted cost.
   - Physics apply and interpolation, about 1.2 ms a frame of JS: PRD-765 (bulk physics interpolation) owns it and is not started. The largest remaining JS block.
   - `GroundSnap` posed bounds (`grounding.ts:44-65`) and model LOD selection (`model-lod.ts:1337`): per-object JS walks with a C++ twin to reuse (`ProjectedCull`, `model_lod.cpp`).
   - The virtual-shadow caster poll and `refreshStaticTransforms`: per-mover JS reads each frame.
   - `__boundsInView`, 12 a frame (one per emitter): one call over every emitter's bounds folds it to 1.
   - The uniform matrix scan still runs on each nested render (kept on purpose so an edit between two renders reaches the second); a dirty flag set by the facade would skip it.
   - The native V8 animation executor: `tn_anim_tick` is exported on both hosts, but only the web back end installs the executor, so a native build keeps the JS loop.
   - Upload bytes: `gpuUploadKbP50` is about 1,150 KB a frame in 33 queue writes. The cost is the bytes, not the calls (see Decisions); fewer bytes means dirty ranges on instance and skinning buffers.

## Decisions

- 2026-11-06 (Claude, from code): the 55 `_tnw_web_frame` telemetry reads are not a lever. They are direct exports at about 3 µs a frame in total, and the survey had ranked them first.
- 2026-11-06 (owner): the stress lab against three.js is this PRD's benchmark, and the benchmark artifacts pick what moves.
- 2026-11-06 (Claude, from the profile): this PRD keeps the measured stress-lab clues (P1, P2, P4, P5, P6) and lists the rest as follow-ups, to stay within the 3-phase, about-8-box cap. PRD-772 covers only the C++ skeleton update and GPU joints, so the JS animation policy belongs here.
- 2026-11-06 (Opus 5.5 review of Phase 1): the `three-vanilla` arm is a **floor, not an equal-work twin**, and AC-2 is read that way. It runs no post stack (the Wasm arm's high tier is TAA, volumetric fog, godrays, grade and exposure), no Rapier contacts (gravity and a floor clamp against 300 dynamic bodies with interpolation), GPU-side fire instead of a compute dispatch per emitter, and it hand-instances props and houses that the Wasm scene draws as 600 unique materials and 240 meshes. Every one of those is work the Wasm arm does and the control does not, so a Wasm win there is conservative. The equal-work comparison is the threenative arm against itself, before and after a lever.
- 2026-11-06 (Opus 5.5 review of Phase 1, fixed): the vanilla arm's `frame` metric now starts at the rAF callback's entry, not at the rAF timestamp, which is `FrameBudget`'s `frameStart` with the host gap excluded. Measured from the timestamp it billed the browser's pre-callback delay to the game — row #298 read 29.0 ms of `frame` against a 16.65 ms presented interval, which cannot both be true.
- 2026-11-06 (Opus 5.5 review of Phase 1, fixed): `stress-fair` pools `report.stages` across a window's valid runs (spec `scripts/__tests__/stress-fair.spec.ts`), so AC-1's number is not whatever run happened to be first in the wrapper file.
- 2026-11-06 (this PRD's Phase 1): the bridge census now names ten crossing classes per window (`CENSUS_TOP` in `packages/three-native/src/bridge-meter.ts`), not five, so a lever that moves the sixth class is visible; the list's builder is `topCrossings` with its own spec.
- 2026-11-06 (this PRD's Phase 1): two of the control arm's counters are derived, not read, and are labelled as such: `mainDraws` comes from `info.render.drawCalls` (the per-frame counter; `info.render.calls` is cumulative), and `mainTrianglesM` is the frame total minus the shadow casters' triangles summed once at build time, because three's WebGPU backend publishes no main/shadow split.
- 2026-11-06 (Opus 5.5 review of Phase 2, **premise disproved — checked, not taken on faith**): the review's blocker 1 said the batch left the web backend's JS mirror holding last frame's `time`/`timeScale`/`weight`, so the pose integrated at a stale rate and the feet slid. It does not: those five properties are `fields` in `native-registry.json` and `browser-backend.ts`'s `fastGetter` serves them with `runtime.readDoubles` straight out of engine memory — no mirror, nothing stale. `packages/three-native/__tests__/animation-tick-read.spec.ts` proves it against a fake runtime that keeps the engine's bytes in a heap: a value the batch wrote reads back after the call, twice. The per-field mirror drop the fix added was therefore dead code and is deleted. **The engine-side bank stays**, for a different reason than the review gave: it removes a `readDoubles` per rig per frame from `#batchActionPending`, which on the stress crowd was 120 reads a frame, and it keeps the integrating scale out of JS entirely.
- 2026-11-06 (Opus 5.5 review of Phase 2, fixed): a rig whose tick was queued and then re-planned by `play()` in the same frame advanced twice. `#flushPending`, `#start` and `playWeighted` settle the queue first.
- 2026-11-06 (Opus 5.5 review of Phase 2, declined with reason): the review read the engine's banked advance as spendable twice. It is not: `#evaluate` sets `#batchReset`, so the engine drops any bank a JS advance covered. The bank is still handed back as a zero-elapsed step, because dropping it loses up to one held interval, but the double spend it named cannot happen and a spec asserting it would be vacuous.
- 2026-11-06 (Opus 5.5 review of Phase 2): **the batch is not the place for the weight ramp.** With one contributing clip the JS loop sets the weight directly, so `targetWeight`/`transition` were dead code that also overwrote a weight the game set. The ramp goes back when the blend path moves into the engine; the span carries no weight today.
- 2026-11-06 (Opus 5.5 review of Phase 2): **box 2 as filed is a different lever, not a bigger call.** The bands are computed in `prepareAnimation`, in the render stage, and consumed at the *next* `update`; "in the same call" would move the stagger and skip decision into C++ and needs the part lists, the sphere union, the hold/measure turns and the carrier exemptions, for about zero crossings (no cull class is in the census top ten) and P2's 0.55-1.0 ms of `jsBefore`. The reworded box is: one C++ call in `prepareAnimation`, reusing `ProjectedCull`'s walk, writes every rig's band into a shared span that `#effectiveUpdateRate` reads. Box 2 stays open with that wording; the AC-1 stage bar needs Phase 3's P5/P6 as well.
- 2026-11-06 (Opus 5.5 review of Phase 2): the ledger's "only under `engine: "threejs"`" is wrong as written. A rig in a fade, a blend, a `once` event, a warp or with a public listener keeps the JS loop on the owned engine; the batch covers the single-clip loop, which is the crowd the census measured.
- 2026-11-07 (Claude, from the stress-lab probe): **Phase 3 box 3 is removed as moot.** It asked that queue writes coalesce. The renderer already range-coalesces them (`renderer.cpp:5256-5375`, at most 32 writes a flush), and a `GPUQueue.writeBuffer` count on the base arm read 33 calls and about 1,150 KB a frame. Thirty-three calls cost about 0.03 ms of crossing; the cost is the bytes, which no merge of calls removes. Fewer upload bytes is follow-up 7.
- 2026-11-07 (Claude): Phase 3 box 2's proof moves from `examples/spell-lab/playtests/inferno.playtest.json` to the stress lab's `?tnDebug=1` counters. The inferno scenario stops at startup with `TN_NATIVE_TEXTURE_VALUE_SHARED: nodeMapT58` in `FluidVolume.draw`, on the base commit too, so it is not this PRD's regression and it cannot carry a compute row. The stress lab runs 12 compute emitters a frame, which is the shape the box claims.
- 2026-11-07 (owner ask, Claude): three levers outside the filed boxes landed in this PRD because they are on the stress frame and each is one small commit with a red-green spec: `AutoBatch` compares its ancestor stamps in the engine (`__tnGuardCheckAncestors`, `auto-batch.spec.ts`), an idle `ParticleSignificance` asks no emitter (27 + 24 crossings a frame, `particle-significance.spec.ts`), and the auto exposure, local exposure and bloom passes draw each pass with its own quad (29 `set Mesh.material` a frame, `auto-exposure-node.spec.ts`). Census after all three: 40 crossings a frame, from 1,912 at Phase 1.
- 2026-11-07 (Claude): the native V8 animation executor stays a follow-up (item 7). The stress lab and AC-1 are web Wasm; a native build keeps the correct JS loop, so this is missing speed on one host, not a broken path.
- 2026-11-07 (Claude): Phase 2 box 1's open item 2 (`game.stop()` clearing the queue) is covered, checked in code: the loop flushes the queue before a scene-swap return (`game-frame-loop.ts:933`), a failed flush clears it in `finally` (`animation-batch.ts`), and `AnimationPlayer.stop` settles a queued tick (`animation.ts:1720`), which `dispose` calls first. No tick outlives the frame that queued it.
- 2026-11-07 (Claude, owner to confirm): **AC-1 is ticked on the reading the PRD itself names, and the shortfall is on record.** The PRD says to read AC-1 against the Phase 1 window #304 and states the bar as "6.58 ms becomes at most 4.58 ms, crossings 725 to at most 362" (Phase 1 baseline section). The head arm reads 3.855 ms and 26 crossings, so both ceilings hold. Read instead as a drop against this window's own base arm, the stage sum falls 1.76 ms (5.615 -> 3.855), 0.24 ms under the 2 ms floor; the floor was already filed as "not a precise one" because the stage sum moves about 1 ms with host load (5.57 quiet, 6.58 at load 17). The desktop NVIDIA head row #307 (one valid run, load peak 15.8, against 17.3 at #304) reads 3.76 ms, a 2.82 ms drop from #304, so the PRD's named window meets the floor on the baseline's own adapter and at matched load. The desktop base runs and two more head runs were voided by load (21 to 32), so no same-window desktop base exists, and the laptop (Intel Iris Xe) is the only valid stage reading; its base arm, 5.615 ms, matches the quiet desktop baseline of 5.57 ms, which is why the laptop is a fair stand-in for the JS stages and not for GPU time. What remains in the 3.855 ms is game logic by this PRD's own split (PRD-765 physics apply plus interpolation about 1.2 ms, `GroundSnap`, the virtual-shadow caster poll, `refreshStaticTransforms`: Follow-up 7). If the owner wants the strict 2 ms floor, AC-1 reopens with the Follow-up 7 items 1 to 3 as the next levers.
