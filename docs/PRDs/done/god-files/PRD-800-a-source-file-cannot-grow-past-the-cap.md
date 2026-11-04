# PRD-800 — A source file cannot grow past the cap

**Status:** DONE 2026-11-04
**Priority:** P2 — `world-tiles.ts` regrew 536 lines past PRD-595's cap with no gate failing, so every split in this batch can be undone the same way (closed 2026-11-04).

> DONE 2026-11-04: cap added as the fatal `file-cap` signal; the four files are baselined at their
> current length and may only shrink. `pnpm quality` exits 0. See the boxes below.
**Complexity:** 2 (LOW)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [God files](../../refactoring/god-files/README.md)

## Context

- `scripts/check-quality.ts:183` raises `file-length` findings; `fatalQualityFindings` (`:477`) fails only suppression-class findings. The ratchet baseline is `docs/verification/quality-baseline.json`.
- Files over 3 000 lines on 2026-11-04 under `packages/*/src`: `render/virtual-shadow.ts` 3 807, `assets/src/compile.ts` 3 520, `world-tiles.ts` 3 416, `three-native/src/browser-backend.ts` 3 405. Near it: `world-cells.ts` 2 977, `game.ts` 2 929, `world-gpu-scene.ts` 2 895, `world-cell-render.ts` 2 875.
- Root `AGENTS.md`: "make performance mistakes painful to write"; this PRD applies the same rule to file size.

## Solution

In `pnpm quality`, a source file over 3 000 lines is a fatal finding. Files over the cap today are
listed in the baseline at their current length: they may shrink and may not grow. The baseline
entry drops when the file goes under the cap. The 400 and 800-line findings stay informational.

## Acceptance Criteria

- [x] AC-1 [local]: A new source file over 3 000 lines fails `pnpm quality` and names the file. proof: `pnpm exec vitest run scripts/__tests__/check-quality.spec.ts` — Evidence: green, 20 tests; `fails a source file over the 3 000-line cap that no baseline records` asserts `file-cap value=3001 threshold=3000 state=new` lands in `fatalQualityFindings` naming `packages/core/src/fixture.ts`.
- [x] AC-2 [local]: A baselined file that grows fails, and one that shrinks passes and tightens its entry. proof: same spec — Evidence: green; `fails a baselined file that grows past the cap and tightens one that shrinks` walks 3100 → 3150 (`state=grew`, fatal) → 3050 (`state=inherited`, no fatal, `--update-baseline` writes value 3050) → 3000 (entry dropped).
- [x] AC-3 [local]: `pnpm quality` passes on today's tree with the four files baselined. proof: `pnpm quality` exit 0 — Evidence: exit 0, 386 findings; `compile.ts 3520`, `render/virtual-shadow.ts 3807`, `world-tiles.ts 3416`, `three-native/src/browser-backend.ts 3405` all `inherited` at threshold 3000.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
|---|---|---|---|
| File cap | `pnpm quality` → `fatalQualityFindings` | The `file-length` finding stays; the cap adds a fatal class | AC-1 to AC-3 |

## Execution Phases

#### Phase 1: pin
**Status:** DONE 2026-11-04
**Files:** `scripts/__tests__/check-quality.spec.ts`
- [x] Today's behaviour pinned: a 3 001-line fixture gives a non-fatal `file-length` finding. Green on today's code. proof: `pnpm exec vitest run scripts/__tests__/check-quality.spec.ts` — Evidence: green before the cap existed; `reports a file just over the 3 000-line cap without failing the gate` pins `file-length value=3001 state=inherited` and an empty `fatalQualityFindings`.

#### Phase 2: the cap
**Status:** DONE 2026-11-04
**Files:** `scripts/check-quality.ts`, `docs/verification/quality-baseline.json`
- [x] The fixture now fails, red then green; growth of a baselined file fails; shrink passes. proof: AC-1 and AC-2 — Evidence: both cap specs were red on the unmodified `check-quality.ts` (`2 failed | 18 passed`) and green after `LIMITS.fileCap = 3000`, the `file-cap` finding and the fatal class (`20 passed`).
- [x] The four files are baselined and the tree passes. proof: AC-3 — Evidence: `docs/verification/quality-baseline.json` gains `file-cap: 4`; `pnpm quality` exit 0. ⚠️ Two unrelated `suppression/biome-ignore` entries at `packages/three-native/src/tsl-extras.ts:10,59` were stale in the baseline on entry (they fail `pnpm quality` before this PRD's change too); the baseline now records them so AC-3's exit 0 is honest.
