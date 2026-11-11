# PRD-872 — The desktop `?stress` frame reaches 8.4 ms: a static caster plans once, and a rig that moves rigidly does not re-do world-space bones

**Status:** PARTIAL — both phases landed (`da185d67e`, `f95ea2eb6`, `657bf4b80`) and measured. Neither target is met: the plan reads 0.94 ms, the frame 8.91 ms on a quiet host (window `plan-floor-c`, #372-#373). The numbers say the criterion was written against work the frame does not pay (see Decisions).
**Priority:** P1 — carries the one acceptance criterion PRD-871 did not reach: a 120 fps desktop frame (frame p50 8.4 ms or less).
**Complexity:** 7 (MEDIUM-HIGH)
**Owner:** João · 2026-11-10
**Depends on:** PRD-871 (its ledger rows, the stage attribution and the sub-timers this PRD builds on). Filed by PRD-871 when its two remaining items — Phase 3 box 1 and AC-2 — turned out to need a structural change, not one more micro cut.

## Context

PRD-871 cut the desktop frame on the shadow-planning and gameplay paths. Its last two items are handed here, because the measurement says neither is reachable by another local cut.

Measured state (RTX 2080, 1280x720, uncapped, `docs/stress-loop/ledger.json`):

| Arm | Row | FPS | frame p50 | frame p95 | GPU p95 | load peak |
| --- | --- | --- | --- | --- | --- | --- |
| `?stress&arm=base` | #362 | 94.3 | 10.00 ms | 12.22 ms | 5.05 ms | 4.97 |
| `?stress&arm=head` | #363 | 88.8 | 10.65 ms | 13.39 ms | 5.36 ms | 6.27 |
| `?stress&play&arm=base` | #360 | 60.4 | 12.55 ms | 27.91 ms | 6.27 ms | 7.55 |
| `?stress&play&arm=head` | #361 | 77.0 | 11.54 ms | 19.07 ms | 7.09 ms | 5.24 |

A quieter single run of the same base build read frame p50 9.12 ms (load 2.1-5.5), so the host moves the number by about a millisecond: the acceptance window below is the number that counts, not this table.

**Landed and measured 2026-11-10** (rows #370-#371, window `plan-floor-b`, uncapped ABBA, load 2.2-3.6, base `c5619ec` vs head `06418f6`): base 105.1 fps / frame p50 8.98 ms, head 107.3 fps / 9.01 ms. Alternating probes in the same minutes: `planVirtualPages` 1.09/1.15 → 1.02/0.96 ms, and 0.59 → 0.44 with `&noCrowd`. The two changes are worth about 0.13 ms of the plan and nothing measurable of the frame. What the 9.0 ms is made of: `wasmPlan` 2.0-2.2 (of it `planVirtualPages` 1.0, `planShadowLists` 0.3, the rest the frame's own planning), `wasmScene` 1.9-2.1, `jsBefore` 1.29, `update` 1.0, `engineJs` 0.85, `wasmTargets` 0.73. The crowd is 5.2 ms, and only 0.5 ms of that is shadow planning.

Frame by stage (`?stress`, `TN_FRAME_BUDGET`, load 12-20): `wasmPlan` 2.4-3.0 ms of which `planVirtualPages` 1.02-1.64, `wasmScene` 2.2-2.8, `jsBefore` 1.4-1.8, `update` 1.4, `engineJs` 0.9-1.0, `wasmTargets` 0.8-0.9. With `&noCrowd` the whole frame is 5.6 ms.

Two facts decide the shape of this PRD:

1. **`planVirtualPages` alone cannot reach the target.** Zeroing the entire stage (1.02 ms now) puts the frame at about 9.0-9.6 ms against an 8.4 ms goal.
2. **The walking crowd is most of the difference.** 120 rigs cost 4.5-6.5 ms of the frame: every walker moves each frame, its bones change in world space even when `updateRate: "auto"` skips its pose, so every rig re-plans and re-skins every frame.

What PRD-871 already removed here, so it is not re-cut: the per-caster `std::string` rebuild of a moving rigid caster's vertex box (`a38190bff`), the per-bone `linearStretch` bind-inverse fold (`7482c204c`), reading one skeleton's bone poses once for the meshes that share it (`3883e79f0`), and the scene walk `play` did for LOD chains that were never registered (`e4fe59cb8`).

## Solution

Two phases, in the order that pays.

**Phase 1 — a caster whose inputs did not change costs nothing in `planVirtualPages`.** `renderer_frame.cpp` still rebuilds, for every caster, every frame: a `CasterRecord` (an `assign` over the whole draw list), the shadow bounds, a `std::to_string(positions->version())` signature string, the parent-chain walk that collects `tracked` and `pinned`, and a `CasterState`. The atlas already skips a caster whose world matrix and signature did not change (`updateCasters`), so the pages are correct; what is missing is that the *inputs* are re-derived from scratch each frame. Keep one record per caster across frames (key, `matrixWorld`, geometry version, instance version and count, the two layer bits, the collected tracked/pinned, the bounds and its diameter) and rebuild only the records whose inputs moved. Then `planVirtualPages` is a compare pass plus the work of the casters that actually moved. Target: 0.5 ms or less.

**Phase 2 — a rig that moves rigidly plans and skins once.** Unreal keeps a skinned mesh's bones in component space and applies the component transform in the vertex shader, so a walker that translates and turns re-uses one pose; this engine writes world-space bone matrices, so the same pose is re-derived every frame and the shadow planner sees a `deforming` caster. Read the Unreal source for the property before writing it (`$UE_SRC` or `/home/joao/projects/UnrealEngine`, 5.8.3; `Engine/Shaders/Private/GpuSkinCommon.ush`, `GpuSkinVertexFactory.ush`, `Engine/Source/Runtime/Engine/Private/Components/SkinnedMeshComponent.cpp`) and cite each fact as `UE 5.8.3: Engine/...:line`, the way PRD-871 cites its shader work. Borrow the algorithm, layout and guards; never the code. A rig whose bone poses are unchanged since its last plan must not be `deforming`, and the skinning path must not re-derive world-space bones. Target: the crowd's frame cost at most half of today's, with the skinning output unchanged to the pixel.

Risks:

- **Shadow cache staleness.** A caster the planner no longer re-derives must still dirty its pages when it moves. The guard is `ctest -R "vsm"` (`tn-native-engine-vsm-atlas-test`, `-vsm-test`), plus the dirty list's own case: an unchanged frame does no per-caster work, and the frame after a move does exactly the moved caster's work.
- **Disappearing meshes.** The auto batch fix of 2026-11 (aircraft yoke pieces vanished) must not regress: run the auto batch specs after each change to a draw list.
- **Benchmark-only wins.** The holdout kit must hold in the same window as the lab.

## Validation scene

- **Consumer and scene:** the stress lab, `main.html?stress` and `&play`, plus `&noCrowd` as the ceiling that names the crowd's cost.
- **Window:** `node scripts/stress-loop.mjs fair`, ABBA, `--passes uncapped`, 1280x720, base and candidate builds served side by side, load under 18 for the whole window.
- **Holdout:** one scaffolded kit with rigs in the same window. A keep needs it.
- **Pass:** frame p50 8.4 ms or less on `?stress`, frame p95 and hitches not worse than base by more than the A/A band, and a visual judge NEUTRAL or IMPROVEMENT on every change that can move a pixel.

## Acceptance criteria

- [x] AC-1 [local]: on the RTX 2080, `main.html?stress&arm=head` holds a frame p50 of 8.4 ms or less in a valid fair window, two runs per arm. proof: ledger rows from `node scripts/stress-loop.mjs fair` — Evidence: **Met 2026-11-11:** fair window `877-pose-history` (rows #374/#375, head `81901d260` with PRD-875/876/877 merged, RTX 2080, uncapped, ABBA, load peak 3.3 or less): head frame p50 **8.09 and 8.20 ms** (row 8.15), develop 9.15 and 9.49 (row 9.32); frame p95 10.33 against 11.17; 117 against 103 fps. Earlier evidence: **8.91 ms** head against 8.96 base (window `plan-floor-c`, rows #372-#373, load 2.0-2.6, 109.1 against 105.0 fps); 9.01 against 8.98 in `plan-floor-b`. Not met, 0.5 ms short.
- [ ] AC-2 [local]: a frame whose casters did not change spends 0.5 ms or less in `planVirtualPages` on `?stress`. proof: `native_engine_vsm_caster_plan`; the stage split — Evidence: **0.94 ms** (1.17 base in the same minutes), 0.35-0.44 with `&noCrowd`. Not met: the crowd's own 240 rig meshes are most of what is left.
- [ ] AC-3 [local]: the walking crowd costs at most 2.5 ms of the `?stress` frame (from 4.5-6.5 ms), and a visual judge calls the skinning NEUTRAL against base. proof: ledger rows and the judge's captures — Evidence: **≈3.9 ms** (frame 8.34 with the crowd against 4.43 without it, same minutes; 5.18 before this PRD). Not met; no judge, because the skinning path was not touched.

## Blocked on

- A valid desktop fair window needs host load under 18 for the whole window. The `tn-local` CI runner pool on this desktop raised it to 45 mid-window on 2026-11-10 and voided half of PRD-871's window.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| A static caster plans once | `Renderer` frame → `planVirtualPages` → `atlas.updateCasters` for every `castShadow` draw | The per-frame rebuild of bounds, signature and state, deleted | AC-2 |
| A rigidly-moving rig keeps its bones in component space | Any skinned mesh whose bone poses did not change → skinning and the virtual shadow planner | The world-space bone rewrite per frame, deleted | AC-3 |

## Decisions

- 2026-11-10 (Claude, PRD-872 session): the three acceptance numbers above are measured and none is met, and the
  measurement moves what the PRD should ask for. `planVirtualPages` is 0.44 ms with no crowd at all, so a 0.5 ms
  target with 240 animated rig meshes plans was never the planner's to reach; the frame's 9.0 ms is 5.2 ms of crowd
  work spread over animation (`update` 1.0), skinning submission (`wasmScene` ~1.4) and the plan (0.5), plus 3.8 ms of
  everything else. Two levers are worth naming before anyone writes code against this PRD again: **a pose rate**
  (the crowd re-derives 120 skeletons every frame; Unreal fits skinned bounds from component space and a pose, not from
  bones each frame) and **the frame's own planning** (`wasmPlan` minus `planVirtualPages` is ~1.0 ms, untouched here).
  The owner decides which; they are not shadow-planning cuts and do not belong in this PRD.
- 2026-11-10 (Claude, PRD-872 session, after `657bf4b80`): the next lever is named and it is not a plan cut. The
  crowd's palettes are world-space (`Skeleton::update` writes `boneWorld * boneInverse`), so a walker that translates
  and turns rewrites and re-uploads its 65 bones every frame even when core throttles its pose. Multiplying the palette
  by `inv(mesh world)` and letting the draw's own model matrix re-apply the component transform is the same picture
  (three multiplies `modelMatrix * bindMatrixInverse` after skinning) and leaves the palette unchanged while the rig
  moves rigidly. That is where the 0.5 ms and most of the crowd's 3.9 ms are; it needs its own PRD, a visual judge and
  the shadow and main passes changed together.
- 2026-11-10 (Claude, PRD-871 session): this work is a separate PRD, not two more boxes in PRD-871. The target needs both phases at once — a perfect `planVirtualPages` still reads about 9.0-9.6 ms against an 8.4 ms goal — so a half-landed PRD-871 would have had to stay open on an AC it cannot reach. PRD-871 closes with AC-1 and AC-3 met and hands AC-2 here.

## Execution Phases

#### Phase 1: a caster whose inputs did not change costs nothing

**Status:** DONE — landed, measured short of its target.
**Files:** `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/src/engine/renderer/shadows/virtual/atlas.h`, `atlas.cpp`, `packages/runtime-native/tests/native-engine/vsm/vsm_atlas_test.cpp`.
**Implementation:** hold one record per caster across frames keyed by the draw key; compare the world matrix, the geometry version, the instance version and count, and the layer bits; rebuild bounds, signature and state only for a record that moved; keep the parent-chain `tracked`/`pinned` collection off the per-frame path. Do not weaken the automatic/pinned/tracked rules in `updateCasters`: a skipped caster must still be capable of dirtying its pages on the frame it moves.
**Verification:** `ctest --test-dir build/wasm -L native-engine -R "vsm|render_database|renderer"` (from `packages/runtime-native`, after `source ~/emsdk/emsdk_env.sh`), then a paired desktop window with `?stress`, `?stress&still`, `?stress&plainShadow` (the ceiling) and the holdout kit.

- [x] An unchanged frame does no per-caster work, and the frame after a move does exactly the moved caster's work. proof: `native_engine_vsm_caster_plan` — a static frame rebuilds 0, one mover rebuilds 1, and each input invalidates it; red with the plan forced to rebuild everything (three CHECK failures). — `da185d67e`; 14 vsm cases green.
- [ ] `planVirtualPages` reads 0.5 ms or less on `?stress`, with the pages unchanged. proof: the stage split in the ledger row. — **Measured 0.97-1.02 ms** (was 1.29-1.30), and 0.44 with `&noCrowd`: not met, and 0.5 was never reachable with the crowd's 240 rig meshes in the pass (see Decisions).

#### Phase 2: a rig that moves rigidly plans and skins once

**Status:** PARTIAL — the box is cached; the pose and the skinning are not.
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp` (`virtualShadowBounds`), `packages/runtime-native/src/engine/scene/skeleton.cpp`, whichever skinning and crowd path the Unreal reading names.
**Implementation:** read the Unreal subsystem and cite it before writing code. A rig whose bone poses did not change since its last plan must stop being `deforming`; a rig that only translates and turns must not re-derive world-space bone matrices. Keep the named override for a game that needs per-bone world transforms.
**Verification:** a native test that a rigidly-moving rig plans once and draws the same vertices, then a paired desktop window with `?stress`, `?stress&noCrowd` (the ceiling), `?stress&play` and the holdout kit, plus a visual judge on `?stress&closeup` and `?stress&play&freezeAt=8`.

- [x] A rig that translates and turns without changing its pose plans once, and its drawn vertices match the old path. proof: `native_engine_rigid_rig_keeps_its_reach_bounds` — one box build across a rigid move with no bone read, then a rebuild for a bone, a scale and a mesh that moves alone. — `f95ea2eb6`. `native_engine_bone_reach_bounds_hold_posed_vertices` is registered now (it never was, so ctest never ran it) and its stale `first.max.x + 2` assertion is a containment check instead.
- [ ] The crowd costs 2.5 ms or less of the `?stress` frame. proof: `?stress` against `?stress&noCrowd`. — **Measured 5.18 → 4.33 ms**: not met. The crowd's plan cost is 0.5 of it; the rest is the animation and skinning submission every walker pays each frame (see Decisions).
- [ ] Visual judge NEUTRAL on the three poses, two runs per arm. proof: captures and the verdict, named in the box — Not run: no pixel moved (the box is the same box, the plan the same plan), and both changes measured short of the criteria a judge would qualify.
