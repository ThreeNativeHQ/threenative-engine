# PRD-534 — The native engine earns the port (CP1)

**Status:** PROPOSED
**Priority:** P2 — Wave 4 go/stop gate: native measured against current ThreeNative once N06 and N09 land; 5 open boxes and no verdict measured.
**Complexity:** 3 — measurement only, on existing workloads; the verdict can stop the program
**Owner:** João
**Work package:** CP1 — [native-engine batch](README.md)
**Depends on:** [PRD-498 (N01)](PRD-498-n01-baseline-and-differential-fixture-runner.md), [PRD-508 (N06)](PRD-508-n06-native-scene-graph-transforms-cameras-geometry.md), [PRD-514 (N09)](PRD-514-n09-native-renderer-and-standard-materials.md), [PRD-531 (N18)](PRD-531-n18-v8-game-runtime-adapter.md) phases 1–2

## Context

Owner decision 3 ([PRD-497](PRD-497-n00-architecture-decision-and-compatibility-inventory.md)): after the native scene graph (N06) and renderer (N09) exist, measure before porting the framework systems (N11–N15), which are most of the work. §15.3 sets the comparison: current optimized ThreeNative, projection and batching included, never vanilla Three.js alone. The decision to keep game code on V8 (decision 2) means the result only counts through the V8 adapter (N18). A C++-driver number alone would hide the crossing cost.

Workloads that already exist: `examples/engine-load-test` (heterogeneous renderables, `skinned-crowd.html`, projection conformance), `examples/native-cpu-load-test`, driven by `pnpm bench:engines` and `pnpm profile:native-cpu`. Skinned content is out of reach until N11, so CP1 uses the static heterogeneous scene only.

## Solution

1. **Arms**, on the same scene, resolution, camera path and presented workload:
   - `current`: today's ThreeNative on the legacy native host.
   - `native-v8`: the native engine with game code on the V8 adapter (the shipping shape).
   - `native-cpp`: the native engine driven by a C++ fixture (the control that isolates crossing cost).
2. **Meters:** CPU time of scene update plus render submission per frame (p50/p95), GPU time, total frame time, and crossings per frame. Cold and warm runs are reported apart.
3. **Verdict rule** (Decisions): the engine hot-path CPU time in `native-v8` must be at most half of `current` on the heterogeneous workload, on desktop and on the Pixel 8. Otherwise N11–N15 stay unstarted and the owner re-plans. When `native-cpp` passes and `native-v8` fails, the cause is crossing cost, and bulk paths (decision 9) are the re-plan.
4. Results go into `docs/verification/runtime-perf-state.md` in place.

## Out of scope

- The full §15.4 gate set across all workloads ([PRD-533 (N20)](PRD-533-n20-platform-qualification-performance-default-promotion.md)).

## Execution Phases

#### Phase 1: Three arms on one workload
**Status:** NOT STARTED
**Files:** `scripts/engine-load-test/`, `examples/engine-load-test/src/`
- [ ] `pnpm bench:engines` runs the heterogeneous workload under `current`, `native-v8` and `native-cpp` with identical presented draws and triangles. proof: `pnpm bench:engines -- --arms current,native-v8,native-cpp --workload heterogeneous`
- [ ] Each arm reports hot-path CPU p50/p95, GPU time, frame time and crossings per frame. proof: the same command's JSON report

#### Phase 2: The measurement
**Status:** NOT STARTED
**Files:** `docs/verification/runtime-perf-state.md`
- [ ] Desktop result for all three arms, on physical hardware with a real display. proof: `pnpm bench:engines -- --arms current,native-v8,native-cpp --workload heterogeneous --target desktop`
- [ ] Pixel 8 result for all three arms. proof: `pnpm bench:engines -- --arms current,native-v8,native-cpp --workload heterogeneous --target android --device <serial>`
- [ ] The verdict, proceed or stop, is written into this PRD and the batch index with both numbers. proof: the two runs above

## Decisions

- The pass bar is the §15.4 hot-path target (about 2× lower CPU), applied early and only to the hot paths that exist at N09. Xvfb and SwiftShader runs are functional checks, not the verdict (§15.3). Owner, 2026-10-04.
- A failed verdict stops N11–N15 but not N19's Wasm build, which is a correctness port, and not N05's spike.
