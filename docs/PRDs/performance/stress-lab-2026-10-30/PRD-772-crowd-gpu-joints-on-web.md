# PRD-772 — Animated rigs take the GPU joint path on the web engine

**Status:** PARTIAL — cause found and a fix is built in a lane worktree, with no paired browser proof yet.
**Priority:** P1 — the crowd is the largest measured CPU cost of the stress frame, and every web game with animated characters pays it (Phases 1-2).
**Owner:** João · 2026-10-30
**Depends on:** PRD-770 Phase 1 for the paired A/B.

## Why

- **Cost.** On the stress lab, `?stress&noCrowd` removed about 8.5 ms from an 18 ms frame on the older develop
  (`hunt/HUNT-main4.md`).
  - Bones: 1.6 ms. Subtree walk: 0.87 ms. Mixer: 0.65 ms. JS rig step: 1.06 ms.
  - The bone palettes upload about 1 MB per frame.
- **The GPU joint path exists but no rig takes it.** The engine has `Renderer::prepareGpuJoints` and `GpuJointScene`
  (`packages/runtime-native/src/engine/renderer/renderer.cpp`).
  - Real-GPU counters on :5744 (lane `crowd-gpu-joints`, 2026-10-30 05:14Z) read: admitted 0, refused 240, skeleton
    updates 240 per frame.
- **Cause.**
  - The admission rule refuses an escaped SkinnedMesh, and the stress crowd escapes it twice.
  - Core's stride preparation reads every property of a walker. That read escapes the walker.
  - Core turns `scene.matrixWorldAutoUpdate` off. That escapes the manual-world Scene root.
- **Earlier attempt.** Lane FC1 (`.worktrees/stress-fix-fc1`) relaxed two other rules: the Armature node hop and two
  primitives per mesh node. The browser showed no gain: 33.6 fps against 35.1/35.9. Main draws went 147 to 156, long
  tasks 912 to 3069, and load took 60 s.
- **Unreal reference.** Unreal skins on the GPU by default. The skin cache mode is a console variable,
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/GPUSkinCache.cpp:105` (`r.SkinCache.Mode`).

## Validation scene

- **Consumer and scene:** the stress lab, `main.html?stress`. 120 mannequin walkers with `Walk_Loop`, 65 joints, and
  2 primitives per mesh node.
- **Window:** the PRD-770 fair window on the RTX 2080 at 1280x720.
- **Benefit workload:** `?stress`.
- **Worst-case control:** a rig whose armature moves away from its placement, which must stay on the CPU path.
- **Inactive control:** `?stress&still`.
- **Pass:**
  - CPU frame p50 lower by more than 3% in both ABBA pairs.
  - Load time no worse than develop plus 10%.
  - Visual judge NEUTRAL on `?stress&closeup`.

### Phase 1 — admit the crowd, with proof in the engine

- [ ] Waste counters publish rigs admitted to GPU joints, rigs refused with the first reason, and CPU skeleton updates per frame, through `TN_FRAME_BUDGET.counters.engine`. proof: `tn-native-engine-render-database-test` case
- [ ] An escaped rig, placement, Armature hop or Scene root is admitted. It stays CPU-eager and is re-checked every frame. proof: native red-green case, red on develop
- [ ] A rig whose armature moves away from the placement's frame stays on the CPU path. proof: native case

### Phase 2 — prove it in the browser

- [ ] On `?stress` the counters read 240 admitted, 0 refused, and `Skeleton::updateAfterWorldWalk` is absent from the main-thread profile. proof: `measure.sh` JSON
- [ ] Paired A/B against develop: CPU frame p50 lower by more than 3% in both pairs, and load time within develop plus 10%. proof: ledger rows from the PRD-770 window
- [ ] Visual judge NEUTRAL or IMPROVEMENT on `?stress&closeup`, 2 runs per arm. proof: judge JSON

## Blocked on

- Nothing outside the repo.

## Decisions

- 2026-10-30, coordinator: race FC1b (DeepSeek, `.worktrees/stress-fix-fc1`) and FC1s (`.worktrees/stress-fix-fc1s`).
  Keep the one with the paired gain.
  - FC1s holds the escaped-rig admission change. It was building at 05:14Z when the session hit its usage limit.
  - TA1 (`.worktrees/stress-fix-ta1`) moves crowd animation into one JobPool batch, and is measured after the admission fix.
