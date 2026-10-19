# PRD-607 — Streaming reports when a hole is near and spends more to close it

**Status:** NOT STARTED
**Priority:** P2 — the only streaming health signal is a raw unit count, and the admission budget stays at 2 ms even when the next missing cell is under the player (this PRD's own open outcome).
**Complexity:** 5 (MEDIUM) — 1–5 implementation files (`world-cells.ts`, the probe, one spec) (+1), a new derived state read by the response and by games (+2), the response touches the admission budget that PRD-477 also derives (+1), native proof reuses the desktop flythrough host (+1). Risk override: none.
**Owner:** unassigned
**Depends on:** None. Respects [PRD-459](../../open-world/PRD-459-smooth-streaming-one-admission-budget-per-frame.md) (nearest-first admission stays) and [PRD-477](../../open-world/PRD-477-worldcells-auto-on-measured-budgets.md) (any automatic base budget feeds the ramp here). Shares the `?tile=4` probe option with [PRD-606](PRD-606-a-fast-travel-destination-is-ready-before-the-cover-lifts.md). Whichever PRD lands first adds it.

## Context

`WorldCells` admits streamed content nearest first, under a fixed per-update budget. It reports the cost of the last update and the work left over (`stats().admission`, `world-cells.ts:903-912`). The doc comment calls `backlog` "the one number that says a player is outrunning the world". The number has three weaknesses.

- **It carries no distance.** `backlog` counts units of work (placement slices and meshes) across every queued cell (`world-cells.ts:909-911`). Forty units at the far edge of the ring are harmless. Three units under the player's feet are a hole. The number cannot tell the two apart.
- **It has no threshold and no name.** A game or an agent must invent its own limit. PRD-459 lists "a player who outruns the backlog sees cells arrive late" as a risk and offers only the count (`PRD-459` Risks, lines 94–95). `readinessAt` can answer "is the area around this point complete" (`world-cells.ts:5858`), but nothing says which radius matters.
- **Nothing reacts.** The budget is `DEFAULT_ADMISSION_BUDGET_MS = 2` (`world-cells.ts:144`) whether the next missing cell is 60 m away or 5 m away. Only the startup cover raises it (`world-cells.ts:4952`). Background work runs on every update regardless: the impostor bake step (`world-cells.ts:8292`, called at `:5009`), the far-aggregate pump (`world-cells.ts:8707`, called at `:5015`) and the cell-proxy preparation (`world-cells.ts:9715`, called at `:5028`).
- **A refused cell is invisible.** `stats().pressure` counts refusals as cumulative totals (`world-cells.ts:896`). It does not say that the cell next to the player is the one a budget refused.

Nobody has measured how often a hole appears. Phase 1 measures it before any engine change.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- UE 5.8.3: `Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartitionRuntimeCellData.cpp:87-90`. For each streaming source, a cell records the distance from the source to the cell's content bounds divided by the source's loading radius. The smallest ratio over all sources is kept.
- UE 5.8.3: `WorldPartitionRuntimeHash.cpp:246-285` and `Engine/Source/Runtime/Engine/Public/WorldPartition/WorldPartitionRuntimeHash.h:39-45`. The ratio maps to four levels: Good, Slow, Critical and Immediate. A ratio of exactly 0 (the source is inside the cell) is Immediate. Below 0.25 is Critical. Below 0.5 (the 0.25 threshold times a warning factor of 2) is Slow. The defaults are `wp.Runtime.SlowStreamingRatio` and `wp.Runtime.BlockOnSlowStreamingRatio` (`WorldPartitionRuntimeHash.cpp:30-52`).
- UE 5.8.3: `WorldPartitionRuntimeHash.cpp:625-653` and `WorldPartitionStreamingPolicy.cpp:679-690`. The level is the worst over cells that are still to be activated, not over the whole world. A cell that is already visible, or always loaded, does not count.
- UE 5.8.3: `WorldPartitionStreamingPolicy.cpp:868-923`. A Critical level on a cell that is marked as blocking asks the world to block until streaming completes. Blocking is per partition (`bBlockOnSlowStreaming`, default false, `Public/WorldPartition/RuntimeHashSet/RuntimePartition.h:92`). A global switch defaults to on (`WorldPartitionStreamingPolicy.cpp:32-35`).
- UE 5.8.3: `WorldPartitionStreamingPolicy.cpp:545-548`, used at `:574` and `:601`. While the world blocks because of bad performance, cells that are not blocking cells are skipped for load and activation. The budget goes to the cells that matter.
- UE 5.8.3: `Engine/Source/Runtime/Engine/Private/WorldPartition/RuntimeHashSet/WorldPartitionRuntimeHashSet.cpp:290-295`. Coarse HLOD partitions are never blocking. They give way when streaming is behind.
- Ordering also includes facing: `WorldPartitionRuntimeCellData.cpp:71-73` and `:96` weight a cell's priority by the angle between the source's view direction and the cell. ThreeNative sorts by distance only. This PRD does not copy it. Phase 1 data decides if it is worth a later PRD.

## Solution

Everything lives in `packages/core/src/world-cells.ts`. It is mechanism with no look decision. A game cannot compute the ratio itself, because the missing-cell set and the budget refusals are internal state.

1. **Measure first (Phase 1).** The probe samples `readinessAt(camera, r)` every frame for `r` of 0, 0.25 R and 0.5 R, where `R = ring * cellSize`. It flies the tiled 1 km world at 1×, 2× and 4× the fixture speed. A frame where the 0.25 R region is not ready is a hole frame. The gate keeps the PRD alive only if holes occur.
2. **A named level (Phase 2).** The residency pass already walks the wanted ring in distance order. It also finds the nearest wanted cell or terrain tile that is not yet drawn. `stats().streaming` reports `performance` (`"good" | "slow" | "critical" | "immediate"`), `nearestMissingRatio` (metres to that cell's nearest edge, divided by `R`, 0 when the follow point is inside it) and `missing` counts by reason: `queued`, `loading`, `refused` (a budget turned it away) and `failed`. The thresholds are named constants, 0.25 and a warning factor of 2, the Unreal defaults, and Phase 1 data may move them.
3. **A response (Phase 3).** `catchUp` is on by default. While the level is critical, the admission budget ramps from the base budget to the covered budget as the ratio falls from 0.25 to 0. Immediate uses the full covered budget. The same condition pauses the three background steps above. This replaces Unreal's block. A browser main thread cannot block, and a freeze under a visible world is worse than a short hitch. The game reads `performance` if it wants to pause its own simulation. `catchUp: false` restores the constant budget. `stats().streaming.catchUp` reports whether the ramp is active and how many extra milliseconds it spent, so an override stays honest.
4. **Reused systems.** The residency sort, `readinessAt`, `COVERED_BUDGET_SCALE`, `AdmissionBudget`, the priced-clock harness and the existing flythrough probe. No new package.

**Risks:**

- **The ramp trades frame time for holes.** The proof compares p95 frame time with the Phase 1 baseline, not only the hole count.
- **Flapping.** A binary switch would flap near the threshold. The ramp is continuous, so a small change in ratio makes a small change in budget.
- **Overlap with PRD-477.** This PRD multiplies whatever base budget PRD-477 derives. It does not derive the base.
- **A hole the ratio cannot see.** Cells missing from the package (no placements) are not wanted, so they never count. Terrain tiles do count, because a missing tile is a visible hole.

## Acceptance Criteria

- [ ] AC-1 [local]: Under a scripted outrun with the priced clock, `stats().streaming.performance` passes through `"critical"` when the nearest missing cell is within 0.25 R, reaches `"immediate"` when the follow point stands in an unloaded cell, and returns to `"good"` after the backlog drains. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts` (new) — Evidence: pending.
- [ ] AC-2 [local]: A cell turned away by a budget reports `missing.refused > 0` and a cell whose asset failed reports `missing.failed > 0`. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: With `catchUp` on, the 2× flight has at most half the hole frames of the Phase 1 baseline, and the run's p95 frame time stays within 1 ms of the baseline. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.playtest.json --url 'http://127.0.0.1:5186/?world&tile=4&speed=2' --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5186 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-4 [local; needs a built desktop host]: The desktop host reports the same `streaming` fields and the same hole-frame direction on the same scenario. No frame ceiling is claimed for native. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-flythrough.desktop.playtest.json --target desktop --executable <pkg>` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `stats().streaming` | Any game or agent that reads `world.stats()`, and a playtest `components` assertion on the probe's `world` entity | Adds a named level beside `admission.backlog`. The backlog stays as the raw unit count. | AC-1, AC-2 |
| `catchUp` response | The existing `update` call, with no new game code | Ramps the admission budget and pauses the impostor bake, far pump and proxy preparation while critical. `catchUp: false` is the named override. | AC-3, AC-4 |

## Execution Phases

#### Phase 1: Measure how often a hole appears
**Status:** NOT STARTED
**Files:** `examples/abyss-framework/src/scenes/WorldProbe.ts`, `examples/abyss-framework/playtests/world-flythrough.playtest.json`, `packages/core/__tests__/world-cells-streaming-health.spec.ts` (new)
**Implementation:** the probe gains `?tile=4` (a 1 km world from the fixture, through the `data` option) and `?speed=N` (a multiple of the 64 m/s flight speed at `WorldProbe.ts:37`). It samples `readinessAt` per frame at the three radii and reports `holeFrames`, `holeShare` and the longest run of hole frames on the `world` entity. A spec drives the same hole count with the priced clock. **Gate:** continue only if at 2× speed the 0.25 R region is not ready in at least 1% of frames on the web run. Otherwise record the decline under `## Decisions` and delete Phases 2–3 (R4).
- [ ] The hole share at 1×, 2× and 4× speed is recorded here for the browser run. proof: the AC-3 playtest command with `speed=1`, `speed=2` and `speed=4`
- [ ] The priced-clock spec reproduces a hole share above 0 at the default budget with a follow point that outruns it. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts`
**Verification:** the two numbers and the gate verdict. Run `engine_search_capabilities` for "world streaming performance" before Phase 2 and confirm no helper exists.

#### Phase 2: A named streaming level
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/world-cells-streaming-health.spec.ts`
**Implementation:** compute the nearest missing ratio inside the existing residency pass. Keep the per-reason counts as plain counters set when a cell is admitted, refused or failed. Add the `streaming` block to `IWorldCellsStats`. Add `@constraint` text to the `WorldCells` doc so the capability manifest names the level.
- [ ] The level moves through critical and immediate under a scripted outrun and returns to good after the drain. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts`
- [ ] A budget-refused cell and a failed asset appear in `missing` under their own reasons. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts`
**Verification:** AC-1 and AC-2 close this phase. Rerun `pnpm build` so `capabilities.json` lists the field.

#### Phase 3: Spend more only when a hole is near
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/world-cells-streaming-health.spec.ts`, `docs/guides/world-streaming.md`
**Implementation:** read the level at the top of `update`. Scale the budget from the base to the covered budget by the ramp above. Skip `#stepImpostor`, `#pumpFarAcquisition` and the proxy admission while the ramp is above zero. Report the ramp in `stats().streaming.catchUp`. The guide names the levels and the `catchUp` override.
- [ ] With `catchUp` on, the budget ramps with the ratio and no update exceeds the covered budget plus one unit. With `catchUp: false`, the budget stays constant. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts`
- [ ] The background steps pause during the ramp and resume when the level is good. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-streaming-health.spec.ts`
- [ ] The 2× flight halves its hole frames within 1 ms of baseline p95 in the browser, and the desktop host reports the same fields. proof: the AC-3 and AC-4 playtest commands
**Verification:** AC-3 and AC-4. The change decides when cells appear, so it needs the visual judge from the root `AGENTS.md`. Capture the same flight pose at the hole moment before and after, headed, with `--browser-recipe webgpu` and `adapter.info` checked, at least two runs per arm. A fresh read-only subagent returns IMPROVEMENT, NEUTRAL or REGRESSION per frame. Record the verdict in the AC-3 line.

## Decisions

- 2026-10-12 (Unreal source review): no blocking call. The browser main thread cannot block, and a freeze under a visible world is a bug. The level is the signal, the ramp is the engine's answer, and a game may pause its own simulation on `"critical"`.
- 2026-10-12 (Unreal source review): facing-weighted cell order (`WorldPartitionRuntimeCellData.cpp:71-73`) is left out. Admission is already nearest first, and the prefetch lead already shifts the ring toward the direction of travel (`world-cells.ts:5684-5716`). Phase 1 data on a turning camera may justify a later PRD.
