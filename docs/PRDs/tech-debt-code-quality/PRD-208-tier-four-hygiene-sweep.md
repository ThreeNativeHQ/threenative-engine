---
prd_contract: v1
---

# PRD-208 — Tier-4 hygiene sweep

**Status:** NOT STARTED

**Priority:** P3 — Open boxes delete zero-caller aliases behind pasted caller censuses; low-impact hygiene.
**Complexity:** +3 for 10+ files, but every item is deletion/comment/single-sourcing with
no behaviour change except DebugOverlay = **5 → MEDIUM mode** (mechanically wide, risk
low).

## Context

Scan Tier 4: items explicitly marked "fold into neighbouring work" that have no neighbour
in this batch. Grouped here so they stop rotting in the audit file. Every deletion needs
a pasted zero-caller census before it lands.

## Work items

**Dead/speculative API — delete with zero-caller proof:**

- [ ] `AudioBus.reparent()` alias, zero callers (`core/src/audio.ts:151`).
- [ ] `export type ProjectionCamera = Camera`, unreferenced (`core/src/renderProjection.ts:334`).

**Drift-risk constants — single-source:**

- [ ] Gesture event list written twice (`core/src/audio.ts:124,243`) → one list.
- [ ] Assets layout constants mirrored in `assets/watch.ts:64` vs `compile.ts:146`;
      `messageOf` ×3 (`compile.ts:146`) → one owner module.

**Tribal knowledge — name it or kill it:**

- [ ] `["ma"+"terial"]` split-string idiom at 3 sites (`core/assets.ts:435`,
      `renderer.ts:58,69`) → one named constant/helper with a comment saying why the
      split exists.
- [ ] 13 stale "Extracted verbatim from runner.ts (PRD-182)" anchors across 11 files sit
      over code they did not extract → re-anchor to truth or delete. An agent preserving
      a defect to honour a comment is worse than no comment.

**Scripts:**

- [ ] `isRecord` ×6 and duplicated `freePort` in `scripts/` → one shared util module.
- [ ] `verify-golden-path.ts` (971 lines) carries its own MCP JSON-RPC client → extract
      to a reusable module beside the other MCP tooling.

**UI / navigation glue:**

- [ ] `DebugOverlay` polls at 10 Hz even closed (`packages/ui/src/DebugOverlay.tsx:23`)
      → poll only while visible; behaviour test proves zero ticks when hidden.
- [ ] `finitePositive` ×3, `toNavigationVector` ×2 within the navigation subpath → one of
      each.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Deleted dead API | — must show zero callers pre-delete | the dead symbols themselves | census grep pasted empty; suite green |
| 2 | Single-sourced constants/lists | both former copy sites | second literals | diverge one site → typecheck/test red |
| 3 | Named material-key helper | the 3 idiom sites | inline split-strings | grep: zero remaining split-string forms |
| 4 | Truthful anchors | future agents reading comments | 13 stale markers | spot-check each anchor against git history of the code under it |
| 5 | Hidden-overlay polling fix | DebugOverlay lifecycle | always-on interval | closed overlay → tick counter static (test red on revert) |

## Execution Phases

### Phase 1 — Deletions and constants (core + assets)

**Files (5):** `audio.ts`, `renderProjection.ts`, `watch.ts`/`compile.ts` shared home,
affected specs (EDIT).

### Phase 2 — Idioms, anchors and scripts

**Files (5 max per increment):** assets/renderer sites, the 11 anchor files (bulk edit),
new scripts util, `verify-golden-path.ts` extraction.

### Phase 3 — UI polling and navigation glue

**Files (4):** `DebugOverlay.tsx`, navigation subpath files, ui spec, navigation spec
(EDIT).

## Verification

Record `docs/verification/prd-208-hygiene-sweep-<date>.md`.

1. Zero-caller censuses for every deleted symbol, pasted.
2. Duplication greps return single hits after each consolidation.
3. Overlay tick-count test red on revert.
4. Full `pnpm typecheck && pnpm lint && pnpm test && pnpm budgets` green; no visual
   change expected — if any template renders differently, stop and investigate.

## Acceptance Criteria

- [ ] Nothing deleted had a caller; nothing single-sourced has a twin.
- [ ] No stale extraction anchor remains unverified.
- [ ] A hidden DebugOverlay performs zero polls.
- [ ] LOC strictly decreases; no new public API added anywhere in this PRD.
