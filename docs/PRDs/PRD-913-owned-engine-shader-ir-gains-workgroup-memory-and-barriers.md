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
3. The skinned cape solves a whole frame (all substeps, coloured constraint batches) in one dispatch when its particle count fits one workgroup, and keeps today's path above that size.
4. `HairStrands3D` runs one thread per point, with each strand's points in workgroup memory.

## Phases

### Phase 1 — IR and WGSL

- [ ] The IR declares workgroup arrays and emits `var<workgroup>`; a `Barrier` statement emits `workgroupBarrier()` or `storageBarrier()`. proof: a native shader IR unit test plus a conformance case that runs a workgroup reduction on web and desktop and reads back the right sum.
- [ ] The TSL bridge maps `workgroupArray`, `workgroupBarrier` and `storageBarrier`, and throws on an unmapped barrier. proof: a `packages/three-native` spec.

### Phase 2 — Solvers

- [ ] The skinned cape solves a frame in one dispatch at ≤ 1,024 particles, with coloured Gauss-Seidel. proof: `softbody-skinned.spec.ts` plus `acceptance-cloth.playtest.json` (stretch ≤ 10%, PRD-911 AC-1).
- [ ] `HairStrands3D` runs one thread per point in workgroup memory. proof: `hair-strands.spec.ts` plus `acceptance-hair.playtest.json` on `?arm=strands` (`hairStretch` 0, `hairInsideHead` 0).

## Acceptance Criteria

- [ ] AC-1: PRD-911 AC-1 and AC-5 pass on the owned engine: stretch ≤ 10% in every phase, cape GPU ≤ 0.35 ms, CPU submission ≤ 0.1 ms. proof: `acceptance-cloth.playtest.json` and `perf.playtest.json --live-clock` with a locked GPU clock.
- [ ] AC-2: PRD-912 AC-4 passes: 2,000 guides of 16 points ≤ 0.15 ms GPU. proof: `perf.playtest.json --live-clock` on `?arm=strands&probe=0&strands=2000&cape=0` with a locked GPU clock.
- [ ] AC-3: The workgroup reduction conformance case gives the same result on web and desktop. proof: `pnpm parity`.

## Blocked on

- A locked GPU clock for the AC-1 and AC-2 timing (`sudo nvidia-smi -lgc`), or the owner's leave to time on display `:0`: the owner, per run.
