---
prd_contract: v1
---

# PRD-570 — A character costs what the camera sees of it

**Status:** NOT STARTED
**Priority:** P2 — AC-1 is open: every rig evaluates its full pose every frame, near or far, on screen or off. Phase 1 has not yet measured how much that costs.
**Complexity:** 5 (MEDIUM) — 1–5 engine files (`animation.ts`, `projection-skinned.ts`, `render-camera-cull.ts`) (+1), skipped-frame accumulation and interpolation state carries across frames (+2), a skin-once compute pass is a new mechanism, gated by Phase 1 (+2); risk override: none
**Owner:** João
**Depends on:** None. Coordinate with [PRD-486](../../open-world/PRD-486-characters-get-a-lod-chain.md): its posed-bounds rule (Phase 2) is the bound this PRD reads when that lands, and its mannequin crowd is a shared subject.

## Context

Every animated character pays its full cost every frame:

- `AnimationPlayer.update(dt)` (`packages/core/src/animation.ts:734-741`) calls `mixer.update(dt)`
  on every call. The documented pattern calls it every frame
  (`packages/core/src/index.ts:80-89`, `SkeletalMesh3D` extends `AnimationPlayer`,
  `skeletal-mesh.ts:16`). Nothing reads distance or visibility. The term frame-skip appears nowhere
  in the animation sources.
- `SkinnedBatch.write` (`packages/core/src/projection-skinned.ts:357`) runs one matrix product per
  bone per rig, then uploads the palette (`:404-405`). It runs for every claimed rig. The batch
  draw sets `frustumCulled = false` (`:274`) and `instanceCount = this.used` (`:401`), so every rig
  draws, including rigs off screen.
- Skinning runs in the vertex stage of every pass that draws the batch. The position node blends 4
  palette matrices per vertex, and the velocity history blends 4 more (`projection-skinned.ts:251-267`).
  Main, shadow and any other pass each repeat it. three 0.185.1 ships an opt-in compute skinning helper
  (`computeSkinning`, `three/build/three.webgpu.js:18926`), which nothing in `packages/core/src` or
  the templates calls. It serves three's own `SkinnedMesh`, not `SkinnedBatch`.

Subjects: the shooter's soldiers (`templates/shooter/src/entities/Enemy.ts`, `SkeletalMesh3D`, five
per scene), the action-rpg fighters, and `examples/skinned-crowd`. The crowd drives 64 rigs through
raw `AnimationMixer` (`examples/skinned-crowd/src/scenes/Crowd.ts:92-105`), so it does not reach
`AnimationPlayer` today.

### What Unreal does (UE 5.8.3, read 2026-10-09)

- **Update and evaluation are separate rates** (update-rate optimization, URO). Each skinned
  component chooses rates from its state
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp:283-370`):
  - A human-controlled character, or one that needs root motion every frame, always runs at rate 1
    while visible.
  - A rig that was not recently rendered evaluates at `BaseNonRenderedUpdateRate`, default 4: one
    frame evaluated, then three skipped.
  - A visible rig picks its rate from its screen size, the same "distance factor" its LOD uses.
    The defaults are thresholds 0.24 and 0.12: above 0.24 every frame, above 0.12 every second
    frame, below that every third (`Classes/Engine/EngineTypes.h:2770-2785, 2820-2826`). A map from
    LOD to frame skip can replace the thresholds (`EngineTypes.h:2787-2794`).
- **Skipped time is not lost.** The rate logic adds an offset per character to the global frame
  counter (`ShiftBucket`, `EngineTypes.h:2693-2723`). This staggers characters, so they do not all
  evaluate on the same frame. A character that skips longer than its rate is forced to update, so
  a rate change cannot starve it
  (`SkinnedMeshComponent.cpp:6066-6100`).
- **Interpolation is limited.** Skipped frames blend toward the last evaluated pose by
  `1 / framesToNextEval`. Interpolation turns off at evaluation rates of `MaxEvalRateForInterpolation`
  (default 4) or above (`SkinnedMeshComponent.cpp:6066-6077, 6154-6165`; `EngineTypes.h:2821`).
- **Unreal ships URO off.** `bEnableUpdateRateOptimizations = false` per component
  (`Private/Components/SkeletalMeshComponent.cpp:493`). This repository's rule is the opposite
  (conventions ship on, with a named override), so this PRD turns it on by default and reports it.
- **Skin once, read in every pass.** The GPU skin cache skins in a compute shader into a buffer that
  depth, velocity, shadow and the base pass then read instead of skinning again
  (`UE 5.8.3: Engine/Source/Runtime/Engine/Public/GPUSkinCache.h:5, 13-19`). On higher-end platforms
  it also writes tight posed bounds for instance culling (`Private/GPUSkinCache.cpp:205-215`).

## Solution

1. **Measure first (Phase 1).** On a crowd driven through `SkeletalMesh3D` at mixed distances,
   attribute the CPU cost of `AnimationPlayer.update` plus `SkinnedBatch.write`, and the GPU vertex
   cost of skinning in each pass. The Phase 2 and Phase 3 gates read these numbers.
2. **Rate by what the camera sees (Phase 2), in core, on by default.**
   - `AnimationPlayer.update(dt)` always accumulates `dt`. It calls `mixer.update(accumulated)` only
     on its evaluation frames, so clip time, fades, `finished` events and stride sync see the same
     total time.
   - The rate comes from the projected size that `render-camera-cull.ts` already computes for the
     player's root. Rigs not drawn last frame use the not-rendered rate.
   - The thresholds are a starting table, recorded in the PRD and tuned by the Phase 2 visual gate.
     They are not constants for the game to revisit.
   - Each player gets a stable stagger offset. A forced evaluation follows any skip that runs longer
     than the rate.
   - Rate 1 always: the camera's own target, root-motion players
     (`animation-root-motion.ts`), and any player with `updateRate: 1`.
   - The named override is `updateRate: "auto" | number` on the player. Every non-auto choice is
     reported.
   - A skipped frame leaves the palette slot unwritten, so `SkinnedBatch.write` is skipped too.
     Interpolation is added only if the Phase 2 judge rejects the plain trail at rate 2.
3. **Skin once (Phase 3), only if Phase 1 shows skinning is at least 0.5 ms of GPU across passes on
   the crowd.** A compute pass writes skinned position and previous position into storage once per
   frame. The batch's `positionNode` and the velocity history read it in every pass. Otherwise the
   phase is declined under `## Decisions`, and the measurement is the record.

Scout lead dropped: an earlier review warned that `maxStorageBuffersInVertexStage` might default
to 0 and break the palette read. The limit exists only in Dawn's `CompatibilityModeLimits`
(`packages/runtime-native/third_party/dawn/dawn-headers/include/dawn/wire/client/webgpu_cpp.h:4546-4565`),
which is compatibility mode, not the core WebGPU that this engine requests.

## Acceptance Criteria

- [ ] AC-1 [local]: A 128-rig `SkeletalMesh3D` crowd receding to 120 m spends at least 40% less CPU in `AnimationPlayer.update` plus `SkinnedBatch.write` than the rate-1 arm, from one build. proof: new `examples/skinned-crowd/playtests/crowd-rate.playtest.json` through `node packages/playtest/dist/runner/cli.js ... --browser-recipe webgpu` with `playtest perf`, adapter named.
- [ ] AC-2 [local]: The shooter's soldiers keep their gameplay behavior: the existing shooter playtests stay green with the policy on. proof: `pnpm test:templates` for shooter.

## Blocked on

- An Android frame-time claim for the crowd needs the Pixel 8, because the emulator cannot hold a performance claim. Unblocked when João attaches the device.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Visibility-driven evaluation rate | game `update(dt)` → `SkeletalMesh3D.update` / `AnimationPlayer.update` (`animation.ts:734`) → `mixer.update` on evaluation frames | Every-frame evaluation; rate 1 stays as the named override | Phase 2, AC-1 |
| Skipped palette writes | projection reconcile → `SkinnedBatch.write` (`projection-skinned.ts:357`) | Unconditional per-rig write | Phase 2, AC-1 |
| Skin-once compute (conditional) | `SkinnedBatch` position node → storage written once per frame | Per-pass vertex-stage skinning, or declined by Phase 1's numbers | Phase 3 |

## Execution Phases

#### Phase 1: The cost is measured
**Status:** NOT STARTED
**Files:** `examples/skinned-crowd/src/scenes/Crowd.ts` (a `SkeletalMesh3D` crowd arm), `examples/skinned-crowd/playtests/crowd-rate.playtest.json` (new)
- [ ] [local] The crowd scenario reports CPU milliseconds for `AnimationPlayer.update` and `SkinnedBatch.write` at 32, 128 and 256 rigs, with the result recorded under `## Decisions`. proof: `crowd-rate.playtest.json` with `playtest perf` and span probes.
- [ ] [local] The same scenario reports GPU milliseconds for skinned draws in the main and shadow passes, against an arm where the crowd is static. The result decides Phase 3 under `## Decisions`. proof: the same playtest, both arms, `TN_FRAME_BUDGET` `main`/`shadow` buckets.

#### Phase 2: Rigs evaluate at the rate their screen size earns
**Status:** NOT STARTED
**Files:** `packages/core/src/animation.ts`, `packages/core/src/projection-skinned.ts`, `packages/core/src/render-camera-cull.ts`, `packages/core/__tests__/animation-rate.spec.ts` (new)
- [ ] [local] Accumulated `dt` keeps clip time, fade progress and the `finished` event identical to rate-1 playback over 300 frames, and a forced evaluation follows any skip longer than the rate. proof: red-green cases in `pnpm exec vitest run packages/core/__tests__/animation-rate.spec.ts`.
- [ ] [local] Stagger offsets spread 128 rigs so that the evaluations in any one frame stay within 1.5× of the mean. Root-motion and `updateRate: 1` players never skip. proof: the same spec.
- [ ] [local] AC-1 passes. A fresh judge subagent compares 10 m, 40 m and 120 m captures against rate 1 and finds no visible loss. proof: `crowd-rate.playtest.json` plus `pnpm visuals:ab --before <rate1> --after <auto> --out <dir>`.
- [ ] [local] The native desktop host runs the crowd scenario with the policy on. proof: `node packages/playtest/dist/runner/cli.js examples/skinned-crowd/playtests/crowd-rate.playtest.json --target desktop`.

#### Phase 3: Skinning runs once per frame, if Phase 1 earns it
**Status:** NOT STARTED
**Files:** `packages/core/src/projection-skinned.ts`, `packages/core/src/render/velocity.ts`, `packages/core/__tests__/projection-skinned.spec.ts`
- [ ] [local] With the skin-once pass, the crowd's main-plus-shadow GPU time falls against Phase 1's arm, and the existing velocity-history assertions stay green. If Phase 1 shows less than 0.5 ms, the decline is recorded under `## Decisions` instead. proof: `crowd-rate.playtest.json` perf arms and `pnpm exec vitest run packages/core/__tests__/projection-skinned.spec.ts`.
