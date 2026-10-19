---
name: ci-speed-loop
description: Run ThreeNative's CI speed loop — measure how long a change takes to merge, name the biggest cost from the first failing jobs and queue wait, change one thing, re-measure the same window, record the iteration and refresh the HTML dashboard. Use when asked to speed up CI or the merge queue, work PRD-550, check progress toward the 30-minute merge goal, or refresh docs/ci-speed/index.html. Not for runtime FPS (perf-loop).
---

# CI speed loop

Goal (PRD-550): a change merges within 30 minutes of its last push. One turn is one measured window,
one named cost, one change, one re-measure. Record a turn that did not move the number too, with the reason.

| Metric | Goal |
| --- | --- |
| Last push to merge, median / p90 | ≤ 30 / ≤ 45 min |
| Merge queue passes on the first attempt | ≥ 90% |
| Merge-group board wall time, median | ≤ 15 min |
| Runner queue wait, p90 | ≤ 3 min |

```sh
node scripts/ci-merge-latency.mjs --since 2026-10-09          # measure only, prints the table
node scripts/ci-speed-loop.mjs record --since 2026-10-09 --label "gating board" --notes "..." [--decision keep]
node scripts/ci-speed-loop.mjs show                           # the ledger
node scripts/ci-speed-loop.mjs discard --iteration 3 --reason "queue outage, 2 PRs only"
node scripts/ci-speed-loop.mjs report                         # regenerate the HTML only
```

`docs/ci-speed/ledger.json` is the record. `docs/ci-speed/index.html` is generated from it and opens with
`file://`. Never edit either by hand. Commit both with the change they measure.

## The turn

1. **Measure.** `record --since <date the change landed>`. The first iteration is the baseline. Do not
   mix PRs from before and after a change in one window.
2. **Name the cost.** Read the "first failing job" chart and the PR table. Name one job or one wait. "CI is slow" is not an answer.
   A red that repeats across unrelated PRs is a load red: fix it at its timeout source, not with a retry.
3. **Change one thing.** One PR per PRD (root `AGENTS.md`). Prove it locally first. A CI round trip costs over an hour.
4. **Re-measure the same metrics** once enough PRs merged (the PRD ACs need 10 PRs and 20 merge groups).
   A window with fewer than 5 PRs is `provisional`, not `keep`.
5. **Decide.** `keep`, `reject`, `provisional`, `inconclusive` or `invalid`. A contended or outage window is `discard`ed with a reason. It stays in the table and leaves the charts.

## Rules

- A value the API cannot supply is `n/a`, never 0. A PR that skipped the queue has no enqueue time.
- Last push is the head commit's committer date, so a rebase moves it. Say so when a number looks low.
- "First attempt" counts the first merge-group run per PR. Cancelled first runs count as not passed.
- Queue wait is job created to job started over all merge-group jobs, including hosted legs. It is not the gating-only wait until PRD-550 phase 3 routes them.
- Do not claim a goal from one window. Cite the iteration id and its PR count.
