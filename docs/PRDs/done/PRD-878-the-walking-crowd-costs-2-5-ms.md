# PRD-878 — The walking crowd costs 2.5 ms of the desktop frame

**Status:** DONE — 2026-11-11, closed at the measured values by the owner (João: option 1); the open bars moved to [PRD-881](../performance/PRD-881-the-crowds-engine-stages-fit-2-5-ms.md).

Executor: read [EXECUTION-ORDER.md](../performance/EXECUTION-ORDER.md) and `PERFORMANCE-LEARNINGS.md` first.
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

- [x] AC-3 [local]: head frame p50 is lower than PR #659's `81901d260` in both ABBA pairs, p95 no more than 5% worse, and a fresh visual judge reads NEUTRAL on the walkers (close-up and crowd, two runs per arm). proof: ledger rows and the verdict — Evidence: frame clauses MET, judge NEUTRAL — ledger rows 376-381: head p50 below `81901d260` in both ABBA pairs (`?stress` 7.41 vs 8.66 and 8.09 vs 9.78; `&noCrowd` 3.78 vs 4.81 and 4.32 vs 5.31; `&still` 7.31 vs 8.91 and 7.54 vs 9.28), mean p50 9.22 → 7.75, p95 11.50 → 10.60 (−8%, not worse), GPU upload 1,191 → 638 KB a frame. Fresh Opus visual judge (read-only, criteria set before viewing), walker close-up and crowd, 2 runs per arm, BEFORE `81901d260` vs AFTER `ee22d38c7`, images in `~/Downloads/prd-878-final/`: all four pairs NEUTRAL (pairs differ at 0.06-0.2% of pixels; an ember burst in BEFORE-run2-crowd is scene timing). Noted, not a failure: the HUD shadow draws read 15 -> 5 with no shadow missing in the stills; the likely cause is the held-pose rigid-mover shadow plan (`c036de53d`, `99268408e`, judged NEUTRAL earlier), not proven per commit. Motion, shadow temporal stability and rim/bloom cannot be judged from stills.

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
**Status:** DONE — 2026-11-11, lane prd878-pose, merged into PR #659.
- [x] A per-skeleton pose version bumps on every bone-local write path and on nothing else. proof: a red-green `native-engine` case (write, no write, mixer evaluate, binding write). — Evidence: `6adcccdc2` cherry-picked; red-green `native_engine_skeleton_pose_version`. Merged tree: native-engine label 687/687 (player cases under `scripts/xvfb.sh`).
- [x] Step A lands: node materials with no nodes take the relative palette; an unchanged pose version skips the slot write and its upload. proof: red-green case on `SkinnedPalette`; `writeRelative` refusals 0 on `?stress` (debug). — Evidence: Step A plus slot reuse, and node materials admitted by a fail-closed graph check (allowlist by node kind; game `nodeUniform<n>` and ten listed camera, screen and clock uniforms only; `normalMatrix`, `bindMatrix` and unknown engine uniforms refuse). Red-green `native_engine_skinned_relative_slot_keeps_an_unchanged_pose`. Upload sends only changed 4x4s (red-green `native_engine_unchanged_frame_storage`: one moved bone 576 → 64 bytes). A held pose skips the skeleton's world palette update (red-green `native_engine_held_pose_skips_the_world_palette`: 8 → 0 updates a walking frame; a prop under a bone still follows). On `?stress` (tnDebug, ABBA): refusals 240 → 0; changed palette bytes p50 998,400 → 363,520; `bufferUploadBytes` 1,228,400 → 523,504-551,984; skip A/B wasmScene −0.18 and −0.25 ms in 2 of 3 pairs. Frame time unverified: two fair windows VOID on host load. judges (fresh Opus, read-only): close-ups NEUTRAL (64 frames), per-matrix upload close-ups NEUTRAL, shadows on open lit ground NEUTRAL (64 frames, walking and held-pose sliding; the slide pairs match almost to the pixel).
- [x] The VSM plan keeps an unchanged-pose rig as a rigid mover. proof: red-green `native_engine_vsm_caster_plan` case; `planVirtualPages` on `?stress`. — Evidence: `99b2b604a` cherry-picked; red-green `native_engine_vsm_caster_plan`. `planVirtualPages` on `?stress` (tnDebug ABBA): 1.30/1.25 → 0.76/0.92 ms. Shadow judge NEUTRAL (above).

#### Phase 2: Per-draw cost of skinned items
**Status:** DONE — the cuts that held are merged; the remainder moved to PRD-881.
- [x] Attribution of `renderPrepared` +1.23 and `project` self +0.54 for skinned items, by sub-timer then same-binary A/B. proof: numbers under Decisions — Evidence (2026-11-11, lane prd878-draw, lean steady_clock marks on the main view, 100-frame block means, RTX 2080, load 5-9): `project` +1.11 ms with the crowd (7,800 bone visits a frame: 0.26 by A/B; skinned item build, skeleton update and bone cache misses ≈0.85 by subtraction); `renderPrepared` +1.06 (VSM plan +0.42, palette place copy/hash +0.22, shadow build +0.19, uploads +0.16, other +0.06). Trap: per-item clock scopes cost ≈0.5 µs a read in threads Wasm and inflate scoped items 2-3x.
- [x] The largest attributed cost is cut, or closed by decision with its ceiling under 0.3 ms. proof: red-green case if behaviour changes; probe numbers — Evidence: `09b844cd5` — a bone whose subtree holds only bones ends `RenderDatabase::project` (cached by id and `subtreeVersion()`; UE 5.8.3: Engine/Source/Runtime/Engine/Private/SkeletalRender.cpp:524 keeps bones in the component's transform array). Red-green `native_engine_bone_chains_are_not_projected` (35 visits → 4; a mesh and a light held by a bone still appear and leave on time). Same-binary A/B, skip toggled every 100 frames, 3 runs: `project` 1.44/1.60/1.49 → 1.18/1.32/1.22 ms (−0.26). Full native-engine label 677/677. No pixel can change (a bone-only subtree draws and lights nothing).
#### Phase 3: JS animation and sync
**Status:** DONE — rate bands and hook picking merged; the inventory and the remaining moves moved to PRD-881.
- [x] Attribution of the ≈0.9 ms JS side of the crowd. proof: main-thread CPU profiles (200 µs sampling, 10 s; 3 runs `?stress`, 2 runs `&noCrowd`, head `6ed423488`, RTX 2080) — Evidence: crowd delta ≈0.8-0.9 ms, of which JS-ownable ≈0.25. `flushAnimationTicks → tn_anim_tick` +0.27 (≈0.04 glue, the rest C++ mixer evaluation); `SceneUpdate.apply → __tnUpdateMatrixWorld` +0.13-0.20 (C++ bone walk); `RenderCameraCull.prepareAnimation` rate bands +0.16 (≈0.10 JS); engine cull +0.11 (≈0.01 JS); lab walker loop +0.10 (core 0.03-0.06); reconcile +0.02. Bridge crossings 43 against 42; shared-transform writes 1,394 a frame, setter ≈0.02 ms. Trap: the `update` stage p50 is a rate artifact (fixed 60 Hz ticks land on ≈52% of crowd frames, ≈26% without).
- [x] The animation rate bands (`RenderCameraCull.prepareAnimation`, ≈0.16 ms with the crowd) run in C++: one engine call a frame, the rig check and band loop out of JS. proof: a red-green case (native-engine or spec) and the main-thread profile before/after — Evidence: `09ff8372c` (`scene.__bandAnimation` answers [id, rate] pairs; rig check, reach test, 32-rig hold and band loop in C++; a freed rig answers [id, -1]; a nested rig keeps the JS walk), `fe16d870d` (no call with no tracked rig), `ead15e1ff` (handle words kept, not re-parsed: writeHandle 0.052 → 0.013 ms). Red-green ctest `native_engine_abi_projected_cull_band_animation` and two core specs. Profile, 5 base / 2 head runs: `prepareAnimation` JS 0.12-0.15 → 0.03-0.05 ms, JS plus C++ 0.16-0.22 → 0.11-0.18. Merged tree: 99 specs pass (three-native and render-camera-cull), 4 ABI cases pass, the registry dump equals the committed `native-registry.json`.

## Decisions

- 2026-11-11 (owner, João: "option 1"; lead): the PRD closes at the measured values and its open bars move to [PRD-881](../performance/PRD-881-the-crowds-engine-stages-fit-2-5-ms.md) (R4). AC-1 (`?stress` minus `&noCrowd` frame p50 at 2.5 ms or less) read 3.70 ms in fair window `fwfinal` (ledger rows 376-379; base `81901d260` 4.16 ms) and AC-2 (`planVirtualPages` at 0.5 ms or less) read 0.79-0.89 ms (base 1.20-1.26 ms). The stage attribution below shows the largest crowd row is the lab's own `update` (game scripting), so PRD-881 restates AC-1 over the engine-owned stages (about 3.3 ms now, bar 2.5 ms) and keeps the 0.5 ms bar for `planVirtualPages`. The Phase 2 remainder (bone array, palette alloc leftovers, draw-item copy) and the Phase 3 inventory proposals also moved to PRD-881. The bars were not relaxed to fit the numbers; the PRD closes on what it landed: AC-3 (frame p50 lower in every ABBA pair, 9.22 -> 7.75 ms, p95 -8%, judge NEUTRAL).

- 2026-11-11 (lead, DeepSeek discovery arm, measured; for the owner's decision on AC-1): where the head build's crowd cost goes. `?stress&tnDebug=1` minus `?stress&noCrowd&tnDebug=1`, A B B A, idle RTX 2080 (nvidia turing), medians of per-window p50 over 16-17 windows per arm: frame +4.53 ms (9.74 vs 5.21; the debug flag adds a little to the fair window's 3.70). By stage: `update` +1.42 (JS main thread, the lab's own `Stress.update` calling `AnimationPlayer.update` per walker, `animation.ts:1306`; game scripting, so engine work reaches only the `AnimationPlayer` share), `wasmScene` +1.31 (`render_database.cpp:2009`, `prepare()` at `:1686`), `wasmPlan` +0.91 (`renderer_frame.cpp:6`; `planVirtualPages` +0.30, `planShadowLists` +0.16), `jsBefore` +0.75, residual +0.11, `engineJs` +0.09; GPU p50 +1.67 (crowd 4.80 vs 3.13), which runs beside the CPU rows. Engine-owned CPU rows sum to about 3.3 ms, so even with `update` excluded 2.5 ms needs about 0.8 ms more engine cut, and the largest single row is the game's. Report: `~/.cache/tmp-tn/prd878-handoff/out/crowd-attribution.md`. Options for AC-1: (a) keep 2.5 ms and fund the next lever (`wasmScene` walk, `jsBefore`, an `AnimationPlayer` batch in `tn_anim_tick`), (b) re-state AC-1 over engine stages only, with a follow-up PRD.

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
- 2026-11-11 (lane prd878-js, round 3, merged as `4609d6e7d`, `4638da4b9`, `55a33150e`): a render reads its frame numbers from one engine snapshot (51 host calls → 1), and `tn_tsl_reads` makes a post quad or dispatch run only the uniform hooks its graphs read (render callbacks 1,690 → 48 a frame; `live.sync` 0.698 → 0.132 ms). ABBA, 2 runs per arm: `&noCrowd` frame 6.08/5.09 → 4.19/4.59 ms, `engineJs` 0.95/0.78 → 0.39/0.41; `?stress` `engineJs` 0.92/1.02 → 0.63/0.74 (frame p50 noise-dominated). Red-green `native_engine_abi_tsl_reads` and four specs. Judge NEUTRAL on 32 `?stress` frames; weak evidence for the backlight rim, bloom response and exposure adaptation (5-10 px walkers, 0.8 s bursts from a settled exposure). Open: a cold-start burst that crosses a light change. Rows kept in JS with reasons: `collect` (JS wrapper lifetime), compute-driven readback (browser API), surface reads, audio, shadow LODs and static transforms (below 0.01 ms in the lab; unverified on a consumer). Still ≥0.05 ms and not moved: auto-exposure, bloom and local-exposure `updateBefore` plus the gA quad render (0.14 / 0.25 / 0.08 / 0.40, per-draw wrapper cost), physics plugin update 0.136, `AnimationPlayer` 0.068. These stay open under Phase 3 box 2.

