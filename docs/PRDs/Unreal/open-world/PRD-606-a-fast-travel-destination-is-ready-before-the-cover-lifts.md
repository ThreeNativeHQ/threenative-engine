# PRD-606 — A fast-travel destination is ready before the cover lifts

**Status:** NOT STARTED
**Priority:** P2 — a teleport still refills the world at the 2 ms walking budget, and no call lets a game's own fade use the covered budget (this PRD's own open outcome).
**Complexity:** 3 (LOW) — 1–5 implementation files (`world-cells.ts`, one guide, the probe) (+1), the covered budgets and `readinessAt` already exist (+0), native proof reuses the desktop flythrough host (+0). The score stays 3 because the change is one flag and one promise. Risk override: none.
**Owner:** unassigned
**Depends on:** None. Respects [PRD-459](../../open-world/PRD-459-smooth-streaming-one-admission-budget-per-frame.md) (one admission budget per frame stays the walking rule) and [PRD-477](../../open-world/PRD-477-worldcells-auto-on-measured-budgets.md) (it owns any automatic budget).

## Context

A game with fast travel, a respawn point or a checkpoint moves the followed object far in one frame. `WorldCells` handles the move correctly but slowly.

- **The jump is detected.** A follow point that crosses more than one cell in one pass counts as a jump (`world-cells.ts:5961-5967`). The prefetch velocity resets (`world-cells.ts:5695`). The hysteresis ring yields its budget share. `TerrainTiles.follow` evicts every tile outside the new ring at once (`world-tiles.ts:2243`).
- **The refill uses the walking budget.** The destination ring is admitted nearest first, at `DEFAULT_ADMISSION_BUDGET_MS = 2` (`world-cells.ts:144`). The source comment records the cost: a spawn backlog of about 1,200 builds took 16 s on web and about 47 s on native at 2 ms on a 10–17 fps lane (`world-cells.ts:145-153`).
- **The covered budget exists but only the startup cover can reach it.** `process(renderer, camera, covered)` switches to 8 times the budget and 8 times the fresh-mesh allowance (`world-cells.ts:5590-5598`). The engine passes `startupCoverActive() && !startupReadiness.ready` (`game.ts:1677-1681`). A game fade at mid-game has no way in.
- **Readiness is read-only.** `readinessAt(position, radius)` reports completed cells and tiles (`world-cells.ts:5858`). Nothing waits on it, so each game writes its own polling loop.
- **Games already work around the gap.** The Strata preview sets `prefetchSeconds: 0` and a ring that covers the whole world because "predictive centring can otherwise evict visible placements after camera jumps" (`examples/strata-terrain-preview/src/render/propStreaming.ts:303-312`).

The missing piece is small. The game needs to say "the screen is hidden, spend more" and to learn when the area around the new position is complete.

### What Unreal does (UE 5.8.3, read 2026-10-12; clean-room summary, no code copied)

- UE 5.8.3: `Engine/Source/Runtime/Engine/Private/WorldPartition/WorldPartitionSubsystem.cpp:202-206` and `:1346-1348`. A cap of 4 cells may load at once (`wp.Runtime.MaxLoadingStreamingCells`). The cap is skipped while the world is inside a block-until-streaming-completed.
- UE 5.8.3: `WorldPartitionSubsystem.cpp:1288`. A block turns off the time-sliced incremental update. `WorldPartitionStreamingPolicy.cpp:344-356` also turns off the "nothing changed, skip the update" shortcut while blocked.
- UE 5.8.3: `WorldPartitionSubsystem.cpp:896` and `WorldPartitionStreamingPolicy.cpp:1159-1175`. A completion query takes a state, a list of query sources (location and radius) and an exact-state flag. A caller asks "is the area around this point loaded" and nothing else. This is the shape of `readinessAt`.
- UE 5.8.3: `Engine/Source/Runtime/Engine/Classes/GameFramework/WorldSettings.h:336-357` and `WorldPartitionSubsystem.cpp:1772-1794`. Dynamic loading-range scaling starts the range at a percentage, waits a delay, then grows it over a duration (default 10 s, off by default). The header warns that 0% is a poor start when terrain tiles stream, because the pawn would have nothing to stand on.
- UE 5.8.3: `WorldPartitionSubsystem.cpp:1839-1866`. The source velocity resets on a teleport (distance over 10,000 units) and after 5 s of inactivity. ThreeNative resets at one ring of travel and keeps that rule.

## Solution

Two additions to `packages/core/src/world-cells.ts`. Both are mechanism, not look. A game cannot write them itself, because `#covered` is private and the admission queue is internal (question (a) of the root rules).

1. **Measure first.** Phase 1 times the refill after a teleport on a 1 km world made by repeating the abyss-framework fixture. It runs at the walking budget and at the covered budget, for one cell of radius and for the whole ring. The gate decides if Phases 2–3 continue.
2. **`settle(options?)`.** The call returns a promise of `IWorldRegionReadiness`. While it is pending, `update` uses the covered admission budget and the covered fresh-mesh allowance, the same two values the startup cover uses. It resolves in the update where `readinessAt(follow, radius).ready` is true, then the cover ends by itself. `radius` is metres and defaults to the value Phase 1 picks. `timeoutMs` bounds the wait. A timeout, a failed load or a `dispose()` rejects the promise with the last readiness in the message. A refused cell cannot hang a fade.
3. **Consumer flow.** The game fades out. It moves the followed object. It awaits `world.settle()`. It fades in. A game that wants a shorter fade passes a smaller `radius` and lets the rest of the ring stream behind the lifted cover. This is the idea behind Unreal's growing loading range, without a second range to tune.
4. **Reused systems.** `readinessAt`, `COVERED_BUDGET_SCALE`, `coveredAdmissionBudgetMs`, `coveredFreshMeshesPerUpdate`, `AdmissionBudget` and the priced-clock harness in `world-cells-admission.spec.ts`. No new package and no look decision.

**Risks:**

- **Load lanes can limit the cover.** `ModelLoadLimiter` (`world-cells.ts:3970`) fixes its lanes at construction. If Phase 1 shows `loadsQueued > 0` for more than half of the covered wait, the lanes are the limit. Phase 2 then widens them while a settle is pending, as Unreal skips its cell cap during a block. If Phase 1 does not show it, the lanes stay unchanged.
- **A radius larger than the ring can never be ready.** Terrain only holds `streamRadius` tiles. `settle` throws on a radius beyond the ring reach instead of waiting for the timeout.
- **No automatic cover on a jump.** The engine cannot know that the screen is hidden. A 16 ms admission under a visible world is a hitch. See `## Decisions`.

## Acceptance Criteria

- [ ] AC-1 [local]: After a teleport across the tiled world, `settle()` resolves with `ready: true` in at most half the updates the walking budget needs for the same radius, and no update spends more than the covered budget plus one unit. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: The update after a settle resolves spends at most the walking budget plus one unit. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts` — Evidence: pending.
- [ ] AC-3 [local]: With `budgets.residentCells: 1`, `settle()` rejects at its timeout with the readiness in the message, and it rejects at once on `dispose()`. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts` — Evidence: pending.
- [ ] AC-4 [local]: In the browser scenario, readiness at the full ring radius is true on the frame the cover lifts, with 0 failed loads and 0 console errors on a named WebGPU adapter. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-travel.playtest.json --url 'http://127.0.0.1:5185/?world&tile=4' --server-command 'pnpm --filter abyss-framework dev --host 127.0.0.1 --port 5185 --strictPort' --browser-recipe webgpu` — Evidence: pending.
- [ ] AC-5 [local; needs a built desktop host]: The desktop host runs the same scenario with the same readiness result and 0 failures. No frame ceiling is claimed for native. proof: `node packages/playtest/dist/runner/cli.js examples/abyss-framework/playtests/world-travel.desktop.playtest.json --target desktop --executable <pkg>` — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| `WorldCells.settle` | A game fades out, moves its follow object, awaits `settle`, fades in | The startup-only cover flag at `game.ts:1677` stays. `settle` adds a second, game-owned way to the same covered budgets. Per-game polling of `readinessAt` becomes unnecessary. | AC-1..AC-3 |
| Fast-travel recipe | `docs/guides/world-streaming.md` | New section. This PRD edits no game, so the Strata preview's `prefetchSeconds: 0` workaround stays as it is. | Phase 2 guide box |
| Travel scenario | `examples/abyss-framework` `?world&tile=4` plus `KeyT` | New playtest. The existing flythrough scenarios stay unchanged. | AC-4, AC-5 |

## Execution Phases

#### Phase 1: Measure the teleport refill
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-cells-admission.spec.ts`, `examples/abyss-framework/src/scenes/WorldProbe.ts`, `examples/abyss-framework/playtests/world-travel.playtest.json` (new)
**Implementation:** a spec case with the existing priced clock moves the follow point from one corner to the far corner. It counts `update()` calls until `readinessAt(destination, radius).ready` for radius one cell and for the full ring. It runs once with `update()` and once with `process(undefined, undefined, true)`. It also records the share of waiting updates with `loadsQueued > 0`. The probe gains `?tile=4`, which repeats the fixture into a 1 km world through the `data` option, and `KeyT`, which moves the camera 600 m. It reports wall milliseconds and the longest frame until ready. **Gate:** continue only if the full ring needs more than 30 updates (0.5 s at 60 Hz) at the walking budget. A fade of that length already hides a shorter refill. Otherwise record the decline under `## Decisions` and delete Phases 2–3 (R4).
- [ ] Updates to ready at the walking and covered budgets, for one cell and for the full ring, with the `loadsQueued` share, are recorded here. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts`
- [ ] The tiled world reports wall milliseconds and longest frame to ready after a 600 m teleport in a real browser, and the gate verdict is written under `## Decisions`. proof: the AC-4 playtest command
**Verification:** the two numbers above. Run `engine_search_capabilities` for "world streaming teleport readiness" before Phase 2 and confirm no helper exists.

#### Phase 2: `settle()` under the cover
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/world-cells-admission.spec.ts`, `docs/guides/world-streaming.md`
**Implementation:** a pending-settle record makes `update` read the covered budgets. It resolves, times out or rejects as described above. A `@situation` tag on the `WorldCells` doc names the fade, move, wait, fade flow so the capability manifest finds it. The guide gains a fast-travel section with the radius advice from Phase 1.
- [ ] A settle resolves ready in at most half the walking-budget updates, and no update exceeds the covered budget plus one unit. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts`
- [ ] The update after the settle resolves spends at most the walking budget plus one unit. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts`
- [ ] A refused cell rejects at the timeout and `dispose()` rejects at once, each with the readiness in the message. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-admission.spec.ts`
- [ ] The guide documents the flow and the radius choice. proof: `pnpm check:docs`
**Verification:** AC-1 to AC-3 close this phase. Rerun `pnpm build` so `capabilities.json` lists the call.

#### Phase 3: Browser and desktop proof
**Status:** NOT STARTED
**Files:** `examples/abyss-framework/src/scenes/WorldProbe.ts`, `examples/abyss-framework/playtests/world-travel.playtest.json`, `examples/abyss-framework/playtests/world-travel.desktop.playtest.json` (new)
**Implementation:** `KeyT` calls `settle()` and the probe reports readiness at the full ring radius on the frame it resolves. The scenario asserts it. The desktop scenario copies it with the host's target.
- [ ] The browser scenario shows the full ring ready at the lift, with 0 failures. proof: the AC-4 playtest command
- [ ] The desktop host shows the same result. proof: the AC-5 playtest command
**Verification:** AC-4 and AC-5. The settled frame equals the frame an uncovered run reaches, so no visual judge applies. Look at one capture on the lift frame by eye.

## Decisions

- 2026-10-12 (Unreal source review): Unreal lifts its cell cap and its update shortcuts only inside a block, and the game still waits. This PRD does the same with a promise. It does not add a blocking call, because the browser main thread cannot block and a block under a visible world is a freeze.
- 2026-10-12 (Unreal source review): no automatic cover on a detected jump. Only the game knows that its screen is hidden. A second streaming source for the destination is also out of scope: `TerrainTiles` holds one focus (`world-tiles.ts:2203-2216`), so a second source is a terrain change that no template needs.
