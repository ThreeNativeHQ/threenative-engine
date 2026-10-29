# Runner capacity

Read before the first push, rerun, branch update or merge whenever CI is slow, the queue is long, or
the user says runners are saturated. On a saturated pool every run costs queue time for every other
PR, so the plan is decided by how many full runs it needs rather than by how fast one PR can land.

## Measure before planning

```bash
gh run list --repo "$pr_repo" --limit 100 --json databaseId,status,workflowName,headBranch,event,createdAt \
  --jq '.[] | select(.status!="completed") | [.status,.workflowName,.headBranch,.event,.createdAt] | @tsv'
gh run list --repo "$pr_repo" --workflow CI --status completed --limit 20 \
  --json headBranch,conclusion,createdAt,updatedAt,event
```

- Count queued and in-progress runs by branch, and attribute each run to a candidate, a parked PR or the base.
- Read recent durations from creation to completion. That is the real cost of one run, including queue time.
- Count runs that ended `cancelled` for each branch. Repeated cancellations mean pushes keep superseding
  in-flight work, and that is usually the biggest source of waste.
- Read the base branch's rules, especially the strict up-to-date setting. That one setting decides
  whether merging N PRs costs about N runs or about N more runs on top of that.

State the estimate as a number of runs multiplied by the observed duration. Say "about 8 full runs ×
1–2.5h" rather than "CI is slow".

## Stop the waste first

1. **No catch-up merges or rebases.** Updating a PR from the base only to "stay current" cancels its
   running check and queues a fresh one. Update a branch only when there is a real conflict or semantic
   dependency, or when strict policy requires it at merge time. Even then, update only the PR you will
   merge next, just before merging it, and never every open PR after each merge.
2. **One push per repair.** Collect every known fix for a candidate, including failed-job diagnosis,
   review feedback and regenerated outputs, and verify them locally before pushing once. Never push
   while the candidate's own run is still queued unless the new commit fixes something that run will
   fail on anyway.
3. **Park low-priority runs.** Parked PRs (experimental, draft, on hold, out of scope) should not hold
   queue slots. With task authority, cancel their queued or in-progress runs and say which ones.
   Converting a PR to draft helps only when the workflows actually skip drafts, so check the triggers first.
4. **Cancel only runs you can prove are obsolete**: a superseded head, or a duplicate run for the same
   SHA. Never cancel base, release, deployment or another owner's runs to free capacity.
5. **Do not dispatch expensive lanes by hand.** Native, GPU, device or platform workflows run only when
   the classifier selects them. Never run several of them in parallel as a shortcut.

## Get the answer without a hosted run

- Read a failed job's log as soon as that job completes, while the rest of the run continues. Diagnosis
  never waits for the whole run.
- Reproduce the failing job's command locally before pushing the fix. A local red-to-green result is
  worth more than a hosted retry, and a hosted run should confirm a result you already have.
- Rerun a job only for a demonstrated transient failure, once, and only the failed job. Rerunning a
  whole workflow on a saturated pool is the most expensive way to learn the same thing again.

## Shrink the number of runs

Pick the cheapest option the repository's policy allows. Anything that changes repository settings
needs the user's explicit decision, so ask; never do it as an incidental step.

| Option | Runs for N ready PRs | Cost | When |
| --- | --- | --- | --- |
| Merge queue, if already configured | 1 merge-group run each, and groups may share | queue config must cover the required checks | the queue exists and its required workflows trigger on `merge_group` |
| Relax strict up-to-date on the base, temporarily | ~N, no rebase reruns | a semantic conflict can slip in between the last run and the merge, so apply the pre-merge gate below | the user decides; back up the ruleset, change only that field, read it back, restore it at the end and report the restore |
| Trains (aggregate branches) | 1 per train | integration work; per-PR history collapses into one squash commit | cohesive small PRs that share a base; see the ordering reference |
| Serial with strict | N plus up to N−1 update reruns | wall clock | only when the queue is short |

Also:

- **Land PRs that shrink others.** If one PR's diff is contained in another's (the same dependency pin,
  for example), land the smaller one and let the larger one shrink. Never land the same content twice.
- **Separate docs from code** when the repository's classifier skips CI for docs-only diffs. A
  docs-only PR can then land almost free instead of costing a full run.
- **Order the queue by blocking value and cost.** Small PRs that everything else depends on go first,
  and large ones start diagnosis early. An expensive PR that is still red must not hold up green ones.

## Report capacity honestly

In the final report, keep runner execution minutes separate from queue and wall time, and keep runs
avoided (a count) separate from time saved (an estimate). Name every run you cancelled, every setting
you changed and restored, and every PR still waiting on capacity rather than on a defect.
