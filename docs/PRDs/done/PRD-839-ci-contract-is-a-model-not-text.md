# PRD-839 — The CI contract is a model, not text matches

**Status:** DONE — Phases 1-3 landed, AC-1 verified locally and AC-2 met on run `42533915867` (25 of 25 job names identical to the last comparable run).
**Priority:** P2 — open Phase 1 replaces 594 raw-text assertions on `ci.yml`, which one in three CI commits has to patch, and Phase 3 drops a proof that splices a historical workflow.
**Complexity:** 5 (MEDIUM)
**Owner:** ThreeNative maintainers
**Depends on:** None
**Batch:** [Untangle report, 2026-11-06](../refactoring/untangle-2026-11-06/README.md) — N2

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

- [x] AC-1 [local]: The CI contract specs pass, and a `pnpm ci:local --affected` plan for a sample diff is unchanged before and after. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-integration-scope.spec.ts` plus a plan diff. Plan diff done 2026-11-08: `node scripts/ci-change-scope.mjs --event pull_request --target develop --base B --head H --local --queue-lane --format json` for 11 real commit ranges, before (`5bd45931a`) and after: all 11 identical once the 40-character candidate SHA is normalized. Spec run 2026-11-08 on the integration worktree (`refactor/untangle-832-842` after the lane merge, every package built): `npx vitest run scripts/__tests__/ci-*.spec.ts` → **28 files, 889 passed**, including the three named specs and the QuickJS packaged-fallback case that the lane worktree could not resolve (it lacked a built `@threenative/assets`). `pnpm typecheck` → EXIT=0.
- [x] AC-2 [shared]: One real PR run selects the same jobs as the last comparable run. proof: the `ci.yml` run on the PRD's PR, job list compared. **Met 2026-11-08:** run `42533915867` (head `d674d4f00`, after the three lane merges and `origin/develop`) and the previous comparable run `42452768709` (head `5bd45931a`) both scheduled **25 jobs, identical names, no diff** (`gh run view <id> --json jobs` → sorted name lists). The scope kept the same selection even though this head adds native C++ changes; the review lane's exemptions (`native-engine`, `native-platforms`, `performance-contracts`, `integration`) are the same on both. Status of the run is separate from selection: it went red on `budgets` (stale native-coverage digest) and `test-unit` (a `gh: server error` while the impacted lane ran), not on the selection this box judges.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Change-scope plan | `ci.yml` scope job → `ci-change-scope.mjs` | Split, re-exported until callers move | Phase 2 |

## Execution Phases

#### Phase 1: Workflow model
**Status:** DONE
**Files:** `scripts/ci-workflow.ts`, `scripts/__tests__/ci-structure.spec.ts`.

- [x] `ci-workflow.ts` returns jobs with `if`, `needs`, steps, `with` and `env`, and an absent field throws. proof: `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts` -> 200 passed, 1 failed. The failure is "selects QuickJS for the packaged fallback", which cannot resolve `@threenative/assets` (no `dist`, and `pnpm --filter @threenative/assets build` fails in this worktree). The same test fails the same way on the unchanged spec from `5bd45931a`. The new test "fails closed when the workflow model is asked for a field, job or step that is absent" passes: `ci.job`, `job.require`, `job.step`, `job.stepById`, `step.require` and `parseWorkflow` throw named errors (`CI_WORKFLOW_NO_JOB`, `CI_WORKFLOW_MISSING_FIELD`, `CI_WORKFLOW_STEP`, `CI_WORKFLOW_SHAPE`). 2026-11-08
- [x] The job-shape invariants read the model, and the text-assertion count in the spec drops by at least half. proof: `rg -c 'toContain\(|indexOf\(' scripts/__tests__/ci-structure.spec.ts` -> 261 against a measured baseline of 593 on the unchanged file at `5bd45931a` (a 56% drop; the half-way bar is 296). Mutation spot-checks on a copy of the YAML, each restored after the run: `native-engine` cache key renamed, `golden-path-template` `needs` reduced to `[scope]`, `TN_SUITE_PHASES` shortened, `max-parallel` raised in `performance-regression.yml`, and `timeout-minutes` removed from `scope`. The matching converted test failed in all five cases. 2026-11-08

#### Phase 2: Classifier split
**Status:** DONE
**Files:** new `scripts/ci/classify.mjs`, `scripts/ci/reuse.mjs`; `scripts/ci-change-scope.mjs`, `ci-integration-scope.mjs`, `ci-runner-admission.mjs`.

- [x] `classify.mjs` imports no `fs`, `child_process` or `gh` helper, and the old module re-exports it. proof: `rg '^import|child_process|node:fs' scripts/ci/classify.mjs` -> no match; `pnpm exec vitest run scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-integration-scope.spec.ts` -> 2 files, all tests pass; 13 other `ci-*` specs also pass (`ci-local`, `ci-native-chain`, `ci-efficiency`, `ci-leg-carry`, and others). `ci-change-scope.mjs` is a facade that binds `TEMPLATE_NAMES` and re-exports the pure classifier from `scripts/ci/classify.mjs` and the git, `gh` and reuse rules from `scripts/ci/reuse.mjs`. 2026-11-08

#### Phase 3: Live proofs only
**Status:** DONE
**Files:** `scripts/__tests__/ci-integration-scope.spec.ts`.

- [x] The historical splice is replaced by explicit native and browser routing cases on the live model. proof: `pnpm exec vitest run scripts/__tests__/ci-integration-scope.spec.ts` -> 96 passed; `rg -c 49f76db scripts/__tests__/ci-integration-scope.spec.ts` -> 0. Mutation check: removing the `exposure` route made 3 of the new cases fail, and the revert made them pass. 2026-11-08

## Corrections

- 2026-11-08: The Context table and the Phase 1 box name a baseline of 594 `toContain` / `indexOf` matches. The same `rg -c` on the unchanged file at `5bd45931a` prints 593. Phase 1 uses 593. The half-way bar moves from 297 to 296.
- 2026-11-08: Some `toContain` matches stay by design. They check a fragment of a shell script (a `run:` body), which the model returns as a string. The converted tests read those fragments from the parsed step through the `expectIncludes` and `expectExcludes` helpers, and read presence checks through `job.mentions()` and `job.runs()`, which ignore comments. The count therefore measures remaining raw-text matches, not remaining job-shape matches.
