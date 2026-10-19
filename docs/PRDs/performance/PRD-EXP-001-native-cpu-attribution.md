# PRD-EXP-001 — Native CPU Attribution and Acceleration Decision Harness

**Complexity: 7 → MEDIUM mode**

**Status:** EXPERIMENTAL — Phase 0 deterministic harness and fox-scale browser baseline complete; optimization/native decision phases remain open. No shipping optimization is authorized.
**Priority:** P3 — Experimental harness with no shipping optimization authorized; scenario matrix unrun.
**Baseline:** branch `experiment/native-cpu-profiling`, clean committed source `11bf82d2152af300e92e8f55c6e7c98a2492a5af`.

---

## 1. Decision and context

ThreeNative keeps upstream Three.js as the public API and renderer. The next architecture decision must be based on measured subsystem costs rather than assuming that a Rust scene mirror will be faster.

This experiment starts from:

> Three.js API + Three.js renderer → selectively accelerated native kernels.

A shared partial native scene representation is reconsidered only if multiple independently proven kernels repeatedly need the same synchronized data. Rewriting Three.js classes, creating a second renderer, or introducing per-property native calls is out of scope.

Existing evidence identifies `WebGPURenderer.render()` and draw-heavy workloads as important on Android QuickJS, but does not isolate transform propagation, culling, render-list work, GPU uploads, or the complete JS/native crossing surface. The existing starter profiler is scene-specific and display-paced. This PRD adds a deterministic load-test game and a repeatable collector that separates CPU preparation from complete rendered frames.

## 2. Experiment contract

### Authoritative evidence classes

| Evidence | What it can establish | What it cannot establish |
|---|---|---|
| Node CPU kernel benchmark | Stock Three.js transform and frustum scaling on this CPU | Browser/native runtime, GPU, or bridge cost |
| Browser hardware WebGPU | Browser Three.js CPU/render scaling on the recorded adapter | Native JS engine or JS/native bridge cost |
| Browser software WebGPU | Harness correctness and relative CPU-only subsystem scaling | Shipping frame rate or GPU conclusions |
| Desktop native | Native host and V8/WebGPU behavior on that host | Android QuickJS or mobile thermal behavior |
| Physical Android | Shipping QuickJS/native/WebGPU behavior on that phone | iOS behavior |

Every report records source SHA, dirty state, runtime, OS, CPU, GPU adapter, workload, warm-up, samples, and whether the evidence is hardware or fallback. Software-renderer results fail closed for GPU/frame-rate claims. Browser WebGPU counters also do **not** prove canvas presentation: visual evidence requires headed Chromium with a display, before/after pixel validation, and an evidence class of `visual-verified`; headless captures are timing-only unless they fail before navigation under `--verify-presentation`.

### Sampling rules

- Deterministic seeded scene generation.
- Benchmark scene-shape alternatives before any native migration: draw folding/`SceneCollapse`, `InstancedMesh`, merged static geometry, `BundleGroup`, HUD/sprite batching, shared versus distinct materials, material ordering, render-object count, and one versus redundant render passes.
- Record `renderer.info` draw calls/triangles where available and add experimental counters for render objects, material transitions, pipeline transitions, passes, and upload calls.
- Instrument `renderer.render()` by meaningful stages where a stable hook exists: matrix propagation, projection/traversal/culling, render-list construction/sort, render-object/node/geometry/binding/pipeline preparation, backend draw/command encoding, submit/present.
- Where upstream internals cannot be separated without a Three.js patch, label the stage combined rather than inventing attribution.
- Compare alternatives only when they preserve the same visible workload and object coverage.
- Warm up for at least 120 frames or 2 seconds before capture.
- At least 300 measured iterations for CPU-only kernels and 180 rendered frames for browser scenarios.
- Report median, p95, p99, mean, standard deviation, and sample count.
- Run each scenario at least three times before an architectural decision.
- Keep raw JSON artifacts under ignored `artifacts/native-cpu-profile/`.
- A change is actionable only when its median gain is at least 10%, exceeds run-to-run noise, and includes all synchronization cost.

## 3. Workload matrix

The standalone load-test game supports these orthogonal dimensions:

- object count: 500, 1k, 2k, 4k, and 10k;
- hierarchy: flat and deterministic deep trees;
- dirty ratio: 0%, 1%, 10%, and 100%;
- visibility: all visible, mostly culled, and alternating visibility;
- material topology: shared material and one material per object;
- geometry topology: shared geometry and one geometry per object;
- rendering: CPU preparation only and complete `WebGPURenderer.render()`;
- mutation churn: stable objects and deterministic add/remove churn.

The first implemented slice may omit material/geometry/churn dimensions, but it must include object count, hierarchy, dirty ratio, visibility, and CPU preparation. Missing dimensions remain explicitly unmeasured, never inferred.

## 4. Measured regions

The harness records non-overlapping wall-clock regions where practical:

1. deterministic game mutation;
2. `scene.updateMatrixWorld(true)` or the selected stock update path;
3. bounds/frustum testing over the generated mesh set;
4. complete renderer call when WebGPU is available;
5. total frame callback;
6. heap/GC signals available from the current runtime.

The existing native production profiler remains the source for host binding, submit, and present counters. This experiment must not claim JS/native crossing attribution from browser-only timing.

## 5. Integration ledger

| New surface | Live caller | Negative control |
|---|---|---|
| `examples/native-cpu-load-test/` | its Vite entry and automated profile runner | invalid object count/config fails before measurement |
| `scripts/profile-native-cpu.ts` | root `profile:native-cpu` command | software adapter without `--allow-software` exits non-zero |
| summary/statistics module | profile runner and unit tests | empty/non-finite samples throw |
| dated verification report | generated from raw JSON | report refuses mixed source SHAs or incomparable scenarios |

The frozen `examples/abyss-vanilla` control is not modified.

## 6. Execution phases

### Phase 1 — Deterministic workload and statistics contract

- Write failing tests for seeded scene topology, dirty-set selection, percentile summaries, malformed samples, and comparison/noise decisions.
- Implement only enough pure TypeScript to pass.
- Verify repeated configuration produces identical IDs, parents, transforms, and dirty selections.

### Phase 2 — Sandboxed load-test game

- Add an ordinary Three.js/WebGPU game under `examples/native-cpu-load-test/`.
- Expose configuration through query parameters and results through a typed `window.__TN_CPU_PROFILE__` contract.
- Keep the scene visually recognizable and show scenario/status in a small DOM overlay.
- Do not use `SceneCollapse`, native kernels, instancing, or framework shortcuts in the independently moving object cases.

### Phase 3 — Automated collector

- Add `pnpm profile:native-cpu`.
- Start the sandbox server, launch Chromium, verify adapter classification, run the requested matrix, and save raw JSON.
- Support CPU-only collection under software fallback but label rendered-frame results non-authoritative.
- Capture JavaScript CPU profiles for hotspot discovery without using sampled self time as complete subsystem attribution.

### Phase 4 — Baseline data and decision

Run at minimum:

- 500, 1k, 2k, and 4k objects;
- flat and deep hierarchy;
- 0%, 10%, and 100% dirty;
- all-visible and mostly-culled;
- three repeats for the core comparison.

Produce a dated report answering:

- What scales with total objects, dirty objects, hierarchy, visible objects, and draws?
- What is the first realistic crossover where stock JS exceeds 2 ms and 4 ms?
- Is transform propagation large enough to justify a bounded native kernel experiment?
- Is culling large enough to follow it?
- Are complete frame numbers hardware-backed or diagnostic only?
- What are the next three targets ranked by expected benefit, complexity, and compatibility risk?

## 7. Acceptance criteria

- [ ] The experiment runs from a clean worktree at a recorded SHA.
- [ ] Unit tests observe red before implementation and pass afterward.
- [ ] The same workload seed produces byte-equivalent topology and dirty selections.
- [ ] At least 500/1k/2k/4k object scenarios produce raw samples and summaries.
- [ ] Software rendering is labeled and cannot become a shipping GPU claim.
- [ ] The result includes synchronization cost in any proposed native-kernel threshold.
- [ ] No Three.js public class, renderer behavior, or native scene mirror is introduced.
- [ ] `git diff --check`, targeted tests, typecheck, and sandbox build pass.
- [ ] The report recommends proceed/stop for a bounded transform experiment and states what remains unknown.

## 8. Phase 0 closure — 2026-08-11

Completed in the Phase 0 batch:

- deterministic workload/statistics tests and `profile:native-cpu` collector scaffolding;
- browser sandbox `examples/native-cpu-load-test/` with a visible `fox-scale` preset;
- headed Chromium/Xvfb visual and metrics baseline recorded in `docs/verification/runtime-perf-state.md`;
- software/headless presentation caveat documented so blank headless canvas captures do not become false failures or false passes.

Still open for this experiment:

- the full 500/1k/2k/4k matrix and architectural proceed/stop decision;
- native/physical-device correlation;
- synchronization-cost-backed native-kernel thresholds;
- any optimization implementation.

## 9. Kill and rollback conditions

Stop a proposed optimization when:

- measured improvement is below 10% or within run variance;
- crossover occurs beyond realistic scene sizes;
- packing, crossing, and result application erase the kernel gain;
- compatibility requires broad Three.js monkey-patching or duplicated renderer semantics;
- the result exists only on software rendering or an emulator;
- ordinary instancing, draw reduction, or stock Three.js optimization wins more cheaply.

The experiment branch is disposable. No push, merge, package release, or production deployment occurs without explicit approval.
