# PRD-782 — A merge reaches npm as fast as the work allows

**Status:** IN PROGRESS
**Priority:** P1 — CI is the owner's main bottleneck, and the audit of every step and every test, the ranked levers and all KPI goals below are still open.
**Complexity:** 8 (HIGH)
**Owner:** CI tooling
**Depends on:** PRD-776, PRD-630

## Context

Owner, 2026-11-01: "Did you check all CI logs to know what can be paralelized, cached, batched, etc,
etc? Are we using any possible techinque to make sure this shit runs AS QUICKLY AS POSSIBLE? any
useless tests candidate to remote?", "we have to consider everything" and "setup this as a CI
improvements loop with clear KPIs like total time to execute full run, flakyness rate, etc".

The answer on that date was no. The audit had read job timing for 14 days and step logs for the long
legs only. This PRD reads the rest, then runs every lever through the CI speed loop.

The clean path to `latest` costs about 236 minutes: promotion board 64, main board 64, release
candidate 5, tag run about 60, npm cohort 43. Those are single runs from the release of 0.3.6 to
0.3.8, not a median.

## Solution

Extend the loop that exists (`scripts/ci-speed-loop.mjs`, `docs/ci-speed/ledger.json`, the CI speed
tab of `pnpm dashboard`, the `ci-speed-loop` skill). One turn is one measured window, one named cost,
one change, one re-measure. `scripts/ci-board-kpis.mjs` adds the whole-road KPIs. Two read-only scouts
(leanpi, DeepSeek v4.1 flash, max effort) read every step and log and inventory every test. Their
claims are unverified until a key number is rechecked against the Actions API.

## KPIs

Baseline: 2026-10-18 to 2026-11-01, 516 `ci.yml` runs, attempt 1, 166 finished full boards. Each goal
is half the cost or better, the owner's "100% more efficient". A full board ran 60 or more jobs.

| KPI | Baseline | Goal | Why this one |
| --- | --- | --- | --- |
| Full board wall time, median | 88.3 min | ≤ 30 min | The owner's "total time of a full run" |
| Longest job on a full board, median | 50.8 min | ≤ 20 min | The floor that no runner count can beat |
| Machine minutes per full board, median | 537.9 | ≤ 240 | Cost of one board, and what fills the 20 slots |
| Machine minutes per week, all runs | 84,454 | ≤ 40,000 | Catches a repeated board that a per-board number hides |
| Job queue wait on full boards, p90 | 24.2 min | ≤ 3 min | The cost of too few slots |
| Full boards green on attempt 1 | 22.3% | ≥ 80% | A red board costs a second board |
| Flake rate: red legs green on another board of the same commit | 49.6% | ≤ 5% | The owner's flakiness KPI |
| Machine minutes on runs that end green | 16.3% | ≥ 70% | The rest buys no release |
| Full-board minutes after the first red leg | 37.4% | ≤ 10% | The cost of late failure |
| Step minutes spent on setup | 12.4% (one board, run 41348117470) | ≤ 6% | Checkout, install, browser, cache. A compile that repeats is not counted yet |
| First promotion PR to npm, open release included | 5,814 min, 0.3.7 still open (lower bound) | ≤ 120 min | The owner's first question, and a stalled release cannot look fast |

Flake rate reads attempt 1 only, so a flake that a rerun hid does not count. PRD-550's five merge KPIs
stay in the same ledger. Carry hit rate and per-cache hit rate wait until a board runs per-job reuse
and the scouts name the caches that matter.

## What the audit found

Audited: `ci.yml` run 41348117470 attempt 1, `native-release.yml` run 41348667449, `release-candidate.yml` run 41348747260, 14 days of job history and the newest 139 failed job logs. The full scout reports are in a comment on PR #601.

Run 41348117470 is not a green board: attempt 1 has 3 reds (Windows desktop core and two verdict jobs that follow it). Its timing is still valid.

Where the cost is, rechecked against the API or the repo:

- Setup is 54.7 of 477.2 machine minutes, 11.5%. The board is limited by work and by queue, so caches recover little.
- 86 runs of more than 50 minutes repeated a commit that had already run: 46,270 of 179,237 machine minutes. Of those, 51 were full boards: 30,318 minutes.
- Outside the merge queue, legs that started after a real red cost 33,652 minutes. `queue-watch` stops this only on `merge_group` (`ci.yml:1567`).
- 16 template jobs run their scenarios in series for 6,902 s, and `packages/playtest/src` has no concurrency flag.
- Android spends 2,279 s in one emulator step, with `-no-snapshot` (`native-platforms.yml:732`).
- Flakes by leg, green on another board of the same commit against all reds: Desktop web/native parity 11 of 15, `template-nonvisual (racing)` 5 of 9, macOS desktop core 5 of 8, Windows desktop core 5 of 7.
- All board jobs but the two native floor legs were ready at minute 4.2, so they wait for a slot and not for a dependency (scout claim, not rechecked).

Scout claims that the recheck rejected:

- The log classes "18 real, 75 environmental, 46 unknown" are not reliable. `CI_NATIVE_BUILD_EVIDENCE`, in 23 logs, prints after the job has already failed (`TN_CI_JOB_RESULT: failure`), so it is a symptom. The receipt reds also follow other failures. The true cause of most reds remains unknown.
- The savings for `template-engine-cost` and `benchmark` come from before the 2026-11-01 cut. On the audited board `template-engine-cost` is skipped and `benchmark` takes 0.5 minutes. The engine parity step was not cut: `ci.yml` skips it only for `starter`, so it still runs on the board for 15 kits. `csg`, `ik` and `vegetation` take 0.3 to 0.4 minutes each, so merging them recovers almost nothing.
- A ccache key that ends in the run id is the normal pattern, not a defect.
- npm publish parallelism is already on #601 (`47c3520b7`). The scout marked it unused.
- The second release run on a commit is not a stray duplicate: the `workflow_run` is the rehearsal (PRD-629) and the tag run is the real one. The fix is PRD-630, not one entry point.

Causes read from the failing step of 63 flaky reds and all 34 boards with a red Desktop parity job:

- Desktop web/native parity, UI-frame gate: 21 reds. 16 are `TN_FRAME_BUDGET_PHASE_OVER_BUDGET`. A window closes every 300 ticks, so a run reports about 735 frames and then a tail of 7 to 16, and the gate read the tail, where a p95 is the worst frame. The same local run reads 0.02 ms on the full window. It was the only real red on 9 boards. The per-frame page that `f6587fc22` proposed is not needed, because the full window already holds hundreds of samples. Its cost was not measured.
- Engine parity step: about 12 reds across 7 kits (`TN_ENGINE_PARITY_WORLD_NOT_DRAWN`, `TN_ENGINE_PARITY_ENVIRONMENT_NOT_BA...`, a score of 0.823 against 0.12). See "Removal candidates".
- Desktop parity, Crowd rate scenario: 6 reds. Browser reference comparison: 3 reds. Not read further.
- Windows and macOS core: mixed (`TN_PROD_STARTUP_BUDGET`, `TN_PROD_PACKAGE_FLAG_UNSUPPORTED`, `native:verify:desktop`). Not fixed.
- gh 2.102 exits 1 on a job log with escape sequences unless told to allow them. Both log readers treated that as "no flake found". Fixed on #601, before the runner image updates.

## Measured gain of #601, from a replay

Owner, 2026-11-01: "must have a real gain to merge this, verify". This replay feeds the 14-day history (attempt 1, 160,092 machine minutes, 268 full boards outside the schedule) through #601's own `findCarried` and real git diffs. It is a replay, not a run. Merge still needs the real boards under "Blocked on".

| Change | Machine min per 14 days | Share | Wall median | Risk found |
| --- | --- | --- | --- | --- |
| Per-job reuse | 18,328 (21,851 if a PR head stands for its merge commit) | 11.4% (13.6%) | 0 min on each event: the native legs set the wall time and do not carry | 14 carried reds. 8 are green elsewhere on the commit. The other 6 are 3 upload or receipt failures, 2 unit flakes and 1 engine parity flake. None is a regression |
| First-red stop | 42,736 gross, 23,630 net if each of 83 stops with a later non-flake red costs one more round | 14.8% to 26.7% | Not replayed | 83 of 132 stops hide a later red until the next round |
| UI-frame gate fix | Up to 9 boards no longer red for this reason alone | Green at once 15.1% to at most 18.3% (42 to 51 of 279) | None | Hosted-runner window size is unproven |

Together: 41,958 to 64,587 machine minutes, 26% to 40%. That is a real gain in machine minutes and free slots. It does not reach the goal of half, and the replay shows no wall time gain. Lower queue wait is likely but not measured. A 5-minute grace on the stop drops the hidden count from 83 to 68 and the gross saving from 46,241 to 38,479 minutes (before reuse), so the stop stays at the first red.

## Levers, ranked

Each lever has one loop turn. The minutes overlap, so do not add them. An ESTIMATE is arithmetic on measured numbers, not a measured result.

| # | Lever | Recovers | State |
| --- | --- | --- | --- |
| 1 | One board per tree, and per-job reuse (PRD-776) | Up to 46,270 machine min per 14 days, about 15 wall min per board | On #601, waits for the all-clear |
| 2 | Stop starting legs after the first real red, on every event | Up to 33,652 machine min per 14 days. Risk: fewer reds shown per round | Code and specs on #601. The janitor runs from main, so its first proof is a red board after this reaches main |
| 3 | Find and fix the real cause of the 4 flaky legs above | A red board costs a second board of about 538 machine min | UI-frame gate fix and gh log fix on #601. Engine parity is an owner decision. Crowd rate and core legs are not fixed |
| 4 | Two browser sessions per template job | ESTIMATE 48 machine min and 8 wall min per board. Needs proof on the software adapter | Parked: more load per job can raise the flake rate, and this run made no software-adapter proof |
| 5 | Split Android and iOS, the two floor legs | ESTIMATE floor 49 to about 25 min. Only both together move it | Android job name is gate-read, so it waits for the all-clear or stays as an aggregator job |
| 6 | Reuse the proof run's binaries in the tag run (PRD-630) | 98 machine min and 31 wall min per release (PRD-630 table) | Waits for the all-clear |
| 7 | Run `clean-consumer` and `clean-consumer-windows` together | ESTIMATE 6 wall min per release | Waits for the all-clear |
| 8 | iOS compile cache. A CMake launcher has no effect with `-G Xcode`, so use `CMAKE_XCODE_ATTRIBUTE_CC` with a wrapper or Ninja | 19 min of compile per board at most. First proof is a macOS CI run | Parked until a macOS run is allowed |
| 9 | Delete the integration `paths` job: pass the lane list in the plan | Dropped: on the audited board the job takes 16 s, and a treeless clone was not faster (15 s against 11 s) | Dropped |
| 10 | Balance `test-unit` shards by measured time | ESTIMATE longest shard 8.9 to 5.4 min, 0 machine min, on a leg that does not set the wall time | Dropped: no real gain |

Techniques with no case to add: setup and browser caches (lever size under 1%), new cache families and an AVD snapshot (PRD-726 rejected them, the 10 GB cache budget was full at 10.8 GB), `CCACHE_SLOPPINESS` (PRD-628 reverted it, zero new hits), precompiled headers (reverted, `ci.yml:361-372`), and skipping redraws in playtests (PRD-727 rejected it, it breaks temporal accumulation). A larger runner costs money, so it goes with the plan decision below.

With levers 1, 5, 6 and that session's main board reuse, the clean path is about 25 + 5 + 5 + 30 min plus the npm cohort, which is unmeasured since `47c3520b7`. That total is an ESTIMATE. Only a release can prove it.

## Removal candidates

All are the owner's decision. Zero reds over 14 days is weak evidence, because a gate only goes red when a regression happens.

| Candidate | Move | Saves | Proof lost |
| --- | --- | --- | --- |
| `integration / auto-exposure`, 8.8 min, 14 reds, load-sensitive | Run on exposure changes and nightly, as its cold boot sibling does | 8.8 machine min per board | An unrelated change that breaks exposure is found at night, not on the board |
| Engine parity step on the hosted software adapter, about 12 flaky reds across 7 kits, `TN_ENGINE_PARITY_WORLD_NOT_DRAWN` in 13 logs | Off the board for 15 kits, nightly on a hardware runner | Unmeasured | The web-against-native pose check per kit on each board |
| `starter-look` pixel gate on a software adapter | Nightly on hardware | ESTIMATE 200 machine min per 14 days | The board's starter look baseline |
| `template-engine-cost`, 16 kits, nightly | 4 kits | ESTIMATE about 1,965 machine min per 14 days, nightly only | The per-kit cost row of PRD-748 for 12 kits |

## Blocked on

- Proof on real boards that #601 has the gain above: one full board on #601's head, then one board after a docs-only commit, compared by machine minutes and wall time. Boards compete with the main board for runners, so this waits for the release session's all-clear after 0.3.8.
- First proof of the first-red stop: the janitor runs from main, so it needs #601 on main and a red board. Its stop count and rounds per merge are checked then.
- GitHub Team plan, 60 concurrent jobs against 20, or the `tn-local` pool. A plan costs money and the pool loads the owner's machines, so it is the owner's decision.
- The removal candidates above — the owner decides each one.
- The session that owns the 0.3.8 release now owns the main board redundancy, auto-publish on main and the hotfix override, on the owner's order: `scripts/release-ship.ts`, `scripts/release-candidate-gate.ts`, `native-release.yml` and the promotion reuse rule in `ci-change-scope.mjs` and `ci-required.mjs`. It hands its commits to #601 after 0.3.8 is out. Levers 6 and 7 touch those files, so they wait for that session. Android shards and any merge of #601 also wait for 0.3.8.

## Decisions

- 2026-11-01 (agent, under the owner's "whatever you want to add as a KPI"): the KPI set and the goals above.
- 2026-11-01 (agent): this PRD shares draft PR #601 with PRD-776. The root rule says one PR per PRD. The
  owner's later rule, after four incidents, is no extra PRs in a session, and the work is one chain.
- 2026-11-01 (owner, relayed by the release session): a promotion with a green tree publishes with no new test run. The release session owns that work, and this PRD owns per-job reuse.
- 2026-11-01 (agent): removals are proposals. A test leaves the board only on the owner's decision.
- 2026-11-01 (owner): "must have a real gain to merge this, verify". #601 merges only after the real boards above show the gain.
- 2026-11-01 (agent): levers 9 and 10 are dropped because the measured gain is near zero. Levers 4, 5 and 8 are parked because this run cannot prove them.

## Execution Phases

#### Phase 1: measure every step, every log and every test
**Status:** PARTIAL

- [x] The loop records 11 whole-road KPIs. proof: `pnpm exec vitest run scripts/__tests__/ci-board-kpis.spec.ts scripts/__tests__/ci-speed-loop.spec.ts` — 28 passed. The 14-day replay gives the baselines above, and 3 of them match the earlier separate analysis (37 of 166, 61 of 123, 16%).
- [x] The ledger holds the baseline iteration with every KPI. proof: `pnpm ci:speed show` — iteration 38, 16 KPIs, none `n/a`. Window: 53 merged PRs, 78 merge groups, 166 finished full boards.
- [x] Every step and log of a full board, the rehearsal run and the candidate run is classified, with key numbers rechecked. proof: "What the audit found" in this PRD — run 41348117470 has 78 jobs, 3 red, the 6,902 s and 2,279 s steps match the API. The audited board is not green, and the tag run itself was not read beyond its timing.
- [ ] Every test is inventoried per job, with its red and flake count. proof: Scout B's inventory in the PR #601 comment.
  Open: counts are per job and per leg. Red logs were sampled (139 of 1,187) and most causes stay unknown, so a per-test flake count does not exist yet.

#### Phase 2: rank every lever and every removal
**Status:** DONE

- [x] Each lever has its recovered minutes, ranked. proof: "Levers, ranked" in this PRD, and 30 technique states in the PR #601 comment.
- [x] Each removal candidate names the proof that would be lost. proof: "Removal candidates" in this PRD.

#### Phase 3: land the levers
**Status:** IN PROGRESS

- [ ] Full board wall time, median, is 30 minutes or less. proof: a `keep` iteration in `pnpm ci:speed show`.
- [ ] Flake rate is 5% or less. proof: a `keep` iteration in `pnpm ci:speed show`.
- [ ] First promotion PR to npm is 120 minutes or less. proof: a `keep` iteration in `pnpm ci:speed show`.
