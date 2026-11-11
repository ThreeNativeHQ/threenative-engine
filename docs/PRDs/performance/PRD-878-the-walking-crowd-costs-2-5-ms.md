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
**Status:** IN PROGRESS — attributed; the bone-chain cut landed (`09b844cd5`); the skinned item build and bone memory work is open.
- [x] Attribution of `renderPrepared` +1.23 and `project` self +0.54 for skinned items, by sub-timer then same-binary A/B. proof: numbers under Decisions — Evidence (2026-11-11, lane prd878-draw, lean steady_clock marks on the main view, 100-frame block means, RTX 2080, load 5-9): `project` +1.11 ms with the crowd (7,800 bone visits a frame: 0.26 by A/B; skinned item build, skeleton update and bone cache misses ≈0.85 by subtraction); `renderPrepared` +1.06 (VSM plan +0.42, palette place copy/hash +0.22, shadow build +0.19, uploads +0.16, other +0.06). Trap: per-item clock scopes cost ≈0.5 µs a read in threads Wasm and inflate scoped items 2-3x.
- [x] The largest attributed cost is cut, or closed by decision with its ceiling under 0.3 ms. proof: red-green case if behaviour changes; probe numbers — Evidence: `09b844cd5` — a bone whose subtree holds only bones ends `RenderDatabase::project` (cached by id and `subtreeVersion()`; UE 5.8.3: Engine/Source/Runtime/Engine/Private/SkeletalRender.cpp:524 keeps bones in the component's transform array). Red-green `native_engine_bone_chains_are_not_projected` (35 visits → 4; a mesh and a light held by a bone still appear and leave on time). Same-binary A/B, skip toggled every 100 frames, 3 runs: `project` 1.44/1.60/1.49 → 1.18/1.32/1.22 ms (−0.26). Full native-engine label 677/677. No pixel can change (a bone-only subtree draws and lights nothing).
- [ ] The remaining skinned cost in `project` (≈0.85 ms: skinned item build, skeleton update, bone cache misses) and the shadow build (+0.19) are attributed per item and cut, largest first. proof: same-binary A/B per cut and a red-green case for each behaviour change.

#### Phase 3: JS animation and sync
**Status:** OPEN — attributed; reopened by the owner on 2026-11-11: per-frame engine JS that is not game scripting moves into C++ (Decisions).
- [x] Attribution of the ≈0.9 ms JS side of the crowd. proof: main-thread CPU profiles (200 µs sampling, 10 s; 3 runs `?stress`, 2 runs `&noCrowd`, head `6ed423488`, RTX 2080) — Evidence: crowd delta ≈0.8-0.9 ms, of which JS-ownable ≈0.25. `flushAnimationTicks → tn_anim_tick` +0.27 (≈0.04 glue, the rest C++ mixer evaluation); `SceneUpdate.apply → __tnUpdateMatrixWorld` +0.13-0.20 (C++ bone walk); `RenderCameraCull.prepareAnimation` rate bands +0.16 (≈0.10 JS); engine cull +0.11 (≈0.01 JS); lab walker loop +0.10 (core 0.03-0.06); reconcile +0.02. Bridge crossings 43 against 42; shared-transform writes 1,394 a frame, setter ≈0.02 ms. Trap: the `update` stage p50 is a rate artifact (fixed 60 Hz ticks land on ≈52% of crowd frames, ≈26% without).
- [x] The animation rate bands (`RenderCameraCull.prepareAnimation`, ≈0.16 ms with the crowd) run in C++: one engine call a frame, the rig check and band loop out of JS. proof: a red-green case (native-engine or spec) and the main-thread profile before/after — Evidence: `09ff8372c` (`scene.__bandAnimation` answers [id, rate] pairs; rig check, reach test, 32-rig hold and band loop in C++; a freed rig answers [id, -1]; a nested rig keeps the JS walk), `fe16d870d` (no call with no tracked rig), `ead15e1ff` (handle words kept, not re-parsed: writeHandle 0.052 → 0.013 ms). Red-green ctest `native_engine_abi_projected_cull_band_animation` and two core specs. Profile, 5 base / 2 head runs: `prepareAnimation` JS 0.12-0.15 → 0.03-0.05 ms, JS plus C++ 0.16-0.22 → 0.11-0.18. Merged tree: 99 specs pass (three-native and render-camera-cull), 4 ABI cases pass, the registry dump equals the committed `native-registry.json`.
- [ ] Every per-frame engine JS function (`packages/core`, `packages/three-native`; not game scripts) costing 0.05 ms or more on `?stress` or `&noCrowd` runs in C++, or is listed under Decisions with the reason it must stay JS (browser API, a game callback). proof: the profile inventory before/after (`jsBefore`, `engineJs`).

## Decisions

- 2026-11-11 (Claude, lead): filed from PRD-872's measured breakdown; ships in PR #659 (one PR for the stress-lab chain).
- 2026-11-11 (Claude, lead, Phase 3): the box "cut the largest attributed JS cost" is removed as moot (R4). The largest
  JS-ownable lever, the rate-band loop, is ≈0.10 ms; all JS-ownable crowd work sums to ≈0.25 ms, under the 0.3 ms floor.
  The JS side's crowd cost is C++ work it calls: mixer evaluation (Phase 1's stamps let an unchanged pose skip it), the
  bone world walk and the cull, which visits 9,818 matrices against 1,298 without the crowd (a Phase 2 lead).
- 2026-11-11 (owner, João: "can we move this animation rate bands to C++ too? whatever else is on JS tahts not game
  scripting should move to C++"): Phase 3 reopens. The 0.3 ms floor does not apply to these moves: the goal is that
  per-frame engine work runs in the C++ engine that serves native and web Wasm, so the JS around engine calls
  (`jsBefore` 0.66 ms and `engineJs` 0.78 ms a frame even with `&noCrowd`) shrinks to game code and single calls.
  Lead's note: the rate bands alone are ≈0.10 ms of JS; the payoff is the whole inventory.
- 2026-11-11 (owner, João: "fix whatever is left dont leave anything behind"): the per-draw work below the 0.3 ms
  floor stays in scope; Phase 2 gains a third box for the remaining ≈0.85 ms in `project` and the shadow build.

