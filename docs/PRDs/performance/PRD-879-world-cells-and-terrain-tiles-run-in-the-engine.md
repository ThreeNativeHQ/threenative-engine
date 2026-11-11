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

- [ ] AC-1 [local]: on the forest walk, per-frame JS in `world-*` and `compute-driven` falls to one engine call per system, and frame p50 is lower in both runs. proof: CPU profile before/after and the playtest's `TN_FRAME_BUDGET` — Evidence: pending.
- [ ] AC-2 [local]: the forest playtest passes and a fresh visual judge reads NEUTRAL on the walk and turn frames, two runs per arm. proof: `loop.playtest.json` exit 0 and the verdict — Evidence: pending.

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
- [ ] Measured per-frame JS cost of the world systems on the forest walk (profile). proof: numbers under Decisions.
- [ ] The admission drain (`#step` → swap → `SharedBatch.clear/write/#regroup`, 4.17 ms a frame on the walk) writes engine-owned instance buffers through one engine call; the JS drain is deleted. proof: red-green case, profile before/after.

#### Phase 2: Bind world cells
**Status:** OPEN
- [ ] `cullMainPass`'s visibility-cell loop (1.2-2.0 ms) and the refilter `#staleIn` scan (0.9-1.05 ms) each run as one engine call; the JS loops are deleted. proof: red-green case and the world-cells specs.
- [ ] Native parity: the V8 desktop player runs the same binding. proof: the native-engine label and a desktop run of the forest scene.
- [ ] A regression guard fails if core's world streaming runs its per-frame pass in JS again: one frame of `WorldCells.update` makes one engine call per system and runs no JS cell or tile loop. proof: the guard case red on the pre-change code, green after.

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

