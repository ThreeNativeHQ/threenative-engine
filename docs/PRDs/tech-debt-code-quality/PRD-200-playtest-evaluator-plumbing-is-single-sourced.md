---
prd_contract: v1
---

# PRD-200 — Playtest evaluator plumbing is single-sourced

**Status:** NOT STARTED

**Priority:** P2 — Open boxes collapse about 18 hand-copied pass/fail predicates into one helper.
**Complexity:** +2 for 6–10 files, +2 for refactoring the harness's judgement core, +1
multi-lane (browser/device runners), +1 for the decompose phase = **6 → MEDIUM mode**.

## Context

Three scan findings share one theme — the code that decides pass/fail and reports it is
hand-copied:

- **#5:** the triviality-guard predicate `pass = comparisonPass && (!trivial || typeof
  assertion.allowTrivial === "string")` is repeated verbatim ~18× (`evaluators/
  movement-evidence.ts` ×16, `world-gameplay.ts` ×2). The anti-vacuous-green control has
  18 independent copies; one drifts and vacuous greens return.
- **#6:** `buildReport` takes 14–16 positional args per target (`runner/runner.ts:515`,
  `androidRunner.ts:362`) with four bare `undefined`s in a row; transposing two same-typed
  neighbours compiles clean and corrupts one target's report.
- **#13:** `movement-evidence.ts` is one ~600-line function evaluating ~15 assertion kinds
  as sequential if-blocks.

Files analyzed: the four paths above.

## Solution

- One exported triviality-guard helper; every call site consumes it.
- `buildReport` takes an options object; call sites read at a glance.
- Split movement-evidence into per-kind evaluators dispatched by assertion kind, each
  small enough to review against its spec rows. Mechanical move — zero verdict changes,
  proven by golden outputs before/after on existing scenarios.

## Integration Ledger

| # | Changed thing | Live caller | Replaces | Negative control |
| --- | --- | --- | --- | --- |
| 1 | Triviality guard helper | all 18 evaluator sites | 18 inline copies | diverge one copy from the helper → consistency test red |
| 2 | Options-object `buildReport` | `runner.ts:515`, `androidRunner.ts:362` | positional signature | transpose attempt no longer compiles; report diff test guards values |
| 3 | Per-kind movement evaluators | the evaluator dispatch entry point | the 600-line if-chain | golden verdict files must be byte-identical pre/post |

## Execution Phases

### Phase 1 — The triviality guard has one definition

**Files (4):** new shared guard module in `packages/playtest/src`, `movement-evidence.ts`,
`world-gameplay.ts` (EDIT), evaluator spec (EDIT).

- [ ] Helper exported; all ~18 sites import it; grep proves zero inline copies remain.
- [ ] A consistency test fails if any inline copy reappears (grep-based or lint rule).
- [ ] Red first: paste the current 18-copy grep count.

Mutation for red: reintroduce one inline copy → consistency test red.

### Phase 2 — buildReport reads by name

**Files (3):** `runner.ts`, `androidRunner.ts`, runner spec (EDIT).

- [ ] Options object with required target identity fields; no positional undefined runs.
- [ ] Existing report bytes unchanged for a captured run (golden diff).
- [ ] Red first: demonstrate today's transposition risk — swap two adjacent args in a
      scratch branch, show typecheck stays green while the report corrupts; paste both.

Mutation for red: revert one call site to positional — typecheck must fail.

### Phase 3 — movement-evidence splits by assertion kind

**Files (4):** `movement-evidence.ts` (+ new per-kind modules ≤5 total this phase),
evaluator spec, golden verdict fixtures (EDIT).

- [ ] Dispatch table maps assertion kind → evaluator; each function reviews against its
      kind's spec rows.
- [ ] Golden run over existing scenarios produces byte-identical verdicts.
- [ ] No dead branch remains: kinds map 1:1 to dispatch entries.

Observe red by flipping one kind's dispatch to a neighbour — the golden diff must catch
it.

## Verification

Record `docs/verification/prd-200-evaluator-plumbing-<date>.md`.

1. Focused specs per phase; mutations pasted red.
2. Golden-verdict diff across all in-repo scenarios pre/post phases 1–3 (must be empty).
3. One browser playtest via the CLI proving reports still generate end-to-end.
4. `grep -c` for the guard predicate shows 1 definition + 0 inline copies.

## Acceptance Criteria

- [ ] Exactly one definition of the anti-vacuous predicate exists and a gate fails when a
      second appears.
- [ ] No caller of `buildReport` passes positionally; a transposed call cannot compile.
- [ ] Verdicts are byte-identical across the refactor for every in-repo scenario.
- [ ] Net LOC in the touched files decreases (scan promised ~100–150 removable).
