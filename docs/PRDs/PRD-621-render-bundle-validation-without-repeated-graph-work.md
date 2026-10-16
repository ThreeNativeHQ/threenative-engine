# PRD-621 — Render bundle validation without repeated graph work

**Status:** IN PROGRESS
**Priority:** P1 — Material graph validation consumes substantial sampled CPU time in the forest startup trace; reduce that work without weakening bundle safety.
**Complexity:** 3 (LOW); one implementation file and complex mutable graph state; risk override: none.
**Owner:** Codex, resumed session fba759fa-cdc9-43fc-b8db-0106117e4c38
**Depends on:** None

## Context

PR #483's forest diagnostic trace contains 804,494 events. Named graph-validation helpers consume substantial self samples: `graphSnapshotCurrent` 3,603 ms, `captureBundleGraph` 2,619 ms, `readBundleGraphChildren` 1,083 ms, `bundleGraphKeys` 903 ms and `bundleGraphChildReader` 573 ms. This startup-inclusive virtual-display trace supports function attribution, not FPS or attribution of the separate 1,619 ms runtime task.

The shared engine owns this fix: every WorldCells bundled scene reaches these checks. On develop, the helpers live inline in `packages/core/src/world-cells.ts`; the epic extracted their identical bodies into `world-bundle-safety.ts`. Deliver the fix through a separate develop PR, then integrate it into the epic.

## Solution

Preserve per-batch validation and the current graph witness. Reuse the stored child witness only as comparison storage while consuming the current reader's full output; never reuse its safety verdict without checking. Remove tuple/map/spread allocations from graph capture and traversal while preserving exact enumeration, property-read order, limits, reader error handling and repair. Do not use version-only, pass-only or frame-only safety caching.

Scope: existing WorldCells implementation and bundle tests, plus the existing runtime harness. No public API, rendering quality, materials, scene content, tolerances or budgets change. No module extraction or unrelated cleanup.

## Acceptance Criteria

AC-1 [local]: WorldCells performs less graph-validation work on a representative repeated-material settled scene, measured through the existing caller rather than an unused helper.

AC-2 [local]: Deep nonenumerable children, inherited dictionary/sparse-array edits, unknown or throwing readers, overflow and later repair retain current fail-closed behavior, including mutations during a pass.

AC-3 [local]: The forest consumer uses the changed engine code, with comparable CPU attribution and no visible regression. Runtime budgets remain required in the epic and cannot be waived by this PRD.

## Integration Ledger

Integration: unchanged — WorldCells main cull → `recordCpuMain` → `bundleIn` → material graph validation. The incumbent path is optimized in place; no parallel implementation or fallback replacement.

## Execution Phases

### Phase 1: Safe algorithm and regression proof

**Status:** DONE
**Files:** `packages/core/src/world-cells.ts`, `packages/core/__tests__/world-bundles.spec.ts`.

- [x] Reduce temporary graph allocation through the real WorldCells caller. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` — baseline 41/41; candidate 42/42, exit 0. Unchanged ordered children retain the existing witness without re-recording; capture removes property tuples/map copies and traversal removes the combined spread array. This proves the caller's allocation path, not a CPU-time gain.
- [x] Preserve existing mutation/error/repair safety behavior. proof: `pnpm exec vitest run packages/core/__tests__/world-bundles.spec.ts` — 42/42, exit 0; added stable-reader length/order changes, late iterator failure, malformed children and repair. Existing deep nonenumerable/inherited/sparse/overflow cases remain green. Per-batch checks remain, so no pass-cache invalidation rule is introduced.

Core typecheck passed (`pnpm --filter @threenative/core typecheck`, exit 0); focused Biome passed with 23 existing warnings and no errors. Parent diff review found no new public API, cache scope, limit or property-enumeration change. Baseline/candidate suite durations are not a performance claim; matched runtime evidence remains open.

The first broader typecheck caught the new partial Node fixture's direct typed assignment at `world-bundles.spec.ts:1159`; it now uses reflective assignment, preserving the same runtime property write. Root `tsc --noEmit -p tsconfig.json` then passed locally. Laptop job `prd621-type-lint-r2` passed workspace `pnpm typecheck` and `pnpm lint`, exit 0 (3,805 linted files, 1,445 warnings, no errors). The earlier workspace build passed on the identical engine source. Full unit/native/runtime qualification remains open.

### Phase 2: Runtime proof and delivery

**Status:** NOT STARTED
**Files:** Existing forest consumer and runtime harness; no new harness.

- [ ] Measure reduced named guard CPU work on the forest consumer under matched conditions. proof: existing playtest `trace` command on baseline and candidate — pending, keep actual trace settings with results.
- [ ] Preserve visual output on the forest consumer. proof: two matched headed WebGPU captures per arm and a fresh read-only visual judge — pending.
- [ ] Pass the required selected repository checks for the candidate. proof: `pnpm typecheck`, `pnpm lint`, `pnpm test` and selected native/playtest lanes — pending; use focused checks while iterating and laptop for long CPU jobs.

## Decisions

- 2026-10-15 (Codex): A module-level WeakMap alone does not eliminate graph walks and is rejected. The validation counter must continue to report actual work; do not optimize only the metric.
- 2026-10-15 (Codex, Argon read-only architecture review): Pass caching rejected. Graph getters/readers and synchronous Three added/removed listeners can mutate shared material graphs between batches. Keep each check and reduce temporary allocation instead. Initial docs check passed: 3,097 links; pre-push hook refused missing workspace build, so no remote branch or PR exists yet.
