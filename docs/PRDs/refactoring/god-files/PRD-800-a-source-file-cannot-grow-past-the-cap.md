# PRD-800 — A source file cannot grow past the cap

**Status:** NOT STARTED
**Priority:** P2 — `world-tiles.ts` regrew 536 lines past PRD-595's cap with no gate failing, so every split in this batch can be undone the same way (all phases open).
**Complexity:** 2 (LOW)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](README.md)

## Context

- `scripts/check-quality.ts:183` raises `file-length` findings; `fatalQualityFindings` (`:477`) fails only suppression-class findings. The ratchet baseline is `docs/verification/quality-baseline.json`.
- Files over 3 000 lines on 2026-11-04 under `packages/*/src`: `render/virtual-shadow.ts` 3 807, `assets/src/compile.ts` 3 520, `world-tiles.ts` 3 416, `three-native/src/browser-backend.ts` 3 405. Near it: `world-cells.ts` 2 977, `game.ts` 2 929, `world-gpu-scene.ts` 2 895, `world-cell-render.ts` 2 875.
- Root `AGENTS.md`: "make performance mistakes painful to write"; this PRD applies the same rule to file size.

## Solution

In `pnpm quality`, a source file over 3 000 lines is a fatal finding. Files over the cap today are
listed in the baseline at their current length: they may shrink and may not grow. The baseline
entry drops when the file goes under the cap. The 400 and 800-line findings stay informational.

## Acceptance Criteria

- [ ] AC-1 [local]: A new source file over 3 000 lines fails `pnpm quality` and names the file. proof: `pnpm exec vitest run scripts/__tests__/check-quality.spec.ts` — Evidence: pending.
- [ ] AC-2 [local]: A baselined file that grows fails, and one that shrinks passes and tightens its entry. proof: same spec — Evidence: pending.
- [ ] AC-3 [local]: `pnpm quality` passes on today's tree with the four files baselined. proof: `pnpm quality` exit 0 — Evidence: pending.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| File cap | `pnpm quality` → `fatalQualityFindings` | The `file-length` finding stays; the cap adds a fatal class | AC-1 to AC-3 |

## Execution Phases

#### Phase 1: pin
**Status:** NOT STARTED
**Files:** `scripts/__tests__/check-quality.spec.ts`
- [ ] Today's behaviour pinned: a 3 001-line fixture gives a non-fatal `file-length` finding. Green on today's code. proof: `pnpm exec vitest run scripts/__tests__/check-quality.spec.ts`

#### Phase 2: the cap
**Status:** NOT STARTED
**Files:** `scripts/check-quality.ts`, `docs/verification/quality-baseline.json`
- [ ] The fixture now fails, red then green; growth of a baselined file fails; shrink passes. proof: AC-1 and AC-2
- [ ] The four files are baselined and the tree passes. proof: AC-3
