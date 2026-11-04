# PRD-801 — Core `game.ts` boot splits by phase, and `stop()` order is pinned

**Status:** NOT STARTED
**Priority:** P2 — `#boot` is one 1 658-line method with about 100 closure locals, and no spec pins the order in which `stop()` releases resources (all phases open).
**Complexity:** 5 (MEDIUM); risk override: `stop()` must fully reverse `start()` (packages/core AGENTS "Shape of the runtime")
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](README.md)

## Context

Read-only audit, 2026-11-04:

- `packages/core/src/game.ts` is 2 929 lines. Public types (163–580), dev-tools install (277–375), validation and renderer metrics (581–731), `GameImpl` fields and scene changes (732–1 151), `#boot` (1 152–2 810: renderer, loader and warm-up, `ctx` and frame budget, `gameLoop` callbacks with a 430-line `onRender`, setup gates), `stop` and `#teardown` (2 818–2 913).
- `#teardown` frees resources by reading private fields that `#boot` assigns.
- `scripts/api-surface.json` keys three members by `src/game.ts#renderer.*`, so `IGameConfig` stays in `game.ts`.
- Pinned by `game.spec.ts` (3 885 lines) and 22 other specs (`startup-*`, `game-auto-scale`, `game-render-skips`, `game-frame-budget-surface`, `playtest`, `worker`, `hot`, `replay`). Not pinned: the `camera.far` and `camera.fov` messages, `goto carry must be a JSON object`, `installDevTools` restore on dispose, `resumeScene`, and the release order of `stop()`.

## Solution

Pin, then extract leaves: `game-validate.ts`, `game-dev-tools.ts`, `game-renderer-metrics.ts`; then
the two big phases of `#boot`, `game-startup.ts` and `game-frame-loop.ts`. Each extraction returns
a disposer that `#teardown` calls, so the release order stays in one place. `defineGame`,
`IGameConfig` and `#teardown` stay in `game.ts`; `index.ts` is unchanged.

## Acceptance Criteria

- [ ] AC-1 [local]: `stop()` releases loop, scene exit, plugin dispose, cleanups, input, store and renderer in that order, and a throwing scene exit still reaches the renderer release. proof: `packages/core/__tests__/game-stop-order.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: `game.ts` is under 1 200 lines, no new file exceeds 1 000, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/core/__tests__/` — Evidence: pending.
- [ ] AC-3 [local]: Core units, the API surface and the build guards stay green. proof: `pnpm --filter @threenative/core test`, `pnpm exec tsx scripts/check-api-surface.ts`, `constraints.spec.ts`, `build.spec.ts` — Evidence: pending.
- [ ] AC-4 [local]: A template boots and plays. proof: `pnpm test:templates` for the starter kit — Evidence: pending.

## Integration Ledger

Integration: unchanged — `defineGame` is the only entry, and every template calls it.

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/game-stop-order.spec.ts` (new), `packages/core/__tests__/game.spec.ts` (new cases only)
- [ ] The release-order spec is green on today's code. proof: AC-1
- [ ] Camera and carry error messages, and dev-tools restore on dispose, are pinned and green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/game.spec.ts`

#### Phase 2: extract the leaves
**Status:** NOT STARTED
**Files:** `packages/core/src/game-{validate,dev-tools,renderer-metrics}.ts` (new), `game.ts`
- [ ] Three leaves extracted. proof: AC-3

#### Phase 3: split `#boot`
**Status:** NOT STARTED
**Files:** `packages/core/src/game-{startup,frame-loop}.ts` (new), `game.ts`
- [ ] Startup and frame loop extracted, each returning its disposer. proof: AC-1, AC-2, AC-3
- [ ] A template plays. proof: AC-4
