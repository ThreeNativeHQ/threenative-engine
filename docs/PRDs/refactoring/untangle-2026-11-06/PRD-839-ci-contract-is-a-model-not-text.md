# PRD-839 — The CI contract is a model, not text matches

**Status:** NOT STARTED
**Priority:** P2 — open Phase 1 replaces 594 raw-text assertions on `ci.yml`, which one in three CI commits has to patch, and Phase 3 drops a proof that splices a historical workflow.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](README.md) — N2

## Context

Report ids G2, G3, G8. In 90 days, `ci.yml` changed in 135 commits and `ci-structure.spec.ts` in 106.

| Problem | Where |
| --- | --- |
| `ci-structure.spec.ts` is 5 048 lines with 121 tests and 594 `toContain` / `indexOf` assertions on raw workflow text | `scripts/__tests__/ci-structure.spec.ts:545-551` (`requiredJob`, `workflowRunScript`) |
| A workflow parser exists but yields only job names and `needs` | `scripts/ci-workflow.ts:49` |
| `ci-change-scope.mjs` mixes 4 modules: path classification, git, Actions API and run reuse, plan validation | `scripts/ci-change-scope.mjs:22-212,412-580,582-653,624-754,1027-1534` |
| A spec splices 1 042- and 3 688-character strings from candidate `49f76db` onto the live workflow | `scripts/__tests__/ci-integration-scope.spec.ts:620-652` |

## Solution

Grow `ci-workflow.ts` into a typed model: job → `if`, `needs`, steps, `with`, `env`. Missing fields
fail closed. The invariants in `ci-structure.spec.ts` become checks over the model. Text assertions
stay only where byte order is the requirement. The classifier splits into a pure
`scripts/ci/classify.mjs` (no `fs`, git or `gh`) and `scripts/ci/reuse.mjs`. The historical splice
becomes explicit cases against the live model.

## Acceptance Criteria

- [ ] AC-1 [local]: The CI contract specs pass, and a `pnpm ci:local --affected` plan for a sample diff is unchanged before and after. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-integration-scope.spec.ts` plus a plan diff
- [ ] AC-2 [shared]: One real PR run selects the same jobs as the last comparable run. proof: the `ci.yml` run on the PRD's PR, job list compared

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Change-scope plan | `ci.yml` scope job → `ci-change-scope.mjs` | Split, re-exported until callers move | Phase 2 |

## Execution Phases

#### Phase 1: Workflow model
**Status:** NOT STARTED
**Files:** `scripts/ci-workflow.ts`, `scripts/__tests__/ci-structure.spec.ts`.

- [ ] `ci-workflow.ts` returns jobs with `if`, `needs`, steps, `with` and `env`, and an absent field throws. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts`
- [ ] The job-shape invariants read the model, and the text-assertion count in the spec drops by at least half. proof: `rg -c 'toContain\(|indexOf\(' scripts/__tests__/ci-structure.spec.ts` against the 594 baseline

#### Phase 2: Classifier split
**Status:** NOT STARTED
**Files:** new `scripts/ci/classify.mjs`, `scripts/ci/reuse.mjs`; `scripts/ci-change-scope.mjs`, `ci-integration-scope.mjs`, `ci-runner-admission.mjs`.

- [ ] `classify.mjs` imports no `fs`, `child_process` or `gh` helper, and the old module re-exports it. proof: `pnpm exec vitest run scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-integration-scope.spec.ts`

#### Phase 3: Live proofs only
**Status:** NOT STARTED
**Files:** `scripts/__tests__/ci-integration-scope.spec.ts`.

- [ ] The historical splice is replaced by explicit native and browser routing cases on the live model. proof: `pnpm exec vitest run scripts/__tests__/ci-integration-scope.spec.ts`
