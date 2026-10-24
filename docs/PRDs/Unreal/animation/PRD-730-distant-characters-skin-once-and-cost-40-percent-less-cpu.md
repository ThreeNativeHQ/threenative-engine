---
prd_contract: v1
---

# PRD-730 — Distant characters skin once and cost 40% less CPU

**Status:** DEFERRED — split from [PRD-570](PRD-570-a-character-costs-what-the-camera-sees-of-it.md) on 2026-10-23 (owner decision). Revisit when a skin-once pass is designed for both the web and the owned native engine; the RAW GPU pose stays the opt-in `gpuPose` until then.
**Priority:** P2
**Complexity:** 7 (HIGH) — GPU storage pass on two backends (+3), velocity-history lifetime (+2), CPU measurement on a loaded host (+2)
**Owner:** João
**Depends on:** [PRD-570](PRD-570-a-character-costs-what-the-camera-sees-of-it.md) (shipped cadence policy and the opt-in RAW GPU pose).

## Context

PRD-570 shipped visibility-driven animation cadence (`updateRate: "auto"`) and a RAW GPU pose path
that evaluates a held rig's pose from keyframes in the vertex stage. Two results kept it from closing:

- **CPU:** the original AC needs at least 40% less CPU in `AnimationPlayer.update` plus
  `SkinnedBatch.write` for a 128-rig crowd. The 2026-10-23 Intel gen-12lp flight measured paired
  reductions of 15.4% and 13.2% (PRD-570 `## Decisions`, 2026-10-23).
- **GPU:** RAW re-evaluates the pose per vertex in the main and shadow passes. Conservative
  held-minus-static bounds are 2.7 / 10.3 / 13.8 ms at 32 / 128 / 256 rigs, far above PRD-570's
  0.5 ms skin-once trigger.

PRD-570 therefore made RAW an opt-in (`gpuPose: true` on `AnimationPlayer` / `SkeletalMesh3D`,
default off) so the default path ships no GPU regression. This PRD owns the remaining work.

## Solution

1. **Skin once.** A pass writes each RAW rig's pose (or skinned position and previous position)
   into storage once per frame. The batch's `positionNode` and the velocity history read it in
   every pass. The pass skips a rig whose palette was not written this frame. It must run on the
   web renderer and on the owned native engine. Unreal ships the same design on by default: its GPU
   skin cache skins in a compute job instead of the vertex shader (`r.SkinCache.Mode` 1,
   UE 5.8.3: Engine/Source/Runtime/Engine/Private/GPUSkinCache.cpp:103-112).
2. **Requalify RAW on.** With skin-once in place, re-fly PRD-570's six-arm CPU and twelve-arm GPU
   matrices from one build. When the GPU bound falls below 0.5 ms and the judge passes, `gpuPose`
   defaults on.
3. **Keep the 40% bar.** The threshold, cadence table and assertions stay as PRD-570 defined them.

## Acceptance Criteria

- [ ] AC-1 [local]: A 128-rig `SkeletalMesh3D` crowd receding to 120 m spends at least 40% less CPU in `AnimationPlayer.update` plus `SkinnedBatch.write` than the rate-1 arm, from one build. proof: `examples/skinned-crowd/playtests/crowd-rate.playtest.json` through `node packages/playtest/dist/runner/cli.js ... --browser-recipe webgpu` with `playtest perf`, adapter named.
- [ ] AC-2 [local]: With `gpuPose` on by default, the crowd's main-plus-shadow GPU time stays within 0.5 ms of the static arm at 32/128/256 rigs, and the velocity-history assertions stay green. proof: `crowd-rate.playtest.json` perf arms and `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`.

## Execution Phases

#### Phase 1: Skinning runs once per frame

- [ ] [local] A skin-once pass feeds the main and shadow passes on web and native; velocity history follows the drawn pose. proof: red-green cases in `packages/core/__tests__/projection-skinned.spec.ts` and a native renderer test.
- [ ] [local] The crowd's main-plus-shadow GPU time falls against PRD-570's RAW arm. proof: `crowd-rate.playtest.json` perf arms at 32/128/256 rigs, adapter named.

#### Phase 2: CPU and motion acceptance

- [ ] [local] AC-1 passes. A fresh judge subagent compares 10 m, 40 m and 120 m captures against rate 1 and finds no visible loss, including temporal smoothness. proof: `crowd-rate.playtest.json` plus matched headed WebGPU captures.
- [ ] [local] `gpuPose` defaults on once AC-2 holds; the templates' `AGENTS.md` names the override. proof: `pnpm exec vitest run packages/core/__tests__/projection-skinned-packets.spec.ts` and the shooter template suite.

## Decisions

- 2026-10-23: split from PRD-570 by owner decision ("Ship safe, defer rest"). Deferred, not declined: revisit when a skin-once pass is designed for both backends.
