# PRD-878 — The walking crowd costs 2.5 ms of the desktop frame

**Status:** IN PROGRESS — filed 2026-11-11 from the PRD-872 palette lane's measurements.
**Priority:** P1 — the crowd is the largest single cost left in the `?stress` frame (about 4.8 ms of 8.2 ms).
**Complexity:** 8 (HIGH) — animation, skinning, renderer and VSM files (+3), cache state across frames (+3), one build
boundary: the C++ engine serves native and web Wasm (+2). Risk override: none.
**Owner:** João · 2026-11-11
**Depends on:** [PRD-872](../done/PRD-872-static-casters-and-rigid-rigs-in-the-desktop-frame.md) (its Decisions hold the
measurements and the parked Step A patch). Ships in PR #659.

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) and `PERFORMANCE-LEARNINGS.md` first.
All code paths below are under `packages/runtime-native/src/engine/` unless they start with `packages/`.

## Context

`?stress` on the RTX 2080 (head `81901d260`): frame p50 9.02 ms, `&noCrowd` 4.20 ms, so the 120 walkers (240 skinned
meshes, 2 per skeleton, 480 draw items with shadows) cost about 4.8 ms. A worker CPU profile puts the crowd delta at
3.8 ms a frame:

| Cost | ms | Where |
| --- | --- | --- |
| `renderPrepared` | +1.23 | `renderer/renderer_frame.cpp:6` |
| `project` | +0.94 (self +0.54) | `renderer/render_database.cpp:893` |
| JS animation and sync | ≈+0.9 | `packages/core` mixer/loop, bridge writes |
| `batch` | +0.29 | skinned palette batching |
| `boneReachBounds` | +0.22 | `animation/skinning/skeleton.cpp:288` |
| `updateAfterWorldWalk` | +0.21 | `animation/skinning/skeleton.cpp:153` |
| bone world walk | +0.18 | scene world walk |
| `writeBuffer` | +0.08 | palette upload |

Facts the levers rest on (PRD-872 Decisions, 2026-11-11):
- 84% of skeleton updates have an unchanged pose, but nothing records which bones a writer touched, so detecting it
  costs about 0.12 ms of the 0.21 ms it would save.
- All 480,000 `SkinnedPalette::writeRelative` calls refuse at `nodeMaterial` (`MeshStandardNodeMaterial` with no
  nodes), so the crowd palette is world-space and every walker's slot changes every frame; the VSM plan then treats
  all 240 rig casters as deforming (`planVirtualPages` 0.94 ms, 0.35-0.44 with `&noCrowd`).
- Unreal re-sends bone data only when the anim tick marks it dirty, never by compare: `UE 5.8.3:
  Engine/Source/Runtime/Engine/Private/Components/SkeletalMeshComponent.cpp:1249-1250`, `SkinnedMeshComponent.cpp:1514`
  (`MarkRenderDynamicDataDirty`); a moved component sends only its transform (`PrimitiveComponent.cpp:655-664`).

## Solution

1. **Writers stamp the pose.** Every bone-local write path (mixer evaluate, property binding, direct game writes)
   bumps a per-skeleton pose version. No compare, no fold.
2. **Root-relative palette for node materials** (parked Step A, `artifacts/stress-lab-audit/p872-stepA-relative-shadow-slot.patch`
   in the PR #659 worktree): a slot holds bones relative to the rig root; a walker that moves without a new pose
   writes only its root matrix. An unchanged pose version skips the palette write and the upload.
3. **The VSM plan reads the stamp**: a rig whose pose version did not change is a rigid mover, not deforming, so it
   keeps its cached box and pages like any rigid caster.
4. **Per-draw costs** in `renderPrepared` and `project` for skinned items: attribute first (sub-timers, then a
   same-binary A/B), then cut the largest one.
5. **JS animation and sync**: attribute the ≈0.9 ms on the JS side; cut what the engine can own.

## Validation scene

- Consumer and scene: the stress lab (`~/projects/threenative/sandbox-stress/stress-lab`), `main.html?stress` (benefit:
  120 walkers) and `main.html?stress&noCrowd` (control: no rigs, so the stamp and slot bookkeeping is charged with no
  benefit); a still crowd (`&still`, poses unchanged) is the best case and a fully animated crowd the worst.
- Staging: `artifacts/stress-lab-audit/tools/stage-lab.sh` builds a lab from a worktree and checks the served Wasm hash.
- Comparison: `fair-urls.sh` one uncapped fair window (ABBA, load gate), head against `81901d260`, RTX 2080, 1280x720.
- Bar: AC-1 to AC-3 below; debug stage split with `?tnDebug=1`; a visual judge on the walkers.

## Acceptance Criteria

- [ ] AC-1 [local, measure lane]: on the RTX 2080, `?stress` minus `?stress&noCrowd` frame p50 is 2.5 ms or less, two runs per arm, in one fair window. proof: ledger rows from `node scripts/stress-loop.mjs fair` — Evidence: pending.
- [ ] AC-2 [local]: `planVirtualPages` reads 0.5 ms or less on `?stress`. proof: the stage split — Evidence: pending.
- [ ] AC-3 [local]: head frame p50 is lower than PR #659's `81901d260` in both ABBA pairs, p95 no more than 5% worse, and a fresh visual judge reads NEUTRAL on the walkers (close-up and crowd, two runs per arm). proof: ledger rows and the verdict — Evidence: pending.

## Blocked on

- Nothing.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Pose version | mixer evaluate, property binding, bone writes → `Skeleton` | Replaces pose compare/fold for change detection | pending |
| Relative palette for node materials | `SkinnedPalette::writeRelative` on the crowd | Replaces world-space slots for node materials | pending |
| Plan reads the stamp | `planVirtualPages` caster state | Rig casters with an unchanged pose stop deforming | pending |

## Execution Phases

#### Phase 1: Writers stamp the pose; unchanged poses skip palette and plan work
**Status:** OPEN
- [ ] A per-skeleton pose version bumps on every bone-local write path and on nothing else. proof: a red-green `native-engine` case (write, no write, mixer evaluate, binding write).
- [ ] Step A lands: node materials with no nodes take the relative palette; an unchanged pose version skips the slot write and its upload. proof: red-green case on `SkinnedPalette`; `writeRelative` refusals 0 on `?stress` (debug).
- [ ] The VSM plan keeps an unchanged-pose rig as a rigid mover. proof: red-green `native_engine_vsm_caster_plan` case; `planVirtualPages` on `?stress`.

#### Phase 2: Per-draw cost of skinned items
**Status:** OPEN
- [ ] Attribution of `renderPrepared` +1.23 and `project` self +0.54 for skinned items, by sub-timer then same-binary A/B. proof: numbers under Decisions.
- [ ] The largest attributed cost is cut, or closed by decision with its ceiling under 0.3 ms. proof: red-green case if behaviour changes; probe numbers.

#### Phase 3: JS animation and sync
**Status:** DONE — attributed; every JS-ownable item is under the 0.3 ms floor, so no cut (Decisions, 2026-11-11).
- [x] Attribution of the ≈0.9 ms JS side of the crowd. proof: main-thread CPU profiles (200 µs sampling, 10 s; 3 runs `?stress`, 2 runs `&noCrowd`, head `6ed423488`, RTX 2080) — Evidence: crowd delta ≈0.8-0.9 ms, of which JS-ownable ≈0.25. `flushAnimationTicks → tn_anim_tick` +0.27 (≈0.04 glue, the rest C++ mixer evaluation); `SceneUpdate.apply → __tnUpdateMatrixWorld` +0.13-0.20 (C++ bone walk); `RenderCameraCull.prepareAnimation` rate bands +0.16 (≈0.10 JS); engine cull +0.11 (≈0.01 JS); lab walker loop +0.10 (core 0.03-0.06); reconcile +0.02. Bridge crossings 43 against 42; shared-transform writes 1,394 a frame, setter ≈0.02 ms. Trap: the `update` stage p50 is a rate artifact (fixed 60 Hz ticks land on ≈52% of crowd frames, ≈26% without).

## Decisions

- 2026-11-11 (Claude, lead): filed from PRD-872's measured breakdown; ships in PR #659 (one PR for the stress-lab chain).
- 2026-11-11 (Claude, lead, Phase 3): the box "cut the largest attributed JS cost" is removed as moot (R4). The largest
  JS-ownable lever, the rate-band loop, is ≈0.10 ms; all JS-ownable crowd work sums to ≈0.25 ms, under the 0.3 ms floor.
  The JS side's crowd cost is C++ work it calls: mixer evaluation (Phase 1's stamps let an unchanged pose skip it), the
  bone world walk and the cull, which visits 9,818 matrices against 1,298 without the crowd (a Phase 2 lead).

