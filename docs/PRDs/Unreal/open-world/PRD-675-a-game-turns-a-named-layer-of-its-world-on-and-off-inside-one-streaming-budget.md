---
prd_contract: v1
---

# PRD-675 — A game turns a named layer of its world on and off inside one streaming budget

**Status:** NOT STARTED
**Priority:** P3 — Phase 1 is open: no game or template asks to switch part of a streamed world at runtime, and two `WorldCells` instances are the untested workaround.
**Complexity:** 5 (MEDIUM) — 6–10 files: `world-cells.ts`, specs, an example scenario, the native world cells, a conformance or `--target` playtest (+2), a per-layer state machine that crosses frames (+2), native proof (+1); risk override: none
**Owner:** João
**Depends on:** None. Uses the shipped admission budget in `packages/core/src/world-cells.ts` and the readiness report of [PRD-606](PRD-606-a-fast-travel-destination-is-ready-before-the-cover-lifts.md) when that ships. Composes with [PRD-459](../../open-world/PRD-459-smooth-streaming-one-admission-budget-per-frame.md): a layer spends the same admission budget, never its own.

## Context

**Unreal LOC:** the feature map counts World Partition and HLOD at 70,618 lines, editor code
included. Data layers are `Engine/Source/Runtime/Engine/{Private,Public}/WorldPartition/DataLayer/`,
9,590 lines, much of it editor-only. **Port estimate:** about 400 to 600 ThreeNative lines: about 250
in `packages/core/src/world-cells.ts`, about 200 of specs and a scenario, and about 150 of C++ in
the native world cells.

### What Unreal does (UE 5.8.3, read 2026-10-21; clean-room summary, no code copied)

- **A runtime data layer has three states:** unloaded, loaded (in memory but not in the world), and
  activated (in the world and visible).
  `UE 5.8.3: Engine/Source/Runtime/Engine/Public/WorldPartition/DataLayer/DataLayerInstance.h:22-33`.
  Runtime layers are separate from editor-only layers.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Public/WorldPartition/DataLayer/DataLayerType.h:8-15`.
- **A streaming cell carries the set of data layers of its actors.** A cell with no layers always
  wants "activated". A cell with layers resolves its wanted state from the layer states, and caches
  it until any layer state changes (an epoch counter).
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartitionRuntimeCell.cpp:156-178`.
- **Several layers on one cell combine with OR by default.** Any activated layer activates the cell.
  Otherwise any loaded layer loads it. An AND rule exists as a setting. An external data layer caps
  the highest state the cell can reach.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartitionRuntimeHash.cpp:841-892` and
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartition.cpp:404`.
- **Distance and layer state meet in one query.** A cell inside a streaming source's range is
  skipped when its layers say unloaded. It is loaded when its layers say loaded, and activated
  otherwise. Non-spatial cells follow their layer state alone.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/RuntimeHashSet/WorldPartitionRuntimeHashSet.cpp:682-686, 737-741`.
- **A game can ask whether streaming is complete for a layer state.** The query skips cells whose
  wanted state differs only because of layers it did not ask about.
  `UE 5.8.3: Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartitionStreamingPolicy.cpp:1159-1225`.

### ThreeNative today

- `WorldCells.load` streams one `world.json` package around one `follow` target
  (`packages/core/src/world-cells.ts:391-420`). A package has no layer field.
- The admission budget is per instance and per `update` (`AdmissionBudget`,
  `world-cells.ts:4107-4140`, opened at `world-cells.ts:5106` and `5163`). Two instances spend two
  budgets in the same frame.
- Each instance owns its own GPU scene dispatch, its own ring, and its own residency counts.
- There is no "loaded but not drawn" state for a package: turning a second instance on starts its
  loads at that moment.
- The 2026-10-12 parity review did not file data layers: "Data layers have no consumer, and two
  `WorldCells` instances already cover the case" (`docs/PRDs/Unreal/README.md`). The Machinefall
  runbook says the same (`docs/PRDs/open-world/RUNBOOK-machinefall-120fps-with-fab-quality.md:283`).
  Phase 1 tests that claim with numbers.

## Solution

**This is mechanism only.** A layer is an ordinary `world.json` package that the game names. This
PRD adds no field to the package format, so no new scene format is opened.

| Unreal piece | ThreeNative module | Layer |
| --- | --- | --- |
| Runtime data layer with three states | `WorldCells.load({ ..., layers: { <name>: { url, state } } })` and `world.setLayerState(name, "unloaded" \| "loaded" \| "active")` | `packages/core/src/world-cells.ts` |
| Cell wanted state from layers, cached by epoch | A layer cell's wanted state is the lower of its ring state and its layer state. A layer change bumps one epoch, and only that layer's cells re-resolve | `world-cells.ts` |
| Loaded but not in the world | "loaded" builds batches and holds GPU-scene records with the draw masked off, and makes no colliders. "active" unmasks the records and admits colliders | `world-cells.ts`, `packages/core/src/world-gpu-scene.ts` |
| One streaming query | Every layer shares the base package's ring, `follow`, admission budget and GPU scene, so one frame spends one budget | `world-cells.ts` |
| Streaming complete for a layer state | `readinessAt` gains an optional layer name | `world-cells.ts` (PRD-606 surface) |
| OR and AND across layers per actor | Not ported. A placement belongs to exactly one package, so it has one layer | none |
| Native | The same states in the native world cells | `packages/runtime-native/src/engine/world/cells/world_cells.cpp` |

**Honest reporting:** `world.stats()` names each layer, its state, its resident cells and the admission
time it spent.

## Acceptance Criteria

- [ ] AC-1 [local]: Switching a layer from "loaded" to "active" while walking adds no frame over the walk's CPU p95 plus 2 ms, and the layer's cells in range draw within 2 frames. proof: the Phase 3 scenario through `node packages/playtest/dist/runner/cli.js` with `TN_FRAME_BUDGET` — Evidence: pending.
- [ ] AC-2 [local]: Across the same walk, the base package and its layers together never spend more than one admission limit plus one unit in a frame. proof: the `admission` field of `world.stats()` sampled by the Phase 3 scenario — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| `WorldCells` layers | `examples/strata-terrain-preview/src/render/propStreaming.ts` → `WorldCells.load({ layers })` and a scenario step that calls `setLayerState` | Replaces a second `WorldCells` instance for the same ring | Phase 3, AC-1 |
| Layer readiness | `readinessAt(position, radius, { layer })` | Extends the PRD-606 report | Phase 2 |

## Execution Phases

#### Phase 1: Do two instances fail where one layered world would not?
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/src/render/propStreaming.ts` (a measurement branch, no shipped change)
- [ ] A second `WorldCells` instance (a prop package, `terrain: false`) is created mid-walk beside the base world. The frames where the two admission spends together pass one limit, the frames from creation to its cells in range drawing, and the extra GPU-scene dispatch time are recorded under `## Decisions`. proof: `node packages/playtest/dist/runner/cli.js perf` with `TN_FRAME_BUDGET` and `world.stats()` sampled per frame, 3 runs, RTX 2080 browser WebGPU lane.
- [ ] The gate verdict is recorded. Gate: continue when a template or sandbox game asks to switch part of its world at runtime, or when the two-instance switch puts a frame over the walk's CPU p95 plus 4 ms, or takes more than 1 s to draw cells already in range. Otherwise defer, and revisit when a game asks for runtime world variants (time-of-day props, quest state, a destroyed town). proof: the Phase 1 perf runs.

#### Phase 2: Layers in the core world cells
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`, `packages/core/src/world-gpu-scene.ts`, `packages/core/__tests__/world-cells.spec.ts`
- [ ] A layer cell's state is the lower of its ring state and its layer state, for every pair of the three states, and a layer change re-resolves only that layer's cells. proof: `pnpm exec vitest run packages/core/__tests__/world-cells.spec.ts`.
- [ ] A "loaded" layer holds its GPU-scene records but draws none of them and makes no colliders. "active" draws them, and the base package and its layers spend one admission budget per update. proof: `pnpm exec vitest run packages/core/__tests__/world-cells.spec.ts`.

#### Phase 3: A scenario, then native
**Status:** NOT STARTED
**Files:** `examples/strata-terrain-preview/src/render/propStreaming.ts`, `examples/strata-terrain-preview/playtests/layer-switch.playtest.json` (new), `packages/runtime-native/src/engine/world/cells/world_cells.cpp`
- [ ] The `layer-switch` scenario walks, switches a layer through all three states, and asserts AC-1 and AC-2 on the browser. proof: `node packages/playtest/dist/runner/cli.js examples/strata-terrain-preview/playtests/layer-switch.playtest.json --url <url> --browser-recipe webgpu`.
- [ ] The same scenario passes on the desktop native host. proof: `node packages/playtest/dist/runner/cli.js examples/strata-terrain-preview/playtests/layer-switch.playtest.json --target desktop`.
**Verification:** AC-1 and AC-2.
