---
prd_contract: v1
---

# PRD-913 — The owned engine's shader IR gains workgroup memory and barriers, so cloth and hair solve in one dispatch

**Status:** OPEN (filed 2026-11-23 from the PRD-911/912 measurements)
**Priority:** P1 — three acceptance criteria of the character-dynamics epic (#717) wait on it: PRD-911 AC-1 (stretch at an affordable cost), PRD-911 AC-5 (cape CPU submission ≤ 0.1 ms) and PRD-912 AC-4 (2,000 hair guides ≤ 0.15 ms GPU).
**Complexity:** 8 (HIGH) — shader IR, WGSL emission, the TSL bridge and two core solvers; crosses the C++/JS boundary.
**Owner:** João
**Depends on:** None
**Repo:** this repo (`packages/runtime-native/src/engine/shader/`, `packages/three-native/src/`, `packages/core/src/softbody-skinned.ts`, `packages/core/src/hair-strands.ts`)

## Context

Measured on 2026-11-23 (`examples/character-dynamics/playtests/perf.playtest.json`, `--live-clock`, 1080p, owned engine, RTX 2080, clock not locked):

- The skinned cape encodes 25 compute kernels a frame. The owned engine spends about 22 µs encoding each, so CPU submission reads 0.65-0.73 ms against a 0.1 ms bar. Batching the kernels into one call per substep did not change the per-kernel cost.
- Cape stretch only reaches ≤ 10% at 16 iterations × 24 substeps. Per-constraint coloured Gauss-Seidel (Chaos's method, `PBDSpringConstraints.cpp:37-71`) matches Jacobi at 8 iterations, but costs one dispatch per colour, about 14 per iteration.
- `HairStrands3D` runs one thread per strand. With 2,000 guides of 16 points, `gpuOther` reads 4.6-7.1 ms against a 0.15 ms bar, because 2,000 threads walk their points serially through storage memory. Unreal's groom runs one thread per point, with the strand in groupshared memory.

Each fix needs the same two features: memory shared by a workgroup, and a barrier between the steps of a solve. The owned IR has neither (`ir.h:238`: `StmtKind` ends at `Return`; `ir.h:207-212` sets only the workgroup size). Three's TSL has both (`workgroupArray`, `workgroupBarrier`, `three/src/nodes/gpgpu/BarrierNode.js`).

## Solution

1. The IR gains a workgroup-scoped array declaration and a `Barrier` statement (workgroup and storage scopes). WGSL output emits `var<workgroup>` and `workgroupBarrier()` / `storageBarrier()`.
2. The TSL bridge in `packages/three-native` maps `workgroupArray` and `workgroupBarrier` / `storageBarrier` to them, and fails closed on any other barrier form.
3. The skinned cape solves a whole frame (all substeps, coloured constraint batches) in one dispatch when its particle count fits one workgroup (≤ 256), and keeps today's path above that size.
4. `HairStrands3D` runs one thread per point, with each strand's points in workgroup memory.

## Phases

### Phase 1 — IR and WGSL

- [x] The IR declares workgroup arrays and emits `var<workgroup>`; a `Barrier` statement emits `workgroupBarrier()` or `storageBarrier()`. proof: a native shader IR unit test plus a conformance case that runs a workgroup reduction on web and desktop and reads back the right sum. Done 2026-11-23: `Program::workgroupArray` and `Program::barrier` (`ir.h`, `ir.cpp`, `wgsl.cpp`, `package.cpp`: workgroup memory is no binding). Red-green: `tn-native-engine-shader-ir-test workgroup_memory` failed to compile before the change (no `workgroupArray` member) and passes after, with the other four IR cases still green; `tsl_ir`, `tsl_graph` and `tsl_js` corpora pass. Conformance row `workgroup-reduction` (64 threads sum 1..64 to 2080 through halving steps with a barrier each, the scene reads the sum back and throws unless it is exact, and the box colour comes from the same GPU value): upstream three reference passes; Wasm engine in Chromium passes with pixelMismatchRatio 0 and perceptualDeltaE 0 against it; desktop V8 player on the RTX 2080 passes with the same 0 and 0. Red for the web row: before the threaded Wasm was rebuilt it failed with `TN_TSL_DYNAMIC_UNSUPPORTED workgroupArray`. Also `tests/native-engine/player-compute.mjs` (V8): four workgroups of 64 each give their own sum [2080, 6176, 10272, 14368], and a changed expected value makes it fail. A kernel with a barrier runs whole workgroups, so `loweredProgram` drops the thread-count guard (a barrier cannot sit in non-uniform flow) and refuses a count that is no multiple of the workgroup size with `TN_COMPUTE_BARRIER_COUNT`.
- [x] The TSL bridge maps `workgroupArray`, `workgroupBarrier` and `storageBarrier`, and throws on an unmapped barrier. proof: a `packages/three-native` spec. Done 2026-11-23: shared table `tsl_call.cpp` (`workgroupArray`, `.element`, assign, `workgroupBarrier`, `storageBarrier`; `textureBarrier` throws `TN_TSL_BARRIER_UNSUPPORTED`), `graph.cpp` lowering, the V8 adapter name list and `core-tsl.mjs`, and `browser-tsl.ts` for the Wasm back end. Red-green: `browser-tsl.spec.ts` "Wasm TSL workgroup memory" failed 3 of 3 (`exports.textureBarrier is not a function`, no `workgroupArray` call) before and passes 28 of 28 after; the V8 player test also refuses `textureBarrier` and a barrier kernel whose count is no multiple of its workgroup, by name. `setName`, `toAtomic` and a 2D or 3D dispatch on a workgroup array stay unmapped.

### Phase 2 — Solvers

- [ ] The skinned cape solves a frame in one dispatch at ≤ 256 particles, with coloured Gauss-Seidel. proof: `softbody-skinned.spec.ts` plus `acceptance-cloth.playtest.json` (stretch ≤ 10%, PRD-911 AC-1).
  Partly done 2026-11-23, box open: the dispatch half is green, the stretch half is red. `SoftBody3D(skinnedMesh)` with at most 256 particles runs carry, every substep, 13 colours of Gauss-Seidel sweeps (7 bend, then 6 stretch) and the collision pass as one kernel of one 256-thread workgroup, one compute call a frame (`softbody-skinned.spec.ts` 23/23; red before: the old path gave 4 calls and 5 nodes; above 256 particles, or with `singleDispatch: false`, the old path stays). Each thread reads its constraints once into registers, so the sweeps touch only workgroup memory. `acceptance-cloth.playtest.json` on `?arm=cloth`, owned engine, 2 iterations x 6 substeps: every bound holds except stretch, worst phase 29% (jog 26, jogTurn 22, sprint 28, hardStop 29, jump 16, snapTurn 12, teleport 3; penetration 0 everywhere; samples 90/90/120/90/60/74/44/45). Stretch falls only with substeps: 12 substeps give 6.9-17%, 24 give 2.9-12.6%, and 24 substeps x 8 iterations give 2.9-8.4% (the bar holds) at about 3 ms of GPU. `perf.playtest.json --live-clock`, `?arm=cloth&probe=0`, 3 runs: `wasmCompute` 0.11-0.12 ms (was 0.65-0.73; bar 0.1), `gpuOther` 0.6 ms (was 0.7; bar 0.35 for the cape alone; `substeps=1` reads 0.3, so the cape is about 0.3 ms of it; clock not locked). Cost per sweep is about 11 us (a barrier phase is about 0.75 us), so more sweeps or substeps cost GPU time one for one.
- [ ] `HairStrands3D` runs one thread per point in workgroup memory. proof: `hair-strands.spec.ts` plus `acceptance-hair.playtest.json` on `?arm=strands` (`hairStretch` 0, `hairInsideHead` 0).

## Acceptance Criteria

- [ ] AC-1: PRD-911 AC-1 and AC-5 pass on the owned engine: stretch ≤ 10% in every phase, cape GPU ≤ 0.35 ms, CPU submission ≤ 0.1 ms. proof: `acceptance-cloth.playtest.json` and `perf.playtest.json --live-clock` with a locked GPU clock.
- [ ] AC-2: PRD-912 AC-4 passes: 2,000 guides of 16 points ≤ 0.15 ms GPU. proof: `perf.playtest.json --live-clock` on `?arm=strands&probe=0&strands=2000&cape=0` with a locked GPU clock.
- [ ] AC-3: The workgroup reduction conformance case gives the same result on web and desktop. proof: `pnpm parity`.

## Blocked on

- A locked GPU clock for the AC-1 and AC-2 timing (`sudo nvidia-smi -lgc`), or the owner's leave to time on display `:0`: the owner, per run.

## Decisions

- 2026-11-23, lead: the one-dispatch cape path covers ≤ 256 particles, not 1,024. WebGPU's default `maxComputeInvocationsPerWorkgroup` is 256 and `computeNode` caps the workgroup there (`graph.cpp`); the test cape has 209 particles. A larger cloth keeps the multi-dispatch path.
