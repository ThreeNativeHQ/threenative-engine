---
prd_contract: v1
---

# PRD-203 — Template loading screens stop drifting

**Status:** NOT STARTED

**Priority:** P2 — Open boxes stamp one canonical loading screen into six templates by substitution.
**Complexity:** +2 for 6–10 files, +2 for a scaffold-mechanism change, +1 for the design
decision phase = **5 → MEDIUM mode**.

## Context

Scan finding #9: `loading.ts` is copy-pasted into six templates (~1,660 total lines) and
has structurally drifted — factory names differ, `if (done)` guard shapes differ, and the
platformer copy grew to 338 lines. `loading-screen.spec.ts` catches absence per template,
not divergence. Constraint from the Charter: templates' `src/render/` is dependency-free
generated user source — it may never import a framework package.

Files analyzed: all six `templates/*/src/render/loading.ts`, `loading-screen.spec.ts`,
and the scaffolder's template-stamping path.

## Solution (decision recorded here, revisited only if Phase 1 evidence contradicts)

Canonical `loading.ts` lives with the scaffolder as template source. Scaffold time stamps
it into every kit like any other generated file; per-kit appearance knobs (colours,
labels, timing) are template variables, not forked code. In-repo templates get
re-stamped, and a consistency spec diffs each in-repo copy against canonical so hand-edit
drift fails CI. Structure and factory names normalize; **look stays byte-equivalent per
kit** — normalizing structure must not silently change what players see.

Rejected alternative, for the record: runtime shared import — violates the dependency-free
`src/render/` rule.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Canonical loading source + stamping | scaffold generation path in create-threenative | six hand-copies | edit one in-repo copy's structure → consistency spec red |
| 2 | Consistency spec | template test suite (`pnpm test:templates`) | absence-only check | delete a copy entirely → both absence and consistency tests red |
| 3 | Normalized factories/guards | each template's bootstrap importing loading module | drifted per-kit names | grep: zero non-canonical factory signatures remain |

## Execution Phases

### Phase 1 — Decide and prove the mechanism on one template

**Files (4):** canonical source under create-threenative template assets (NEW),
scaffolder stamping path (EDIT), shooter or smallest-drifted template `loading.ts`
(EDIT), its spec (EDIT).

- [ ] Stamp produces byte-identical output to the template's current file after
      normalization (diff pasted).
- [ ] Appearance variables flow through template substitution, not post-hoc edits.
- [ ] Red first: paste today's structural drift (factory-name grep across the six).

Mutation for red: hand-edit the stamped output → consistency spec red.

### Phase 2 — Roll out to all kits and enforce

**Files (5):** remaining five `loading.ts` copies (EDIT), shared template consistency
spec (EDIT).

- [ ] Every kit stamped from canonical; platformer shrinks from 338 to canonical size +
      its variable block.
- [ ] Consistency spec runs in `pnpm test:templates`.
- [ ] Visual proof per kit: one playtest screenshot per template compared against
      pre-change baseline (`pnpm visuals`) — loading screen look unchanged.

## Verification

Record `docs/verification/prd-203-loading-single-source-<date>.md`.

1. Consistency spec green; mutation (hand-edit) observed red and pasted.
2. Scaffolder smoke: fresh scaffold of two different kits yields working loading screens.
3. `pnpm visuals` per template against baselines — no unintended pixel change.
4. LOC delta reported: ~1,660 lines across templates collapses to canonical + variables.

## Acceptance Criteria

- [ ] Exactly one canonical loading implementation exists; all six in-repo copies match it
      modulo declared appearance variables.
- [ ] Hand-editing an in-repo copy fails CI; editing canonical propagates via re-stamp.
- [ ] No template imports a package for its loading screen.
- [ ] Per-kit screenshots match pre-change baselines within threshold.
