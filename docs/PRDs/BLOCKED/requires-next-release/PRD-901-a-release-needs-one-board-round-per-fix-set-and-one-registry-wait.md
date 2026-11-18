# PRD-901 — A release needs one board round per fix set and one registry wait

**Status:** BLOCKED — phases 1 to 3 are delivered; AC-4 to AC-6 need the next release
**Priority:** P1 — Release 0.3.16 took 40.7 hours from promotion PR to merge, and AC-4 to AC-6 below are the open proof that the next release does not.
**Complexity:** 3 (LOW); risk override: MEDIUM, because phase 2 changes the order of an npm publish, which cannot be undone.
**Owner:** CI tooling
**Depends on:** None

## Context

Owner, 2026-11-18: "check CI recent logs, look for opportunity to speed up it significantly", then
"especially the process to release a new lib".

The release road has three parts: the promotion board on the `develop -> main` PR, the merge, and the
`ship` job of `npm-release.yml`. This PRD reads the two newest releases on the Actions API.

```mermaid
flowchart LR
  A["Promotion PR opened"] -->|"0.3.15: 109 min, 3 boards<br/>0.3.16: 2,443 min, 22 boards"| B["Merge to main"]
  B -->|"main CI: 1.5 min, reused"| C["ship job starts"]
  C -->|"setup, candidate, tag, upgrade proof: 20.6 min"| D["First npm upload"]
  D -->|"7 registry waits: 27.7 min; 28.5 to the last package"| E["Cohort readable"]
  E -->|"clean room: 8.8 min"| F["ship job ends"]
```

### Cost 1: a promotion board shows one red leg per round

Release 0.3.16, PR #689, opened 2026-11-17 03:43 UTC and merged 2026-11-18 20:25 UTC.

| Fact | Value |
| --- | --- |
| Promotion boards (`ci.yml`, `pull_request`, head `develop`) | 22 |
| Green boards | 2 |
| Cancelled boards that already had a real red leg | 18 |
| Red legs that those 18 boards showed | 21 |
| Rounds that stopped on `budgets`, `test-unit`, `test` or `typecheck` | 14 (6, 5, 2, 1) |
| Machine minutes, all 22 boards (`queue-watch` excluded) | 6,545 |
| Machine minutes on boards that did not end green | 5,419 (83%) |
| `native-release.yml` rehearsals on the same PR | 23 runs, 1,061 wall minutes |

Cause: `queue-watch` cancels a full board on a pull request at its first red job
(`.github/workflows/ci.yml:1735` gates it; `scripts/ci-queue-watch.mjs`, the `run cancel` of the
first-red loop). PRD-782 added that rule to save
machine minutes. On a promotion board it hides every other red. Five rounds in a row on 2026-11-18
(10:16 to 17:48 UTC) each showed one new red: Android emulator, `test-native`,
`template-nonvisual (racing)`, auto-exposure cold boot, Windows desktop core. One full board of
65 minutes shows all five.

A develop push with a promotion PR on its head runs only the cache-warm lane
(`scripts/ci-change-scope.mjs:576`). So the promotion board is the first run of `typecheck`,
`budgets` and the unit tests for a commit that went directly to develop.

One board, the 18:32 UTC round, was clean at minute 45 and a feature push replaced it. The two
replaced boards of 0.3.15 already had a red leg. That is too little evidence for a frozen release
branch (see Non-Goals).

### Cost 2: the publish waits for the registry seven times

Release 0.3.15, `npm-release.yml` run 44005207314, `ship` step 02:44:45 to 03:42:34 UTC (57.8 min).

| Part of the `ship` step | Minutes |
| --- | --- |
| Checkout, install, build | 4.4 |
| Wait for `release-candidate.yml` | 5.3 |
| Tag run | 2.3 |
| Pack and upgrade proof, two templates | 8.6 |
| Registry waits, 7 dependency levels (4.96, 5.39, 3.37, 3.28, 2.78, 2.36, 5.58) | 27.7 |
| Clean room from the registry, `npm` lane then `pnpm` lane | 8.8 |

Cause: `publishCohort` uploads one dependency level and then waits until the abbreviated packument
of each package lists the version and `latest` (`installableOnRegistry`, both in `scripts/release.ts`). The chain `core -> ui -> terrain -> assets -> runtime-native ->
create-threenative` is real, so there are 7 levels. Each level waits for one roll of the packument
cache, 2.4 to 5.6 minutes, and no upload needs that time: npm accepts a package before its
dependencies are readable.

### Not a cost on this road

- The main push after the merge took 1.5 minutes. The tag run took 2.3 minutes and built nothing.
- The green promotion board took 64.9 minutes. Its floor is the iOS simulator leg, 45.4 minutes after
  10.2 minutes in the hosted macOS queue. PRD-776 owns "no CI leg runs longer than 20 min".

## Solution

1. **A promotion board runs to its end.** `ci-queue-watch.mjs` keeps the comment and skips the
   cancel when the run is a pull request into `main`. The comment lists every red leg of the board.
   The merge queue, a pull request into develop and a manual run keep the first-red cancel.
2. **The cohort publishes in two waves.** Wave 1 is every package except `create-threenative`, with
   the present upload limit of 4. Wave 2 is `create-threenative`. Each wave waits one time for all its
   packages. The scaffolder stays last, so a new project still pins only readable versions. Measured
   ceiling from the 0.3.15 run: two waits in place of 27.7, which takes first upload to last package
   readable from 28.5 minutes to about 11.2.
   Uploads keep their dependency levels inside a wave, so a failed upload still stops the packages
   behind it and npm never stores a dependent whose dependency it will not get.
3. **The ledger carries the two numbers.** `ci-board-kpis.mjs` adds promotion boards per release and
   merge-to-`ship`-end minutes, so `pnpm ci:speed record` re-measures them on each release.

Risk of wave 1: for one packument roll (at most 5.6 minutes measured) `latest` of a dependent, for
example `@threenative/ui`, can name a version whose `@threenative/core` peer is not readable yet. A
direct `npm install @threenative/ui` in that window fails with `ETARGET` and passes on retry.
`npm create threenative` is not affected. The clean room still runs after every package is readable.
Only readability moves: a failed upload of `@threenative/core` stops `@threenative/ui` before it is
uploaded, because a wave's levels upload in order.

## Non-Goals

- A frozen `release/x.y.z` branch as the promotion head. It changes the rule that main takes only
  the ordinary `develop -> main` PR, and the evidence is one lost clean board. Open it as its own PRD
  when a release loses two or more clean boards to unrelated develop pushes.
- A shorter board: the iOS, Android and Windows legs belong to PRD-776 and PRD-782.
- Reuse of green legs between two promotion boards. PRD-776 owns per-job carry.
- The `native-release.yml` rehearsal on each promotion push. PRD-380 owns it.
- The red `npm:native` clean-room step that ended the 0.3.15 run after the publish. PRD-897 owns it.
- Parallel clean-room lanes and parallel upgrade proofs. They recover about 5 minutes and add load
  to lanes that are already red at times.

## Acceptance Criteria

- [x] AC-1 [local]: On a pull request into `main`, `queue-watch` comments each red job and does not cancel the run. On a merge group it still cancels at the first red. proof: `pnpm exec vitest run scripts/__tests__/ci-queue-watch.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts` — Evidence 2026-11-18: 294/294 pass. Red on the old rule first: reverting `scripts/ci-queue-watch.mjs` to `origin/develop` fails 5 of the promotion tests, including "names every red leg and cancels nothing".
- [x] AC-2 [local]: `releaseWaves` returns two waves, `create-threenative` alone in the last, and `publishCohort` starts wave 2 only after every wave 1 package is readable. proof: `pnpm exec vitest run scripts/__tests__/release.spec.ts scripts/__tests__/release-ship.spec.ts` — Evidence 2026-11-18: 52/52 and 44/44. Red first: reverting `scripts/release.ts` to `origin/develop` fails the wave specs. The real cohort reads 2 waves over 6 + 1 upload levels, so the upload order is unchanged and only the waits collapse.
- [x] AC-3 [local]: `ci-board-kpis.mjs` reports promotion boards per release and merge-to-`ship`-end minutes, and the replay of 0.3.15 and 0.3.16 gives 3 and 22 boards and 59.5 minutes for 0.3.15. proof: `pnpm exec vitest run scripts/__tests__/ci-board-kpis.spec.ts` and `pnpm ci:speed record` — Evidence 2026-11-18: 38/38 with `ci-speed-loop.spec.ts`, and 5 red on the old `ci-board-kpis.mjs`. Replay, ledger iteration #42: 0.3.15 = 3 boards, 1,331 machine minutes, merge→`ship` end 59.5 min; 0.3.16 = 22 boards, 5,962 machine minutes, merge→`ship` end 79.7 min. `promotionBoardsLatest` = 22, `mergeToShipEndMin` = 79.7. Both `ship` jobs concluded red after their publish (0.3.15 in the clean-room `npm:native` step PRD-897 owns), so the measure is the job's end whatever its conclusion, and a `ship` with no completion reads n/a.
- [ ] AC-4 [shared]: On the next release, a red promotion board ends with every leg concluded and one comment that names all its red legs. proof: the run id and the comment link of that board — Evidence: pending.
- [ ] AC-5 [shared]: On the next release, first npm upload to last package readable is 12 minutes or less (0.3.15: at most 28.5 — first upload 03:05:26.49 UTC, last package readable by 03:33:54.09, the end of the 11-second scaffold step that follows it). proof: the `ship` log of that release — Evidence: pending. Replay of the same log under two waves: ~11.2 minutes, unverified until a release runs it.
- [ ] AC-6 [shared]: On the next release, the promotion PR merges in 4 boards or fewer (0.3.16: 22) and merge to `ship` end is 45 minutes or less (0.3.15: 59.5). proof: a ledger iteration in `pnpm ci:speed show` — Evidence: pending.

## Blocked on

- AC-4 to AC-6 need a real release. Unblocked by the owner's next `Release 0.3.x` promotion PR.
  The code for them is in this repository (PR #697); what is missing is one release that runs it.

## Integration Ledger

| Capability | Reachable consumer/trigger | Replaces / disposition | Evidence |
| --- | --- | --- | --- |
| Promotion board runs to its end | `ci.yml` job `queue-watch` -> `scripts/ci-queue-watch.mjs` on `pull_request` with base `main` | The first-red cancel stays for merge groups, develop PRs and manual runs | AC-1, AC-4 |
| Two-wave publish | `npm-release.yml` job `ship` -> `pnpm release:ship` -> `scripts/release.ts` `publishCohort` | The 7-level order is removed, not kept as an option | AC-2, AC-5 |
| Release KPIs | `pnpm ci:speed record` -> `scripts/ci-board-kpis.mjs` | Adds two fields to the ledger row | AC-3, AC-6 |

## Decisions

- 2026-11-18 (agent, open to the owner's veto): a pull request into `main` leaves the first-red cancel of PRD-782. One round that shows every red costs at most 660 machine minutes (0.3.16's last board measured 656). Release 0.3.16 spent 5,419 on rounds that showed one red each.
- 2026-11-18 (agent, open to the owner's veto): two publish waves accept the `ETARGET` window in the Solution. The option without a window is a staging dist-tag that moves to `latest` after all packages are readable. It needs `npm dist-tag` under Trusted Publishing, which is unverified.
- 2026-11-18 (agent, open to the owner's veto): a wave uploads its levels in order and waits once, rather than uploading all of wave 1 at once. Four-wide uploads in `releaseOrder` let a failed `@threenative/core` upload leave `@threenative/ui` published against a version npm will never serve, and npm versions cannot be deleted. Uploads cost seconds, so the two waits stay two.
- 2026-11-18 (agent): the supersede guard is removed, and on a promotion board a `cancelled` leg counts as a leg that did not pass. A leg killed by `timeout-minutes` concludes `cancelled` inside a run that concluded `failure` (`ci.yml` run 43858835585), so a board whose only red leg timed out would otherwise report "none red". The cancelling paths still ignore `cancelled`, because a superseded run has cancelled legs and is not red — and a superseding push cancels `queue-watch` itself anyway.
- 2026-11-18 (agent): no frozen release branch in this PRD. See Non-Goals for the trigger.

## Execution Phases

#### Phase 1: a promotion board shows every red in one round
**Status:** PARTIAL — every box that does not need a release is ticked
**Files:** `scripts/ci-queue-watch.mjs` (skip the cancel for base `main`, list every red in the comment), `scripts/__tests__/ci-queue-watch.spec.ts`, `.github/workflows/ci.yml` (pass the base ref to the watcher, rename the step).
**Implementation:** The watcher already reads the run and its jobs. Add the base ref to its inputs. For base `main`, keep the poll until every job concludes, then write one comment with all red jobs. A failed comment must still exit non-zero.
- [x] The watcher spec is red on the current rule and green after the change. proof: `pnpm exec vitest run scripts/__tests__/ci-queue-watch.spec.ts scripts/__tests__/ci-structure.spec.ts scripts/__tests__/ci-needs.spec.ts` — covers AC-1. Result 2026-11-18: 294/294, 5 red before the change.
- [ ] A red promotion board of the next release names all its red legs. proof: run id and comment link — covers AC-4.

#### Phase 2: the publish waits once per wave
**Status:** PARTIAL — every box that does not need a release is ticked
**Files:** `scripts/release.ts` (`releaseWaves` splits the levels into waves; `publishCohort` uploads a wave level by level and waits for the whole wave once), `scripts/__tests__/release.spec.ts`.
**Implementation:** Keep `releaseOrder` for the cycle check and `releaseLevels` for the upload order. `releaseWaves` cuts the levels at the scaffolder: wave 1 is every level before it, wave 2 is the scaffolder, and a package that depends on the scaffolder would keep a third. The upload limit of 4 and the 15-minute deadline per package do not change. A red upload in a wave stops the rest of that wave and every later one.
- [x] The release spec is red on 7 levels and green on two waves, and a wave 1 failure publishes no scaffolder. proof: `pnpm exec vitest run scripts/__tests__/release.spec.ts scripts/__tests__/release-ship.spec.ts` — covers AC-2. Result 2026-11-18: 52/52 and 44/44; "publishes no scaffolder when a wave 1 upload fails" and "publishes no dependent when its dependency's upload fails" cover both stops.
- [x] `pnpm release --dry-run` packs the cohort and prints the two waves. proof: the command, exit 0 — covers the real entry point of AC-2. Result 2026-11-18: `pnpm release --dry-run --skip-gates` exit 0, "Dry run packed 17 package(s) in 2 publish wave(s)", wave 1 = the 16 other packages, wave 2 = `create-threenative`. Without `--skip-gates` the run stops at `pnpm test`, red on develop in `packages/terrain/__tests__/editor-document.spec.ts` before this change.
- [ ] The next release reads 12 minutes or less from first upload to last package readable. proof: the `ship` log — covers AC-5.

#### Phase 3: the ledger measures the release road
**Status:** PARTIAL — every box that does not need a release is ticked
**Files:** `scripts/ci-board-kpis.mjs`, `scripts/__tests__/ci-board-kpis.spec.ts`, `.claude/skills/ci-speed-loop/SKILL.md` (two KPI rows; `.agents/skills` carries no `ci-speed-loop`, so that file is the only copy).
**Implementation:** Count `ci.yml` `pull_request` runs with base `main` between the open and the merge of each promotion PR. Read merge time and the end of the `ship` job of the `npm-release.yml` run on the merge commit. A release with no `ship` run is `n/a`, not 0.
- [x] The KPI spec passes and the replay matches the hand count. proof: `pnpm exec vitest run scripts/__tests__/ci-board-kpis.spec.ts scripts/__tests__/ci-speed-loop.spec.ts`, then `pnpm ci:speed record --since 2026-11-17 --label "PRD-901 baseline"` — covers AC-3. Result 2026-11-18: 38/38; ledger iteration #42 replays 3 and 22 boards and 59.5 minutes for 0.3.15, matching the hand count in the Context. Iterations #40 and #41 are superseded: #40 read a promotion closed in September against the window's end, #41 read whichever `ship` run the API listed last.
- [ ] The next release is a ledger iteration with 4 boards or fewer and 45 minutes or less. proof: `pnpm ci:speed show` — covers AC-6.
