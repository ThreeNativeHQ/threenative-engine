# Ordering and batching

Read before planning a multi-PR run. Establish precedence before choosing batches, rerunning CI, updating branches, or assigning repair work.

## Build the dependency graph

Use current diffs and ancestry as evidence. Summarize each PR's actual contract change: what it supplies, what it consumes, what it changes in build/test execution, and what must already exist when it lands.

| Relationship | Evidence | Scheduling consequence |
| --- | --- | --- |
| Hard dependency: A before B | B requires an API, schema, artifact, workflow, or commit supplied by A | Land A before B, or test and deliver an authorized cohesive aggregate containing both |
| Shared blocker or efficiency improvement | Failure logs identify A's fix as a cause across PRs, or measurements show A reduces later work | Prioritize A when ready; unrelated eligible work remains free to merge |
| Conflict or common generated output | Overlapping hunks, shared generators/lockfiles, or conflicting interfaces | Coordinate one integration order; overlap alone does not make either PR a prerequisite |
| Independent change | Current diffs and contracts have no relevant coupling | Review/test concurrently within capacity; merge as soon as eligible |
| Release or rollout prerequisite | A's outputs are needed to publish/deploy B, but B's code can safely land earlier | Gate the release/rollout separately; do not invent a code-merge dependency |

Inspect both sides of any claimed edge. PR text can be stale, commit ancestry can include changes already squash-merged, and adjacent PR numbers prove nothing. An already-contained source PR is a coverage/closure question, not another prerequisite to merge again. Use patch and final-tree comparison when ancestry alone cannot prove inclusion.

Topologically order hard dependencies. In each available wave, consider ready shared unblockers first, then independent ready candidates and the smallest repairs likely to unlock more work. Use age to break comparable ties so expensive or old work is not perpetually displaced. Estimates should use recent comparable job durations, queue capacity, and actual work remaining, not invented precision.

If the graph cycles, identify whether it is one atomic change split across PRs or a real design incompatibility. A cohesive aggregate can solve the first within scope; it does not solve incompatible contracts. Report unresolved dependency uncertainty while continuing independent work. Inspect prerequisites outside the selected set read-only; request a scope extension only if work on them is necessary and not already authorized.

Example: B consumes A's new function, C fixes a CI failure observed on both, and D changes independent documentation. A precedes B. C is worth repairing first if its fix is confirmed. D can merge immediately once its own gates pass. A draft prerequisite blocks its dependents; a draft elsewhere does not hold the queue.

## Choose a batch only after ordering

Batching has two distinct benefits: combining fixes before each PR push avoids repeated runs, while consolidating related PRs can avoid some independent future PR/base runs. The first is the default. The second adds integration and review cost, changes PR history, and needs a justified batch boundary.

1. Compare the work still required for individual PRs with one aggregate: remaining source runs, branch-update reruns, aggregate verification, required queue runs, base runs, and integration/review effort. CI already completed is sunk cost. Do not rebuild several ready green PRs just to call them a batch.
2. Prefer the smallest cohesive group, often 2–4 PRs, sharing one base, compatible review/rollback boundaries, and useful verification. Similar titles or a common repository are insufficient. Do not combine unrelated security, database, release, or platform changes to fill a batch.
3. Integrate pinned source SHAs in dependency order. Map each PR to its purpose and resulting paths; explain intentional omissions and deduplication. Resolve generated conflicts from combined source inputs. Verify consumer behavior at shared boundaries, not only the component unit tests.
4. Review and run the required checks on the final aggregate diff. Original approvals and individual green checks are supporting evidence, not aggregate approval. If an aggregate fails, diagnose before changing membership; split it when the coupling or investigation cost removes the expected benefit.
5. After the aggregate lands, compare source coverage, refresh original heads, and only then perform authorized superseded-PR closure. Preserve any new source delta. Never claim that closed source PRs were individually merged.

## Stacks, base movement, and scheduling traps

For stacked PRs, inspect merge bases and child diffs before selecting squash, rebase, or merge. Squashing a parent can make its commits appear again in the child's diff. Retargeting alone may neither remove that duplication nor trigger CI. Reestablish the intended child diff using a repository-approved strategy that preserves contributors' work; review and validate the resulting candidate. Do not silently force-push a stack.

When a prerequisite lands, fetch it once and update only affected candidates that need it. Batch known integration and review fixes into the same verified push. Strict branch protection or a merge queue may require additional runs; those are real constraints. A permissive base policy still requires assessing semantic conflicts with the new base.

Keep changes that qualify for an existing narrow verification lane separate from executable changes when mixing would trigger an expensive full lane without a compensating benefit. Determine eligibility from the complete diff and the repository's classifier, not from a documentation label or the most recent commit.

Use GitHub merge queues according to their configured behavior. Their merge limits affect grouping of merges to the base; they do not combine merge-group builds. Required Actions checks need a `merge_group` trigger. Source PR checks, queue checks, and base checks may all still run. [GitHub merge queue documentation](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue).
