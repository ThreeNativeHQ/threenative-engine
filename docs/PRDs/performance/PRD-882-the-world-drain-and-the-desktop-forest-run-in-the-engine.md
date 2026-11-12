# PRD-882 — The world drain and the desktop forest run in the engine

**Status:** OPEN — filed 2026-11-11 from the PRD-879 close-out (owner, João: option 1).
**Priority:** P1 — the forest walk still runs about 1.5 ms of per-record bookkeeping in JS a frame, and the desktop player cannot run the forest at all.
**Complexity:** 8 (HIGH) — core world batch files and an `InstancedBatch` storage change (+3), streaming state across frames (+3), native port of the forest's loader, sky and TSL needs (+2). Risk override: none.
**Owner:** João · 2026-11-11
**Depends on:** [PRD-879](../done/PRD-879-world-cells-and-terrain-tiles-run-in-the-engine.md).

Executor: read [EXECUTION-ORDER.md](./EXECUTION-ORDER.md) and `PERFORMANCE-LEARNINGS.md` first.
C++ paths are under `packages/runtime-native/src/engine/`; JS paths under `packages/core/src/`.

## Context

PRD-879 moved the world cull, the material witness, the record bytes and the stale scan into one engine call each, and the
slab pack now sends only changed cell blocks. Left in JS (`~/.cache/tmp-tn/prd878-handoff/world.md`): the drain's
per-record bookkeeping around `world-cell-residency.ts:526/:615`, `world-cell-render.ts:304/:1278`,
`world-cell-batches.ts:561/:630/:779/:996/:1027/:1047` and `world-cell-placements.ts:273` (placement building, segment maps,
settle/regroup), about 1.5 ms a walk frame. Moving them rewrites how `InstancedBatch` stores its matrices (over 300 lines).
`WorldCells.update` on the walk read 1.98/3.62 ms before and 2.78/2.65 after the final lane, inside run noise (spread about 80%).

The V8 desktop player cannot run the forest: `bundle-native-engine` refuses `strata-terrain-preview` with `TN_NATIVE_ENGINE_UNBOUND`
(GLTFLoader with KTX2, Draco and meshopt; SkyMesh; ImprovedNoise; five TSL nodes; RedFormat/ASTC).

## Solution

Own the drain's per-record state in the engine behind the existing one-call-a-frame binding, then bind the forest's
remaining browser-only pieces so `native:verify:desktop` can walk it.

## Validation scene

- Consumer: `examples/strata-terrain-preview` forest (`loop.playtest.json`), `TN_ENGINE=threenative`, `TN_PLAYTEST_HOST_DISPLAY=1 --headed --browser-recipe webgpu`, RTX 2080 (recipe in the PRD-879 Decisions). Control: a scene with no world cells.
- Comparison: same-binary before/after, two runs per arm, a main-thread CPU profile of the walk and turn; the desktop run through `--target desktop`.

## Acceptance Criteria

- [ ] AC-1 [local]: on the forest walk, `WorldCells.update` runs one engine call per system and no JS per-record loop, and frame p50 is lower in both runs. proof: CPU profile before/after and `TN_FRAME_BUDGET` — Evidence: pending.
- [ ] AC-2 [local]: the desktop player walks the forest scene and the playtest exits 0, with a fresh visual judge NEUTRAL against the browser frame. proof: `--target desktop` exit code and the verdict — Evidence: pending.

## Execution Phases

#### Phase 1: The drain in the engine
**Status:** OPEN
- [ ] `InstancedBatch` keeps its matrices in the engine, and placement building, segment maps and settle/regroup run there; the JS per-record loops are deleted. proof: red-green case (extend the PRD-879 guard in `world-cells-main-cull.spec.ts` plus a native-engine ctest) and a profile before/after.

#### Phase 2: The desktop forest
**Status:** OPEN
- [ ] The forest's loader, sky and TSL needs run in the V8 desktop player. proof: `bundle-native-engine` accepts `strata-terrain-preview` and a desktop run walks it.
- [ ] The native-engine label and the desktop forest playtest pass on the same tree. proof: `ctest -L native-engine` and the `--target desktop` exit code.

## Blocked on

- Nothing.
