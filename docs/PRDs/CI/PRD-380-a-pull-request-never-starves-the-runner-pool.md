---
prd_contract: v1
---

# PRD-380 — A pull request never starves the runner pool

**Status:** PARTIAL — phases 1 and 2 complete; phase 3's janitor is in and its proof is a live merged PR
**Priority:** P2 — Only AC-1's seven-day runner-minute audit proof stays open.
**Complexity:** 6 → MEDIUM-HIGH (+1 workflow triggers, +1 reduced PR matrix, +1 scheduled janitor, +1 shared release concurrency, +1 guarded specs, +1 npm-release wiring).
**Owner:** CI release tooling.
**Problem:** The org's GitHub-hosted runner concurrency is small (roughly three runs at once) and it is consumed by matrices that a pull request does not need. On 2026-09-12 thirteen CI runs sat queued, five of them `main` pushes, while three heavy runs held the pool; a two-minute `build` join waited over an hour. Three multipliers: `native-release.yml` runs its macOS/Windows/Linux proof on **every** PR that touches one of four paths (including `native-platform-workflow.test.mjs`, which ordinary runtime-native PRs touch), `ci.yml` runs the **full** `native-platforms` matrix for any `selection == 'full'` PR, and nothing cancels a run whose PR has already merged, so dead runs keep holding runners. The owner's ask: pushing to a branch must not restart or stall the whole board.

Baseline: `develop`. [PRD-373](../done/PRD-373-selective-ci-and-develop-promotion.md) owns the selective-CI classifier and the develop→main promotion rule; this PRD narrows what the selection is allowed to spend a runner on. PRD-379 changes *how* `native-release` learns about CI completion; this PRD changes *what triggers* it.

## Decisions

- 2026-10-02 (João, via the CI audit): reshaped to the current PRD rules (proof on every box, no ceremony
  boxes, at most 3 phases). The old phase 4, one concurrency group for release proofs, folds into phase 1
  because it edits the same workflow. The janitor is a `pull_request: closed` trigger instead of a
  scheduled script. Linux native rows move to the owner's machine under
  [PRD-480](PRD-480-linux-ci-runs-on-the-owner-machine.md), so phase 2 is mainly about the hosted
  macOS, Windows and iOS legs. Measured 2026-09-18 to 10-02: native-release PR runs cost 7.0k
  runner-min, and runs still going after their PR merged or closed cost 5.0k.
- 2026-10-02 (phase 1): a promotion PR is `develop -> main`. PRD-373 retired the `promotion/<sha>`
  ref on 2026-09-12, so the proof's PR route keys on `github.event.pull_request.base.ref == 'main'`
  (which also covers the `hotfix/` emergency path, that branch's own full qualification) rather than
  on a branch prefix. The one shared concurrency group reverses the `head_sha`-in-the-group choice
  above on purpose: a superseded proof now queues instead of running beside a live one.

### Phase 1 — The release proof stops running on every PR push

**Status:** COMPLETE

**Files:** `.github/workflows/native-release.yml`, `.github/workflows/npm-release.yml`,
`.github/workflows/release-candidate.yml`, `scripts/__tests__/native-release-proof.spec.ts`,
`scripts/__tests__/ci-structure.spec.ts`.

- [x] Release proof never runs on an ordinary PR push. proof: `pnpm exec vitest run scripts/__tests__/native-release-proof.spec.ts`,
  which also asserts it still runs on a promotion PR, the `release-proof` label, manual dispatch and an npm `v*` release.
  Evidence: `native-release-proof.spec.ts` 2026-10-02, 61 passed; 3 new assertions red before the workflow change.
  The `pull_request.paths` filter is replaced by `types: [opened, synchronize, reopened, labeled]`, and
  `gates` — which every proof job `needs:` — now refuses an ordinary develop PR, so the whole board costs nothing.
  npm-release.yml and release-candidate.yml trigger no part of this proof and are unchanged.
- [x] At most one release proof holds runners at a time across branches. proof: `pnpm exec vitest run
  scripts/__tests__/ci-structure.spec.ts`, with a case asserting the shared concurrency group.
  Evidence: `ci-structure.spec.ts` 2026-10-02, 2 assertions red before the workflow change, 123 passed after.
  `group: native-release-proof`, `cancel-in-progress: false` kept.

### Phase 2 — PRs run a reduced native matrix; the full matrix stays on main and nightly

**Status:** COMPLETE

**Files:** `.github/workflows/ci.yml`, `.github/workflows/native-platforms.yml`,
`scripts/ci-change-scope.mjs`, `scripts/ci-required.mjs`,
`scripts/__tests__/ci-efficiency.spec.ts`, `scripts/__tests__/ci-needs.spec.ts`,
`packages/runtime-native/tests/starter-desktop.test.mjs`.

- [x] An ordinary PR selection emits only the Linux native rows. proof: `pnpm exec vitest run scripts/__tests__/ci-efficiency.spec.ts`.
  Evidence: `pnpm exec vitest run scripts/__tests__/ci-efficiency.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts`
  2026-10-02, 216 passed; 2 new assertions and 4 `ci-needs` cases red before the change, plus
  `packages/runtime-native` `native-platform-workflow` + `starter-desktop` 79 passed after it.
  The plan carries `nativeTier` (`full` | `reduced` | `none`), decided once in
  `scripts/ci-change-scope.mjs` from the change's native reach and its target branch, and
  `native-platforms.yml` reads it: `desktop` (macOS, Windows) and `ios-simulator` skip unless it is
  `full`, and `starter-linux` runs `linux-x64` alone — the arm64 row is shaped into the matrix by
  the `scope` job, because a job's `if` cannot read `matrix`. `web-reference`, `android-v8-source`,
  `android-emulator-parity` and `desktop-parity` are Linux rows and still run.
- [x] `main` pushes, the nightly and pull requests into `main` keep the full matrix. proof: `pnpm exec vitest run
  scripts/__tests__/ci-efficiency.spec.ts`, which also asserts no label exempts it.
  Evidence: same run as above, 2026-10-02, 216 passed; the case fails on the pre-change files.
  (This box read `promotion/*` PRs; phase 1 retired that ref, so the promotion route is
  `base.ref == 'main'` — see the 2026-10-02 phase-1 decision.) A `main` push, the nightly, an
  explicit `workflow_dispatch` and any merge group or pull request into `main` all classify
  `nativeTier: full`, no job in `native-platforms.yml` reads a pull-request label, and
  `ci-required` records the tier in its verdict — a reduced pass can therefore never stand in for a
  full requirement (PRD-481), which `ci-needs.spec.ts` proves in three cases.

### Phase 3 — A merged or closed PR stops spending runners

**Status:** IN PROGRESS — janitor landed, live proof pending.

**Files:** NEW `.github/workflows/ci-janitor.yml` (`pull_request: types: [closed]`, cancels the head
ref's queued and in-progress runs with `gh run cancel`), `scripts/__tests__/ci-structure.spec.ts`.

- [x] Closing or merging a PR cancels its head ref's in-flight runs within a minute. proof: the janitor run id
  and the cancelled run ids on one merged PR.
  The workflow and its guards are in: `ci-structure.spec.ts` 2026-10-02, 124 passed (the case was red
  with no `ci-janitor.yml`). Box stays open — the proof is a live merged PR, and until one merges the
  only executed evidence is a local `gh` stub, which is not the claim.
  Evidence: janitor run 37096061684 cancelled run 37095819714 when #410 merged; janitor run 37091826027
  cancelled run 37091514862 when #408 merged (2026-10-03).

`ci-janitor.yml` is the one workflow here holding `actions: write`, so the existing "no job cancels
its own run" guard now names it as its single exception rather than dropping the ban: the janitor
fires on `closed`, never from a failure step, scopes every cancel to the event's own repository, and
skips its own run id.

## Acceptance criteria

- [ ] AC-1 [shared]: proof: the PRD-481 audit script over the 7 days after phase 3 lands. Native-release
  PR runs plus post-close runs fall from 12.0k to under 2k runner-min per 14 days. Evidence: pending.
