# PRD-872 — The desktop `?stress` frame reaches 8.4 ms: a static caster plans once, and a rig that moves rigidly does not re-do world-space bones

**Status:** NOT STARTED
**Priority:** P1 — carries the one acceptance criterion PRD-871 did not reach: a 120 fps desktop frame (frame p50 8.4 ms or less). Today 10.00-10.65 ms.
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

- [ ] AC-1 [local]: on the RTX 2080, `main.html?stress&arm=head` holds a frame p50 of 8.4 ms or less in a valid fair window, two runs per arm. proof: ledger rows from `node scripts/stress-loop.mjs fair` — Evidence: pending (10.00-10.65 ms today, rows #362-#363 of PRD-871).
- [ ] AC-2 [local]: a frame whose casters did not change spends 0.5 ms or less in `planVirtualPages` on `?stress`. proof: a `vsm_atlas_test` case that counts per-caster work on an unchanged frame, red-green; the stage split in the ledger row — Evidence: pending (1.02-1.64 ms today).
- [ ] AC-3 [local]: the walking crowd costs at most 2.5 ms of the `?stress` frame (from 4.5-6.5 ms), and a visual judge calls the skinning NEUTRAL against base. proof: ledger rows and the judge's captures, named in the box — Evidence: pending.

## Blocked on

- A valid desktop fair window needs host load under 18 for the whole window. The `tn-local` CI runner pool on this desktop raised it to 45 mid-window on 2026-11-10 and voided half of PRD-871's window.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| A static caster plans once | `Renderer` frame → `planVirtualPages` → `atlas.updateCasters` for every `castShadow` draw | The per-frame rebuild of bounds, signature and state, deleted | AC-2 |
| A rigidly-moving rig keeps its bones in component space | Any skinned mesh whose bone poses did not change → skinning and the virtual shadow planner | The world-space bone rewrite per frame, deleted | AC-3 |

## Decisions

- 2026-11-10 (Claude, PRD-871 session): this work is a separate PRD, not two more boxes in PRD-871. The target needs both phases at once — a perfect `planVirtualPages` still reads about 9.0-9.6 ms against an 8.4 ms goal — so a half-landed PRD-871 would have had to stay open on an AC it cannot reach. PRD-871 closes with AC-1 and AC-3 met and hands AC-2 here.

## Execution Phases

#### Phase 1: a caster whose inputs did not change costs nothing

**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer_frame.cpp`, `packages/runtime-native/src/engine/renderer/shadows/virtual/atlas.h`, `atlas.cpp`, `packages/runtime-native/tests/native-engine/vsm/vsm_atlas_test.cpp`.
**Implementation:** hold one record per caster across frames keyed by the draw key; compare the world matrix, the geometry version, the instance version and count, and the layer bits; rebuild bounds, signature and state only for a record that moved; keep the parent-chain `tracked`/`pinned` collection off the per-frame path. Do not weaken the automatic/pinned/tracked rules in `updateCasters`: a skipped caster must still be capable of dirtying its pages on the frame it moves.
**Verification:** `ctest --test-dir build/wasm -L native-engine -R "vsm|render_database|renderer"` (from `packages/runtime-native`, after `source ~/emsdk/emsdk_env.sh`), then a paired desktop window with `?stress`, `?stress&still`, `?stress&plainShadow` (the ceiling) and the holdout kit.

- [ ] An unchanged frame does no per-caster work, and the frame after a move does exactly the moved caster's work. proof: a `vsm_atlas_test` case, red-green on the count.
- [ ] `planVirtualPages` reads 0.5 ms or less on `?stress`, with the pages unchanged. proof: the stage split in the ledger row; `ctest -R "vsm"` green.

#### Phase 2: a rig that moves rigidly plans and skins once

**Status:** NOT STARTED
**Files:** `packages/runtime-native/src/engine/renderer/renderer.cpp` (`virtualShadowBounds`), `packages/runtime-native/src/engine/scene/skeleton.cpp`, whichever skinning and crowd path the Unreal reading names.
**Implementation:** read the Unreal subsystem and cite it before writing code. A rig whose bone poses did not change since its last plan must stop being `deforming`; a rig that only translates and turns must not re-derive world-space bone matrices. Keep the named override for a game that needs per-bone world transforms.
**Verification:** a native test that a rigidly-moving rig plans once and draws the same vertices, then a paired desktop window with `?stress`, `?stress&noCrowd` (the ceiling), `?stress&play` and the holdout kit, plus a visual judge on `?stress&closeup` and `?stress&play&freezeAt=8`.

- [ ] A rig that translates and turns without changing its pose plans once, and its drawn vertices match the old path. proof: a native test, red-green.
- [ ] The crowd costs 2.5 ms or less of the `?stress` frame. proof: `?stress` against `?stress&noCrowd` in one window, both arms in ledger rows.
- [ ] Visual judge NEUTRAL on the three poses, two runs per arm. proof: captures and the verdict, named in the box.
