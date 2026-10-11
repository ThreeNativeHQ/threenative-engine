# PRD-595 — `world-cells.ts` splits by seam and survives a load/evict race fuzz

**Status:** PARTIAL
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

- [x] AC-1 [local]: A seeded fuzz of 1 000 interleavings of load completion, eviction, `dispose()` and re-entry ends with `#bytes`, `#hlodBytes` and refcounts at 0, and each geometry disposed exactly once. proof: `pnpm exec vitest run packages/core/__tests__/world-cells-race.spec.ts` — Evidence: 2026-10-11 independent focused gate passes all 1 000 seeds in 2.31 s; every seed observes positive public residentBytes and then zero residentBytes, HLOD bytes and refcounts; 1 651 actual loaded geometries each dispose exactly once.
- [ ] AC-2 [local]: After the split, no file under `packages/core/src/world-*` exceeds 3 000 lines, and all existing world specs pass unchanged. proof: `pnpm exec vitest run packages/core/__tests__/world-*.spec.ts` plus `pnpm quality` — Evidence: pending.
- [ ] AC-3 [local]: The strata preview and machinefall walk playtests still pass after the split. proof: `pnpm --filter strata-terrain-preview test:terrain:web` and the machinefall map-walk scenario — Evidence: pending.

## Execution Phases

#### Phase 1: fuzz first
**Status:** DONE
**Files:** `packages/core/__tests__/world-cells-race.spec.ts` (new)
- [x] Fuzz green on today's code, or a found race fixed red-green. proof: `world-cells-race.spec.ts` — 2026-10-11 all 1 000 seeds pass with actual charged-byte telemetry and nonempty lifecycle observations; no lifecycle race found.

#### Phase 2: extract by seam
**Status:** PARTIAL
**Files:** `packages/core/src/world-cells.ts` → four new modules
- [ ] Files under 3 000 lines, specs unchanged. proof: world specs + `pnpm quality`
- [ ] Walk playtests pass. proof: preview + machinefall scenarios

2026-10-11 Phase 1 resident-byte observation completed: added readonly `residentBytes` to existing `IWorldCellsStats`, returning actual `#bytes`; its documentation distinguishes placement residency charges from separately reported far-impostor/HLOD charges. The required red run failed all 1,000 seeds before the field existed because positive resident bytes could not be observed; after the minimal field addition every seed observes positive bytes and asserts zero bytes after draining. Independent focused gate passes in 2.31 s: 1,651 loads and actual geometries disposed exactly once, 417 pending disposals, 476 late completions, 1,428 evictions, 31 reentries, 357 seeds with positive HLOD bytes and all 1,000 with positive refcounts. Nearest unchanged `world-cells.spec.ts` and `world-cells-admission.spec.ts` pass 58 tests (14.01 s). Core typecheck passes after building this lane’s missing playtest dependency; no shared mutable dependency/build links were introduced. Scoped Biome passes with 22 existing/new nonfatal complexity warnings (one in the new scenario). The bounded Haiku arm timed out after saving its changes/logs; coordinator reviewed the diff and independently reran core typecheck and the fuzz gate. Parent review independently passes all 1,000 seeds (2.02 s), observing 1,650 loaded geometries disposed exactly once, 417 pending disposals, 476 late completions, 1,428 evictions, 31 reentries and 356 positive-HLOD seeds. Counts can vary with admission timing; each run retains the same seeded decisions and asserts every teardown invariant. No extraction, full-world suite or preview/machinefall proof is claimed; Phase 2 and AC-2/3 remain open.

2026-10-11 Phase 2 first mechanical seam (PARTIAL): moved the queued model-load interface, `ModelLoadLimiter` and `AdmissionBudget` with their intact bodies/JSDoc to internal `world-load-limiter.ts`; dependencies are only type imports `Object3D` and existing `IAdmissionBudget` from `world-tiles.ts`. No public index export, behavior change, new dependency or test-file modification. Automated comparison confirms the moved block matches the committed original except class export keywords. Existing WorldCells/admission specs pass 58 tests (9.86 s); the unchanged 1,000-seed fuzz passes (2.03 s); core typecheck and scoped Biome pass (20 nonfatal warnings). The Haiku arm timed out at 600 seconds after saving the verified changes/logs; coordinator reviewed the diff and exact-body comparison. The module is 106 lines and `world-cells.ts` remains 10,230 lines, so the 3,000-line criterion is explicitly unfulfilled; other named seams, larger coherent class subsystems, the full unchanged world suite and preview/machinefall playtests remain open.
