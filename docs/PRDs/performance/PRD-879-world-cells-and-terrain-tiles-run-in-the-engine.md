# PRD-879 — World cells and terrain tiles run their frame in the engine

**Status:** OPEN — filed 2026-11-11 from the PRD-878 discovery probes.
**Priority:** P1 — core's world streaming runs its whole per-frame pass in JS while the C++ engine already holds a tested twin that no game reaches.
**Complexity:** 8 (HIGH) — core world files and the C++ world module (+3), streaming state across frames (+3), one build boundary: the C++ engine serves native and web Wasm (+2). Risk override: none.
**Owner:** João · 2026-11-11
**Depends on:** None. Ships in PR #659 (owner: one PR for this chain).

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) and `PERFORMANCE-LEARNINGS.md` first.
C++ paths are under `packages/runtime-native/src/engine/`; JS paths under `packages/core/src/`.

## Context

Owner, 2026-11-11: "whatever else is on JS tahts not game scripting should move to C++". A read-only discovery probe
(DeepSeek, `~/.cache/tmp-tn/prd878-hunt/out/core.md`, rows checked by the lead) found core's world streaming doing its
per-frame work in JS:

- `world-tiles.ts:917` `TerrainTiles.process` and `#seamPass` (`:1925`, `world-tile-observation.ts:156`): a new `Map`
  and a loop over every resident tile each frame; probe estimate ≈3 ms a frame at a 289-tile ring (unverified).
- `world-cell-render-main-cull.ts:169` `cullMainPass`, `world-cell-chunks.ts:752` `stepCellProxies`,
  `world-cell-render.ts:580` `publishCasterAdmission`, `world-cell-impostors.ts:624` `stepImpostor`: loops over every
  visibility cell, resident cell and batch part, from `WorldCells.update` (`world-cells.ts:1130`).

The engine already has the twin: `world/tiles/terrain_tiles.cpp:737` `TerrainTiles::process`, `:517` `seamPass`,
`world/cells/world_cells.cpp:345` `WorldCells::update`, with `tests/native-engine/world/world_tiles_test.cpp` and
`world_cells_test.cpp`. No ABI binding reaches them from `packages/three-native` or the web engine, so every game pays the
JS path, and the two copies can drift.

## Solution

Bind `WorldCells::update` and `TerrainTiles::process` through the ABI as one engine call a frame each. Core's
`WorldCells` keeps its public API and becomes a thin owner of engine handles: residency, culling, proxies, caster
admission, impostor stepping and seams run in C++. The JS loops are deleted (no fallback, owner rule). JS keeps only
what needs a browser API (fetch of tile bytes, GPU readback callbacks) and game callbacks, each named under Decisions.

## Validation scene

- Consumer: `examples/strata-terrain-preview` forest (`loop.playtest.json`), served with `TN_ENGINE=threenative`,
  `TN_PLAYTEST_HOST_DISPLAY=1 --headed --browser-recipe webgpu` on the RTX 2080 (Xvfb gives SwiftShader). Control: a
  scene with no world cells (the stress lab `?stress`) charges the binding's bookkeeping with no benefit.
- Comparison: same-binary before/after, two runs per arm, `?tnDebug=1` stage split (`computeDrivenMs`, frame p50/p95),
  plus a main-thread CPU profile of the walk and turn.

## Acceptance Criteria

- [ ] AC-1 [local]: on the forest walk, per-frame JS in `world-*` and `compute-driven` falls to one engine call per system, and frame p50 is lower in both runs. proof: CPU profile before/after and the playtest's `TN_FRAME_BUDGET` — Evidence: PARTLY MET — frame p50 is lower in both runs (walk 10.43/10.03 -> 6.71/6.54 ms before the final lane; final lane `WorldCells.update` walk 1.98/3.62 -> 2.78/2.65 ms is inside run noise), and the cull, material witness, records and stale scan are one engine call each (guard `world-cells-main-cull.spec`). NOT MET for the drain's bookkeeping (placement building, segment maps, settle/regroup) which still runs per record in JS, so the "one engine call per system" clause fails. Left open for that box.
- [x] AC-2 [local]: the forest playtest passes and a fresh visual judge reads NEUTRAL on the walk and turn frames, two runs per arm. proof: `loop.playtest.json` exit 0 and the verdict — Evidence: the forest playtest `loop.playtest.json` exits 0, 0, 0 on the final tree (`TN_PROGRAM_LATE` 0, `TN_HOT_CALL` 0, travel 58.5 m, adapter turing). Fresh Opus visual judge (read-only, criteria set before viewing) on the 8 walk and turn captures in `~/Downloads/prd-879-final/` (BEFORE/AFTER, 2 runs per arm): NEUTRAL on all four pairs; the two run 2 BEFORE frames show a different spot on the walk, so they are weak evidence, and AFTER run 2 matches BEFORE run 1 as a second same-place comparison. A faint vertical dark striping appears in all 8 frames, before and after. Not judgeable from stills: pop-in over time, hitches.

## Blocked on

- Nothing.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `WorldCells::update` binding | core `WorldCells.update` each compute frame | Deletes the JS cull, proxies, caster admission, impostor step | pending |
| `TerrainTiles::process` binding | core terrain tiles each frame | Deletes the JS process and seam pass | pending |

## Execution Phases

#### Phase 1: Measure and bind terrain tiles
**Status:** OPEN
- [x] Measured per-frame JS cost of the world systems on the forest walk (profile). proof: numbers under Decisions — Evidence: the 2026-11-11 measured-walk decision (two baseline runs, owned engine, RTX 2080).
- [x] The admission drain (`#step` → swap → `SharedBatch.clear/write/#regroup`, 4.17 ms a frame on the walk) writes engine-owned instance buffers through one engine call; the JS drain is deleted. proof: red-green case, profile before/after. — Evidence: `f075d0c5a` (SharedBatch keeps bookkeeping only; `WorldCells.update` flushes the frame's record ops in one `InstancedBufferAttribute.__tnRecords` call that writes the engine buffers and upload ranges; JS holds no instance bytes; the three.js arm runs the twin `applyRecords`). Red-green `native_engine_abi_world_records`. Profile, owned engine, RTX 2080, 2 runs per arm: drain 4.17/4.16 → 1.48/1.88 ms; what remains is JS bookkeeping (swap, `clearSegment`, `addPlacements`) with no byte loop. The SharedBatch `TN_BRIDGE_WARNING` is gone.

#### Phase 2: Bind world cells
**Status:** OPEN
- [x] `cullMainPass`'s visibility-cell loop runs as one engine call; the JS per-cell loop is deleted. proof: red-green `native_engine_abi_frustum_intersects_boxes` and `world-cells-main-cull.spec` ("tests every visibility cell in one engine call") — Evidence: `2a8174815` (`Frustum.__tnIntersectsBoxes`), plus `59599292c` (the bundle proof's material flags in one call, red-green `native_engine_abi_material_witness`, `world-bundle-safety.spec`). Profile, 2 runs: main cull walk 1.20/1.23 → 0.74/0.54 ms, turn and idle 2.08/1.49 → 0.80/0.59; `WorldCells.update` turn and idle 2.49/1.81 → 1.11/0.86. Merged tree: 23 world spec files, 274 tests pass; native-engine label 678/678 (lane tree). Visual judge NEUTRAL on walk and turn (one after-run framed differently, traced to the walk's travel nondeterminism, open under AC-2).
- [x] The refilter `#staleIn` scan (0.86-1.05 ms on the walk) runs as one engine call over packed entry state. proof: red-green case and a profile. — Evidence: `73893489d` (per-cell packed rows, one `Object3D.__tnStaleEntries` call a pass) and `51b6c26c0` (the engine keeps the rows, sent only when a cell changes; a scan with no rows throws `TN_WORLD_STALE`). Red-green `native_engine_abi_world_stale_entries`, `world-cell-stale.spec`, and "refuses an engine scan that cannot be handed its rows". Profile, 2 runs: `#collectStale` 0.84/1.02 → 0.51/0.55 ms.
- [ ] The drain's JS bookkeeping (≈1.5 ms on the walk: swap, `clearSegment`, `addPlacements`, per-record segment maps) and the slab pack (0.30 ms on swap frames) run in the engine. proof: red-green case and a profile before/after. — Partial, `bf82ade5c` + `e6a565e65`: the slab pack sends only the changed cell blocks (`__tnStaleRows(blocks, plan)`; red-green spec "sends the engine's stale rows only the cell blocks that changed" and `native_engine_abi_world_stale_entries`; `#packSlab` 0.166/0.298 → 0.084/0.092 ms), and a placement's box is one closed-form measure (`#boundsAt` 0.120/0.191 → 0.009/0.005 ms; guard counts `Box3.applyMatrix4`: 5556 → 0). Open: placement building, segment maps, `#settle`/`#regroup`, `settleRecords` stay in JS; moving them rewrites how `InstancedBatch` stores matrices (over 300 lines). `WorldCells.update` walk 1.98/3.62 → 2.78/2.65 ms is inside run noise (≈80% spread).
- [x] The forest playtest exits 0 on three runs in a row after `d65499f4f` (pointer-lock refusal reported, not thrown). proof: three `loop.playtest.json` exit codes. — Evidence: exit 0, 0, 0 after `d65499f4f` on the RTX 2080 (adapter turing), `TN_PROGRAM_LATE` 0, `TN_HOT_CALL` 0, travel 58.5 m. Runs on the procedural fallback trees exited 1 (walk blocked by a tree, `TN_TSL_TYPE` in the impostor bake); the temperate `local-assets` must be present.
- [ ] Native parity: the V8 desktop player runs the same binding. proof: the native-engine label and a desktop run of the forest scene. — Partial: the native-engine label passes 680/680 in a V8 engine-player tree at `51b6c26c0`, and a scratch V8-player bundle calls `__tnRecords`, `__tnStaleRows` and `__tnStaleEntries` with the native case's answers. Open: the desktop forest run cannot start, because `bundle-native-engine` refuses `strata-terrain-preview` with `TN_NATIVE_ENGINE_UNBOUND` (GLTFLoader with KTX2, Draco and meshopt; SkyMesh; ImprovedNoise; five TSL nodes; RedFormat/ASTC). That port is its own work, outside this PRD's files.
- [x] A regression guard fails if core's world streaming runs its per-frame pass in JS again: one frame of `WorldCells.update` makes one engine call per system and runs no JS cell or tile loop. proof: the guard case red on the pre-change code, green after. — Evidence: `be6a49d37` + `73893489d`: `world-cells-main-cull.spec` "PRD-879 guard" drives a load and a walk on fake engine calls and fails on more than one cull, records or stale call a frame, a JS instance upload or a JS box test. Red on `573a65a7b`, red with the JS drain restored, red with the JS scan restored; green at `51b6c26c0`. Merged tree (`327f1f6fb`): 75 spec files, 1,077 tests pass; 7 ABI cases pass; the registry dump equals `native-registry.json`; typecheck clean.

## Decisions

- 2026-11-11 (Claude, lead): filed from the owner's "move engine JS to C++" direction and the core probe; the world
  systems are their own PRD because they are not crowd work (PRD-878) and carry their own validation scene.
- 2026-11-11 (owner, João: "make sure this is fixed and proven fixed"): the PRD closes only with all four proofs run — the
  profile before/after, the forest playtest exit 0, a fresh visual judge, the native-engine label plus a desktop run — and
  the regression guard. Any proof that cannot run stays an open box with the reason, never a pass.
- 2026-11-11 (lane prd879-world, measured; lead decision): the forest walk profile (owned engine, RTX 2080, 2 runs)
  corrects the probe. `TerrainTiles.process`, `#seamPass` and `follow` take 0 samples on walk and turn (the frame checks
  the epoch only; the "3 ms" came from a stale code comment), so binding terrain tiles is removed as moot (R4).
  `WorldCells.update` costs 6.69/6.89 ms a frame on the walk and 1.81-2.49 on turn and idle: the admission drain
  4.17/4.16, `cullMainPass` 1.20-2.08, the refilter `#staleIn` 0.86-1.05; proxies, caster admission, impostor step,
  restore and shadow tells are each ≤0.013 ms. The C++ `WorldCells::update` covers residency, refilter and job levels
  only (no main cull, proxies, admission or batch buffers), so the binding is a port, not a switch. The baseline
  playtest already exits 1 (`TN_PROGRAM_LATE` console errors, the `GameState.travel` sample); both are fixed at their
  layer as part of AC-2.

