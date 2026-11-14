# God files

**Status:** DONE 2026-11-04 — 5 of 5 PRDs archived to [`done/god-files/`](.). Every source file in the batch is under PRD-800's 3 000-line cap and cannot grow back into one. (filed 2026-11-04; PRD-800 archived to
[`done/god-files/`](.)).

**Goal:** no source file is a god file, and none can grow back into one. The world files that Strata
depends on are split in [strata-refactoring](../../../../packages/terrain/docs/PRDs/done/strata-refactoring/README.md) (PRD-797 to PRD-799).

## Evidence that files regrow

PRD-595 closed AC-2 on 2026-10-11 with every `world-*` file under 3 000 lines (`world-tiles.ts`
2 880). On 2026-11-04 `world-tiles.ts` is 3 416. `pnpm quality` (`scripts/check-quality.ts`) raises a
`file-length` finding at 400 and 800 lines and ratchets it against
`docs/verification/quality-baseline.json`, but only suppression-class findings fail the gate
(`fatalQualityFindings`, `check-quality.ts:477`). PRD-800 adds a fatal 3 000-line cap.

## PRDs, in execution order

| Order | Priority | PRD | File | Lines |
|---|---|---|---|---|
| 1 | P2 | [PRD-800](PRD-800-a-source-file-cannot-grow-past-the-cap.md) ✅ | the gate | — |
| 2 | P2 | [PRD-801](PRD-801-core-game-ts-boot-splits-by-phase.md) ✅ | `packages/core/src/game.ts` | 2 929 → 1 130 |
| 3 | P2 | [PRD-802](PRD-802-virtual-shadow-splits-and-owns-its-layers.md) | `packages/core/src/render/virtual-shadow.ts` | 3 807 |
| 4 | P2 | [PRD-803](PRD-803-browser-backend-splits-by-seam.md) ✅ | `packages/three-native/src/browser-backend.ts` | 3 405 → 1 810 |
| 5 | P2 | [PRD-804](PRD-804-assets-compile-splits-and-pins-its-config-errors.md) ✅ | `packages/assets/src/compile.ts` | 3 520 → 952 |

PRD-800 lands first so a split cannot be undone by the next feature. PRDs 801 to 804 touch separate
packages and may run in parallel.

## Same rules as the batch

Pin first, move without changing behaviour, keep the public entry (`index.ts`, `api-surface.json`)
unchanged, and re-export moved symbols from the old module until no consumer imports them.
