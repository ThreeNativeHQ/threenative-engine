# PRD-841 — `game.ts` stops being the file every feature edits

**Status:** PARTIAL — Phase 3 box 1 landed; the boot proxy, the teardown and the UI bridge are open.
**Priority:** P2 — the open boxes delete the 46-field boot proxy, the hand-ordered teardown and the hard-wired scene-entry audits that put `game.ts` in 116 commits in 90 days.
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](../refactoring/untangle-2026-11-06/README.md) — N4

## Context

Report ids A2, A3, A7.

| Problem | Where |
| --- | --- |
| `#bootGame()` builds a 196-line `Object.defineProperties` proxy of 46 private fields. A cast hides a forgotten field, so the phase reads `undefined`. | `packages/core/src/game.ts:829-1025`, interface `packages/core/src/game-frame-loop.ts:90-139` |
| Teardown releases 30 fields in a hand-written order. A `#cleanup` stack already exists and is pushed by some phases. | `game.ts:1047-1140`, `#cleanup` at `game.ts:445`, pushes at `game-startup.ts:125,850,854` |
| `#enterScene` hard-wires 3 audits in a required order, each landed by its own PR | `game.ts:693-703` (`applyOpacityConvention`, `renderTrapAudit`, `unlitFoliageWarning`) |
| UI bridge, config, lifecycle and scene policy in one file | `game.ts:217-380,391-780,561-598` |

## Solution

Boot and loop phases take two narrow interfaces declared where they are used: `IBootPhase` and
`ILoopPhase` over a mutable `IBootState` that the phase owns. The proxy is deleted. Every acquisition
pushes its own disposer onto `#cleanup`. Ordering contracts are documented on the phase that pushes
them, and the field-by-field release is deleted. Scene-entry inspectors register into one ordered
list. The UI bridge moves to `game-ui.ts`.

## Acceptance Criteria

- [x] AC-1 [local]: Start, scene change and stop keep their order and leak nothing. proof: `npx vitest run packages/core/__tests__/game.spec.ts packages/core/__tests__/game-stop-order.spec.ts` → 93 passed (2026-11-08, worktree `.worktrees/untangle-841` at `a8c7990f2`). The order spec pins loop, scene exit, plugin `dispose`, cleanup, input, store, renderer, and a case with several plugins in setup order; deleting the store's push fails 2 cases.
- [x] AC-2 [local]: The starter boots and plays its golden scenario. proof: `TN_PLAYTEST_ALLOW_SOFTWARE=1 TN_GOLDEN_PATH_SCENARIOS=1 TN_GOLDEN_PATH_TEMPLATES=starter pnpm verify:golden-path` → **EXIT=0** (2026-11-08, RTX 2080, `--browser-recipe webgpu`), the CI configuration of this lane: pack, scaffold, install, MCP, dev, test (drove 1 of 14 non-visual scenarios, `assets`, `pass: true`), build web, assert artifact, then the packed-mutation control. ⚠️ Without `TN_PLAYTEST_ALLOW_SOFTWARE` the scaffolder's own `pnpm test` drives all 26 scenarios including the two visual ones, and there `boot-failure` (blank capture: 1 distinct colour) and `play` (`maxFrameMsP95` 21.91 ms against 16.7) fail — the playtest runner provisions its own Xvfb, whose frame rate and composited capture the harness documents as not evidence; the two scenarios CI routes to the visual lanes, which this lane did not run. No `TN_PLAYTEST_BRIDGE_MISSING` appeared in any run; `starter-assets` returned 846 frames.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Boot phases | `Game.start` → `game-startup.ts` | Proxy deleted | Phase 1 |
| Teardown | `Game.stop` | Hand release deleted | Phase 2 |

## Execution Phases

#### Phase 1: Narrow phase interfaces
**Status:** DONE
**Files:** `packages/core/src/game.ts`, `game-startup.ts`, `game-frame-loop.ts`, new `game-boot-phase.ts`.

- [x] Phases take `IBootPhase` / `ILoopPhase`, and `Object.defineProperties` is gone from `game.ts`. `game-boot-phase.ts` declares `IBootState` (the data a phase owns), `IBootHost` (the game's seven calls), `IBootPhase` (what `startGameWorld` reads) and `ILoopPhase` (what the frame loop and `startScenes` read, a `Pick` the startup result hands on). `GameImpl` keeps one `#boot` object built by `createBootGame`, and its 40 private fields became members of that object. A forgotten field is now a compile error: removing `viewport` from `createBootGame` fails with TS2322 naming `viewport`. proof: `npx vitest run packages/core/__tests__/game.spec.ts packages/core/__tests__/game-stop-order.spec.ts` → 92 passed; `pnpm --filter @threenative/core exec tsc --noEmit -p .` → 0 errors. Root `pnpm typecheck` runs at the end of the lane (the worktree needs built `dist` first).

#### Phase 2: Disposers on acquisition
**Status:** DONE
**Files:** `game.ts`, `game-startup.ts`, `game-frame-loop.ts`, `game-boot-phase.ts`, `packages/core/AGENTS.md`.

- [x] Every acquisition pushes its disposer, and `#teardown` only drains `#cleanup`. The renderer, store, input, scene clear, interpolation, viewport, canvas layer, asset loader, picker, pointer events, matrix pass, autobatcher, camera cull, startup readiness, stall watch, dev tools, scene-owned registries, plugin groups, scene exit, frame budget and loop stop each push their own release where they are acquired. `drainCleanup` runs the stack newest first and keeps every release failure-atomic. The `releases` list in `startGameWorld`, `startup.dispose`, `frameLoop.dispose`, `#startupDispose`, `#frameLoopDispose`, `#disposedPlugins` and the 90-line field-by-field release are deleted. proof: `npx vitest run packages/core/__tests__/game.spec.ts packages/core/__tests__/game-stop-order.spec.ts` → 93 passed (the order spec pins loop, scene exit, plugin dispose, cleanup, input, store, renderer; a new case pins several plugins in setup order). Red check: deleting the store's push fails 2 order cases.
  - **Decision (2026-11-08): ordering contracts.** Each contract sits on the phase that pushes it. (1) The UI bridge is not on the stack: its lifetime is the game's, so `#teardown` disconnects it first, as before. (2) `startScenes` pushes the loop stop last and the scene exit and the two plugin groups before it, so the loop stops, the scene exits, every plugin `dispose` runs, then every setup cleanup runs, each group in setup order as before. (3) The store starts before the input, so it stops after it. (4) The scene clear is pushed before the objects built on it, so they release first. Four releases moved relative to the old hand order and none is read by the release it moved past: the asset loader, stall watch and readiness cancel now run after the plugin cleanups (the cleanups may still use the assets), the picker and pointer events dispose before the viewport instead of after the renderer, and the frame budget disposes after plugin `dispose` instead of before the scene exit. The loop that reports into it still stops first.

#### Phase 3: Inspectors and UI out of the hub
**Status:** DONE
**Files:** `game.ts`, new `game-ui.ts`, `scene-entry-inspectors.ts`.

- [x] Scene-entry audits register in one ordered list, and adding one does not edit `game.ts`. `packages/core/src/scene-entry-inspectors.ts` owns the list and the order that matters — the opacity convention first, so the render trap audit reports what the convention made take effect — and `#enterScene` is one call. The list is a field (`#sceneEntryInspectors`), so a game installs its own. proof: `npx vitest run packages/core/__tests__/scene-entry-inspectors.spec.ts packages/core/__tests__/game.spec.ts` → 90 passed (including the order, the level each finding reports at, and a caller-added inspector); the whole core suite → 4575 passed, 4 skipped.
- [x] The UI bridge lives in `game-ui.ts`. `createGameUi` owns the bridge connection, the startup post, the disconnect and the `game.ui` facade, and `GameImpl` keeps one `#ui` seam that the boot host calls reach. `game.ts` lost the `connectUiBridge`, `publishUiState` and `onUiIntent` imports. The public `IGameUi` is unchanged. proof: `pnpm --filter @threenative/ui test` → publint exit 0 after `pnpm --filter @threenative/ui build`; `npx vitest run packages/ui` → 28 passed; `npx vitest run packages/core/__tests__/game.spec.ts packages/core/__tests__/game-stop-order.spec.ts` plus the nine core UI specs → 175 passed; `pnpm --filter @threenative/core exec tsc --noEmit -p .` → 0 errors.
