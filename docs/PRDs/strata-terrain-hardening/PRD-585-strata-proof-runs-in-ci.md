# PRD-585 — Strata's proof runs in CI, not only by hand

**Status:** PARTIAL
**Priority:** P1 — No Strata playtest, consumer check or editor script runs in CI, so every later PRD in this epic can regress unseen (AC-1 to AC-5).
**Complexity:** 4 (MEDIUM); risk override: none
**Owner:** ThreeNative maintainers
**Depends on:** None
**Epic:** [Strata terrain hardening](README.md)

## Context

Audit of `2d2124792` (2026-10-10):

- `.github/workflows/ci.yml:125-126` and `:275-277` run only `pnpm --filter strata-terrain-preview bake`.
  No `test:terrain:*`, `test:kit`, `test:consumer` or `verify-*.mjs` runs in any workflow.
- `examples/strata-terrain-preview/package.json:12-20` wires 7 `verify-*.mjs` scripts; 10 more
  are chained from them, undocumented. `playtests/walk.playtest.json`, `scripts/measure-*.mjs`,
  `check-water.mjs`, `check-temperate.mts` and `consumer-world.mjs` are referenced by nothing.
- `packages/terrain/__tests__/forest-runtime.spec.ts:11` mocks `WorldCells.load`. No test loads
  a baked terrain world package through a real `WorldCells` (core audit D2).
- `editor.playtest.json` (60 lines) checks a vertex count and a screenshot. It does not
  exercise a tool, stroke, undo or save.

## Solution

Add one job to the existing `ci.yml` (no new workflow file; root `AGENTS.md`): `strata` runs
`test:terrain:web`, `test:consumer` and `test:terrain:editor` against the selected-scope rules in
`scripts/ci-change-scope.mjs`, so it runs when `packages/terrain/`, the example or the world
modules in core change. Add a real `WorldCells` integration spec. Delete the orphan scripts or
index them in the example's `AGENTS.md`.

## Acceptance Criteria

- [ ] AC-1 [shared]: The `strata` job runs `test:terrain:web` green on a PR touching `packages/terrain/`. proof: CI run link — Evidence: pending.
- [ ] AC-2 [shared]: The same job runs `test:consumer` and `test:terrain:editor` green. proof: CI run link — Evidence: pending.
- [x] AC-3 [local]: The change-scope selects the job for terrain, example and `world-cells` paths and skips it for an unrelated template. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts` — Evidence: PASS (213 tests), including `world.ts`, qualification, and required-verdict missing/skipped/failed/unmapped cases.
- [x] AC-4 [local]: A baked 3×3-cell package loads through a real `WorldCells`; walking across cells gives resident cells and instance counts equal to the bake. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-terrain.spec.ts` — Evidence: PASS (1 test); bounded drain fails on timeout and cleanup runs in `finally`.
- [x] AC-5 [local]: Every file under the example's `scripts/` and `playtests/` is wired from `package.json` or named in its `AGENTS.md`. proof: `pnpm exec vitest run scripts/__tests__/strata-script-census.spec.ts` — Evidence: PASS (1 test); recursive, nonempty inventory matches exact documented relative paths, including fixtures.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| Strata CI job | PR touching terrain paths → `ci.yml` `strata` | Bake-only steps | AC-1, AC-2 |
| Real package load | `bakeWorldPackage` → `WorldCells.load` | Mocked `WorldCells.load` | AC-4 |

## Execution Phases

#### Phase 1: integration spec and script census
**Status:** COMPLETE
**Files:** `packages/core/__tests__/world-cells-terrain.spec.ts` (new), `examples/strata-terrain-preview/AGENTS.md`, orphan scripts (delete or index)
- [x] Real `WorldCells` loads a baked package. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-terrain.spec.ts` — PASS (1 test); core typecheck also passed.
- [x] No unwired script or playtest is left. proof: census spec — PASS (1 test); original package scripts preserved, manual/preparation helpers indexed by purpose. `pnpm sync:agents`, mirror contracts (8 tests), and `pnpm check:docs` passed.

#### Phase 2: the CI job
**Status:** PARTIAL
**Files:** `.github/workflows/ci.yml`, `scripts/ci-change-scope.mjs`, `scripts/__tests__/ci-structure.spec.ts`, `scripts/__tests__/ci-needs.spec.ts`
- [x] Scope selects and skips correctly. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts` — PASS (213 tests); the existing protected main-job join rejects missing, skipped, failed and unmapped results. Focused Biome checks passed with complexity warnings.
- [ ] Web playtest green in CI. proof: CI run link
- [ ] Consumer and editor scripts green in CI. proof: CI run link

The local job wiring is verified; AC-1/AC-2 need a real candidate CI run with successful `strata` execution. Skipped draft checks are not runtime proof.
