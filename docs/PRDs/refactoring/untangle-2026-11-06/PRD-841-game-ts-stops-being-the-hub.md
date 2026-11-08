# PRD-841 — `game.ts` stops being the file every feature edits

**Status:** PARTIAL — Phase 3 box 1 landed; the boot proxy, the teardown and the UI bridge are open.
**Priority:** P2 — the open boxes delete the 46-field boot proxy, the hand-ordered teardown and the hard-wired scene-entry audits that put `game.ts` in 116 commits in 90 days.
**Complexity:** 4 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — N4

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

- [ ] AC-1 [local]: Start, scene change and stop keep their order and leak nothing. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts __tests__/game-stop-order.spec.ts`
- [ ] AC-2 [local]: The starter boots and plays its golden scenario. proof: `pnpm test:templates` (starter)

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
**Status:** NOT STARTED
**Files:** `game.ts`, `game-startup.ts`, `game-frame-loop.ts`.

- [ ] Every acquisition pushes its disposer, and `#teardown` only drains `#cleanup`. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game-stop-order.spec.ts`

#### Phase 3: Inspectors and UI out of the hub
**Status:** PARTIAL — the scene-entry audits are one list; the UI bridge is still in `game.ts`
**Files:** `game.ts`, new `game-ui.ts`, the 3 audit modules.

- [x] Scene-entry audits register in one ordered list, and adding one does not edit `game.ts`. `packages/core/src/scene-entry-inspectors.ts` owns the list and the order that matters — the opacity convention first, so the render trap audit reports what the convention made take effect — and `#enterScene` is one call. The list is a field (`#sceneEntryInspectors`), so a game installs its own. proof: `npx vitest run packages/core/__tests__/scene-entry-inspectors.spec.ts packages/core/__tests__/game.spec.ts` → 90 passed (including the order, the level each finding reports at, and a caller-added inspector); the whole core suite → 4575 passed, 4 skipped.
- [ ] The UI bridge lives in `game-ui.ts`. proof: `pnpm --filter @threenative/ui test`
