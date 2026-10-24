---
prd_contract: v1
---

# PRD-730 — The merge queue reuses a green run of the same tree

**Status:** IN PROGRESS
**Priority:** P1 — Owner order 2026-10-23: a merge group whose tree a green pull-request run already tested must not run the full board again.
**Owner:** ci-reuse lane
**Complexity:** 2 → MEDIUM; risk override: none (a pass may only come from a proven identical tree, every doubt runs the board).
**Progress:** 0/3 phases verified.

## Scope

Evidence: PR #541 passed CI run 40036262286 on `2f213906d` (70 of 73 jobs green, 3 skipped by design). The merge-queue runs 40041268137 and 40046171681 then ran the same 73-job board on commit `4d6d854c4`. Its tree (`4bfa8be7f`) is the tree of the PR head and of the PR merge commit `1316eb6d1`. Develop had not moved.

The tree reuse of [PRD-481](PRD-481-ci-does-each-piece-of-work-once.md) cannot help here. `UNPROVEN_REUSE_BOARDS` in `scripts/ci-change-scope.mjs` blocks it, because the current run's matrix expansion is not authoritative. This PRD adds one narrow exception for the `merge_group` event: the merge-group commit has the same tree as the head of the pull request it names, and that head has a green full run. Keep the queue contract of [PRD-550](PRD-550-a-change-merges-within-30-minutes.md). Push, pull_request, schedule and workflow_dispatch events do not change. The board is not trimmed and no workflow file is added.

Integration: `ci-change-scope.mjs` (scope job) → `plan.selection = reused` → `ci-required.mjs` re-verifies the same facts and writes a receipt.

## Execution Phases

#### Phase 1 — Decide the reuse

- [ ] `queueHeadReuse` in `scripts/ci-change-scope.mjs` returns a source run only when all of these hold: the PR head tree equals the merge-group tree; the newest `pull_request` run of that head concluded success in its latest attempt; `ci-required` and every board job the full plan requires (matrix legs by name) succeeded in it; the run's tested candidate (from its Integration receipt artifacts) has the same tree and parents `[base, head]`; the PR plan, recomputed from those parents, is `full` with the same or a stronger native tier. proof: `pnpm exec vitest run scripts/__tests__/ci-queue-reuse.spec.ts`, red before the change and green after.
- [ ] Every miss, ambiguity or API error returns a normal full plan with the reason `tree reuse unavailable: ...`. proof: the same spec (different tree, red or cancelled run, narrowed run, API failure).
- [ ] Events other than `merge_group` never use the new path. proof: the same spec (pull_request, push, workflow_dispatch).

#### Phase 2 — Wire it into the workflow

- [ ] `ci.yml` passes `github.event.merge_group.head_ref` to the scope job and to `ci-required`. `ci-required.mjs` re-runs the decision, requires the same source run id, names the run id and tree in its summary, and writes `artifacts/ci-queue-reuse/receipt.json`, which a step uploads. proof: the same spec runs `ci-required.mjs` against a reused plan and reads the receipt; `pnpm exec vitest run scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts scripts/__tests__/ci-efficiency.spec.ts`.
- [ ] `AGENTS.md` names the exception in one sentence and `pnpm sync:agents` regenerates the mirrors. proof: `pnpm sync:agents --check`.

#### Phase 3 — Validate

- [ ] Every spec that reads `.github/workflows/*.yml` or the CI scripts passes, plus typecheck, lint and the doc checks. proof: `pnpm typecheck`, `pnpm lint`, `pnpm exec vitest run scripts/__tests__/ci-*.spec.ts`, `pnpm check:docs`.
- [ ] Read-only check of the decision against the real run data of #541. proof: `queueHeadReuse` run against run 40036262286, pull request 541 and queue commit `4d6d854c4` returns a reuse.

## Decisions

- Reuse needs the PR head tree and the tested candidate tree to equal the merge-group tree. A pull request that was behind its base when it ran has a different candidate tree, so it runs the board again.
- The pull-request head is read with `git ls-remote origin refs/pull/<n>/head` (the queue ref carries the PR number and the base sha, not the head sha). This needs no `pull-requests` permission.
- Runner class is not compared. The source run is the identical tree and workflow on a green `ci-required`, and the existing per-job runner comparison belongs to the generic cross-commit reuse, which stays disabled.
- Integration and native-platforms legs are trusted through the source run's `ci-required`, which validated their receipts against the same plan. The unit, template and golden matrices are checked leg by leg by name.

## Blocked on

- A real merge-group run is the only full proof of the workflow wiring. It needs a PR to enter the queue after the branch carrying this change is merged to develop (owner or coordinator).
