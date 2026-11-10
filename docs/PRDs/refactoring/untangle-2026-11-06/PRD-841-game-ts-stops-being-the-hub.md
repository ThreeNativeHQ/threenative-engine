# PRD-841 — `game.ts` stops being the file every feature edits

**Status:** NOT STARTED
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
**Status:** NOT STARTED
**Files:** `packages/core/src/game.ts`, `game-startup.ts`, `game-frame-loop.ts`.

- [ ] Phases take `IBootPhase` / `ILoopPhase`, and `Object.defineProperties` is gone from `game.ts`. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts` plus `pnpm typecheck`

#### Phase 2: Disposers on acquisition
**Status:** NOT STARTED
**Files:** `game.ts`, `game-startup.ts`, `game-frame-loop.ts`.

- [ ] Every acquisition pushes its disposer, and `#teardown` only drains `#cleanup`. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game-stop-order.spec.ts`

#### Phase 3: Inspectors and UI out of the hub
**Status:** NOT STARTED
**Files:** `game.ts`, new `game-ui.ts`, the 3 audit modules.

- [ ] Scene-entry audits register in one ordered list, and adding one does not edit `game.ts`. proof: `pnpm --filter @threenative/core exec vitest run __tests__/game.spec.ts`
- [ ] The UI bridge lives in `game-ui.ts`. proof: `pnpm --filter @threenative/ui test`
