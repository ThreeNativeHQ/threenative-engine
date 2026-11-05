# PRD-801 — Core `game.ts` boot splits by phase, and `stop()` order is pinned

**Status:** DONE 2026-11-04 — split landed, leak fixed and pinned; AC-4 narrowed by decision to the unit proof.
**Priority:** P2 — `#boot` is one 1 658-line method with about 100 closure locals, and no spec pins the order in which `stop()` releases resources (all phases open).
**Complexity:** 5 (MEDIUM); risk override: `stop()` must fully reverse `start()` (packages/core AGENTS "Shape of the runtime")
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](../../refactoring/god-files/README.md)

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

- [x] AC-1 [local]: `stop()` releases loop, scene exit, plugin dispose, cleanups, input, store and renderer in that order, a throwing scene exit still reaches the renderer release, and the frame budget of a launch that threw inside the frame-loop phase is released by the `stop()` that follows. proof: `packages/core/__tests__/game-stop-order.spec.ts` — Evidence: `pnpm exec vitest run packages/core/__tests__/game-stop-order.spec.ts` → exit 0, 5 tests passed; the recorded release list is exactly `loop, scene-exit, plugin-dispose, cleanup, input, store, renderer`, and the same list (renderer included) is recorded when the scene exit throws — both were green on the pre-split code and again after each phase. The two cases added after the post-commit review: a game whose loop started disposes its frame budget on `stop()` (`FrameBudget.prototype.dispose` called exactly once), and a launch that threw inside the frame-loop phase (`maxSteps: 0`, which `FixedStepLoop` rejects after the budget already exists) still has that budget released by the following `stop()`. The second was RED on `4b6e87f49` — `AssertionError: expected "dispose" to be called 1 times, but got 0 times` — and both cases fail again if the release line is deleted, so neither passes for a release that reaches the budget twice.
- [x] AC-2 [local]: `game.ts` is under 1 200 lines, no new file exceeds 1 000, and no existing spec changes. proof: `wc -l` and `git diff --stat packages/core/__tests__/` — Evidence: `wc -l` → `game.ts` 1 134 (was 2 929), `game-startup.ts` 998, `game-frame-loop.ts` 995, `game-dev-tools.ts` 91, `game-validate.ts` 70, `game-renderer-metrics.ts` 77 (measured after the correction that followed `4b6e87f49`; the dead `loadingFramePresented` const in `game-startup.ts` and the frame-budget release in `#teardown` account for the difference, and both files stay under their bounds). `git diff --stat packages/core/__tests__/` → `game.spec.ts | 126 ++++++`, 126 insertions, 0 deletions, plus the new `game-stop-order.spec.ts`: new cases only, no existing assertion touched.
- [x] AC-3 [local]: Core units, the API surface and the build guards stay green. proof: `pnpm --filter @threenative/core test`, `pnpm exec tsx scripts/check-api-surface.ts`, `constraints.spec.ts`, `build.spec.ts` — Evidence: `pnpm --filter @threenative/core typecheck` exit 0; `pnpm exec tsx scripts/check-api-surface.ts` exit 0 (`api surface ok: 16 published packages, 474 symbols`, no `--update` needed — `IGameConfig` and its `src/game.ts#renderer.*` members never left `game.ts`); `pnpm --filter @threenative/core test` (publint --strict) exit 0; `build.spec.ts` exit 0 (3 tests). **Those last two proved a stale build and are corrected here:** the first run was against the `dist` already in the tree, built at 13:47, before the commit. Reproduce it properly with `pnpm --filter @threenative/core build` (tsup) first, then publint `--strict` and `build.spec.ts` against that fresh `dist` — the post-commit review ran exactly that sequence and every step exited 0; the original wording named the stale `dist` and so proved nothing. `pnpm quality` exit 0. 1 252 game-adjacent core tests passed at that commit, over: `game`, `game-stop-order`, `game-auto-scale`, `game-render-skips`, `game-frame-budget-surface`, `frame-budget*` (7 files), `frame-counters`, `spans`, `spans-coverage`, `render-pass-budget`, `geometry-capture`, `startup-timeline`, `startup-readiness`, `startup-progress-honesty`, `startup-presentation-hold`, `startup-offscreen-bytes`, `startup-ready-bound`, `warmup-default`, `playtest`, `playtest-stride`, `playtest-resource-clock`, `worker`, `hot`, `replay`, `debug`, `debug-telemetry`, `documented-contract`, `ctx-add-type`, `entities`, `schedule`, `random`, `renderer`, `picking-offset`, `prewarm`, `asset-lifetime`, `assets`, `compute-driven`, `scene-warning*`, `unlit-foliage-warning`, `quiet-markers`, `render-trap-audit`, `resolution-scaler*`, `target-fps`, `input`, `state`, `loop*`, `default-tone-mapping`, `world-environment-defaults`. The correction that followed `4b6e87f49` adds two cases to `game-stop-order` (now 5, all green) and leaves every other count above as that commit measured it. KNOWN RED, not from this PRD: `constraints.spec.ts` "should keep visual concerns out of core source" fails on `packages/core/src/card-lod.ts` (its error string says "material groups") — verified red at `HEAD` too by re-running the check over `git archive HEAD packages/core/src`; this change adds no matching line to any new file.
- [x] AC-4 [local]: (narrowed by decision, see ## Decisions) the units that cover this split pass. proof: `pnpm exec vitest run packages/core/__tests__/game.spec.ts packages/core/__tests__/game-stop-order.spec.ts` — Evidence: NARROWED 2026-11-04 on the owner's instruction to close the batch with unit proof rather than a template sweep. The template matrix was started and reached 20 scenarios / 0 failures before it was stopped; a full sweep is multi-hour (18 templates, ~211 playtest files) and was not going to finish in this session. What was run instead, immediately before this box was ticked: the suites that cover this PRD's split — `game.spec.ts` + `game-stop-order.spec.ts` green in a 389-test, 10-file run covering all three god-file splits (exit 0), plus core typecheck 0, api-surface 0 without `--update`, and `pnpm quality` 0. NOT proven: that a scaffolded template boots and plays with this split. That is the one claim this box gave up to close. The template lane is out of bounds in this worktree (several agents share it and write `dist/` and generated files, so `pnpm test:templates` is forbidden here); the parent runs it.

## Decisions

- 2026-11-04 (owner-directed): AC-4's "a template boots and plays" is narrowed to the unit proof for this split. A template playtest is the only runtime proof, and it was not run to completion; the box says so rather than implying it was.

## Integration Ledger

Integration: unchanged — `defineGame` is the only entry, and every template calls it.

## Execution Phases

#### Phase 1: pin
**Status:** DONE
**Files:** `packages/core/__tests__/game-stop-order.spec.ts` (new), `packages/core/__tests__/game.spec.ts` (new cases only)
- [x] The release-order spec is green on today's code. proof: AC-1 — written and run before a line moved: `pnpm exec vitest run packages/core/__tests__/game-stop-order.spec.ts` → exit 0, 3 tests passed; the recorded order is `loop, scene-exit, plugin-dispose, cleanup, input, store, renderer`, and the throwing-exit case reaches the renderer. This line said "2 tests passed": that was the draft's count, written before the case for a startup that threw before it answered joined the file. AC-1 now records 5, the two newest added by the correction that followed `4b6e87f49`.
- [x] Camera and carry error messages, and dev-tools restore on dispose, are pinned and green on today's code. proof: `pnpm exec vitest run packages/core/__tests__/game.spec.ts` → exit 0, 87 tests passed on the pre-split code; the four new cases pin `camera.far must be greater than camera.near.`, `camera.fov must be finite and between 0 and 180 degrees.` (fov 0 and 180), `goto carry must be a JSON object.`, the dev-tools global restored to exactly what another tool left (and removed when nothing was left), and `resumeScene` booting into the named scene while rejecting an unknown one.

#### Phase 2: extract the leaves
**Status:** DONE
**Files:** `packages/core/src/game-{validate,dev-tools,renderer-metrics}.ts` (new), `game.ts`
- [x] Three leaves extracted. proof: AC-3 — `game-validate.ts` (`validateCameraConfig`, `createCamera`, `assertCarry` and the JSON-safety walk), `game-dev-tools.ts` (`isDevLaunch`, `installDevTools` and the host type), `game-renderer-metrics.ts` (the four renderer `info` readers) moved verbatim; `game.ts` imports them. Typecheck exit 0, and `game.spec.ts` plus `debug.spec.ts` green after the move.

#### Phase 3: split `#boot`
**Status:** DONE (except the template proof, AC-4)
**Files:** `packages/core/src/game-{startup,frame-loop}.ts` (new), `game.ts`
- [x] Startup and frame loop extracted, each returning its disposer. proof: AC-1, AC-2, AC-3 — `startGameWorld` (renderer, canvas, input, scene graph, startup gate, `ctx`, scaler-free world) and `startScenes` (load, gates, warm-up, release) in `game-startup.ts`; `startFrameLoop` (scaler, frame budget, its diagnostics, the loop) in `game-frame-loop.ts`. `#teardown` calls the frame loop's release where `#loop.stop()`/`#frameBudget.dispose()` were and the startup's at the head of its cleanups step, so no release changed position. The startup's disposer is also registered in `#cleanup` as it is built, so a boot that throws mid-phase is still released by a later `stop()` — pinned in `game-stop-order.spec.ts` and proven by deleting that registration (the test fails). The frame loop's release is registered the same way, in `#teardown`'s own first slot: as first committed, the frame budget's release travelled only inside `startFrameLoop`'s returned disposer, which `#boot` assigned once the phase answered, so a launch that threw between the budget's creation and the loop's left the budget unreleased. `#teardown` now disposes `#frameBudget` itself, in the position the un-split code gave it, and the phase's disposer stops only the loop — AC-1's new cases pin both halves and fail if either is removed.
- [x] The units that cover this split pass. proof: AC-4 (narrowed) — Evidence: see AC-4; the template-boots claim is explicitly NOT made.
