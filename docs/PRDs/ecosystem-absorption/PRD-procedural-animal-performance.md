---
prd_contract: v1
---

# PRD-procedural-animal-performance — Meet the 32-wolf crowd frame budget

**Status:** NOT STARTED
**Priority:** P2 — Bring the baked 32-wolf crowd inside its CPU frame budget; correctness already ships in PRD-procedural-animal-content.
**Adoption order:** follows [PRD-procedural-animal-content](../done/PRD-procedural-animal-content.md).
**Complexity:** 5 (MED); donor solver cost in `packages/procedural-animals` plus one paired-run measurement.
**Owner:** ThreeNative maintainers.
**Depends on:** [PRD-procedural-animal-content](../done/PRD-procedural-animal-content.md) (the baked wolf, its example and its AC-7 instrumentation).
**Progress:** 0%

## Context

AC-7 of the content PRD was split out on 2026-10-07 by owner decision, with the CPU limit unchanged. Measured there (browser, hardware WebGPU, 300 warm-up + 1,800 measured frames, 32 wolves vs animals removed): CPU p95 delta 35.50 ms (`9ff86980d`), 20.10 ms (`145d7eb10`), then 6.10 ms in the normal scalar diagnostic profile after the scalar `writeFrame` change. GPU p95 delta passed at 3.62 ms (limit 4 ms). Profiling put the cost in animal follow (donor update, bone-frame upload), not rendering. Full evidence: the done PRD's `## Decisions` log.

## Solution

Reduce per-frame animal follow cost without dropping the donor solver's iterations or cadence, or accept a measured design change (for example fewer solved wolves per frame) as a recorded owner decision. Keep the 2 ms CPU and 4 ms GPU limits unless the owner changes them.

## Phase 1 — Meet the budget

- [ ] Three paired runs (300 warm-up, 1,800 measured, same scene with animals removed, one recorded adapter) show incremental p95 CPU ≤2 ms and GPU ≤4 ms for 32 crowd wolves. proof: the Phase 3 benchmark scenario of `examples/procedural-animals` through `node packages/playtest/dist/runner/cli.js`, results recorded here.
- [ ] High-tier single-animal cost is reported separately. proof: same scenario, high-tier arm.
- [ ] Fifty create/destroy cycles leave no owned buffers, listeners or actors alive. proof: the 50-generation lifecycle driver already in `examples/procedural-animals`.
- [ ] A frame-time win never comes from culling visible wolves. proof: the existing 32 main/shadow submission assertions stay green.

## Blocked on

A provisioned hardware-WebGPU runner for the paired runs.
