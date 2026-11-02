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
| First promotion PR to npm, open release included | see the ledger | ≤ 120 min | The owner's first question, and a stalled release cannot look fast |

Flake rate reads attempt 1 only, so a flake that a rerun hid does not count. PRD-550's five merge KPIs
stay in the same ledger. Carry hit rate and per-cache hit rate wait until a board runs per-job reuse
and the scouts name the caches that matter.

## Blocked on

- GitHub Team plan, 60 concurrent jobs against 20. It costs money, so it is the owner's decision.
- The all-clear from the session that owns the 0.3.8 release. These wait for it: the main push carries
  gate jobs, Android shards, PRD-630 binary reuse, and any merge of draft PR #601.

## Decisions

- 2026-11-01 (agent, under the owner's "whatever you want to add as a KPI"): the KPI set and the goals above.
- 2026-11-01 (agent): this PRD shares draft PR #601 with PRD-776. The root rule says one PR per PRD. The
  owner's later rule, after four incidents, is no extra PRs in a session, and the work is one chain.
- 2026-11-01 (agent): removals are proposals. A test leaves the board only on the owner's decision.

## Execution Phases

#### Phase 1: measure every step, every log and every test
**Status:** IN PROGRESS

- [x] The loop records 11 whole-road KPIs. proof: `pnpm exec vitest run scripts/__tests__/ci-board-kpis.spec.ts scripts/__tests__/ci-speed-loop.spec.ts` — 28 passed. The 14-day replay gives the baselines above, and 3 of them match the earlier separate analysis (37 of 166, 61 of 123, 16%).
- [ ] The ledger holds the baseline iteration with every KPI. proof: `pnpm ci:speed show`.
- [ ] Every step and log of a full green board and of the tag run is classified, with key numbers rechecked. proof: findings table in this PRD, from `~/.cache/tmp-tn/ci-audit/out/scout-a.md`.
- [ ] Every test is inventoried per job, with its red and flake count. proof: findings table in this PRD, from `~/.cache/tmp-tn/ci-audit/out/scout-b.md`.

#### Phase 2: rank every lever and every removal
**Status:** NOT STARTED

- [ ] Each technique has a state and each lever has its recovered minutes, ranked. proof: lever table in this PRD.
- [ ] Each removal candidate names the proof that would be lost. proof: removal table in this PRD, sent to the owner.

#### Phase 3: land the levers
**Status:** NOT STARTED

- [ ] Full board wall time, median, is 30 minutes or less. proof: a `keep` iteration in `pnpm ci:speed show`.
- [ ] Flake rate is 5% or less. proof: a `keep` iteration in `pnpm ci:speed show`.
- [ ] First promotion PR to npm is 120 minutes or less. proof: a `keep` iteration in `pnpm ci:speed show`.
