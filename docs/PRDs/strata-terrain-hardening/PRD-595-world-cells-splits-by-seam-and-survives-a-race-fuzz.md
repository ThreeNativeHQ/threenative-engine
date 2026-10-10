# PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz

**Status:** NOT STARTED
**Priority:** P2 — `world-cells.ts` is 10 228 lines and its async load/evict orderings are proven for one interleaving only (AC-1 to AC-3).
**Complexity:** 5 (MEDIUM); risk override: complex async state
**Owner:** ThreeNative maintainers
**Depends on:** None (coordinate with [PRD-473](../open-world/PRD-473-open-worlds-hold-120-fps-gpu-driven.md), which edits the same file)
**Epic:** [Strata terrain hardening](README.md)

## Context

Core audit of `2d2124792` (2026-10-10):

- `packages/core/src/world-cells.ts` is 10 228 lines (about 9 100 before #381). `WorldCells`
  runs from line 4101 to the end with 183 private methods. The file also holds `SharedBatch`
  (1098), `BundleSurfaceSafety` (3163), `ModelLoadLimiter` (3970), `AdmissionBudget` (4038) and the
  shadow-proxy merge helpers (2687–3100).
- HLOD load (`world-cells.ts:9454-9490`) reserves bytes before the load and rechecks
  `#cellLive`/`cancelled` after. The asset path (`8043-8068`) hands a model that finished after
  `wanted()` turned false to `#adoptAsset` without a check at the call site.
  `world-cells-hlod.spec.ts:394-410` covers one ordering.
- Misplaced JSDoc: two blocks back to back before `#disposeLoaded` (about `10059-10069`); in
  `frame-budget.ts`, `dispose()` sits between `beginFrame`'s JSDoc and `beginFrame`.

## Solution

Write the race fuzz first, against today's file, so that the split is proven behaviour-preserving.
Then extract by seam with no logic change: `world-cell-batches.ts`, `world-load-limiter.ts`,
`world-bundle-safety.ts`, `world-chunk-shadow.ts`. Fix any race the fuzz finds in its own commit,
red then green.

## Acceptance Criteria

- [ ] AC-1 [local]: A seeded fuzz of 1 000 interleavings of load completion, eviction, `dispose()` and re-entry ends with `#bytes`, `#hlodBytes` and refcounts at 0, and each geometry disposed exactly once. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-race.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: After the split, no file under `packages/core/src/world-*` exceeds 3 000 lines, and all existing world specs pass unchanged. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` plus `pnpm quality` — Evidence: pending.
- [ ] AC-3 [local]: The strata preview and machinefall walk playtests still pass after the split. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and the machinefall map-walk scenario — Evidence: pending.

## Execution Phases

#### Phase 1: fuzz first
**Status:** NOT STARTED
**Files:** `packages/core/__tests__/world-cells-race.spec.ts` (new)
- [ ] Fuzz green on today's code, or a found race fixed red-green. proof: `world-cells-race.spec.ts`

#### Phase 2: extract by seam
**Status:** NOT STARTED
**Files:** `packages/core/src/world-cells.ts` → four new modules
- [ ] Files under 3 000 lines, specs unchanged. proof: world specs + `pnpm quality`
- [ ] Walk playtests pass. proof: preview + machinefall scenarios
